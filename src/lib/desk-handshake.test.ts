import { describe, expect, it } from 'vitest';
import { DeskController } from './desk';
import { DemoTransport } from './demo';
import type { SocketLike } from './rpc';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface WireOptions {
  hello: Record<string, unknown>;
  /** Answer the versioned `hello` request, or refuse it like an old daemon. */
  helloAnswer?: 'result' | 'unsupported' | 'unknown-method';
}

/**
 * A socket that answers like the daemon: the push `hello`, then every
 * request this client makes during connect (hello, catalog.models,
 * session.list, memory.*).
 */
class DaemonSocket implements SocketLike {
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  constructor(private readonly options: WireOptions) {}

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { id?: number; method?: string };
    setTimeout(() => this.answer(frame), 0);
  }

  private answer(frame: { id?: number; method?: string }): void {
    if (typeof frame.id !== 'number') return;
    const id = frame.id;
    switch (frame.method) {
      case 'hello':
        if (this.options.helloAnswer === 'unsupported') {
          this.deliver({ id, error: { code: -32012, message: 'unsupported', data: { requested: 2, supported: [3] } } });
          return;
        }
        if (this.options.helloAnswer === 'unknown-method') {
          this.deliver({ id, error: { code: -32601, message: 'unknown method' } });
          return;
        }
        this.deliver({ id, result: { ...this.options.hello, methods: [{ name: 'hello' }] } });
        return;
      case 'catalog.models':
        this.deliver({ id, result: { models: [] } });
        return;
      case 'session.list':
        this.deliver({ id, result: { sessions: [] } });
        return;
      case 'memory.list':
        this.deliver({ id, result: { entries: [] } });
        return;
      case 'memory.usage':
        this.deliver({ id, result: { chars: 0, limit: 8000 } });
        return;
      default:
        this.deliver({ id, result: {} });
    }
  }

  close(): void {
    this.onclose?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Open the connection the way a daemon does: hello first. */
  open(): void {
    this.onopen?.();
    this.deliver({ hello: this.options.hello });
  }
}

const MODERN_HELLO = {
  protocol: 2,
  minProtocol: 2,
  supported: [2],
  capabilities: {
    eventSeq: true,
    snapshotRequired: true,
    connGap: true,
    idempotentTurns: true,
    turnLedger: true,
    versionNegotiation: true,
  },
  daemon: 'damond',
  version: '0.9.0',
  backends: ['claude'],
  permissionTimeoutSecs: 300,
};

function env(options: WireOptions) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', version: '0.9.0', backends: ['claude'] }), { status: 200 });
    }
    if (url.endsWith('/v1/ws_ticket')) {
      return new Response(JSON.stringify({ ticket: 't-1' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const sockets: DaemonSocket[] = [];
  const socketFactory = (): SocketLike => {
    const socket = new DaemonSocket(options);
    sockets.push(socket);
    setTimeout(() => socket.open(), 0);
    return socket;
  };
  return { fetchImpl, socketFactory, sockets };
}

describe('DeskController — protocol v2 handshake', () => {
  it('records what the daemon promised, and reports it on the connection card', async () => {
    const deps = env({ hello: MODERN_HELLO });
    const desk = new DeskController({
      storage: new MemoryStorage(),
      demo: new DemoTransport({ sleep: async () => undefined }),
      fetchImpl: deps.fetchImpl,
      socketFactory: deps.socketFactory,
    });
    await desk.connect('daemon', 'http://127.0.0.1:9470');

    const connection = desk.getSnapshot().connection;
    expect(connection.status).toBe('live');
    expect(connection.protocol).toMatchObject({ version: 2, min: 2, supported: [2], negotiated: true });
    expect(connection.protocol?.capabilities.eventSeq).toBe(true);
    expect(connection.protocol?.capabilities.idempotentTurns).toBe(true);
    expect(connection.probeNote).toContain('protocol v2');
    expect(connection.probeNote).toContain('(negotiated)');
    expect(connection.probeNote).toContain('6/6 capabilities');
  });

  it('says plainly what an older daemon cannot do', async () => {
    // A 0.7-era daemon: no version range, no capabilities, no negotiation.
    const deps = env({ hello: { protocol: 2, daemon: 'damond', version: '0.7.2', backends: ['claude'] } });
    const desk = new DeskController({
      storage: new MemoryStorage(),
      demo: new DemoTransport({ sleep: async () => undefined }),
      fetchImpl: deps.fetchImpl,
      socketFactory: deps.socketFactory,
    });
    await desk.connect('daemon', 'http://127.0.0.1:9470');

    const connection = desk.getSnapshot().connection;
    expect(connection.status).toBe('live');
    expect(connection.protocol).toMatchObject({ version: 2, negotiated: false });
    expect(connection.protocol?.capabilities.eventSeq).toBe(false);
    expect(connection.probeNote).toContain('0/6 capabilities');
  });

  it('refuses to pretend it can talk to a daemon on another protocol', async () => {
    const deps = env({ hello: MODERN_HELLO, helloAnswer: 'unsupported' });
    const desk = new DeskController({
      storage: new MemoryStorage(),
      demo: new DemoTransport({ sleep: async () => undefined }),
      fetchImpl: deps.fetchImpl,
      socketFactory: deps.socketFactory,
    });
    await desk.connect('daemon', 'http://127.0.0.1:9470');

    const connection = desk.getSnapshot().connection;
    expect(connection.status).toBe('error');
    expect(connection.error).toContain('protocol');
    expect(connection.protocol).toBeUndefined();
  });

  it('still connects to a daemon that answers hello as a push only', async () => {
    const deps = env({ hello: MODERN_HELLO, helloAnswer: 'unknown-method' });
    const desk = new DeskController({
      storage: new MemoryStorage(),
      demo: new DemoTransport({ sleep: async () => undefined }),
      fetchImpl: deps.fetchImpl,
      socketFactory: deps.socketFactory,
    });
    await desk.connect('daemon', 'http://127.0.0.1:9470');

    const connection = desk.getSnapshot().connection;
    expect(connection.status).toBe('live');
    expect(connection.protocol).toMatchObject({ version: 2, negotiated: false });
    expect(connection.protocol?.capabilities.eventSeq).toBe(true);
  });
});
