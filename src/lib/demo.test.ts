import { describe, expect, it } from 'vitest';
import { DEMO_ROUTES, DemoTransport, chunkText, composeReply, detectIntent } from './demo';
import type { StreamEvent } from './types';

const instant = new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 });

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
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
    const prompt = '데몬 클라이언트 구현 순서를 잡아줘';
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
