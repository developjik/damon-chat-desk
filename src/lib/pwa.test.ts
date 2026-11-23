import { describe, expect, it } from 'vitest';
import { ShellStatus, SKIP_WAITING_MESSAGE, trackUpdates, watchNetwork, type RegistrationLike } from './pwa';
import { SKIP_WAITING } from './sw';

function worker(state = 'installing') {
  const listeners: Array<() => void> = [];
  const posted: unknown[] = [];
  return {
    state,
    posted,
    postMessage: (message: unknown) => posted.push(message),
    addEventListener: (_type: 'statechange', listener: () => void) => listeners.push(listener),
    become(next: string) {
      this.state = next;
      for (const listener of listeners) listener();
    },
  };
}

function registration(waiting: ReturnType<typeof worker> | null = null) {
  const listeners: Array<() => void> = [];
  const reg: RegistrationLike & { found(w: ReturnType<typeof worker>): void } = {
    waiting,
    installing: null,
    addEventListener: (_type, listener) => listeners.push(listener),
    found(w) {
      reg.installing = w;
      for (const listener of listeners) listener();
    },
  };
  return reg;
}

describe('trackUpdates', () => {
  it('reports a worker that installs while an older one controls the page', () => {
    const reg = registration();
    const seen: unknown[] = [];
    trackUpdates(reg, () => true, (w) => seen.push(w));
    const next = worker();
    reg.found(next);
    next.become('installed');
    expect(seen).toEqual([next]);
  });

  it('does not call the first install an update', () => {
    const reg = registration();
    const seen: unknown[] = [];
    trackUpdates(reg, () => false, (w) => seen.push(w));
    const first = worker();
    reg.found(first);
    first.become('installed');
    expect(seen).toEqual([]);
  });

  it('picks up a worker already waiting from an earlier visit', () => {
    const waiting = worker('installed');
    const seen: unknown[] = [];
    trackUpdates(registration(waiting), () => true, (w) => seen.push(w));
    expect(seen).toEqual([waiting]);
  });
});

describe('ShellStatus', () => {
  it('speaks the worker\'s skip-waiting message', () => {
    expect(SKIP_WAITING_MESSAGE).toBe(SKIP_WAITING);
  });

  it('posts SKIP_WAITING to the waiting worker on applyUpdate', () => {
    const shell = new ShellStatus();
    expect(shell.applyUpdate()).toBe(false);
    const waiting = worker('installed');
    shell.setWaiting(waiting);
    expect(shell.getSnapshot().updateReady).toBe(true);
    expect(shell.applyUpdate()).toBe(true);
    expect(waiting.posted).toEqual([{ type: SKIP_WAITING }]);
    expect(shell.updating).toBe(true);
  });

  it('reloads on controllerchange only when this tab asked', () => {
    let reloads = 0;
    const shell = new ShellStatus(true, () => (reloads += 1));
    const waiting = worker('installed');
    shell.setWaiting(waiting);
    shell.applyUpdate();
    shell.controllerChanged();
    expect(reloads).toBe(1);
    expect(shell.updating).toBe(false);
  });

  it('turns Update into a plain reload after another tab took over', () => {
    let reloads = 0;
    const shell = new ShellStatus(true, () => (reloads += 1));
    const waiting = worker('installed');
    shell.setWaiting(waiting);
    shell.controllerChanged();
    expect(reloads).toBe(0);
    expect(shell.applyUpdate()).toBe(true);
    expect(reloads).toBe(1);
    expect(waiting.posted).toEqual([]);
  });

  it('does not treat the first install claiming the page as a takeover', () => {
    let reloads = 0;
    const shell = new ShellStatus(true, () => (reloads += 1));
    shell.controllerChanged();
    const waiting = worker('installed');
    shell.setWaiting(waiting);
    expect(shell.applyUpdate()).toBe(true);
    expect(waiting.posted).toEqual([{ type: SKIP_WAITING }]);
    expect(reloads).toBe(0);
  });

  it('notifies only on real changes', () => {
    const shell = new ShellStatus(true);
    let calls = 0;
    shell.subscribe(() => (calls += 1));
    const before = shell.getSnapshot();
    shell.setOnline(true);
    expect(shell.getSnapshot()).toBe(before);
    shell.setOnline(false);
    expect(calls).toBe(1);
    expect(shell.getSnapshot().online).toBe(false);
  });

  it('mirrors online/offline and retries when the network returns', () => {
    const shell = new ShellStatus(true);
    const listeners: Record<string, () => void> = {};
    let retries = 0;
    watchNetwork({ addEventListener: (type, listener) => (listeners[type] = listener) }, shell, () => (retries += 1));
    listeners.offline!();
    expect(shell.getSnapshot().online).toBe(false);
    expect(retries).toBe(0);
    listeners.online!();
    expect(shell.getSnapshot().online).toBe(true);
    expect(retries).toBe(1);
  });
});
