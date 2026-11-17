import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DeskController, DeskState } from './lib/desk';
import { copyText, downloadPayload } from './lib/download';
import type { ExportFormat } from './lib/export';
import type { PlanDecision, ReplySlot, TransportKind } from './lib/types';
import { Composer } from './components/Composer';
import { ConnectPanel } from './components/ConnectPanel';
import { ExportMenu } from './components/ExportMenu';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';

interface AppProps {
  desk: DeskController;
}

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'streaming parser', prompt: 'SSE 응답에서 청크가 프레임 중간에서 끊기면 어떻게 처리해야 해?' },
  { label: 'compare routes', prompt: '스트리밍 응답과 배치 응답, 채팅 UI엔 어느 쪽이 맞아? 비교해 줘.' },
  { label: 'design order', prompt: '데몬이 상태를 들고 있는 채팅 클라이언트의 구현 순서를 잡아줘.' },
];
function EmptyState({ onPick, state }: { onPick: (prompt: string) => void; state: DeskState }) {
  return (
    <div className="empty">
      <div className="empty-mark mono">damon / chat desk</div>
      <h1>
        라우팅이 보이는 채팅.
        <br />
        <span className="empty-sub">하나의 데몬, 여러 프로바이더.</span>
      </h1>
      <p className="empty-copy">
        메시지마다 프로바이더를 고르고, 같은 프롬프트를 두 곳에 동시에 보내 비교합니다. 대화와 메모리는 브라우저가 아니라 데몬에 남습니다.
        {state.connection.transport === 'demo' ? ' 지금은 시뮬레이션된 데모 데몬으로 동작합니다.' : ''}
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button type="button" key={suggestion.label} className="suggestion" onClick={() => onPick(suggestion.prompt)}>
            <span className="suggestion-label mono">{suggestion.label}</span>
            <span className="suggestion-text">{suggestion.prompt}</span>
          </button>
        ))}
      </div>
      <div className="feature-grid">
        <div className="feature">
          <span className="feature-key mono">01 / route</span>
          <p>메시지 단위 프로바이더 스위치. 응답마다 어디로 갔는지, 얼마나 걸렸는지 남습니다.</p>
        </div>
        <div className="feature">
          <span className="feature-key mono">02 / split</span>
          <p>같은 프롬프트를 두 프로바이더에 fan-out, 나란히 스트리밍.</p>
        </div>
        <div className="feature">
          <span className="feature-key mono">03 / tools</span>
          <p>툴 호출은 한 줄로 접히고, 펼치면 인자·stdout·diff·소요 시간이 그대로 보입니다.</p>
        </div>
        <div className="feature">
          <span className="feature-key mono">04 / steer · plan</span>
          <p>스트리밍 중 방향 수정(turn.steer), 에이전트 계획서 승인/수정 요청(plan.respond), 턴 단위 분기(session.fork).</p>
        </div>
      </div>
    </div>
  );
}

export function App({ desk }: AppProps) {
  const state = useSyncExternalStore(desk.subscribe, desk.getSnapshot);
  const [connectOpen, setConnectOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const conversation = state.conversations.find((entry) => entry.id === state.activeId) ?? null;

  useEffect(() => {
    if (!state.notice) return;
    setToast(state.notice);
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [state.notice]);

  const connect = (transport: TransportKind, baseUrl: string, opts: { masterToken?: string; deviceToken?: string }) => {
    void desk.connect(transport, baseUrl, opts).then(() => setConnectOpen(false));
  };

  const respond = (slot: ReplySlot, actionId: string) => {
    const ask = slot.ask;
    if (!ask) return;
    const action = ask.actions.find((entry) => entry.id === actionId) ?? ask.actions[0];
    if (!action) return;
    void desk.respond(ask, action, slot.daemonSessionId);
  };

  const fork = (messageId: string) => {
    if (conversation) void desk.forkAt(conversation.id, messageId);
  };

  const plan = (messageId: string, slot: ReplySlot, decision: PlanDecision, feedback?: string) => {
    if (!conversation) return;
    void desk.respondPlan({ convId: conversation.id, messageId, slotId: slot.id }, decision, feedback);
  };

  const exportConversation = (format: ExportFormat) => {
    if (!conversation) {
      desk.notify('내보낼 대화가 없습니다');
      return;
    }
    const payload = desk.exportConversation(conversation.id, format);
    if (!payload) return;
    if (!downloadPayload(payload)) {
      desk.notify('이 브라우저에서는 파일을 저장할 수 없습니다 — 클립보드 복사를 쓰세요');
      return;
    }
    desk.notify(`${payload.filename} 저장됨`);
  };

  const copyConversation = async () => {
    if (!conversation) {
      desk.notify('복사할 대화가 없습니다');
      return;
    }
    const payload = desk.exportConversation(conversation.id, 'markdown');
    if (!payload) return;
    const copied = await copyText(payload.content);
    desk.notify(copied ? 'Markdown을 클립보드에 복사했습니다' : '클립보드 복사가 차단되었습니다 — 다운로드를 쓰세요');
  };

  return (
    <div className="app">
      <Sidebar
        state={state}
        onNew={() => desk.newConversation()}
        onSelect={(id) => desk.selectConversation(id)}
        onDelete={(id) => void desk.deleteConversation(id)}
        onRename={(id, title) => void desk.renameConversation(id, title)}
        onArchive={(id, archived) => void desk.archiveConversation(id, archived)}
        onSessionQuery={(query) => desk.setSessionQuery(query)}
        onShowArchived={(show) => desk.setShowArchived(show)}
        onOpenDaemon={(row) => void desk.openDaemonSession(row)}
        onRefreshDaemon={() => void desk.refreshDaemonSessions()}
        onRenameDaemon={(row, title) => void desk.renameDaemonSession(row, title)}
        onArchiveDaemon={(row, archived) => void desk.archiveDaemonSession(row, archived)}
        onDeleteDaemon={(row) => void desk.deleteDaemonSession(row)}
        onMemoryToggle={(enabled) => desk.setMemoryEnabled(enabled)}
        memory={{
          onQuery: (text) => desk.setMemoryQuery(text),
          onFilter: (filter) => desk.setMemoryFilter(filter),
          onScope: (scope, owner) => void desk.setMemoryScope(scope, owner),
          onAdd: (content) => void desk.addMemory(content),
          onUpdate: (entry, content) => void desk.updateMemory(entry, content),
          onRemove: (entry) => void desk.removeMemory(entry),
          onApprove: (entry) => void desk.approveMemory(entry),
          onReject: (entry) => void desk.rejectMemory(entry),
          onRefresh: () => void desk.refreshMemory(),
        }}
        onExport={exportConversation}
        onCopy={() => void copyConversation()}
        onConnect={() => setConnectOpen(true)}
        onDemo={() => void desk.enterDemo()}
        onClose={() => desk.openSidebar(false)}
      />
      {state.sidebarOpen ? <div className="scrim" onClick={() => desk.openSidebar(false)} role="presentation" /> : null}

      <main className={`main ${state.compare ? 'wide' : ''}`}>
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => desk.openSidebar(true)} aria-label="메뉴">
            ☰
          </button>
          <div className="topbar-title">
            <h1>{conversation?.title ?? '새 대화'}</h1>
            <div className="topbar-sub mono">
              <span className={`pill ${state.connection.transport}`}>
                {state.connection.transport === 'demo' ? 'demo' : state.connection.transport === 'daemon' ? 'daemon' : 'openai'}
              </span>
              <span>{state.connection.targets.length} routes</span>
              {conversation ? <span className="faint">· {conversation.messages.length} messages</span> : null}
            </div>
          </div>
          <div className="topbar-right">
            {conversation?.forkedFrom ? <span className="badge mono">branch</span> : null}
            {state.compare ? <span className="badge mono">split</span> : null}
            <ExportMenu
              disabled={!conversation || conversation.messages.length === 0}
              onExport={exportConversation}
              onCopy={() => void copyConversation()}
            />
            <button type="button" className="icon-btn" onClick={() => setConnectOpen(true)} aria-label="연결 설정" title="연결 설정">
              ⚙
            </button>
          </div>
        </header>

        <Transcript
          messages={conversation?.messages ?? []}
          onRetry={(message, slot) => {
            if (conversation) void desk.retrySlot(conversation.id, message.id, slot.id);
          }}
          onCancel={(slot) => desk.cancel(slot.id)}
          onRespond={(slot, actionId) => respond(slot, actionId)}
          onFork={(message) => fork(message.id)}
          onPlan={(message, slot, decision, feedback) => plan(message.id, slot, decision, feedback)}
          emptyState={<EmptyState state={state} onPick={(prompt) => void desk.send(prompt)} />}
        />

        <Composer
          targets={state.connection.targets}
          primaryKey={state.primaryKey}
          secondaryKey={state.secondaryKey}
          compare={state.compare}
          busy={state.busy}
          memoryEnabled={state.memory.enabled}
          memoryCount={state.memory.entries.filter((entry) => entry.status === 'active').length}
          onSend={(prompt) => void desk.send(prompt)}
          onSteer={(text) => void desk.steer(text)}
          onPrimary={(key: string) => desk.setPrimary(key)}
          onSecondary={(key: string) => desk.setSecondary(key)}
          onCompare={(compare: boolean) => desk.setCompare(compare)}
          onMemory={(enabled: boolean) => desk.setMemoryEnabled(enabled)}
        />
      </main>

      <ConnectPanel
        open={connectOpen}
        state={state}
        onClose={() => setConnectOpen(false)}
        onConnect={connect}
        onDemo={() => void desk.enterDemo()}
        onPair={(key, name) => void desk.pairDevice(key, name)}
        onCheckPairing={() => void desk.checkPairing()}
      />

      {toast ? <div className="toast mono">{toast}</div> : null}
    </div>
  );
}
