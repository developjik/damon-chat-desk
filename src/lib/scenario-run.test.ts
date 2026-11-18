import { describe, expect, it } from 'vitest';
import { DeskController } from './desk';
import { DemoTransport } from './demo';
import { WireTap } from './inspector';

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

async function ready() {
  const demo = new DemoTransport({ sleep: async () => undefined, now: () => 1_700_000_000_000, random: () => 0.5 });
  const wire = new WireTap(800, { now: () => 1_700_000_000_000 });
  const desk = new DeskController({ storage: new MemoryStorage(), demo, wire });
  await desk.init();
  return { desk, wire };
}

function activeSlot(desk: DeskController) {
  const state = desk.getSnapshot();
  const conversation = state.conversations.find((entry) => entry.id === state.activeId)!;
  const message = conversation.messages.at(-1)!;
  return { conversation, message, slot: message.slots![0] };
}

function slotOf(desk: DeskController, conversationId: string, messageId: string) {
  const conversation = desk.getSnapshot().conversations.find((entry) => entry.id === conversationId)!;
  return conversation.messages.find((entry) => entry.id === messageId)!.slots![0];
}

const eventData = (frame: { payload: unknown }) => (frame.payload as { data?: Record<string, unknown> }).data;

describe('scenarios in the desk', () => {
  it('runs the refactor scenario up to a plan and records the exchange', async () => {
    const { desk, wire } = await ready();
    await desk.runScenario('refactor');

    const { conversation, slot } = activeSlot(desk);
    expect(conversation.title).toBe('결제 웹훅 핸들러 3분할');
    expect(conversation.messages).toHaveLength(2);
    expect(slot.status).toBe('done');
    expect(slot.tools).toHaveLength(2);
    expect(slot.tools?.map((call) => call.kind)).toEqual(['read', 'search']);
    expect(slot.tools?.some((call) => call.result?.diff)).toBe(false);
    expect(slot.plan?.status).toBe('awaiting_review');
    expect(slot.plan?.steps.length).toBeGreaterThan(2);
    expect(slot.text).toContain('검증');

    const frames = wire.getSnapshot().frames;
    const methods = frames.map((frame) => `${frame.dir}:${frame.method}`);
    expect(methods).toContain('tx:session.create');
    expect(methods).toContain('rx:session.create');
    expect(methods).toContain('tx:turn.start');
    expect(methods).toContain('rx:turn.start');
    expect(frames.some((frame) => frame.method === 'session.event')).toBe(true);
    expect(
      frames.some((frame) => frame.method === 'session.event' && eventData(frame)?.type === 'permission_requested'),
    ).toBe(true);
    expect(frames.some((frame) => frame.method === 'session.event' && eventData(frame)?.kind === 'tool_call')).toBe(true);
    // the plan call rides the wire as a permission ask, not desk-only state
    const ask = frames.find((frame) => eventData(frame)?.type === 'permission_requested')!;
    expect(eventData(ask)?.kind).toBe('plan');
  });

  it('continues with the edits only after an approval', async () => {
    const { desk, wire } = await ready();
    await desk.runScenario('refactor');
    const first = activeSlot(desk);

    // A revision request settles the card and runs nothing.
    await desk.respondPlan(
      { convId: first.conversation.id, messageId: first.message.id, slotId: first.slot.id },
      'request_changes',
      '테스트를 먼저 추가해 주세요',
    );
    const revised = activeSlot(desk);
    expect(slotOf(desk, first.conversation.id, first.message.id).plan?.status).toBe('changes_requested');
    expect(revised.conversation.messages).toHaveLength(2);
    expect(wire.getSnapshot().frames.filter((frame) => frame.method === 'turn.start' && frame.dir === 'tx')).toHaveLength(1);

    // A second run, approved, does run its parked beats as a new turn.
    await desk.runScenario('incident');
    const second = activeSlot(desk);
    await desk.respondPlan(
      { convId: second.conversation.id, messageId: second.message.id, slotId: second.slot.id },
      'approve',
    );

    const conversation = desk
      .getSnapshot()
      .conversations.find((entry) => entry.id === second.conversation.id)!;
    expect(conversation.messages).toHaveLength(3);
    const followUp = conversation.messages[2].slots![0];
    expect(followUp.status).toBe('done');
    expect(followUp.notice).toContain('승인된 계획 실행');
    expect(followUp.tools?.map((call) => call.kind)).toEqual(expect.arrayContaining(['edit', 'shell']));
    expect(followUp.tools?.some((call) => call.result?.diff)).toBe(true);
    expect(followUp.text).toContain('핫픽스를 적용');
    expect(slotOf(desk, second.conversation.id, second.message.id).plan?.status).toBe('approved');

    const frames = wire.getSnapshot().frames;
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'plan.respond')).toBe(true);
    expect(
      frames.some(
        (frame) =>
          frame.dir === 'rx' &&
          frame.method === 'plan.respond' &&
          (frame.payload as { result?: { status?: string } }).result?.status === 'approved',
      ),
    ).toBe(true);
    expect(frames.filter((frame) => frame.method === 'turn.start' && frame.dir === 'tx')).toHaveLength(3);
  });

  it('sends the prompt for real on an OpenAI-compatible endpoint', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.body) bodies.push(String(init.body));
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/health')) {
        return new Response(JSON.stringify({ status: 'no daemon here' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '핫픽스를 적용했습니다.' } }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const wire = new WireTap(200, { now: () => 1000 });
    const desk = new DeskController({ storage: new MemoryStorage(), demo: new DemoTransport(), fetchImpl, wire });
    await desk.init();
    await desk.connect('openai', 'http://127.0.0.1:9999');
    expect(desk.getSnapshot().connection.transport).toBe('openai');

    await desk.runScenario('incident');
    const state = desk.getSnapshot();
    const conversation = state.conversations.find((entry) => entry.id === state.activeId)!;
    const user = conversation.messages.find((message) => message.role === 'user')!;
    expect(user.text).toContain('OOMKilled');
    expect(bodies.some((body) => body.includes('OOMKilled'))).toBe(true);
    expect(conversation.messages.at(-1)?.slots?.[0].text).toContain('핫픽스');

    const frames = wire.getSnapshot().frames;
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'https POST /v1/chat/completions')).toBe(true);
    expect(frames.some((frame) => frame.dir === 'rx' && frame.method === 'chat.completion')).toBe(true);
  });

  it('records a steer on the wire while the turn runs', async () => {
    const { desk, wire } = await ready();
    const run = desk.runScenario('pr-review');
    await desk.steer('보안 이슈를 먼저 정리해 줘');
    await run;

    const { slot } = activeSlot(desk);
    expect(slot.steers?.some((note) => note.text.includes('보안 이슈'))).toBe(true);
    expect(slot.steers?.every((note) => note.state === 'sent')).toBe(true);
    expect(slot.plan).toBeUndefined();
    const frames = wire.getSnapshot().frames;
    expect(frames.some((frame) => frame.dir === 'tx' && frame.method === 'turn.steer')).toBe(true);
    expect(frames.some((frame) => frame.dir === 'rx' && frame.method === 'turn.steer')).toBe(true);
  });

  it('opens, filters and clears the inspector through the controller', async () => {
    const { desk, wire } = await ready();
    expect(desk.getSnapshot().inspector).toEqual({ open: false, filter: 'all' });
    desk.toggleInspector();
    expect(desk.getSnapshot().inspector.open).toBe(true);
    desk.setInspectorFilter('tools');
    expect(desk.getSnapshot().inspector.filter).toBe('tools');
    await desk.runScenario('pr-review');
    expect(wire.getSnapshot().frames.length).toBeGreaterThan(0);
    desk.clearWire();
    expect(wire.getSnapshot().frames).toHaveLength(0);
    desk.toggleInspector(false);
    expect(desk.getSnapshot().inspector.open).toBe(false);
  });
});
