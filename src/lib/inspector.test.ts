import { describe, expect, it } from 'vitest';
import {
  WireTap,
  deltaGroupStats,
  deltaGroupSummary,
  deltaText,
  foldedFrameCount,
  frameBody,
  frameDetail,
  frameMatches,
  frameSummary,
  formatBytes,
  formatLatency,
  formatSpan,
  inspectorRows,
  isDeltaFrame,
  isToolTraffic,
  stamp,
  type WireFrame,
} from './inspector';

const request = { id: 1, method: 'turn.start', params: { sessionId: 's-1', prompt: 'hello' } };
const event = {
  event: 'session.event',
  sessionId: 's-1',
  data: { type: 'timeline', kind: 'tool_call', call_id: 'c-1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' } },
};

function tap(limit = 4) {
  let clock = 1_700_000_000_000;
  return new WireTap(limit, { now: () => (clock += 10) });
}

describe('WireTap', () => {
  it('stamps direction, sequence, size and latency', () => {
    const wire = tap();
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 1, payload: request });
    wire.record({ dir: 'rx', kind: 'result', method: 'turn.start', protocol: 'jsonrpc', id: 1, latencyMs: 42, payload: { id: 1, result: {} } });
    const snapshot = wire.getSnapshot();
    expect(snapshot.frames).toHaveLength(2);
    expect(snapshot.frames[0].seq).toBe(1);
    expect(snapshot.frames[0].bytes).toBe(JSON.stringify(request).length);
    expect(snapshot.frames[1].latencyMs).toBe(42);
    expect(snapshot.tx).toBe(1);
    expect(snapshot.rx).toBe(1);
  });

  it('counts requests that have not been answered yet', () => {
    const wire = tap();
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 7, payload: { id: 7 } });
    expect(wire.getSnapshot().inflight).toBe(1);
    wire.record({ dir: 'rx', kind: 'result', method: 'turn.start', protocol: 'jsonrpc', id: 7, latencyMs: 900, payload: { id: 7 } });
    expect(wire.getSnapshot().inflight).toBe(0);
  });

  it('keeps the newest frames and reports how many fell off', () => {
    const wire = tap(3);
    for (let index = 0; index < 5; index += 1) {
      wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: { n: index } });
    }
    const snapshot = wire.getSnapshot();
    expect(snapshot.frames).toHaveLength(3);
    expect(snapshot.frames.at(-1)?.seq).toBe(5);
    expect(snapshot.dropped).toBe(2);
  });

  it('drops everything on clear but keeps sequence numbers rising', () => {
    const wire = tap();
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: {} });
    wire.clear();
    expect(wire.getSnapshot().frames).toHaveLength(0);
    expect(wire.getSnapshot().dropped).toBe(0);
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: {} });
    expect(wire.getSnapshot().frames[0].seq).toBe(2);
  });

  it('notifies subscribers on a timer and hands out a stable snapshot', () => {
    const wire = tap();
    let notified = 0;
    const off = wire.subscribe(() => {
      notified += 1;
    });
    const first = wire.getSnapshot();
    expect(wire.getSnapshot()).toBe(first);
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: {} });
    expect(wire.getSnapshot()).not.toBe(first);
    off();
    expect(notified).toBeLessThanOrEqual(1); // throttled, flushed on the next tick
  });

  it('marks tool and approval traffic so the third chip has something to show', () => {
    const wire = tap();
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.steer', protocol: 'jsonrpc', id: 2, payload: {} });
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: event });
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: { event: 'session.event', data: { type: 'timeline', kind: 'assistant_message', text: 'hi' } } });
    const frames = wire.getSnapshot().frames;
    expect(frames[0].tool).toBe(true);
    expect(frames[1].tool).toBe(true);
    expect(frames[2].tool).toBe(false);
    expect(frames.filter((frame) => frameMatches('tools', frame))).toHaveLength(2);
    expect(frames.filter((frame) => frameMatches('tx', frame))).toHaveLength(1);
    expect(frames.filter((frame) => frameMatches('rx', frame))).toHaveLength(2);
  });

  it('copies frames as one readable block per frame', () => {
    const wire = tap();
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 1, payload: request });
    const text = wire.toText();
    expect(text).toContain('→ TX');
    expect(text).toContain('turn.start');
    expect(text).toContain('"prompt": "hello"');
    expect(wire.toText('rx')).toBe('');
  });
});

describe('isToolTraffic', () => {
  it('knows the approval verbs and the timeline kinds', () => {
    expect(isToolTraffic({ dir: 'tx', kind: 'request', method: 'permission.respond', protocol: 'jsonrpc', payload: {} })).toBe(true);
    expect(isToolTraffic({ dir: 'tx', kind: 'request', method: 'plan.respond', protocol: 'jsonrpc', payload: {} })).toBe(true);
    expect(isToolTraffic({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: event })).toBe(true);
    expect(isToolTraffic({ dir: 'tx', kind: 'request', method: 'session.list', protocol: 'jsonrpc', payload: {} })).toBe(false);
  });
});

describe('frame helpers', () => {
  it('names the event under session.event', () => {
    const wire = tap();
    const frame = wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: event });
    expect(frameDetail(frame)).toBe('timeline.tool_call');
    expect(frameSummary(frame)).toContain('Bash');
    expect(frameSummary(frame)).toContain('npm test');
    expect(frameBody(frame)).toContain('"kind": "tool_call"');
  });

  it('previews a request by its params and a response by its keys', () => {
    const wire = tap();
    const tx = wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 1, payload: request });
    expect(frameSummary(tx)).toContain('sessionId=s-1');
    expect(frameDetail(tx)).toBe('request');
    const rx = wire.record({ dir: 'rx', kind: 'result', method: 'turn.start', protocol: 'jsonrpc', id: 1, latencyMs: 31, payload: { id: 1, result: { turnId: 't-1' } } });
    expect(frameSummary(rx)).toContain('turnId=t-1');
  });

  it('formats time, latency and size without lying', () => {
    expect(stamp(new Date(2026, 10, 18, 15, 2, 31, 284).getTime())).toBe('15:02:31.284');
    expect(formatLatency(undefined)).toBe('');
    expect(formatLatency(0.2)).toBe('1ms');
    expect(formatLatency(42)).toBe('42ms');
    expect(formatLatency(2380)).toBe('2.38s');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
  });
});

describe('delta grouping', () => {
  const prompt = { id: 1, method: 'turn.start', params: { sessionId: 's-1', prompt: 'go' } };

  /** A tap whose clock ticks 10ms per frame, so spans are predictable. */
  function stream(): WireTap {
    return new WireTap(400, { now: (() => {
      let clock = 1_700_000_000_000;
      return () => (clock += 10);
    })() });
  }

  function text(wire: WireTap, value: string): void {
    wire.record({
      dir: 'rx',
      kind: 'notification',
      method: 'session.event',
      protocol: 'jsonrpc',
      payload: { event: 'session.event', sessionId: 's-1', data: { type: 'timeline', kind: 'assistant_message', text: value } },
    });
  }

  function toolCall(wire: WireTap): void {
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: event });
  }

  function run(): WireFrame[] {
    const wire = stream();
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 1, payload: prompt });
    text(wire, '첫 ');
    text(wire, '문장');
    text(wire, '을 ');
    text(wire, '씁');
    text(wire, '니다');
    toolCall(wire);
    text(wire, '그 ');
    text(wire, '다음');
    wire.record({ dir: 'rx', kind: 'result', method: 'turn.start', protocol: 'jsonrpc', id: 1, latencyMs: 900, payload: { id: 1, result: { turnId: 't-1' } } });
    return [...wire.getSnapshot().frames];
  }

  it('folds a run of text deltas and splits it at the first other frame', () => {
    const frames = run();
    const rows = inspectorRows(frames);
    expect(rows.map((row) => row.kind)).toEqual(['frame', 'group', 'frame', 'group', 'frame']);
    const first = rows[1];
    if (first.kind !== 'group') throw new Error('expected a group');
    expect(first.frames.map((frame) => deltaText(frame)).join('')).toBe('첫 문장을 씁니다');
    const second = rows[3];
    if (second.kind !== 'group') throw new Error('expected a group');
    expect(second.frames).toHaveLength(2);
    // nothing is lost: every frame is either a row or inside one
    expect(foldedFrameCount(rows) + rows.filter((row) => row.kind === 'frame').length).toBe(frames.length);
  });

  it('leaves a lone delta as its own row', () => {
    const wire = stream();
    text(wire, '한 글자');
    toolCall(wire);
    const rows = inspectorRows([...wire.getSnapshot().frames]);
    expect(rows.map((row) => row.kind)).toEqual(['frame', 'frame']);
  });

  it('folds the frames the filter shows, not the ones it hides', () => {
    const frames = run();
    const rxRows = inspectorRows(frames.filter((frame) => frameMatches('rx', frame)));
    expect(rxRows.map((row) => row.kind)).toEqual(['group', 'frame', 'group', 'frame']);
    const toolRows = inspectorRows(frames.filter((frame) => frameMatches('tools', frame)));
    expect(toolRows.map((row) => row.kind)).toEqual(['frame']);
  });

  it('can be turned off, one row per frame', () => {
    const frames = run();
    const rows = inspectorRows(frames, { group: false });
    expect(rows).toHaveLength(frames.length);
    expect(rows.every((row) => row.kind === 'frame')).toBe(true);
  });

  it('reads out count, span and size of the folded run', () => {
    const frames = run();
    const first = frames.filter((frame) => isDeltaFrame(frame)).slice(0, 5);
    const stats = deltaGroupStats(first);
    expect(stats.count).toBe(5);
    expect(stats.spanMs).toBe(40);
    expect(stats.bytes).toBe(first.reduce((sum, frame) => sum + frame.bytes, 0));
    expect(stats.chars).toBe('첫 문장을 씁니다'.length);
    expect(stats.preview).toBe('첫 문장을 씁니다');
    expect(deltaGroupSummary(first)).toBe(`×5 deltas · 40ms · ${formatBytes(stats.bytes)}`);
  });

  it('knows exactly what counts as a text delta', () => {
    const wire = stream();
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: { event: 'session.event', data: { type: 'timeline', kind: 'assistant_message', text: 'a' } } });
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: { event: 'session.event', data: { type: 'timeline', kind: 'assistant_message', text: 'b' } } });
    toolCall(wire);
    wire.record({ dir: 'rx', kind: 'notification', method: 'session.event', protocol: 'jsonrpc', payload: { event: 'session.event', data: { type: 'permission_requested', kind: 'tool' } } });
    const frames = [...wire.getSnapshot().frames];
    expect(frames.map((frame) => isDeltaFrame(frame))).toEqual([true, true, false, false]);
    expect(isDeltaFrame({ dir: 'tx', kind: 'request', method: 'session.event', protocol: 'jsonrpc', payload: {} })).toBe(false);
    expect(isDeltaFrame({ dir: 'rx', kind: 'notification', method: 'turn.start', protocol: 'jsonrpc', payload: {} })).toBe(false);
  });

  it('formats a span in the units a reader expects', () => {
    expect(formatSpan(0)).toBe('0ms');
    expect(formatSpan(840)).toBe('840ms');
    expect(formatSpan(2400)).toBe('2.4s');
    expect(formatSpan(65_000)).toBe('1m05s');
  });
});
