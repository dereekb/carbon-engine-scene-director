import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readVector } from '../json';
import type { ExpandFleetCompositionExisting } from '../compositions/expand';
import { readDraftFits } from '../compositions/operation';
import type { SceneVector } from '../scene';

/**
 * A ship's document placement, as staging reads it off the draft.
 */
export interface StagingDraftShip {
  readonly position: SceneVector;
  readonly rotation: SceneVector;
}

/**
 * An object's document placement and radius, as staging reads it off the draft.
 */
export interface StagingDraftObject extends StagingDraftShip {
  /**
   * Its document radius (metres), or null when it has none.
   */
  readonly radius: Maybe<number>;
}

/**
 * What the draft holds that staging needs.
 */
export interface StagingDraft {
  readonly ships: Map<string, StagingDraftShip>;
  /**
   * The scene's objects (see objects/object.ts): references for `near` and `facing`, and ids ship ids must skip.
   */
  readonly objects: Map<string, StagingDraftObject>;
  readonly fleets: Set<string>;
  /**
   * The scene location's origin (system metres), or null without a location.
   */
  readonly locationOrigin: Maybe<SceneVector>;
  /**
   * The scene's fits by key.
   */
  readonly fits: Record<string, string>;
}

/**
 * Reads the draft defensively (normalizeScene reports what is malformed): a ship without a valid position or
 * rotation counts at the origin, facing 0, as normalizing defaults it.
 *
 * @param draft - The document mid-edit.
 * @returns Its ships, objects, fleet ids and location origin.
 */
export function readStagingDraft(draft: JsonObject): StagingDraft {
  const ships = new Map<string, StagingDraftShip>();
  for (const ship of Array.isArray(draft['ships']) ? draft['ships'] : []) {
    if (!isPlainObject(ship) || typeof ship['id'] !== 'string') continue;
    ships.set(ship['id'], { position: readOptionalVector(ship['position']), rotation: readOptionalVector(ship['rotation']) });
  }
  const objects = new Map<string, StagingDraftObject>();
  for (const object of Array.isArray(draft['objects']) ? draft['objects'] : []) {
    if (!isPlainObject(object) || typeof object['id'] !== 'string') continue;
    const radius = object['radius'];
    objects.set(object['id'], { position: readOptionalVector(object['position']), rotation: readOptionalVector(object['rotation']), radius: typeof radius === 'number' && Number.isFinite(radius) && radius > 0 ? radius : null });
  }
  const fleets = new Set<string>();
  for (const fleet of Array.isArray(draft['fleets']) ? draft['fleets'] : []) {
    if (isPlainObject(fleet) && typeof fleet['id'] === 'string') fleets.add(fleet['id']);
  }
  const location = draft['location'];
  const locationOrigin = isPlainObject(location) && location['origin'] != null ? readVector(location['origin'], 'origin', []) : null;
  return { ships, objects, fleets, locationOrigin, fits: readDraftFits(draft) };
}

/**
 * The `existing` argument of expandFleetComposition.
 *
 * @param draft - What the draft holds.
 * @returns Its ship positions, object ids and fleet ids.
 */
export function toExpandExisting(draft: StagingDraft): ExpandFleetCompositionExisting {
  return { ships: new Map([...draft.ships].map(([id, ship]) => [id, ship.position])), objects: new Set(draft.objects.keys()), fleets: draft.fleets, fits: draft.fits };
}

/**
 * Every id ships and objects hold: new ship and object ids skip them all.
 *
 * @param draft - What the draft holds.
 * @returns The ids.
 */
export function stagingTakenIds(draft: StagingDraft): Set<string> {
  return new Set([...draft.ships.keys(), ...draft.objects.keys()]);
}

function readOptionalVector(value: unknown): SceneVector {
  return value === undefined ? [0, 0, 0] : readVector(value, 'vector', []);
}
