/**
 * Delivery honesty — what protocol v2 added so a client can tell a
 * partial answer from a complete one.
 *
 * Three things arrive on the wire that the desk has to believe:
 *
 *   - every `session.event` frame carries `seq`, a session-scoped,
 *     strictly increasing cursor;
 *   - `session.gap {dropped, cursor}` names how many events this
 *     connection never received;
 *   - `session.snapshot_required {cursor, reason}` says the in-flight
 *     journal shed its prefix, so the stream on screen is not the turn.
 *
 * The daemon announces both holes, and this tracker also notices a jump
 * in `seq` on its own — the same fact from two directions, so a client
 * that misses the announcement still does not render a hole as an answer.
 *
 * No React and no transport here: this is arithmetic, unit-tested on its
 * own, and the only place the cursor is interpreted.
 */

import type { SlotDelivery } from './types';

/**
 * Follows one session's event numbering for the length of one turn.
 *
 * `baseline` is where the session stood before this turn (the `cursor`
 * `session.create` / `resume` / `watch` returned). Without it the first
 * frame establishes the baseline and nothing before it can be called
 * lost — an honest "I do not know what I missed".
 */
export class DeliveryTracker {
  private last: number | null;

  constructor(baseline: number | null = null) {
    this.last = baseline;
  }

  /** Where the numbering stands now, or null before any frame. */
  get cursor(): number | null {
    return this.last;
  }

  /** Adopt a cursor the daemon handed out in a result (create/resume/watch). */
  start(cursor: number | null | undefined): void {
    if (typeof cursor === 'number' && Number.isFinite(cursor)) this.last = cursor;
  }

  /**
   * Count the events between the last frame and this one. A frame
   * without `seq` (replayed store rows) says nothing about numbering, and
   * a `seq` at or behind the last one is a repeat or a rewind, not a hole.
   */
  observe(seq: number | null | undefined): number {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return 0;
    const last = this.last;
    if (last === null) {
      this.last = seq;
      return 0;
    }
    if (seq <= last) return 0;
    const skipped = seq - last - 1;
    this.last = seq;
    return skipped > 0 ? skipped : 0;
  }

  /**
   * Adopt a `session.gap` frame's own count and move to the cursor the
   * frame names, so the frame that follows it is not counted twice.
   */
  admit(dropped: number | null | undefined, cursor: number | null | undefined): number {
    if (typeof cursor === 'number' && Number.isFinite(cursor)) {
      this.last = this.last === null ? cursor : Math.max(this.last, cursor);
    }
    return typeof dropped === 'number' && dropped > 0 ? dropped : 0;
  }
}

/** Add what a frame reported to the slot's running record. */
export function mergeDelivery(current: SlotDelivery | undefined, patch: Partial<SlotDelivery>): SlotDelivery {
  const base: SlotDelivery = current ?? { dropped: 0 };
  return {
    ...base,
    ...patch,
    dropped: (current?.dropped ?? 0) + (patch.dropped ?? 0),
    // Sticky: once known lost, a later frame does not make it whole.
    snapshotRequired: base.snapshotRequired || patch.snapshotRequired || undefined,
  };
}

/**
 * The line(s) the reply card shows under its header. Empty when the
 * delivery layer has nothing to admit.
 */
export function deliverySummary(delivery: SlotDelivery): string[] {
  const lines: string[] = [];
  if (delivery.snapshotRequired) {
    lines.push(
      delivery.resynced
        ? '저널 유실 — 데몬 저장본에서 다시 읽었습니다 (session.snapshot_required)'
        : delivery.stale
          ? '저널 유실 — 이 응답은 일부가 빠졌을 수 있습니다 (session.snapshot_required)'
          : '저널 유실 — 데몬 저장본에서 다시 읽는 중 (session.snapshot_required)',
    );
  }
  if (delivery.dropped > 0) {
    lines.push(`이 연결이 놓친 이벤트 ${delivery.dropped}개 — 응답 일부가 빠졌을 수 있습니다 (session.gap)`);
  }
  if (delivery.attached) {
    lines.push('이미 실행 중인 턴에 붙었습니다 — 새 턴을 시작하지 않았습니다 (duplicate · inProgress)');
  } else if (delivery.duplicate) {
    lines.push('같은 키의 이전 결과를 재사용했습니다 — 턴을 다시 돌리지 않았습니다 (duplicate)');
  }
  if (delivery.resumed) {
    lines.push('세션이 살아있지 않아 session.resume 후 같은 키로 다시 보냈습니다 (-32001)');
  }
  return lines;
}
