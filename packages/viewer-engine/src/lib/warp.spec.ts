import { describe, expect, it } from 'vitest';
import { CjsBallparkController } from './runtime-sim';
import { LandingPoint, WARP_IN_BACKDATE_TICKS, WarpDropOutTime, WarpExitTime, WarpFactor, WarpInBackdate, WarpInExitTicks, WarpLength, WarpPhaseAt, WarpRemainingAt, type WarpProfile } from './warp';

const AU = 149_597_870_700;

// Measured in Destiny: a TFI-like battleship (162.5 m/s) warping 300 km at 3 AU/s drops out 12 s after warp start.
const SHORT_WARP: WarpProfile = { accelDuration: 3.7417, cruiseDuration: 0, decelRate: 1, warpSpeed: 225_000.75 };

describe('WarpFactor', () => {
  it('is 1000 × AU/s, rounded, at least 1', () => {
    expect(WarpFactor(5)).toBe(5000);
    expect(WarpFactor(4.5)).toBe(4500);
    expect(WarpFactor(1.0004)).toBe(1000);
    expect(WarpFactor(0)).toBe(1);
  });

  it('refuses what Destiny would throw on', () => {
    expect(() => WarpFactor(Number.NaN)).toThrow(RangeError);
    expect(() => WarpFactor(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => WarpFactor(3e6)).toThrow(RangeError);
  });
});

describe('LandingPoint and WarpLength', () => {
  it('lands range metres back toward where warp begins', () => {
    expect(LandingPoint([0, 0, 300_000], 0, [0, 0, 0])).toEqual([0, 0, 300_000]);
    expect(LandingPoint([0, 0, 300_000], 20_000, [0, 0, 0])).toEqual([0, 0, 280_000]);
    expect(LandingPoint([1000, 0, 0], 500, [1000, 0, 0])).toEqual([1000, 0, 0]);
    expect(WarpLength([0, 0, 300_000], 20_000, [0, 0, 0])).toBe(280_000);
    expect(WarpLength([0, 0, 300_000], 400_000, [0, 0, 0])).toBe(-100_000);
  });
});

describe('WarpExitTime and WarpPhaseAt', () => {
  it("matches Destiny's measured short warp", () => {
    expect(WarpExitTime(SHORT_WARP, 162.5)).toBe(12);
    expect(WarpPhaseAt(SHORT_WARP, 3)).toBe('warping');
    expect(WarpPhaseAt(SHORT_WARP, 3.7417)).toBe('exiting');
    expect(WarpPhaseAt(SHORT_WARP, 11)).toBe('exiting');
  });

  it("runs on Destiny's own profile for a long warp", () => {
    const profile = CjsBallparkController.prototype.SetupWarpConstants(5000, 10 * AU, {});
    expect(profile.cruiseDuration).toBeGreaterThan(0);
    expect(WarpExitTime(profile, 456.25)).toBe(20);
    expect(WarpPhaseAt(profile, profile.accelDuration + profile.cruiseDuration - 0.01)).toBe('warping');
    expect(WarpPhaseAt(profile, profile.accelDuration + profile.cruiseDuration)).toBe('exiting');
  });

  it('never drops out at a max velocity of 0', () => {
    expect(WarpExitTime(SHORT_WARP, 0)).toBe(Infinity);
  });
});

describe('WarpDropOutTime and WarpRemainingAt', () => {
  const profile = CjsBallparkController.prototype.SetupWarpConstants(5000, 3e6, {});

  it('floors to WarpExitTime', () => {
    const slow = WarpDropOutTime(profile, 365);
    expect(slow).toBeCloseTo(profile.accelDuration + Math.log(profile.warpSpeed / 100) / profile.decelRate, 9);
    expect(WarpExitTime(profile, 365)).toBe(Math.floor(slow) + 1);
    expect(WarpDropOutTime(profile, 0)).toBe(Infinity);
  });

  it("follows Destiny's WarpDistance: the whole distance at start, shrinking, then none", () => {
    expect(WarpRemainingAt(profile, 0)).toBeCloseTo(3e6 - 1, 3);
    let last = Infinity;
    for (let t = 0; t <= 12; t += 0.25) {
      const remaining = WarpRemainingAt(profile, t);
      expect(remaining).toBeLessThanOrEqual(last);
      last = remaining;
    }
    // Measured on a park: a Rifter warping in over 3,000 km is 260.2 km out 4 s in and 49.1 km out 5 s in.
    expect(WarpRemainingAt(profile, 4) / 1000).toBeCloseTo(260.2, 1);
    expect(WarpRemainingAt(profile, 5) / 1000).toBeCloseTo(49.1, 1);
    expect(WarpRemainingAt(profile, 40)).toBe(0);
  });

  it("times a warp-in from EntityWarpIn's backdate", () => {
    expect(WarpInBackdate(0)).toBe(0);
    expect(WarpInBackdate(3)).toBe(3);
    expect(WarpInBackdate(900)).toBe(WARP_IN_BACKDATE_TICKS);
    // Measured on a park: started at tick 4 (backdate 4), the exit event came 7 ticks later.
    expect(WarpInExitTicks(profile, 365, 4)).toBe(7);
    expect(WarpInExitTicks(profile, 0, 4)).toBe(Infinity);
  });
});
