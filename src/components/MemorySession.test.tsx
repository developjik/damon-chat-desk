import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryPanel } from './MemoryPanel';
import { SessionList, type SessionItem } from './SessionList';
import type { DeskState } from '../lib/desk';
import type { MemoryEntry } from '../lib/types';

const entries: MemoryEntry[] = [
  { id: 'm1', scope: 'user', content: '선호 스택: Vite + React, 1px 보더 다크 UI.', status: 'active', source: 'daemon', updatedAt: Date.now() },
  { id: 'm2', scope: 'user', content: 'WS 티켓은 1회용, 60초 만료.', status: 'active', updatedAt: Date.now() },
  { id: 'm3', scope: 'user', content: '데모가 먼저 뜨는 구조를 선호', status: 'pending', updatedAt: Date.now() },
  { id: 'm4', scope: 'bot', owner: 'scribe', content: '릴리스 노트: 날짜 → 변경 → 근거', status: 'active', updatedAt: Date.now() },
];

function memoryState(over: Partial<DeskState['memory']> = {}): DeskState['memory'] {
  return {
    entries: entries.filter((entry) => entry.scope === 'user'),
    enabled: true,
    chars: 120,
    limit: 8000,
    loading: false,
    view: { scope: 'user', entries: entries.filter((entry) => entry.scope === 'user'), chars: 120, limit: 8000 },
    query: '',
    filter: 'all',
    busy: false,
    supported: true,
    ...over,
  };
}

const noop = () => undefined;
const memoryActions = {
  onToggle: noop,
  onQuery: noop,
  onFilter: noop,
  onScope: noop,
  onAdd: noop,
  onUpdate: noop,
  onRemove: noop,
  onApprove: noop,
  onReject: noop,
  onRefresh: noop,
};

describe('MemoryPanel', () => {
  it('shows the search box, scope chips, filters and ledger usage', () => {
    const markup = renderToStaticMarkup(<MemoryPanel memory={memoryState()} transport="daemon" {...memoryActions} />);
    expect(markup).toContain('placeholder="메모리 검색"');
    expect(markup).toContain('mem-chip on');
    expect(markup).toContain('>user<');
    expect(markup).toContain('>bot<');
    expect(markup).toContain('>전체<');
    expect(markup).toContain('2 active · 1 pending');
    expect(markup).toContain('120/8000');
    expect(markup).toContain('mem-meter');
  });

  it('renders each entry with its derived key, scope badge and actions', () => {
    const markup = renderToStaticMarkup(<MemoryPanel memory={memoryState()} transport="daemon" {...memoryActions} />);
    // key: value is read as a key badge, the value keeps the body
    expect(markup).toContain('>선호 스택<');
    expect(markup).toContain('Vite + React, 1px 보더 다크 UI.');
    // a pending entry gets approve/reject instead of being injected silently
    expect(markup).toContain('>승인<');
    expect(markup).toContain('>거절<');
    expect(markup).toContain('mem-badge status');
    expect(markup).toContain('>수정<');
    expect(markup).toContain('>삭제<');
  });

  it('names the bot ledger with its owner when that scope is selected', () => {
    const state = memoryState({
      view: { scope: 'bot', owner: 'scribe', entries: entries.filter((entry) => entry.scope === 'bot'), chars: 30, limit: 8000 },
    });
    const markup = renderToStaticMarkup(<MemoryPanel memory={state} transport="daemon" {...memoryActions} />);
    expect(markup).toContain('mem-owner');
    expect(markup).toContain('value="scribe"');
    expect(markup).toContain('>scribe<');
    expect(markup).toContain('mem-badge owner');
    expect(markup).toContain('>bot<');
  });

  it('offers the compose row and explains the wiring per transport', () => {
    expect(renderToStaticMarkup(<MemoryPanel memory={memoryState()} transport="daemon" {...memoryActions} />)).toContain(
      'memory.list / write / remove / approve',
    );
    expect(renderToStaticMarkup(<MemoryPanel memory={memoryState()} transport="demo" {...memoryActions} />)).toContain(
      '시뮬레이션된 원장',
    );
    expect(renderToStaticMarkup(<MemoryPanel memory={memoryState()} transport="daemon" {...memoryActions} />)).toContain(
      '새 메모',
    );
  });

  it('says there is no ledger on a transport that has none', () => {
    const state = memoryState({
      supported: false,
      entries: [],
      view: { scope: 'user', entries: [], chars: 0, limit: 0 },
    });
    const markup = renderToStaticMarkup(<MemoryPanel memory={state} transport="openai" {...memoryActions} />);
    expect(markup).toContain('이 모드에는 메모리 원장이 없습니다');
    expect(markup).toContain('OpenAI 호환 모드에서는 메모리 원장이 없습니다');
  });

  it('reports a refused write in place', () => {
    const markup = renderToStaticMarkup(
      <MemoryPanel memory={memoryState({ error: '메모리 원장 한도를 넘습니다' })} transport="daemon" {...memoryActions} />,
    );
    expect(markup).toContain('mem-error');
    expect(markup).toContain('한도를 넘습니다');
  });
});

const items: SessionItem[] = [
  { key: 'c1', kind: 'local', title: 'SSE 프레임 경계 처리', meta: '2 msg · 방금', active: true, archived: false },
  { key: 'c2', kind: 'local', title: '강릉 숙소 비교', meta: '1 msg · 3시간 전', active: false, archived: false },
  { key: 'sess-a1', kind: 'daemon', title: 'damon API 리뷰', meta: '1시간 전 · pinned', badge: 'claude', active: false, archived: false },
];

const sessionActions = {
  onQuery: noop,
  onSelect: noop,
  onRename: noop,
  onArchive: noop,
  onDelete: noop,
};

describe('SessionList', () => {
  it('has a live search box and one row per session with its meta', () => {
    const markup = renderToStaticMarkup(
      <SessionList items={items} query="" title="sessions" empty="아직 대화가 없습니다" {...sessionActions} />,
    );
    expect(markup).toContain('placeholder="세션 검색 — 제목·내용·툴"');
    expect(markup).toContain('SSE 프레임 경계 처리');
    expect(markup).toContain('2 msg · 방금');
    expect(markup).toContain('session active');
    expect(markup).toContain('backend-chip');
  });

  it('puts rename, archive and a two-step delete in each row menu', () => {
    const markup = renderToStaticMarkup(
      <SessionList items={items} query="" title="sessions" empty="없음" {...sessionActions} />,
    );
    expect(markup.match(/class="row-menu"/g)?.length).toBe(3);
    expect(markup).toContain('이름 변경');
    expect(markup).toContain('>보관<');
    expect(markup).toContain('>삭제<');
    expect(markup).not.toContain('삭제 확인');
  });

  it('offers the archive count as a toggle', () => {
    const markup = renderToStaticMarkup(
      <SessionList
        items={items}
        query=""
        title="sessions"
        empty="없음"
        archivedCount={2}
        showArchived={false}
        onShowArchived={noop}
        {...sessionActions}
      />,
    );
    expect(markup).toContain('보관함 2');

    const open = renderToStaticMarkup(
      <SessionList
        items={items}
        query=""
        title="sessions"
        empty="없음"
        archivedCount={2}
        showArchived
        onShowArchived={noop}
        {...sessionActions}
      />,
    );
    expect(open).toContain('보관함 접기');
    expect(open).toContain('archive-toggle on');
  });

  it('shows the query and an empty result line', () => {
    const markup = renderToStaticMarkup(
      <SessionList items={[]} query="강릉" title="sessions" empty="아직 대화가 없습니다" {...sessionActions} />,
    );
    expect(markup).toContain('value="강릉"');
    expect(markup).toContain('“강릉” 결과 없음');
  });
});
