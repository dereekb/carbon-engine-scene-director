import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_MS, TICKS_PER_SECOND } from './clock';
import { ExportFrameTicks } from './export-frames';
import { FrameLock } from './frame-lock';

describe('FrameLock (sd-time)', () => {
  it('has frame 0 due at the anchor itself', () => {
    const lock = new FrameLock(30, CLOCK_EPOCH_TICKS);
    expect(lock.frame).toBe(-1);
    expect(lock.NextClock()).toBe(CLOCK_EPOCH_TICKS);
    expect(lock.IsDue()).toBe(true);
    lock.Reached();
    expect(lock.frame).toBe(0);
    expect(lock.NextClock()).toBe(CLOCK_EPOCH_TICKS + 333_333);
    expect(lock.IsDue()).toBe(false);
  });

  it('makes every other 60 Hz frame a grid frame at 30 fps', () => {
    const lock = new FrameLock(30, 0);
    lock.Reached();
    const pattern: boolean[] = [];
    for (let frame = 0; frame < 600; frame++) {
      lock.Advance(Math.round((1000 / 60) * TICKS_PER_MS));
      const due = lock.IsDue();
      pattern.push(due);
      if (due) lock.Reached();
    }
    expect(pattern.filter(Boolean)).toHaveLength(300);
    for (let frame = 2; frame < 600; frame++) expect(pattern[frame], `frame ${frame}`).toBe(!pattern[frame - 1]);
    expect(lock.frame).toBe(300);
  });

  it('owes at most one frame: a slow spell is never paid back', () => {
    const lock = new FrameLock(30, 0);
    lock.Reached();
    // A 2 s stall, then fast frames: one grid frame is due, then the pacing goes on from there.
    lock.Advance(2 * TICKS_PER_SECOND);
    expect(lock.IsDue()).toBe(true);
    lock.Reached();
    expect(lock.IsDue()).toBe(true);
    lock.Reached();
    expect(lock.IsDue()).toBe(false);
    lock.Advance(Math.round((1000 / 60) * TICKS_PER_MS));
    expect(lock.IsDue()).toBe(false);
    lock.Advance(Math.round((1000 / 60) * TICKS_PER_MS));
    expect(lock.IsDue()).toBe(true);
  });

  it('puts grid frame k at the anchor plus the export grid, and re-anchors', () => {
    const lock = new FrameLock(24, 5 * TICKS_PER_SECOND);
    for (let index = 0; index <= 48; index++) {
      expect(lock.NextClock()).toBe(5 * TICKS_PER_SECOND + ExportFrameTicks(index, 24));
      lock.Advance(TICKS_PER_SECOND);
      lock.Reached();
    }
    expect(lock.NextClock()).toBe(7 * TICKS_PER_SECOND + ExportFrameTicks(1, 24));
    lock.Anchor(3 * TICKS_PER_SECOND);
    expect([lock.frame, lock.NextClock(), lock.IsDue()]).toEqual([-1, 3 * TICKS_PER_SECOND, true]);
  });
});
