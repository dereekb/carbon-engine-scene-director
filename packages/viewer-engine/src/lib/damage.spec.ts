import type { ShipDefense } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DamageModel, type HpSetRecord, ImpactsHealed } from './damage';
import { RoundTrip } from './state-capture.spec-helper';

const RESONANCES = { em: 0.4, thermal: 0.65, kinetic: 0.75, explosive: 0.9 };

function Defense(armor: number, thermal = 0.65): ShipDefense {
  const layer = (hp: number, resonances = RESONANCES) => ({ hp, resonances, resists: { em: 0, thermal: 0, kinetic: 0, explosive: 0 }, ehp: hp });
  return { shield: layer(500), armor: layer(armor, { ...RESONANCES, thermal }), structure: layer(400), ehp: 0, shieldRecharge: 468.75 };
}

describe('DamageModel', () => {
  it('starts at max HP, keeps the fraction when max changes, and repairs up to max', () => {
    const model = new DamageModel();
    model.SetDefense('fc', Defense(1000));
    expect(model.Report('fc')?.armor).toEqual({ hp: 1000, max: 1000, resists: { em: 60, thermal: 35, kinetic: 25, explosive: 10 }, ehp: 1481 });
    expect(model.Damage('fc', 'armor', 600)).toBe(600);
    model.SetDefense('fc', Defense(2000, 0.325));
    expect(model.Report('fc')?.armor).toMatchObject({ hp: 800, max: 2000, resists: { thermal: 67.5 } });
    expect(model.Repair('fc', 'armor', 500)).toBe(500);
    expect(model.Repair('fc', 'armor', 5000)).toBe(700);
    expect(model.Report('fc')?.armor.hp).toBe(2000);
    expect(model.Damage('fc', 'shield', 9999)).toBe(500);
    expect(model.Report('fc')?.shield.hp).toBe(0);
  });

  it('gives the remaining HP fractions the impact overlay shows', () => {
    const model = new DamageModel();
    expect(model.Fractions('fc')).toBeNull();
    model.SetDefense('fc', Defense(1000));
    expect(model.Fractions('fc')).toEqual({ shield: 1, armor: 1, structure: 1 });
    model.Damage('fc', 'shield', 500);
    model.Damage('fc', 'armor', 250);
    expect(model.Fractions('fc')).toEqual({ shield: 0, armor: 0.75, structure: 1 });
  });

  it("gives each layer's HP and max for auto-repair, null for an untracked ship", () => {
    const model = new DamageModel();
    expect(model.Health('fc')).toBeNull();
    model.SetDefense('fc', Defense(1000));
    model.Damage('fc', 'armor', 250);
    expect(model.Health('fc')).toEqual({ shield: { hp: 500, max: 500 }, armor: { hp: 750, max: 1000 }, structure: { hp: 400, max: 400 } });
  });

  it('reports repairs and incoming remote reps, and forgets a removed ship', () => {
    const model = new DamageModel();
    model.SetDefense('fc', Defense(1000));
    model.SetRepairs('fc', { shield: 0, armor: 12.345, structure: 0 });
    model.SetIncoming('fc', [{ from: 'logi', module: 'high-0', layer: 'armor', amount: 360.04, cycleTime: 5, effectiveness: 0.87654 }]);
    expect(model.Report('fc')).toMatchObject({ repairs: { armor: 12.35 }, incoming: [{ from: 'logi', amount: 360, effectiveness: 0.877 }], shieldRecharge: 468.75 });
    model.Remove('fc');
    expect(model.Has('fc')).toBe(false);
    expect(model.Report('fc')).toBeNull();
    expect(model.Repair('fc', 'armor', 10)).toBe(0);
    model.SetDefense('fc', Defense(1000));
    model.Damage('fc', 'armor', 300);
    model.Clear();
    model.SetDefense('fc', Defense(1000));
    expect(model.Report('fc')?.armor.hp).toBe(1000);
  });

  it('applies hits shield first, spilling the unabsorbed share into armor and structure, to destruction', () => {
    const model = new DamageModel();
    model.SetDefense('rifter', Defense(600));
    const em = (amount: number) => ({ em: amount, thermal: 0, kinetic: 0, explosive: 0 });
    expect(model.ApplyHit('rifter', em(1000))).toEqual({ taken: { shield: 400, armor: 0, structure: 0 }, total: 400, structure: 400 });
    expect(model.ApplyHit('rifter', em(1000))).toEqual({ taken: { shield: 100, armor: 300, structure: 0 }, total: 400, structure: 400 });
    expect(model.Destroyed('rifter')).toBe(false);
    const last = model.ApplyHit('rifter', em(2000));
    expect(last?.taken.armor).toBeCloseTo(300, 9);
    expect(last?.structure).toBe(0);
    expect(model.Destroyed('rifter')).toBe(true);
    expect(model.ApplyHit('nobody', em(10))).toBeNull();
    expect(model.Destroyed('nobody')).toBe(false);
  });

  it("recharges shields passively on EVE's curve, peaking at 25 %", () => {
    const model = new DamageModel();
    model.SetDefense('rifter', Defense(600));
    model.SetDefense('full', Defense(600));
    model.Damage('rifter', 'shield', 375);
    expect(model.Recharge(1)).toEqual(['rifter']);
    expect(model.Report('rifter')?.shield.hp).toBeCloseTo(125 + (2.5 * 500) / 468.75, 1);
    model.Damage('rifter', 'structure', 400);
    const before = model.Report('rifter')?.shield.hp;
    expect(model.Recharge(10)).toEqual([]);
    expect(model.Report('rifter')?.shield.hp).toBe(before);
  });
});

function Rifter(): ShipDefense {
  const layer = (hp: number) => ({ hp, resonances: RESONANCES, resists: { em: 0, thermal: 0, kinetic: 0, explosive: 0 }, ehp: hp });
  return { shield: layer(562.5), armor: layer(562.5), structure: layer(437.5), ehp: 0, shieldRecharge: 468.75 };
}

const RECORD: HpSetRecord = { tick: 4, appliedAt: 4, intent: 'cinematic', values: { shield: '0%', armor: 200 }, hp: { shield: 0, armor: 200 } };

describe('DamageModel immunity', () => {
  const em = (amount: number) => ({ em: amount, thermal: 0, kinetic: 0, explosive: 0 });

  it('indexes immune layers apart from the HP entries; SetImmunity replaces the index', () => {
    const model = new DamageModel();
    expect(model.Immunity('r')).toEqual([]);
    model.SetImmunity(new Map([['r', ['structure'] as const]]));
    expect(model.Immunity('r')).toEqual(['structure']);
    model.SetDefense('r', Defense(600));
    model.Remove('r');
    model.Clear();
    expect(model.Immunity('r')).toEqual(['structure']);
    model.SetImmunity(new Map([['x', ['shield', 'armor', 'structure'] as const]]));
    expect(model.Immunity('r')).toEqual([]);
    expect(model.Immunity('x')).toEqual(['shield', 'armor', 'structure']);
  });

  it('absorbs a hit at an immune layer that has HP, leaving HP unchanged', () => {
    const model = new DamageModel();
    model.SetDefense('r', Defense(600));
    model.SetImmunity(new Map([['r', ['shield', 'armor', 'structure'] as const]]));
    expect(model.ApplyHit('r', em(1000))).toEqual({ taken: { shield: 0, armor: 0, structure: 0 }, total: 0, structure: 400, absorbed: 400, absorbedBy: 'shield' });
    expect(model.Fractions('r')).toEqual({ shield: 1, armor: 1, structure: 1 });
    model.SetImmunity(new Map([['r', ['armor'] as const]]));
    const hit = model.ApplyHit('r', em(2000));
    expect(hit).toMatchObject({ taken: { shield: 500, armor: 0, structure: 0 }, total: 500, absorbedBy: 'armor' });
    expect(hit?.absorbed).toBeCloseTo(300, 9);
    expect(model.Damage('r', 'armor', 100)).toBe(0);
    expect(model.Damage('r', 'structure', 100)).toBe(100);
    model.SetImmunity(new Map());
    expect(model.ApplyHit('r', em(100))).toEqual({ taken: { shield: 0, armor: 40, structure: 0 }, total: 40, structure: 300 });
  });

  it('is never Destroyed at 0 structure while structure is immune, and is once the index lifts it', () => {
    const model = new DamageModel();
    model.SetDefense('r', Defense(600));
    model.SetImmunity(new Map([['r', ['structure'] as const]]));
    model.SetHp('r', { shield: 0, armor: 0, structure: 0 }, RECORD);
    expect(model.Destroyed('r')).toBe(false);
    expect(model.DestroyedShips()).toEqual([]);
    expect(model.Damage('r', 'structure', 10)).toBe(0);
    model.SetImmunity(new Map());
    expect(model.Destroyed('r')).toBe(true);
    expect(model.DestroyedShips()).toEqual(['r']);
  });

  it('lets the drains through to structure, then stops them there', () => {
    const model = new DamageModel();
    model.SetDefense('r', Defense(600));
    model.SetImmunity(new Map([['r', ['structure'] as const]]));
    for (let i = 0; i < 10; i++) model.ApplyHit('r', em(2000));
    expect(model.Fractions('r')).toEqual({ shield: 0, armor: 0, structure: 1 });
    expect(model.Destroyed('r')).toBe(false);
  });
});

describe('DamageModel set_hp', () => {
  it('sets HP clamped to [0, max] and Health reads it back', () => {
    const model = new DamageModel();
    expect(model.SetHp('r', { shield: 0, armor: 200, structure: 437.5 }, RECORD)).toBe(false);
    model.SetDefense('r', Rifter());
    expect(model.SetHp('r', { shield: -5, armor: 200, structure: 9999 }, RECORD)).toBe(true);
    expect(model.Health('r')).toEqual({ shield: { hp: 0, max: 562.5 }, armor: { hp: 200, max: 562.5 }, structure: { hp: 437.5, max: 437.5 } });
    expect(model.HpSet('r')).toEqual(RECORD);
    expect(model.HpSet('other')).toBeNull();
  });

  it('keeps the record and the set fraction across SetDefense; Remove and Clear drop it', () => {
    const model = new DamageModel();
    model.SetDefense('r', Rifter());
    model.SetHp('r', { shield: 562.5, armor: 281.25, structure: 437.5 }, RECORD);
    const plated = Rifter();
    model.SetDefense('r', { ...plated, armor: { ...plated.armor, hp: 1125 } });
    expect(model.Health('r')?.armor).toEqual({ hp: 562.5, max: 1125 });
    expect(model.HpSet('r')).toEqual(RECORD);
    model.Remove('r');
    model.SetDefense('r', Rifter());
    expect(model.HpSet('r')).toBeNull();
    model.SetHp('r', { shield: 1, armor: 1, structure: 1 }, RECORD);
    model.Clear();
    expect(model.HpSet('r')).toBeNull();
  });

  it('recharges a set shield of 0 on the curve, the same in steps or at once', () => {
    const stepped = new DamageModel();
    const once = new DamageModel();
    for (const model of [stepped, once]) {
      model.SetDefense('r', Rifter());
      model.SetHp('r', { shield: 0, armor: 562.5, structure: 437.5 }, RECORD);
    }
    for (let second = 0; second < 10; second += 1) stepped.Recharge(1);
    once.Recharge(10);
    const expected = 562.5 * (1 - Math.exp(-50 / 468.75)) ** 2;
    expect(expected).toBeCloseTo(5.758, 3);
    expect(stepped.Health('r')?.shield.hp).toBeCloseTo(expected, 6);
    expect(once.Health('r')?.shield.hp).toBeCloseTo(expected, 6);
  });

  it('repairs a set armor; lists the ships at 0 structure, sorted, and does not recharge them', () => {
    const model = new DamageModel();
    for (const id of ['c', 'a', 'b']) model.SetDefense(id, Rifter());
    model.SetHp('a', { shield: 0, armor: 100, structure: 437.5 }, RECORD);
    expect(model.Repair('a', 'armor', 50)).toBe(50);
    expect(model.Health('a')?.armor.hp).toBe(150);
    model.SetHp('c', { shield: 0, armor: 0, structure: 0 }, RECORD);
    model.SetHp('b', { shield: 0, armor: 0, structure: 0 }, RECORD);
    model.SetHp('a', { shield: 0, armor: 0, structure: 1 }, RECORD);
    expect(model.DestroyedShips()).toEqual(['b', 'c']);
    expect(model.Recharge(10)).toEqual(['a']);
    expect(model.Health('b')?.shield.hp).toBe(0);
  });

  it('restores the record from a snapshot', () => {
    const model = new DamageModel();
    model.SetDefense('r', Rifter());
    model.SetHp('r', { shield: 0, armor: 200, structure: 437.5 }, RECORD);
    const trip = RoundTrip(
      model,
      (m) => [m.Health('r'), m.HpSet('r')],
      (m) => m.SetHp('r', { shield: 1, armor: 1, structure: 1 }, { ...RECORD, tick: 9, appliedAt: 9 })
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
  });
});

describe('DamageModel snapshots (sd-time)', () => {
  it('restores HP, repairs and incoming reps', () => {
    const model = new DamageModel();
    model.SetDefense('fc', Defense(1000));
    model.SetDefense('logi', Defense(800));
    model.Damage('fc', 'shield', 500);
    model.Damage('fc', 'armor', 250);
    model.SetRepairs('fc', { shield: 0, armor: 12.345, structure: 0 });
    model.SetIncoming('fc', [{ from: 'logi', module: 'high-0', layer: 'armor', amount: 360, cycleTime: 5, effectiveness: 0.9 }]);
    const trip = RoundTrip(
      model,
      (m) => [m.Report('fc'), m.Report('logi'), m.Fractions('fc')],
      (m) => {
        m.Damage('fc', 'armor', 700);
        m.Recharge(30);
        m.SetIncoming('fc', []);
        m.Remove('logi');
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
  });
});

describe('ImpactsHealed', () => {
  it('is true only when armor or structure rose across a jump', () => {
    const at = (shield: number, armor: number, structure: number) => ({ shield, armor, structure });
    expect(ImpactsHealed(at(0, 0, 0.4), at(0.8, 1, 1))).toBe(true);
    expect(ImpactsHealed(at(0, 0.2, 1), at(0, 0.5, 1))).toBe(true);
    expect(ImpactsHealed(at(0, 0, 0), null)).toBe(true);
    expect(ImpactsHealed(at(0.1, 1, 1), at(0.9, 1, 1))).toBe(false);
    expect(ImpactsHealed(at(1, 0.6, 1), at(1, 0.3, 0.9))).toBe(false);
    expect(ImpactsHealed(null, at(1, 1, 1))).toBe(false);
    expect(ImpactsHealed(null, null)).toBe(false);
  });
});
