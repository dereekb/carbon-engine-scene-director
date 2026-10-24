/**
 * The `export_movie` tool's command (sd-export): render the movie, a time range of it, or N seconds of an unscripted
 * scene offline to an MP4 on a fixed 1/fps scene clock. The hub runs it and the page implements it for the hub's calls;
 * this module only validates. Runtime-free.
 */

import { isPlainObject } from '../json';
import { SceneError } from '../scene';
import { MOVIE_OUTPUT_FIELDS, type MovieOutputCommand, readMovieOutput } from './output';

export const MOVIE_EXPORT_ACTIONS = ['status', 'start', 'cancel'] as const;

export type MovieExportAction = (typeof MOVIE_EXPORT_ACTIONS)[number];

/**
 * Seconds drawn but not encoded before a `from` > 0 (lag, exposure and the effects replayed at the seek settle).
 */
export const DEFAULT_EXPORT_PREROLL_SECONDS = 2;
export const MAX_EXPORT_PREROLL_SECONDS = 10;
/**
 * The longest file one export writes.
 */
export const MAX_EXPORT_SECONDS = 3600;

/**
 * A validated `export_movie { action: "start" }`. Optional fields left out take the page's defaults: `from` 0, `to`
 * the movie's end, `restart` true with a timeline, and the output's (output.ts).
 */
export interface MovieExportStartCommand extends MovieOutputCommand {
  readonly action: 'start';
  readonly from?: number;
  readonly to?: number;
  readonly duration?: number;
  readonly restart?: boolean;
  readonly preroll: number;
}

export type MovieExportCommand = { readonly action: 'status' } | { readonly action: 'cancel' } | MovieExportStartCommand;

const START_FIELDS = ['from', 'to', 'duration', ...MOVIE_OUTPUT_FIELDS, 'restart', 'preroll'] as const;

/**
 * Fields the page adds to the hub's start call (the export's id) besides the command's.
 */
const PAGE_FIELDS = ['id'];

/**
 * Validates an export_movie command.
 *
 * @param input - The tool's arguments.
 * @param where - The message prefix.
 * @returns The command, defaults filled (fps, width, height, codec, preroll, source).
 * @throws {SceneError} With every problem found.
 */
export function normalizeMovieExportCommand(input: unknown, where = 'export_movie'): MovieExportCommand {
  if (input != null && !isPlainObject(input)) throw new SceneError([`${where} must be an object { action?, ... }`]);
  const object = (input ?? {}) as Record<string, unknown>;
  const action = object['action'] ?? 'status';
  if (typeof action !== 'string' || !(MOVIE_EXPORT_ACTIONS as readonly string[]).includes(action)) {
    throw new SceneError([`${where}.action must be one of ${MOVIE_EXPORT_ACTIONS.join(', ')}`]);
  }
  const problems: string[] = [];
  for (const key of Object.keys(object)) {
    if (key === 'action' || PAGE_FIELDS.includes(key)) continue;
    if ((START_FIELDS as readonly string[]).includes(key)) {
      if (action !== 'start') problems.push(`${where}.${key} goes with action "start" ("${action}" takes no other field)`);
    } else problems.push(`${where}.${key} is not an export_movie field (action, ${START_FIELDS.join(', ')})`);
  }
  if (action !== 'start') {
    if (problems.length) throw new SceneError(problems);
    return { action: action as 'status' | 'cancel' };
  }
  const command = readStart(object, problems, where);
  if (problems.length) throw new SceneError(problems);
  return command;
}

function readStart(object: Record<string, unknown>, problems: string[], where: string): MovieExportStartCommand {
  const from = object['from'];
  const to = object['to'];
  const duration = object['duration'];
  if (from !== undefined && !(isFiniteNumber(from) && from >= 0)) problems.push(`${where}.from must be seconds of timeline time, 0 or more`);
  if (to !== undefined && !(isFiniteNumber(to) && to > 0)) problems.push(`${where}.to must be seconds of timeline time, more than 0`);
  if (duration !== undefined && !(isFiniteNumber(duration) && duration > 0)) problems.push(`${where}.duration must be seconds, more than 0`);
  if (to !== undefined && duration !== undefined) problems.push(`${where}: give to or duration, not both`);
  const start = isFiniteNumber(from) && from >= 0 ? from : 0;
  if (isFiniteNumber(to) && to > 0 && to <= start) problems.push(`${where}.to (${to} s) must be after from (${start} s)`);
  const seconds = isFiniteNumber(duration) && duration > 0 ? duration : isFiniteNumber(to) && to > start ? to - start : undefined;
  if (seconds != null && seconds > MAX_EXPORT_SECONDS) problems.push(`${where}: ${roundSeconds(seconds)} s is longer than an export's ${MAX_EXPORT_SECONDS} s`);
  const output = readMovieOutput(object, problems, where);
  const restart = object['restart'];
  if (restart !== undefined && typeof restart !== 'boolean') problems.push(`${where}.restart must be true (a fresh run from the placements) or false (the run in the time window)`);
  const preroll = object['preroll'];
  if (preroll !== undefined && !(isFiniteNumber(preroll) && preroll >= 0 && preroll <= MAX_EXPORT_PREROLL_SECONDS)) problems.push(`${where}.preroll must be seconds from 0 to ${MAX_EXPORT_PREROLL_SECONDS}`);
  return {
    action: 'start',
    ...(isFiniteNumber(from) && from >= 0 ? { from } : {}),
    ...(isFiniteNumber(to) && to > 0 ? { to } : {}),
    ...(isFiniteNumber(duration) && duration > 0 ? { duration } : {}),
    ...output,
    ...(typeof restart === 'boolean' ? { restart } : {}),
    preroll: isFiniteNumber(preroll) && preroll >= 0 ? Math.min(preroll, MAX_EXPORT_PREROLL_SECONDS) : DEFAULT_EXPORT_PREROLL_SECONDS
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
