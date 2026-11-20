import { describe, expect, it } from 'vitest';
import { DeliveryTracker, deliverySummary, mergeDelivery } from './delivery';

describe('DeliveryTracker', () => {
  it('counts the hole a jump in seq leaves behind', () => {
    const tracker = new DeliveryTracker();
    expect(tracker.observe(41)).toBe(0);
    expect(tracker.observe(42)).toBe(0);
    // 43–46 never arrived: the daemon's numbering says so even if no
    // `session.gap` frame did.
    expect(tracker.observe(47)).toBe(4);
    expect(tracker.cursor).toBe(47);
  });

  it('uses the session cursor as the baseline for the first frame', () => {
    const tracker = new DeliveryTracker(40);
    // The turn's first frame is 45: 41–44 were lost between create and turn.
    expect(tracker.observe(45)).toBe(4);
    const fresh = new DeliveryTracker(40);
    expect(fresh.observe(41)).toBe(0);
  });

  it('adopts a session.gap cursor so the next frame is not counted twice', () => {
    const tracker = new DeliveryTracker(10);
    tracker.observe(11);
    expect(tracker.admit(3, 15)).toBe(3);
    // The frame the gap announced carries cursor 15 itself.
    expect(tracker.observe(15)).toBe(0);
    expect(tracker.observe(16)).toBe(0);
  });

  it('ignores repeats, rewinds and frames without numbering', () => {
    const tracker = new DeliveryTracker();
    tracker.observe(7);
    expect(tracker.observe(7)).toBe(0);
    expect(tracker.observe(5)).toBe(0);
    expect(tracker.observe(undefined)).toBe(0);
    expect(tracker.cursor).toBe(7);
    expect(tracker.observe(9)).toBe(1);
  });

  it('reports nothing before the first numbered frame', () => {
    const tracker = new DeliveryTracker();
    expect(tracker.cursor).toBeNull();
    expect(tracker.observe(undefined)).toBe(0);
    expect(tracker.observe(120)).toBe(0);
  });
});

describe('mergeDelivery', () => {
  it('adds gaps up and keeps a snapshot warning sticky', () => {
    const first = mergeDelivery(undefined, { dropped: 2, cursor: 9 });
    expect(first).toEqual({ dropped: 2, cursor: 9, snapshotRequired: undefined });
    const second = mergeDelivery(first, { dropped: 3 });
    expect(second.dropped).toBe(5);
    const third = mergeDelivery(second, { dropped: 0, snapshotRequired: true, resynced: true });
    expect(third).toMatchObject({ dropped: 5, snapshotRequired: true, resynced: true });
    // A later frame does not erase what was already lost.
    expect(mergeDelivery(third, { dropped: 1 }).snapshotRequired).toBe(true);
  });
});

describe('deliverySummary', () => {
  it('says nothing for a clean answer', () => {
    expect(deliverySummary({ dropped: 0 })).toEqual([]);
  });

  it('names the loss and what was done about it', () => {
    expect(deliverySummary({ dropped: 3 })[0]).toContain('3개');
    expect(deliverySummary({ dropped: 3 })[0]).toContain('session.gap');
    expect(deliverySummary({ dropped: 0, snapshotRequired: true, resynced: true })[0]).toContain('다시 읽었습니다');
    expect(deliverySummary({ dropped: 0, snapshotRequired: true, stale: true })[0]).toContain('일부가 빠졌을 수 있습니다');
  });

  it('tells a replayed result, an attached turn and a resume apart', () => {
    const attached = deliverySummary({ dropped: 0, duplicate: true, attached: true });
    expect(attached[0]).toContain('실행 중인 턴');
    const duplicate = deliverySummary({ dropped: 0, duplicate: true });
    expect(duplicate[0]).toContain('재사용');
    const resumed = deliverySummary({ dropped: 0, resumed: true });
    expect(resumed[0]).toContain('session.resume');
  });
});
