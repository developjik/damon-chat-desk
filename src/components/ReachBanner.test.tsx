import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReachBanner } from './ReachBanner';
import { UpdatePrompt } from './UpdatePrompt';
import { reachNotice } from '../lib/reachability';

const noop = () => undefined;

describe('ReachBanner', () => {
  it('renders nothing without a notice', () => {
    expect(renderToStaticMarkup(<ReachBanner notice={null} busy={false} onRetry={noop} onDemo={noop} onSettings={noop} />)).toBe('');
  });

  it('shows "데몬에 닿지 않음" as an alert with retry and demo', () => {
    const notice = reachNotice({ transport: 'daemon', status: 'offline', baseUrl: '/dm', targets: [] }, true);
    const html = renderToStaticMarkup(<ReachBanner notice={notice} busy={false} onRetry={noop} onDemo={noop} onSettings={noop} />);
    expect(html).toContain('data-reach="unreachable"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('데몬에 닿지 않음');
    expect(html).toContain('다시 시도');
    expect(html).toContain('데모로 전환');
  });

  it('shows a busy retry while probing', () => {
    const notice = reachNotice({ transport: 'daemon', status: 'offline', baseUrl: '/dm', targets: [] }, false);
    const html = renderToStaticMarkup(<ReachBanner notice={notice} busy onRetry={noop} onDemo={noop} onSettings={noop} />);
    expect(html).toContain('data-reach="offline"');
    expect(html).toContain('확인 중…');
  });

  it('keeps the demo-offline note polite and action-free', () => {
    const notice = reachNotice({ transport: 'demo', status: 'live', baseUrl: 'demo://simulated', targets: [] }, false);
    const html = renderToStaticMarkup(<ReachBanner notice={notice} busy={false} onRetry={noop} onDemo={noop} onSettings={noop} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('다시 시도');
  });
});

describe('UpdatePrompt', () => {
  it('offers the update only when one is waiting', () => {
    expect(renderToStaticMarkup(<UpdatePrompt open={false} onUpdate={noop} onDismiss={noop} />)).toBe('');
    const html = renderToStaticMarkup(<UpdatePrompt open onUpdate={noop} onDismiss={noop} />);
    expect(html).toContain('새 버전이 준비되었습니다');
    expect(html).toContain('업데이트');
  });
});
