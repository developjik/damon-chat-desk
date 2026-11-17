import { describe, expect, it } from 'vitest';
import {
  buildExport,
  conversationToJson,
  conversationToMarkdown,
  conversationTotals,
  exportFileName,
  fenceFor,
} from './export';
import { makeTarget } from './targets';
import type { Conversation, ReplySlot, ToolCall } from './types';

const claude = makeTarget({ provider: 'claude', providerLabel: 'Claude Code', model: 'claude-sonnet-4-5', modelLabel: 'Sonnet 4.5' });
const codex = makeTarget({ provider: 'codex', providerLabel: 'Codex CLI', model: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' });

const shell: ToolCall = {
  id: 'call-1',
  name: 'Bash',
  kind: 'shell',
  label: 'npm test -- --run',
  input: 'npm test -- --run',
  status: 'done',
  startedAt: 1_000,
  endedAt: 2_280,
  result: { stdout: 'Tests  27 passed (27)\n```bash\nok\n```', exitCode: 0 },
};

const edit: ToolCall = {
  id: 'call-2',
  name: 'Edit',
  kind: 'edit',
  label: 'src/lib/sse.ts',
  status: 'error',
  startedAt: 3_000,
  endedAt: 3_120,
  result: { diff: '--- a/src/lib/sse.ts\n+++ b/src/lib/sse.ts\n-const SEP = "\\n\\n";\n+const SEPS = ["\\n\\n", "\\r\\n\\r\\n"];' },
};

const slotA: ReplySlot = {
  id: 'slot-a',
  target: claude,
  text: '프레임 분리를 먼저 하세요.\n\n```ts\nconst fence = 1;\n```',
  status: 'done',
  startedAt: 1_000,
  firstTokenAt: 1_640,
  endedAt: 6_210,
  usage: { inputTokens: 118, outputTokens: 240, costUsd: 0.0118 },
  daemonSessionId: 'sess-a1b2c3',
  tools: [shell, edit],
  steers: [{ id: 'st-1', text: '테스트까지 붙여줘', at: 2_000, state: 'sent' }],
};

const slotB: ReplySlot = {
  id: 'slot-b',
  target: codex,
  text: '세 단계로 나눕니다.',
  status: 'done',
  startedAt: 1_000,
  firstTokenAt: 1_400,
  endedAt: 4_300,
  usage: { inputTokens: 96, outputTokens: 120, costUsd: 0.0032 },
};

const conversation: Conversation = {
  id: 'conv-1',
  title: 'SSE 경계 처리 계획',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  daemonSessions: { claude: 'sess-a1b2c3' },
  messages: [
    { id: 'm1', role: 'user', text: '스트리밍 파서를 어떻게 나눠?', createdAt: 1_700_000_000_000, mode: 'compare', memoryInjected: true },
    { id: 'm2', role: 'assistant', createdAt: 1_700_000_005_000, mode: 'compare', slots: [slotA, slotB] },
  ],
};

const AT = Date.UTC(2026, 10, 17, 14, 30);

describe('fenceFor', () => {
  it('outgrows the longest backtick run', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('```ts\ncode\n```')).toBe('````');
    expect(fenceFor('no ticks at all')).toBe('```');
  });
});

describe('conversationTotals', () => {
  it('sums replies, tools, tokens and time', () => {
    const totals = conversationTotals(conversation);
    expect(totals.messages).toBe(2);
    expect(totals.slots).toBe(2);
    expect(totals.tools).toBe(2);
    expect(totals.failedTools).toBe(1);
    expect(totals.inputTokens).toBe(214);
    expect(totals.outputTokens).toBe(360);
    expect(Math.round(totals.costUsd * 10_000)).toBe(Math.round((0.0118 + 0.0032) * 10_000));
  });
});

describe('conversationToMarkdown', () => {
  const markdown = conversationToMarkdown(conversation, {
    transport: 'daemon',
    version: 'damond 0.7.2',
    exportedAt: AT,
    memory: [{ id: 'mem-1', scope: 'user', content: 'Vite + React 선호', status: 'active' }],
  });

  it('opens with the conversation header and totals', () => {
    expect(markdown.startsWith('# SSE 경계 처리 계획')).toBe(true);
    expect(markdown).toContain('transport daemon (damond 0.7.2)');
    expect(markdown).toContain('`claude` → `sess-a1b2c3`');
    expect(markdown).toContain('- turns: 2 (2 replies, 2 tool calls — 1 failed, 0 running)');
    expect(markdown).toContain('- tokens: in 214 / out 360');
    expect(markdown).toContain('- cost: $0.0150');
  });

  it('keeps every turn, both compare replies and the steering note', () => {
    expect(markdown).toContain('## 01 · you');
    expect(markdown).toContain('> memory block was injected in front of this prompt');
    expect(markdown).toContain('## 02 · assistant');
    expect(markdown).toContain('### reply 1/2 · Claude Code / claude-sonnet-4-5 · done');
    expect(markdown).toContain('### reply 2/2 · Codex CLI / gpt-5-codex · done');
    expect(markdown).toContain('ttft 640ms');
    expect(markdown).toContain('session `sess-a1b2c3`');
    expect(markdown).toContain('테스트까지 붙여줘 (sent)');
  });

  it('writes the tool log as a table plus per-call result blocks', () => {
    expect(markdown).toContain('#### tools (2)');
    expect(markdown).toContain('| 1 | `Bash` | `npm test -- --run` | done | 1.28s | 0 |');
    expect(markdown).toContain('| 2 | `Edit` | `src/lib/sse.ts` | error | 120ms | — |');
    expect(markdown).toContain('#### tool 1 — Bash · npm test -- --run · done · 1.28s');
    expect(markdown).toContain('Tests  27 passed (27)');
    expect(markdown).toContain('+const SEPS = ["\\n\\n", "\\r\\n\\r\\n"];');
  });

  it('keeps the reply text and its own code fence intact', () => {
    const reply = conversation.messages[1].slots?.[0].text ?? '';
    expect(reply).toContain('```ts\nconst fence = 1;\n```');
    expect(markdown).toContain(reply.trim());
  });

  it('fences a tool output that already contains a fence', () => {
    expect(markdown).toContain('````text');
    expect(markdown).toContain('````');
  });

  it('appends the memory ledger that was injected', () => {
    expect(markdown).toContain('## memory ledger (active at export time)');
    expect(markdown).toContain('[user] Vite + React 선호');
  });

  it('never leaves a four-blank-line gap', () => {
    expect(markdown).not.toMatch(/\n{4,}/);
  });
});

describe('conversationToJson', () => {
  it('is machine-readable and keeps the tool results', () => {
    const parsed = JSON.parse(conversationToJson(conversation, { transport: 'daemon', exportedAt: AT })) as Record<
      string,
      never
    >;
    const data = parsed as unknown as {
      format: string;
      exportedAt: string;
      totals: { tools: number };
      conversation: {
        title: string;
        daemonSessions: Record<string, string>;
        messages: Array<{ role: string; memoryInjected: boolean; slots: Array<{ tools: Array<{ result: { stdout?: string; diff?: string } }>; text: string }> }>;
      };
      memory: unknown[];
    };
    expect(data.format).toBe('damon-chat-desk.conversation.v1');
    expect(data.exportedAt).toBe(new Date(AT).toISOString());
    expect(data.totals.tools).toBe(2);
    expect(data.conversation.title).toBe('SSE 경계 처리 계획');
    expect(data.conversation.daemonSessions.claude).toBe('sess-a1b2c3');
    expect(data.conversation.messages[0].memoryInjected).toBe(true);
    expect(data.conversation.messages[1].slots).toHaveLength(2);
    expect(data.conversation.messages[1].slots[0].tools[0].result.stdout).toContain('Tests  27 passed (27)');
    expect(data.conversation.messages[1].slots[0].tools[1].result.diff).toContain('SEPS');
    expect(data.memory).toEqual([]);
  });
});

describe('exportFileName', () => {
  it('slugs the title and stamps the local time', () => {
    const at = new Date(2026, 10, 17, 14, 30);
    expect(exportFileName({ ...conversation, title: 'SSE / frame: boundary?' }, 'markdown', at)).toBe(
      'damon-sse-frame-boundary-20261117-1430.md',
    );
    expect(exportFileName({ ...conversation, title: '한글 제목' }, 'json', at)).toBe('damon-한글-제목-20261117-1430.json');
  });

  it('falls back to a generic name', () => {
    expect(exportFileName({ ...conversation, title: '///' }, 'markdown', new Date(2026, 0, 2, 3, 4))).toBe(
      'damon-conversation-20260102-0304.md',
    );
  });
});

describe('buildExport', () => {
  it('packs the payload with mime and size stats', () => {
    const payload = buildExport(conversation, 'markdown', { exportedAt: AT });
    expect(payload.mime).toBe('text/markdown;charset=utf-8');
    expect(payload.filename.endsWith('.md')).toBe(true);
    expect(payload.stats).toMatchObject({ messages: 2, slots: 2, tools: 2 });
    expect(payload.stats.chars).toBe(payload.content.length);
    expect(buildExport(conversation, 'json').mime).toBe('application/json;charset=utf-8');
  });
});
