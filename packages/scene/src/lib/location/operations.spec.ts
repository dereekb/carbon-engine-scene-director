import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { applySceneOperations, createEmptyScene, normalizeScene, type SceneDocument } from '../scene';
import { CNAP_LOCATION, JITA } from './location.spec-helper';

const RIFTER = { id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', position: [100, 0, 0] };
const base = (): SceneDocument => normalizeScene({ name: 'loc', ships: [RIFTER] }).scene;

describe('location operations', () => {
  it('set_location adds a location and replaces it whole', () => {
    const set = applySceneOperations(base(), [{ op: 'set_location', location: CNAP_LOCATION }]).scene;
    expect(set.location).toEqual(CNAP_LOCATION);
    expect(set.ships[0].position).toEqual([100, 0, 0]);

    const replaced = applySceneOperations(set, [{ op: 'set_location', location: { system: JITA, origin: [1, 2, 3] } }]).scene;
    expect(replaced.location).toEqual({ system: JITA, origin: [1, 2, 3] });
  });

  it('refuses a location that is not an object or not valid', () => {
    expect(catchSceneError(() => applySceneOperations(base(), [{ op: 'set_location', location: 'Jita' }])).problems).toEqual(['operations[0].location must be an object; clear_location removes the location']);
    const problems = catchSceneError(() => applySceneOperations(base(), [{ op: 'set_location', location: { system: JITA } }])).problems;
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(problem.startsWith('location.')).toBe(true);
  });

  it('clear_location removes it, and is a silent no-op without one', () => {
    const set = applySceneOperations(base(), [{ op: 'set_location', location: CNAP_LOCATION }]).scene;
    expect('location' in applySceneOperations(set, [{ op: 'clear_location' }]).scene).toBe(false);
    const cleared = applySceneOperations(base(), [{ op: 'clear_location' }]);
    expect('location' in cleared.scene).toBe(false);
    expect(cleared.warnings).toEqual([]);
  });

  it('composes with other operations and leaves the input alone', () => {
    const scene = createEmptyScene('loc');
    const before = structuredClone(scene);
    const edited = applySceneOperations(scene, [
      { op: 'add_ship', ship: RIFTER },
      { op: 'set_location', location: CNAP_LOCATION },
      { op: 'set_environment', environment: { universe: 'res:/dx9/scene/universe/c02_cube.black' } }
    ]).scene;
    expect(edited.location).toEqual(CNAP_LOCATION);
    expect(edited.environment.universe).toBe('res:/dx9/scene/universe/c02_cube.black');
    expect(edited.ships.map((ship) => ship.id)).toEqual(['rifter']);
    expect(scene).toEqual(before);
  });
});
