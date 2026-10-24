/**
 * The `export_movie` tool's command (sd-export): render the movie, a time range of it, or N seconds of an unscripted
 * scene offline to an MP4 on a fixed 1/fps scene clock. The hub runs it and the page implements it for the hub's calls;
 * this module only validates. Runtime-free.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import { SceneError } from '../scene';
import { exportCodecLimitText, exportCodecString } from './codec';

export const MOVIE_EXPORT_ACTIONS = ['status', 'start', 'cancel'] as const;

export type MovieExportAction = (typeof MOVIE_EXPORT_ACTIONS)[number];

/**
 * The codecs an export encodes with. AV1 and VP9 are not yet: Chrome gives no decoder description for them, so the
 * hub would build av1C / vpcC itself.
 */
export const MOVIE_EXPORT_CODECS = ['h264', 'hevc'] as const;

export type MovieExportCodec = (typeof MOVIE_EXPORT_CODECS)[number];

/**
 * What a frame is drawn from: the scene (WebGPU), or the slate (the timeline time on black, no renderer: headless
 * checks).
 */
export const MOVIE_EXPORT_SOURCES = ['scene', 'slate'] as const;

export type MovieExportSource = (typeof MOVIE_EXPORT_SOURCES)[number];

export const DEFAULT_EXPORT_FPS = 30;
export const MIN_EXPORT_FPS = 1;
export const MAX_EXPORT_FPS = 120;
export const DEFAULT_EXPORT_WIDTH = 1920;
export const DEFAULT_EXPORT_HEIGHT = 1080;
/**
 * The output's smallest side; sizes are even (H.264 4:2:0).
 */
export const MIN_EXPORT_SIZE = 64;
/**
 * H.264 level 5.2's frame size bounds the output.
 */
export const MAX_EXPORT_WIDTH = 4096;
export const MAX_EXPORT_HEIGHT = 2304;
/**
 * Seconds drawn but not encoded before a `from` > 0 (lag, exposure and the effects replayed at the seek settle).
 */
export const DEFAULT_EXPORT_PREROLL_SECONDS = 2;
export const MAX_EXPORT_PREROLL_SECONDS = 10;
/**
 * The longest file one export writes.
 */
export const MAX_EXPORT_SECONDS = 3600;
export const MIN_EXPORT_BITRATE = 100_000;
export const MAX_EXPORT_BITRATE = 200_000_000;
/**
 * Seconds between keyframes.
 */
export const EXPORT_KEYFRAME_SECONDS = 2;
export const MIN_EXPORT_LETTERBOX = 0.5;
export const MAX_EXPORT_LETTERBOX = 4;
export const MAX_EXPORT_NAME_LENGTH = 80;

/**
 * A validated `export_movie { action: "start" }`. Optional fields left out take the page's defaults: `from` 0, `to`
 * the movie's end, `letterbox` the movie's look, `bitrate` from the size and fps, `restart` true with a timeline, and
 * the name from the scene's name and the time.
 */
export interface MovieExportStartCommand {
  readonly action: 'start';
  readonly from?: number;
  readonly to?: number;
  readonly duration?: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly letterbox?: number | false;
  readonly codec: MovieExportCodec;
  readonly bitrate?: number;
  readonly restart?: boolean;
  readonly preroll: number;
  readonly name?: string;
  readonly source: MovieExportSource;
}

export type MovieExportCommand = { readonly action: 'status' } | { readonly action: 'cancel' } | MovieExportStartCommand;

const START_FIELDS = ['from', 'to', 'duration', 'fps', 'width', 'height', 'letterbox', 'codec', 'bitrate', 'restart', 'preroll', 'name', 'source'] as const;

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
  const fps = readInteger({ object, key: 'fps', min: MIN_EXPORT_FPS, max: MAX_EXPORT_FPS, fallback: DEFAULT_EXPORT_FPS, problems, where, text: 'frames a second' });
  const width = readSize({ object, key: 'width', max: MAX_EXPORT_WIDTH, fallback: DEFAULT_EXPORT_WIDTH, problems, where });
  const height = readSize({ object, key: 'height', max: MAX_EXPORT_HEIGHT, fallback: DEFAULT_EXPORT_HEIGHT, problems, where });
  const codecName = (MOVIE_EXPORT_CODECS as readonly unknown[]).includes(object['codec'] ?? 'h264') ? ((object['codec'] ?? 'h264') as MovieExportCodec) : null;
  if (codecName && !exportCodecString({ codec: codecName, width, height, fps })) problems.push(`${where}: ${width} × ${height} at ${fps} fps is beyond ${exportCodecLimitText(codecName)}: a smaller size or a lower fps`);
  const letterbox = object['letterbox'];
  const letterboxOk = letterbox === undefined || letterbox === false || (isFiniteNumber(letterbox) && letterbox >= MIN_EXPORT_LETTERBOX && letterbox <= MAX_EXPORT_LETTERBOX);
  if (!letterboxOk) problems.push(`${where}.letterbox must be an aspect ratio from ${MIN_EXPORT_LETTERBOX} to ${MAX_EXPORT_LETTERBOX} (2.39 is scope), or false for none (default the movie's look)`);
  const codec = object['codec'] ?? 'h264';
  if (codec === 'vp9' || codec === 'av1') problems.push(`${where}.codec "${codec}" is not yet: h264 or hevc`);
  else if (typeof codec !== 'string' || !(MOVIE_EXPORT_CODECS as readonly string[]).includes(codec)) problems.push(`${where}.codec must be one of ${MOVIE_EXPORT_CODECS.join(', ')}`);
  const bitrate = object['bitrate'];
  if (bitrate !== undefined && !(Number.isInteger(bitrate) && (bitrate as number) >= MIN_EXPORT_BITRATE && (bitrate as number) <= MAX_EXPORT_BITRATE)) problems.push(`${where}.bitrate must be bits a second, an integer from ${MIN_EXPORT_BITRATE} to ${MAX_EXPORT_BITRATE}`);
  const restart = object['restart'];
  if (restart !== undefined && typeof restart !== 'boolean') problems.push(`${where}.restart must be true (a fresh run from the placements) or false (the run in the time window)`);
  const preroll = object['preroll'];
  if (preroll !== undefined && !(isFiniteNumber(preroll) && preroll >= 0 && preroll <= MAX_EXPORT_PREROLL_SECONDS)) problems.push(`${where}.preroll must be seconds from 0 to ${MAX_EXPORT_PREROLL_SECONDS}`);
  const name = readName(object['name'], problems, where);
  const source = object['source'] ?? 'scene';
  if (typeof source !== 'string' || !(MOVIE_EXPORT_SOURCES as readonly string[]).includes(source)) problems.push(`${where}.source must be one of ${MOVIE_EXPORT_SOURCES.join(', ')}`);
  return {
    action: 'start',
    ...(isFiniteNumber(from) && from >= 0 ? { from } : {}),
    ...(isFiniteNumber(to) && to > 0 ? { to } : {}),
    ...(isFiniteNumber(duration) && duration > 0 ? { duration } : {}),
    fps,
    width,
    height,
    ...(letterbox !== undefined && letterboxOk ? { letterbox: letterbox as number | false } : {}),
    codec: (MOVIE_EXPORT_CODECS as readonly unknown[]).includes(codec) ? (codec as MovieExportCodec) : 'h264',
    ...(Number.isInteger(bitrate) ? { bitrate: bitrate as number } : {}),
    ...(typeof restart === 'boolean' ? { restart } : {}),
    preroll: isFiniteNumber(preroll) && preroll >= 0 ? Math.min(preroll, MAX_EXPORT_PREROLL_SECONDS) : DEFAULT_EXPORT_PREROLL_SECONDS,
    ...(name != null ? { name } : {}),
    source: (MOVIE_EXPORT_SOURCES as readonly unknown[]).includes(source) ? (source as MovieExportSource) : 'scene'
  };
}

interface ReadNumberInput {
  readonly object: Record<string, unknown>;
  readonly key: string;
  readonly max: number;
  readonly fallback: number;
  readonly problems: string[];
  readonly where: string;
}

function readInteger(input: ReadNumberInput & { readonly min: number; readonly text: string }): number {
  const { object, key, min, max, fallback, problems, where, text } = input;
  const value = object[key];
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) return value as number;
  problems.push(`${where}.${key} must be ${text}, an integer from ${min} to ${max}`);
  return fallback;
}

function readSize(input: ReadNumberInput): number {
  const { object, key, max, fallback, problems, where } = input;
  const value = object[key];
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && (value as number) >= MIN_EXPORT_SIZE && (value as number) <= max && (value as number) % 2 === 0) return value as number;
  const odd = Number.isInteger(value) && (value as number) % 2 ? ` (${value} is odd: 4:2:0 video needs even sizes)` : '';
  problems.push(`${where}.${key} must be pixels, an even integer from ${MIN_EXPORT_SIZE} to ${max}${odd}`);
  return fallback;
}

function readName(value: unknown, problems: string[], where: string): Maybe<string> {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex
  const ok = text.length > 0 && text.length <= MAX_EXPORT_NAME_LENGTH && !/[/\\\u0000-\u001F\u007F]/u.test(text) && /[\p{L}\p{N}]/u.test(text);
  if (!ok) problems.push(`${where}.name must be the file's name without .mp4: 1 to ${MAX_EXPORT_NAME_LENGTH} characters with a letter or digit, no "/" or "\\" (it is lowercased, other characters become "-")`);
  return ok ? text.replace(/\.mp4$/iu, '') : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
