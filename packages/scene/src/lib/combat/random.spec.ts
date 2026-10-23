import { describe, expect, it } from 'vitest';
import { type CombatRollKey, combatHash, combatPick, combatRoll, combatShuffle } from './random';

const KEY: CombatRollKey = { ship: 'rifter', module: 'high-0', activation: 1, cycle: 3, target: 'punisher' };

describe('combatRoll', () => {
  it('gives the same key the same roll, in [0, 1)', () => {
    const roll = combatRoll(1, KEY);
    expect(combatRoll(1, { ...KEY })).toBe(roll);
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(1);
    expect(Number.isSafeInteger(combatHash('anything'))).toBe(true);
  });

  it('changes with any field', () => {
    const roll = combatRoll(1, KEY);
    const changed = [combatRoll(2, KEY), combatRoll(1, { ...KEY, ship: 'rifter-2' }), combatRoll(1, { ...KEY, module: 'high-1' }), combatRoll(1, { ...KEY, activation: 2 }), combatRoll(1, { ...KEY, cycle: 4 }), combatRoll(1, { ...KEY, target: 'punisher-2' })];
    for (const other of changed) expect(other).not.toBe(roll);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('is uniform over 100,000 keys: mean 0.5 and each decile 10 %', () => {
    const deciles = new Array<number>(10).fill(0);
    let sum = 0;
    const count = 100_000;
    for (let index = 0; index < count; index += 1) {
      const roll = combatRoll(7, { ship: `ship-${index % 97}`, module: `high-${index % 7}`, activation: 1 + (index % 3), cycle: index, target: 'target' });
      sum += roll;
      deciles[Math.floor(roll * 10)] += 1;
    }
    expect(Math.abs(sum / count - 0.5)).toBeLessThan(0.005);
    for (const decile of deciles) expect(Math.abs(decile / count - 0.1)).toBeLessThan(0.005);
  });

  it('does not depend on the order rolls are asked for', () => {
    const keys = Array.from({ length: 20 }, (_, cycle) => ({ ...KEY, cycle }));
    const forward = keys.map((key) => combatRoll(3, key));
    const backward = [...keys].reverse().map((key) => combatRoll(3, key));
    expect(backward.reverse()).toEqual(forward);
  });
});

describe('combatPick and combatShuffle', () => {
  it('pick deterministically within range', () => {
    for (let index = 0; index < 200; index += 1) {
      const pick = combatPick(1, `explosion|ship-${index}`, 3);
      expect(pick).toBe(combatPick(1, `explosion|ship-${index}`, 3));
      expect([0, 1, 2]).toContain(pick);
    }
    const picks = new Set(Array.from({ length: 200 }, (_, index) => combatPick(1, `explosion|ship-${index}`, 3)));
    expect(picks.size).toBe(3);
    expect(combatPick(1, 'x', 0)).toBe(0);
    expect(combatPick(1, 'x', 1)).toBe(0);
  });

  it('shuffle deterministically, keeping every item', () => {
    const items = Array.from({ length: 18 }, (_, index) => index);
    const shuffled = combatShuffle(1, 'blasts|rifter', items);
    expect(combatShuffle(1, 'blasts|rifter', items)).toEqual(shuffled);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(shuffled).not.toEqual(items);
    expect(combatShuffle(2, 'blasts|rifter', items)).not.toEqual(shuffled);
    expect(items).toEqual(Array.from({ length: 18 }, (_, index) => index));
  });
});
