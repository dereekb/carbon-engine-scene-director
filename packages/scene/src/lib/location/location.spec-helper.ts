import { expect } from 'vitest';
import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import type { SceneLocation } from './location';

/**
 * Jita's numbers (tools-core map routes, SDE 3632936): the CNAP, its moon, Jita IV and the Perimeter gate in system
 * metres, and the origin 30 km off the CNAP toward the sun.
 */
export const JITA = 30000142;
export const CNAP = { id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', position: [-107303362560, -18744975360, 436489052160] as SceneVector, radius: 100000 };
export const MOON = { id: 40009087, name: 'Jita IV - Moon 4', position: [-107306319871, -18744939412, 436491860176] as SceneVector, radius: 1620000 };
export const PLANET = { id: 40009082, name: 'Jita IV', position: [-107354576606, -18753785170, 436797007078] as SceneVector, radius: 18890000 };
export const GATE = { id: 50001249, name: 'Stargate (Perimeter)', position: [-4067676856320, -710577070080, -3956622581760] as SceneVector, radius: 3532 };
export const CNAP_30KM_OFFSET: SceneVector = [31007.319, 5416.712, -126131.699];
export const CNAP_30KM_ORIGIN: SceneVector = [-107303331552.681, -18744969943.288, 436488926028.301];

export const CNAP_LOCATION: SceneLocation = {
  system: JITA,
  name: 'Jita',
  region: 'The Forge',
  origin: CNAP_30KM_ORIGIN,
  anchor: { celestial: CNAP.id, name: CNAP.name, kind: 'station', offset: CNAP_30KM_OFFSET }
};

/**
 * Expects each component within a tolerance.
 */
export function expectVectorClose(actual: Maybe<readonly number[]>, expected: readonly number[], tolerance = 1e-3): void {
  expect(actual).toHaveLength(3);
  for (const [index, value] of expected.entries()) expect(Math.abs((actual?.[index] ?? NaN) - value)).toBeLessThanOrEqual(tolerance);
}

export function vectorLength(vector: readonly number[]): number {
  return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
}
