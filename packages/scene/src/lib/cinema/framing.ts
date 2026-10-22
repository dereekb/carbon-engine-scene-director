/**
 * Framing math for the cinematic camera: Carbon's view extents, how far to stand to fit a sphere, keeping the eye
 * out of every hull, and clip planes that hold at close range.
 */

import type { SceneVector } from '../scene';
import { addScaledVec, distanceVec, lengthVec, normalizeVec, subVec } from './vectors';

const DEGREES = Math.PI / 180;

/**
 * Above this aspect Carbon shrinks both half extents by aspect / 1.6 (EveCamera.CalculateProjectionMatrix), so a
 * wide window keeps the 1.6 width and loses height.
 */
export const CARBON_ASPECT_CLAMP = 1.6;

/**
 * How far out of a hull's bounding sphere the eye is kept, as a multiple of its radius.
 */
export const HULL_CLEARANCE = 1.15;

/**
 * The near plane's floor and ceiling, metres.
 */
export const MIN_NEAR_CLIP = 0.05;
export const MAX_NEAR_CLIP = 1000;

/**
 * The near plane while the eye is inside a hull's bounding sphere (a pass over a long hull), where the sphere says
 * nothing about how close the mesh is: the orbit camera's smallest front clip.
 */
export const INSIDE_NEAR_CLIP = 0.5;

/**
 * The far plane's floor, metres (the orbit camera's).
 */
export const MIN_FAR_CLIP = 1e5;

/**
 * The widest far / near ratio: the orbit camera's (its front clip is distance × 0.0005, its back clip distance × 1000).
 */
export const MAX_CLIP_RATIO = 2e6;

export interface ViewHalfExtents {
  /**
   * Half the view's width one metre ahead of the eye.
   */
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * The view's half extents one metre ahead of the eye, with Carbon's aspect clamp.
 *
 * @param fov - Vertical field of view, degrees, before the clamp.
 * @param aspect - Width / height.
 */
export function viewHalfExtents(fov: number, aspect: number): ViewHalfExtents {
  let halfHeight = Math.tan((fov * DEGREES) / 2);
  let halfWidth = aspect * halfHeight;
  if (aspect > CARBON_ASPECT_CLAMP) {
    const adjustment = aspect / CARBON_ASPECT_CLAMP;
    halfWidth /= adjustment;
    halfHeight /= adjustment;
  }
  return { halfWidth, halfHeight };
}

/**
 * Metres from a sphere's centre that make it span `fill` of the view's smaller half extent.
 *
 * @param radius - The sphere's radius, metres.
 * @param fov - Degrees.
 * @param aspect - Width / height.
 * @param fill - 1 just fits the sphere; 0.5 leaves it half the frame.
 */
export function fitDistance(radius: number, fov: number, aspect: number, fill = 1): number {
  const { halfWidth, halfHeight } = viewHalfExtents(fov, aspect);
  const half = Math.atan(Math.min(halfWidth, halfHeight) * Math.max(0.01, fill));
  return Math.max(radius, 1) / Math.sin(half);
}

export interface CinemaSphere {
  readonly centre: SceneVector;
  readonly radius: number;
}

/**
 * Pushes the eye out of every sphere it is inside of (times the clearance), straight out from the centre.
 *
 * @param eye - The wanted eye.
 * @param spheres - The hulls.
 * @param clearance - A multiple of each radius.
 * @returns The eye, moved or not.
 */
export function clearHulls(eye: SceneVector, spheres: readonly CinemaSphere[], clearance = HULL_CLEARANCE): SceneVector {
  let result = eye;
  // A couple of passes settle overlapping hulls.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const sphere of spheres) {
      const keep = sphere.radius * clearance;
      const offset = subVec(result, sphere.centre);
      const distance = lengthVec(offset);
      if (distance < keep) {
        result = addScaledVec(sphere.centre, normalizeVec(offset) ?? [0, 1, 0], keep);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return result;
}

export interface CameraClipsInput {
  readonly eye: SceneVector;
  readonly spheres: readonly CinemaSphere[];
  /**
   * Metres from the origin the far plane must reach (the dressing, the objects); 0 for none.
   */
  readonly reach?: number;
}

export interface CameraClips {
  readonly near: number;
  readonly far: number;
}

/**
 * Clip planes for a free camera: the near plane at half the nearest hull's surface (so a close shot never cuts the
 * hull; INSIDE_NEAR_CLIP inside a bounding sphere), the far plane past the farthest hull and the reach, and the ratio
 * no wider than the orbit camera's.
 */
export function cameraClips({ eye, spheres, reach = 0 }: CameraClipsInput): CameraClips {
  let nearest = Infinity;
  let farthest = 0;
  for (const sphere of spheres) {
    const distance = distanceVec(eye, sphere.centre);
    nearest = Math.min(nearest, distance >= sphere.radius ? distance - sphere.radius : INSIDE_NEAR_CLIP * 2);
    farthest = Math.max(farthest, distance + sphere.radius);
  }
  const far = Math.max(MIN_FAR_CLIP, farthest * 1.1, reach > 0 ? (reach + lengthVec(eye)) * 1.1 : 0);
  const near = Math.max(far / MAX_CLIP_RATIO, Math.min(MAX_NEAR_CLIP, Math.max(MIN_NEAR_CLIP, Number.isFinite(nearest) ? nearest * 0.5 : MAX_NEAR_CLIP)));
  return { near, far };
}
