import { describe, expect, it } from 'vitest';
import {
  askKindLabel,
  emptySessionStatus,
  isSessionPhase,
  localSessionPhases,
  mergeSessionPhases,
  normalizeRecovered,
  normalizeSessionRow,
  normalizeSessionStatus,
  phaseChipLabel,
  phaseOfConversation,
  recoveredSummary,
  sessionPhaseIndex,
  shortSessionId,
  withoutRecovered,
} from './phases';
import { makeTarget } from './targets';
import type { ChatMessage, Conversation, ReplySlot, SessionStatusRow } from './types';

const target = makeTarget({ provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet' });

function slot(over: Partial<ReplySlot> = {}): ReplySlot {
  return { id: 'slot-1', target, text: '', status: 'done', startedAt: 1000, ...over };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  const message: ChatMessage = { id: 'm1', role: 'assistant', createdAt: 1000, mode: 'single', slots: [slot()] };
  return {
    id: 'conv-1',
    title: '대화',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [message],
    daemonSessions: { claude: 'sess-1' },
    ...over,
  };
}

describe('session.status — wire normalization', () => {
  it('reads a full row', () => {
    expect(
      normalizeSessionRow({
        sessionId: 'sess-1',
        backend: 'claude',
        busy: true,
        phase: 'awaiting_input',
        idleSecs: 3,
        turnId: 'turn-9',
        pendingAsk: { requestId: 'req-1', kind: 'plan', label: '구현 계획', askedAtMs: 1700000000000 },
      }),
    ).toEqual({
      sessionId: 'sess-1',
      backend: 'claude',
      phase: 'awaiting_input',
      busy: true,
      turnId: 'turn-9',
      idleSecs: 3,
      pendingAsk: { requestId: 'req-1', kind: 'plan', label: '구현 계획', askedAtMs: 1700000000000 },
      source: 'daemon',
    });
  });

  it('tolerates a missing turnId — the claim lands before the backend names it', () => {
    const row = normalizeSessionRow({ sessionId: 'sess-1', backend: 'codex', busy: true, phase: 'busy' });
    expect(row?.phase).toBe('busy');
    expect(row).not.toHaveProperty('turnId');
    // The daemon sends an explicit null on some rows; that is absent too.
    expect(normalizeSessionRow({ sessionId: 's', busy: true, phase: 'busy', turnId: null })).not.toHaveProperty('turnId');
  });

  it('keeps an ask whose label is absent', () => {
    const row = normalizeSessionRow({
      sessionId: 'sess-1',
      busy: true,
      phase: 'awaiting_input',
      pendingAsk: { requestId: 'req-2', kind: 'question', askedAtMs: 5 },
    });
    expect(row?.pendingAsk).toEqual({ requestId: 'req-2', kind: 'question', label: '', askedAtMs: 5 });
  });

  it('derives the phase from what an older row did carry', () => {
    // No `phase` at all: `busy` speaks, and an ask means a parked turn.
    expect(normalizeSessionRow({ sessionId: 's', busy: true })?.phase).toBe('busy');
    expect(normalizeSessionRow({ sessionId: 's', busy: false })?.phase).toBe('idle');
    expect(
      normalizeSessionRow({ sessionId: 's', busy: true, pendingAsk: { requestId: 'r', kind: 'permission' } })?.phase,
    ).toBe('awaiting_input');
  });

  it('drops what it cannot place instead of throwing', () => {
    expect(normalizeSessionRow(null)).toBeNull();
    expect(normalizeSessionRow({ backend: 'claude' })).toBeNull();
    expect(normalizeSessionStatus(undefined)).toEqual({ rows: [], recovered: [] });
    expect(normalizeSessionStatus('nope')).toEqual({ rows: [], recovered: [] });
    expect(normalizeSessionStatus({ sessions: [{ sessionId: 'a' }, null], recovered: [{}] })).toEqual({
      rows: [{ sessionId: 'a', backend: '', phase: 'idle', busy: false, source: 'daemon' }],
      recovered: [],
    });
  });

  it('reads a recovered row as what the dead daemon was doing', () => {
    expect(
      normalizeRecovered({ sessionId: 'sess-1', backend: 'claude', phase: 'busy', sinceMs: 42, turnId: 'turn-1' }),
    ).toEqual({ sessionId: 'sess-1', backend: 'claude', phase: 'busy', sinceMs: 42, turnId: 'turn-1' });
    // turnId arrives as null when the claim never got one.
    expect(normalizeRecovered({ sessionId: 's', phase: 'awaiting_input', sinceMs: 7, turnId: null })).toEqual({
      sessionId: 's',
      backend: '',
      phase: 'awaiting_input',
      sinceMs: 7,
    });
    // No phase: a recovered row only exists because something was running.
    expect(normalizeRecovered({ sessionId: 's' })?.phase).toBe('busy');
    expect(normalizeRecovered({ sessionId: 's' })?.sinceMs).toBe(0);
  });
});

describe('this tab’s own phase', () => {
  it('reads a streaming slot as busy, with the daemon turn id', () => {
    const row = phaseOfConversation(conversation({ messages: [{ id: 'm', role: 'assistant', createdAt: 1, mode: 'single', slots: [slot({ status: 'streaming', turnId: 'turn-3' })] }] }));
    expect(row).toMatchObject({ phase: 'busy', busy: true, turnId: 'turn-3', backend: 'claude', source: 'local' });
  });

  it('reads a parked plan as awaiting_input with its label', () => {
    const row = phaseOfConversation(
      conversation({
        messages: [
          {
            id: 'm',
            role: 'assistant',
            createdAt: 1,
            mode: 'single',
            slots: [
              slot({
                status: 'streaming',
                plan: {
                  id: 'req-plan',
                  title: '구현 계획',
                  content: '',
                  steps: [],
                  files: [],
                  risks: [],
                  status: 'awaiting_review',
                },
              }),
            ],
          },
        ],
      }),
    );
    // The plan wins over the still-open stream: the turn is parked on it.
    expect(row).toMatchObject({ phase: 'awaiting_input', pendingAsk: { kind: 'plan', label: '구현 계획' } });
  });

  it('reads a tool ask as awaiting_input, and a finished turn as idle', () => {
    const asked = phaseOfConversation(
      conversation({
        messages: [
          {
            id: 'm',
            role: 'assistant',
            createdAt: 1,
            mode: 'single',
            slots: [
              slot({
                status: 'streaming',
                ask: { id: 'req-7', kind: 'permission', name: 'Bash', title: 'npm test', actions: [] },
              }),
            ],
          },
        ],
      }),
    );
    expect(asked).toMatchObject({ phase: 'awaiting_input', pendingAsk: { requestId: 'req-7', kind: 'permission', label: 'npm test' } });
    expect(phaseOfConversation(conversation())?.phase).toBe('idle');
    expect(phaseOfConversation(conversation({ messages: [] }))).toBeNull();
  });

  it('maps a daemon conversation onto every session it holds, and the demo onto its id', () => {
    const conversationWithTwo = conversation({
      daemonSessions: { claude: 'sess-1', qwen: 'sess-2' },
      messages: [{ id: 'm', role: 'assistant', createdAt: 1, mode: 'single', slots: [slot({ status: 'streaming' })] }],
    });
    const daemonRows = localSessionPhases([conversationWithTwo], 'daemon');
    expect(daemonRows.map((row) => row.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
    expect(daemonRows.every((row) => row.source === 'local' && row.phase === 'busy')).toBe(true);

    // The simulator names a session by its conversation id.
    const demoRows = localSessionPhases([conversation({ daemonSessions: {} })], 'demo');
    expect(demoRows).toHaveLength(0); // its last turn is done — no news
    expect(localSessionPhases([conversation()], 'openai')).toEqual([]);
  });
});

describe('mergeSessionPhases', () => {
  const remote: SessionStatusRow = {
    sessionId: 'sess-1',
    backend: 'claude',
    phase: 'idle',
    busy: false,
    source: 'daemon',
  };

  it('lets the live stream win over a stale daemon snapshot', () => {
    const local: SessionStatusRow = { sessionId: 'sess-1', backend: '', phase: 'busy', busy: true, source: 'local' };
    const [row] = mergeSessionPhases([remote], [local]);
    expect(row).toMatchObject({ sessionId: 'sess-1', backend: 'claude', phase: 'busy', busy: true, source: 'local' });
  });

  it('never lets a local idle hide a turn the daemon says is running', () => {
    const busyRemote = { ...remote, phase: 'busy' as const, busy: true };
    const merged = mergeSessionPhases([busyRemote], [{ sessionId: 'sess-1', backend: 'claude', phase: 'idle', busy: false }]);
    expect(merged[0]).toMatchObject({ phase: 'busy', busy: true, source: 'daemon' });
  });

  it('carries the ask from whoever knows it, and drops a stale one', () => {
    const parked: SessionStatusRow = {
      sessionId: 'sess-1',
      backend: 'claude',
      phase: 'awaiting_input',
      busy: true,
      pendingAsk: { requestId: 'req-1', kind: 'plan', label: '계획', askedAtMs: 1 },
      source: 'daemon',
    };
    const streaming: SessionStatusRow = { sessionId: 'sess-1', backend: 'claude', phase: 'busy', busy: true, turnId: 't-1' };
    // The ask was answered here, so this tab's `busy` says the parked ask is gone.
    const [answered] = mergeSessionPhases([parked], [streaming]);
    expect(answered.phase).toBe('busy');
    expect(answered.pendingAsk).toBeUndefined();
    expect(answered.turnId).toBe('t-1');
  });

  it('keeps sessions only the local stream knows about', () => {
    const merged = mergeSessionPhases([], [{ sessionId: 'new-1', backend: 'codex', phase: 'busy', busy: true }]);
    expect(merged).toEqual([{ sessionId: 'new-1', backend: 'codex', phase: 'busy', busy: true, source: 'local' }]);
  });
});

describe('phase display', () => {
  it('labels the three phases and the ask kinds', () => {
    expect([phaseChipLabel('idle'), phaseChipLabel('busy'), phaseChipLabel('awaiting_input')]).toEqual([
      'idle',
      'busy',
      'waiting',
    ]);
    expect([askKindLabel('permission'), askKindLabel('question'), askKindLabel('plan')]).toEqual([
      '승인 요청',
      '질문',
      '계획 검토',
    ]);
    expect(askKindLabel('mcp')).toBe('mcp');
    expect(isSessionPhase('busy')).toBe(true);
    expect(isSessionPhase('running')).toBe(false);
  });

  it('indexes rows by session and shortens ids for the list', () => {
    const index = sessionPhaseIndex([{ sessionId: 'aaaaaaaa-bbbb', backend: 'claude', phase: 'busy', busy: true }]);
    expect(index.get('aaaaaaaa-bbbb')?.phase).toBe('busy');
    expect(shortSessionId('aaaaaaaa-bbbb')).toBe('aaaaaaaa');
    expect(shortSessionId('short')).toBe('short');
  });

  it('drops one recovered mark without touching the rest of the view', () => {
    const view = {
      supported: true,
      rows: [],
      recovered: [
        { sessionId: 'a', backend: 'claude', phase: 'busy' as const, sinceMs: 1 },
        { sessionId: 'b', backend: 'codex', phase: 'busy' as const, sinceMs: 2 },
      ],
    };
    const next = withoutRecovered(view, 'a');
    expect(next.recovered.map((row) => row.sessionId)).toEqual(['b']);
    // Nothing to drop: the same object comes back, so the store does not emit.
    expect(withoutRecovered(next, 'zzz')).toBe(next);
    expect(emptySessionStatus()).toEqual({ supported: false, rows: [], recovered: [] });
  });

  it('says what a recovered session was doing and when', () => {
    const now = 20 * 3_600_000;
    expect(recoveredSummary({ sessionId: 's', backend: 'claude', phase: 'busy', sinceMs: now - 90_000 }, now)).toBe(
      '턴 실행 중이던 · 1분 전',
    );
    expect(
      recoveredSummary({ sessionId: 's', backend: 'claude', phase: 'awaiting_input', sinceMs: now - 3 * 3_600_000 }, now),
    ).toBe('답을 기다리던 · 3시간 전');
    // A daemon that reported no timestamp still says what it was doing.
    expect(recoveredSummary({ sessionId: 's', backend: 'claude', phase: 'busy', sinceMs: 0 }, now)).toBe('턴 실행 중이던');
  });
});
