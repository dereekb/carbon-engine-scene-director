/**
 * The director's visibility floor (auto_camera `minShipSize`): how big a framing draws its subject's ships, as a share of
 * the frame height, judged on the director's own scene (EVE radii, DIRECTOR_ASPECT) so a pick is the same on any
 * device, resolution or export fps.
 *
 *   size = median EVE radius of the subject's ships ÷ (eye distance × the view's half height at the pose's lens)
 *
 * The typical hull's diameter over the frame's height, with Carbon's aspect clamp. A moving shot is judged at its
 * farthest frame (`DIRECTOR_FRAMING_REACH`): a push out multiplies the distance, a radii path takes its farthest point.
 */

import type { Maybe } from '@dereekb/util';
import { viewHalfExtents } from '../framing';
import type { ResolvedHardpoint } from '../hardpoints';
import { CAMERA_SHOT_LIBRARY } from '../library';
import type { CameraPose } from '../pose';
import { cinemaMemo, sceneFocus, type CinemaScene, type CinemaShip } from '../subjects';
import { distanceVec } from '../vectors';
import { DIRECTOR_FRAMINGS, type DirectorFramingName } from './framings';
import type { DirectorSubject } from './interest';
import { DIRECTOR_ASPECT } from './picture';

/**
 * A shot on screen is cut once its size falls under this share of the floor (the margin keeps a shot picked just above
 * the floor from being cut by drift).
 */
export const SIZE_KEEP_FACTOR = 0.8;
/**
 * Tightening aims this far over the floor (hardpoint distances are not exactly proportional to fill).
 */
export const TIGHTEN_MARGIN = 1.05;
/**
 * Tightening tries at most this many fills.
 */
export const TIGHTEN_TRIES = 2;

/**
 * How far out a framing's eye reaches over its shot: `factor` × the base pose's distance (a push out), or `radii` × the
 * subject's radius from its centre (a path in radii, at its farthest point).
 */
export type DirectorFramingReach = { readonly factor: number } | { readonly radii: number };

function deriveReach(): Readonly<Partial<Record<DirectorFramingName, DirectorFramingReach>>> {
  const reach: Partial<Record<DirectorFramingName, DirectorFramingReach>> = {};
  for (const row of DIRECTOR_FRAMINGS) {
    const entry = row.library ? CAMERA_SHOT_LIBRARY.find((candidate) => candidate.name === row.library) : null;
    if (!entry) continue;
    const built = entry.build({ hardpoint: {} });
    const moves = Array.isArray(built['moves']) ? (built['moves'] as Record<string, unknown>[]) : [];
    let factor = 1;
    let radii = 0;
    for (const move of moves) {
      if (move['type'] === 'push' && typeof move['factor'] === 'number' && move['factor'] > 1) factor *= move['factor'];
      else if (move['type'] === 'path' && move['units'] === 'radii' && Array.isArray(move['points'])) {
        for (const point of move['points'] as unknown[]) if (Array.isArray(point)) radii = Math.max(radii, Math.hypot(...(point as number[])));
      }
    }
    if (radii > 0) reach[row.name] = { radii };
    else if (factor > 1) reach[row.name] = { factor };
  }
  return reach;
}

/**
 * Each moving framing's reach, from the library entries' built moves (a spec pins it); the rest are judged at their
 * base pose (push-in, zoom-in and orbit moves never take the eye farther).
 */
export const DIRECTOR_FRAMING_REACH = deriveReach();

/**
 * The ships a framing's size is judged on: a ship framing the ship; a pair its shooter; a group its landed members (with
 * the arriving ones for warp-in); an engagement or landmark the axis teams' landed ships, else every landed one.
 */
function sizeShips(scene: CinemaScene, subject: DirectorSubject, framing: DirectorFramingName, teams: Maybe<readonly [string, string]>): readonly CinemaShip[] {
  let ships: readonly CinemaShip[];
  if (subject.kind === 'ship') ships = scene.ships.filter((ship) => ship.id === subject.ship);
  else if (subject.kind === 'pair') ships = scene.ships.filter((ship) => ship.id === subject.ship);
  else if (subject.kind === 'group') {
    const members = new Set(subject.members);
    ships = [...scene.ships, ...(framing === 'warp-in' ? (scene.arriving ?? []) : [])].filter((ship) => members.has(ship.id));
  } else {
    const sides = teams ? scene.ships.filter((ship) => ship.team === teams[0] || ship.team === teams[1]) : [];
    ships = sides.length ? sides : scene.ships;
  }
  return ships;
}

/**
 * The lower median EVE radius of the ships a framing judges its subject by, metres; memoized on the director's scene.
 *
 * @returns The radius, or 0 with no ships.
 */
export function subjectShipRadius(scene: CinemaScene, subject: DirectorSubject, framing: DirectorFramingName, teams: Maybe<readonly [string, string]>): number {
  const kind = subject.kind === 'group' && framing === 'warp-in' ? 'arriving' : 'landed';
  const teamsKey = subject.kind === 'engagement' || subject.kind === 'landmark' ? `|${teams?.join(',') ?? ''}` : '';
  return cinemaMemo(scene, `director-size|${subject.key}|${kind}${teamsKey}`, () => {
    const radii = sizeShips(scene, subject, framing, teams)
      .map((ship) => ship.radius ?? ship.frameRadius)
      .sort((a, b) => a - b);
    return radii.length ? radii[Math.floor((radii.length - 1) / 2)] : 0;
  });
}

export interface FramedShipSizeInput {
  readonly scene: CinemaScene;
  readonly framing: DirectorFramingName;
  readonly subject: DirectorSubject;
  readonly resolved: ResolvedHardpoint;
  readonly pose: CameraPose;
  /**
   * The axis teams (engagement and landmark framings).
   */
  readonly teams: Maybe<readonly [string, string]>;
}

/**
 * The framing's ship size: the subject's typical hull diameter over the frame height at the framing's farthest frame.
 *
 * @returns The share of the frame height; Infinity when the eye sits on the subject's centre; 0 with no ships.
 */
export function framedShipSize(input: FramedShipSizeInput): number {
  const { scene, framing, subject, resolved, pose, teams } = input;
  const radius = subjectShipRadius(scene, subject, framing, teams);
  const centre = subject.kind === 'landmark' ? sceneFocus(scene, teams ?? undefined).centre : (resolved.subject?.centre ?? pose.look);
  const reach = DIRECTOR_FRAMING_REACH[framing];
  let distance = distanceVec(pose.eye, centre);
  if (reach && 'factor' in reach) distance *= reach.factor;
  else if (reach && 'radii' in reach) distance = reach.radii * (resolved.subject?.radius ?? 0);
  const { halfHeight } = viewHalfExtents(pose.fov, DIRECTOR_ASPECT);
  let size = 0;
  if (radius > 0) size = distance > 0 ? radius / (distance * halfHeight) : Infinity;
  return size;
}

/**
 * A size for reports and the cut log: 3 significant figures.
 */
export function roundShipSize(size: number): number {
  return Number.isFinite(size) ? Number(size.toPrecision(3)) : size;
}

/**
 * A size as a percentage of the frame height, for whys: "0.31 %".
 */
export function shipSizeText(size: number): string {
  return `${Number((size * 100).toPrecision(2))} %`;
}
