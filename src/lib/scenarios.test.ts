import { describe, expect, it } from 'vitest';
import { SCENARIOS, isScenarioId, scenarioById, scenarioHasPlan, scenarioToolNames } from './scenarios';
import { buildPlan } from './plan';

describe('scenarios', () => {
  it('ships the three real-work runs, each with a distinct id', () => {
    expect(SCENARIOS).toHaveLength(3);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(3);
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual(['refactor', 'pr-review', 'incident']);
    for (const scenario of SCENARIOS) {
      expect(scenario.prompt.length).toBeGreaterThan(40);
      expect(scenario.tools.length).toBeGreaterThan(1);
      expect(scenario.usage.inputTokens).toBeGreaterThan(0);
    }
  });

  it('plays prose and tool calls in every run', () => {
    for (const scenario of SCENARIOS) {
      const kinds = new Set(scenario.beats.map((beat) => beat.kind));
      expect(kinds.has('text')).toBe(true);
      expect(kinds.has('tool')).toBe(true);
      const tools = scenario.beats.filter((beat) => beat.kind === 'tool');
      expect(tools.length).toBeGreaterThanOrEqual(2);
      for (const beat of tools) {
        if (beat.kind !== 'tool') continue;
        expect(beat.tool.ms).toBeGreaterThan(0);
        expect(beat.tool.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('parks a plan on the risky runs and continues only when approved', () => {
    expect(scenarioHasPlan(scenarioById('refactor')!)).toBe(true);
    expect(scenarioHasPlan(scenarioById('incident')!)).toBe(true);
    expect(scenarioHasPlan(scenarioById('pr-review')!)).toBe(false);
    for (const id of ['refactor', 'incident']) {
      const scenario = scenarioById(id)!;
      expect(scenario.plan?.content).toContain('리스크');
      expect((scenario.after ?? []).length).toBeGreaterThan(0);
    }
  });

  it('writes plans the plan card can structure', () => {
    for (const scenario of SCENARIOS) {
      if (!scenario.plan) continue;
      const plan = buildPlan({ requestId: `req-${scenario.id}`, content: scenario.plan.content, title: scenario.plan.title });
      expect(plan.steps.length).toBeGreaterThanOrEqual(3);
      expect(plan.files.length).toBeGreaterThan(0);
      expect(plan.risks.length).toBeGreaterThan(0);
      expect(plan.title).toBe(scenario.plan.title);
    }
  });

  it('lists the tool vocabulary of a run', () => {
    expect(scenarioToolNames(scenarioById('refactor')!)).toEqual(['read', 'search', 'edit', 'write', 'shell']);
    expect(scenarioToolNames(scenarioById('pr-review')!)).toEqual(['shell', 'read', 'search']);
  });

  it('resolves ids without inventing one', () => {
    expect(isScenarioId('refactor')).toBe(true);
    expect(isScenarioId('nope')).toBe(false);
    expect(scenarioById('nope')).toBeUndefined();
  });
});
