import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, PlanDecision, ReplySlot } from '../lib/types';
import { Markdown } from './Markdown';
import { PlanCard } from './PlanCard';
import { ToolViewer } from './ToolViewer';
import { SlotMetrics } from './RoutePicker';

interface TranscriptProps {
  messages: ChatMessage[];
  onRetry: (message: ChatMessage, slot: ReplySlot) => void;
  onCancel: (slot: ReplySlot) => void;
  onRespond: (slot: ReplySlot, actionId: string) => void;
  onFork: (message: ChatMessage, slot: ReplySlot) => void;
  onPlan: (message: ChatMessage, slot: ReplySlot, decision: PlanDecision, feedback?: string) => void;
  emptyState: React.ReactNode;
}

function StatusLabel({ status }: { status: ReplySlot['status'] }) {
  if (status === 'streaming') {
    return (
      <span className="status streaming">
        <span className="pulse" aria-hidden />
        streaming
      </span>
    );
  }
  if (status === 'error') return <span className="status error">error</span>;
  if (status === 'canceled') return <span className="status muted">canceled</span>;
  if (status === 'queued') return <span className="status muted">queued</span>;
  return <span className="status muted">done</span>;
}

function SlotCard({
  slot,
  now,
  onRetry,
  onCancel,
  onRespond,
  onFork,
  onPlan,
}: {
  slot: ReplySlot;
  now: number;
  onRetry: () => void;
  onCancel: () => void;
  onRespond: (actionId: string) => void;
  onFork: () => void;
  onPlan: (decision: PlanDecision, feedback?: string) => void;
}) {
  const streaming = slot.status === 'streaming' || slot.status === 'queued';
  return (
    <article className={`slot ${slot.status} ${streaming ? 'live' : ''}`}>
      <header className="slot-head">
        <span className={`route-dot ${slot.status === 'error' ? 'err' : 'ok'}`} aria-hidden />
        <span className="slot-provider">{slot.target.providerLabel}</span>
        <span className="slash" aria-hidden>
          /
        </span>
        <span className="slot-model mono">{slot.target.model || 'default'}</span>
        <span className="slot-head-right">
          <StatusLabel status={slot.status} />
        </span>
      </header>

      {slot.notice ? <div className="slot-notice mono">{slot.notice}</div> : null}

      {slot.steers && slot.steers.length > 0 ? (
        <div className="steers">
          {slot.steers.map((note) => (
            <div className={`steer ${note.state}`} key={note.id}>
              <span className="steer-mark mono" aria-hidden>
                ↳
              </span>
              <span className="steer-text">{note.text}</span>
              <span className="steer-state mono" title={note.error ?? note.ack ?? 'turn.steer'}>
                {note.state === 'failed' ? `not delivered · ${note.error ?? 'error'}` : 'steer sent'}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {slot.tools && slot.tools.length > 0 ? <ToolViewer calls={slot.tools} now={now} /> : null}

      {slot.plan ? <PlanCard plan={slot.plan} onDecide={onPlan} /> : null}

      {slot.ask ? (
        <div className="ask">
          <div className="ask-head">
            <span className="ask-kind mono">{slot.ask.kind}</span>
            <span className="ask-name">{slot.ask.title ?? slot.ask.name}</span>
          </div>
          {typeof slot.ask.detail === 'string' ? <pre className="ask-detail mono">{slot.ask.detail}</pre> : null}
          <div className="ask-actions">
            {slot.ask.actions.map((action) => (
              <button
                key={action.id || action.label}
                type="button"
                className={`ghost-btn ${action.behavior === 'deny' ? 'danger' : 'accent'}`}
                onClick={() => onRespond(action.id)}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="slot-body">
        {slot.text ? (
          <Markdown source={slot.text} streaming={slot.status === 'streaming'} />
        ) : slot.status === 'error' ? (
          <p className="slot-error">{sliceError(slot.error)}</p>
        ) : slot.status === 'canceled' ? (
          <p className="slot-canceled">중단됨 — 응답이 시작되기 전에 멈췄습니다</p>
        ) : (
          <div className="skeleton" aria-label="waiting for the first token">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <footer className="slot-foot">
        <SlotMetrics slot={slot} now={now} />
        <div className="slot-actions">
          {streaming ? (
            <button type="button" className="ghost-btn" onClick={onCancel}>
              stop
            </button>
          ) : (
            <>
              <button type="button" className="ghost-btn" onClick={onFork} title="이 턴에서 새 분기 세션을 만듭니다 (session.fork)">
                branch
              </button>
              <button type="button" className="ghost-btn" onClick={onRetry}>
                retry
              </button>
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

function sliceError(error?: string): string {
  if (!error) return '요청이 실패했습니다.';
  return error.length > 400 ? `${error.slice(0, 400)}…` : error;
}

export function Transcript({ messages, onRetry, onCancel, onRespond, onFork, onPlan, emptyState }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  const hasLive = messages.some((message) => message.slots?.some((slot) => slot.status === 'streaming' || slot.status === 'queued'));

  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [hasLive]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  });

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      {messages.length === 0 ? emptyState : null}
      {messages.map((message) => {
        if (message.role === 'user') {
          return (
            <div className="turn user" key={message.id}>
              <div className="user-meta mono">
                <span>you</span>
                {message.memoryInjected ? <span className="mem-flag">memory</span> : null}
                <span className="faint">{new Date(message.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="user-text">{message.text}</div>
            </div>
          );
        }
        const slots = message.slots ?? [];
        const compare = slots.length > 1;
        return (
          <div className={`turn assistant ${compare ? 'compare' : ''}`} key={message.id}>
            {/* The card head already names the route — this row is only
                worth showing when there is more than one of them. */}
            {compare ? (
              <div className="assistant-meta mono">
                <span>fan-out</span>
                <span className="faint">{slots.length} routes · same prompt</span>
              </div>
            ) : null}
            <div className={compare ? 'slot-grid' : 'slot-single'}>
              {slots.map((slot) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  now={now}
                  onRetry={() => onRetry(message, slot)}
                  onCancel={() => onCancel(slot)}
                  onRespond={(actionId) => onRespond(slot, actionId)}
                  onFork={() => onFork(message, slot)}
                  onPlan={(decision, feedback) => onPlan(message, slot, decision, feedback)}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="transcript-tail" />
    </div>
  );
}
