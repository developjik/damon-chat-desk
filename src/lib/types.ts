/**
 * Shared types for the chat desk.
 *
 * One vocabulary across three transports:
 *   - `daemon`  real damon-agent-core (JSON-RPC v2 over /ws)
 *   - `openai`  any OpenAI-compatible /v1 endpoint (SSE)
 *   - `demo`    simulated daemon, no network
 */

export type TransportKind = 'daemon' | 'openai' | 'demo';

/** What the router can send a prompt to. */
export interface RouteTarget {
  /** Stable identity of the route: transport-independent (provider + model). */
  key: string;
  /** Backend id on the daemon (`claude`), vendor for OpenAI (`openai`). */
  provider: string;
  /** Human name of the provider surface. */
  providerLabel: string;
  /** Model id on the wire. */
  model: string;
  /** Human model name (falls back to the id). */
  modelLabel: string;
  /** How the route was discovered — drives the badge in the UI. */
  source: 'backend' | 'model';
  available: boolean;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  contextUsed?: number;
  contextWindow?: number;
}

export type SlotStatus = 'queued' | 'streaming' | 'done' | 'error' | 'canceled';

/* ------------------------------------------------------------------ */
/* tool calls — the daemon's ToolCallDetail, normalized                 */
/* ------------------------------------------------------------------ */

export type ToolStatus = 'running' | 'done' | 'error';

export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'fetch' | 'task' | 'other';

/** Whatever the call produced — one pane per field that exists. */
export interface ToolResult {
  /** shell stdout, file content, search hits, fetched body, subagent log */
  stdout?: string;
  stderr?: string;
  /** unified diff for an edit */
  diff?: string;
  exitCode?: number;
  error?: string;
}

/**
 * One tool execution, in the shape the accordion renders it. The daemon
 * emits a `timeline` `tool_call` per state change; the desk upserts by
 * `id` so a call is one row from `running` to `done`.
 */
export interface ToolCall {
  /** provider call id — the upsert key */
  id: string;
  name: string;
  kind: ToolKind;
  /** One-line subject: the command, path, query or url. */
  label: string;
  /** Full argument text shown when the row is open. */
  input?: string;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  result?: ToolResult;
  /** Raw normalized detail, kept verbatim for the `raw` pane. */
  detail?: unknown;
}

/* ------------------------------------------------------------------ */
/* steering — turn.steer while a reply is streaming                     */
/* ------------------------------------------------------------------ */

export interface SteerNote {
  id: string;
  text: string;
  at: number;
  /** `sent` once the transport accepted it, `failed` when it did not. */
  state: 'sent' | 'failed';
  /** The daemon's own acknowledgement, when it returned one. */
  ack?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* plan review — permission ask of kind `plan` + plan.respond            */
/* ------------------------------------------------------------------ */

export type PlanDecision = 'approve' | 'request_changes' | 'defer';

export type PlanStatus =
  | 'awaiting_review'
  | 'approved'
  | 'changes_requested'
  | 'deferred'
  | 'expired'
  | 'error';

export interface PlanStep {
  title: string;
  detail?: string;
}

/**
 * A plan the agent parked for review. `content` is the raw plan text;
 * `steps`/`files`/`risks` are the structured read of it so the card can
 * show what the agent proposes without a wall of prose.
 */
export interface PlanRequest {
  /** permission request id — the live transport handle */
  id: string;
  /** durable review row (plan.list / plan.respond key) */
  planId?: string;
  revision?: number;
  title: string;
  content: string;
  steps: PlanStep[];
  files: string[];
  risks: string[];
  status: PlanStatus;
  feedback?: string;
  decidedAt?: number;
  /** True while the decision is in flight. */
  submitting?: boolean;
  /** Why the last decision failed, if it did. */
  error?: string;
}

/** One provider's answer inside a turn — a compare turn holds two. */
export interface ReplySlot {
  id: string;
  target: RouteTarget;
  text: string;
  status: SlotStatus;
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
  usage?: Usage;
  error?: string;
  /** Short routing note: new daemon session, resumed, memory injected, … */
  notice?: string;
  /** Daemon session bound to this (conversation, provider) pair. */
  daemonSessionId?: string;
  turnId?: string;
  /** A parked ask (tool approval, question) awaiting a decision. */
  ask?: PermissionAsk;
  /** Tool executions in this reply, in call order. */
  tools?: ToolCall[];
  /** `turn.steer` instructions sent while this reply streamed. */
  steers?: SteerNote[];
  /** The plan the agent parked for review, when it asked for one. */
  plan?: PlanRequest;
  /** Loaded from daemon history — no timing to report. */
  imported?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  createdAt: number;
  /** user text, or nothing on an assistant turn (its slots carry the text) */
  text?: string;
  slots?: ReplySlot[];
  mode: 'single' | 'compare';
  memoryInjected?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** provider → daemon session id, for `daemon` transport conversations. */
  daemonSessions: Record<string, string>;
  /** True for conversations listed from the daemon that hold only a summary. */
  remote?: boolean;
  /** The conversation this one was forked from (session.fork). */
  forkedFrom?: string;
  /**
   * Archived sessions stay in storage but out of the sidebar list
   * (`session.set_archived` on the daemon, a local flag otherwise).
   */
  archived?: boolean;
}

export interface DaemonHealth {
  status: string;
  version?: string;
  backends?: string[];
}

/**
 * The two ledgers the daemon keeps: the user's own memory and a bot's
 * (named by `owner`). `memory.*` takes a scope on every call.
 */
export type MemoryScope = 'user' | 'bot';

export interface MemoryEntry {
  id: string;
  scope: string;
  owner?: string | null;
  content: string;
  source?: string | null;
  status: 'active' | 'pending';
  createdAt?: number | null;
  updatedAt?: number | null;
}

/** Which entries the memory panel shows. */
export type MemoryFilter = 'all' | 'active' | 'pending';

export interface ConnectionState {
  transport: TransportKind;
  /** `idle` before the first probe; `live` when the transport answered. */
  status: 'idle' | 'probing' | 'live' | 'offline' | 'error';
  baseUrl: string;
  version?: string;
  error?: string;
  /** Daemon backends reported by /health, or models from /v1/models. */
  targets: RouteTarget[];
  probeNote?: string;
}

export interface PermissionAction {
  id: string;
  label: string;
  behavior: 'allow' | 'deny' | string;
  variant?: string;
}

/** An ask the agent parked mid-turn (tool approval, question, plan). */
export interface PermissionAsk {
  id: string;
  kind: string;
  name: string;
  title?: string;
  detail?: unknown;
  actions: PermissionAction[];
}

export type StreamEvent =
  | { type: 'start'; turnId?: string }
  | { type: 'delta'; text: string }
  | { type: 'notice'; text: string }
  /** A tool call snapshot — upserted by `call.id`. */
  | { type: 'tool'; call: ToolCall }
  | { type: 'permission'; ask: PermissionAsk }
  | { type: 'plan'; plan: PlanRequest }
  /** The parked ask was settled elsewhere — the card is no longer answerable. */
  | { type: 'plan_resolved'; requestId: string }
  | { type: 'steer'; text: string; at: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason?: string; usage?: Usage }
  | { type: 'error'; message: string };
