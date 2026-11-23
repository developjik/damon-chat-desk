/**
 * The service worker's whole policy, kept free of worker globals so the
 * tests drive it with fakes (`src/sw.ts` is the two-line entry).
 *
 * Only the app shell is ever cached: the files the build listed, plus
 * `index.html` for in-scope navigations. Daemon and model traffic —
 * `/dm` proxy, `/health`, `/v1/*`, `/ws`, any other origin — is never
 * intercepted, so a stale answer can never pose as a live daemon.
 */

export interface ShellManifest {
  /** Content hash of the shell; a new build gets a new cache. */
  version: string;
  /** Paths relative to the worker scope, e.g. `index.html`, `assets/x.js`. */
  files: string[];
}

export const SHELL_CACHE_PREFIX = 'damon-desk-shell-';
export const SHELL_INDEX = 'index.html';
export const SKIP_WAITING = 'SKIP_WAITING';

/** First path segments that belong to a daemon or model server. */
const NEVER_CACHE = new Set(['dm', 'ws', 'health', 'v1', 'api']);

export type FetchDecision = { kind: 'bypass' } | { kind: 'shell'; key: string };

export interface RequestLike {
  method: string;
  url: string;
  mode?: string;
}

export function shellCacheName(version: string): string {
  return `${SHELL_CACHE_PREFIX}${version}`;
}

/** Caches from earlier shells — dropped once the new worker activates. */
export function staleShellCaches(keys: string[], version: string): string[] {
  const current = shellCacheName(version);
  return keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== current);
}

export function isNeverCached(relativePath: string): boolean {
  const first = relativePath.replace(/^\/+/, '').split('/')[0] ?? '';
  return NEVER_CACHE.has(first.toLowerCase());
}

/**
 * Answer from the shell cache, or leave the request to the network.
 * `scope` is the registration scope (`https://host/damon-chat-desk/`).
 */
export function decideFetch(request: RequestLike, scope: string, files: ReadonlySet<string>): FetchDecision {
  if (request.method !== 'GET') return { kind: 'bypass' };
  let url: URL;
  let base: URL;
  try {
    url = new URL(request.url);
    base = new URL(scope);
  } catch {
    return { kind: 'bypass' };
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return { kind: 'bypass' };
  const relative = url.pathname.slice(base.pathname.length);
  if (isNeverCached(relative)) return { kind: 'bypass' };

  if (request.mode === 'navigate') {
    const last = relative.split('/').pop() ?? '';
    if (last.includes('.') && !last.endsWith('.html')) return { kind: 'bypass' };
    return { kind: 'shell', key: new URL(SHELL_INDEX, base).href };
  }
  if (url.search === '' && files.has(relative)) return { kind: 'shell', key: new URL(relative, base).href };
  return { kind: 'bypass' };
}

/* ------------------------------------------------------------------ */
/* worker wiring                                                       */
/* ------------------------------------------------------------------ */

export interface SwExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SwFetchEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

export interface SwMessageEvent {
  data: unknown;
}

/** The slice of `ServiceWorkerGlobalScope` the worker uses. */
export interface SwGlobal {
  registration: { scope: string };
  caches: CacheStorage;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: SwMessageEvent) => void): void;
}

/**
 * A new shell installs next to the running one and waits: the page shows
 * an "update" prompt and posts `SKIP_WAITING` when the user accepts, so a
 * half-typed message is never lost to a surprise reload.
 */
export function installServiceWorker(sw: SwGlobal, manifest: ShellManifest): void {
  const cacheName = shellCacheName(manifest.version);
  const files = new Set(manifest.files);

  sw.addEventListener('install', (event) => {
    event.waitUntil(
      sw.caches.open(cacheName).then((cache) =>
        // `reload` skips the HTTP cache: Pages serves index.html with a
        // max-age, and a stale one would point at assets that are gone.
        cache.addAll(manifest.files.map((file) => new Request(new URL(file, sw.registration.scope).href, { cache: 'reload' }))),
      ),
    );
  });

  sw.addEventListener('activate', (event) => {
    event.waitUntil(
      sw.caches
        .keys()
        .then((keys) => Promise.all(staleShellCaches(keys, manifest.version).map((key) => sw.caches.delete(key))))
        .then(() => sw.clients.claim()),
    );
  });

  sw.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown } | null;
    if (data && data.type === SKIP_WAITING) void sw.skipWaiting();
  });

  sw.addEventListener('fetch', (event) => {
    const decision = decideFetch(event.request, sw.registration.scope, files);
    if (decision.kind === 'bypass') return;
    event.respondWith(
      sw.caches
        .open(cacheName)
        .then((cache) => cache.match(decision.key))
        .then((hit) => hit ?? sw.fetch(event.request)),
    );
  });
}
