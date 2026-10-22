import { describe, expect, it } from 'vitest';
import type { SceneShip } from '../scene';
import { apply, catchSceneError, GUARDIAN, makeMiniComposition, scene, TFI } from './staging.spec-helper';

const FEROX = 'bc1_t1:caldaribase:caldari';
const SCIMITAR = 'cl2_t2:minmatarbase:minmatar';

function byId(ships: readonly SceneShip[], id: string): SceneShip {
  const ship = ships.find((candidate) => candidate.id === id);
  if (!ship) throw new Error(`no ship ${id}`);
  return ship;
}

describe('stage_engagement', () => {
  it('stages two compositions with their fronts range apart, on their own teams', () => {
    const { scene: after } = apply(scene(), { op: 'stage_engagement', sides: [{ composition: makeMiniComposition() }, { composition: makeMiniComposition() }], center: [1000, 0, 0] });
    expect(after.fleets?.map((fleet) => fleet.id)).toEqual(['mini', 'mini-2']);
    const a = byId(after.ships, 'mini-fc');
    const b = byId(after.ships, 'mini-2-fc');
    expect(a).toMatchObject({ team: 'blue', rotation: [0, 0, 0] });
    expect(b).toMatchObject({ team: 'red', rotation: [180, 0, 0] });
    expect(Math.abs(b.position[2] - 250 - (a.position[2] + 250) - 20000)).toBeLessThanOrEqual(2);
    expect(a.position[0]).toBe(1000);
    expect((a.position[2] + b.position[2]) / 2).toBeCloseTo(0, 0);
  });

  it('makes a ship list a fleet: the first ship the FC, each line a squad', () => {
    const { scene: after } = apply(scene(), {
      op: 'stage_engagement',
      sides: [
        { composition: makeMiniComposition() },
        {
          ships: [
            { hull: 'Ferox', dna: FEROX, radius: 215, count: 8 },
            { hull: 'Scimitar', dna: SCIMITAR, radius: 134, count: 2, role: 'logi' }
          ]
        }
      ]
    });
    const red = after.fleets?.find((fleet) => fleet.id === 'red');
    expect(red?.commander).toBe('red-fc');
    expect(red?.wings[0].squads.map((squad) => [squad.id, squad.members.length, squad.anchor?.ship])).toEqual([
      ['dps', 7, undefined],
      ['logi', 2, 'red-logi-01']
    ]);
    const gap = byId(after.ships, 'red-fc').position[2] - byId(after.ships, 'mini-fc').position[2];
    expect(Math.abs(gap - 20465)).toBeLessThanOrEqual(2);
  });

  it('makes free sides in formations with team prefixes', () => {
    const { scene: after } = apply(scene(), {
      op: 'stage_engagement',
      range: 0,
      heading: 90,
      sides: [
        { ships: [{ dna: TFI, radius: 250, count: 3 }], fleet: false, formation: 'line' },
        { ships: [{ dna: GUARDIAN, radius: 80, count: 4 }], fleet: false, formation: 'wall', team: 'green' }
      ]
    });
    expect(after.ships.map((ship) => ship.id)).toEqual(['blue-01', 'blue-02', 'blue-03', 'green-01', 'green-02', 'green-03', 'green-04']);
    expect(after.fleets ?? []).toEqual([]);
    expect(byId(after.ships, 'blue-01').position).toEqual([-250, 0, 0]);
    expect(byId(after.ships, 'green-01').position).toEqual([80, 0, 0]);
    expect(byId(after.ships, 'blue-02').position[0]).toBe(-250);
  });

  it('centres on a near ship with the tangent heading', () => {
    const before = scene({ ships: [{ id: 'station', dna: TFI }] });
    const { scene: after } = apply(before, { op: 'stage_engagement', near: { ship: 'station', range: 30000, direction: 'right' }, sides: [{ composition: makeMiniComposition() }, { composition: makeMiniComposition() }] });
    const a = byId(after.ships, 'mini-fc');
    expect(a.rotation[0]).toBe(180);
    expect(Math.round((a.position[0] + byId(after.ships, 'mini-2-fc').position[0]) / 2)).toBe(30000);
  });

  it('refuses malformed engagements', () => {
    const problems = (operation: Record<string, unknown>) => catchSceneError(() => apply(scene(), { op: 'stage_engagement', ...operation })).problems.join('\n');
    const side = { composition: makeMiniComposition() };
    expect(problems({ sides: [side, { ...side, team: 'blue' }] })).toMatch(/both sides are on team "blue"/u);
    expect(problems({ sides: [side] })).toMatch(/must be two sides/u);
    expect(problems({ sides: [side, side, side] })).toMatch(/must be two sides/u);
    expect(problems({ sides: [side, { ...side, ships: [{ dna: TFI }] }] })).toMatch(/give composition or ships, not both/u);
    expect(problems({ sides: [side, { ...side, fleet: false }] })).toMatch(/a composition always makes a fleet/u);
    expect(problems({ sides: [side, { ships: [{ dna: TFI }], formation: 'line' }] })).toMatch(/formation needs fleet: false/u);
    expect(problems({ sides: [side, { ships: [{ hull: 'Ferox' }] }] })).toMatch(/hull "Ferox" has no dna. The stage_engagement tool/u);
    expect(problems({ sides: [side, { composition: 'tfis' }] })).toMatch(/resolves composition names/u);
    expect(problems({ sides: [side, side], range: -1 })).toMatch(/range must be/u);
  });
});
