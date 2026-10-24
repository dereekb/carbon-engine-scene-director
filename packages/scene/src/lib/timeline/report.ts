/**
 * What the page reports about the timeline (get_state `timeline`, each scripted ship's `script`, and the timeline
 * tool's full report): the states and the report shapes the hub, verify-page and the specs share.
 */

import type { Maybe } from '@dereekb/util';
import type { CueTrigger } from './events';
import type { SceneCueAdds, SceneMovie, TimelineActionKind, TimelineActionName } from './timeline';

/**
 * The timeline's state: `idle` (the scene has no script), `stopped` (a live scene gained one: `timeline play` starts
 * it), `preparing` (a scripted load holds the scene clock until every hull's numbers, fit and build settled),
 * `ready` (prepared, held at t = 0 until play), `playing`, `paused` (the cursor and the ship scripts hold; ships fly on),
 * `done` (playing with no pending cue and every script ended).
 */
export const TIMELINE_STATES = ['idle', 'stopped', 'preparing', 'ready', 'playing', 'paused', 'done'] as const;

export type TimelineState = (typeof TIMELINE_STATES)[number];

/**
 * A cue's state: `waiting` (an event cue whose event has not come: no due second yet), `pending` (due at a second: a
 * timed cue, or a resolved event cue), `fired`, `failed` (its lever threw: the error is kept, it never fires again),
 * `skipped` (fired with nothing to do, e.g. a camera cue with the timeline's camera off), `missed` (added or retimed into
 * the past while playing: it plays from the next restart).
 */
export const CUE_STATES = ['waiting', 'pending', 'fired', 'failed', 'skipped', 'missed'] as const;

export type CueState = (typeof CUE_STATES)[number];

/**
 * A ship script's state: `waiting` (on a step's after, or in warp before its order), `arriving` (a warp-in not landed
 * yet), `flying` (a step's order runs), `holding` (its last, never-ending order flies on), `done`, `failed` (a refusal or
 * a dropped order; a step whose target was destroyed ends instead, and the script goes on), `interrupted` (another
 * order took the ship), `destroyed`.
 */
export const SHIP_SCRIPT_STATES = ['waiting', 'arriving', 'flying', 'holding', 'done', 'failed', 'interrupted', 'destroyed'] as const;

export type ShipScriptState = (typeof SHIP_SCRIPT_STATES)[number];

/**
 * One cue in a report.
 */
export interface CueReport {
  readonly id: string;
  /**
   * A timed cue's time; an event cue's arm time when given.
   */
  readonly at?: number;
  /**
   * An event cue's trigger, its derived arm time, its latest, and the text.
   */
  readonly when?: CueTrigger;
  readonly arms?: number;
  readonly latest?: number;
  readonly whenText?: string;
  /**
   * The timeline second it is due at (timed, or a resolved event cue).
   */
  readonly due?: number;
  /**
   * The event that resolved an event cue: its timeline second and text.
   */
  readonly event?: { readonly second: number; readonly text: string };
  readonly name?: string;
  readonly action: TimelineActionName;
  readonly kind: TimelineActionKind;
  readonly state: CueState;
  /**
   * The world tick it fired (or failed) on.
   */
  readonly tick?: number;
  readonly note?: string;
  readonly error?: string;
  /**
   * The lever's compact result.
   */
  readonly result?: unknown;
  readonly adds?: SceneCueAdds;
}

/**
 * A beat in get_state's timeline: the last fired cue of a lane.
 */
export interface TimelineBeatReport {
  readonly id: string;
  readonly name?: string;
  /**
   * The timeline second it fired.
   */
  readonly at: number;
}

/**
 * A scripted ship's progress (get_state ships[].script).
 */
export interface ShipScriptReport {
  readonly state: ShipScriptState;
  /**
   * The step running or next, 0-based.
   */
  readonly step: number;
  readonly steps: number;
  readonly order?: string;
  /**
   * Seconds until the step's order is given.
   */
  readonly startsIn?: number;
  /**
   * Seconds until a step with a duration ends.
   */
  readonly endsIn?: number;
  readonly note?: string;
}

/**
 * get_state's `timeline` (null for a scene without a script).
 */
export interface TimelineSummary {
  readonly state: TimelineState;
  /**
   * Whole seconds played.
   */
  readonly time: number;
  /**
   * The world tick of t = 0.
   */
  readonly startedAt?: number;
  /**
   * Whether camera cues play.
   */
  readonly camera: boolean;
  readonly cues: Readonly<Record<'total' | CueState, number>>;
  /**
   * Pending cues with a due second (timed, or resolved event cues).
   */
  readonly next?: readonly { readonly id: string; readonly at?: number; readonly action: TimelineActionName; readonly in: number }[];
  readonly last?: readonly { readonly id: string; readonly at?: number; readonly action: TimelineActionName; readonly tick?: number; readonly state: CueState; readonly note?: string }[];
  readonly failed?: readonly { readonly id: string; readonly at?: number; readonly action: TimelineActionName; readonly tick?: number; readonly error: string }[];
  /**
   * Event cues still waiting (≤ 5): their trigger text, and seconds until they arm and until their latest.
   */
  readonly waiting?: readonly { readonly id: string; readonly when: string; readonly armsIn?: number; readonly latestIn?: number }[];
  /**
   * The last fired beat per lane: fleet (every action but the camera's) and camera.
   */
  readonly beat?: { readonly fleet?: TimelineBeatReport; readonly camera?: TimelineBeatReport };
  /**
   * The run's event log: its size and last entries (≤ 5).
   */
  readonly events?: { readonly count: number; readonly last: readonly { readonly second: number; readonly text: string }[]; readonly full?: true };
  /**
   * The movie block and whether its look applies.
   */
  readonly movie?: SceneMovie & { readonly ended?: boolean; readonly applied?: boolean };
  readonly scripts?: Readonly<Record<'ships' | ShipScriptState, number>>;
  readonly liveEdits?: { readonly count: number; readonly last: readonly { readonly source: 'cue' | 'edit'; readonly cue?: string; readonly tick: number; readonly adds?: SceneCueAdds }[] };
  readonly preparing?: { readonly seconds: number; readonly waiting: Readonly<Record<string, number>> };
  readonly note?: Maybe<string>;
}
