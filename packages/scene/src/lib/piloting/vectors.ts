import type { SceneVector } from '../scene';

/**
 * Small vector helpers for the piloting math: scene vectors in, scene vectors out.
 */

export const ZERO_VECTOR: SceneVector = [0, 0, 0];

export function addVectors(a: SceneVector, b: SceneVector): SceneVector {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subtractVectors(a: SceneVector, b: SceneVector): SceneVector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVector(a: SceneVector, scale: number): SceneVector {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

export function dotVectors(a: SceneVector, b: SceneVector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVectors(a: SceneVector, b: SceneVector): SceneVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vectorLength(a: SceneVector): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * The unit vector along `a`.
 *
 * @param a - The vector.
 * @param fallback - Returned for a zero vector.
 * @returns The unit vector, or the fallback.
 */
export function unitVector(a: SceneVector, fallback: SceneVector = [0, 0, 1]): SceneVector {
  const length = vectorLength(a);
  return length > 0 ? scaleVector(a, 1 / length) : fallback;
}

/**
 * The angle between two vectors.
 *
 * @param a - One vector.
 * @param b - The other.
 * @returns Degrees, 0 to 180; 0 when either is zero.
 */
export function angleBetween(a: SceneVector, b: SceneVector): number {
  const lengths = vectorLength(a) * vectorLength(b);
  return lengths > 0 ? (Math.acos(Math.max(-1, Math.min(1, dotVectors(a, b) / lengths))) * 180) / Math.PI : 0;
}

/**
 * A unit vector perpendicular to `a`, in the plane of `a` and `hint` when they are not parallel.
 *
 * @param a - The vector.
 * @param hint - The side to lean to (the component of `hint` across `a`).
 * @returns The unit perpendicular.
 */
export function perpendicularTo(a: SceneVector, hint: SceneVector): SceneVector {
  const unit = unitVector(a);
  let across = subtractVectors(hint, scaleVector(unit, dotVectors(hint, unit)));
  if (vectorLength(across) < 1e-9 * Math.max(1, vectorLength(hint))) {
    const axis: SceneVector = Math.abs(unit[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    across = crossVectors(unit, axis);
  }
  return unitVector(across);
}

/**
 * Turns unit vector `a` toward unit vector `b` by an angle, in their plane.
 *
 * @param a - The vector to turn (unit).
 * @param b - The vector to turn toward (unit, not parallel to `a`; a perpendicular is used when it is).
 * @param degrees - How far.
 * @returns The turned unit vector.
 */
export function rotateToward(a: SceneVector, b: SceneVector, degrees: number): SceneVector {
  const across = perpendicularTo(a, b);
  const radians = (degrees * Math.PI) / 180;
  return unitVector(addVectors(scaleVector(a, Math.cos(radians)), scaleVector(across, Math.sin(radians))));
}
