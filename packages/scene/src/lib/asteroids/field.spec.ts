import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { normalizeScene } from '../scene';
import { DARK_OCHRE_ROCKS, rockSet, VELDSPAR_ROCKS } from './asteroids.spec-helper';
import { ASTEROID_FIELDS_NOT_DRAWN_WARNING, defaultAsteroidFieldSeed, defaultRockSize, diffAsteroidFields, normalizeAsteroidFields, type SceneAsteroidField } from './field';

const VELDSPAR = { ore: 'Veldspar', type: 1230, faction: 'ore_veldspar', rocks: VELDSPAR_ROCKS };

function normalize(input: unknown, takenIds: Iterable<string> = []): ReturnType<typeof normalizeAsteroidFields> {
  return normalizeAsteroidFields({ input, takenIds: new Set(takenIds) });
}

describe('normalizeAsteroidFields', () => {
  it('fills defaults, the seed from the id, and writes keys in canonical order', () => {
    const { fields, problems, warnings } = normalize([{ ores: [{ rocks: VELDSPAR_ROCKS, weight: 1, faction: 'ore_veldspar', ore: 'Veldspar', colour: 'grey' }], id: 'belt', glow: true }]);
    expect(problems).toEqual([]);
    expect(warnings).toEqual(['asteroidFields[0].glow is not a known field and was dropped', 'asteroidFields[0].ores[0].colour is not a known field and was dropped']);
    expect(fields).toEqual([{ id: 'belt', position: [0, 0, 0], rotation: [0, 0, 0], shape: 'sphere', radius: 20000, count: 150, size: [300, 3000], seed: defaultAsteroidFieldSeed('belt'), ores: [{ ore: 'Veldspar', faction: 'ore_veldspar', rocks: VELDSPAR_ROCKS }] }]);
    expect(Object.keys(fields?.[0] ?? {})).toEqual(['id', 'position', 'rotation', 'shape', 'radius', 'count', 'size', 'seed', 'ores']);
    expect(defaultAsteroidFieldSeed('belt')).not.toBe(defaultAsteroidFieldSeed('belt-2'));
    expect(Number.isInteger(defaultAsteroidFieldSeed('belt'))).toBe(true);
    expect(normalize([]).fields).toBeNull();
    expect(normalize(undefined).fields).toBeNull();
  });

  it('keeps every key in order, expands a flat rock list, and drops disc keys on a sphere', () => {
    const flat = VELDSPAR_ROCKS.medium;
    const { fields, problems } = normalize([{ id: 'disc', name: 'Disc', position: [0, 0, 60000], rotation: [30, 0, 10], shape: 'disc', radius: 30000, innerRadius: 5000, thickness: 6000, arc: 180, count: 300, size: [200, 2000], seed: 7, ores: [{ ...VELDSPAR, weight: 2 }, { rocks: flat }] }]);
    expect(problems).toEqual([]);
    expect(Object.keys(fields?.[0] ?? {})).toEqual(['id', 'name', 'position', 'rotation', 'shape', 'radius', 'innerRadius', 'thickness', 'arc', 'count', 'size', 'seed', 'ores']);
    expect(Object.keys(fields?.[0].ores[0] ?? {})).toEqual(['ore', 'type', 'faction', 'weight', 'rocks']);
    expect(fields?.[0].ores[1]).toEqual({ rocks: { small: flat, medium: flat, large: flat } });
    const sphere = normalize([{ id: 's', thickness: 100, arc: 90, ores: [VELDSPAR] }]);
    expect(sphere.warnings).toEqual(['asteroidFields[0].thickness applies to a disc or ring, not a sphere, and was dropped', 'asteroidFields[0].arc applies to a disc or ring, not a sphere, and was dropped']);
    expect(sphere.fields?.[0].thickness).toBeUndefined();
  });

  it('caps the default rock size on a small field', () => {
    expect(defaultRockSize(20000)).toEqual([300, 3000]);
    expect(defaultRockSize(4000)).toEqual([300, 1000]);
    expect(defaultRockSize(800)).toEqual([200, 200]);
    expect(normalize([{ id: 'small', radius: 4000, ores: [VELDSPAR] }]).fields?.[0].size).toEqual([300, 1000]);
  });

  it('refuses taken ids, bad shapes, sizes, counts, seeds, ores and rocks', () => {
    const { problems } = normalize(
      [
        { id: 'rifter', ores: [VELDSPAR] },
        { id: 'astra', ores: [VELDSPAR] },
        { id: 'x', ores: [VELDSPAR] },
        { id: 'x', ores: [VELDSPAR] },
        { id: 'a b', shape: 'cube', radius: 0, ores: [VELDSPAR] },
        { id: 'inner', radius: 1000, innerRadius: 1000, size: [10, 100], ores: [VELDSPAR] },
        { id: 'counts', count: 0, ores: [VELDSPAR] },
        { id: 'counts2', count: 2001, seed: 2 ** 32, ores: [VELDSPAR] },
        { id: 'counts3', count: 1.5, seed: -1, ores: [VELDSPAR] },
        { id: 'size', size: [3000, 300], ores: [VELDSPAR] },
        { id: 'size2', radius: 1000, size: [100, 1000], ores: [VELDSPAR] },
        { id: 'size3', size: [300], ores: [VELDSPAR] },
        { id: 'none', ores: [] },
        { id: 'nine', ores: Array.from({ length: 9 }, () => VELDSPAR) },
        { id: 'dna', ores: [{ rocks: ['rock_01'] }] },
        { id: 'empty', ores: [{ rocks: { small: [], medium: VELDSPAR_ROCKS.medium, large: VELDSPAR_ROCKS.large } }] },
        { id: 'weight', ores: [{ ...VELDSPAR, weight: 0, type: 'Veldspar' }] },
        'w'
      ],
      ['rifter', 'astra']
    );
    expect(problems).toEqual([
      'asteroidFields[0].id "rifter" is a ship\'s or object\'s id; ids are unique across ships, objects and asteroid fields',
      'asteroidFields[1].id "astra" is a ship\'s or object\'s id; ids are unique across ships, objects and asteroid fields',
      'asteroidFields[3].id "x" is used more than once',
      'asteroidFields[4].id must be 1-64 letters, digits, "_", "-" or "."',
      'asteroidFields[4].shape must be one of sphere, disc, ring',
      'asteroidFields[4].radius must be a number of metres above 0 to 1,000,000',
      'asteroidFields[5].innerRadius 1000 m must be under the radius (1000 m)',
      'asteroidFields[6].count must be a whole number from 1 to 2,000',
      'asteroidFields[7].count must be a whole number from 1 to 2,000',
      'asteroidFields[7].seed must be a whole number from 0 to 4294967295',
      'asteroidFields[8].count must be a whole number from 1 to 2,000',
      'asteroidFields[8].seed must be a whole number from 0 to 4294967295',
      'asteroidFields[9].size must be [min, max] with 1 <= min <= max <= 50,000 m',
      'asteroidFields[10].size: the largest rock (1000 m) must be smaller than the field radius (1000 m)',
      'asteroidFields[11].size must be [min, max] rock radii in metres',
      'asteroidFields[12].ores must be a list of 1 to 8 ores, each with rocks',
      'asteroidFields[13].ores must be a list of 1 to 8 ores, each with rocks',
      'asteroidFields[14].ores[0].rocks[0] "rock_01" is not hull:faction:race[:commands]',
      'asteroidFields[15].ores[0].rocks.small must be a non-empty list of rock DNAs (hull:faction:asteroid)',
      'asteroidFields[16].ores[0].type must be a positive integer type id',
      'asteroidFields[16].ores[0].weight must be a number above 0',
      'asteroidFields[17] must be an object'
    ]);
    expect(normalize({}).problems).toEqual(['asteroidFields must be an array']);
  });

  it('refuses more than 48 models and a field reaching past the scene extent', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ rocks: rockSet(`rock_0${letter}_%_grey`, 'ore_x') }));
    expect(normalize([{ id: 'many', ores: many }]).problems).toEqual(['asteroidFields[0].ores use 60 distinct rock models; a field draws at most 48 (each is one SOF build); use fewer ores or fewer models per ore']);
    expect(normalize([{ id: 'far', position: [0, 0, 9_990_000], radius: 20000, ores: [VELDSPAR] }]).problems).toEqual([
      'asteroidFields[0] reaches 10,000 km from the scene origin (centre, radius and largest rock); a scene spans at most 10,000 km around its origin; place it closer, shrink it, or move the origin there with set_location'
    ]);
    expect(normalize([{ id: 'edge', position: [0, 0, 9_970_000], radius: 20000, ores: [VELDSPAR] }]).problems).toEqual([]);
  });
});

describe('asteroidFields in a scene', () => {
  const field = { id: 'belt', ores: [VELDSPAR] };

  it('round-trips, lets camera.target name a field, and warns it is not drawn yet', () => {
    const { scene, warnings } = normalizeScene({ ships: [{ id: 'rifter', dna: 'mf4_t1:minmatarbase:minmatar' }], asteroidFields: [field], camera: { target: 'belt' } });
    expect(scene.camera.target).toBe('belt');
    expect(warnings).toContain(ASTEROID_FIELDS_NOT_DRAWN_WARNING);
    expect(normalizeScene(scene).scene).toEqual(scene);
    expect(normalizeScene({}).warnings).not.toContain(ASTEROID_FIELDS_NOT_DRAWN_WARNING);
    expect(catchSceneError(() => normalizeScene({ ships: [{ id: 'belt', dna: 'mf4_t1:minmatarbase:minmatar' }], asteroidFields: [field] })).problems).toEqual(['asteroidFields[0].id "belt" is a ship\'s or object\'s id; ids are unique across ships, objects and asteroid fields']);
  });
});

describe('diffAsteroidFields', () => {
  const base = normalize([{ id: 'a', ores: [VELDSPAR] }]).fields?.[0] as SceneAsteroidField;

  it('sorts added, removed, rebuilt and moved fields; a name change does nothing', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...base, id }));
    const after: SceneAsteroidField[] = [
      { ...base, seed: 1 },
      { ...base, id: 'b', position: [0, 0, 1000] },
      { ...base, id: 'c', name: 'Renamed' },
      { ...base, id: 'd', ores: [{ rocks: DARK_OCHRE_ROCKS }] },
      { ...base, id: 'f' }
    ];
    const diff = diffAsteroidFields(before, after);
    expect(diff.added.map((field) => field.id)).toEqual(['f']);
    expect(diff.removed.map((field) => field.id)).toEqual(['e']);
    expect(diff.rebuilt.map((field) => field.id)).toEqual(['a', 'd']);
    expect(diff.moved.map((field) => field.id)).toEqual(['b']);
  });

  it('rebuilds on every rock key', () => {
    const changes: Partial<SceneAsteroidField>[] = [{ shape: 'disc' }, { radius: 30000 }, { innerRadius: 10 }, { thickness: 10 }, { arc: 90 }, { count: 151 }, { size: [300, 2000] }, { seed: 9 }];
    for (const change of changes) expect(diffAsteroidFields([base], [{ ...base, ...change }]).rebuilt).toHaveLength(1);
    expect(diffAsteroidFields([base], [{ ...base, rotation: [10, 0, 0] }]).moved).toHaveLength(1);
  });
});
