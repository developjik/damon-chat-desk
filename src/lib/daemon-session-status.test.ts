import { describe, expect, it } from 'vitest';
import { DaemonTransport } from './daemon';
import { RpcError } from './rpc';

const MODERN = {
  protocol: 2,
  minProtocol: 2,
  supported: [2],
  capabilities: { sessionPhase: true },
  daemon: 'damond',
  version: '0.9.0',
};

/** Answer `session.status` with `answers[0]`, then whatever follows. */
function transportWith(hello: unknown, answers: unknown[]) {
  const transport = new DaemonTransport({ baseUrl: 'http://127.0.0.1:9470' });
  (transport as unknown as { hello: unknown }).hello = hello;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let index = 0;
  (transport as unknown as { rpc: unknown }).rpc = {
    onEvent: () => () => undefined,
    request: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const answer = answers[Math.min(index++, answers.length - 1)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { transport, calls };
}

describe('DaemonTransport — session.status', () => {
  it('reads phases, asks and recovered rows off the wire', async () => {
    const { transport, calls } = transportWith(MODERN, [
      {
        sessions: [
          {
            sessionId: 'sess-1',
            backend: 'claude',
            busy: true,
            phase: 'awaiting_input',
            idleSecs: 4,
            pendingAsk: { requestId: 'req-1', kind: 'plan', label: '구현 계획', askedAtMs: 1700 },
          },
          { sessionId: 'sess-2', backend: 'codex', busy: true, phase: 'busy', turnId: 'turn-2', idleSecs: 0 },
        ],
        recovered: [{ sessionId: 'sess-9', backend: 'claude', phase: 'busy', sinceMs: 99, turnId: 'turn-9' }],
      },
    ]);

    const result = await transport.sessionStatus();
    expect(calls).toEqual([{ method: 'session.status', params: {} }]);
    expect(result.supported).toBe(true);
    expect(result.rows.map((row) => [row.sessionId, row.phase])).toEqual([
      ['sess-1', 'awaiting_input'],
      ['sess-2', 'busy'],
    ]);
    expect(result.rows[0].pendingAsk).toMatchObject({ kind: 'plan', label: '구현 계획' });
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]).toMatchObject({ sessionId: 'sess-9', phase: 'busy', sinceMs: 99 });
  });

  it('never asks a daemon that did not promise sessionPhase', async () => {
    const { transport, calls } = transportWith({ protocol: 2, daemon: 'damond', version: '0.8.0' }, [{ sessions: [] }]);
    await expect(transport.sessionStatus()).resolves.toEqual({ supported: false, rows: [], recovered: [] });
    expect(calls).toEqual([]);
  });

  it('reports an answered -32601 as unsupported instead of failing the read', async () => {
    const { transport } = transportWith(MODERN, [new RpcError({ code: -32601, message: 'unknown method' })]);
    await expect(transport.sessionStatus()).resolves.toEqual({ supported: false, rows: [], recovered: [] });
  });

  it('lets a real transport error through — the desk decides what to show', async () => {
    const { transport } = transportWith(MODERN, [new RpcError({ code: -32000, message: 'store closed' })]);
    await expect(transport.sessionStatus()).rejects.toMatchObject({ code: -32000 });
  });
});
