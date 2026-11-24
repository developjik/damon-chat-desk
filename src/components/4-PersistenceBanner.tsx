import type { ExportFormat } from '../lib/export';

export function PersistenceBanner({ status, canExport, onRetry, onExport }: {
  status: 'idle' | 'saved' | 'failed' | 'unavailable';
  canExport: boolean;
  onRetry: () => void;
  onExport: (format: ExportFormat) => void;
}) {
  if (status !== 'failed' && status !== 'unavailable') return null;
  return <section className="reach-banner" role="alert" aria-live="polite" data-testid="persistence-banner">
    <div className="reach-head"><strong className="reach-title">이 기기에 최근 변경사항을 저장하지 못했습니다</strong></div>
    <p className="reach-detail">{status === 'unavailable' ? '브라우저 저장소를 사용할 수 없습니다.' : '저장 공간 부족 또는 브라우저 제한으로 저장에 실패했습니다.'} 이 탭에서는 계속 대화할 수 있지만 새로고침하거나 닫으면 저장되지 않은 변경사항이 사라질 수 있습니다. 중요한 대화는 내보내기로 보관하세요. 다른 대화도 왼쪽 목록에서 선택해 내보낼 수 있습니다.</p>
    <div className="reach-actions">
      <button type="button" className="ghost-btn tiny" onClick={onRetry}>저장 다시 시도</button>
      <button type="button" className="ghost-btn tiny" onClick={() => onExport('markdown')} disabled={!canExport}>현재 대화 Markdown 내보내기</button>
      <button type="button" className="ghost-btn tiny" onClick={() => onExport('json')} disabled={!canExport}>현재 대화 JSON 내보내기</button>
    </div>
  </section>;
}
