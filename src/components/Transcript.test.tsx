import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Transcript } from './Transcript';
import { makeTarget } from '../lib/targets';
import type { ChatMessage, SlotDelivery } from '../lib/types';

const target = makeTarget({ provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet', modelLabel: 'Sonnet 4.6' });

function answer(delivery?: SlotDelivery): ChatMessage[] {
  return [
    { id: 'm1', role: 'user', text: '질문', createdAt: 0, mode: 'single' },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: 0,
      mode: 'single',
      slots: [{ id: 's1', target, text: '부분 답', status: 'done', startedAt: 1, endedAt: 2, delivery }],
    },
  ];
}

function render(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    <Transcript
      messages={messages}
      onRetry={() => undefined}
      onCancel={() => undefined}
      onRespond={() => undefined}
      onFork={() => undefined}
      onPlan={() => undefined}
      emptyState={null}
    />,
  );
}

describe('Transcript — delivery line', () => {
  it('stays quiet when nothing was lost', () => {
    expect(render(answer())).not.toContain('slot-delivery');
  });

  it('says how many events this connection missed', () => {
    const html = render(answer({ dropped: 3, cursor: 47 }));
    expect(html).toContain('slot-delivery');
    expect(html).toContain('3개');
    expect(html).toContain('session.gap');
  });

  it('says whether a holed answer was re-read from the daemon', () => {
    expect(render(answer({ dropped: 0, snapshotRequired: true, resynced: true }))).toContain('다시 읽었습니다');
    expect(render(answer({ dropped: 0, snapshotRequired: true, stale: true }))).toContain('빠졌을 수 있습니다');
  });

  it('tells an attached turn from a replayed result', () => {
    expect(render(answer({ dropped: 0, duplicate: true, attached: true }))).toContain('실행 중인 턴');
    expect(render(answer({ dropped: 0, duplicate: true }))).toContain('재사용');
  });
});
