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

import { RpcClient, RpcError, rpcErrorHint, type HelloPayload, type ServerEvent, type SocketFactory, wsUrlFor } from './rpc';
import type {
  ChatMessage,
  DaemonHealth,
  MemoryEntry,
  MemoryScope,
  PermissionAsk,
  PlanDecision,
  ReplySlot,
  RouteTarget,
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
    const rpc = new RpcClient(this.deps.socketFactory);
    this.rpc = rpc;
    const hello = await rpc.connect(wsUrlFor(this.baseUrl, ticket));
    this.hello = hello;
    return hello;
  }

  get client(): RpcClient {
    if (!this.rpc) throw new Error('daemon transport is not connected');
    return this.rpc;
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

  async createSession(input: { backend: string; model?: string; cwd?: string }): Promise<string> {
    const params: Record<string, unknown> = { backend: input.backend };
    if (input.model) params.model = input.model;
    if (input.cwd) params.cwd = input.cwd;
    const result = await this.client.request<{ sessionId: string }>('session.create', params);
    return result.sessionId;
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
   */
  async steer(sessionId: string, prompt: string): Promise<string> {
    const result = await this.client.request<{ result?: string }>('turn.steer', { sessionId, prompt }, 20_000);
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
   */
  async *streamTurn(
    sessionId: string,
    prompt: string,
    opts: { signal?: AbortSignal; memoryOwner?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    const rpc = this.client;
    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let sawDone = false;
    let aborted = false;

    const push = (event: StreamEvent) => {
      if (closed) return;
      queue.push(event);
      wake?.();
    };

    const off = rpc.onEvent((frame: ServerEvent) => {
      if (frame.event !== 'session.event' || frame.sessionId !== sessionId) return;
      const mapped = mapSessionEvent(frame.data);
      if (!mapped) return;
      if (mapped.type === 'done') sawDone = true;
      if (mapped.type === 'error') sawDone = true;
      push(mapped);
    });

    const onAbort = () => {
      aborted = true;
      void this.cancelTurn(sessionId).catch(() => {});
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const params: Record<string, unknown> = { sessionId, prompt };
    if (opts.memoryOwner) params.memoryOwner = opts.memoryOwner;
    const turn = rpc
      .request<{ turnId?: string; stopReason?: string; usage?: unknown }>('turn.start', params, 10 * 60_000)
      .then((result) => {
        if (!sawDone) push({ type: 'done', stopReason: result?.stopReason, usage: mapUsage(result?.usage) });
      })
      .catch((error: unknown) => {
        const message = error instanceof RpcError ? `${error.message}${rpcErrorHint(error.code) ? ` — ${rpcErrorHint(error.code)}` : ''}` : String((error as Error)?.message ?? error);
        push({ type: 'error', message });
      })
      .finally(() => {
        closed = true;
        wake?.();
      });

    try {
      for (;;) {
        if (queue.length === 0) {
          if (closed) break;
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = null;
              resolve();
            };
          });
          continue;
        }
        const event = queue.shift() as StreamEvent;
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          // Keep the loop alive until the request settles so a late
          // `turn.start` failure is not lost; the finally closes it.
          if (!closed) continue;
          break;
        }
      }
      if (aborted && !sawDone) yield { type: 'done', stopReason: 'canceled' };
    } finally {
      off();
      opts.signal?.removeEventListener('abort', onAbort);
      void turn;
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
