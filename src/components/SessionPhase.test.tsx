import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhaseChip, RecoveredBanner } from './SessionPhase';
import { SessionList, type SessionItem } from './SessionList';
import type { SessionStatusRow } from '../lib/types';

const busy: SessionStatusRow = { sessionId: 'sess-1', backend: 'claude', phase: 'busy', busy: true, source: 'daemon', turnId: 'turn-1' };
const waiting: SessionStatusRow = {
  sessionId: 'sess-1',
  backend: 'claude',
  phase: 'awaiting_input',
  busy: true,
  source: 'daemon',
  pendingAsk: { requestId: 'req-1', kind: 'plan', label: '구현 계획', askedAtMs: 1000 },
};

function item(over: Partial<SessionItem> = {}): SessionItem {
  return {
    key: 'sess-1',
    kind: 'daemon',
    title: 'API 리뷰',
    meta: '3분 전',
    badge: 'claude',
    active: false,
    archived: false,
    ...over,
  };
}

const noop = () => undefined;

describe('PhaseChip', () => {
  it('says nothing about an idle session', () => {
    expect(renderToStaticMarkup(<PhaseChip row={{ ...busy, phase: 'idle', busy: false }} />)).toBe('');
    expect(renderToStaticMarkup(<PhaseChip row={undefined} />)).toBe('');
  });

  it('marks a running turn and the parked ask with its kind and label', () => {
    const html = renderToStaticMarkup(<PhaseChip row={busy} />);
    expect(html).toContain('phase-chip busy');
    expect(html).toContain('>busy<');
    expect(html).toContain('데몬 원장');

    const parked = renderToStaticMarkup(<PhaseChip row={waiting} />);
    expect(parked).toContain('phase-chip awaiting_input');
    expect(parked).toContain('>waiting<');
    expect(parked).toContain('>plan<');
    expect(parked).toContain('구현 계획');
    expect(parked).toContain('답을 기다리는 중');
  });

  it('can show the phase without the ask, and marks a local read', () => {
    // The compact form drops the ask line; the hover title keeps it.
    expect(renderToStaticMarkup(<PhaseChip row={waiting} showAsk={false} />)).not.toContain('phase-ask');
    expect(renderToStaticMarkup(<PhaseChip row={{ ...busy, source: 'local' }} />)).toContain('이 창의 스트림');
  });

  it('keeps the ask kind but drops the label in a narrow list row', () => {
    const html = renderToStaticMarkup(<PhaseChip row={waiting} compact />);
    expect(html).toContain('>plan<');
    expect(html).toContain('>waiting<');
    expect(html).not.toContain('phase-label');
    // The sentence survives on the title attribute.
    expect(html).toContain('계획 검토: 구현 계획');
  });
});

describe('RecoveredBanner', () => {
  const rows = [
    { sessionId: 'aaaaaaaa-bbbb-cccc', backend: 'claude', phase: 'busy' as const, sinceMs: 1000 },
    { sessionId: 'dddddddd', backend: 'codex', phase: 'awaiting_input' as const, sinceMs: 2000 },
  ];

  it('names the interruption instead of hiding it', () => {
    const html = renderToStaticMarkup(<RecoveredBanner rows={rows} onResume={noop} now={1000 + 5 * 60_000} />);
    expect(html).toContain('recovered');
    expect(html).toContain('중단된 세션 2개');
    expect(html).toContain('마지막 응답은 완결되지 않았습니다');
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain('codex');
    expect(html).toContain('턴 실행 중이던 · 5분 전');
    expect(html).toContain('답을 기다리던');
    expect(html).toContain('이어받기');
    expect(html).not.toContain('기록 열기');
  });

  it('offers the history too when the caller can open it', () => {
    const html = renderToStaticMarkup(<RecoveredBanner rows={[rows[0]]} onResume={noop} onOpen={noop} />);
    expect(html).toContain('기록 열기');
  });

  it('renders nothing when nothing was interrupted', () => {
    expect(renderToStaticMarkup(<RecoveredBanner rows={[]} onResume={noop} />)).toBe('');
  });
});

describe('SessionList — phase rows', () => {
  it('puts the phase next to the backend chip, and omits it for a quiet session', () => {
    const html = renderToStaticMarkup(
      <SessionList
        items={[item({ phase: waiting }), item({ key: 'sess-2', title: '조용한 세션' })]}
        query=""
        title="on the daemon"
        empty="없음"
        onQuery={noop}
        onSelect={noop}
        onRename={noop}
        onArchive={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('session-flags');
    expect(html).toContain('phase-chip awaiting_input');
    expect(html).toContain('>plan<');
    // One chip for two rows: idle sessions add no chip of their own.
    expect(html.match(/phase-chip/g) ?? []).toHaveLength(1);
  });
});
