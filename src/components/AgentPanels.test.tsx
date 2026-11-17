import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanCard } from './PlanCard';
import { ToolViewer } from './ToolViewer';
import { buildPlan } from '../lib/plan';
import { mergeToolCall, normalizeToolCall } from '../lib/tools';
import type { ToolCall } from '../lib/types';

const shell = mergeToolCall(
  normalizeToolCall(
    { call_id: 'call-1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test -- --run' } },
    1_000,
  ),
  normalizeToolCall(
    {
      call_id: 'call-1',
      name: 'Bash',
      status: 'completed',
      detail: { type: 'shell', command: 'npm test -- --run', output: '6 passed', exit_code: 0 },
    },
    2_280,
  ),
);

const failing: ToolCall = normalizeToolCall(
  {
    call_id: 'call-2',
    name: 'Bash',
    status: 'failed',
    detail: { type: 'shell', command: 'npm run lint', output: '1 error', exit_code: 1 },
  },
  1_000,
);

const edit = normalizeToolCall(
  {
    call_id: 'call-3',
    name: 'Edit',
    status: 'completed',
    detail: { type: 'edit', path: 'src/lib/sse.ts', unified_diff: '--- a/src/lib/sse.ts\n+++ b/src/lib/sse.ts\n-old\n+new' },
  },
  1_000,
);

const PLAN = `## 스트리밍 클라이언트 구현 계획

1. **계약 고정** — 스키마를 먼저 못 박습니다.
2. **얇은 경로** — 프롬프트 → 스트림 → 렌더.

변경 예상 파일: \`src/lib/desk.ts\`

리스크: 상태를 UI에 두면 두 번째 서피스가 갈라집니다.
`;

describe('ToolViewer', () => {
  it('renders one collapsed row per call with its status and duration', () => {
    const markup = renderToStaticMarkup(<ToolViewer calls={[shell, failing, edit]} now={3_000} />);
    expect(markup).toContain('tools');
    expect(markup).toContain('1.28s');
    expect(markup).toContain('done');
    expect(markup).toContain('failed');
    expect(markup).toContain('1 failed'); // summary line counts
    // rows are <details> so the argument and result stay one click away
    expect(markup.match(/<details/g)?.length).toBe(3);
    expect(markup).toContain('npm test -- --run');
    expect(markup).toContain('src/lib/sse.ts');
  });

  it('keeps the input and result inside the row body', () => {
    const markup = renderToStaticMarkup(<ToolViewer calls={[shell, edit]} now={3_000} />);
    expect(markup).toContain('stdout');
    expect(markup).toContain('6 passed');
    expect(markup).toContain('diff');
    expect(markup).toContain('diff-line add');
    expect(markup).toContain('exit 0');
  });

  it('draws a running call without a duration', () => {
    const running = normalizeToolCall(
      { call_id: 'r1', name: 'Read', status: 'running', detail: { type: 'read', path: 'a.ts' } },
      1_000,
    );
    const markup = renderToStaticMarkup(<ToolViewer calls={[running]} now={2_000} />);
    expect(markup).toContain('running');
    expect(markup).toContain('pulse');
  });

  it('renders nothing without calls', () => {
    expect(renderToStaticMarkup(<ToolViewer calls={[]} now={0} />)).toBe('');
  });
});

describe('PlanCard', () => {
  const plan = buildPlan({ requestId: 'req-1', planId: 'plan-abc123456789', revision: 2, content: PLAN });

  it('shows the structured plan and the three decisions while pending', () => {
    const markup = renderToStaticMarkup(<PlanCard plan={plan} onDecide={() => undefined} />);
    expect(markup).toContain('plan');
    expect(markup).toContain('r2');
    expect(markup).toContain('awaiting review');
    expect(markup).toContain('계약 고정');
    expect(markup).toContain('src/lib/desk.ts');
    expect(markup).toContain('approve');
    expect(markup).toContain('request changes');
    expect(markup).toContain('defer');
    expect(markup).toContain('raw plan');
  });

  it('replaces the actions with the decision once it is settled', () => {
    const decided = { ...plan, status: 'approved' as const, decidedAt: 1_700_000_000_000 };
    const markup = renderToStaticMarkup(<PlanCard plan={decided} onDecide={() => undefined} />);
    expect(markup).toContain('plan-status mono approved');
    expect(markup).not.toContain('approve</button>');
  });

  it('keeps the feedback that went to the agent', () => {
    const revised = { ...plan, status: 'changes_requested' as const, feedback: '3번을 먼저 합시다' };
    const markup = renderToStaticMarkup(<PlanCard plan={revised} onDecide={() => undefined} />);
    expect(markup).toContain('changes requested');
    expect(markup).toContain('3번을 먼저 합시다');
  });

  it('surfaces a failed decision', () => {
    const failed = { ...plan, error: '다른 화면에서 먼저 결정되었습니다' };
    const markup = renderToStaticMarkup(<PlanCard plan={failed} onDecide={() => undefined} />);
    expect(markup).toContain('plan-error');
    expect(markup).toContain('다른 화면에서');
  });
});
