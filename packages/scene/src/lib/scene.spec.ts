import { describe, expect, it } from 'vitest';
import { applySceneOperations, DEFAULT_UNIVERSE, diffScenes, normalizeScene, SceneError } from './scene';

const duel = {
  name: 'duel',
  ships: [
    { id: 'a', dna: 'af1_t1:amarrbase:amarr', position: [0, 0, 0] },
    { id: 'b', dna: 'mf1_t1:minmatarbase:minmatar', position: [3000, 0, 0], rotation: [180, 0, 0], team: 'blue' }
  ]
};

/** Runs `action`, which must throw a SceneError, and returns the error. */
function catchSceneError(action: () => unknown): SceneError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneError);
    return error as SceneError;
  }
  throw new Error('expected a SceneError');
}

describe('scene documents', () => {
  it('a minimal document gets defaults', () => {
    const { scene, warnings } = normalizeScene({ ships: [{ id: 'x', dna: 'af1_t1:amarrbase:amarr' }] });
    expect(scene.schema).toBe('cjs-scene/1');
    expect(scene.environment.universe).toBe(DEFAULT_UNIVERSE);
    expect(scene.ships[0].position).toEqual([0, 0, 0]);
    expect(scene.ships[0].rotation).toEqual([0, 0, 0]);
    expect(scene.camera.target).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('every problem is reported together', () => {
    const error = catchSceneError(() =>
      normalizeScene({
        schema: 'other/2',
        ships: [
          { id: 'a', dna: 'not-dna' },
          { id: 'a', dna: 'af1_t1:amarrbase:amarr', position: [1, 2] }
        ],
        camera: { target: 'missing', pitch: 120 }
      })
    );
    const text = error.problems.join('\n');
    for (const expected of ['schema', 'not hull:faction:race', 'used more than once', 'position', 'pitch', 'camera.target']) {
      expect(text).toMatch(new RegExp(expected));
    }
  });

  it('unknown keys warn and are dropped; reserved keys are kept with a warning', () => {
    const { scene, warnings } = normalizeScene({
      colour: 'red',
      timeline: [{ at: 1 }],
      ships: [{ id: 'a', dna: 'af1_t1:amarrbase:amarr', speed: 3, orders: [{ orbit: 'b' }] }]
    });
    expect((scene as unknown as Record<string, unknown>)['colour']).toBeUndefined();
    expect((scene.ships[0] as unknown as Record<string, unknown>)['speed']).toBeUndefined();
    expect(scene.ships[0].orders).toEqual([{ orbit: 'b' }]);
    expect(scene.timeline).toEqual([{ at: 1 }]);
    expect(warnings).toHaveLength(4);
  });

  it('operations edit a copy and validate the result', () => {
    const { scene } = normalizeScene(duel);
    const { scene: next } = applySceneOperations(scene, [
      { op: 'update_ship', id: 'a', set: { position: [10, 0, 0] } },
      { op: 'add_ship', ship: { id: 'c', dna: 'cf1_t1:caldaribase:caldari' } },
      { op: 'remove_ship', id: 'b' },
      { op: 'set_camera', camera: { target: 'c', distance: 900 } },
      { op: 'rename', name: 'trio' }
    ]);
    expect(scene.ships.map((ship) => ship.id)).toEqual(['a', 'b']);
    expect(next.ships.map((ship) => ship.id)).toEqual(['a', 'c']);
    expect(next.ships[0].position).toEqual([10, 0, 0]);
    expect(next.camera.target).toBe('c');
    expect(next.camera.yaw).toBe(45);
    expect(next.name).toBe('trio');
  });

  it("removing the camera's target clears it; bad operations all report", () => {
    const { scene } = normalizeScene({ ...duel, camera: { target: 'b' } });
    expect(applySceneOperations(scene, [{ op: 'remove_ship', id: 'b' }]).scene.camera.target).toBeNull();
    const error = catchSceneError(() => applySceneOperations(scene, [{ op: 'remove_ship', id: 'zz' }, { op: 'update_ship', id: 'a', set: { id: 'q' } }, { op: 'explode' }]));
    expect(error.problems).toHaveLength(3);
  });

  it('the diff names exactly the work to do', () => {
    const { scene: before } = normalizeScene(duel);
    const { scene: after } = applySceneOperations(before, [
      { op: 'update_ship', id: 'a', set: { dna: 'af1_t1:amarrnavy:amarr' } },
      { op: 'update_ship', id: 'b', set: { position: [1, 1, 1], name: 'Rifter' } },
      { op: 'add_ship', ship: { id: 'c', dna: 'cf1_t1:caldaribase:caldari' } }
    ]);
    const diff = diffScenes(before, after);
    expect(diff.rebuilt.map((ship) => ship.id)).toEqual(['a']);
    expect(diff.moved.map((ship) => ship.id)).toEqual(['b']);
    expect(diff.relabelled.map((ship) => ship.id)).toEqual(['b']);
    expect(diff.added.map((ship) => ship.id)).toEqual(['c']);
    expect(diff.removed).toEqual([]);
    expect(diff.environment).toBe(false);
    expect(diffScenes(null, before).added.map((ship) => ship.id)).toEqual(['a', 'b']);
  });
});
