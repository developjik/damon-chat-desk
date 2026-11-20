import { describe, expect, it } from 'vitest';
import { DeskController } from './desk';
import { DemoTransport } from './demo';
import { makeTarget } from './targets';
import type { ChatMessage, RouteTarget, StreamEvent, TransportKind } from './types';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const TARGET: RouteTarget = makeTarget({
  provider: 'claude',
  providerLabel: 'Claude Code',
  model: 'sonnet',
  modelLabel: 'Sonnet 4.6',
});

interface FakeStreamOptions {
  idempotencyKey?: string;
  baseline?: number | null;
  onCursor?: (cursor: number) => void;
  signal?: AbortSignal;
}

/**
 * The daemon the desk thinks it is talking to: a scripted `streamTurn`
 * plus the calls this feature cares about. It answers in the desk's own
 * vocabulary (`StreamEvent`, `ChatMessage`), which is what the real
 * transport maps the wire into.
 */
function fakeDaemon(script: {
  events: StreamEvent[];
  stored?: ChatMessage[];
  createCursor?: number;
  turnDelayMs?: number;
}) {
  const calls: string[] = [];
  const keys: Array<string | undefined> = [];
  const baselines: Array<number | null | undefined> = [];
  const transport = {
    protocol: {
      version: 2,
      min: 2,
      supported: [2],
      negotiated: true,
      capabilities: {
        eventSeq: true,
        snapshotRequired: true,
        connGap: true,
        idempotentTurns: true,
        turnLedger: true,
        versionNegotiation: true,
      },
    },
    supports: () => true,
    async createSession() {
      calls.push('session.create');
      return { sessionId: 'sess-1', backend: 'claude', cursor: script.createCursor ?? 40, replayed: 0 };
    },
    async watchSession(sessionId: string) {
      calls.push('session.watch');
      return { sessionId, subscribed: true, cursor: 41 };
    },
    async messages() {
      calls.push('session.messages');
      return script.stored ?? [];
    },
    async steer(_sessionId: string, _prompt: string, key?: string) {
      calls.push('turn.steer');
      keys.push(key);
      return 'steering';
    },
    async *streamTurn(_sessionId: string, _prompt: string, opts: FakeStreamOptions = {}) {
      calls.push('turn.start');
      keys.push(opts.idempotencyKey);
      baselines.push(opts.baseline);
      if (script.turnDelayMs) await new Promise((resolve) => setTimeout(resolve, script.turnDelayMs));
      for (const event of script.events) {
        if (opts.onCursor) {
          const cursor = event.type === 'gap' || event.type === 'snapshot_required' ? event.cursor : undefined;
          if (typeof cursor === 'number') opts.onCursor(cursor);
        }
        yield event;
      }
    },
  };
  return { transport, calls, keys, baselines };
}

async function daemonDesk(transport: unknown) {
  const desk = new DeskController({ storage: new MemoryStorage(), demo: new DemoTransport({ sleep: async () => undefined }) });
  // A live boot is a network round trip; the desk's own event handling is
  // what this suite exercises, so the transport is mounted directly.
  const internals = desk as unknown as {
    daemon: unknown;
    set: (patch: Record<string, unknown>, immediate?: boolean) => void;
  };
  internals.daemon = transport;
  internals.set({
    connection: {
      transport: 'daemon' as TransportKind,
      status: 'live',
      baseUrl: 'http://127.0.0.1:9470',
      version: 'damond 0.9.0',
      targets: [TARGET],
    },
    primaryKey: TARGET.key,
    secondaryKey: TARGET.key,
  });
  return desk;
}

function lastSlot(desk: DeskController) {
  const state = desk.getSnapshot();
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  const message = [...(conversation?.messages ?? [])].reverse().find((entry) => entry.role === 'assistant');
  return { conversation, message, slot: message?.slots?.[0] };
}

describe('DeskController — protocol v2 delivery', () => {
  it('starts the turn from the session cursor and keeps it', async () => {
    const fake = fakeDaemon({ events: [{ type: 'start' }, { type: 'delta', text: '답' }, { type: 'done' }], createCursor: 40 });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    expect(fake.calls.slice(0, 2)).toEqual(['session.create', 'turn.start']);
    expect(fake.baselines[0]).toBe(40);
    expect((desk as unknown as { sessionCursors: Map<string, number> }).sessionCursors.get('sess-1')).toBe(40);
  });

  it('marks a reply whose stream admitted dropped events', async () => {
    const fake = fakeDaemon({
      events: [
        { type: 'start' },
        { type: 'delta', text: '부분' },
        { type: 'gap', dropped: 3, cursor: 47 },
        { type: 'delta', text: ' 답' },
        { type: 'done' },
      ],
    });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    const { slot } = lastSlot(desk);
    expect(slot?.status).toBe('done');
    expect(slot?.text).toBe('부분 답');
    expect(slot?.delivery).toMatchObject({ dropped: 3, cursor: 47 });
    // A gap is not a resync trigger: the turn's own frames were fine.
    expect(fake.calls).not.toContain('session.messages');
  });

  it('re-reads the stored turn when the journal shed its prefix', async () => {
    const stored: ChatMessage[] = [
      { id: 'db-u', role: 'user', text: '질문', createdAt: 1, mode: 'single' },
      {
        id: 'db-a',
        role: 'assistant',
        createdAt: 2,
        mode: 'single',
        slots: [{ id: 'db-a-slot', target: TARGET, text: '부분 답 — 저장본에서 복원한 나머지', status: 'done', startedAt: 2, imported: true }],
      },
    ];
    const fake = fakeDaemon({
      events: [{ type: 'start' }, { type: 'delta', text: '부분' }, { type: 'snapshot_required', cursor: 51 }, { type: 'done' }],
      stored,
    });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    const { slot } = lastSlot(desk);
    expect(fake.calls).toContain('session.messages');
    expect(slot?.text).toBe('부분 답 — 저장본에서 복원한 나머지');
    expect(slot?.delivery).toMatchObject({ snapshotRequired: true, resynced: true });
    expect(desk.getSnapshot().notice).toContain('다시 읽었습니다');
  });

  it('keeps the streamed text when the store has nothing longer', async () => {
    const fake = fakeDaemon({
      events: [{ type: 'start' }, { type: 'delta', text: '부분 답' }, { type: 'snapshot_required' }, { type: 'done' }],
      stored: [],
    });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    const { slot } = lastSlot(desk);
    expect(slot?.text).toBe('부분 답');
    expect(slot?.delivery).toMatchObject({ snapshotRequired: true, stale: true });
  });

  it('does not resync a compare conversation from one side', async () => {
    const fake = fakeDaemon({
      events: [{ type: 'start' }, { type: 'delta', text: '부분' }, { type: 'snapshot_required' }, { type: 'done' }],
      stored: [
        {
          id: 'db-a',
          role: 'assistant',
          createdAt: 2,
          mode: 'single',
          slots: [{ id: 'db-a-slot', target: TARGET, text: '아주 긴 저장본 답변입니다', status: 'done', startedAt: 2, imported: true }],
        },
      ],
    });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');
    const conv = desk.getSnapshot().conversations.find((entry) => entry.id === desk.getSnapshot().activeId);
    // A compare conversation holds two sessions: re-reading one would
    // speak for both.
    (desk as unknown as { patchConversation: (id: string, patch: Record<string, unknown>) => void }).patchConversation(conv!.id, {
      daemonSessions: { claude: 'sess-1', codex: 'sess-2' },
    });
    fake.calls.length = 0;
    await desk.send('두 번째 질문');

    const { slot } = lastSlot(desk);
    expect(fake.calls.filter((call) => call === 'session.messages')).toHaveLength(0);
    expect(slot?.delivery).toMatchObject({ snapshotRequired: true, stale: true });
  });
});

describe('DeskController — keyed retry', () => {
  it('re-sends the same key after a transport failure', async () => {
    const fake = fakeDaemon({ events: [{ type: 'start' }, { type: 'delta', text: '진행' }, { type: 'error', message: 'socket closed' }] });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    const first = lastSlot(desk);
    expect(first.slot?.status).toBe('error');
    expect(first.slot?.turnId).toBeUndefined();
    const key = first.slot?.idempotencyKey;
    expect(key).toBeTruthy();

    fake.keys.length = 0;
    await desk.retrySlot(first.conversation!.id, first.message!.id, first.slot!.id);
    expect(fake.keys).toEqual([key]);
  });

  it('mints a new key once the turn really ran', async () => {
    const fake = fakeDaemon({ events: [{ type: 'start', turnId: 'turn-7' }, { type: 'delta', text: '진행' }, { type: 'error', message: 'backend died' }] });
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();
    await desk.send('질문');

    const first = lastSlot(desk);
    expect(first.slot?.turnId).toBe('turn-7');
    const key = first.slot?.idempotencyKey;
    fake.keys.length = 0;
    await desk.retrySlot(first.conversation!.id, first.message!.id, first.slot!.id);
    expect(fake.keys[0]).toBeTruthy();
    expect(fake.keys[0]).not.toBe(key);
  });
});

describe('DeskController — steering under a key', () => {
  it('sends the steer key so a lost ack cannot double-deliver', async () => {
    const hold: { release?: () => void } = {};
    const fake = fakeDaemon({
      events: [],
      turnDelayMs: 0,
    });
    // A turn that stays live while the steer goes out.
    const streamTurn = async function* (this: unknown, _s: string, _p: string, opts: FakeStreamOptions = {}) {
      fake.calls.push('turn.start');
      fake.keys.push(opts.idempotencyKey);
      await new Promise<void>((resolve) => {
        hold.release = resolve;
      });
      yield { type: 'done' } as StreamEvent;
    };
    (fake.transport as unknown as { streamTurn: unknown }).streamTurn = streamTurn;
    const desk = await daemonDesk(fake.transport);
    desk.newConversation();

    const sending = desk.send('질문');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await desk.steer('방향 수정');

    const steered = fake.keys[1];
    expect(steered).toBeTruthy();
    expect(fake.calls).toContain('turn.steer');
    hold.release?.();
    await sending;
  });
});
