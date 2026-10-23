import { applySceneOperations, normalizeScene, type SceneDocument, toLiveFleetScene } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { FleetCommanders } from './fleet-commanders';

const DNA = 'mf1_t1:minmatarbase:minmatar';
const FLEET = 'f';
const DPS = { fleet: FLEET, kind: 'squad', id: 'dps' } as const;
const WHOLE = { fleet: FLEET, kind: 'fleet', id: FLEET } as const;

function MakeScene(): SceneDocument {
  const ids = ['fc', 'd1', 'd2', 'r1', 'r2', 'r3'];
  return normalizeScene({
    ships: ids.map((id) => ({ id, dna: DNA })),
    objects: [{ id: 'astra', dna: DNA }],
    fleets: [{ id: FLEET, commander: 'fc', targets: ['r1', 'r2'], wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', members: ['d1', 'd2'] }] }] }]
  }).scene;
}

const Live = (scene: SceneDocument, commanders: FleetCommanders) => toLiveFleetScene(scene, new Set(), commanders.Overlay()).scene;

describe('FleetCommanders', () => {
  it("overlays live calls on the document's, [] calling nothing, and bumps its version on a change only", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    expect(Live(scene, commanders)).toBe(scene);

    commanders.SetCall(DPS, ['r3']);
    commanders.SetCall(WHOLE, []);
    const version = commanders.version;
    const live = Live(scene, commanders);
    expect(live.fleets?.[0].wings[0].squads[0].targets).toEqual(['r3']);
    expect(live.fleets?.[0].targets).toBeUndefined();
    expect(scene.fleets?.[0].targets).toEqual(['r1', 'r2']);
    expect(commanders.CallOf(DPS)).toEqual(['r3']);

    const overlay = commanders.Overlay();
    commanders.SetCall(DPS, ['r3']);
    expect(commanders.version).toBe(version);
    expect(commanders.Overlay()).toBe(overlay);

    commanders.Clear();
    expect(commanders.version).toBe(version + 1);
    expect(commanders.CallOf(DPS)).toBeNull();
    expect(Live(scene, commanders)).toBe(scene);
  });

  it("prunes removed ships and objects from live lists with remove_ship's warning, and keeps an emptied list", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    commanders.SetCall(DPS, ['astra', 'r3']);
    commanders.SetCall(WHOLE, ['r2']);
    const after = applySceneOperations(scene, [
      { op: 'remove_object', id: 'astra' },
      { op: 'remove_ship', id: 'r2' }
    ]);
    expect(after.scene.fleets?.[0].targets).toEqual(['r1']);
    const warnings = commanders.AfterEdit(scene, after.scene);
    expect(warnings).toEqual(['fleet "f": squad "dps" no longer calls "astra" (it was removed)', 'fleet "f" no longer calls "r2" (it was removed)']);
    expect(after.warnings).toContain('fleet "f" no longer calls "r2" (it was removed)');
    expect(commanders.CallOf(DPS)).toEqual(['r3']);
    // The FC's live call ran out: the document's pruned list must not come back.
    expect(commanders.CallOf(WHOLE)).toEqual([]);
    expect(Live(after.scene, commanders).fleets?.[0].targets).toBeUndefined();
  });

  it("drops a live call when its group goes or the patch edits the group's document list", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    commanders.SetCall(DPS, ['r3']);
    commanders.SetCall(WHOLE, ['r3']);
    const unrelated = applySceneOperations(scene, [{ op: 'update_ship', id: 'r1', set: { name: 'Red one' } }]).scene;
    expect(commanders.AfterEdit(scene, unrelated)).toEqual([]);
    expect(commanders.CallOf(WHOLE)).toEqual(['r3']);

    const edited = applySceneOperations(unrelated, [{ op: 'update_fleet', fleet: FLEET, set: { targets: ['r2'] } }]).scene;
    const version = commanders.version;
    commanders.AfterEdit(unrelated, edited);
    expect(commanders.version).toBe(version + 1);
    expect(commanders.CallOf(WHOLE)).toBeNull();
    expect(Live(edited, commanders).fleets?.[0].targets).toEqual(['r2']);
    expect(commanders.CallOf(DPS)).toEqual(['r3']);

    const gone = applySceneOperations(edited, [{ op: 'remove_squad', fleet: FLEET, squad: 'dps' }]).scene;
    commanders.AfterEdit(edited, gone);
    expect(commanders.CallOf(DPS)).toBeNull();
  });
});
