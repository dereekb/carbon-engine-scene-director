import type { Maybe } from '@dereekb/util';
import type { FleetCommand } from '../fleets/fleet';
import type { FleetEngageRule, FleetPersonalityTargeting, FleetTargetPreference, FleetTargetRole } from './personality';
import { type FleetPicture, type FleetPictureShip, fleetReachMetres, type FleetReachNumbers } from './picture';

/**
 * What a personality fleet shoots: which hostiles it may call (within its targeting reach), in what order (priority
 * tier, then its preference, then nearest, then id), when it moves off its primary, how its queue refills, when it
 * opens fire, and what a free-firing member picks on its own.
 */

/**
 * The fleet's targeting reach in metres: the personality's reach, never beyond the fleet's lock range (when it has
 * one).
 *
 * @param reach - The personality's targeting reach.
 * @param numbers - The fleet's reach.
 * @returns Metres.
 */
export function toFleetTargetingReach(reach: FleetPersonalityTargeting['reach'], numbers: FleetReachNumbers): number {
  const metres = fleetReachMetres(reach, numbers);
  return numbers.lock > 0 ? Math.min(metres, numbers.lock) : metres;
}

const COMMAND_RANK: Readonly<Record<FleetCommand, number>> = { fleet: 0, wing: 1, squad: 2 };

/**
 * A hostile's sort key for a preference: lower comes first.
 *
 * @param prefer - The preference.
 * @param ship - The hostile.
 * @returns The key.
 */
function preferenceKey(prefer: FleetTargetPreference, ship: FleetPictureShip): number {
  let key: number;
  switch (prefer) {
    case 'weakest':
      key = ship.remaining;
      break;
    case 'damaged':
      key = ship.health;
      break;
    case 'toughest':
      key = -ship.remaining;
      break;
    case 'dangerous':
      key = -ship.dps;
      break;
    case 'commander':
      key = Math.min(3, ...ship.commands.map((command) => COMMAND_RANK[command]));
      break;
    case 'fastest':
      key = -ship.speed;
      break;
    case 'biggest':
      key = -ship.signature;
      break;
    case 'smallest':
      key = ship.signature;
      break;
    default:
      key = ship.distance;
  }
  return key;
}

/**
 * A role's tier: its place in the priority list; a role left out ranks after every listed one.
 *
 * @param priority - The tiers in call order.
 * @param role - The role.
 * @returns The tier, 0 first.
 */
export function fleetTargetTier(priority: readonly FleetTargetRole[], role: FleetTargetRole): number {
  const index = priority.indexOf(role);
  return index < 0 ? priority.length : index;
}

export interface RankFleetTargetsInput {
  readonly hostiles: readonly FleetPictureShip[];
  readonly targeting: Pick<FleetPersonalityTargeting, 'priority' | 'prefer'>;
  /**
   * Metres: hostiles further out are not candidates.
   */
  readonly reach: number;
}

/**
 * The candidates in call order: hostiles within reach, by tier, then preference, then nearest, then id.
 *
 * @param input - The hostiles, the targeting and the reach.
 * @returns The ranked candidates.
 */
export function rankFleetTargets(input: RankFleetTargetsInput): FleetPictureShip[] {
  const { hostiles, targeting, reach } = input;
  const keyed = hostiles.filter((ship) => ship.distance <= reach).map((ship) => ({ ship, tier: fleetTargetTier(targeting.priority, ship.role), key: preferenceKey(targeting.prefer, ship) }));
  keyed.sort((a, b) => a.tier - b.tier || a.key - b.key || a.ship.distance - b.ship.distance || (a.ship.id < b.ship.id ? -1 : a.ship.id > b.ship.id ? 1 : 0));
  return keyed.map((each) => each.ship);
}

export interface FleetCallDecision {
  /**
   * The call the fleet wants: primary first, then the queue.
   */
  readonly call: string[];
  readonly why: string;
}

export interface FleetCallInput {
  readonly picture: Pick<FleetPicture, 'hostiles' | 'call' | 'reach'>;
  readonly targeting: Pick<FleetPersonalityTargeting, 'priority' | 'prefer' | 'reach' | 'queue' | 'switch'>;
}

/**
 * The fleet's wanted call. It keeps its live primary unless that is gone, dead or out of reach, or (`on-better`) a
 * candidate of a higher tier is in reach; a new primary is the top candidate. The queue keeps its live entries that
 * are still candidates, in order, then refills from the ranked candidates up to `queue`.
 *
 * @param input - The picture and the targeting.
 * @returns The wanted call and why.
 */
export function toFleetCall(input: FleetCallInput): FleetCallDecision {
  const { picture, targeting } = input;
  const reach = toFleetTargetingReach(targeting.reach, picture.reach);
  const ranked = rankFleetTargets({ hostiles: picture.hostiles, targeting, reach });
  const candidates = new Map(ranked.map((ship) => [ship.id, ship]));
  const current = picture.call[0];
  const kept = current != null ? candidates.get(current) : undefined;
  const top = ranked[0];
  let primary: Maybe<FleetPictureShip> = kept ?? top;
  let why: string;
  if (!top) why = `nothing within ${describeMetres(reach)}`;
  else if (kept && targeting.switch === 'on-better' && fleetTargetTier(targeting.priority, top.role) < fleetTargetTier(targeting.priority, kept.role)) {
    primary = top;
    why = `${top.id} (${top.role}) is a better target than ${kept.id} (${kept.role})`;
  } else if (kept) why = `keeps ${kept.id}`;
  else if (current != null) why = `${current} is down or out of reach; ${top.id} (${top.role}, ${targeting.prefer}) next`;
  else why = `${top.id} (${top.role}, ${targeting.prefer}) within ${describeMetres(reach)}`;
  const call: string[] = [];
  if (primary) {
    call.push(primary.id);
    const queue = [...picture.call.slice(1).filter((id) => candidates.has(id) && id !== primary?.id), ...ranked.map((ship) => ship.id)];
    for (const id of queue) if (call.length <= targeting.queue && !call.includes(id)) call.push(id);
  }
  return { call, why };
}

/**
 * Metres for a message: `24 km`, `800 m`.
 *
 * @param metres - The distance.
 * @returns The text.
 */
export function describeMetres(metres: number): string {
  return metres >= 1000 ? `${Math.round(metres / 100) / 10} km` : `${Math.round(metres)} m`;
}

export interface FleetEngagedInput {
  readonly engage: FleetEngageRule;
  readonly picture: Pick<FleetPicture, 'hostiles' | 'members' | 'reach'>;
  readonly targeting: Pick<FleetPersonalityTargeting, 'reach'>;
  /**
   * Whether it was engaged at the last step.
   */
  readonly was: boolean;
}

/**
 * Whether the fleet is engaged: once engaged it stays so while any hostile is in the picture; otherwise its rule
 * decides: `on-sight` a hostile within lock reach, `in-range` one within targeting reach, `when-attacked` a member
 * shot by a hostile.
 *
 * @param input - The rule, the picture, the targeting and the last state.
 * @returns Engaged, and why when it flips on.
 */
export function toFleetEngaged(input: FleetEngagedInput): { readonly engaged: boolean; readonly why?: string } {
  const { engage, picture, targeting, was } = input;
  const { hostiles } = picture;
  let result: { readonly engaged: boolean; readonly why?: string } = { engaged: false };
  if (hostiles.length && was) result = { engaged: true };
  else if (hostiles.length) {
    const lock = picture.reach.lock;
    const reach = toFleetTargetingReach(targeting.reach, picture.reach);
    const hostileIds = new Set(hostiles.map((ship) => ship.id));
    let trigger: Maybe<string> = null;
    if (engage === 'on-sight' && hostiles[0].distance <= lock) trigger = `${hostiles[0].id} within lock range`;
    else if (engage === 'in-range') {
      const near = hostiles.find((ship) => ship.distance <= reach);
      if (near) trigger = `${near.id} within ${describeMetres(reach)}`;
    } else if (engage === 'when-attacked') {
      const shot = picture.members.find((member) => member.attackedBy.some((id) => hostileIds.has(id)));
      if (shot) trigger = `${shot.attackedBy.find((id) => hostileIds.has(id))} shot ${shot.id}`;
    }
    if (trigger) result = { engaged: true, why: trigger };
  }
  return result;
}

export interface FreeFirePickInput {
  /**
   * Hostiles with their distance from the picking ship.
   */
  readonly hostiles: readonly { readonly id: string; readonly distance: number }[];
  /**
   * Metres: the ship's own reach.
   */
  readonly reach: number;
}

/**
 * A free-firing member's pick: the nearest hostile within its own reach (ties: id).
 *
 * @param input - The hostiles and the ship's reach.
 * @returns The pick; null when none is in reach.
 */
export function pickFreeFireTarget(input: FreeFirePickInput): Maybe<string> {
  let pick: Maybe<{ readonly id: string; readonly distance: number }> = null;
  for (const each of input.hostiles) {
    if (each.distance <= input.reach && (!pick || each.distance < pick.distance || (each.distance === pick.distance && each.id < pick.id))) pick = each;
  }
  return pick?.id ?? null;
}
