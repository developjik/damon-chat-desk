/**
 * OpenAI-compatible transport: `GET /v1/models` and
 * `POST /v1/chat/completions` with SSE streaming.
 *
 * This is the wire shape the desk speaks when it is not talking to a
 * Damon daemon (LM Studio, llama.cpp, LiteLLM, any gateway). README
 * principle 2: the UI only knows this schema.
 *
 * With a `WireTap` attached the same traffic lands in the inspector: the
 * HTTP request as one TX frame and every SSE `data:` block as an RX
 * chunk, so an OpenAI-mode turn is inspectable next to a daemon turn.
 */

import { SSEParser, decodeStream, type SSEFrame } from './sse';
import { targetsFromModels, type OpenAIModel } from './targets';
import { fetcher } from './http';
import type { WireTap } from './inspector';
import type { RouteTarget, StreamEvent } from './types';

export interface OpenAIOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Where the frames of this call are recorded (the inspector). */
  tap?: WireTap;
}

/** One SSE frame as the inspector shows it: the event name and its JSON. */
function recordChunk(tap: WireTap | undefined, frame: SSEFrame): void {
  if (!tap) return;
  let data: unknown = frame.data;
  if (frame.data !== '[DONE]') {
    try {
      data = JSON.parse(frame.data) as unknown;
    } catch {
      data = frame.data;
    }
  }
  const chunk = data as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>; usage?: unknown } | null;
  const delta = chunk?.choices?.[0]?.delta?.content ?? '';
  tap.record({
    dir: 'rx',
    kind: 'chunk',
    method: frame.event === 'message' ? 'chat.completion.chunk' : frame.event,
    protocol: 'sse',
    status: 'ok',
    payload: {
      event: frame.event,
      data,
      ...(typeof delta === 'string' && delta ? { delta } : {}),
    },
  });
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** `/v1/models` → routes. Throws with the server's message on failure. */
export async function listModels(opts: OpenAIOptions): Promise<RouteTarget[]> {
  const doFetch = fetcher(opts.fetchImpl);
  const url = joinUrl(opts.baseUrl, '/v1/models');
  const sentAt = Date.now();
  const response = await doFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...authHeaders(opts.apiKey) },
    signal: opts.signal,
  });
  opts.tap?.record({
    dir: 'tx',
    kind: 'request',
    method: 'https GET /v1/models',
    protocol: 'http',
    at: sentAt,
    payload: { method: 'GET', url },
  });
  opts.tap?.record({
    dir: 'rx',
    kind: response.ok ? 'result' : 'error',
    method: 'https GET /v1/models',
    protocol: 'http',
    latencyMs: Date.now() - sentAt,
    status: response.ok ? 'ok' : 'error',
    payload: { status: response.status },
  });
  if (!response.ok) {
    throw new Error(`/v1/models → ${response.status} ${response.statusText}`.trim());
  }
  const body = (await response.json()) as { data?: OpenAIModel[] };
  return targetsFromModels(Array.isArray(body.data) ? body.data : []);
}

export interface ChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Ask the server to append `usage` in the final chunk where supported. */
  streamOptions?: boolean;
}

export interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; role?: string };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * POST /v1/chat/completions and translate it into desk stream events.
 * A non-streaming JSON answer is accepted too — some compatible servers
 * ignore `stream: true`.
 */
export async function* streamChat(
  opts: OpenAIOptions & { request: ChatRequest },
): AsyncGenerator<StreamEvent> {
  const doFetch = fetcher(opts.fetchImpl);
  const body: Record<string, unknown> = {
    model: opts.request.model,
    messages: opts.request.messages,
    stream: true,
  };
  if (opts.request.streamOptions !== false) body.stream_options = { include_usage: true };

  const url = joinUrl(opts.baseUrl, '/v1/chat/completions');
  const sentAt = Date.now();
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...authHeaders(opts.apiKey),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  opts.tap?.record({
    dir: 'tx',
    kind: 'request',
    method: 'https POST /v1/chat/completions',
    protocol: 'http',
    at: sentAt,
    payload: {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
    },
  });
  if (!response.ok) {
    opts.tap?.record({
      dir: 'rx',
      kind: 'error',
      method: 'https POST /v1/chat/completions',
      protocol: 'http',
      latencyMs: Date.now() - sentAt,
      status: 'error',
      payload: { status: response.status, statusText: response.statusText },
    });
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 400).trim();
    } catch {
      /* body already gone */
    }
    yield {
      type: 'error',
      message: `/v1/chat/completions → ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
    };
    return;
  }

  yield { type: 'start' };

  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || contentType.includes('application/json')) {
    // Non-streaming answer (or a server that always answers JSON).
    const json = (await response.json()) as ChatCompletionChunk;
    opts.tap?.record({
      dir: 'rx',
      kind: 'result',
      method: 'chat.completion',
      protocol: 'http',
      latencyMs: Date.now() - sentAt,
      status: 'ok',
      payload: json,
    });
    const text = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.delta?.content ?? '';
    if (text) yield { type: 'delta', text };
    yield { type: 'done', usage: mapUsage(json) };
    return;
  }

  const parser = new SSEParser();
  let finishReason: string | undefined;
  let usage: ReturnType<typeof mapUsage>;

  for await (const chunk of decodeStream(response.body)) {
    for (const frame of parser.push(chunk)) {
      recordChunk(opts.tap, frame);
      const result = applyFrame(frame, (delta) => ({ type: 'delta', text: delta }));
      if (result === 'done') {
        yield { type: 'done', stopReason: finishReason, usage };
        return;
      }
      if (result.kind === 'delta') yield result.event;
      else if (result.kind === 'meta') {
        if (result.finishReason) finishReason = result.finishReason;
        if (result.usage) usage = result.usage;
      }
    }
  }
  for (const frame of parser.flush()) {
    recordChunk(opts.tap, frame);
    const result = applyFrame(frame, (delta) => ({ type: 'delta', text: delta }));
    if (result === 'done') break;
    if (result.kind === 'delta') yield result.event;
    else if (result.kind === 'meta') {
      if (result.finishReason) finishReason = result.finishReason;
      if (result.usage) usage = result.usage;
    }
  }
  yield { type: 'done', stopReason: finishReason, usage };
}

type FrameResult =
  | 'done'
  | { kind: 'delta'; event: StreamEvent }
  | { kind: 'meta'; finishReason?: string; usage?: ReturnType<typeof mapUsage> }
  | { kind: 'skip' };

/** Parse one SSE frame; exported for tests. */
export function applyFrame(frame: SSEFrame, deltaEvent: (text: string) => StreamEvent): FrameResult {
  if (frame.data.trim() === '[DONE]') return 'done';
  let chunk: ChatCompletionChunk;
  try {
    chunk = JSON.parse(frame.data) as ChatCompletionChunk;
  } catch {
    return { kind: 'skip' };
  }
  const choice = chunk.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
  if (delta) return { kind: 'delta', event: deltaEvent(delta) };
  if (choice?.finish_reason || chunk.usage) {
    return { kind: 'meta', finishReason: choice?.finish_reason ?? undefined, usage: mapUsage(chunk) };
  }
  return { kind: 'skip' };
}

export function mapUsage(chunk: ChatCompletionChunk): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
} | undefined {
  if (!chunk.usage) return undefined;
  const usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  if (typeof chunk.usage.prompt_tokens === 'number') usage.inputTokens = chunk.usage.prompt_tokens;
  if (typeof chunk.usage.completion_tokens === 'number') usage.outputTokens = chunk.usage.completion_tokens;
  const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') usage.cachedInputTokens = cached;
  return Object.keys(usage).length ? usage : undefined;
}
