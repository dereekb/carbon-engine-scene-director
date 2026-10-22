/**
 * The page camera following its target ship, and picking a ship under the pointer.
 *
 * - Following. Every frame the focus shifts by the target's drawn travel since the last frame (the ClientBall the
 *   renderer draws), so an orbit, pan or zoom made meanwhile is kept. Framing places the focus off the master ball,
 *   which runs about two ticks ahead of the drawn ship, so the first frame after framing a moving ship pulls the focus
 *   back onto the drawn hull.
 * - Modes (the document's camera.mode). `orbit` keeps the angles the user or the document set. `chase` swings the
 *   camera behind the ship's drawn heading, CHASE_PITCH above it; a drag looks around and eases back once released.
 * - Retargeting glides the focus from the old view onto the new ship.
 * - Picking casts the pointer's ray through the view and takes the nearest ship whose bounding sphere it passes
 *   through, with a few pixels of slack so a distant frigate can still be clicked. It reads the projection EveCamera
 *   draws with, not the document's fov: EveCamera's default zoom curve overrides the field of view every frame, and
 *   Carbon narrows the view above an aspect of 1.6.
 *
 * The angles are EveCamera's (degrees here): the eye sits at focus + distance × (sin yaw cos pitch, -sin pitch,
 * cos yaw cos pitch) and looks at the focus, so a negative pitch looks down from above.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneCameraMode } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';

const DEGREES = Math.PI / 180;

/**
 * Degrees the chase camera sits above the followed ship's heading (a negative pitch raises the eye).
 */
export const CHASE_PITCH = -12;

/**
 * Time constant, in seconds, of the chase camera swinging onto the ship's heading.
 */
export const CHASE_SWING_SECONDS = 0.3;

/**
 * Time constant, in seconds, of a look-around drag easing back behind the ship once released.
 */
export const CHASE_RETURN_SECONDS = 0.8;

/**
 * Seconds the focus takes to glide onto a new target.
 */
export const CAMERA_GLIDE_SECONDS = 0.6;

/**
 * Pixels of slack around a ship's bounding sphere when picking, so small or distant ships can be clicked.
 */
export const PICK_SLACK_PIXELS = 10;

/**
 * A vector following writes into (the orbit camera's focus).
 */
export interface MutableVector {
  [axis: number]: number;
}

/**
 * The orbit camera fields following drives (engine.ts's OrbitCamera), in degrees.
 */
export interface FollowedView {
  readonly focus: MutableVector;
  yaw: number;
  pitch: number;
}

/**
 * The followed ship as drawn this frame.
 */
export interface FollowedShip {
  readonly position: ArrayLike<number>;
  /**
   * Its drawn forward vector; null when unknown (chase then holds its angles).
   */
  readonly forward: Maybe<ArrayLike<number>>;
}

export interface CameraFollowTarget {
  readonly id: string;
  /**
   * Where the ship was when framing placed the focus.
   */
  readonly position: ArrayLike<number>;
}

export interface CameraAngles {
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * The chase camera's angles behind a heading.
 *
 * @param forward - The ship's forward vector, any length.
 * @returns The yaw and pitch, in degrees, that put the eye behind the ship and CHASE_PITCH above its heading; null for
 * a zero vector.
 */
export function ChaseAngles(forward: ArrayLike<number>): Maybe<CameraAngles> {
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  let angles: Maybe<CameraAngles> = null;
  if (length > 0) {
    const [x, y, z] = [forward[0] / length, forward[1] / length, forward[2] / length];
    // The eye sits along -forward: (sin yaw cos pitch, -sin pitch, cos yaw cos pitch) = -(x, y, z).
    angles = { yaw: Math.atan2(-x, -z) / DEGREES, pitch: Math.asin(Math.max(-1, Math.min(1, y))) / DEGREES + CHASE_PITCH };
  }
  return angles;
}

/**
 * Eases an angle toward another the short way round, as a first-order lag.
 *
 * @param from - Degrees.
 * @param to - Degrees.
 * @param seconds - The time step.
 * @param timeConstant - Seconds to cover about 63 % of the gap.
 * @returns The eased angle, in degrees (not wrapped).
 */
export function EaseAngle(from: number, to: number, seconds: number, timeConstant: number): number {
  const gap = ((((to - from) % 360) + 540) % 360) - 180;
  return from + gap * (1 - Math.exp(-seconds / timeConstant));
}

/**
 * The view a pick reads.
 */
export interface PickCamera {
  /**
   * EveCamera's view matrix, world to view, column-major.
   */
  readonly view: ArrayLike<number>;
  /**
   * EveCamera's projection matrix, column-major: indices 0 and 5 are the near plane's inverse half width and height.
   */
  readonly projection: ArrayLike<number>;
  /**
   * The view's size in CSS pixels.
   */
  readonly width: number;
  readonly height: number;
}

export interface PickSphere {
  readonly id: string;
  readonly centre: ArrayLike<number>;
  readonly radius: number;
}

/**
 * The ship under a point of the view: the nearest bounding sphere the pointer's ray enters, each widened to at least
 * PICK_SLACK_PIXELS at its distance.
 *
 * @param camera - The view.
 * @param x - The pointer, CSS pixels from the view's left edge.
 * @param y - The pointer, CSS pixels from the view's top edge.
 * @param spheres - The ships' bounding spheres, in world space.
 * @returns The id of the ship hit, or null.
 */
export function PickShip(camera: PickCamera, x: number, y: number, spheres: Iterable<PickSphere>): Maybe<string> {
  const { view, projection, width, height } = camera;
  // The view matrix rows are the camera's right, up and back axes in world space; its translation gives the eye.
  const right = [view[0], view[4], view[8]];
  const up = [view[1], view[5], view[9]];
  const back = [view[2], view[6], view[10]];
  const eye = [0, 1, 2].map((axis) => -(view[12] * right[axis] + view[13] * up[axis] + view[14] * back[axis]));
  // The view's half extents one metre ahead of the eye.
  const halfWidth = 1 / Math.abs(projection[0]);
  const halfHeight = 1 / Math.abs(projection[5]);
  const across = (2 * x) / width - 1;
  const down = 1 - (2 * y) / height;
  const ray = [0, 1, 2].map((axis) => -back[axis] + across * halfWidth * right[axis] + down * halfHeight * up[axis]);
  const length = Math.hypot(ray[0], ray[1], ray[2]);
  const metresPerPixelPerMetre = (2 * halfHeight) / height;
  let picked: Maybe<string> = null;
  let nearest = Infinity;
  for (const sphere of spheres) {
    const offset = [0, 1, 2].map((axis) => sphere.centre[axis] - eye[axis]);
    const along = (offset[0] * ray[0] + offset[1] * ray[1] + offset[2] * ray[2]) / length;
    const missSquared = offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2] - along * along;
    const radius = Math.max(sphere.radius, PICK_SLACK_PIXELS * metresPerPixelPerMetre * along);
    if (along > 0 && missSquared <= radius * radius) {
      const entry = along - Math.sqrt(radius * radius - missSquared);
      if (entry < nearest) {
        nearest = entry;
        picked = sphere.id;
      }
    }
  }
  return picked;
}

/**
 * Moves the orbit camera with its target ship every frame, in the document's camera mode.
 */
export class CameraFollow {
  /**
   * How the camera follows its target.
   */
  mode: SceneCameraMode = 'orbit';
  /**
   * True while the pointer drags the view: chase then holds the look-around offset instead of easing it back.
   */
  dragging = false;
  private target: Maybe<{ readonly id: string; readonly from: number[] }> = null;
  /**
   * The chase camera's eased aim, without the look-around offset.
   */
  private chase: Maybe<{ yaw: number; pitch: number }> = null;
  /**
   * The look-around offset a drag adds to the chase aim.
   */
  private readonly look = { yaw: 0, pitch: 0 };
  /**
   * The angles chase set last frame; the view differing from them means the user dragged it.
   */
  private chaseSet: Maybe<CameraAngles> = null;
  private glide: Maybe<{ readonly offset: number[]; readonly applied: number[]; readonly start: number }> = null;
  private last: Maybe<number> = null;

  /**
   * The ship being followed.
   */
  get following(): Maybe<string> {
    return this.target?.id ?? null;
  }

  /**
   * Follows a ship from where framing put the focus, or stops following.
   *
   * @param target - The ship and where it was when framing placed the focus; null to stop following.
   * @param glide - The old focus minus the new one, to glide in from; null to cut straight to it.
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  Follow(target: Maybe<CameraFollowTarget>, glide: Maybe<ArrayLike<number>>, now: number): void {
    if (target?.id !== this.target?.id) {
      this.chase = null;
      this.look.yaw = 0;
      this.look.pitch = 0;
    }
    this.target = target ? { id: target.id, from: Array.from(target.position) } : null;
    this.glide = target && glide ? { offset: Array.from(glide), applied: [0, 0, 0], start: now } : null;
    // Framing just set the view's angles: they are not a drag.
    this.chaseSet = null;
  }

  /**
   * Moves the view with the followed ship for the frame at `now`.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param view - The orbit camera.
   * @param sample - The followed ship as drawn at `now`, or null when it has no ball.
   */
  Frame(now: number, view: FollowedView, sample: (id: string) => Maybe<FollowedShip>): void {
    const last = this.last;
    const seconds = last == null ? 0 : Math.max(0, (now - last) / TICKS_PER_SECOND);
    this.last = now;
    const target = this.target;
    const ship = target ? sample(target.id) : null;
    if (target && ship) {
      for (let axis = 0; axis < 3; axis++) {
        view.focus[axis] += ship.position[axis] - target.from[axis];
        target.from[axis] = ship.position[axis];
      }
      this.Glide(now, view);
      const aim = this.mode === 'chase' && ship.forward ? ChaseAngles(ship.forward) : null;
      if (aim) {
        this.Chase(aim, seconds, view);
      } else {
        this.chase = null;
        this.chaseSet = null;
      }
    }
  }

  private Glide(now: number, view: FollowedView): void {
    const glide = this.glide;
    if (glide) {
      const progress = Math.min(1, (now - glide.start) / TICKS_PER_SECOND / CAMERA_GLIDE_SECONDS);
      // Ease out: the share of the offset still to cover.
      const left = (1 - progress) ** 3;
      for (let axis = 0; axis < 3; axis++) {
        const wanted = glide.offset[axis] * left;
        view.focus[axis] += wanted - glide.applied[axis];
        glide.applied[axis] = wanted;
      }
      if (progress >= 1) this.glide = null;
    }
  }

  private Chase(aim: CameraAngles, seconds: number, view: FollowedView): void {
    if (this.chaseSet) {
      this.look.yaw += view.yaw - this.chaseSet.yaw;
      this.look.pitch += view.pitch - this.chaseSet.pitch;
    }
    if (!this.dragging) {
      const keep = Math.exp(-seconds / CHASE_RETURN_SECONDS);
      this.look.yaw *= keep;
      this.look.pitch *= keep;
    }
    const chase = this.chase ?? { yaw: view.yaw - this.look.yaw, pitch: view.pitch - this.look.pitch };
    chase.yaw = EaseAngle(chase.yaw, aim.yaw, seconds, CHASE_SWING_SECONDS);
    chase.pitch += (aim.pitch - chase.pitch) * (1 - Math.exp(-seconds / CHASE_SWING_SECONDS));
    this.chase = chase;
    view.yaw = chase.yaw + this.look.yaw;
    view.pitch = Math.max(-89, Math.min(89, chase.pitch + this.look.pitch));
    this.chaseSet = { yaw: view.yaw, pitch: view.pitch };
  }
}
