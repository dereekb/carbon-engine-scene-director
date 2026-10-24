import { describe, expect, it } from 'vitest';
import { SceneError } from '../scene';
import { distributionQuantile } from './distributions';
import { drainTotalHp, hpSetHasRandom, hpSetRoll, normalizeHpSetCommand, readHpAmount, resolveHpSet } from './hp-set';

const RIFTER = { shield: { hp: 562.5, max: 562.5 }, armor: { hp: 562.5, max: 562.5 }, structure: { hp: 437.5, max: 437.5 } };
const DAMAGED = { shield: { hp: 100, max: 562.5 }, armor: { hp: 300, max: 562.5 }, structure: { hp: 400, max: 437.5 } };

function problemsOf(input: unknown): string[] {
  let problems: string[] = [];
  try {
    normalizeHpSetCommand(input);
  } catch (error) {
    if (!(error instanceof SceneError)) throw error;
    problems = [...error.problems];
  }
  return problems;
}

function resolve(values: Readonly<Record<string, unknown>>, layers = RIFTER, ship = 'r1', seed = 1) {
  const command = normalizeHpSetCommand({ ships: [ship], ...values });
  return resolveHpSet({ layers, command, ship, seed });
}

describe('normalizeHpSetCommand', () => {
  it('accepts HP, percents and ranges per layer, with the defaults', () => {
    const command = normalizeHpSetCommand({ ships: ['r1'], shield: '0%', armor: 300, structure: { min: '40%', max: '80%' } });
    expect(command).toEqual({ ships: ['r1'], shield: '0%', armor: 300, structure: { min: '40%', max: '80%', distribution: 'uniform' }, intent: 'cinematic' });
    expect(hpSetHasRandom(command)).toBe(true);
    expect(hpSetHasRandom(normalizeHpSetCommand({ ships: ['r1'], armor: 1 }))).toBe(false);
  });

  it('accepts every distribution, a total, a seed and a fleet squad', () => {
    expect(normalizeHpSetCommand({ ships: ['r1'], armor: { min: 10, max: 90, distribution: 'normal', mean: 70, sd: 5 } }).armor).toEqual({ min: 10, max: 90, distribution: 'normal', mean: 70, sd: 5 });
    expect(normalizeHpSetCommand({ ships: ['r1'], armor: { min: '0%', max: '100%', distribution: 'triangular', mode: '80%' } }).armor).toEqual({ min: '0%', max: '100%', distribution: 'triangular', mode: '80%' });
    expect(normalizeHpSetCommand({ ships: ['r1'], total: 1000 }).total).toBe(1000);
    expect(normalizeHpSetCommand({ ships: ['r1'], total: '40%' }).total).toBe('40%');
    expect(normalizeHpSetCommand({ ships: ['r1'], total: { min: '10%', max: '30%' } }).total).toEqual({ min: '10%', max: '30%', distribution: 'uniform' });
    const command = normalizeHpSetCommand({ fleet: 'f', squad: 'dps-a', armor: '50%', intent: 'gameplay', seed: 7 });
    expect(command).toEqual({ fleet: 'f', squad: 'dps-a', armor: '50%', intent: 'gameplay', seed: 7 });
  });

  it('trims a percent and normalizes to the same thing twice', () => {
    expect(normalizeHpSetCommand({ ships: ['r1'], armor: ' 40.50 % ' }).armor).toBe('40.5%');
    const once = normalizeHpSetCommand({ ships: ['r1'], shield: '0 %', structure: { min: '10 %', max: '90%', distribution: 'normal' } });
    expect(normalizeHpSetCommand(once)).toEqual(once);
    expect(readHpAmount('40.5%')).toEqual({ unit: 'percent', value: 40.5 });
    expect(readHpAmount(12)).toEqual({ unit: 'hp', value: 12 });
  });

  it('reports bad amounts', () => {
    expect(problemsOf({ ships: ['r1'] })).toEqual(['set_hp needs shield, armor, structure or total']);
    expect(problemsOf({ ships: ['r1'], total: 10, armor: 0 })).toEqual(['set_hp: give total, or shield / armor / structure, not both']);
    expect(problemsOf({ ships: ['r1'], armor: '120%' })).toEqual(['set_hp.armor "120%": percentages run from 0% to 100%']);
    expect(problemsOf({ ships: ['r1'], armor: '-5%' })).toEqual(['set_hp.armor "-5%": percentages run from 0% to 100%']);
    expect(problemsOf({ ships: ['r1'], armor: -1 })).toEqual(['set_hp.armor must be a finite number of HP, 0 or more']);
    expect(problemsOf({ ships: ['r1'], armor: Number.NaN })).toEqual(['set_hp.armor must be a finite number of HP, 0 or more']);
    expect(problemsOf({ ships: ['r1'], armor: Number.POSITIVE_INFINITY })).toEqual(['set_hp.armor must be a finite number of HP, 0 or more']);
    expect(problemsOf({ ships: ['r1'], armor: 'abc' })).toEqual(['set_hp.armor "abc" is not a percent ("40%")']);
    expect(problemsOf({ ships: ['r1'], armor: true })[0]).toMatch(/^set_hp.armor must be HP/);
  });

  it('reports bad ranges', () => {
    expect(problemsOf({ ships: ['r1'], armor: { min: 80, max: 10 } })).toEqual(['set_hp.armor: min is above max']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: '80%' } })).toEqual(['set_hp.armor: min, max, mean, sd and mode use one unit: all HP or all percent']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, distribution: 'normal', mean: 90 } })).toEqual(['set_hp.armor.mean must be within min and max']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, distribution: 'triangular', mode: 5 } })).toEqual(['set_hp.armor.mode must be within min and max']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, distribution: 'normal', sd: 0 } })).toEqual(['set_hp.armor.sd must be above 0']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, mean: 40 } })).toEqual(['set_hp.armor.mean is for the normal distribution']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, distribution: 'normal', mode: 40 } })).toEqual(['set_hp.armor.mode is for the triangular distribution']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, distribution: 'gaussian' } })).toEqual(['set_hp.armor.distribution must be one of uniform, normal, triangular']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10, max: 80, spread: 3 } })).toEqual(['set_hp.armor.spread is not a range field (min, max, distribution, mean, sd, mode)']);
    expect(problemsOf({ ships: ['r1'], armor: { min: 10 } })).toEqual(['set_hp.armor needs min and max']);
  });

  it('reports bad command fields and selections, all together', () => {
    expect(problemsOf({ ships: ['r1'], armor: 1, intent: 'movie' })).toEqual(['set_hp.intent must be one of cinematic, gameplay']);
    for (const seed of [1.5, -1, 2 ** 32]) expect(problemsOf({ ships: ['r1'], armor: 1, seed })).toEqual(['set_hp.seed must be an integer from 0 to 4294967295']);
    expect(problemsOf({ ships: ['r1'], armor: 1, damage: 3 })).toEqual(['set_hp.damage is not a set_hp field']);
    expect(problemsOf({ ships: ['r1'], hull: 1 })).toEqual(['set_hp.hull is not a set_hp field (the hull layer is structure)', 'set_hp needs shield, armor, structure or total']);
    expect(problemsOf({ armor: 1 })).toEqual(['set_hp needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)']);
    expect(problemsOf({ ships: ['r1'], fleet: 'f', armor: 1 })).toEqual(['set_hp needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)']);
    expect(problemsOf({ ships: ['r1'], wing: 'w', armor: 1 })).toEqual(['set_hp: wing and squad select within a fleet; give fleet too']);
    expect(problemsOf({ ships: ['r1'], armor: '120%', shield: { min: 9, max: 1 }, intent: 'x' })).toHaveLength(3);
    expect(problemsOf('armor')).toHaveLength(1);
  });
});

describe('resolveHpSet', () => {
  it('sets each named layer by percent and HP, leaving the others', () => {
    expect(resolve({ shield: '0%', armor: '50%' }).hp).toEqual({ shield: 0, armor: 281.25, structure: 437.5 });
    const armorOnly = resolve({ armor: 200 }, DAMAGED);
    expect(armorOnly.hp).toEqual({ shield: 100, armor: 200, structure: 400 });
    expect(armorOnly.set).toEqual({ armor: { hp: 200 } });
    expect(armorOnly.clamped).toEqual([]);
  });

  it('sets HP above a max to the max, with a note', () => {
    const result = resolve({ armor: 900 });
    expect(result.hp.armor).toBe(562.5);
    expect(result.clamped).toEqual(['armor 900 HP is above its max 562.5: set to 562.5']);
    const range = resolve({ armor: { min: 600, max: 800 } });
    expect(range.hp.armor).toBe(562.5);
    expect(range.clamped).toEqual(['armor range 600–800 HP is above its max 562.5: drawn up to 562.5']);
  });

  it('drains a total from a full ship, shield first, whatever the HP now', () => {
    for (const layers of [RIFTER, DAMAGED]) {
      const percent = resolve({ total: '40%' }, layers).hp;
      expect(percent.shield).toBeCloseTo(0, 9);
      expect(percent.armor).toBeCloseTo(187.5, 9);
      expect(percent.structure).toBeCloseTo(437.5, 9);
      const hp = resolve({ total: 1000 }, layers).hp;
      expect(hp.shield).toBeCloseTo(0, 9);
      expect(hp.armor).toBeCloseTo(562.5, 9);
      expect(hp.structure).toBeCloseTo(437.5, 9);
    }
    expect(drainTotalHp({ shield: 562.5, armor: 562.5, structure: 437.5 }, 1562.5)).toEqual({ shield: 562.5, armor: 562.5, structure: 437.5 });
    expect(resolve({ total: 5000 }).clamped).toEqual(['total 5000 HP is above its max 1562.5: set to 1562.5']);
  });

  it('holds 1 HP of structure for a cinematic set; a gameplay set at 0 destroys', () => {
    const total = resolve({ total: 0 });
    expect(total.hp).toEqual({ shield: 0, armor: 0, structure: 1 });
    expect(total.clamped).toEqual(['structure held at 1 HP: a cinematic set never kills']);
    expect(total.destroys).toBe(false);
    expect(resolve({ structure: 0 }).hp.structure).toBe(1);
    expect(resolve({ shield: 0 }, DAMAGED).clamped).toEqual([]);
    expect(resolve({ structure: 0, intent: 'gameplay' }).destroys).toBe(true);
    expect(resolve({ total: 0, intent: 'gameplay' }).destroys).toBe(true);
    const sliver = resolve({ structure: '0.01%', intent: 'gameplay' });
    expect(sliver.hp.structure).toBeCloseTo(0.04375, 9);
    expect(sliver.destroys).toBe(false);
  });

  it('draws a range from the keyed roll', () => {
    const result = resolve({ armor: { min: '10%', max: '90%', distribution: 'normal' } }, RIFTER, 'r1', 3);
    const roll = hpSetRoll(3, 'r1', 'armor');
    expect(result.set.armor?.roll).toBe(roll);
    expect(result.hp.armor).toBe(distributionQuantile('normal', roll, { min: 56.25, max: 506.25 }));
    const total = resolve({ total: { min: '10%', max: '30%' } }, RIFTER, 'r1', 3);
    expect(total.set.total?.roll).toBe(hpSetRoll(3, 'r1', 'total'));
  });
});

describe('the keyed draws', () => {
  const RANGE = { armor: { min: '10%', max: '90%' } };

  it('give the same (seed, ship, target) the same HP, and change with each', () => {
    const base = resolve(RANGE, RIFTER, 'r1', 1).hp.armor;
    expect(resolve(RANGE, RIFTER, 'r1', 1).hp.armor).toBe(base);
    expect(resolve(RANGE, RIFTER, 'r1', 2).hp.armor).not.toBe(base);
    expect(resolve(RANGE, RIFTER, 'r2', 1).hp.armor).not.toBe(base);
    expect(resolve({ shield: { min: '10%', max: '90%' } }, RIFTER, 'r1', 1).hp.shield).not.toBe(base);
  });

  it('do not depend on the order ships are resolved in', () => {
    const ships = Array.from({ length: 12 }, (_, index) => `ship-${index}`);
    const forward = new Map(ships.map((ship) => [ship, resolve(RANGE, RIFTER, ship, 5).hp.armor]));
    const backward = new Map([...ships].reverse().map((ship) => [ship, resolve(RANGE, RIFTER, ship, 5).hp.armor]));
    for (const ship of ships) expect(backward.get(ship)).toBe(forward.get(ship));
    expect(new Set(forward.values()).size).toBe(ships.length);
  });
});
