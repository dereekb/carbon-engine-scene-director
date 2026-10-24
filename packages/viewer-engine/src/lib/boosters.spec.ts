import { describe, expect, it } from 'vitest';
import { DriveBoosters, WARP_GLOW_FROM, WARP_GLOW_FULL, WarpGlow, type BoosterHost } from './boosters';

describe('WarpGlow', () => {
  it('is 0 at sub-light speeds and 1 at warp speeds, rising between', () => {
    expect(WarpGlow(0, 300)).toBe(0);
    expect(WarpGlow(300 * WARP_GLOW_FROM, 300)).toBe(0);
    expect(WarpGlow(300 * WARP_GLOW_FULL, 300)).toBe(1);
    expect(WarpGlow(1e9, 300)).toBe(1);
    let last = 0;
    for (let ratio = WARP_GLOW_FROM; ratio <= WARP_GLOW_FULL; ratio += (WARP_GLOW_FULL - WARP_GLOW_FROM) / 8) {
      const glow = WarpGlow(300 * ratio, 300);
      expect(glow).toBeGreaterThanOrEqual(last);
      last = glow;
    }
  });

  it('copes with a max velocity of 0', () => {
    expect(WarpGlow(0, 0)).toBe(0);
    expect(WarpGlow(5000, 0)).toBe(1);
  });
});

describe('DriveBoosters', () => {
  it("sets the booster set's reference speed and warp colours", () => {
    const ship: BoosterHost = { maxSpeed: 0, boosters: { maxVel: 250, warpIntensity: 0 } as NonNullable<BoosterHost['boosters']> };
    DriveBoosters(ship, { speed: 100, maxVelocity: 162.5 });
    expect(ship).toMatchObject({ maxSpeed: 162.5, boosters: { maxVel: 162.5, warpIntensity: 0 } });
    DriveBoosters(ship, { speed: 1e6, maxVelocity: 162.5 });
    expect(ship.boosters?.warpIntensity).toBe(1);
  });

  it('drives a ship without boosters', () => {
    const ship: BoosterHost = { maxSpeed: 0, boosters: null };
    DriveBoosters(ship, { speed: 10, maxVelocity: 0 });
    expect(ship.maxSpeed).toBe(1);
  });
});
