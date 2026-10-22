import { describe, expect, it } from 'vitest';
import { DNA_PATTERN } from '../json';
import { catchSceneError, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';
import { applySceneOperations, createEmptyScene, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import { readEftHeader } from './eft';
import { FLEET_COMPOSITION_EXAMPLES } from './examples';
import { makeMiniComposition, TFIS_FIT_KEYS, tfisComposition } from './compositions.spec-helper';

const TFIS = FLEET_COMPOSITION_EXAMPLES[0];

function addTfis(scene: SceneDocument, extra: Record<string, unknown> = {}): ReturnType<typeof applySceneOperations> {
  return applySceneOperations(scene, [{ op: 'add_fleet_composition', composition: TFIS, position: [0, 0, 0], ...extra }]);
}

describe('add_fleet_composition', () => {
  it('adds TFIs beside an existing fleet', () => {
    const before = normalizeScene(TFI_FLEET_SCENE).scene;
    const { scene, warnings } = addTfis(before, { position: [0, 0, 100000] });
    expect(warnings).toEqual([]);
    expect(scene.ships).toHaveLength(50);
    expect(scene.fleets?.map((fleet) => fleet.id)).toEqual(['tfi', 'tfis']);
    const diff = diffScenes(before, scene);
    expect(diff.added).toHaveLength(44);
    expect(diff.regrouped).toHaveLength(0);
    expect(diff.fleets).toBe(true);
  });

  it('gives two compositions in one patch disjoint ids', () => {
    const { scene } = applySceneOperations(createEmptyScene(), [
      { op: 'add_fleet_composition', composition: TFIS, position: [0, 0, 0] },
      { op: 'add_fleet_composition', composition: TFIS, position: [0, 0, 100000] },
      { op: 'set_camera', camera: { target: 'tfis-2-fc' } }
    ]);
    expect(scene.fleets?.map((fleet) => fleet.id)).toEqual(['tfis', 'tfis-2']);
    expect(new Set(scene.ships.map((ship) => ship.id)).size).toBe(88);
    expect(scene.camera.target).toBe('tfis-2-fc');
  });

  it('skips a composition id an object holds', () => {
    const before = normalizeScene({ objects: [{ id: 'tfis-fc', dna: 'cm1_t1:upwell:generic' }] }).scene;
    expect(addTfis(before).scene.fleets?.map((fleet) => fleet.id)).toEqual(['tfis-2']);
    expect(catchSceneError(() => addTfis(before, { fleet: 'tfis' })).problems[0]).toMatch(/object "tfis-fc" already exists/u);
  });

  it('faces a point', () => {
    const { scene } = applySceneOperations(createEmptyScene(), [{ op: 'add_fleet_composition', composition: makeMiniComposition(), position: [0, 0, 0], facing: [0, 0, -10] }]);
    expect(scene.ships.every((ship) => ship.rotation.join() === '180,0,0')).toBe(true);
  });

  it('refuses bad placement arguments', () => {
    const op = { op: 'add_fleet_composition', composition: makeMiniComposition() };
    expect(catchSceneError(() => applySceneOperations(createEmptyScene(), [{ ...op, position: [0, 0, 0], heading: 10, facing: [1, 0, 0] }])).problems).toEqual(['operations[0]: give heading or facing, not both']);
    expect(catchSceneError(() => applySceneOperations(createEmptyScene(), [op])).problems).toEqual(["operations[0].position is required: the FC's [x, y, z] in metres"]);
    expect(catchSceneError(() => applySceneOperations(createEmptyScene(), [{ ...op, position: [5, 0, 5], facing: [5, 900, 5] }])).problems).toEqual(['operations[0].facing is straight above or below the position; give a point off to the side, or a heading']);
  });

  it('prefixes composition problems and refuses the whole patch', () => {
    const scene = createEmptyScene();
    const error = catchSceneError(() =>
      applySceneOperations(scene, [
        { op: 'rename', name: 'x' },
        { op: 'add_fleet_composition', composition: { id: 'x', commander: { hull: 'Zarmazd' } }, position: [0, 0, 0] }
      ])
    );
    expect(error.problems).toEqual(['operations[1].composition.commander: hull "Zarmazd" has no dna. The add_fleet_composition tool resolves hull names to DNA through tools-core; patch_scene needs every ship line\'s dna.']);
    expect(catchSceneError(() => applySceneOperations(scene, [{ op: 'add_fleet_composition', composition: { id: 'x' }, position: [0, 0, 0] }])).problems).toEqual(["operations[0].composition.commander must be an object: the fleet commander's ship"]);
    expect(scene).toEqual(createEmptyScene());
  });
});

describe('remove_fleet withShips', () => {
  it('removes the fleet and its ships, clearing a camera target on one', () => {
    const added = applySceneOperations(normalizeScene(TFI_FLEET_SCENE).scene, [
      { op: 'add_fleet_composition', composition: TFIS, position: [0, 0, 100000] },
      { op: 'set_camera', camera: { target: 'tfis-logi-03' } }
    ]).scene;
    const { scene } = applySceneOperations(added, [{ op: 'remove_fleet', fleet: 'tfis', withShips: true }]);
    expect(scene.ships).toHaveLength(6);
    expect(scene.fleets?.map((fleet) => fleet.id)).toEqual(['tfi']);
    expect(scene.camera.target).toBeNull();
    expect(diffScenes(added, scene).removed).toHaveLength(44);
  });

  it('keeps the ships without withShips and refuses other values', () => {
    const added = addTfis(createEmptyScene()).scene;
    expect(applySceneOperations(added, [{ op: 'remove_fleet', fleet: 'tfis' }]).scene.ships).toHaveLength(44);
    expect(catchSceneError(() => applySceneOperations(added, [{ op: 'remove_fleet', fleet: 'tfis', withShips: 'yes' }])).problems).toEqual(['operations[0].withShips must be true or omitted']);
  });
});

describe('the TFIs example end to end', () => {
  it('adds to an empty scene and normalizes again cleanly', () => {
    const { scene, warnings } = addTfis(createEmptyScene());
    expect(warnings).toEqual([]);
    expect(normalizeScene(structuredClone(scene)).warnings).toEqual([]);
    expect(scene.ships.every((ship) => DNA_PATTERN.test(ship.dna))).toBe(true);
  });

  it('carries the 13 doctrine fits, each matching its lines', () => {
    const composition = tfisComposition();
    expect(Object.keys(composition.fits ?? {})).toEqual(TFIS_FIT_KEYS);
    for (const ship of [composition.commander, ...composition.wings.flatMap((wing) => wing.squads.flatMap((squad) => squad.ships))]) {
      expect(readEftHeader(composition.fits![ship.fit!])?.hull).toBe(ship.hull);
    }
  });

  it('puts the fits in the scene once under tfis/<key>, reused by a second fleet, with the fleet id on a clash', () => {
    const { scene } = addTfis(createEmptyScene());
    const composition = tfisComposition();
    expect(scene.fits).toEqual(Object.fromEntries(TFIS_FIT_KEYS.map((key) => [`tfis/${key}`, composition.fits?.[key]])));
    const byId = new Map(scene.ships.map((ship) => [ship.id, ship]));
    expect([byId.get('tfis-fc')?.fit, byId.get('tfis-logi-01')?.fit, byId.get('tfis-carriers-03')?.fit]).toEqual(['tfis/tfi', 'tfis/guardian', 'tfis/archon']);

    const twice = addTfis(scene, { position: [0, 0, 200000] }).scene;
    expect(Object.keys(twice.fits ?? {})).toHaveLength(13);
    expect(twice.ships.find((ship) => ship.id === 'tfis-2-fc')?.fit).toBe('tfis/tfi');

    const edited = applySceneOperations(scene, [{ op: 'set_fits', fits: { 'tfis/tfi': '[Tempest Fleet Issue, Edited]\nDamage Control II' } }]).scene;
    const clash = addTfis(edited, { position: [0, 0, 200000], fleet: 'blue' }).scene;
    expect(clash.ships.find((ship) => ship.id === 'blue-fc')?.fit).toBe('blue/tfi');
    expect(clash.fits?.['blue/tfi']).toBe(composition.fits?.['tfi']);
    expect(clash.ships.find((ship) => ship.id === 'blue-logi-01')?.fit).toBe('tfis/guardian');
  });
});
