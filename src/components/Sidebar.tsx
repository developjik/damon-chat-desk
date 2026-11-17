import { memoryBlock, type DeskState } from '../lib/desk';
import type { Conversation } from '../lib/types';
import { backendTitle, type DaemonSessionRow } from '../lib/daemon';

interface SidebarProps {
  state: DeskState;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenDaemon: (row: DaemonSessionRow) => void;
  onRefreshDaemon: () => void;
  onMemory: (enabled: boolean) => void;
  onConnect: () => void;
  onDemo: () => void;
  onClose: () => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

function sessionTitle(conversation: Conversation): string {
  return conversation.title || '새 대화';
}

export function Sidebar({
  state,
  onNew,
  onSelect,
  onDelete,
  onOpenDaemon,
  onRefreshDaemon,
  onMemory,
  onConnect,
  onDemo,
  onClose,
}: SidebarProps) {
  const { connection, memory } = state;
  const live = connection.status === 'live';
  const conversations = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const activeEntries = memory.entries.filter((entry) => entry.status === 'active');
  const preview = memoryBlock(memory.entries);

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

      <nav className="sessions">
        <div className="section-head">
          <span>sessions</span>
          <span className="count mono">{conversations.length}</span>
        </div>
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className={`session ${conversation.id === state.activeId ? 'active' : ''}`}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="session-title">{sessionTitle(conversation)}</span>
                <span className="session-meta mono">
                  {conversation.messages.length} msg · {relativeTime(conversation.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="session-del"
                onClick={() => onDelete(conversation.id)}
                aria-label="대화 삭제"
                title="삭제"
              >
                ×
              </button>
            </li>
          ))}
          {conversations.length === 0 ? <li className="empty-row">아직 대화가 없습니다</li> : null}
        </ul>
      </nav>

      {connection.transport === 'daemon' && live ? (
        <nav className="sessions daemon">
          <div className="section-head">
            <span>on the daemon</span>
            <button type="button" className="icon-btn" onClick={onRefreshDaemon} aria-label="데몬 세션 새로고침" title="새로고침">
              ↻
            </button>
          </div>
          <ul>
            {state.daemonSessions.map((row) => (
              <li key={row.sessionId}>
                <button type="button" className="session daemon-row" onClick={() => onOpenDaemon(row)}>
                  <span className="backend-chip mono">{backendTitle(row.backend)}</span>
                  <span className="session-title">{row.title || row.sessionId.slice(0, 10)}</span>
                </button>
              </li>
            ))}
            {state.daemonSessions.length === 0 ? <li className="empty-row">데몬에 세션이 없습니다</li> : null}
          </ul>
        </nav>
      ) : null}

      <section className="memory">
        <div className="section-head">
          <span>memory</span>
          <label className="switch">
            <input type="checkbox" checked={memory.enabled} onChange={(event) => onMemory(event.target.checked)} />
            <span className="slider" aria-hidden />
          </label>
        </div>
        <div className="memory-meta mono">
          <span>
            {activeEntries.length} active
            {memory.entries.length > activeEntries.length ? ` · ${memory.entries.length - activeEntries.length} pending` : ''}
          </span>
          {memory.limit ? (
            <span className="faint">
              {memory.chars}/{memory.limit}
            </span>
          ) : (
            <span className="faint">local</span>
          )}
        </div>
        <ul className="memory-list">
          {memory.entries.slice(0, 6).map((entry) => (
            <li key={entry.id} className={entry.status}>
              <span className={`mem-dot ${entry.status}`} aria-hidden />
              <span className="mem-text">{entry.content}</span>
            </li>
          ))}
          {memory.entries.length === 0 ? (
            <li className="empty-row">
              {connection.transport === 'daemon'
                ? '메모리 원장이 비어 있습니다'
                : connection.transport === 'demo'
                  ? '시뮬레이션 원장을 사용합니다'
                  : '이 모드에는 메모리 원장이 없습니다'}
            </li>
          ) : null}
        </ul>
        {preview ? (
          <details className="mem-preview">
            <summary className="mono">injected context</summary>
            <pre className="mono">{preview}</pre>
          </details>
        ) : null}
        <div className="memory-note">
          {connection.transport === 'daemon'
            ? 'memory.* RPC로 동기화 · 주입은 이 클라이언트가 프롬프트 앞에 붙입니다'
            : connection.transport === 'demo'
              ? '시뮬레이션된 원장 (localStorage)'
              : 'OpenAI 호환 모드에서는 메모리 원장이 없습니다'}
        </div>
      </section>

      <footer className="sidebar-foot">
        <span className="mono">damon-agent-core</span>
        <span className="faint">static SPA · no server</span>
      </footer>
    </aside>
  );
}
