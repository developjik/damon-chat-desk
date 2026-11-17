import { describe, expect, it } from 'vitest';
import {
  conversationMeta,
  conversationPreview,
  conversationSearchText,
  filterConversations,
  filterDaemonRows,
  relativeTime,
} from './sessions';
import { makeTarget } from './targets';
import type { Conversation } from './types';

const claude = makeTarget({ provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet', modelLabel: 'Sonnet 4.5' });

function conversation(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: '새 대화',
    createdAt: 1_000,
    updatedAt: 1_000,
    messages: [],
    daemonSessions: {},
    ...over,
  };
}

const sessions: Conversation[] = [
  conversation({
    id: 'c1',
    title: 'SSE 프레임 경계',
    updatedAt: 9_000,
    messages: [
      { id: 'm1', role: 'user', text: '청크가 중간에서 끊기면?', createdAt: 1_000, mode: 'single' },
      {
        id: 'm2',
        role: 'assistant',
        createdAt: 2_000,
        mode: 'single',
        slots: [
          {
            id: 's1',
            target: claude,
            text: '버퍼를 파서가 들고 있으면 됩니다.',
            status: 'done',
            startedAt: 1_000,
            tools: [{ id: 't1', name: 'Bash', kind: 'shell', label: 'npm test -- src/lib/sse.test.ts', status: 'done', startedAt: 1_000 }],
          },
        ],
      },
    ],
  }),
  conversation({
    id: 'c2',
    title: '강릉 숙소 비교',
    updatedAt: 5_000,
    messages: [{ id: 'm3', role: 'user', text: '오션뷰 2박 요금', createdAt: 1_000, mode: 'single' }],
  }),
  conversation({ id: 'c3', title: '보관된 세션', archived: true, updatedAt: 300, messages: [] }),
];

describe('relativeTime', () => {
  it('speaks in the units a sidebar needs', () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(now - 10_000, now)).toBe('방금');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5분 전');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3시간 전');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2일 전');
  });
});

describe('conversationSearchText / preview', () => {
  it('indexes the prompt, the reply and the tool calls', () => {
    const body = conversationSearchText(sessions[0]);
    expect(body).toContain('청크가 중간에서');
    expect(body).toContain('버퍼를 파서가');
    expect(body).toContain('npm test -- src/lib/sse.test.ts');
    expect(body).toContain('claude code');
  });

  it('previews the last thing that was said', () => {
    expect(conversationPreview(sessions[0])).toBe('버퍼를 파서가 들고 있으면 됩니다.');
    expect(conversationPreview(sessions[1])).toBe('오션뷰 2박 요금');
    expect(conversationPreview(conversation({ id: 'empty' }))).toBe('');
  });
});

describe('filterConversations', () => {
  it('hides archived sessions unless the archive view asks for them', () => {
    expect(filterConversations(sessions).map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(filterConversations(sessions, { archived: true }).map((row) => row.id)).toEqual(['c3']);
  });

  it('matches several terms anywhere in the conversation', () => {
    expect(filterConversations(sessions, { text: '프레임' }).map((row) => row.id)).toEqual(['c1']);
    expect(filterConversations(sessions, { text: 'sse 파서' }).map((row) => row.id)).toEqual(['c1']);
    expect(filterConversations(sessions, { text: 'npm' }).map((row) => row.id)).toEqual(['c1']);
    expect(filterConversations(sessions, { text: '없는말' })).toHaveLength(0);
  });

  it('ignores case and surrounding space', () => {
    expect(filterConversations(sessions, { text: '  SSE  ' }).map((row) => row.id)).toEqual(['c1']);
  });
});

describe('filterDaemonRows', () => {
  const rows = [
    { sessionId: 'sess-a1', backend: 'claude', title: 'damon API 리뷰', tags: ['review'], archived: false },
    { sessionId: 'sess-b2', backend: 'codex', title: null, cwd: '/home/dev/assignment-map', archived: true },
  ];

  it('searches title, id, backend, cwd and tags', () => {
    expect(filterDaemonRows(rows, { text: 'api' }).map((row) => row.sessionId)).toEqual(['sess-a1']);
    expect(filterDaemonRows(rows, { text: 'assignment', includeArchived: true }).map((row) => row.sessionId)).toEqual(['sess-b2']);
    expect(filterDaemonRows(rows, { text: 'codex', includeArchived: true }).map((row) => row.sessionId)).toEqual(['sess-b2']);
    expect(filterDaemonRows(rows, { text: 'sess-a1' })).toHaveLength(1);
  });

  it('keeps archived rows out unless asked', () => {
    expect(filterDaemonRows(rows).map((row) => row.sessionId)).toEqual(['sess-a1']);
    expect(filterDaemonRows(rows, { includeArchived: true })).toHaveLength(2);
  });
});

describe('conversationMeta', () => {
  it('counts turns and says when it moved, with a daemon marker', () => {
    expect(conversationMeta(sessions[0], 10_000)).toBe('2 msg · 방금');
    expect(conversationMeta({ ...sessions[1], remote: true }, 5_000 + 60_000)).toBe('1 msg · 1분 전 · daemon');
  });
});
