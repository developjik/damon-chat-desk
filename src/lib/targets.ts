/**
 * Provider/model routing helpers: how a target is named, keyed, grouped,
 * and how a reply's cost is summarised. Pure functions — the UI and the
 * transports both read routes from here so a label can never drift from
 * the thing that is actually called.
 */

import type { RouteTarget, Usage } from './types';

/** Stable key for a route — no transport in it, so demo and live agree. */
export function targetKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

export function makeTarget(input: {
  provider: string;
  providerLabel?: string;
  model: string;
  modelLabel?: string;
  source?: 'backend' | 'model';
  available?: boolean;
}): RouteTarget {
  return {
    key: targetKey(input.provider, input.model),
    provider: input.provider,
    providerLabel: input.providerLabel ?? input.provider,
    model: input.model,
    modelLabel: input.modelLabel ?? input.model,
    source: input.source ?? 'model',
    available: input.available ?? true,
  };
}

/** Vendor guessed from an OpenAI-compatible model id, for provider grouping. */
export function vendorOfModel(model: string): { id: string; label: string } {
  const id = model.toLowerCase();
  if (id.startsWith('claude')) return { id: 'anthropic', label: 'Anthropic' };
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('chatgpt'))
    return { id: 'openai', label: 'OpenAI' };
  if (id.startsWith('gemini')) return { id: 'google', label: 'Google' };
  if (id.startsWith('grok')) return { id: 'xai', label: 'xAI' };
  if (id.startsWith('qwen') || id.startsWith('qwq')) return { id: 'alibaba', label: 'Alibaba' };
  if (id.startsWith('deepseek')) return { id: 'deepseek', label: 'DeepSeek' };
  if (id.startsWith('mistral') || id.startsWith('codestral')) return { id: 'mistral', label: 'Mistral' };
  if (id.startsWith('llama') || id.startsWith('codellama')) return { id: 'meta', label: 'Meta' };
  if (id.startsWith('kimi') || id.startsWith('moonshot')) return { id: 'moonshot', label: 'Moonshot' };
  if (id.startsWith('glm') || id.startsWith('zai')) return { id: 'zai', label: 'Z.ai' };
  if (id.includes('local') || id.includes('lmstudio') || id.includes('llama.cpp'))
    return { id: 'local', label: 'Local' };
  const head = id.split(/[-/:]/)[0] || 'custom';
  return { id: head, label: head.charAt(0).toUpperCase() + head.slice(1) };
}

export interface OpenAIModel {
  id: string;
  owned_by?: string;
}

/** Group `/v1/models` entries into provider-qualified routes. */
export function targetsFromModels(models: OpenAIModel[]): RouteTarget[] {
  const seen = new Set<string>();
  const out: RouteTarget[] = [];
  for (const model of models) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const vendor = vendorOfModel(model.id);
    out.push(
      makeTarget({
        provider: vendor.id,
        providerLabel: vendor.label,
        model: model.id,
        source: 'model',
      }),
    );
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** Group `/v1/models` models by vendor (for the grouped picker). */
export function groupTargets(targets: RouteTarget[]): Array<{ provider: string; label: string; targets: RouteTarget[] }> {
  const map = new Map<string, { provider: string; label: string; targets: RouteTarget[] }>();
  for (const target of targets) {
    const bucket = map.get(target.provider);
    if (bucket) bucket.targets.push(target);
    else map.set(target.provider, { provider: target.provider, label: target.providerLabel, targets: [target] });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Compare mode sends the same prompt to two *different* routes. */
export function canCompare(targets: RouteTarget[]): boolean {
  if (targets.length < 2) return false;
  const [a, b] = targets;
  return a.key !== b.key;
}

/** Compact "provider · model" label used in bubbles and menus. */
export function routeLabel(target: RouteTarget): string {
  return `${target.providerLabel} · ${target.modelLabel}`;
}

export function firstTokenMs(slot: { startedAt: number; firstTokenAt?: number }): number | undefined {
  if (!slot.firstTokenAt) return undefined;
  return Math.max(0, slot.firstTokenAt - slot.startedAt);
}

export function elapsedMs(slot: { startedAt: number; endedAt?: number; firstTokenAt?: number }, now = Date.now()): number {
  const end = slot.endedAt ?? now;
  return Math.max(0, end - slot.startedAt);
}

export function formatMs(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** Rough token count when the transport reports no usage (≈4 chars/token). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const words = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(cjk > 0 ? cjk : 0, Math.ceil(words * 1.33)) + Math.ceil(cjk / 2);
}

export function formatTokens(count?: number): string {
  if (count === undefined) return '—';
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

/** tokens/sec over the streaming window, once the reply has started. */
export function tokensPerSecond(count?: number, windowMs?: number): number | undefined {
  if (!count || !windowMs || windowMs < 250) return undefined;
  return (count / windowMs) * 1000;
}

export function usageSummary(usage?: Usage, opts: { omitOutput?: boolean } = {}): string[] {
  if (!usage) return [];
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined && !opts.omitOutput) parts.push(`out ${formatTokens(usage.outputTokens)}`);
  if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (usage.contextUsed !== undefined && usage.contextWindow) {
    parts.push(`ctx ${formatTokens(usage.contextUsed)}/${formatTokens(usage.contextWindow)}`);
  }
  return parts;
}
