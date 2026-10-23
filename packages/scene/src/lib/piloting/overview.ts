import type { Maybe } from '@dereekb/util';
import { turretHitChance } from '../combat/accuracy';
import { FLEET_AWARENESS_RANGE, type FleetShipFacts, type ShipLayerFractions, type ShipLockFact } from '../personalities/picture';
import type { SceneVector } from '../scene';
import { appliedDpsOf, type PilotWeapon } from './application';
import { candidateRangesOf, envelopePointOf, liveFlightOf, type PilotContact } from './envelope';
import { idealRangeOf, type IdealRange } from './ideal';
import { remoteRepairAt, shipReachOf, type PilotTackle } from './profile';
import { relativeMotionOf } from './relative';
import { isIdealStanceType, type IdealStanceType } from './stance';
import type { ResolvedShipStance } from './stances';
import { vectorLength } from './vectors';

/**
 * get_overview: EVE's overview from one ship. Every other live ship within reach, nearest first, with the overview's
 * columns (distance, velocity, radial, transversal, angular), bearing and aspect, its reach and tackle, the DPS it
 * applies on this ship now and this ship's on it, its lock and fire on this ship; this ship's own state and stance; and
 * the envelope against its focus (the ideal range the pilots fly to). Plain JSON from the page's facts, so a program
 * outside the page reads what the page's pilots read (sd-piloting).
 */

/**
 * Metres: ships further than this (surface to surface) are left off by default.
 */
export const OVERVIEW_DEFAULT_WITHIN = FLEET_AWARENESS_RANGE;

/**
 * Rows returned by default.
 */
export const OVERVIEW_DEFAULT_LIMIT = 25;

export type OverviewRelation = 'hostile' | 'friendly' | 'neutral';

/**
 * How a ship stands to another by team: both set and equal friendly, both set and different hostile, else neutral.
 *
 * @param self - The ship measuring.
 * @param other - The ship measured.
 * @returns The relation.
 */
export function overviewRelationOf(self: Pick<FleetShipFacts, 'team'>, other: Pick<FleetShipFacts, 'team'>): OverviewRelation {
  let relation: OverviewRelation = 'neutral';
  if (self.team != null && other.team != null) relation = self.team === other.team ? 'friendly' : 'hostile';
  return relation;
}

/**
 * A live ship's facts as a ship in a pilot's picture.
 *
 * @param facts - The page's facts of the ship.
 * @returns The contact; null while its combat profile is pending.
 */
export function toPilotContact(facts: FleetShipFacts): Maybe<PilotContact> {
  const { id, profile, position, radius } = facts;
  return profile
    ? {
        id,
        profile,
        position,
        velocity: facts.velocity ?? [0, 0, 0],
        radius,
        heading: facts.heading ?? null,
        propModOn: facts.propModOn === true,
        remaining: facts.remainingEhp ?? facts.remaining,
        ...(facts.scrammed ? { scrammed: true } : {}),
        ...(facts.webFactor != null && facts.webFactor !== 1 ? { webFactor: facts.webFactor } : {})
      }
    : null;
}

export interface ShipOverviewTackle {
  readonly point?: number;
  readonly scram?: number;
  readonly web?: number;
}

/**
 * One row: another ship as this one sees it.
 */
export interface ShipOverviewRow {
  readonly id: string;
  readonly name?: string;
  readonly team?: string;
  readonly relation: OverviewRelation;
  /**
   * Surface to surface (m).
   */
  readonly distance: number;
  /**
   * Its speed (m/s).
   */
  readonly velocity: number;
  /**
   * m/s along the line of sight, positive while the gap opens.
   */
  readonly radial: number;
  /**
   * m/s across the line of sight.
   */
  readonly transversal: number;
  /**
   * rad/s: what turret tracking reads.
   */
  readonly angular: number;
  /**
   * Degrees off this ship's nose (0 dead ahead).
   */
  readonly bearing: number;
  /**
   * Degrees between its nose and this ship (0: it points at this ship).
   */
  readonly aspect: number;
  /**
   * How far its weapons reach (capped at its lock range) and its lock range, metres.
   */
  readonly reach?: number;
  readonly lockRange?: number;
  readonly tackle?: ShipOverviewTackle;
  /**
   * Not friendly: the DPS it applies on this ship now (0 beyond its lock range).
   */
  readonly incomingDps?: number;
  /**
   * Not friendly: this ship's turrets' hit chance on it now (paper DPS weighted; absent without turrets) and the DPS
   * this ship applies on it now.
   */
  readonly hitChance?: number;
  readonly outgoingDps?: number;
  /**
   * Friendly, when this ship fits remote repairers: HP per second they would land on it at this distance.
   */
  readonly repairs?: number;
  /**
   * Its lock on this ship.
   */
  readonly targeting?: ShipLockFact['state'];
  /**
   * Its weapons fire at this ship.
   */
  readonly shooting?: true;
  /**
   * HP left over its total, 0..1, and per layer.
   */
  readonly health: number;
  readonly layers?: ShipLayerFractions;
  /**
   * Its own target.
   */
  readonly target?: string;
  readonly propModOn?: true;
  readonly scrammed?: true;
  readonly webFactor?: number;
}

/**
 * The ship the overview is measured from.
 */
export interface ShipOverviewSelf {
  readonly id: string;
  readonly name?: string;
  readonly team?: string;
  readonly position: SceneVector;
  /**
   * m/s now, and its top speed as it flies (its prop mod's state, webs).
   */
  readonly speed: number;
  readonly maxSpeed: number;
  readonly signature: number;
  readonly health: number;
  readonly layers?: ShipLayerFractions;
  /**
   * Effective HP left and at full health.
   */
  readonly remainingEhp?: number;
  readonly ehp?: number;
  readonly propModOn?: true;
  readonly scrammed?: true;
  readonly webFactor?: number;
  readonly target?: string;
  readonly locks: readonly ShipLockFact[];
  readonly reach?: number;
  readonly lockRange?: number;
  readonly tackle?: ShipOverviewTackle;
  /**
   * HP per second remote repairers land on it now.
   */
  readonly incomingReps?: number;
  /**
   * Destroyed, warping or still arriving.
   */
  readonly away?: true;
}

export interface ShipOverviewEnvelopePoint {
  readonly range: number;
  readonly out: number;
  readonly in: number;
}

/**
 * The envelope against the focus.
 */
export interface ShipOverviewEnvelope {
  readonly focus: string;
  /**
   * The stance type it is weighed for: the ship's own ideal type, else `auto`.
   */
  readonly for: IdealStanceType | 'auto';
  /**
   * The range to the focus now (m) and whether it lies in the window.
   */
  readonly range: number;
  readonly inWindow: boolean;
  readonly ideal: Maybe<IdealRange>;
  /**
   * `envelope: true`: out and in DPS at every candidate range, in the ideal's posture and prop mod state.
   */
  readonly points?: readonly ShipOverviewEnvelopePoint[];
}

export interface ShipOverviewCounts {
  readonly hostile: number;
  readonly friendly: number;
  readonly neutral: number;
  /**
   * Ships beyond `within`, and rows cut by `limit`.
   */
  readonly beyond: number;
  readonly cut: number;
}

export interface ShipOverview {
  readonly ship: ShipOverviewSelf;
  /**
   * Its resolved stance (sd-piloting), when given.
   */
  readonly stance?: ResolvedShipStance;
  readonly rows: readonly ShipOverviewRow[];
  readonly counts: ShipOverviewCounts;
  /**
   * Null when it has no focus or no combat profile; absent with `envelope: false`.
   */
  readonly envelope?: Maybe<ShipOverviewEnvelope>;
  readonly warnings?: readonly string[];
}

export interface ShipOverviewInput {
  readonly ship: string;
  /**
   * Every live ship (the page's facts).
   */
  readonly ships: readonly FleetShipFacts[];
  /**
   * Metres (default OVERVIEW_DEFAULT_WITHIN) and rows (default OVERVIEW_DEFAULT_LIMIT).
   */
  readonly within?: Maybe<number>;
  readonly limit?: Maybe<number>;
  /**
   * The envelope's focus (default: its own target, else the nearest hostile).
   */
  readonly target?: Maybe<string>;
  /**
   * false: no envelope; true: with its points.
   */
  readonly envelope?: Maybe<boolean>;
  readonly stance?: Maybe<ResolvedShipStance>;
}

function round(value: number, decimals = 0): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function tackleOf(tackle: PilotTackle): Maybe<ShipOverviewTackle> {
  const out: ShipOverviewTackle = { ...(tackle.point ? { point: round(tackle.point) } : {}), ...(tackle.scram ? { scram: round(tackle.scram) } : {}), ...(tackle.web ? { web: round(tackle.web) } : {}) };
  return Object.keys(out).length ? out : null;
}

/**
 * A weapon set's turret hit chance at a geometry, weighted by paper DPS.
 *
 * @param weapons - The weapons.
 * @param geometry - Distance, angular velocity and the target's signature.
 * @returns 0..1; null without turrets.
 */
function turretHitChanceOf(weapons: readonly PilotWeapon[], geometry: { readonly distance: number; readonly angular: number; readonly signature: number }): Maybe<number> {
  let weight = 0;
  let sum = 0;
  for (const weapon of weapons) {
    if ((weapon.kind !== 'tracking' && weapon.kind !== 'disintegrator') || weapon.dps <= 0) continue;
    const chance = turretHitChance({ angularVelocity: geometry.angular, tracking: weapon.tracking ?? 0, signatureRadius: geometry.signature, signatureResolution: weapon.signatureResolution ?? 0, distance: geometry.distance, optimal: weapon.optimal, falloff: weapon.falloff });
    weight += weapon.dps;
    sum += weapon.dps * chance;
  }
  return weight > 0 ? sum / weight : null;
}

function roundIdeal(ideal: IdealRange): IdealRange {
  return { ...ideal, ideal: round(ideal.ideal), window: [round(ideal.window[0]), round(ideal.window[1])], ordered: round(ideal.ordered), out: round(ideal.out, 1), in: round(ideal.in, 1), score: Number(ideal.score.toPrecision(3)) };
}

/**
 * The overview from one ship.
 *
 * @param input - The ship, every live ship's facts, the cuts, the envelope's focus and the ship's stance.
 * @returns The overview.
 * @throws {Error} When the ship is not among the facts.
 */
export function toShipOverview(input: ShipOverviewInput): ShipOverview {
  const { ship, ships, stance } = input;
  const selfFacts = ships.find((each) => each.id === ship);
  if (!selfFacts) throw new Error(`ship "${ship}" is not in the scene (or has exploded)`);
  const within = input.within ?? OVERVIEW_DEFAULT_WITHIN;
  const limit = input.limit ?? OVERVIEW_DEFAULT_LIMIT;
  const warnings: string[] = [];
  const self = toPilotContact(selfFacts);
  const selfBody = { position: selfFacts.position, velocity: selfFacts.velocity ?? [0, 0, 0], radius: selfFacts.radius, heading: selfFacts.heading ?? null };
  const selfFlight = self ? liveFlightOf(self) : null;
  const selfSignature = selfFlight?.signature ?? selfFacts.signature;
  const counts = { hostile: 0, friendly: 0, neutral: 0, beyond: 0, cut: 0 };
  const placed: { readonly facts: FleetShipFacts; readonly row: ShipOverviewRow }[] = [];
  const hostiles: PilotContact[] = [];
  for (const other of ships) {
    if (other.id === ship || other.away) continue;
    const relation = overviewRelationOf(selfFacts, other);
    const body = { position: other.position, velocity: other.velocity ?? [0, 0, 0], radius: other.radius, heading: other.heading ?? null };
    const motion = relativeMotionOf(selfBody, body);
    if (motion.distance > within) {
      counts.beyond += 1;
      continue;
    }
    counts[relation] += 1;
    const contact = toPilotContact(other);
    if (contact && relation === 'hostile') hostiles.push(contact);
    const lock = other.locks?.find((each) => each.target === ship);
    let incomingDps: Maybe<number> = null;
    let outgoingDps: Maybe<number> = null;
    let hitChance: Maybe<number> = null;
    let repairs: Maybe<number> = null;
    if (relation !== 'friendly') {
      if (contact) incomingDps = motion.distance <= contact.profile.lockRange ? appliedDpsOf(contact.profile.weapons, { distance: motion.distance, angular: motion.angular, signature: selfSignature, speed: vectorLength(selfBody.velocity) }) : 0;
      if (self) {
        const geometry = { distance: motion.distance, angular: motion.angular, signature: contact ? liveFlightOf(contact).signature : other.signature, speed: vectorLength(body.velocity) };
        outgoingDps = motion.distance <= self.profile.lockRange ? appliedDpsOf(self.profile.weapons, geometry) : 0;
        hitChance = turretHitChanceOf(self.profile.weapons, geometry);
      }
    } else if (self?.profile.reps.length) repairs = remoteRepairAt(self.profile.reps, motion.distance);
    const tackle = contact ? tackleOf(contact.profile.tackle) : null;
    const row: ShipOverviewRow = {
      id: other.id,
      ...(other.name ? { name: other.name } : {}),
      ...(other.team != null ? { team: other.team } : {}),
      relation,
      distance: round(motion.distance),
      velocity: round(vectorLength(body.velocity), 1),
      radial: round(motion.radialVelocity, 1),
      transversal: round(motion.transversal, 1),
      angular: round(motion.angular, 4),
      bearing: round(motion.bearing, 1),
      aspect: round(motion.aspect, 1),
      ...(contact ? { reach: round(shipReachOf(contact.profile)), lockRange: round(contact.profile.lockRange) } : {}),
      ...(tackle ? { tackle } : {}),
      ...(incomingDps != null ? { incomingDps: round(incomingDps, 1) } : {}),
      ...(hitChance != null ? { hitChance: round(hitChance, 3) } : {}),
      ...(outgoingDps != null ? { outgoingDps: round(outgoingDps, 1) } : {}),
      ...(repairs != null ? { repairs: round(repairs, 1) } : {}),
      ...(lock ? { targeting: lock.state } : {}),
      ...(other.shooting?.includes(ship) ? { shooting: true as const } : {}),
      health: round(other.health, 3),
      ...(other.layers ? { layers: { shield: round(other.layers.shield, 3), armor: round(other.layers.armor, 3), hull: round(other.layers.hull, 3) } } : {}),
      ...(other.target ? { target: other.target } : {}),
      ...(other.propModOn ? { propModOn: true as const } : {}),
      ...(other.scrammed ? { scrammed: true as const } : {}),
      ...(other.webFactor != null && other.webFactor !== 1 ? { webFactor: round(other.webFactor, 3) } : {})
    };
    placed.push({ facts: other, row });
  }
  placed.sort((a, b) => a.row.distance - b.row.distance || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  counts.cut = Math.max(0, placed.length - limit);
  const rows = placed.slice(0, limit).map((each) => each.row);
  let envelope: Maybe<ShipOverviewEnvelope> = null;
  if (input.envelope !== false) {
    let focusId = input.target ?? null;
    if (focusId != null && !hostiles.some((each) => each.id === focusId)) {
      const known = ships.find((each) => each.id === focusId && !each.away);
      if (!known) {
        warnings.push(`target "${focusId}" is not a live ship: the envelope is weighed on the nearest hostile`);
        focusId = null;
      }
    }
    focusId ??= selfFacts.target != null && ships.some((each) => each.id === selfFacts.target && !each.away) ? selfFacts.target : (placed.find((each) => each.row.relation === 'hostile' && each.facts.profile)?.row.id ?? null);
    const focusFacts = focusId != null ? ships.find((each) => each.id === focusId) : null;
    const focus = focusFacts ? toPilotContact(focusFacts) : null;
    if (self && focus) {
      const pilotType = stance?.pilot?.type;
      const type: IdealStanceType | 'auto' = pilotType && isIdealStanceType(pilotType) ? pilotType : 'auto';
      const ideal = idealRangeOf({ self, focus, hostiles, incomingReps: selfFacts.incomingReps ?? 0, type, propMods: stance?.propMods });
      const range = relativeMotionOf(selfBody, focus).distance;
      const points: ShipOverviewEnvelopePoint[] = [];
      if (input.envelope === true && ideal) {
        for (const candidate of candidateRangesOf({ self, focus, hostiles })) {
          const point = envelopePointOf({ self, focus, hostiles, incomingReps: selfFacts.incomingReps ?? 0, range: candidate, posture: ideal.posture, propMod: ideal.propMod });
          if (point) points.push({ range: round(point.range), out: round(point.out, 1), in: round(point.in, 1) });
        }
      }
      envelope = { focus: focus.id, for: type, range: round(range), inWindow: ideal != null && range >= ideal.window[0] && range <= ideal.window[1], ideal: ideal ? roundIdeal(ideal) : null, ...(input.envelope === true ? { points } : {}) };
    } else if (!self) warnings.push(`ship "${ship}"'s combat numbers are still pending: no envelope yet`);
  }
  const selfTackle = self ? tackleOf(self.profile.tackle) : null;
  const overviewSelf: ShipOverviewSelf = {
    id: ship,
    ...(selfFacts.name ? { name: selfFacts.name } : {}),
    ...(selfFacts.team != null ? { team: selfFacts.team } : {}),
    position: selfFacts.position,
    speed: round(vectorLength(selfBody.velocity), 1),
    maxSpeed: round(selfFlight?.speed ?? selfFacts.speed, 1),
    signature: round(selfSignature, 1),
    health: round(selfFacts.health, 3),
    ...(selfFacts.layers ? { layers: { shield: round(selfFacts.layers.shield, 3), armor: round(selfFacts.layers.armor, 3), hull: round(selfFacts.layers.hull, 3) } } : {}),
    ...(self ? { remainingEhp: round(self.remaining), ehp: round(self.profile.ehp) } : {}),
    ...(selfFacts.propModOn ? { propModOn: true as const } : {}),
    ...(selfFacts.scrammed ? { scrammed: true as const } : {}),
    ...(selfFacts.webFactor != null && selfFacts.webFactor !== 1 ? { webFactor: round(selfFacts.webFactor, 3) } : {}),
    ...(selfFacts.target ? { target: selfFacts.target } : {}),
    locks: selfFacts.locks ?? [],
    ...(self ? { reach: round(shipReachOf(self.profile)), lockRange: round(self.profile.lockRange) } : {}),
    ...(selfTackle ? { tackle: selfTackle } : {}),
    ...(selfFacts.incomingReps ? { incomingReps: round(selfFacts.incomingReps, 1) } : {}),
    ...(selfFacts.away ? { away: true as const } : {})
  };
  return {
    ship: overviewSelf,
    ...(stance ? { stance } : {}),
    rows,
    counts,
    ...(input.envelope !== false ? { envelope } : {}),
    ...(warnings.length ? { warnings } : {})
  };
}
