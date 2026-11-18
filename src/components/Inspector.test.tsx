import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Inspector, InspectorToggle } from './Inspector';
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
