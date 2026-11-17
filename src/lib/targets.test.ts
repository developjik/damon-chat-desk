import { describe, expect, it } from 'vitest';
import {
  canCompare,
  estimateTokens,
  firstTokenMs,
  formatMs,
  formatTokens,
  groupTargets,
  makeTarget,
  tokensPerSecond,
  targetsFromModels,
  usageSummary,
  vendorOfModel,
} from './targets';

describe('vendorOfModel', () => {
  it('recognises the vendors an OpenAI-compatible server can expose', () => {
    expect(vendorOfModel('claude-sonnet-4-5').id).toBe('anthropic');
    expect(vendorOfModel('gpt-5-codex').id).toBe('openai');
    expect(vendorOfModel('o3-mini').id).toBe('openai');
    expect(vendorOfModel('gemini-2.5-pro').id).toBe('google');
    expect(vendorOfModel('qwen3-coder-plus').id).toBe('alibaba');
    expect(vendorOfModel('deepseek-coder').id).toBe('deepseek');
    expect(vendorOfModel('llama-3.3-70b').id).toBe('meta');
    expect(vendorOfModel('my-finetune').label).toBe('My');
  });
});

describe('targetsFromModels / groupTargets', () => {
  it('builds unique routes grouped by vendor', () => {
    const routes = targetsFromModels([
      { id: 'gpt-5-codex' },
      { id: 'claude-sonnet-4-5' },
      { id: 'gpt-5-codex' },
      { id: '' },
    ]);
    expect(routes).toHaveLength(2);
    const groups = groupTargets(routes);
    expect(groups.map((group) => group.label)).toEqual(['Anthropic', 'OpenAI']);
    expect(groups[1].targets[0].model).toBe('gpt-5-codex');
  });

  it('keys a route by provider and model only', () => {
    const a = makeTarget({ provider: 'claude', model: 'sonnet' });
    const b = makeTarget({ provider: 'claude', model: 'sonnet', source: 'backend' });
    expect(a.key).toBe(b.key);
  });
});

describe('canCompare', () => {
  it('refuses identical routes', () => {
    const a = makeTarget({ provider: 'claude', model: 'sonnet' });
    const b = makeTarget({ provider: 'claude', model: 'sonnet' });
    const c = makeTarget({ provider: 'codex', model: 'gpt-5-codex' });
    expect(canCompare([a, c])).toBe(true);
    expect(canCompare([a, b])).toBe(false);
    expect(canCompare([a])).toBe(false);
  });
});

describe('metrics formatting', () => {
  it('formats latency and tokens', () => {
    expect(formatMs(420)).toBe('420ms');
    expect(formatMs(1520)).toBe('1.52s');
    expect(formatMs(undefined)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1240)).toBe('1.2k');
    expect(formatTokens(24000)).toBe('24k');
  });

  it('computes time to first token and throughput', () => {
    expect(firstTokenMs({ startedAt: 1000, firstTokenAt: 1642 })).toBe(642);
    expect(firstTokenMs({ startedAt: 1000 })).toBeUndefined();
    expect(tokensPerSecond(300, 5000)).toBeCloseTo(60);
    expect(tokensPerSecond(300, 100)).toBeUndefined();
  });

  it('estimates tokens for latin and CJK text', () => {
    expect(estimateTokens('hello world')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('안녕하세요')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('summarises usage for the bubble footer', () => {
    expect(usageSummary({ inputTokens: 118, outputTokens: 312, costUsd: 0.0118 })).toEqual([
      'in 118',
      'out 312',
      '$0.0118',
    ]);
    expect(usageSummary({ contextUsed: 1200, contextWindow: 200000 })).toEqual(['ctx 1.2k/200k']);
    expect(usageSummary(undefined)).toEqual([]);
  });
});
