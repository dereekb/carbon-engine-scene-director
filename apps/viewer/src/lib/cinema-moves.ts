/**
 * The cinematic camera's moves, as pure functions of time: each move turns the hardpoint's live pose at `t` seconds
 * into the shot. They apply in order, in the pose's own frame (a dolly runs along the view, a truck along its right).
 *
 * - Timed moves (dolly, truck, crane, push, zoom, an orbit, roll or spin by `angle`, a path) run from `at` over their
 *   `duration` (else the shot's, else DEFAULT_MOVE_SECONDS) through their easing.
 * - Rate moves (orbit, roll or spin by `rate`) turn at a steady rate from `at`, for their duration or until the shot
 *   ends.
 * - The shake is value noise seeded per shot: no Math.random, so a replay or an exported movie reproduces it.
 * - Lag is exponential smoothing on scene seconds: a paused clock freezes it, and fixed steps repeat exactly.
 *
 * Node-tested: it imports only the scene package and the clock.
 */

import type { Maybe } from '@dereekb/util';
import {
  addScaledVec,
  addVec,
  blendFov,
  cinemaAnchor,
  crossVec,
  distanceVec,
  headingAxes,
  lengthVec,
  measureWaypointPath,
  normalizeVec,
  orthogonalizeVec,
  pathDistanceAt,
  pathPointAt,
  pathTangentAt,
  poseForward,
  quatFromAxisAngle,
  resolveWaypoint,
  rotateVec,
  subVec,
  waypointTime,
  WORLD_UP,
  type CameraMove,
  type CameraMoveAxis,
  type CameraPose,
  type CinemaEasing,
  type CinemaScene,
  type SceneVector,
  type SubjectFrame,
  type WaypointContext
} from '@scene-director/scene';

const DEGREES = Math.PI / 180;

/**
 * A timed move with no duration of its own and a shot that holds runs over this many seconds.
 */
export const DEFAULT_MOVE_SECONDS = 4;

export interface MoveContext {
  /**
   * The frame the hardpoint stood in (orbit's subject-up, a subject-frame path); null for a free pose.
   */
  readonly subject: Maybe<SubjectFrame>;
  /**
   * The shot's noise seed.
   */
  readonly seed: number;
  /**
   * The shot's duration, seconds; null while it holds.
   */
  readonly shotDuration: Maybe<number>;
  /**
   * The scene as drawn, for waypoints riding on ships and objects; null leaves them unresolved.
   */
  readonly scene?: Maybe<CinemaScene>;
}

/**
 * Cubic easings.
 *
 * @param easing - The curve.
 * @param x - 0..1 (clamped).
 */
export function Ease(easing: Maybe<CinemaEasing>, x: number): number {
  const t = Math.max(0, Math.min(1, x));
  let eased: number;
  switch (easing) {
    case 'ease-in':
      eased = t * t * t;
      break;
    case 'ease-out':
      eased = 1 - (1 - t) ** 3;
      break;
    case 'ease-in-out':
      eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      break;
    default:
      eased = t;
  }
  return eased;
}

/**
 * A timed move's eased progress at `t`.
 *
 * @param move - The move.
 * @param t - Seconds into the shot.
 * @param shotDuration - The shot's duration, or null.
 * @returns 0 before it starts, 1 once it is done.
 */
export function MoveProgress(move: CameraMove, t: number, shotDuration: Maybe<number>): number {
  return Ease(move.easing ?? 'linear', (t - (move.at ?? 0)) / MoveDuration(move, shotDuration));
}

/**
 * Seconds a timed move runs: its own duration, else the rest of the shot, else DEFAULT_MOVE_SECONDS.
 */
export function MoveDuration(move: CameraMove, shotDuration: Maybe<number>): number {
  return move.duration ?? (shotDuration == null ? DEFAULT_MOVE_SECONDS : Math.max(1e-6, shotDuration - (move.at ?? 0)));
}

/**
 * Degrees a turning move (orbit, roll, spin) has turned by `t`: a rate times its running time, or its angle eased.
 */
export function MoveAngle(move: CameraMove & { readonly rate?: number; readonly angle?: number }, t: number, shotDuration: Maybe<number>): number {
  let angle = 0;
  if (move.rate != null) {
    const at = move.at ?? 0;
    const running = Math.max(0, Math.min(t - at, move.duration ?? Infinity));
    angle = move.rate * running;
  } else if (move.angle != null) {
    angle = move.angle * MoveProgress(move, t, shotDuration);
  }
  return angle;
}

/**
 * Plays the moves on a pose.
 *
 * @param base - The hardpoint's (or the free pose's) live pose.
 * @param moves - The shot's moves, applied in order.
 * @param t - Seconds into the shot.
 * @param context - The subject, the noise seed and the shot's duration.
 * @returns The moved pose.
 */
export function EvaluateMoves(base: CameraPose, moves: readonly CameraMove[], t: number, context: MoveContext): CameraPose {
  let pose = base;
  for (const move of moves) {
    if (t < (move.at ?? 0)) continue;
    pose = ApplyMove(pose, move, t, context);
  }
  return pose;
}

function ApplyMove(pose: CameraPose, move: CameraMove, t: number, context: MoveContext): CameraPose {
  const forward = poseForward(pose) ?? [0, 0, 1];
  const up = orthogonalizeVec(pose.up, forward) ?? orthogonalizeVec(WORLD_UP, forward) ?? [0, 1, 0];
  const right = crossVec(forward, up);
  const p = (): number => MoveProgress(move, t, context.shotDuration);
  let moved = pose;
  switch (move.type) {
    case 'dolly': {
      // Along the view; the eye stops short of the look point.
      const distance = distanceVec(pose.eye, pose.look);
      const travel = Math.min(move.distance * p(), distance * 0.99);
      moved = { ...pose, eye: addScaledVec(pose.eye, forward, travel) };
      break;
    }
    case 'truck':
    case 'crane': {
      const offset = (move.type === 'truck' ? right : up).map((value) => value * move.distance * p()) as SceneVector;
      moved = { ...pose, eye: addVec(pose.eye, offset), look: addVec(pose.look, offset) };
      break;
    }
    case 'push':
      moved = { ...pose, eye: addScaledVec(pose.look, subVec(pose.eye, pose.look), move.factor ** p()) };
      break;
    case 'zoom':
      moved = { ...pose, fov: blendFov(pose.fov, move.fov, p()) };
      break;
    case 'orbit': {
      const turn = quatFromAxisAngle(ResolveAxis(move.axis, up, context), MoveAngle(move, t, context.shotDuration) * DEGREES);
      moved = { ...pose, eye: addVec(pose.look, rotateVec(turn, subVec(pose.eye, pose.look))), up: rotateVec(turn, pose.up) };
      break;
    }
    case 'roll':
      moved = { ...pose, up: rotateVec(quatFromAxisAngle(forward, MoveAngle(move, t, context.shotDuration) * DEGREES), pose.up) };
      break;
    case 'spin': {
      const turn = quatFromAxisAngle(ResolveAxis(move.axis, up, context), MoveAngle(move, t, context.shotDuration) * DEGREES);
      moved = { ...pose, look: addVec(pose.eye, rotateVec(turn, subVec(pose.look, pose.eye))), up: rotateVec(turn, pose.up) };
      break;
    }
    case 'path':
      moved = PathPose(pose, move, p() * MoveDuration(move, context.shotDuration), context);
      break;
    case 'shake':
      moved = Shake(pose, move, t, context.seed);
      break;
    case 'track':
      // Look-at lag: the rig's smoothing reads it (TrackLag).
      break;
  }
  return moved;
}

/**
 * A move's axis in world space.
 */
function ResolveAxis(axis: CameraMoveAxis, viewUp: SceneVector, context: MoveContext): SceneVector {
  let resolved: SceneVector;
  if (axis === 'up') resolved = [...WORLD_UP];
  else if (axis === 'subject-up') resolved = context.subject ? context.subject.up : [...WORLD_UP];
  else if (axis === 'view-up') resolved = viewUp;
  else resolved = normalizeVec(axis) ?? [...WORLD_UP];
  return resolved;
}

/**
 * The look-at lag the track moves running at `t` ask for, seconds; 0 for none.
 */
export function TrackLag(moves: readonly CameraMove[], t: number): number {
  let lag = 0;
  for (const move of moves) {
    const at = move.at ?? 0;
    if (move.type === 'track' && t >= at && t <= at + (move.duration ?? Infinity)) lag = Math.max(lag, move.lag);
  }
  return lag;
}

type PathMove = Extract<CameraMove, { type: 'path' }>;

/**
 * The eye on a path at `t` seconds into it: its waypoints resolved on the scene as drawn (a waypoint riding on a ship
 * moves with it), measured, and walked by arc length, passing each timed waypoint at its time. Waypoints whose hull is
 * gone drop out; with fewer than two left the pose holds.
 *
 * @param pose - The base pose.
 * @param move - The path.
 * @param t - Eased seconds into the path.
 * @param context - The subject (bare points in `frame: "subject"`, scaled by its radius with `units: "radii"`) and the
 *   scene.
 */
function PathPose(pose: CameraPose, move: PathMove, t: number, context: MoveContext): CameraPose {
  const scene = context.scene;
  const subject = context.subject;
  const frame = move.frame === 'subject' && subject ? { ...subject, scale: move.units === 'radii' ? subject.radius : 1 } : null;
  const waypoints: WaypointContext = { anchorOf: (ref) => (scene ? cinemaAnchor(scene, ref) : null), frame };
  const resolved = move.points.flatMap((waypoint) => {
    const point = resolveWaypoint(waypoint, waypoints);
    return point ? [{ point, time: waypointTime(waypoint) }] : [];
  });
  if (resolved.length < 2) return pose;
  const path = measureWaypointPath(resolved.map((entry) => entry.point));
  const distance = pathDistanceAt(
    path,
    resolved.map((entry) => entry.time),
    t,
    MoveDuration(move, context.shotDuration)
  );
  const eye = pathPointAt(path, distance);
  let look: SceneVector;
  if (move.look === 'path') look = addScaledVec(eye, pathTangentAt(path, distance) ?? poseForward(pose) ?? [0, 0, 1], Math.max(1, distanceVec(pose.eye, pose.look)));
  else if (move.look === 'subject') look = pose.look;
  else look = resolveWaypoint(move.look, waypoints) ?? pose.look;
  let up: SceneVector = pose.up;
  if (move.up === 'world') up = [...WORLD_UP];
  else if (typeof move.up === 'object') {
    const anchor = scene ? cinemaAnchor(scene, move.up) : null;
    if (anchor) up = headingAxes(anchor.rotation, true).up;
  }
  const forward = normalizeVec(subVec(look, eye)) ?? [0, 0, 1];
  return { ...pose, eye, look, up: orthogonalizeVec(up, forward) ?? orthogonalizeVec(WORLD_UP, forward) ?? [0, 1, 0] };
}

type ShakeMove = Extract<CameraMove, { type: 'shake' }>;

/**
 * The shake's strength at `t`: 0 before it starts and after its duration, decaying from 1 at its start.
 */
export function ShakeEnvelope(move: ShakeMove, t: number): number {
  const at = move.at ?? 0;
  const running = t - at;
  let envelope = 0;
  if (running >= 0 && running <= (move.duration ?? Infinity)) envelope = move.decay ? Math.exp(-running / move.decay) : 1;
  return envelope;
}

function Shake(pose: CameraPose, move: ShakeMove, t: number, seed: number): CameraPose {
  const strength = move.amplitude * ShakeEnvelope(move, t) * DEGREES;
  if (!(strength > 0)) return pose;
  const x = (t - (move.at ?? 0)) * move.frequency;
  const yaw = Noise(seed, 0, x) * strength;
  const pitch = Noise(seed, 1, x) * strength;
  const roll = Noise(seed, 2, x) * strength * 0.5;
  const forward = poseForward(pose) ?? [0, 0, 1];
  const up = orthogonalizeVec(pose.up, forward) ?? [0, 1, 0];
  const right = crossVec(forward, up);
  const distance = Math.max(1, lengthVec(subVec(pose.look, pose.eye)));
  // Small turns about the eye: yaw about up, pitch about right, roll about the view.
  let direction = rotateVec(quatFromAxisAngle(up, yaw), forward);
  direction = rotateVec(quatFromAxisAngle(right, pitch), direction);
  const turnedUp = rotateVec(quatFromAxisAngle(direction, roll), rotateVec(quatFromAxisAngle(right, pitch), up));
  return { ...pose, look: addScaledVec(pose.eye, direction, distance), up: turnedUp };
}

/**
 * Smooth value noise in [-1, 1]: hashed lattice values, eased between.
 *
 * @param seed - The shot's seed.
 * @param channel - Which stream.
 * @param x - The position (time × frequency).
 */
export function Noise(seed: number, channel: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const w = f * f * (3 - 2 * f);
  const a = Hash(seed, channel, i);
  const b = Hash(seed, channel, i + 1);
  return a + (b - a) * w;
}

function Hash(seed: number, channel: number, index: number): number {
  let h = (seed ^ Math.imul(channel + 1, 0x9e3779b1) ^ Math.imul(index | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

/**
 * A 32-bit FNV-1a hash of text: a shot's noise seed.
 */
export function SeedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * First-order lag toward a target over `seconds` of scene time.
 *
 * @param current - Where it is.
 * @param target - Where it is headed.
 * @param seconds - The time step (0 freezes it).
 * @param timeConstant - Seconds to cover about 63 % of the gap; 0 snaps.
 */
export function Smooth(current: SceneVector, target: SceneVector, seconds: number, timeConstant: number): SceneVector {
  if (!(timeConstant > 0)) return [...target];
  const keep = Math.exp(-Math.max(0, seconds) / timeConstant);
  return [target[0] + (current[0] - target[0]) * keep, target[1] + (current[1] - target[1]) * keep, target[2] + (current[2] - target[2]) * keep];
}
