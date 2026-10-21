/**
 * The scene document: the JSON a person or Claude writes to describe a scene,
 * and the only state a saved scene keeps. The page translates it into runtime
 * objects; nothing here imports the runtime, so the bridge, the page and the
 * tests share one definition.
 *
 * Units are EVE's: metres for positions and distances, degrees for angles.
 * Y is up.
 */

export const SCENE_SCHEMA = "cjs-scene/1";

export const DEFAULT_UNIVERSE = "res:/dx9/scene/universe/a01_cube.black";

/** Keys reserved for later phases; accepted and kept, but not acted on yet. */
const RESERVED_SCENE_KEYS = new Set([ "timeline" ]);
const RESERVED_SHIP_KEYS = new Set([ "orders" ]);

const SCENE_KEYS = new Set([ "schema", "name", "environment", "camera", "ships", ...RESERVED_SCENE_KEYS ]);
const SHIP_KEYS = new Set([ "id", "dna", "name", "team", "position", "rotation", ...RESERVED_SHIP_KEYS ]);
const CAMERA_KEYS = new Set([ "target", "distance", "yaw", "pitch", "fov" ]);
const ENVIRONMENT_KEYS = new Set([ "universe" ]);

/** hull:faction:race, then optional `:command?args` segments. */
const DNA_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+(:[^\s]+)*$/u;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

/** A document that cannot be used, with every problem found rather than the first. */
export class SceneError extends Error
{
  constructor(problems)
  {
    super(`Invalid scene document:\n- ${problems.join("\n- ")}`);
    this.name = "SceneError";
    this.problems = problems;
  }
}

/** The smallest valid document. */
export function createEmptyScene(name = "untitled")
{
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
 * @param {unknown} input A candidate document.
 * @returns {{ scene: object, warnings: string[] }} The normalized copy.
 * @throws {SceneError} When the document cannot be used.
 */
export function normalizeScene(input)
{
  const problems = [];
  const warnings = [];

  if (!isPlainObject(input)) throw new SceneError([ "the scene must be a JSON object" ]);
  if (input.schema !== undefined && input.schema !== SCENE_SCHEMA)
  {
    problems.push(`schema must be "${SCENE_SCHEMA}", got ${JSON.stringify(input.schema)}`);
  }
  reportUnknownKeys(input, SCENE_KEYS, "scene", warnings);

  const empty = createEmptyScene();
  const scene = {
    schema: SCENE_SCHEMA,
    name: input.name === undefined ? empty.name : readString(input.name, "name", problems),
    environment: normalizeEnvironment(input.environment, problems, warnings),
    camera: normalizeCamera(input.camera, problems, warnings),
    ships: []
  };

  if (input.ships !== undefined && !Array.isArray(input.ships)) problems.push("ships must be an array");
  const ids = new Set();
  for (const [ index, ship ] of (Array.isArray(input.ships) ? input.ships : []).entries())
  {
    const normalized = normalizeShip(ship, `ships[${index}]`, problems, warnings);
    if (!normalized) continue;
    if (ids.has(normalized.id)) problems.push(`ships[${index}].id "${normalized.id}" is used more than once`);
    ids.add(normalized.id);
    scene.ships.push(normalized);
  }

  if (scene.camera.target !== null && !ids.has(scene.camera.target))
  {
    problems.push(`camera.target "${scene.camera.target}" is not a ship id`);
  }
  for (const key of RESERVED_SCENE_KEYS)
  {
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
 *   { op: "update_ship", id, set: { dna?, name?, team?, position?, rotation?, orders? } }
 *   { op: "remove_ship", id }
 *   { op: "set_camera", camera }            merged into the current camera
 *   { op: "set_environment", environment }  merged into the current environment
 *   { op: "rename", name }
 *
 * @param {object} scene A normalized document.
 * @param {object[]} operations The edits.
 * @returns {{ scene: object, warnings: string[] }} The edited, normalized copy.
 * @throws {SceneError} When an operation is malformed or the result is invalid.
 */
export function applySceneOperations(scene, operations)
{
  if (!Array.isArray(operations) || operations.length === 0) throw new SceneError([ "operations must be a non-empty array" ]);
  const next = structuredClone(scene);
  const problems = [];

  for (const [ index, operation ] of operations.entries())
  {
    const where = `operations[${index}]`;
    if (!isPlainObject(operation) || typeof operation.op !== "string")
    {
      problems.push(`${where} must be an object with an "op" string`);
      continue;
    }
    switch (operation.op)
    {
      case "add_ship":
        if (!isPlainObject(operation.ship)) problems.push(`${where}.ship must be an object`);
        else if (next.ships.some(ship => ship.id === operation.ship.id)) problems.push(`${where}: ship "${operation.ship.id}" already exists`);
        else next.ships.push(structuredClone(operation.ship));
        break;
      case "update_ship":
      {
        const ship = next.ships.find(candidate => candidate.id === operation.id);
        if (!ship) problems.push(`${where}: no ship "${operation.id}"`);
        else if (!isPlainObject(operation.set)) problems.push(`${where}.set must be an object`);
        else if ("id" in operation.set) problems.push(`${where}: a ship's id cannot be changed; remove and add it instead`);
        else Object.assign(ship, structuredClone(operation.set));
        break;
      }
      case "remove_ship":
      {
        const index = next.ships.findIndex(ship => ship.id === operation.id);
        if (index < 0) problems.push(`${where}: no ship "${operation.id}"`);
        else
        {
          next.ships.splice(index, 1);
          if (next.camera.target === operation.id) next.camera.target = null;
        }
        break;
      }
      case "set_camera":
        if (!isPlainObject(operation.camera)) problems.push(`${where}.camera must be an object`);
        else Object.assign(next.camera, structuredClone(operation.camera));
        break;
      case "set_environment":
        if (!isPlainObject(operation.environment)) problems.push(`${where}.environment must be an object`);
        else Object.assign(next.environment, structuredClone(operation.environment));
        break;
      case "rename":
        next.name = operation.name;
        break;
      default:
        problems.push(`${where}: unknown op "${operation.op}"`);
    }
  }

  if (problems.length) throw new SceneError(problems);
  return normalizeScene(next);
}

/**
 * What changed between two normalized documents, in the terms the page acts on.
 *
 * @returns {{ environment: boolean, camera: boolean, added: object[], removed: object[],
 *   rebuilt: object[], moved: object[], relabelled: object[] }}
 */
export function diffScenes(before, after)
{
  const previous = new Map((before?.ships ?? []).map(ship => [ ship.id, ship ]));
  const current = new Map(after.ships.map(ship => [ ship.id, ship ]));
  const diff = {
    environment: !sameJson(before?.environment, after.environment),
    camera: !sameJson(before?.camera, after.camera),
    added: [],
    removed: [],
    rebuilt: [],
    moved: [],
    relabelled: []
  };

  for (const [ id, ship ] of previous) if (!current.has(id)) diff.removed.push(ship);
  for (const [ id, ship ] of current)
  {
    const old = previous.get(id);
    if (!old) diff.added.push(ship);
    else if (old.dna !== ship.dna) diff.rebuilt.push(ship);
    else
    {
      if (!sameJson(old.position, ship.position) || !sameJson(old.rotation, ship.rotation)) diff.moved.push(ship);
      if (old.name !== ship.name || old.team !== ship.team) diff.relabelled.push(ship);
    }
  }
  return diff;
}

function normalizeEnvironment(input, problems, warnings)
{
  const environment = { universe: DEFAULT_UNIVERSE };
  if (input === undefined) return environment;
  if (!isPlainObject(input))
  {
    problems.push("environment must be an object");
    return environment;
  }
  reportUnknownKeys(input, ENVIRONMENT_KEYS, "environment", warnings);
  if (input.universe !== undefined)
  {
    const universe = readString(input.universe, "environment.universe", problems);
    if (universe && !/^res:\/.+\.(black|red)$/iu.test(universe)) problems.push("environment.universe must be a res:/ path to a .black or .red file");
    environment.universe = universe;
  }
  return environment;
}

function normalizeCamera(input, problems, warnings)
{
  const camera = { ...createEmptyScene().camera };
  if (input === undefined) return camera;
  if (!isPlainObject(input))
  {
    problems.push("camera must be an object");
    return camera;
  }
  reportUnknownKeys(input, CAMERA_KEYS, "camera", warnings);
  if (input.target !== undefined && input.target !== null) camera.target = readString(input.target, "camera.target", problems);
  if (input.distance !== undefined && input.distance !== null) camera.distance = readNumber(input.distance, "camera.distance", problems, { min: 1 });
  if (input.yaw !== undefined) camera.yaw = readNumber(input.yaw, "camera.yaw", problems);
  if (input.pitch !== undefined) camera.pitch = readNumber(input.pitch, "camera.pitch", problems, { min: -89, max: 89 });
  if (input.fov !== undefined) camera.fov = readNumber(input.fov, "camera.fov", problems, { min: 5, max: 120 });
  return camera;
}

function normalizeShip(input, where, problems, warnings)
{
  if (!isPlainObject(input))
  {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, SHIP_KEYS, where, warnings);

  const ship = {
    id: readString(input.id, `${where}.id`, problems),
    dna: readString(input.dna, `${where}.dna`, problems),
    position: input.position === undefined ? [ 0, 0, 0 ] : readVector(input.position, `${where}.position`, problems),
    rotation: input.rotation === undefined ? [ 0, 0, 0 ] : readVector(input.rotation, `${where}.rotation`, problems)
  };
  if (ship.id && !ID_PATTERN.test(ship.id)) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  if (ship.dna && !DNA_PATTERN.test(ship.dna)) problems.push(`${where}.dna "${ship.dna}" is not hull:faction:race[:commands]`);
  if (input.name !== undefined) ship.name = readString(input.name, `${where}.name`, problems);
  if (input.team !== undefined) ship.team = readString(input.team, `${where}.team`, problems);
  for (const key of RESERVED_SHIP_KEYS)
  {
    if (input[key] === undefined) continue;
    ship[key] = structuredClone(input[key]);
    warnings.push(`${where}.${key} is reserved for a later phase and is stored but not played yet`);
  }
  return ship;
}

function reportUnknownKeys(object, allowed, where, warnings)
{
  for (const key of Object.keys(object))
  {
    if (!allowed.has(key)) warnings.push(`${where}.${key} is not a known field and was dropped`);
  }
}

function readString(value, where, problems)
{
  if (typeof value === "string" && value.trim()) return value.trim();
  problems.push(`${where} must be a non-empty string`);
  return "";
}

function readNumber(value, where, problems, { min = -Infinity, max = Infinity } = {})
{
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  problems.push(`${where} must be a finite number${min > -Infinity || max < Infinity ? ` in [${min}, ${max}]` : ""}`);
  return 0;
}

function readVector(value, where, problems)
{
  if (Array.isArray(value) && value.length === 3 && value.every(component => typeof component === "number" && Number.isFinite(component)))
  {
    return [ ...value ];
  }
  problems.push(`${where} must be an array of three finite numbers`);
  return [ 0, 0, 0 ];
}

function isPlainObject(value)
{
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a, b)
{
  return JSON.stringify(a) === JSON.stringify(b);
}
