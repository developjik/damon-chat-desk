import { describe, expect, it } from 'vitest';
import { DeskController, memoryBlock, titleOf } from './desk';
import { DEMO_ROUTES, DemoTransport } from './demo';
import { filterMemory } from './memory';
import { filterConversations } from './sessions';
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

  it('folds tool snapshots into one row per call', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('SSE 파서 버그 잡아줘');
    const conversation = activeConversation(desk);
    const tools = conversation.messages[1].slots?.[0].tools ?? [];
    expect(tools).toHaveLength(4);
    expect(new Set(tools.map((call) => call.id)).size).toBe(4);
    expect(tools[0].status).toBe('error');
    expect(tools[3].result?.exitCode).toBe(0);
  });
});

function activeConversation(desk: DeskController) {
  const state = desk.getSnapshot();
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  if (!conversation) throw new Error('no active conversation');
  return conversation;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DeskController — turn.steer', () => {
  it('sends a direction correction into the running turn', async () => {
    const demo = new DemoTransport({ sleep: () => new Promise((resolve) => setTimeout(resolve, 2)) });
    const desk = new DeskController({ storage: new MemoryStorage(), demo });
    await desk.init();
    desk.newConversation();
    const sending = desk.send('스트리밍과 배치 중 뭐가 나아?');
    await waitFor(() => activeConversation(desk).messages[1]?.slots?.[0]?.status === 'streaming');
    await desk.steer('비용 쪽을 더 봐줘');
    await sending;

    const slot = activeConversation(desk).messages[1].slots?.[0];
    expect(slot?.steers?.[0]).toMatchObject({ text: '비용 쪽을 더 봐줘', state: 'sent' });
    // the demo acknowledged it inside the answer
    expect(slot?.text).toContain('비용 쪽을 더 봐줘');
    // a steer never opens a new user turn
    expect(activeConversation(desk).messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('refuses to steer when no reply is streaming', async () => {
    const { desk } = await ready();
    await desk.steer('방향 수정');
    expect(desk.getSnapshot().notice).toContain('스트리밍');
    expect(activeConversation(desk).messages.flatMap((message) => message.slots ?? []).every((slot) => !slot.steers)).toBe(true);
  });
});

describe('DeskController — plan.respond', () => {
  it('records an approved plan on the slot', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('구현 순서를 잡아줘');
    const conversation = activeConversation(desk);
    const message = conversation.messages[1];
    const slot = message.slots![0];
    expect(slot.plan?.status).toBe('awaiting_review');

    await desk.respondPlan({ convId: conversation.id, messageId: message.id, slotId: slot.id }, 'approve');
    const updated = activeConversation(desk).messages[1].slots![0];
    expect(updated.plan?.status).toBe('approved');
    expect(updated.plan?.decidedAt).toBeGreaterThan(0);
    expect(desk.getSnapshot().notice).toContain('승인');
  });

  it('needs a reason before requesting changes', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('구현 순서를 잡아줘');
    const conversation = activeConversation(desk);
    const message = conversation.messages[1];
    const slot = message.slots![0];
    await desk.respondPlan({ convId: conversation.id, messageId: message.id, slotId: slot.id }, 'request_changes');
    const updated = activeConversation(desk).messages[1].slots![0];
    expect(updated.plan?.status).toBe('awaiting_review');
    expect(updated.plan?.error).toContain('수정 요청');
  });
});

describe('DeskController — session.fork', () => {
  it('opens the branch as a new conversation and leaves the original intact', async () => {
    const { desk } = await ready();
    desk.newConversation();
    await desk.send('SSE 프레임 경계 처리');
    const source = activeConversation(desk);
    const assistant = source.messages[1];

    await desk.forkAt(source.id, assistant.id);
    const branch = activeConversation(desk);
    expect(branch.id).not.toBe(source.id);
    expect(branch.title).toBe(`${source.title} (fork)`);
    expect(branch.forkedFrom).toBe(source.id);
    expect(branch.messages).toHaveLength(2);
    expect(branch.daemonSessions.claude).toMatch(/^demo-fork-/);

    const original = desk.getSnapshot().conversations.find((entry) => entry.id === source.id);
    expect(original?.messages).toHaveLength(2);
    expect(desk.getSnapshot().notice).toContain('분기');
  });
});

describe('DeskController — memory ledger', () => {
  it('writes an entry into the user ledger and re-reads it', async () => {
    const { desk } = await ready();
    const before = desk.getSnapshot().memory.entries.length;
    await expect(desk.addMemory('선호 에디터: Cursor')).resolves.toBe(true);
    const entries = desk.getSnapshot().memory.entries;
    expect(entries.length).toBe(before + 1);
    expect(entries.some((entry) => entry.content === '선호 에디터: Cursor')).toBe(true);
    expect(desk.getSnapshot().memory.chars).toBeGreaterThan(0);
    expect(desk.getSnapshot().notice).toContain('memory.write');
  });

  it('keeps a refused write out of the ledger and says why', async () => {
    const { desk } = await ready();
    const before = desk.getSnapshot().memory.entries;
    await expect(desk.addMemory('token: sk-abcdefghijklmnopqrstuvwxyz')).resolves.toBe(false);
    expect(desk.getSnapshot().memory.entries).toHaveLength(before.length);
    expect(desk.getSnapshot().memory.error).toContain('비밀키');
  });

  it('edits by writing the new text and removing the old id', async () => {
    const { desk } = await ready();
    const entry = desk.getSnapshot().memory.entries.find((row) => row.status === 'active');
    expect(entry).toBeTruthy();
    await expect(desk.updateMemory(entry!, '수정된 한 줄')).resolves.toBe(true);
    const entries = desk.getSnapshot().memory.entries;
    expect(entries.some((row) => row.id === entry!.id)).toBe(false);
    expect(entries.some((row) => row.content === '수정된 한 줄')).toBe(true);
    expect(desk.getSnapshot().notice).toContain('메모리를 수정했습니다');
  });

  it('removes an entry', async () => {
    const { desk } = await ready();
    const entry = desk.getSnapshot().memory.entries[0];
    await expect(desk.removeMemory(entry)).resolves.toBe(true);
    expect(desk.getSnapshot().memory.entries.some((row) => row.id === entry.id)).toBe(false);
    expect(desk.getSnapshot().notice).toContain('memory.remove');
  });

  it('approves a pending write and rejects another', async () => {
    const { desk } = await ready();
    const pending = desk.getSnapshot().memory.entries.find((row) => row.status === 'pending');
    expect(pending).toBeTruthy();
    await expect(desk.approveMemory(pending!)).resolves.toBe(true);
    expect(desk.getSnapshot().memory.entries.find((row) => row.id === pending!.id)?.status).toBe('active');

    // a bot-scope write is an agent-shaped write — the gate holds it pending
    await desk.setMemoryScope('bot', 'scribe');
    expect(await desk.addMemory('에이전트가 남긴 메모')).toBe(true);
    const next = desk.getSnapshot().memory.view.entries.find((row) => row.status === 'pending');
    expect(next).toBeTruthy();
    await expect(desk.rejectMemory(next!)).resolves.toBe(true);
    expect(desk.getSnapshot().memory.view.entries.some((row) => row.id === next!.id)).toBe(false);
  });

  it('switches to a bot ledger without changing the injection source', async () => {
    const { desk } = await ready();
    await desk.setMemoryScope('bot', 'scribe');
    const state = desk.getSnapshot();
    expect(state.memory.view.scope).toBe('bot');
    expect(state.memory.view.owner).toBe('scribe');
    expect(state.memory.view.entries.length).toBeGreaterThan(0);
    expect(state.memory.view.entries.every((row) => row.scope === 'bot' && row.owner === 'scribe')).toBe(true);
    expect(state.memory.entries.every((row) => row.scope === 'user')).toBe(true);

    await desk.setMemoryScope('user');
    expect(desk.getSnapshot().memory.view.scope).toBe('user');
  });

  it('filters the panel without dropping entries from the ledger', async () => {
    const { desk } = await ready();
    const all = desk.getSnapshot().memory.entries.length;
    desk.setMemoryQuery('JSON-RPC');
    desk.setMemoryFilter('active');
    const state = desk.getSnapshot();
    expect(state.memory.query).toBe('JSON-RPC');
    expect(state.memory.filter).toBe('active');
    expect(state.memory.entries).toHaveLength(all);
    const visible = filterMemory(state.memory.view.entries, { text: state.memory.query, filter: state.memory.filter });
    expect(visible.map((row) => row.content).join(' ')).toContain('JSON-RPC');
  });

  it('reports the ledger as unsupported on a transport without one', async () => {
    const fakeFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama-3.1-8b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const desk = new DeskController({
      storage: new MemoryStorage(),
      demo: new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 }),
      fetchImpl: fakeFetch,
    });
    await desk.init();
    await desk.connect('openai', 'http://fake.local');
    expect(desk.getSnapshot().connection.transport).toBe('openai');
    expect(desk.getSnapshot().memory.supported).toBe(false);
    await expect(desk.addMemory('원장 없는 모드')).resolves.toBe(false);
    expect(desk.getSnapshot().notice).toContain('원장');
  });
});

describe('DeskController — session management', () => {
  it('renames a conversation and the simulated session row', async () => {
    const { desk, demo } = await ready();
    const id = desk.getSnapshot().activeId!;
    await expect(desk.renameConversation(id, '  새   이름 ')).resolves.toBe(true);
    expect(desk.getSnapshot().conversations.find((row) => row.id === id)?.title).toBe('새 이름');
    expect(demo.sessionsList(true).find((row) => row.sessionId === id)?.title).toBe('새 이름');
  });

  it('archives a conversation out of the list and restores it', async () => {
    const { desk } = await ready();
    const id = desk.getSnapshot().activeId!;
    await desk.archiveConversation(id, true);
    expect(desk.getSnapshot().activeId).toBeNull();
    expect(desk.getSnapshot().conversations.find((row) => row.id === id)?.archived).toBe(true);
    expect(filterConversations(desk.getSnapshot().conversations).some((row) => row.id === id)).toBe(false);
    expect(filterConversations(desk.getSnapshot().conversations, { archived: true }).some((row) => row.id === id)).toBe(true);

    await desk.archiveConversation(id, false);
    expect(filterConversations(desk.getSnapshot().conversations).some((row) => row.id === id)).toBe(true);
    expect(desk.getSnapshot().notice).toContain('보관을 풀었습니다');
  });

  it('deletes a conversation and its simulated session', async () => {
    const { desk, demo } = await ready();
    const id = desk.getSnapshot().activeId!;
    await expect(desk.deleteConversation(id)).resolves.toBe(true);
    expect(desk.getSnapshot().conversations.some((row) => row.id === id)).toBe(false);
    expect(demo.sessionsList(true).some((row) => row.sessionId === id)).toBe(false);
  });

  it('searches the session list by title and by reply text', async () => {
    const { desk } = await ready();
    desk.setSessionQuery('SSE');
    expect(filterConversations(desk.getSnapshot().conversations, { text: desk.getSnapshot().sessions.query }).map((row) => row.id)).toEqual([
      'demo-conv-1',
    ]);
    desk.setSessionQuery('FrameSplitter');
    expect(filterConversations(desk.getSnapshot().conversations, { text: desk.getSnapshot().sessions.query }).map((row) => row.id)).toEqual([
      'demo-conv-1',
    ]);
    desk.setSessionQuery('없는 검색어');
    expect(filterConversations(desk.getSnapshot().conversations, { text: desk.getSnapshot().sessions.query })).toHaveLength(0);
  });

  it('shows archived sessions only when the archive view is on', async () => {
    const { desk } = await ready();
    expect(desk.getSnapshot().sessions.showArchived).toBe(false);
    desk.setShowArchived(true);
    expect(desk.getSnapshot().sessions.showArchived).toBe(true);
  });
});

describe('DeskController — export', () => {
  it('exports the active conversation as markdown, then json', async () => {
    const { desk } = await ready();
    const id = desk.getSnapshot().activeId!;
    const markdown = desk.exportConversation(id, 'markdown');
    expect(markdown?.filename.endsWith('.md')).toBe(true);
    expect(markdown?.content).toContain('# SSE 프레임 경계 처리');
    expect(markdown?.content).toContain('## totals');
    expect(markdown?.content).toContain('## memory ledger (active at export time)');
    expect(desk.getSnapshot().notice).toContain('Markdown');

    const json = desk.exportConversation(id, 'json');
    const parsed = JSON.parse(json!.content) as { conversation: { id: string; messages: unknown[] }; totals: { messages: number } };
    expect(parsed.conversation.id).toBe(id);
    expect(parsed.totals.messages).toBe(2);
    expect(desk.getSnapshot().notice).toContain('JSON');
  });

  it('refuses to export something that does not exist', async () => {
    const { desk } = await ready();
    expect(desk.exportConversation('missing', 'json')).toBeNull();
    expect(desk.getSnapshot().notice).toContain('없습니다');
  });

  it('refuses to export an empty conversation', async () => {
    const { desk } = await ready();
    await desk.openDaemonSession({ sessionId: 'sess-empty', backend: 'claude', createdAt: 1 });
    const empty = desk.getSnapshot().conversations.find((row) => row.daemonSessions.claude === 'sess-empty');
    expect(empty).toBeTruthy();
    expect(desk.exportConversation(empty!.id, 'markdown')).toBeNull();
    expect(desk.getSnapshot().notice).toContain('메시지가 없어');
  });
});

/* ------------------------------------------------------------------ */
/* stop — turn.cancel from the button, the palette and Esc             */
/* ------------------------------------------------------------------ */

function lastSlots(desk: DeskController) {
  const state = desk.getSnapshot();
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  const message = [...(conversation?.messages ?? [])].reverse().find((entry) => entry.slots && entry.slots.length > 0);
  return message?.slots ?? [];
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function slowDesk(ms = 3) {
  const demo = new DemoTransport({ sleep: () => new Promise<void>((resolve) => setTimeout(resolve, ms)) });
  return new DeskController({ demo });
}

describe('DeskController — stop', () => {
  it('keeps the partial text and marks the slot canceled, not error', async () => {
    const desk = slowDesk();
    await desk.init();
    const sending = desk.send('SSE 응답에서 청크가 프레임 중간에서 끊기면 어떻게 처리해야 해?');
    await waitUntil(() => (lastSlots(desk)[0]?.text.length ?? 0) > 0, 'the first token');

    const partial = lastSlots(desk)[0].text;
    expect(desk.getSnapshot().busy).toBe(true);
    expect(desk.stop()).toBe(1);
    await sending;

    const slot = lastSlots(desk)[0];
    expect(slot.status).toBe('canceled');
    expect(slot.text).toBe(partial);
    expect(slot.error).toBeUndefined();
    expect(slot.endedAt).toBeTypeOf('number');
    expect(desk.getSnapshot().busy).toBe(false);
    expect(desk.getSnapshot().notice).toContain('중단');
  });

  it('stops before the first token without leaving a skeleton state', async () => {
    const desk = slowDesk();
    await desk.init();
    const sending = desk.send('구현 순서를 잡아줘');
    expect(desk.stop()).toBe(1);
    await sending;
    const slot = lastSlots(desk)[0];
    expect(slot.status).toBe('canceled');
    expect(slot.text).toBe('');
  });

  it('stops one side of a split turn and lets the other finish', async () => {
    const desk = slowDesk(2);
    await desk.init();
    desk.setCompare(true);
    const sending = desk.send('스트리밍 응답과 배치 응답, 채팅 UI엔 어느 쪽이 맞아? 비교해 줘.');
    await waitUntil(() => lastSlots(desk).length === 2 && lastSlots(desk).every((slot) => slot.text.length > 0), 'both streams');

    const [first, second] = lastSlots(desk);
    expect(desk.stop(first.id)).toBe(1);
    await sending;

    const after = lastSlots(desk);
    expect(after.find((slot) => slot.id === first.id)?.status).toBe('canceled');
    expect(after.find((slot) => slot.id === second.id)?.status).toBe('done');
    expect(desk.getSnapshot().busy).toBe(false);
  });

  it('is a no-op when nothing is streaming', async () => {
    const { desk } = await ready();
    expect(desk.stop()).toBe(0);
    expect(desk.stop('missing-slot')).toBe(0);
    expect(desk.getSnapshot().notice).toBeUndefined();
  });

  it('drops tokens that arrive after the stop instead of growing the answer', async () => {
    const demo = new DemoTransport({ sleep: async () => undefined });
    let parked = false;
    let resume: () => void = () => undefined;
    demo.streamTurn = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'start' };
      yield { type: 'delta', text: '부분' };
      await new Promise<void>((resolve) => {
        parked = true;
        resume = resolve;
      });
      yield { type: 'delta', text: ' 늦은 토큰' };
      yield { type: 'done', stopReason: 'completed' };
    };
    const desk = new DeskController({ demo });
    await desk.init();
    const sending = desk.send('중간에 멈추는 응답');
    await waitUntil(() => parked, 'the parked stream');
    expect(desk.stop()).toBe(1);
    resume();
    await sending;

    const slot = lastSlots(desk)[0];
    expect(slot.status).toBe('canceled');
    expect(slot.text).toBe('부분');
    expect(slot.endedAt).toBeTypeOf('number');
  });

  it('retries a canceled slot and streams again', async () => {
    const desk = slowDesk(1);
    await desk.init();
    const sending = desk.send('SSE 응답에서 청크가 프레임 중간에서 끊기면 어떻게 처리해야 해?');
    await waitUntil(() => (lastSlots(desk)[0]?.text.length ?? 0) > 0, 'the first token');
    desk.stop();
    await sending;

    const state = desk.getSnapshot();
    const conversation = state.conversations.find((entry) => entry.id === state.activeId)!;
    const message = [...conversation.messages].reverse().find((entry) => entry.slots && entry.slots.length > 0)!;
    const slotId = message.slots![0].id;
    const retry = desk.retrySlot(conversation.id, message.id, slotId);
    await waitUntil(() => (lastSlots(desk)[0]?.text.length ?? 0) > 0, 'the retried tokens');
    await retry;

    const slot = lastSlots(desk)[0];
    expect(slot.status).toBe('done');
    expect(slot.text.length).toBeGreaterThan(0);
    expect(slot.error).toBeUndefined();
  });

  it('honours a transport that ends the turn as canceled on its own', async () => {
    const demo = new DemoTransport({ sleep: async () => undefined });
    demo.streamTurn = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'start' };
      yield { type: 'delta', text: '부분 응답' };
      yield { type: 'done', stopReason: 'canceled' };
    };
    const desk = new DeskController({ demo });
    await desk.init();
    await desk.send('중간에 멈추는 응답');
    const slot = lastSlots(desk)[0];
    expect(slot.status).toBe('canceled');
    expect(slot.text).toBe('부분 응답');
  });
});
