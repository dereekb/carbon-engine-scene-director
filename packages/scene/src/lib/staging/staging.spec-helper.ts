import { applySceneOperations, normalizeScene, type SceneDocument, type SceneShip, type SceneVector } from '../scene';

export { GUARDIAN, makeMiniComposition, TFI } from '../compositions/compositions.spec-helper';
export { catchSceneError, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';

export const RIFTER = 'mf4_t1:minmatarbase:minmatar';

/**
 * A normalized document from a candidate that must be valid.
 *
 * @param input - The candidate.
 * @returns The document.
 */
export function scene(input: unknown = { name: 'staging' }): SceneDocument {
  return normalizeScene(input).scene;
}

/**
 * Applies operations to a document.
 *
 * @param before - The document.
 * @param operations - The operations.
 * @returns The result.
 */
export function apply(before: SceneDocument, ...operations: unknown[]): ReturnType<typeof applySceneOperations> {
  return applySceneOperations(before, operations);
}

/**
 * The ships `after` has that `before` does not, in document order.
 *
 * @param before - The document before.
 * @param after - The document after.
 * @returns The new ships.
 */
export function newShips(before: SceneDocument, after: SceneDocument): SceneShip[] {
  const old = new Set(before.ships.map((ship) => ship.id));
  return after.ships.filter((ship) => !old.has(ship.id));
}

/**
 * The least distance between any two points.
 *
 * @param points - The points.
 * @returns Metres (Infinity for fewer than two).
 */
export function minPairDistance(points: readonly SceneVector[]): number {
  let least = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) least = Math.min(least, distance(points[i], points[j]));
  }
  return least;
}

export function distance(a: SceneVector, b: SceneVector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
