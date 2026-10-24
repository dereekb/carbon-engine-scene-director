/**
 * get_state.cinema.director: the director's state, bias, current pick and why, its best candidates and its recent
 * cuts. Compact on purpose (get_state is large): 3 candidates, 5 recent cuts; auto_camera's result carries the 20-cut
 * log.
 */

import type { Maybe } from '@dereekb/util';
import type { DirectorSide } from './axis';
import { directorHold, type CameraDirectorSettings, type DirectorFollow, type DirectorPace, type DirectorScale } from './command';
import type { DirectorFramingName } from './framings';
import type { DirectorEventRef } from './interest';
import type { DirectorCandidateReport, DirectorPick } from './step';

/**
 * off; waiting (on, until the scene settles or has something to frame); driving (its shot is on screen); paused (its
 * shot frozen by stop_shot { pause }); yielded (on, but Claude, the timeline or the user has the camera).
 */
export const CAMERA_DIRECTOR_STATES = ['off', 'waiting', 'driving', 'paused', 'yielded'] as const;

export type CameraDirectorState = (typeof CAMERA_DIRECTOR_STATES)[number];

/**
 * Who turned the director on.
 */
export const CAMERA_DIRECTOR_SOURCES = ['claude', 'timeline', 'user'] as const;

export type CameraDirectorSource = (typeof CAMERA_DIRECTOR_SOURCES)[number];

export interface DirectorBiasReport {
  readonly follow: Maybe<DirectorFollow>;
  readonly favour: Maybe<DirectorScale>;
  readonly sun: boolean;
  readonly teams: Maybe<readonly [string, string]>;
  readonly pace: DirectorPace;
  readonly hold: { readonly min: number; readonly max: number };
  readonly letterbox: Maybe<number | false>;
  readonly hud: Maybe<boolean>;
  readonly seed: Maybe<number>;
}

export interface DirectorPickReport {
  readonly framing: DirectorFramingName;
  readonly shot: { readonly library?: string; readonly hardpoint: string; readonly subject: string };
  readonly scale: DirectorScale;
  readonly side: DirectorSide;
  /**
   * Seconds on screen, and until its max hold.
   */
  readonly since: number;
  readonly holdsFor: number;
  readonly score: number;
  readonly why: string;
  readonly event?: DirectorEventRef;
  readonly transition: 'cut' | 'blend';
}

export interface CameraDirectorReport {
  readonly on: boolean;
  readonly state: CameraDirectorState;
  readonly yieldedTo?: 'user' | 'claude' | 'timeline';
  readonly source?: CameraDirectorSource;
  readonly bias: DirectorBiasReport;
  readonly pick?: DirectorPickReport;
  readonly candidates: readonly DirectorCandidateReport[];
  readonly axis?: { readonly kind: 'teams' | 'motion'; readonly teams?: readonly [string, string]; readonly ship?: string; readonly side: DirectorSide };
  readonly cuts: number;
  readonly recent: readonly { readonly at: number; readonly framing: DirectorFramingName; readonly subject: string; readonly scale: DirectorScale; readonly why: string }[];
  readonly cost: { readonly lastMs: number; readonly maxMs: number };
  readonly note?: string;
}

export function toDirectorBiasReport(settings: CameraDirectorSettings): DirectorBiasReport {
  return { follow: settings.follow, favour: settings.favour, sun: settings.sun, teams: settings.teams, pace: settings.pace, hold: directorHold(settings), letterbox: settings.letterbox, hud: settings.hud, seed: settings.seed };
}

/**
 * A pick for the report, at scene time `time`.
 *
 * @param pick - The pick.
 * @param time - Scene seconds now.
 */
export function describeDirectorPick(pick: DirectorPick, time: number): DirectorPickReport {
  const since = Math.max(0, time - pick.since);
  const library = typeof pick.shot['shot'] === 'string' ? pick.shot['shot'] : undefined;
  return {
    framing: pick.framing,
    shot: { ...(library ? { library } : {}), hardpoint: pick.hardpoint.name, subject: pick.label },
    scale: pick.scale,
    side: pick.side,
    since: Math.round(since * 10) / 10,
    holdsFor: Math.max(0, Math.round((pick.max - since) * 10) / 10),
    score: pick.score,
    why: pick.why,
    ...(pick.event ? { event: pick.event } : {}),
    transition: pick.transition
  };
}

/**
 * The HUD's director line: "driving · hero tfis-fc · 3 s (red-dps-02 exploded)", "yielded to you · D hands back".
 *
 * @param report - The director report.
 * @returns The line, or null when off.
 */
export function cameraDirectorText(report: CameraDirectorReport): Maybe<string> {
  let text: Maybe<string> = null;
  if (report.state === 'driving' && report.pick) {
    const top = report.pick.why.split(' · ')[0];
    text = `driving · ${report.pick.framing} ${report.pick.shot.subject} · ${Math.round(report.pick.since)} s (${top})`;
  } else if (report.state === 'yielded') text = `yielded to ${report.yieldedTo === 'user' || report.yieldedTo == null ? 'you' : report.yieldedTo} · D hands back`;
  else if (report.state === 'paused') text = 'paused · resume_shot continues';
  else if (report.state === 'waiting') text = ['waiting', ...(report.note ? [report.note] : [])].join(' · ');
  else if (report.state === 'driving') text = 'driving';
  return text;
}
