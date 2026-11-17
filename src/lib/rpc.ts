/**
 * JSON-RPC v2 over WebSocket — the daemon's real wire (see
 * damon-agent-core docs/protocol-v2.md).
 *
 * One socket multiplexes every session. Requests carry an id; server
 * pushes carry no id and an `event` name. The socket factory is
 * injectable so the handshake and the event fan-out are unit-tested
 * against a fake socket instead of a daemon.
 */

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorShape) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** Human hint for the daemon's stable error codes. */
export function rpcErrorHint(code: number): string {
  switch (code) {
    case -32001:
      return 'session not live — resume it and retry';
    case -32002:
      return 'this backend lacks that capability';
    case -32003:
      return 'backend not installed or not detected';
    case -32004:
      return 'session cap reached — close or delete one';
    case -32006:
      return 'a turn is already running on this session';
    default:
      return '';
  }
}

export interface ServerEvent {
  event: string;
  sessionId?: string;
  runId?: string;
  creationId?: string;
  data?: unknown;
}

export type EventHandler = (event: ServerEvent) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HelloPayload {
  protocol: number;
  daemon: string;
  version: string;
  backends?: string[];
  methods?: unknown[];
  remoteClients?: number;
  permissionTimeoutSecs?: number;
}

export class RpcClient {
  private socket: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<EventHandler>();
  hello: HelloPayload | null = null;

  constructor(
    private readonly factory: SocketFactory = defaultSocketFactory,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Open the socket and wait for the daemon`s `hello` frame. */
  connect(url: string, timeoutMs = 8000): Promise<HelloPayload> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('daemon handshake timed out'));
      }, timeoutMs);

      const socket = this.factory(url);
      this.socket = socket;

      socket.onopen = () => {
        /* hello follows on the wire */
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('socket error — check the daemon URL'));
      };
      socket.onclose = () => {
        this.socket = null;
        this.failAll(new Error('socket closed'));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('socket closed before hello'));
        }
      };
      socket.onmessage = (message) => {
        const frame = parseFrame(message.data);
        if (!frame) return;
        if ('hello' in frame && frame.hello) {
          this.hello = frame.hello;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(frame.hello);
          }
          return;
        }
        if ('id' in frame && typeof frame.id === 'number') {
          this.settle(frame.id, frame);
          return;
        }
        if ('event' in frame && typeof frame.event === 'string') {
          for (const handler of this.handlers) {
            handler({
              event: frame.event,
              sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
              runId: typeof frame.runId === 'string' ? frame.runId : undefined,
              creationId: typeof frame.creationId === 'string' ? frame.creationId : undefined,
              data: frame.data,
            });
          }
        }
      };
    });
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('not connected to the daemon'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private settle(id: number, frame: { result?: unknown; error?: RpcErrorShape }): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (frame.error) pending.reject(new RpcError(frame.error));
    else pending.resolve(frame.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.failAll(new Error('connection closed'));
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
  }
}

interface FrameShape {
  id?: number;
  result?: unknown;
  error?: RpcErrorShape;
  hello?: HelloPayload;
  event?: string;
  sessionId?: string;
  runId?: string;
  creationId?: string;
  data?: unknown;
}

export function parseFrame(raw: unknown): FrameShape | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as FrameShape;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

export function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * ws(s):// URL for a daemon base URL, with the one-shot ticket.
 * A relative base (`/dm`) resolves against the page origin, so the same
 * code works behind a dev proxy and against an absolute daemon URL.
 */
export function wsUrlFor(baseUrl: string, ticket?: string): string {
  const base = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1';
  const url = new URL(baseUrl.replace(/\/+$/, ''), base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  url.search = '';
  if (ticket) url.searchParams.set('ticket', ticket);
  return url.toString();
}
