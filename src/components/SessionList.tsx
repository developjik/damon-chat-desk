import { useEffect, useState } from 'react';
import type { SessionStatusRow } from '../lib/types';
import { PhaseChip } from './SessionPhase';

/** One row of either list — the daemon's sessions and the local ones. */
export interface SessionItem {
  key: string;
  kind: 'local' | 'daemon';
  title: string;
  meta: string;
  badge?: string;
  active: boolean;
  archived: boolean;
  /** What `session.status` says this session is doing right now. */
  phase?: SessionStatusRow;
}

interface SessionListProps {
  items: SessionItem[];
  query: string;
  title: string;
  empty: string;
  onQuery: (text: string) => void;
  onSelect: (item: SessionItem) => void;
  onRename: (item: SessionItem, title: string) => void;
  onArchive: (item: SessionItem, archived: boolean) => void;
  onDelete: (item: SessionItem) => void;
  /** Archived rows are counted but hidden unless asked for. */
  archivedCount?: number;
  showArchived?: boolean;
  onShowArchived?: (show: boolean) => void;
  onRefresh?: () => void;
  /** Only the first list keeps the box; the daemon list shares its query. */
  showSearch?: boolean;
}

/**
 * A session list with a live search box and a per-row menu (rename,
 * archive, delete). Delete is a two-step: the first press turns the
 * button into a confirm, so a session is never lost on a stray click.
 */
export function SessionList({
  items,
  query,
  title,
  empty,
  onQuery,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  archivedCount = 0,
  showArchived = false,
  onShowArchived,
  onRefresh,
  showSearch = true,
}: SessionListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  // A row menu closes on an outside click or Escape — never more than one open.
  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.row-menu')) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const startRename = (item: SessionItem) => {
    setEditing(item.key);
    setDraft(item.title);
    setConfirming(null);
    setMenu(null);
  };

  const commit = (item: SessionItem) => {
    const next = draft.trim();
    setEditing(null);
    setDraft('');
    if (next && next !== item.title) onRename(item, next);
  };

  return (
    <nav className="sessions">
      <div className="section-head">
        <span>{title}</span>
        <span className="mem-head-right">
          {onRefresh ? (
            <button type="button" className="icon-btn" onClick={onRefresh} aria-label="세션 새로고침" title="새로고침">
              ↻
            </button>
          ) : null}
          <span className="count mono">{items.length}</span>
        </span>
      </div>

      {showSearch ? (
        <input
          className="session-search"
          type="search"
          value={query}
          placeholder="세션 검색 — 제목·내용·툴"
          onChange={(event) => onQuery(event.target.value)}
          spellCheck={false}
          aria-label="세션 검색"
        />
      ) : null}

      <ul>
        {items.map((item) => (
          <li key={`${item.kind}-${item.key}`} className={item.active ? 'active-row' : ''}>
            <div className="session-row">
              <button
                type="button"
                className={`session ${item.active ? 'active' : ''}`}
                onClick={() => onSelect(item)}
                title={item.title}
              >
                {item.badge || item.phase ? (
                  <span className="session-flags">
                    {item.badge ? <span className="backend-chip mono">{item.badge}</span> : null}
                    <PhaseChip row={item.phase} compact />
                  </span>
                ) : null}
                <span className="session-title">{item.title}</span>
                <span className="session-meta mono">{item.meta}</span>
              </button>
              <div className={`row-menu${menu === item.key ? ' open' : ''}`}>
                <button
                  type="button"
                  className="row-menu-trigger"
                  aria-label="세션 메뉴"
                  aria-expanded={menu === item.key}
                  title="세션 메뉴"
                  onClick={() => {
                    setMenu(menu === item.key ? null : (item.key as string));
                    setConfirming(null);
                  }}
                >
                  ⋯
                </button>
                <div className="row-menu-body">
                  <button type="button" onClick={() => startRename(item)}>
                    이름 변경
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      onArchive(item, !item.archived);
                    }}
                  >
                    {item.archived ? '보관 해제' : '보관'}
                  </button>
                  {confirming === item.key ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setConfirming(null);
                        setMenu(null);
                        onDelete(item);
                      }}
                    >
                      삭제 확인
                    </button>
                  ) : (
                    <button type="button" className="danger" onClick={() => setConfirming(item.key)}>
                      삭제
                    </button>
                  )}
                </div>
              </div>
            </div>

            {editing === item.key ? (
              <form
                className="rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  commit(item);
                }}
              >
                <input
                  className="rename-input"
                  value={draft}
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditing(null);
                      setDraft('');
                    }
                  }}
                  aria-label="세션 이름"
                />
                <button type="submit" className="ghost-btn tiny accent">
                  저장
                </button>
                <button
                  type="button"
                  className="ghost-btn tiny"
                  onClick={() => {
                    setEditing(null);
                    setDraft('');
                  }}
                >
                  취소
                </button>
              </form>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? <li className="empty-row">{query.trim() ? `“${query.trim()}” 결과 없음` : empty}</li> : null}
      </ul>

      {onShowArchived && archivedCount > 0 ? (
        <button type="button" className={`archive-toggle ${showArchived ? 'on' : ''}`} onClick={() => onShowArchived(!showArchived)}>
          <span aria-hidden>▤</span>
          {showArchived ? '보관함 접기' : `보관함 ${archivedCount}`}
        </button>
      ) : null}
    </nav>
  );
}
