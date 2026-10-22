import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readVector } from '../json';
import type { ExpandFleetCompositionExisting } from '../compositions/expand';
import type { SceneVector } from '../scene';

/**
 * A ship's document placement, as staging reads it off the draft.
 */
export interface StagingDraftShip {
  readonly position: SceneVector;
  readonly rotation: SceneVector;
}

/**
 * What the draft holds that staging needs.
 */
export interface StagingDraft {
  readonly ships: Map<string, StagingDraftShip>;
  readonly fleets: Set<string>;
  /**
   * The scene location's origin (system metres), or null without a location.
   */
  readonly locationOrigin: Maybe<SceneVector>;
}

/**
 * Reads the draft defensively (normalizeScene reports what is malformed): a ship without a valid position or
 * rotation counts at the origin, facing 0, as normalizing defaults it.
 *
 * @param draft - The document mid-edit.
 * @returns Its ships, fleet ids and location origin.
 */
export function readStagingDraft(draft: JsonObject): StagingDraft {
  const ships = new Map<string, StagingDraftShip>();
  for (const ship of Array.isArray(draft['ships']) ? draft['ships'] : []) {
    if (!isPlainObject(ship) || typeof ship['id'] !== 'string') continue;
    ships.set(ship['id'], { position: readOptionalVector(ship['position']), rotation: readOptionalVector(ship['rotation']) });
  }
  const fleets = new Set<string>();
  for (const fleet of Array.isArray(draft['fleets']) ? draft['fleets'] : []) {
    if (isPlainObject(fleet) && typeof fleet['id'] === 'string') fleets.add(fleet['id']);
  }
  const location = draft['location'];
  const locationOrigin = isPlainObject(location) && location['origin'] != null ? readVector(location['origin'], 'origin', []) : null;
  return { ships, fleets, locationOrigin };
}

/**
 * The `existing` argument of expandFleetComposition.
 *
 * @param draft - What the draft holds.
 * @returns Its ship positions and fleet ids.
 */
export function toExpandExisting(draft: StagingDraft): ExpandFleetCompositionExisting {
  return { ships: new Map([...draft.ships].map(([id, ship]) => [id, ship.position])), fleets: draft.fleets };
}

function readOptionalVector(value: unknown): SceneVector {
  return value === undefined ? [0, 0, 0] : readVector(value, 'vector', []);
}
