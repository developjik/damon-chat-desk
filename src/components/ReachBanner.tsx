import type { ReachNotice } from '../lib/reachability';

interface ReachBannerProps {
  notice: ReachNotice | null;
  busy: boolean;
  onRetry: () => void;
  onDemo: () => void;
  onSettings: () => void;
}

/** "데몬에 닿지 않음" and friends — see `reachNotice`. */
export function ReachBanner({ notice, busy, onRetry, onDemo, onSettings }: ReachBannerProps) {
  if (!notice) return null;
  const calm = notice.kind === 'demo-offline';
  return (
    <section
      className={`reach-banner ${notice.kind}`}
      data-testid="reach-banner"
      data-reach={notice.kind}
      role={calm ? 'status' : 'alert'}
      aria-live={calm ? 'polite' : 'assertive'}
    >
      <div className="reach-head">
        <span className={`dot ${calm ? 'warn' : 'err'}`} aria-hidden />
        <strong className="reach-title">{notice.title}</strong>
      </div>
      <p className="reach-detail">{notice.detail}</p>
      {notice.retry || notice.demo ? (
        <div className="reach-actions">
          {notice.retry ? (
            <button type="button" className="ghost-btn tiny" onClick={onRetry} disabled={busy}>
              {busy ? '확인 중…' : '다시 시도'}
            </button>
          ) : null}
          {notice.demo ? (
            <button type="button" className="ghost-btn tiny" onClick={onDemo}>
              데모로 전환
            </button>
          ) : null}
          <button type="button" className="ghost-btn tiny" onClick={onSettings}>
            연결 설정
          </button>
        </div>
      ) : null}
    </section>
  );
}
