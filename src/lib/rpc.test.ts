import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_PROTOCOL,
  RpcClient,
  RpcError,
  capabilitiesOf,
  negotiatesProtocol,
  parseFrame,
  rpcErrorHint,
  wsUrlFor,
  type SocketLike,
} from './rpc';

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

  it('carries seq, replay and the gap fields to subscribers', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '1' } });
    await connecting;

    const seen: Array<Record<string, unknown>> = [];
    client.onEvent((event) => seen.push(event as unknown as Record<string, unknown>));
    socket().deliver({ event: 'session.event', sessionId: 's1', seq: 12, data: { type: 'turn_started' } });
    socket().deliver({ event: 'session.event', sessionId: 's1', seq: 3, replay: true, data: { type: 'turn_completed' } });
    socket().deliver({ event: 'session.gap', sessionId: 's1', dropped: 4, cursor: 17 });
    socket().deliver({ event: 'session.snapshot_required', sessionId: 's1', cursor: 21, reason: 'journal_overflow' });

    expect(seen[0]).toMatchObject({ seq: 12, replay: false });
    expect(seen[1]).toMatchObject({ seq: 3, replay: true });
    expect(seen[2]).toMatchObject({ event: 'session.gap', dropped: 4, cursor: 17 });
    expect(seen[3]).toMatchObject({ event: 'session.snapshot_required', cursor: 21, reason: 'journal_overflow' });
  });
});

describe('capabilitiesOf', () => {
  it('reads an absent capability as false — the promise comes from the daemon', () => {
    expect(capabilitiesOf(null).eventSeq).toBe(false);
    expect(capabilitiesOf({ protocol: 2, daemon: 'damond', version: '0.8.0' }).idempotentTurns).toBe(false);
    const caps = capabilitiesOf({
      protocol: 2,
      daemon: 'damond',
      version: '0.8.0',
      capabilities: { eventSeq: true, connGap: true, nonsense: true },
    });
    expect(caps).toEqual({
      eventSeq: true,
      snapshotRequired: false,
      connGap: true,
      idempotentTurns: false,
      turnLedger: false,
      versionNegotiation: false,
      sessionPhase: false,
    });
  });

  it('only negotiates when the daemon offered a version range', () => {
    expect(negotiatesProtocol({ protocol: 2, daemon: 'damond', version: '0.7.0' })).toBe(false);
    expect(negotiatesProtocol({ protocol: 2, daemon: 'damond', version: '0.8.0', supported: [] })).toBe(false);
    expect(negotiatesProtocol({ protocol: 2, daemon: 'damond', version: '0.8.0', supported: [2] })).toBe(true);
  });
});

describe('RpcClient — version negotiation', () => {
  const modernHello = {
    protocol: 2,
    minProtocol: 2,
    supported: [2],
    capabilities: { eventSeq: true, snapshotRequired: true, connGap: true, idempotentTurns: true, turnLedger: true, versionNegotiation: true },
    daemon: 'damond',
    version: '0.9.0',
    permissionTimeoutSecs: 300,
  };

  it('confirms the version with a hello request and merges the answer', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: modernHello });
    await Promise.resolve();

    const sent = socket().last;
    expect(sent).toMatchObject({ method: 'hello', params: { protocolVersion: CLIENT_PROTOCOL, client: { name: 'damon-chat-desk' } } });
    // The push hello carries no roster: the answer does.
    socket().deliver({ id: sent.id, result: { ...modernHello, backends: ['claude'], methods: [] } });

    const hello = await connecting;
    expect(client.negotiated).toBe(true);
    expect(hello.backends).toEqual(['claude']);
    expect(capabilitiesOf(hello).idempotentTurns).toBe(true);
  });

  it('refuses a daemon whose version it cannot speak, naming what it offers', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: modernHello });
    await Promise.resolve();
    socket().deliver({
      id: socket().last.id,
      error: { code: -32012, message: 'unsupported', data: { requested: 2, supported: [3] } },
    });
    await expect(connecting).rejects.toThrow('3');
    await expect(connecting).rejects.toThrow('protocol');
    expect(client.negotiated).toBe(false);
    expect(rpcErrorHint(-32012)).toContain('protocol');
  });

  it('falls back to the push hello when the daemon has no hello request', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: modernHello });
    await Promise.resolve();
    socket().deliver({ id: socket().last.id, error: { code: -32601, message: 'unknown method' } });
    await expect(connecting).resolves.toMatchObject({ protocol: 2, version: '0.9.0' });
    expect(client.negotiated).toBe(false);
  });

  it('does not ask a daemon that never advertised a range', async () => {
    const { client, socket } = setup();
    const connecting = client.connect('ws://x/ws');
    socket().deliver({ hello: { protocol: 2, daemon: 'damond', version: '0.7.2' } });
    await expect(connecting).resolves.toMatchObject({ version: '0.7.2' });
    expect(client.negotiated).toBe(false);
    // Only the hello push crossed the wire — no request at all.
    expect(socket().sent).toHaveLength(0);
  });
});
