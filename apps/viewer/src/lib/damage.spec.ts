import type { ShipDefense } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DamageModel } from './damage';

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
});
