import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { AUDIBLE_MAX_RATE, isTimeRate, MAX_TIME_RATE, MIN_TIME_RATE, normalizeTimeControlCommand } from './command';

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

  it('lists every problem at once: a bad pause, unknown keys and the jump keys that arrive with the snapshots', () => {
    const problems = catchSceneError(() => normalizeTimeControlCommand({ pause: 'yes', rate: 99, back: 10, seek: 4, every: 5, window: 60, speed: 2 })).problems;
    expect(problems).toHaveLength(7);
    expect(problems.filter((problem) => problem.includes('arrive with the snapshots'))).toHaveLength(4);
    expect(problems).toContain('time_control.speed is not a time_control field (pause, rate)');
    expect(problems).toContain('time_control.pause must be true (pause) or false (play)');
  });

  it('refuses a non-object', () => {
    expect(catchSceneError(() => normalizeTimeControlCommand([1])).problems).toEqual(['time_control must be an object { pause?, rate? }']);
  });
});
