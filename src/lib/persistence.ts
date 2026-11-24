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

export type SaveResult = { status: 'saved' } | { status: 'unavailable' } | { status: 'failed' };

export function saveState(state: SavedState, storage: Storage | undefined = safeStorage()): SaveResult {
  if (!storage) return { status: 'unavailable' };
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
    return { status: 'saved' };
  } catch {
    return { status: 'failed' };
  }
}

export function safeStorage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}
