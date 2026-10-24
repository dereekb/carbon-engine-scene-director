/**
 * auto_camera's pure half: the command (the director on or off, and its bias) and the settings it merges into.
 *
 *   auto_camera { on?, follow?: { fleet } | { ship } | null, favour?: wide | medium | close | null, sun?, teams?: [a, b],
 *                 pace?: slow | normal | fast, hold?: { min?, max? }, letterbox?, hud?, seed? }
 *
 * - Any call hands the camera to the director (`on` defaults to true); `on: false` turns it off.
 * - Bias keys merge one by one: a value sets the key, null resets it to its default, an omitted key stays (auto_repair's
 *   null rule).
 * - `hold` wins over `pace`: min in [2, 60] s, max in [min + 1, 300] s.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject } from '../../json';
import { SceneError } from '../../scene';

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
  readonly letterbox?: number | false | null;
  readonly hud?: boolean | null;
  readonly seed?: number | null;
}

/**
 * The director's bias, as merged from every auto_camera call since the tab loaded.
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
   * Presentation while the director drives; null keeps the page's.
   */
  readonly letterbox: Maybe<number | false>;
  readonly hud: Maybe<boolean>;
  /**
   * The jitter seed; null takes the document's combat seed.
   */
  readonly seed: Maybe<number>;
}

export const DEFAULT_CAMERA_DIRECTOR_SETTINGS: CameraDirectorSettings = { follow: null, favour: null, sun: false, teams: null, pace: DEFAULT_DIRECTOR_PACE, hold: null, letterbox: null, hud: null, seed: null };

const COMMAND_KEYS = new Set(['on', 'follow', 'favour', 'sun', 'teams', 'pace', 'hold', 'letterbox', 'hud', 'seed']);

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
  const command: { -readonly [K in keyof AutoCameraCommand]: AutoCameraCommand[K] } = {};
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object { on?, follow?, favour?, sun?, teams?, pace?, hold?, letterbox?, hud?, seed? }`);
  } else if (input != null) {
    for (const key of Object.keys(input)) if (!COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not an auto_camera field`);
    const { on, follow, favour, sun, teams, pace, hold, letterbox, hud, seed } = input;
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
  }
  if (problems.length) throw new SceneError(problems);
  return command;
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
 * Merges a command into the settings: a value sets its key, null resets it to the default, an omitted key stays.
 *
 * @param command - The normalized command.
 * @param previous - The settings before; default the defaults.
 * @returns The settings after.
 */
export function resolveCameraDirectorSettings(command: AutoCameraCommand, previous: CameraDirectorSettings = DEFAULT_CAMERA_DIRECTOR_SETTINGS): CameraDirectorSettings {
  const defaults = DEFAULT_CAMERA_DIRECTOR_SETTINGS;
  const pick = <K extends keyof CameraDirectorSettings>(key: K): CameraDirectorSettings[K] => {
    const value = (command as Record<string, unknown>)[key];
    let result: CameraDirectorSettings[K] = previous[key];
    if (value === null) result = defaults[key];
    else if (value !== undefined) result = value as CameraDirectorSettings[K];
    return result;
  };
  return { follow: pick('follow'), favour: pick('favour'), sun: pick('sun'), teams: pick('teams'), pace: pick('pace'), hold: pick('hold'), letterbox: pick('letterbox'), hud: pick('hud'), seed: pick('seed') };
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
