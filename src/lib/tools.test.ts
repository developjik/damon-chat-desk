import { describe, expect, it } from 'vitest';
import { mergeToolCall, normalizeToolCall, oneLine, parseDiff, toolCounts, toolDuration, toolKindOf } from './tools';

describe('toolKindOf', () => {
  it('maps the daemon detail tags onto the viewer kinds', () => {
    expect(toolKindOf('shell')).toBe('shell');
    expect(toolKindOf('sub_agent')).toBe('task');
    expect(toolKindOf('plan')).toBe('other');
    expect(toolKindOf('mystery')).toBe('other');
    expect(toolKindOf(undefined)).toBe('other');
  });
});

describe('normalizeToolCall', () => {
  it('flattens a shell detail into command, output and exit code', () => {
    const call = normalizeToolCall(
      {
        call_id: 'c1',
        name: 'Bash',
        status: 'completed',
        detail: { type: 'shell', command: 'npm test\n--run', output: '6 passed', exit_code: 0 },
      },
      1_000,
    );
    expect(call).toMatchObject({
      id: 'c1',
      name: 'Bash',
      kind: 'shell',
      label: 'npm test --run',
      input: 'npm test\n--run',
      status: 'done',
      result: { stdout: '6 passed', exitCode: 0 },
      startedAt: 1_000,
      endedAt: 1_000,
    });
    expect(toolDuration(call, 2_000)).toBe(0);
  });

  it('marks a non-zero exit as an error even when the status says completed', () => {
    const call = normalizeToolCall(
      { call_id: 'c2', name: 'Bash', status: 'completed', detail: { type: 'shell', command: 'tsc', output: 'boom', exit_code: 2 } },
      500,
    );
    expect(call.status).toBe('error');
    expect(call.result?.exitCode).toBe(2);
  });

  it('keeps a running call open — no end time, no duration', () => {
    const call = normalizeToolCall({ call_id: 'c3', name: 'Read', status: 'running', detail: { type: 'read', path: 'src/a.ts' } }, 700);
    expect(call.status).toBe('running');
    expect(call.endedAt).toBeUndefined();
    expect(toolDuration(call, 9_999)).toBeUndefined();
  });

  it('reads an edit as a diff and a search as hits', () => {
    const edit = normalizeToolCall(
      { call_id: 'e1', name: 'Edit', status: 'completed', detail: { type: 'edit', path: 'src/sse.ts', unified_diff: '--- a\n+++ b\n+one' } },
      10,
    );
    expect(edit).toMatchObject({ kind: 'edit', label: 'src/sse.ts', result: { diff: '--- a\n+++ b\n+one' } });

    const search = normalizeToolCall(
      { call_id: 's1', name: 'Grep', status: 'completed', detail: { type: 'search', query: 'streamTurn', content: 'a.ts:1' } },
      10,
    );
    expect(search).toMatchObject({ kind: 'search', label: 'streamTurn', result: { stdout: 'a.ts:1' } });
  });

  it('falls back to the raw input for an unmapped detail', () => {
    const call = normalizeToolCall(
      { call_id: 'u1', name: 'mcp_tool', status: 'failed', detail: { type: 'unknown', input: { path: 'x' }, output: { ok: false } } },
      10,
    );
    expect(call.kind).toBe('other');
    expect(call.status).toBe('error');
    expect(call.input).toContain('"path": "x"');
    expect(call.result?.stdout).toContain('"ok": false');
  });

  it('survives a call with no detail at all', () => {
    const call = normalizeToolCall({ name: 'Mystery', status: 'running' }, 42);
    expect(call).toMatchObject({ name: 'Mystery', kind: 'other', label: 'Mystery', status: 'running' });
    expect(call.id).toBe(`Mystery-42`);
  });
});

describe('mergeToolCall', () => {
  it('folds the terminal snapshot onto the running row', () => {
    const running = normalizeToolCall(
      { call_id: 'c1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' } },
      1_000,
    );
    const done = normalizeToolCall(
      { call_id: 'c1', name: 'Bash', status: 'completed', detail: { type: 'shell', command: 'npm test', output: 'ok', exit_code: 0 } },
      2_400,
    );
    const merged = mergeToolCall(running, done);
    expect(merged.status).toBe('done');
    expect(merged.startedAt).toBe(1_000);
    expect(merged.endedAt).toBe(2_400);
    expect(merged.result?.stdout).toBe('ok');
  });

  it('never regresses a finished row when a late running frame arrives', () => {
    const done = normalizeToolCall(
      { call_id: 'c1', name: 'Bash', status: 'completed', detail: { type: 'shell', command: 'x', output: 'y', exit_code: 0 } },
      2_000,
    );
    const late = normalizeToolCall({ call_id: 'c1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'x' } }, 2_000);
    const merged = mergeToolCall(done, late);
    expect(merged.status).toBe('done');
    expect(merged.result?.stdout).toBe('y');
  });
});

describe('parseDiff', () => {
  it('separates added, removed, meta and context lines', () => {
    const lines = parseDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n same');
    expect(lines.map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'del', 'add', 'ctx']);
    expect(lines[4].text).toBe('new');
  });
});

describe('oneLine and toolCounts', () => {
  it('collapses whitespace and truncates', () => {
    expect(oneLine('npm   test\n--run', 40)).toBe('npm test --run');
    expect(oneLine('x'.repeat(40), 10)).toHaveLength(10);
  });

  it('counts rows by status', () => {
    const base = { name: 't', kind: 'shell' as const, label: 'x', startedAt: 0 };
    expect(
      toolCounts([
        { ...base, id: '1', status: 'done' },
        { ...base, id: '2', status: 'error' },
        { ...base, id: '3', status: 'running' },
        { ...base, id: '4', status: 'done' },
      ]),
    ).toEqual({ running: 1, done: 2, error: 1 });
    expect(toolCounts(undefined)).toEqual({ running: 0, done: 0, error: 0 });
  });
});
