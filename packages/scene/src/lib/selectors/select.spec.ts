import { describe, expect, it } from 'vitest';
import { DEFENSE_LAYERS, type DefenseLayerName } from '../fitting/defense';
import { sampleShips, type SelectShipsOptions, selectShips, type ShipHullFact, type ShipLiveFact, type ShipSelectionFacts, shipSelectionReport } from './select';
import type { ShipSelector } from './selector';

const ORDER = ['bfc', 'p1', 'p2', 'g1', 'g2', 't1', 'r1', 'r2', 'e1', 'x1', 'y1'];
const TEAMS: Record<string, string> = { bfc: 'blue', p1: 'blue', p2: 'blue', g1: 'blue', g2: 'blue', t1: 'blue', r1: 'red', r2: 'red', e1: 'red', x1: 'RED' };

function sceneOf(order: readonly string[] = ORDER, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ships: order.map((id) => ({ id, dna: 'frig:faction:race', ...(TEAMS[id] ? { team: TEAMS[id] } : {}) })),
    fleets: [
      {
        id: 'b',
        commander: 'bfc',
        wings: [
          {
            id: 'w1',
            squads: [
              { id: 'dps', role: 'dps', members: ['p1', 'p2'] },
              { id: 'logi', role: 'logi', members: ['g1', 'g2'] },
              { id: 'tackle', role: 'tackle', members: ['t1'] },
              { id: 'empty', role: 'dps', members: [] }
            ]
          }
        ]
      },
      {
        id: 'r',
        wings: [
          {
            id: 'rw',
            squads: [
              { id: 'rdps', role: 'dps', members: ['r1', 'r2'] },
              { id: 'ewar', role: 'ewar', members: ['e1'] }
            ]
          }
        ]
      }
    ],
    ...extra
  };
}

const SCENE = sceneOf();
const PUNISHER: ShipHullFact = { typeID: 597, name: 'Punisher', group: 'Frigate' };
const GUARDIAN: ShipHullFact = { typeID: 11987, name: 'Guardian', group: 'Logistics Cruiser' };
const RIFTER: ShipHullFact = { typeID: 587, name: 'Rifter', group: 'Frigate' };
const HULLS: Record<string, ShipHullFact | null | undefined> = { bfc: PUNISHER, p1: PUNISHER, p2: PUNISHER, g1: GUARDIAN, g2: GUARDIAN, t1: RIFTER, r1: RIFTER, r2: RIFTER, e1: undefined, x1: RIFTER, y1: null };
const FULL: Record<DefenseLayerName, number> = { shield: 1, armor: 1, structure: 1 };
const STATES: Record<string, Partial<ShipLiveFact>> = { r2: { destroyed: true }, t1: { inWarp: true }, x1: { inWarp: true }, p1: { fractions: { ...FULL, shield: 0.5 } }, p2: { fractions: { ...FULL, shield: 0.9991 } }, g2: { fractions: null } };
const FACTS: ShipSelectionFacts = {
  hullOf: (id) => HULLS[id],
  stateOf: (id) => ({ destroyed: false, inWarp: false, fractions: FULL, ...STATES[id] })
};

function pick(selector: ShipSelector, options: SelectShipsOptions = { facts: FACTS }, scene: Record<string, unknown> = SCENE): string[] {
  const result = selectShips(scene, selector, options);
  expect(result.problems).toEqual([]);
  return result.ships;
}

describe('selectShips: scopes', () => {
  it('selects ships (deduplicated, in document order), a fleet, a wing, a squad and the whole scene', () => {
    expect(pick({ ships: ['x1', 'p1', 'x1'] })).toEqual(['p1', 'x1']);
    expect(pick({ fleet: 'b' })).toEqual(['bfc', 'p1', 'p2', 'g1', 'g2', 't1']);
    expect(pick({ fleet: 'b', wing: 'w1' })).toEqual(['p1', 'p2', 'g1', 'g2', 't1']);
    expect(pick({ fleet: 'b', squad: 'logi' })).toEqual(['g1', 'g2']);
    expect(pick({ all: true })).toEqual(ORDER);
  });

  it('names unknown ships, fleets, wings and squads, and selects nothing then', () => {
    expect(selectShips(SCENE, { ships: ['p1', 'ghost'] })).toMatchObject({ ships: [], problems: ['selection: no ship "ghost"'] });
    expect(selectShips(SCENE, { fleet: 'nope' }).problems).toEqual(['selection: no fleet "nope"']);
    expect(selectShips(SCENE, { fleet: 'b', wing: 'w9' }).problems).toEqual(['selection: no wing "w9" in fleet "b"']);
    expect(selectShips(SCENE, { fleet: 'b', squad: 's9' }, { where: 'operations[0]' }).problems).toEqual(['operations[0]: no squad "s9" in fleet "b"']);
  });

  it('an empty squad, or filters that keep nothing, select nothing without a problem', () => {
    expect(selectShips(SCENE, { fleet: 'b', squad: 'empty' })).toMatchObject({ ships: [], problems: [], scoped: 0 });
    const none = selectShips(SCENE, { all: true, team: ['red'], role: ['logi'] });
    expect(none).toMatchObject({ ships: [], problems: [], warnings: [], scoped: 11, excluded: { role: 9, team: 2 } });
  });
});

describe('selectShips: filters', () => {
  it('role reads the squads: an FC in no squad and free ships have none', () => {
    expect(pick({ fleet: 'b', role: ['dps'] })).toEqual(['p1', 'p2']);
    expect(pick({ all: true, role: ['logi'] })).toEqual(['g1', 'g2']);
    expect(pick({ all: true, role: ['dps', 'tackle'] })).toEqual(['p1', 'p2', 't1', 'r1', 'r2']);
  });

  it('team is case-insensitive, and a ship with no team never matches', () => {
    expect(pick({ all: true, team: ['red'] })).toEqual(['r1', 'r2', 'e1', 'x1']);
    expect(pick({ all: true, team: ['Blue', 'RED'] })).toEqual(ORDER.filter((id) => id !== 'y1'));
  });

  it('hull matches a type name, a type id, a numeric string or a ship group', () => {
    expect(pick({ all: true, hull: ['punisher'] })).toEqual(['bfc', 'p1', 'p2']);
    expect(pick({ all: true, hull: [587] })).toEqual(['t1', 'r1', 'r2', 'x1']);
    expect(pick({ all: true, hull: ['11987'] })).toEqual(['g1', 'g2']);
    expect(pick({ all: true, hull: ['Frigate'] })).toEqual(['bfc', 'p1', 'p2', 't1', 'r1', 'r2', 'x1']);
    expect(pick({ all: true, hull: ['Guardian', 'Rifter'] })).toEqual(['g1', 'g2', 't1', 'r1', 'r2', 'x1']);
  });

  it('a pending hull is left out, listed and warned about; a ship with no EVE type matches nothing', () => {
    const result = selectShips(SCENE, { fleet: 'r', hull: ['Rifter'] }, { facts: FACTS });
    expect(result.ships).toEqual(['r1', 'r2']);
    expect(result.unresolved).toEqual([{ id: 'e1', why: 'its EVE type is still loading' }]);
    expect(result.warnings).toEqual(['1 ship was left out: its EVE type is still loading ("e1"); call again once it has loaded']);
    expect(result.excluded).toEqual({ hull: 1 });
    expect(pick({ ships: ['y1'], hull: ['Frigate'] })).toEqual([]);
  });

  it('a ship an earlier filter removed is never unresolved', () => {
    const result = selectShips(SCENE, { all: true, team: ['blue'], hull: ['Punisher'] }, { facts: FACTS });
    expect(result.unresolved).toEqual([]);
    expect(result.ships).toEqual(['bfc', 'p1', 'p2']);
  });

  it('state: each value', () => {
    const alive = ORDER.filter((id) => id !== 'r2');
    expect(pick({ all: true, state: ['alive'] })).toEqual(alive);
    expect(pick({ all: true, state: ['destroyed'] })).toEqual(['r2']);
    expect(pick({ all: true, state: ['damaged'] })).toEqual(['p1']);
    expect(pick({ all: true, state: ['undamaged'] })).toEqual(alive.filter((id) => id !== 'p1'));
    expect(pick({ all: true, state: ['in-warp'] })).toEqual(['t1', 'x1']);
    expect(pick({ all: true, state: ['on-grid'] })).toEqual(alive.filter((id) => id !== 't1' && id !== 'x1'));
    expect(pick({ all: true, state: ['destroyed', 'in-warp'] })).toEqual(['t1', 'r2', 'x1']);
  });

  it('a destroyed ship is neither damaged, undamaged, in warp nor on grid', () => {
    for (const state of ['damaged', 'undamaged', 'in-warp', 'on-grid'] as const) expect(pick({ ships: ['r2'], state: [state] }), state).toEqual([]);
  });
});

describe('selectShips: combinations', () => {
  it('ANDs across keys and ORs within a list', () => {
    expect(pick({ fleet: 'b', role: ['logi'], state: ['alive'] })).toEqual(['g1', 'g2']);
    expect(pick({ all: true, team: ['red'], hull: ['Frigate'] })).toEqual(['r1', 'r2', 'x1']);
    expect(pick({ all: true, team: ['red'], hull: ['Frigate'], state: ['alive'] })).toEqual(['r1', 'x1']);
    expect(pick({ ships: ['p1', 'p2', 'r2'], state: ['alive'] })).toEqual(['p1', 'p2']);
  });

  it('counts what each step removed', () => {
    const result = selectShips(SCENE, { all: true, team: ['red'], hull: ['Frigate'], state: ['alive'] }, { facts: FACTS });
    expect(result).toMatchObject({ scope: 'all', scoped: 11, excluded: { team: 7, hull: 1, state: 1 }, unresolved: [{ id: 'e1' }] });
  });
});

describe('selectShips: sample', () => {
  it('keeps a count, a rounded percent with at least one, and all of a smaller set', () => {
    expect(pick({ all: true, sample: { count: 3 } })).toHaveLength(3);
    expect(pick({ all: true, sample: { percent: 30 } })).toHaveLength(3);
    expect(pick({ fleet: 'b', squad: 'logi', sample: { percent: 10 } })).toHaveLength(1);
    expect(pick({ fleet: 'b', squad: 'logi', sample: { count: 5 } })).toEqual(['g1', 'g2']);
    expect(pick({ fleet: 'b', squad: 'empty', sample: { percent: 50 } })).toEqual([]);
  });

  it('rolls on the document combat seed unless the sample or the caller gives one', () => {
    const ids = ORDER;
    expect(pick({ all: true, sample: { count: 4 } })).toEqual(sampleShips(ids, { count: 4 }, 1));
    expect(pick({ all: true, sample: { count: 4 } }, {}, sceneOf(ORDER, { combat: { seed: 42 } }))).toEqual(sampleShips(ids, { count: 4 }, 42));
    expect(pick({ all: true, sample: { count: 4, seed: 7 } }, {}, sceneOf(ORDER, { combat: { seed: 42 } }))).toEqual(sampleShips(ids, { count: 4 }, 7));
    expect(pick({ all: true, sample: { count: 4 } }, { seed: 9 })).toEqual(sampleShips(ids, { count: 4 }, 9));
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((seed) => sampleShips(ids, { count: 4 }, seed).join()));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('keeps the same ships whatever order the scene lists them in, and nests', () => {
    const reversed = sceneOf([...ORDER].reverse());
    const forward = pick({ all: true, sample: { count: 5, seed: 3 } }, {});
    const backward = pick({ all: true, sample: { count: 5, seed: 3 } }, {}, reversed);
    expect([...backward].sort()).toEqual([...forward].sort());
    const two = pick({ all: true, sample: { count: 2, seed: 3 } }, {});
    const three = pick({ all: true, sample: { count: 3, seed: 3 } }, {});
    expect(two.every((id) => three.includes(id))).toBe(true);
  });

  it('runs last, and reports what it kept', () => {
    const result = selectShips(SCENE, { all: true, team: ['red'], sample: { count: 2, seed: 5 } });
    expect(result.ships).toHaveLength(2);
    expect(result.ships.every((id) => ['r1', 'r2', 'e1', 'x1'].includes(id))).toBe(true);
    expect(result).toMatchObject({ excluded: { team: 7, sample: 2 }, sample: { from: 4, kept: 2, seed: 5 } });
  });
});

describe('selectShips: warnings and refusals', () => {
  it('warns about a role, team or hull entry that matches nothing in the scope, naming what it holds', () => {
    expect(selectShips(SCENE, { fleet: 'b', team: ['rde'] }).warnings).toEqual(['selection.team "rde" matches no ship in fleet "b" (teams there: blue)']);
    expect(selectShips(SCENE, { fleet: 'r', role: ['logi'] }).warnings).toEqual(['selection.role "logi" matches no ship in fleet "r" (roles there: dps, ewar)']);
    expect(selectShips(SCENE, { ships: ['y1'], team: ['red'] }).warnings).toEqual(['selection.team "red" matches no ship in the listed ships (no teams there)']);
    expect(selectShips(SCENE, { all: true, hull: ['Rfter'] }, { facts: FACTS }).warnings).toEqual([
      'selection.hull "Rfter" matches no ship in the scene (hulls there: Punisher, Guardian, Rifter; groups: Frigate, Logistics Cruiser)',
      '1 ship was left out: its EVE type is still loading ("e1"); call again once it has loaded'
    ]);
  });

  it('without facts, hull and state are problems naming the live tool; role, team and sample still work', () => {
    expect(selectShips(SCENE, { all: true, hull: ['Rifter'] }).problems).toEqual(["selection.hull reads the live scene (each ship's EVE type): only a live tool resolves them"]);
    expect(selectShips(SCENE, { all: true, hull: ['Rifter'], state: ['alive'] }, { where: 'operations[0]', liveHint: 'use the set_immunity tool, which resolves them in the viewer' }).problems).toEqual([
      "operations[0].hull and .state read the live scene (each ship's EVE type and state): use the set_immunity tool, which resolves them in the viewer"
    ]);
    expect(selectShips(SCENE, { all: true, state: ['alive'] }).ships).toEqual([]);
    expect(pick({ all: true, team: ['red'], role: ['dps'], sample: { count: 1 } }, {})).toHaveLength(1);
  });

  it('tolerates a draft mid-patch', () => {
    const draft = { ships: [{ id: 'a', team: 'red' }, 3, { name: 'no id' }, { id: 'b', team: 7 }], fleets: [null, { id: 'f', wings: [{ id: 'w', squads: [{ id: 's', role: 'logi', members: 'a' }, { id: 't', role: 9, members: ['b'] }, 'junk'] }, 7] }] };
    expect(selectShips(draft, { all: true })).toMatchObject({ ships: ['a', 'b'], problems: [] });
    expect(selectShips(draft, { all: true, team: ['red'] }).ships).toEqual(['a']);
    expect(selectShips(draft, { all: true, role: ['logi'] }).ships).toEqual([]);
    expect(selectShips({}, { all: true }).ships).toEqual([]);
  });
});

describe('shipSelectionReport', () => {
  it('keeps the counts, and only the parts that say something', () => {
    expect(shipSelectionReport(selectShips(SCENE, { fleet: 'b' }))).toEqual({ scope: 'fleet "b"', scoped: 6, matched: 6 });
    expect(shipSelectionReport(selectShips(SCENE, { fleet: 'b', squad: 'logi' }))).toEqual({ scope: 'fleet "b" squad "logi"', scoped: 2, matched: 2 });
    expect(shipSelectionReport(selectShips(SCENE, { all: true, team: ['red'], hull: ['Frigate'], sample: { count: 1, seed: 2 } }, { facts: FACTS }))).toEqual({
      scope: 'all',
      scoped: 11,
      matched: 1,
      excluded: { team: 7, hull: 1, sample: 2 },
      unresolved: [{ id: 'e1', why: 'its EVE type is still loading' }],
      sample: { from: 3, kept: 1, seed: 2 },
      warnings: ['1 ship was left out: its EVE type is still loading ("e1"); call again once it has loaded']
    });
  });

  it('every layer fraction is read', () => {
    for (const layer of DEFENSE_LAYERS) {
      const facts: ShipSelectionFacts = { hullOf: () => null, stateOf: () => ({ destroyed: false, inWarp: false, fractions: { ...FULL, [layer]: 0.2 } }) };
      expect(selectShips(SCENE, { ships: ['p1'], state: ['damaged'] }, { facts }).ships, layer).toEqual(['p1']);
    }
  });
});
