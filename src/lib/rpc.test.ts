import { describe, expect, it, vi } from 'vitest';
import { RpcClient, RpcError, parseFrame, rpcErrorHint, wsUrlFor, type SocketLike } from './rpc';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  get last(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
  }
}

function setup() {
  let socket: FakeSocket | null = null;
  const client = new RpcClient((url) => {
    socket = new FakeSocket(url);
    return socket;
  });
  return { client, socket: () => socket as unknown as FakeSocket };
}

describe('wsUrlFor', () => {
  it('swaps the scheme and appends /ws with a ticket', () => {
    expect(wsUrlFor('http://127.0.0.1:9470', 'abc')).toBe('ws://127.0.0.1:9470/ws?ticket=abc');
    expect(wsUrlFor('https://box.local/base/', 't')).toBe('wss://box.local/base/ws?ticket=t');
  });
});

describe('RpcClient', () => {
  it('resolves the hello frame that opens the connection', async () => {
    const { client, socket } = setup();
    const hello = client.connect('ws://x/ws?ticket=1');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '0.7.2', backends: ['claude', 'codex'] } });
    await expect(hello).resolves.toMatchObject({ protocol: 2, backends: ['claude', 'codex'] });
    expect(client.hello?.version).toBe('0.7.2');
  });

  it('sends a request frame and resolves on the matching id', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const call = client.request('session.list', { limit: 5 });
    const frame = socket().last;
    expect(frame).toMatchObject({ id: 1, method: 'session.list', params: { limit: 5 } });
    socket().deliver({ id: 1, result: { sessions: [{ sessionId: 'a' }] } });
    await expect(call).resolves.toEqual({ sessions: [{ sessionId: 'a' }] });
  });

  it('turns an error frame into RpcError with the code', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const call = client.request('session.create', {});
    socket().deliver({ id: 1, error: { code: -32003, message: 'backend `pi` is not available' } });
    await expect(call).rejects.toBeInstanceOf(RpcError);
    await expect(call).rejects.toMatchObject({ code: -32003 });
    expect(rpcErrorHint(-32003)).toContain('backend');
  });

  it('fans out server pushes to every subscriber', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const seen: string[] = [];
    const off = client.onEvent((event) => seen.push(`${event.sessionId}:${event.event}`));
    socket().deliver({ event: 'session.event', sessionId: 's1', data: { type: 'turn_started' } });
    socket().deliver({ event: 'session.event', sessionId: 's2', data: { type: 'turn_started' } });
    off();
    socket().deliver({ event: 'session.event', sessionId: 's3', data: {} });
    expect(seen).toEqual(['s1:session.event', 's2:session.event']);
  });

  it('rejects pending calls when the socket closes', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const call = client.request('turn.start', { sessionId: 's', prompt: 'hi' });
    socket().close();
    await expect(call).rejects.toThrow('socket closed');
    expect(client.connected).toBe(false);
  });

  it('times out a request the daemon never answers', async () => {
    vi.useFakeTimers();
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const call = client.request('memory.list', { scope: 'user' }, 1000);
    const assertion = expect(call).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects connect when the socket dies before hello', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().close();
    await expect(connecting).rejects.toThrow('socket closed');
  });

  it('ignores frames that are not JSON', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame({})).toBeNull();
    expect(parseFrame('{"event":"x"}')).toMatchObject({ event: 'x' });
  });
});
