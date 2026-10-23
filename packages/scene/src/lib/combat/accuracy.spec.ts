import { describe, expect, it } from 'vitest';
import { HIT_RESULTS, hitResultOf, NO_FALLOFF_METRES, rollShot, turretHitChance, vortonApplication } from './accuracy';

/**
 * The max-skills Rifter's 200mm AutoCannon II on a Punisher (signature 37).
 */
const AUTOCANNON = { tracking: 393.75, optimal: 750, falloff: 9675, signatureResolution: 40000, signatureRadius: 37 };

describe('turretHitChance', () => {
  it("gives EVE's chances for a Rifter's autocannon on a Punisher", () => {
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 5000 })).toBeCloseTo(0.875, 3);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 750 + 2 * 9675 })).toBe(0.0625);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 700 })).toBe(1);
    // Orbiting it at ~1 km at 400 m/s: ω ≈ 0.374 rad/s.
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0.374, distance: 1000 })).toBeCloseTo(0.48, 2);
  });

  it("has no reach past optimal with a disintegrator's 1 m falloff, and keeps Destiny's guards", () => {
    const disintegrator = { tracking: 52.5, optimal: 32_897, falloff: NO_FALLOFF_METRES, signatureResolution: 40000, signatureRadius: 37, angularVelocity: 0 };
    expect(turretHitChance({ ...disintegrator, distance: 32_897 })).toBe(1);
    expect(turretHitChance({ ...disintegrator, distance: 32_907 })).toBeLessThan(1e-6);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 0, falloff: 0 })).toBe(0);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 0, tracking: 0 })).toBe(0);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 0, signatureRadius: 0 })).toBe(0);
    expect(turretHitChance({ ...AUTOCANNON, angularVelocity: 0, distance: 0, optimal: -1 })).toBe(0);
  });
});

describe('rollShot', () => {
  it('wrecks under 0.01, hits at roll + 0.49 below the chance, misses at or above it', () => {
    expect(rollShot(0.0099, 1)).toEqual({ hit: true, quality: 3, wrecking: true, result: 'wrecks' });
    expect(rollShot(0.01, 1)).toEqual({ hit: true, quality: 0.5, wrecking: false, result: 'grazes' });
    expect(rollShot(0.49, 0.5)).toMatchObject({ hit: true, quality: 0.98, result: 'hits' });
    expect(rollShot(0.5, 0.5)).toEqual({ hit: false, quality: 0, wrecking: false, result: 'misses' });
    expect(rollShot(0.005, 0)).toMatchObject({ hit: false, result: 'misses' });
  });

  it('names every client combat-log tier', () => {
    expect([0.5, 0.625, 0.75, 1, 1.25, 1.49, 3].map(hitResultOf)).toEqual(['grazes', 'glances off', 'hits', 'penetrates', 'smashes', 'smashes', 'wrecks']);
    expect([0.13, 0.2, 0.4, 0.6, 0.9, 0.001].map((roll) => rollShot(roll, 1).result)).toEqual(['grazes', 'glances off', 'hits', 'penetrates', 'smashes', 'wrecks']);
    expect(HIT_RESULTS).toEqual(['grazes', 'glances off', 'hits', 'penetrates', 'smashes', 'wrecks']);
  });
});

describe('vortonApplication', () => {
  const smallVorton = { explosionRadius: 43, explosionVelocity: 190, drf: 0.4 };

  it('applies S / E to a target at rest, capped at 1', () => {
    expect(vortonApplication({ ...smallVorton, signatureRadius: 35, targetSpeed: 0 })).toBeCloseTo(35 / 43, 12);
    expect(vortonApplication({ ...smallVorton, signatureRadius: 500, targetSpeed: 0 })).toBe(1);
    expect(vortonApplication({ ...smallVorton, signatureRadius: 0, targetSpeed: 0 })).toBe(0);
  });

  it('scales a fast small target by (S / E × Ve / Vt) ^ drf', () => {
    const factor = vortonApplication({ ...smallVorton, signatureRadius: 35, targetSpeed: 1000 });
    expect(factor).toBeCloseTo(((35 / 43) * (190 / 1000)) ** 0.4, 12);
    expect(factor).toBeLessThan(35 / 43);
    // Slow enough that the explosion outruns it: S / E again.
    expect(vortonApplication({ ...smallVorton, signatureRadius: 35, targetSpeed: 50 })).toBeCloseTo(35 / 43, 12);
  });
});
