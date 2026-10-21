import { describe, expect, it } from 'vitest';
import { applySceneOperations, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import { catchSceneError, GUARDIAN, TFI, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { toFleetMemberships } from './membership';

const base = (): SceneDocument => normalizeScene(TFI_FLEET_SCENE).scene;
const edit = (operations: unknown[], scene: SceneDocument = base()) => applySceneOperations(scene, operations);
const squadOf = (scene: SceneDocument, id: string) => scene.fleets?.[0].wings.flatMap((wing) => wing.squads).find((squad) => squad.id === id);
const FC_REFUSED = 'operations[0]: ship "fc" commands fleet "tfi"; give the fleet another commander (update_fleet) or remove the fleet (remove_fleet) first';

describe('fleet operations', () => {
  it('adds, updates and removes a fleet', () => {
    const added = edit([
      { op: 'add_ship', ship: { id: 'other', dna: TFI } },
      { op: 'add_fleet', fleet: { id: 'solo', commander: 'other' } }
    ]).scene;
    expect(added.fleets?.map((fleet) => fleet.id)).toEqual(['tfi', 'solo']);
    expect(catchSceneError(() => edit([{ op: 'add_fleet', fleet: { id: 'tfi', commander: 'fc' } }])).problems).toEqual(['operations[0]: fleet "tfi" already exists']);

    expect(edit([{ op: 'update_fleet', fleet: 'tfi', set: { name: 'Renamed' } }]).scene.fleets?.[0].name).toBe('Renamed');
    expect('name' in (edit([{ op: 'update_fleet', fleet: 'tfi', set: { name: null } }]).scene.fleets?.[0] ?? {})).toBe(false);
    expect(catchSceneError(() => edit([{ op: 'update_fleet', fleet: 'tfi', set: { id: 'x' } }])).problems).toEqual([`operations[0]: a fleet's id cannot be changed; remove and add it instead`]);
    expect(catchSceneError(() => edit([{ op: 'update_fleet', fleet: 'tfi', set: { wings: [] } }])).problems).toEqual(['operations[0]: wings are edited with add_wing, update_wing and remove_wing']);

    const removed = edit([{ op: 'remove_fleet', fleet: 'tfi' }]).scene;
    expect('fleets' in removed).toBe(false);
    expect(removed.ships).toHaveLength(6);
    expect(catchSceneError(() => edit([{ op: 'remove_fleet', fleet: 'x' }])).problems).toEqual(['operations[0]: no fleet "x"']);
  });

  it('adds, updates and removes wings and squads', () => {
    const added = edit([
      { op: 'add_wing', fleet: 'tfi', wing: { id: 'wing-2' } },
      { op: 'add_squad', fleet: 'tfi', wing: 'wing-2', squad: { id: 'tackle', role: 'tackle' } },
      { op: 'update_wing', fleet: 'tfi', wing: 'wing-1', set: { commander: 'tfi-1' } }
    ]).scene;
    expect(added.fleets?.[0].wings.map((wing) => wing.id)).toEqual(['wing-1', 'wing-2']);
    expect(squadOf(added, 'tackle')).toEqual({ id: 'tackle', role: 'tackle', members: [] });
    expect(added.fleets?.[0].wings[0].commander).toBe('tfi-1');
    expect(catchSceneError(() => edit([{ op: 'add_wing', fleet: 'tfi', wing: { id: 'wing-1' } }])).problems).toEqual(['operations[0]: wing "wing-1" already exists in fleet "tfi"']);
    expect(catchSceneError(() => edit([{ op: 'add_squad', fleet: 'tfi', wing: 'wing-1', squad: { id: 'logi', role: 'logi' } }])).problems).toEqual(['operations[0]: squad "logi" already exists in fleet "tfi"']);

    const retuned = edit([{ op: 'update_squad', fleet: 'tfi', squad: 'dps', set: { role: 'logi', anchor: null } }]).scene;
    expect(toFleetMemberships(retuned).get('tfi-1')?.anchor).toEqual({ ship: 'fc', range: 30000 });
    expect(catchSceneError(() => edit([{ op: 'update_squad', fleet: 'tfi', squad: 'dps', set: { members: [] } }])).problems).toEqual(['operations[0]: members are edited with move_to_squad and remove_from_fleet']);
    const replaced = edit([{ op: 'update_squad', fleet: 'tfi', squad: 'logi', set: { anchor: { range: 20000 } } }]).scene;
    expect(squadOf(replaced, 'logi')?.anchor).toEqual({ range: 20000 });

    const noLogi = edit([{ op: 'remove_squad', fleet: 'tfi', squad: 'logi' }]).scene;
    expect(noLogi.ships).toHaveLength(6);
    expect(toFleetMemberships(noLogi).has('guardian-1')).toBe(false);

    // A squad anchored on a removed wing's ship falls back to the FC.
    const twoWings = edit([
      { op: 'add_wing', fleet: 'tfi', wing: { id: 'wing-2' } },
      { op: 'move_to_squad', ships: ['tfi-3'], fleet: 'tfi', squad: 'logi' },
      { op: 'add_squad', fleet: 'tfi', wing: 'wing-2', squad: { id: 'tackle', role: 'tackle' } },
      { op: 'move_to_squad', ships: ['tfi-1'], fleet: 'tfi', squad: 'tackle' },
      { op: 'set_anchor', fleet: 'tfi', squad: 'dps', anchor: { ship: 'tfi-1' } }
    ]).scene;
    const { scene, warnings } = edit([{ op: 'remove_wing', fleet: 'tfi', wing: 'wing-2' }], twoWings);
    expect(warnings).toEqual(['fleet "tfi": squad "dps" now anchors on the fleet commander (its anchor "tfi-1" left the fleet)']);
    expect(squadOf(scene, 'dps')?.anchor).toEqual({ range: 1000 });
    expect(scene.ships).toHaveLength(6);
  });

  it('move_to_squad seats ships and repairs what they leave', () => {
    const joined = edit([
      { op: 'add_ship', ship: { id: 'new', dna: TFI } },
      { op: 'move_to_squad', ships: ['new'], fleet: 'tfi', squad: 'dps' }
    ]).scene;
    expect(squadOf(joined, 'dps')?.members).toEqual(['tfi-1', 'tfi-2', 'tfi-3', 'new']);

    const toLogi = edit([{ op: 'move_to_squad', ships: ['tfi-3'], fleet: 'tfi', squad: 'logi' }]).scene;
    expect(toFleetMemberships(toLogi).get('tfi-3')?.anchor).toEqual({ ship: 'guardian-1', range: 1000 });

    const { scene, warnings } = edit([{ op: 'move_to_squad', ships: ['guardian-1'], fleet: 'tfi', squad: 'dps' }]);
    expect(warnings).toEqual(['fleet "tfi": squad "logi" lost its commander "guardian-1"', 'fleet "tfi": squad "logi" now anchors on the fleet commander (its anchor "guardian-1" left the squad)']);
    expect(squadOf(scene, 'logi')).toEqual({ id: 'logi', role: 'logi', members: ['guardian-2'], anchor: { range: 30000 } });

    // tfi-1 commands wing-2 from no squad, then moves into a wing-1 squad.
    const wingCommander = edit([
      { op: 'remove_from_fleet', ships: ['tfi-1'] },
      { op: 'add_wing', fleet: 'tfi', wing: { id: 'wing-2', commander: 'tfi-1' } },
      { op: 'move_to_squad', ships: ['tfi-1'], fleet: 'tfi', squad: 'logi' }
    ]);
    expect(wingCommander.warnings).toEqual(['fleet "tfi": wing "wing-2" lost its commander "tfi-1"']);
    expect(toFleetMemberships(wingCommander.scene).get('tfi-1')).toMatchObject({ squad: 'logi', commands: [], anchor: { ship: 'guardian-1', range: 1000 } });

    const crossFleet = edit([
      { op: 'add_ship', ship: { id: 'fc2', dna: TFI } },
      { op: 'add_fleet', fleet: { id: 'b', commander: 'fc2', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps' }] }] } },
      { op: 'move_to_squad', ships: ['tfi-2'], fleet: 'b', squad: 's' }
    ]).scene;
    expect(toFleetMemberships(crossFleet).get('tfi-2')).toMatchObject({ fleet: 'b', squad: 's', anchor: { ship: 'fc2', range: 1000 } });
    expect(squadOf(crossFleet, 'dps')?.members).toEqual(['tfi-1', 'tfi-3']);

    const refused = catchSceneError(() =>
      edit([
        { op: 'add_ship', ship: { id: 'fc2', dna: TFI } },
        { op: 'add_fleet', fleet: { id: 'b', commander: 'fc2' } },
        { op: 'move_to_squad', ships: ['fc2'], fleet: 'tfi', squad: 'dps' }
      ])
    );
    expect(refused.problems).toEqual(['operations[2]: ship "fc2" commands fleet "b"; give the fleet another commander (update_fleet) or remove the fleet (remove_fleet) first']);

    const stays = edit([{ op: 'move_to_squad', ships: ['tfi-1'], fleet: 'tfi', squad: 'dps' }]);
    expect(stays.warnings).toEqual([]);
    expect(squadOf(stays.scene, 'dps')?.members).toEqual(['tfi-1', 'tfi-2', 'tfi-3']);
  });

  it('remove_from_fleet takes ships out, but not the FC', () => {
    const { scene } = edit([{ op: 'remove_from_fleet', ships: ['tfi-1'] }]);
    expect(squadOf(scene, 'dps')?.members).toEqual(['tfi-2', 'tfi-3']);
    expect(scene.ships).toHaveLength(6);
    expect(catchSceneError(() => edit([{ op: 'remove_from_fleet', ships: ['fc'] }])).problems).toEqual([FC_REFUSED]);
    expect(
      catchSceneError(() =>
        edit([
          { op: 'add_ship', ship: { id: 'loner', dna: TFI } },
          { op: 'remove_from_fleet', ships: ['loner'] }
        ])
      ).problems
    ).toEqual(['operations[1]: ship "loner" is not in a fleet']);
  });

  it('set_anchor merges, and null resets to the defaults', () => {
    expect(squadOf(edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'logi', anchor: { range: 2500 } }]).scene, 'logi')?.anchor).toEqual({ ship: 'guardian-1', range: 2500 });
    expect(squadOf(edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'logi', anchor: { ship: null } }]).scene, 'logi')?.anchor).toEqual({ range: 30000 });
    const defaulted = edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'dps', anchor: { range: null } }]).scene;
    expect(squadOf(defaulted, 'dps')?.anchor).toBeUndefined();
    expect(catchSceneError(() => edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'dps', anchor: 5 }])).problems).toEqual(['operations[0].anchor must be an object']);
  });

  it('remove_ship takes the ship out of its fleet', () => {
    const quiet = edit([{ op: 'remove_ship', id: 'tfi-2' }]);
    expect(quiet.warnings).toEqual([]);
    expect(squadOf(quiet.scene, 'dps')?.members).toEqual(['tfi-1', 'tfi-3']);

    const logiAnchor = edit([{ op: 'remove_ship', id: 'guardian-1' }]);
    expect(logiAnchor.warnings).toEqual(['fleet "tfi": squad "logi" lost its commander "guardian-1"', 'fleet "tfi": squad "logi" now anchors on the fleet commander (its anchor "guardian-1" left the fleet)']);
    expect(squadOf(logiAnchor.scene, 'logi')).toEqual({ id: 'logi', role: 'logi', members: ['guardian-2'], anchor: { range: 30000 } });

    const reanchored = edit([
      { op: 'set_anchor', fleet: 'tfi', squad: 'logi', anchor: { ship: 'guardian-2' } },
      { op: 'remove_ship', id: 'guardian-2' }
    ]);
    expect(reanchored.warnings).toEqual(['fleet "tfi": squad "logi" now anchors on "guardian-1" (its anchor "guardian-2" left the fleet)']);
    expect(squadOf(reanchored.scene, 'logi')?.anchor).toEqual({ ship: 'guardian-1', range: 30000 });

    const toWingCommander = edit([
      { op: 'add_ship', ship: { id: 'wc', dna: GUARDIAN } },
      { op: 'update_wing', fleet: 'tfi', wing: 'wing-1', set: { commander: 'wc' } },
      { op: 'update_squad', fleet: 'tfi', squad: 'logi', set: { commander: null } },
      { op: 'remove_ship', id: 'guardian-1' }
    ]);
    expect(toWingCommander.warnings).toEqual(['fleet "tfi": squad "logi" now anchors on "wc" (its anchor "guardian-1" left the fleet)']);

    const framed = edit([
      { op: 'set_camera', camera: { target: 'tfi-1' } },
      { op: 'remove_ship', id: 'tfi-1' }
    ]).scene;
    expect(framed.camera.target).toBeNull();
  });

  it('a fleet commander must be replaced before it is removed', () => {
    expect(catchSceneError(() => edit([{ op: 'remove_ship', id: 'fc' }])).problems).toEqual([FC_REFUSED]);

    const { scene } = edit([
      { op: 'update_fleet', fleet: 'tfi', set: { commander: 'tfi-1' } },
      { op: 'remove_ship', id: 'fc' }
    ]);
    const memberships = toFleetMemberships(scene);
    expect(memberships.get('tfi-1')).toMatchObject({ anchor: null, commands: ['fleet'] });
    expect(memberships.get('tfi-2')?.anchor).toEqual({ ship: 'tfi-1', range: 1000 });
    expect(memberships.get('guardian-1')?.anchor).toEqual({ ship: 'tfi-1', range: 30000 });

    const reversed = catchSceneError(() =>
      edit([
        { op: 'remove_ship', id: 'fc' },
        { op: 'update_fleet', fleet: 'tfi', set: { commander: 'tfi-1' } }
      ])
    );
    expect(reversed.problems).toEqual([FC_REFUSED]);
  });

  it('every operation problem is reported together', () => {
    const error = catchSceneError(() =>
      edit([
        { op: 'remove_fleet', fleet: 'nope' },
        { op: 'add_squad', fleet: 'tfi', wing: 'nope', squad: { id: 's', role: 'dps' } },
        { op: 'set_anchor', fleet: 'tfi', squad: 'nope', anchor: {} },
        { op: 'move_to_squad', ships: ['ghost'], fleet: 'tfi', squad: 'dps' },
        { op: 'remove_from_fleet', ships: 'tfi-1' }
      ])
    );
    expect(error.problems).toEqual(['operations[0]: no fleet "nope"', 'operations[1]: no wing "nope" in fleet "tfi"', 'operations[2]: no squad "nope" in fleet "tfi"', 'operations[3]: no ship "ghost"', 'operations[4].ships must be a non-empty array of ship ids']);
  });
});

describe('the fleet diff', () => {
  const ids = (ships: { readonly id: string }[]) => ships.map((ship) => ship.id);

  it('a rename changes the fleets but regroups nobody', () => {
    const before = base();
    const diff = diffScenes(before, edit([{ op: 'update_fleet', fleet: 'tfi', set: { name: 'Renamed' } }], before).scene);
    expect(diff.fleets).toBe(true);
    expect(diff.regrouped).toEqual([]);
  });

  it('regroups the ships whose membership changed', () => {
    const before = base();
    expect(ids(diffScenes(before, edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'dps', anchor: { range: 2500 } }], before).scene).regrouped)).toEqual(['tfi-1', 'tfi-2', 'tfi-3']);

    const handover = diffScenes(
      before,
      edit(
        [
          { op: 'update_fleet', fleet: 'tfi', set: { commander: 'tfi-1' } },
          { op: 'remove_ship', id: 'fc' }
        ],
        before
      ).scene
    );
    expect(ids(handover.regrouped)).toEqual(['tfi-1', 'tfi-2', 'tfi-3', 'guardian-1']);
    expect(ids(handover.removed)).toEqual(['fc']);

    const unfleeted = edit([{ op: 'remove_fleet', fleet: 'tfi' }], before).scene;
    const added = diffScenes(unfleeted, before);
    expect(ids(added.regrouped)).toEqual(['fc', 'tfi-1', 'tfi-2', 'tfi-3', 'guardian-1', 'guardian-2']);
    expect(added.moved).toEqual([]);
  });

  it('a first load has fleets but no regrouped ships', () => {
    const diff = diffScenes(null, base());
    expect(diff.fleets).toBe(true);
    expect(diff.regrouped).toEqual([]);
  });
});
