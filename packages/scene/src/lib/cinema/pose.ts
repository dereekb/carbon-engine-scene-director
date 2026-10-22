/**
 * A camera pose: where the eye is, what it looks at, which way is up and the lens. The free camera draws one; blends,
 * the orbit takeover and the view matrix all start from it.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import { addScaledVec, crossVec, distanceVec, dotVec, lerpVec, normalizeVec, orthogonalizeVec, quatAxes, quatFromAxisAngle, quatLookRotation, rotateVec, slerpQuat, subVec, WORLD_UP } from './vectors';

const DEGREES = Math.PI / 180;

/**
 * The orbit camera's pitch limit, degrees (engine.ts OrbitCamera.Set).
 */
export const ORBIT_PITCH_LIMIT = 89;

export interface CameraPose {
  readonly eye: SceneVector;
  readonly look: SceneVector;
  /**
   * Need not be unit length or perpendicular to the view; the view orthogonalizes it.
   */
  readonly up: SceneVector;
  /**
   * Vertical field of view, degrees, before Carbon's aspect clamp.
   */
  readonly fov: number;
}

/**
 * EveCamera's orbit, in degrees: the eye sits at focus + distance × (sin yaw cos pitch, -sin pitch, cos yaw cos pitch).
 */
export interface OrbitView {
  readonly focus: SceneVector;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * The view direction, eye to look; null when they coincide.
 */
export function poseForward(pose: CameraPose): Maybe<SceneVector> {
  return normalizeVec(subVec(pose.look, pose.eye));
}

/**
 * Blends two poses: the look point and the lens lerp, the eye swings round the blended look point (its offset's
 * direction slerps and its length lerps), and the roll follows the slerped orientation. Blending between two
 * hardpoints on one subject so keeps the subject in frame instead of cutting through it.
 *
 * @param a - The pose at weight 0.
 * @param b - The pose at weight 1.
 * @param weight - 0..1 (not clamped).
 */
export function blendPoses(a: CameraPose, b: CameraPose, weight: number): CameraPose {
  const look = lerpVec(a.look, b.look, weight);
  const offsetA = subVec(a.eye, a.look);
  const offsetB = subVec(b.eye, b.look);
  const lengthA = Math.hypot(...offsetA);
  const lengthB = Math.hypot(...offsetB);
  const rotationA = quatLookRotation(subVec(a.look, a.eye), a.up);
  const rotationB = quatLookRotation(subVec(b.look, b.eye), b.up);
  const rotation = slerpQuat(rotationA, rotationB, weight);
  const axes = quatAxes(rotation);
  let eye: SceneVector;
  if (lengthA > 1e-9 && lengthB > 1e-9) {
    // The offsets are minus each pose's forward times its length, so the slerped forward carries the swing.
    eye = addScaledVec(look, axes.forward, -(lengthA + (lengthB - lengthA) * weight));
  } else {
    eye = lerpVec(a.eye, b.eye, weight);
  }
  const forward = normalizeVec(subVec(look, eye)) ?? axes.forward;
  const up = orthogonalizeVec(axes.up, forward) ?? axes.up;
  return { eye, look, up, fov: blendFov(a.fov, b.fov, weight) };
}

/**
 * Lerps two fields of view in tan(fov / 2), so a zoom reads as even.
 *
 * @param a - Degrees.
 * @param b - Degrees.
 * @param weight - 0..1.
 * @returns Degrees.
 */
export function blendFov(a: number, b: number, weight: number): number {
  const ta = Math.tan((a * DEGREES) / 2);
  const tb = Math.tan((b * DEGREES) / 2);
  return (2 * Math.atan(ta + (tb - ta) * weight)) / DEGREES;
}

/**
 * The pose's roll, degrees: its up against the level up (world up square to the view), signed about the view
 * direction; 0 when looking straight up or down.
 */
export function poseRoll(pose: CameraPose): number {
  const forward = poseForward(pose);
  const level = forward ? orthogonalizeVec(WORLD_UP, forward) : null;
  const up = forward ? orthogonalizeVec(pose.up, forward) : null;
  return forward && level && up ? Math.atan2(dotVec(crossVec(level, up), forward), dotVec(level, up)) / DEGREES : 0;
}

/**
 * The pose turned by `degrees` about its view direction.
 */
export function rollPose(pose: CameraPose, degrees: number): CameraPose {
  const forward = poseForward(pose);
  return forward ? { ...pose, up: rotateVec(quatFromAxisAngle(forward, degrees * DEGREES), pose.up) } : pose;
}

/**
 * The orbit view that puts the eye where the pose has it, looking at the pose's look point (the roll is dropped).
 * The pitch is clamped to the orbit camera's ±89°.
 */
export function toOrbitView(pose: CameraPose): OrbitView {
  const offset = subVec(pose.eye, pose.look);
  const distance = Math.max(1, Math.hypot(...offset));
  const direction = normalizeVec(offset) ?? [0, 0, 1];
  const pitch = Math.max(-ORBIT_PITCH_LIMIT, Math.min(ORBIT_PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, -direction[1]))) / DEGREES));
  const yaw = Math.atan2(direction[0], direction[2]) / DEGREES;
  return { focus: [...pose.look], distance, yaw, pitch };
}

/**
 * The pose of an orbit view, level (world up).
 */
export function fromOrbitView(view: OrbitView, fov: number): CameraPose {
  const yaw = view.yaw * DEGREES;
  const pitch = view.pitch * DEGREES;
  const direction: SceneVector = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  return { eye: addScaledVec(view.focus, direction, view.distance), look: [...view.focus], up: [...WORLD_UP], fov };
}

/**
 * The view matrix of a pose, world to view, column-major, as gl-matrix's lookAt builds it (rows 0-2 of the rotation are
 * the camera's right, up and back axes).
 */
export function poseViewMatrix(pose: CameraPose): number[] {
  const back = normalizeVec(subVec(pose.eye, pose.look)) ?? [0, 0, 1];
  const right = normalizeVec(crossVec(pose.up, back)) ?? normalizeVec(crossVec(WORLD_UP, back)) ?? [1, 0, 0];
  const up = crossVec(back, right);
  const { eye } = pose;
  return [right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0, -dotVec(right, eye), -dotVec(up, eye), -dotVec(back, eye), 1];
}

/**
 * Reads a pose back off a view matrix.
 *
 * @param view - World to view, column-major.
 * @param lookDistance - Metres ahead of the eye to put the look point.
 * @param fov - Degrees.
 */
export function poseFromViewMatrix(view: ArrayLike<number>, lookDistance: number, fov: number): CameraPose {
  const right: SceneVector = [view[0], view[4], view[8]];
  const up: SceneVector = [view[1], view[5], view[9]];
  const back: SceneVector = [view[2], view[6], view[10]];
  const eye: SceneVector = [0, 1, 2].map((axis) => -(right[axis] * view[12] + up[axis] * view[13] + back[axis] * view[14])) as SceneVector;
  return { eye, look: addScaledVec(eye, back, -Math.max(1e-3, lookDistance)), up, fov };
}

/**
 * Metres from the eye to the look point.
 */
export function poseDistance(pose: CameraPose): number {
  return distanceVec(pose.eye, pose.look);
}
