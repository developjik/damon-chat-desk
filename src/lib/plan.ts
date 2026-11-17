/**
 * Plan review.
 *
 * A `kind: plan` permission ask (claude's ExitPlanMode) arrives with the
 * plan text in `input.plan`. The card should show what the agent
 * actually proposes — steps, the files it will touch, the risks it
 * admitted — instead of a wall of prose with two buttons under it.
 *
 * This module does that read once, and maps a decision back to the
 * status `plan.respond` reports.
 */

import type { PlanDecision, PlanRequest, PlanStatus, PlanStep } from './types';

const MAX_STEPS = 8;
const MAX_DETAIL = 420;
/** A step body ends where the plan's own footnotes begin. */
const META_LINE = /^(?:변경|수정|예상|파일|리스크|위험|주의|files?|changes?|risks?|notes?)\b/i;

/** Drop list markers and emphasis, keep the words. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+|>\s*)/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

interface StepHead {
  line: number;
  text: string;
}

function stepHeads(lines: string[]): StepHead[] {
  const numbered: StepHead[] = [];
  const headings: StepHead[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^\d+[.)]\s+\S/.test(trimmed) || /^(?:\*\*)?\d+단계/.test(trimmed)) {
      numbered.push({ line: index, text: trimmed });
      return;
    }
    if (/^#{2,4}\s+\S/.test(trimmed)) headings.push({ line: index, text: trimmed });
  });
  // A numbered plan is the plan; headings are only the fallback when the
  // agent wrote prose sections instead.
  return numbered.length > 0 ? numbered : headings;
}

/** `**1단계 — 계약 고정.** 응답 스키마를 못 박습니다.` → title + detail */
export function splitStep(raw: string): PlanStep {
  let text = stripMarkdown(raw)
    .replace(/^#{2,4}\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\d+단계\s*[—:-]?\s*/, '');
  let detail: string | undefined;

  const dash = text.split(/\s+[—–-]\s+/);
  if (dash.length > 1 && dash[0].length <= 48) {
    text = dash[0];
    detail = dash.slice(1).join(' — ');
  } else {
    const sentence = text.match(/^(.{4,48}?)[.:]\s+(.+)$/);
    if (sentence) {
      text = sentence[1];
      detail = sentence[2];
    }
  }

  return {
    title: text.length > 90 ? `${text.slice(0, 89)}…` : text,
    detail: detail ? (detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail) : undefined,
  };
}

export function parsePlanSteps(content: string): PlanStep[] {
  const lines = content.split('\n');
  const heads = stepHeads(lines);
  if (heads.length === 0) {
    const paragraph = content
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith('```'));
    return paragraph ? [splitStep(paragraph)] : [];
  }

  const steps: PlanStep[] = [];
  for (let index = 0; index < heads.length && steps.length < MAX_STEPS; index += 1) {
    const head = heads[index];
    const next = heads[index + 1]?.line ?? lines.length;
    // A step's detail is its own paragraph, not the plan's footnotes: stop
    // at a blank line or at the first files/risks line.
    const tail: string[] = [];
    for (const line of lines.slice(head.line + 1, next)) {
      if (line.trim() === '') break;
      const cleaned = stripMarkdown(line);
      if (!cleaned) continue;
      if (META_LINE.test(cleaned)) break;
      tail.push(cleaned);
    }
    const step = splitStep(head.text);
    const extra = tail.join(' ');
    if (extra) {
      const merged = step.detail ? `${step.detail} ${extra}` : extra;
      step.detail = merged.length > MAX_DETAIL ? `${merged.slice(0, MAX_DETAIL)}…` : merged;
    }
    steps.push(step);
  }
  return steps;
}

const FILE_PATTERN = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|json|md|css|scss|rs|py|toml|ya?ml|sh|html|sql|go|java|kt|swift))(?=$|[\s`'",):])/g;

export function parsePlanFiles(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(FILE_PATTERN)) {
    const path = match[1];
    if (!path || found.includes(path)) continue;
    found.push(path);
    if (found.length >= 8) break;
  }
  return found;
}

const RISK_PATTERN = /위험|리스크|주의|문제는|risk|trade-?off|트레이드오프|제약/i;

export function parsePlanRisks(content: string): string[] {
  const risks: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !RISK_PATTERN.test(trimmed)) continue;
    const text = stripMarkdown(trimmed).replace(/^[-—:]\s*/, '');
    if (!text || risks.includes(text)) continue;
    risks.push(text.length > 180 ? `${text.slice(0, 179)}…` : text);
    if (risks.length >= 4) break;
  }
  return risks;
}

export function planTitleOf(content: string): string {
  const heading = content.split('\n').find((line) => /^#{1,4}\s+\S/.test(line.trim()));
  if (heading) {
    const title = stripMarkdown(heading);
    if (title) return title;
  }
  const first = content.split('\n').find((line) => line.trim().length > 0);
  const flat = stripMarkdown(first ?? '').replace(/\s+/g, ' ');
  if (!flat) return '계획 검토';
  return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
}

export interface BuildPlanInput {
  requestId: string;
  content: string;
  title?: string;
  planId?: string;
  revision?: number;
}

export function buildPlan(input: BuildPlanInput): PlanRequest {
  const content = input.content.trim();
  return {
    id: input.requestId,
    planId: input.planId,
    revision: input.revision,
    title: input.title?.trim() || planTitleOf(content),
    content,
    steps: parsePlanSteps(content),
    files: parsePlanFiles(content),
    risks: parsePlanRisks(content),
    status: 'awaiting_review',
  };
}

/** `plan.respond` decision → the status the card shows. */
export function planStatusFor(decision: PlanDecision, reported?: string): PlanStatus {
  switch (decision) {
    case 'approve':
      return 'approved';
    case 'request_changes':
      return 'changes_requested';
    case 'defer':
      return 'deferred';
    default:
      return reported === 'approved' || reported === 'changes_requested' || reported === 'deferred'
        ? reported
        : 'awaiting_review';
  }
}

export function planDecisionLabel(status: PlanStatus): string {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes requested';
    case 'deferred':
      return 'deferred';
    case 'expired':
      return 'expired';
    case 'error':
      return 'failed';
    default:
      return 'awaiting review';
  }
}
