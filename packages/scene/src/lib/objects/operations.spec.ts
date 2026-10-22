import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { applySceneOperations, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import type { SceneObject } from './object';

const ASTRA = 'cm1_t1:upwell:generic';
const WRECK = 'wreck_s:genericbase:generic';
const RIFTER = 'mf4_t1:minmatarbase:minmatar';
const ASTRAHUS = { op: 'add_objects', type: 'Astrahus', dna: ASTRA, radius: 45000 };
const WRECKS = { op: 'add_objects', type: 'Minmatar Frigate Wreck', dna: WRECK, radius: 14 };
const BASE = { name: 'objects', ships: [{ id: 'rifter', dna: RIFTER, rotation: [90, 0, 0] }] };

function scene(input: unknown = BASE): SceneDocument {
  return normalizeScene(input).scene;
}

function apply(before: SceneDocument, ...operations: unknown[]): ReturnType<typeof applySceneOperations> {
  return applySceneOperations(before, operations);
}

function problems(before: SceneDocument, ...operations: unknown[]): string[] {
  return catchSceneError(() => apply(before, ...operations)).problems;
}

function object(document: SceneDocument, id: string): SceneObject {
  const found = document.objects?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no object ${id}`);
  return found;
}

describe('add_object', () => {
  it('adds one object as given and refuses taken ids', () => {
    const before = scene();
    const { scene: after } = apply(before, { op: 'add_object', object: { id: 'astra', dna: ASTRA, position: [0, 0, 100000] } });
    expect(after.objects).toEqual([{ id: 'astra', dna: ASTRA, position: [0, 0, 100000], rotation: [0, 0, 0] }]);
    expect(problems(after, { op: 'add_object', object: { id: 'astra', dna: ASTRA } })).toEqual(['operations[0]: object "astra" already exists']);
    expect(problems(after, { op: 'add_object', object: { id: 'rifter', dna: ASTRA } })).toEqual(['operations[0]: "rifter" is a ship\'s id; ids are unique across ships and objects']);
    expect(diffScenes(before, after).objects.added.map((added) => added.id)).toEqual(['astra']);
  });
});

describe('add_objects', () => {
  it('numbers ids after the highest over ships and objects, and names them', () => {
    const before = scene({ ...BASE, ships: [...BASE.ships, { id: 'astrahus-03', dna: RIFTER, position: [0, 0, -9e5] }], objects: [{ id: 'astrahus-02', dna: ASTRA, position: [0, 0, 9e5] }] });
    const { scene: after } = apply(before, { ...ASTRAHUS, count: 2, formation: 'line', position: [0, 0, 400000] });
    expect(after.objects?.slice(1).map((added) => [added.id, added.name])).toEqual([
      ['astrahus-04', 'Astrahus 4'],
      ['astrahus-05', 'Astrahus 5']
    ]);
    expect(object(after, 'astrahus-04')).toMatchObject({ type: 'Astrahus', dna: ASTRA, radius: 45000, position: [0, 0, 400000] });
  });

  it('takes an explicit id and name, refusing id with count', () => {
    const { scene: after } = apply(scene(), { ...ASTRAHUS, id: 'astra', position: [0, 0, 100000] }, { op: 'add_objects', dna: WRECK, type: 26550, position: [0, 0, -5000] });
    expect(object(after, 'astra').name).toBe('Astrahus');
    expect(object(after, 'wreck_s-01')).toMatchObject({ name: 'type 26550 1', type: 26550 });
    expect(problems(scene(), { ...ASTRAHUS, id: 'astra', count: 2 })[0]).toMatch(/id names one object/u);
    expect(problems(scene(), { ...ASTRAHUS, id: 'rifter' })[0]).toMatch(/is a ship's id/u);
  });

  it('places off a ship and an object, surface to surface, with their yaw', () => {
    const { scene: after } = apply(scene(), { ...ASTRAHUS, id: 'astra', near: { ship: 'rifter', range: 30000 }, radii: { rifter: 31 } }, { ...WRECKS, id: 'wreck', near: { object: 'astra', range: 3000, direction: 'behind' } });
    expect(object(after, 'astra')).toMatchObject({ position: [75031, 0, 0], rotation: [90, 0, 0] });
    expect(object(after, 'wreck')).toMatchObject({ position: [75031 - 48014, 0, 0], rotation: [90, 0, 0] });
    expect(problems(scene(), { ...ASTRAHUS, near: { ship: 'rifter', object: 'x' } })[0]).toMatch(/give ship or object, not both/u);
    expect(problems(scene(), { ...ASTRAHUS, near: { ship: 'rifter', direction: 'sun' } })[0]).toMatch(/sun/u);
  });

  it('turns with rotation, heading or facing a point, a ship or an object', () => {
    const before = apply(scene(), { ...ASTRAHUS, id: 'astra', position: [100000, 0, 0] }).scene;
    const turned = apply(before, { ...WRECKS, id: 'r', rotation: [10, 20, 30] }, { ...WRECKS, id: 'h', heading: -90 }, { ...WRECKS, id: 'p', facing: [0, 0, 1000] }, { ...WRECKS, id: 's', position: [0, 0, 1000], facing: 'rifter' }, { ...WRECKS, id: 'o', facing: 'astra' }).scene;
    expect(['r', 'h', 'p', 's', 'o'].map((id) => object(turned, id).rotation)).toEqual([
      [10, 20, 30],
      [-90, 0, 0],
      [0, 0, 0],
      [180, 0, 0],
      [90, 0, 0]
    ]);
    expect(problems(before, { ...WRECKS, facing: [0, 1000, 0] })[0]).toMatch(/straight above or below/u);
    expect(problems(before, { ...WRECKS, heading: 0, rotation: [0, 0, 0] })[0]).toMatch(/give one of rotation, heading, not several/u);
  });

  it('lays out formations with the default spacing, at most 100 a line', () => {
    const { scene: after } = apply(scene(), { ...WRECKS, count: 3, formation: 'line', position: [0, 0, 5000] });
    const xs = (after.objects ?? []).map((added) => added.position[0]);
    expect(xs).toEqual([0, 142, -142]);
    expect(problems(scene(), { ...WRECKS, count: 101 })[0]).toMatch(/count must be a finite number in \[1, 100\]/u);
  });

  it('refuses a missing dna and a celestial with the tool hints', () => {
    expect(problems(scene(), { op: 'add_objects', type: 'Astrahus' })[0]).toBe('operations[0]: type "Astrahus" has no dna. The add_objects tool resolves type names to DNA through tools-core; patch_scene needs dna.');
    expect(problems(scene(), { ...ASTRAHUS, near: { celestial: 'Jita IV' } })[0]).toMatch(/add_objects tool resolves a celestial/u);
    expect(problems(scene(), { ...ASTRAHUS, facing: { celestial: 'Jita IV' } })[0]).toMatch(/add_objects tool resolves \{ celestial \}/u);
  });

  it('warns about overlaps, far placements and a missing radius; refuses past 10,000 km', () => {
    const { warnings } = apply(scene(), { ...ASTRAHUS, id: 'astra', position: [1000, 0, 0] }, { op: 'add_objects', dna: WRECK, position: [3e6, 0, 0] });
    expect(warnings).toEqual([
      'operations[0]: astra overlaps ships "rifter" (inside its 45,000 m radius); place it elsewhere',
      'operations[1]: no radius; the page uses the SOF bounding radius once built (spacing assumed 1000 m). The add_objects tool fills the SDE radius from a type',
      'operations[1]: 1 object is more than 2,000 km from the scene origin; scenes rarely use more than 2,000 km (the limit is 10,000 km)'
    ]);
    expect(problems(scene(), { ...ASTRAHUS, position: [0, 0, 12e6] })[0]).toMatch(/objects\[0\]\.position is 12,000 km from the scene origin/u);
  });
});

describe('update_object, move_object and remove_object', () => {
  const placed = (): SceneDocument => apply(scene(), { ...ASTRAHUS, id: 'astra', name: 'Astra', position: [0, 0, 100000] }).scene;

  it('replaces values, clears with null, and refuses an id change or unknown id', () => {
    const { scene: after } = apply(placed(), { op: 'update_object', id: 'astra', set: { dna: 'cl1_t1:upwell:generic', name: null, radius: null, rotation: [45, 0, 0] } });
    expect(object(after, 'astra')).toEqual({ id: 'astra', dna: 'cl1_t1:upwell:generic', type: 'Astrahus', position: [0, 0, 100000], rotation: [45, 0, 0] });
    expect(diffScenes(placed(), after).objects.rebuilt.map((rebuilt) => rebuilt.id)).toEqual(['astra']);
    expect(problems(placed(), { op: 'update_object', id: 'astra', set: { id: 'b' } })[0]).toMatch(/id cannot be changed/u);
    expect(problems(placed(), { op: 'update_object', id: 'nope', set: {} })[0]).toBe('operations[0]: no object "nope"');
  });

  it('moves off a ship, keeping the rotation unless turned', () => {
    const { scene: after } = apply(placed(), { op: 'move_object', id: 'astra', near: { ship: 'rifter', range: 0 } });
    expect(object(after, 'astra')).toMatchObject({ position: [45000, 0, 0], rotation: [0, 0, 0] });
    expect(diffScenes(placed(), after).objects.moved.map((moved) => moved.id)).toEqual(['astra']);
    const faced = apply(placed(), { op: 'move_object', id: 'astra', facing: 'rifter' }).scene;
    expect(object(faced, 'astra')).toMatchObject({ position: [0, 0, 100000], rotation: [180, 0, 0] });
    expect(problems(placed(), { op: 'move_object', id: 'astra' })[0]).toMatch(/give position or near/u);
  });

  it('removes one, clearing the camera target', () => {
    const before = apply(placed(), { op: 'set_camera', camera: { target: 'astra' } }).scene;
    const { scene: after } = apply(before, { op: 'remove_object', id: 'astra' });
    expect(after.objects).toBeUndefined();
    expect(after.camera.target).toBeNull();
    expect(diffScenes(before, after).objects.removed.map((removed) => removed.id)).toEqual(['astra']);
  });
});

describe('objects and staging in one patch', () => {
  it('stages ships off an object added earlier in the patch, facing it', () => {
    const { scene: after } = apply(scene(), { ...ASTRAHUS, id: 'astra', position: [0, 0, 200000] }, { op: 'add_ships', dna: RIFTER, hull: 'Rifter', radius: 31, count: 3, near: { object: 'astra' }, facing: 'astra' });
    const ships = after.ships.filter((ship) => ship.id.startsWith('rifter-'));
    expect(ships).toHaveLength(3);
    expect(ships[0].position).toEqual([0, 0, 250031]);
    expect(ships[0].rotation[0]).toBe(180);
  });
});
