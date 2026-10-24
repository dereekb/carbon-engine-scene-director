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
    applyLayeredDamage(RIFTER, { em: 5000, thermal: 5000, kinetic: 5000, explosive: 5000 }, ['armor', 'structure']);
    expect(RIFTER).toEqual(before);
  });
});

describe('applyLayeredDamage with immune layers', () => {
  const EVEN: DamageLayers = { shield: { hp: 100, resonances: OMNI }, armor: { hp: 100, resonances: OMNI }, structure: { hp: 100, resonances: OMNI } };
  const HIT = { em: 150, thermal: 0, kinetic: 0, explosive: 0 };
  const round = (value: number): number => Math.round(value * 1e9) / 1e9;
  const run = (immune: readonly ('shield' | 'armor' | 'structure')[], layers: DamageLayers = EVEN) => {
    const result = applyLayeredDamage(layers, HIT, immune);
    const taken = { shield: round(result.taken.shield), armor: round(result.taken.armor), structure: round(result.taken.structure) };
    return { taken, left: [result.layers.shield.hp, result.layers.armor.hp, result.layers.structure.hp].map(round), absorbed: round(result.absorbed ?? 0), by: result.absorbedBy };
  };

  it("follows the plan's worked table on three 100 HP layers and a 150 HP hit", () => {
    expect(run([])).toEqual({ taken: { shield: 100, armor: 50, structure: 0 }, left: [0, 50, 100], absorbed: 0, by: undefined });
    expect(run(['structure'])).toEqual({ taken: { shield: 100, armor: 50, structure: 0 }, left: [0, 50, 100], absorbed: 0, by: undefined });
    expect(run(['armor'])).toEqual({ taken: { shield: 100, armor: 0, structure: 0 }, left: [0, 100, 100], absorbed: 50, by: 'armor' });
    expect(run(['shield', 'armor', 'structure'])).toEqual({ taken: { shield: 0, armor: 0, structure: 0 }, left: [100, 100, 100], absorbed: 150, by: 'shield' });
    expect(run(['shield'])).toEqual({ taken: { shield: 0, armor: 0, structure: 0 }, left: [100, 100, 100], absorbed: 150, by: 'shield' });
    const noShield: DamageLayers = { ...EVEN, shield: { ...EVEN.shield, hp: 0 } };
    expect(run(['shield'], noShield)).toEqual({ taken: { shield: 0, armor: 100, structure: 50 }, left: [0, 0, 50], absorbed: 0, by: undefined });
    expect(run(['shield', 'structure'], noShield)).toEqual({ taken: { shield: 0, armor: 100, structure: 0 }, left: [0, 0, 100], absorbed: 50, by: 'structure' });
  });

  it('every layer immune at full: the shield absorbs the effective damage, nothing is taken', () => {
    const damage = { em: 50, thermal: 0, kinetic: 100, explosive: 0 };
    const result = applyLayeredDamage(RIFTER, damage, ['shield', 'armor', 'structure']);
    expect(result.taken).toEqual({ shield: 0, armor: 0, structure: 0 });
    expect(result.total).toBe(0);
    expect(result.layers).toEqual(RIFTER);
    expect(result.absorbed).toBe(110);
    expect(result.absorbedBy).toBe('shield');
  });

  it('armor and structure immune, shield at 30 HP: the shield empties, armor absorbs the rest at its resonances', () => {
    const layers: DamageLayers = { ...RIFTER, shield: { ...RIFTER.shield, hp: 30 } };
    const damage = { em: 60, thermal: 0, kinetic: 100, explosive: 0 };
    const result = applyLayeredDamage(layers, damage, ['armor', 'structure']);
    // The shield takes 60 + 60 = 120 against its 30 HP: it absorbs 1/4 of the raw damage, 3/4 reaches the armor.
    expect(result.taken).toEqual({ shield: 30, armor: 0, structure: 0 });
    expect(result.absorbed).toBeCloseTo(60 * 0.75 * 0.4 + 100 * 0.75 * 0.75, 9);
    expect(result.absorbedBy).toBe('armor');
    expect(result.layers.armor).toEqual(RIFTER.armor);
    expect(result.layers.structure).toEqual(RIFTER.structure);
  });

  it('structure immune: shield and armor drain, the spill into structure is absorbed', () => {
    const result = applyLayeredDamage(RIFTER, { em: 5000, thermal: 5000, kinetic: 5000, explosive: 5000 }, ['structure']);
    expect(result.taken).toMatchObject({ shield: 562.5, armor: 562.5, structure: 0 });
    expect(result.structure).toBe(437.5);
    expect(result.absorbedBy).toBe('structure');
    expect(result.absorbed).toBeGreaterThan(0);
  });

  it('no immunity is exactly the old result, with no absorbed key', () => {
    const damage = { em: 300, thermal: 400, kinetic: 0, explosive: 200 };
    const plain = applyLayeredDamage(RIFTER, damage);
    expect(applyLayeredDamage(RIFTER, damage, [])).toEqual(plain);
    expect('absorbed' in plain).toBe(false);
    expect('absorbedBy' in plain).toBe(false);
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
