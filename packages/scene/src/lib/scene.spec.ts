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

describe('ship flight fields', () => {
  const guardian = { id: 'g', dna: 'ac3_t2:carthum:amarr' };

  it('type is a type id or an EVE type name', () => {
    const { scene, warnings } = normalizeScene({
      ships: [
        { ...guardian, type: 11987 },
        { id: 't', dna: 'mb2_t1:minmatarnavy:minmatar', type: '  Tempest Fleet Issue ' },
        { id: 'n', dna: guardian.dna, type: null }
      ]
    });
    expect(scene.ships.map((ship) => ship.type)).toEqual([11987, 'Tempest Fleet Issue', undefined]);
    expect('type' in scene.ships[2]).toBe(false);
    expect(warnings).toEqual([]);
    const error = catchSceneError(() => normalizeScene({ ships: [0, -1, 2.5, {}, '', 'x'.repeat(101)].map((type, index) => ({ id: `s${index}`, dna: guardian.dna, type })) }));
    expect(error.problems).toHaveLength(6);
    expect(error.problems[0]).toBe('ships[0].type must be a positive integer type id or an EVE type name');
  });

  it('stats overrides are validated, unknown stats warn, and empty means absent', () => {
    const { scene, warnings } = normalizeScene({
      ships: [
        { ...guardian, stats: { maxVelocity: 300, agility: 0.5, speed: 3 } },
        { id: 'e', dna: guardian.dna, stats: {} }
      ]
    });
    expect(scene.ships[0].stats).toEqual({ maxVelocity: 300, agility: 0.5 });
    expect(scene.ships[1].stats).toBeUndefined();
    expect(warnings).toEqual(['ships[0].stats.speed is not a known stat and was dropped']);
    const error = catchSceneError(() =>
      normalizeScene({
        ships: [
          { ...guardian, stats: { mass: 0, maxVelocity: -1 } },
          { id: 'x', dna: guardian.dna, stats: 5 }
        ]
      })
    );
    expect(error.problems).toEqual(['ships[0].stats.mass must be a positive number (kg)', 'ships[0].stats.maxVelocity must be a number of 0 or more (m/s)', 'ships[1].stats must be an object of mass, maxVelocity, agility and signatureRadius']);
  });

  it('pilot is reserved: stored with a warning, never interpreted', () => {
    const { scene, warnings } = normalizeScene({
      ships: [
        { ...guardian, pilot: { skills: { Navigation: 4 } } },
        { id: 'p', dna: guardian.dna, pilot: 'fc' },
        { id: 'q', dna: guardian.dna, pilot: null }
      ]
    });
    expect(scene.ships[0].pilot).toEqual({ skills: { Navigation: 4 } });
    expect(scene.ships[1].pilot).toBe('fc');
    expect(scene.ships[2].pilot).toBeUndefined();
    expect(warnings).toEqual(['ships[0].pilot is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot', 'ships[1].pilot is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot']);
    for (const pilot of [3, '', [1]]) {
      expect(catchSceneError(() => normalizeScene({ ships: [{ ...guardian, pilot }] })).problems).toEqual(['ships[0].pilot must be an object or a pilot name']);
    }
  });

  it('update_ship replaces stats as a whole and null clears type, stats and pilot', () => {
    const { scene } = normalizeScene({ ships: [{ ...guardian, type: 11987, stats: { mass: 1e7, agility: 0.5 }, pilot: 'fc' }] });
    const replaced = applySceneOperations(scene, [{ op: 'update_ship', id: 'g', set: { stats: { maxVelocity: 300 } } }]).scene;
    expect(replaced.ships[0].stats).toEqual({ maxVelocity: 300 });
    const cleared = applySceneOperations(scene, [{ op: 'update_ship', id: 'g', set: { type: null, stats: null, pilot: null } }]).scene;
    expect(cleared.ships[0]).toEqual({ id: 'g', dna: guardian.dna, position: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it('the diff retunes a ship whose type, stats or pilot changed, and still rebuilds on a DNA change', () => {
    const { scene: before } = normalizeScene({ ...duel, ships: [...duel.ships, { ...guardian, stats: { mass: 1e7, agility: 0.5 } }] });
    const { scene: after } = applySceneOperations(before, [
      { op: 'update_ship', id: 'a', set: { type: 597 } },
      { op: 'update_ship', id: 'b', set: { stats: { maxVelocity: 500 }, dna: 'mf1_t1:minmatarnavy:minmatar' } },
      { op: 'update_ship', id: 'g', set: { stats: { agility: 0.5, mass: 1e7 } } }
    ]);
    const diff = diffScenes(before, after);
    expect(diff.retuned.map((ship) => ship.id)).toEqual(['a']);
    expect(diff.rebuilt.map((ship) => ship.id)).toEqual(['b']);
    expect(diff.moved).toEqual([]);
    expect(diffScenes(after, applySceneOperations(after, [{ op: 'update_ship', id: 'g', set: { pilot: 'fc' } }]).scene).retuned.map((ship) => ship.id)).toEqual(['g']);
  });
});
