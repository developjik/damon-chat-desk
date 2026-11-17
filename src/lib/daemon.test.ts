import { describe, expect, it } from 'vitest';
import {
  DaemonTransport,
  backendTitle,
  mapDaemonMessages,
  mapSessionEvent,
  mapUsage,
  normalizeBaseUrl,
} from './daemon';
import { RpcError, type ServerEvent } from './rpc';
import { makeTarget } from './targets';
import type { StreamEvent } from './types';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const target = makeTarget({ provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet' });

describe('normalizeBaseUrl', () => {
  it('adds a scheme and strips trailing slashes', () => {
    expect(normalizeBaseUrl('localhost:9470/')).toBe('http://localhost:9470');
    expect(normalizeBaseUrl(' https://box.local ')).toBe('https://box.local');
    expect(normalizeBaseUrl('')).toBe('http://127.0.0.1:9470');
  });
});

describe('backendTitle', () => {
  it('uses the daemon catalogue titles', () => {
    expect(backendTitle('claude')).toBe('Claude Code');
    expect(backendTitle('opencode')).toBe('OpenCode');
    expect(backendTitle('custom')).toBe('Custom');
  });
});

describe('mapSessionEvent', () => {
  it('maps timeline assistant text into a delta', () => {
    expect(mapSessionEvent({ type: 'timeline', kind: 'assistant_message', text: '조각' })).toEqual({
      type: 'delta',
      text: '조각',
    });
  });

  it('drops empty or unrelated timeline items', () => {
    expect(mapSessionEvent({ type: 'timeline', kind: 'assistant_message', text: '' })).toBeNull();
    expect(mapSessionEvent({ type: 'timeline', kind: 'reasoning', text: 'thinking' })).toBeNull();
    expect(mapSessionEvent({ type: 'attention_required', reason: 'finished' })).toBeNull();
  });

  it('maps tool calls and turn failures', () => {
    const mapped = mapSessionEvent({
      type: 'timeline',
      kind: 'tool_call',
      call_id: 'call-7',
      name: 'Bash',
      status: 'running',
      detail: { type: 'shell', command: 'npm test' },
    });
    expect(mapped).toMatchObject({
      type: 'tool',
      call: { id: 'call-7', name: 'Bash', kind: 'shell', label: 'npm test', status: 'running' },
    });
    expect(mapSessionEvent({ type: 'turn_failed', error: 'boom', code: 'rate_limit' })).toEqual({
      type: 'error',
      message: 'boom (rate_limit)',
    });
  });

  it('maps a completed tool call with its output and exit code', () => {
    const mapped = mapSessionEvent({
      type: 'timeline',
      kind: 'tool_call',
      call_id: 'call-7',
      name: 'Bash',
      status: 'completed',
      detail: { type: 'shell', command: 'npm test', output: '6 passed', exit_code: 0 },
    });
    expect(mapped).toMatchObject({
      type: 'tool',
      call: { status: 'done', result: { stdout: '6 passed', exitCode: 0 } },
    });
  });

  it('reads a plan ask as a plan, not a generic permission', () => {
    const mapped = mapSessionEvent({
      type: 'permission_requested',
      id: 'req-plan',
      kind: 'plan',
      name: 'ExitPlanMode',
      title: '구현 계획',
      input: { plan: '## 계획\n\n1. 계약 고정 — src/lib/types.ts\n2. 얇은 경로' },
      actions: [{ id: 'allow', label: 'Allow', behavior: 'allow' }],
    });
    expect(mapped).toMatchObject({ type: 'plan', plan: { id: 'req-plan', status: 'awaiting_review' } });
    const plan = mapped && mapped.type === 'plan' ? mapped.plan : null;
    expect(plan?.steps[0].title).toBe('계약 고정');
    expect(plan?.files).toContain('src/lib/types.ts');
  });

  it('maps usage from a completed turn', () => {
    expect(
      mapSessionEvent({ type: 'turn_completed', usage: { input_tokens: 12, output_tokens: 40, cost_usd: 0.002 } }),
    ).toEqual({ type: 'done', usage: { inputTokens: 12, outputTokens: 40, costUsd: 0.002 } });
  });

  it('maps a permission ask with its actions', () => {
    const mapped = mapSessionEvent({
      type: 'permission_requested',
      id: 'req-1',
      kind: 'tool',
      name: 'Bash',
      title: 'npm test',
      actions: [{ id: 'allow', label: 'Allow', behavior: 'allow', variant: 'primary' }],
    });
    expect(mapped).toMatchObject({ type: 'permission', ask: { id: 'req-1', actions: [{ id: 'allow' }] } });
  });

  it('keeps a cancellation as a done with a reason', () => {
    expect(mapSessionEvent({ type: 'turn_canceled', reason: 'user' })).toEqual({ type: 'done', stopReason: 'user' });
  });
});

describe('mapUsage', () => {  it('accepts both snake_case and camelCase context fields', () => {
    expect(mapUsage({ contextUsed: 10, contextSize: 200 })).toEqual({ contextUsed: 10, contextWindow: 200 });
    expect(mapUsage({ context_used: 5, context_window: 100 })).toEqual({ contextUsed: 5, contextWindow: 100 });
    expect(mapUsage(null)).toBeUndefined();
  });
});

describe('mapDaemonMessages', () => {
  it('groups an assistant run under one turn and skips tool rows', () => {
    const messages = mapDaemonMessages(
      [
        { id: 1, role: 'user', ts: 100, data: { content: '질문' } },
        { id: 2, role: 'assistant', ts: 101, data: { content: '첫 문단' } },
        { id: 3, role: 'tool', ts: 102, data: { content: 'tool output' } },
        { id: 4, role: 'assistant', ts: 103, data: { content: '둘째 문단' } },
        { id: 5, role: 'user', ts: 104, data: { content: '다음 질문' } },
      ],
      target,
    );
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].slots?.map((slot) => slot.text)).toEqual(['첫 문단', '둘째 문단']);
    expect(messages[1].slots?.[0].target.provider).toBe('claude');
    // history rows carry no timing — the UI must not invent a 0ms reply
    expect(messages[1].slots?.[0].imported).toBe(true);
  });
});

describe('DaemonTransport.streamTurn', () => {
  it('folds session.event pushes for its own session into stream events', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const handlers: Array<(event: ServerEvent) => void> = [];
    let resolveTurn: (value: unknown) => void = () => undefined;
    const fakeRpc = {
      onEvent(handler: (event: ServerEvent) => void) {
        handlers.push(handler);
        return () => undefined;
      },
      request(method: string) {
        if (method === 'turn.start') {
          return new Promise((resolve) => {
            resolveTurn = resolve;
          });
        }
        return Promise.resolve({});
      },
    };
    (transport as unknown as { rpc: unknown }).rpc = fakeRpc;

    const events: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const event of transport.streamTurn('s1', '안녕')) events.push(event);
    })();

    await tick();
    const push = (frame: ServerEvent) => handlers.forEach((handler) => handler(frame));
    push({ event: 'session.event', sessionId: 'other', data: { type: 'turn_started' } });
    push({ event: 'session.event', sessionId: 's1', data: { type: 'turn_started' } });
    push({ event: 'session.event', sessionId: 's1', data: { type: 'timeline', kind: 'assistant_message', text: '안' } });
    push({ event: 'session.event', sessionId: 's1', data: { type: 'timeline', kind: 'assistant_message', text: '녕' } });
    push({ event: 'session.event', sessionId: 's1', data: { type: 'turn_completed', usage: { output_tokens: 2 } } });
    resolveTurn({ turnId: 't1', stopReason: 'completed' });
    await consumer;

    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', text: '안' },
      { type: 'delta', text: '녕' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events[0].type).toBe('start');
  });

  it('surfaces a failed turn as an error event', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const handlers: Array<(event: ServerEvent) => void> = [];
    let failTurn: (error: Error) => void = () => undefined;
    const fakeRpc = {
      onEvent(handler: (event: ServerEvent) => void) {
        handlers.push(handler);
        return () => undefined;
      },
      request: () =>
        new Promise((_resolve, reject) => {
          failTurn = reject;
        }),
    };
    (transport as unknown as { rpc: unknown }).rpc = fakeRpc;

    const events: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const event of transport.streamTurn('s1', '안녕')) events.push(event);
    })();
    await tick();
    handlers.forEach((handler) =>
      handler({ event: 'session.event', sessionId: 's1', data: { type: 'turn_failed', error: 'backend died' } }),
    );
    await tick();
    failTurn(new Error('socket closed'));
    await consumer;
    expect(events.some((event) => event.type === 'error' && event.message.includes('backend died'))).toBe(true);
  });
});

function fakeRpcOn(transport: DaemonTransport) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fakeRpc = {
    onEvent: () => () => undefined,
    request: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session.fork') return Promise.resolve({ sessionId: 'sess-fork' });
      if (method === 'turn.steer') return Promise.resolve({ result: 'steering the running turn' });
      if (method === 'plan.list') {
        return Promise.resolve({ plans: [{ planId: 'p1', sessionId: 's1', revision: 2, status: 'awaiting_review' }] });
      }
      if (method === 'plan.respond') {
        const decision = params.decision;
        return Promise.resolve({
          recorded: true,
          status: decision === 'approve' ? 'approved' : 'changes_requested',
          applied: true,
          planId: params.planId,
          revision: params.expectedRevision,
        });
      }
      return Promise.resolve({});
    },
  };
  (transport as unknown as { rpc: unknown }).rpc = fakeRpc;
  return calls;
}

describe('DaemonTransport — agent control calls', () => {
  it('sends turn.steer with the session id and prompt', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = fakeRpcOn(transport);
    await expect(transport.steer('s1', '방향 수정')).resolves.toBe('steering the running turn');
    expect(calls[0]).toEqual({ method: 'turn.steer', params: { sessionId: 's1', prompt: '방향 수정' } });
  });

  it('forks a session and returns the branch id', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = fakeRpcOn(transport);
    await expect(transport.forkSession('s1')).resolves.toBe('sess-fork');
    expect(calls[0]).toEqual({ method: 'session.fork', params: { sessionId: 's1' } });
  });

  it('decides a plan with its CAS revision, and sends feedback only when given', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = fakeRpcOn(transport);

    const approved = await transport.respondPlan({ planId: 'p1', expectedRevision: 2, decision: 'approve' });
    expect(approved).toMatchObject({ status: 'approved', applied: true });
    expect(calls[0]).toEqual({
      method: 'plan.respond',
      params: { planId: 'p1', expectedRevision: 2, decision: 'approve' },
    });

    await transport.respondPlan({ planId: 'p1', expectedRevision: 2, decision: 'request_changes', feedback: '3번을 먼저' });
    expect(calls[1].params).toEqual({
      planId: 'p1',
      expectedRevision: 2,
      decision: 'request_changes',
      feedback: '3번을 먼저',
    });
  });

  it('lists the durable review rows for a session', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = fakeRpcOn(transport);
    const rows = await transport.listPlans('s1');
    expect(rows[0]).toMatchObject({ planId: 'p1', revision: 2 });
    expect(calls[0]).toEqual({ method: 'plan.list', params: { sessionId: 's1' } });
  });
});

describe('mapSessionEvent — plan lifecycle', () => {
  it('accepts the plan_reviewed/plan_requested alias', () => {
    const mapped = mapSessionEvent({ type: 'plan_requested', id: 'req-2', plan: '1. 계약 고정 — 스키마' });
    expect(mapped).toMatchObject({ type: 'plan', plan: { id: 'req-2' } });
  });

  it('marks a settled request so the card stops being answerable', () => {
    expect(mapSessionEvent({ type: 'permission_resolved', request_id: 'req-2' })).toEqual({
      type: 'plan_resolved',
      requestId: 'req-2',
    });
    expect(mapSessionEvent({ type: 'permission_resolved' })).toBeNull();
  });
});


function recordingRpc(transport: DaemonTransport, responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fakeRpc = {
    onEvent: () => () => undefined,
    request: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const result = responses[method];
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? {});
    },
  };
  (transport as unknown as { rpc: unknown }).rpc = fakeRpc;
  return calls;
}

describe('DaemonTransport — memory ledger calls', () => {
  it('lists the bot ledger with its owner, pending included', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'memory.list': { entries: [{ id: 'm1', scope: 'bot', content: 'x', status: 'active' }] } });
    const entries = await transport.listMemory({ scope: 'bot', owner: 'scribe', includePending: true });
    expect(entries).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'memory.list', params: { scope: 'bot', owner: 'scribe', includePending: true } });
  });

  it('defaults to the user ledger and never sends an owner for it', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'memory.list': { entries: [] } });
    await transport.listMemory();
    expect(calls[0]).toEqual({ method: 'memory.list', params: { scope: 'user', includePending: false } });
  });

  it('writes with memory.write and reports the gate status', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'memory.write': { id: 'm9', status: 'pending' } });
    const result = await transport.writeMemory({ scope: 'bot', owner: 'scribe', content: '릴리스 노트 순서', source: 'desk' });
    expect(result).toEqual({ id: 'm9', status: 'pending' });
    expect(calls[0]).toEqual({
      method: 'memory.write',
      params: { scope: 'bot', owner: 'scribe', content: '릴리스 노트 순서', source: 'desk' },
    });
  });

  it('propagates the -32011 rejection untouched', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    recordingRpc(transport, {
      'memory.write': new RpcError({ code: -32011, message: 'rejected', data: { kind: 'secret' } }),
    });
    await expect(transport.writeMemory({ scope: 'user', content: 'sk-1234567890abcdefghij' })).rejects.toMatchObject({
      code: -32011,
      data: { kind: 'secret' },
    });
  });

  it('removes, approves and rejects by id', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, {
      'memory.remove': { removed: true },
      'memory.approve': { approved: true },
      'memory.reject': { rejected: true },
    });
    await expect(transport.removeMemory('m1')).resolves.toBe(true);
    await expect(transport.approveMemory('m2')).resolves.toBe(true);
    await expect(transport.rejectMemory('m3')).resolves.toBe(true);
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['memory.remove', { id: 'm1' }],
      ['memory.approve', { id: 'm2' }],
      ['memory.reject', { id: 'm3' }],
    ]);
  });

  it('asks usage for the ledger it is viewing', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'memory.usage': { scope: 'bot', chars: 42, limit: 8000 } });
    await expect(transport.memoryUsage('bot', 'scribe')).resolves.toEqual({ chars: 42, limit: 8000 });
    expect(calls[0]).toEqual({ method: 'memory.usage', params: { scope: 'bot', owner: 'scribe' } });
  });
});

describe('DaemonTransport — session management calls', () => {
  it('lists sessions including archived rows when asked', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'session.list': { sessions: [{ sessionId: 's1', backend: 'claude', createdAt: 1 }] } });
    const rows = await transport.listSessions(80, { includeArchived: true });
    expect(rows).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'session.list', params: { limit: 80, includeArchived: true } });
  });

  it('renames a session', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, { 'session.rename': { renamed: true } });
    await expect(transport.renameSession('s1', 'API 리뷰')).resolves.toBe(true);
    expect(calls[0]).toEqual({ method: 'session.rename', params: { sessionId: 's1', title: 'API 리뷰' } });
  });

  it('archives and deletes a session', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, {
      'session.set_archived': { updated: true },
      'session.delete': { deleted: true },
    });
    await expect(transport.setSessionArchived('s1', true)).resolves.toBe(true);
    await expect(transport.deleteSession('s1')).resolves.toBe(true);
    expect(calls).toEqual([
      { method: 'session.set_archived', params: { sessionId: 's1', archived: true } },
      { method: 'session.delete', params: { sessionId: 's1' } },
    ]);
  });

  it('reads the daemon serialization through session.export', async () => {
    const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
    const calls = recordingRpc(transport, {
      'session.export': { session: { sessionId: 's1', title: '리뷰' }, messages: [], usage: { turns: 2 } },
    });
    const exported = await transport.exportSession('s1');
    expect(exported.session?.title).toBe('리뷰');
    expect(calls[0]).toEqual({ method: 'session.export', params: { sessionId: 's1' } });
  });
});
