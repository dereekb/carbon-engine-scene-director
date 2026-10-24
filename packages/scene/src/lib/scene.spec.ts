import { describe, expect, it } from 'vitest';
import { applySceneOperations, DEFAULT_CAMERA_FOV, DEFAULT_UNIVERSE, diffScenes, normalizeScene, SceneError } from './scene';

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

  it('unknown keys warn and are dropped; the timeline and ship orders are validated, a pilot name stays reserved', () => {
    const { scene, warnings } = normalizeScene({
      colour: 'red',
      timeline: [{ at: 1, order_ship: { id: 'a', order: { type: 'stop' } } }],
      ships: [
        { id: 'a', dna: 'af1_t1:amarrbase:amarr', speed: 3, orders: [{ type: 'orbit', target: 'b', range: 500 }], pilot: { name: 'Jo' } },
        { id: 'b', dna: 'mf1_t1:minmatarbase:minmatar' }
      ]
    });
    expect((scene as unknown as Record<string, unknown>)['colour']).toBeUndefined();
    expect((scene.ships[0] as unknown as Record<string, unknown>)['speed']).toBeUndefined();
    expect(scene.ships[0].orders).toEqual([{ type: 'orbit', target: 'b', range: 500, speed: 1 }]);
    expect(scene.timeline).toEqual({ cues: [{ id: 'cue-1', at: 1, order_ship: { id: 'a', order: { type: 'stop' } } }] });
    expect(warnings.filter((warning) => /colour|speed|pilot/.test(warning))).toHaveLength(3);
    expect(warnings.some((warning) => /reserved for a later phase and is stored but not played/.test(warning))).toBe(false);
    expect(catchSceneError(() => normalizeScene({ ships: [{ id: 'a', dna: 'af1_t1:amarrbase:amarr', orders: [{ orbit: 'b' }] }] })).problems.join('\n')).toMatch(/orders\[0\]\.type must be one of/);
  });

  it('diffs ship orders: a kept ship whose script changed restarts it', () => {
    const before = normalizeScene({ ships: [...duel.ships.map((ship) => ({ ...ship }))] }).scene;
    const after = applySceneOperations(before, [{ op: 'update_ship', id: 'a', set: { orders: [{ type: 'stop' }] } }]).scene;
    expect(diffScenes(before, after).orders.map((ship) => ship.id)).toEqual(['a']);
    expect(diffScenes(after, applySceneOperations(after, [{ op: 'update_ship', id: 'a', set: { orders: null } }]).scene).orders.map((ship) => ship.id)).toEqual(['a']);
    expect(diffScenes(null, after).orders).toEqual([]);
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

  it('the camera mode defaults to orbit, set_camera switches it, and an unknown mode is a problem', () => {
    const { scene } = normalizeScene({ ...duel, camera: { target: 'b' } });
    expect(scene.camera.mode).toBe('orbit');
    const next = applySceneOperations(scene, [{ op: 'set_camera', camera: { mode: 'chase' } }]).scene;
    expect(next.camera).toMatchObject({ target: 'b', mode: 'chase' });
    expect(catchSceneError(() => normalizeScene({ ...duel, camera: { mode: 'pov' } })).problems).toEqual(['camera.mode must be one of orbit, chase']);
  });

  it("the camera fov defaults to 90 (EveCamera's own), keeps a set one, and must be 5 to 120", () => {
    expect(DEFAULT_CAMERA_FOV).toBe(90);
    expect(normalizeScene(duel).scene.camera.fov).toBe(DEFAULT_CAMERA_FOV);
    expect(normalizeScene({ ...duel, camera: { target: 'b' } }).scene.camera.fov).toBe(DEFAULT_CAMERA_FOV);
    expect(normalizeScene({ ...duel, camera: { fov: 30 } }).scene.camera.fov).toBe(30);
    expect(catchSceneError(() => normalizeScene({ ...duel, camera: { fov: 150 } })).problems.join('\n')).toMatch(/camera\.fov/);
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

describe('ship immunity', () => {
  it('round-trips immune through normalizeScene', () => {
    const scene = normalizeScene({
      ...duel,
      ships: [
        { ...duel.ships[0], immune: ['Structure'] },
        { ...duel.ships[1], immune: true }
      ]
    }).scene;
    expect(scene.ships.map((ship) => ship.immune)).toEqual([['structure'], true]);
    expect(normalizeScene(scene).scene).toEqual(scene);
    expect(normalizeScene({ ...duel, ships: [{ ...duel.ships[0], immune: false }, duel.ships[1]] }).scene.ships[0]).not.toHaveProperty('immune');
    expect(catchSceneError(() => normalizeScene({ ...duel, ships: [{ ...duel.ships[0], immune: ['hull'] }, duel.ships[1]] })).problems).toEqual(['ships[0].immune: "hull" is not a layer (the hull layer is structure)']);
  });

  it('diffScenes names a kept ship whose immunity changed, without a rebuild or a retune', () => {
    const before = normalizeScene(duel).scene;
    const after = applySceneOperations(before, [
      { op: 'set_immunity', ships: ['a'], immune: true },
      { op: 'add_ship', ship: { id: 'c', dna: 'mf1_t1:minmatarbase:minmatar', position: [0, 0, 9000], immune: true } }
    ]).scene;
    const diff = diffScenes(before, after);
    expect(diff.immunity.map((ship) => ship.id)).toEqual(['a']);
    expect(diff.added.map((ship) => ship.id)).toEqual(['c']);
    expect(diff.rebuilt).toEqual([]);
    expect(diff.retuned).toEqual([]);
    expect(diffScenes(after, applySceneOperations(after, [{ op: 'set_immunity', ships: ['a'], immune: ['shield', 'armor', 'structure'] }]).scene).immunity).toEqual([]);
    expect(diffScenes(null, after).immunity).toEqual([]);
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

  it('pilot holds command and reaction; a pilot name and other keys are stored with a warning', () => {
    const { scene, warnings } = normalizeScene({
      ships: [
        { ...guardian, pilot: { command: 0.8, reaction: 0.5, skills: { Navigation: 4 } } },
        { id: 'p', dna: guardian.dna, pilot: 'fc' },
        { id: 'q', dna: guardian.dna, pilot: null },
        { id: 'r', dna: guardian.dna, pilot: { reaction: 1 } }
      ]
    });
    expect(scene.ships[0].pilot).toEqual({ command: 0.8, reaction: 0.5, skills: { Navigation: 4 } });
    expect(scene.ships[1].pilot).toBe('fc');
    expect(scene.ships[2].pilot).toBeUndefined();
    expect(scene.ships[3].pilot).toEqual({ reaction: 1 });
    expect(warnings).toEqual(['ships[0].pilot.skills is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot', 'ships[1].pilot is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot']);
    for (const pilot of [3, '', [1]]) {
      expect(catchSceneError(() => normalizeScene({ ships: [{ ...guardian, pilot }] })).problems).toEqual(['ships[0].pilot must be an object of command and reaction (0..1) or a pilot name']);
    }
    expect(catchSceneError(() => normalizeScene({ ships: [{ ...guardian, pilot: { reaction: -1 } }] })).problems).toEqual(['ships[0].pilot.reaction must be a finite number in [0, 1]']);
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
    const traits = applySceneOperations(after, [{ op: 'update_ship', id: 'g', set: { pilot: { command: 1, reaction: 0.2 } } }]).scene;
    expect(diffScenes(after, traits).retuned).toEqual([]);
  });

  it('keeps propMod, and the diff retunes a module change and switches an active change', () => {
    const { scene: before, warnings } = normalizeScene({ ...duel, ships: [{ ...duel.ships[0], propMod: '10MN Afterburner II' }, duel.ships[1]] });
    expect(warnings).toEqual([]);
    expect(before.ships[0].propMod).toEqual({ module: '10MN Afterburner II' });
    expect(normalizeScene(JSON.parse(JSON.stringify(before))).scene).toEqual(before);
    const { scene: after } = applySceneOperations(before, [
      { op: 'set_prop_mods', ships: ['a'], active: true },
      { op: 'update_ship', id: 'b', set: { propMod: 'mwd' } }
    ]);
    const diff = diffScenes(before, after);
    expect(diff.switched.map((ship) => ship.id)).toEqual(['a']);
    expect(diff.retuned.map((ship) => ship.id)).toEqual(['b']);
    const cleared = applySceneOperations(after, [{ op: 'update_ship', id: 'a', set: { propMod: null } }]).scene;
    expect(cleared.ships[0].propMod).toBeUndefined();
    expect(diffScenes(after, cleared).switched.map((ship) => ship.id)).toEqual(['a']);
    expect(diffScenes(after, cleared).retuned.map((ship) => ship.id)).toEqual(['a']);
    expect(diffScenes(null, after).switched).toEqual([]);
  });
});

describe('ship fits', () => {
  const RIFTER_FIT = '[Rifter, Tackle]\nDamage Control II\n\n1MN Afterburner II\nWarp Scrambler II';
  const fitted = { name: 'fitted', ships: [{ id: 'r', dna: 'mf1_t1:minmatarbase:minmatar', fit: 'tackle' }], fits: { tackle: RIFTER_FIT } };

  it('keeps an inline fit, a fit key and the fits map', () => {
    const { scene } = normalizeScene({ ...fitted, ships: [...fitted.ships, { id: 's', dna: 'mf1_t1:minmatarbase:minmatar', fit: `  ${RIFTER_FIT}\n` }] });
    expect(scene.ships.map((ship) => ship.fit)).toEqual(['tackle', RIFTER_FIT]);
    expect(scene.fits).toEqual({ tackle: RIFTER_FIT });
  });

  it('reports a missing key, bad keys, text without a header and a hull mismatch', () => {
    const error = catchSceneError(() => normalizeScene({ ships: [{ id: 'r', dna: 'mf1_t1:minmatarbase:minmatar', fit: 'nope' }], fits: { 'a b': RIFTER_FIT, ok: 'Damage Control II' } }));
    expect(error.problems).toEqual(['fits key "a b" must be 1-64 letters, digits, "_", "-" or ".", optionally twice with one "/" between', 'fits["ok"] must be EFT text starting with a [Hull, Fit name] header', 'ships[0].fit "nope" is not a key of the scene\'s fits']);
    const { warnings } = normalizeScene({ ...fitted, ships: [{ ...fitted.ships[0], type: 'Slasher' }] });
    expect(warnings).toEqual(['ships[0].fit: the fit is for a Rifter, but the ship\'s type is "Slasher"; the ship flies as its type']);
  });

  it('update_ship sets and clears a fit; a fit change is a retune', () => {
    const before = normalizeScene(fitted).scene;
    const inline = applySceneOperations(before, [{ op: 'update_ship', id: 'r', set: { fit: `${RIFTER_FIT}\nStasis Webifier II` } }]).scene;
    expect(diffScenes(before, inline).retuned.map((ship) => ship.id)).toEqual(['r']);
    const cleared = applySceneOperations(inline, [{ op: 'update_ship', id: 'r', set: { fit: null } }]).scene;
    expect(cleared.ships[0].fit).toBeUndefined();
    expect(diffScenes(inline, cleared).retuned.map((ship) => ship.id)).toEqual(['r']);
    const same = applySceneOperations(before, [{ op: 'update_ship', id: 'r', set: { fit: RIFTER_FIT } }]).scene;
    expect(diffScenes(before, same).retuned).toEqual([]);
  });

  it('set_fits merges and deletes keys, refuses deleting a used one, and editing the text retunes its ships', () => {
    const before = normalizeScene(fitted).scene;
    const edited = applySceneOperations(before, [{ op: 'set_fits', fits: { tackle: `${RIFTER_FIT}\nStasis Webifier II`, spare: RIFTER_FIT } }]).scene;
    expect(Object.keys(edited.fits ?? {})).toEqual(['tackle', 'spare']);
    expect(diffScenes(before, edited).retuned.map((ship) => ship.id)).toEqual(['r']);
    expect(applySceneOperations(edited, [{ op: 'set_fits', fits: { spare: null } }]).scene.fits).toEqual({ tackle: `${RIFTER_FIT}\nStasis Webifier II` });
    expect(catchSceneError(() => applySceneOperations(edited, [{ op: 'set_fits', fits: { tackle: null } }])).problems).toEqual(['operations[0]: fit "tackle" is used by ship "r"; change or clear those ships\' fit first']);
    const emptied = applySceneOperations(normalizeScene({ fits: { spare: RIFTER_FIT } }).scene, [{ op: 'set_fits', fits: { spare: null } }]).scene;
    expect(emptied.fits).toBeUndefined();
  });
});
