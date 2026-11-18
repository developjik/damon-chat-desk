import { describe, expect, it } from 'vitest';
import { DEMO_ROUTES, DemoTransport, chunkText, composeReply, detectIntent } from './demo';
import { WireTap } from './inspector';
import { mergeToolCall } from './tools';
import type { StreamEvent, ToolCall } from './types';

const instant = new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 });

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Fold the `tool` snapshots the way the desk does — by call id. */
function foldTools(events: StreamEvent[]): ToolCall[] {
  const rows: ToolCall[] = [];
  for (const event of events) {
    if (event.type !== 'tool') continue;
    const at = rows.findIndex((row) => row.id === event.call.id);
    if (at >= 0) rows[at] = mergeToolCall(rows[at], event.call);
    else rows.push(event.call);
  }
  return rows;
}

describe('detectIntent', () => {
  it('reads the intent off the prompt', () => {
    expect(detectIntent('SSE 파서에서 청크 경계 버그 어떻게 잡아?')).toBe('code');
    expect(detectIntent('스트리밍과 배치 중 어느 쪽이 나아?')).toBe('compare');
    expect(detectIntent('구현 순서를 설계해 줘')).toBe('plan');
    expect(detectIntent('오늘 점심 뭐 먹지')).toBe('explain');
  });
});

describe('composeReply', () => {
  it('answers in each provider style without leaking the other style', () => {
    const prompt = 'SSE 파서에서 청크 경계 버그 어떻게 잡아?';
    const claude = composeReply(prompt, DEMO_ROUTES[0]);
    const codex = composeReply(prompt, DEMO_ROUTES[1]);
    expect(claude).toContain('```ts');
    expect(claude).toContain('트레이드오프');
    expect(codex).toContain('계획');
    expect(codex).not.toBe(claude);
  });

  it('references the ask so a demo answer is not generic', () => {
    const prompt = '메시지 단위 라우팅을 어떻게 설계할까?';
    expect(composeReply(prompt, DEMO_ROUTES[2])).toContain('메시지 단위 라우팅을 어떻게 설계할까?');
  });
});

describe('chunkText', () => {
  it('round-trips the text and never splits a surrogate pair', () => {
    const text = '안녕하세요 👩‍💻 codex — 스트리밍 테스트';
    expect(chunkText(text).join('')).toBe(text);
    for (const chunk of chunkText(text)) {
      expect([...chunk].join('')).toBe(chunk);
    }
  });
});

describe('DemoTransport.streamTurn', () => {
  it('streams the composed answer and closes with usage', async () => {
    const prompt = 'SSE 응답에서 청크가 프레임 중간에서 끊기면 어떻게 처리해야 해?';
    const target = DEMO_ROUTES[1];
    const events = await collect(instant.streamTurn(prompt, target));

    expect(events[0].type).toBe('start');
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe(composeReply(prompt, target));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'completed' });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toMatchObject({ type: 'usage', usage: { inputTokens: expect.any(Number) } });
  });

  it('simulates a real tool log for a code ask', async () => {
    const events = await collect(
      instant.streamTurn('SSE 파서에서 청크 경계 버그 어떻게 잡아?', DEMO_ROUTES[0]),
    );
    // Two frames per call — `running`, then the terminal snapshot.
    expect(events.filter((event) => event.type === 'tool')).toHaveLength(8);
    const calls = foldTools(events);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ name: 'Bash', kind: 'shell', status: 'error', result: { exitCode: 1 } });
    expect(calls[0].result?.stdout).toContain('1 failed');
    expect(calls[1]).toMatchObject({ kind: 'read', label: 'src/lib/sse.ts' });
    expect(calls[2]).toMatchObject({ kind: 'edit' });
    expect(calls[3]).toMatchObject({ status: 'done', result: { exitCode: 0 } });
    expect(calls[2].result?.diff).toContain('+const SEPARATORS');
    expect(calls[2].endedAt).toBeGreaterThan(calls[2].startedAt);
  });

  it('names the tool vocabulary per provider', async () => {
    const claude = await collect(instant.streamTurn('파서 버그 잡아줘', DEMO_ROUTES[0]));
    const codex = await collect(instant.streamTurn('파서 버그 잡아줘', DEMO_ROUTES[1]));
    const namesOf = (events: StreamEvent[]) =>
      events.flatMap((event) => (event.type === 'tool' ? [event.call.name] : []));
    expect(namesOf(claude)).toContain('Bash');
    expect(namesOf(codex)).toContain('shell');
  });

  it('parks a plan for review after a design ask', async () => {
    const events = await collect(instant.streamTurn('구현 순서를 잡아줘', DEMO_ROUTES[0]));
    const planEvent = events.find((event): event is Extract<StreamEvent, { type: 'plan' }> => event.type === 'plan');
    expect(planEvent).toBeTruthy();
    expect(planEvent?.plan.steps.length).toBeGreaterThan(2);
    expect(planEvent?.plan.status).toBe('awaiting_review');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'awaiting_plan' });
  });

  it('injects a queued steer and acknowledges it in the stream', async () => {
    const demo = new DemoTransport({ sleep: () => new Promise((resolve) => setTimeout(resolve, 1)), now: () => 1000 });
    const target = DEMO_ROUTES[2];
    const events: StreamEvent[] = [];
    let steered = false;
    for await (const event of demo.streamTurn('테스트', target, { steerKey: target.key })) {
      events.push(event);
      if (!steered && event.type === 'delta') {
        demo.steer('대신 스트리밍 쪽으로 가자', target.key);
        steered = true;
      }
    }
    const steer = events.find((event) => event.type === 'steer');
    expect(steer).toMatchObject({ type: 'steer', text: '대신 스트리밍 쪽으로 가자' });
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    expect(text).toContain('대신 스트리밍 쪽으로 가자');
  });

  it('forks a session into a titled branch', () => {
    const demo = new DemoTransport({ now: () => 1000 });
    demo.seedSessions([{ sessionId: 'seed-1', backend: 'claude', title: '원본', createdAt: 1 }]);
    const id = demo.forkSession('seed-1', '원본');
    expect(id).toBe('demo-fork-1');
    expect(demo.sessionsList().find((row) => row.sessionId === id)?.title).toBe('원본 (fork)');
  });

  it('records a plan decision', async () => {
    const demo = new DemoTransport({ sleep: async () => undefined });
    const approved = await demo.respondPlan({ planId: 'p1', decision: 'approve' });
    expect(approved).toMatchObject({ status: 'approved', applied: true });
    const revised = await demo.respondPlan({ planId: 'p1', revision: 1, decision: 'request_changes' });
    expect(revised).toMatchObject({ status: 'changes_requested', revision: 2 });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const target = DEMO_ROUTES[0];
    for await (const event of instant.streamTurn('테스트', target, { signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'canceled' });
  });

  it('keeps a simulated memory ledger with one pending entry', () => {
    const entries = instant.memory(true);
    expect(entries.filter((entry) => entry.status === 'active').length).toBe(2);
    expect(entries.some((entry) => entry.status === 'pending')).toBe(true);
    expect(instant.memory()).toHaveLength(2);
    expect(instant.memoryUsage().limit).toBeGreaterThan(0);
  });
});

describe('demo wire', () => {
  it('records turn.start, assistant deltas and turn.cancel for an aborted turn', async () => {
    const wire = new WireTap(400, { now: () => 1_700_000_000_000 });
    const demo = new DemoTransport({ sleep: async () => undefined, now: () => 1_700_000_000_000, random: () => 0.5 });
    demo.setTap(wire);
    const controller = new AbortController();
    let seen = 0;
    let deltas = 0;
    for await (const event of demo.streamTurn('SSE 파서 버그 어떻게 잡아?', DEMO_ROUTES[0], {
      signal: controller.signal,
      sessionId: 'conv-test',
    })) {
      seen += 1;
      if (event.type === 'delta') deltas += 1;
      if (seen === 3) controller.abort();
    }
    expect(deltas).toBeGreaterThan(0);
    const frames = wire.getSnapshot().frames;
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'turn.start')).toBe(true);
    expect(
      frames.some((frame) => frame.dir === 'rx' && frame.method === 'session.event' && (frame.payload as { data?: { kind?: string } }).data?.kind === 'assistant_message'),
    ).toBe(true);
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'turn.cancel')).toBe(true);
    expect(
      frames.some((frame) => frame.dir === 'rx' && frame.method === 'session.event' && (frame.payload as { data?: { type?: string } }).data?.type === 'turn_canceled'),
    ).toBe(true);
    // pushes carry the session; responses are matched by id, as on the wire
    expect(
      frames.filter((frame) => frame.kind === 'notification').every((frame) => frame.sessionId === 'conv-test'),
    ).toBe(true);
  });

  it('records session.fork and turn.steer as request/response pairs', () => {
    const wire = new WireTap(50, { now: () => 1000 });
    const demo = new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 });
    demo.setTap(wire);
    demo.addSession({ sessionId: 'conv-1', backend: 'claude', title: '테스트', createdAt: 1000 });
    const forked = demo.forkSession('conv-1', '테스트');
    demo.steer('보안 먼저', 'claude/claude-sonnet-4-5', 'conv-1');
    const frames = wire.getSnapshot().frames;
    expect(forked).toBeTruthy();
    expect(frames.filter((frame) => frame.method === 'session.fork' && frame.id !== undefined)).toHaveLength(2);
    expect(
      frames.some((frame) => frame.dir === 'rx' && frame.method === 'session.fork' && (frame.payload as { result?: { sessionId?: string } }).result?.sessionId === forked),
    ).toBe(true);
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'turn.steer')).toBe(true);
    expect(wire.getSnapshot().inflight).toBe(0);
  });
});
