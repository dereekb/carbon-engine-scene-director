import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { applySceneOperations, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import { BLUE_ICE_ROCKS, DARK_OCHRE_ROCKS, VELDSPAR_ROCKS } from './asteroids.spec-helper';
import { expandAsteroidField } from './expand';
import { defaultAsteroidFieldSeed, type SceneAsteroidField } from './field';

const RIFTER = 'mf4_t1:minmatarbase:minmatar';
const ASTRA = 'cm1_t1:upwell:generic';
const VELDSPAR = { ore: 'Veldspar', type: 1230, faction: 'ore_veldspar', rocks: VELDSPAR_ROCKS };
const DARK_OCHRE = { ore: 'Dark Ochre', faction: 'crystal_darkochre', rocks: DARK_OCHRE_ROCKS };
const BASE = { name: 'fields', ships: [{ id: 'rifter', dna: RIFTER, rotation: [90, 0, 0] }], objects: [{ id: 'astra', dna: ASTRA, position: [0, 0, -200000], radius: 45000 }] };

function scene(input: unknown = BASE): SceneDocument {
  return normalizeScene(input).scene;
}

function apply(before: SceneDocument, ...operations: unknown[]): ReturnType<typeof applySceneOperations> {
  return applySceneOperations(before, operations);
}

function problems(before: SceneDocument, ...operations: unknown[]): string[] {
  return catchSceneError(() => apply(before, ...operations)).problems;
}

function field(document: SceneDocument, id: string): SceneAsteroidField {
  const found = document.asteroidFields?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('add_asteroid_field', () => {
  it('adds a field at a position with a default name, id and seed', () => {
    const { scene: after } = apply(scene(), { op: 'add_asteroid_field', ores: [VELDSPAR, DARK_OCHRE], position: [0, 0, 100000], shape: 'disc', count: 120, rotation: [10, 0, 0] });
    expect(after.asteroidFields).toEqual([{ id: 'veldspar-01', name: 'Veldspar and Dark Ochre field', position: [0, 0, 100000], rotation: [10, 0, 0], shape: 'disc', radius: 20000, count: 120, size: [300, 3000], seed: defaultAsteroidFieldSeed('veldspar-01'), ores: [VELDSPAR, DARK_OCHRE] }]);
    const { scene: third } = apply(after, { op: 'add_asteroid_field', ores: [{ rocks: BLUE_ICE_ROCKS }], position: [0, 0, 300000], name: 'Ice' }, { op: 'add_asteroid_field', ores: [{ rocks: BLUE_ICE_ROCKS }], position: [0, 0, 400000] });
    expect(third.asteroidFields?.map((each) => [each.id, each.name])).toEqual([
      ['veldspar-01', 'Veldspar and Dark Ochre field'],
      ['ice-01', 'Ice'],
      ['asteroid-field-01', 'Asteroid field']
    ]);
  });

  it('places a field near a ship from its surface to the field edge, turned to the ship', () => {
    const { scene: after } = apply(scene(), { op: 'add_asteroid_field', id: 'belt', ores: [VELDSPAR], radius: 30000, near: { ship: 'rifter', range: 20000 }, radii: { rifter: 50 } });
    const belt = field(after, 'belt');
    expect(distance(belt.position, [0, 0, 0])).toBeCloseTo(50 + 20000 + 30000, 3);
    expect(belt.rotation).toEqual([90, 0, 0]);
    const behind = field(apply(scene(), { op: 'add_asteroid_field', id: 'b', ores: [VELDSPAR], near: { object: 'astra', range: 5000, direction: 'behind' }, heading: 45 }).scene, 'b');
    expect(distance(behind.position, [0, 0, -200000])).toBeCloseTo(45000 + 5000 + 20000, 3);
    expect(behind.rotation).toEqual([45, 0, 0]);
    const facing = field(apply(scene(), { op: 'add_asteroid_field', id: 'c', ores: [VELDSPAR], position: [100000, 0, 0], facing: 'rifter' }).scene, 'c');
    expect(facing.rotation[0]).toBeCloseTo(-90, 6);
  });

  it('refuses a celestial near, an ore without rocks and taken ids', () => {
    expect(problems(scene(), { op: 'add_asteroid_field', ores: [VELDSPAR], near: { celestial: 'Perimeter II - Asteroid Belt 1' } })).toEqual(["operations[0].near.celestial: the add_asteroid_field tool resolves a celestial of the scene's location to a position; patch_scene takes near.ship, near.object or a position"]);
    expect(problems(scene(), { op: 'add_asteroid_field', ores: [{ ore: 'Veldspar' }, 'Scordite'] })).toEqual([
      'operations[0].ores[0] "Veldspar" has no rocks. The add_asteroid_field tool resolves ore names to SOF rock models through tools-core; patch_scene needs rocks',
      'operations[0].ores[1] "Scordite" has no rocks. The add_asteroid_field tool resolves ore names to SOF rock models through tools-core; patch_scene needs { rocks }'
    ]);
    expect(problems(scene(), { op: 'add_asteroid_field', id: 'rifter', ores: [VELDSPAR] })).toEqual(['operations[0].id "rifter" is a ship\'s or object\'s id; ids are unique across ships, objects and asteroid fields']);
    const withField = apply(scene(), { op: 'add_asteroid_field', id: 'belt', ores: [VELDSPAR], position: [0, 0, 100000] }).scene;
    expect(problems(withField, { op: 'add_asteroid_field', id: 'belt', ores: [VELDSPAR] })).toEqual(['operations[0].id: asteroid field "belt" already exists']);
  });

  it('makes ship, object and composition ids skip field ids', () => {
    const withField = apply(scene(), { op: 'add_asteroid_field', id: 'rifter-02', ores: [VELDSPAR], position: [0, 0, 100000] }, { op: 'add_asteroid_field', id: 'astrahus-01', ores: [VELDSPAR], position: [0, 0, 150000] }).scene;
    const ships = apply(withField, { op: 'add_ships', dna: RIFTER, hull: 'Rifter', count: 2, position: [0, 0, -50000] }).scene;
    expect(ships.ships.map((ship) => ship.id)).toEqual(['rifter', 'rifter-03', 'rifter-04']);
    const objects = apply(withField, { op: 'add_objects', type: 'Astrahus', dna: ASTRA, radius: 45000, position: [0, 500000, 0] }).scene;
    expect(objects.objects?.map((object) => object.id)).toEqual(['astra', 'astrahus-02']);
  });

  it('warns about a far field, ships inside it, a shortfall and oversized rocks', () => {
    const far = apply(scene(), { op: 'add_asteroid_field', ores: [VELDSPAR], position: [0, 0, 3_000_000] });
    expect(far.warnings).toContain('operations[0]: 1 asteroid field is more than 2,000 km from the scene origin; scenes rarely use more than 2,000 km (the limit is 10,000 km)');
    const around = apply(scene(), { op: 'add_asteroid_field', id: 'around', ores: [VELDSPAR], position: [0, 0, 1000] });
    expect(around.warnings.find((warning) => warning.includes('sit inside'))).toMatch(/^operations\[0\]: ships "rifter" sit inside asteroid field "around" \(2\d km\); its rocks draw through them$/u);
    const dense = apply(scene(), { op: 'add_asteroid_field', ores: [VELDSPAR], position: [0, 0, 100000], radius: 4000, size: [1000, 1200], count: 200 });
    expect(dense.warnings.find((warning) => warning.includes('without overlap'))).toMatch(/^operations\[0\]: placed \d+ of 200 rocks without overlap; widen the field, shrink size or lower count$/u);
    expect(dense.warnings).toContain('operations[0]: the largest rock (1200 m) is over a quarter of the field radius (4000 m); the field will look like a few boulders');
  });
});

describe('update_asteroid_field and remove_asteroid_field', () => {
  const withField = (): SceneDocument => apply(scene(), { op: 'add_asteroid_field', id: 'belt', name: 'Belt', ores: [VELDSPAR], position: [0, 0, 100000], shape: 'disc', thickness: 4000, arc: 180 }).scene;

  it('merges, clears with null, replaces ores whole and refuses an id change', () => {
    const { scene: after } = apply(withField(), { op: 'update_asteroid_field', id: 'belt', set: { count: 90, thickness: null, arc: null, name: null, ores: [DARK_OCHRE] } });
    const belt = field(after, 'belt');
    expect(belt.count).toBe(90);
    expect(belt.thickness).toBeUndefined();
    expect(belt.arc).toBeUndefined();
    expect(belt.name).toBeUndefined();
    expect(belt.ores).toEqual([DARK_OCHRE]);
    expect(problems(withField(), { op: 'update_asteroid_field', id: 'belt', set: { id: 'b2' } })).toEqual(["operations[0]: an asteroid field's id cannot be changed; remove and add it instead"]);
    expect(problems(withField(), { op: 'update_asteroid_field', id: 'nope', set: {} })).toEqual(['operations[0]: no asteroid field "nope"']);
    expect(problems(withField(), { op: 'update_asteroid_field', id: 'belt', set: { count: 0 } })).toEqual(['asteroidFields[0].count must be a whole number from 1 to 2,000']);
  });

  it('reports moved and rebuilt fields through diffScenes', () => {
    const before = withField();
    const moved = apply(before, { op: 'update_asteroid_field', id: 'belt', set: { position: [0, 0, 120000], rotation: [0, 20, 0] } }).scene;
    expect(diffScenes(before, moved).asteroidFields.moved.map((each) => each.id)).toEqual(['belt']);
    const rebuilt = apply(before, { op: 'update_asteroid_field', id: 'belt', set: { seed: 11 } }).scene;
    expect(diffScenes(before, rebuilt).asteroidFields.rebuilt.map((each) => each.id)).toEqual(['belt']);
    const renamed = apply(before, { op: 'update_asteroid_field', id: 'belt', set: { name: 'New' } }).scene;
    expect(diffScenes(before, renamed).asteroidFields).toEqual({ added: [], removed: [], rebuilt: [], moved: [] });
    expect(diffScenes(scene(), before).asteroidFields.added.map((each) => each.id)).toEqual(['belt']);
    expect(expandAsteroidField(field(rebuilt, 'belt')).digest).not.toBe(expandAsteroidField(field(before, 'belt')).digest);
  });

  it('removes a field and clears camera.target', () => {
    const targeted = apply(withField(), { op: 'set_camera', camera: { target: 'belt' } }).scene;
    expect(targeted.camera.target).toBe('belt');
    const { scene: after } = apply(targeted, { op: 'remove_asteroid_field', id: 'belt' });
    expect(after.asteroidFields).toBeUndefined();
    expect(after.camera.target).toBeNull();
    expect(diffScenes(targeted, after).asteroidFields.removed.map((each) => each.id)).toEqual(['belt']);
    expect(problems(after, { op: 'remove_asteroid_field', id: 'belt' })).toEqual(['operations[0]: no asteroid field "belt"']);
  });
});
