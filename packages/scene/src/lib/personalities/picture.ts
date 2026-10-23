import type { Maybe } from '@dereekb/util';
import type { FleetCommand, SceneFleet } from '../fleets/fleet';
import { toFleetShipOrder } from '../fleets/live';
import type { ShipFleetMembership } from '../fleets/membership';
import type { ShipOrder } from '../orders';
import type { SceneVector } from '../scene';
import type { ShipCombatProfile } from '../piloting/profile';
import type { FleetReach, FleetTargetRole } from './personality';

/**
 * The brain's picture of a fight: what one personality fleet's FC knows at a boundary. The page builds it
 * (fleet-commanders) from the live scene, combat and Destiny; everything here is plain and serializable, in document
 * order, so the same picture gives the same decisions and a model can later read the same view. Distances are
 * metres, surface to surface from the acting FC; offsets are origin-relative metres from the FC's centre.
 */

/**
 * Metres: hostiles further than this from the FC are not in the picture.
 */
export const FLEET_AWARENESS_RANGE = 250_000;

/**
 * Seconds: a member shot within this window counts as attacked (the `when-attacked` engage rule).
 */
export const FLEET_ATTACKED_WINDOW = 20;

/**
 * Ranges by the guns, metres: the lock range, turret optimal, and turret optimal + falloff (missiles count their mean
 * flight range for optimal and falloff).
 */
export interface FleetReachNumbers {
  readonly lock: number;
  readonly optimal: number;
  readonly falloff: number;
}

/**
 * One ship in the picture.
 */
export interface FleetPictureShip {
  readonly id: string;
  readonly team?: string;
  /**
   * Surface distance from the acting FC; 0 for the FC.
   */
  readonly distance: number;
  /**
   * Its centre minus the FC's centre.
   */
  readonly offset: SceneVector;
  /**
   * HP left over its total (shield + armor + hull), 0..1.
   */
  readonly health: number;
  /**
   * HP left (shield + armor + hull).
   */
  readonly remaining: number;
  /**
   * Paper DPS of its weapons.
   */
  readonly dps: number;
  /**
   * Its tier: `fc` for a fleet commander, else its squad's role; a ship in no squad is `dps`.
   */
  readonly role: FleetTargetRole;
  /**
   * The commands it holds (fleet, wing, squad).
   */
  readonly commands: readonly FleetCommand[];
  readonly signature: number;
  /**
   * Max velocity, m/s.
   */
  readonly speed: number;
  /**
   * Its own target (locked or locking), when it has one.
   */
  readonly target?: string;
}

/**
 * A member of the picture's fleet.
 */
export interface FleetPictureMember extends FleetPictureShip {
  readonly reach: FleetReachNumbers;
  /**
   * Hostiles that shot it within FLEET_ATTACKED_WINDOW.
   */
  readonly attackedBy: readonly string[];
}

/**
 * Whether the fleet's prop mods run: `none` when no member has one.
 */
export type FleetPicturePropMods = 'on' | 'off' | 'none';

export interface FleetPicture {
  readonly fleet: string;
  /**
   * The acting FC and its command ability (0 for a pilot that is not FC-capable); null while leaderless.
   */
  readonly fc: Maybe<{ readonly ship: string; readonly ability: number }>;
  /**
   * The fleet's team: its FC's, else its members' most common; null when none is set (no hostiles).
   */
  readonly team: Maybe<string>;
  readonly members: readonly FleetPictureMember[];
  /**
   * Hostiles by distance, then id.
   */
  readonly hostiles: readonly FleetPictureShip[];
  /**
   * The fleet's live call: primary first, then the queue (live entries only).
   */
  readonly call: readonly string[];
  /**
   * The FC's order (its pending one, else the applied one); null when it has none.
   */
  readonly order: Maybe<ShipOrder>;
  /**
   * Whether free fire is on for the whole fleet.
   */
  readonly freeFire: boolean;
  readonly propMods: FleetPicturePropMods;
  /**
   * The members' median reach (members without weapons left out of optimal and falloff).
   */
  readonly reach: FleetReachNumbers;
}

/**
 * What the page knows of one live ship, for toFleetPicture.
 */
export interface FleetShipFacts extends Omit<FleetPictureShip, 'role' | 'commands' | 'distance' | 'offset'> {
  /**
   * Its centre, origin-relative metres.
   */
  readonly position: SceneVector;
  readonly radius: number;
  /**
   * Destroyed, warping or still arriving: never a hostile, and not a member the fleet counts.
   */
  readonly away?: boolean;
  /**
   * Members only: its reach and who shot it.
   */
  readonly reach?: FleetReachNumbers;
  readonly attackedBy?: readonly string[];
  /**
   * What the pilots and get_overview read beyond the FC brain's view (sd-piloting); toFleetPicture ignores them.
   */
  readonly name?: string;
  /**
   * m/s.
   */
  readonly velocity?: SceneVector;
  /**
   * Where its nose points (a unit vector).
   */
  readonly heading?: SceneVector;
  /**
   * Its combat profile; absent while its numbers are pending.
   */
  readonly profile?: ShipCombatProfile;
  readonly propModOn?: boolean;
  /**
   * A scram holds it (its MWD cannot run).
   */
  readonly scrammed?: boolean;
  /**
   * The speed multiplier of the webs on it (1 or unset: none).
   */
  readonly webFactor?: number;
  /**
   * Effective HP left: each layer's HP over its omni resonance.
   */
  readonly remainingEhp?: number;
  /**
   * HP left over max per layer, 0..1.
   */
  readonly layers?: ShipLayerFractions;
  /**
   * Its locks started or done.
   */
  readonly locks?: readonly ShipLockFact[];
  /**
   * The ships its running weapons fire at.
   */
  readonly shooting?: readonly string[];
  /**
   * HP per second remote repairers land on it now.
   */
  readonly incomingReps?: number;
}

export interface ShipLayerFractions {
  readonly shield: number;
  readonly armor: number;
  readonly hull: number;
}

export interface ShipLockFact {
  readonly target: string;
  readonly state: 'locking' | 'locked';
}

export interface FleetPictureInput {
  /**
   * The fleet as it flies (the live view).
   */
  readonly fleet: SceneFleet;
  /**
   * Every fleet membership in the live view, for roles and commands.
   */
  readonly memberships: ReadonlyMap<string, ShipFleetMembership>;
  /**
   * Every live ship in the scene.
   */
  readonly ships: readonly FleetShipFacts[];
  readonly fc: FleetPicture['fc'];
  readonly call: readonly string[];
  readonly order: Maybe<ShipOrder>;
  readonly freeFire: boolean;
  readonly propMods: FleetPicturePropMods;
}

/**
 * The fleet's team: its FC's when set, else the most common among its members (ties: the first in fleet order).
 *
 * @param fcTeam - The acting FC's team.
 * @param memberTeams - The members' teams in fleet order.
 * @returns The team, or null when none is set.
 */
export function toFleetTeam(fcTeam: Maybe<string>, memberTeams: readonly Maybe<string>[]): Maybe<string> {
  let team: Maybe<string> = fcTeam ?? null;
  if (team == null) {
    const counts = new Map<string, number>();
    for (const each of memberTeams) if (each != null) counts.set(each, (counts.get(each) ?? 0) + 1);
    let best = 0;
    for (const [each, count] of counts) {
      if (count > best) {
        team = each;
        best = count;
      }
    }
  }
  return team;
}

/**
 * The median of the positive values.
 *
 * @param values - The values.
 * @returns The median; 0 when none is positive.
 */
function median(values: readonly number[]): number {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  let result = 0;
  if (sorted.length) result = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return result;
}

/**
 * The fleet's reach: each range's median over the members that have it.
 *
 * @param members - The members' reaches.
 * @returns The medians.
 */
export function toFleetReachNumbers(members: readonly Pick<FleetPictureMember, 'reach'>[]): FleetReachNumbers {
  return { lock: median(members.map((member) => member.reach.lock)), optimal: median(members.map((member) => member.reach.optimal)), falloff: median(members.map((member) => member.reach.falloff)) };
}

/**
 * A personality range in metres.
 *
 * @param reach - A named reach or metres.
 * @param numbers - The fleet's reach.
 * @returns Metres.
 */
export function fleetReachMetres(reach: FleetReach, numbers: FleetReachNumbers): number {
  return typeof reach === 'number' ? reach : numbers[reach];
}

/**
 * A ship's priority tier from its membership: `fc` for a fleet commander, else its squad's role, else `dps`.
 *
 * @param membership - Its membership, when it has one.
 * @returns The tier.
 */
export function fleetTargetRoleOf(membership: Maybe<ShipFleetMembership>): FleetTargetRole {
  let role: FleetTargetRole = membership?.role ?? 'dps';
  if (membership?.commands.includes('fleet')) role = 'fc';
  return role;
}

/**
 * The vector from one point to another.
 *
 * @param from - The start.
 * @param to - The end.
 * @returns to − from.
 */
function offsetOf(from: SceneVector, to: SceneVector): SceneVector {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

/**
 * Builds a fleet's picture: its members in fleet order (those not away), and the hostiles: live ships of another team
 * within FLEET_AWARENESS_RANGE of the FC, by distance then id. A fleet with no team, or no FC to measure from, sees
 * no hostiles.
 *
 * @param input - The fleet, the scene's live ships and the fleet's live state.
 * @returns The picture.
 */
export function toFleetPicture(input: FleetPictureInput): FleetPicture {
  const { fleet, memberships, ships, fc } = input;
  const byId = new Map(ships.map((ship) => [ship.id, ship]));
  const order = toFleetShipOrder(fleet);
  const inFleet = new Set(order);
  const origin = fc ? byId.get(fc.ship) : null;
  const place = (ship: FleetShipFacts): FleetPictureShip => {
    const offset: SceneVector = origin ? offsetOf(origin.position, ship.position) : [0, 0, 0];
    const centre = Math.hypot(offset[0], offset[1], offset[2]);
    const distance = origin && ship.id !== origin.id ? Math.max(0, centre - ship.radius - origin.radius) : 0;
    const membership = memberships.get(ship.id);
    return {
      id: ship.id,
      ...(ship.team != null ? { team: ship.team } : {}),
      distance,
      offset,
      health: ship.health,
      remaining: ship.remaining,
      dps: ship.dps,
      role: fleetTargetRoleOf(membership),
      commands: [...(membership?.commands ?? [])],
      signature: ship.signature,
      speed: ship.speed,
      ...(ship.target ? { target: ship.target } : {})
    };
  };
  const members: FleetPictureMember[] = [];
  for (const id of order) {
    const ship = byId.get(id);
    if (ship && !ship.away) members.push({ ...place(ship), reach: ship.reach ?? { lock: 0, optimal: 0, falloff: 0 }, attackedBy: [...(ship.attackedBy ?? [])] });
  }
  const team = toFleetTeam(
    origin?.team,
    members.map((member) => member.team)
  );
  const hostiles: FleetPictureShip[] = [];
  if (origin && team != null) {
    for (const ship of ships) {
      if (!ship.away && !inFleet.has(ship.id) && ship.team != null && ship.team !== team) {
        const placed = place(ship);
        if (placed.distance <= FLEET_AWARENESS_RANGE) hostiles.push(placed);
      }
    }
    hostiles.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { fleet: fleet.id, fc, team, members, hostiles, call: [...input.call], order: input.order ?? null, freeFire: input.freeFire, propMods: input.propMods, reach: toFleetReachNumbers(members) };
}
