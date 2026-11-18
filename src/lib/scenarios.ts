/**
 * The three real-work scenarios — refactor, PR review, incident.
 *
 * Each one is a complete agent run the desk can play end to end: prose,
 * tool calls with their real result panes, and (where the work is risky)
 * a plan the user has to approve before the agent touches a file. The
 * demo transport streams the beats through the same event shape as a
 * live daemon, so the transcript, the tool accordion, the plan card, the
 * `turn.steer` path and the JSON-RPC inspector all light up together —
 * a visitor on GitHub Pages sees the protocol, not a slide about it.
 *
 * Data only: no React, no transport. `demo.ts` plays it, `App` launches
 * it, and the tests read it.
 */

import type { ToolKind, ToolResult } from './types';

export type ScenarioId = 'refactor' | 'pr-review' | 'incident';

export interface ScenarioTool {
  kind: ToolKind;
  /** Overrides the backend's default tool name when the CLI has its own. */
  name?: string;
  label: string;
  input: string;
  status: 'done' | 'error';
  /** Wall clock the daemon would report for the call. */
  ms: number;
  result: ToolResult;
}

export type ScenarioBeat = { kind: 'text'; text: string } | { kind: 'tool'; tool: ScenarioTool };

export interface ScenarioPlan {
  title: string;
  content: string;
}

export interface Scenario {
  id: ScenarioId;
  index: string;
  /** Short English handle, the card's kicker. */
  label: string;
  title: string;
  summary: string;
  /** What gets typed into the composer and sent to a real daemon. */
  prompt: string;
  /** Tool badges on the launcher card. */
  tools: string[];
  /** The run up to the plan (or to the final answer when there is none). */
  beats: ScenarioBeat[];
  plan?: ScenarioPlan;
  /** Beats that run only after the plan is approved. */
  after?: ScenarioBeat[];
  usage: { inputTokens: number; outputTokens: number };
}

/* ------------------------------------------------------------------ */
/* 01 — refactor                                                       */
/* ------------------------------------------------------------------ */

const WEBHOOK_SOURCE = ` 1  export async function POST(req: Request) {
 2    const raw = await req.text()
 3    const signature = req.headers.get('stripe-signature') ?? ''
 4    // TODO: this used to verify before parsing; moved during the v2 cutover
 5    const body = JSON.parse(raw)
 6    const tenant = body.account ?? 'default'
 7    const db = await connect()
 8
 9    for (const event of body.events ?? []) {
10      if (event.type === 'payment.succeeded') {
11        const existing = await db.payments.findFirst({ id: event.id })
12        if (existing) continue
13        await db.payments.insert({ id: event.id, tenant, amount: event.amount / 100 })
14        await queue.enqueue('receipt', { id: event.id })
15      }
16      if (event.type === 'payment.failed') { /* … */ }
17      // … 210 more lines of the same shape
18    }
19    return Response.json({ ok: true })
20  }
21
22  // verifySignature, normalizeEvent and the retry loop are inlined below
23  // (lines 24–380)`;

const REFACTOR_PLAN = `## 웹훅 핸들러 3분할 리팩토링

1. **서명 검증 분리** — \`verifySignature(raw, header, secret)\`를 순수 함수로 옮기고 raw body를 읽는 순서를 첫 줄로 고정합니다.
2. **이벤트 정규화 분리** — 벤더 payload를 \`PaymentEvent\`로 바꾸는 \`normalizeEvent()\`를 만듭니다.
3. **저장 어댑터 분리** — DB를 만지는 건 \`upsertPayment(event)\` 하나로 좁히고 핸들러는 순서만 남깁니다.
4. **계약 테스트 고정** — 기존 테스트는 고치지 않고, 새 공개 함수 3개의 시그니처만 잠급니다.

변경 예상 파일: \`src/api/webhook.ts\`, \`src/api/webhook.verify.ts\`, \`src/api/webhook.normalize.ts\`, \`tests/webhook.test.ts\`

리스크: raw body를 파싱한 뒤에 검증하면 서명 비교가 조용히 실패합니다 — 검증을 첫 줄로 고정하고 테스트로 잠급니다.`;

const refactor: Scenario = {
  id: 'refactor',
  index: '01',
  label: 'refactor',
  title: '결제 웹훅 핸들러 3분할',
  summary: '380줄 핸들러를 순수 함수 셋으로 쪼개고, 기존 테스트를 그대로 통과시킵니다. 파일을 만지기 전에 계획 승인을 받습니다.',
  prompt:
    'src/api/webhook.ts 핸들러가 380줄이야. 서명 검증·이벤트 정규화·저장을 각각 순수 함수로 분리하고, 기존 테스트는 손대지 말고 그대로 통과하게 해 줘. 파일을 만지기 전에 계획부터 보여 줘.',
  tools: ['Read', 'Grep', 'Edit', 'Bash'],
  beats: [
    {
      kind: 'text',
      text: '핸들러의 책임 경계부터 확인하겠습니다. 파일이 길어서 구조를 먼저 읽고, 지금 테스트가 실제로 고정하고 있는 계약을 같이 봅니다.',
    },
    {
      kind: 'tool',
      tool: {
        kind: 'read',
        label: 'src/api/webhook.ts',
        input: 'src/api/webhook.ts',
        status: 'done',
        ms: 88,
        result: { stdout: WEBHOOK_SOURCE },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'search',
        label: 'verifySignature|normalizeEvent|upsertPayment',
        input: 'verifySignature|normalizeEvent|upsertPayment',
        status: 'done',
        ms: 121,
        result: {
          stdout: `src/api/webhook.ts:24:  function verifySignature(raw: string, header: string)
src/api/webhook.ts:96:  function normalizeEvent(raw: VendorEvent)
src/api/webhook.ts:241:  async function upsertPayment(db: Db, event: PaymentEvent)
src/api/webhook.ts:337:  // retry loop (inlined, no cap)
tests/webhook.test.ts:18:  it('rejects a tampered signature', ...)
tests/webhook.test.ts:42:  it('normalizes a succeeded payment', ...)`,
        },
      },
    },
    {
      kind: 'text',
      text: `세 책임이 한 함수에 섞여 있고, 순서가 뒤집혀 있습니다.

- **검증**은 24줄에 있는데 호출은 5줄(파싱 이후)입니다. 지금 테스트는 이 순서를 잡지 못합니다.
- **정규화**와 **저장**이 \`for\` 루프 안에서 교차합니다 — 이벤트 하나가 실패하면 앞의 저장이 남습니다.
- \`verifySignature\`/\`normalizeEvent\`/\`upsertPayment\`는 이미 이름이 붙어 있습니다. 새 추상화가 아니라 **파일 밖으로 꺼내는 일**입니다.

파일을 만지기 전에 4단계 계획을 올립니다. 승인하면 3개 파일로 나누고, 기존 테스트를 그대로 돌립니다.`,
    },
  ],
  plan: { title: '웹훅 핸들러 3분할 리팩토링', content: REFACTOR_PLAN },
  after: [
    {
      kind: 'tool',
      tool: {
        kind: 'edit',
        label: 'src/api/webhook.ts',
        input: 'src/api/webhook.ts',
        status: 'done',
        ms: 236,
        result: {
          diff: `--- a/src/api/webhook.ts
+++ b/src/api/webhook.ts
@@ -1,19 +1,16 @@
+import { verifySignature } from './webhook.verify'
+import { normalizeEvent } from './webhook.normalize'
+import { upsertPayment } from './webhook.store'
+
 export async function POST(req: Request) {
   const raw = await req.text()
   const signature = req.headers.get('stripe-signature') ?? ''
-  // TODO: this used to verify before parsing; moved during the v2 cutover
-  const body = JSON.parse(raw)
-  const tenant = body.account ?? 'default'
-  const db = await connect()
-
-  for (const event of body.events ?? []) {
-    if (event.type === 'payment.succeeded') {
-      const existing = await db.payments.findFirst({ id: event.id })
-      if (existing) continue
-      await db.payments.insert({ id: event.id, tenant, amount: event.amount / 100 })
-      await queue.enqueue('receipt', { id: event.id })
-    }
-    if (event.type === 'payment.failed') { /* … */ }
-    // … 210 more lines of the same shape
-  }
+  if (!verifySignature(raw, signature, env.WEBHOOK_SECRET)) {
+    return new Response('bad signature', { status: 400 })
+  }
+  const db = await connect()
+  for (const event of normalizeEvent(raw)) {
+    await upsertPayment(db, event)
+  }
   return Response.json({ ok: true })
 }`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'write',
        label: 'src/api/webhook.verify.ts',
        input: 'src/api/webhook.verify.ts',
        status: 'done',
        ms: 42,
        result: {
          stdout: `+ export function verifySignature(raw: string, header: string, secret: string): boolean
+ // constant-time compare, throws on a malformed header
+ export function parseSignature(header: string): { t: number; v1: string }`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'npm test -- tests/webhook.test.ts',
        input: 'npm test -- tests/webhook.test.ts',
        status: 'done',
        ms: 1180,
        result: {
          stdout: `> damon-desk@0.1.0 test
> vitest run tests/webhook.test.ts

 ✓ tests/webhook.test.ts (12 tests) 942ms
   ✓ rejects a tampered signature
   ✓ verifies before parsing (raw body order)
   ✓ normalizes a succeeded payment
   ✓ keeps a failed event out of the store

 Test Files  1 passed (1)
      Tests  12 passed (12)`,
          exitCode: 0,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'npx tsc --noEmit',
        input: 'npx tsc --noEmit',
        status: 'done',
        ms: 2400,
        result: { stdout: '', exitCode: 0 },
      },
    },
    {
      kind: 'text',
      text: `끝났습니다. 핸들러가 얇아졌고 계약은 그대로입니다.

- \`src/api/webhook.ts\` — 380줄 → **61줄**
- \`webhook.verify.ts\` — 새 파일 **34줄** (서명 검증, 상수 시간 비교)
- \`webhook.normalize.ts\` — 새 파일 **88줄** (벤더 → \`PaymentEvent\`)
- \`webhook.store.ts\` — 새 파일 **57줄** (DB를 만지는 유일한 지점)

검증:

- \`npm test -- tests/webhook.test.ts\` → 12 passed (기존 10개는 손대지 않음)
- \`npx tsc --noEmit\` → 0 errors

남은 일: 인라인 재시도 루프(337줄)는 아직 그 자리에 있습니다. 다음 턴에서 큐 상한과 함께 정리하는 걸 권합니다.`,
    },
  ],
  usage: { inputTokens: 4820, outputTokens: 980 },
};

/* ------------------------------------------------------------------ */
/* 02 — PR review                                                      */
/* ------------------------------------------------------------------ */

const PR_DIFF = `diff --git a/src/server/exportCache.ts b/src/server/exportCache.ts
new file mode 100644
index 0000000..6f18c2a
--- /dev/null
+++ b/src/server/exportCache.ts
@@ -0,0 +1,34 @@
+import { createHash } from 'node:crypto'
+
+const cache = new Map<string, string>()
+
+export function cacheKey(sessionId: string): string {
+  return createHash('sha1').update(sessionId).digest('hex') + ':' + Date.now()
+}
+
+export async function exportOnce(sessionId: string, build: () => Promise<string>): Promise<string> {
+  const key = cacheKey(sessionId)
+  const hit = cache.get(key)
+  if (hit) return hit
+  const value = await build()
+  cache.set(key, value)
+  return value
+}
diff --git a/src/server/routes/export.ts b/src/server/routes/export.ts
@@
-  const body = await buildExport(sessionId)
+  const body = await exportOnce(sessionId, () => buildExport(sessionId))
   res.type('application/json').send(body)`;

const prReview: Scenario = {
  id: 'pr-review',
  index: '02',
  label: 'pr review',
  title: 'PR #482 — 세션 export 캐시',
  summary: 'diff와 주변 코드를 읽고 보안·성능 관점 코멘트를 남깁니다. 머지 판단까지 한 번에.',
  prompt:
    'PR #482 `feat: 세션 export 캐시`를 리뷰해 줘. 보안과 성능 관점에서 코멘트를 달고, 지금 머지 가능한지 판단해 줘.',
  tools: ['Bash', 'Read', 'Grep'],
  beats: [
    {
      kind: 'text',
      text: 'PR 메타데이터와 diff부터 보겠습니다. 캐시는 키 설계가 전부라서, 키가 무엇으로 만들어지는지와 값이 얼마나 커질 수 있는지를 먼저 확인합니다.',
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'gh pr view 482 --json title,files,additions,deletions',
        input: 'gh pr view 482 --json title,files,additions,deletions',
        status: 'done',
        ms: 640,
        result: {
          stdout: `{"title":"feat: 세션 export 캐시","additions":34,"deletions":1,
 "files":[{"path":"src/server/exportCache.ts","additions":34},
          {"path":"src/server/routes/export.ts","additions":2,"deletions":1}]}`,
          exitCode: 0,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'gh pr diff 482',
        input: 'gh pr diff 482',
        status: 'done',
        ms: 720,
        result: { stdout: PR_DIFF, exitCode: 0 },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'read',
        label: 'src/server/routes/export.ts',
        input: 'src/server/routes/export.ts',
        status: 'done',
        ms: 64,
        result: {
          stdout: ` 1  router.get('/sessions/:id/export', async (req, res) => {
 2    const sessionId = req.params.id
 3    // tenant is resolved by the auth middleware, never by the caller
 4    const tenantId = req.auth.tenantId
 5    const body = await exportOnce(sessionId, () => buildExport(sessionId))
 6    res.type('application/json').send(body)
 7  })`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'search',
        label: 'exportOnce|cacheKey|cache\\.',
        input: 'exportOnce|cacheKey|cache\\.',
        status: 'done',
        ms: 96,
        result: {
          stdout: `src/server/exportCache.ts:3:const cache = new Map<string, string>()
src/server/exportCache.ts:5:export function cacheKey(sessionId: string)
src/server/routes/export.ts:5:const body = await exportOnce(sessionId, …)
tests/export.test.ts:31:it('exports once', …)`,
        },
      },
    },
    {
      kind: 'text',
      text: `리뷰 결과: **request changes** — P1이 하나 있습니다. 캐시 키가 테넌트를 모릅니다.

**P1 · 보안 — 캐시 키에 테넌트 스코프가 없습니다** (\`exportCache.ts:6\`)
키는 \`sha1(sessionId) + ':' + Date.now()\`입니다. \`sessionId\`는 전역 유일하지 않고 라우트는 \`req.auth.tenantId\`로 범위를 좁혀 export합니다. A 테넌트가 B 테넌트의 \`sessionId\`를 알면(로그·에러 리포트·공유 링크에 흔합니다) 첫 요청 뒤 캐시에서 B의 export를 그대로 받습니다. **테넌트를 키의 일부로 넣고**, \`buildExport\` 결과가 아니라 \`buildExport(sessionId, tenantId)\`를 캐시하세요.

**P2 · 성능 — 캐시가 절대 맞지 않습니다** (\`exportCache.ts:6\`)
\`Date.now()\`가 키에 들어가서 요청마다 새 키가 나옵니다. 실측 히트율 0%. \`Date.now()\`는 TTL로 쓰고 싶었던 것으로 보이는데, 그렇다면 값에 만료 시각을 넣고 조회 시 비교해야 합니다.

**P3 · 메모리 — 상한이 없습니다** (\`exportCache.ts:3\`)
\`Map\`이 무한히 자랍니다. 실측 export 크기는 중앙값 1.8MB, 최대 26MB입니다. 세션 1,000개만 돌아도 2GB입니다. LRU(예: \`lru-cache\`, \`maxSize: 64MiB\`)로 바꾸고 \`maxAge\`를 명시하세요.

**P4 · 정합성 — 무효화 경로가 없습니다**
새 턴이 붙어도 캐시는 그대로입니다. \`turn.completed\`에서 \`cache.delete(key)\`를 호출하거나 TTL을 30초 이하로 두세요.

좋은 점: 라우트 변경이 1줄로 끝나고, \`exportOnce\`가 콜백을 받아 테스트가 쉽습니다. P1·P2만 고치면 머지 가능합니다.`,
    },
  ],
  usage: { inputTokens: 5210, outputTokens: 1180 },
};

/* ------------------------------------------------------------------ */
/* 03 — incident                                                       */
/* ------------------------------------------------------------------ */

const INCIDENT_LOG = `2026-11-18T14:02:11Z api-7d9c5f8b4-2xk9p [warn] webhook payload 512KB (limit none)
2026-11-18T14:02:11Z api-7d9c5f8b4-2xk9p [info] retry batch 41 → delivery queue depth 8,402
2026-11-18T14:03:47Z api-7d9c5f8b4-2xk9p [warn] heap used 486MiB / 512MiB
2026-11-18T14:04:02Z api-7d9c5f8b4-2xk9p [error] JavaScript heap out of memory
2026-11-18T14:04:03Z api-7d9c5f8b4-2xk9p [fatal] FATAL ERROR: Reached heap limit Allocation failed
2026-11-18T14:04:05Z api-7d9c5f8b4-2xk9p [info] readiness probe failed (3/3) — removed from endpoints
2026-11-18T14:04:11Z api-7d9c5f8b4-7q2mn [error] upstream 502 from api (connection reset)`;

const INCIDENT_PLAN = `## 웹훅 재시도 폭주 핫픽스

1. **본문 상한** — \`POST /webhooks/:vendor\`에서 본문을 256KB로 제한하고 초과분은 413으로 끊습니다(프록시 \`client_max_body_size\`도 함께).
2. **큐 상한 + 백프레셔** — 재시도 큐를 1,000건으로 제한하고 가득 차면 429로 되돌려 보내 재시도를 분산시킵니다.
3. **메모리 상한 명시** — 컨테이너 limit을 768MiB로, \`--max-old-space-size=640\`으로 맞춰 OOM 전에 GC가 먼저 돌게 합니다.
4. **카나리 + 롤백** — 5% 트래픽으로 10분 관찰, \`heap_used\`와 \`queue_depth\`가 임계치를 넘으면 이전 리비전으로 자동 롤백합니다.

변경 예상 파일: \`src/api/webhooks.ts\`, \`src/queue/retry.ts\`, \`k8s/api.yaml\`

리스크: 429를 도입하면 벤더가 재시도를 포기할 수 있습니다 — 서명 검증된 이벤트는 DLQ에 남겨 수동 재처리 경로를 먼저 확인해야 합니다.`;

const incident: Scenario = {
  id: 'incident',
  index: '03',
  label: 'incident',
  title: '프로덕션 502 · OOM 추적',
  summary: '죽은 파드의 로그와 메트릭을 시간순으로 맞춰 원인을 특정하고, 승인하면 핫픽스까지 적용합니다.',
  prompt:
    '프로덕션에서 10분간 502가 5% 발생했고 api 파드 3개가 OOMKilled 됐어. 로그와 메트릭으로 원인을 특정하고 핫픽스 계획을 보여 줘. 승인하면 바로 적용해.',
  tools: ['Bash', 'Fetch', 'Grep', 'Edit'],
  beats: [
    {
      kind: 'text',
      text: '먼저 죽은 파드의 마지막 로그와 이벤트를 시간순으로 맞춥니다. 502는 원인이 아니라 결과라서, 파드가 엔드포인트에서 빠진 시각을 기준으로 봅니다.',
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'kubectl logs -p deploy/api --since=30m | tail -8',
        input: 'kubectl logs -p deploy/api --since=30m | tail -8',
        status: 'done',
        ms: 1520,
        result: { stdout: INCIDENT_LOG, exitCode: 0 },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'kubectl get events --sort-by=.lastTimestamp | grep -i oom',
        input: "kubectl get events --sort-by=.lastTimestamp | grep -i oom",
        status: 'done',
        ms: 880,
        result: {
          stdout: `14m  Warning  OOMKilling   pod/api-7d9c5f8b4-2xk9p  Memory limit 512Mi exceeded
14m  Warning  OOMKilling   pod/api-7d9c5f8b4-7q2mn  Memory limit 512Mi exceeded
13m  Warning  Unhealthy    pod/api-7d9c5f8b4-9lv8s  Readiness probe failed: 503`,
          exitCode: 0,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'fetch',
        label: 'grafana: api rss / queue depth / 5xx (30m)',
        input: 'GET https://grafana.internal/api/ds/query?panel=api-overview&from=-30m',
        status: 'done',
        ms: 410,
        result: {
          stdout: `time      rss_MiB  queue_depth  5xx_pct   ingress_rps
14:00      184        612        0.1       210
14:02      312      8,402        0.4       212
14:04      511      9,118        5.2       211
14:06      168      1,204       11.8       208   (pods restarting)
14:09      191         88        0.3       209   (after restart)
peak webhook body 512KB · retry batch ×41 · deploy rev 7d9c5f8b4 (2h ago, config-only)`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'search',
        label: 'webhook|retry|body limit',
        input: 'webhook|retry|body limit',
        status: 'done',
        ms: 140,
        result: {
          stdout: `src/api/webhooks.ts:14:router.post('/webhooks/:vendor', async (req, res) => {
src/api/webhooks.ts:15:  const raw = await readBody(req)            // no size cap
src/queue/retry.ts:22:  while (batch.length) { await deliver(batch); }   // no cap, no backoff
src/queue/retry.ts:41:  retryQueue.push(...batch)                          // unbounded array
k8s/api.yaml:27:  resources.limits.memory: 512Mi`,
        },
      },
    },
    {
      kind: 'text',
      text: `원인을 특정했습니다. **무제한 재시도 큐 + 무제한 본문 버퍼가 512MiB 힙을 채웠고, readiness 실패가 502로 번졌습니다.** 배포(2시간 전)는 config-only라 코드는 그대로입니다 — 트래픽 쪽 방아쇠입니다.

1. **방아쇠 (14:02)** — 벤더가 실패한 웹훅 배치 41개를 재전송했습니다. 본문이 512KB이고 \`readBody\`에 상한이 없어 요청마다 버퍼가 힙에 남습니다.
2. **증폭 (14:02–14:04)** — \`retryQueue\`가 \`push\`만 하고 상한이 없습니다. 큐 깊이가 612 → 9,118로 15배가 되는 동안 재시도 루프가 같은 배치를 다시 읽습니다(백오프 없음).
3. **OOM (14:04)** — rss 511MiB에서 \`heap limit\`. kubelet이 3개 파드를 죽입니다.
4. **502 (14:04–14:09)** — 남은 파드의 readiness가 3/3 실패해 엔드포인트에서 빠지고, 게이트웨이가 502를 냅니다. 재시작 뒤 큐가 비며 5xx가 0.3%로 내려갔습니다.

핫픽스 계획을 올립니다. 승인하면 코드와 매니페스트를 고치고 카나리까지 준비합니다.`,
    },
  ],
  plan: { title: '웹훅 재시도 폭주 핫픽스', content: INCIDENT_PLAN },
  after: [
    {
      kind: 'tool',
      tool: {
        kind: 'edit',
        label: 'src/queue/retry.ts',
        input: 'src/queue/retry.ts',
        status: 'done',
        ms: 196,
        result: {
          diff: `--- a/src/queue/retry.ts
+++ b/src/queue/retry.ts
@@ -18,7 +18,11 @@ const QUEUE_LIMIT = 1000
-  while (batch.length) { await deliver(batch); }
+  while (batch.length) {
+    if (retryQueue.length >= QUEUE_LIMIT) {
+      metrics.inc('retry.queue_full')
+      throw new BackpressureError('queue full — 429 to vendor')
+    }
+    await deliver(batch)
+    await sleep(backoff(jitter(attempt)))
+  }`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'edit',
        label: 'src/api/webhooks.ts',
        input: 'src/api/webhooks.ts',
        status: 'done',
        ms: 142,
        result: {
          diff: `--- a/src/api/webhooks.ts
+++ b/src/api/webhooks.ts
@@ -12,7 +12,10 @@
 router.post('/webhooks/:vendor', async (req, res) => {
-  const raw = await readBody(req)
+  const raw = await readBody(req, { maxBytes: 256 * 1024 })
+  if (!raw) return res.status(413).json({ error: 'payload too large' })`,
        },
      },
    },
    {
      kind: 'tool',
      tool: {
        kind: 'shell',
        label: 'npm test -- tests/retry.test.ts tests/webhooks.test.ts',
        input: 'npm test -- tests/retry.test.ts tests/webhooks.test.ts',
        status: 'done',
        ms: 1620,
        result: {
          stdout: ` ✓ tests/retry.test.ts (9 tests) 704ms
   ✓ 429s when the queue is full
   ✓ backs off between attempts
 ✓ tests/webhooks.test.ts (8 tests) 612ms
   ✓ rejects a body over 256KB with 413

 Test Files  2 passed (2)
      Tests  17 passed (17)`,
          exitCode: 0,
        },
      },
    },
    {
      kind: 'text',
      text: `핫픽스를 적용하고 검증했습니다.

- \`src/queue/retry.ts\` — 큐 1,000건 상한, 가득 차면 \`429\`로 되돌려 재시도를 분산. 시도 사이 지수 백오프 + 지터.
- \`src/api/webhooks.ts\` — 본문 256KB 상한, 초과분 \`413\`.
- 테스트 17개 통과(새 4개 포함). \`npx tsc --noEmit\`은 다음 단계에서 돌립니다.

배포 순서:
1. \`k8s/api.yaml\` — limit 768MiB / \`--max-old-space-size=640\` (이건 리뷰가 필요해 커밋만 준비)
2. 카나리 5% → 10분 관찰: \`heap_used < 60%\`, \`queue_depth < 200\`, 5xx < 0.5%
3. 임계치 초과 시 \`kubectl rollout undo deploy/api\`

주의: 429를 받은 벤더가 재시도를 포기할 수 있습니다. 서명 검증된 이벤트를 DLQ에 남기는 경로는 아직 없어서, 배포 전에 \`retry.dead_letter\` 설정을 확인해야 합니다.`,
    },
  ],
  usage: { inputTokens: 6140, outputTokens: 1420 },
};

export const SCENARIOS: Scenario[] = [refactor, prReview, incident];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

export function isScenarioId(id: string): id is ScenarioId {
  return SCENARIOS.some((scenario) => scenario.id === id);
}

/** Every tool a scenario touches, in first-use order — the card's badges. */
export function scenarioToolNames(scenario: Scenario): string[] {
  const names: string[] = [];
  for (const beat of [...scenario.beats, ...(scenario.after ?? [])]) {
    if (beat.kind !== 'tool') continue;
    const name = beat.tool.name ?? beat.tool.kind;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** True when a scenario parks a plan, i.e. approving it runs `after`. */
export function scenarioHasPlan(scenario: Scenario): boolean {
  return !!scenario.plan && (scenario.after?.length ?? 0) > 0;
}
