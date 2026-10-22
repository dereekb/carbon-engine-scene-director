/**
 * Follow the FC's steering math, runtime-free (it imports only runtime-sim): the fleet's heading frame, the lead that
 * cancels Destiny's goto lag, and each member's goto point on its formation slot. DestinyWorld.Steer flies it.
 *
 * Positions stay in plain float64 arrays: a slot 30 km out must not lose metres to Float32Array rounding.
 */

import { quat, type Quat } from './runtime-sim';

/**
 * m/s: below this an anchor counts as at rest, and a member slow enough to settle.
 */
export const SETTLE_SPEED = 1;

/**
 * A settled member stays settled until its slot drifts past this multiple of its follow tolerance (or its anchor
 * moves), so it does not flicker between settling and steering at the tolerance's edge.
 */
export const SETTLE_HOLD = 1.5;

export type SteeringVector = [number, number, number];

/**
 * The fleet's heading frame: Destiny's legacy heading of the FC, without its banking roll.
 *
 * @param yaw - The FC's legacy yaw, radians (atan2(x, z)).
 * @param pitch - The FC's legacy pitch, radians (-asin(y / r)).
 * @returns The frame: x right, y up, z forward.
 */
export function FleetFrame(yaw: number, pitch: number): Quat {
  return quat.fromYawPitchRoll(quat.create(), yaw, pitch, 0);
}

/**
 * Rotates a vector by a quaternion, in float64.
 *
 * @param rotation - The quaternion, [x, y, z, w].
 * @param vector - The vector.
 * @returns A new rotated vector.
 */
export function RotateVector(rotation: ArrayLike<number>, vector: ArrayLike<number>): SteeringVector {
  const [qx, qy, qz, qw] = [rotation[0], rotation[1], rotation[2], rotation[3]];
  const [vx, vy, vz] = [vector[0], vector[1], vector[2]];
  // t = 2 q × v; v' = v + w t + q × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/**
 * The heading frame of a warp from `from` to `to`: Destiny's legacy heading facing the landing (yaw atan2(x, z), pitch
 * -asin(y / r)), without roll; the leader faces it in warp and after landing, so it frames the landed formation.
 * A zero vector gives yaw 0, pitch 0.
 *
 * @param from - Where the warp begins.
 * @param to - The landing.
 * @returns FleetFrame of that heading.
 */
export function WarpFrame(from: ArrayLike<number>, to: ArrayLike<number>): Quat {
  const [x, y, z] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const r = Math.hypot(x, y, z);
  return r > 0 ? FleetFrame(Math.atan2(x, z), -Math.asin(Math.max(-1, Math.min(1, y / r)))) : FleetFrame(0, 0);
}

export interface FramePointInput {
  readonly origin: ArrayLike<number>;
  /**
   * A heading frame (FleetFrame / WarpFrame).
   */
  readonly frame: ArrayLike<number>;
  /**
   * Metres in the frame: x right, y up, z forward.
   */
  readonly offset: ArrayLike<number>;
}

/**
 * The point `offset` from `origin` in `frame`, in float64.
 *
 * @param input - The origin, the frame and the offset.
 * @returns origin + RotateVector(frame, offset).
 */
export function FramePoint(input: FramePointInput): SteeringVector {
  const { origin, frame, offset } = input;
  const rotated = RotateVector(frame, offset);
  return [origin[0] + rotated[0], origin[1] + rotated[1], origin[2] + rotated[2]];
}

/**
 * The forward vector of a legacy heading.
 *
 * @param yaw - Radians, atan2(x, z).
 * @param pitch - Radians, -asin(y / r).
 * @returns The unit vector the heading faces.
 */
export function HeadingForward(yaw: number, pitch: number): SteeringVector {
  return [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

export interface LeadDistanceInput {
  /**
   * m/s.
   */
  readonly anchorSpeed: number;
  /**
   * The member's max velocity, m/s.
   */
  readonly maxVelocity: number;
  /**
   * The member's speed fraction, (0, 1].
   */
  readonly speed: number;
  /**
   * The Destiny tick, seconds.
   */
  readonly tickSeconds: number;
}

/**
 * How far ahead of its slot (along the anchor's velocity) a member aims. Destiny's GotoThrust eases off as (d / D)^4
 * within one tick's travel D of the goto point, so a ship chasing a point moving at u settles D · (u / V)^(1/4)
 * behind it; aiming that far ahead puts it on the point. A member slower than its anchor gets the full D and trails at
 * its own max velocity.
 *
 * @param input - The anchor's speed, the member's max velocity and speed fraction, and the tick length.
 * @returns Metres; 0 when the anchor is at rest or the member cannot move.
 */
export function LeadDistance(input: LeadDistanceInput): number {
  const { anchorSpeed, maxVelocity, speed, tickSeconds } = input;
  const velocity = maxVelocity * speed;
  let lead = 0;
  if (velocity > 0 && anchorSpeed >= 1e-3 && Number.isFinite(velocity) && Number.isFinite(anchorSpeed)) lead = velocity * tickSeconds * Math.min(1, anchorSpeed / velocity) ** 0.25;
  return lead;
}

export interface SteeringBall {
  readonly position: ArrayLike<number>;
  readonly velocity: ArrayLike<number>;
  /**
   * Metres: the ball's EVE radius.
   */
  readonly radius: number;
}

export interface SteeringMember extends SteeringBall {
  /**
   * m/s.
   */
  readonly maxVelocity: number;
  /**
   * Speed fraction, (0, 1].
   */
  readonly speed: number;
}

export interface FormationGotoInput {
  readonly anchor: SteeringBall;
  readonly member: SteeringMember;
  /**
   * The fleet heading frame (FleetFrame).
   */
  readonly frame: ArrayLike<number>;
  /**
   * The slot's unit direction from the anchor in the frame.
   */
  readonly direction: ArrayLike<number>;
  /**
   * The slot's range, metres surface to surface.
   */
  readonly slotRange: number;
  /**
   * The Destiny tick, seconds.
   */
  readonly tickSeconds: number;
}

export interface FormationGoto {
  /**
   * The slot point: the anchor's position plus the rotated direction times the slot's centre distance.
   */
  readonly point: SteeringVector;
  /**
   * Where the member aims: the slot point plus the lead along the anchor's velocity.
   */
  readonly goto: SteeringVector;
  /**
   * Metres from the member to its slot point.
   */
  readonly error: number;
  /**
   * m/s.
   */
  readonly anchorSpeed: number;
  /**
   * The member's speed, m/s.
   */
  readonly memberSpeed: number;
  /**
   * The fleet's forward vector (the frame's +Z).
   */
  readonly forward: SteeringVector;
}

/**
 * A member's goto point on its formation slot. Every output is finite for finite input, zero velocities and
 * coincident positions included.
 *
 * @param input - The anchor, the member, the frame, the slot and the tick length.
 * @returns The slot point, the goto point, the slot error, both speeds and the fleet's forward vector.
 */
export function FormationGoto(input: FormationGotoInput): FormationGoto {
  const { anchor, member, frame, direction, slotRange, tickSeconds } = input;
  const reach = slotRange + anchor.radius + member.radius;
  const offset = RotateVector(frame, direction);
  const point: SteeringVector = [0, 1, 2].map((axis) => anchor.position[axis] + offset[axis] * reach) as SteeringVector;
  const anchorSpeed = Math.hypot(anchor.velocity[0], anchor.velocity[1], anchor.velocity[2]);
  const lead = LeadDistance({ anchorSpeed, maxVelocity: member.maxVelocity, speed: member.speed, tickSeconds });
  const goto: SteeringVector = lead > 0 ? (point.map((value, axis) => value + (anchor.velocity[axis] / anchorSpeed) * lead) as SteeringVector) : [...point];
  return {
    point,
    goto,
    error: Math.hypot(member.position[0] - point[0], member.position[1] - point[1], member.position[2] - point[2]),
    anchorSpeed,
    memberSpeed: Math.hypot(member.velocity[0], member.velocity[1], member.velocity[2]),
    forward: RotateVector(frame, [0, 0, 1])
  };
}
