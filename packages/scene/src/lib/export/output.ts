/**
 * The movie file's output fields that `export_movie` and `record_movie` share (sd-export): the frame rate, the size, the
 * letterbox, the codec, the bitrate or quality, the file's name and the source. Validation and the plan's output half.
 * Runtime-free.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_MOVIE_QUALITY, defaultExportBitrate, type ExportRect, exportCodecLimitText, exportCodecString, exportPictureRect, MAX_EXPORT_BITRATE, MIN_EXPORT_BITRATE, MOVIE_QUALITIES, type MovieQuality } from './codec';

/**
 * The codecs a movie encodes with. AV1 and VP9 are not yet: Chrome gives no decoder description for them, so the hub
 * would build av1C / vpcC itself.
 */
export const MOVIE_EXPORT_CODECS = ['h264', 'hevc'] as const;

export type MovieExportCodec = (typeof MOVIE_EXPORT_CODECS)[number];

/**
 * What a frame is drawn from: the scene (WebGPU), or the slate (the time on black, no renderer: headless checks).
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
 * Seconds between keyframes.
 */
export const EXPORT_KEYFRAME_SECONDS = 2;
export const MIN_EXPORT_LETTERBOX = 0.5;
export const MAX_EXPORT_LETTERBOX = 4;
export const MAX_EXPORT_NAME_LENGTH = 80;

/**
 * The output fields of a validated start. Left out: `letterbox` takes the movie's look, `bitrate` the quality's (default
 * standard), and the name the scene's name and the time.
 */
export interface MovieOutputCommand {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly letterbox?: number | false;
  readonly codec: MovieExportCodec;
  readonly bitrate?: number;
  readonly quality?: MovieQuality;
  readonly name?: string;
  readonly source: MovieExportSource;
}

/**
 * The output fields a start takes (export_movie and record_movie).
 */
export const MOVIE_OUTPUT_FIELDS = ['fps', 'width', 'height', 'letterbox', 'codec', 'bitrate', 'quality', 'name', 'source'] as const;

/**
 * The encoder preference WebCodecs accepted.
 */
export type MovieExportHardware = 'prefer-hardware' | 'no-preference';

/**
 * The output half of a movie's plan (export_movie's and record_movie's), resolved by the page at its start.
 */
export interface MovieOutputPlan {
  readonly source: MovieExportSource;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /**
   * Where the picture sits in the frame (the rest is black bars).
   */
  readonly picture: ExportRect;
  readonly letterbox: number | false;
  readonly codec: MovieExportCodec;
  readonly codecString: string;
  readonly bitrate: number;
  /**
   * The quality preset (default standard): it set the bitrate unless the command gave one.
   */
  readonly quality: MovieQuality;
  readonly hardware: MovieExportHardware;
  /**
   * Frames between keyframes.
   */
  readonly keyframeEvery: number;
}

/**
 * Reads the output fields of a start, pushing every problem found.
 *
 * @param object - The tool's arguments.
 * @param problems - Where the problems go.
 * @param where - The message prefix.
 * @returns The output fields, defaults filled (fps, width, height, codec, source).
 */
export function readMovieOutput(object: Record<string, unknown>, problems: string[], where: string): MovieOutputCommand {
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
  const quality = object['quality'];
  const qualityOk = quality === undefined || (MOVIE_QUALITIES as readonly unknown[]).includes(quality);
  if (!qualityOk) problems.push(`${where}.quality must be one of ${MOVIE_QUALITIES.join(', ')} (default ${DEFAULT_MOVIE_QUALITY})`);
  const name = readName(object['name'], problems, where);
  const source = object['source'] ?? 'scene';
  if (typeof source !== 'string' || !(MOVIE_EXPORT_SOURCES as readonly string[]).includes(source)) problems.push(`${where}.source must be one of ${MOVIE_EXPORT_SOURCES.join(', ')}`);
  return {
    fps,
    width,
    height,
    ...(letterbox !== undefined && letterboxOk ? { letterbox: letterbox as number | false } : {}),
    codec: (MOVIE_EXPORT_CODECS as readonly unknown[]).includes(codec) ? (codec as MovieExportCodec) : 'h264',
    ...(Number.isInteger(bitrate) ? { bitrate: bitrate as number } : {}),
    ...(quality !== undefined && qualityOk ? { quality: quality as MovieQuality } : {}),
    ...(name != null ? { name } : {}),
    source: (MOVIE_EXPORT_SOURCES as readonly unknown[]).includes(source) ? (source as MovieExportSource) : 'scene'
  };
}

/**
 * The output half of a plan: the bitrate (given, else the quality's), the codec string for it, the picture's rect and
 * the keyframe spacing. The encoder's preference is "prefer-hardware" until the page checks its support.
 *
 * @param command - The start's output fields.
 * @param letterbox - The look: the command's, else the movie's, else false.
 * @returns The output plan.
 */
export function movieOutputPlan(command: MovieOutputCommand, letterbox: number | false): MovieOutputPlan {
  const quality = command.quality ?? DEFAULT_MOVIE_QUALITY;
  const bitrate = command.bitrate ?? defaultExportBitrate({ ...command, quality });
  return {
    source: command.source,
    fps: command.fps,
    width: command.width,
    height: command.height,
    picture: exportPictureRect(command.width, command.height, letterbox),
    letterbox,
    codec: command.codec,
    codecString: exportCodecString({ ...command, bitrate })?.codecString ?? '',
    bitrate,
    quality,
    hardware: 'prefer-hardware',
    keyframeEvery: Math.max(1, Math.round(EXPORT_KEYFRAME_SECONDS * command.fps))
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
