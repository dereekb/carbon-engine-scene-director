/**
 * Float64 vector and quaternion helpers for the cinematic camera. The renderer's gl-matrix types are float32, which
 * wobbles by metres a few thousand kilometres out; the camera math stays in plain number tuples.
 *
 * Quaternions are `[x, y, z, w]`. The frame convention is the ships': local +Z is forward, +Y is up, and +X is
 * up × forward (port for a ship; the camera's left). Starboard is forward × up.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';

export type CinemaQuaternion = [number, number, number, number];

/**
 * World up.
 */
export const WORLD_UP: Readonly<SceneVector> = [0, 1, 0];

export const IDENTITY_QUATERNION: Readonly<CinemaQuaternion> = [0, 0, 0, 1];

export function addVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>): SceneVector {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>): SceneVector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec(a: Readonly<SceneVector>, scale: number): SceneVector {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

/**
 * a + b × scale.
 */
export function addScaledVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>, scale: number): SceneVector {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

export function dotVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>): SceneVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function lengthVec(a: Readonly<SceneVector>): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distanceVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The unit vector along a, or null for a zero (or non-finite) vector.
 */
export function normalizeVec(a: Readonly<SceneVector>): Maybe<SceneVector> {
  const length = lengthVec(a);
  return length > 1e-12 && Number.isFinite(length) ? [a[0] / length, a[1] / length, a[2] / length] : null;
}

export function lerpVec(a: Readonly<SceneVector>, b: Readonly<SceneVector>, weight: number): SceneVector {
  return [a[0] + (b[0] - a[0]) * weight, a[1] + (b[1] - a[1]) * weight, a[2] + (b[2] - a[2]) * weight];
}

/**
 * The component of a perpendicular to the unit vector axis, normalized; null when a is (nearly) parallel to it.
 */
export function orthogonalizeVec(a: Readonly<SceneVector>, axis: Readonly<SceneVector>): Maybe<SceneVector> {
  const along = dotVec(a, axis);
  const rest = addScaledVec(a, axis, -along);
  return lengthVec(rest) > 1e-6 * Math.max(1, lengthVec(a)) ? normalizeVec(rest) : null;
}

export function multiplyQuat(a: Readonly<CinemaQuaternion>, b: Readonly<CinemaQuaternion>): CinemaQuaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function normalizeQuat(q: Readonly<CinemaQuaternion>): CinemaQuaternion {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length > 1e-12 ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [0, 0, 0, 1];
}

/**
 * Turns a vector by a unit quaternion.
 */
export function rotateVec(q: Readonly<CinemaQuaternion>, v: Readonly<SceneVector>): SceneVector {
  const [x, y, z, w] = q;
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * A rotation of `angle` radians about an axis (right-handed: counter-clockwise looking down the axis).
 *
 * @param axis - Any length; a zero axis gives the identity.
 * @param angle - Radians.
 */
export function quatFromAxisAngle(axis: Readonly<SceneVector>, angle: number): CinemaQuaternion {
  const unit = normalizeVec(axis);
  if (!unit) return [0, 0, 0, 1];
  const half = angle / 2;
  const s = Math.sin(half);
  return [unit[0] * s, unit[1] * s, unit[2] * s, Math.cos(half)];
}

/**
 * Spherical interpolation the short way round.
 */
export function slerpQuat(a: Readonly<CinemaQuaternion>, b: Readonly<CinemaQuaternion>, weight: number): CinemaQuaternion {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (cos > 0.9995) {
    wa = 1 - weight;
    wb = weight;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - weight) * angle) / sin;
    wb = Math.sin(weight * angle) / sin;
  }
  return normalizeQuat([a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]);
}

/**
 * The rotation taking local +Z to `forward` and local +Y to `up` (orthogonalized against forward).
 *
 * @param forward - Any length.
 * @param up - Any length; when parallel to forward, a perpendicular is picked.
 */
export function quatLookRotation(forward: Readonly<SceneVector>, up: Readonly<SceneVector>): CinemaQuaternion {
  const z = normalizeVec(forward) ?? [0, 0, 1];
  const y = orthogonalizeVec(up, z) ?? orthogonalizeVec(WORLD_UP, z) ?? orthogonalizeVec([0, 0, 1], z) ?? [1, 0, 0];
  const x = crossVec(y, z);
  // From the rotation matrix with columns x, y, z.
  const [m00, m01, m02] = [x[0], y[0], z[0]];
  const [m10, m11, m12] = [x[1], y[1], z[1]];
  const [m20, m21, m22] = [x[2], y[2], z[2]];
  const trace = m00 + m11 + m22;
  let q: CinemaQuaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return normalizeQuat(q);
}

export interface FrameAxes {
  readonly forward: SceneVector;
  readonly up: SceneVector;
  /**
   * forward × up.
   */
  readonly starboard: SceneVector;
}

/**
 * The forward, up and starboard axes of a rotation.
 */
export function quatAxes(q: Readonly<CinemaQuaternion>): FrameAxes {
  const forward = rotateVec(q, [0, 0, 1]);
  const up = rotateVec(q, [0, 1, 0]);
  return { forward, up, starboard: crossVec(forward, up) };
}

/**
 * Below this |forward · up| a heading counts as level enough to square against world up.
 */
const NEAR_VERTICAL = 0.98;

/**
 * The axes of a hull's heading: level (its forward squared against world up; its own up when it points near
 * vertical) or banked (its own axes, rolling with it).
 *
 * @param rotation - The hull's rotation, [x, y, z, w].
 * @param bank - True for the banked axes.
 */
export function headingAxes(rotation: Readonly<CinemaQuaternion>, bank = false): FrameAxes {
  const axes = quatAxes(rotation);
  const forward = normalizeVec(axes.forward) ?? [0, 0, 1];
  let up: SceneVector;
  if (bank || Math.abs(dotVec(forward, WORLD_UP)) > NEAR_VERTICAL) up = orthogonalizeVec(axes.up, forward) ?? [0, 1, 0];
  else up = orthogonalizeVec(WORLD_UP, forward) ?? [0, 1, 0];
  return { forward, up, starboard: crossVec(forward, up) };
}

/**
 * A point given in a frame's [forward, starboard, up] axes, off its origin.
 */
export function fromFrame(origin: Readonly<SceneVector>, axes: FrameAxes, components: Readonly<SceneVector>): SceneVector {
  return addScaledVec(addScaledVec(addScaledVec(origin, axes.forward, components[0]), axes.starboard, components[1]), axes.up, components[2]);
}

/**
 * Reads a vector off anything array-like (a Float32Array sample, a tuple).
 */
export function toVec(value: ArrayLike<number>): SceneVector {
  return [value[0], value[1], value[2]];
}
