/**
 * Tool-call normalization.
 *
 * The daemon's `timeline` `tool_call` item carries a normalized
 * `ToolCallDetail` (damon-agent-core src/backend/types.rs), tagged by
 * `type`: shell | read | edit | write | search | fetch | sub_agent |
 * plan | unknown. Each variant holds its own fields (`command`/`output`/
 * `exit_code`, `path`/`unified_diff`, …).
 *
 * The accordion should not know any of that. This module flattens one
 * detail into a `ToolCall`: a one-line subject, the full argument text,
 * and the result panes. The desk upserts the snapshot by call id, so a
 * call is one row from `running` to `done` instead of two unrelated
 * badges.
 */

import type { ToolCall, ToolKind, ToolResult, ToolStatus } from './types';

const KIND_BY_DETAIL: Record<string, ToolKind> = {
  shell: 'shell',
  read: 'read',
  edit: 'edit',
  write: 'write',
  search: 'search',
  fetch: 'fetch',
  sub_agent: 'task',
  plan: 'other',
};

/** `sub_agent` → `task`; anything unrecognized keeps the `other` hatch. */
export function toolKindOf(detailType?: string): ToolKind {
  if (!detailType) return 'other';
  return KIND_BY_DETAIL[detailType] ?? 'other';
}

export interface RawToolEvent {
  call_id?: unknown;
  callId?: unknown;
  name?: unknown;
  status?: unknown;
  detail?: unknown;
  startedAt?: number;
  endedAt?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toolStatusOf(raw: unknown): ToolStatus {
  switch (raw) {
    case 'running':
    case 'started':
    case 'in_progress':
      return 'running';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'done';
  }
}

/** First line only, collapsed — the row label must never wrap. */
export function oneLine(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface Flattened {
  kind: ToolKind;
  label: string;
  input?: string;
  result?: ToolResult;
  status: ToolStatus;
}

function flatten(detail: Record<string, unknown> | null, name: string, rawStatus: unknown): Flattened {
  const type = str(detail?.type);
  const kind = toolKindOf(type);
  let status = toolStatusOf(rawStatus);

  if (!detail) {
    return { kind, label: name, status };
  }

  switch (type) {
    case 'shell': {
      const command = str(detail.command) ?? name;
      const output = str(detail.output);
      const exitCode = typeof detail.exit_code === 'number' ? detail.exit_code : undefined;
      if (exitCode !== undefined && exitCode !== 0) status = 'error';
      return {
        kind: 'shell',
        label: oneLine(command),
        input: command,
        result: { stdout: output, exitCode },
        status,
      };
    }
    case 'read': {
      const path = str(detail.path) ?? name;
      return { kind: 'read', label: oneLine(path), input: path, result: { stdout: str(detail.content) }, status };
    }
    case 'edit': {
      const path = str(detail.path) ?? name;
      return {
        kind: 'edit',
        label: oneLine(path),
        input: path,
        result: { diff: str(detail.unified_diff) },
        status,
      };
    }
    case 'write': {
      const path = str(detail.path) ?? name;
      return { kind: 'write', label: oneLine(path), input: path, result: { stdout: str(detail.content) }, status };
    }
    case 'search': {
      const query = str(detail.query) ?? name;
      return { kind: 'search', label: oneLine(query), input: query, result: { stdout: str(detail.content) }, status };
    }
    case 'fetch': {
      const url = str(detail.url) ?? name;
      return { kind: 'fetch', label: oneLine(url), input: url, result: { stdout: str(detail.result) }, status };
    }
    case 'sub_agent': {
      const description = str(detail.description) ?? name;
      return {
        kind: 'task',
        label: oneLine(description),
        input: description,
        result: { stdout: str(detail.log) },
        status,
      };
    }
    case 'plan': {
      return { kind: 'other', label: name, input: str(detail.text), result: { stdout: str(detail.text) }, status };
    }
    default: {
      const input = jsonText(detail.input);
      const output = jsonText(detail.output);
      return {
        kind: 'other',
        label: oneLine(str(detail.command) ?? str(detail.path) ?? input ?? name),
        input,
        result: { stdout: output },
        status,
      };
    }
  }
}

/** One `tool_call` timeline item (or a demo script entry) → a ToolCall. */
export function normalizeToolCall(raw: RawToolEvent, at: number = Date.now()): ToolCall {
  const name = str(raw.name) ?? 'tool';
  const detail = asRecord(raw.detail);
  const flattened = flatten(detail, name, raw.status);
  const id = str(raw.call_id) ?? str(raw.callId) ?? `${name}-${at}`;
  const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : at;
  const endedAt =
    typeof raw.endedAt === 'number'
      ? raw.endedAt
      : flattened.status === 'running'
        ? undefined
        : Math.max(startedAt, at);
  const result = flattened.result;
  const hasResult = result && Object.values(result).some((value) => value !== undefined);
  return {
    id,
    name,
    kind: flattened.kind,
    label: flattened.label,
    input: flattened.input,
    status: flattened.status,
    startedAt,
    endedAt,
    result: hasResult ? result : undefined,
    detail: detail ?? undefined,
  };
}

/**
 * Fold a newer snapshot of the same call into the row already on screen.
 * A `running` frame never erases a result that already arrived, and the
 * start time stays with the first sighting.
 */
export function mergeToolCall(previous: ToolCall | undefined, next: ToolCall): ToolCall {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    startedAt: Math.min(previous.startedAt, next.startedAt),
    endedAt: next.endedAt ?? previous.endedAt,
    result: next.result ?? previous.result,
    detail: next.detail ?? previous.detail,
    input: next.input ?? previous.input,
    // A late `running` snapshot for a finished call is a re-render, not a
    // regression: keep the terminal status.
    status: next.status === 'running' && previous.status !== 'running' ? previous.status : next.status,
  };
}

export function toolCounts(calls: ToolCall[] | undefined): { running: number; done: number; error: number } {
  const counts = { running: 0, done: 0, error: 0 };
  for (const call of calls ?? []) counts[call.status] += 1;
  return counts;
}

/** Wall-clock cost of the call, or `undefined` while it still runs. */
export function toolDuration(call: ToolCall, now: number = Date.now()): number | undefined {
  if (call.status === 'running') return undefined;
  return Math.max(0, (call.endedAt ?? now) - call.startedAt);
}

export interface DiffLine {
  kind: 'add' | 'del' | 'meta' | 'ctx';
  text: string;
}

/** Split a unified diff for the gutter; unknown prefixes render as context. */
export function parseDiff(unified: string): DiffLine[] {
  return unified.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
      return { kind: 'meta' as const, text: line };
    }
    if (line.startsWith('+')) return { kind: 'add' as const, text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del' as const, text: line.slice(1) };
    return { kind: 'ctx' as const, text: line };
  });
}

/** One glyph per tool kind — the row reads at a glance without the name. */
export const TOOL_GLYPH: Record<ToolKind, string> = {
  shell: '$',
  read: '⌖',
  edit: '✎',
  write: '✎',
  search: '⌕',
  fetch: '↗',
  task: '⌥',
  other: '·',
};
