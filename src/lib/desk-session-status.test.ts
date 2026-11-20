import { describe, expect, it } from 'vitest';
import { DeskController } from './desk';
import { DemoTransport } from './demo';
import type { SocketLike } from './rpc';

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

interface WireOptions {
  /** True when the daemon advertises `capabilities.sessionPhase`. */
  sessionPhase?: boolean;
  /** Answers for successive `session.status` calls; the last one repeats. */
  status?: unknown[];
}

const HELLO = (sessionPhase: boolean) => ({
  protocol: 2,
  minProtocol: 2,
  supported: [2],
  capabilities: { eventSeq: true, sessionPhase },
  daemon: 'damond',
  version: '0.9.0',
  backends: ['claude'],
});

/** A socket that answers the calls this desk makes while connecting. */
class FakeDaemon implements SocketLike {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  private statusCalls = 0;

  constructor(private readonly options: WireOptions) {}

  calls(method: string): Array<{ method: string; params: Record<string, unknown> }> {
    return this.sent.filter((frame) => frame.method === method);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (frame.method) this.sent.push({ method: frame.method, params: frame.params ?? {} });
    if (typeof frame.id !== 'number') return;
    setTimeout(() => this.answer(frame.id as number, frame.method ?? '', frame.params ?? {}), 0);
  }

  private answer(id: number, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'hello':
        this.deliver({ id, result: { ...HELLO(this.options.sessionPhase === true), methods: [] } });
        return;
      case 'session.list':
        this.deliver({
          id,
          result: {
            sessions: [
              { sessionId: 'sess-1', backend: 'claude', createdAt: 1, title: 'API 리뷰' },
              { sessionId: 'sess-9', backend: 'claude', createdAt: 2, title: '중단된 턴' },
            ],
          },
        });
        return;
      case 'session.status': {
        const answers = this.options.status ?? [{ sessions: [], recovered: [] }];
        const answer = answers[Math.min(this.statusCalls, answers.length - 1)];
        this.statusCalls += 1;
        if (answer instanceof Error) this.deliver({ id, error: { code: -32000, message: answer.message } });
        else this.deliver({ id, result: answer });
        return;
      }
      case 'session.resume':
        this.deliver({ id, result: { sessionId: params.sessionId, backend: 'claude', replayed: 0, cursor: 7 } });
        return;
      case 'memory.list':
        this.deliver({ id, result: { entries: [] } });
        return;
      case 'memory.usage':
        this.deliver({ id, result: { chars: 0, limit: 8000 } });
        return;
      default:
        this.deliver({ id, result: {} });
    }
  }

  close(): void {
    this.onclose?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  open(): void {
    this.onopen?.();
    this.deliver({ hello: HELLO(this.options.sessionPhase === true) });
  }
}

function env(options: WireOptions) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', version: '0.9.0', backends: ['claude'] }), { status: 200 });
    }
    if (url.endsWith('/v1/ws_ticket')) return new Response(JSON.stringify({ ticket: 't-1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const sockets: FakeDaemon[] = [];
  const socketFactory = (): SocketLike => {
    const socket = new FakeDaemon(options);
    sockets.push(socket);
    setTimeout(() => socket.open(), 0);
    return socket;
  };
  return { fetchImpl, socketFactory, sockets };
}

async function connected(options: WireOptions, statusPollMs = 0) {
  const deps = env(options);
  const desk = new DeskController({
    storage: new MemoryStorage(),
    demo: new DemoTransport({ sleep: async () => undefined }),
    fetchImpl: deps.fetchImpl,
    socketFactory: deps.socketFactory,
    statusPollMs,
  });
  await desk.connect('daemon', 'http://127.0.0.1:9470');
  return { desk, socket: deps.sockets[0] };
}

const PARKED = {
  sessions: [
    {
      sessionId: 'sess-1',
      backend: 'claude',
      busy: true,
      phase: 'awaiting_input',
      idleSecs: 2,
      pendingAsk: { requestId: 'req-1', kind: 'plan', label: '구현 계획', askedAtMs: 1700 },
    },
    { sessionId: 'sess-2', backend: 'codex', busy: true, phase: 'busy', idleSecs: 0 },
  ],
  recovered: [{ sessionId: 'sess-9', backend: 'claude', phase: 'busy', sinceMs: 5000, turnId: 'turn-9' }],
};

describe('DeskController — session.status', () => {
  it('keeps every phase, the parked ask and the recovered row', async () => {
    const { desk } = await connected({ sessionPhase: true, status: [PARKED] });
    const status = desk.getSnapshot().sessionStatus;
    expect(status.supported).toBe(true);
    expect(status.rows.map((row) => [row.sessionId, row.phase])).toEqual([
      ['sess-1', 'awaiting_input'],
      ['sess-2', 'busy'],
    ]);
    expect(status.rows[0].pendingAsk).toMatchObject({ kind: 'plan', label: '구현 계획' });
    expect(status.recovered).toEqual([
      { sessionId: 'sess-9', backend: 'claude', phase: 'busy', sinceMs: 5000, turnId: 'turn-9' },
    ]);
    expect(status.updatedAt).toBeGreaterThan(0);
  });

  it('never asks a daemon that predates the capability, and still connects', async () => {
    const { desk, socket } = await connected({ sessionPhase: false });
    const status = desk.getSnapshot().sessionStatus;
    expect(desk.getSnapshot().connection.status).toBe('live');
    expect(status.supported).toBe(false);
    expect(status.rows).toEqual([]);
    expect(socket.calls('session.status')).toEqual([]);
  });

  it('re-reads on demand and replaces the previous picture', async () => {
    const { desk } = await connected({
      sessionPhase: true,
      status: [PARKED, { sessions: [{ sessionId: 'sess-2', backend: 'codex', busy: false, phase: 'idle' }], recovered: [] }],
    });
    await desk.refreshSessionStatus();
    const status = desk.getSnapshot().sessionStatus;
    expect(status.rows).toEqual([{ sessionId: 'sess-2', backend: 'codex', phase: 'idle', busy: false, source: 'daemon' }]);
    // Resumed or pruned on the daemon: the banner goes on the next read.
    expect(status.recovered).toEqual([]);
  });

  it('keeps the last picture and says why when the read fails', async () => {
    const { desk } = await connected({ sessionPhase: true, status: [PARKED] });
    // The transport is still connected; the next read fails on the wire.
    (desk as unknown as { daemon: { sessionStatus: () => Promise<never> } }).daemon.sessionStatus = () =>
      Promise.reject(new Error('socket closed'));
    await desk.refreshSessionStatus();
    const status = desk.getSnapshot().sessionStatus;
    expect(status.error).toBe('socket closed');
    expect(status.rows).toHaveLength(2);
  });

  it('resumes a recovered session and clears its mark', async () => {
    const { desk, socket } = await connected({ sessionPhase: true, status: [PARKED] });
    const resumed = await desk.resumeRecoveredSession('sess-9');
    expect(resumed).toBe(true);
    expect(socket.calls('session.resume')).toEqual([{ method: 'session.resume', params: { sessionId: 'sess-9' } }]);
    expect(desk.getSnapshot().sessionStatus.recovered).toEqual([]);
    expect(desk.getSnapshot().notice).toContain('이어받았습니다');
  });

  it('says so when a resume is refused, and keeps the mark', async () => {
    const { desk } = await connected({ sessionPhase: true, status: [PARKED] });
    (desk as unknown as { daemon: { resumeSession: () => Promise<never> } }).daemon.resumeSession = () =>
      Promise.reject(new Error('session not live'));
    expect(await desk.resumeRecoveredSession('sess-9')).toBe(false);
    expect(desk.getSnapshot().sessionStatus.recovered).toHaveLength(1);
    expect(desk.getSnapshot().notice).toContain('session not live');
  });

  it('polls while connected, so a phase changed elsewhere still lands', async () => {
    const { desk, socket } = await connected({ sessionPhase: true, status: [PARKED] }, 20);
    const before = socket.calls('session.status').length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(socket.calls('session.status').length).toBeGreaterThan(before);
    // Leaving the daemon stops the timer with it.
    await desk.enterDemo();
    expect(desk.getSnapshot().sessionStatus.rows).toEqual([]);
  });

  it('drops the ledger when the desk moves to the simulated daemon', async () => {
    const { desk } = await connected({ sessionPhase: true, status: [PARKED] });
    await desk.enterDemo();
    const status = desk.getSnapshot().sessionStatus;
    expect(status.rows).toEqual([]);
    expect(status.recovered).toEqual([]);
  });

  it('draws this tab’s own streaming phase with no ledger at all', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slept = 0;
    const demo = new DemoTransport({
      sleep: async () => {
        slept += 1;
        if (slept === 1) await gate;
      },
      now: () => 1000,
      random: () => 0.5,
    });
    const desk = new DeskController({ storage: new MemoryStorage(), demo });
    await desk.init();
    const activeId = desk.getSnapshot().activeId;

    const running = desk.send('SSE 프레임 경계는 어떻게 처리해?');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const streaming = desk.sessionPhases();
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ sessionId: activeId, phase: 'busy', busy: true, source: 'local' });

    release();
    await running;
    // The turn is over: an idle session is no news, so no row is claimed.
    expect(desk.sessionPhases()).toEqual([]);
  });
});
