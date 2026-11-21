/**
 * Bombadil UI invariants for the desk's demo mode.
 *
 * Bombadil explores the app on its own — it clicks, types, scrolls and
 * presses the desk's keyboard shortcuts — and checks the exported properties
 * in every state it reaches. Nothing here is a fixed script: the properties
 * say what must hold, Bombadil finds the paths that try to break them.
 *
 * Run against a built desk (demo mode needs no daemon):
 *
 *   npm run test:bombadil                      # GitHub Pages demo
 *   BOMBADIL_ORIGIN=http://127.0.0.1:4173/ npm run test:bombadil
 *
 * Two kinds of checks live here:
 *
 *   1. The defaults — console errors, uncaught exceptions, unhandled
 *      rejections and HTTP 4xx/5xx (`browser/defaults/properties`), plus the
 *      stock click/scroll/navigation generators (`browser/defaults`).
 *   2. The desk's own invariants — one overlay at a time, an announced
 *      overlay, and the render agreeing with the store it renders (busy ⇔
 *      stop control, inspector flag ⇔ drawer, transcript ⇔ messages,
 *      transport chip ⇔ connection).
 *
 * The store is the `window.__damonDesk` controller `src/main.tsx` exposes for
 * e2e smoke checks; every property tolerates its absence, so the same
 * specification also runs against a surface that only has the DOM.
 */

import { always, eventually, now, weighted } from '@antithesishq/bombadil';
import {
  actions,
  extract,
  registerCustomAction,
  type ActionTemplate,
} from '@antithesishq/bombadil/browser';

/* The default properties: no console errors, no uncaught exceptions, no
 * unhandled rejections, no HTTP 4xx/5xx. Re-exported by name rather than
 * `export *` so the spec registers its own action generator below and not
 * the stock `defaultActions` at the same time. */
export {
  noConsoleErrors,
  noHttpErrorCodes,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';
import { defaultActions } from '@antithesishq/bombadil/browser/defaults';
import { isAction } from '@antithesishq/bombadil/actions';

type DeskSnapshot = {
  transport: string;
  busy: boolean;
  inspector: boolean;
  messages: number;
};

/** The controller the app renders, narrowed to what these properties read. */
const desk = extract((state): DeskSnapshot | null => {
  const store = (
    state.window as unknown as {
      __damonDesk?: { getSnapshot?: () => unknown };
    }
  ).__damonDesk;
  const snap = store?.getSnapshot?.() as
    | {
        connection?: { transport?: string };
        busy?: boolean;
        inspector?: { open?: boolean };
        activeId?: string | null;
        conversations?: { id: string; messages?: unknown[] }[];
      }
    | undefined;
  if (!snap) return null;
  const active = (snap.conversations ?? []).find((entry) => entry.id === snap.activeId);
  return {
    transport: String(snap.connection?.transport ?? 'unknown'),
    busy: snap.busy === true,
    inspector: snap.inspector?.open === true,
    messages: Array.isArray(active?.messages) ? active.messages.length : 0,
  } as DeskSnapshot;
});

/** Overlays the user can see right now: the palette, the connect panel, the scenario launcher. */
const openDialogs = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="dialog"]'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((node) => ({
      name: (node.getAttribute('aria-label') ?? node.getAttribute('aria-labelledby') ?? '').trim(),
      modal: node.getAttribute('aria-modal') === 'true',
    })),
);

/** The parts of the chrome these properties compare against the store. */
const chrome = extract((state) => {
  const visible = (selector: string): boolean => {
    const node = state.document.querySelector(selector);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const toggle = state.document.querySelector('.inspector-toggle');
  return {
    stop: visible('.stop-turn'),
    drawer: visible('aside.inspector'),
    togglePressed: toggle?.getAttribute('aria-pressed') ?? null,
    pill: (state.document.querySelector('.topbar .pill')?.textContent ?? '').trim() || null,
    title: (state.document.querySelector('.topbar h1')?.textContent ?? '').trim(),
    turns: state.document.querySelectorAll('.transcript .turn').length,
    composerFields: state.document.querySelectorAll('.composer textarea').length,
  };
});

/* ----------------------------- invariants ----------------------------- */

/**
 * One overlay at a time. The palette, the connect panel and the scenario
 * launcher all declare `aria-modal="true"`; two of them at once leaves the
 * screen reader (and the scrim) with two claims on the same interaction.
 */
export const singleModalAtATime = always(() => openDialogs.current.length <= 1);

/** Every overlay the user can see is a modal and names itself. */
export const modalsAreNamed = always(() =>
  openDialogs.current.every((dialog) => dialog.modal && dialog.name !== ''),
);

/** The header's transport chip says the connection the store actually holds. */
export const transportChipMatchesStore = always(() => {
  const snap = desk.current;
  const { pill } = chrome.current;
  return snap === null || pill === null || pill === snap.transport;
});

/** A live turn is what shows the stop control, and nothing else is. */
export const busyMirrorsStopControl = always(() => {
  const snap = desk.current;
  return snap === null || snap.busy === chrome.current.stop;
});

/** The inspector flag, the drawer and the toggle's pressed state move together. */
export const inspectorMirrorsDrawer = always(() => {
  const snap = desk.current;
  if (snap === null) return true;
  const { drawer, togglePressed } = chrome.current;
  const pressed = togglePressed === null ? snap.inspector : togglePressed === 'true';
  return snap.inspector === drawer && pressed === snap.inspector;
});

/** The transcript shows exactly the messages of the conversation it names. */
export const transcriptMirrorsActiveConversation = always(() => {
  const snap = desk.current;
  return snap === null || chrome.current.turns === snap.messages;
});

/** The header always says which conversation is open ("새 대화" included). */
export const headerNamesTheConversation = always(() => chrome.current.title !== '');

/** Never more than one composer, however the desk re-renders. */
export const singleComposer = always(() => chrome.current.composerFields <= 1);

/**
 * A live turn settles. The demo transport streams a canned reply and then
 * closes the turn, so a turn that stays busy is a stuck stream — the failure
 * mode this desk exists to make visible.
 */
export const liveTurnSettles = always(
  now(() => desk.current !== null && desk.current.busy).implies(
    eventually(() => desk.current !== null && !desk.current.busy).within(45, 'seconds'),
  ),
);

/* ---------------------------- action drivers ---------------------------- */

/**
 * A synthetic keydown, delivered where the desk listens for it (`document`).
 * Meta and Ctrl are both set so the same action works on macOS and Linux.
 */
const shortcut = registerCustomAction(
  'desk:shortcut',
  async (document, _window, key: string) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: true, ctrlKey: true, bubbles: true }),
    );
  },
);

/**
 * Type a prompt and send it: the whole turn lifecycle (composer → transport →
 * streamed reply → idle) in one action, so the properties above see turns
 * being sent instead of waiting for a random click to find the send button.
 */
const sendTurn = registerCustomAction('desk:send-turn', async (document, _window) => {
  const area = document.querySelector<HTMLTextAreaElement>('.composer textarea');
  if (!area) return;
  area.focus();
  area.select();
  document.execCommand('insertText', false, 'Bombadil: 이 데모가 응답하는지 한 줄로 알려줘');
  // React commits the controlled value on the next tick; the button enables with it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const send = Array.from(document.querySelectorAll('.composer .send-btn')).find(
    (button) => !(button as HTMLButtonElement).disabled,
  ) as HTMLButtonElement | undefined;
  send?.click();
});

/* The keyboard shortcuts the desk documents (⌘K, ⌘I, Esc) and a turn to send. */
const keyboard = actions(
  (): ActionTemplate[] => [shortcut('k'), shortcut('i'), shortcut('Escape')],
);

const turns = actions((): ActionTemplate[] => [sendTurn()]);

/**
 * Bombadil's stock generators, minus free-form typing into fields.
 *
 * 0.8.0 crashes the whole run (`decoding response for
 * Debugger.evaluateOnCallFrame`, lone surrogate) when its random text carries
 * an unpaired surrogate, so the suite types the fixed prompt below instead of
 * letting a 5-minute run die on random bytes. Clicks, scrolling, hover-free
 * navigation and waits all stay.
 */
const pointerDefaults = defaultActions.filter((action) => !isAction(action, 'TypeText'));

export const deskActions = weighted([
  [100, pointerDefaults],
  [15, keyboard],
  [8, turns],
]);
