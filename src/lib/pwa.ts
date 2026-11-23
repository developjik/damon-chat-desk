/**
 * Page-side half of the PWA: registers `sw.js`, notices when a new shell
 * is waiting, and tracks whether the browser has a network at all. The
 * state is a tiny external store so React reads it with
 * `useSyncExternalStore`, like the desk.
 */

/**
 * Same string as `SKIP_WAITING` in ./sw — not imported, so the page and
 * the worker share no chunk and `sw.js` stays one classic script
 * (pwa.test.ts keeps the two equal).
 */
export const SKIP_WAITING_MESSAGE = 'SKIP_WAITING';

export interface ShellState {
  /** `navigator.onLine` — false means no network, not "daemon down". */
  online: boolean;
  /** A new shell is installed and waits for the user to accept it. */
  updateReady: boolean;
}

interface WaitingWorker {
  postMessage(message: unknown): void;
}

export class ShellStatus {
  private state: ShellState;
  private listeners = new Set<() => void>();
  private waiting: WaitingWorker | null = null;
  /** Set once the user accepted; the next controller change reloads. */
  updating = false;
  /** Another tab already activated the new shell; Update just reloads. */
  private takenOver = false;
  private readonly reload: () => void;

  constructor(online = true, reload: () => void = () => undefined) {
    this.state = { online, updateReady: false };
    this.reload = reload;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ShellState => this.state;

  private set(patch: Partial<ShellState>): void {
    const next = { ...this.state, ...patch };
    if (next.online === this.state.online && next.updateReady === this.state.updateReady) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  setOnline(online: boolean): void {
    this.set({ online });
  }

  setWaiting(worker: WaitingWorker | null): void {
    this.waiting = worker;
    this.takenOver = false;
    this.set({ updateReady: !!worker });
  }

  /** Tell the waiting worker to take over; the page reloads on `controllerchange`. */
  applyUpdate(): boolean {
    if (!this.waiting) return false;
    if (this.takenOver) {
      this.reload();
      return true;
    }
    this.updating = true;
    this.waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
    return true;
  }

  /** `controllerchange`: reload if this tab asked for it, else remember. */
  controllerChanged(): void {
    if (this.updating) {
      this.updating = false;
      this.reload();
      return;
    }
    // Without a waiting shell this is the first install claiming the page.
    if (this.waiting) this.takenOver = true;
  }
}

interface WorkerLike extends WaitingWorker {
  state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

/**
 * Report a worker that finished installing while an older one still
 * controls the page. On the very first install nothing controls the page
 * yet — that is not an update, so nothing is reported.
 */
export function trackUpdates(
  registration: RegistrationLike,
  hasController: () => boolean,
  onWaiting: (worker: WorkerLike) => void,
): void {
  if (registration.waiting && hasController()) onWaiting(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && hasController()) onWaiting(worker);
    });
  });
}

/** How often an open tab asks the server for a new `sw.js`. */
const UPDATE_CHECK_MS = 30 * 60 * 1000;

export function registerShell(shell: ShellStatus, base: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  container.addEventListener('controllerchange', () => shell.controllerChanged());
  container
    .register(`${base}sw.js`, { scope: base })
    .then((registration) => {
      trackUpdates(registration, () => !!container.controller, (worker) => shell.setWaiting(worker));
      const check = () => void registration.update().catch(() => undefined);
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch(() => undefined);
}

interface NetworkEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
}

/** Mirror `online`/`offline` into the store; `onOnline` gets a retry hook. */
export function watchNetwork(target: NetworkEvents, shell: ShellStatus, onOnline: () => void): void {
  target.addEventListener('online', () => {
    shell.setOnline(true);
    onOnline();
  });
  target.addEventListener('offline', () => shell.setOnline(false));
}
