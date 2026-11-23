/**
 * JSON-RPC v2 over WebSocket — the daemon's real wire (see
 * damon-agent-core docs/protocol-v2.md).
 *
 * One socket multiplexes every session. Requests carry an id; server
 * pushes carry no id and an `event` name. The socket factory is
 * injectable so the handshake and the event fan-out are unit-tested
 * against a fake socket instead of a daemon.
 *
 * Every frame this client puts on the wire or takes off it is also
 * handed to the optional `WireTap`, which is what the inspector renders.
 * The tap never changes behaviour: a frame is recorded after it has been
 * sent or parsed.
 */

import type { WireTap } from './inspector';
import { PROTOCOL_CAPABILITIES, type ProtocolCapability } from './types';

/** What this client calls itself in `hello`'s `client` field. */
export const CLIENT_NAME = 'damon-chat-desk';
export const CLIENT_VERSION = '0.1.0';

/** The MAJOR protocol version this client speaks (protocol v2). */
export const CLIENT_PROTOCOL = 2;

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
    case -32012:
      return 'the daemon does not speak this protocol version — update the desk or the daemon';
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
  /**
   * The session's event cursor, on `session.event` frames. Strictly
   * increasing per session; a jump means events were lost.
   */
  seq?: number;
  /** True on catch-up history a fresh subscription replays. */
  replay?: boolean;
  /** `session.gap` / `session.snapshot_required`: where the numbering stands. */
  cursor?: number;
  /** `session.gap`: how many events this connection never received. */
  dropped?: number;
  /** `session.snapshot_required`: `journal_overflow` today. */
  reason?: string;
}

export type EventHandler = (event: ServerEvent) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  sentAt: number;
}

export interface HelloPayload {
  protocol: number;
  /** Oldest version the daemon still answers (protocol v2 daemons only). */
  minProtocol?: number;
  /** Every version the daemon accepts — present means it negotiates. */
  supported?: number[];
  /** Feature gates; an absent key means the daemon does not promise it. */
  capabilities?: Record<string, unknown>;
  daemon: string;
  version: string;
  backends?: string[];
  methods?: unknown[];
  remoteClients?: number;
  permissionTimeoutSecs?: number | null;
}

/** `hello.capabilities` as six booleans; anything absent reads false. */
export function capabilitiesOf(hello: HelloPayload | null | undefined): Record<ProtocolCapability, boolean> {
  const raw = hello?.capabilities ?? {};
  const out = {} as Record<ProtocolCapability, boolean>;
  for (const key of PROTOCOL_CAPABILITIES) out[key] = raw[key] === true;
  return out;
}

/** True when the daemon offered a version range, i.e. it can negotiate. */
export function negotiatesProtocol(hello: HelloPayload | null | undefined): boolean {
  return Array.isArray(hello?.supported) && hello.supported.length > 0;
}

export class RpcClient {
  private socket: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<EventHandler>();
  private closeHandlers = new Set<() => void>();
  hello: HelloPayload | null = null;
  /** True when the handshake was confirmed with a versioned `hello`. */
  negotiated = false;

  constructor(
    private readonly factory: SocketFactory = defaultSocketFactory,
    private readonly requestTimeoutMs = 30_000,
    private readonly tap?: WireTap,
  ) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Open the socket and wait for the daemon's `hello` frame.
   *
   * A daemon that advertises `supported[]` is also asked (`hello` as a
   * request) to confirm the version this client speaks. That request is
   * what turns a silent mismatch into one typed failure (-32012); a daemon
   * that predates negotiation sends no `supported[]` and stays on the old
   * path, byte for byte.
   */
  connect(url: string, timeoutMs = 8000): Promise<HelloPayload> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('daemon handshake timed out'));
      }, timeoutMs);

      const finish = (hello: HelloPayload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(hello);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      /** Confirm the version, then resolve with the merged `hello`. */
      const negotiate = (hello: HelloPayload) => {
        this.request<HelloPayload>(
          'hello',
          { protocolVersion: CLIENT_PROTOCOL, client: { name: CLIENT_NAME, version: CLIENT_VERSION } },
          timeoutMs,
        )
          .then((answer) => {
            this.negotiated = true;
            const merged: HelloPayload = { ...hello, ...answer };
            this.hello = merged;
            finish(merged);
          })
          .catch((error: unknown) => {
            if (error instanceof RpcError && error.code === -32012) {
              const data = error.data as { supported?: unknown } | undefined;
              const supported = Array.isArray(data?.supported) ? (data.supported as number[]) : undefined;
              fail(
                new Error(
                  `daemon speaks protocol ${supported?.join('/') ?? '?'} — this desk speaks ${CLIENT_PROTOCOL}. ` +
                    'Update the desk or the daemon to connect.',
                ),
              );
              return;
            }
            // A daemon without the request form answers -32601; the push
            // hello it already sent is the whole handshake.
            if (error instanceof RpcError && error.code === -32601) {
              this.negotiated = false;
              finish(hello);
              return;
            }
            fail(error instanceof Error ? error : new Error(String(error)));
          });
      };

      const socket = this.factory(url);
      this.socket = socket;

      socket.onopen = () => {
        /* hello follows on the wire */
      };
      socket.onerror = () => {
        fail(new Error('socket error — check the daemon URL'));
      };
      socket.onclose = () => {
        const wasOpen = this.hello !== null;
        this.socket = null;
        this.failAll(new Error('socket closed'));
        fail(new Error('socket closed before hello'));
        if (wasOpen) for (const handler of this.closeHandlers) handler();
      };
      socket.onmessage = (message) => {
        const frame = parseFrame(message.data);
        if (!frame) return;
        if ('hello' in frame && frame.hello) {
          this.hello = frame.hello;
          this.tap?.record({
            dir: 'rx',
            kind: 'hello',
            method: 'hello',
            protocol: 'jsonrpc',
            payload: { hello: frame.hello },
          });
          if (!settled) {
            // A daemon that offers a version range is asked to confirm
            // it; one that does not is already done handshaking.
            if (negotiatesProtocol(frame.hello)) negotiate(frame.hello);
            else finish(frame.hello);
          }
          return;
        }
        if ('id' in frame && typeof frame.id === 'number') {
          this.settle(frame.id, frame);
          return;
        }
        if ('event' in frame && typeof frame.event === 'string') {
          this.tap?.record({
            dir: 'rx',
            kind: 'notification',
            method: frame.event,
            protocol: 'jsonrpc',
            sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
            payload: frame,
          });
          for (const handler of this.handlers) {
            handler({
              event: frame.event,
              sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
              runId: typeof frame.runId === 'string' ? frame.runId : undefined,
              creationId: typeof frame.creationId === 'string' ? frame.creationId : undefined,
              data: frame.data,
              seq: typeof frame.seq === 'number' ? frame.seq : undefined,
              replay: frame.replay === true,
              cursor: typeof frame.cursor === 'number' ? frame.cursor : undefined,
              dropped: typeof frame.dropped === 'number' ? frame.dropped : undefined,
              reason: typeof frame.reason === 'string' ? frame.reason : undefined,
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
      const sentAt = Date.now();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
        sentAt,
      });
      const envelope = { id, method, params };
      this.tap?.record({
        dir: 'tx',
        kind: 'request',
        method,
        protocol: 'jsonrpc',
        id,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        payload: envelope,
      });
      socket.send(JSON.stringify(envelope));
    });
  }

  private settle(id: number, frame: { result?: unknown; error?: RpcErrorShape }): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.tap?.record({
      dir: 'rx',
      kind: frame.error ? 'error' : 'result',
      method: pending.method,
      protocol: 'jsonrpc',
      id,
      latencyMs: Date.now() - pending.sentAt,
      status: frame.error ? 'error' : 'ok',
      payload: frame,
    });
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

  /** The socket dropped after the handshake (not on `close()`). */
  onClosed(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
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
  seq?: number;
  replay?: boolean;
  cursor?: number;
  dropped?: number;
  reason?: string;
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
