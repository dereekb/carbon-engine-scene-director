/**
 * Waypoints: points anchored in space or on a ship or object, resolved against the scene as drawn, and the path through
 * them: a centripetal Catmull-Rom spline walked by arc length, passing waypoints at set times where given.
 *
 * The cinematic camera flies them (cinema/shot.ts's path move). Nothing here knows about cameras, so ship pathing (a
 * ship flying a route at set speeds) can resolve and walk the same waypoints.
 *
 * A waypoint is a bare [x, y, z] (in the path's own frame: world space, or the shot's subject) or an object:
 *
 *   { position: [x, y, z] }                     a point in space, scene metres
 *   { ship | object, offset?: [forward, starboard, up], units?: "metres" | "radii", bank? }
 *                                               a point riding on a hull, in its level heading frame (banked, rolling
 *                                               with it, with bank: true), in metres or hull radii
 *
 * either with `time?`: the seconds into the path it is passed at (the others are spaced by arc length between them).
 * Anchored waypoints move with their hull, so a path is resolved and measured again every frame.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, readVector, reportUnknownKeys } from '../json';
import type { SceneVector } from '../scene';
import { addScaledVec, distanceVec, fromFrame, headingAxes, normalizeVec, scaleVec, subVec, type CinemaQuaternion, type FrameAxes } from '../cinema/vectors';

export const WAYPOINT_UNITS = ['metres', 'radii'] as const;
export type WaypointUnits = (typeof WAYPOINT_UNITS)[number];

/**
 * A waypoint given as an object: in space (`position`) or on a hull (`ship` or `object`, with an `offset`).
 */
export interface AnchoredWaypoint {
  /**
   * A point in space, scene metres.
   */
  readonly position?: SceneVector;
  /**
   * The ship the point rides on.
   */
  readonly ship?: string;
  /**
   * The object the point rides on.
   */
  readonly object?: string;
  /**
   * [forward, starboard, up] off the hull's centre, in its heading frame; default [0, 0, 0].
   */
  readonly offset?: SceneVector;
  /**
   * What the offset counts: metres (default) or the hull's bounding radius, so one path fits any hull size.
   */
  readonly units?: WaypointUnits;
  /**
   * Ride the hull's banked frame (rolling with it) rather than its level heading.
   */
  readonly bank?: boolean;
  /**
   * Seconds into the path the waypoint is passed at.
   */
  readonly time?: number;
}

export type Waypoint = SceneVector | AnchoredWaypoint;

/**
 * A hull a waypoint rides on.
 */
export interface WaypointAnchor {
  readonly centre: SceneVector;
  /**
   * [x, y, z, w].
   */
  readonly rotation: CinemaQuaternion;
  /**
   * Its bounding radius: what `units: "radii"` counts.
   */
  readonly radius: number;
}

export interface WaypointContext {
  /**
   * The hull a ship or object id names, or null when it is not in the scene.
   */
  readonly anchorOf: (ref: { readonly ship?: string; readonly object?: string }) => Maybe<WaypointAnchor>;
  /**
   * The frame bare [x, y, z] waypoints are given in ([forward, starboard, up] off its centre); null for world space.
   * `scale` multiplies the bare points (a subject's radius, so one path fits any subject size); default 1.
   */
  readonly frame?: Maybe<FrameAxes & { readonly centre: SceneVector; readonly scale?: number }>;
}

const WAYPOINT_KEYS = new Set(['position', 'ship', 'object', 'offset', 'units', 'bank', 'time']);

/**
 * Where a waypoint is now.
 *
 * @param waypoint - The waypoint.
 * @param context - The anchors and the frame of bare points.
 * @returns Its scene position, or null when its hull is not in the scene.
 */
export function resolveWaypoint(waypoint: Waypoint, context: WaypointContext): Maybe<SceneVector> {
  let position: Maybe<SceneVector> = null;
  if (Array.isArray(waypoint)) {
    position = context.frame ? fromFrame(context.frame.centre, context.frame, scaleVec(waypoint, context.frame.scale ?? 1)) : [...waypoint];
  } else if (waypoint.position) {
    position = [...waypoint.position];
  } else {
    const anchor = context.anchorOf(waypoint);
    if (anchor) {
      const offset = waypoint.offset ?? [0, 0, 0];
      const scale = waypoint.units === 'radii' ? anchor.radius : 1;
      position = fromFrame(anchor.centre, headingAxes(anchor.rotation, waypoint.bank === true), scaleVec(offset, scale));
    }
  }
  return position;
}

/**
 * The hull a waypoint rides on, or null for a point in space.
 */
export function waypointAnchorId(waypoint: Waypoint): Maybe<string> {
  return Array.isArray(waypoint) ? null : (waypoint.ship ?? waypoint.object ?? null);
}

/**
 * The seconds a waypoint is passed at, or null when it is spaced by arc length.
 */
export function waypointTime(waypoint: Waypoint): Maybe<number> {
  return Array.isArray(waypoint) ? null : (waypoint.time ?? null);
}

/**
 * Reads one waypoint: [x, y, z] or { position } or { ship | object, offset?, units?, bank? }, each with time?.
 *
 * @param input - The JSON.
 * @param where - Where it sits, for messages.
 * @param problems - Receives every problem.
 * @param warnings - Receives one warning per unknown key.
 * @returns The waypoint, or null when invalid.
 */
export function readWaypoint(input: unknown, where: string, problems: string[], warnings: string[] = []): Maybe<Waypoint> {
  const before = problems.length;
  let waypoint: Maybe<Waypoint> = null;
  if (Array.isArray(input)) {
    waypoint = readVector(input, where, problems);
  } else if (isPlainObject(input)) {
    reportUnknownKeys(input, WAYPOINT_KEYS, where, warnings);
    const result: { -readonly [K in keyof AnchoredWaypoint]: AnchoredWaypoint[K] } = {};
    const anchors = ['position', 'ship', 'object'].filter((key) => input[key] != null);
    if (anchors.length !== 1) problems.push(`${where} needs exactly one of position ([x, y, z] in space), ship and object (an id the point rides on)`);
    if (input['position'] != null) result.position = readVector(input['position'], `${where}.position`, problems);
    for (const key of ['ship', 'object'] as const) {
      const value = input[key];
      if (value == null) continue;
      if (typeof value === 'string' && value.trim()) result[key] = value.trim();
      else problems.push(`${where}.${key} must be an id`);
    }
    if (input['offset'] != null) result.offset = readVector(input['offset'], `${where}.offset`, problems);
    if (input['units'] != null) {
      if (WAYPOINT_UNITS.includes(input['units'] as WaypointUnits)) result.units = input['units'] as WaypointUnits;
      else problems.push(`${where}.units must be "metres" or "radii"`);
    }
    if (input['bank'] != null) {
      if (typeof input['bank'] === 'boolean') result.bank = input['bank'];
      else problems.push(`${where}.bank must be true or false`);
    }
    if (input['time'] != null) {
      const time = input['time'];
      if (typeof time === 'number' && Number.isFinite(time) && time >= 0) result.time = time;
      else problems.push(`${where}.time must be seconds ≥ 0`);
    }
    if (result.position && (result.offset || result.units || result.bank != null)) problems.push(`${where}: offset, units and bank ride on a ship or object, not a position`);
    waypoint = result;
  } else {
    problems.push(`${where} must be [x, y, z], { position }, or { ship | object, offset?, units?, bank? }`);
  }
  return problems.length > before ? null : waypoint;
}

/**
 * Reads a list of waypoints: at least `min`, with any pass times never going back.
 */
export function readWaypoints(input: unknown, where: string, problems: string[], warnings: string[] = [], min = 2): Waypoint[] {
  const waypoints: Waypoint[] = [];
  if (!Array.isArray(input) || input.length < min) {
    problems.push(`${where} must be at least ${min} waypoints`);
  } else {
    input.forEach((entry, index) => {
      const waypoint = readWaypoint(entry, `${where}[${index}]`, problems, warnings);
      if (waypoint) waypoints.push(waypoint);
    });
    let last = -Infinity;
    for (const [index, waypoint] of waypoints.entries()) {
      const time = waypointTime(waypoint);
      if (time == null) continue;
      if (time < last) problems.push(`${where}[${index}].time goes back (${time} s after ${last} s)`);
      last = time;
    }
  }
  return waypoints;
}

/**
 * Samples per path segment when measuring its arc length.
 */
const PATH_SAMPLES = 32;

/**
 * A measured path through resolved waypoints.
 */
export interface WaypointPath {
  readonly points: readonly SceneVector[];
  /**
   * Cumulative arc length at each sample: PATH_SAMPLES per segment, from 0 at the first point.
   */
  readonly lengths: readonly number[];
  /**
   * Arc length at each waypoint.
   */
  readonly knots: readonly number[];
  readonly total: number;
}

/**
 * Measures the centripetal Catmull-Rom spline through the points, so it can be walked at constant speed.
 *
 * @param points - At least two.
 */
export function measureWaypointPath(points: readonly SceneVector[]): WaypointPath {
  const lengths = [0];
  const knots = [0];
  let previous = points[0];
  for (let segment = 0; segment < points.length - 1; segment++) {
    for (let sample = 1; sample <= PATH_SAMPLES; sample++) {
      const point = catmullRom(points, segment, sample / PATH_SAMPLES);
      lengths.push(lengths[lengths.length - 1] + distanceVec(previous, point));
      previous = point;
    }
    knots.push(lengths[lengths.length - 1]);
  }
  return { points, lengths, knots, total: lengths[lengths.length - 1] };
}

/**
 * The point `distance` metres along the path (clamped to its ends).
 */
export function pathPointAt(path: WaypointPath, distance: number): SceneVector {
  const { points, lengths, total } = path;
  if (!(total > 0)) return [...points[0]];
  const target = Math.max(0, Math.min(total, distance));
  let low = 0;
  let high = lengths.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (lengths[middle] < target) low = middle;
    else high = middle;
  }
  const span = lengths[high] - lengths[low];
  const sample = low + (span > 0 ? (target - lengths[low]) / span : 0);
  const segment = Math.min(points.length - 2, Math.floor(sample / PATH_SAMPLES));
  return catmullRom(points, segment, (sample - segment * PATH_SAMPLES) / PATH_SAMPLES);
}

/**
 * The path's direction `distance` metres along it.
 */
export function pathTangentAt(path: WaypointPath, distance: number): Maybe<SceneVector> {
  const step = Math.max(1e-3, path.total * 1e-3);
  const ahead = pathPointAt(path, Math.min(path.total, distance + step));
  const behind = pathPointAt(path, Math.max(0, distance - step));
  return normalizeVec(subVec(ahead, behind));
}

/**
 * How far along the path it is at `t` seconds of `duration`: each waypoint with a time is passed at it (the first at 0
 * and the last at the duration unless they say otherwise), at a steady speed between them.
 *
 * @param path - The measured path.
 * @param times - Each waypoint's pass time, or null.
 * @param t - Seconds into the path.
 * @param duration - Its length in seconds.
 */
export function pathDistanceAt(path: WaypointPath, times: readonly Maybe<number>[], t: number, duration: number): number {
  const last = path.knots.length - 1;
  const keys: { time: number; distance: number }[] = [];
  times.forEach((time, index) => {
    if (time != null && index <= last) keys.push({ time, distance: path.knots[index] });
  });
  if (times[0] == null) keys.unshift({ time: 0, distance: 0 });
  if (times[last] == null) keys.push({ time: Math.max(duration, keys[keys.length - 1]?.time ?? 0), distance: path.total });
  let distance = keys[keys.length - 1].distance;
  if (t <= keys[0].time) distance = keys[0].distance;
  else {
    for (let index = 0; index < keys.length - 1; index++) {
      const from = keys[index];
      const to = keys[index + 1];
      if (t <= to.time) {
        const span = to.time - from.time;
        distance = from.distance + (to.distance - from.distance) * (span > 0 ? (t - from.time) / span : 1);
        break;
      }
    }
  }
  return distance;
}

/**
 * A centripetal (alpha 0.5) Catmull-Rom spline through the points, on one segment.
 *
 * @param points - At least two points; the ends are extended by reflection.
 * @param segment - From points[segment] to points[segment + 1].
 * @param s - 0..1 along the segment's parameter.
 */
export function catmullRom(points: readonly SceneVector[], segment: number, s: number): SceneVector {
  const last = points.length - 1;
  const p1 = points[segment];
  const p2 = points[Math.min(last, segment + 1)];
  const p0 = segment > 0 ? points[segment - 1] : addScaledVec(p1, subVec(p1, p2), 1);
  const p3 = segment + 2 <= last ? points[segment + 2] : addScaledVec(p2, subVec(p2, p1), 1);
  const knot = (a: SceneVector, b: SceneVector): number => Math.max(1e-6, Math.sqrt(distanceVec(a, b)));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * s;
  const mix = (a: SceneVector, b: SceneVector, ta: number, tb: number): SceneVector => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}
