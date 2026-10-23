import type { Maybe } from '@dereekb/util';
import type { SceneFleet } from '../fleets/fleet';
import { toFleetShipOrder } from '../fleets/live';
import { type FleetSuccessionStep, MIN_FLEET_HANDOVER } from './personality';

/**
 * Command in a personality fleet: who takes over when the FC goes down (the succession protocol), how long that takes
 * (the handover), and how long the acting FC takes over each decision (the FC delay). Times are whole seconds, which
 * are Destiny ticks.
 */

/**
 * Seconds: an FC of ability 0 waits up to this long over a decision (half to all of it); ability 1 decides at once.
 */
export const MAX_FC_DECISION_DELAY = 10;

export interface FleetSuccessorInput {
  readonly fleet: SceneFleet;
  /**
   * Destroyed ships (the FC among them).
   */
  readonly gone: ReadonlySet<string>;
  readonly steps: readonly FleetSuccessionStep[];
  /**
   * A ship's command ability; null for a pilot that is not FC-capable.
   */
  readonly abilityOf: (ship: string) => Maybe<number>;
}

export interface FleetSuccessor {
  readonly ship: string;
  /**
   * The step that picked it.
   */
  readonly step: FleetSuccessionStep;
  /**
   * Its command ability; 0 for a pilot that is not FC-capable.
   */
  readonly ability: number;
}

/**
 * The designate: the protocol's steps in order over the live members (the fleet commander left out), the first step
 * any member meets deciding. `most-able`: the FC-capable member with the highest ability (ties: fleet order); `chain`:
 * wing commanders in wing order, then squad commanders; `anyone`: fleet order.
 *
 * @param input - The fleet, the gone ships, the protocol and the abilities.
 * @returns The designate, or null when no step finds a live member (leaderless).
 */
export function toFleetSuccessor(input: FleetSuccessorInput): Maybe<FleetSuccessor> {
  const { fleet, gone, steps, abilityOf } = input;
  const live = toFleetShipOrder(fleet).filter((ship) => ship !== fleet.commander && !gone.has(ship));
  const chain = new Set<string>();
  for (const wing of fleet.wings) if (wing.commander) chain.add(wing.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) if (squad.commander) chain.add(squad.commander);
  let successor: Maybe<FleetSuccessor> = null;
  for (const step of steps) {
    let ship: Maybe<string> = null;
    if (step === 'most-able') {
      let best = -1;
      for (const each of live) {
        const ability = abilityOf(each);
        if (ability != null && ability > best) {
          ship = each;
          best = ability;
        }
      }
    } else if (step === 'chain') ship = [...chain].find((each) => live.includes(each)) ?? null;
    else ship = live[0] ?? null;
    if (ship != null) {
      successor = { ship, step, ability: abilityOf(ship) ?? 0 };
      break;
    }
  }
  return successor;
}

export interface FleetHandoverInput {
  /**
   * The designate's ability, 0..1.
   */
  readonly ability: number;
  /**
   * The personality's longest handover, seconds.
   */
  readonly handover: number;
  /**
   * A uniform number in [0, 1).
   */
  readonly unit: number;
}

/**
 * How long the designate takes to take command: `ceil(2 + (1 − a) × (handover − 2) × (0.5 + 0.5u))` seconds, so
 * ability 1 always takes MIN_FLEET_HANDOVER and ability 0 between half and all of `handover`.
 *
 * @param input - The ability, the personality's handover and a draw.
 * @returns Whole seconds (ticks).
 */
export function toHandoverTicks(input: FleetHandoverInput): number {
  const ability = Math.max(0, Math.min(1, input.ability));
  return Math.ceil(MIN_FLEET_HANDOVER + (1 - ability) * Math.max(0, input.handover - MIN_FLEET_HANDOVER) * (0.5 + 0.5 * input.unit));
}

/**
 * How long the acting FC takes over a decision: `round((1 − a) × MAX_FC_DECISION_DELAY × (0.5 + 0.5u))` seconds.
 *
 * @param ability - The FC's ability, 0..1.
 * @param unit - A uniform number in [0, 1).
 * @returns Whole seconds (ticks); 0 for ability 1.
 */
export function toFcDelayTicks(ability: number, unit: number): number {
  return Math.round((1 - Math.max(0, Math.min(1, ability))) * MAX_FC_DECISION_DELAY * (0.5 + 0.5 * unit));
}
