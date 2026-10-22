import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { normalizeScene } from '../scene';
import { diffSceneObjects, normalizeSceneObjects, type SceneObject } from './object';

const ASTRA = 'cm1_t1:upwell:generic';
const RIFTER = 'mf4_t1:minmatarbase:minmatar';

describe('normalizeSceneObjects', () => {
  it('fills defaults and writes keys in canonical order', () => {
    const { objects, problems, warnings } = normalizeSceneObjects({ input: [{ radius: 45000, name: 'Astra', dna: ASTRA, id: 'astra', type: 'Astrahus', colour: 'red' }], shipIds: new Set() });
    expect(problems).toEqual([]);
    expect(warnings).toEqual(['objects[0].colour is not a known field and was dropped']);
    expect(objects).toEqual([{ id: 'astra', dna: ASTRA, type: 'Astrahus', name: 'Astra', position: [0, 0, 0], rotation: [0, 0, 0], radius: 45000 }]);
    expect(Object.keys(objects?.[0] ?? {})).toEqual(['id', 'dna', 'type', 'name', 'position', 'rotation', 'radius']);
    expect(normalizeSceneObjects({ input: [], shipIds: new Set() }).objects).toBeNull();
    expect(normalizeSceneObjects({ input: undefined, shipIds: new Set() }).objects).toBeNull();
  });

  it('refuses bad ids, duplicates, ship ids, dna, radii, types and far positions', () => {
    const { problems } = normalizeSceneObjects({
      input: [{ id: 'a b', dna: ASTRA }, { id: 'x', dna: ASTRA }, { id: 'x', dna: ASTRA }, { id: 'rifter', dna: ASTRA }, { id: 'y', dna: 'cm1_t1' }, { id: 'z', dna: ASTRA, radius: 0, type: -3, position: [0, 0, 2e7] }, 'w'],
      shipIds: new Set(['rifter'])
    });
    expect(problems).toEqual([
      'objects[0].id must be 1-64 letters, digits, "_", "-" or "."',
      'objects[2].id "x" is used more than once',
      'objects[3].id "rifter" is a ship\'s id; ids are unique across ships and objects',
      'objects[4].dna "cm1_t1" is not hull:faction:race[:commands]',
      'objects[5].type must be a positive integer type id or an EVE type name',
      'objects[5].position is 20,000 km from the scene origin; a scene spans at most 10,000 km around its origin, as an EVE grid does; place it closer, or move the origin there with set_location',
      'objects[5].radius must be a finite number of metres above 0',
      'objects[6] must be an object'
    ]);
    expect(normalizeSceneObjects({ input: {}, shipIds: new Set() }).problems).toEqual(['objects must be an array']);
  });

  it('lets camera.target name an object in a scene', () => {
    const scene = normalizeScene({ ships: [{ id: 'rifter', dna: RIFTER }], objects: [{ id: 'astra', dna: ASTRA, type: 35832 }], camera: { target: 'astra' } }).scene;
    expect(scene.camera.target).toBe('astra');
    expect(scene.objects?.[0].type).toBe(35832);
    expect(normalizeScene(scene).scene).toEqual(scene);
    expect(catchSceneError(() => normalizeScene({ camera: { target: 'nobody' } })).problems).toEqual(['camera.target "nobody" is not a ship or object id']);
  });
});

describe('diffSceneObjects', () => {
  const base: SceneObject = { id: 'a', dna: ASTRA, position: [0, 0, 0], rotation: [0, 0, 0], radius: 45000 };

  it('sorts added, removed, rebuilt, moved and resized objects', () => {
    const before: SceneObject[] = [base, { ...base, id: 'b' }, { ...base, id: 'c' }, { ...base, id: 'd' }];
    const after: SceneObject[] = [
      { ...base, dna: 'cl1_t1:upwell:generic' },
      { ...base, id: 'b', rotation: [90, 0, 0] },
      { ...base, id: 'c', radius: 1 },
      { ...base, id: 'e' }
    ];
    const diff = diffSceneObjects(before, after);
    expect(diff.added.map((object) => object.id)).toEqual(['e']);
    expect(diff.removed.map((object) => object.id)).toEqual(['d']);
    expect(diff.rebuilt.map((object) => object.id)).toEqual(['a']);
    expect(diff.moved.map((object) => object.id)).toEqual(['b']);
    expect(diff.resized.map((object) => object.id)).toEqual(['c']);
  });

  it('needs nothing for a name or type edit', () => {
    const diff = diffSceneObjects([base], [{ ...base, name: 'Astra', type: 'Astrahus' }]);
    expect(Object.values(diff).every((list) => list.length === 0)).toBe(true);
  });
});
