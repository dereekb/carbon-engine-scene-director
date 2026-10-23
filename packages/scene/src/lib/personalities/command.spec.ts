import { describe, expect, it } from 'vitest';
import { commandFleet, personality } from './personalities.spec-helper';
import { toFcDelayTicks, toFleetSuccessor, toHandoverTicks } from './succession';
import { drawFleetTrait, toFleetBackups, toFleetPilotTraits } from './traits';

describe('pilot traits', () => {
  it('draws a trait from a range, or takes a number as is', () => {
    expect(drawFleetTrait(0.4, 0.9)).toBe(0.4);
    expect(drawFleetTrait([0.2, 0.6], 0)).toBe(0.2);
    expect(drawFleetTrait([0.2, 0.6], 0.5)).toBeCloseTo(0.4);
  });

  it('picks backups: wing commanders, squad commanders, boost members, then seeded members', () => {
    const fleet = commandFleet();
    expect(toFleetBackups(fleet, 4, 7)).toEqual(['wc', 's1c', 'b1', 'b2']);
    const five = toFleetBackups(fleet, 5, 7);
    expect(five.slice(0, 4)).toEqual(['wc', 's1c', 'b1', 'b2']);
    expect(['m1', 'm2', 'm3', 'm4']).toContain(five[4]);
    expect(toFleetBackups(fleet, 5, 7)).toEqual(five);
    expect(toFleetBackups(fleet, 0, 7)).toEqual([]);
    expect(toFleetBackups(fleet, 20, 7)).toHaveLength(8);
    expect(toFleetBackups(fleet, 20, 7)).not.toContain('fc');
  });

  it('draws command for the FC and backups and reaction for everyone; authored traits win', () => {
    const fleet = commandFleet();
    const brawler = personality('brawler');
    const traits = toFleetPilotTraits({ fleet, personality: brawler, seed: 1, pilotOf: (ship) => (ship === 'm1' ? { command: 0.95, reaction: 0.2 } : ship === 'm2' ? { reaction: 1 } : null) });
    expect([...traits.keys()]).toEqual(['fc', 'wc', 's1c', 'm1', 'm2', 'm3', 'm4', 'b1', 'b2']);
    const [lo, hi] = brawler.command.ability as [number, number];
    for (const ship of ['fc', 'wc', 's1c']) {
      expect(traits.get(ship)?.command).toBeGreaterThanOrEqual(lo);
      expect(traits.get(ship)?.command).toBeLessThanOrEqual(hi);
      expect(traits.get(ship)?.source).toBe('personality');
    }
    expect(traits.get('b1')?.command).toBeUndefined();
    expect(traits.get('m1')).toEqual({ command: 0.95, reaction: 0.2, source: 'pilot' });
    expect(traits.get('m2')).toEqual({ reaction: 1, source: 'pilot' });
    expect(traits.get('m3')?.source).toBe('personality');
    const again = toFleetPilotTraits({ fleet, personality: brawler, seed: 1, pilotOf: (ship) => (ship === 'm1' ? { command: 0.95, reaction: 0.2 } : ship === 'm2' ? { reaction: 1 } : null) });
    expect(again).toEqual(traits);
    const reseeded = toFleetPilotTraits({ fleet, personality: brawler, seed: 2, pilotOf: () => null });
    expect(reseeded.get('m3')?.reaction).not.toBe(traits.get('m3')?.reaction);
  });

  it('marks a pilot with one authored trait and one drawn as mixed', () => {
    const traits = toFleetPilotTraits({ fleet: commandFleet(), personality: personality('line'), seed: 3, pilotOf: (ship) => (ship === 'fc' ? { reaction: 0.5 } : null) });
    expect(traits.get('fc')?.source).toBe('mixed');
  });
});

describe('succession', () => {
  const fleet = commandFleet();
  const abilities: Record<string, number> = { fc: 0.9, wc: 0.4, s1c: 0.7, m3: 0.7 };
  const abilityOf = (ship: string) => abilities[ship] ?? null;

  it('most-able takes the highest ability, ties in fleet order', () => {
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc']), steps: ['most-able', 'chain', 'anyone'], abilityOf })).toEqual({ ship: 's1c', step: 'most-able', ability: 0.7 });
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc', 's1c']), steps: ['most-able'], abilityOf })).toEqual({ ship: 'm3', step: 'most-able', ability: 0.7 });
  });

  it('falls through the steps, and a successor that is not FC-capable has ability 0', () => {
    const none = () => null;
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc']), steps: ['most-able', 'chain', 'anyone'], abilityOf: none })).toEqual({ ship: 'wc', step: 'chain', ability: 0 });
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc', 'wc', 's1c']), steps: ['most-able', 'chain', 'anyone'], abilityOf: none })).toEqual({ ship: 'm1', step: 'anyone', ability: 0 });
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc', 'wc']), steps: ['chain'], abilityOf })).toEqual({ ship: 's1c', step: 'chain', ability: 0.7 });
  });

  it('is leaderless when no step finds a live member', () => {
    const all = new Set(['fc', 'wc', 's1c', 'm1', 'm2', 'm3', 'm4', 'b1', 'b2']);
    expect(toFleetSuccessor({ fleet, gone: all, steps: ['most-able', 'chain', 'anyone'], abilityOf })).toBeNull();
    expect(toFleetSuccessor({ fleet, gone: new Set(['fc']), steps: ['most-able'], abilityOf: () => null })).toBeNull();
  });

  it('hands over by ability: 2 s at ability 1, half to all of the handover at 0', () => {
    expect(toHandoverTicks({ ability: 1, handover: 30, unit: 0.99 })).toBe(2);
    expect(toHandoverTicks({ ability: 0, handover: 30, unit: 0 })).toBe(16);
    expect(toHandoverTicks({ ability: 0, handover: 30, unit: 0.999999 })).toBe(30);
    expect(toHandoverTicks({ ability: 0.5, handover: 90, unit: 0.5 })).toBe(Math.ceil(2 + 0.5 * 88 * 0.75));
    expect(toHandoverTicks({ ability: 0.2, handover: 30, unit: 0.3 })).toBeGreaterThan(toHandoverTicks({ ability: 0.8, handover: 30, unit: 0.3 }));
  });

  it('delays an FC decision by ability: none at 1, 5-10 s at 0', () => {
    expect(toFcDelayTicks(1, 0.7)).toBe(0);
    expect(toFcDelayTicks(0, 0)).toBe(5);
    expect(toFcDelayTicks(0, 0.999999)).toBe(10);
    expect(toFcDelayTicks(0.6, 0.5)).toBe(3);
  });
});
