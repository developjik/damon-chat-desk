import { describe, expect, it } from 'vitest';
import { DaemonTransport } from './daemon';
import { RpcError, type ServerEvent } from './rpc';
import type { StreamEvent } from './types';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A transport whose JSON-RPC client is a scripted fake: `request` answers
 * from `answers` (or a deferred the test controls) and `push` feeds the
 * connection's event handlers, exactly as `RpcClient` would.
 */
function harness() {
  const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
  const handlers: Array<(event: ServerEvent) => void> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  const fakeRpc = {
    onEvent(handler: (event: ServerEvent) => void) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      const answer = answers.get(method);
      if (!answer) return Promise.resolve({});
      try {
        return Promise.resolve(answer(params));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  (transport as unknown as { rpc: unknown }).rpc = fakeRpc;

  const push = (frame: ServerEvent) => handlers.forEach((handler) => handler(frame));
  const event = (data: unknown, extra: Partial<ServerEvent> = {}): ServerEvent => ({
    event: 'session.event',
    sessionId: 's1',
    data,
    ...extra,
  });
  return { transport, calls, answers, push, event };
}

async function collect(generator: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('DaemonTransport — protocol surface', () => {
  it('reports the capabilities it was promised, and nothing it was not', () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    transport.hello = {
      protocol: 2,
      minProtocol: 2,
      supported: [2],
      capabilities: { eventSeq: true, connGap: true, idempotentTurns: true },
      daemon: 'damond',
      version: '0.9.0',
    };
    const protocol = transport.protocol;
    expect(protocol.version).toBe(2);
    expect(protocol.min).toBe(2);
    expect(protocol.supported).toEqual([2]);
    expect(protocol.capabilities.eventSeq).toBe(true);
    expect(protocol.capabilities.snapshotRequired).toBe(false);
    expect(transport.supports('idempotentTurns')).toBe(true);
    expect(transport.supports('turnLedger')).toBe(false);
  });

  it('reads the cursor out of create, resume and watch', async () => {
    const { transport, answers, calls } = harness();
    answers.set('session.create', () => ({ sessionId: 'sess-1', backend: 'claude', replayed: 2, cursor: 41 }));
    answers.set('session.resume', () => ({ sessionId: 'sess-1', backend: 'claude', replayed: 0, cursor: 55 }));
    answers.set('session.watch', () => ({ sessionId: 'sess-1', subscribed: true, replayed: 0, cursor: 60 }));

    await expect(transport.createSession({ backend: 'claude' })).resolves.toMatchObject({ sessionId: 'sess-1', cursor: 41 });
    await expect(transport.resumeSession('sess-1')).resolves.toMatchObject({ cursor: 55 });
    await expect(transport.watchSession('sess-1')).resolves.toMatchObject({ subscribed: true, cursor: 60 });
    expect(calls.map((call) => call.method)).toEqual([
      'session.create',
      'session.resume',
      'session.watch',
    ]);
  });
});

describe('DaemonTransport.streamTurn — keyed turns', () => {
  it('sends the turn key and remembers the cursor it is given', async () => {
    const { transport, calls, answers, push, event } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);
    const cursors: number[] = [];

    const consumer = collect(
      transport.streamTurn('s1', '안녕', {
        idempotencyKey: 'key-1',
        baseline: 40,
        onCursor: (cursor) => cursors.push(cursor),
      }),
    );
    await tick();
    push(event({ type: 'turn_started' }, { seq: 41 }));
    push(event({ type: 'timeline', kind: 'assistant_message', text: '안' }, { seq: 42 }));
    turn.resolve({ turnId: 't1', stopReason: 'completed' });
    const events = await consumer;

    expect(calls[0]).toEqual({
      method: 'turn.start',
      params: { sessionId: 's1', prompt: '안녕', idempotencyKey: 'key-1' },
    });
    expect(events.some((entry) => entry.type === 'delta')).toBe(true);
    expect(cursors.at(-1)).toBe(42);
  });

  it('skips replay frames so catch-up history is not rendered twice', async () => {
    const { transport, answers, push, event } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);

    const consumer = collect(transport.streamTurn('s1', '다시'));
    await tick();
    // A fresh subscription replays the store: a finished turn's text and
    // its turn_completed. Neither belongs to the turn this consumer awaits.
    push(event({ type: 'timeline', kind: 'assistant_message', text: '지난 답' }, { replay: true, seq: 30 }));
    push(event({ type: 'turn_completed' }, { replay: true, seq: 31 }));
    push(event({ type: 'timeline', kind: 'assistant_message', text: '이번 답' }, { seq: 32 }));
    turn.resolve({ turnId: 't2', stopReason: 'completed' });
    const events = await consumer;

    expect(events.filter((entry) => entry.type === 'delta')).toEqual([{ type: 'delta', text: '이번 답' }]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reports a jump in seq as a gap even without a session.gap frame', async () => {
    const { transport, answers, push, event } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);

    const consumer = collect(transport.streamTurn('s1', '안녕', { baseline: 10 }));
    await tick();
    push(event({ type: 'turn_started' }, { seq: 11 }));
    // 12–14 never arrived.
    push(event({ type: 'timeline', kind: 'assistant_message', text: '끝' }, { seq: 15 }));
    turn.resolve({ turnId: 't3', stopReason: 'completed' });
    const events = await consumer;

    const gap = events.find((entry) => entry.type === 'gap');
    expect(gap).toMatchObject({ type: 'gap', dropped: 3, cursor: 15 });
  });

  it('takes the daemon’s own gap count instead of recounting it', async () => {
    const { transport, answers, push } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);

    const consumer = collect(transport.streamTurn('s1', '안녕', { baseline: 10 }));
    await tick();
    push({ event: 'session.event', sessionId: 's1', seq: 11, data: { type: 'turn_started' } });
    push({ event: 'session.gap', sessionId: 's1', dropped: 4, cursor: 16 });
    push({ event: 'session.event', sessionId: 's1', seq: 16, data: { type: 'timeline', kind: 'assistant_message', text: '다음' } });
    turn.resolve({ turnId: 't4', stopReason: 'completed' });
    const events = await consumer;

    const gaps = events.filter((entry) => entry.type === 'gap');
    expect(gaps).toEqual([{ type: 'gap', dropped: 4, cursor: 16 }]);
  });

  it('surfaces snapshot_required as its own event', async () => {
    const { transport, answers, push } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);

    const consumer = collect(transport.streamTurn('s1', '안녕'));
    await tick();
    push({ event: 'session.snapshot_required', sessionId: 's1', cursor: 21, reason: 'journal_overflow' });
    push({ event: 'session.event', sessionId: 's1', seq: 22, data: { type: 'timeline', kind: 'assistant_message', text: '일부' } });
    turn.resolve({ turnId: 't5', stopReason: 'completed' });
    const events = await consumer;

    expect(events.find((entry) => entry.type === 'snapshot_required')).toEqual({
      type: 'snapshot_required',
      cursor: 21,
      reason: 'journal_overflow',
    });
  });

  it('keeps watching when the key is already running elsewhere', async () => {
    const { transport, answers, push, event } = harness();
    const turn = deferred<unknown>();
    answers.set('turn.start', () => turn.promise);

    const consumer = collect(transport.streamTurn('s1', '안녕', { idempotencyKey: 'k-9' }));
    await tick();
    // The first attempt owns the turn; this connection was subscribed to it.
    turn.resolve({ sessionId: 's1', duplicate: true, inProgress: true });
    await tick();
    push(event({ type: 'turn_started' }, { seq: 41 }));
    push(event({ type: 'timeline', kind: 'assistant_message', text: '진행 중인 답' }, { seq: 42 }));
    push(event({ type: 'turn_completed' }, { seq: 43 }));
    const events = await consumer;

    expect(events.find((entry) => entry.type === 'delivery')).toMatchObject({
      patch: { attached: true, duplicate: true },
    });
    expect(events.filter((entry) => entry.type === 'delta')).toEqual([{ type: 'delta', text: '진행 중인 답' }]);
    // The inProgress answer is not an answer: exactly one ending, from the turn.
    expect(events.filter((entry) => entry.type === 'done')).toHaveLength(1);
  });

  it('replays the first answer when the key already settled', async () => {
    const { transport, answers } = harness();
    answers.set('turn.start', () => ({ turnId: 't7', stopReason: 'completed', usage: { output_tokens: 5 }, duplicate: true }));

    const events = await collect(transport.streamTurn('s1', '안녕', { idempotencyKey: 'k-7' }));
    expect(events.find((entry) => entry.type === 'delivery')).toMatchObject({ patch: { duplicate: true } });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'completed', usage: { outputTokens: 5 } });
  });

  it('resumes a dead session and re-sends the same key', async () => {
    const { transport, answers, calls } = harness();
    let attempts = 0;
    answers.set('turn.start', () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError({ code: -32001, message: 'session not live' });
      return { turnId: 't8', stopReason: 'completed' };
    });
    answers.set('session.resume', () => ({ sessionId: 's1', replayed: 0, cursor: 70 }));

    const events = await collect(transport.streamTurn('s1', '안녕', { idempotencyKey: 'k-8' }));
    expect(calls.map((call) => call.method)).toEqual(['turn.start', 'session.resume', 'turn.start']);
    expect(calls[2].params).toMatchObject({ sessionId: 's1', idempotencyKey: 'k-8' });
    expect(events.find((entry) => entry.type === 'delivery')).toMatchObject({ patch: { resumed: true } });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('gives up when the session cannot be resumed', async () => {
    const { transport, answers } = harness();
    answers.set('turn.start', () => {
      throw new RpcError({ code: -32001, message: 'session not live' });
    });
    answers.set('session.resume', () => {
      throw new RpcError({ code: -32602, message: 'session not found' });
    });
    const events = await collect(transport.streamTurn('s1', '안녕'));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((events.at(-1) as { message: string }).message).toContain('session not live');
  });
});
