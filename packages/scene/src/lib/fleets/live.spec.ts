import { describe, expect, it } from 'vitest';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import { GUARDIAN, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { toLiveFleetScene } from './live';
import { toFleetMemberships } from './membership';

const base = (): SceneDocument => normalizeScene(TFI_FLEET_SCENE).scene;
const squadOf = (scene: SceneDocument, id: string) => scene.fleets?.[0].wings.flatMap((wing) => wing.squads).find((squad) => squad.id === id);

describe('toLiveFleetScene', () => {
  it('leaves an untouched scene the same object', () => {
    const scene = base();
    const view = toLiveFleetScene(scene, new Set());
    expect(view.scene).toBe(scene);
    expect(view.changes.size).toBe(0);
    expect(toLiveFleetScene(scene, new Set(['not-in-a-fleet'])).scene).toBe(scene);
  });

  it('a dead squad lead falls back as remove_ship does, with the same warnings', () => {
    const scene = base();
    const removed = applySceneOperations(scene, [{ op: 'remove_ship', id: 'guardian-1' }]);
    const view = toLiveFleetScene(scene, new Set(['guardian-1']));
    expect(view.warnings).toEqual(removed.warnings);
    expect(squadOf(view.scene, 'logi')).toEqual(squadOf(removed.scene, 'logi'));
    expect(view.changes.get('tfi')).toEqual({ destroyed: ['guardian-1'] });
    expect(view.scene.ships).toBe(scene.ships);
    expect(scene.fleets?.[0].wings[0].squads[1].members).toEqual(['guardian-1', 'guardian-2']);
  });

  it('a dead FC hands the fleet to the first live wing commander, else squad commander, else member', () => {
    const withWing = applySceneOperations(base(), [
      { op: 'add_ship', ship: { id: 'wc', dna: GUARDIAN } },
      { op: 'update_wing', fleet: 'tfi', wing: 'wing-1', set: { commander: 'wc' } }
    ]).scene;
    const toWing = toLiveFleetScene(withWing, new Set(['fc']));
    expect(toWing.scene.fleets?.[0].commander).toBe('wc');
    expect(toWing.changes.get('tfi')).toEqual({ actingFor: 'fc', destroyed: ['fc'] });
    expect(toFleetMemberships(toWing.scene).get('tfi-1')?.anchor?.ship).toBe('wc');

    const toSquad = toLiveFleetScene(base(), new Set(['fc']));
    expect(toSquad.scene.fleets?.[0].commander).toBe('guardian-1');
    expect(toFleetMemberships(toSquad.scene).get('guardian-1')).toMatchObject({ commands: expect.arrayContaining(['fleet']) });

    const toMember = toLiveFleetScene(base(), new Set(['fc', 'guardian-1']));
    expect(toMember.scene.fleets?.[0].commander).toBe('tfi-1');
    expect(toMember.changes.get('tfi')).toEqual({ actingFor: 'fc', destroyed: ['fc', 'guardian-1'] });
    expect(squadOf(toMember.scene, 'logi')?.members).toEqual(['guardian-2']);
  });

  it('drops a fleet with nobody alive', () => {
    const view = toLiveFleetScene(base(), new Set(['fc', 'tfi-1', 'tfi-2', 'tfi-3', 'guardian-1', 'guardian-2']));
    expect(view.scene.fleets).toEqual([]);
    expect(view.changes.get('tfi')).toMatchObject({ dropped: true, destroyed: ['fc', 'guardian-1', 'tfi-1', 'tfi-2', 'tfi-3', 'guardian-2'] });
    expect(view.warnings).toEqual([]);
  });

  it("splices live calls over the document's lists, [] calling nothing, before the dead leave", () => {
    const scene = applySceneOperations(base(), [{ op: 'update_fleet', fleet: 'tfi', set: { targets: ['tfi-1'] } }]).scene;
    const calls = new Map<string, readonly string[]>([
      ['tfi', []],
      ['tfi/squad/logi', ['x', 'y']],
      ['tfi/squad/gone', ['z']]
    ]);
    const view = toLiveFleetScene(scene, new Set(), { calls });
    expect(view.scene.fleets?.[0].targets).toBeUndefined();
    expect(squadOf(view.scene, 'logi')?.targets).toEqual(['x', 'y']);
    expect(view.changes.size).toBe(0);
    expect(scene.fleets?.[0].targets).toEqual(['tfi-1']);
    expect(squadOf(scene, 'logi')?.targets).toBeUndefined();

    const dead = toLiveFleetScene(scene, new Set(['guardian-1']), { calls });
    expect(squadOf(dead.scene, 'logi')).toMatchObject({ members: ['guardian-2'], targets: ['x', 'y'] });
    expect(toLiveFleetScene(scene, new Set(), { calls: new Map() }).scene).toBe(scene);
  });
});
