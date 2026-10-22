import { describe, expect, it } from 'vitest';
import { makeFleetScene, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { type FleetSelection, readFleetSelection, selectFleetShips } from './selection';

const WINGED = makeFleetScene(
  ['wc', 'a', 'fc', 'b', 'c', 'loner'],
  [
    {
      id: 'f',
      commander: 'fc',
      wings: [
        { id: 'w1', commander: 'wc', squads: [{ id: 's1', role: 'dps', members: ['a', 'b'] }] },
        {
          id: 'w2',
          squads: [
            { id: 's2', role: 'logi', members: ['c', 'b'] },
            { id: 'empty', role: 'dps', members: [] }
          ]
        }
      ]
    }
  ]
);

function select(selection: FleetSelection, scene: Record<string, unknown> = WINGED) {
  return selectFleetShips(scene, selection);
}

describe('selectFleetShips', () => {
  it('a fleet is its FC, its wing commanders and its squad members, in document order', () => {
    expect(select({ fleet: 'tfi' }, TFI_FLEET_SCENE)).toEqual({ ships: ['fc', 'tfi-1', 'tfi-2', 'tfi-3', 'guardian-1', 'guardian-2'], problems: [] });
    expect(select({ fleet: 'f' }).ships).toEqual(['wc', 'a', 'fc', 'b', 'c']);
  });

  it('a wing is its commander and its squads; a squad is its members', () => {
    expect(select({ fleet: 'f', wing: 'w1' }).ships).toEqual(['wc', 'a', 'b']);
    expect(select({ fleet: 'f', wing: 'w2' }).ships).toEqual(['b', 'c']);
    expect(select({ fleet: 'f', squad: 's2' }).ships).toEqual(['b', 'c']);
    expect(select({ fleet: 'tfi', squad: 'logi' }, TFI_FLEET_SCENE).ships).toEqual(['guardian-1', 'guardian-2']);
    expect(select({ fleet: 'f', squad: 'empty' })).toEqual({ ships: [], problems: [] });
  });

  it('ships are deduplicated and kept in document order', () => {
    expect(select({ ships: ['c', 'a', 'c'] })).toEqual({ ships: ['a', 'c'], problems: [] });
  });

  it('names every unknown ship, fleet, wing and squad', () => {
    expect(select({ ships: ['a', 'ghost'] })).toEqual({ ships: ['a'], problems: ['selection: no ship "ghost"'] });
    expect(select({ fleet: 'nope' }).problems).toEqual(['selection: no fleet "nope"']);
    expect(select({ fleet: 'f', wing: 'w9' }).problems).toEqual(['selection: no wing "w9" in fleet "f"']);
    expect(selectFleetShips(WINGED, { fleet: 'f', squad: 's9' }, 'operations[0]').problems).toEqual(['operations[0]: no squad "s9" in fleet "f"']);
  });

  it('tolerates a draft mid-patch', () => {
    const draft = { ships: [{ id: 'fc' }, 3, { id: 'x' }, { name: 'no id' }], fleets: [null, { id: 'f', commander: 'fc', wings: [{ id: 'w', squads: [{ id: 's', members: 'x' }, 'junk'] }, 7] }] };
    expect(selectFleetShips(draft, { fleet: 'f' })).toEqual({ ships: ['fc'], problems: [] });
    expect(selectFleetShips({}, { ships: ['x'] }).problems).toEqual(['selection: no ship "x"']);
  });
});

describe('readFleetSelection', () => {
  it('reads ships, or a fleet narrowed by a wing or a squad', () => {
    const problems: string[] = [];
    expect(readFleetSelection({ ships: ['a', 'b'] }, 'switch', problems)).toEqual({ ships: ['a', 'b'] });
    expect(readFleetSelection({ fleet: 'f' }, 'switch', problems)).toEqual({ fleet: 'f' });
    expect(readFleetSelection({ fleet: 'f', wing: 'w' }, 'switch', problems)).toEqual({ fleet: 'f', wing: 'w' });
    expect(readFleetSelection({ fleet: 'f', squad: 's' }, 'switch', problems)).toEqual({ fleet: 'f', squad: 's' });
    expect(problems).toEqual([]);
  });

  it('needs exactly one of ships and fleet, and wing or squad only within a fleet', () => {
    const read = (record: Record<string, unknown>) => {
      const problems: string[] = [];
      return { selection: readFleetSelection(record, 'switch', problems), problems };
    };
    const both = 'switch needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)';
    expect(read({})).toEqual({ selection: {}, problems: [both] });
    expect(read({ ships: ['a'], fleet: 'f' }).problems).toEqual([both]);
    expect(read({ ships: [] }).problems).toEqual(['switch.ships must be a non-empty array of ship ids']);
    expect(read({ ships: ['bad id'] }).problems).toEqual(['switch.ships must be a non-empty array of ship ids']);
    expect(read({ ships: ['a'], wing: 'w' }).problems).toEqual(['switch: wing and squad select within a fleet; give fleet too']);
    expect(read({ fleet: 'f', wing: 'w', squad: 's' }).problems).toEqual(['switch: give wing or squad, not both']);
    expect(read({ fleet: 3 }).problems).toEqual(['switch.fleet must be an id (1-64 letters, digits, "_", "-" or ".")']);
  });
});
