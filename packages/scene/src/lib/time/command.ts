/**
 * The time_control tool's pure half: the command it takes and its bounds. The page's TimeControl (apps/viewer
 * time-control.ts) runs it on the scene clock: a rate (slow motion, fast-forward) and a pause. Jumping back and seeking
 * inside a recorded window arrive with the snapshots (sd-time).
 */

import type { Maybe } from '@dereekb/util';
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
 * time_control: pause or play, and the scene clock's rate. `{}` reports.
 */
export interface TimeControlCommand {
  readonly pause?: boolean;
  readonly rate?: number;
}

const COMMAND_KEYS = new Set<string>(['pause', 'rate']);

/**
 * The keys the jump back brings (sd-time), refused until it lands.
 */
const JUMP_KEYS = new Set<string>(['back', 'seek', 'every', 'window']);

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
    problems.push(`${where} must be an object { pause?, rate? }`);
  } else {
    const object = input ?? {};
    for (const key of Object.keys(object)) {
      if (JUMP_KEYS.has(key)) problems.push(`${where}.${key}: jumping back and seeking arrive with the snapshots; this page plays, pauses and sets the rate only`);
      else if (!COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not a time_control field (pause, rate)`);
    }
    const { pause, rate } = object as Record<string, unknown>;
    if (pause !== undefined && typeof pause !== 'boolean') problems.push(`${where}.pause must be true (pause) or false (play)`);
    if (rate !== undefined && !isTimeRate(rate)) problems.push(`${where}.rate must be a number from ${MIN_TIME_RATE} (1/16, slow motion) to ${MAX_TIME_RATE} (fast-forward); 1 is real time`);
    command = { ...(typeof pause === 'boolean' ? { pause } : {}), ...(isTimeRate(rate) ? { rate } : {}) };
  }
  if (problems.length || !command) throw new SceneError(problems);
  return command;
}
