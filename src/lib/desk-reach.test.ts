import { describe, expect, it } from 'vitest';
import { DeskController } from './desk';

const storage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
};

describe('DeskController.retryConnection', () => {
  it('re-probes an unreachable server and goes live once it answers', async () => {
    let up = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (!up) throw new TypeError('Failed to fetch');
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'local-model', owned_by: 'lm' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const desk = new DeskController({ storage: storage(), fetchImpl });

    await desk.connect('openai', 'http://127.0.0.1:1234');
    expect(desk.getSnapshot().connection.status).toBe('offline');

    up = true;
    await desk.retryConnection();
    const connection = desk.getSnapshot().connection;
    expect(connection.status).toBe('live');
    expect(connection.transport).toBe('openai');
    expect(connection.targets.length).toBeGreaterThan(0);
  });

  it('leaves demo and live connections alone', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const desk = new DeskController({ storage: storage(), fetchImpl });
    await desk.enterDemo();
    await desk.retryConnection();
    expect(calls).toBe(0);
    expect(desk.getSnapshot().connection.transport).toBe('demo');
  });
});
