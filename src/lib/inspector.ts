/**
 * The wire tap — a record of every frame the desk speaks, for the
 * JSON-RPC inspector.
 *
 * All three transports push their traffic through one `WireTap`:
 *   - `daemon`  real JSON-RPC v2 over `/ws` (RpcClient records the
 *               request, the response and every `session.event` push)
 *   - `demo`    the simulated daemon's own frames, in the same envelope
 *   - `openai`  the HTTP request plus each SSE chunk
 *
 * The tap is a ring buffer, not a log: the newest `limit` frames survive
 * and `dropped` says how many fell off the front. React subscribes to it
 * directly (the frame stream changes per token and must not re-render the
 * whole desk), so a snapshot is cached until the next record.
 */

export type WireDirection = 'tx' | 'rx';

/** What the frame is on the wire. */
export type WireKind =
  | 'request'
  | 'result'
  | 'error'
  | 'notification'
  | 'hello'
  /** one SSE / streamed data frame */
  | 'chunk';

export type WireProtocol = 'jsonrpc' | 'sse' | 'http';

export interface WireFrame {
  /** Monotonic within the tap, survives `clear` so rows never collide. */
  seq: number;
  at: number;
  dir: WireDirection;
  kind: WireKind;
  /** `turn.start`, `session.event`, `chat.completion.chunk`, `https POST /v1/...` */
  method: string;
  protocol: WireProtocol;
  /** JSON-RPC id — present on requests and their responses. */
  id?: number | string;
  sessionId?: string;
  /** Round trip for a response frame, ms. */
  latencyMs?: number;
  /** Serialized size of the payload, bytes (approximate). */
  bytes: number;
  /** Tool / approval traffic — the third filter chip. */
  tool?: boolean;
  status?: 'ok' | 'error';
  payload: unknown;
}

export type WireDraft = Omit<WireFrame, 'seq' | 'at' | 'bytes'> & { at?: number };

export type InspectorFilter = 'all' | 'tx' | 'rx' | 'tools';

export const INSPECTOR_FILTERS: Array<{ id: InspectorFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'tx', label: 'TX' },
  { id: 'rx', label: 'RX' },
  { id: 'tools', label: '툴·승인' },
];

export interface WireSnapshot {
  frames: readonly WireFrame[];
  /** Frames that fell off the front of the ring. */
  dropped: number;
  tx: number;
  rx: number;
  /** Requests still waiting for their response frame. */
  inflight: number;
  /** Errors seen since the last clear (response errors and failed pushes). */
  errors: number;
}

const DEFAULT_LIMIT = 400;
const NOTIFY_MS = 70;

/** `session.event` from `data.type` / `data.kind`. */
function eventLabel(frame: WireDraft): string {
  if (frame.method !== 'session.event') return '';
  const data = (frame.payload as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data || typeof data !== 'object') return '';
  const type = typeof data.type === 'string' ? data.type : '';
  const kind = typeof data.kind === 'string' ? data.kind : '';
  return [type, kind].filter(Boolean).join('.');
}

/**
 * Tool and approval traffic: a call, an ask, a plan, or a decision about
 * one. Kept as a wire fact (method + event kind), not as a UI guess.
 */
export function isToolTraffic(frame: WireDraft): boolean {
  const method = frame.method;
  if (
    method === 'turn.steer' ||
    method === 'permission.respond' ||
    method.startsWith('plan.') ||
    method === 'session.fork'
  ) {
    return true;
  }
  const label = eventLabel(frame);
  return (
    label.includes('tool_call') ||
    label.startsWith('permission_requested') ||
    label.startsWith('permission_resolved') ||
    label.startsWith('plan_requested') ||
    label.startsWith('todo')
  );
}

function bytesOf(payload: unknown): number {
  try {
    const json = JSON.stringify(payload);
    return json ? json.length : 0;
  } catch {
    return 0;
  }
}

function isErrorFrame(frame: WireDraft): boolean {
  if (frame.status === 'error') return true;
  if (frame.kind === 'error') return true;
  const data = (frame.payload as { data?: Record<string, unknown> } | undefined)?.data;
  if (data && typeof data === 'object') {
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'turn_failed' || (type === 'timeline' && data.kind === 'error')) return true;
  }
  return false;
}

export class WireTap {
  private frames: WireFrame[] = [];
  private seq = 0;
  private dropped = 0;
  private cached: WireSnapshot | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    deps: { now?: () => number } = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WireSnapshot => {
    if (this.cached) return this.cached;
    let tx = 0;
    let rx = 0;
    let errors = 0;
    const answered = new Set<number | string>();
    const inflight = new Set<number | string>();
    for (const frame of this.frames) {
      if (frame.dir === 'tx') {
        tx += 1;
        if (frame.kind === 'request' && frame.id !== undefined) inflight.add(frame.id);
      } else {
        rx += 1;
        if (frame.id !== undefined) {
          answered.add(frame.id);
          inflight.delete(frame.id);
        }
      }
      if (isErrorFrame(frame)) errors += 1;
    }
    this.cached = {
      frames: this.frames,
      dropped: this.dropped,
      tx,
      rx,
      inflight: inflight.size,
      errors,
    };
    return this.cached;
  };

  /** Record one frame; the tap stamps seq, time and size. */
  record(draft: WireDraft): WireFrame {
    const frame: WireFrame = {
      ...draft,
      seq: (this.seq += 1),
      at: draft.at ?? this.now(),
      bytes: bytesOf(draft.payload),
      tool: draft.tool ?? isToolTraffic(draft),
    };
    this.frames = [...this.frames, frame];
    if (this.frames.length > this.limit) {
      const overflow = this.frames.length - this.limit;
      this.frames = this.frames.slice(overflow);
      this.dropped += overflow;
    }
    this.cached = null;
    this.schedule();
    return frame;
  }

  clear(): void {
    this.frames = [];
    this.dropped = 0;
    this.cached = null;
    this.flush();
  }

  get size(): number {
    return this.frames.length;
  }

  /** The frames as a copyable transcript (pretty JSON, one frame per block). */
  toText(filter: InspectorFilter = 'all'): string {
    const rows = this.frames.filter((frame) => frameMatches(filter, frame));
    if (rows.length === 0) return '';
    const lines = [`# damon-chat-desk · JSON-RPC inspector · ${rows.length} frames`];
    for (const frame of rows) {
      const head = [
        stamp(frame.at),
        frame.dir === 'tx' ? '→ TX' : '← RX',
        frame.method,
        frame.id !== undefined ? `#${frame.id}` : '',
        frame.latencyMs !== undefined ? `${Math.round(frame.latencyMs)}ms` : '',
        `${frame.bytes}B`,
      ]
        .filter(Boolean)
        .join('  ');
      lines.push('', head, JSON.stringify(frame.payload, null, 2));
    }
    return lines.join('\n');
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, NOTIFY_MS);
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const listener of this.listeners) listener();
  }
}

export function frameMatches(filter: InspectorFilter, frame: WireFrame | WireDraft): boolean {
  switch (filter) {
    case 'tx':
      return frame.dir === 'tx';
    case 'rx':
      return frame.dir === 'rx';
    case 'tools':
      return frame.tool === true;
    default:
      return true;
  }
}

/** `15:02:31.284` — local wall clock, millisecond precision. */
export function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** The event / payload name under the method — `timeline.tool_call`. */
export function frameDetail(frame: WireFrame): string {
  const label = eventLabel(frame);
  if (label) return label;
  if (frame.kind === 'hello') return 'handshake';
  if (frame.kind === 'request') return 'request';
  if (frame.kind === 'result') return 'result';
  if (frame.kind === 'error') return 'error';
  return frame.protocol === 'sse' ? 'sse' : 'push';
}

function shortJson(value: unknown, max = 90): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One-line preview for a row: the tool name and command, the prompt, the
 * result keys — whatever a reader would look for first.
 */
export function frameSummary(frame: WireFrame): string {
  const payload = frame.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return shortJson(payload);
  const params = (payload.params ?? payload.data ?? payload.result ?? payload.error ?? payload) as Record<string, unknown>;

  if (frame.method === 'session.event' && params && typeof params === 'object') {
    const data = params as Record<string, unknown>;
    if (data.kind === 'tool_call') {
      const detail = (data.detail ?? {}) as Record<string, unknown>;
      return shortJson([data.name, detail.command ?? detail.path ?? detail.query ?? data.title].filter(Boolean).join(' · '), 110);
    }
    if (typeof data.text === 'string') return shortJson(data.text, 110);
    const id = data.request_id ?? data.id;
    return shortJson(
      [data.type, data.kind, data.name ?? data.title ?? data.stopReason ?? data.reason, id ? `#${String(id)}` : '']
        .filter(Boolean)
        .join(' · '),
      110,
    );
  }

  if (frame.kind === 'request' && params && typeof params === 'object') {
    const entries = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${shortJson(value, 60)}`);
    return shortJson(entries.join(' '), 120);
  }
  if (frame.kind === 'error') {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    return shortJson(`${String(error.code ?? '')} ${String(error.message ?? '')}`.trim(), 110);
  }
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const keys = Object.keys(params);
    if (keys.length === 0) return '{}';
    return shortJson(keys.map((key) => `${key}=${shortJson(params[key], 40)}`).join(' '), 120);
  }
  return shortJson(frame.payload);
}

/** Pretty payload for the expanded row — invalid values never throw. */
export function frameBody(frame: WireFrame): string {
  try {
    return JSON.stringify(frame.payload, null, 2) ?? '';
  } catch {
    return String(frame.payload);
  }
}
