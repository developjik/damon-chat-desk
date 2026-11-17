/**
 * Memory ledger helpers — the read side of `memory.*`.
 *
 * The daemon's ledger is a list of free-text entries per scope
 * (`user`, or a bot named by `owner`). There is no key column: the
 * "key" the panel shows is derived from the content itself (a leading
 * `key: value` reads as a key, anything else falls back to its opening
 * words), so the badge never claims more structure than the ledger has.
 */

import { RpcError } from './rpc';
import type { MemoryEntry, MemoryFilter, MemoryScope } from './types';

export interface MemoryFacet {
  text?: string;
  filter?: MemoryFilter;
  scope?: MemoryScope;
  owner?: string | null;
}

export interface MemoryStats {
  active: number;
  pending: number;
  chars: number;
}

/** chars counts ACTIVE entries only — the same rule as `memory.usage`. */
export function memoryStats(entries: MemoryEntry[]): MemoryStats {
  let active = 0;
  let pending = 0;
  let chars = 0;
  for (const entry of entries) {
    if (entry.status === 'pending') {
      pending += 1;
      continue;
    }
    active += 1;
    chars += entry.content.length;
  }
  return { active, pending, chars };
}

function haystack(entry: MemoryEntry): string {
  return [entry.content, entry.source ?? '', entry.owner ?? '', entry.scope].join('\n').toLowerCase();
}

/**
 * Search + facet filter for the panel. A blank query keeps every entry;
 * `filter` narrows to active or pending; `scope`/`owner` narrow the
 * ledger when the panel holds more than one.
 */
export function filterMemory(entries: MemoryEntry[], facet: MemoryFacet = {}): MemoryEntry[] {
  const needle = (facet.text ?? '').trim().toLowerCase();
  const terms = needle ? needle.split(/\s+/).filter(Boolean) : [];
  return entries
    .filter((entry) => {
      if (facet.filter === 'active' && entry.status !== 'active') return false;
      if (facet.filter === 'pending' && entry.status !== 'pending') return false;
      if (facet.scope && entry.scope !== facet.scope) return false;
      if (facet.owner) {
        const owner = (entry.owner ?? '').toLowerCase();
        if (owner !== facet.owner.toLowerCase()) return false;
      }
      if (terms.length === 0) return true;
      const body = haystack(entry);
      return terms.every((term) => body.includes(term));
    })
    .sort((a, b) => {
      // Pending writes are the ones that need a decision — they float up.
      const rank = (entry: MemoryEntry) => (entry.status === 'pending' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
}

const KEY_PATTERN = /^([\p{L}\p{N}_.\- ]{2,28})\s*[:：—–]\s+/u;

/**
 * The key badge, only when the entry actually carries a `key: value`
 * shape. The ledger is free text; inventing a key for prose would just
 * repeat the value line, so a plain entry gets no chip.
 */
export function memoryKey(entry: MemoryEntry): string | null {
  const content = entry.content.replace(/\s+/g, ' ').trim();
  const explicit = content.match(KEY_PATTERN);
  return explicit && explicit[1].trim() ? explicit[1].trim() : null;
}

/** Everything after the derived key, for the row's value line. */
export function memoryValue(entry: MemoryEntry): string {
  const content = entry.content.replace(/\s+/g, ' ').trim();
  const explicit = content.match(KEY_PATTERN);
  if (explicit) return content.slice(explicit[0].length).trim();
  return content;
}

export function scopeLabel(scope: string, owner?: string | null): string {
  if (scope === 'bot') return owner ? `bot · ${owner}` : 'bot';
  return scope || 'user';
}

export interface MemoryBadge {
  kind: 'scope' | 'owner' | 'source' | 'status';
  label: string;
}

/** The badge strip the row shows: scope, owner, source, pending state. */
export function memoryBadges(entry: MemoryEntry): MemoryBadge[] {
  const badges: MemoryBadge[] = [{ kind: 'scope', label: entry.scope === 'bot' ? 'bot' : 'user' }];
  if (entry.owner) badges.push({ kind: 'owner', label: entry.owner });
  if (entry.source) badges.push({ kind: 'source', label: entry.source });
  if (entry.status === 'pending') badges.push({ kind: 'status', label: 'pending' });
  return badges;
}

/** The write `memory.write` expects, with empty optional fields dropped. */
export function memoryWriteParams(input: {
  scope: MemoryScope;
  owner?: string | null;
  content: string;
  source?: string;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { scope: input.scope, content: input.content };
  if (input.scope === 'bot' && input.owner) params.owner = input.owner;
  if (input.source) params.source = input.source;
  return params;
}

/* ------------------------------------------------------------------ */
/* rejections — -32011 gate kinds and what to tell the user            */
/* ------------------------------------------------------------------ */

export type MemoryRejectKind =
  | 'prompt_injection'
  | 'secret'
  | 'invisible'
  | 'capacity'
  | 'invalid'
  | 'unsupported'
  | 'unknown';

/** A refuser that is not an RPC: the demo's simulation of the gate chain. */
export class MemoryRejection extends Error {
  readonly kind: MemoryRejectKind;
  readonly limit?: number;
  readonly current?: number;
  readonly attempted?: number;

  constructor(input: { kind: MemoryRejectKind; message?: string; limit?: number; current?: number; attempted?: number }) {
    super(input.message ?? input.kind);
    this.name = 'MemoryRejection';
    this.kind = input.kind;
    this.limit = input.limit;
    this.current = input.current;
    this.attempted = input.attempted;
  }
}

export interface MemoryErrorInfo {
  kind: MemoryRejectKind;
  message: string;
}

function rejectText(kind: MemoryRejectKind): string {
  switch (kind) {
    case 'prompt_injection':
      return '지시문처럼 보이는 내용이라 거부되었습니다 — 명령이 아닌 사실만 적어 주세요.';
    case 'secret':
      return '비밀키로 보이는 문자열이 있어 거부되었습니다 — 값을 지우고 다시 저장하세요.';
    case 'invisible':
      return '보이지 않는 문자(제로폭 등)가 섞여 있어 거부되었습니다.';
    case 'capacity':
      return '메모리 원장 한도를 넘습니다 — 오래된 항목을 지운 뒤 다시 시도하세요.';
    case 'invalid':
      return '내용이나 스코프가 올바르지 않습니다.';
    case 'unsupported':
      return '이 데몬은 메모리 쓰기를 지원하지 않습니다 (memory.write 없음).';
    default:
      return '메모리를 저장하지 못했습니다.';
  }
}

function kindOf(value: unknown): MemoryRejectKind | null {
  const known: MemoryRejectKind[] = ['prompt_injection', 'secret', 'invisible', 'capacity'];
  return typeof value === 'string' && (known as string[]).includes(value) ? (value as MemoryRejectKind) : null;
}

function numbersOf(data: unknown): { limit?: number; current?: number; attempted?: number } {
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const pick = (key: string) => (typeof record[key] === 'number' ? (record[key] as number) : undefined);
  return { limit: pick('limit'), current: pick('current'), attempted: pick('attempted') };
}

/**
 * Read whatever a refused write threw: the daemon's `-32011` with its
 * `error.data.kind`, a demo rejection, or an older untyped error.
 */
export function memoryErrorInfo(error: unknown): MemoryErrorInfo {
  if (error instanceof MemoryRejection) {
    return { kind: error.kind, message: capacityText(error.kind, error) };
  }
  if (error instanceof RpcError) {
    if (error.code === -32011) {
      const data = error.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {};
      const kind = kindOf(data.kind) ?? 'unknown';
      const size = numbersOf(error.data);
      return {
        kind,
        message: kind === 'capacity' ? capacityText(kind, size) : rejectText(kind),
      };
    }
    if (error.code === -32601) return { kind: 'unsupported', message: rejectText('unsupported') };
    if (error.code === -32602) return { kind: 'invalid', message: rejectText('invalid') };
    return { kind: 'unknown', message: error.message || rejectText('unknown') };
  }
  const message = (error as Error)?.message;
  return { kind: 'unknown', message: message || rejectText('unknown') };
}

function capacityText(kind: MemoryRejectKind, size: { limit?: number; current?: number; attempted?: number }): string {
  if (kind !== 'capacity') return rejectText(kind);
  if (size.limit !== undefined && size.current !== undefined) {
    const attempted = size.attempted !== undefined ? ` (+${size.attempted}자)` : '';
    return `원장 한도를 넘습니다 — ${size.current}/${size.limit}자${attempted}. 오래된 항목을 지운 뒤 다시 시도하세요.`;
  }
  return rejectText('capacity');
}
