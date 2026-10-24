/**
 * The time_control tool's pure half: the command it takes and its bounds. The page's TimeControl (apps/viewer
 * time-control.ts) runs it on the scene clock: a rate (slow motion, fast-forward), a pause, and jumps back or to any
 * time inside the recorded window (the page's snapshots, sd-time).
 */

import type { Maybe } from '@dereekb/util';
import { MAX_EXPORT_FPS, MIN_EXPORT_FPS } from '../export/output';
import { isPlainObject } from '../json';
import { SceneError } from '../scene';

/**
 * The slowest rate: one Destiny tick every 16 s of wall time.
 */
export const MIN_TIME_RATE = 1 / 16;
/**
 * The fastest rate. The page steps every tick even here, within a frame's step budget.
 */
export const MAX_TIME_RATE = 32;
export const DEFAULT_TIME_RATE = 1;
/**
 * Above this rate the page mutes its audio: the sounds of 4 ticks a second pile up into noise. Slow motion stays
 * audible, at normal pitch.
 */
export const AUDIBLE_MAX_RATE = 2;
/**
 * Snapshot spacing, scene seconds: the default, and the bounds `every` takes.
 */
export const DEFAULT_SNAPSHOT_EVERY_SECONDS = 5;
export const MIN_SNAPSHOT_EVERY_SECONDS = 1;
export const MAX_SNAPSHOT_EVERY_SECONDS = 60;
/**
 * How far back the recorded window reaches, scene seconds: the default, and the bounds `window` takes.
 */
export const DEFAULT_TIME_WINDOW_SECONDS = 120;
export const MIN_TIME_WINDOW_SECONDS = 10;
export const MAX_TIME_WINDOW_SECONDS = 3600;
/**
 * The memory the snapshots may hold, MB; the oldest go first past it.
 */
export const DEFAULT_TIME_BUDGET_MB = 64;
/**
 * The furthest a seek simulates past the recorded end, scene seconds.
 */
export const MAX_SEEK_AHEAD_SECONDS = 300;
/**
 * The longest beat (`play`), scene seconds.
 */
export const MAX_PLAY_SECONDS = 3600;

/**
 * time_control: pause or play, the scene clock's rate, a jump back or to a scene time, the frame lock, a beat, and the
 * recording's spacing and window. Applied in the order window settings, jump, rate, fps, then pause or play. `{}`
 * reports.
 */
export interface TimeControlCommand {
  readonly pause?: boolean;
  readonly rate?: number;
  /**
   * Scene seconds to jump back from now (> 0).
   */
  readonly back?: number;
  /**
   * Where to jump to: a scene time (get_state time.seconds), or `{ timeline }` seconds of timeline time (get_state
   * time.timeline), back inside the window or forward past it.
   */
  readonly seek?: TimeSeek;
  /**
   * Snapshot spacing, scene seconds (MIN_SNAPSHOT_EVERY_SECONDS to MAX_SNAPSHOT_EVERY_SECONDS).
   */
  readonly every?: number;
  /**
   * How far back the window reaches, scene seconds (MIN_TIME_WINDOW_SECONDS to MAX_TIME_WINDOW_SECONDS).
   */
  readonly window?: number;
  /**
   * The frame lock: the scene clock moves on a 1/fps grid, one grid frame a drawn frame at most (an integer from
   * MIN_EXPORT_FPS to MAX_EXPORT_FPS), or false to unlock.
   */
  readonly fps?: number | false;
  /**
   * A beat: play this many scene seconds from now (above 0, at most MAX_PLAY_SECONDS), then pause; the call returns at
   * the pause.
   */
  readonly play?: number;
}

/**
 * A seek target: scene seconds, or `{ timeline }` seconds since the scripted timeline's t = 0.
 */
export type TimeSeek = number | { readonly timeline: number };

const COMMAND_KEYS = new Set<string>(['pause', 'rate', 'back', 'seek', 'every', 'window', 'fps', 'play']);
const COMMAND_KEYS_TEXT = 'pause, rate, back, seek, every, window, fps, play';

/**
 * Whether a value is a rate the scene clock takes.
 *
 * @param value - The candidate.
 * @returns True for a finite number in [MIN_TIME_RATE, MAX_TIME_RATE].
 */
export function isTimeRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_TIME_RATE && value <= MAX_TIME_RATE;
}

/**
 * Validates a time_control command.
 *
 * @param input - The candidate command (the tool's arguments).
 * @param where - The message prefix.
 * @returns The command.
 * @throws {SceneError} With every problem found.
 */
export function normalizeTimeControlCommand(input: unknown, where = 'time_control'): TimeControlCommand {
  const problems: string[] = [];
  let command: Maybe<TimeControlCommand> = null;
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object { pause?, rate?, back?, seek?, every?, window?, fps?, play? }`);
  } else {
    const object = input ?? {};
    for (const key of Object.keys(object)) {
      if (!COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not a time_control field (${COMMAND_KEYS_TEXT})`);
    }
    const { pause, rate, back, seek, every, window, fps, play } = object as Record<string, unknown>;
    if (pause !== undefined && typeof pause !== 'boolean') problems.push(`${where}.pause must be true (pause) or false (play)`);
    if (rate !== undefined && !isTimeRate(rate)) problems.push(`${where}.rate must be a number from ${MIN_TIME_RATE} (1/16, slow motion) to ${MAX_TIME_RATE} (fast-forward); 1 is real time`);
    const backOk = back === undefined || (isFiniteNumber(back) && back > 0);
    if (!backOk) problems.push(`${where}.back must be a number of scene seconds above 0`);
    const seekOk = seek === undefined || isSeek(seek);
    if (!seekOk) problems.push(`${where}.seek must be a scene time in seconds (get_state time.seconds), 0 or more, or { timeline: <seconds of timeline time, 0 or more> }`);
    if (back !== undefined && seek !== undefined) problems.push(`${where}: give back or seek, not both`);
    const everyOk = every === undefined || isInRange(every, MIN_SNAPSHOT_EVERY_SECONDS, MAX_SNAPSHOT_EVERY_SECONDS);
    if (!everyOk) problems.push(`${where}.every must be the snapshot spacing in scene seconds, from ${MIN_SNAPSHOT_EVERY_SECONDS} to ${MAX_SNAPSHOT_EVERY_SECONDS}`);
    const windowOk = window === undefined || isInRange(window, MIN_TIME_WINDOW_SECONDS, MAX_TIME_WINDOW_SECONDS);
    if (!windowOk) problems.push(`${where}.window must be the scene seconds kept, from ${MIN_TIME_WINDOW_SECONDS} to ${MAX_TIME_WINDOW_SECONDS}`);
    const fpsOk = fps === undefined || fps === false || (Number.isInteger(fps) && (fps as number) >= MIN_EXPORT_FPS && (fps as number) <= MAX_EXPORT_FPS);
    if (!fpsOk) problems.push(`${where}.fps must be the frame lock's frames a second, an integer from ${MIN_EXPORT_FPS} to ${MAX_EXPORT_FPS}, or false to unlock`);
    const playOk = play === undefined || (isFiniteNumber(play) && play > 0 && play <= MAX_PLAY_SECONDS);
    if (!playOk) problems.push(`${where}.play must be the scene seconds to play before pausing, above 0 and at most ${MAX_PLAY_SECONDS}`);
    if (play !== undefined && pause !== undefined) problems.push(`${where}: give pause or play, not both (play plays, then pauses)`);
    command = {
      ...(typeof pause === 'boolean' ? { pause } : {}),
      ...(isTimeRate(rate) ? { rate } : {}),
      ...(back !== undefined && backOk ? { back: back as number } : {}),
      ...(seek !== undefined && seekOk ? { seek: typeof seek === 'number' ? seek : { timeline: (seek as { readonly timeline: number }).timeline } } : {}),
      ...(every !== undefined && everyOk ? { every: every as number } : {}),
      ...(window !== undefined && windowOk ? { window: window as number } : {}),
      ...(fps !== undefined && fpsOk ? { fps: fps as number | false } : {}),
      ...(play !== undefined && playOk ? { play: play as number } : {})
    };
  }
  if (problems.length || !command) throw new SceneError(problems);
  return command;
}

function isSeek(value: unknown): value is TimeSeek {
  if (isFiniteNumber(value)) return value >= 0;
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const timeline = (value as Record<string, unknown>)['timeline'];
  return keys.length === 1 && keys[0] === 'timeline' && isFiniteNumber(timeline) && timeline >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}
