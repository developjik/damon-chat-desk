import type { ExportFormat } from '../lib/export';

interface ExportMenuProps {
  disabled: boolean;
  onExport: (format: ExportFormat) => void;
  onCopy: () => void;
}

const ITEMS: Array<{ id: ExportFormat | 'copy'; label: string; hint: string }> = [
  { id: 'markdown', label: 'Markdown 다운로드', hint: '.md' },
  { id: 'json', label: 'JSON 다운로드', hint: '.json' },
  { id: 'copy', label: '클립보드에 복사', hint: 'md' },
];

/**
 * The header export control. A native <details> keeps the popover open
 * state out of React; the click closes it explicitly so the toast lands
 * on a clean screen.
 */
export function ExportMenu({ disabled, onExport, onCopy }: ExportMenuProps) {
  const close = (node: EventTarget | null) => {
    const details = (node as HTMLElement | null)?.closest('details');
    details?.removeAttribute('open');
  };

  return (
    <details className="export-menu">
      <summary className="icon-btn export-summary" aria-label="대화 내보내기" title="대화 내보내기 (Markdown / JSON)">
        ⤓
      </summary>
      <div className="export-body">
        <div className="export-label mono">export conversation</div>
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="export-item"
            disabled={disabled}
            onClick={(event) => {
              close(event.currentTarget);
              if (item.id === 'copy') onCopy();
              else onExport(item.id);
            }}
          >
            <span>{item.label}</span>
            <span className="export-hint mono">{item.hint}</span>
          </button>
        ))}
        <div className="export-foot">메시지 · 툴 실행 · 비교 응답 포함</div>
      </div>
    </details>
  );
}
