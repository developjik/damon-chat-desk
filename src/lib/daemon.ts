/**
 * damon-agent-core transport — JSON-RPC v2 over `/ws`.
 *
 * This mirrors the daemon's actual surface (src/api.rs +
 * docs/protocol-v2.md in developjik/damon-agent-core):
 *
 *   GET  /health           {status, version, backends[]}   (loopback only
 *                          exposes version + roster)
 *   POST /v1/ws_ticket     master `Authorization: Bearer` or `{deviceToken}`
 *   POST /v1/pair          {pairingKey, name} → {deviceId, token, status}
 *   POST /v1/pair/status   {deviceId, token} → {status}
 *   GET  /ws?ticket=…      JSON-RPC: session.*, turn.*, memory.*, catalog.*
 *
 * Memory: list/write/remove/approve/reject per ledger (`user`, or a bot
 * named by `owner`), usage counts ACTIVE chars only. Sessions: list,
 * rename, set_archived, delete, export.
 *
 * Note the daemon no longer serves OpenAI-compatible `/v1/models` or
 * `/v1/chat/completions` (removed upstream; agents answer, not a proxy).
 * The desk detects which surface is there and speaks the right one —
 * see `detect.ts`.
 */

import {
  RpcClient,
  RpcError,
  capabilitiesOf,
  rpcErrorHint,
  type HelloPayload,
  type ServerEvent,
  type SocketFactory,
  wsUrlFor,
} from './rpc';
import type { WireTap } from './inspector';
import { DeliveryTracker } from './delivery';
import { normalizeSessionStatus } from './phases';
import type {
  ChatMessage,
  DaemonHealth,
  MemoryEntry,
  MemoryScope,
  PermissionAsk,
  PlanDecision,
  ProtocolCapability,
  ProtocolState,
  RecoveredSession,
  ReplySlot,
  RouteTarget,
  SessionStatusRow,
  StreamEvent,
  Usage,
} from './types';
import { makeTarget, targetKey } from './targets';
import { buildPlan } from './plan';
import { normalizeToolCall } from './tools';
import { fetcher } from './http';

export const BACKEND_TITLES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  omp: 'Oh My Pi',
  pi: 'Pi',
  qwen: 'Qwen Code',
  droid: 'Droid',
  opencode: 'OpenCode',
  mimo: 'MiMo Code',
  zcode: 'ZCode',
};

export function backendTitle(id: string): string {
  return BACKEND_TITLES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** `localhost:9470` → `http://localhost:9470`. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:9470';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A path means "same origin, behind a proxy" — the Vite /dm proxy is
  // how a browser reaches a daemon whose own routes send no CORS headers.
  if (trimmed.startsWith('/')) return trimmed;
  return `http://${trimmed}`;
}

/** What `session.status` answered, with the capability's verdict attached. */
export interface SessionStatusResult {
  /** False when this daemon never promised `capabilities.sessionPhase`. */
  supported: boolean;
  rows: SessionStatusRow[];
  recovered: RecoveredSession[];
}

export interface DaemonConfig {
  baseUrl: string;
  /** Master `auth_token` from the daemon config (loopback needs none). */
  masterToken?: string;
  /** Device token obtained through `POST /v1/pair` + approval. */
  deviceToken?: string;
}

export interface DaemonDeps {
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  /** The inspector's tap: every JSON-RPC frame on this transport. */
  tap?: WireTap;
}

export interface DaemonPlanRow {
  planId: string;
  sessionId: string;
  requestId?: string;
  revision: number;
  title?: string;
  content?: string;
  complete?: boolean;
  status?: string;
  decision?: string | null;
  supersededBy?: string | null;
}

export interface DaemonSessionRow {
  sessionId: string;
  createdAt: number;
  backend: string;
  title?: string | null;
  cwd?: string | null;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
}

/** Where a session's event numbering stands, as the daemon reports it. */
export interface SessionCursor {
  sessionId: string;
  backend?: string;
  /** Replay-tagged frames the subscription sent for missed history. */
  replayed?: number;
  /** The newest `seq` handed out so far; the next live frame continues it. */
  cursor?: number;
  subscribed?: boolean;
}

/** `turn.start`'s answer — including the Keyed-retry shapes. */
export interface TurnStartResult {
  turnId?: string;
  stopReason?: string;
  usage?: unknown;
  /** A repeated `idempotencyKey`: this answer is the first attempt's. */
  duplicate?: boolean;
  /** That attempt is still running; this connection is now subscribed to it. */
  inProgress?: boolean;
  detached?: boolean;
}

/** A turn attached to another connection may never end; bound the wait. */
const ATTACHED_TURN_TIMEOUT_MS = 10 * 60_000;

/** `session.export` — the daemon's own serialization of one session. */
export interface DaemonSessionExport {
  session?: { sessionId: string; createdAt?: number; backend?: string; title?: string | null; tags?: string[]; cwd?: string | null };
  messages?: Array<{ id: number | string; role: string; ts?: number; data?: { content?: string; items?: string[] } | null }>;
  usage?: { contextUsed?: number; contextSize?: number; costUsd?: number; turns?: number };
}

interface StoredMessage {
  id: number | string;
  session_id?: string;
  role: string;
  ts?: number;
  data?: { content?: string; items?: string[] } | null;
}

export function mapDaemonMessages(rows: StoredMessage[], target: RouteTarget): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: ChatMessage | null = null;
  for (const row of rows) {
    const text = row.data?.content ?? '';
    if (row.role === 'user') {
      pending = null;
      out.push({
        id: `daemon-${row.id}`,
        role: 'user',
        text,
        createdAt: row.ts ?? 0,
        mode: 'single',
      });
      continue;
    }
    if (row.role === 'assistant') {
      if (!pending) {
        pending = {
          id: `daemon-${row.id}`,
          role: 'assistant',
          createdAt: row.ts ?? 0,
          mode: 'single',
          slots: [],
        };
        out.push(pending);
      }
      const slot: ReplySlot = {
        id: `${pending.id}-slot`,
        target,
        text,
        status: 'done',
        startedAt: row.ts ?? 0,
        imported: true,
      };
      pending.slots = [...(pending.slots ?? []), slot];
      continue;
    }
    // reasoning / tool / todo / compaction / error rows are history noise
    // for the desk — the transcript view keeps the conversation.
  }
  return out;
}

/**
 * The plan text of a `kind: plan` ask. claude's ExitPlanMode rides
 * `input.plan`; a backend that normalizes it puts the same text on
 * `detail.text` (`ToolCallDetail::Plan`).
 */
export function planTextOf(event: Record<string, unknown>): string {
  const detail = event.detail;
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.trim()) return record.text;
  }
  const input = event.input;
  if (typeof input === 'string' && input.trim()) return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['plan', 'content', 'text', 'markdown', 'body']) {
      if (typeof record[key] === 'string' && (record[key] as string).trim()) return record[key] as string;
    }
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '';
    }
  }
  return typeof event.title === 'string' ? event.title : '';
}

export function planFromEvent(event: Record<string, unknown>) {
  return buildPlan({
    requestId: String(event.id ?? event.planId ?? ''),
    content: planTextOf(event),
    title: typeof event.title === 'string' ? event.title : undefined,
    planId: typeof event.planId === 'string' ? event.planId : undefined,
    revision: typeof event.revision === 'number' ? event.revision : undefined,
  });
}

export function mapUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const usage: Usage = {};
  const num = (key: string): number | undefined =>
    typeof u[key] === 'number' ? (u[key] as number) : undefined;
  const input = num('input_tokens');
  const output = num('output_tokens');
  const cached = num('cached_input_tokens');
  const cost = num('cost_usd');
  const ctxUsed = num('context_used') ?? num('contextUsed');
  const ctxWindow = num('context_window') ?? num('contextSize');
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (cost !== undefined) usage.costUsd = cost;
  if (ctxUsed !== undefined) usage.contextUsed = ctxUsed;
  if (ctxWindow !== undefined) usage.contextWindow = ctxWindow;
  return Object.keys(usage).length ? usage : undefined;
}

/** Turn a `session.event` frame into desk stream events. */
export function mapSessionEvent(data: unknown): StreamEvent | null {
  if (!data || typeof data !== 'object') return null;
  const event = data as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';
  switch (type) {
    case 'turn_started':
      return { type: 'start' };
    case 'timeline': {
      const kind = typeof event.kind === 'string' ? event.kind : '';
      if (kind === 'assistant_message') {
        const text = typeof event.text === 'string' ? event.text : '';
        return text ? { type: 'delta', text } : null;
      }
      if (kind === 'tool_call') {
        // One snapshot per state change; the desk upserts by call id so
        // `running` and `completed` frames land on the same row.
        return { type: 'tool', call: normalizeToolCall(event) };
      }
      if (kind === 'error') {
        const text = typeof event.text === 'string' ? event.text : 'turn failed';
        return { type: 'error', message: text };
      }
      return null;
    }
    case 'permission_requested': {
      if (String(event.kind ?? '') === 'plan') {
        return { type: 'plan', plan: planFromEvent(event) };
      }
      const ask: PermissionAsk = {
        id: String(event.id ?? ''),
        kind: String(event.kind ?? 'ask'),
        name: String(event.name ?? 'request'),
        title: typeof event.title === 'string' ? event.title : undefined,
        detail: event.detail ?? event.input,
        actions: Array.isArray(event.actions)
          ? (event.actions as Array<Record<string, unknown>>).map((action) => ({
              id: String(action.id ?? ''),
              label: String(action.label ?? action.id ?? ''),
              behavior: String(action.behavior ?? 'allow'),
              variant: typeof action.variant === 'string' ? action.variant : undefined,
            }))
          : [],
      };
      return { type: 'permission', ask };
    }
    // Not a daemon wire name — a surface that names the plan event
    // directly (and any future daemon that promotes it) still lands here.
    case 'plan_requested':
    case 'plan_review':
      return { type: 'plan', plan: planFromEvent(event) };
    case 'permission_resolved':
      return typeof event.request_id === 'string' ? { type: 'plan_resolved', requestId: event.request_id } : null;
    case 'turn_completed':
      return { type: 'done', usage: mapUsage(event.usage) };
    case 'turn_canceled':
      return { type: 'done', stopReason: typeof event.reason === 'string' ? event.reason : 'canceled' };
    case 'turn_failed': {
      const message = typeof event.error === 'string' ? event.error : 'turn failed';
      const code = typeof event.code === 'string' ? event.code : '';
      return { type: 'error', message: code ? `${message} (${code})` : message };
    }
    case 'model_changed':
      return typeof event.model === 'string' ? { type: 'notice', text: `model → ${event.model}` } : null;
    default:
      return null;
  }
}

export class DaemonTransport {
  readonly baseUrl: string;
  private readonly config: DaemonConfig;
  private readonly deps: DaemonDeps;
  private rpc: RpcClient | null = null;
  hello: HelloPayload | null = null;

  constructor(config: DaemonConfig, deps: DaemonDeps = {}) {
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.deps = deps;
  }

  private get doFetch(): typeof fetch {
    return fetcher(this.deps.fetchImpl);
  }

  private authHeaders(): Record<string, string> {
    const token = this.config.masterToken ?? this.config.deviceToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async health(): Promise<DaemonHealth> {
    const response = await this.doFetch(`${this.baseUrl}/health`, {
      headers: { Accept: 'application/json', ...this.authHeaders() },
    });
    if (!response.ok) throw new Error(`/health → ${response.status}`);
    return (await response.json()) as DaemonHealth;
  }

  /** Spend a one-time pairing key; the token is returned exactly once. */
  async pair(pairingKey: string, name: string): Promise<{ deviceId: string; token: string; status: string }> {
    const response = await this.doFetch(`${this.baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: pairingKey.trim(), name }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(String(body.error ?? `pairing refused (${response.status})`));
    }
    return {
      deviceId: String(body.deviceId ?? ''),
      token: String(body.token ?? ''),
      status: String(body.status ?? 'pending'),
    };
  }

  async pairStatus(deviceId: string, token: string): Promise<string> {
    const response = await this.doFetch(`${this.baseUrl}/v1/pair/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, token }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`pair status → ${response.status}`);
    return String(body.status ?? 'pending');
  }

  /** Single-use WS ticket: master bearer, or the device's own token. */
  async mintTicket(): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: string | undefined;
    if (this.config.deviceToken && !this.config.masterToken) {
      body = JSON.stringify({ deviceToken: this.config.deviceToken });
    } else if (this.config.masterToken) {
      headers.Authorization = `Bearer ${this.config.masterToken}`;
      body = '{}';
    } else {
      body = '{}';
    }
    const response = await this.doFetch(`${this.baseUrl}/v1/ws_ticket`, { method: 'POST', headers, body });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'ws_ticket refused — check the daemon auth token (or approve this device)'
          : `ws_ticket → ${response.status}`,
      );
    }
    const payload = (await response.json()) as { ticket?: string };
    if (!payload.ticket) throw new Error('ws_ticket returned no ticket');
    return payload.ticket;
  }

  async connect(): Promise<HelloPayload> {
    const ticket = await this.mintTicket();
    const rpc = new RpcClient(this.deps.socketFactory, 30_000, this.deps.tap);
    this.rpc = rpc;
    const hello = await rpc.connect(wsUrlFor(this.baseUrl, ticket));
    this.hello = hello;
    return hello;
  }

  /** False once the socket has closed, even if the handshake succeeded. */
  get connected(): boolean {
    return this.rpc?.connected ?? false;
  }

  /** The daemon went away under a live connection. */
  onClosed(handler: () => void): () => void {
    return this.rpc?.onClosed(handler) ?? (() => undefined);
  }

  get client(): RpcClient {
    if (!this.rpc) throw new Error('daemon transport is not connected');
    return this.rpc;
  }

  /** What the handshake settled on (protocol version, range, capabilities). */
  get protocol(): ProtocolState {
    const hello = this.hello;
    return {
      version: hello?.protocol ?? 0,
      min: hello?.minProtocol,
      supported: hello?.supported,
      negotiated: this.rpc?.negotiated ?? false,
      capabilities: capabilitiesOf(hello),
    };
  }

  /** True when this daemon promised `capability` in its `hello`. */
  supports(capability: ProtocolCapability): boolean {
    return capabilitiesOf(this.hello)[capability];
  }

  /** Every (backend, model) the daemon can route to. */
  async routes(fallbackBackends: string[] = []): Promise<RouteTarget[]> {
    const backends = this.hello?.backends?.length ? this.hello.backends : fallbackBackends;
    const routes: RouteTarget[] = [];
    await Promise.all(
      backends.map(async (backend) => {
        let models: Array<{ id?: string; name?: string }> = [];
        try {
          const catalog = await this.client.request<{ models?: Array<{ id?: string; name?: string }> }>(
            'catalog.models',
            { backend },
            6000,
          );
          models = Array.isArray(catalog.models) ? catalog.models : [];
        } catch {
          models = []; // a catalogue probe never blocks the connection
        }
        if (models.length === 0) {
          routes.push(
            makeTarget({
              provider: backend,
              providerLabel: backendTitle(backend),
              model: '',
              modelLabel: 'default model',
              source: 'backend',
            }),
          );
          return;
        }
        for (const model of models) {
          const id = model.id ?? '';
          if (!id) continue;
          routes.push(
            makeTarget({
              provider: backend,
              providerLabel: backendTitle(backend),
              model: id,
              modelLabel: model.name ?? id,
              source: 'backend',
            }),
          );
        }
      }),
    );
    return routes.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.modelLabel.localeCompare(b.modelLabel));
  }

  async listSessions(limit = 60, opts: { includeArchived?: boolean; backend?: string } = {}): Promise<DaemonSessionRow[]> {
    const params: Record<string, unknown> = { limit, includeArchived: opts.includeArchived === true };
    if (opts.backend) params.backend = opts.backend;
    const result = await this.client.request<{ sessions?: DaemonSessionRow[] }>('session.list', params);
    return Array.isArray(result.sessions) ? result.sessions : [];
  }

  /**
   * `session.status {}` → live sessions with their phase, plus `recovered`.
   *
   * `turnId` and `pendingAsk` are additive: whichever the daemon omits is
   * simply absent on the row (a claim can land before a turn id exists).
   * Gated on `capabilities.sessionPhase`, so a daemon that predates the field
   * set is never asked and an old client/server pair behaves exactly as
   * before; a daemon that advertises it but answers `-32601` (partial
   * upgrade) is reported as unsupported instead of failing the read.
   */
  async sessionStatus(): Promise<SessionStatusResult> {
    if (!this.supports('sessionPhase')) return { supported: false, rows: [], recovered: [] };
    try {
      const raw = await this.client.request<unknown>('session.status', {}, 10_000);
      const { rows, recovered } = normalizeSessionStatus(raw);
      return { supported: true, rows, recovered };
    } catch (error) {
      // A daemon that advertises the capability but does not answer the
      // method is mid-upgrade; report it rather than break the status line.
      if (error instanceof RpcError && error.code === -32601) return { supported: false, rows: [], recovered: [] };
      throw error;
    }
  }

  /** `session.rename {sessionId, title}` → `{renamed}`. */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const result = await this.client.request<{ renamed?: boolean }>('session.rename', { sessionId, title }, 10_000);
    return result?.renamed === true;
  }

  /** Hide a row from `session.list` without deleting its history. */
  async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const result = await this.client.request<{ updated?: boolean }>(
      'session.set_archived',
      { sessionId, archived },
      10_000,
    );
    return result?.updated === true;
  }

  /** Delete the session row (and tombstone a discovered native handle). */
  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.client.request<{ deleted?: boolean }>('session.delete', { sessionId }, 15_000);
    return result?.deleted === true;
  }

  /** The daemon's own session serialization (session + messages + usage). */
  async exportSession(sessionId: string): Promise<DaemonSessionExport> {
    return this.client.request<DaemonSessionExport>('session.export', { sessionId }, 20_000);
  }

  async createSession(input: { backend: string; model?: string; cwd?: string }): Promise<SessionCursor> {
    const params: Record<string, unknown> = { backend: input.backend };
    if (input.model) params.model = input.model;
    if (input.cwd) params.cwd = input.cwd;
    const result = await this.client.request<SessionCursor>('session.create', params);
    if (!result?.sessionId) throw new Error('session.create returned no sessionId');
    return result;
  }

  /**
   * `session.resume` — attaches (or re-attaches) this connection to a
   * session and answers with its cursor. Idempotent, and the recovery
   * path for `-32001`: a daemon restart leaves the row but not the live
   * session, and the turn is what has to be resumed before it can run.
   */
  async resumeSession(sessionId: string): Promise<SessionCursor> {
    const result = await this.client.request<SessionCursor>('session.resume', { sessionId }, 30_000);
    if (!result?.sessionId) throw new Error('session.resume returned no sessionId');
    return result;
  }

  /**
   * `session.watch` — subscribe this connection to a live session without
   * creating or turning on it. The answer's `cursor` is that session's
   * numbering, which is what makes a later gap detectable.
   */
  async watchSession(sessionId: string): Promise<SessionCursor> {
    const result = await this.client.request<SessionCursor>('session.watch', { sessionId }, 15_000);
    return result;
  }

  async messages(sessionId: string, target: RouteTarget): Promise<ChatMessage[]> {
    const result = await this.client.request<{ messages?: StoredMessage[] }>('session.messages', {
      sessionId,
      limit: 200,
    });
    return mapDaemonMessages(result.messages ?? [], target);
  }

  async usage(sessionId: string): Promise<{ contextUsed?: number; contextSize?: number; costUsd?: number; turns?: number }> {
    return this.client.request('session.usage', { sessionId });
  }

  /** One ledger: `memory.list {scope, owner?, includePending?}`. */
  async listMemory(input: { scope?: MemoryScope; owner?: string | null; includePending?: boolean } = {}): Promise<MemoryEntry[]> {
    const scope = input.scope ?? 'user';
    const params: Record<string, unknown> = { scope, includePending: input.includePending === true };
    if (scope === 'bot' && input.owner) params.owner = input.owner;
    const result = await this.client.request<{ entries?: MemoryEntry[] }>('memory.list', params, 10_000);
    return Array.isArray(result.entries) ? result.entries : [];
  }

  /** `memory.usage` — chars counts ACTIVE entries only. */
  async memoryUsage(scope: MemoryScope = 'user', owner?: string | null): Promise<{ chars: number; limit: number }> {
    const params: Record<string, unknown> = { scope };
    if (scope === 'bot' && owner) params.owner = owner;
    const result = await this.client.request<{ chars?: number; limit?: number }>('memory.usage', params, 10_000);
    return { chars: result?.chars ?? 0, limit: result?.limit ?? 0 };
  }

  /**
   * `memory.write` — one gate chain (scan → cap → approval). A refusal is
   * `-32011` with `error.data.kind`; nothing is ever sanitized or
   * truncated, so the caller shows the kind instead of retrying silently.
   */
  async writeMemory(input: {
    scope: MemoryScope;
    owner?: string | null;
    content: string;
    source?: string;
  }): Promise<{ id: string; status: 'active' | 'pending' }> {
    const params: Record<string, unknown> = { scope: input.scope, content: input.content };
    if (input.scope === 'bot' && input.owner) params.owner = input.owner;
    if (input.source) params.source = input.source;
    const result = await this.client.request<{ id?: string; status?: 'active' | 'pending' }>('memory.write', params, 15_000);
    if (!result?.id) throw new Error('memory.write returned no id');
    return { id: result.id, status: result.status === 'pending' ? 'pending' : 'active' };
  }

  async removeMemory(id: string): Promise<boolean> {
    const result = await this.client.request<{ removed?: boolean }>('memory.remove', { id }, 10_000);
    return result?.removed === true;
  }

  /** One-shot CAS on a pending write: false when unknown or already active. */
  async approveMemory(id: string): Promise<boolean> {
    const result = await this.client.request<{ approved?: boolean }>('memory.approve', { id }, 10_000);
    return result?.approved === true;
  }

  async rejectMemory(id: string): Promise<boolean> {
    const result = await this.client.request<{ rejected?: boolean }>('memory.reject', { id }, 10_000);
    return result?.rejected === true;
  }

  /** The user ledger's entries — the injection source. */
  async memory(includePending = false): Promise<MemoryEntry[]> {
    return this.listMemory({ scope: 'user', includePending });
  }

  async cancelTurn(sessionId: string): Promise<void> {
    await this.client.request('turn.cancel', { sessionId }, 8000);
  }

  /**
   * Redirect the turn that is already running. The daemon refuses this
   * with -32002 when the backend cannot steer; callers queue the text as
   * the next prompt instead.
   *
   * `idempotencyKey` is the Keyed contract: a steer delivered twice would
   * hand the agent the same words twice, so a repeat replays the first
   * delivery (`{result}`, `duplicate`), and a repeat while it is still in
   * flight answers `-32006`.
   */
  async steer(sessionId: string, prompt: string, idempotencyKey?: string): Promise<string> {
    const params: Record<string, unknown> = { sessionId, prompt };
    if (idempotencyKey) params.idempotencyKey = idempotencyKey;
    const result = await this.client.request<{ result?: string; duplicate?: boolean }>('turn.steer', params, 20_000);
    return typeof result?.result === 'string' ? result.result : '';
  }

  /** Copy a session (messages, tags, usage, resume handle) into a branch. */
  async forkSession(sessionId: string, upto?: number): Promise<string> {
    const params: Record<string, unknown> = { sessionId };
    if (typeof upto === 'number') params.upto = upto;
    const result = await this.client.request<{ sessionId?: string }>('session.fork', params, 25_000);
    if (!result?.sessionId) throw new Error('session.fork returned no sessionId');
    return result.sessionId;
  }

  /** Every revision of the session's plan reviews, chain-ordered. */
  async listPlans(sessionId: string): Promise<DaemonPlanRow[]> {
    const result = await this.client.request<{ plans?: DaemonPlanRow[] }>('plan.list', { sessionId }, 10_000);
    return Array.isArray(result?.plans) ? result.plans : [];
  }

  /**
   * Decide a durable plan review. `expectedRevision` is a CAS claim: a
   * stale revision answers -32009 and nothing reaches the agent.
   */
  async respondPlan(input: {
    planId: string;
    expectedRevision: number;
    decision: PlanDecision;
    feedback?: string;
  }): Promise<{ status?: string; applied?: boolean; revision?: number }> {
    const params: Record<string, unknown> = {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      decision: input.decision,
    };
    if (input.feedback) params.feedback = input.feedback;
    return this.client.request('plan.respond', params, 20_000);
  }

  async respondPermission(sessionId: string, requestId: string, response: Record<string, unknown>): Promise<void> {
    await this.client.request('permission.respond', { sessionId, requestId, response }, 10_000);
  }

  /**
   * Run one turn and stream it. `turn.start` itself resolves when the
   * turn ends, so the events are what the UI renders; the resolution is
   * the authoritative end (usage included).
   *
   * Protocol v2 is what makes a stream honest about itself here:
   *
   *   - every frame's `seq` is fed to a `DeliveryTracker`, so a jump in
   *     the numbering becomes a `gap` event even if the daemon's own
   *     `session.gap` never arrives;
   *   - `session.gap` and `session.snapshot_required` are the connection's
   *     own losses, not the turn's, and they ride out as their own events;
   *   - catch-up frames (`replay: true`) are skipped: the desk already
   *     renders that history, and a replayed `turn_completed` would end
   *     this turn before it began;
   *   - `idempotencyKey` makes a re-send safe. A `{duplicate, inProgress}`
   *     answer means the turn is already running on another connection:
   *     this generator keeps consuming that turn's stream instead of
   *     reporting a phantom empty answer;
   *   - `-32001` (session not live, e.g. after a daemon restart) is
   *     recovered once: `session.resume`, then the same key again.
   */
  async *streamTurn(
    sessionId: string,
    prompt: string,
    opts: {
      signal?: AbortSignal;
      memoryOwner?: string;
      /** One per turn; a re-send of the same key replays instead of re-running. */
      idempotencyKey?: string;
      /** Where the session stood before this turn (create/resume/watch cursor). */
      baseline?: number | null;
      /** The session's numbering as frames arrive, so the desk can keep it. */
      onCursor?: (cursor: number) => void;
    } = {},
  ): AsyncGenerator<StreamEvent> {
    const rpc = this.client;
    const tracker = new DeliveryTracker(opts.baseline ?? null);
    const queue: StreamEvent[] = [];
    // A holder, not a bare `let`: the loop assigns the waker and the async
    // settle path calls it, and TypeScript narrows a bare variable to null
    // across those two closures.
    const signal: { wake: (() => void) | null } = { wake: null };
    /** No frame may be pushed any more — the turn is over for this consumer. */
    let closed = false;
    let sawDone = false;
    /** `turn.start` answered (or failed): the request no longer gates the loop. */
    let requestSettled = false;
    /** The turn runs on another connection and this one just watches it. */
    let attached = false;
    let aborted = false;
    // A holder, not a bare `let`: the timer is armed from inside the
    // async IIFE below and cleared from the generator body.
    const timers: { attached?: ReturnType<typeof setTimeout> } = {};

    const push = (event: StreamEvent) => {
      if (closed) return;
      queue.push(event);
      signal.wake?.();
    };

    const noteCursor = () => {
      const cursor = tracker.cursor;
      if (cursor !== null) opts.onCursor?.(cursor);
    };

    const off = rpc.onEvent((frame: ServerEvent) => {
      if (frame.sessionId !== sessionId) return;
      if (frame.event === 'session.event') {
        const skipped = tracker.observe(frame.seq);
        // Catch-up history is already on screen; it is not this answer.
        if (frame.replay === true) {
          noteCursor();
          return;
        }
        if (skipped > 0) push({ type: 'gap', dropped: skipped, cursor: tracker.cursor ?? undefined });
        noteCursor();
        const mapped = mapSessionEvent(frame.data);
        if (!mapped) return;
        if (mapped.type === 'done' || mapped.type === 'error') sawDone = true;
        push(mapped);
        return;
      }
      if (frame.event === 'session.gap') {
        // The daemon counted this one itself; adopting its cursor keeps the
        // frame that follows from being counted a second time.
        const dropped = tracker.admit(frame.dropped, frame.cursor);
        noteCursor();
        if (dropped > 0) push({ type: 'gap', dropped, cursor: frame.cursor });
        return;
      }
      if (frame.event === 'session.snapshot_required') {
        tracker.start(frame.cursor);
        noteCursor();
        push({ type: 'snapshot_required', cursor: frame.cursor, reason: frame.reason });
      }
    });

    const onAbort = () => {
      aborted = true;
      void this.cancelTurn(sessionId).catch(() => {});
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const params: Record<string, unknown> = { sessionId, prompt };
    if (opts.memoryOwner) params.memoryOwner = opts.memoryOwner;
    if (opts.idempotencyKey) params.idempotencyKey = opts.idempotencyKey;

    const startTurn = () => rpc.request<TurnStartResult>('turn.start', params, 10 * 60_000);

    const settle = (async () => {
      let result: TurnStartResult;
      try {
        try {
          result = await startTurn();
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== -32001) throw error;
          // The session outlived its process (`-32001`). Resume it, then
          // send the SAME key: the daemon replays the attempt if it still
          // remembers it, so a restart costs a resume, not a second turn.
          const resumed = await this.resumeSession(sessionId).catch(() => null);
          if (!resumed) throw error;
          tracker.start(resumed.cursor);
          noteCursor();
          push({ type: 'delivery', patch: { resumed: true } });
          push({ type: 'notice', text: '세션이 살아있지 않아 session.resume 후 같은 키로 다시 보냈습니다' });
          result = await startTurn();
        }

        if (result?.duplicate === true && result.inProgress === true) {
          // The first attempt owns the turn; this connection was just
          // subscribed to it. End on its own event, not on this answer.
          attached = true;
          push({ type: 'delivery', patch: { attached: true, duplicate: true } });
          push({ type: 'notice', text: '이미 실행 중인 턴에 연결했습니다 — 이 스트림이 그 턴입니다' });
          timers.attached = setTimeout(() => {
            push({ type: 'error', message: '실행 중인 턴이 끝나기를 기다리다 시간이 초과되었습니다 — 다른 서피스에서 계속되고 있을 수 있습니다' });
            requestSettled = true;
            closed = true;
            signal.wake?.();
          }, ATTACHED_TURN_TIMEOUT_MS);
          return;
        }

        if (result?.duplicate === true) push({ type: 'delivery', patch: { duplicate: true } });
        if (!sawDone) push({ type: 'done', stopReason: result?.stopReason, usage: mapUsage(result?.usage) });
      } catch (error) {
        const message =
          error instanceof RpcError
            ? `${error.message}${rpcErrorHint(error.code) ? ` — ${rpcErrorHint(error.code)}` : ''}`
            : String((error as Error)?.message ?? error);
        push({ type: 'error', message });
      } finally {
        // An attached turn is not over: this consumer keeps reading it
        // until its own ending event arrives (or the watchdog gives up).
        if (!attached) {
          requestSettled = true;
          closed = true;
        }
        if (timers.attached) clearTimeout(timers.attached);
        signal.wake?.();
      }
    })();

    try {
      for (;;) {
        if (queue.length === 0) {
          if (requestSettled) break;
          await new Promise<void>((resolve) => {
            signal.wake = () => {
              signal.wake = null;
              resolve();
            };
          });
          continue;
        }
        const event = queue.shift() as StreamEvent;
        yield event;
        if (event.type !== 'done' && event.type !== 'error') continue;
        // A turn this connection did not start ends on its own event; a
        // turn it started waits for `turn.start` to settle so a late
        // failure is not lost.
        if (attached || requestSettled) break;
      }
      if (aborted && !sawDone) yield { type: 'done', stopReason: 'canceled' };
    } finally {
      if (timers.attached) clearTimeout(timers.attached);
      off();
      opts.signal?.removeEventListener('abort', onAbort);
      void settle;
    }
  }

  close(): void {
    this.rpc?.close();
    this.rpc = null;
  }
}

/** Route key comparison helper used by the orchestrator. */
export function routeKeyOf(provider: string, model: string): string {
  return targetKey(provider, model);
}
