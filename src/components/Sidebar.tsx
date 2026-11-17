import type { DeskState } from '../lib/desk';
import type { ExportFormat } from '../lib/export';
import { conversationMeta, filterConversations, filterDaemonRows, relativeTime } from '../lib/sessions';
import type { DaemonSessionRow } from '../lib/daemon';
import type { MemoryEntry, MemoryFilter, MemoryScope } from '../lib/types';
import { MemoryPanel } from './MemoryPanel';
import { SessionList, type SessionItem } from './SessionList';

interface SidebarProps {
  state: DeskState;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onSessionQuery: (query: string) => void;
  onShowArchived: (show: boolean) => void;
  onOpenDaemon: (row: DaemonSessionRow) => void;
  onRefreshDaemon: () => void;
  onRenameDaemon: (row: DaemonSessionRow, title: string) => void;
  onArchiveDaemon: (row: DaemonSessionRow, archived: boolean) => void;
  onDeleteDaemon: (row: DaemonSessionRow) => void;
  onMemoryToggle: (enabled: boolean) => void;
  memory: {
    onQuery: (text: string) => void;
    onFilter: (filter: MemoryFilter) => void;
    onScope: (scope: MemoryScope, owner?: string) => void;
    onAdd: (content: string) => void;
    onUpdate: (entry: MemoryEntry, content: string) => void;
    onRemove: (entry: MemoryEntry) => void;
    onApprove: (entry: MemoryEntry) => void;
    onReject: (entry: MemoryEntry) => void;
    onRefresh: () => void;
  };
  onExport: (format: ExportFormat) => void;
  onCopy: () => void;
  onConnect: () => void;
  onDemo: () => void;
  onClose: () => void;
}

export function Sidebar({
  state,
  onNew,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onSessionQuery,
  onShowArchived,
  onOpenDaemon,
  onRefreshDaemon,
  onRenameDaemon,
  onArchiveDaemon,
  onDeleteDaemon,
  onMemoryToggle,
  memory,
  onExport,
  onCopy,
  onConnect,
  onDemo,
  onClose,
}: SidebarProps) {
  const { connection } = state;
  const live = connection.status === 'live';
  const query = state.sessions.query;
  const showArchived = state.sessions.showArchived;
  const archivedCount = state.conversations.filter((conversation) => conversation.archived === true).length;
  const active = state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;

  const conversationItems: SessionItem[] = filterConversations(state.conversations, {
    text: query,
    archived: showArchived,
  })
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((conversation) => ({
      key: conversation.id,
      kind: 'local',
      title: conversation.title || '새 대화',
      meta: conversationMeta(conversation),
      active: conversation.id === state.activeId,
      archived: conversation.archived === true,
    }));

  const daemonRows = filterDaemonRows(state.daemonSessions, { text: query, includeArchived: showArchived });
  const daemonByKey = new Map(state.daemonSessions.map((row) => [row.sessionId, row]));
  const daemonItems: SessionItem[] = daemonRows.map((row) => ({
    key: row.sessionId,
    kind: 'daemon',
    title: row.title || row.sessionId.slice(0, 12),
    meta: `${relativeTime(row.createdAt)}${row.pinned ? ' · pinned' : ''}${row.archived ? ' · 보관' : ''}`,
    badge: row.backend,
    active: false,
    archived: row.archived === true,
  }));

  const rowOf = (item: SessionItem): DaemonSessionRow | undefined => daemonByKey.get(item.key);

  return (
    <aside className={`sidebar ${state.sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◆
          </span>
          <span className="brand-name">damon</span>
          <span className="brand-sub">chat desk</span>
        </div>
        <span className="version mono">v0.1</span>
        <button type="button" className="icon-btn close-sidebar" onClick={onClose} aria-label="사이드바 닫기">
          ✕
        </button>
      </div>

      <button type="button" className="new-chat" onClick={onNew}>
        <span className="plus" aria-hidden>
          +
        </span>
        새 대화
      </button>

      <div className="export-row" role="group" aria-label="대화 내보내기">
        <span className="export-row-label mono">export</span>
        <button type="button" className="ghost-btn tiny" onClick={() => onExport('markdown')} disabled={!active} title="현재 대화를 Markdown 파일로">
          ⤓ md
        </button>
        <button type="button" className="ghost-btn tiny" onClick={() => onExport('json')} disabled={!active} title="현재 대화를 JSON 파일로">
          ⤓ json
        </button>
        <button type="button" className="ghost-btn tiny" onClick={onCopy} disabled={!active} title="Markdown을 클립보드로">
          copy
        </button>
      </div>

      <section className={`conn-card ${connection.status}`}>
        <div className="conn-row">
          <span className={`pill ${connection.transport}`}>{connection.transport === 'demo' ? 'demo' : connection.transport === 'daemon' ? 'daemon' : 'openai'}</span>
          <span className={`conn-status ${live ? 'live' : connection.status}`}>
            <span className={`dot ${live ? 'ok' : connection.status === 'probing' ? 'warn' : 'err'}`} aria-hidden />
            {connection.status}
          </span>
          <button type="button" className="icon-btn" onClick={onConnect} aria-label="연결 설정">
            ⚙
          </button>
        </div>
        <div className="conn-url mono">{connection.baseUrl}</div>
        <div className="conn-note">
          {connection.status === 'offline' || connection.status === 'error'
            ? connection.error
            : connection.version ?? connection.probeNote}
        </div>
        {connection.transport === 'demo' ? (
          <div className="conn-actions">
            <button type="button" className="ghost-btn" onClick={onConnect}>
              데몬 연결
            </button>
          </div>
        ) : (
          <div className="conn-actions">
            <button type="button" className="ghost-btn" onClick={onDemo}>
              데모로 전환
            </button>
          </div>
        )}
      </section>

      <SessionList
        items={conversationItems}
        query={query}
        title="sessions"
        empty="아직 대화가 없습니다"
        onQuery={onSessionQuery}
        onSelect={(item) => onSelect(item.key)}
        onRename={(item, title) => onRename(item.key, title)}
        onArchive={(item, archived) => onArchive(item.key, archived)}
        onDelete={(item) => onDelete(item.key)}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onShowArchived={onShowArchived}
      />

      {connection.transport === 'daemon' && live ? (
        <SessionList
          items={daemonItems}
          query={query}
          title="on the daemon"
          empty="데몬에 세션이 없습니다"
          onQuery={onSessionQuery}
          onSelect={(item) => {
            const row = rowOf(item);
            if (row) onOpenDaemon(row);
          }}
          onRename={(item, title) => {
            const row = rowOf(item);
            if (row) onRenameDaemon(row, title);
          }}
          onArchive={(item, archived) => {
            const row = rowOf(item);
            if (row) onArchiveDaemon(row, archived);
          }}
          onDelete={(item) => {
            const row = rowOf(item);
            if (row) onDeleteDaemon(row);
          }}
          onRefresh={onRefreshDaemon}
          showSearch={false}
        />
      ) : null}

      <MemoryPanel
        memory={state.memory}
        transport={connection.transport}
        onToggle={onMemoryToggle}
        onQuery={memory.onQuery}
        onFilter={memory.onFilter}
        onScope={memory.onScope}
        onAdd={memory.onAdd}
        onUpdate={memory.onUpdate}
        onRemove={memory.onRemove}
        onApprove={memory.onApprove}
        onReject={memory.onReject}
        onRefresh={memory.onRefresh}
      />

      <footer className="sidebar-foot">
        <span className="mono">damon-agent-core</span>
        <span className="faint">static SPA · no server</span>
      </footer>
    </aside>
  );
}
