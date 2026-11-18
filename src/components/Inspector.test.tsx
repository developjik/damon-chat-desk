import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeltaGroupRow, Inspector, InspectorToggle } from './Inspector';
import { WireTap } from '../lib/inspector';

const noop = () => undefined;

function filledTap() {
  const wire = new WireTap(50, { now: () => 1_700_000_000_000 });
  wire.record({
    dir: 'tx',
    kind: 'request',
    method: 'turn.start',
    protocol: 'jsonrpc',
    id: 1,
    sessionId: 's-1',
    payload: { id: 1, method: 'turn.start', params: { sessionId: 's-1', prompt: '핸들러를 분리해 줘' } },
  });
  wire.record({
    dir: 'rx',
    kind: 'notification',
    method: 'session.event',
    protocol: 'jsonrpc',
    sessionId: 's-1',
    payload: {
      event: 'session.event',
      sessionId: 's-1',
      data: { type: 'timeline', kind: 'tool_call', call_id: 'c1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' } },
    },
  });
  wire.record({
    dir: 'rx',
    kind: 'result',
    method: 'turn.start',
    protocol: 'jsonrpc',
    id: 1,
    latencyMs: 2380,
    payload: { id: 1, result: { turnId: 't-1' } },
  });
  return wire;
}

describe('Inspector', () => {
  it('shows each frame with direction, method, round trip and a preview', () => {
    const markup = renderToStaticMarkup(
      <Inspector tap={filledTap()} open filter="all" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(markup).toContain('JSON-RPC');
    expect(markup).toContain('→ TX');
    expect(markup).toContain('← RX');
    expect(markup).toContain('turn.start');
    expect(markup).toContain('2.38s');
    expect(markup).toContain('session.event');
    expect(markup).toContain('timeline.tool_call');
    expect(markup).toContain('npm test');
    expect(markup).toContain('prompt=핸들러를 분리해 줘');
    expect(markup).toContain('clear');
    expect(markup).toContain('copy');
    expect(markup).toContain('follow');
  });

  it('narrows the list to the active chip', () => {
    const tap = filledTap();
    const tx = renderToStaticMarkup(
      <Inspector tap={tap} open filter="tx" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(tx).toContain('wire-row tx');
    expect(tx).not.toContain('wire-row rx');

    const tools = renderToStaticMarkup(
      <Inspector tap={tap} open filter="tools" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(tools).toContain('timeline.tool_call');
    expect(tools).not.toContain('prompt=핸들러를 분리해 줘');
  });

  it('renders nothing while closed', () => {
    const markup = renderToStaticMarkup(
      <Inspector tap={filledTap()} open={false} filter="all" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(markup).toBe('');
  });

  it('explains an empty panel instead of showing a blank box', () => {
    const markup = renderToStaticMarkup(
      <Inspector tap={new WireTap(10)} open filter="all" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(markup).toContain('아직 프레임이 없습니다');
    expect(markup).toContain('turn.start');
  });

  it('labels the wire the current transport speaks', () => {
    const sse = renderToStaticMarkup(
      <Inspector tap={filledTap()} open filter="all" protocol="sse" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );
    expect(sse).toContain('inspector-proto mono">sse');
  });
});

describe('delta groups', () => {
  /** One turn's wire: request, a long run of deltas, a tool call, an ask. */
  function longTurn(deltas = 120) {
    const wire = new WireTap(400);
    wire.record({ dir: 'tx', kind: 'request', method: 'turn.start', protocol: 'jsonrpc', id: 1, payload: { id: 1, method: 'turn.start', params: { prompt: 'go' } } });
    for (let index = 0; index < deltas; index += 1) {
      wire.record({
        dir: 'rx',
        kind: 'notification',
        method: 'session.event',
        protocol: 'jsonrpc',
        payload: { event: 'session.event', data: { type: 'timeline', kind: 'assistant_message', text: `chunk ${index} ` } },
      });
    }
    wire.record({
      dir: 'rx',
      kind: 'notification',
      method: 'session.event',
      protocol: 'jsonrpc',
      payload: { event: 'session.event', data: { type: 'timeline', kind: 'tool_call', call_id: 'c1', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' } } },
    });
    wire.record({
      dir: 'rx',
      kind: 'notification',
      method: 'session.event',
      protocol: 'jsonrpc',
      payload: { event: 'session.event', data: { type: 'permission_requested', id: 'p1', kind: 'plan', name: 'ExitPlanMode', title: '계획' } },
    });
    return wire;
  }

  const render = (tap: WireTap) =>
    renderToStaticMarkup(
      <Inspector tap={tap} open filter="all" protocol="jsonrpc" onFilter={noop} onClose={noop} onClear={noop} onNotify={noop} />,
    );

  function rowsOf(markup: string): number {
    return markup.split('class="wire-row').length - 1;
  }

  it('folds 120 consecutive deltas into a single row and keeps the tool call visible', () => {
    const markup = render(longTurn());
    expect(markup).toContain('wire-row rx group');
    expect(markup).toContain('×120 deltas');
    expect(markup).toContain('— 눌러서 프레임 펼치기');
    expect(markup).toContain('timeline.tool_call');
    expect(markup).toContain('npm test');
    expect(markup).toContain('permission_requested');
    // request + fold row + tool call + ask — not 122 rows
    expect(rowsOf(markup)).toBe(4);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('wire-group nested');
  });

  it('offers the grouping toggle, on by default', () => {
    const markup = render(longTurn());
    expect(markup).toContain('group');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('opens the run into individual delta frames', () => {
    const wire = longTurn(6);
    const frames = [...wire.getSnapshot().frames].filter((frame) => frame.method === 'session.event' && (frame.payload as { data?: { kind?: string } }).data?.kind === 'assistant_message');
    const expanded = renderToStaticMarkup(
      <DeltaGroupRow frames={frames} open selected={null} onToggle={noop} onSelect={noop} />,
    );
    expect(expanded).toContain('wire-deltas');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded.split('wire-group nested').length - 1).toBe(6);
    expect(expanded).toContain('chunk 5');
  });
});

describe('InspectorToggle', () => {
  it('carries the frame count and a live state', () => {
    const markup = renderToStaticMarkup(<InspectorToggle tap={filledTap()} open={false} onToggle={noop} />);
    expect(markup).toContain('JSON-RPC');
    expect(markup).toContain('inspector-toggle-count mono">3');
    expect(markup).not.toContain('inspector-toggle on');
  });

  it('says it is open when it is', () => {
    const markup = renderToStaticMarkup(<InspectorToggle tap={new WireTap(10)} open onToggle={noop} />);
    expect(markup).toContain('inspector-toggle on');
    expect(markup).toContain('aria-pressed="true"');
  });
});
