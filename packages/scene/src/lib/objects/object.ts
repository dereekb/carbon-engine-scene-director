import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, ID_PATTERN, isPlainObject, readShipType, readString, readVector, reportUnknownKeys, sameJson } from '../json';
import { readScenePosition } from '../extent';
import type { SceneVector } from '../scene';

/**
 * A static EVE object in the scene: a station, a stargate, an Upwell structure, a large collidable object or a wreck.
 * The page draws it through the SOF on fixed curves and gives it a static Destiny ball, so ships can approach, keep at
 * range on, orbit or warp to it. Nothing moves it but the document.
 */
export interface SceneObject {
  /**
   * Unique across the scene's ships and objects.
   */
  id: string;
  /**
   * SOF DNA: hull:faction:race[:commands]. The add_objects tool fills it from the type.
   */
  dna: string;
  /**
   * The EVE type it was resolved from: a type id, or the canonical English name. Provenance only; the page never
   * looks it up.
   */
  type?: number | string;
  name?: string;
  /**
   * Scene metres, within MAX_SCENE_DISTANCE of the origin.
   */
  position: SceneVector;
  /**
   * `[yaw, pitch, roll]` degrees, as ships.
   */
  rotation: SceneVector;
  /**
   * The Destiny ball's radius in metres, which order ranges are measured on. The add_objects tool fills the type's SDE
   * radius (EVE's overview rule), or its SOF bounding radius where the SDE has none or gives a wreck its 14 m
   * placeholder. Without it the page uses the SOF bounding radius once built, else DEFAULT_OBJECT_RADIUS.
   */
  radius?: number;
}

/**
 * The most objects one `add_objects` line or op places.
 */
export const MAX_OBJECTS_PER_OPERATION = 100;

/**
 * The radius (metres) an object without one counts with until its SOF build reports one.
 */
export const DEFAULT_OBJECT_RADIUS = 1000;

/**
 * How many nearest ships get_state lists per object.
 */
export const OBJECT_NEAREST_SHIPS = 3;

export type SceneObjectStatus = 'queued' | 'building' | 'ready' | 'validated' | 'failed';

/**
 * Where an object's ball radius came from.
 */
export type SceneObjectRadiusSource = 'document' | 'sof' | 'default';

/**
 * One row of `get_state.objects`.
 */
export interface SceneObjectStateReport {
  readonly id: string;
  readonly type?: number | string;
  readonly name?: string;
  readonly dna: string;
  readonly status: SceneObjectStatus;
  readonly error?: string;
  readonly diagnostics?: unknown[];
  /**
   * Metres, rounded.
   */
  readonly position: SceneVector;
  readonly rotation: SceneVector;
  /**
   * The ball's radius: what ranges are measured on.
   */
  readonly radius: number;
  readonly radiusFrom: SceneObjectRadiusSource;
  /**
   * The SOF bounding radius, once built.
   */
  readonly sofRadius?: number;
  /**
   * Metres from the scene origin.
   */
  readonly distance: number;
  /**
   * Up to OBJECT_NEAREST_SHIPS ships, surface to surface, nearest first (negative when a ship is inside it).
   */
  readonly nearestShips: readonly { readonly id: string; readonly distance: number }[];
  /**
   * Ships whose applied or pending order targets it.
   */
  readonly targetedBy?: readonly string[];
}

/**
 * What changed in the objects between two documents.
 */
export interface SceneObjectsDiff {
  readonly added: SceneObject[];
  readonly removed: SceneObject[];
  /**
   * Kept objects whose dna changed.
   */
  readonly rebuilt: SceneObject[];
  /**
   * Kept objects (not rebuilt) whose position or rotation changed.
   */
  readonly moved: SceneObject[];
  /**
   * Kept objects whose radius changed.
   */
  readonly resized: SceneObject[];
}

export interface NormalizedSceneObjects {
  /**
   * The objects, or null when there are none.
   */
  readonly objects: Maybe<SceneObject[]>;
  readonly ids: Set<string>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * An object's keys, in the order they are written.
 */
const OBJECT_KEYS = ['id', 'dna', 'type', 'name', 'position', 'rotation', 'radius'] as const;

/**
 * Validates the document's `objects` and fills defaults. Unknown keys warn and are dropped; keys come out in
 * OBJECT_KEYS order, so equal objects serialize the same.
 *
 * @param config - The candidate list and the ship ids it must not reuse.
 * @param config.input - The candidate `objects`: absent (null or undefined) or an array.
 * @param config.shipIds - The scene's ship ids.
 * @returns The objects, their ids, the problems and the warnings.
 */
export function normalizeSceneObjects(config: { readonly input: unknown; readonly shipIds: ReadonlySet<string> }): NormalizedSceneObjects {
  const { input, shipIds } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const objects: SceneObject[] = [];
  const ids = new Set<string>();
  if (input != null && !Array.isArray(input)) problems.push('objects must be an array');
  for (const [index, entry] of (Array.isArray(input) ? input : []).entries()) {
    const where = `objects[${index}]`;
    const object = normalizeSceneObject(entry, where, problems, warnings);
    if (!object) continue;
    if (shipIds.has(object.id)) problems.push(`${where}.id "${object.id}" is a ship's id; ids are unique across ships and objects`);
    else if (ids.has(object.id)) problems.push(`${where}.id "${object.id}" is used more than once`);
    ids.add(object.id);
    objects.push(object);
  }
  return { objects: objects.length ? objects : null, ids, problems, warnings };
}

function normalizeSceneObject(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<SceneObject> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, new Set<string>(OBJECT_KEYS), where, warnings);
  const id = readString(input['id'], `${where}.id`, problems);
  const dna = readString(input['dna'], `${where}.dna`, problems);
  if (id && !ID_PATTERN.test(id)) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  if (dna && !DNA_PATTERN.test(dna)) problems.push(`${where}.dna "${dna}" is not hull:faction:race[:commands]`);
  const object: SceneObject = { id, dna, position: [0, 0, 0], rotation: [0, 0, 0] };
  if (input['type'] != null) object.type = readShipType(input['type'], `${where}.type`, problems);
  if (input['name'] != null) object.name = readString(input['name'], `${where}.name`, problems);
  if (input['position'] !== undefined) object.position = readScenePosition(input['position'], `${where}.position`, problems);
  if (input['rotation'] !== undefined) object.rotation = readVector(input['rotation'], `${where}.rotation`, problems);
  const radius = input['radius'];
  if (radius != null) {
    if (typeof radius === 'number' && Number.isFinite(radius) && radius > 0) object.radius = radius;
    else problems.push(`${where}.radius must be a finite number of metres above 0`);
  }
  // Rebuild in canonical key order: type and name sit between dna and position.
  const ordered = Object.fromEntries(OBJECT_KEYS.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
  return ordered as unknown as SceneObject;
}

/**
 * What changed in the objects between two normalized documents.
 *
 * @param before - The objects the page shows.
 * @param after - The objects to show.
 * @returns The added, removed, rebuilt, moved and resized objects. A type or name change needs nothing from the page.
 */
export function diffSceneObjects(before: readonly SceneObject[], after: readonly SceneObject[]): SceneObjectsDiff {
  const previous = new Map(before.map((object) => [object.id, object]));
  const current = new Set(after.map((object) => object.id));
  const diff: SceneObjectsDiff = { added: [], removed: [], rebuilt: [], moved: [], resized: [] };
  for (const object of before) if (!current.has(object.id)) diff.removed.push(object);
  for (const object of after) {
    const old = previous.get(object.id);
    if (!old) diff.added.push(object);
    else if (old.dna !== object.dna) diff.rebuilt.push(object);
    else if (!sameJson(old.position, object.position) || !sameJson(old.rotation, object.rotation)) diff.moved.push(object);
    if (old && old.radius !== object.radius) diff.resized.push(object);
  }
  return diff;
}
