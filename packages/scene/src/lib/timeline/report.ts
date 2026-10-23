/**
 * What the page reports about the timeline (get_state `timeline`, each scripted ship's `script`, and the timeline
 * tool's full report): the states and the report shapes the hub, verify-page and the specs share.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneCueAdds, TimelineActionKind, TimelineActionName } from './timeline';

/**
 * The timeline's state: `idle` (the scene has no script), `stopped` (a live scene gained one: `timeline play` starts
 * it), `preparing` (a scripted load holds the scene clock until every hull's numbers, fit and build settled),
 * `ready` (prepared, held at t = 0 until play), `playing`, `paused` (the cursor and the ship scripts hold; ships fly on),
 * `done` (playing with no pending cue and every script ended).
 */
export const TIMELINE_STATES = ['idle', 'stopped', 'preparing', 'ready', 'playing', 'paused', 'done'] as const;

export type TimelineState = (typeof TIMELINE_STATES)[number];

/**
 * A cue's state: `pending`, `fired`, `failed` (its lever threw: the error is kept, it never fires again), `skipped`
 * (fired with nothing to do, e.g. a camera cue with the timeline's camera off), `missed` (added or retimed into the past
 * while playing: it plays from the next restart).
 */
export const CUE_STATES = ['pending', 'fired', 'failed', 'skipped', 'missed'] as const;

export type CueState = (typeof CUE_STATES)[number];

/**
 * A ship script's state: `waiting` (on a step's after, or in warp before its order), `arriving` (a warp-in not landed
 * yet), `flying` (a step's order runs), `holding` (its last, never-ending order flies on), `done`, `failed` (a refusal or
 * a dropped order), `interrupted` (another order took the ship), `destroyed`.
 */
export const SHIP_SCRIPT_STATES = ['waiting', 'arriving', 'flying', 'holding', 'done', 'failed', 'interrupted', 'destroyed'] as const;

export type ShipScriptState = (typeof SHIP_SCRIPT_STATES)[number];

/**
 * One cue in a report.
 */
export interface CueReport {
  readonly id: string;
  readonly at: number;
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
  readonly next?: readonly { readonly id: string; readonly at: number; readonly action: TimelineActionName; readonly in: number }[];
  readonly last?: readonly { readonly id: string; readonly at: number; readonly action: TimelineActionName; readonly tick?: number; readonly state: CueState; readonly note?: string }[];
  readonly failed?: readonly { readonly id: string; readonly at: number; readonly action: TimelineActionName; readonly tick?: number; readonly error: string }[];
  readonly scripts?: Readonly<Record<'ships' | ShipScriptState, number>>;
  readonly liveEdits?: { readonly count: number; readonly last: readonly { readonly source: 'cue' | 'edit'; readonly cue?: string; readonly tick: number; readonly adds?: SceneCueAdds }[] };
  readonly preparing?: { readonly seconds: number; readonly waiting: Readonly<Record<string, number>> };
  readonly note?: Maybe<string>;
}
