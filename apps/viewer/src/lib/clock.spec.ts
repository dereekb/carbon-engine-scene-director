import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, MAX_FRAME_STEP_MS, SceneClock, TICKS_PER_MS, TICKS_PER_SECOND } from './clock';

describe('SceneClock', () => {
  it('starts at the epoch, past the ClientBall shift, and the first frame moves nothing', () => {
    const clock = new SceneClock();
    expect(CLOCK_EPOCH_TICKS).toBeGreaterThan(2 * TICKS_PER_SECOND);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS);
    expect(clock.Advance(12345.6)).toBe(CLOCK_EPOCH_TICKS);
    expect(clock.seconds).toBe(0);
  });

  it('advances in whole ticks by the frame delta', () => {
    const clock = new SceneClock();
    clock.Advance(1000);
    clock.Advance(1016.6667);
    expect(Number.isInteger(clock.now)).toBe(true);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS + Math.round(16.6667 * TICKS_PER_MS));
    clock.Advance(2000);
    expect(clock.seconds).toBeCloseTo(1, 6);
  });

  it('caps a stalled frame, so a hidden tab pauses the scene instead of fast-forwarding it', () => {
    const clock = new SceneClock();
    clock.Advance(0);
    clock.Advance(60_000);
    expect(clock.now - CLOCK_EPOCH_TICKS).toBe(MAX_FRAME_STEP_MS * TICKS_PER_MS);
  });

  it('never goes backwards', () => {
    const clock = new SceneClock();
    clock.Advance(500);
    clock.Advance(600);
    const before = clock.now;
    clock.Advance(100);
    expect(clock.now).toBe(before);
    clock.Advance(Number.NaN);
    expect(clock.now).toBe(before);
    clock.Advance(116);
    expect(clock.now).toBe(before + 16 * TICKS_PER_MS);
  });

  it('adds no ticks while held, and the frame after release advances by its own delta only', () => {
    const clock = new SceneClock();
    clock.Advance(0);
    clock.Advance(100);
    const before = clock.now;
    clock.Hold();
    expect(clock.held).toBe(true);
    clock.Advance(600);
    clock.Advance(1400);
    expect(clock.now).toBe(before);
    clock.Release();
    expect(clock.held).toBe(false);
    clock.Advance(1416);
    expect(clock.now).toBe(before + 16 * TICKS_PER_MS);
  });

  it('scales the step by the rate, after the frame cap', () => {
    const clock = new SceneClock();
    clock.Advance(0);
    clock.rate = 4;
    clock.Advance(100);
    expect(clock.now - CLOCK_EPOCH_TICKS).toBe(400 * TICKS_PER_MS);
    clock.rate = 0.25;
    clock.Advance(200);
    expect(clock.now - CLOCK_EPOCH_TICKS).toBe(425 * TICKS_PER_MS);
    clock.rate = 32;
    clock.Advance(60_200);
    expect(clock.now - CLOCK_EPOCH_TICKS).toBe((425 + 32 * MAX_FRAME_STEP_MS) * TICKS_PER_MS);
    expect(() => {
      clock.rate = 64;
    }).toThrow(RangeError);
    expect(clock.rate).toBe(32);
  });

  it('adds no ticks while paused, or paused and held, and resumes by the next delta only', () => {
    const clock = new SceneClock();
    clock.Advance(0);
    clock.paused = true;
    clock.Advance(500);
    clock.Hold();
    clock.Advance(900);
    clock.Release();
    clock.Advance(1300);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS);
    clock.paused = false;
    clock.Advance(1316);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS + 16 * TICKS_PER_MS);
  });

  it('Next records the frame without moving the clock, and Set moves it', () => {
    const clock = new SceneClock();
    clock.Next(0);
    const target = clock.Next(250);
    expect(target).toBe(CLOCK_EPOCH_TICKS + 250 * TICKS_PER_MS);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS);
    // The frame is recorded: the next frame's target counts from 250 ms, still from the unmoved clock.
    expect(clock.Next(300)).toBe(CLOCK_EPOCH_TICKS + 50 * TICKS_PER_MS);
    clock.Set(CLOCK_EPOCH_TICKS + TICKS_PER_SECOND + 0.4);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS + TICKS_PER_SECOND);
    expect(clock.seconds).toBe(1);
  });
});
