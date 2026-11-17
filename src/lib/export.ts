/**
 * Conversation export — Markdown for reading, JSON for data.
 *
 * Both builders read the same desk state: every turn, every reply slot
 * (compare turns hold two), the tool calls folded into each slot with
 * their stdout/diff/exit code, steering notes, and the parked plan. The
 * export is the transcript the user is looking at, not a re-query.
 */

import type { Conversation, MemoryEntry, ReplySlot, ToolCall, Usage } from './types';
import { elapsedMs, formatMs, formatTokens, routeLabel } from './targets';

export type ExportFormat = 'markdown' | 'json';

export interface ExportContext {
  transport?: string;
  version?: string;
  baseUrl?: string;
  exportedAt?: number;
  memory?: MemoryEntry[];
}

export interface ExportPayload {
  filename: string;
  mime: string;
  format: ExportFormat;
  content: string;
  /** Turns/slots/tools the file covers, for the toast. */
  stats: { messages: number; slots: number; tools: number; chars: number };
}

const FORMAT_VERSION = 'damon-chat-desk.conversation.v1';
/** A single stdout pane is clipped so one noisy build cannot dominate a file. */
const RESULT_CAP = 8000;

export function exportMime(format: ExportFormat): string {
  return format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8';
}

export function exportExtension(format: ExportFormat): 'md' | 'json' {
  return format === 'markdown' ? 'md' : 'json';
}

function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** `damon-<title-slug>-20261117-2340.md` — stable and sortable. */
export function exportFileName(conversation: Conversation, format: ExportFormat, at = new Date()): string {
  const slug = conversation.title
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `damon-${slug || 'conversation'}-${stamp}.${exportExtension(format)}`;
}

function iso(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toISOString();
}

export function conversationTotals(conversation: Conversation): {
  messages: number;
  slots: number;
  tools: number;
  runningTools: number;
  failedTools: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
} {
  let slots = 0;
  let tools = 0;
  let runningTools = 0;
  let failedTools = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let durationMs = 0;
  for (const message of conversation.messages) {
    for (const slot of message.slots ?? []) {
      slots += 1;
      inputTokens += slot.usage?.inputTokens ?? 0;
      outputTokens += slot.usage?.outputTokens ?? 0;
      costUsd += slot.usage?.costUsd ?? 0;
      durationMs += elapsedMs(slot, slot.endedAt ?? slot.startedAt);
      for (const tool of slot.tools ?? []) {
        tools += 1;
        if (tool.status === 'running') runningTools += 1;
        if (tool.status === 'error') failedTools += 1;
      }
    }
  }
  return {
    messages: conversation.messages.length,
    slots,
    tools,
    runningTools,
    failedTools,
    inputTokens,
    outputTokens,
    costUsd,
    durationMs,
  };
}

/* ------------------------------------------------------------------ */
/* markdown                                                            */
/* ------------------------------------------------------------------ */

/** A fence longer than any backtick run inside the text. */
export function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function code(text: string, language = ''): string {
  const body = text.replace(/\n+$/, '');
  const fence = fenceFor(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

function clip(text: string, cap = RESULT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (${text.length - cap}자 생략)`;
}

/** Table cells cannot hold a pipe or a newline. */
function cell(text: string, cap = 80): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

function toolTitle(tool: ToolCall): string {
  const parts = [tool.name || tool.kind, tool.label ? `· ${tool.label}` : ''].filter(Boolean);
  return parts.join(' ');
}

function toolResultBlock(tool: ToolCall, index: number): string[] {
  const lines: string[] = [];
  const result = tool.result;
  if (tool.input && tool.input !== tool.label) {
    lines.push(`- input: ${code(clip(tool.input))}`);
  }
  if (result?.stdout) lines.push(`- stdout`, '', code(clip(result.stdout), 'text'));
  if (result?.stderr) lines.push(`- stderr`, '', code(clip(result.stderr), 'text'));
  if (result?.diff) lines.push(`- diff`, '', code(clip(result.diff), 'diff'));
  if (result?.error) lines.push(`- error: ${result.error}`);
  if (result?.exitCode !== undefined && result.exitCode !== null) lines.push(`- exit: ${result.exitCode}`);
  if (lines.length === 0) {
    lines.push(`- (결과 없음) · call \`${tool.id}\``);
  }
  const took = elapsedMs(tool, tool.endedAt ?? tool.startedAt);
  const head = `#### tool ${index} — ${toolTitle(tool)} · ${tool.status} · ${formatMs(took)}`;
  return [head, '', ...lines, ''];
}

function slotHeading(slot: ReplySlot, index: number, total: number): string {
  const label = total > 1 ? `reply ${index + 1}/${total}` : 'reply';
  const route = `${slot.target.providerLabel} / ${slot.target.model || 'default'}`;
  return `${label} · ${route} · ${slot.status}`;
}

function slotMeta(slot: ReplySlot): string {
  const bits: string[] = [];
  if (slot.imported) bits.push('daemon history');
  else {
    bits.push(`took ${formatMs(elapsedMs(slot, slot.endedAt ?? slot.startedAt))}`);
    if (slot.firstTokenAt) bits.push(`ttft ${formatMs(slot.firstTokenAt - slot.startedAt)}`);
  }
  if (slot.usage?.inputTokens !== undefined) bits.push(`in ${formatTokens(slot.usage.inputTokens)}`);
  if (slot.usage?.outputTokens !== undefined) bits.push(`out ${formatTokens(slot.usage.outputTokens)}`);
  if (slot.usage?.costUsd !== undefined && slot.usage.costUsd > 0) bits.push(`$${slot.usage.costUsd.toFixed(4)}`);
  if (slot.daemonSessionId) bits.push(`session \`${slot.daemonSessionId}\``);
  return bits.join(' · ');
}

function slotMarkdown(slot: ReplySlot, index: number, total: number): string[] {
  const out: string[] = [];
  out.push(`### ${slotHeading(slot, index, total)}`, '');
  const meta = slotMeta(slot);
  if (meta) out.push(`> ${meta}`, '');
  if (slot.notice) out.push(`> ${slot.notice}`, '');
  if (slot.error) out.push(`> **error** — ${slot.error}`, '');
  if (slot.steers && slot.steers.length > 0) {
    out.push('#### steering');
    out.push('');
    for (const note of slot.steers) {
      out.push(`- \`${iso(note.at)}\` ${note.text} (${note.state}${note.error ? ` · ${note.error}` : ''})`);
    }
    out.push('');
  }
  if (slot.plan) {
    out.push(`#### plan · ${slot.plan.status}${slot.plan.revision ? ` · r${slot.plan.revision}` : ''}`);
    out.push('');
    out.push(slot.plan.content || slot.plan.title, '');
    if (slot.plan.feedback) out.push(`> feedback: ${slot.plan.feedback}`, '');
  }
  if (slot.tools && slot.tools.length > 0) {
    out.push(`#### tools (${slot.tools.length})`);
    out.push('');
    out.push('| # | tool | call | status | took | exit |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    slot.tools.forEach((tool, toolIndex) => {
      const exit = tool.result?.exitCode;
      out.push(
        `| ${toolIndex + 1} | \`${cell(tool.name || tool.kind, 24)}\` | \`${cell(tool.label, 60)}\` | ${tool.status} | ${formatMs(
          elapsedMs(tool, tool.endedAt ?? tool.startedAt),
        )} | ${exit === undefined || exit === null ? '—' : exit} |`,
      );
    });
    out.push('');
    slot.tools.forEach((tool, toolIndex) => {
      out.push(...toolResultBlock(tool, toolIndex + 1));
    });
  }
  if (slot.text) out.push(slot.text.trim(), '');
  return out;
}

export function conversationToMarkdown(conversation: Conversation, context: ExportContext = {}): string {
  const totals = conversationTotals(conversation);
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`, '');
  lines.push(
    `> damon chat desk export · ${iso(context.exportedAt ?? Date.now())} · transport ${context.transport ?? 'unknown'}${
      context.version ? ` (${context.version})` : ''
    }`,
    '',
  );
  lines.push('## conversation', '');
  lines.push(`- id: \`${conversation.id}\``);
  lines.push(`- created: ${iso(conversation.createdAt)}`);
  lines.push(`- updated: ${iso(conversation.updatedAt)}`);
  lines.push(`- mode: ${conversation.messages.some((message) => message.mode === 'compare') ? 'single + compare' : 'single'}`);
  if (conversation.forkedFrom) lines.push(`- forked from: \`${conversation.forkedFrom}\``);
  const sessions = Object.entries(conversation.daemonSessions ?? {});
  if (sessions.length > 0) {
    lines.push(`- daemon sessions: ${sessions.map(([provider, id]) => `\`${provider}\` → \`${id}\``).join(', ')}`);
  }
  if (conversation.archived) lines.push('- archived: yes');
  lines.push('');

  lines.push('## totals', '');
  lines.push(`- turns: ${totals.messages} (${totals.slots} replies, ${totals.tools} tool calls — ${totals.failedTools} failed, ${totals.runningTools} running)`);
  lines.push(`- tokens: in ${formatTokens(totals.inputTokens)} / out ${formatTokens(totals.outputTokens)}`);
  if (totals.costUsd > 0) lines.push(`- cost: $${totals.costUsd.toFixed(4)}`);
  lines.push(`- reply time: ${formatMs(totals.durationMs)}`);
  lines.push('');
  lines.push('---', '');

  conversation.messages.forEach((message, index) => {
    const number = `${index + 1}`.padStart(2, '0');
    if (message.role === 'user') {
      lines.push(`## ${number} · you · ${iso(message.createdAt)}`, '');
      if (message.memoryInjected) lines.push('> memory block was injected in front of this prompt', '');
      lines.push((message.text ?? '').trim(), '');
      return;
    }
    const slots = message.slots ?? [];
    lines.push(`## ${number} · assistant · ${iso(message.createdAt)} · ${message.mode}`, '');
    slots.forEach((slot, slotIndex) => {
      lines.push(...slotMarkdown(slot, slotIndex, slots.length));
    });
  });

  if (context.memory && context.memory.length > 0) {
    lines.push('---', '');
    lines.push('## memory ledger (active at export time)', '');
    for (const entry of context.memory) {
      lines.push(`- [${entry.scope}${entry.owner ? ` · ${entry.owner}` : ''}] ${entry.content}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* json                                                                */
/* ------------------------------------------------------------------ */

function jsonUsage(usage?: Usage): Usage | undefined {
  return usage ? { ...usage } : undefined;
}

function jsonTool(tool: ToolCall): Record<string, unknown> {
  return {
    id: tool.id,
    name: tool.name,
    kind: tool.kind,
    label: tool.label,
    input: tool.input,
    status: tool.status,
    startedAt: tool.startedAt,
    endedAt: tool.endedAt ?? null,
    durationMs: elapsedMs(tool, tool.endedAt ?? tool.startedAt),
    result: tool.result ? { ...tool.result } : null,
  };
}

function jsonSlot(slot: ReplySlot): Record<string, unknown> {
  return {
    id: slot.id,
    target: { ...slot.target },
    status: slot.status,
    text: slot.text,
    startedAt: slot.startedAt,
    firstTokenAt: slot.firstTokenAt ?? null,
    endedAt: slot.endedAt ?? null,
    ttftMs: slot.firstTokenAt ? slot.firstTokenAt - slot.startedAt : null,
    durationMs: elapsedMs(slot, slot.endedAt ?? slot.startedAt),
    usage: jsonUsage(slot.usage) ?? null,
    notice: slot.notice ?? null,
    error: slot.error ?? null,
    imported: slot.imported === true,
    daemonSessionId: slot.daemonSessionId ?? null,
    turnId: slot.turnId ?? null,
    steers: (slot.steers ?? []).map((note) => ({ text: note.text, at: note.at, state: note.state, ack: note.ack ?? null, error: note.error ?? null })),
    tools: (slot.tools ?? []).map(jsonTool),
    plan: slot.plan
      ? {
          id: slot.plan.id,
          planId: slot.plan.planId ?? null,
          revision: slot.plan.revision ?? null,
          title: slot.plan.title,
          status: slot.plan.status,
          steps: slot.plan.steps,
          files: slot.plan.files,
          risks: slot.plan.risks,
          content: slot.plan.content,
          feedback: slot.plan.feedback ?? null,
        }
      : null,
    ask: slot.ask ? { id: slot.ask.id, kind: slot.ask.kind, name: slot.ask.name, title: slot.ask.title ?? null } : null,
  };
}

export function conversationToJson(conversation: Conversation, context: ExportContext = {}): string {
  const totals = conversationTotals(conversation);
  const payload = {
    format: FORMAT_VERSION,
    exportedAt: new Date(context.exportedAt ?? Date.now()).toISOString(),
    transport: context.transport ?? null,
    version: context.version ?? null,
    baseUrl: context.baseUrl ?? null,
    totals,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archived: conversation.archived === true,
      forkedFrom: conversation.forkedFrom ?? null,
      daemonSessions: { ...conversation.daemonSessions },
      messages: conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        createdAt: message.createdAt,
        mode: message.mode,
        memoryInjected: message.memoryInjected === true,
        text: message.text ?? null,
        slots: (message.slots ?? []).map(jsonSlot),
      })),
    },
    memory: (context.memory ?? []).map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      owner: entry.owner ?? null,
      source: entry.source ?? null,
      status: entry.status,
      content: entry.content,
      updatedAt: entry.updatedAt ?? null,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Build one downloadable payload; the caller decides download vs copy. */
export function buildExport(
  conversation: Conversation,
  format: ExportFormat,
  context: ExportContext = {},
): ExportPayload {
  const content = format === 'markdown' ? conversationToMarkdown(conversation, context) : conversationToJson(conversation, context);
  const totals = conversationTotals(conversation);
  return {
    filename: exportFileName(conversation, format, context.exportedAt ? new Date(context.exportedAt) : new Date()),
    mime: exportMime(format),
    format,
    content,
    stats: { messages: totals.messages, slots: totals.slots, tools: totals.tools, chars: content.length },
  };
}

/** One route's line for a card header — kept here so exports and UI agree. */
export function exportRouteLine(slot: ReplySlot): string {
  return routeLabel(slot.target);
}
