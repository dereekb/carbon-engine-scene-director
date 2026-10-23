import { describe, expect, it } from 'vitest';
import { applyLayeredDamage, type DamageLayers, damageTotal, NO_DAMAGE, passiveRecharge, shotDamage } from './damage';

const OMNI = { em: 1, thermal: 1, kinetic: 1, explosive: 1 };

/**
 * A max-skills Rifter's layers (defense.spec.ts) with an even 0.67 structure.
 */
const RIFTER: DamageLayers = {
  shield: { hp: 562.5, resonances: { em: 1, thermal: 0.8, kinetic: 0.6, explosive: 0.5 } },
  armor: { hp: 562.5, resonances: { em: 0.4, thermal: 0.65, kinetic: 0.75, explosive: 0.9 } },
  structure: { hp: 437.5, resonances: { em: 0.67, thermal: 0.67, kinetic: 0.67, explosive: 0.67 } }
};

describe('shotDamage', () => {
  it('scales each type by one factor', () => {
    const base = { em: 49.31, thermal: 0, kinetic: 5.48, explosive: 10.96 };
    expect(shotDamage(base, 3)).toEqual({ em: 49.31 * 3, thermal: 0, kinetic: 5.48 * 3, explosive: 10.96 * 3 });
    expect(damageTotal(base)).toBeCloseTo(65.75, 9);
    expect(damageTotal(NO_DAMAGE)).toBe(0);
  });
});

describe('applyLayeredDamage', () => {
  it('takes damage on the shield through its resonances', () => {
    const result = applyLayeredDamage(RIFTER, { em: 50, thermal: 0, kinetic: 100, explosive: 0 });
    expect(result.taken).toEqual({ shield: 110, armor: 0, structure: 0 });
    expect(result.layers.shield.hp).toBe(452.5);
    expect(result.layers.armor).toEqual(RIFTER.armor);
    expect(result.total).toBe(110);
    expect(result.structure).toBe(437.5);
  });

  it('spills the unabsorbed share of the raw damage into armor at its resonances', () => {
    const layers: DamageLayers = { ...RIFTER, shield: { ...RIFTER.shield, hp: 50 } };
    const result = applyLayeredDamage(layers, { em: 60, thermal: 0, kinetic: 100, explosive: 0 });
    // The shield takes 60 + 60 = 120 against its 50 HP: it absorbs 5/12 of the raw damage, 7/12 moves on.
    const armor = 60 * (7 / 12) * 0.4 + 100 * (7 / 12) * 0.75;
    expect(result.taken.shield).toBe(50);
    expect(result.taken.armor).toBeCloseTo(armor, 9);
    expect(armor).toBeCloseTo(57.75, 9);
    expect(result.layers.shield.hp).toBe(0);
    expect(result.layers.armor.hp).toBeCloseTo(562.5 - 57.75, 9);
    expect(result.taken.structure).toBe(0);
  });

  it('goes through all three layers to 0, and an emptied layer passes everything on', () => {
    const tiny: DamageLayers = { shield: { hp: 10, resonances: OMNI }, armor: { hp: 10, resonances: OMNI }, structure: { hp: 10, resonances: OMNI } };
    const result = applyLayeredDamage(tiny, { em: 100, thermal: 0, kinetic: 0, explosive: 0 });
    expect(result.taken).toEqual({ shield: 10, armor: 10, structure: 10 });
    expect(result.structure).toBe(0);
    expect(result.total).toBe(30);
    const broken = applyLayeredDamage({ ...RIFTER, shield: { ...RIFTER.shield, hp: 0 }, armor: { ...RIFTER.armor, hp: 0 } }, { em: 10, thermal: 0, kinetic: 0, explosive: 0 });
    expect(broken.taken).toMatchObject({ shield: 0, armor: 0 });
    expect(broken.taken.structure).toBeCloseTo(6.7, 12);
  });

  it('never changes its input', () => {
    const before = structuredClone(RIFTER);
    applyLayeredDamage(RIFTER, { em: 5000, thermal: 5000, kinetic: 5000, explosive: 5000 });
    expect(RIFTER).toEqual(before);
  });
});

describe('passiveRecharge', () => {
  const TAU = 468.75;
  const rate = (s: number) => (10 / TAU) * (Math.sqrt(Math.max(0, s)) - s);

  it("follows EVE's recharge curve (RK4 at 0.01 s steps)", () => {
    let s = 0.1;
    const step = 0.01;
    for (let index = 0; index < 6000; index += 1) {
      const k1 = rate(s);
      const k2 = rate(s + (step / 2) * k1);
      const k3 = rate(s + (step / 2) * k2);
      const k4 = rate(s + step * k3);
      s += (step / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    expect(passiveRecharge({ fraction: 0.1, seconds: 60, rechargeTime: TAU })).toBeCloseTo(s, 6);
  });

  it('peaks at 25 % at 2.5 × Smax / τ, from empty', () => {
    const peak = (TAU * Math.LN2) / 5;
    const at = (t: number) => passiveRecharge({ fraction: 0, seconds: t, rechargeTime: TAU });
    const slope = (t: number) => (at(t + 1e-3) - at(t - 1e-3)) / 2e-3;
    expect(at(peak)).toBeCloseTo(0.25, 12);
    expect(slope(peak)).toBeCloseTo(2.5 / TAU, 8);
    expect(slope(peak - 20)).toBeLessThan(slope(peak));
    expect(slope(peak + 20)).toBeLessThan(slope(peak));
    // A Rifter's shield: 3 HP/s at its peak.
    expect((562.5 * 2.5) / TAU).toBe(3);
  });

  it('holds still for no time, stays full, and clamps', () => {
    expect(passiveRecharge({ fraction: 0.4, seconds: 0, rechargeTime: TAU })).toBe(0.4);
    expect(passiveRecharge({ fraction: 1, seconds: 100, rechargeTime: TAU })).toBe(1);
    expect(passiveRecharge({ fraction: 1.2, seconds: 0, rechargeTime: TAU })).toBe(1);
    expect(passiveRecharge({ fraction: 0.5, seconds: 10, rechargeTime: 0 })).toBe(0.5);
  });
});
