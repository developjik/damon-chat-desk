/**
 * Session list helpers — the sidebar's live search and the archive
 * split. Pure functions so the filter is testable without React.
 */

import type { Conversation } from './types';

/** The daemon row fields the sidebar filters on (a structural subset). */
export interface SessionRowLike {
  sessionId: string;
  title?: string | null;
  backend?: string;
  cwd?: string | null;
  tags?: string[];
  archived?: boolean;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

/** Everything inside a conversation a search should be able to hit. */
export function conversationSearchText(conversation: Conversation): string {
  const parts: string[] = [conversation.title];
  for (const sessionId of Object.values(conversation.daemonSessions ?? {})) parts.push(sessionId);
  for (const message of conversation.messages) {
    if (message.text) parts.push(message.text);
    for (const slot of message.slots ?? []) {
      parts.push(slot.target.providerLabel, slot.target.modelLabel, slot.target.model);
      if (slot.text) parts.push(slot.text);
      for (const tool of slot.tools ?? []) parts.push(tool.name, tool.label);
    }
  }
  return parts.join('\n').toLowerCase();
}

/** Last thing said, for the row's preview line. */
export function conversationPreview(conversation: Conversation): string {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    const text =
      message.role === 'user'
        ? message.text ?? ''
        : [...(message.slots ?? [])].reverse().find((slot) => slot.text)?.text ?? '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat) return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  }
  return '';
}

export interface ConversationQuery {
  text?: string;
  archived?: boolean;
}

/**
 * Filter the conversation list. `archived` defaults to false — archived
 * sessions are out of the sidebar unless the view asks for them.
 */
export function filterConversations(list: Conversation[], query: ConversationQuery = {}): Conversation[] {
  const terms = (query.text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const wantArchived = query.archived === true;
  return list.filter((conversation) => {
    if ((conversation.archived === true) !== wantArchived) return false;
    if (terms.length === 0) return true;
    const body = conversationSearchText(conversation);
    return terms.every((term) => body.includes(term));
  });
}

export interface DaemonQuery {
  text?: string;
  includeArchived?: boolean;
}

/** Same filter for the daemon's own `session.list` rows. */
export function filterDaemonRows<T extends SessionRowLike>(rows: T[], query: DaemonQuery = {}): T[] {
  const terms = (query.text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return rows.filter((row) => {
    if (!query.includeArchived && row.archived === true) return false;
    if (terms.length === 0) return true;
    const body = [row.title ?? '', row.sessionId, row.backend ?? '', row.cwd ?? '', ...(row.tags ?? [])]
      .join('\n')
      .toLowerCase();
    return terms.every((term) => body.includes(term));
  });
}

/** A row's second line: turn count and when it last moved. */
export function conversationMeta(conversation: Conversation, now = Date.now()): string {
  const messages = conversation.messages.length;
  const parts = [`${messages} msg`, relativeTime(conversation.updatedAt, now)];
  if (conversation.remote) parts.push('daemon');
  return parts.join(' · ');
}
