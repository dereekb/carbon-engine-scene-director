import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { AUDIBLE_MAX_RATE, isTimeRate, MAX_SNAPSHOT_EVERY_SECONDS, MAX_TIME_RATE, MAX_TIME_WINDOW_SECONDS, MIN_SNAPSHOT_EVERY_SECONDS, MIN_TIME_RATE, MIN_TIME_WINDOW_SECONDS, normalizeTimeControlCommand } from './command';

describe('normalizeTimeControlCommand', () => {
  it('takes pause and rate, and {} or nothing as a status read', () => {
    expect(normalizeTimeControlCommand({})).toEqual({});
    expect(normalizeTimeControlCommand(undefined)).toEqual({});
    expect(normalizeTimeControlCommand({ pause: true })).toEqual({ pause: true });
    expect(normalizeTimeControlCommand({ pause: false, rate: 4 })).toEqual({ pause: false, rate: 4 });
    expect(normalizeTimeControlCommand({ rate: 0.25 })).toEqual({ rate: 0.25 });
  });

  it('bounds the rate from 1/16 to 32', () => {
    expect(MIN_TIME_RATE).toBe(1 / 16);
    expect(MAX_TIME_RATE).toBe(32);
    expect(AUDIBLE_MAX_RATE).toBe(2);
    expect(normalizeTimeControlCommand({ rate: MIN_TIME_RATE })).toEqual({ rate: MIN_TIME_RATE });
    expect(normalizeTimeControlCommand({ rate: MAX_TIME_RATE })).toEqual({ rate: MAX_TIME_RATE });
    for (const rate of [0, -1, 1 / 32, 33, Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
      expect(isTimeRate(rate)).toBe(false);
      expect(catchSceneError(() => normalizeTimeControlCommand({ rate })).problems).toEqual([expect.stringContaining('time_control.rate must be a number from 0.0625')]);
    }
  });

  it('takes back, seek, every and window within their bounds', () => {
    expect(normalizeTimeControlCommand({ back: 10, rate: 0.25 })).toEqual({ back: 10, rate: 0.25 });
    expect(normalizeTimeControlCommand({ seek: 0, pause: true })).toEqual({ seek: 0, pause: true });
    expect(normalizeTimeControlCommand({ every: MIN_SNAPSHOT_EVERY_SECONDS, window: MAX_TIME_WINDOW_SECONDS })).toEqual({ every: 1, window: 3600 });
    expect(normalizeTimeControlCommand({ every: MAX_SNAPSHOT_EVERY_SECONDS, window: MIN_TIME_WINDOW_SECONDS })).toEqual({ every: 60, window: 10 });
    for (const back of [0, -1, Number.NaN, '5']) expect(catchSceneError(() => normalizeTimeControlCommand({ back })).problems).toEqual(['time_control.back must be a number of scene seconds above 0']);
    expect(catchSceneError(() => normalizeTimeControlCommand({ seek: -1 })).problems).toEqual([expect.stringContaining('time_control.seek must be a scene time')]);
    for (const every of [0.5, 61]) expect(catchSceneError(() => normalizeTimeControlCommand({ every })).problems).toEqual([expect.stringContaining('time_control.every must be')]);
    for (const window of [9, 3601]) expect(catchSceneError(() => normalizeTimeControlCommand({ window })).problems).toEqual([expect.stringContaining('time_control.window must be')]);
  });

  it('takes a seek in timeline seconds', () => {
    expect(normalizeTimeControlCommand({ seek: { timeline: 3.5 }, rate: 0.5 })).toEqual({ seek: { timeline: 3.5 }, rate: 0.5 });
    expect(normalizeTimeControlCommand({ seek: { timeline: 0 } })).toEqual({ seek: { timeline: 0 } });
    for (const seek of [{ timeline: -1 }, { timeline: '3' }, { timeline: 3, scene: 4 }, {}, [3]]) {
      expect(catchSceneError(() => normalizeTimeControlCommand({ seek })).problems).toEqual([expect.stringContaining('or { timeline: <seconds of timeline time, 0 or more> }')]);
    }
  });

  it('refuses back with seek', () => {
    expect(catchSceneError(() => normalizeTimeControlCommand({ back: 5, seek: 4 })).problems).toEqual(['time_control: give back or seek, not both']);
    expect(catchSceneError(() => normalizeTimeControlCommand({ back: 5, seek: { timeline: 1 } })).problems).toEqual(['time_control: give back or seek, not both']);
  });

  it('lists every problem at once: a bad pause, a bad rate, bad jump keys and unknown keys', () => {
    const problems = catchSceneError(() => normalizeTimeControlCommand({ pause: 'yes', rate: 99, back: -10, every: 0, window: 5, speed: 2 })).problems;
    expect(problems).toHaveLength(6);
    expect(problems).toContain('time_control.speed is not a time_control field (pause, rate, back, seek, every, window)');
    expect(problems).toContain('time_control.pause must be true (pause) or false (play)');
  });

  it('refuses a non-object', () => {
    expect(catchSceneError(() => normalizeTimeControlCommand([1])).problems).toEqual(['time_control must be an object { pause?, rate?, back?, seek?, every?, window? }']);
  });
});
