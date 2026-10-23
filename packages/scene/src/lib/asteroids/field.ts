import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, ID_PATTERN, isPlainObject, type JsonObject, readNumber, readString, readVector, reportUnknownKeys, sameJson } from '../json';
import { formatSceneDistance, MAX_SCENE_DISTANCE, readScenePosition } from '../extent';
import { unitHash } from '../fleets/orders';
import type { SceneVector } from '../scene';

/**
 * The shapes a field's rocks fill: a sphere (a shell with innerRadius), a disc (a flat cylinder, densest in its
 * mid-plane), or a ring (a disc with a hole). Disc and ring lie in the field's local XZ plane.
 */
export const ASTEROID_FIELD_SHAPES = ['sphere', 'disc', 'ring'] as const;

export type AsteroidFieldShape = (typeof ASTEROID_FIELD_SHAPES)[number];

/**
 * The three model sets a rock draws from, by its radius within the field's size range.
 */
export const ASTEROID_ROCK_SIZES = ['small', 'medium', 'large'] as const;

export type AsteroidRockSize = (typeof ASTEROID_ROCK_SIZES)[number];

/**
 * The most rocks one field holds.
 */
export const MAX_FIELD_ROCKS = 2000;

/**
 * The most ores one field mixes.
 */
export const MAX_FIELD_ORES = 8;

/**
 * The most distinct rock DNAs one field draws: each is one SOF build and one instanced draw per pass.
 */
export const MAX_FIELD_MODELS = 48;

/**
 * The largest field radius, metres (1,000 km).
 */
export const MAX_FIELD_RADIUS = 1_000_000;

/**
 * The largest rock radius, metres (50 km).
 */
export const MAX_ROCK_RADIUS = 50_000;

export const DEFAULT_FIELD_SHAPE: AsteroidFieldShape = 'sphere';

/**
 * Metres.
 */
export const DEFAULT_FIELD_RADIUS = 20_000;

export const DEFAULT_FIELD_COUNT = 150;

/**
 * Rock radii, metres, for a field of DEFAULT_FIELD_RADIUS or more; a smaller field caps both at radius / 4.
 */
export const DEFAULT_ROCK_SIZE: readonly [number, number] = [300, 3000];

/**
 * A ring's default hole, as a share of its radius.
 */
export const RING_INNER_RATIO = 0.6;

/**
 * A disc's default thickness, as a share of its radius.
 */
export const DISC_THICKNESS_RATIO = 0.25;

/**
 * A ring's default thickness, as a share of its radius.
 */
export const RING_THICKNESS_RATIO = 1 / 6;

/**
 * How many nearest ships get_state lists per field.
 */
export const ASTEROID_FIELD_NEAREST_SHIPS = 3;

/**
 * One ore's rock models, by size: SOF DNAs (`<hull>:<faction>:asteroid`).
 */
export interface SceneAsteroidRocks {
  small: string[];
  medium: string[];
  large: string[];
}

/**
 * One ore of a field: its rock models, and how often it is picked against the others.
 */
export interface SceneAsteroidOre {
  /**
   * The English ore name it was resolved from. Provenance only; the page never looks it up.
   */
  ore?: string;
  /**
   * The EVE type id it was resolved from. Provenance only.
   */
  type?: number;
  /**
   * The SOF rock faction its models come from. Provenance only.
   */
  faction?: string;
  /**
   * The share of rocks against the other ores' weights; 1 when absent.
   */
  weight?: number;
  rocks: SceneAsteroidRocks;
}

/**
 * A seeded asteroid field: expandAsteroidField turns it into rocks, the same rocks everywhere. The page draws them;
 * they have no Destiny balls and are not order targets.
 */
export interface SceneAsteroidField {
  /**
   * Unique across the scene's ships, objects and fields.
   */
  id: string;
  name?: string;
  /**
   * The field centre, scene metres. The whole field (centre, radius and largest rock) sits within MAX_SCENE_DISTANCE.
   */
  position: SceneVector;
  /**
   * `[yaw, pitch, roll]` degrees: turns the field frame. Local Y is a disc's or ring's axis; local +Z the middle of
   * its arc.
   */
  rotation: SceneVector;
  shape: AsteroidFieldShape;
  /**
   * Metres.
   */
  radius: number;
  /**
   * An empty core, metres: a shell, or a hole in a disc. Absent: a ring's RING_INNER_RATIO, else 0.
   */
  innerRadius?: number;
  /**
   * Disc and ring only, metres. Absent: DISC_THICKNESS_RATIO or RING_THICKNESS_RATIO of the radius.
   */
  thickness?: number;
  /**
   * Disc and ring only: degrees of the circle filled, centred on local +Z. Absent: 360.
   */
  arc?: number;
  /**
   * Rocks asked for; a rock that cannot be placed without overlap is dropped.
   */
  count: number;
  /**
   * `[min, max]` rock radii, metres (log-uniform).
   */
  size: [number, number];
  /**
   * 0 to 2^32 - 1. Filled from the id when absent.
   */
  seed: number;
  ores: SceneAsteroidOre[];
}

/**
 * What changed in the fields between two documents.
 */
export interface SceneAsteroidFieldsDiff {
  readonly added: SceneAsteroidField[];
  readonly removed: SceneAsteroidField[];
  /**
   * Kept fields whose rocks changed (shape, radius, innerRadius, thickness, arc, count, size, seed or ores): the page
   * re-expands them.
   */
  readonly rebuilt: SceneAsteroidField[];
  /**
   * Kept fields (not rebuilt) whose position or rotation changed: the page re-places them.
   */
  readonly moved: SceneAsteroidField[];
}

export type SceneAsteroidFieldStatus = 'queued' | 'building' | 'ready' | 'validated' | 'failed' | 'off';

/**
 * One row of `get_state.asteroidFields`: no per-rock lists.
 */
export interface SceneAsteroidFieldStateReport {
  readonly id: string;
  readonly name?: string;
  readonly status: SceneAsteroidFieldStatus;
  readonly error?: string;
  readonly position: SceneVector;
  readonly rotation: SceneVector;
  readonly shape: AsteroidFieldShape;
  readonly radius: number;
  readonly innerRadius?: number;
  readonly thickness?: number;
  readonly arc?: number;
  readonly seed: number;
  readonly rocks: {
    readonly requested: number;
    readonly placed: number;
    readonly bySize: Readonly<Record<AsteroidRockSize, number>>;
    readonly byOre: readonly { readonly ore: string; readonly rocks: number }[];
  };
  readonly models: { readonly total: number; readonly built: number; readonly failed: number; readonly failedDnas?: readonly string[] };
  readonly cells: number;
  /**
   * The radius around the centre every placed rock fits in, metres.
   */
  readonly envelope: number;
  /**
   * Metres from the scene origin to the centre.
   */
  readonly distance: number;
  readonly digest: string;
  /**
   * Up to ASTEROID_FIELD_NEAREST_SHIPS ships, surface to envelope, nearest first (negative inside).
   */
  readonly nearestShips: readonly { readonly id: string; readonly distance: number }[];
}

export interface NormalizedAsteroidFields {
  /**
   * The fields, or null when there are none.
   */
  readonly fields: Maybe<SceneAsteroidField[]>;
  readonly ids: Set<string>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * A field's keys, in the order they are written.
 */
const FIELD_KEYS = ['id', 'name', 'position', 'rotation', 'shape', 'radius', 'innerRadius', 'thickness', 'arc', 'count', 'size', 'seed', 'ores'] as const;

/**
 * An ore's keys, in the order they are written.
 */
const ORE_KEYS = ['ore', 'type', 'faction', 'weight', 'rocks'] as const;

const ROCKS_KEYS = new Set<string>(ASTEROID_ROCK_SIZES);

const SEED_RANGE = 2 ** 32;

/**
 * Validates the document's `asteroidFields` and fills defaults (shape, radius, count, size and the seed are written
 * in). Unknown keys warn and are dropped; keys come out in canonical order, so equal fields serialize the same.
 *
 * @param config - The candidate list and the ids it must not reuse.
 * @param config.input - The candidate `asteroidFields`: absent (null or undefined) or an array.
 * @param config.takenIds - The scene's ship and object ids.
 * @returns The fields, their ids, the problems and the warnings.
 */
export function normalizeAsteroidFields(config: { readonly input: unknown; readonly takenIds: ReadonlySet<string> }): NormalizedAsteroidFields {
  const { input, takenIds } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const fields: SceneAsteroidField[] = [];
  const ids = new Set<string>();
  if (input != null && !Array.isArray(input)) problems.push('asteroidFields must be an array');
  for (const [index, entry] of (Array.isArray(input) ? input : []).entries()) {
    const where = `asteroidFields[${index}]`;
    const field = normalizeAsteroidField(entry, where, problems, warnings);
    if (!field) continue;
    if (takenIds.has(field.id)) problems.push(`${where}.id "${field.id}" is a ship's or object's id; ids are unique across ships, objects and asteroid fields`);
    else if (ids.has(field.id)) problems.push(`${where}.id "${field.id}" is used more than once`);
    ids.add(field.id);
    fields.push(field);
  }
  return { fields: fields.length ? fields : null, ids, problems, warnings };
}

/**
 * Validates one field and fills its defaults.
 *
 * @param input - The candidate field.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problems.
 * @param warnings - Receives the warnings.
 * @returns The field in canonical key order, or null when it is not an object.
 */
export function normalizeAsteroidField(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<SceneAsteroidField> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, new Set<string>(FIELD_KEYS), where, warnings);
  const before = problems.length;
  const id = readString(input['id'], `${where}.id`, problems);
  if (id && !ID_PATTERN.test(id)) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  const field: SceneAsteroidField = { id, position: [0, 0, 0], rotation: [0, 0, 0], shape: DEFAULT_FIELD_SHAPE, radius: DEFAULT_FIELD_RADIUS, count: DEFAULT_FIELD_COUNT, size: [...DEFAULT_ROCK_SIZE], seed: 0, ores: [] };
  if (input['name'] != null) field.name = readString(input['name'], `${where}.name`, problems);
  if (input['position'] != null) field.position = readScenePosition(input['position'], `${where}.position`, problems);
  if (input['rotation'] != null) field.rotation = readVector(input['rotation'], `${where}.rotation`, problems);
  const shape = input['shape'];
  if (shape != null) {
    if (ASTEROID_FIELD_SHAPES.includes(shape as AsteroidFieldShape)) field.shape = shape as AsteroidFieldShape;
    else problems.push(`${where}.shape must be one of ${ASTEROID_FIELD_SHAPES.join(', ')}`);
  }
  if (input['radius'] != null) field.radius = readMetres(input['radius'], `${where}.radius`, problems, { above: 0, max: MAX_FIELD_RADIUS }) ?? DEFAULT_FIELD_RADIUS;
  if (input['innerRadius'] != null) {
    const inner = readMetres(input['innerRadius'], `${where}.innerRadius`, problems, { min: 0 });
    if (inner != null && inner >= field.radius) problems.push(`${where}.innerRadius ${inner} m must be under the radius (${field.radius} m)`);
    else if (inner != null) field.innerRadius = inner;
  }
  for (const key of ['thickness', 'arc'] as const) {
    if (input[key] == null) continue;
    if (field.shape === 'sphere') {
      warnings.push(`${where}.${key} applies to a disc or ring, not a sphere, and was dropped`);
      continue;
    }
    const value = key === 'thickness' ? readMetres(input[key], `${where}.thickness`, problems, { above: 0 }) : readArc(input[key], `${where}.arc`, problems);
    if (value != null) field[key] = value;
  }
  if (input['count'] != null) {
    const count = input['count'];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= MAX_FIELD_ROCKS) field.count = count;
    else problems.push(`${where}.count must be a whole number from 1 to ${MAX_FIELD_ROCKS.toLocaleString('en-US')}`);
  }
  field.size = input['size'] == null ? defaultRockSize(field.radius) : (readRockSize(input['size'], `${where}.size`, problems) ?? field.size);
  if (field.size[1] >= field.radius) problems.push(`${where}.size: the largest rock (${field.size[1]} m) must be smaller than the field radius (${field.radius} m)`);
  if (input['seed'] != null) {
    const seed = input['seed'];
    if (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed < SEED_RANGE) field.seed = seed;
    else problems.push(`${where}.seed must be a whole number from 0 to ${SEED_RANGE - 1}`);
  } else field.seed = defaultAsteroidFieldSeed(id);
  field.ores = readOres(input['ores'], `${where}.ores`, problems, warnings);
  const limit = asteroidFieldEnvelopeLimit(field);
  if (problems.length === before && limit > MAX_SCENE_DISTANCE) {
    problems.push(`${where} reaches ${formatSceneDistance(limit)} from the scene origin (centre, radius and largest rock); a scene spans at most ${formatSceneDistance(MAX_SCENE_DISTANCE)} around its origin; place it closer, shrink it, or move the origin there with set_location`);
  }
  // Rebuild in canonical key order.
  const ordered = Object.fromEntries(FIELD_KEYS.filter((key) => field[key] !== undefined).map((key) => [key, field[key]]));
  return ordered as unknown as SceneAsteroidField;
}

/**
 * A field's default seed: a hash of its id, so two default fields differ and a field keeps its rocks across saves.
 *
 * @param id - The field id.
 * @returns A whole number from 0 to 2^32 - 1.
 */
export function defaultAsteroidFieldSeed(id: string): number {
  return Math.floor(unitHash(`asteroid-field|${id}`) * SEED_RANGE);
}

/**
 * The default rock radii for a field radius: DEFAULT_ROCK_SIZE, both capped at a quarter of the radius.
 *
 * @param radius - The field radius, metres.
 * @returns `[min, max]`, metres.
 */
export function defaultRockSize(radius: number): [number, number] {
  const max = Math.min(DEFAULT_ROCK_SIZE[1], Math.round(radius / 4)) || radius / 4;
  return [Math.min(DEFAULT_ROCK_SIZE[0], max), max];
}

/**
 * How far from the scene origin a field can reach: its centre's distance, its radius and its largest rock.
 *
 * @param field - The field.
 * @returns Metres.
 */
export function asteroidFieldEnvelopeLimit(field: Pick<SceneAsteroidField, 'position' | 'radius' | 'size'>): number {
  return Math.hypot(...field.position) + field.radius + field.size[1];
}

/**
 * Every distinct rock DNA a field draws.
 *
 * @param field - The field.
 * @returns The DNAs, in first-use order.
 */
export function asteroidFieldModels(field: Pick<SceneAsteroidField, 'ores'>): string[] {
  return [...new Set(field.ores.flatMap((ore) => ASTEROID_ROCK_SIZES.flatMap((size) => ore.rocks[size])))];
}

/**
 * What changed in the fields between two normalized documents.
 *
 * @param before - The fields the page shows.
 * @param after - The fields to show.
 * @returns The added, removed, rebuilt and moved fields. A name change needs nothing from the page.
 */
export function diffAsteroidFields(before: readonly SceneAsteroidField[], after: readonly SceneAsteroidField[]): SceneAsteroidFieldsDiff {
  const previous = new Map(before.map((field) => [field.id, field]));
  const current = new Set(after.map((field) => field.id));
  const diff: SceneAsteroidFieldsDiff = { added: [], removed: [], rebuilt: [], moved: [] };
  for (const field of before) if (!current.has(field.id)) diff.removed.push(field);
  for (const field of after) {
    const old = previous.get(field.id);
    if (!old) diff.added.push(field);
    else if (!sameJson(rockKeys(old), rockKeys(field))) diff.rebuilt.push(field);
    else if (!sameJson(old.position, field.position) || !sameJson(old.rotation, field.rotation)) diff.moved.push(field);
  }
  return diff;
}

function rockKeys(field: SceneAsteroidField): unknown[] {
  return [field.shape, field.radius, field.innerRadius ?? null, field.thickness ?? null, field.arc ?? null, field.count, field.size, field.seed, field.ores];
}

function readMetres(value: unknown, where: string, problems: string[], bounds: { readonly min?: number; readonly above?: number; readonly max?: number }): Maybe<number> {
  const { min = -Infinity, above = -Infinity, max = Infinity } = bounds;
  let metres: Maybe<number> = null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value > above && value <= max) metres = value;
  else {
    const floor = above > -Infinity ? `above ${above}` : `from ${min}`;
    const ceiling = max < Infinity ? ` to ${max.toLocaleString('en-US')}` : '';
    problems.push(`${where} must be a number of metres ${floor}${ceiling}`);
  }
  return metres;
}

function readArc(value: unknown, where: string, problems: string[]): Maybe<number> {
  let arc: Maybe<number> = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 360) arc = value;
  else problems.push(`${where} must be degrees above 0, at most 360`);
  return arc;
}

function readRockSize(value: unknown, where: string, problems: string[]): Maybe<[number, number]> {
  let size: Maybe<[number, number]> = null;
  const valid = Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
  if (!valid) problems.push(`${where} must be [min, max] rock radii in metres`);
  else {
    const [min, max] = value as [number, number];
    if (min < 1 || max > MAX_ROCK_RADIUS || min > max) problems.push(`${where} must be [min, max] with 1 <= min <= max <= ${MAX_ROCK_RADIUS.toLocaleString('en-US')} m`);
    else size = [min, max];
  }
  return size;
}

function readOres(value: unknown, where: string, problems: string[], warnings: string[]): SceneAsteroidOre[] {
  const ores: SceneAsteroidOre[] = [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIELD_ORES) {
    problems.push(`${where} must be a list of 1 to ${MAX_FIELD_ORES} ores, each with rocks`);
    return ores;
  }
  for (const [index, entry] of value.entries()) {
    const ore = readOre(entry, `${where}[${index}]`, problems, warnings);
    if (ore) ores.push(ore);
  }
  const models = asteroidFieldModels({ ores }).length;
  if (models > MAX_FIELD_MODELS) problems.push(`${where} use ${models} distinct rock models; a field draws at most ${MAX_FIELD_MODELS} (each is one SOF build); use fewer ores or fewer models per ore`);
  return ores;
}

function readOre(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<SceneAsteroidOre> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object with rocks`);
    return null;
  }
  reportUnknownKeys(input, new Set<string>(ORE_KEYS), where, warnings);
  const ore: Partial<SceneAsteroidOre> = {};
  if (input['ore'] != null) ore.ore = readString(input['ore'], `${where}.ore`, problems);
  if (input['type'] != null) {
    const type = input['type'];
    if (typeof type === 'number' && Number.isSafeInteger(type) && type > 0) ore.type = type;
    else problems.push(`${where}.type must be a positive integer type id`);
  }
  if (input['faction'] != null) ore.faction = readString(input['faction'], `${where}.faction`, problems);
  if (input['weight'] != null) {
    const weight = readNumber(input['weight'], `${where}.weight`, problems);
    if (!(weight > 0)) problems.push(`${where}.weight must be a number above 0`);
    else if (weight !== 1) ore.weight = weight;
  }
  ore.rocks = readRocks(input['rocks'], `${where}.rocks`, problems, warnings);
  const ordered = Object.fromEntries(ORE_KEYS.filter((key) => ore[key] !== undefined).map((key) => [key, ore[key]]));
  return ordered as unknown as SceneAsteroidOre;
}

function readRocks(value: unknown, where: string, problems: string[], warnings: string[]): SceneAsteroidRocks {
  const rocks: SceneAsteroidRocks = { small: [], medium: [], large: [] };
  if (Array.isArray(value)) {
    const list = readDnaList(value, where, problems);
    for (const size of ASTEROID_ROCK_SIZES) rocks[size] = [...list];
  } else if (isPlainObject(value)) {
    reportUnknownKeys(value as JsonObject, ROCKS_KEYS, where, warnings);
    for (const size of ASTEROID_ROCK_SIZES) rocks[size] = readDnaList(value[size], `${where}.${size}`, problems);
  } else problems.push(`${where} must be { small, medium, large } lists of rock DNAs, or one list for all three`);
  return rocks;
}

function readDnaList(value: unknown, where: string, problems: string[]): string[] {
  const list: string[] = [];
  if (!Array.isArray(value) || !value.length) {
    problems.push(`${where} must be a non-empty list of rock DNAs (hull:faction:asteroid)`);
    return list;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string' && DNA_PATTERN.test(entry)) list.push(entry);
    else problems.push(`${where}[${index}] ${JSON.stringify(entry)} is not hull:faction:race[:commands]`);
  }
  return list;
}
