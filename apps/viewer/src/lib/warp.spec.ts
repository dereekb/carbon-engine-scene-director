import { describe, expect, it } from 'vitest';
import { CjsBallparkController } from './runtime-sim';
import { LandingPoint, WarpExitTime, WarpFactor, WarpLength, WarpPhaseAt, type WarpProfile } from './warp';

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
