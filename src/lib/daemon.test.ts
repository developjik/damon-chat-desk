import { describe, expect, it } from 'vitest';
import {
  DaemonTransport,
  backendTitle,
  mapDaemonMessages,
  mapSessionEvent,
  mapUsage,
  normalizeBaseUrl,
} from './daemon';
import type { ServerEvent } from './rpc';
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
    expect(mapSessionEvent({ type: 'timeline', kind: 'tool_call', name: 'Bash', status: 'running' })).toEqual({
      type: 'tool',
      name: 'Bash',
      status: 'running',
    });
    expect(mapSessionEvent({ type: 'turn_failed', error: 'boom', code: 'rate_limit' })).toEqual({
      type: 'error',
      message: 'boom (rate_limit)',
    });
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

describe('mapUsage', () => {
  it('accepts both snake_case and camelCase context fields', () => {
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
