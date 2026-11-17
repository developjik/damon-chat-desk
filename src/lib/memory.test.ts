import { describe, expect, it } from 'vitest';
import {
  MemoryRejection,
  filterMemory,
  memoryBadges,
  memoryErrorInfo,
  memoryKey,
  memoryStats,
  memoryValue,
  memoryWriteParams,
  scopeLabel,
} from './memory';
import { RpcError } from './rpc';
import type { MemoryEntry } from './types';

function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    scope: 'user',
    content: '내용',
    status: 'active',
    updatedAt: 1000,
    ...over,
  };
}

const ledger: MemoryEntry[] = [
  entry({ id: '1', content: '선호 스택: Vite + React, 1px 보더 다크 UI.', updatedAt: 3000 }),
  entry({ id: '2', content: 'WS 티켓은 1회용이고 60초 만료.', updatedAt: 2000 }),
  entry({ id: '3', content: '정적 SPA는 GitHub Pages에 배포', status: 'pending', updatedAt: 4000 }),
  entry({ id: '4', scope: 'bot', owner: 'scribe', content: '릴리스 노트 순서: 날짜 → 변경 → 근거', updatedAt: 1000 }),
];

describe('memoryStats', () => {
  it('counts active chars only, like memory.usage', () => {
    const stats = memoryStats(ledger);
    expect(stats.active).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.chars).toBe(
      ledger.filter((row) => row.status === 'active').reduce((total, row) => total + row.content.length, 0),
    );
  });
});

describe('filterMemory', () => {
  it('floats pending entries and keeps everything with a blank query', () => {
    const all = filterMemory(ledger);
    expect(all).toHaveLength(4);
    expect(all[0].status).toBe('pending');
  });

  it('matches every term across content, source and owner', () => {
    expect(filterMemory(ledger, { text: 'json-rpc' })).toHaveLength(0);
    expect(filterMemory(ledger, { text: 'ws' }).map((row) => row.id)).toEqual(['2']);
    expect(filterMemory(ledger, { text: 'scribe 릴리스' }).map((row) => row.id)).toEqual(['4']);
  });

  it('narrows by scope, owner and status', () => {
    expect(filterMemory(ledger, { scope: 'bot' }).map((row) => row.id)).toEqual(['4']);
    expect(filterMemory(ledger, { owner: 'scribe' }).map((row) => row.id)).toEqual(['4']);
    expect(filterMemory(ledger, { filter: 'active' }).map((row) => row.id)).toEqual(['1', '2', '4']);
    expect(filterMemory(ledger, { filter: 'pending' }).map((row) => row.id)).toEqual(['3']);
  });
});

describe('memoryKey / memoryValue', () => {
  it('reads a leading key: value pair as the key', () => {
    const row = entry({ id: 'k', content: '선호 스택: Vite + React, 다크 UI.' });
    expect(memoryKey(row)).toBe('선호 스택');
    expect(memoryValue(row)).toBe('Vite + React, 다크 UI.');
  });

  it('accepts the em dash form a human writes', () => {
    const row = entry({ id: 'k', content: '배포 규칙 — 태그는 v로 시작' });
    expect(memoryKey(row)).toBe('배포 규칙');
    expect(memoryValue(row)).toBe('태그는 v로 시작');
  });

  it('does not invent a key past the label length', () => {
    const row = entry({ id: 'k', content: `${'x'.repeat(40)}: value` });
    expect(memoryKey(row)).toBeNull();
  });

  it('has no key when the entry is plain prose', () => {
    const row = entry({ id: 'k', content: 'damon-agent-core는 /ws JSON-RPC v2를 쓴다. 티켓은 1회용.' });
    expect(memoryKey(row)).toBeNull();
    expect(memoryValue(row)).toBe(row.content);
  });
});

describe('memoryBadges / scopeLabel', () => {
  it('names the ledger, its owner and the pending state', () => {
    const badges = memoryBadges(ledger[3]);
    expect(badges.map((badge) => badge.label)).toEqual(['bot', 'scribe']);
    expect(memoryBadges({ ...ledger[2], source: 'daemon' }).map((badge) => badge.kind)).toEqual([
      'scope',
      'source',
      'status',
    ]);
    expect(scopeLabel('bot', 'scribe')).toBe('bot · scribe');
    expect(scopeLabel('user')).toBe('user');
  });
});

describe('memoryWriteParams', () => {
  it('sends owner only for a bot ledger and drops empty optionals', () => {
    expect(memoryWriteParams({ scope: 'user', owner: 'scribe', content: 'x' })).toEqual({ scope: 'user', content: 'x' });
    expect(memoryWriteParams({ scope: 'bot', owner: 'scribe', content: 'x', source: 'desk' })).toEqual({
      scope: 'bot',
      owner: 'scribe',
      content: 'x',
      source: 'desk',
    });
  });
});

describe('memoryErrorInfo', () => {
  it('reads -32011 gate kinds into a concrete message', () => {
    const secret = memoryErrorInfo(new RpcError({ code: -32011, message: 'rejected', data: { kind: 'secret' } }));
    expect(secret.kind).toBe('secret');
    expect(secret.message).toContain('비밀키');

    const injection = memoryErrorInfo(
      new RpcError({ code: -32011, message: 'rejected', data: { kind: 'prompt_injection' } }),
    );
    expect(injection.kind).toBe('prompt_injection');
    expect(injection.message).toContain('지시문');
  });

  it('reports the actual capacity numbers', () => {
    const info = memoryErrorInfo(
      new RpcError({ code: -32011, message: 'rejected', data: { kind: 'capacity', limit: 8000, current: 7900, attempted: 200 } }),
    );
    expect(info.kind).toBe('capacity');
    expect(info.message).toContain('7900/8000');
    expect(info.message).toContain('+200');
  });

  it('turns a missing verb into an unsupported headline', () => {
    expect(memoryErrorInfo(new RpcError({ code: -32601, message: 'unknown method' })).kind).toBe('unsupported');
    expect(memoryErrorInfo(new RpcError({ code: -32602, message: 'bad scope' })).kind).toBe('invalid');
  });

  it('understands the demo rejection type', () => {
    const info = memoryErrorInfo(new MemoryRejection({ kind: 'invisible' }));
    expect(info.kind).toBe('invisible');
    expect(info.message).toContain('보이지 않는');
  });

  it('never throws on an unknown error', () => {
    expect(memoryErrorInfo(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' });
    expect(memoryErrorInfo(undefined).kind).toBe('unknown');
  });
});
