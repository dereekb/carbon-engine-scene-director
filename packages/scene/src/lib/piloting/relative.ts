import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import { angleBetween, crossVectors, dotVectors, scaleVector, subtractVectors, vectorLength } from './vectors';

/**
 * EVE's overview columns between two ships: distance, radial and transversal velocity, angular velocity, bearing and
 * aspect. Everything is measured from `self`, on origin-relative metres and m/s.
 */

/**
 * A ship as the piloting math sees its motion.
 */
export interface PilotBody {
  /**
   * Its centre, origin-relative metres.
   */
  readonly position: SceneVector;
  /**
   * m/s.
   */
  readonly velocity: SceneVector;
  readonly radius: number;
  /**
   * Where its nose points (a unit vector); its velocity stands in when unset.
   */
  readonly heading?: Maybe<SceneVector>;
}

export interface RelativeMotion {
  /**
   * Surface to surface, never below 0.
   */
  readonly distance: number;
  readonly centreDistance: number;
  /**
   * m/s along the line of sight, positive while the gap opens.
   */
  readonly radialVelocity: number;
  /**
   * m/s the gap closes at (−radialVelocity).
   */
  readonly closingVelocity: number;
  /**
   * m/s across the line of sight.
   */
  readonly transversal: number;
  /**
   * rad/s: transversal over the centre distance (what turret tracking reads).
   */
  readonly angular: number;
  /**
   * Degrees between self's nose and the other ship (0 dead ahead, 180 behind); 0 when self has no heading.
   */
  readonly bearing: number;
  /**
   * Degrees between the other ship's nose and self (0: it points at self); 0 when it has no heading.
   */
  readonly aspect: number;
}

/**
 * The overview columns of `other` seen from `self`.
 *
 * @param self - The ship measuring.
 * @param other - The ship measured.
 * @returns Distance, radial and transversal velocity, angular velocity, bearing and aspect.
 */
export function relativeMotionOf(self: PilotBody, other: PilotBody): RelativeMotion {
  const offset = subtractVectors(other.position, self.position);
  const centreDistance = vectorLength(offset);
  const relativeVelocity = subtractVectors(other.velocity, self.velocity);
  let radialVelocity = 0;
  let transversal = vectorLength(relativeVelocity);
  if (centreDistance > 0) {
    const lineOfSight = scaleVector(offset, 1 / centreDistance);
    radialVelocity = dotVectors(relativeVelocity, lineOfSight);
    transversal = vectorLength(crossVectors(relativeVelocity, lineOfSight));
  }
  const selfHeading = self.heading ?? self.velocity;
  const otherHeading = other.heading ?? other.velocity;
  return {
    distance: Math.max(0, centreDistance - self.radius - other.radius),
    centreDistance,
    radialVelocity,
    closingVelocity: -radialVelocity,
    transversal,
    angular: centreDistance > 0 ? transversal / centreDistance : 0,
    bearing: angleBetween(selfHeading, offset),
    aspect: angleBetween(otherHeading, scaleVector(offset, -1))
  };
}

/**
 * The surface distance between two bodies.
 *
 * @param a - One body.
 * @param b - The other.
 * @returns Metres, never below 0.
 */
export function surfaceDistanceOf(a: Pick<PilotBody, 'position' | 'radius'>, b: Pick<PilotBody, 'position' | 'radius'>): number {
  return Math.max(0, vectorLength(subtractVectors(a.position, b.position)) - a.radius - b.radius);
}
