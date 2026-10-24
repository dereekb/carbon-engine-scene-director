/**
 * What a movie export reports (sd-export): its plan, the page's progress report, the hub's status and the saved file.
 * Runtime-free: the page builds the report, the hub adds the file.
 */

import type { Maybe } from '@dereekb/util';
import type { MovieOutputPlan } from './output';

/**
 * An export's states: preparing (locks, the fixed size, the restart and its prepare), seeking (the silent seek to the
 * preroll's start), prerolling (frames drawn, not encoded), rendering (frames encoded), finishing (the encoder's flush
 * and the hub's save), then done, cancelled or failed.
 */
export const MOVIE_EXPORT_STATES = ['preparing', 'seeking', 'prerolling', 'rendering', 'finishing', 'done', 'cancelled', 'failed'] as const;

export type MovieExportState = (typeof MOVIE_EXPORT_STATES)[number];

/**
 * The states an export is still running in.
 */
export const RUNNING_MOVIE_EXPORT_STATES: ReadonlySet<MovieExportState> = new Set(['preparing', 'seeking', 'prerolling', 'rendering', 'finishing']);

/**
 * What an export renders, resolved by the page at its start: the output (output.ts) and the span.
 */
export interface MovieExportPlan extends MovieOutputPlan {
  /**
   * Timeline seconds of the first encoded frame (scene seconds from now for a scene without a timeline: 0).
   */
  readonly from: number;
  readonly to: number;
  readonly seconds: number;
  /**
   * Frames encoded.
   */
  readonly frames: number;
  /**
   * A fresh run from the placements (timeline restart); false: the run in the time window, or now without a timeline.
   */
  readonly restart: boolean;
  readonly timeline: boolean;
  /**
   * Drawn, not encoded, before from.
   */
  readonly preroll: { readonly seconds: number; readonly frames: number };
}

/**
 * The page's progress report (get_state export, and the hub's status without the file's bytes).
 */
export interface MovieExportReport {
  readonly id: string;
  readonly state: MovieExportState;
  readonly plan: MovieExportPlan;
  /**
   * Encoded frames so far.
   */
  readonly frame: number;
  readonly frames: number;
  /**
   * The share of the frames encoded, 0 to 1.
   */
  readonly progress: number;
  /**
   * Timeline seconds of the last frame drawn (a preroll frame's is before from).
   */
  readonly time: number;
  /**
   * fps: frames drawn a wall second; realtime: scene seconds a wall second (1 is real time).
   */
  readonly rate: { readonly fps: number; readonly realtime: number };
  /**
   * Wall seconds left at the current rate, once rendering.
   */
  readonly eta: Maybe<number>;
  /**
   * What the export waits for now (the encoder, the socket, a hidden tab, the prepare).
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
 * Where the hub writes an export.
 */
export interface MovieExportFile {
  readonly path: string;
  /**
   * The hub's `/movies/<file>` route.
   */
  readonly url: string;
  /**
   * Under WSL, the path from Windows (`\\wsl.localhost\<distro>\...`).
   */
  readonly windowsPath?: string;
  /**
   * Bytes written so far (the status).
   */
  readonly bytes?: number;
}

/**
 * The saved file.
 */
export interface MovieExportResult {
  readonly path: string;
  readonly url: string;
  readonly windowsPath?: string;
  readonly bytes: number;
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly codec: string;
  readonly wallSeconds: number;
  /**
   * Frames a wall second over the whole export.
   */
  readonly meanFps: number;
}

/**
 * export_movie status (the hub): idle before any export, else the last export's page report with the file and, once
 * saved, the result.
 */
export type MovieExportStatus =
  | { readonly state: 'idle'; readonly note: string }
  | (Omit<MovieExportReport, 'state'> & {
      readonly state: MovieExportState;
      readonly file: MovieExportFile;
      readonly result?: MovieExportResult;
    });

/**
 * export_movie start's answer.
 */
export interface MovieExportStartResult {
  readonly id: string;
  readonly state: MovieExportState;
  readonly file: MovieExportFile;
  readonly plan: MovieExportPlan;
  readonly warnings: string[];
}

/**
 * The page's answer to the hub's start call.
 */
export interface MovieExportPageStart {
  readonly id: string;
  readonly state: MovieExportState;
  readonly plan: MovieExportPlan;
  /**
   * The scene's name, for the default file name.
   */
  readonly scene: Maybe<string>;
  readonly warnings: string[];
}
