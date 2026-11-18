import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { copyText } from '../lib/download';
import {
  INSPECTOR_FILTERS,
  frameBody,
  frameDetail,
  frameMatches,
  frameSummary,
  formatBytes,
  formatLatency,
  stamp,
  type InspectorFilter,
  type WireFrame,
  type WireTap,
} from '../lib/inspector';

interface InspectorProps {
  tap: WireTap;
  open: boolean;
  filter: InspectorFilter;
  /** What the active transport speaks — the header says which wire it is. */
  protocol: 'jsonrpc' | 'sse' | 'http';
  onFilter: (filter: InspectorFilter) => void;
  onClose: () => void;
  onClear: () => void;
  onNotify: (message: string) => void;
}

function errorFrame(frame: WireFrame): boolean {
  return frame.status === 'error' || frame.kind === 'error';
}

/**
 * One wire row: time, direction, method, the event under it, the round
 * trip when it was a response, and its size. Clicking opens the payload.
 */
function WireRow({ frame, open, onToggle }: { frame: WireFrame; open: boolean; onToggle: () => void }) {
  const detail = frameDetail(frame);
  const summary = frameSummary(frame);
  return (
    <div className={`wire-group ${open ? 'open' : ''}`}>
      <button
        type="button"
        className={`wire-row ${frame.dir} ${errorFrame(frame) ? 'err' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        title={`${frame.method}${frame.id !== undefined ? ` #${frame.id}` : ''}`}
      >
        <span className="wire-time mono">{stamp(frame.at)}</span>
        <span className={`wire-dir mono ${frame.dir}`}>{frame.dir === 'tx' ? '→ TX' : '← RX'}</span>
        <span className="wire-method mono">
          {frame.method}
          {frame.id !== undefined ? <span className="wire-id"> #{frame.id}</span> : null}
          {detail && detail !== 'request' && detail !== 'result' ? <span className="wire-sub mono">{detail}</span> : null}
        </span>
        <span className="wire-lat mono">{formatLatency(frame.latencyMs)}</span>
        <span className="wire-size mono">{formatBytes(frame.bytes)}</span>
        <span className="wire-summary mono">{summary}</span>
      </button>
      {open ? <pre className="wire-body mono">{frameBody(frame)}</pre> : null}
    </div>
  );
}

/**
 * The JSON-RPC inspector drawer.
 *
 * It reads the tap directly instead of going through the desk store: the
 * frame stream changes per token, and re-rendering the transcript for
 * every frame would cost the thing the panel is meant to observe.
 */
export function Inspector({ tap, open, filter, protocol, onFilter, onClose, onClear, onNotify }: InspectorProps) {
  const snapshot = useSyncExternalStore(tap.subscribe, tap.getSnapshot, tap.getSnapshot);
  const [selected, setSelected] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const list = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => snapshot.frames.filter((frame) => frameMatches(filter, frame)), [snapshot, filter]);
  const counts = useMemo(() => {
    let tools = 0;
    for (const frame of snapshot.frames) if (frame.tool) tools += 1;
    return { all: snapshot.frames.length, tx: snapshot.tx, rx: snapshot.rx, tools };
  }, [snapshot]);

  useLayoutEffect(() => {
    const node = list.current;
    if (!node || !follow) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length, follow]);

  if (!open) return null;

  const onScroll = () => {
    const node = list.current;
    if (!node) return;
    setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
  };

  const copy = async () => {
    const text = tap.toText(filter);
    if (!text) {
      onNotify('복사할 프레임이 없습니다');
      return;
    }
    const copied = await copyText(text);
    onNotify(
      copied
        ? `${rows.length}개 프레임을 클립보드에 복사했습니다`
        : '클립보드 복사가 차단되었습니다 — 브라우저 권한을 확인하세요',
    );
  };

  return (
    <aside className="inspector" aria-label="JSON-RPC 프로토콜 인스펙터">
      <header className="inspector-head">
        <span className={`inspector-live ${snapshot.inflight > 0 ? 'on' : ''} ${snapshot.frames.length > 0 ? 'has' : ''}`} aria-hidden />
        <span className="inspector-title">JSON-RPC</span>
        <span className="inspector-proto mono">{protocol === 'sse' ? 'sse' : protocol === 'http' ? 'http' : 'v2'}</span>
        <span className="inspector-stats mono">
          tx {snapshot.tx} · rx {snapshot.rx}
        </span>
        <button type="button" className="icon-btn inspector-close" onClick={onClose} aria-label="인스펙터 닫기">
          ✕
        </button>
      </header>

      <div className="inspector-filters" role="group" aria-label="프레임 필터">
        {INSPECTOR_FILTERS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`inspector-chip ${filter === entry.id ? 'on' : ''}`}
            onClick={() => onFilter(entry.id)}
            aria-pressed={filter === entry.id}
          >
            {entry.label}
            <span className="inspector-chip-count mono">{counts[entry.id]}</span>
          </button>
        ))}
      </div>

      <div className="inspector-list" ref={list} onScroll={onScroll}>
        {rows.length === 0 ? (
          <div className="inspector-empty">
            <p className="inspector-empty-mark mono">{'{}'}</p>
            <p className="inspector-empty-title">아직 프레임이 없습니다</p>
            <p className="inspector-empty-copy">
              메시지를 보내면 `turn.start` 요청과 `session.event` 알림이 여기에 흐릅니다. 아래 시나리오를 실행하면 툴 호출과
              계획 승인까지 한 번에 볼 수 있습니다.
            </p>
          </div>
        ) : (
          rows.map((frame) => (
            <WireRow
              key={frame.seq}
              frame={frame}
              open={selected === frame.seq}
              onToggle={() => setSelected((current) => (current === frame.seq ? null : frame.seq))}
            />
          ))
        )}
      </div>

      <footer className="inspector-foot">
        <button type="button" className="ghost-btn tiny" onClick={onClear}>
          clear
        </button>
        <button type="button" className="ghost-btn tiny" onClick={() => void copy()}>
          copy
        </button>
        <button
          type="button"
          className={`ghost-btn tiny ${follow ? 'on' : ''}`}
          onClick={() => setFollow((current) => !current)}
          aria-pressed={follow}
        >
          follow
        </button>
        <span className="inspector-foot-note mono">
          {snapshot.inflight > 0 ? `${snapshot.inflight} inflight · ` : ''}
          {snapshot.dropped > 0 ? `${snapshot.dropped} dropped · ` : ''}
          {snapshot.errors > 0 ? `${snapshot.errors} err · ` : ''}
          {rows.length}/{snapshot.frames.length}
        </span>
      </footer>
    </aside>
  );
}

/**
 * The topbar switch. It subscribes to the tap itself so the frame count
 * moves without re-rendering the app around it.
 */
export function InspectorToggle({ tap, open, onToggle }: { tap: WireTap; open: boolean; onToggle: () => void }) {
  const snapshot = useSyncExternalStore(tap.subscribe, tap.getSnapshot, tap.getSnapshot);
  const state = snapshot.inflight > 0 ? 'live' : snapshot.frames.length > 0 ? 'has' : 'idle';
  return (
    <button
      type="button"
      className={`inspector-toggle ${open ? 'on' : ''}`}
      onClick={onToggle}
      aria-pressed={open}
      aria-label="JSON-RPC 인스펙터 열기"
      title="JSON-RPC 인스펙터 (⌘I / Ctrl+I)"
    >
      <span className={`inspector-toggle-dot ${state}`} aria-hidden />
      <span className="inspector-toggle-label mono">JSON-RPC</span>
      <span className="inspector-toggle-count mono">{snapshot.frames.length}</span>
    </button>
  );
}
