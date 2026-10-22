/**
 * Follow the FC, the runtime-free half: what each fleet member flies (its resolved anchor and its formation slot)
 * and how far from its slot it may be and still count as in formation. The viewer's FleetFollowing turns these
 * plans into Destiny steering.
 */

import type { SceneVector } from '../scene';
import type { SceneFleet } from './fleet';
import { type FleetFormationSlot, toFleetFormationSlots, toFleetGroupOffsets } from './formation';
import { type FleetAnchor, toFleetAnchors } from './membership';

/**
 * What a fleet member flies while following its fleet.
 */
export interface FleetFollowPlan {
  readonly fleet: string;
  /**
   * The ship whose heading frames the slot: the FC, or the leader of a group flying apart.
   */
  readonly commander: string;
  /**
   * Exactly toFleetMemberships' anchor for the ship.
   */
  readonly anchor: FleetAnchor;
  /**
   * Its formation slot; `slot.anchor === anchor.ship`.
   */
  readonly slot: FleetFormationSlot;
}

export interface FleetFollowPlansInput {
  readonly fleet: SceneFleet;
  /**
   * The FC's document position: the layout runs there, so a fleet laid out there gets its own slots back.
   */
  readonly origin: SceneVector;
  /**
   * The FC's document yaw, degrees.
   */
  readonly heading: number;
  /**
   * Each ship's radius in metres (its ball radius).
   */
  readonly radiusOf: (ship: string) => number;
}

/**
 * Every non-FC fleet ship's follow plan: its anchor from toFleetAnchors (never re-derived) and its slot from
 * toFleetFormationSlots.
 *
 * @param input - The fleet, the FC's document position and yaw, and each ship's radius.
 * @returns Each plan keyed by ship id, in toFleetAnchors' order; the FC has none.
 * @throws {Error} As layoutFleetFormation does, which never happens for a normalized fleet within EVE's fleet size.
 */
export function toFleetFollowPlans(input: FleetFollowPlansInput): Map<string, FleetFollowPlan> {
  const { fleet } = input;
  const slots = toFleetFormationSlots(input);
  const plans = new Map<string, FleetFollowPlan>();
  for (const [ship, membership] of toFleetAnchors(fleet)) {
    const slot = slots.get(ship);
    if (membership.anchor && slot) plans.set(ship, { fleet: fleet.id, commander: fleet.commander, anchor: membership.anchor, slot });
  }
  return plans;
}

export interface FleetGroupFollowPlansInput extends FleetFollowPlansInput {
  /**
   * The ship the group flies on; it flies its own order, so it has no plan.
   */
  readonly leader: string;
  /**
   * The group's ships (the leader among them).
   */
  readonly ships: readonly string[];
}

/**
 * The follow plans of a wing or squad flying apart from its fleet on its leader (a live order_fleet move or warp): every
 * group ship but the leader keeps its toFleetAnchors anchor and fleet slot when that anchor is in the group, and
 * otherwise keeps range on the leader at its toFleetGroupOffsets offset (direction = the unit offset, slot range =
 * |offset| − the two radii, anchor range = that slot range rounded to the metre). Every plan's `commander` (the ship whose
 * heading frames the slot) is the leader. This is the one place the page flies anchors other than toFleetMemberships': the
 * document's anchors stay as they are, and the plans end when the group regroups.
 *
 * @param input - The fleet plans' input, the leader and the group's ships.
 * @returns Each group ship's plan but the leader's, keyed by ship id, in `ships` order.
 * @throws {Error} As toFleetGroupOffsets does.
 */
export function toFleetGroupFollowPlans(input: FleetGroupFollowPlansInput): Map<string, FleetFollowPlan> {
  const { fleet, leader, ships, radiusOf } = input;
  const group = new Set(ships);
  const anchors = toFleetAnchors(fleet);
  const slots = toFleetFormationSlots(input);
  const offsets = toFleetGroupOffsets(input);
  const plans = new Map<string, FleetFollowPlan>();
  for (const ship of ships) {
    if (ship === leader) continue;
    const anchor = anchors.get(ship)?.anchor;
    const slot = slots.get(ship);
    const offset = offsets.get(ship);
    if (anchor && slot && group.has(anchor.ship)) {
      plans.set(ship, { fleet: fleet.id, commander: leader, anchor, slot });
    } else if (offset) {
      const reach = Math.hypot(offset[0], offset[1], offset[2]);
      const direction: SceneVector = reach > 0 ? [offset[0] / reach, offset[1] / reach, offset[2] / reach] : [0, 0, -1];
      const range = Math.max(0, reach - radiusOf(leader) - radiusOf(ship));
      plans.set(ship, { fleet: fleet.id, commander: leader, anchor: { ship: leader, range: Math.round(range) }, slot: { anchor: leader, direction, range } });
    }
  }
  return plans;
}

/**
 * Metres a following ship may sit from its slot and still count as in formation, at least.
 */
export const FOLLOW_TOLERANCE = 200;

/**
 * The share of the slot range added to FOLLOW_TOLERANCE: a far slot swings further on a turn.
 */
export const FOLLOW_TOLERANCE_FRACTION = 0.05;

/**
 * Seconds of the anchor's speed added to FOLLOW_TOLERANCE: steering re-aims once a tick, so a member as fast as its
 * anchor sits about two ticks back at full speed.
 */
export const FOLLOW_TOLERANCE_SECONDS = 2.5;

export interface FollowToleranceInput {
  /**
   * The slot's range, metres surface to surface.
   */
  readonly slotRange: number;
  /**
   * The anchor's speed, m/s.
   */
  readonly anchorSpeed: number;
}

/**
 * How far from its slot a following ship may be and still count as in formation.
 *
 * @param input - The slot range and the anchor's speed.
 * @returns Metres: FOLLOW_TOLERANCE, plus FOLLOW_TOLERANCE_FRACTION of the slot range, plus FOLLOW_TOLERANCE_SECONDS of
 *   the anchor's speed.
 */
export function toFollowTolerance(input: FollowToleranceInput): number {
  return FOLLOW_TOLERANCE + FOLLOW_TOLERANCE_FRACTION * Math.max(0, input.slotRange) + FOLLOW_TOLERANCE_SECONDS * Math.max(0, input.anchorSpeed);
}
