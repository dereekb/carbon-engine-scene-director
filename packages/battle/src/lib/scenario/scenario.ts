import type { Maybe } from '@dereekb/util';
import { AUTO_REPAIR_POLICIES, type AutoRepairPolicy, FLEET_PERSONALITY_SCHEMA, SCENE_SCHEMA, type SceneVector } from '@scene-director/scene';

/**
 * The scenario file's schema: a battle the console stages and starts with no agent (sd-console).
 */
export const SCENARIO_SCHEMA = 'cjs-scenario/1';

export const SCENARIO_SIDE_STARTS = ['engage', 'hold'] as const;

/**
 * How a side starts: `engage` lets its FC brain fight at once, `hold` waits for Engage (a hold stance plus cease_fire,
 * cued when it lands, or at t = 0 when it starts placed).
 */
export type ScenarioSideStart = (typeof SCENARIO_SIDE_STARTS)[number];

export const SCENARIO_STARTS = ['playing', 'paused'] as const;

/**
 * Whether the scene's clock plays once the scenario loads.
 */
export type ScenarioStart = (typeof SCENARIO_STARTS)[number];

export const SCENARIO_LOGI_FORMATIONS = ['follow', 'loose'] as const;

/**
 * The logi squads' stance: `follow` keeps their anchor (30 km on the FC), `loose` flies them as support pilots.
 */
export type ScenarioLogiFormation = (typeof SCENARIO_LOGI_FORMATIONS)[number];

/**
 * Where a fleet's Retreat aligns and its Warp out warps: a ship, object or celestial id or place name, a point
 * (origin-relative metres), or `away` (straight away from the nearest enemy fleet).
 */
export type ScenarioRetreat = string | SceneVector;

export const SCENARIO_RETREAT_AWAY = 'away';

/**
 * A fleet's doctrine: a base personality's name, or a template (its `extends` the base, default `line`), with the
 * overrides the settings dialog edits.
 */
export type ScenarioPersonality = string | ScenarioPersonalityTemplate;

export interface ScenarioPersonalityTemplate {
  readonly extends?: string;
  readonly name?: string;
  readonly description?: string;
  readonly engage?: string;
  readonly targeting?: Readonly<Record<string, unknown>>;
  readonly movement?: Readonly<Record<string, unknown>>;
  readonly command?: Readonly<Record<string, unknown>>;
  readonly pilots?: Readonly<Record<string, unknown>>;
}

export interface ScenarioLogiSettings {
  readonly formation?: ScenarioLogiFormation;
  readonly autoRepair?: { readonly on?: boolean; readonly policy?: AutoRepairPolicy };
}

/**
 * One fleet's FC settings: the doctrine, the logi and the out.
 */
export interface ScenarioFleetSettings {
  readonly personality?: ScenarioPersonality;
  readonly logi?: ScenarioLogiSettings;
  readonly retreat?: ScenarioRetreat;
}

/**
 * One side: stage_engagement's side fields, plus how it arrives and starts, and its settings.
 */
export interface ScenarioSide {
  readonly fleet: string;
  readonly team?: string;
  readonly name?: string;
  readonly composition?: string | Readonly<Record<string, unknown>>;
  readonly ships?: readonly Readonly<Record<string, unknown>>[];
  readonly formation?: string;
  readonly spacing?: number;
  readonly prefix?: string;
  readonly warpIn?: boolean | Readonly<Record<string, unknown>>;
  readonly start?: ScenarioSideStart;
  readonly settings?: ScenarioFleetSettings;
}

export interface Scenario {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /**
   * A set_location place.
   */
  readonly location?: string;
  readonly combat?: { readonly seed?: number; readonly death?: 'explode' | 'flag' };
  readonly range?: number;
  readonly heading?: number;
  readonly center?: SceneVector;
  readonly near?: Readonly<Record<string, unknown>>;
  readonly sides: readonly ScenarioSide[];
  readonly camera?: { readonly auto: true | Readonly<Record<string, unknown>> };
  readonly start?: ScenarioStart;
  /**
   * Extra timeline cues.
   */
  readonly timeline?: readonly Readonly<Record<string, unknown>>[];
  readonly compositions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly personalities?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly fits?: Readonly<Record<string, string>>;
  /**
   * A pre-staged scene used instead of location and sides' staging; settings still apply by fleet id.
   */
  readonly scene?: Readonly<Record<string, unknown>>;
}

/**
 * A settings drop: the same schema with only `id` and `sides[].fleet` plus `settings`. It never restarts the battle.
 */
export interface ScenarioSettingsDrop {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly id: string;
  readonly sides: readonly { readonly fleet: string; readonly settings: ScenarioFleetSettings }[];
}

export interface NormalizedScenario {
  readonly kind: 'scenario';
  readonly scenario: Scenario;
  readonly warnings: string[];
}

export interface NormalizedScenarioSettingsDrop {
  readonly kind: 'settings';
  readonly drop: ScenarioSettingsDrop;
  readonly warnings: string[];
}

export type NormalizedScenarioInput = NormalizedScenario | NormalizedScenarioSettingsDrop;

/**
 * Every problem normalizing a scenario found, at once.
 */
export class ScenarioError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The scenario is invalid: ${problems.join('; ')}`);
    this.name = 'ScenarioError';
    this.problems = problems;
  }
}

type JsonObject = Record<string, unknown>;

const SCENARIO_KEYS = new Set(['schema', 'id', 'name', 'description', 'location', 'combat', 'range', 'heading', 'center', 'near', 'sides', 'camera', 'start', 'timeline', 'compositions', 'personalities', 'fits', 'scene']);
const SIDE_KEYS = new Set(['fleet', 'team', 'name', 'composition', 'ships', 'formation', 'spacing', 'prefix', 'warpIn', 'start', 'settings', 'personality']);
const SETTINGS_KEYS = new Set(['personality', 'logi', 'retreat']);
const STAGING_KEYS = ['location', 'combat', 'range', 'heading', 'center', 'near', 'camera', 'start', 'timeline', 'compositions', 'personalities', 'fits', 'scene'];
const STAGING_SIDE_KEYS = ['team', 'name', 'composition', 'ships', 'formation', 'spacing', 'prefix', 'warpIn', 'start'];
const PERSONALITY_TEMPLATE_KEYS = new Set(['schema', 'id', 'extends', 'name', 'description', 'engage', 'targeting', 'movement', 'command', 'pilots']);

/**
 * Whether a value is a plain JSON object.
 *
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a parsed scenario file is a settings drop: no staging field at the top, and sides carrying only `fleet` and
 * `settings`.
 *
 * @param input - A parsed `cjs-scenario/1` file.
 * @returns True for a settings drop.
 */
export function isScenarioSettingsDrop(input: unknown): boolean {
  let drop = false;

  if (isJsonObject(input) && Array.isArray(input['sides'])) {
    const sides = input['sides'] as unknown[];
    drop = !STAGING_KEYS.some((key) => key in input) && sides.length > 0 && sides.every((side) => isJsonObject(side) && 'settings' in side && !STAGING_SIDE_KEYS.some((key) => key in side));
  }

  return drop;
}

/**
 * Reads a scenario file (a whole scenario, or a settings drop), reporting every problem at once.
 *
 * @param input - The parsed file.
 * @returns The scenario or the settings drop, and its warnings.
 * @throws {ScenarioError} With every problem found.
 */
export function normalizeScenario(input: unknown): NormalizedScenarioInput {
  const problems: string[] = [];
  const warnings: string[] = [];
  let result: Maybe<NormalizedScenarioInput>;

  if (!isJsonObject(input)) {
    problems.push('a scenario must be a JSON object');
  } else if (input['schema'] !== SCENARIO_SCHEMA) {
    problems.push(`schema must be "${SCENARIO_SCHEMA}"`);
  } else if (isScenarioSettingsDrop(input)) {
    const drop = readSettingsDrop(input, problems, warnings);
    result = { kind: 'settings', drop, warnings };
  } else {
    const scenario = readScenario(input, problems, warnings);
    result = { kind: 'scenario', scenario, warnings };
  }

  if (problems.length > 0 || !result) {
    throw new ScenarioError(problems);
  }

  return result;
}

function readSettingsDrop(input: JsonObject, problems: string[], warnings: string[]): ScenarioSettingsDrop {
  const id = readRequiredId(input['id'], 'id', problems);
  const seen = new Set<string>();
  const sides = (input['sides'] as unknown[]).map((side, index) => {
    const where = `sides[${index}]`;
    const object = side as JsonObject;
    const fleet = readRequiredId(object['fleet'], `${where}.fleet`, problems);

    if (seen.has(fleet)) {
      problems.push(`${where}.fleet "${fleet}" is named twice`);
    }

    seen.add(fleet);
    reportUnknown(object, new Set(['fleet', 'settings']), where, warnings);
    return { fleet, settings: readFleetSettings(object['settings'], `${where}.settings`, problems, warnings) };
  });

  return { schema: SCENARIO_SCHEMA, id, sides };
}

function readScenario(input: JsonObject, problems: string[], warnings: string[]): Scenario {
  reportUnknown(input, SCENARIO_KEYS, 'scenario', warnings);
  const id = readRequiredId(input['id'], 'id', problems);
  const scene = readOptionalObject(input['scene'], 'scene', problems);

  if (scene && scene['schema'] !== SCENE_SCHEMA) {
    problems.push(`scene must be a "${SCENE_SCHEMA}" document`);
  }

  const sides = readSides(input['sides'], Boolean(scene), problems, warnings);
  const center = input['center'] == null ? undefined : readVector(input['center'], 'center', problems);
  const near = readOptionalObject(input['near'], 'near', problems);

  if (center && near) {
    problems.push('give center or near, not both');
  }

  return compactObject<Scenario>({
    schema: SCENARIO_SCHEMA,
    id,
    name: readOptionalText(input['name'], 'name', problems),
    description: readOptionalText(input['description'], 'description', problems),
    location: readOptionalText(input['location'], 'location', problems),
    combat: readCombat(input['combat'], problems),
    range: readOptionalNumber(input['range'], 'range', problems, 0),
    heading: readOptionalNumber(input['heading'], 'heading', problems),
    center,
    near,
    sides,
    camera: readCamera(input['camera'], problems),
    start: readOptionalEnum(input['start'], SCENARIO_STARTS, 'start', problems),
    timeline: readOptionalObjectList(input['timeline'], 'timeline', problems),
    compositions: readObjectMap(input['compositions'], 'compositions', problems),
    personalities: readObjectMap(input['personalities'], 'personalities', problems),
    fits: readFits(input['fits'], problems),
    scene
  });
}

function readSides(value: unknown, prestaged: boolean, problems: string[], warnings: string[]): ScenarioSide[] {
  const sides: ScenarioSide[] = [];

  if (!Array.isArray(value) || value.length !== 2) {
    problems.push('sides must be an array of exactly two sides');
  } else {
    value.forEach((side, index) => {
      const read = readSide(side, `sides[${index}]`, prestaged, problems, warnings);

      if (read) {
        sides.push(read);
      }
    });

    if (sides.length === 2 && sides[0].fleet === sides[1].fleet) {
      problems.push(`the two sides need different fleet ids (both are "${sides[0].fleet}")`);
    }
  }

  return sides;
}

function readSide(value: unknown, where: string, prestaged: boolean, problems: string[], warnings: string[]): Maybe<ScenarioSide> {
  let side: Maybe<ScenarioSide>;

  if (isJsonObject(value)) {
    reportUnknown(value, SIDE_KEYS, where, warnings);
    const composition = value['composition'];
    const ships = readOptionalObjectList(value['ships'], `${where}.ships`, problems);

    if (composition != null && typeof composition !== 'string' && !isJsonObject(composition)) {
      problems.push(`${where}.composition must be a composition name or an inline composition`);
    }

    if (!prestaged && composition == null && ships == null) {
      problems.push(`${where} needs a composition or ships`);
    } else if (composition != null && ships != null) {
      problems.push(`${where}: give a composition or ships, not both`);
    }

    if ('personality' in value) {
      warnings.push(`${where}.personality is ignored: give the doctrine as ${where}.settings.personality`);
    }

    const warpIn = value['warpIn'];

    if (warpIn != null && typeof warpIn !== 'boolean' && !isJsonObject(warpIn)) {
      problems.push(`${where}.warpIn must be true, false or { stagger?, together? }`);
    }

    side = compactObject<ScenarioSide>({
      fleet: readRequiredId(value['fleet'], `${where}.fleet`, problems),
      team: readOptionalText(value['team'], `${where}.team`, problems),
      name: readOptionalText(value['name'], `${where}.name`, problems),
      composition,
      ships,
      formation: readOptionalText(value['formation'], `${where}.formation`, problems),
      spacing: readOptionalNumber(value['spacing'], `${where}.spacing`, problems, 0),
      prefix: readOptionalText(value['prefix'], `${where}.prefix`, problems),
      warpIn,
      start: readOptionalEnum(value['start'], SCENARIO_SIDE_STARTS, `${where}.start`, problems),
      settings: value['settings'] == null ? undefined : readFleetSettings(value['settings'], `${where}.settings`, problems, warnings)
    });
  } else {
    problems.push(`${where} must be an object`);
  }

  return side;
}

/**
 * Reads one fleet's settings.
 *
 * @param value - The settings object.
 * @param where - Its path, for messages.
 * @param problems - Problems are added here.
 * @param warnings - Warnings are added here.
 * @returns The settings.
 */
export function readFleetSettings(value: unknown, where: string, problems: string[], warnings: string[]): ScenarioFleetSettings {
  let settings: ScenarioFleetSettings = {};

  if (isJsonObject(value)) {
    reportUnknown(value, SETTINGS_KEYS, where, warnings);
    settings = compactObject<ScenarioFleetSettings>({
      personality: readPersonality(value['personality'], `${where}.personality`, problems, warnings),
      logi: readLogi(value['logi'], `${where}.logi`, problems, warnings),
      retreat: readRetreat(value['retreat'], `${where}.retreat`, problems)
    });
  } else {
    problems.push(`${where} must be an object`);
  }

  return settings;
}

function readPersonality(value: unknown, where: string, problems: string[], warnings: string[]): Maybe<ScenarioPersonality> {
  let personality: Maybe<ScenarioPersonality>;

  if (typeof value === 'string' && value.trim()) {
    personality = value.trim();
  } else if (isJsonObject(value)) {
    reportUnknown(value, PERSONALITY_TEMPLATE_KEYS, where, warnings);

    if (value['schema'] != null && value['schema'] !== FLEET_PERSONALITY_SCHEMA) {
      problems.push(`${where}.schema must be "${FLEET_PERSONALITY_SCHEMA}" when given`);
    }

    if (value['extends'] != null && typeof value['extends'] !== 'string') {
      problems.push(`${where}.extends must be a personality name`);
    }

    const { schema: _schema, id: _id, ...template } = value;
    personality = template as ScenarioPersonalityTemplate;
  } else if (value != null) {
    problems.push(`${where} must be a personality name or a template`);
  }

  return personality;
}

function readLogi(value: unknown, where: string, problems: string[], warnings: string[]): Maybe<ScenarioLogiSettings> {
  let logi: Maybe<ScenarioLogiSettings>;

  if (isJsonObject(value)) {
    reportUnknown(value, new Set(['formation', 'autoRepair']), where, warnings);
    const autoRepair = value['autoRepair'];
    let readAutoRepair: ScenarioLogiSettings['autoRepair'];

    if (isJsonObject(autoRepair)) {
      if (autoRepair['on'] != null && typeof autoRepair['on'] !== 'boolean') {
        problems.push(`${where}.autoRepair.on must be true or false`);
      }

      readAutoRepair = compactObject<NonNullable<ScenarioLogiSettings['autoRepair']>>({ on: autoRepair['on'], policy: readOptionalEnum(autoRepair['policy'], AUTO_REPAIR_POLICIES, `${where}.autoRepair.policy`, problems) });
    } else if (autoRepair != null) {
      problems.push(`${where}.autoRepair must be { on?, policy? }`);
    }

    logi = compactObject<ScenarioLogiSettings>({ formation: readOptionalEnum(value['formation'], SCENARIO_LOGI_FORMATIONS, `${where}.formation`, problems), autoRepair: readAutoRepair });
  } else if (value != null) {
    problems.push(`${where} must be { formation?, autoRepair? }`);
  }

  return logi;
}

function readRetreat(value: unknown, where: string, problems: string[]): Maybe<ScenarioRetreat> {
  let retreat: Maybe<ScenarioRetreat>;

  if (typeof value === 'string' && value.trim()) {
    retreat = value.trim();
  } else if (Array.isArray(value)) {
    retreat = readVector(value, where, problems);
  } else if (value != null) {
    problems.push(`${where} must be a place name, an id, a point [x, y, z] or "away"`);
  }

  return retreat;
}

function readCombat(value: unknown, problems: string[]): Scenario['combat'] {
  let combat: Scenario['combat'];

  if (isJsonObject(value)) {
    const death = value['death'];

    if (death != null && death !== 'explode' && death !== 'flag') {
      problems.push('combat.death must be "explode" or "flag"');
    }

    combat = compactObject<NonNullable<Scenario['combat']>>({ seed: readOptionalNumber(value['seed'], 'combat.seed', problems), death });
  } else if (value != null) {
    problems.push('combat must be { seed?, death? }');
  }

  return combat;
}

function readCamera(value: unknown, problems: string[]): Scenario['camera'] {
  let camera: Scenario['camera'];

  if (isJsonObject(value)) {
    const auto = value['auto'];

    if (auto === true || isJsonObject(auto)) {
      camera = { auto };
    } else if (auto != null && auto !== false) {
      problems.push("camera.auto must be true or auto_camera's arguments");
    }
  } else if (value != null) {
    problems.push('camera must be { auto }');
  }

  return camera;
}

function readFits(value: unknown, problems: string[]): Maybe<Record<string, string>> {
  let fits: Maybe<Record<string, string>>;

  if (isJsonObject(value)) {
    fits = {};

    for (const [key, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.trim()) {
        fits[key] = text;
      } else {
        problems.push(`fits["${key}"] must be EFT text`);
      }
    }
  } else if (value != null) {
    problems.push('fits must be an object of EFT texts');
  }

  return fits;
}

function readObjectMap(value: unknown, where: string, problems: string[]): Maybe<Record<string, JsonObject>> {
  let map: Maybe<Record<string, JsonObject>>;

  if (isJsonObject(value)) {
    map = {};

    for (const [key, entry] of Object.entries(value)) {
      if (isJsonObject(entry)) {
        map[key] = entry;
      } else {
        problems.push(`${where}["${key}"] must be an object`);
      }
    }
  } else if (value != null) {
    problems.push(`${where} must be an object keyed by name`);
  }

  return map;
}

function readOptionalObjectList(value: unknown, where: string, problems: string[]): Maybe<JsonObject[]> {
  let list: Maybe<JsonObject[]>;

  if (Array.isArray(value)) {
    list = [];

    value.forEach((entry, index) => {
      if (isJsonObject(entry)) {
        list?.push(entry);
      } else {
        problems.push(`${where}[${index}] must be an object`);
      }
    });
  } else if (value != null) {
    problems.push(`${where} must be an array`);
  }

  return list;
}

function readOptionalObject(value: unknown, where: string, problems: string[]): Maybe<JsonObject> {
  let object: Maybe<JsonObject>;

  if (isJsonObject(value)) {
    object = value;
  } else if (value != null) {
    problems.push(`${where} must be an object`);
  }

  return object;
}

function readRequiredId(value: unknown, where: string, problems: string[]): string {
  let id = '';

  if (typeof value === 'string' && value.trim()) {
    id = value.trim();
  } else {
    problems.push(`${where} is required (a non-empty string)`);
  }

  return id;
}

function readOptionalText(value: unknown, where: string, problems: string[]): Maybe<string> {
  let text: Maybe<string>;

  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    problems.push(`${where} must be a string`);
  }

  return text;
}

function readOptionalNumber(value: unknown, where: string, problems: string[], min = -Infinity): Maybe<number> {
  let number: Maybe<number>;

  if (typeof value === 'number' && Number.isFinite(value) && value >= min) {
    number = value;
  } else if (value != null) {
    problems.push(min === -Infinity ? `${where} must be a number` : `${where} must be a number of at least ${min}`);
  }

  return number;
}

function readOptionalEnum<T extends string>(value: unknown, allowed: readonly T[], where: string, problems: string[]): Maybe<T> {
  let read: Maybe<T>;

  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    read = value as T;
  } else if (value != null) {
    problems.push(`${where} must be one of ${allowed.map((option) => JSON.stringify(option)).join(', ')}`);
  }

  return read;
}

function readVector(value: unknown, where: string, problems: string[]): SceneVector {
  let vector: SceneVector = [0, 0, 0];

  if (Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    vector = [value[0], value[1], value[2]];
  } else {
    problems.push(`${where} must be a point [x, y, z] in metres`);
  }

  return vector;
}

function reportUnknown(object: JsonObject, allowed: ReadonlySet<string>, where: string, warnings: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      warnings.push(`${where}.${key} is not a known field and is ignored`);
    }
  }
}

/**
 * A copy without its null and undefined keys, so normalized output compares and serializes cleanly.
 *
 * @param object - Any object.
 * @returns The copy, as the type it reads into.
 */
export function compactObject<T extends object>(object: Readonly<Record<string, unknown>>): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value != null)) as T;
}
