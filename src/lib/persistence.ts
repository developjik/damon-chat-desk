/**
 * Local persistence for the desk: connection settings and the
 * conversations the browser owns (demo + OpenAI-compatible modes).
 * A daemon-backed conversation keeps only its session mapping here —
 * the transcript itself stays on the daemon.
 */

import type { Conversation, TransportKind } from './types';

const KEY = 'damon-desk.v1';

export interface SavedSettings {
  transport: TransportKind;
  baseUrl: string;
  masterToken?: string;
  deviceToken?: string;
  memoryEnabled: boolean;
  compare: boolean;
  primaryKey?: string;
  secondaryKey?: string;
}

export interface SavedState {
  settings: SavedSettings;
  conversations: Conversation[];
  activeId: string | null;
}

export function loadState(storage: Storage | undefined = safeStorage()): SavedState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedState;
    if (!parsed || !Array.isArray(parsed.conversations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(state: SavedState, storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    // Live slots are transient; keep finished text only.
    const conversations = state.conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        slots: message.slots?.map((slot) => (slot.status === 'streaming' ? { ...slot, status: 'canceled' as const } : slot)),
      })),
    }));
    storage.setItem(KEY, JSON.stringify({ ...state, conversations }));
  } catch {
    /* quota or privacy mode — the desk still works in memory */
  }
}

export function safeStorage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const probe = '__damon_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}
