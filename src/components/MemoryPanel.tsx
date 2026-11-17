import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../lib/desk';
import { filterMemory, memoryBadges, memoryKey, memoryStats, memoryValue } from '../lib/memory';
import { relativeTime } from '../lib/sessions';
import type { MemoryEntry, MemoryFilter, MemoryScope, TransportKind } from '../lib/types';

interface MemoryPanelProps {
  memory: DeskState['memory'];
  transport: TransportKind;
  onToggle: (enabled: boolean) => void;
  onQuery: (text: string) => void;
  onFilter: (filter: MemoryFilter) => void;
  onScope: (scope: MemoryScope, owner?: string) => void;
  onAdd: (content: string) => void;
  onUpdate: (entry: MemoryEntry, content: string) => void;
  onRemove: (entry: MemoryEntry) => void;
  onApprove: (entry: MemoryEntry) => void;
  onReject: (entry: MemoryEntry) => void;
  onRefresh: () => void;
}

const FILTERS: Array<{ id: MemoryFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'active', label: 'active' },
  { id: 'pending', label: 'pending' },
];

function MemoryRow({
  entry,
  busy,
  editing,
  editDraft,
  onEditDraft,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onApprove,
  onReject,
}: {
  entry: MemoryEntry;
  busy: boolean;
  editing: boolean;
  editDraft: string;
  onEditDraft: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRemove: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pending = entry.status === 'pending';
  const key = memoryKey(entry);
  return (
    <li className={`mem-row ${entry.status}${expanded ? ' open' : ''}`}>
      <div className="mem-row-head">
        {key ? (
          <span className="mem-key mono" title={entry.id}>
            {key}
          </span>
        ) : null}
        {memoryBadges(entry).map((badge) => (
          <span className={`mem-badge ${badge.kind}`} key={`${badge.kind}-${badge.label}`}>
            {badge.label}
          </span>
        ))}
      </div>

      {editing ? (
        <div className="mem-edit">
          <textarea
            className="mem-edit-area"
            value={editDraft}
            rows={3}
            onChange={(event) => onEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSaveEdit();
              }
              if (event.key === 'Escape') onCancelEdit();
            }}
          />
          <div className="mem-edit-actions">
            <button type="button" className="ghost-btn accent" onClick={onSaveEdit} disabled={busy || !editDraft.trim()}>
              저장
            </button>
            <button type="button" className="ghost-btn" onClick={onCancelEdit}>
              취소
            </button>
            <span className="mem-edit-hint mono">⌘↵</span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mem-value"
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? '접기' : '전체 보기'}
        >
          {expanded ? entry.content : memoryValue(entry) || entry.content}
        </button>
      )}

      <div className="mem-row-foot">
        <span className="mem-when mono">{entry.updatedAt ? relativeTime(entry.updatedAt) : '—'}</span>
        <span className="mem-row-actions">
          {pending ? (
            <>
              <button type="button" className="ghost-btn tiny accent" onClick={onApprove} disabled={busy}>
                승인
              </button>
              <button type="button" className="ghost-btn tiny danger" onClick={onReject} disabled={busy}>
                거절
              </button>
            </>
          ) : null}
          <button type="button" className="ghost-btn tiny" onClick={onStartEdit} disabled={busy || editing}>
            수정
          </button>
          <button type="button" className="ghost-btn tiny danger" onClick={onRemove} disabled={busy}>
            삭제
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * The memory ledger panel: read every entry of the selected ledger,
 * search and filter it, and write/edit/remove through `memory.*`. A
 * pending entry (one the gate chain held for approval) gets approve and
 * reject here instead of being silently injected.
 */
export function MemoryPanel({
  memory,
  transport,
  onToggle,
  onQuery,
  onFilter,
  onScope,
  onAdd,
  onUpdate,
  onRemove,
  onApprove,
  onReject,
  onRefresh,
}: MemoryPanelProps) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [ownerDraft, setOwnerDraft] = useState(memory.view.owner ?? 'scribe');
  const composer = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (memory.view.owner) setOwnerDraft(memory.view.owner);
  }, [memory.view.owner]);

  useEffect(() => {
    if (composing) composer.current?.focus();
  }, [composing]);

  const visible = filterMemory(memory.view.entries, { text: memory.query, filter: memory.filter });
  const stats = memoryStats(memory.view.entries);
  const usage = memory.view.chars;
  const limit = memory.view.limit;
  const ratio = limit > 0 ? Math.min(1, usage / limit) : 0;
  const disabled = !memory.supported || memory.busy;
  const scope = memory.view.scope;

  const commitOwner = () => {
    const owner = ownerDraft.trim();
    if (owner && owner !== memory.view.owner) onScope('bot', owner);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onAdd(text);
    setDraft('');
    setComposing(false);
  };

  const saveEdit = (entry: MemoryEntry) => {
    const text = editDraft.trim();
    if (!text) return;
    onUpdate(entry, text);
    setEditingId(null);
    setEditDraft('');
  };

  return (
    <section className="memory">
      <div className="section-head">
        <span>memory</span>
        <span className="mem-head-right">
          <button type="button" className="icon-btn" onClick={onRefresh} aria-label="메모리 새로고침" title="새로고침">
            ↻
          </button>
          <label className="switch" title="저장된 메모리를 프롬프트 앞에 붙입니다">
            <input type="checkbox" checked={memory.enabled} onChange={(event) => onToggle(event.target.checked)} />
            <span className="slider" aria-hidden />
          </label>
        </span>
      </div>

      <div className="mem-toolbar">
        <input
          className="mem-search"
          type="search"
          value={memory.query}
          placeholder="메모리 검색"
          onChange={(event) => onQuery(event.target.value)}
          spellCheck={false}
        />
        <div className="mem-chips" role="group" aria-label="메모리 스코프">
          <button
            type="button"
            className={`mem-chip ${scope === 'user' ? 'on' : ''}`}
            onClick={() => onScope('user')}
            title="사용자 원장 (memory.list scope: user)"
          >
            user
          </button>
          <button
            type="button"
            className={`mem-chip ${scope === 'bot' ? 'on' : ''}`}
            onClick={() => onScope('bot', ownerDraft.trim() || 'scribe')}
            title="봇 원장 (memory.list scope: bot, owner)"
          >
            bot
          </button>
          {scope === 'bot' ? (
            <input
              className="mem-owner"
              value={ownerDraft}
              placeholder="owner"
              onChange={(event) => setOwnerDraft(event.target.value)}
              onBlur={commitOwner}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitOwner();
                }
              }}
              spellCheck={false}
            />
          ) : null}
        </div>
        <div className="mem-chips filters" role="group" aria-label="메모리 필터">
          {FILTERS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`mem-chip ${memory.filter === entry.id ? 'on' : ''}`}
              onClick={() => onFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="memory-meta mono">
        <span>
          {stats.active} active
          {stats.pending > 0 ? ` · ${stats.pending} pending` : ''}
          {visible.length !== memory.view.entries.length ? ` · ${visible.length} shown` : ''}
        </span>
        {limit > 0 ? (
          <span className="faint">
            {usage}/{limit}
          </span>
        ) : (
          <span className="faint">{memory.supported ? 'no ledger' : 'local'}</span>
        )}
      </div>
      {limit > 0 ? (
        <div className={`mem-meter ${ratio > 0.9 ? 'full' : ''}`} aria-hidden>
          <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
        </div>
      ) : null}

      {memory.error ? <div className="mem-error">{memory.error}</div> : null}

      <ul className="mem-list">
        {visible.map((entry) => (
          <MemoryRow
            key={entry.id}
            entry={entry}
            busy={Boolean(memory.busy)}
            editing={editingId === entry.id}
            editDraft={editingId === entry.id ? editDraft : ''}
            onEditDraft={setEditDraft}
            onStartEdit={() => {
              setEditingId(entry.id);
              setEditDraft(entry.content);
            }}
            onCancelEdit={() => {
              setEditingId(null);
              setEditDraft('');
            }}
            onSaveEdit={() => saveEdit(entry)}
            onRemove={() => onRemove(entry)}
            onApprove={() => onApprove(entry)}
            onReject={() => onReject(entry)}
          />
        ))}
        {visible.length === 0 ? (
          <li className="empty-row">
            {!memory.supported
              ? '이 모드에는 메모리 원장이 없습니다'
              : memory.view.entries.length === 0
                ? `${scope} 원장이 비어 있습니다`
                : memory.query.trim()
                  ? `“${memory.query.trim()}”에 맞는 메모리가 없습니다`
                  : '이 필터에 해당하는 메모리가 없습니다'}
          </li>
        ) : null}
      </ul>

      {composing ? (
        <div className="mem-form">
          <textarea
            ref={composer}
            className="mem-form-area"
            value={draft}
            rows={3}
            placeholder={scope === 'bot' ? `${ownerDraft || 'owner'} 원장에 저장할 내용` : '저장할 내용 — 사실 위주로'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
              if (event.key === 'Escape') {
                setComposing(false);
                setDraft('');
              }
            }}
          />
          <div className="mem-form-actions">
            <span className="mem-form-target mono">
              → {scope === 'bot' ? `bot · ${ownerDraft || 'owner'}` : 'user'} ledger
            </span>
            <button type="button" className="ghost-btn accent" onClick={submit} disabled={disabled || !draft.trim()}>
              저장
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setComposing(false);
                setDraft('');
              }}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="mem-add" onClick={() => setComposing(true)} disabled={disabled}>
          <span aria-hidden>+</span> 새 메모
        </button>
      )}

      <div className="memory-note">
        {transport === 'daemon'
          ? 'memory.list / write / remove / approve · 주입은 이 클라이언트가 프롬프트 앞에 붙입니다'
          : transport === 'demo'
            ? '시뮬레이션된 원장 — 쓰기·승인·삭제가 같은 게이트를 흉내 냅니다'
            : 'OpenAI 호환 모드에서는 메모리 원장이 없습니다'}
      </div>
    </section>
  );
}
