import type { Maybe } from '@dereekb/util';
import type { ShipOrder } from '../orders';
import type { SceneVector } from '../scene';
import { appliedDpsOf, maxWeaponReachOf } from './application';
import { liveFlightOf, type PilotContact } from './envelope';
import { orbitOrderFor } from './orbit';
import { type PilotBody, surfaceDistanceOf } from './relative';
import { addVectors, angleBetween, crossVectors, dotVectors, rotateToward, scaleVector, subtractVectors, unitVector, vectorLength } from './vectors';

/**
 * The maneuvers a pilot flies around its ideal: kite away at an angle, spiral in, burn out of reach, hold a support
 * point, and band orders on a lever's ship. Each returns plain directions, points or orders; stepShipPilot decides
 * which one flies.
 */

/**
 * A kiter backing off flies this far off the line straight away from its focus (keeps transversal: never burn
 * directly away from turret boats).
 */
export const KITE_AWAY_DEGREES = 40;

/**
 * A ship closing under its focus's guns aims this far off the line straight at it (half way to the perpendicular).
 */
export const SPIRAL_DEGREES = 45;

/**
 * A wanted direction is given again once it turns more than this from the ship's direction order.
 */
export const REAIM_DEGREES = 10;

/**
 * A ship burning out flies this far off the line straight away from the threat.
 */
export const BURN_OUT_DEGREES = 20;

/**
 * Metres beyond every hostile's reach a burning-out ship counts as out of reach.
 */
export const BURN_OUT_MARGIN_METRES = 5000;

/**
 * A support ship holds this share of its repair reach from its friend.
 */
export const SUPPORT_REACH_SHARE = 0.8;

/**
 * A support ship flies to its point while farther than this share of its repair reach from it.
 */
export const SUPPORT_POINT_SLACK_SHARE = 0.5;

/**
 * A lever's band around a single range: ± this share of it, at least LEVER_BAND_MINIMUM_METRES.
 */
export const LEVER_BAND_SHARE = 0.1;

export const LEVER_BAND_MINIMUM_METRES = 500;

/**
 * The side a ship already moves to across the line to another (its velocity across the line), so a turn keeps its
 * transversal; any perpendicular when it moves along the line.
 *
 * @param self - The ship.
 * @param line - The line (from the ship toward the other).
 * @returns A unit vector across the line.
 */
function acrossSideOf(self: PilotBody, line: SceneVector): SceneVector {
  const unit = unitVector(line);
  const across = subtractVectors(self.velocity, scaleVector(unit, dotVectors(self.velocity, unit)));
  const fallback = crossVectors(unit, Math.abs(unit[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  return unitVector(vectorLength(across) > 1e-6 ? across : fallback);
}

/**
 * The direction to kite away: straight away from the focus turned KITE_AWAY_DEGREES toward the side the ship already
 * moves to.
 *
 * @param self - The kiter.
 * @param focus - What it kites.
 * @returns A unit direction.
 */
export function kiteAwayDirectionOf(self: PilotBody, focus: PilotBody): SceneVector {
  const away = unitVector(subtractVectors(self.position, focus.position));
  return rotateToward(away, acrossSideOf(self, away), KITE_AWAY_DEGREES);
}

/**
 * The direction to close in: straight at the focus, turned SPIRAL_DEGREES toward the side the ship already moves to
 * while the focus can shoot it (`spiral`), else straight.
 *
 * @param self - The ship closing.
 * @param focus - What it closes on.
 * @param spiral - Whether to spiral.
 * @returns A unit direction.
 */
export function closeInDirectionOf(self: PilotBody, focus: PilotBody, spiral: boolean): SceneVector {
  const toward = unitVector(subtractVectors(focus.position, self.position));
  return spiral ? rotateToward(toward, acrossSideOf(self, toward), SPIRAL_DEGREES) : toward;
}

/**
 * The threat's centre: the hostiles' positions weighted by the DPS each applies to the ship now (equal weights when
 * none applies any).
 *
 * @param self - The ship.
 * @param hostiles - The hostiles.
 * @returns The centroid; the ship's own position without hostiles.
 */
export function threatCentroidOf(self: PilotContact, hostiles: readonly PilotContact[]): SceneVector {
  const flight = liveFlightOf(self);
  const speed = vectorLength(self.velocity);
  const weights = hostiles.map((hostile) => {
    const distance = surfaceDistanceOf(self, hostile);
    const centre = distance + self.radius + hostile.radius;
    return distance <= hostile.profile.lockRange ? appliedDpsOf(hostile.profile.weapons, { distance, angular: centre > 0 ? (speed * 2) / Math.PI / centre : 0, signature: flight.signature, speed }) : 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let centroid = self.position;
  if (hostiles.length) {
    const share = (index: number) => (total > 0 ? weights[index] / total : 1 / hostiles.length);
    centroid = hostiles.reduce<SceneVector>((sum, hostile, index) => addVectors(sum, scaleVector(hostile.position, share(index))), [0, 0, 0]);
  }
  return centroid;
}

/**
 * The direction to burn out: straight away from the threat's centre, turned BURN_OUT_DEGREES toward the side the ship
 * already moves to.
 *
 * @param self - The ship.
 * @param hostiles - The hostiles.
 * @returns A unit direction.
 */
export function burnOutDirectionOf(self: PilotContact, hostiles: readonly PilotContact[]): SceneVector {
  const away = unitVector(subtractVectors(self.position, threatCentroidOf(self, hostiles)));
  return rotateToward(away, acrossSideOf(self, away), BURN_OUT_DEGREES);
}

/**
 * How far a hostile reaches a ship: its weapons (capped at its lock range) and its tackle.
 *
 * @param hostile - The hostile.
 * @returns Metres.
 */
export function hostileReachOf(hostile: PilotContact): number {
  const { point, scram, web } = hostile.profile.tackle;
  return Math.max(Math.min(hostile.profile.lockRange, maxWeaponReachOf(hostile.profile.weapons)), point ?? 0, scram ?? 0, web ?? 0);
}

/**
 * Whether a ship is beyond every hostile's reach + a margin.
 *
 * @param self - The ship.
 * @param hostiles - The hostiles.
 * @param margin - Metres beyond their reach.
 * @returns True when none reaches it.
 */
export function isOutOfReachOf(self: PilotBody, hostiles: readonly PilotContact[], margin = BURN_OUT_MARGIN_METRES): boolean {
  return hostiles.every((hostile) => surfaceDistanceOf(self, hostile) > hostileReachOf(hostile) + margin);
}

export interface SupportPointInput {
  readonly self: PilotBody;
  /**
   * The friend it holds on.
   */
  readonly friend: PilotBody;
  readonly hostiles: readonly PilotContact[];
  /**
   * Its repair reach (repairReachOf).
   */
  readonly reach: number;
}

/**
 * Where a support ship holds: SUPPORT_REACH_SHARE of its repair reach behind its friend, on the line from the threat's
 * centre through the friend (the friend between it and the hostiles); without hostiles, on its own side of the friend.
 *
 * @param input - The support ship, its friend, the hostiles and its repair reach.
 * @returns The point and the range it holds from the friend (surface).
 */
export function supportPointOf(input: SupportPointInput): { readonly point: SceneVector; readonly range: number } {
  const { self, friend, hostiles, reach } = input;
  const range = SUPPORT_REACH_SHARE * reach;
  const threat = hostiles.length ? hostiles.reduce<SceneVector>((sum, hostile) => addVectors(sum, scaleVector(hostile.position, 1 / hostiles.length)), [0, 0, 0]) : null;
  const behind = unitVector(threat ? subtractVectors(friend.position, threat) : subtractVectors(self.position, friend.position));
  return { point: addVectors(friend.position, scaleVector(behind, range + self.radius + friend.radius)), range };
}

/**
 * A lever's band around a range: a [min, max] as given, a single range ± LEVER_BAND_SHARE (at least
 * LEVER_BAND_MINIMUM_METRES).
 *
 * @param range - Metres or a band.
 * @returns [min, max] metres.
 */
export function leverBandOf(range: number | readonly [number, number]): readonly [number, number] {
  let band: readonly [number, number];
  if (typeof range === 'number') {
    const slack = Math.max(LEVER_BAND_MINIMUM_METRES, LEVER_BAND_SHARE * range);
    band = [Math.max(0, range - slack), range + slack];
  } else band = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
  return band;
}

export interface LeverOrderInput {
  readonly type: 'orbit' | 'keep-at-range' | 'approach';
  readonly self: PilotContact;
  readonly target: PilotContact;
  readonly band: readonly [number, number];
  readonly propModOn: boolean;
}

/**
 * The order a lever wants: orbit the target at what flies the band's middle (orbitOrderFor), keep it at the band's
 * middle, or approach it.
 *
 * @param input - The lever, the ship, its target, the band and whether the prop mod will run.
 * @returns The order.
 */
export function leverOrderOf(input: LeverOrderInput): ShipOrder {
  const { type, self, target, band, propModOn } = input;
  const middle = (band[0] + band[1]) / 2;
  let order: ShipOrder;
  if (type === 'approach') order = { type: 'approach', target: target.id, speed: 1 };
  else if (type === 'keep-at-range') order = { type: 'keep-at-range', target: target.id, range: Math.round(middle), speed: 1 };
  else {
    const flight = liveFlightOf({ ...self, propModOn });
    order = { type: 'orbit', target: target.id, range: orbitOrderFor({ speed: flight.speed, tau: flight.tau, radii: self.radius + target.radius, distance: middle }), speed: 1 };
  }
  return order;
}

/**
 * Whether a wanted direction differs from the ship's direction order by more than REAIM_DEGREES (always, when its
 * order is no direction).
 *
 * @param wanted - The wanted direction.
 * @param current - The ship's order.
 * @returns True when the direction should be given.
 */
export function isReaim(wanted: SceneVector, current: Maybe<ShipOrder>): boolean {
  return current?.type !== 'direction' || angleBetween(wanted, current.direction) > REAIM_DEGREES;
}
