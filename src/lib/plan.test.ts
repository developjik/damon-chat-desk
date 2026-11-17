import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  parsePlanFiles,
  parsePlanRisks,
  parsePlanSteps,
  planDecisionLabel,
  planStatusFor,
  planTitleOf,
  splitStep,
} from './plan';

const PLAN = `## 스트리밍 클라이언트 구현 계획

1. **계약 고정** — 요청/응답 스키마와 에러 코드를 먼저 못 박습니다.
2. **얇은 경로** — 프롬프트 → 스트림 → 렌더 한 줄기만 연결합니다.
   취소는 AbortController로 fetch까지 전파합니다.
3. **상태 이전** — 세션과 메모리를 데몬으로 옮깁니다.

변경 예상 파일: \`src/lib/desk.ts\`, \`src/lib/types.ts\`, \`src/components/Transcript.tsx\`

리스크: 3번을 미루면 비교 모드가 서로 다른 진실을 그리게 됩니다.
트레이드오프: 세션 저장이 늦어지면 두 번째 서피스에서 이어갈 수 없습니다.
`;

describe('parsePlanSteps', () => {
  it('reads a numbered plan into steps with their follow-up lines', () => {
    const steps = parsePlanSteps(PLAN);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ title: '계약 고정', detail: '요청/응답 스키마와 에러 코드를 먼저 못 박습니다.' });
    expect(steps[1].detail).toContain('AbortController');
  });

  it('reads `N단계` prose as steps', () => {
    const steps = parsePlanSteps('**1단계 — 계약 고정.** 스키마를 먼저 정합니다.\n\n**2단계 — 얇은 경로.** 렌더까지 한 줄기.');
    expect(steps.map((step) => step.title)).toEqual(['계약 고정', '얇은 경로']);
    expect(steps[0].detail).toContain('스키마');
  });

  it('falls back to headings, then to the first paragraph', () => {
    const headed = parsePlanSteps('## 계약\n본문\n## 구현\n본문');
    expect(headed.map((step) => step.title)).toEqual(['계약', '구현']);
    const prose = parsePlanSteps('그냥 한 문단짜리 계획입니다.');
    expect(prose).toHaveLength(1);
    expect(prose[0].title).toContain('한 문단');
  });

  it('returns nothing for an empty plan', () => {
    expect(parsePlanSteps('   ')).toEqual([]);
  });
});

describe('splitStep', () => {
  it('splits a bold title from its sentence', () => {
    expect(splitStep('**1. 계약 고정.** 스키마를 못 박습니다.')).toEqual({
      title: '계약 고정',
      detail: '스키마를 못 박습니다.',
    });
  });

  it('keeps a long single line whole', () => {
    const step = splitStep('아주 긴 설명이 제목 자리에 오는 경우에는 자르지 않고 그대로 둡니다');
    expect(step.title.length).toBeGreaterThan(10);
  });
});

describe('parsePlanFiles', () => {
  it('collects paths once, in order, and ignores prose words', () => {
    const files = parsePlanFiles(PLAN);
    expect(files).toEqual(['src/lib/desk.ts', 'src/lib/types.ts', 'src/components/Transcript.tsx']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`).join(' ');
    expect(parsePlanFiles(many)).toHaveLength(8);
  });
});

describe('parsePlanRisks', () => {
  it('keeps the risk and tradeoff lines', () => {
    const risks = parsePlanRisks(PLAN);
    expect(risks).toHaveLength(2);
    expect(risks[0]).toContain('서로 다른 진실');
  });

  it('finds nothing in a risk-free plan', () => {
    expect(parsePlanRisks('1. 스키마 고정\n2. 렌더')).toEqual([]);
  });
});

describe('buildPlan', () => {
  it('structures the plan and keeps the raw text', () => {
    const plan = buildPlan({ requestId: 'req-1', planId: 'plan-9', revision: 2, content: PLAN });
    expect(plan.id).toBe('req-1');
    expect(plan.planId).toBe('plan-9');
    expect(plan.revision).toBe(2);
    expect(plan.title).toBe('스트리밍 클라이언트 구현 계획');
    expect(plan.steps).toHaveLength(3);
    expect(plan.files.length).toBe(3);
    expect(plan.status).toBe('awaiting_review');
    expect(plan.content).toContain('얇은 경로');
  });

  it('falls back to a readable title', () => {
    expect(planTitleOf('구현 계획을 정리했습니다.')).toContain('구현 계획');
    expect(planTitleOf('')).toBe('계획 검토');
  });
});

describe('decision mapping', () => {
  it('maps each decision to the card status', () => {
    expect(planStatusFor('approve', 'approved')).toBe('approved');
    expect(planStatusFor('request_changes', 'changes_requested')).toBe('changes_requested');
    expect(planStatusFor('defer', 'deferred')).toBe('deferred');
    expect(planDecisionLabel('awaiting_review')).toBe('awaiting review');
    expect(planDecisionLabel('changes_requested')).toBe('changes requested');
  });
});
