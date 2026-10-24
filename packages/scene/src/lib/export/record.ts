/**
 * The `record_movie` tool (sd-export → Live recording): records the live scene to an MP4 while the tools stay open. The
 * scene clock runs under the record lock (the frame lock at the file's fps), and every grid frame it reaches is
 * captured and encoded, so file frame k is scene time T0 + k / fps: video time is scene time, whatever the page's draw
 * rate, the rate or the pauses. The hub runs it and the page implements it for the hub's calls; this module validates
 * and holds the types. Runtime-free.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import { SceneError } from '../scene';
import { MAX_EXPORT_SECONDS } from './command';
import { MOVIE_OUTPUT_FIELDS, type MovieOutputCommand, type MovieOutputPlan, readMovieOutput } from './output';
import type { MovieExportFile, MovieExportResult } from './report';

/**
 * status (the default) reports the last recording, start begins one, stop ends it and saves the file, cancel discards
 * it.
 */
export const MOVIE_RECORD_ACTIONS = ['status', 'start', 'stop', 'cancel'] as const;

export type MovieRecordAction = (typeof MOVIE_RECORD_ACTIONS)[number];

/**
 * A recording's states: preparing (the canvas held at the picture size, warm-up frames, the encoder configuring),
 * recording (grid frames encoded), finishing (the encoder's flush, the hub's save), then done, cancelled or failed.
 */
export const MOVIE_RECORD_STATES = ['preparing', 'recording', 'finishing', 'done', 'cancelled', 'failed'] as const;

export type MovieRecordState = (typeof MOVIE_RECORD_STATES)[number];

/**
 * The states a recording is still running in.
 */
export const RUNNING_MOVIE_RECORD_STATES: ReadonlySet<MovieRecordState> = new Set(['preparing', 'recording', 'finishing']);

/**
 * A validated `record_movie { action: "start" }`: the output fields (output.ts) and an optional duration, seconds of
 * video after which the recording stops by itself (at most MAX_EXPORT_SECONDS; without it the cap stops it).
 */
export interface MovieRecordStartCommand extends MovieOutputCommand {
  readonly action: 'start';
  readonly duration?: number;
}

export type MovieRecordCommand = { readonly action: 'status' } | { readonly action: 'stop' } | { readonly action: 'cancel' } | MovieRecordStartCommand;

const START_FIELDS = ['duration', ...MOVIE_OUTPUT_FIELDS] as const;

/**
 * Fields the page adds to the hub's calls (the recording's id) besides the command's.
 */
const PAGE_FIELDS = ['id'];

/**
 * Validates a record_movie command.
 *
 * @param input - The tool's arguments.
 * @param where - The message prefix.
 * @returns The command, defaults filled (fps, width, height, codec, source).
 * @throws {SceneError} With every problem found.
 */
export function normalizeMovieRecordCommand(input: unknown, where = 'record_movie'): MovieRecordCommand {
  if (input != null && !isPlainObject(input)) throw new SceneError([`${where} must be an object { action?, ... }`]);
  const object = (input ?? {}) as Record<string, unknown>;
  const action = object['action'] ?? 'status';
  if (typeof action !== 'string' || !(MOVIE_RECORD_ACTIONS as readonly string[]).includes(action)) {
    throw new SceneError([`${where}.action must be one of ${MOVIE_RECORD_ACTIONS.join(', ')}`]);
  }
  const problems: string[] = [];
  for (const key of Object.keys(object)) {
    if (key === 'action' || PAGE_FIELDS.includes(key)) continue;
    if ((START_FIELDS as readonly string[]).includes(key)) {
      if (action !== 'start') problems.push(`${where}.${key} goes with action "start" ("${action}" takes no other field)`);
    } else problems.push(`${where}.${key} is not a record_movie field (action, ${START_FIELDS.join(', ')})`);
  }
  if (action !== 'start') {
    if (problems.length) throw new SceneError(problems);
    return { action: action as 'status' | 'stop' | 'cancel' };
  }
  const duration = object['duration'];
  const durationOk = duration === undefined || (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= MAX_EXPORT_SECONDS);
  if (!durationOk) problems.push(`${where}.duration must be seconds of video, more than 0 and at most ${MAX_EXPORT_SECONDS}`);
  const output = readMovieOutput(object, problems, where);
  if (problems.length) throw new SceneError(problems);
  return { action: 'start', ...(duration !== undefined ? { duration: duration as number } : {}), ...output };
}

/**
 * What a recording writes, resolved by the page at its start: the output (output.ts) and when it stops by itself.
 */
export interface MovieRecordPlan extends MovieOutputPlan {
  /**
   * Seconds of video after which it stops by itself, or null: when stopped (or at the cap).
   */
  readonly duration: Maybe<number>;
  /**
   * The most frames it encodes: the duration's, else MAX_EXPORT_SECONDS'.
   */
  readonly maxFrames: number;
}

/**
 * The page's report of a recording (get_state record, the progress messages, the hub's status).
 */
export interface MovieRecordReport {
  readonly id: string;
  readonly state: MovieRecordState;
  readonly plan: MovieRecordPlan;
  /**
   * Frames encoded so far: file frame k is scene time T0 + k / fps.
   */
  readonly frame: number;
  /**
   * Seconds of video so far (frame / fps).
   */
  readonly seconds: number;
  /**
   * Scene seconds of the last encoded frame's clock (null before one).
   */
  readonly sceneSeconds: Maybe<number>;
  /**
   * fps: frames encoded a wall second; realtime: video (scene) seconds a wall second, over the last frames.
   */
  readonly rate: { readonly fps: number; readonly realtime: number };
  /**
   * Seconds of video left before it stops by itself (the duration or the cap).
   */
  readonly left: number;
  /**
   * What the recording waits for now (the encoder, the socket, a hidden tab, the warm-up).
   */
  readonly waiting?: string;
  readonly encoder: { readonly queue: number; readonly chunks: number; readonly keyFrames: number; readonly bytes: number };
  readonly frameMs: { readonly mean: number; readonly max: number; readonly retries: number };
  /**
   * ISO time.
   */
  readonly startedAt: string;
  readonly wallSeconds: number;
  /**
   * WebGPU errors since the start.
   */
  readonly gpuErrors: number;
  readonly warnings: string[];
  readonly error?: string;
  readonly note?: string;
  /**
   * The saved file (the hub's saved message), once done.
   */
  readonly file?: MovieExportFile;
}

/**
 * record_movie status (the hub): idle before any recording, else the last recording's page report with the file and,
 * once saved, the result.
 */
export type MovieRecordStatus =
  | { readonly state: 'idle'; readonly note: string }
  | (Omit<MovieRecordReport, 'state'> & {
      readonly state: MovieRecordState;
      readonly file: MovieExportFile;
      readonly result?: MovieExportResult;
    });

/**
 * record_movie start's answer.
 */
export interface MovieRecordStartResult {
  readonly id: string;
  readonly state: MovieRecordState;
  readonly file: MovieExportFile;
  readonly plan: MovieRecordPlan;
  readonly warnings: string[];
}

/**
 * The page's answer to the hub's start call.
 */
export interface MovieRecordPageStart {
  readonly id: string;
  readonly state: MovieRecordState;
  readonly plan: MovieRecordPlan;
  /**
   * The scene's name, for the default file name.
   */
  readonly scene: Maybe<string>;
  readonly warnings: string[];
}
