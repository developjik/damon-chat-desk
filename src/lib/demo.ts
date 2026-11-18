/**
 * Demo mode — a simulated daemon with no network at all.
 *
 * Purpose: a visitor of the GitHub Pages build (recruiter, reviewer)
 * must be able to see provider routing and the side-by-side compare
 * mode without installing a daemon. Every frame this transport emits
 * goes through the same event shape as the real one, so the UI has no
 * demo branch: the badge says "simulated" and nothing else changes.
 */

import type { MemoryEntry, MemoryScope, PlanDecision, PlanRequest, ReplySlot, RouteTarget, StreamEvent, ToolCall, ToolResult } from './types';
import { makeTarget } from './targets';
import { buildPlan } from './plan';
import { MemoryRejection, memoryStats } from './memory';
import type { WireTap } from './inspector';
import { scenarioById, type Scenario, type ScenarioBeat, type ScenarioId } from './scenarios';

/**
 * The simulated daemon's own wire log.
 *
 * A demo turn is a real protocol exchange with a fake peer: this writes
 * the same envelopes the daemon sends (`{id, method, params}`, `{id,
 * result}`, `{event, sessionId, data}`) into the inspector's tap, so what
 * a visitor reads in the panel matches what a live daemon would put on
 * the socket — `turn.start`, `session.event` pushes, `plan.respond`.
 */
class DemoWire {
  private nextId = 1;
  private sent = new Map<number, { method: string; at: number }>();

  constructor(
    private readonly tap: WireTap | null,
    private readonly now: () => number,
  ) {}

  request(method: string, params: Record<string, unknown>, sessionId?: string): number {
    const id = this.nextId++;
    const at = this.now();
    this.sent.set(id, { method, at });
    this.tap?.record({
      dir: 'tx',
      kind: 'request',
      method,
      protocol: 'jsonrpc',
      id,
      sessionId,
      at,
      payload: { id, method, params },
    });
    return id;
  }

  result(id: number, result: unknown): void {
    const sent = this.sent.get(id);
    this.sent.delete(id);
    this.tap?.record({
      dir: 'rx',
      kind: 'result',
      method: sent?.method ?? 'response',
      protocol: 'jsonrpc',
      id,
      latencyMs: sent ? this.now() - sent.at : undefined,
      status: 'ok',
      payload: { id, result },
    });
  }

  /** One server push — `session.event` in every case the daemon uses. */
  push(event: string, data: Record<string, unknown>, sessionId?: string): void {
    this.tap?.record({
      dir: 'rx',
      kind: 'notification',
      method: event,
      protocol: 'jsonrpc',
      sessionId,
      payload: { event, sessionId, data },
    });
  }
}

/** A scripted call in the wire's own `ToolCallDetail` shape. */
function detailOf(script: { kind: ToolCall['kind']; input: string; result: ToolResult }): Record<string, unknown> {
  switch (script.kind) {
    case 'shell':
      return { type: 'shell', command: script.input, output: script.result.stdout, exit_code: script.result.exitCode };
    case 'read':
      return { type: 'read', path: script.input, content: script.result.stdout };
    case 'edit':
      return { type: 'edit', path: script.input, unified_diff: script.result.diff };
    case 'write':
      return { type: 'write', path: script.input, content: script.result.stdout };
    case 'search':
      return { type: 'search', query: script.input, content: script.result.stdout };
    case 'fetch':
      return { type: 'fetch', url: script.input, result: script.result.stdout };
    default:
      return { type: 'unknown', input: script.input };
  }
}

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

/* ------------------------------------------------------------------ */
/* tool scripts — a realistic run for the accordion                     */
/* ------------------------------------------------------------------ */

interface DemoToolScript {
  /** Backend-specific tool name; falls back to the kind for scenarios. */
  name?: string;
  kind: ToolCall['kind'];
  label: string;
  input: string;
  status: 'done' | 'error';
  /** Wall-clock cost the daemon would report for this call. */
  ms: number;
  result: ToolResult;
}

/** Per-backend tool vocabulary, so a demo log matches the provider. */
const TOOL_NAMES: Record<string, Partial<Record<ToolCall['kind'], string>>> = {
  claude: { shell: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', search: 'Grep', fetch: 'WebFetch' },
  codex: { shell: 'shell', read: 'read', edit: 'apply_patch', write: 'write', search: 'search', fetch: 'fetch' },
  qwen: { shell: 'bash', read: 'read_file', edit: 'edit_file', write: 'write_file', search: 'grep', fetch: 'fetch' },
  opencode: { shell: 'bash', read: 'read', edit: 'edit', write: 'write', search: 'grep', fetch: 'fetch' },
};

function toolName(target: RouteTarget, kind: ToolCall['kind']): string {
  return TOOL_NAMES[target.provider]?.[kind] ?? kind;
}

const FAILING_TEST = `> damon-chat-desk@0.1.0 test
> vitest run src/lib/sse.test.ts

 ❯ src/lib/sse.test.ts (6 tests | 1 failed) 214ms
   ✓ flushes the trailing frame
   × keeps a half frame until the next chunk
     → expected [] to deeply equal [ 'data: {a:1}' ]

 FAIL  src/lib/sse.test.ts > keeps a half frame until the next chunk
 AssertionError: expected [] to deeply equal [ 'data: {a:1}' ]

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)`;

const PASSING_TEST = `> damon-chat-desk@0.1.0 test
> vitest run src/lib/sse.test.ts

 ✓ src/lib/sse.test.ts (6 tests) 198ms

 Test Files  1 passed (1)
      Tests  6 passed (6)`;

const SSE_SOURCE = ` 31  const REST = '\\r\\n\\r\\n';
 32
 33  export function splitFrames(buffer: string): { frames: string[]; rest: string } {
 34    const frames: string[] = [];
 35    let at = buffer.indexOf('\\n\\n');
 36    while (at !== -1) {
 37      frames.push(buffer.slice(0, at));
 38      buffer = buffer.slice(at + 2);
 39      at = buffer.indexOf('\\n\\n');
 40    }
 41    return { frames, rest: buffer };
 42  }`;

const SSE_DIFF = `--- a/src/lib/sse.ts
+++ b/src/lib/sse.ts
@@ -1,6 +1,7 @@
-const SEPARATOR = '\\n\\n';
+const SEPARATORS = ['\\n\\n', '\\r\\n\\r\\n'];
 
-export function splitFrames(buffer: string) {
+export function splitFrames(buffer: string) {
   const frames: string[] = [];
   let at = indexOfSeparator(buffer, 0);`;

const SEARCH_HITS = `src/lib/sse.ts:41:export function splitFrames(buffer: string)
src/lib/desk.ts:512:    const events = await this.eventsFor(convId, target, …)
src/lib/daemon.ts:196:  async *streamTurn(sessionId: string, prompt: string, …)`;

const PLAN_FILES = ` 1  {
 2    "name": "damon-chat-desk",
 3    "scripts": {
 4      "build": "tsc --noEmit && vite build",
 5      "test": "vitest run"
 6    },
 7    "dependencies": { "react": "19.3.1" }
 8  }`;

/** One snapshot of a scripted call, in the wire shape the desk folds. */
function scriptCall(
  script: DemoToolScript,
  id: string,
  startedAt: number,
  status: ToolCall['status'],
  endedAt?: number,
): ToolCall {
  return {
    id,
    name: script.name ?? script.kind,
    kind: script.kind,
    label: script.label,
    input: script.input,
    status,
    startedAt,
    endedAt,
    result: status === 'running' ? undefined : script.result,
  };
}

/** Emit `running`, wait the way a real call would, emit the result. */
async function* runDemoTool(
  script: DemoToolScript,
  id: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
  wire?: { wire: DemoWire; sessionId?: string },
): AsyncGenerator<StreamEvent> {
  const startedAt = now();
  const name = script.name ?? script.kind;
  wire?.wire.push(
    'session.event',
    { type: 'timeline', kind: 'tool_call', call_id: id, name, status: 'running', detail: detailOf(script) },
    wire.sessionId,
  );
  yield { type: 'tool', call: scriptCall(script, id, startedAt, 'running') };
  await sleep(waitMs);
  wire?.wire.push(
    'session.event',
    {
      type: 'timeline',
      kind: 'tool_call',
      call_id: id,
      name,
      status: script.status === 'error' ? 'failed' : 'completed',
      detail: detailOf(script),
    },
    wire.sessionId,
  );
  yield { type: 'tool', call: scriptCall(script, id, startedAt, script.status, startedAt + script.ms) };
}

/** The calls the demo agent makes for each kind of ask. */
function scriptsFor(target: RouteTarget, intent: Intent): DemoToolScript[] {
  if (intent === 'code') {
    return [
      {
        name: toolName(target, 'shell'),
        kind: 'shell',
        label: 'npm test -- src/lib/sse.test.ts',
        input: 'npm test -- src/lib/sse.test.ts',
        status: 'error',
        ms: 892,
        result: { stdout: FAILING_TEST, exitCode: 1 },
      },
      {
        name: toolName(target, 'read'),
        kind: 'read',
        label: 'src/lib/sse.ts',
        input: 'src/lib/sse.ts',
        status: 'done',
        ms: 96,
        result: { stdout: SSE_SOURCE },
      },
      {
        name: toolName(target, 'edit'),
        kind: 'edit',
        label: 'src/lib/sse.ts',
        input: 'src/lib/sse.ts',
        status: 'done',
        ms: 214,
        result: { diff: SSE_DIFF },
      },
      {
        name: toolName(target, 'shell'),
        kind: 'shell',
        label: 'npm test -- src/lib/sse.test.ts',
        input: 'npm test -- src/lib/sse.test.ts',
        status: 'done',
        ms: 1104,
        result: { stdout: PASSING_TEST, exitCode: 0 },
      },
    ];
  }
  if (intent === 'plan') {
    return [
      {
        name: toolName(target, 'read'),
        kind: 'read',
        label: 'package.json',
        input: 'package.json',
        status: 'done',
        ms: 74,
        result: { stdout: PLAN_FILES },
      },
      {
        name: toolName(target, 'search'),
        kind: 'search',
        label: 'streamTurn',
        input: 'streamTurn',
        status: 'done',
        ms: 132,
        result: { stdout: SEARCH_HITS },
      },
    ];
  }
  if (intent === 'compare') {
    return [
      {
        name: toolName(target, 'search'),
        kind: 'search',
        label: 'stream',
        input: 'stream',
        status: 'done',
        ms: 118,
        result: { stdout: SEARCH_HITS },
      },
    ];
  }
  return [];
}

/** The plan the demo agent parks for approval after a design ask. */
let planCounter = 0;

export function demoPlan(prompt: string, target: RouteTarget): PlanRequest {
  planCounter += 1;
  const topic = topicOf(prompt);
  const structured = profileFor(target).style !== 'prose';
  const content = [
    `## ${topic} — 구현 계획`,
    '',
    '1. **계약 고정** — 요청/응답 스키마와 에러 상태를 먼저 못 박습니다.',
    '2. **얇은 경로** — 프롬프트 → 스트림 → 렌더 한 줄기만 연결합니다.',
    '3. **상태 이전** — 세션과 메모리를 브라우저에서 데몬으로 옮깁니다.',
    '4. **부가 기능** — 비교 모드와 세션 분기를 그 위에 얹습니다.',
    '',
    '변경 예상 파일: `src/lib/desk.ts`, `src/lib/types.ts`, `src/components/Transcript.tsx`',
    '',
    structured
      ? '리스크: 3번을 미루면 비교 모드가 서로 다른 진실을 그리게 됩니다.'
      : '트레이드오프: UI가 상태를 계속 들고 있으면 두 번째 서피스에서 이어갈 수 없습니다.',
  ].join('\n');
  return buildPlan({
    requestId: `demo-plan-req-${planCounter}`,
    planId: `plan-demo-${planCounter}`,
    revision: 1,
    content,
    title: `${topic} — 구현 계획`,
  });
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

/** What the desk may ask a simulated turn for. */
export interface DemoStreamOptions {
  signal?: AbortSignal;
  composeFrom?: string;
  steerKey?: string;
  /** The conversation that owns this turn — the frame's `sessionId`. */
  sessionId?: string;
  /** First turn of a conversation: the wire shows `session.create` first. */
  newSession?: boolean;
  /** Play one of the real-work scenarios instead of composing an answer. */
  scenario?: ScenarioId;
}

export interface DemoSession {
  sessionId: string;
  backend: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
  archived?: boolean;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DemoTransport {
  private readonly deps: Required<DemoDeps>;
  private sessions: DemoSession[] = [];
  private memoryEntries: MemoryEntry[];
  /** Where the simulated wire is recorded (the inspector). */
  private tap: WireTap | null = null;

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
      {
        id: 'mem-b1',
        scope: 'bot',
        owner: 'scribe',
        content: '릴리스 노트는 CHANGELOG.md에 날짜 → 변경 → 근거 순서로 적는다.',
        source: 'demo',
        status: 'active',
        updatedAt: this.deps.now(),
      },
    ];
  }

  /** Restore a ledger the desk kept in local storage (demo writes persist). */
  hydrateMemory(entries: MemoryEntry[]): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    this.memoryEntries = entries.map((entry) => ({ ...entry }));
  }

  /** Attach the inspector's tap; the desk owns it and passes it in. */
  setTap(tap: WireTap | null): void {
    this.tap = tap;
  }

  private wire(): DemoWire {
    return new DemoWire(this.tap, this.deps.now);
  }

  /** seed a conversation list so a first visit is not an empty shell */
  seedSessions(rows: DemoSession[]): void {
    this.sessions = [...rows];
  }

  sessionsList(includeArchived = false): DemoSession[] {
    return this.sessions.filter((row) => includeArchived || !row.archived);
  }

  addSession(session: DemoSession): void {
    this.sessions = [session, ...this.sessions.filter((row) => row.sessionId !== session.sessionId)];
  }

  /** `session.rename` — the demo's row title is the whole record. */
  renameSession(sessionId: string, title: string): boolean {
    const row = this.sessions.find((entry) => entry.sessionId === sessionId);
    if (!row) return false;
    row.title = title;
    return true;
  }

  /** `session.set_archived` — hidden from the list, history kept. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const row = this.sessions.find((entry) => entry.sessionId === sessionId);
    if (!row) return false;
    row.archived = archived;
    return true;
  }

  deleteSession(sessionId: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((row) => row.sessionId !== sessionId);
    return this.sessions.length !== before;
  }

  /* ---------------------------------------------------------------- */
  /* memory ledger                                                      */
  /* ---------------------------------------------------------------- */

  private readonly memoryLimit = 8000;

  private inLedger(entry: MemoryEntry, scope: MemoryScope, owner?: string | null): boolean {
    if ((entry.scope === 'bot' ? 'bot' : 'user') !== scope) return false;
    if (scope !== 'bot') return true;
    return (entry.owner ?? '') === (owner ?? '');
  }

  /** `memory.list {scope, owner?, includePending?}` over the simulated ledgers. */
  memoryList(input: { scope?: MemoryScope; owner?: string | null; includePending?: boolean } = {}): MemoryEntry[] {
    const scope = input.scope ?? 'user';
    return this.memoryEntries
      .filter((entry) => this.inLedger(entry, scope, input.owner))
      .filter((entry) => input.includePending === true || entry.status === 'active')
      .map((entry) => ({ ...entry }));
  }

  memory(includePending = false): MemoryEntry[] {
    return this.memoryList({ scope: 'user', includePending });
  }

  memoryUsage(scope: MemoryScope = 'user', owner?: string | null): { chars: number; limit: number } {
    const ledger = this.memoryEntries.filter((entry) => this.inLedger(entry, scope, owner));
    return { chars: memoryStats(ledger).chars, limit: this.memoryLimit };
  }

  /** Every ledger at once, for the desk's local-storage snapshot. */
  snapshotMemory(): MemoryEntry[] {
    return this.memoryEntries.map((entry) => ({ ...entry }));
  }

  /**
   * The demo's version of the gate chain: invisible chars, secrets, an
   * instruction-shaped line, then the cap. Agent-shaped writes land
   * `pending` exactly like a write that needs approval.
   */
  writeMemory(input: { scope: MemoryScope; owner?: string | null; content: string; source?: string }): {
    id: string;
    status: 'active' | 'pending';
  } {
    const content = input.content.trim();
    if (!content) throw new MemoryRejection({ kind: 'invalid', message: 'empty content' });
    if (input.scope === 'bot' && !input.owner) throw new MemoryRejection({ kind: 'invalid', message: 'owner required' });
    if (/[\u200b-\u200f\u2060\ufeff]/.test(content)) throw new MemoryRejection({ kind: 'invisible' });
    if (/sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
      throw new MemoryRejection({ kind: 'secret' });
    }
    if (/ignore (all )?(previous|above) instructions|system prompt|이전 지시.{0,8}무시|시스템 프롬프트/i.test(content)) {
      throw new MemoryRejection({ kind: 'prompt_injection' });
    }
    const ledger = this.memoryEntries.filter((entry) => this.inLedger(entry, input.scope, input.owner));
    const current = memoryStats(ledger).chars;
    if (current + content.length > this.memoryLimit) {
      throw new MemoryRejection({ kind: 'capacity', limit: this.memoryLimit, current, attempted: content.length });
    }
    const id = `mem-${this.memoryEntries.length + 1}-${this.deps.now().toString(36)}`;
    const agentWrite = input.scope === 'bot' || (input.source ?? '').startsWith('agent');
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      owner: input.scope === 'bot' ? input.owner ?? null : null,
      content,
      source: input.source ?? 'demo',
      status: agentWrite ? 'pending' : 'active',
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
    };
    this.memoryEntries = [entry, ...this.memoryEntries];
    return { id, status: entry.status };
  }

  removeMemory(id: string): boolean {
    const before = this.memoryEntries.length;
    this.memoryEntries = this.memoryEntries.filter((entry) => entry.id !== id);
    return this.memoryEntries.length !== before;
  }

  /** One-shot CAS: a settled entry cannot be approved twice. */
  approveMemory(id: string): boolean {
    const entry = this.memoryEntries.find((row) => row.id === id);
    if (!entry || entry.status !== 'pending') return false;
    entry.status = 'active';
    entry.updatedAt = this.deps.now();
    return true;
  }

  rejectMemory(id: string): boolean {
    const entry = this.memoryEntries.find((row) => row.id === id);
    if (!entry || entry.status !== 'pending') return false;
    this.memoryEntries = this.memoryEntries.filter((row) => row.id !== id);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* turn.steer — a redirect queued for a running turn                  */
  /* ---------------------------------------------------------------- */

  private steers = new Map<string, Array<{ text: string; at: number }>>();

  /** Queue a steering instruction for the turn running on `key`. */
  steer(text: string, key = '*', sessionId?: string): void {
    const body = text.trim();
    if (!body) return;
    const queued = this.steers.get(key) ?? [];
    queued.push({ text: body, at: this.deps.now() });
    this.steers.set(key, queued);
    const wire = this.wire();
    const id = wire.request('turn.steer', { sessionId: sessionId ?? key, prompt: body }, sessionId);
    wire.result(id, { result: 'queued for the running turn' });
  }

  /** Steers waiting for a turn; the stream drains them between chunks. */
  private takeSteers(key: string): Array<{ text: string; at: number }> {
    const queued = this.steers.get(key) ?? [];
    this.steers.delete(key);
    return queued;
  }

  /* ---------------------------------------------------------------- */
  /* session.fork                                                       */
  /* ---------------------------------------------------------------- */

  private forkCount = 0;

  /** Copy a session into a branch; returns the new session id. */
  forkSession(sessionId?: string, title?: string): string {
    this.forkCount += 1;
    const id = `demo-fork-${this.forkCount}`;
    const wire = this.wire();
    const requestId = wire.request('session.fork', { sessionId: sessionId ?? '', upto: undefined }, sessionId);
    const source = this.sessions.find((row) => row.sessionId === sessionId);
    this.addSession({
      sessionId: id,
      backend: source?.backend ?? 'claude',
      title: `${title ?? source?.title ?? '새 대화'} (fork)`,
      createdAt: this.deps.now(),
    });
    wire.result(requestId, { sessionId: id });
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* plan.respond                                                       */
  /* ---------------------------------------------------------------- */

  private plans: Array<{ planId: string; revision: number; status: string }> = [];
  /** Plan id → the beats the agent runs once that plan is approved. */
  private resumes = new Map<string, ScenarioBeat[]>();

  /** What an approved plan continues with, or nothing when it has no follow-up. */
  takeResume(planId: string): ScenarioBeat[] | undefined {
    const beats = this.resumes.get(planId);
    this.resumes.delete(planId);
    return beats;
  }

  async respondPlan(input: {
    planId: string;
    revision?: number;
    decision: PlanDecision;
    feedback?: string;
  }): Promise<{ status: string; applied: boolean; revision: number }> {
    const wire = this.wire();
    const requestId = wire.request('plan.respond', {
      planId: input.planId,
      expectedRevision: input.revision ?? 1,
      decision: input.decision,
      ...(input.feedback ? { feedback: input.feedback } : {}),
    });
    await this.deps.sleep(140);
    const status =
      input.decision === 'approve' ? 'approved' : input.decision === 'request_changes' ? 'changes_requested' : 'deferred';
    const revision = input.revision ?? 1;
    const existing = this.plans.find((row) => row.planId === input.planId);
    if (existing) existing.status = status;
    else this.plans.push({ planId: input.planId, revision, status });
    const applied = input.decision !== 'defer';
    const nextRevision = input.decision === 'request_changes' ? revision + 1 : revision;
    wire.result(requestId, {
      recorded: true,
      status,
      applied,
      planId: input.planId,
      revision: nextRevision,
    });
    return { status, applied, revision: nextRevision };
  }

  async *streamTurn(
    prompt: string,
    target: RouteTarget,
    opts: DemoStreamOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const scenario = opts.scenario ? scenarioById(opts.scenario) : undefined;
    if (scenario) {
      yield* this.streamScenario(scenario, target, opts);
      return;
    }
    yield* this.streamComposed(prompt, target, opts);
  }

  /* ---------------------------------------------------------------- */
  /* wire header — session.create (first turn) then turn.start          */
  /* ---------------------------------------------------------------- */

  private async openTurn(
    wire: DemoWire,
    target: RouteTarget,
    sessionId: string,
    prompt: string,
    newSession: boolean,
  ): Promise<number> {
    if (newSession) {
      const created = wire.request('session.create', { backend: target.provider, model: target.model || undefined }, sessionId);
      await this.deps.sleep(24);
      wire.result(created, { sessionId, backend: target.provider, replayed: 0 });
    }
    const turnId = wire.request('turn.start', { sessionId, prompt }, sessionId);
    wire.push('session.event', { type: 'turn_started', turn_id: sessionId }, sessionId);
    return turnId;
  }

  /** The client's `turn.cancel` and the daemon's acknowledgement. */
  private cancelTurn(wire: DemoWire, sessionId: string): void {
    const id = wire.request('turn.cancel', { sessionId }, sessionId);
    wire.result(id, { cancelled: true });
    wire.push('session.event', { type: 'turn_canceled', reason: 'user' }, sessionId);
  }

  private usageFrames(usage: { inputTokens: number; outputTokens: number; costUsd: number }) {
    return {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: Number(usage.costUsd.toFixed(6)),
    };
  }

  private costOf(profile: DemoProfile, inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1000) * profile.price.input + (outputTokens / 1000) * profile.price.output;
  }

  /* ---------------------------------------------------------------- */
  /* composed answer — the generic demo turn                            */
  /* ---------------------------------------------------------------- */

  private async *streamComposed(prompt: string, target: RouteTarget, opts: DemoStreamOptions): AsyncGenerator<StreamEvent> {
    const profile = profileFor(target);
    const { sleep, random } = this.deps;
    // `prompt` is what the desk actually sent (memory block included);
    // the answer is composed from the user's clean words.
    const ask = opts.composeFrom ?? prompt;
    const intent = detectIntent(ask);
    const text = composeReply(ask, target);
    const started = this.deps.now();
    const steerKey = opts.steerKey ?? target.key;
    const sessionId = opts.sessionId ?? `demo-${target.provider}-session`;
    const wire = this.wire();
    const turnKey = `demo-${started.toString(36)}`;
    yield { type: 'start', turnId: turnKey };
    const turnId = await this.openTurn(wire, target, sessionId, prompt, opts.newSession === true);

    const delay = (min: number, max: number) => min + Math.round(random() * (max - min));
    await sleep(delay(profile.firstToken[0], profile.firstToken[1]));

    const chunks = chunkText(text);
    const scripts = scriptsFor(target, intent);
    const between = scripts.length > 0 ? Math.max(1, Math.floor(chunks.length / (scripts.length + 1))) : chunks.length;
    let cursor = 0;
    let nextTool = 0;
    let toolSeq = 0;

    const runTool = (script: DemoToolScript, id: string) =>
      runDemoTool(script, id, this.deps.now, sleep, delay(150, 280), { wire, sessionId });

    while (cursor < chunks.length) {
      if (opts.signal?.aborted) {
        this.cancelTurn(wire, sessionId);
        yield { type: 'done', stopReason: 'canceled' };
        return;
      }
      for (const note of this.takeSteers(steerKey)) {
        yield { type: 'steer', text: note.text, at: note.at };
        const echo = `\n\n> ${note.text} — 반영해서 이어갑니다.\n\n`;
        yield { type: 'delta', text: echo };
        wire.push('session.event', { type: 'timeline', kind: 'assistant_message', text: echo }, sessionId);
      }
      const chunk = chunks[cursor];
      cursor += 1;
      yield { type: 'delta', text: chunk };
      wire.push('session.event', { type: 'timeline', kind: 'assistant_message', text: chunk }, sessionId);
      if (scripts.length > 0 && cursor % between === 0 && nextTool < scripts.length) {
        const script = scripts[nextTool];
        nextTool += 1;
        toolSeq += 1;
        yield* runTool(script, `demo-call-${toolSeq}-${started.toString(36)}`);
      }
      await sleep(delay(profile.pace[0], profile.pace[1]));
    }

    // A short answer may finish before every scripted call fired.
    while (nextTool < scripts.length) {
      const script = scripts[nextTool];
      nextTool += 1;
      toolSeq += 1;
      yield* runTool(script, `demo-call-${toolSeq}-${started.toString(36)}`);
    }

    const inputTokens = Math.max(12, Math.round(prompt.length / 3.6));
    const outputTokens = Math.max(24, Math.round(text.length / 3.2));
    const usage = { inputTokens, outputTokens, costUsd: this.costOf(profile, inputTokens, outputTokens) };
    yield { type: 'usage', usage };

    if (intent === 'plan') {
      // A design ask parks a plan for approval — the card is the demo's
      // plan.respond surface, same as the daemon's `kind: plan` ask.
      const plan = demoPlan(ask, target);
      wire.push(
        'session.event',
        {
          type: 'permission_requested',
          id: plan.id,
          kind: 'plan',
          name: 'ExitPlanMode',
          title: plan.title,
          input: { plan: plan.content },
          actions: [
            { id: 'allow', label: 'approve', behavior: 'allow' },
            { id: 'deny', label: 'request changes', behavior: 'deny' },
          ],
        },
        sessionId,
      );
      wire.result(turnId, { turnId: turnKey, stopReason: 'awaiting_plan' });
      yield { type: 'plan', plan };
      yield { type: 'done', stopReason: 'awaiting_plan' };
      return;
    }
    wire.push('session.event', { type: 'turn_completed', usage: this.usageFrames(usage) }, sessionId);
    wire.result(turnId, { turnId: turnKey, stopReason: 'completed', usage: this.usageFrames(usage) });
    yield { type: 'done', stopReason: 'completed' };
  }

  /* ---------------------------------------------------------------- */
  /* scripted scenarios — refactor · PR review · incident               */
  /* ---------------------------------------------------------------- */

  private scenarioPlan(scenario: Scenario): PlanRequest {
    const content = scenario.plan?.content ?? '';
    return buildPlan({
      requestId: `perm-${scenario.id}-1`,
      planId: `plan-demo-${scenario.id}`,
      revision: 1,
      content,
      title: scenario.plan?.title,
    });
  }

  /**
   * Stream one beat list: prose in chunks, tools through `runDemoTool`,
   * a steer echo whenever the user steers mid-run. Aborting sets
   * `control.canceled` so the caller can close the turn's frames once.
   */
  private async *playBeats(
    beats: ScenarioBeat[],
    target: RouteTarget,
    wire: DemoWire,
    sessionId: string,
    steerKey: string,
    profile: DemoProfile,
    opts: DemoStreamOptions,
    control: { canceled: boolean },
  ): AsyncGenerator<StreamEvent> {
    const { sleep, random } = this.deps;
    const delay = (min: number, max: number) => min + Math.round(random() * (max - min));
    const stamp = Date.now().toString(36);
    let toolSeq = 0;

    for (const beat of beats) {
      if (control.canceled) return;
      if (beat.kind === 'tool') {
        toolSeq += 1;
        const name = beat.tool.name ?? toolName(target, beat.tool.kind);
        yield* runDemoTool(
          { ...beat.tool, name },
          `demo-call-${toolSeq}-${stamp}`,
          this.deps.now,
          sleep,
          delay(180, 340),
          { wire, sessionId },
        );
        continue;
      }
      for (const chunk of chunkText(beat.text)) {
        if (opts.signal?.aborted) {
          control.canceled = true;
          return;
        }
        for (const note of this.takeSteers(steerKey)) {
          yield { type: 'steer', text: note.text, at: note.at };
          const echo = `\n\n> ${note.text} — 반영해서 이어갑니다.\n\n`;
          yield { type: 'delta', text: echo };
          wire.push('session.event', { type: 'timeline', kind: 'assistant_message', text: echo }, sessionId);
        }
        yield { type: 'delta', text: chunk };
        wire.push('session.event', { type: 'timeline', kind: 'assistant_message', text: chunk }, sessionId);
        await sleep(delay(profile.pace[0], profile.pace[1]));
      }
    }
  }

  private async *streamScenario(
    scenario: Scenario,
    target: RouteTarget,
    opts: DemoStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const profile = profileFor(target);
    const steerKey = opts.steerKey ?? target.key;
    const sessionId = opts.sessionId ?? `demo-${target.provider}-session`;
    const wire = this.wire();
    const started = this.deps.now();
    const turnKey = `demo-${started.toString(36)}`;
    yield { type: 'start', turnId: turnKey };
    const turnId = await this.openTurn(wire, target, sessionId, scenario.prompt, opts.newSession === true);
    await this.deps.sleep(profile.firstToken[0] + 120);

    const control = { canceled: false };
    yield* this.playBeats(scenario.beats, target, wire, sessionId, steerKey, profile, opts, control);
    if (control.canceled) {
      this.cancelTurn(wire, sessionId);
      yield { type: 'done', stopReason: 'canceled' };
      return;
    }

    const usage = { ...scenario.usage, costUsd: this.costOf(profile, scenario.usage.inputTokens, scenario.usage.outputTokens) };
    yield { type: 'usage', usage };

    if (scenario.plan) {
      const plan = this.scenarioPlan(scenario);
      wire.push(
        'session.event',
        {
          type: 'permission_requested',
          id: plan.id,
          kind: 'plan',
          name: 'ExitPlanMode',
          title: plan.title,
          input: { plan: plan.content },
          actions: [
            { id: 'allow', label: 'approve', behavior: 'allow' },
            { id: 'deny', label: 'request changes', behavior: 'deny' },
            { id: 'defer', label: 'defer', behavior: 'deny' },
          ],
        },
        sessionId,
      );
      if (scenario.after?.length) this.resumes.set(plan.planId ?? plan.id, scenario.after);
      wire.result(turnId, { turnId: turnKey, stopReason: 'awaiting_plan' });
      yield { type: 'plan', plan };
      yield { type: 'done', stopReason: 'awaiting_plan' };
      return;
    }

    wire.push('session.event', { type: 'turn_completed', usage: this.usageFrames(usage) }, sessionId);
    wire.result(turnId, { turnId: turnKey, stopReason: 'completed', usage: this.usageFrames(usage) });
    yield { type: 'done', stopReason: 'completed' };
  }

  /** The turn an approved plan starts — a fresh `turn.start` on the wire. */
  async *resumeBeats(
    beats: ScenarioBeat[],
    target: RouteTarget,
    opts: { signal?: AbortSignal; sessionId?: string; prompt?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    const profile = profileFor(target);
    const sessionId = opts.sessionId ?? `demo-${target.provider}-session`;
    const wire = this.wire();
    const started = this.deps.now();
    const turnKey = `demo-${started.toString(36)}`;
    yield { type: 'start', turnId: turnKey };
    const turnId = await this.openTurn(wire, target, sessionId, opts.prompt ?? '(approved plan) 실행', false);
    await this.deps.sleep(420);

    const control = { canceled: false };
    yield* this.playBeats(beats, target, wire, sessionId, target.key, profile, opts, control);
    if (control.canceled) {
      this.cancelTurn(wire, sessionId);
      yield { type: 'done', stopReason: 'canceled' };
      return;
    }

    const chars = beats.reduce((total, beat) => total + (beat.kind === 'text' ? beat.text.length : 0), 0);
    const inputTokens = 2400 + chars;
    const outputTokens = Math.max(80, Math.round(chars / 3.2));
    const usage = { inputTokens, outputTokens, costUsd: this.costOf(profile, inputTokens, outputTokens) };
    yield { type: 'usage', usage };
    wire.push('session.event', { type: 'turn_completed', usage: this.usageFrames(usage) }, sessionId);
    wire.result(turnId, { turnId: turnKey, stopReason: 'completed', usage: this.usageFrames(usage) });
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
