import type { RecoveredSession, SessionStatusRow } from '../lib/types';import {
  askKindLabel,
  phaseChipLabel,
  phaseTitle,
  recoveredSummary,
  shortSessionId,
} from '../lib/phases';

/**
 * One session's state, as a chip: `busy`, `waiting · plan`, or nothing at
 * all for an idle session (an idle row is the absence of news, and a list
 * of `idle` chips is noise). `source: 'local'` means this tab's own stream
 * reported it — a daemon too old to know phases still gets the chips for
 * the turns running here.
 *
 * `compact` keeps the ask's kind but drops its label, for a 230px sidebar
 * row: the title attribute still carries the whole sentence.
 */
export function PhaseChip({
  row,
  showAsk = true,
  compact = false,
}: {
  row?: SessionStatusRow;
  showAsk?: boolean;
  compact?: boolean;
}) {
  if (!row || row.phase === 'idle') return null;
  const ask = row.pendingAsk;
  const detail = ask ? `${askKindLabel(ask.kind)}${ask.label ? `: ${ask.label}` : ''}` : '';
  const title = [`${phaseTitle(row.phase)}${detail ? ` · ${detail}` : ''}`, row.source === 'local' ? '이 창의 스트림' : '데몬 원장'].join(' · ');
  return (
    <span className={`phase-chip ${row.phase}${row.source === 'local' ? ' local' : ''}`} title={title}>
      <span className={`phase-dot ${row.phase}`} aria-hidden />
      <span className="phase-word mono">{phaseChipLabel(row.phase)}</span>
      {showAsk && ask ? (
        <span className="phase-ask">
          <span className="phase-kind mono">{ask.kind}</span>
          {ask.label && !compact ? <span className="phase-label">{ask.label}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

interface RecoveredBannerProps {
  rows: RecoveredSession[];
  /** `session.resume` — the daemon drops the mark, so the row goes away. */
  onResume: (sessionId: string) => void;
  /** Open the session's history (only offered when it is in the list). */
  onOpen?: (row: RecoveredSession) => void;
  now?: number;
}

/**
 * The one thing a crash-restored daemon must not be quiet about: these
 * sessions were mid-turn when it died, so their last answer is not the
 * whole answer. The daemon reports the fact in `session.status`; until the
 * session is resumed (or a day passes), this banner keeps saying it.
 */
export function RecoveredBanner({ rows, onResume, onOpen, now = Date.now() }: RecoveredBannerProps) {
  if (rows.length === 0) return null;
  return (
    <section className="recovered-banner" role="status" aria-live="polite">
      <div className="recovered-head">
        <span className="recovered-chip mono">recovered</span>
        <span className="recovered-title">
          데몬이 턴 도중 종료되었습니다 — 중단된 세션 {rows.length}개 (마지막 응답은 완결되지 않았습니다)
        </span>
      </div>
      <ul className="recovered-list">
        {rows.map((row) => (
          <li key={row.sessionId} className="recovered-row">
            <span className="recovered-id mono" title={row.sessionId}>
              {shortSessionId(row.sessionId)}
            </span>
            {row.backend ? <span className="recovered-backend mono">{row.backend}</span> : null}
            <span className="recovered-what">{recoveredSummary(row, now)}</span>
            {onOpen ? (
              <button type="button" className="ghost-btn tiny" onClick={() => onOpen(row)}>
                기록 열기
              </button>
            ) : null}
            <button type="button" className="ghost-btn tiny accent" onClick={() => onResume(row.sessionId)}>
              이어받기
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
