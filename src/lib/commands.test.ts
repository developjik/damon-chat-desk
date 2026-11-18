import { describe, expect, it, vi } from 'vitest';
import {
  buildCommands,
  filterCommands,
  firstEnabledIndex,
  liveSlotCount,
  nextEnabledIndex,
  type PaletteCommand,
  type PaletteHandlers,
} from './commands';
import { DeskController, type DeskState } from './desk';
import { DemoTransport } from './demo';

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
    runScenario: vi.fn(),
    toggleInspector: vi.fn(),
    openScenarios: vi.fn(),
  };
}

async function demoState(): Promise<DeskState> {
  const desk = new DeskController({ demo: new DemoTransport({ sleep: async () => undefined, now: () => 1000, random: () => 0.5 }) });
  await desk.init();
  return desk.getSnapshot();
}

const ids = (commands: PaletteCommand[]) => commands.map((command) => command.id);

describe('buildCommands', () => {
  it('offers the whole desk surface, grouped action → session → route', async () => {
    const state = await demoState();
    const commands = buildCommands(state, handlers());
    const list = ids(commands);

    for (const id of [
      'action.new',
      'action.compare',
      'action.memory-toggle',
      'action.memory-panel',
      'action.demo',
      'action.connect',
      'action.export-md',
      'action.export-json',
      'action.copy-md',
    ]) {
      expect(list).toContain(id);
    }
    expect(commands[0].group).toBe('action');
    expect(commands.filter((command) => command.group === 'session')).toHaveLength(state.conversations.length);
    expect(commands.filter((command) => command.group === 'route')).toHaveLength(state.connection.targets.length);
    // Split off: no B-side rows until compare mode is on.
    expect(list.some((id) => id.startsWith('route.b.'))).toBe(false);
  });

  it('reads the current state into the rows', async () => {
    const state = await demoState();
    const commands = buildCommands(state, handlers());
    const demo = commands.find((command) => command.id === 'action.demo');
    expect(demo?.disabled).toBe(true);
    expect(commands.find((command) => command.id === 'action.connect')?.detail).toBe(state.connection.baseUrl);
    expect(commands.find((command) => command.id === 'action.compare')?.label).toContain('켜기');
    const active = state.conversations.find((conversation) => conversation.id === state.activeId);
    expect(commands.find((command) => command.id === 'action.export-md')?.disabled).toBe((active?.messages.length ?? 0) === 0);
    // Nothing is streaming on a fresh boot, so there is nothing to stop.
    expect(ids(commands)).not.toContain('action.stop');
  });

  it('adds the stop row only while a turn is live, and B routes in split', async () => {
    const state = await demoState();
    const compare = {
      ...state,
      compare: true,
      busy: true,
      conversations: state.conversations.map((conversation) =>
        conversation.id === state.activeId
          ? {
              ...conversation,
              messages: [
                {
                  id: 'm-live',
                  role: 'assistant' as const,
                  createdAt: 1,
                  mode: 'single' as const,
                  slots: [
                    { id: 's-live', target: state.connection.targets[0], text: '부분', status: 'streaming' as const, startedAt: 1 },
                  ],
                },
              ],
            }
          : conversation,
      ),
    };
    expect(liveSlotCount(compare)).toBe(1);
    const commands = buildCommands(compare, handlers());
    const list = ids(commands);
    expect(list).toContain('action.stop');
    expect(list.filter((id) => id.startsWith('route.b.'))).toHaveLength(state.connection.targets.length);
    expect(commands.find((command) => command.id === 'action.compare')?.label).toContain('끄기');
  });

  it('runs the handler it belongs to', async () => {
    const state = await demoState();
    const spy = handlers();
    const commands = buildCommands({ ...state, compare: false }, spy);
    commands.find((command) => command.id === 'action.compare')?.run();
    expect(spy.setCompare).toHaveBeenCalledWith(true);
    commands.find((command) => command.id === `session.${state.activeId}`)?.run();
    expect(spy.selectConversation).toHaveBeenCalledWith(state.activeId);
    commands.find((command) => command.id.startsWith('route.a.'))?.run();
    expect(spy.setPrimary).toHaveBeenCalledWith(state.connection.targets[0].key);
  });
});

describe('filterCommands', () => {
  it('matches every token across label, detail and keywords', async () => {
    const commands = buildCommands(await demoState(), handlers());
    expect(filterCommands(commands, 'split')[0].id).toBe('action.compare');
    expect(filterCommands(commands, '비교')[0].id).toBe('action.compare');
    expect(filterCommands(commands, 'json')[0].id).toBe('action.export-json');
    expect(filterCommands(commands, 'md')[0].id).toBe('action.export-md');
    expect(filterCommands(commands, '데몬')[0].id).toBe('action.connect');
    // Routes are searchable by provider and model.
    const route = filterCommands(commands, '라우트').filter((command) => command.group === 'route');
    expect(route.length).toBeGreaterThan(0);
  });

  it('keeps the full list in order for an empty query and drops non-matches', async () => {
    const commands = buildCommands(await demoState(), handlers());
    expect(filterCommands(commands, '   ').map((command) => command.id)).toEqual(commands.map((command) => command.id));
    expect(filterCommands(commands, '존재하지않는명령')).toEqual([]);
  });
});

describe('keyboard cursor', () => {
  const row = (id: string, disabled = false): PaletteCommand => ({
    id,
    group: 'action',
    label: id,
    disabled,
    run: () => undefined,
  });

  it('wraps in both directions and never lands on a disabled row', () => {
    const rows = [row('a'), row('b', true), row('c')];
    expect(nextEnabledIndex(rows, 0, 1)).toBe(2);
    expect(nextEnabledIndex(rows, 2, 1)).toBe(0);
    expect(nextEnabledIndex(rows, 0, -1)).toBe(2);
    expect(nextEnabledIndex(rows, -1, 1)).toBe(0);
    expect(firstEnabledIndex(rows)).toBe(0);
    expect(firstEnabledIndex([row('x', true), row('y')])).toBe(1);
    expect(nextEnabledIndex([], 0, 1)).toBe(0);
  });
});
