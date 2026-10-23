import type { Maybe } from '@dereekb/util';
import { appliedDpsOf } from './application';
import { legacyOrbitOf, orbitOrderFor } from './orbit';
import { flightOf, type PilotFlight, type ShipCombatProfile } from './profile';
import { relativeMotionOf, surfaceDistanceOf, type PilotBody } from './relative';
import { addVectors, scaleVector, subtractVectors, unitVector, vectorLength } from './vectors';

/**
 * The engagement envelope: for a pilot against its focus, the DPS it applies (out) and takes (in) at a range, posture
 * and prop mod state, from both sides' numbers. idealRangeOf scores these points.
 */

/**
 * A ship in a pilot's picture: its motion, its combat profile and its live state.
 */
export interface PilotContact extends PilotBody {
  readonly id: string;
  readonly profile: ShipCombatProfile;
  /**
   * Whether its prop mod runs now.
   */
  readonly propModOn: boolean;
  /**
   * Effective HP left.
   */
  readonly remaining: number;
  /**
   * Whether a scram holds it (its MWD cannot run).
   */
  readonly scrammed?: boolean;
  /**
   * The speed multiplier of the webs on it (1 or unset: none).
   */
  readonly webFactor?: number;
}

export type PilotPosture = 'orbit' | 'keep-at-range';

export const PILOT_POSTURES: readonly PilotPosture[] = ['orbit', 'keep-at-range'];

export interface EnvelopeInput {
  readonly self: PilotContact;
  readonly focus: PilotContact;
  /**
   * Every hostile in the picture (the focus may be among them).
   */
  readonly hostiles: readonly PilotContact[];
  /**
   * HP per second friendly logi put on this ship.
   */
  readonly incomingReps?: number;
}

/**
 * The range grid, metres: every RANGE_GRID_FINE_STEP to RANGE_GRID_FINE_TO, every RANGE_GRID_MEDIUM_STEP to
 * RANGE_GRID_MEDIUM_TO, every RANGE_GRID_COARSE_STEP beyond (up to the lock range).
 */
export const RANGE_GRID_FINE_STEP = 250;

export const RANGE_GRID_FINE_TO = 5000;

export const RANGE_GRID_MEDIUM_STEP = 1000;

export const RANGE_GRID_MEDIUM_TO = 30_000;

export const RANGE_GRID_COARSE_STEP = 2500;

/**
 * Metres kept clear of a hostile's scram or web, and the margin around tackle breakpoints.
 */
export const TACKLE_MARGIN_METRES = 1500;

/**
 * A non-focus hostile's transversal on this ship, as a share of this ship's speed: the mean over random directions
 * (2 / π).
 */
export const STRAY_TRANSVERSAL_SHARE = 2 / Math.PI;

/**
 * An orbit is not flyable at a range when even an order of 0 settles wider than ORBIT_TIGHTEST_SHARE × the range +
 * ORBIT_TIGHTEST_SLACK metres.
 */
export const ORBIT_TIGHTEST_SHARE = 1.05;

export const ORBIT_TIGHTEST_SLACK = 50;

/**
 * The live flight of a contact: its prop mod state, a scram, and the webs on it.
 *
 * @param contact - The ship.
 * @returns Speed (webbed), signature and τ.
 */
export function liveFlightOf(contact: Pick<PilotContact, 'profile' | 'propModOn' | 'scrammed' | 'webFactor'>): PilotFlight {
  const flight = flightOf(contact.profile, contact.propModOn, contact.scrammed);
  return { ...flight, speed: flight.speed * (contact.webFactor ?? 1) };
}

/**
 * The candidate ranges a pilot weighs against its focus: the range grid and the breakpoints of every weapon and
 * tackle module on both sides (tackle ± TACKLE_MARGIN_METRES), capped at this ship's lock range.
 *
 * @param input - The pilot, its focus and the hostiles.
 * @returns Metres, ascending, distinct.
 */
export function candidateRangesOf(input: EnvelopeInput): number[] {
  const { self, focus, hostiles } = input;
  const cap = self.profile.lockRange;
  const ranges: number[] = [];
  for (let range = RANGE_GRID_FINE_STEP; range <= Math.min(cap, RANGE_GRID_FINE_TO); range += RANGE_GRID_FINE_STEP) ranges.push(range);
  for (let range = RANGE_GRID_FINE_TO + RANGE_GRID_MEDIUM_STEP; range <= Math.min(cap, RANGE_GRID_MEDIUM_TO); range += RANGE_GRID_MEDIUM_STEP) ranges.push(range);
  for (let range = RANGE_GRID_MEDIUM_TO + RANGE_GRID_COARSE_STEP; range <= cap; range += RANGE_GRID_COARSE_STEP) ranges.push(range);
  for (const weapon of self.profile.weapons) ranges.push(weapon.optimal, weapon.optimal + weapon.falloff);
  for (const hostile of [focus, ...hostiles]) {
    for (const weapon of hostile.profile.weapons) ranges.push(weapon.optimal, weapon.optimal + weapon.falloff);
    for (const tackle of [hostile.profile.tackle.point, hostile.profile.tackle.scram, hostile.profile.tackle.web]) if (tackle) ranges.push(tackle - TACKLE_MARGIN_METRES, tackle + TACKLE_MARGIN_METRES);
  }
  for (const tackle of [self.profile.tackle.point, self.profile.tackle.scram, self.profile.tackle.web]) if (tackle) ranges.push(tackle * 0.9);
  return [...new Set(ranges.filter((range) => range > 0 && range <= cap).map((range) => Math.round(range)))].sort((a, b) => a - b);
}

/**
 * One point of the envelope.
 */
export interface EnvelopePoint {
  /**
   * The range flown to the focus, surface to surface (m).
   */
  readonly range: number;
  readonly posture: PilotPosture;
  readonly propMod: boolean;
  /**
   * What to order for this range: an orbit's ordered range (orbitOrderFor), else the range.
   */
  readonly ordered: number;
  /**
   * This ship's speed holding it (m/s).
   */
  readonly speed: number;
  /**
   * rad/s between this ship and the focus.
   */
  readonly angular: number;
  /**
   * DPS this ship applies to the focus.
   */
  readonly out: number;
  /**
   * DPS every hostile that can lock this ship applies to it there.
   */
  readonly in: number;
  /**
   * out over the focus's remaining EHP; (in − incoming reps) over this ship's remaining EHP.
   */
  readonly killRate: number;
  readonly deathRate: number;
  /**
   * Hostiles whose scram or web (+ TACKLE_MARGIN_METRES) reaches the spot.
   */
  readonly tackledBy: readonly string[];
}

export interface EnvelopePointInput extends EnvelopeInput {
  readonly range: number;
  readonly posture: PilotPosture;
  readonly propMod: boolean;
}

/**
 * The envelope at one range, posture and prop mod state; null when the posture cannot hold that range (an orbit
 * tighter than the ship can fly).
 *
 * @param input - The pilot, its focus, the hostiles, the range, posture and prop mod state.
 * @returns The point, or null.
 */
export function envelopePointOf(input: EnvelopePointInput): Maybe<EnvelopePoint> {
  const { self, focus, hostiles, range, posture, propMod, incomingReps } = input;
  const flight = flightOf(self.profile, propMod, self.scrammed);
  const speedCap = flight.speed * (self.webFactor ?? 1);
  const radii = self.radius + focus.radius;
  const focusSpeed = vectorLength(focus.velocity);
  const focusFlight = liveFlightOf(focus);
  let point: Maybe<EnvelopePoint> = null;
  let speed = Math.min(speedCap, focusSpeed);
  let angular = relativeMotionOf(self, focus).transversal / (range + radii);
  let ordered = range;
  let flyable = true;
  if (posture === 'orbit') {
    const tightest = legacyOrbitOf({ speed: speedCap, tau: flight.tau, range: 0, radii }).distance;
    flyable = tightest <= ORBIT_TIGHTEST_SHARE * range + ORBIT_TIGHTEST_SLACK;
    ordered = orbitOrderFor({ speed: speedCap, tau: flight.tau, radii, distance: range });
    const orbit = legacyOrbitOf({ speed: speedCap, tau: flight.tau, range: ordered, radii });
    speed = orbit.speed;
    angular = orbit.angular;
  }
  if (flyable) {
    const fromFocus = unitVector(subtractVectors(self.position, focus.position));
    const spot = addVectors(focus.position, scaleVector(fromFocus, range + radii));
    const out = range <= self.profile.lockRange ? appliedDpsOf(self.profile.weapons, { distance: range, angular, signature: focusFlight.signature, speed: focusSpeed }) : 0;
    let incoming = 0;
    const tackledBy: string[] = [];
    const seen = new Set<string>();
    for (const hostile of [focus, ...hostiles]) {
      if (seen.has(hostile.id)) continue;
      seen.add(hostile.id);
      const distance = hostile.id === focus.id ? range : surfaceDistanceOf(hostile, { position: spot, radius: self.radius });
      const { scram, web } = hostile.profile.tackle;
      if ((scram && distance <= scram + TACKLE_MARGIN_METRES) || (web && distance <= web + TACKLE_MARGIN_METRES)) tackledBy.push(hostile.id);
      if (distance <= hostile.profile.lockRange) {
        const hostileAngular = hostile.id === focus.id ? angular : (speed * STRAY_TRANSVERSAL_SHARE) / (distance + self.radius + hostile.radius);
        incoming += appliedDpsOf(hostile.profile.weapons, { distance, angular: hostileAngular, signature: flight.signature, speed });
      }
    }
    point = {
      range,
      posture,
      propMod,
      ordered,
      speed,
      angular,
      out,
      in: incoming,
      killRate: out / Math.max(1, focus.remaining),
      deathRate: Math.max(0, incoming - (incomingReps ?? 0)) / Math.max(1, self.remaining),
      tackledBy
    };
  }
  return point;
}
