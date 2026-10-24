/**
 * The `movie` tool (Movie mode M5): the authoring view over the timeline. Beats are the timeline's cues in two lanes,
 * camera and fleet; the command adds, moves, edits and removes them, plays or seeks from one, and sets the movie's look
 * and end. Runtime-free: the page implements it, the hub lists it.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject } from '../json';
import { SceneError } from '../scene';
import { isTimeRate, MAX_TIME_RATE, MIN_TIME_RATE } from '../time/command';
import type { CueState, TimelineState } from './report';
import { DEFAULT_MOVIE_LETTERBOX, MAX_TIMELINE_SECONDS, type SceneMovie, type TimelineActionName } from './timeline';

export const MOVIE_ACTIONS = ['status', 'add', 'move', 'edit', 'remove', 'play', 'seek', 'pause', 'restart', 'retake', 'set'] as const;

export type MovieAction = (typeof MOVIE_ACTIONS)[number];

/**
 * The beat lanes: the camera's (play_shot, play_sequence, stop_shot, auto_camera) and the fleet's (every other action,
 * warp-in patch cues included).
 */
export const BEAT_LANES = ['fleet', 'camera'] as const;

export type BeatLane = (typeof BEAT_LANES)[number];

export const CAMERA_BEAT_ACTIONS: readonly TimelineActionName[] = ['play_shot', 'play_sequence', 'stop_shot', 'auto_camera'];

/**
 * How far before a beat `movie play { from }` lands by default, seconds: the beat plays in, not from its first frame.
 */
export const DEFAULT_MOVIE_LEAD_SECONDS = 2;

/**
 * Where a play or a seek goes: a beat (cue) id, or seconds of timeline time.
 */
export type MovieBeatTarget = string | number;

export type MovieCommand =
  | { readonly action: 'status' }
  | { readonly action: 'add'; readonly beat: JsonObject }
  | { readonly action: 'move'; readonly id: string; readonly at?: Maybe<number>; readonly when?: Maybe<JsonObject> }
  | { readonly action: 'edit'; readonly id: string; readonly set: JsonObject }
  | { readonly action: 'remove'; readonly id: string }
  | { readonly action: 'play'; readonly from?: MovieBeatTarget; readonly lead: number; readonly rate?: number }
  | { readonly action: 'seek'; readonly to: MovieBeatTarget; readonly offset: number; readonly play: boolean }
  | { readonly action: 'pause' }
  | { readonly action: 'restart'; readonly paused: boolean }
  | { readonly action: 'retake' }
  | { readonly action: 'set'; readonly movie: Maybe<JsonObject> };

/**
 * The fields each action reads (besides `action`).
 */
const MOVIE_ACTION_FIELDS: Readonly<Record<MovieAction, readonly string[]>> = {
  status: [],
  add: ['beat'],
  move: ['id', 'at', 'when'],
  edit: ['id', 'set'],
  remove: ['id'],
  play: ['from', 'lead', 'rate'],
  seek: ['to', 'offset', 'play'],
  pause: [],
  restart: ['paused'],
  retake: [],
  set: ['movie']
};

const MOVIE_FIELDS = new Set(Object.values(MOVIE_ACTION_FIELDS).flat());

/**
 * A beat's lane.
 *
 * @param action - The cue's action.
 * @returns camera for the camera's levers, else fleet.
 */
export function beatLaneOf(action: TimelineActionName): BeatLane {
  return CAMERA_BEAT_ACTIONS.includes(action) ? 'camera' : 'fleet';
}

/**
 * The movie block's look with its defaults: letterbox DEFAULT_MOVIE_LETTERBOX, HUD off.
 *
 * @param movie - The timeline's movie block.
 * @returns The letterbox and the HUD the movie plays with.
 */
export function movieLookOf(movie: SceneMovie): { readonly letterbox: number | false; readonly hud: boolean } {
  return { letterbox: movie.letterbox ?? DEFAULT_MOVIE_LETTERBOX, hud: movie.hud ?? false };
}

/**
 * Validates a movie command.
 *
 * @param input - The tool's arguments.
 * @param where - The message prefix.
 * @returns The command, defaults filled (play's lead, seek's offset and play, restart's paused).
 * @throws {SceneError} With every problem found.
 */
export function normalizeMovieCommand(input: unknown, where = 'movie'): MovieCommand {
  if (input != null && !isPlainObject(input)) throw new SceneError([`${where} must be an object { action?, ... }`]);
  const object = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const action = object['action'] ?? 'status';
  if (typeof action !== 'string' || !(MOVIE_ACTIONS as readonly string[]).includes(action)) {
    throw new SceneError([`${where}.action must be one of ${MOVIE_ACTIONS.join(', ')}`]);
  }
  const fields = MOVIE_ACTION_FIELDS[action as MovieAction];
  for (const key of Object.keys(object)) {
    if (key === 'action' || fields.includes(key)) continue;
    if (MOVIE_FIELDS.has(key)) problems.push(`${where}.${key} does not go with action "${action}" (it takes ${fields.length ? fields.join(', ') : 'no other field'})`);
    else problems.push(`${where}.${key} is not a movie field (action, ${[...MOVIE_FIELDS].join(', ')})`);
  }
  const command = readCommand(action as MovieAction, object, problems, where);
  if (problems.length) throw new SceneError(problems);
  return command;
}

function readCommand(action: MovieAction, object: Record<string, unknown>, problems: string[], where: string): MovieCommand {
  switch (action) {
    case 'add': {
      const beat = object['beat'];
      if (!isPlainObject(beat)) problems.push(`${where}.beat must be a cue { id?, at?, when?, name?, <action>: <its arguments> } (the timeline's add_cue)`);
      return { action, beat: isPlainObject(beat) ? beat : {} };
    }
    case 'move': {
      const id = readId(object, problems, where);
      const at = object['at'];
      const when = object['when'];
      if (at === undefined && when === undefined) problems.push(`${where}: move needs at (timeline seconds) or when (an event; null makes it timed)`);
      if (at != null && !isTimelineSeconds(at)) problems.push(`${where}.at must be seconds of timeline time, 0 to ${MAX_TIMELINE_SECONDS} (null leaves an event cue to arm when what it names exists)`);
      if (when != null && !isPlainObject(when)) problems.push(`${where}.when must be an event { kill | arrival | warp | cue | primary | fire: <filter>, count?, after?, latest? }, or null to make it timed`);
      return { action, id, ...(at !== undefined ? { at: isTimelineSeconds(at) ? at : null } : {}), ...(when !== undefined ? { when: isPlainObject(when) ? when : null } : {}) };
    }
    case 'edit': {
      const id = readId(object, problems, where);
      const set = object['set'];
      if (!isPlainObject(set) || !Object.keys(set).length) problems.push(`${where}.set must be the cue's changes { at?, when?, name?, <action>? } (the timeline's update_cue)`);
      return { action, id, set: isPlainObject(set) ? set : {} };
    }
    case 'remove':
      return { action, id: readId(object, problems, where) };
    case 'play': {
      const from = object['from'];
      const lead = object['lead'];
      const rate = object['rate'];
      if (from !== undefined && !isBeatTarget(from)) problems.push(`${where}.from must be a beat id or seconds of timeline time (0 or more)`);
      if (lead !== undefined && (from === undefined || !isFiniteNumber(lead) || lead < 0)) problems.push(from === undefined ? `${where}.lead goes with from` : `${where}.lead must be seconds, 0 or more`);
      if (rate !== undefined && !isTimeRate(rate)) problems.push(`${where}.rate must be a number from ${MIN_TIME_RATE} to ${MAX_TIME_RATE}`);
      return { action, ...(isBeatTarget(from) ? { from } : {}), lead: isFiniteNumber(lead) && lead >= 0 ? lead : DEFAULT_MOVIE_LEAD_SECONDS, ...(isTimeRate(rate) ? { rate } : {}) };
    }
    case 'seek': {
      const to = object['to'];
      const offset = object['offset'];
      const play = object['play'];
      if (!isBeatTarget(to)) problems.push(`${where}.to must be a beat id or seconds of timeline time (0 or more)`);
      if (offset !== undefined && !isFiniteNumber(offset)) problems.push(`${where}.offset must be seconds (negative lands before the beat)`);
      if (play !== undefined && typeof play !== 'boolean') problems.push(`${where}.play must be true (play on from the landing) or false (land paused)`);
      return { action, to: isBeatTarget(to) ? to : 0, offset: isFiniteNumber(offset) ? offset : 0, play: play === true };
    }
    case 'restart': {
      const paused = object['paused'];
      if (paused !== undefined && typeof paused !== 'boolean') problems.push(`${where}.paused must be true or false`);
      return { action, paused: paused === true };
    }
    case 'set': {
      const movie = object['movie'];
      if (movie !== null && !isPlainObject(movie)) problems.push(`${where}.movie must be { letterbox?, hud?, end? } (a null key resets it) or null (no movie block)`);
      return { action, movie: isPlainObject(movie) ? movie : null };
    }
    default:
      return { action };
  }
}

function readId(object: Record<string, unknown>, problems: string[], where: string): string {
  const id = object['id'];
  if (typeof id !== 'string' || !id) problems.push(`${where}.id must be the beat's cue id (movie status lists them)`);
  return typeof id === 'string' ? id : '';
}

function isBeatTarget(value: unknown): value is MovieBeatTarget {
  return (typeof value === 'string' && value.length > 0) || isTimelineSeconds(value);
}

function isTimelineSeconds(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_TIMELINE_SECONDS;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * How a beat is triggered: a time, or an event (its text, when it arms, after and latest).
 */
export type MovieBeatTrigger = { readonly at: number } | { readonly when: string; readonly arms?: number; readonly after?: number; readonly latest?: number };

/**
 * One beat in the movie report.
 */
export interface MovieBeatReport {
  readonly id: string;
  readonly name?: string;
  readonly lane: BeatLane;
  readonly action: TimelineActionName;
  readonly trigger: MovieBeatTrigger;
  /**
   * Timeline seconds: when it fired, else when it is due (timed, or a resolved event cue); null while it waits.
   */
  readonly time: Maybe<number>;
  readonly state: CueState;
  /**
   * Seconds until it, for a beat still ahead.
   */
  readonly in?: number;
  readonly note?: string;
  readonly error?: string;
}

/**
 * A lane's current beat: the last one fired.
 */
export interface MovieCurrentBeat {
  readonly id: string;
  readonly name?: string;
  readonly at: number;
}

/**
 * The movie tool's report (status, and after play, seek, pause, restart and retake).
 */
export interface MovieReport {
  readonly state: TimelineState;
  /**
   * Timeline seconds now (fractional), 0 before t = 0.
   */
  readonly time: number;
  readonly end?: number;
  /**
   * The movie reached its end (the clock stopped there; movie play goes on past it).
   */
  readonly ended?: boolean;
  /**
   * The movie block's look, and whether it applies now (the timeline is not idle or stopped); absent without a movie
   * block.
   */
  readonly look?: { readonly letterbox: number | false; readonly hud: boolean; readonly applied: boolean };
  readonly camera: { readonly driver: Maybe<string>; readonly beat?: string };
  readonly beat: { readonly fleet?: MovieCurrentBeat; readonly camera?: MovieCurrentBeat };
  readonly next?: { readonly id: string; readonly name?: string; readonly lane: BeatLane; readonly action: TimelineActionName; readonly time: number; readonly in: number };
  /**
   * Every beat, by time (waiting beats last), then in stored order.
   */
  readonly beats: readonly MovieBeatReport[];
  readonly waiting: number;
  readonly events: { readonly count: number; readonly last: readonly { readonly second: number; readonly text: string }[]; readonly full?: true };
  /**
   * The time-control window in timeline seconds; origin: t = 0's pinned snapshot is in it (every beat can be reached).
   */
  readonly window?: { readonly earliest: number; readonly latest: number; readonly origin: boolean };
  readonly scripts?: Readonly<Record<string, number>>;
  readonly note?: string;
}

/**
 * A movie edit's result (add, move, edit, remove, set).
 */
export interface MovieEditResult {
  /**
   * The beat's report row (null after a remove, or for set).
   */
  readonly beat: Maybe<MovieBeatReport>;
  /**
   * The re-simulation the edit ran (null when it changed only the future), absent when it could not re-simulate.
   */
  readonly resimulated?: unknown;
  readonly movie: MovieReport;
  readonly warnings: string[];
}
