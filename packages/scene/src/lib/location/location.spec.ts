import { describe, expect, it } from 'vitest';
import { diffScenes, normalizeScene } from '../scene';
import { normalizeSceneLocation } from './location';
import { CNAP_LOCATION, JITA } from './location.spec-helper';

describe('normalizeSceneLocation', () => {
  it('keeps a full location, in canonical key order whatever the input order', () => {
    const shuffled = { anchor: { offset: CNAP_LOCATION.anchor?.offset, kind: 'station', name: CNAP_LOCATION.anchor?.name, celestial: CNAP_LOCATION.anchor?.celestial }, origin: CNAP_LOCATION.origin, region: 'The Forge', name: 'Jita', system: JITA };
    const normalized = normalizeSceneLocation({ input: shuffled });
    expect(normalized).toEqual({ location: CNAP_LOCATION, problems: [], warnings: [] });
    expect(JSON.stringify(normalized.location)).toBe(JSON.stringify(CNAP_LOCATION));
  });

  it('treats null and undefined as absent', () => {
    expect(normalizeSceneLocation({ input: null }).location).toBeNull();
    expect('location' in normalizeScene({ location: null }).scene).toBe(false);
    expect('location' in normalizeScene({}).scene).toBe(false);
  });

  it('reports every problem together', () => {
    expect(normalizeSceneLocation({ input: {} }).problems).toEqual(['location.system must be an EVE solar system id (a positive integer); the set_location tool resolves a system name', 'location.origin is required: the scene origin in system metres (the set_location tool computes it from a celestial)']);
    expect(normalizeSceneLocation({ input: 'Jita' }).problems).toEqual(['location must be an object']);
    expect(normalizeSceneLocation({ input: { system: 1.5, origin: [1, 2] } }).problems).toEqual(['location.system must be an EVE solar system id (a positive integer); the set_location tool resolves a system name', 'location.origin must be an array of three finite numbers']);
    const { location, problems } = normalizeSceneLocation({ input: { system: 'Jita', origin: [1.3e17, 0, 0], anchor: { kind: 'belt', offset: [0, 0] } } });
    expect(location).toBeNull();
    expect(problems).toEqual([
      expect.stringContaining('the set_location tool resolves a system name'),
      'location.origin must be within 1e15 m of the star (system metres, not galactic coordinates)',
      'location.anchor.celestial must be an EVE celestial id (a positive integer)',
      'location.anchor.kind must be one of star, planet, moon, asteroidBelt, station, stargate',
      'location.anchor.offset must be an array of three finite numbers'
    ]);
  });

  it('warns about and drops unknown keys at both levels', () => {
    const { location, warnings } = normalizeSceneLocation({ input: { system: JITA, origin: [0, 0, 0], colour: 'red', anchor: { celestial: 40009076, size: 3 } } });
    expect(location).toEqual({ system: JITA, origin: [0, 0, 0], anchor: { celestial: 40009076 } });
    expect(warnings).toEqual(['location.colour is not a known field and was dropped', 'location.anchor.size is not a known field and was dropped']);
  });

  it('round-trips through JSON bit-exact', () => {
    const first = normalizeScene({ name: 'loc', location: CNAP_LOCATION }).scene;
    const again = normalizeScene(JSON.parse(JSON.stringify(first))).scene;
    expect(again).toEqual(first);
    expect(again.location?.origin).toEqual(CNAP_LOCATION.origin);
    expect(Object.keys(first)).toEqual(['schema', 'name', 'environment', 'location', 'camera', 'ships']);
  });
});

describe('diffScenes location', () => {
  const ship = { id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar' };
  const without = normalizeScene({ ships: [ship] }).scene;
  const located = normalizeScene({ ships: [ship], location: CNAP_LOCATION }).scene;

  it('flags a location change and moves no ship', () => {
    const diff = diffScenes(without, located);
    expect(diff.location).toBe(true);
    expect([diff.moved, diff.rebuilt, diff.added, diff.removed]).toEqual([[], [], [], []]);
    expect(diffScenes(located, structuredClone(located)).location).toBe(false);
    expect(diffScenes(located, without).location).toBe(true);
  });

  it('flags an anchor-only change and a first load', () => {
    const renamed = normalizeScene({ ships: [ship], location: { ...CNAP_LOCATION, anchor: { ...CNAP_LOCATION.anchor, name: 'CNAP' } } }).scene;
    expect(diffScenes(located, renamed).location).toBe(true);
    expect(diffScenes(null, located).location).toBe(true);
    expect(diffScenes(null, without).location).toBe(false);
  });
});
