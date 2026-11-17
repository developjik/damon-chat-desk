import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPalette } from './CommandPalette';
import type { PaletteHandlers } from '../lib/commands';
import { DeskController } from '../lib/desk';
import { DemoTransport } from '../lib/demo';

function handlers(): PaletteHandlers {
  return {
    newConversation: vi.fn(),
    selectConversation: vi.fn(),
    setCompare: vi.fn(),
    setMemoryEnabled: vi.fn(),
    openMemoryPanel: vi.fn(),
    enterDemo: vi.fn(),
    openConnect: vi.fn(),
    exportConversation: vi.fn(),
    copyMarkdown: vi.fn(),
    setPrimary: vi.fn(),
    setSecondary: vi.fn(),
    stop: vi.fn(),
  };
}

async function demoState() {
  const desk = new DeskController({ demo: new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 }) });
  await desk.init();
  return desk.getSnapshot();
}

describe('CommandPalette', () => {
  it('renders nothing while closed', async () => {
    const state = await demoState();
    expect(renderToStaticMarkup(<CommandPalette open={false} state={state} handlers={handlers()} onClose={() => undefined} />)).toBe('');
  });

  it('renders a search box, grouped rows and the active row selected', async () => {
    const state = await demoState();
    const markup = renderToStaticMarkup(<CommandPalette open state={state} handlers={handlers()} onClose={() => undefined} />);
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('명령 · 세션 · 라우트 검색');
    expect(markup).toContain('동작');
    expect(markup).toContain('세션 전환');
    expect(markup).toContain('라우트');
    expect(markup).toContain('새 대화');
    expect(markup).toContain('role="option"');
    // The first enabled row is the keyboard cursor's resting place.
    expect(markup).toContain('aria-activedescendant="palette-opt-action-new"');
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('esc 닫기');
  });
});
