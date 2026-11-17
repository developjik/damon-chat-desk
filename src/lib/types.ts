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
}

export interface DaemonHealth {
  status: string;
  version?: string;
  backends?: string[];
}

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
  | { type: 'tool'; name: string; status?: string }
  | { type: 'permission'; ask: PermissionAsk }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason?: string; usage?: Usage }
  | { type: 'error'; message: string };
