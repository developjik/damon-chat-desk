/**
 * Session phase — the daemon's `session.status` folded into something the
 * desk can draw.
 *
 * Two sources say what a session is doing, and they answer different
 * questions:
 *
 *   - the daemon's ledger (`session.status` rows, `capabilities.sessionPhase`)
 *     knows every session, including turns other surfaces started;
 *   - this tab's own stream knows *now* — a poll is up to one interval old,
 *     so the conversation on screen would lag a turn it is itself streaming.
 *
 * `mergeSessionPhases` lets the live stream win for its own sessions and
 * leaves the daemon's word for the rest. Everything here is pure and
 * tolerant: a daemon that predates the field set simply contributes no
 * rows, and a row that omits `turnId`/`pendingAsk` stays valid.
 */

import type {
  Conversation,
  PendingAskSummary,
  RecoveredSession,
  ReplySlot,
  SessionPhase,
  SessionStatusRow,
  SessionStatusView,
  TransportKind,
} from './types';

export function emptySessionStatus(): SessionStatusView {
  return { supported: false, rows: [], recovered: [] };
}

export function isSessionPhase(value: unknown): value is SessionPhase {
  return value === 'idle' || value === 'busy' || value === 'awaiting_input';
}

/** The chip's word for a phase — short, mono, the daemon's own vocabulary. */
export function phaseChipLabel(phase: SessionPhase): string {
  if (phase === 'busy') return 'busy';
  if (phase === 'awaiting_input') return 'waiting';
  return 'idle';
}

/** What the chip means in a sentence (hover / screen reader). */
export function phaseTitle(phase: SessionPhase): string {
  if (phase === 'busy') return '턴 실행 중 (busy)';
  if (phase === 'awaiting_input') return '사용자 답을 기다리는 중 (awaiting_input)';
  return '유휴 (idle)';
}

/** An ask kind in the user's words; unknown kinds stay as they came. */
export function askKindLabel(kind: string): string {
  switch (kind) {
    case 'permission':
      return '승인 요청';
    case 'question':
      return '질문';
    case 'plan':
      return '계획 검토';
    default:
      return kind || '요청';
  }
}

/**
 * One `session.status` row → the desk's shape, or nothing when there is no
 * id to hang it on. `phase` is preferred; a daemon that only sends `busy`
 * (or a row mid-upgrade) is read from that instead of being dropped.
 */
export function normalizeSessionRow(raw: unknown): SessionStatusRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
  if (!sessionId) return null;
  const busy = row.busy === true;
  const pendingAsk = normalizePendingAsk(row.pendingAsk);
  const phase: SessionPhase = isSessionPhase(row.phase)
    ? row.phase
    : pendingAsk
      ? 'awaiting_input'
      : busy
        ? 'busy'
        : 'idle';
  const out: SessionStatusRow = {
    sessionId,
    backend: typeof row.backend === 'string' ? row.backend : '',
    phase,
    // A parked turn is busy on the wire too; derive it rather than trust a
    // row that only carried `phase`.
    busy: busy || phase !== 'idle',
    source: 'daemon',
  };
  // Absent is normal (the claim lands before the backend reports its id),
  // and the daemon may send an explicit null on a recovered row.
  if (typeof row.turnId === 'string' && row.turnId) out.turnId = row.turnId;
  if (typeof row.idleSecs === 'number') out.idleSecs = row.idleSecs;
  if (pendingAsk) out.pendingAsk = pendingAsk;
  return out;
}

export function normalizePendingAsk(raw: unknown): PendingAskSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const ask = raw as Record<string, unknown>;
  const requestId = typeof ask.requestId === 'string' ? ask.requestId : '';
  const kind = typeof ask.kind === 'string' ? ask.kind : '';
  if (!requestId && !kind) return null;
  return {
    requestId,
    kind: kind || 'ask',
    // `label` is optional on the wire (a tool ask has one, some asks do not).
    label: typeof ask.label === 'string' ? ask.label : '',
    askedAtMs: typeof ask.askedAtMs === 'number' ? ask.askedAtMs : 0,
  };
}

export function normalizeRecovered(raw: unknown): RecoveredSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
  if (!sessionId) return null;
  const out: RecoveredSession = {
    sessionId,
    backend: typeof row.backend === 'string' ? row.backend : '',
    // The row only exists because a turn was running or parked when the
    // daemon died; `busy` is the honest read when `phase` is missing.
    phase: isSessionPhase(row.phase) ? row.phase : 'busy',
    sinceMs: typeof row.sinceMs === 'number' ? row.sinceMs : 0,
  };
  if (typeof row.turnId === 'string' && row.turnId) out.turnId = row.turnId;
  return out;
}

/**
 * `session.status`'s whole answer. A daemon without the fields (or a
 * response that lost them) lands as empty lists, never as an exception.
 */
export function normalizeSessionStatus(raw: unknown): Pick<SessionStatusView, 'rows' | 'recovered'> {
  const body = (raw ?? {}) as { sessions?: unknown; recovered?: unknown };
  const rows = Array.isArray(body.sessions)
    ? body.sessions.map(normalizeSessionRow).filter((row): row is SessionStatusRow => row !== null)
    : [];
  const recovered = Array.isArray(body.recovered)
    ? body.recovered.map(normalizeRecovered).filter((row): row is RecoveredSession => row !== null)
    : [];
  return { rows, recovered };
}

/** The sessions this tab is streaming or parked on, read off its own slots. */
export function localSessionPhases(conversations: Conversation[], transport: TransportKind): SessionStatusRow[] {
  if (transport === 'openai') return [];
  const rows = new Map<string, SessionStatusRow>();
  for (const conversation of conversations) {
    const sessionIds =
      transport === 'demo' ? [conversation.id] : Object.values(conversation.daemonSessions ?? {});
    if (sessionIds.length === 0) continue;
    const row = phaseOfConversation(conversation);
    if (!row || row.phase === 'idle') continue;
    for (const sessionId of sessionIds) {
      const backend =
        Object.entries(conversation.daemonSessions ?? {}).find(([, id]) => id === sessionId)?.[0] ?? '';
      rows.set(sessionId, { ...row, sessionId, backend, source: 'local' });
    }
  }
  return [...rows.values()];
}

/**
 * What the last turn of a conversation says about it: a parked ask or an
 * unanswered plan is `awaiting_input`, a streaming slot is `busy`, and
 * everything else is `idle` (not worth reporting).
 */
export function phaseOfConversation(conversation: Conversation): SessionStatusRow | null {
  const message = conversation.messages[conversation.messages.length - 1];
  const slots: ReplySlot[] = message?.slots ?? [];
  if (slots.length === 0) return null;

  let pendingAsk: PendingAskSummary | undefined;
  let streaming = false;
  let turnId: string | undefined;

  for (const slot of slots) {
    if (!pendingAsk && slot.plan && slot.plan.status === 'awaiting_review') {
      pendingAsk = {
        requestId: slot.plan.id,
        kind: 'plan',
        label: slot.plan.title,
        askedAtMs: slot.plan.decidedAt ?? slot.startedAt,
      };
    }
    if (!pendingAsk && slot.ask) {
      pendingAsk = {
        requestId: slot.ask.id,
        kind: slot.ask.kind,
        label: slot.ask.title ?? slot.ask.name,
        askedAtMs: slot.startedAt,
      };
    }
    if (slot.status === 'streaming' || slot.status === 'queued') {
      streaming = true;
      turnId = turnId ?? slot.turnId;
    }
  }

  const phase: SessionPhase = pendingAsk ? 'awaiting_input' : streaming ? 'busy' : 'idle';
  const row: SessionStatusRow = {
    sessionId: '',
    backend: slots[0]?.target.provider ?? '',
    phase,
    busy: phase !== 'idle',
    source: 'local',
  };
  if (turnId) row.turnId = turnId;
  if (pendingAsk) row.pendingAsk = pendingAsk;
  return row;
}

/**
 * The daemon's rows with this tab's live phases laid over them.
 *
 * The rule is one line: a session this tab is actively working leaves the
 * daemon's stale snapshot alone, and a session it is not touching keeps the
 * daemon's word (another surface may be running it). A local `idle` never
 * overwrites a daemon `busy` — that would hide a turn somebody else owns.
 */
export function mergeSessionPhases(remote: SessionStatusRow[], local: SessionStatusRow[]): SessionStatusRow[] {
  const merged = new Map<string, SessionStatusRow>();
  for (const row of remote) merged.set(row.sessionId, row);
  for (const row of local) {
    if (row.phase === 'idle') continue;
    const known = merged.get(row.sessionId);
    const next: SessionStatusRow = {
      ...(known ?? row),
      sessionId: row.sessionId,
      backend: known?.backend || row.backend,
      phase: row.phase,
      busy: true,
      source: 'local',
    };
    if (row.turnId) next.turnId = row.turnId;
    else delete next.turnId;
    if (row.pendingAsk) next.pendingAsk = row.pendingAsk;
    else delete next.pendingAsk;
    merged.set(row.sessionId, next);
  }
  return [...merged.values()];
}

/** `sessionId → row`, for the list rows that only hold an id. */
export function sessionPhaseIndex(rows: SessionStatusRow[]): Map<string, SessionStatusRow> {
  return new Map(rows.map((row) => [row.sessionId, row]));
}

/** Drop one recovered mark locally (the daemon drops it when resumed). */
export function withoutRecovered(view: SessionStatusView, sessionId: string): SessionStatusView {
  const recovered = view.recovered.filter((row) => row.sessionId !== sessionId);
  return recovered.length === view.recovered.length ? view : { ...view, recovered };
}

/** `11111111-2222-…` reads better as `11111111` in a dense list. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

/**
 * One recovered row in a sentence: what it was doing, when it was found,
 * and which session it was — the whole reason the banner is worth space.
 */
export function recoveredSummary(row: RecoveredSession, now = Date.now()): string {
  const before = row.phase === 'awaiting_input' ? '답을 기다리던' : '턴 실행 중이던';
  const diff = row.sinceMs > 0 ? Math.max(0, now - row.sinceMs) : -1;
  const when =
    diff < 0
      ? ''
      : diff < 60_000
        ? '방금'
        : diff < 3_600_000
          ? `${Math.floor(diff / 60_000)}분 전`
          : diff < 86_400_000
            ? `${Math.floor(diff / 3_600_000)}시간 전`
            : `${Math.floor(diff / 86_400_000)}일 전`;
  return [before, when].filter(Boolean).join(' · ');
}
