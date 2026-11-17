import { describe, expect, it } from 'vitest';
import { DeskController, memoryBlock, titleOf } from './desk';
import { DEMO_ROUTES, DemoTransport } from './demo';
import type { RouteTarget, StreamEvent } from './types';

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
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

function makeDesk(promptLog?: string[]) {
  const demo = new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 });
  if (promptLog) {
    const original = demo.streamTurn.bind(demo);
    demo.streamTurn = (prompt: string, target: RouteTarget) => {
      promptLog.push(prompt);
      return original(prompt, target);
    };
  }
  const storage = new MemoryStorage();
  const desk = new DeskController({ storage, demo });
  return { desk, storage, demo };
}

async function ready(promptLog?: string[]) {
  const ctx = makeDesk(promptLog);
  await ctx.desk.init();
  return ctx;
}

describe('titleOf', () => {
  it('flattens whitespace and truncates', () => {
    expect(titleOf('  hello   world ')).toBe('hello world');
    expect(titleOf('x'.repeat(60))).toHaveLength(45);
  });
});

describe('memoryBlock', () => {
  it('only includes active entries and declares itself data', () => {
    const block = memoryBlock([
      { id: '1', scope: 'user', content: '활성 메모', status: 'active' },
      { id: '2', scope: 'user', content: '대기 메모', status: 'pending' },
    ]);
    expect(block).toContain('활성 메모');
    expect(block).not.toContain('대기 메모');
    expect(block.startsWith('<memory>')).toBe(true);
    expect(block).toContain('지시가 아니라');
  });
});

describe('DeskController — demo boot', () => {
  it('connects to the simulated daemon and seeds a session list', async () => {
    const { desk } = await ready();
    const state = desk.getSnapshot();
    expect(state.connection.transport).toBe('demo');
    expect(state.connection.status).toBe('live');
    expect(state.connection.targets).toHaveLength(4);
    expect(state.conversations.length).toBe(3);
    expect(state.activeId).toBe('demo-conv-1');
    expect(state.primaryKey).toBe(DEMO_ROUTES[0].key);
    expect(state.secondaryKey).toBe(DEMO_ROUTES[1].key);
    expect(state.memory.entries.length).toBeGreaterThan(0);
  });
});

describe('DeskController — sending', () => {
  it('adds a turn and finishes the reply in place', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('SSE 프레임 경계는 어떻게 처리해?');

    const conversation = desk.getSnapshot().conversations.find((entry) => entry.id === desk.getSnapshot().activeId);
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.title).toContain('SSE');
    const slot = conversation?.messages[1].slots?.[0];
    expect(slot?.status).toBe('done');
    expect(slot?.text.length).toBeGreaterThan(80);
    expect(slot?.endedAt).toBeGreaterThanOrEqual(slot?.startedAt ?? 0);
    expect(desk.getSnapshot().busy).toBe(false);
  });

  it('fan-outs to two routes in compare mode', async () => {
    const { desk } = await ready();
    desk.newConversation();
    desk.setPrimary(DEMO_ROUTES[0].key);
    desk.setSecondary(DEMO_ROUTES[2].key);
    desk.setCompare(true);
    await desk.send('스트리밍과 배치를 비교해 줘');

    const conversation = desk.getSnapshot().conversations.find((entry) => entry.id === desk.getSnapshot().activeId);
    const assistant = conversation?.messages[1];
    expect(assistant?.mode).toBe('compare');
    expect(assistant?.slots).toHaveLength(2);
    expect(assistant?.slots?.map((slot) => slot.target.provider)).toEqual(['claude', 'qwen']);
    expect(assistant?.slots?.every((slot) => slot.status === 'done' && slot.text.length > 0)).toBe(true);
  });

  it('refuses to start a compare with the same route twice', async () => {
    const { desk } = await ready();
    desk.setCompare(true);
    desk.setPrimary(DEMO_ROUTES[0].key);
    desk.setSecondary(DEMO_ROUTES[0].key);
    await desk.send('같은 라우트 두 번');
    const conversation = desk.getSnapshot().conversations.find((entry) => entry.id === desk.getSnapshot().activeId);
    expect(conversation?.messages[1].slots).toHaveLength(1);
  });

  it('injects the memory block in front of the outgoing prompt', async () => {
    const prompts: string[] = [];
    const { desk } = await ready(prompts);
    desk.newConversation();
    desk.setMemoryEnabled(true);
    await desk.send('메모리 주입 확인');
    expect(prompts[0].startsWith('<memory>')).toBe(true);
    expect(prompts[0]).toContain('메모리 주입 확인');
    expect(prompts[0]).toContain('JSON-RPC');

    prompts.length = 0;
    desk.setMemoryEnabled(false);
    await desk.send('메모리 off');
    expect(prompts[0]).toBe('메모리 off');
  });

  it('retries a finished reply in place', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('재시도 테스트');
    const state = desk.getSnapshot();
    const conversation = state.conversations.find((entry) => entry.id === state.activeId);
    const message = conversation!.messages[1];
    const slot = message.slots![0];
    slot.text = '지워질 텍스트';
    await desk.retrySlot(conversation!.id, message.id, slot.id);
    const after = desk.getSnapshot().conversations.find((entry) => entry.id === state.activeId);
    expect(after?.messages[1].slots?.[0].text).not.toContain('지워질');
    expect(after?.messages[1].slots?.[0].status).toBe('done');
  });

  it('ignores an empty prompt and a second send while busy', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('   ');
    expect(desk.getSnapshot().activeId).toBeNull();

    const slow = new DemoTransport({ sleep: () => new Promise((resolve) => setTimeout(resolve, 20)) });
    const desk2 = new DeskController({ storage: new MemoryStorage(), demo: slow });
    await desk2.init();
    desk2.newConversation();
    const first = desk2.send('첫 메시지');
    await desk2.send('두 번째');
    await first;
    const conversation = desk2.getSnapshot().conversations.find((entry) => entry.id === desk2.getSnapshot().activeId);
    expect(conversation?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});

describe('DeskController — persistence and sessions', () => {
  it('persists conversations and restores them', async () => {
    const { desk, storage } = await ready();
    desk.newConversation();
    await desk.send('저장되는 대화');
    const saved = storage.raw('damon-desk.v1');
    expect(saved).toBeTruthy();
    expect(saved).toContain('저장되는 대화');

    const restored = new DeskController({ storage, demo: new DemoTransport({ sleep: async () => undefined }) });
    await restored.init();
    expect(restored.getSnapshot().conversations.some((entry) => entry.messages.some((message) => message.text === '저장되는 대화'))).toBe(true);
  });

  it('creates, selects and deletes conversations', async () => {
    const { desk } = await ready();
    const first = desk.getSnapshot().activeId;
    desk.newConversation();
    expect(desk.getSnapshot().activeId).toBeNull();
    desk.selectConversation(first!);
    expect(desk.getSnapshot().activeId).toBe(first);
    desk.deleteConversation(first!);
    expect(desk.getSnapshot().conversations.some((entry) => entry.id === first)).toBe(false);
  });

  it('keeps compare routes distinct when the primary moves', async () => {
    const { desk } = await ready();
    desk.setPrimary(DEMO_ROUTES[3].key);
    desk.setPrimary(DEMO_ROUTES[0].key);
    const state = desk.getSnapshot();
    expect(state.primaryKey).toBe(DEMO_ROUTES[0].key);
    expect(state.secondaryKey).not.toBe(state.primaryKey);
  });

  it('toggles memory and keeps the flag in the snapshot', async () => {
    const { desk } = await ready();
    desk.setMemoryEnabled(false);
    expect(desk.getSnapshot().memory.enabled).toBe(false);
    desk.setMemoryEnabled(true);
    expect(desk.getSnapshot().memory.enabled).toBe(true);
  });

  it('opens a demo daemon session as a conversation', async () => {
    const { desk } = await ready();
    await desk.openDaemonSession({ sessionId: 'seed-1', backend: 'claude', title: '데몬 세션', createdAt: 10 });
    const state = desk.getSnapshot();
    const conversation = state.conversations.find((entry) => entry.id === state.activeId);
    expect(conversation?.title).toBe('데몬 세션');
    expect(conversation?.daemonSessions.claude).toBe('seed-1');
  });
});

describe('DeskController — notifications', () => {
  it('notifies subscribers on every state change', async () => {
    const { desk } = await ready();
    let calls = 0;
    const off = desk.subscribe(() => {
      calls += 1;
    });
    desk.setCompare(true);
    off();
    desk.setCompare(false);
    expect(calls).toBe(1);
  });
});

describe('stream event folding', () => {
  it('keeps the text of every delta in order', async () => {
    const { desk } = await ready();
    desk.newConversation();
    const demo = new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 });
    const instant: StreamEvent[] = [];
    for await (const event of demo.streamTurn('순서 확인', DEMO_ROUTES[0])) instant.push(event);
    const expected = instant
      .filter((event): event is Extract<StreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    await desk.send('순서 확인');
    const conversation = desk.getSnapshot().conversations.find((entry) => entry.id === desk.getSnapshot().activeId);
    expect(conversation?.messages[1].slots?.[0].text).toBe(expected);
  });
});
