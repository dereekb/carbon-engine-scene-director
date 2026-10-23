import { describe, expect, it } from 'vitest';
import { appliedDpsOf, expectedTurretDamageFactor, maxWeaponReachOf, missileReachChance, type PilotWeapon, weaponApplicationOf } from './application';
import { CARACAL_PROFILE, RIFTER_PROFILE } from './piloting.spec-helper';

const AUTOCANNON: PilotWeapon = { kind: 'tracking', dps: 100, optimal: 750, falloff: 9675, tracking: 393.75, signatureResolution: 40_000 };

describe('expectedTurretDamageFactor', () => {
  it("is EVE's mean shot quality at a hit chance: 3p under 1 %, 0.5(p² + 0.98p + 0.0501) above", () => {
    expect(expectedTurretDamageFactor(0)).toBe(0);
    expect(expectedTurretDamageFactor(0.005)).toBeCloseTo(0.015, 12);
    expect(expectedTurretDamageFactor(0.01)).toBeCloseTo(0.03, 12);
    expect(expectedTurretDamageFactor(0.5)).toBeCloseTo(0.5 * (0.25 + 0.49 + 0.0501), 12);
    expect(expectedTurretDamageFactor(1)).toBeCloseTo(1.01505, 12);
  });
});

describe('weaponApplicationOf', () => {
  it('applies a turret in full at rest within optimal, half at optimal + falloff', () => {
    const still = { angular: 0, signature: 37, speed: 0 };
    expect(appliedDpsOf([AUTOCANNON], { ...still, distance: 500 })).toBeCloseTo(101.505, 6);
    expect(weaponApplicationOf(AUTOCANNON, { ...still, distance: 750 + 9675 })).toBeCloseTo(expectedTurretDamageFactor(0.5), 12);
  });

  it('applies a missile inside its flight, its longer-flight chance beyond, nothing past it', () => {
    const missile = CARACAL_PROFILE.weapons[0];
    const geometry = { angular: 0, signature: 380, speed: 100 };
    expect(missile.kind).toBe('missile');
    expect(weaponApplicationOf(missile, { ...geometry, distance: missile.optimal - 1 })).toBe(1);
    expect(missileReachChance(missile, missile.optimal + 1)).toBeCloseTo(missile.upperChance ?? 0, 12);
    expect(weaponApplicationOf(missile, { ...geometry, distance: missile.optimal + missile.falloff + 1 })).toBe(0);
    expect(weaponApplicationOf(missile, { ...geometry, signature: 35, speed: 3000, distance: 1000 })).toBeLessThan(0.1);
  });

  it('applies a vorton within optimal only', () => {
    const vorton: PilotWeapon = { kind: 'vorton', dps: 100, optimal: 10_000, falloff: 1, explosion: { radius: 100, velocity: 100, drf: 0.5 } };
    expect(weaponApplicationOf(vorton, { angular: 0, signature: 400, speed: 0, distance: 9000 })).toBe(1);
    expect(weaponApplicationOf(vorton, { angular: 0, signature: 400, speed: 0, distance: 11_000 })).toBe(0);
  });

  it('reaches optimal + 2 falloffs with turrets, the longer flight with missiles', () => {
    expect(maxWeaponReachOf(RIFTER_PROFILE.weapons)).toBe(750 + 2 * 9675);
    const missile = CARACAL_PROFILE.weapons[0];
    expect(maxWeaponReachOf(CARACAL_PROFILE.weapons)).toBeCloseTo(missile.optimal + missile.falloff, 6);
  });
});
