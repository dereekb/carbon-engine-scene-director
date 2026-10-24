/**
 * auto_camera's pure half: the command (the director on or off, and its bias) and the settings it merges into.
 *
 *   auto_camera { on?, follow?: { fleet } | { ship } | null, favour?: wide | medium | close | null, sun?, teams?: [a, b],
 *                 pace?: slow | normal | fast, hold?: { min?, max? }, scales?, framings?, exclude?, minShipSize?,
 *                 letterbox?, hud?, seed? }
 *
 * - Any call hands the camera to the director (`on` defaults to true); `on: false` turns it off.
 * - Bias keys merge one by one into the live layer: a value sets the key, null drops it (back to the scene's
 *   `autoCamera` value, else the default), an omitted key stays (auto_repair's null rule).
 * - `hold` wins over `pace`: min in [2, 60] s, max in [min + 1, 300] s.
 * - The shot rules are hard: `scales` and `framings` allow, `exclude` denies, and `minShipSize` is the floor on how small
 *   the subject's ships may be on screen (a share of the frame height; 0 turns it off).
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject } from '../../json';
import { SceneError } from '../../scene';
import { DIRECTOR_FRAMING_NAMES, DIRECTOR_FRAMINGS, framingScales, type DirectorFramingName } from './framings';

/**
 * The shot scales the director varies between.
 */
export const DIRECTOR_SCALES = ['wide', 'medium', 'close'] as const;

export type DirectorScale = (typeof DIRECTOR_SCALES)[number];

/**
 * The hold presets: how long a director shot stays up, seconds.
 */
export const DIRECTOR_PACES = {
  slow: { min: 6, max: 20 },
  normal: { min: 4, max: 12 },
  fast: { min: 3, max: 7 }
} as const;

export type DirectorPace = keyof typeof DIRECTOR_PACES;

export const DIRECTOR_PACE_NAMES = Object.keys(DIRECTOR_PACES) as DirectorPace[];

export const DEFAULT_DIRECTOR_PACE: DirectorPace = 'normal';

/**
 * `hold` limits, seconds: min in [min[0], min[1]]; max in [min + maxGap, max].
 */
export const DIRECTOR_HOLD_LIMITS = { min: [2, 60], maxGap: 1, max: 300 } as const;

/**
 * The visibility floor's default: the subject's typical hull spans at least this share of the frame height (0.5 %: about
 * 4 px of an 820 px iPad view, 5.4 px at 1080 p).
 */
export const DEFAULT_MIN_SHIP_SIZE = 0.005;
export const MAX_MIN_SHIP_SIZE = 0.25;

/**
 * The director's main subject: a fleet (its acting FC, the successor after a death) or a ship.
 */
export type DirectorFollow = { readonly fleet: string } | { readonly ship: string };

export interface DirectorHold {
  readonly min?: number;
  readonly max?: number;
}

/**
 * auto_camera's arguments, normalized. An omitted key keeps the setting; null resets it.
 */
export interface AutoCameraCommand {
  readonly on?: boolean;
  readonly follow?: DirectorFollow | null;
  readonly favour?: DirectorScale | null;
  readonly sun?: boolean | null;
  readonly teams?: readonly [string, string] | null;
  readonly pace?: DirectorPace | null;
  readonly hold?: DirectorHold | null;
  readonly scales?: readonly DirectorScale[] | null;
  readonly framings?: readonly DirectorFramingName[] | null;
  readonly exclude?: readonly DirectorFramingName[] | null;
  readonly minShipSize?: number | null;
  readonly letterbox?: number | false | null;
  readonly hud?: boolean | null;
  readonly seed?: number | null;
}

/**
 * The bias keys (auto_camera's, less `on`).
 */
export type AutoCameraBiasKey = Exclude<keyof AutoCameraCommand, 'on'>;

/**
 * One layer of bias (the scene's `autoCamera`, or the live overrides of every call and cue since the tab loaded): the
 * keys it sets, never null.
 */
export type AutoCameraBias = { readonly [K in AutoCameraBiasKey]?: Exclude<AutoCameraCommand[K], null> };

/**
 * The director's settings: the defaults ← the scene's `autoCamera` ← the live overrides.
 */
export interface CameraDirectorSettings {
  readonly follow: Maybe<DirectorFollow>;
  readonly favour: Maybe<DirectorScale>;
  /**
   * Into the sun when possible.
   */
  readonly sun: boolean;
  /**
   * The axis of action's two teams; null takes the two biggest with landed ships.
   */
  readonly teams: Maybe<readonly [string, string]>;
  readonly pace: DirectorPace;
  /**
   * The hold override (wins over pace, key by key).
   */
  readonly hold: Maybe<DirectorHold>;
  /**
   * The scales it may pick; null: all.
   */
  readonly scales: Maybe<readonly DirectorScale[]>;
  /**
   * The only framings it may pick; null: all.
   */
  readonly framings: Maybe<readonly DirectorFramingName[]>;
  /**
   * Framings it never picks.
   */
  readonly exclude: readonly DirectorFramingName[];
  /**
   * The visibility floor: the subject's typical hull over the frame height; 0 off.
   */
  readonly minShipSize: number;
  /**
   * Presentation while the director drives; null keeps the page's.
   */
  readonly letterbox: Maybe<number | false>;
  readonly hud: Maybe<boolean>;
  /**
   * The jitter seed; null takes the document's combat seed.
   */
  readonly seed: Maybe<number>;
}

export const DEFAULT_CAMERA_DIRECTOR_SETTINGS: CameraDirectorSettings = {
  follow: null,
  favour: null,
  sun: false,
  teams: null,
  pace: DEFAULT_DIRECTOR_PACE,
  hold: null,
  scales: null,
  framings: null,
  exclude: [],
  minShipSize: DEFAULT_MIN_SHIP_SIZE,
  letterbox: null,
  hud: null,
  seed: null
};

/**
 * The bias keys, in report order.
 */
export const AUTO_CAMERA_BIAS_KEYS: readonly AutoCameraBiasKey[] = ['follow', 'favour', 'sun', 'teams', 'pace', 'hold', 'scales', 'framings', 'exclude', 'minShipSize', 'letterbox', 'hud', 'seed'];

const COMMAND_KEYS = new Set<string>(['on', ...AUTO_CAMERA_BIAS_KEYS]);

/**
 * Reads auto_camera's arguments.
 *
 * @param input - The arguments.
 * @param where - Where they sit, for messages.
 * @returns The command.
 * @throws SceneError listing every problem (unknown keys, bad values).
 */
export function normalizeAutoCameraCommand(input: unknown, where = 'auto_camera'): AutoCameraCommand {
  const problems: string[] = [];
  let command: AutoCameraCommand = {};
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object { on?, follow?, favour?, sun?, teams?, pace?, hold?, scales?, framings?, exclude?, minShipSize?, letterbox?, hud?, seed? }`);
  } else if (input != null) {
    for (const key of Object.keys(input)) if (!COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not an auto_camera field`);
    command = readAutoCameraKeys(input, [...COMMAND_KEYS], where, problems);
  }
  if (problems.length) throw new SceneError(problems);
  return command;
}

/**
 * Reads the given auto_camera keys of an object (auto_camera's arguments, or the scene's `autoCamera` block), pushing a
 * problem per bad value.
 *
 * @param input - The object.
 * @param keys - The keys to read; the rest are ignored.
 * @param where - Where it sits, for messages.
 * @param problems - Collects the problems.
 * @returns The keys read (null kept: it resets).
 */
export function readAutoCameraKeys(input: Record<string, unknown>, keys: readonly string[], where: string, problems: string[]): AutoCameraCommand {
  const command: { -readonly [K in keyof AutoCameraCommand]: AutoCameraCommand[K] } = {};
  const read = new Set(keys);
  const value = (key: string): unknown => (read.has(key) ? input[key] : undefined);
  const { on, follow, favour, sun, teams, pace, hold, scales, framings, exclude, minShipSize, letterbox, hud, seed } = Object.fromEntries([...read].map((key) => [key, value(key)])) as Record<string, unknown>;
  if (on !== undefined) {
    if (typeof on === 'boolean') command.on = on;
    else problems.push(`${where}.on must be true or false`);
  }
  if (follow !== undefined) command.follow = readFollow(follow, `${where}.follow`, problems);
  if (favour !== undefined) {
    if (favour === null || (DIRECTOR_SCALES as readonly unknown[]).includes(favour)) command.favour = favour as DirectorScale | null;
    else problems.push(`${where}.favour must be one of ${DIRECTOR_SCALES.join(', ')}, or null`);
  }
  if (sun !== undefined) {
    if (sun === null || typeof sun === 'boolean') command.sun = sun;
    else problems.push(`${where}.sun must be true, false or null`);
  }
  if (teams !== undefined) {
    if (teams === null) command.teams = null;
    else if (Array.isArray(teams) && teams.length === 2 && teams.every((team) => typeof team === 'string' && ID_PATTERN.test(team)) && teams[0] !== teams[1]) command.teams = [teams[0], teams[1]];
    else problems.push(`${where}.teams must be two different team ids [a, b], or null`);
  }
  if (pace !== undefined) {
    if (pace === null || (DIRECTOR_PACE_NAMES as readonly unknown[]).includes(pace)) command.pace = pace as DirectorPace | null;
    else {
      const paces = DIRECTOR_PACE_NAMES.map((name) => `${name} (${DIRECTOR_PACES[name].min}–${DIRECTOR_PACES[name].max} s)`).join(', ');
      problems.push(`${where}.pace must be one of ${paces}, or null`);
    }
  }
  if (hold !== undefined) command.hold = readHold(hold, `${where}.hold`, problems);
  if (scales !== undefined) {
    if (scales === null) command.scales = null;
    else if (Array.isArray(scales) && scales.length && scales.every((scale) => (DIRECTOR_SCALES as readonly unknown[]).includes(scale)) && new Set(scales).size === scales.length) command.scales = DIRECTOR_SCALES.filter((scale) => scales.includes(scale));
    else problems.push(`${where}.scales must be a non-empty list of ${DIRECTOR_SCALES.join(', ')} (no repeats), or null`);
  }
  if (framings !== undefined) command.framings = readFramings(framings, `${where}.framings`, false, problems);
  if (exclude !== undefined) command.exclude = readFramings(exclude, `${where}.exclude`, true, problems);
  if (command.framings && command.exclude) for (const name of command.framings) if (command.exclude.includes(name)) problems.push(`${where}: "${name}" is in both framings and exclude`);
  if (minShipSize !== undefined) {
    if (minShipSize === null || (typeof minShipSize === 'number' && Number.isFinite(minShipSize) && minShipSize >= 0 && minShipSize <= MAX_MIN_SHIP_SIZE)) command.minShipSize = minShipSize;
    else problems.push(`${where}.minShipSize must be a share of the frame height in [0, ${MAX_MIN_SHIP_SIZE}] (0 turns it off), or null`);
  }
  if (letterbox !== undefined) {
    if (letterbox === null || letterbox === false) command.letterbox = letterbox;
    else if (typeof letterbox === 'number' && Number.isFinite(letterbox) && letterbox >= 0.5 && letterbox <= 4) command.letterbox = letterbox;
    else problems.push(`${where}.letterbox must be an aspect in [0.5, 4] (2.39 for scope), false, or null`);
  }
  if (hud !== undefined) {
    if (hud === null || typeof hud === 'boolean') command.hud = hud;
    else problems.push(`${where}.hud must be true, false or null`);
  }
  if (seed !== undefined) {
    if (seed === null || (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) command.seed = seed;
    else problems.push(`${where}.seed must be an integer in [0, 2³² − 1], or null (the document's combat seed)`);
  }
  return command;
}

function readFramings(value: unknown, where: string, empty: boolean, problems: string[]): Maybe<readonly DirectorFramingName[]> {
  let names: Maybe<readonly DirectorFramingName[]> = null;
  const known = DIRECTOR_FRAMING_NAMES as readonly unknown[];
  if (value === null) return null;
  if (!Array.isArray(value) || (!empty && !value.length)) problems.push(`${where} must be a${empty ? '' : ' non-empty'} list of director framings (${DIRECTOR_FRAMING_NAMES.join(', ')}), or null`);
  else {
    const before = problems.length;
    value.forEach((name, index) => {
      if (!known.includes(name)) problems.push(`${where}.${index} ${JSON.stringify(name)} is not a director framing (${DIRECTOR_FRAMING_NAMES.join(', ')})`);
    });
    if (problems.length === before) names = DIRECTOR_FRAMING_NAMES.filter((name) => value.includes(name));
  }
  return names;
}

function readFollow(value: unknown, where: string, problems: string[]): Maybe<DirectorFollow> {
  let follow: Maybe<DirectorFollow> = null;
  if (value === null) return null;
  if (!isPlainObject(value)) problems.push(`${where} must be { fleet } or { ship }, or null`);
  else {
    const keys = Object.keys(value);
    const { fleet, ship } = value;
    if (keys.length !== 1 || (fleet === undefined && ship === undefined)) problems.push(`${where} must be exactly one of { fleet } and { ship }`);
    else if (fleet !== undefined) {
      if (typeof fleet === 'string' && ID_PATTERN.test(fleet)) follow = { fleet };
      else problems.push(`${where}.fleet must be a fleet id`);
    } else if (typeof ship === 'string' && ID_PATTERN.test(ship)) follow = { ship };
    else problems.push(`${where}.ship must be a ship id`);
  }
  return follow;
}

function readHold(value: unknown, where: string, problems: string[]): Maybe<DirectorHold> {
  if (value === null) return null;
  const [minLow, minHigh] = DIRECTOR_HOLD_LIMITS.min;
  let hold: Maybe<DirectorHold> = null;
  if (!isPlainObject(value)) problems.push(`${where} must be { min?, max? } (seconds), or null`);
  else {
    const before = problems.length;
    for (const key of Object.keys(value)) if (key !== 'min' && key !== 'max') problems.push(`${where}.${key} is not a hold field (min, max)`);
    const { min, max } = value;
    const finite = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry);
    if (min === undefined && max === undefined) problems.push(`${where} needs min or max (seconds)`);
    if (min !== undefined && !(finite(min) && min >= minLow && min <= minHigh)) problems.push(`${where}.min must be seconds in [${minLow}, ${minHigh}]`);
    const floor = finite(min) ? min + DIRECTOR_HOLD_LIMITS.maxGap : minLow + DIRECTOR_HOLD_LIMITS.maxGap;
    if (max !== undefined && !(finite(max) && max >= floor && max <= DIRECTOR_HOLD_LIMITS.max)) problems.push(`${where}.max must be seconds in [${floor}, ${DIRECTOR_HOLD_LIMITS.max}]${finite(min) ? ' (at least min + 1)' : ''}`);
    if (problems.length === before) hold = { ...(min === undefined ? {} : { min: min as number }), ...(max === undefined ? {} : { max: max as number }) };
  }
  return hold;
}

/**
 * Merges a command into a bias layer: a value sets its key, null drops it, an omitted key stays; `on` is never stored.
 *
 * @param previous - The layer before.
 * @param command - The normalized command.
 * @returns The layer after.
 */
export function mergeAutoCameraBias(previous: Maybe<AutoCameraBias>, command: AutoCameraCommand): AutoCameraBias {
  const merged: Record<string, unknown> = { ...previous };
  for (const key of AUTO_CAMERA_BIAS_KEYS) {
    const value = command[key];
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as AutoCameraBias;
}

/**
 * The settings from layers of bias: the defaults, then each layer's keys in turn (null and omitted keys fall through).
 *
 * @param layers - The layers, lowest first (the scene's `autoCamera`, then the live overrides).
 * @returns The settings.
 */
export function resolveCameraDirectorSettings(...layers: readonly Maybe<AutoCameraBias | AutoCameraCommand>[]): CameraDirectorSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_CAMERA_DIRECTOR_SETTINGS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of AUTO_CAMERA_BIAS_KEYS) {
      const value = (layer as Record<string, unknown>)[key];
      if (value != null) settings[key] = value;
    }
  }
  return settings as unknown as CameraDirectorSettings;
}

/**
 * Why the settings' shot rules leave no framing to pick, if they do: `framings` outside `scales`, or every allowed framing
 * excluded. A row's possible scales are its own, plus wide and medium for `group` rows.
 *
 * @param settings - The settings.
 * @returns The problem, or null.
 */
export function directorRulesProblem(settings: Pick<CameraDirectorSettings, 'scales' | 'framings' | 'exclude'>): Maybe<string> {
  const allowed = DIRECTOR_FRAMINGS.filter((row) => directorFramingAllowed(row.name, settings) && (!settings.scales || framingScales(row).some((scale) => settings.scales?.includes(scale))));
  let problem: Maybe<string> = null;
  if (!allowed.length) {
    const rules = [...(settings.framings ? [`framings ${settings.framings.join(', ')}`] : []), ...(settings.exclude.length ? [`exclude ${settings.exclude.join(', ')}`] : []), ...(settings.scales ? [`scales ${settings.scales.join(', ')}`] : [])];
    problem = `auto_camera: the rules leave no framing to pick (${rules.join('; ')})`;
  }
  return problem;
}

/**
 * Whether the framing lists allow a framing (scales aside).
 */
export function directorFramingAllowed(name: DirectorFramingName, settings: Pick<CameraDirectorSettings, 'framings' | 'exclude'>): boolean {
  return (!settings.framings || settings.framings.includes(name)) && !settings.exclude.includes(name);
}

/**
 * The hold a director shot gets, seconds: the pace's preset, each key overridden by `hold`, max at least min + 1.
 *
 * @param settings - The settings.
 * @returns { min, max }.
 */
export function directorHold(settings: Pick<CameraDirectorSettings, 'pace' | 'hold'>): { readonly min: number; readonly max: number } {
  const preset = DIRECTOR_PACES[settings.pace] ?? DIRECTOR_PACES[DEFAULT_DIRECTOR_PACE];
  const min = settings.hold?.min ?? preset.min;
  const max = Math.min(DIRECTOR_HOLD_LIMITS.max, Math.max(min + DIRECTOR_HOLD_LIMITS.maxGap, settings.hold?.max ?? preset.max));
  return { min, max };
}

/**
 * The ids a command names, for checking against the live (or projected) scene: the followed fleet or ship, the teams.
 *
 * @param command - The command.
 * @returns Each reference with where it sits.
 */
export function autoCameraReferences(command: AutoCameraCommand): { readonly kind: 'fleet' | 'ship' | 'team'; readonly id: string; readonly path: string }[] {
  const references: { kind: 'fleet' | 'ship' | 'team'; id: string; path: string }[] = [];
  const follow = command.follow;
  if (follow && 'fleet' in follow) references.push({ kind: 'fleet', id: follow.fleet, path: 'follow.fleet' });
  else if (follow && 'ship' in follow) references.push({ kind: 'ship', id: follow.ship, path: 'follow.ship' });
  for (const [index, team] of (command.teams ?? []).entries()) references.push({ kind: 'team', id: team, path: `teams[${index}]` });
  return references;
}
