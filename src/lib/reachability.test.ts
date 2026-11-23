import { describe, expect, it } from 'vitest';
import { DAEMON_CLOSED, reachNotice } from './reachability';
import type { ConnectionState } from './types';

const conn = (patch: Partial<ConnectionState>): ConnectionState => ({
  transport: 'daemon',
  status: 'live',
  baseUrl: 'http://127.0.0.1:9470',
  targets: [],
  ...patch,
});

describe('reachNotice', () => {
  it('says nothing while things work', () => {
    expect(reachNotice(conn({}), true)).toBeNull();
    expect(reachNotice(conn({ status: 'probing' }), true)).toBeNull();
    expect(reachNotice(conn({ transport: 'demo', baseUrl: 'demo://simulated' }), true)).toBeNull();
  });

  it('tells "no network" apart from "daemon not reachable"', () => {
    const offline = reachNotice(conn({ status: 'offline' }), false);
    expect(offline?.kind).toBe('offline');
    expect(offline?.title).toContain('데몬에 닿지 않음');
    expect(offline?.detail).toContain('네트워크가 없습니다');

    const unreachable = reachNotice(conn({ status: 'offline', error: 'no daemon' }), true);
    expect(unreachable?.kind).toBe('unreachable');
    expect(unreachable?.title).toBe('데몬에 닿지 않음');
    expect(unreachable?.detail).toContain('http://127.0.0.1:9470');
    expect(unreachable).toMatchObject({ retry: true, demo: true });
  });

  it('says a live daemon went away instead of blaming /health', () => {
    const notice = reachNotice(conn({ status: 'offline', error: DAEMON_CLOSED }), true);
    expect(notice).toMatchObject({ kind: 'unreachable', retry: true });
    expect(notice?.detail).toContain('연결이 끊겼습니다');
    expect(notice?.detail).not.toContain('/health');
  });

  it('reports a failed handshake with its error', () => {
    const failed = reachNotice(conn({ status: 'error', error: 'ws closed 1006' }), true);
    expect(failed).toMatchObject({ kind: 'failed', title: '데몬 연결 실패', detail: 'ws closed 1006' });
  });

  it('names the OpenAI surface a server, not a daemon', () => {
    expect(reachNotice(conn({ transport: 'openai', status: 'offline' }), true)?.title).toBe('서버에 닿지 않음');
  });

  it('keeps demo calm offline — it needs no network', () => {
    const demo = reachNotice(conn({ transport: 'demo', baseUrl: 'demo://simulated' }), false);
    expect(demo).toMatchObject({ kind: 'demo-offline', retry: false, demo: false });
  });
});
