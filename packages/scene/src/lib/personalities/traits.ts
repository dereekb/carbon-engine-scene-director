import type { Maybe } from '@dereekb/util';
import { combatHash, combatShuffle } from '../combat/random';
import type { SceneFleet } from '../fleets/fleet';
import { toFleetShipOrder } from '../fleets/live';
import type { FleetTraitRange, ResolvedFleetPersonality } from './personality';
import type { SceneShipPilotTraits } from './pilots';

/**
 * Pilot traits in a personality fleet: a pilot's authored `command` / `reaction` win; unset ones are seeded draws from
 * the personality, keyed by the scene's combat seed, the fleet, the ship and the trait, so a reload draws the same.
 * The FC and `command.backups` backups draw a command ability (they are FC-capable); every member draws a reaction.
 */

const TWO_POW_53 = 2 ** 53;

/**
 * A uniform number in [0, 1) for a key on the combat seed.
 *
 * @param seed - The scene's combat seed.
 * @param key - What the draw is for.
 * @returns The number.
 */
export function fleetTraitUnit(seed: number, key: string): number {
  return combatHash(`${seed}|${key}`) / TWO_POW_53;
}

/**
 * A trait from a personality range: the number itself, or a seeded draw between `[lo, hi]`.
 *
 * @param range - The range.
 * @param unit - A uniform number in [0, 1).
 * @returns The trait, 0..1.
 */
export function drawFleetTrait(range: FleetTraitRange, unit: number): number {
  return typeof range === 'number' ? range : range[0] + (range[1] - range[0]) * unit;
}

/**
 * Where a ship's traits came from: all authored on its pilot, all drawn from the personality, or some of each.
 */
export type FleetPilotTraitSource = 'pilot' | 'personality' | 'mixed';

export interface FleetPilotTraits {
  /**
   * Its command ability; absent for a pilot that is not FC-capable.
   */
  readonly command?: number;
  readonly reaction: number;
  readonly source: FleetPilotTraitSource;
}

/**
 * The members besides the FC that draw a command ability: wing commanders, squad commanders, members of boost squads,
 * then the other members in a seeded order, up to `count`.
 *
 * @param fleet - The fleet.
 * @param count - How many backups.
 * @param seed - The scene's combat seed.
 * @returns The backups, best first.
 */
export function toFleetBackups(fleet: SceneFleet, count: number, seed: number): string[] {
  const ranked = new Set<string>();
  for (const wing of fleet.wings) if (wing.commander) ranked.add(wing.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) if (squad.commander) ranked.add(squad.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) if (squad.role === 'boost') for (const member of squad.members) ranked.add(member);
  const rest = toFleetShipOrder(fleet).filter((ship) => !ranked.has(ship));
  for (const ship of combatShuffle(seed, `backups|${fleet.id}`, rest)) ranked.add(ship);
  ranked.delete(fleet.commander);
  return [...ranked].slice(0, Math.max(0, count));
}

export interface FleetPilotTraitsInput {
  readonly fleet: SceneFleet;
  readonly personality: Pick<ResolvedFleetPersonality, 'command' | 'pilots'>;
  /**
   * A ship's authored traits.
   */
  readonly pilotOf: (ship: string) => Maybe<Pick<SceneShipPilotTraits, 'command' | 'reaction'>>;
  readonly seed: number;
}

/**
 * Every member's traits in a personality fleet: authored traits win, the rest are seeded draws (`trait|<fleet>|<ship>|
 * command` and `…|reaction`). The FC and the backups draw `command.ability`; any member whose pilot sets `command` is
 * FC-capable too.
 *
 * @param input - The fleet, its personality, the authored traits and the seed.
 * @returns Traits per ship, in fleet order.
 */
export function toFleetPilotTraits(input: FleetPilotTraitsInput): Map<string, FleetPilotTraits> {
  const { fleet, personality, pilotOf, seed } = input;
  const capable = new Set([fleet.commander, ...toFleetBackups(fleet, personality.command.backups, seed)]);
  const traits = new Map<string, FleetPilotTraits>();
  for (const ship of toFleetShipOrder(fleet)) {
    const authored = pilotOf(ship) ?? {};
    const draw = (trait: string, range: FleetTraitRange) => drawFleetTrait(range, fleetTraitUnit(seed, `trait|${fleet.id}|${ship}|${trait}`));
    const command = authored.command ?? (capable.has(ship) ? draw('command', personality.command.ability) : undefined);
    const reaction = authored.reaction ?? draw('reaction', personality.pilots.reaction);
    const authoredCount = (authored.reaction != null ? 1 : 0) + (authored.command != null ? 1 : 0);
    const drawnCount = (authored.reaction == null ? 1 : 0) + (authored.command == null && command != null ? 1 : 0);
    let source: FleetPilotTraitSource = 'mixed';
    if (!drawnCount) source = 'pilot';
    else if (!authoredCount) source = 'personality';
    traits.set(ship, { ...(command != null ? { command } : {}), reaction, source });
  }
  return traits;
}
