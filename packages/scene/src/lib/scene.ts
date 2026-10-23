import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, ID_PATTERN, isPlainObject, type JsonObject, readNumber, readShipType, readString, readVector, reportUnknownKeys, sameJson } from './json';
import { FLEET_OPERATIONS, type FleetOperationContext, applyFleetOperation, normalizeFleets, removeCalledTarget, removeShipFromFleets, type SceneFleet, toFleetMemberships } from './fleets';
import { type HullStatOverrides, normalizeHullStatOverrides } from './stats';
import { applyFleetCompositionOperation, FLEET_COMPOSITION_OPERATIONS } from './compositions/operation';
import { normalizeSceneLocation, type SceneLocation } from './location/location';
import { normalizeShipPropMod, type SceneShipPropMod } from './prop-mods/prop-mod';
import { applyPropModOperation, PROP_MOD_OPERATIONS } from './prop-mods/operation';
import { applyStagingOperation, STAGING_OPERATIONS } from './staging/operation';
import { applyObjectOperation, OBJECT_OPERATIONS } from './objects/operations';
import { diffSceneObjects, normalizeSceneObjects, type SceneObject, type SceneObjectsDiff } from './objects/object';
import { readScenePosition } from './extent';
import { applyFitOperation, FIT_OPERATIONS } from './fitting/operation';
import { applyCombatOperation, COMBAT_OPERATIONS, normalizeSceneCombat, type SceneCombat } from './combat/document';
import { fitTextOf, normalizeSceneFits, normalizeShipFit } from './fitting/fit';
import { keepSceneArrivals, readWarpIn, type SceneArrival, toArrivalLane } from './arrivals/arrival';
import { applyPersonalityOperation, normalizeScenePersonalities, PERSONALITY_OPERATIONS } from './personalities/document';
import type { FleetPersonality } from './personalities/personality';
import { normalizeShipPilot, pilotFlightPart, type SceneShipPilot } from './personalities/pilots';
import { normalizeSceneTimeline } from './timeline/normalize';
import { normalizeShipOrderSteps, type SceneShipStep, type ShipStepName, shipStepNameWarning } from './timeline/steps';
import { applyTimelineOperation, TIMELINE_OPERATIONS } from './timeline/operations';
import { removeTimelineReferences } from './timeline/prune';
import type { SceneTimeline } from './timeline/timeline';
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
   * The propulsion module it fits and whether it runs at load. Omitted: the hull-sized Tech II microwarpdrive, off.
   * A string or a type id is shorthand for `{ module }`.
   */
  propMod?: SceneShipPropMod;
  /**
   * The ship's EVE fit: EFT text (starting with its `[Hull, Fit name]` header), or a key of the document's `fits`.
   * Its modules set the ship's HP, resists, capacitor, signature and speed; its first MWD / AB is the prop mod when
   * `propMod.module` names none (see fitting/fit.ts).
   */
  fit?: string;
  /**
   * The ship's own script (timeline/steps.ts): order_ship orders it flies in turn from play start, each with `after`
   * (seconds to wait first) and `duration` (seconds it lasts). Omitted when empty.
   */
  orders?: SceneShipStep[];
  /**
   * The pilot's traits (personalities/pilots.ts): `command` (FC ability) and `reaction`, 0..1. Any other key, or a
   * pilot name, is reserved for the character system: stored, not used yet. Ships fly with the max-skills pilot.
   */
  pilot?: SceneShipPilot;
}

/**
 * How the camera follows its target ship: `orbit` keeps the angles you set, `chase` sits behind the ship and turns
 * with it.
 */
export const SCENE_CAMERA_MODES = ['orbit', 'chase'] as const;
export type SceneCameraMode = (typeof SCENE_CAMERA_MODES)[number];

export interface SceneCamera {
  /**
   * Ship or object id to frame and follow, or null to frame every ship.
   */
  target: Maybe<string>;
  /**
   * Metres from the target, or null to fit it.
   */
  distance: Maybe<number>;
  yaw: number;
  pitch: number;
  fov: number;
  /**
   * How the camera follows its target; without a target it does nothing.
   */
  mode: SceneCameraMode;
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
  /**
   * Where the scene is in New Eden (see location/location.ts): a solar system and the system-metre point the scene's
   * [0, 0, 0] sits on. Ships stay in scene metres around it. Omitted when it is nowhere in particular.
   */
  location?: SceneLocation;
  camera: SceneCamera;
  ships: SceneShip[];
  /**
   * EVE fleets: a fleet commander, wings and squads with a role and an anchor (see fleets/fleet.ts). The page flies
   * them: members keep range on their anchors in formation behind the FC. Omitted when there are none.
   */
  fleets?: SceneFleet[];
  /**
   * Static EVE objects: stations, gates, structures, large collidable objects and wrecks (see objects/object.ts).
   * Ids are unique across ships and objects. Omitted when there are none.
   */
  objects?: SceneObject[];
  /**
   * EFT fit text by key, for the ships' `fit`. A fleet composition adds its fits here once, under
   * `<composition id>/<fit key>`. Unused keys stay until set_fits deletes them. Omitted when there are none.
   */
  fits?: Record<string, string>;
  /**
   * Custom fleet personalities by key (personalities/personality.ts), for the fleets' `personality` beside the
   * built-ins; a key is not a built-in name. Omitted when there are none.
   */
  personalities?: Record<string, FleetPersonality>;
  /**
   * Combat settings: the seed every shot's roll is keyed by and what a ship does at 0 structure (see
   * combat/document.ts). Omitted when empty: seed 1, death "explode".
   */
  combat?: SceneCombat;
  /**
   * The scene's script (timeline/timeline.ts): cues at a time from play start, each running one lever (a ship or fleet
   * order, prop mods, modules, targets, a camera shot, a document patch). Omitted when it has no cues.
   */
  timeline?: SceneTimeline;
}

export interface NormalizedScene {
  readonly scene: SceneDocument;
  readonly warnings: string[];
  /**
   * applySceneOperations only: the groups its operations added arriving by warp (`warpIn`), for the page to land.
   */
  readonly arrivals?: readonly SceneArrival[];
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
   * Kept ships whose type, stats, pilot (beyond its command and reaction traits), prop mod module or fit text changed (an inline edit, another key, or the
   * `fits` text it names): their flight numbers and modules need recomputing, not a rebuild.
   */
  readonly retuned: SceneShip[];
  /**
   * Ships present before and after whose `propMod.active` changed: the page switches their prop mods at once.
   * A module change is a retune instead; a ship can be in both lists.
   */
  readonly switched: SceneShip[];
  /**
   * Whether the fleets changed at all, a name included.
   */
  readonly fleets: boolean;
  /**
   * Ships present before and after (rebuilt or not) whose fleet membership changed (fleet, wing, squad, role,
   * commands or resolved anchor), joining or leaving a fleet included: the ships whose following must be re-issued.
   */
  readonly regrouped: SceneShip[];
  /**
   * Whether the location changed (system, origin or anchor): the page re-fetches its system data.
   */
  readonly location: boolean;
  /**
   * What changed in the objects.
   */
  readonly objects: SceneObjectsDiff;
  /**
   * Whether the combat settings changed: the seed takes effect for later shots, the death mode for later deaths.
   */
  readonly combat: boolean;
  /**
   * Ships present before and after whose `orders` changed: the page restarts their scripts.
   */
  readonly orders: SceneShip[];
}

/**
 * A document mid-edit: operations write unvalidated values into it, and normalizeScene checks the result.
 */
type SceneDraft = JsonObject & { ships: JsonObject[]; camera: JsonObject; environment: JsonObject };

const SCENE_KEYS = new Set<string>(['schema', 'name', 'environment', 'location', 'camera', 'ships', 'fleets', 'objects', 'fits', 'personalities', 'combat', 'timeline']);
const SHIP_KEYS = new Set<string>(['id', 'dna', 'name', 'team', 'position', 'rotation', 'type', 'stats', 'propMod', 'fit', 'pilot', 'orders']);

const CAMERA_KEYS = new Set<string>(['target', 'distance', 'yaw', 'pitch', 'fov', 'mode']);
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
    camera: { target: null, distance: null, yaw: 45, pitch: -15, fov: 45, mode: 'orbit' },
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
  const located = normalizeSceneLocation({ input: input['location'] });
  problems.push(...located.problems);
  warnings.push(...located.warnings);

  const scene: SceneDocument = {
    schema: SCENE_SCHEMA,
    name: input['name'] === undefined ? DEFAULT_SCENE_NAME : readString(input['name'], 'name', problems),
    environment: normalizeEnvironment(input['environment'], problems, warnings),
    ...(located.location ? { location: located.location } : {}),
    camera: normalizeCamera(input['camera'], problems, warnings),
    ships: []
  };

  const fits = normalizeSceneFits(input['fits']);
  problems.push(...fits.problems);
  const ships = input['ships'];
  if (ships !== undefined && !Array.isArray(ships)) problems.push('ships must be an array');
  const ids = new Set<string>();
  const scripted: { readonly ship: SceneShip; readonly index: number; readonly orders: unknown }[] = [];
  for (const [index, ship] of (Array.isArray(ships) ? ships : []).entries()) {
    const normalized = normalizeShip(ship, `ships[${index}]`, { problems, warnings, fits: fits.fits });
    if (!normalized) continue;
    if (ids.has(normalized.id)) problems.push(`ships[${index}].id "${normalized.id}" is used more than once`);
    ids.add(normalized.id);
    scene.ships.push(normalized);
    if (isPlainObject(ship) && ship['orders'] != null) scripted.push({ ship: normalized, index, orders: ship['orders'] });
  }

  const objects = normalizeSceneObjects({ input: input['objects'], shipIds: ids });
  problems.push(...objects.problems);
  warnings.push(...objects.warnings);
  const target = scene.camera.target;
  if (target != null && !ids.has(target) && !objects.ids.has(target)) {
    problems.push(`camera.target "${target}" is not a ship or object id`);
  }
  const personalities = normalizeScenePersonalities(input['personalities']);
  problems.push(...personalities.problems);
  warnings.push(...personalities.warnings);
  const fleets = normalizeFleets({ input: input['fleets'], shipIds: ids, targetIds: new Set([...ids, ...objects.ids]), personalityNames: personalities.names });
  problems.push(...fleets.problems);
  warnings.push(...fleets.warnings);
  if (fleets.fleets) scene.fleets = fleets.fleets;
  if (objects.objects) scene.objects = objects.objects;
  if (fits.fits) scene.fits = fits.fits;
  if (personalities.personalities) scene.personalities = personalities.personalities;
  const combat = normalizeSceneCombat(input['combat']);
  problems.push(...combat.problems);
  warnings.push(...combat.warnings);
  if (combat.combat) scene.combat = combat.combat;
  normalizeScript({ input, scene, scripted, targetIds: new Set([...ids, ...objects.ids]), problems, warnings });

  if (problems.length) throw new SceneError(problems);
  return { scene, warnings };
}

/**
 * Applies edit operations to a document and returns the normalized result; the
 * input is not modified. Operations run in order and all must succeed.
 *
 * Operations:
 *   { op: "add_ship", ship, warpIn? }   warpIn (true, or { stagger?, together? }): it lands from warp at its placement,
 *                                       along its rotation's yaw (the result's arrivals; the page plans it)
 *   { op: "update_ship", id, set: { dna?, name?, team?, position?, rotation?, type?, stats?, propMod?, fit?, orders?, pilot? } }
 *                                       each key replaces the ship's value (stats, propMod and orders as a whole); null
 *                                       clears type, stats, propMod, fit, pilot and orders
 *   { op: "remove_ship", id }               also takes the ship out of its fleet (a fleet commander is refused) and off
 *                                       every fleet's, wing's and squad's called targets, with a warning
 *   { op: "set_camera", camera }            merged into the current camera
 *   { op: "set_environment", environment }  merged into the current environment
 *   { op: "rename", name }
 *   { op: "set_location", location }   replaces the scene's location (system id, origin, anchor); the set_location tool
 *                                       resolves names. Ships stay where they are in the scene
 *   { op: "clear_location" }               removes it; a no-op without one
 *   { op: "add_fleet", fleet }   { op: "update_fleet", fleet, set: { name?, commander?, targets?, personality? } }
 *                                       personality: a built-in name or a key of personalities (null clears)
 *   { op: "remove_fleet", fleet, withShips? }   withShips: true also removes every ship holding a position in it
 *   { op: "add_wing", fleet, wing }   { op: "update_wing", fleet, wing, set: { name?, commander?, targets? } }   { op: "remove_wing", fleet, wing }
 *   { op: "add_squad", fleet, wing, squad }   { op: "update_squad", fleet, squad, set: { name?, role?, commander?, anchor?, targets? } }
 *                                       targets: the group's opening called targets (ship or object ids in kill
 *                                       order; null clears); order_fleet's targets order calls live (fleets/targets.ts)
 *   { op: "remove_squad", fleet, squad }
 *   { op: "move_to_squad", ships, fleet, squad }   { op: "remove_from_fleet", ships }
 *   { op: "set_anchor", fleet, squad, anchor: { ship?, range? } }   merged; null resets ship to the FC and range to the role default
 *                                       a ship taken out of a squad falls squads anchored on it back to their squad
 *                                       commander, then wing commander, then the FC, with a warning
 *   { op: "add_fleet_composition", composition, position, heading? | facing?, fleet?, team?, warpIn? }
 *                                       adds a cjs-fleet/1 composition's ships in formation and its fleet, with free
 *                                       ids; every ship line needs its dna (see compositions/operation.ts)
 *   { op: "set_prop_mods", ships | fleet [, wing | squad], active?, module? }
 *                                       merged into each selected ship's propMod: active false and module null remove
 *                                       the key (see prop-mods/operation.ts)
 *   { op: "add_ships", dna, hull?, radius?, count?, formation?, spacing?, position? | near?, heading? | facing?, team?,
 *     name?, prefix?, stats?, propMod?, fleet?, radii?, warpIn? }
 *                                       count ships of one hull, free in a formation, as a new fleet, or into a fleet's
 *                                       squad at their formation slots (see staging/add-ships.ts)
 *   { op: "stage_engagement", sides: [A, B], range?, center? | near?, heading?, radii? }
 *                                       two sides (compositions or ship lists) facing each other, fronts range apart
 *                                       (sides[i].warpIn lands a side from warp);
 *                                       every ship line needs its dna (see staging/engagement.ts)
 *   { op: "set_fits", fits: { "<key>": "<EFT text>" | null } }
 *                                       merged into the document's fits; null deletes a key no ship uses (see
 *                                       fitting/operation.ts)
 *   { op: "add_object", object }   { op: "add_objects", dna, type?, radius?, count?, position? | near?, ... }
 *   { op: "update_object", id, set }   { op: "move_object", id, position? | near?, heading? | facing? | rotation? }
 *   { op: "remove_object", id }   static objects (see objects/operations.ts); add_objects needs dna, which the
 *                                       add_objects tool resolves from a type
 *   { op: "set_personalities", personalities: { "<key>": template | null } }
 *                                       merged into the document's personalities; null deletes a key no fleet uses
 *                                       (see personalities/document.ts)
 *   { op: "set_combat", seed?: n | null, death?: "explode" | "flag" | null }
 *                                       merged into the document's combat; null resets a field (see
 *                                       combat/document.ts)
 *   { op: "add_cue", cue }   { op: "update_cue", id, set }   { op: "remove_cue", id }   { op: "set_timeline", timeline }
 *   { op: "clear_timeline" }               the timeline's cues (see timeline/operations.ts); removing a ship, object,
 *                                       fleet, wing or squad prunes the cues and ship steps naming it, with a warning
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
  const arrivals: SceneArrival[] = [];

  for (const [index, operation] of operations.entries()) {
    const where = `operations[${index}]`;
    if (isPlainObject(operation) && typeof operation['op'] === 'string') {
      applyOperation(operation, { draft: next, where, problems, warnings, arrivals });
    } else {
      problems.push(`${where} must be an object with an "op" string`);
    }
  }

  if (problems.length) throw new SceneError(problems);
  const normalized = normalizeScene(next);
  const arriving = keepSceneArrivals(arrivals, new Set(normalized.scene.ships.map((ship) => ship.id)));
  return { scene: normalized.scene, warnings: [...warnings, ...normalized.warnings], ...(arriving.length ? { arrivals: arriving } : {}) };
}

function applyOperation(operation: JsonObject, context: FleetOperationContext & { readonly draft: SceneDraft }): void {
  const { draft: next, where, problems } = context;
  switch (operation['op']) {
    case 'add_ship': {
      const ship = operation['ship'];
      if (!isPlainObject(ship)) problems.push(`${where}.ship must be an object`);
      else if (next.ships.some((candidate) => candidate['id'] === ship['id'])) problems.push(`${where}: ship "${String(ship['id'])}" already exists`);
      else {
        const warpIn = readWarpIn(operation['warpIn'], { where: `${where}.warpIn`, problems, warnings: context.warnings, draft: next, fromRefused: 'add_ship lands along its rotation; turn the ship to face the way it flies in' });
        next.ships.push(structuredClone(ship));
        if (warpIn && typeof ship['id'] === 'string') {
          const yaw = Array.isArray(ship['rotation']) && typeof ship['rotation'][0] === 'number' ? ship['rotation'][0] : 0;
          context.arrivals?.push({ where, group: ship['id'], ships: [ship['id']], leader: ship['id'], lane: toArrivalLane(yaw), landing: 'document', stagger: warpIn.stagger, together: warpIn.together });
        }
      }
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
        removeCalledTarget(String(operation['id']), context);
        removeTimelineReferences({ ships: [String(operation['id'])] }, context);
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
    case 'set_location':
      if (isPlainObject(operation['location'])) next['location'] = structuredClone(operation['location']);
      else problems.push(`${where}.location must be an object; clear_location removes the location`);
      break;
    case 'clear_location':
      delete next['location'];
      break;
    default:
      if (FLEET_OPERATIONS.has(String(operation['op']))) applyFleetOperation(operation, context);
      else if (FLEET_COMPOSITION_OPERATIONS.has(String(operation['op']))) applyFleetCompositionOperation(operation, context);
      else if (PROP_MOD_OPERATIONS.has(String(operation['op']))) applyPropModOperation(operation, context);
      else if (STAGING_OPERATIONS.has(String(operation['op']))) applyStagingOperation(operation, context);
      else if (OBJECT_OPERATIONS.has(String(operation['op']))) applyObjectOperation(operation, context);
      else if (FIT_OPERATIONS.has(String(operation['op']))) applyFitOperation(operation, context);
      else if (COMBAT_OPERATIONS.has(String(operation['op']))) applyCombatOperation(operation, context);
      else if (PERSONALITY_OPERATIONS.has(String(operation['op']))) applyPersonalityOperation(operation, context);
      else if (TIMELINE_OPERATIONS.has(String(operation['op']))) applyTimelineOperation(operation, context);
      else problems.push(`${where}: unknown op "${String(operation['op'])}"`);
  }
}

/**
 * What changed between two normalized documents, in the terms the page acts on.
 *
 * @param before - The document the page currently shows, or null on a first load.
 * @param after - The document to show.
 * @returns The ships to add, remove, rebuild, move, relabel, retune, switch, regroup and restart the scripts of, whether
 *   the environment, camera, fleets or location changed, and what changed in the objects.
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
    switched: [],
    fleets: !sameJson(before?.fleets ?? [], after.fleets ?? []),
    regrouped: [],
    location: !sameJson(before?.location ?? null, after.location ?? null),
    objects: diffSceneObjects(before?.objects ?? [], after.objects ?? []),
    combat: !sameJson(before?.combat ?? null, after.combat ?? null),
    orders: []
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
      if (!sameJson(old.type, ship.type) || !sameJson(old.stats, ship.stats) || !sameJson(pilotFlightPart(old.pilot), pilotFlightPart(ship.pilot)) || !sameJson(old.propMod?.module, ship.propMod?.module) || fitTextOf(old, before) !== fitTextOf(ship, after)) diff.retuned.push(ship);
    } else {
      diff.rebuilt.push(ship);
    }
    if (old && !sameJson(membershipsBefore.get(id), membershipsAfter.get(id))) diff.regrouped.push(ship);
    if (old && (old.propMod?.active === true) !== (ship.propMod?.active === true)) diff.switched.push(ship);
    if (old && !sameJson(old.orders ?? null, ship.orders ?? null)) diff.orders.push(ship);
  }
  return diff;
}

interface NormalizeScriptInput {
  readonly input: JsonObject;
  readonly scene: SceneDocument;
  readonly scripted: readonly { readonly ship: SceneShip; readonly index: number; readonly orders: unknown }[];
  readonly targetIds: ReadonlySet<string>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Reads the ships' orders, then the timeline (last: its projection applies patch cues to the rest of the document), and
 * warns about step targets that are neither an id the document holds nor one a cue adds.
 */
function normalizeScript(input: NormalizeScriptInput): void {
  const { scene, problems, warnings } = input;
  const memberships = toFleetMemberships(scene);
  const names: ShipStepName[] = [];
  for (const { ship, index, orders } of input.scripted) {
    const steps = normalizeShipOrderSteps({ input: orders, where: `ships[${index}].orders`, self: ship.id, targets: input.targetIds, inFleet: memberships.has(ship.id) });
    problems.push(...steps.problems);
    warnings.push(...steps.warnings);
    names.push(...steps.names);
    if (steps.steps) ship.orders = steps.steps;
  }
  const timeline = normalizeSceneTimeline({ input: input.input['timeline'], scene, apply: applySceneOperations, project: !problems.length });
  problems.push(...timeline.problems);
  warnings.push(...timeline.warnings);
  for (const name of names) if (!timeline.addedTargets.has(name.target)) warnings.push(shipStepNameWarning(name));
  if (timeline.timeline) scene.timeline = timeline.timeline;
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
  if (input['mode'] !== undefined) {
    if (SCENE_CAMERA_MODES.includes(input['mode'] as SceneCameraMode)) camera.mode = input['mode'] as SceneCameraMode;
    else problems.push(`camera.mode must be one of ${SCENE_CAMERA_MODES.join(', ')}`);
  }
  return camera;
}

interface NormalizeShipContext {
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * The document's normalized fits, for the ship's fit key.
   */
  readonly fits: Maybe<Readonly<Record<string, string>>>;
}

function normalizeShip(input: unknown, where: string, context: NormalizeShipContext): Maybe<SceneShip> {
  const { problems, warnings } = context;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, SHIP_KEYS, where, warnings);

  const ship: SceneShip = {
    id: readString(input['id'], `${where}.id`, problems),
    dna: readString(input['dna'], `${where}.dna`, problems),
    position: input['position'] === undefined ? [0, 0, 0] : readScenePosition(input['position'], `${where}.position`, problems),
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

  const propMod = normalizeShipPropMod({ input: input['propMod'], where: `${where}.propMod` });
  problems.push(...propMod.problems);
  warnings.push(...propMod.warnings);
  if (propMod.propMod) ship.propMod = propMod.propMod;

  const fit = normalizeShipFit({ input: input['fit'], where: `${where}.fit`, fits: context.fits, type: ship.type });
  problems.push(...fit.problems);
  warnings.push(...fit.warnings);
  if (fit.fit != null) ship.fit = fit.fit;

  const pilot = normalizeShipPilot({ input: input['pilot'], where: `${where}.pilot` });
  problems.push(...pilot.problems);
  warnings.push(...pilot.warnings);
  if (pilot.pilot != null) ship.pilot = pilot.pilot;
  return ship;
}
