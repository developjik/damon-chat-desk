import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectPanel } from './ConnectPanel';
import type { DeskState } from '../lib/desk';
import type { ProtocolState } from '../lib/types';

const CAPS: ProtocolState['capabilities'] = {
  eventSeq: true,
  snapshotRequired: true,
  connGap: true,
  idempotentTurns: true,
  turnLedger: true,
  versionNegotiation: true,
};

function state(protocol?: ProtocolState): DeskState {
  return {
    connection: {
      transport: 'daemon',
      status: 'live',
      baseUrl: 'http://127.0.0.1:9470',
      version: 'damond 0.9.0',
      targets: [],
      probeNote: '1 backends · protocol v2 (negotiated) · 6/6 capabilities',
      protocol,
    },
    conversations: [],
    activeId: null,
    daemonSessions: [],
    memory: {
      entries: [],
      enabled: true,
      chars: 0,
      limit: 0,
      loading: false,
      view: { scope: 'user', entries: [], chars: 0, limit: 0 },
      query: '',
      filter: 'all',
      busy: false,
      supported: true,
    },
    sessions: { query: '', showArchived: false },
    compare: false,
    primaryKey: null,
    secondaryKey: null,
    sidebarOpen: false,
    inspector: { open: false, filter: 'all' },
    busy: false,
    pairing: {},
  } as DeskState;
}

function render(desk: DeskState): string {
  return renderToStaticMarkup(
    <ConnectPanel
      open
      state={desk}
      onClose={() => undefined}
      onConnect={() => undefined}
      onDemo={() => undefined}
      onPair={() => undefined}
      onCheckPairing={() => undefined}
    />,
  );
}

describe('ConnectPanel — protocol card', () => {
  it('lists every capability the daemon promised', () => {
    const html = render(
      state({ version: 2, min: 2, supported: [2], negotiated: true, capabilities: CAPS }),
    );
    expect(html).toContain('protocol v2');
    expect(html).toContain('min 2');
    expect(html).toContain('supported 2');
    expect(html).toContain('negotiated');
    for (const key of ['eventSeq', 'snapshotRequired', 'connGap', 'idempotentTurns', 'turnLedger', 'versionNegotiation']) {
      expect(html).toContain(key);
    }
    expect(html).toContain('유실 구간을 표시');
  });

  it('says what an older daemon cannot do instead of hiding it', () => {
    const html = render(
      state({
        version: 2,
        negotiated: false,
        capabilities: {
          eventSeq: false,
          snapshotRequired: false,
          connGap: false,
          idempotentTurns: false,
          turnLedger: false,
          versionNegotiation: false,
        },
      }),
    );
    expect(html).toContain('push hello');
    expect(html).toContain('프로토콜 v2 이전');
  });

  it('shows no protocol card before a handshake', () => {
    expect(render(state(undefined))).not.toContain('protocol-card');
  });
});
