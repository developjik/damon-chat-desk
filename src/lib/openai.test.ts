import { describe, expect, it, vi } from 'vitest';
import { applyFrame, listModels, mapUsage, streamChat } from './openai';
import type { StreamEvent } from './types';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // deliberately split mid-frame to exercise the parser
      const middle = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, middle)));
      controller.enqueue(encoder.encode(text.slice(middle)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('listModels', () => {
  it('maps /v1/models into provider-qualified routes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 'claude-sonnet-4-5' }, { id: 'gpt-5-codex' }, { id: 'llama-3.3-70b' }, { id: 'gpt-5-codex' }],
      }),
    ) as unknown as typeof fetch;

    const routes = await listModels({ baseUrl: 'http://127.0.0.1:1234/', apiKey: 'k', fetchImpl });
    expect(routes.map((route) => `${route.provider}:${route.model}`)).toEqual([
      'anthropic:claude-sonnet-4-5',
      'meta:llama-3.3-70b',
      'openai:gpt-5-codex',
    ]);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe('http://127.0.0.1:1234/v1/models');
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('surfaces the status when the route is missing', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    await expect(listModels({ baseUrl: 'http://x', fetchImpl })).rejects.toThrow('404');
  });
});

describe('streamChat', () => {
  it('streams deltas, then finish reason and usage', async () => {
    const body = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"안녕"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"하세요"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const fetchImpl = vi.fn(async () => sseResponse(body)) as unknown as typeof fetch;
    const events = await collect(streamChat({ baseUrl: 'http://x', fetchImpl, request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } }));

    expect(events[0].type).toBe('start');
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('안녕하세요');
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', stopReason: 'stop', usage: { inputTokens: 11, outputTokens: 4 } });
  });

  it('sends stream:true and asks for usage', async () => {
    let sent: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse('data: [DONE]\n\n');
    }) as unknown as typeof fetch;
    await collect(streamChat({ baseUrl: 'http://x', fetchImpl, request: { model: 'm', messages: [] } }));
    expect(sent).toMatchObject({ model: 'm', stream: true, stream_options: { include_usage: true } });
  });

  it('accepts a non-streaming JSON answer', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        choices: [{ message: { content: '완성된 답' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })) as unknown as typeof fetch;
    const events = await collect(streamChat({ baseUrl: 'http://x', fetchImpl, request: { model: 'm', messages: [] } }));
    expect(events).toEqual([
      { type: 'start' },
      { type: 'delta', text: '완성된 답' },
      { type: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
  });

  it('reports an HTTP failure as an error event, not a throw', async () => {
    const fetchImpl = (async () => new Response('model not found', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const events = await collect(streamChat({ baseUrl: 'http://x', fetchImpl, request: { model: 'm', messages: [] } }));
    expect(events.at(-1)?.type).toBe('error');
    expect((events.at(-1) as { message: string }).message).toContain('model not found');
  });
});

describe('applyFrame / mapUsage', () => {
  it('treats [DONE] as the terminator', () => {
    expect(applyFrame({ event: 'message', data: '[DONE]' }, (text) => ({ type: 'delta', text }))).toBe('done');
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(applyFrame({ event: 'message', data: '{oops' }, (text) => ({ type: 'delta', text }))).toEqual({ kind: 'skip' });
  });

  it('maps cached prompt tokens', () => {
    expect(mapUsage({ usage: { prompt_tokens: 9, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } } })).toEqual({
      inputTokens: 9,
      outputTokens: 1,
      cachedInputTokens: 4,
    });
    expect(mapUsage({})).toBeUndefined();
  });
});
