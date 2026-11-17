/**
 * Demo mode — a simulated daemon with no network at all.
 *
 * Purpose: a visitor of the GitHub Pages build (recruiter, reviewer)
 * must be able to see provider routing and the side-by-side compare
 * mode without installing a daemon. Every frame this transport emits
 * goes through the same event shape as the real one, so the UI has no
 * demo branch: the badge says "simulated" and nothing else changes.
 */

import type { MemoryEntry, ReplySlot, RouteTarget, StreamEvent } from './types';
import { makeTarget } from './targets';

interface DemoProfile {
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  style: 'prose' | 'structured' | 'terse';
  /** ms before the first token */
  firstToken: [number, number];
  /** ms between chunks */
  pace: [number, number];
  /** USD per 1k tokens */
  price: { input: number; output: number };
}

const PROFILES: DemoProfile[] = [
  {
    provider: 'claude',
    providerLabel: 'Claude Code',
    model: 'claude-sonnet-4-5',
    modelLabel: 'Sonnet 4.5',
    style: 'prose',
    firstToken: [520, 780],
    pace: [14, 28],
    price: { input: 0.003, output: 0.015 },
  },
  {
    provider: 'codex',
    providerLabel: 'Codex CLI',
    model: 'gpt-5-codex',
    modelLabel: 'GPT-5 Codex',
    style: 'structured',
    firstToken: [380, 620],
    pace: [10, 22],
    price: { input: 0.00125, output: 0.01 },
  },
  {
    provider: 'qwen',
    providerLabel: 'Qwen Code',
    model: 'qwen3-coder-plus',
    modelLabel: 'Qwen3 Coder Plus',
    style: 'terse',
    firstToken: [300, 520],
    pace: [9, 18],
    price: { input: 0.0004, output: 0.0016 },
  },
  {
    provider: 'opencode',
    providerLabel: 'OpenCode',
    model: 'grok-code-fast-1',
    modelLabel: 'Grok Code Fast',
    style: 'terse',
    firstToken: [280, 480],
    pace: [8, 16],
    price: { input: 0.0002, output: 0.0015 },
  },
];

export const DEMO_ROUTES: RouteTarget[] = PROFILES.map((profile) =>
  makeTarget({
    provider: profile.provider,
    providerLabel: profile.providerLabel,
    model: profile.model,
    modelLabel: profile.modelLabel,
    source: 'backend',
  }),
);

function profileFor(target: RouteTarget): DemoProfile {
  return PROFILES.find((p) => p.provider === target.provider && p.model === target.model) ?? PROFILES[0];
}

/* ------------------------------------------------------------------ */
/* reply composition                                                   */
/* ------------------------------------------------------------------ */

type Intent = 'code' | 'compare' | 'plan' | 'explain';

export function detectIntent(prompt: string): Intent {
  const p = prompt.toLowerCase();
  if (/비교|compare|vs\.?|차이|어느 쪽|어떤 게 나/.test(p)) return 'compare';
  // Design/sequence words win over implementation words: "구현 순서를
  // 설계해" is a plan question even though it mentions 구현.
  if (/계획|plan|로드맵|roadmap|설계|design|구조|architecture|순서|단계/.test(p)) return 'plan';
  if (/코드|code|버그|bug|에러|error|구현|implement|리팩|refactor|sse|react|typescript|파서|parser/.test(p)) return 'code';
  return 'explain';
}

function topicOf(prompt: string): string {
  const first = prompt.replace(/\s+/g, ' ').trim();
  return first.length > 72 ? `${first.slice(0, 72)}…` : first;
}

const CODE_BLOCK = `\`\`\`ts
export class FrameSplitter {
  private buffer = '';
  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    for (let at = this.buffer.indexOf('\\n\\n'); at !== -1; at = this.buffer.indexOf('\\n\\n')) {
      frames.push(this.buffer.slice(0, at));
      this.buffer = this.buffer.slice(at + 2);
    }
    return frames;
  }
}
\`\`\``;

const TEST_BLOCK = `\`\`\`ts
it('keeps a half frame until the next chunk', () => {
  const splitter = new FrameSplitter();
  expect(splitter.push('data: {"a"')).toEqual([]);
  expect(splitter.push(':1}\\n\\n')).toEqual(['data: {"a":1}']);
});
\`\`\``;

function codeReply(intent: Intent, prompt: string, style: DemoProfile['style']): string {
  const topic = topicOf(prompt);
  if (intent === 'code') {
    if (style === 'prose') {
      return `스트림 파서를 UI에서 떼어내는 게 먼저입니다. 버퍼는 파서가 들고, 컴포넌트는 완성된 프레임만 받으면 청크 경계 문제가 화면까지 올라오지 않습니다. “${topic}”도 결국 같은 지점입니다.

${CODE_BLOCK}

놓치기 쉬운 경계가 셋 있습니다.
- 구분자는 \`\\n\\n\`만이 아니라 \`\\r\\n\\r\\n\`도 옵니다. 프록시를 거치면 특히 그렇습니다.
- \`data: [DONE]\`은 JSON.parse 전에 걸러야 예외가 안 납니다.
- 마지막 프레임은 빈 줄 없이 끝날 수 있으니 flush 경로가 필요합니다.

트레이드오프: \`eventsource-parser\`를 쓰면 코드는 40줄 줄지만, 스트림이 끊겼을 때 부분 프레임을 살리는 정책은 여전히 직접 정해야 합니다.`;
    }
    if (style === 'structured') {
      return `계획부터 고정하고 시작하는 게 빠릅니다.

1. 프레임 분리를 순수 함수로 분리한다 — UI는 완성된 문자열만 받는다.
2. 취소는 \`AbortController\`로 fetch까지 그대로 전파한다.
3. 경계 케이스(\`\\r\\n\`, 반쪽 프레임, \`[DONE]\`)만 단위 테스트로 잠근다.

${CODE_BLOCK}

검증은 세 케이스로 충분합니다.

${TEST_BLOCK}

“${topic}” 기준으로 보면 1번이 먼저입니다. 파서가 UI 안에 있으면 테스트가 DOM에 묶여서 회귀가 늦게 잡힙니다.`;
    }
    return `핵심은 프레임 분리를 파서로 빼는 것.

- 버퍼는 파서 소유, UI는 완성 프레임만 소비
- \`\\n\\n\` + \`\\r\\n\\r\\n\` 둘 다 처리
- \`[DONE]\`은 parse 전에 차단, 마지막엔 flush

${CODE_BLOCK}

“${topic}”에서도 같은 순서로 가면 됩니다.`;
  }

  if (intent === 'compare') {
    if (style === 'prose') {
      return `정답은 “무엇을 비교 대상으로 두느냐”에 달려 있습니다. “${topic}”를 두 축으로 나눠 보면 이렇습니다.

**지연 vs 처리량** — 스트리밍은 첫 토큰까지의 시간이 짧고, 배치 응답은 총 처리량이 높습니다. 채팅 UI라면 지연이, 배치 파이프라인이라면 처리량이 기준입니다.

**운영 비용** — 스트리밍은 연결을 오래 잡고 있어 프록시 타임아웃과 하트비트가 필요합니다. 배치는 그 부담이 없지만 사용자는 빈 화면을 봅니다.

**복구** — 스트리밍은 끊긴 지점부터 이어붙이기 쉽고, 배치는 실패 시 전부 다시 요청합니다.

제 판단은 스트리밍 쪽입니다. 이 화면처럼 “응답이 지금 생성되고 있다”는 사실 자체가 제품 경험이라면 배치로는 대체가 안 됩니다.`;
    }
    if (style === 'structured') {
      return `세 줄로 정리합니다.

- **첫 토큰 지연**: 스트리밍 우위. 판단에 필요한 시간이 아니라 기다리는 시간을 줄입니다.
- **총 비용**: 배치가 유리합니다. 연결 유지 비용과 재시도 비용이 다릅니다.
- **복구**: 스트리밍은 마지막 프레임부터, 배치는 전체 재요청.

“${topic}”에선 세 번째가 결정적입니다. 데몬이 죽어도 대화가 남아야 한다면 스트리밍 + 데몬 저장 조합이어야 합니다.`;
    }
    return `짧게: 지연은 스트리밍, 비용은 배치, 복구는 스트리밍 쪽이 낫습니다.

- 첫 토큰: 스트리밍
- 총 비용: 배치
- 재시도: 스트리밍

“${topic}”는 첫 토큰이 중요한 쪽입니다.`;
  }

  if (intent === 'plan') {
    if (style === 'prose') {
      return `먼저 경계를 정하는 게 좋습니다. “${topic}”에서 UI가 책임질 것과 데몬이 책임질 것을 나누면 이후 결정이 저절로 좁혀집니다.

**1단계 — 계약 고정.** 응답 스키마와 에러 코드를 먼저 못 박습니다. UI는 이 스키마만 알면 되고, 데몬 내부 구현은 자유로워집니다.

**2단계 — 가장 얇은 경로 하나.** 프롬프트 → 스트림 → 렌더. 세션 저장이나 비교 모드는 이 경로가 안정된 뒤에 붙입니다.

**3단계 — 상태의 위치.** 대화·메모리를 브라우저에 두면 두 번째 서피스에서 이어갈 수 없습니다. 이 시점에 저장소를 데몬으로 옮기는 결정을 미루지 않는 게 좋습니다.

4단계에서 비교 모드를 붙이면 라우팅 계층이 이미 있으니 추가 비용이 거의 없습니다.`;
    }
    if (style === 'structured') {
      return `단계 순서를 이렇게 잡겠습니다.

1. **계약**: 요청/응답 스키마 + 에러 코드 고정
2. **얇은 경로**: 프롬프트 → 스트림 → 렌더 하나만
3. **상태 이전**: 세션·메모리를 데몬으로
4. **부가 기능**: 비교 모드, 프로바이더 스위처

“${topic}”에서 3번을 미루면 4번이 두 배가 됩니다. 상태가 브라우저에 있는 동안 비교 모드는 서로 다른 진실을 그리게 됩니다.`;
    }
    return `순서:

1. 스키마 고정
2. 프롬프트→스트림→렌더 한 줄기
3. 세션·메모리 데몬 이전
4. 비교 모드

“${topic}”는 3번이 핵심입니다.`;
  }

  if (style === 'prose') {
    return `“${topic}”에 대해 제가 보는 지점은 하나입니다. 표면(UI)이 얇아야 코어가 여러 서피스를 감당합니다.

구체적으로는 세 가지가 따라옵니다.
- 상태를 브라우저에 두지 않으면 새로고침·기기 전환에서 대화가 끊기지 않습니다.
- 라우팅을 메시지 단위로 열어두면 같은 대화 안에서도 비용과 품질을 바꿀 수 있습니다.
- 스트리밍 계약이 고정되면 프로바이더를 바꿔도 UI 코드는 그대로입니다.

반대로 UI가 상태를 들고 있으면 이 셋이 모두 막힙니다. 지금 단계에서 가장 값싼 결정은 “UI는 렌더만 한다”를 지키는 것입니다.`;
  }
  if (style === 'structured') {
    return `세 가지로 요약합니다.

- **상태는 코어에.** UI는 렌더만 하면 새로고침·기기 전환에서 대화가 남습니다.
- **라우팅은 메시지 단위.** 같은 대화에서 싼 모델과 깊은 모델을 섞어 씁니다.
- **계약은 하나.** 스키마가 고정되면 프로바이더 교체가 UI 변경 없이 됩니다.

“${topic}”에서도 이 셋이 기준입니다.`;
  }
  return `요점만:

- 상태는 코어, UI는 렌더
- 라우팅은 메시지 단위
- 계약은 하나

“${topic}”도 같은 기준으로 판단하면 됩니다.`;
}

export function composeReply(prompt: string, target: RouteTarget): string {
  const profile = profileFor(target);
  return codeReply(detectIntent(prompt), prompt, profile.style);
}

/** Split text into streaming chunks (code points, never mid-surrogate). */
export function chunkText(text: string): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const size = 2 + (i % 5);
    chunks.push(chars.slice(i, i + size).join(''));
    i += size;
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* simulated daemon                                                    */
/* ------------------------------------------------------------------ */

export interface DemoDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface DemoSession {
  sessionId: string;
  backend: string;
  title: string;
  createdAt: number;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DemoTransport {
  private readonly deps: Required<DemoDeps>;
  private sessions: DemoSession[] = [];
  private memoryEntries: MemoryEntry[];

  constructor(deps: DemoDeps = {}) {
    this.deps = {
      sleep: deps.sleep ?? DEFAULT_SLEEP,
      now: deps.now ?? (() => Date.now()),
      random: deps.random ?? (() => 0.35 + Math.random() * 0.3),
    };
    this.memoryEntries = [
      {
        id: 'mem-1',
        scope: 'user',
        content: 'TypeScript는 strict + noUncheckedIndexedAccess를 선호하고, 기본 export보다 이름 있는 export를 쓴다.',
        source: 'demo',
        status: 'active',
        updatedAt: this.deps.now(),
      },
      {
        id: 'mem-2',
        scope: 'user',
        content: 'damon-agent-core는 /ws JSON-RPC v2를 쓴다. WS 티켓은 1회용이고 60초 안에 만료된다.',
        source: 'demo',
        status: 'active',
        updatedAt: this.deps.now(),
      },
      {
        id: 'mem-3',
        scope: 'user',
        content: '정적 SPA는 Vite + GitHub Pages 조합. 데몬이 없을 때도 데모가 먼저 뜨는 구조를 선호한다.',
        source: 'demo',
        status: 'pending',
        updatedAt: this.deps.now(),
      },
    ];
  }

  /* seed a conversation list so a first visit is not an empty shell */
  seedSessions(rows: DemoSession[]): void {
    this.sessions = [...rows];
  }

  sessionsList(): DemoSession[] {
    return [...this.sessions];
  }

  addSession(session: DemoSession): void {
    this.sessions = [session, ...this.sessions.filter((row) => row.sessionId !== session.sessionId)];
  }

  memory(includePending = false): MemoryEntry[] {
    return this.memoryEntries.filter((entry) => includePending || entry.status === 'active');
  }

  memoryUsage(): { chars: number; limit: number } {
    const chars = this.memoryEntries
      .filter((entry) => entry.status === 'active')
      .reduce((total, entry) => total + entry.content.length, 0);
    return { chars, limit: 8000 };
  }

  async *streamTurn(
    prompt: string,
    target: RouteTarget,
    opts: { signal?: AbortSignal; composeFrom?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    const profile = profileFor(target);
    const { sleep, random } = this.deps;
    // `prompt` is what the desk actually sent (memory block included);
    // the answer is composed from the user's clean words.
    const text = composeReply(opts.composeFrom ?? prompt, target);
    const started = this.deps.now();
    yield { type: 'start', turnId: `demo-${started.toString(36)}` };

    const delay = (min: number, max: number) => min + Math.round(random() * (max - min));
    await sleep(delay(profile.firstToken[0], profile.firstToken[1]));

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      if (opts.signal?.aborted) {
        yield { type: 'done', stopReason: 'canceled' };
        return;
      }
      yield { type: 'delta', text: chunk };
      await sleep(delay(profile.pace[0], profile.pace[1]));
    }

    const inputTokens = Math.max(12, Math.round(prompt.length / 3.6));
    const outputTokens = Math.max(24, Math.round(text.length / 3.2));
    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        costUsd: (inputTokens / 1000) * profile.price.input + (outputTokens / 1000) * profile.price.output,
      },
    };
    yield { type: 'done', stopReason: 'completed' };
  }
}

/** A slot pre-filled from a seeded demo conversation. */
export function demoSlot(target: RouteTarget, text: string, at: number): ReplySlot {
  return {
    id: `demo-slot-${at}-${target.key}`,
    target,
    text,
    status: 'done',
    startedAt: at,
    firstTokenAt: at + 640,
    endedAt: at + 4200,
    usage: { inputTokens: 96, outputTokens: Math.round(text.length / 3.2) },
  };
}
