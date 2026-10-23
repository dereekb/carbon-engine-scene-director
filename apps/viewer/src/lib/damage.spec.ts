import type { ShipDefense } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DamageModel, ImpactsHealed } from './damage';
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
