/**
 * The command palette's catalogue — pure data so the keyboard path is
 * testable without a DOM.
 *
 * Every row is something the desk can already do: start a conversation,
 * jump to one, flip split/memory, switch transports, export, pick a
 * route. `buildCommands` reads a settled snapshot; the palette only
 * searches and runs what it is handed.
 */

import type { DeskState } from './desk';
import type { ExportFormat } from './export';
import { conversationMeta } from './sessions';

export type CommandGroup = 'action' | 'session' | 'route';

export interface PaletteCommand {
  id: string;
  group: CommandGroup;
  label: string;
  /** Right-aligned hint: state, file extension, message count. */
  detail?: string;
  /** Extra search text — English and Korean spellings of the same thing. */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** What the palette may ask the app to do. Implemented by App + the desk. */
export interface PaletteHandlers {
  newConversation: () => void;
  selectConversation: (id: string) => void;
  setCompare: (compare: boolean) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  openMemoryPanel: () => void;
  enterDemo: () => void;
  openConnect: () => void;
  exportConversation: (format: ExportFormat) => void;
  copyMarkdown: () => void;
  setPrimary: (key: string) => void;
  setSecondary: (key: string) => void;
  stop: () => void;
}

export const GROUP_LABELS: Record<CommandGroup, string> = {
  action: '동작',
  session: '세션 전환',
  route: '라우트',
};

/** Slots of the active conversation that still receive tokens. */
export function liveSlotCount(state: DeskState): number {
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  if (!conversation) return 0;
  let live = 0;
  for (const message of conversation.messages) {
    for (const slot of message.slots ?? []) {
      if (slot.status === 'streaming' || slot.status === 'queued') live += 1;
    }
  }
  return live;
}

export function buildCommands(state: DeskState, handlers: PaletteHandlers): PaletteCommand[] {
  const active = state.conversations.find((entry) => entry.id === state.activeId) ?? null;
  const messages = active?.messages.length ?? 0;
  const canExport = !!active && messages > 0;
  const activeMemory = state.memory.entries.filter((entry) => entry.status === 'active').length;
  const live = liveSlotCount(state);

  const actions: PaletteCommand[] = [
    {
      id: 'action.new',
      group: 'action',
      label: '새 대화',
      detail: active ? `${messages} msg → 새 세션` : '빈 대화',
      keywords: 'new chat 새 대화 시작 create',
      run: handlers.newConversation,
    },
    {
      id: 'action.compare',
      group: 'action',
      label: state.compare ? 'split 비교 모드 끄기' : 'split 비교 모드 켜기',
      detail: state.compare ? 'on' : 'off',
      keywords: 'split compare 비교 모드 fanout 나란히 a/b 사이드',
      run: () => handlers.setCompare(!state.compare),
    },
    {
      id: 'action.memory-toggle',
      group: 'action',
      label: state.memory.enabled ? 'memory 주입 끄기' : 'memory 주입 켜기',
      detail: state.memory.enabled ? `${activeMemory} active` : 'off',
      keywords: 'memory 메모리 주입 원장 toggle inject',
      run: () => handlers.setMemoryEnabled(!state.memory.enabled),
    },
    {
      id: 'action.memory-panel',
      group: 'action',
      label: 'memory 패널 열기',
      detail: state.memory.supported ? `${state.memory.chars}/${state.memory.limit} chars` : '이 계층은 원장 없음',
      keywords: 'memory 메모리 패널 원장 ledger 사이드바 열기',
      run: handlers.openMemoryPanel,
    },
    {
      id: 'action.demo',
      group: 'action',
      label: 'demo 모드로 전환',
      detail: state.connection.transport === 'demo' ? 'already demo' : 'network 없이 체험',
      keywords: 'demo 데모 시뮬레이터 simulated 전환 offline',
      disabled: state.connection.transport === 'demo',
      run: handlers.enterDemo,
    },
    {
      id: 'action.connect',
      group: 'action',
      label: 'daemon 연결 설정 열기',
      detail: state.connection.baseUrl,
      keywords: 'daemon 데몬 openai 연결 설정 connect url token',
      run: handlers.openConnect,
    },
    {
      id: 'action.export-md',
      group: 'action',
      label: '내보내기 — Markdown',
      detail: '.md',
      keywords: 'export 내보내기 markdown md 다운로드 저장 파일',
      disabled: !canExport,
      run: () => handlers.exportConversation('markdown'),
    },
    {
      id: 'action.export-json',
      group: 'action',
      label: '내보내기 — JSON',
      detail: '.json',
      keywords: 'export 내보내기 json 다운로드 저장 파일 스키마',
      disabled: !canExport,
      run: () => handlers.exportConversation('json'),
    },
    {
      id: 'action.copy-md',
      group: 'action',
      label: 'Markdown 클립보드 복사',
      detail: 'copy',
      keywords: 'copy 복사 클립보드 clipboard markdown md',
      disabled: !canExport,
      run: handlers.copyMarkdown,
    },
  ];

  if (state.busy || live > 0) {
    actions.push({
      id: 'action.stop',
      group: 'action',
      label: '진행 중인 턴 중단',
      detail: live > 0 ? `${live} streaming` : 'streaming',
      keywords: 'stop 중단 취소 cancel 중지 esc turn.cancel',
      run: handlers.stop,
    });
  }

  const sessions: PaletteCommand[] = state.conversations
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((conversation) => ({
      id: `session.${conversation.id}`,
      group: 'session' as const,
      label: conversation.title || '새 대화',
      detail: `${conversationMeta(conversation)}${conversation.id === state.activeId ? ' · 현재' : ''}${conversation.archived ? ' · 보관' : ''}`,
      keywords: `세션 session 대화 전환 switch ${conversation.remote ? 'daemon' : 'local'}`,
      run: () => handlers.selectConversation(conversation.id),
    }));

  const routes: PaletteCommand[] = state.connection.targets.map((target) => ({
    id: `route.a.${target.key}`,
    group: 'route' as const,
    label: `${target.providerLabel} / ${target.model || 'default'}`,
    detail: state.compare ? 'A · primary' : 'primary',
    keywords: `라우트 route 모델 model ${target.provider} ${target.modelLabel} primary a`,
    disabled: target.available === false,
    run: () => handlers.setPrimary(target.key),
  }));

  if (state.compare) {
    for (const target of state.connection.targets) {
      routes.push({
        id: `route.b.${target.key}`,
        group: 'route',
        label: `${target.providerLabel} / ${target.model || 'default'}`,
        detail: 'B · secondary',
        keywords: `라우트 route 모델 model ${target.provider} ${target.modelLabel} secondary b 비교`,
        disabled: target.available === false || target.key === state.primaryKey,
        run: () => handlers.setSecondary(target.key),
      });
    }
  }

  return [...actions, ...sessions, ...routes];
}

/** -1 when some query token is missing from the row. */
export function scoreCommand(command: PaletteCommand, query: string): number {
  const text = query.trim().toLowerCase();
  if (!text) return 0;
  const label = command.label.toLowerCase();
  const haystack = `${label} ${(command.detail ?? '').toLowerCase()} ${(command.keywords ?? '').toLowerCase()} ${GROUP_LABELS[command.group]}`;
  let score = 0;
  for (const token of text.split(/\s+/)) {
    if (!haystack.includes(token)) return -1;
    if (label.startsWith(token)) score += 8;
    else if (label.includes(` ${token}`)) score += 5;
    else if (label.includes(token)) score += 3;
    else score += 1;
  }
  return score;
}

/** Every token must match; better label matches float up, ties keep order. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  return commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** Move `delta` rows from `from`, wrapping, and skip disabled rows. */
export function nextEnabledIndex(commands: PaletteCommand[], from: number, delta: number): number {
  if (commands.length === 0) return 0;
  let index = from;
  for (let step = 0; step < commands.length; step += 1) {
    index = (index + delta + commands.length) % commands.length;
    if (!commands[index].disabled) return index;
  }
  return Math.min(Math.max(from, 0), commands.length - 1);
}

export function firstEnabledIndex(commands: PaletteCommand[]): number {
  const index = commands.findIndex((command) => !command.disabled);
  return index < 0 ? 0 : index;
}
