import { describe, expect, it } from 'vitest';
import { catchSceneError, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';
import { makeMiniComposition } from '../compositions/compositions.spec-helper';
import { applySceneOperations, createEmptyScene, normalizeScene, type SceneDocument } from '../scene';

const FLEET = normalizeScene(TFI_FLEET_SCENE).scene;

function setPropMods(operation: Record<string, unknown>, scene: SceneDocument = FLEET) {
  return applySceneOperations(scene, [{ op: 'set_prop_mods', ...operation }]);
}

function propMods(scene: SceneDocument): Record<string, unknown> {
  return Object.fromEntries(scene.ships.filter((ship) => ship.propMod).map((ship) => [ship.id, ship.propMod]));
}

describe('set_prop_mods', () => {
  it('selects by ships, fleet, wing and squad', () => {
    expect(propMods(setPropMods({ ships: ['tfi-2', 'fc'], active: true }).scene)).toEqual({ fc: { active: true }, 'tfi-2': { active: true } });
    expect(Object.keys(propMods(setPropMods({ fleet: 'tfi', active: true }).scene))).toEqual(['fc', 'tfi-1', 'tfi-2', 'tfi-3', 'guardian-1', 'guardian-2']);
    expect(Object.keys(propMods(setPropMods({ fleet: 'tfi', wing: 'wing-1', module: 'ab' }).scene))).toEqual(['tfi-1', 'tfi-2', 'tfi-3', 'guardian-1', 'guardian-2']);
    expect(propMods(setPropMods({ fleet: 'tfi', squad: 'logi', module: '10MN AB II', active: true }).scene)).toEqual({
      'guardian-1': { module: '10MN AB II', active: true },
      'guardian-2': { module: '10MN AB II', active: true }
    });
  });

  it('sets and clears the module and active, removing an emptied propMod', () => {
    const on = setPropMods({ ships: ['fc'], module: 'MWD', active: true }).scene;
    expect(on.ships[0].propMod).toEqual({ module: 'mwd', active: true });
    expect(setPropMods({ ships: ['fc'], active: false }, on).scene.ships[0].propMod).toEqual({ module: 'mwd' });
    expect(setPropMods({ ships: ['fc'], module: null }, on).scene.ships[0].propMod).toEqual({ active: true });
    expect(setPropMods({ ships: ['fc'], module: null, active: false }, on).scene.ships[0].propMod).toBeUndefined();
    const shorthand = normalizeScene({ ...TFI_FLEET_SCENE, ships: [{ id: 'fc', dna: 'mb2_t1:minmatarnavy:minmatar', propMod: '500MN Microwarpdrive II' }], fleets: [] }).scene;
    expect(setPropMods({ ships: ['fc'], active: true }, shorthand).scene.ships[0].propMod).toEqual({ module: '500MN Microwarpdrive II', active: true });
  });

  it('warns when the selection fits no prop mod', () => {
    const none = setPropMods({ fleet: 'tfi', squad: 'dps', module: 'none' }).scene;
    const { scene, warnings } = setPropMods({ fleet: 'tfi', active: true }, none);
    expect(scene.ships.find((ship) => ship.id === 'tfi-1')?.propMod).toEqual({ module: 'none', active: true });
    expect(warnings).toEqual(['operations[0]: "tfi-1", "tfi-2", "tfi-3" fit no prop mod (propMod.module "none"), so they stay off']);
  });

  it('reports every problem', () => {
    expect(catchSceneError(() => setPropMods({ active: true })).problems).toEqual(['operations[0] needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)']);
    expect(catchSceneError(() => setPropMods({ ships: ['fc'], fleet: 'tfi', active: true })).problems).toHaveLength(1);
    expect(catchSceneError(() => setPropMods({ ships: ['fc'] })).problems).toEqual(['operations[0] needs active (true or false) or module (a module, or null for the hull-sized default)']);
    expect(catchSceneError(() => setPropMods({ ships: ['fc'], active: 1 })).problems).toEqual(['operations[0].active must be true or false']);
    expect(catchSceneError(() => setPropMods({ ships: ['ghost'], active: true })).problems).toEqual(['operations[0]: no ship "ghost"']);
    expect(catchSceneError(() => setPropMods({ fleet: 'tfi', squad: 'nope', active: true })).problems).toEqual(['operations[0]: no squad "nope" in fleet "tfi"']);
    expect(catchSceneError(() => setPropMods({ ships: ['fc'], module: '' })).problems).toHaveLength(1);
  });

  it('composes after add_fleet_composition in the same patch', () => {
    const { scene } = applySceneOperations(createEmptyScene(), [
      { op: 'add_fleet_composition', composition: makeMiniComposition(), position: [0, 0, 0], fleet: 'mini' },
      { op: 'set_prop_mods', fleet: 'mini', squad: 'logi', module: 'ab', active: true }
    ]);
    expect(propMods(scene)).toEqual({ 'mini-logi-01': { module: 'ab', active: true }, 'mini-logi-02': { module: 'ab', active: true } });
  });
});
