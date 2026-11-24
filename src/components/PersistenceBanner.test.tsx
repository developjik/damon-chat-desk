import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersistenceBanner } from './PersistenceBanner';
const noop=()=>undefined;
describe('persistence warning',()=>{
  it.each(['idle','saved'] as const)('hides when %s',status=>{expect(renderToStaticMarkup(<PersistenceBanner status={status} canExport onRetry={noop} onExport={noop}/>)).toBe('')});
  it.each(['failed','unavailable'] as const)('offers retry and both export formats when %s',status=>{
    const html=renderToStaticMarkup(<PersistenceBanner status={status} canExport onRetry={noop} onExport={noop}/>);
    expect(html).toContain('role="alert"');expect(html).toContain('저장 다시 시도');expect(html).toContain('Markdown 내보내기');expect(html).toContain('JSON 내보내기');expect(html).toContain('새로고침');expect(html).not.toContain('disabled');
  });
  it('disables exports without a conversation but keeps retry enabled',()=>{
    const html=renderToStaticMarkup(<PersistenceBanner status="failed" canExport={false} onRetry={noop} onExport={noop}/>);
    expect(html.match(/disabled/g)).toHaveLength(2);
  });
});
