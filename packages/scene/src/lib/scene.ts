import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, ID_PATTERN, isPlainObject, type JsonObject, readNumber, readShipType, readString, readVector, reportUnknownKeys, sameJson } from './json';
import { FLEET_OPERATIONS, type FleetOperationContext, applyFleetOperation, normalizeFleets, removeShipFromFleets, type SceneFleet, toFleetMemberships } from './fleets';
import { type HullStatOverrides, normalizeHullStatOverrides } from './stats';
import { applyFleetCompositionOperation, FLEET_COMPOSITION_OPERATIONS } from './compositions/operation';
/**
 * The scene document: the JSON a person or Claude writes to describe a scene,
 * and the only state a saved scene keeps. The page translates it into runtime
 * objects; nothing here imports the runtime, so the hub, the page and the
 * tests share one definition.
 *
 * Units are EVE's: metres for positions and distances, degrees for angles.
 * Y is up.
 */

export const SCENE_SCHEMA = 'cjs-scene/1';

export const DEFAULT_UNIVERSE = 'res:/dx9/scene/universe/a01_cube.black';

export const DEFAULT_SCENE_NAME = 'untitled';

/**
 * A position in metres or a rotation in degrees (`[yaw, pitch, roll]`).
 */
export type SceneVector = [number, number, number];

export interface SceneShip {
  id: string;
  /**
   * SOF DNA: hull:faction:race[:commands].
   */
  dna: string;
  name?: string;
  team?: string;
  position: SceneVector;
  rotation: SceneVector;
  /**
   * The EVE type the ship flies as: a type id, or an exact English type name. When
   * omitted, the DNA's hull:faction:race picks the type (see ship_stats).
   */
  type?: number | string;
  /**
   * Replacements for the hull's published flight values (mass kg, maxVelocity m/s,
   * agility, signatureRadius m), applied before the pilot's skills and the prop mod.
   * All four together pin the numbers without the EVE data.
   */
  stats?: HullStatOverrides;
  /**
   * Reserved for the movement phase: stored, not played yet.
   */
  orders?: unknown;
  /**
   * Reserved for the character system: stored, not used yet. Ships fly with the max-skills pilot.
   */
  pilot?: unknown;
}

export interface SceneCamera {
  /**
   * Ship id to frame, or null to frame every ship.
   */
  target: Maybe<string>;
  /**
   * Metres from the target, or null to fit it.
   */
  distance: Maybe<number>;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface SceneEnvironment {
  /**
   * res:/ path of the EveSpaceScene whose values dress the scene.
   */
  universe: string;
}

export interface SceneDocument {
  schema: typeof SCENE_SCHEMA;
  name: string;
  environment: SceneEnvironment;
  camera: SceneCamera;
  ships: SceneShip[];
  /**
   * EVE fleets: a fleet commander, wings and squads with a role and an anchor (see fleets/fleet.ts). The page flies
   * them: members keep range on their anchors in formation behind the FC. Omitted when there are none.
   */
  fleets?: SceneFleet[];
  /**
   * Reserved for the timeline phase: stored, not played yet.
   */
  timeline?: unknown;
}

export interface NormalizedScene {
  readonly scene: SceneDocument;
  readonly warnings: string[];
}

/**
 * What changed between two documents, in the terms the page acts on.
 */
export interface SceneDiff {
  readonly environment: boolean;
  readonly camera: boolean;
  readonly added: SceneShip[];
  readonly removed: SceneShip[];
  readonly rebuilt: SceneShip[];
  readonly moved: SceneShip[];
  readonly relabelled: SceneShip[];
  /**
   * Kept ships whose type, stats or pilot changed: their flight numbers need recomputing, not a rebuild.
   */
  readonly retuned: SceneShip[];
  /**
   * Whether the fleets changed at all, a name included.
   */
  readonly fleets: boolean;
  /**
   * Ships present before and after (rebuilt or not) whose fleet membership changed (fleet, wing, squad, role,
   * commands or resolved anchor), joining or leaving a fleet included: the ships whose following must be re-issued.
   */
  readonly regrouped: SceneShip[];
}

/**
 * A document mid-edit: operations write unvalidated values into it, and normalizeScene checks the result.
 */
type SceneDraft = JsonObject & { ships: JsonObject[]; camera: JsonObject; environment: JsonObject };

/**
 * Keys reserved for later phases; accepted and kept, but not acted on yet.
 */
const RESERVED_SCENE_KEYS = ['timeline'] as const;
const RESERVED_SHIP_KEYS = ['orders', 'pilot'] as const;

const SCENE_KEYS = new Set<string>(['schema', 'name', 'environment', 'camera', 'ships', 'fleets', ...RESERVED_SCENE_KEYS]);
const SHIP_KEYS = new Set<string>(['id', 'dna', 'name', 'team', 'position', 'rotation', 'type', 'stats', ...RESERVED_SHIP_KEYS]);
const CAMERA_KEYS = new Set<string>(['target', 'distance', 'yaw', 'pitch', 'fov']);
const ENVIRONMENT_KEYS = new Set<string>(['universe']);

const UNIVERSE_PATTERN = /^res:\/.+\.(black|red)$/iu;

/**
 * A document that cannot be used, with every problem found rather than the first.
 */
export class SceneError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid scene document:\n- ${problems.join('\n- ')}`);
    this.name = 'SceneError';
    this.problems = problems;
  }
}

/**
 * The smallest valid document.
 *
 * @param name - The document's name.
 * @returns A document with default environment and camera and no ships.
 */
export function createEmptyScene(name: string = DEFAULT_SCENE_NAME): SceneDocument {
  return {
    schema: SCENE_SCHEMA,
    name,
    environment: { universe: DEFAULT_UNIVERSE },
    camera: { target: null, distance: null, yaw: 45, pitch: -15, fov: 45 },
    ships: []
  };
}

/**
 * Validates a document and fills defaults. Unknown keys are reported as
 * warnings and dropped, so a typo is visible instead of silently ignored.
 *
 * @param input - A candidate document.
 * @returns The normalized copy and its warnings.
 * @throws {SceneError} When the document cannot be used.
 */
export function normalizeScene(input: unknown): NormalizedScene {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) throw new SceneError(['the scene must be a JSON object']);
  if (input['schema'] !== undefined && input['schema'] !== SCENE_SCHEMA) {
    problems.push(`schema must be "${SCENE_SCHEMA}", got ${JSON.stringify(input['schema'])}`);
  }
  reportUnknownKeys(input, SCENE_KEYS, 'scene', warnings);

  const scene: SceneDocument = {
    schema: SCENE_SCHEMA,
    name: input['name'] === undefined ? DEFAULT_SCENE_NAME : readString(input['name'], 'name', problems),
    environment: normalizeEnvironment(input['environment'], problems, warnings),
    camera: normalizeCamera(input['camera'], problems, warnings),
    ships: []
  };

  const ships = input['ships'];
  if (ships !== undefined && !Array.isArray(ships)) problems.push('ships must be an array');
  const ids = new Set<string>();
  for (const [index, ship] of (Array.isArray(ships) ? ships : []).entries()) {
    const normalized = normalizeShip(ship, `ships[${index}]`, problems, warnings);
    if (!normalized) continue;
    if (ids.has(normalized.id)) problems.push(`ships[${index}].id "${normalized.id}" is used more than once`);
    ids.add(normalized.id);
    scene.ships.push(normalized);
  }

  const target = scene.camera.target;
  if (target != null && !ids.has(target)) {
    problems.push(`camera.target "${target}" is not a ship id`);
  }
  const fleets = normalizeFleets({ input: input['fleets'], shipIds: ids });
  problems.push(...fleets.problems);
  warnings.push(...fleets.warnings);
  if (fleets.fleets) scene.fleets = fleets.fleets;
  for (const key of RESERVED_SCENE_KEYS) {
    if (input[key] === undefined) continue;
    scene[key] = structuredClone(input[key]);
    warnings.push(`${key} is reserved for a later phase and is stored but not played yet`);
  }

  if (problems.length) throw new SceneError(problems);
  return { scene, warnings };
}

/**
 * Applies edit operations to a document and returns the normalized result; the
 * input is not modified. Operations run in order and all must succeed.
 *
 * Operations:
 *   { op: "add_ship", ship }
 *   { op: "update_ship", id, set: { dna?, name?, team?, position?, rotation?, type?, stats?, orders?, pilot? } }
 *                                       each key replaces the ship's value (stats as a whole); null clears type, stats and pilot
 *   { op: "remove_ship", id }               also takes the ship out of its fleet (a fleet commander is refused)
 *   { op: "set_camera", camera }            merged into the current camera
 *   { op: "set_environment", environment }  merged into the current environment
 *   { op: "rename", name }
 *   { op: "add_fleet", fleet }   { op: "update_fleet", fleet, set: { name?, commander? } }
 *   { op: "remove_fleet", fleet, withShips? }   withShips: true also removes every ship holding a position in it
 *   { op: "add_wing", fleet, wing }   { op: "update_wing", fleet, wing, set: { name?, commander? } }   { op: "remove_wing", fleet, wing }
 *   { op: "add_squad", fleet, wing, squad }   { op: "update_squad", fleet, squad, set: { name?, role?, commander?, anchor? } }
 *   { op: "remove_squad", fleet, squad }
 *   { op: "move_to_squad", ships, fleet, squad }   { op: "remove_from_fleet", ships }
 *   { op: "set_anchor", fleet, squad, anchor: { ship?, range? } }   merged; null resets ship to the FC and range to the role default
 *                                       a ship taken out of a squad falls squads anchored on it back to their squad
 *                                       commander, then wing commander, then the FC, with a warning
 *   { op: "add_fleet_composition", composition, position, heading? | facing?, fleet?, team? }
 *                                       adds a cjs-fleet/1 composition's ships in formation and its fleet, with free
 *                                       ids; every ship line needs its dna (see compositions/operation.ts)
 *
 * @param scene - A normalized document.
 * @param operations - The edits.
 * @returns The edited, normalized copy and its warnings.
 * @throws {SceneError} When an operation is malformed or the result is invalid.
 */
export function applySceneOperations(scene: SceneDocument, operations: unknown): NormalizedScene {
  if (!Array.isArray(operations) || operations.length === 0) throw new SceneError(['operations must be a non-empty array']);
  const next = structuredClone(scene) as unknown as SceneDraft;
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const [index, operation] of operations.entries()) {
    const where = `operations[${index}]`;
    if (isPlainObject(operation) && typeof operation['op'] === 'string') {
      applyOperation(operation, { draft: next, where, problems, warnings });
    } else {
      problems.push(`${where} must be an object with an "op" string`);
    }
  }

  if (problems.length) throw new SceneError(problems);
  const normalized = normalizeScene(next);
  return { scene: normalized.scene, warnings: [...warnings, ...normalized.warnings] };
}

function applyOperation(operation: JsonObject, context: FleetOperationContext & { readonly draft: SceneDraft }): void {
  const { draft: next, where, problems } = context;
  switch (operation['op']) {
    case 'add_ship': {
      const ship = operation['ship'];
      if (!isPlainObject(ship)) problems.push(`${where}.ship must be an object`);
      else if (next.ships.some((candidate) => candidate['id'] === ship['id'])) problems.push(`${where}: ship "${String(ship['id'])}" already exists`);
      else next.ships.push(structuredClone(ship));
      break;
    }
    case 'update_ship': {
      const ship = next.ships.find((candidate) => candidate['id'] === operation['id']);
      const set = operation['set'];
      if (!ship) problems.push(`${where}: no ship "${String(operation['id'])}"`);
      else if (!isPlainObject(set)) problems.push(`${where}.set must be an object`);
      else if ('id' in set) problems.push(`${where}: a ship's id cannot be changed; remove and add it instead`);
      else Object.assign(ship, structuredClone(set));
      break;
    }
    case 'remove_ship': {
      const index = next.ships.findIndex((ship) => ship['id'] === operation['id']);
      if (index < 0) {
        problems.push(`${where}: no ship "${String(operation['id'])}"`);
      } else {
        next.ships.splice(index, 1);
        if (next.camera['target'] === operation['id']) next.camera['target'] = null;
        removeShipFromFleets(String(operation['id']), context);
      }
      break;
    }
    case 'set_camera':
      if (isPlainObject(operation['camera'])) Object.assign(next.camera, structuredClone(operation['camera']));
      else problems.push(`${where}.camera must be an object`);
      break;
    case 'set_environment':
      if (isPlainObject(operation['environment'])) Object.assign(next.environment, structuredClone(operation['environment']));
      else problems.push(`${where}.environment must be an object`);
      break;
    case 'rename':
      next['name'] = operation['name'];
      break;
    default:
      if (FLEET_OPERATIONS.has(String(operation['op']))) applyFleetOperation(operation, context);
      else if (FLEET_COMPOSITION_OPERATIONS.has(String(operation['op']))) applyFleetCompositionOperation(operation, context);
      else problems.push(`${where}: unknown op "${String(operation['op'])}"`);
  }
}

/**
 * What changed between two normalized documents, in the terms the page acts on.
 *
 * @param before - The document the page currently shows, or null on a first load.
 * @param after - The document to show.
 * @returns The ships to add, remove, rebuild, move, relabel, retune and regroup, and whether the environment, camera or
 *   fleets changed.
 */
export function diffScenes(before: Maybe<SceneDocument>, after: SceneDocument): SceneDiff {
  const previous = new Map((before?.ships ?? []).map((ship) => [ship.id, ship]));
  const current = new Map(after.ships.map((ship) => [ship.id, ship]));
  const diff: SceneDiff = {
    environment: !sameJson(before?.environment, after.environment),
    camera: !sameJson(before?.camera, after.camera),
    added: [],
    removed: [],
    rebuilt: [],
    moved: [],
    relabelled: [],
    retuned: [],
    fleets: !sameJson(before?.fleets ?? [], after.fleets ?? []),
    regrouped: []
  };
  const membershipsBefore = toFleetMemberships(before ?? {});
  const membershipsAfter = toFleetMemberships(after);

  for (const [id, ship] of previous) if (!current.has(id)) diff.removed.push(ship);
  for (const [id, ship] of current) {
    const old = previous.get(id);
    if (!old) {
      diff.added.push(ship);
    } else if (old.dna === ship.dna) {
      if (!sameJson(old.position, ship.position) || !sameJson(old.rotation, ship.rotation)) diff.moved.push(ship);
      if (old.name !== ship.name || old.team !== ship.team) diff.relabelled.push(ship);
      if (!sameJson(old.type, ship.type) || !sameJson(old.stats, ship.stats) || !sameJson(old.pilot, ship.pilot)) diff.retuned.push(ship);
    } else {
      diff.rebuilt.push(ship);
    }
    if (old && !sameJson(membershipsBefore.get(id), membershipsAfter.get(id))) diff.regrouped.push(ship);
  }
  return diff;
}

function normalizeEnvironment(input: unknown, problems: string[], warnings: string[]): SceneEnvironment {
  const environment: SceneEnvironment = { universe: DEFAULT_UNIVERSE };
  if (input === undefined) return environment;
  if (!isPlainObject(input)) {
    problems.push('environment must be an object');
    return environment;
  }
  reportUnknownKeys(input, ENVIRONMENT_KEYS, 'environment', warnings);
  if (input['universe'] !== undefined) {
    const universe = readString(input['universe'], 'environment.universe', problems);
    if (universe && !UNIVERSE_PATTERN.test(universe)) problems.push('environment.universe must be a res:/ path to a .black or .red file');
    environment.universe = universe;
  }
  return environment;
}

function normalizeCamera(input: unknown, problems: string[], warnings: string[]): SceneCamera {
  const camera = createEmptyScene().camera;
  if (input === undefined) return camera;
  if (!isPlainObject(input)) {
    problems.push('camera must be an object');
    return camera;
  }
  reportUnknownKeys(input, CAMERA_KEYS, 'camera', warnings);
  if (input['target'] !== undefined && input['target'] !== null) camera.target = readString(input['target'], 'camera.target', problems);
  if (input['distance'] !== undefined && input['distance'] !== null) camera.distance = readNumber(input['distance'], 'camera.distance', problems, { min: 1 });
  if (input['yaw'] !== undefined) camera.yaw = readNumber(input['yaw'], 'camera.yaw', problems);
  if (input['pitch'] !== undefined) camera.pitch = readNumber(input['pitch'], 'camera.pitch', problems, { min: -89, max: 89 });
  if (input['fov'] !== undefined) camera.fov = readNumber(input['fov'], 'camera.fov', problems, { min: 5, max: 120 });
  return camera;
}

function normalizeShip(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<SceneShip> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, SHIP_KEYS, where, warnings);

  const ship: SceneShip = {
    id: readString(input['id'], `${where}.id`, problems),
    dna: readString(input['dna'], `${where}.dna`, problems),
    position: input['position'] === undefined ? [0, 0, 0] : readVector(input['position'], `${where}.position`, problems),
    rotation: input['rotation'] === undefined ? [0, 0, 0] : readVector(input['rotation'], `${where}.rotation`, problems)
  };
  if (ship.id && !ID_PATTERN.test(ship.id)) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  if (ship.dna && !DNA_PATTERN.test(ship.dna)) problems.push(`${where}.dna "${ship.dna}" is not hull:faction:race[:commands]`);
  if (input['name'] !== undefined) ship.name = readString(input['name'], `${where}.name`, problems);
  if (input['team'] !== undefined) ship.team = readString(input['team'], `${where}.team`, problems);
  if (input['type'] != null) ship.type = readShipType(input['type'], `${where}.type`, problems);

  const stats = normalizeHullStatOverrides({ input: input['stats'], where: `${where}.stats` });
  problems.push(...stats.problems);
  warnings.push(...stats.warnings);
  if (stats.overrides) ship.stats = stats.overrides;

  if (input['orders'] !== undefined) {
    ship.orders = structuredClone(input['orders']);
    warnings.push(`${where}.orders is reserved for a later phase and is stored but not played yet`);
  }
  const pilot = input['pilot'];
  if (pilot != null && !isPlainObject(pilot) && !(typeof pilot === 'string' && pilot.trim())) {
    problems.push(`${where}.pilot must be an object or a pilot name`);
  } else if (pilot != null) {
    ship.pilot = structuredClone(pilot);
    warnings.push(`${where}.pilot is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot`);
  }
  return ship;
}
