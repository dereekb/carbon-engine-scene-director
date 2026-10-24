import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../json';
import { isFilteredSelector, readShipSelector, type ShipSelector } from './selector';

function read(record: JsonObject, where = 'set_immunity'): { selector: ShipSelector; problems: string[] } {
  const problems: string[] = [];
  const selector = readShipSelector(record, where, problems);
  return { selector, problems };
}

const MISSING_SCOPE = 'set_immunity needs exactly one of ships (ship ids), fleet (a fleet id, optionally with wing or squad) and all (every ship in the scene)';

describe('readShipSelector', () => {
  it('reads the old scopes as readFleetSelection does', () => {
    expect(read({ ships: ['a', 'b'] })).toEqual({ selector: { ships: ['a', 'b'] }, problems: [] });
    expect(read({ fleet: 'f' })).toEqual({ selector: { fleet: 'f' }, problems: [] });
    expect(read({ fleet: 'f', wing: 'w' })).toEqual({ selector: { fleet: 'f', wing: 'w' }, problems: [] });
    expect(read({ fleet: 'f', squad: 's' })).toEqual({ selector: { fleet: 'f', squad: 's' }, problems: [] });
  });

  it('takes all: true as the whole scene, and refuses it with another scope or another value', () => {
    expect(read({ all: true })).toEqual({ selector: { all: true }, problems: [] });
    expect(read({ all: false }).problems).toEqual(['set_immunity.all must be true (every ship in the scene); give ships or fleet to select fewer']);
    expect(read({ all: 'yes' }).problems).toEqual(['set_immunity.all must be true (every ship in the scene); give ships or fleet to select fewer']);
    expect(read({ all: true, ships: ['a'] }).problems).toEqual([MISSING_SCOPE]);
    expect(read({ all: true, fleet: 'f' }).problems).toEqual([MISSING_SCOPE]);
    expect(read({ all: true, squad: 's' }).problems).toEqual(['set_immunity: wing and squad select within a fleet; give fleet too']);
  });

  it('refuses no scope and two scopes, so a filter alone never means everything', () => {
    expect(read({ role: 'dps' })).toEqual({ selector: {}, problems: [MISSING_SCOPE] });
    expect(read({}).problems).toEqual([MISSING_SCOPE]);
    expect(read({ ships: ['a'], fleet: 'f' }).problems).toEqual([MISSING_SCOPE]);
  });

  it('reads each filter as a list, normalized', () => {
    expect(read({ all: true, role: 'LOGI' }).selector).toEqual({ all: true, role: ['logi'] });
    expect(read({ all: true, role: ['dps', 'Tackle', 'dps'] }).selector.role).toEqual(['dps', 'tackle']);
    expect(read({ all: true, team: [' red ', 'Red', 'blue'] }).selector.team).toEqual(['red', 'blue']);
    expect(read({ all: true, hull: 'Rifter' }).selector.hull).toEqual(['Rifter']);
    expect(read({ all: true, hull: 587 }).selector.hull).toEqual([587]);
    expect(read({ all: true, hull: ['Rifter', 'frigate', 587, 'rifter'] }).selector.hull).toEqual(['Rifter', 'frigate', 587]);
    expect(read({ all: true, state: ['alive', 'IN-WARP'] }).selector.state).toEqual(['alive', 'in-warp']);
  });

  it('reads a sample as a count, a percent or an object', () => {
    expect(read({ all: true, sample: 5 }).selector.sample).toEqual({ count: 5 });
    expect(read({ all: true, sample: '30%' }).selector.sample).toEqual({ percent: 30 });
    expect(read({ all: true, sample: ' 30 % ' }).selector.sample).toEqual({ percent: 30 });
    expect(read({ all: true, sample: '12.5%' }).selector.sample).toEqual({ percent: 12.5 });
    expect(read({ all: true, sample: { count: 2, seed: 7 } }).selector.sample).toEqual({ count: 2, seed: 7 });
    expect(read({ all: true, sample: { percent: 100 } }).selector.sample).toEqual({ percent: 100 });
  });

  it('reports every malformed filter together', () => {
    const { selector, problems } = read({ fleet: 'f', role: 'healer', state: ['alive', 'dead'], team: '', hull: [0, -1, {}, ''] });
    expect(selector).toEqual({});
    expect(problems).toEqual([
      'set_immunity.role "healer" is not a squad role (dps, logi, tackle, ewar, boost, support)',
      'set_immunity.team must be a team name or a non-empty list of them',
      'set_immunity.hull must be an EVE type name, a type id or a ship group name, or a non-empty list of them',
      'set_immunity.state "dead" is not a ship state (alive, destroyed, damaged, undamaged, in-warp, on-grid)'
    ]);
    expect(read({ all: true, team: 3 }).problems).toEqual(['set_immunity.team must be a team name or a non-empty list of them']);
    expect(read({ all: true, hull: [] }).problems).toEqual(['set_immunity.hull must be an EVE type name, a type id or a ship group name, or a non-empty list of them']);
  });

  it('pins each sample problem', () => {
    const shape = 'set_immunity.sample must be a count (an integer from 1), a percent ("30%") or { count | percent, seed? }';
    const range = 'set_immunity.sample.percent must be above 0 and at most 100';
    const cases: [unknown, string[]][] = [
      [0, [shape]],
      [1.5, [shape]],
      ['0%', [range]],
      ['130%', [range]],
      ['half', [shape]],
      [true, [shape]],
      [{ count: 2, percent: 50 }, ['set_immunity.sample needs exactly one of count and percent']],
      [{}, ['set_immunity.sample needs exactly one of count and percent']],
      [{ count: 0 }, ['set_immunity.sample.count must be an integer from 1']],
      [{ percent: 0 }, [range]],
      [{ count: 2, seed: -1 }, ['set_immunity.sample.seed must be an integer from 0 to 4294967295']],
      [{ count: 2, x: 1 }, ['set_immunity.sample.x is not a sample field (count, percent, seed)']]
    ];
    for (const [sample, problems] of cases) expect(read({ all: true, sample }).problems, JSON.stringify(sample)).toEqual(problems);
  });

  it('is stable: reading its own output changes nothing', () => {
    const { selector } = read({ fleet: 'f', squad: 's', role: 'Logi', team: 'blue', hull: ['Guardian', 11987], state: 'alive', sample: '50%' });
    expect(read(selector as JsonObject)).toEqual({ selector, problems: [] });
    const all = read({ all: true, sample: { count: 3, seed: 9 } }).selector;
    expect(read(all as JsonObject).selector).toEqual(all);
  });
});

describe('isFilteredSelector', () => {
  it('is false for the old selections and true for all or any filter', () => {
    expect(isFilteredSelector({ ships: ['a'] })).toBe(false);
    expect(isFilteredSelector({ fleet: 'f', squad: 's' })).toBe(false);
    expect(isFilteredSelector({ all: true })).toBe(true);
    expect(isFilteredSelector({ fleet: 'f', role: ['logi'] })).toBe(true);
    expect(isFilteredSelector({ ships: ['a'], state: ['alive'] })).toBe(true);
    expect(isFilteredSelector({ ships: ['a'], sample: { count: 1 } })).toBe(true);
  });
});
