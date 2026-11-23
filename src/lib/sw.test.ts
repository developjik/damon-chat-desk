import { describe, expect, it } from 'vitest';
import {
  decideFetch,
  installServiceWorker,
  isNeverCached,
  shellCacheName,
  staleShellCaches,
  SKIP_WAITING,
  type ShellManifest,
  type SwGlobal,
} from './sw';

const SCOPE = 'https://developjik.github.io/damon-chat-desk/';
const FILES = new Set(['index.html', 'assets/index-abc.js', 'assets/index-abc.css', 'manifest.webmanifest']);
const get = (url: string, mode?: string) => ({ method: 'GET', url, mode });

describe('decideFetch', () => {
  it('serves precached shell files from the cache', () => {
    expect(decideFetch(get(`${SCOPE}assets/index-abc.js`), SCOPE, FILES)).toEqual({
      kind: 'shell',
      key: `${SCOPE}assets/index-abc.js`,
    });
  });

  it('answers in-scope navigations with the cached index.html', () => {
    expect(decideFetch(get(SCOPE, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'shell', key: `${SCOPE}index.html` });
    expect(decideFetch(get(`${SCOPE}?session=1`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'shell', key: `${SCOPE}index.html` });
  });

  it('never touches daemon or model traffic', () => {
    for (const path of ['dm/health', 'dm/ws', 'health', 'v1/models', 'v1/chat/completions', 'ws', 'api/x']) {
      expect(decideFetch(get(`${SCOPE}${path}`), SCOPE, FILES)).toEqual({ kind: 'bypass' });
      expect(decideFetch(get(`${SCOPE}${path}`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'bypass' });
    }
  });

  it('bypasses other origins, other paths, non-GET and unlisted files', () => {
    expect(decideFetch(get('http://127.0.0.1:9470/health'), SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch(get('https://developjik.github.io/other/'), SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch({ method: 'POST', url: `${SCOPE}assets/index-abc.js` }, SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch(get(`${SCOPE}assets/other.js`), SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch(get(`${SCOPE}assets/index-abc.js?v=2`), SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch(get(`${SCOPE}docs/mobile.png`, 'navigate'), SCOPE, FILES).kind).toBe('bypass');
    expect(decideFetch(get('not a url'), SCOPE, FILES).kind).toBe('bypass');
  });

  it('matches the never-cache list on the first segment only', () => {
    expect(isNeverCached('dm')).toBe(true);
    expect(isNeverCached('/V1/models')).toBe(true);
    expect(isNeverCached('assets/dm.js')).toBe(false);
    expect(isNeverCached('wsx')).toBe(false);
  });
});

describe('shell caches', () => {
  it('drops only earlier shells', () => {
    expect(staleShellCaches([shellCacheName('old'), shellCacheName('new'), 'someone-else'], 'new')).toEqual([shellCacheName('old')]);
  });
});

/* ---------------------------------------------------------------- */

class FakeCache {
  entries = new Map<string, Response>();
  added: string[] = [];
  async addAll(requests: RequestInfo[]): Promise<void> {
    for (const request of requests) {
      const url = typeof request === 'string' ? request : request.url;
      this.added.push(url);
      this.entries.set(url, new Response(`cached ${url}`));
    }
  }
  async match(key: string): Promise<Response | undefined> {
    return this.entries.get(key);
  }
}

function fakeWorker() {
  const caches = new Map<string, FakeCache>();
  const listeners: Record<string, (event: unknown) => void> = {};
  const network: string[] = [];
  const state = { skipped: 0, claimed: 0 };
  const storage = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new FakeCache());
      return caches.get(name)!;
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const sw = {
    registration: { scope: SCOPE },
    caches: storage as unknown as CacheStorage,
    clients: { claim: async () => void (state.claimed += 1) },
    skipWaiting: async () => void (state.skipped += 1),
    fetch: async (request: Request) => {
      network.push(request.url);
      return new Response(`network ${request.url}`);
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
  } as unknown as SwGlobal;
  const extendable = async (type: string) => {
    const pending: Promise<unknown>[] = [];
    listeners[type]!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };
  const fetchVia = async (url: string, mode?: RequestMode) => {
    let response: Promise<Response> | null = null;
    const request = new Request(url, mode ? { mode: mode === 'navigate' ? 'same-origin' : mode } : {});
    const event = {
      request: mode === 'navigate' ? { method: 'GET', url, mode: 'navigate' } : request,
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    };
    listeners.fetch!(event);
    return response ? await (response as Promise<Response>).then((r) => r.text()) : null;
  };
  return { sw, caches, listeners, network, state, extendable, fetchVia };
}

const MANIFEST: ShellManifest = { version: 'v2', files: ['index.html', 'assets/index-abc.js'] };

describe('installServiceWorker', () => {
  it('precaches the shell on install without taking over', async () => {
    const worker = fakeWorker();
    installServiceWorker(worker.sw, MANIFEST);
    await worker.extendable('install');
    expect(worker.caches.get(shellCacheName('v2'))!.added).toEqual([`${SCOPE}index.html`, `${SCOPE}assets/index-abc.js`]);
    expect(worker.state.skipped).toBe(0);
  });

  it('drops older shells and claims clients on activate', async () => {
    const worker = fakeWorker();
    await worker.sw.caches.open(shellCacheName('v1'));
    installServiceWorker(worker.sw, MANIFEST);
    await worker.extendable('install');
    await worker.extendable('activate');
    expect([...worker.caches.keys()]).toEqual([shellCacheName('v2')]);
    expect(worker.state.claimed).toBe(1);
  });

  it('skips waiting only when the page asks', () => {
    const worker = fakeWorker();
    installServiceWorker(worker.sw, MANIFEST);
    worker.listeners.message!({ data: { type: 'other' } });
    worker.listeners.message!({ data: null });
    expect(worker.state.skipped).toBe(0);
    worker.listeners.message!({ data: { type: SKIP_WAITING } });
    expect(worker.state.skipped).toBe(1);
  });

  it('opens the shell offline and leaves daemon traffic to the network', async () => {
    const worker = fakeWorker();
    installServiceWorker(worker.sw, MANIFEST);
    await worker.extendable('install');
    expect(await worker.fetchVia(SCOPE, 'navigate')).toBe(`cached ${SCOPE}index.html`);
    expect(await worker.fetchVia(`${SCOPE}assets/index-abc.js`)).toBe(`cached ${SCOPE}assets/index-abc.js`);
    expect(await worker.fetchVia(`${SCOPE}dm/health`)).toBeNull();
    expect(await worker.fetchVia('http://127.0.0.1:9470/v1/models')).toBeNull();
    expect(worker.network).toEqual([]);
  });

  it('falls back to the network for a listed file missing from the cache', async () => {
    const worker = fakeWorker();
    installServiceWorker(worker.sw, MANIFEST);
    expect(await worker.fetchVia(`${SCOPE}assets/index-abc.js`)).toBe(`network ${SCOPE}assets/index-abc.js`);
  });
});
