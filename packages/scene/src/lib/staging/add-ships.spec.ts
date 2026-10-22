import { describe, expect, it } from 'vitest';
import { diffScenes } from '../scene';
import { layoutFleetFormation, toFleetFollowPlans, DEFAULT_FORMATION_RADIUS, type SceneFleet } from '../fleets';
import { apply, catchSceneError, distance, GUARDIAN, minPairDistance, newShips, RIFTER, scene, TFI, TFI_FLEET_SCENE } from './staging.spec-helper';

const RIFTERS = { op: 'add_ships', hull: 'Rifter', dna: RIFTER, radius: 31 };
const TFIS = { op: 'add_ships', hull: 'Tempest Fleet Issue', dna: TFI, radius: 250 };
const ANCHOR_SCENE = { name: 'anchor', ships: [{ id: 'anchor', dna: TFI, type: 'Tempest Fleet Issue' }] };
const FLEET_RADII = { fc: 250, 'tfi-1': 250, 'tfi-2': 250, 'tfi-3': 250, 'guardian-1': 80, 'guardian-2': 80 };

describe('add_ships: free ships', () => {
  it('adds numbered ships of one hull in a formation', () => {
    const before = scene();
    const { scene: after, warnings } = apply(before, { ...RIFTERS, count: 5, formation: 'line', team: 'red', stats: { maxVelocity: 500 }, propMod: { module: 'ab', active: true }, heading: 90 });
    const ships = newShips(before, after);
    expect(ships.map((ship) => ship.id)).toEqual(['rifter-01', 'rifter-02', 'rifter-03', 'rifter-04', 'rifter-05']);
    expect(ships[2]).toMatchObject({ name: 'Rifter 3', type: 'Rifter', team: 'red', dna: RIFTER, rotation: [90, 0, 0], stats: { maxVelocity: 500 }, propMod: { module: 'ab', active: true } });
    expect(ships[0].position).toEqual([0, 0, 0]);
    expect(ships[1].position).toEqual([0, 0, -193]);
    expect(warnings).toEqual([]);
  });

  it('continues numbering across operations in one patch', () => {
    const { scene: after } = apply(scene(), { ...RIFTERS, count: 2 }, { ...RIFTERS, count: 2, position: [0, 0, 50000] });
    expect(after.ships.map((ship) => ship.id)).toEqual(['rifter-01', 'rifter-02', 'rifter-03', 'rifter-04']);
    expect(minPairDistance(after.ships.slice(0, 2).map((ship) => ship.position))).toBeGreaterThanOrEqual(191);
  });

  it('places the lead off a ship, surface to surface, and faces a ship', () => {
    const before = scene(ANCHOR_SCENE);
    const { scene: after } = apply(before, { ...RIFTERS, count: 3, formation: 'wedge', near: { ship: 'anchor', range: 10000 }, facing: 'anchor', radii: { anchor: 250 } });
    const ships = newShips(before, after);
    expect(ships[0].position).toEqual([0, 0, 10281]);
    expect(ships.every((ship) => ship.rotation[0] === 180)).toBe(true);
  });

  it('takes the near ship heading by default', () => {
    const before = scene({ ships: [{ id: 'anchor', dna: TFI, rotation: [90, 0, 0] }] });
    const ships = newShips(before, apply(before, { ...RIFTERS, near: { ship: 'anchor' } }).scene);
    expect(ships[0]).toMatchObject({ position: [5031, 0, 0], rotation: [90, 0, 0] });
  });

  it('warns about overlaps, far placements, missing radii and tight spacing', () => {
    const { warnings } = apply(scene(ANCHOR_SCENE), { ...RIFTERS, count: 2, position: [100, 0, 0], spacing: 50 }, { op: 'add_ships', dna: RIFTER, position: [3e6, 0, 0] });
    expect(warnings.join('\n')).toMatch(/within 500 m of ships already in the scene \(rifter-01 near "anchor"/u);
    expect(warnings.join('\n')).toMatch(/under two radii/u);
    expect(warnings.join('\n')).toMatch(/1 ship is more than 2,000 km from the scene origin; scenes rarely use more than 2,000 km \(the limit is 10,000 km\)/u);
    expect(warnings.join('\n')).toMatch(/no radius for mf4_t1/u);
  });

  it('refuses what the tool resolves, and contradictions', () => {
    const before = scene(ANCHOR_SCENE);
    const problems = (operation: Record<string, unknown>) => catchSceneError(() => apply(before, operation)).problems;
    expect(problems({ op: 'add_ships', hull: 'Rifter' })[0]).toBe('operations[0]: hull "Rifter" has no dna. The add_ships tool resolves hull names to DNA through tools-core; patch_scene needs every ship line\'s dna.');
    expect(problems({ ...RIFTERS, position: [0, 0, 0], near: { ship: 'anchor' } })[0]).toMatch(/position or near, not both/u);
    expect(problems({ ...RIFTERS, heading: 0, facing: 'anchor' })[0]).toMatch(/heading or facing, not both/u);
    expect(problems({ ...RIFTERS, near: { celestial: 'Jita IV' } })[0]).toMatch(/add_ships tool resolves a celestial/u);
    expect(problems({ ...RIFTERS, near: { ship: 'nobody' } })[0]).toMatch(/no ship "nobody"/u);
    expect(problems({ ...RIFTERS, facing: [0, 1000, 0] })[0]).toMatch(/straight above or below/u);
    expect(problems({ ...RIFTERS, position: [2e7, 0, 0] })[0]).toMatch(/is 20,000 km from the scene origin; a scene spans at most 10,000 km/u);
    expect(problems({ ...RIFTERS, near: { ship: 'anchor', object: 'astra' } })[0]).toMatch(/give ship or object, not both/u);
    expect(problems({ ...RIFTERS, near: { object: 'nothing' } })[0]).toMatch(/near.object: no object "nothing"/u);
    expect(problems({ ...RIFTERS, facing: 'nothing' })[0]).toMatch(/no ship or object "nothing"/u);
  });

  it('places off an object on its radius, faces one, and skips object ids', () => {
    const before = scene({
      ...ANCHOR_SCENE,
      objects: [
        { id: 'astra', dna: 'cm1_t1:upwell:generic', position: [0, 0, 100000], rotation: [90, 0, 0], radius: 45000 },
        { id: 'rifter-01', dna: 'wreck_s:genericbase:generic', position: [0, 0, -50000] }
      ]
    });
    const ships = newShips(before, apply(before, { ...RIFTERS, count: 2, near: { object: 'astra', range: 1000 } }, { ...RIFTERS, facing: 'astra' }).scene);
    expect(ships.map((ship) => ship.id)).toEqual(['rifter-02', 'rifter-03', 'rifter-04']);
    expect(ships[0]).toMatchObject({ position: [46031, 0, 100000], rotation: [90, 0, 0] });
    expect(ships[2].rotation[0]).toBe(0);
  });
});

describe('add_ships: a new fleet', () => {
  it('makes the first ship the FC and the rest one squad at their formation slots', () => {
    const before = scene();
    const { scene: after } = apply(before, { ...RIFTERS, count: 4, position: [0, 0, 1000], heading: 30, team: 'red', fleet: { new: true } });
    expect(after.ships.map((ship) => ship.id)).toEqual(['rifter-fc', 'rifter-dps-01', 'rifter-dps-02', 'rifter-dps-03']);
    expect(after.fleets?.[0]).toMatchObject({ id: 'rifter', commander: 'rifter-fc', wings: [{ id: 'wing-1', squads: [{ id: 'dps', role: 'dps' }] }] });
    expect(after.ships[0]).toMatchObject({ name: 'FC', position: [0, 0, 1000], rotation: [30, 0, 0], team: 'red' });
    const fleet = after.fleets?.[0] as SceneFleet;
    const slots = layoutFleetFormation({ fleet, origin: after.ships[0].position, heading: 30, radiusOf: () => 31 });
    expect(toFleetFollowPlans({ fleet, origin: after.ships[0].position, heading: 30, radiusOf: () => 31 }).size).toBe(3);
    for (const ship of after.ships) expect(distance(slots.get(ship.id) ?? [0, 0, 0], ship.position)).toBeLessThanOrEqual(1);
  });

  it('numbers the fleet id when taken, refuses a taken explicit id, and makes an FC-only fleet', () => {
    const first = apply(scene(), { ...RIFTERS, fleet: { new: true } }).scene;
    expect(first.fleets?.[0].wings).toEqual([]);
    const second = apply(first, { ...RIFTERS, count: 2, position: [0, 0, 20000], fleet: { new: true } }).scene;
    expect(second.fleets?.map((fleet) => fleet.id)).toEqual(['rifter', 'rifter-2']);
    expect(catchSceneError(() => apply(first, { ...RIFTERS, fleet: { new: true, id: 'rifter' } })).problems[0]).toMatch(/fleet "rifter" already exists/u);
  });

  it('anchors a logi squad on its lead and refuses a formation', () => {
    const { scene: after } = apply(scene(), { op: 'add_ships', hull: 'Guardian', dna: GUARDIAN, radius: 80, count: 3, fleet: { new: true, squad: { role: 'logi' } } });
    expect(after.fleets?.[0].wings[0].squads[0]).toMatchObject({ id: 'logi', role: 'logi', anchor: { ship: 'guardian-logi-01' } });
    expect(catchSceneError(() => apply(scene(), { ...RIFTERS, formation: 'line', fleet: { new: true } })).problems[0]).toMatch(/formation: a new fleet flies/u);
  });
});

describe('add_ships: joining a fleet', () => {
  const join = (fleet: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...TFIS, count: 2, radii: FLEET_RADII, fleet, ...extra });

  it('seats the ships in a squad at their formation slots', () => {
    const before = scene(TFI_FLEET_SCENE);
    const { scene: after } = apply(before, join({ id: 'tfi', squad: 'dps' }));
    const ships = newShips(before, after);
    expect(ships.map((ship) => ship.id)).toEqual(['tfi-dps-01', 'tfi-dps-02']);
    const fleet = after.fleets?.[0] as SceneFleet;
    expect(fleet.wings[0].squads[0].members).toEqual(['tfi-1', 'tfi-2', 'tfi-3', 'tfi-dps-01', 'tfi-dps-02']);
    const radii = new Map<string, number>([...Object.entries(FLEET_RADII), ['tfi-dps-01', 250], ['tfi-dps-02', 250]]);
    const slots = layoutFleetFormation({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: (id) => radii.get(id) ?? DEFAULT_FORMATION_RADIUS });
    for (const ship of ships) expect(ship.position).toEqual(slots.get(ship.id));
    const diff = diffScenes(before, after);
    expect(diff.added.map((ship) => ship.id)).toEqual(['tfi-dps-01', 'tfi-dps-02']);
    expect(diff.fleets).toBe(true);
  });

  it('warns when a join moves members of later squads, not when joining the last', () => {
    const fleetScene = {
      ships: ['fc', 'a-1', 'a-2', 'b-1', 'b-2'].map((id) => ({ id, dna: TFI })),
      fleets: [
        {
          id: 'f',
          commander: 'fc',
          wings: [
            {
              id: 'w',
              squads: [
                { id: 'a', role: 'dps', members: ['a-1', 'a-2'] },
                { id: 'b', role: 'dps', members: ['b-1', 'b-2'] }
              ]
            }
          ]
        }
      ]
    };
    const radii = { fc: 250, 'a-1': 250, 'a-2': 250, 'b-1': 250, 'b-2': 250 };
    const first = apply(scene(fleetScene), { ...TFIS, count: 2, radii, fleet: { id: 'f', squad: 'a' } }).warnings;
    expect(first.join('\n')).toMatch(/moves 2 existing members of fleet "f" to new formation slots/u);
    expect(apply(scene(fleetScene), { ...TFIS, count: 2, radii, fleet: { id: 'f', squad: 'b' } }).warnings.join('\n')).not.toMatch(/formation slots/u);
  });

  it('refuses placement keys, unknown squads and a full fleet', () => {
    const before = scene(TFI_FLEET_SCENE);
    const problems = (operation: Record<string, unknown>) => catchSceneError(() => apply(before, operation)).problems.join('\n');
    expect(problems(join({ id: 'tfi', squad: 'dps' }, { formation: 'line' }))).toMatch(/formation: ships joining fleet "tfi"/u);
    expect(problems(join({ id: 'tfi', squad: 'dps' }, { position: [0, 0, 0] }))).toMatch(/position: ships joining/u);
    expect(problems(join({ id: 'tfi', squad: 'dps' }, { heading: 0 }))).toMatch(/heading: ships joining/u);
    expect(problems(join({ id: 'tfi', squad: 'tackle' }))).toMatch(/no squad "tackle" in fleet "tfi" \(squads: dps, logi\)/u);
    expect(problems(join({ id: 'nope', squad: 'dps' }))).toMatch(/no fleet "nope" in the scene \(fleets: tfi\)/u);
    expect(problems({ ...join({ id: 'tfi', squad: 'dps' }), count: 251 })).toMatch(/passes? 256|would pass 256/u);
  });
});

describe('add_ships: a new squad', () => {
  it('goes in the last wing with its role id, anchored by the composition rules, moving nobody', () => {
    const before = scene(TFI_FLEET_SCENE);
    const first = apply(before, { op: 'add_ships', hull: 'Guardian', dna: GUARDIAN, radius: 80, count: 2, radii: FLEET_RADII, fleet: { id: 'tfi', squad: { role: 'logi' } } });
    const squads = first.scene.fleets?.[0].wings[0].squads ?? [];
    expect(squads.map((squad) => squad.id)).toEqual(['dps', 'logi', 'logi-2']);
    expect(squads[2]).toMatchObject({ role: 'logi', members: ['tfi-logi-2-01', 'tfi-logi-2-02'], anchor: { ship: 'tfi-logi-2-01' } });
    expect(first.warnings.join('\n')).not.toMatch(/formation slots/u);
    const second = apply(first.scene, { ...TFIS, radii: FLEET_RADII, fleet: { id: 'tfi', squad: { id: 'pickets', anchor: { on: 'dps', range: 5000 } } } });
    expect(second.scene.fleets?.[0].wings[0].squads[3]).toMatchObject({ id: 'pickets', anchor: { ship: 'tfi-1', range: 5000 } });
  });

  it('creates wing-1 for a wingless fleet', () => {
    const before = scene({ ships: [{ id: 'fc', dna: TFI }], fleets: [{ id: 'solo', commander: 'fc', wings: [] }] });
    const { scene: after } = apply(before, { ...TFIS, fleet: { id: 'solo', squad: {} } });
    expect(after.fleets?.[0].wings).toEqual([{ id: 'wing-1', squads: [{ id: 'dps', role: 'dps', members: ['solo-dps-01'] }] }]);
  });
});
