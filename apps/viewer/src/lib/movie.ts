/**
 * Movie mode M5 (sd-timeline doc `movie`): the movie tool's pure parts, node-tested with no runtime. The report over
 * the timeline player's records, a beat's time, a long seek's chunks, and the frame's presentation (the page's
 * settings, the movie's look, a shot's).
 */

import type { Maybe } from '@dereekb/util';
import { beatLaneOf, type ExportRect, MAX_SEEK_AHEAD_SECONDS, movieLookOf, type MovieBeatReport, type MovieReport, type SceneMovie, type TimelineEventEntry, type TimelineState, type TimelineSummary } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { CueRecord } from './timeline';

/**
 * How many event log entries the movie report lists (newest first).
 */
export const MOVIE_REPORT_EVENTS = 10;

/**
 * Whether the movie's look applies: the authored timeline has a movie block and the player is not idle or stopped.
 *
 * @param state - The timeline player's state.
 */
export function MovieLookApplies(state: TimelineState): boolean {
  return state !== 'idle' && state !== 'stopped';
}

/**
 * A beat's timeline second: when it fired (or failed or was skipped), else when it is due (timed, or an event cue whose
 * event came, a missed one included); null while it waits for its event.
 *
 * @param record - The player's cue record.
 */
export function BeatTime(record: Pick<CueRecord, 'second' | 'due'>): Maybe<number> {
  return record.second ?? record.due ?? null;
}

/**
 * One beat's report row.
 *
 * @param record - The player's cue record.
 * @param now - Timeline seconds now.
 */
export function BeatReportOf(record: CueRecord, now: number): MovieBeatReport {
  const time = BeatTime(record);
  const after = record.when?.after;
  const trigger = record.when ? { when: record.whenText ?? 'its event', ...(record.arms != null ? { arms: record.arms } : {}), ...(after != null ? { after } : {}), ...(record.latest != null ? { latest: record.latest } : {}) } : { at: record.at ?? 0 };
  return {
    id: record.id,
    ...(record.name ? { name: record.name } : {}),
    lane: beatLaneOf(record.action),
    action: record.action,
    trigger,
    time,
    state: record.state,
    ...(record.state === 'pending' && time != null ? { in: Math.max(0, Math.round((time - now) * 100) / 100) } : {}),
    ...(record.note ? { note: record.note } : {}),
    ...(record.error ? { error: record.error } : {})
  };
}

export interface MovieReportInput {
  /**
   * The player's summary (null for an unscripted scene).
   */
  readonly summary: Maybe<TimelineSummary>;
  readonly records: readonly CueRecord[];
  /**
   * The event log up to its cursor (TimelinePlayer.Events).
   */
  readonly events: readonly TimelineEventEntry[];
  /**
   * Timeline seconds now (fractional).
   */
  readonly time: number;
  /**
   * The authored timeline's movie block.
   */
  readonly movie: Maybe<SceneMovie>;
  /**
   * Who drives the camera (get_state cinema.driver), or null for the orbit camera.
   */
  readonly driver: Maybe<string>;
  /**
   * The time-control window in timeline seconds.
   */
  readonly window: Maybe<{ readonly earliest: number; readonly latest: number; readonly origin: boolean }>;
}

/**
 * The movie tool's report: the timeline's state and time, the look and the end, the current and next beats, and every
 * beat by time (waiting beats last, then stored order).
 */
export function MovieReportOf({ summary, records, events, time, movie, driver, window }: MovieReportInput): MovieReport {
  const state = summary?.state ?? 'idle';
  const beats = records
    .filter((record) => !record.removed)
    .map((record, order) => ({ row: BeatReportOf(record, time), order }))
    .sort((a, b) => (a.row.time ?? Infinity) - (b.row.time ?? Infinity) || a.order - b.order)
    .map(({ row }) => row);
  const next = beats.find((beat) => beat.state === 'pending' && beat.time != null);
  const end = movie?.end;
  const current = summary?.beat ?? {};
  return {
    state,
    time,
    ...(end != null ? { end, ...(summary?.startedAt != null && time >= end ? { ended: true as const } : {}) } : {}),
    ...(movie ? { look: { ...movieLookOf(movie), applied: MovieLookApplies(state) } } : {}),
    camera: { driver, ...(current.camera ? { beat: current.camera.id } : {}) },
    beat: { ...(current.fleet ? { fleet: current.fleet } : {}), ...(current.camera ? { camera: current.camera } : {}) },
    ...(next && next.time != null ? { next: { id: next.id, ...(next.name ? { name: next.name } : {}), lane: next.lane, action: next.action, time: next.time, in: next.in ?? 0 } } : {}),
    beats,
    waiting: beats.filter((beat) => beat.state === 'waiting').length,
    events: {
      count: events.length,
      last: events
        .slice(-MOVIE_REPORT_EVENTS)
        .reverse()
        .map(({ second, text }) => ({ second, text })),
      ...(summary?.events?.full ? { full: true as const } : {})
    },
    ...(window ? { window } : {}),
    ...(summary?.scripts ? { scripts: summary.scripts } : {}),
    ...(summary?.note ? { note: summary.note } : {})
  };
}

/**
 * A seek's jumps: one jump goes at most MAX_SEEK_AHEAD_SECONDS past the recorded end, and each landing is recorded, so
 * a target further ahead runs as consecutive jumps of that length.
 *
 * @param target - The seek's clock (100 ns ticks).
 * @param recordedEnd - TimeControl.recordedEnd.
 * @param maxAhead - The furthest one jump goes past the recorded end, 100 ns ticks.
 * @returns Each jump's target, the seek's own last.
 */
export function SeekChunks(target: number, recordedEnd: number, maxAhead = MAX_SEEK_AHEAD_SECONDS * TICKS_PER_SECOND): number[] {
  const chunks: number[] = [];
  let end = recordedEnd;
  while (target > end + maxAhead) {
    end += maxAhead;
    chunks.push(end);
  }
  chunks.push(target);
  return chunks;
}

/**
 * A look's keys: an aspect (or false for none) and whether the HUD shows; each optional (unset: the layer below's).
 */
export interface PresentationLook {
  readonly letterbox?: number | false;
  readonly hud?: boolean;
}

/**
 * What the director hands the page's presentation every frame: the playing shot's look, and the movie's while it
 * applies (with its run, the timeline's t = 0 tick: a load or a restart is a new run).
 */
export interface FramePresentation {
  readonly shot: PresentationLook;
  readonly movie: Maybe<{ readonly letterbox: number | false; readonly hud: boolean; readonly run: number }>;
  /**
   * While a movie export runs (sd-export): its letterbox (a playing shot's own wins), the picture's rect in the output
   * frame (the canvas backing store is held at its size) and the output's size. The page's settings do not apply.
   */
  readonly export?: { readonly letterbox: Maybe<number>; readonly picture: ExportRect; readonly output: { readonly width: number; readonly height: number } };
}

/**
 * The keys the user switched (L, H) while a movie's look applied: they win over the movie for the run.
 */
export interface MovieRunOverrides {
  readonly letterbox?: Maybe<number>;
  readonly hud?: boolean;
}

/**
 * The frame's presentation, lowest first: the page's settings (`?letterbox=`, `?hud=`, L and H), the movie's look
 * while it applies (each key the user switched during the run is the user's), a playing shot's own look.
 *
 * @returns The aspect (null: none) and whether the HUD shows.
 */
export function MoviePresentation({
  page,
  movie,
  overrides = {},
  shot = {}
}: {
  readonly page: { readonly letterbox: Maybe<number>; readonly hud: boolean };
  readonly movie: Maybe<{ readonly letterbox: number | false; readonly hud: boolean }>;
  readonly overrides?: MovieRunOverrides;
  readonly shot?: PresentationLook;
}): { readonly letterbox: Maybe<number>; readonly hud: boolean } {
  let letterbox = page.letterbox;
  let hud = page.hud;
  if (movie) {
    letterbox = overrides.letterbox !== undefined ? overrides.letterbox : movie.letterbox || null;
    hud = overrides.hud ?? movie.hud;
  }
  if (shot.letterbox !== undefined) letterbox = shot.letterbox || null;
  if (shot.hud !== undefined) hud = shot.hud;
  return { letterbox, hud };
}
