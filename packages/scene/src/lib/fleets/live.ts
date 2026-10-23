import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../json';
import type { ShipStance } from '../piloting/stance';
import type { SceneFleet } from './fleet';
import { toFleetGroupKey } from './group';
import { applyFleetOperation, type FleetOperationContext, removeShipFromFleets } from './operations';

/**
 * What the live view changed in one fleet.
 */
export interface LiveFleetChange {
  /**
   * The dead fleet commander the fleet's commander acts for (the live view's successor).
   */
  readonly actingFor?: string;
  /**
   * The fleet's destroyed ships, in fleet order.
   */
  readonly destroyed: readonly string[];
  /**
   * Nobody in the fleet is alive: the live view dropped it.
   */
  readonly dropped?: true;
}

export interface LiveFleetView<S> {
  /**
   * The document with the gone ships taken out of their fleets; the same object when no fleet holds one.
   */
  readonly scene: S;
  /**
   * By fleet id, for each fleet that held a gone ship.
   */
  readonly changes: ReadonlyMap<string, LiveFleetChange>;
  /**
   * The fleet repairs' warnings (a squad re-anchored), as remove_ship gives them.
   */
  readonly warnings: readonly string[];
}

/**
 * The page's live fleet state the live view splices over the document.
 */
export interface LiveFleetOverlay {
  /**
   * The live called targets by group key (toFleetGroupKey): each replaces its group's document list, `[]` calling
   * nothing. A key whose group the document no longer holds is ignored.
   */
  readonly calls?: ReadonlyMap<string, readonly string[]>;
  /**
   * The acting fleet commander by fleet id (a personality fleet's succession, FleetCommanders): it replaces the default
   * rule's successor once the commander is gone, and takes the command from a commander that still flies (a flagged
   * FC after its handover). Ignored when it is gone or holds no position in the fleet.
   */
  readonly commanders?: ReadonlyMap<string, string>;
  /**
   * The stance book's group stances by group key (order_fleet's stance order): each replaces its group's document
   * stance, null clearing it. A key whose group the document no longer holds is ignored. The book's per-ship stances
   * go to resolveShipStances instead (piloting/stances.ts).
   */
  readonly stances?: ReadonlyMap<string, Maybe<ShipStance>>;
}

/**
 * Splices live calls over a draft's fleets, wings and squads.
 *
 * @param fleets - The draft's fleets.
 * @param calls - The live calls by group key.
 */
function spliceCalls(fleets: SceneFleet[], calls: ReadonlyMap<string, readonly string[]>): void {
  const splice = (holder: { targets?: string[] }, key: string): void => {
    const targets = calls.get(key);
    if (targets?.length) holder.targets = [...targets];
    else if (targets) delete holder.targets;
  };
  for (const fleet of fleets) {
    splice(fleet, toFleetGroupKey({ fleet: fleet.id, kind: 'fleet', id: fleet.id }));
    for (const wing of fleet.wings) {
      splice(wing, toFleetGroupKey({ fleet: fleet.id, kind: 'wing', id: wing.id }));
      for (const squad of wing.squads) splice(squad, toFleetGroupKey({ fleet: fleet.id, kind: 'squad', id: squad.id }));
    }
  }
}

/**
 * Splices live stances over a draft's fleets, wings and squads.
 *
 * @param fleets - The draft's fleets.
 * @param stances - The live stances by group key; null clears.
 */
function spliceStances(fleets: SceneFleet[], stances: ReadonlyMap<string, Maybe<ShipStance>>): void {
  const splice = (holder: { stance?: ShipStance }, key: string): void => {
    if (!stances.has(key)) return;
    const stance = stances.get(key);
    if (stance) holder.stance = structuredClone(stance);
    else delete holder.stance;
  };
  for (const fleet of fleets) {
    splice(fleet, toFleetGroupKey({ fleet: fleet.id, kind: 'fleet', id: fleet.id }));
    for (const wing of fleet.wings) {
      splice(wing, toFleetGroupKey({ fleet: fleet.id, kind: 'wing', id: wing.id }));
      for (const squad of wing.squads) splice(squad, toFleetGroupKey({ fleet: fleet.id, kind: 'squad', id: squad.id }));
    }
  }
}

/**
 * The ships of a fleet in fleet order: wing commanders in wing order, then squad commanders, then members (wing,
 * squad, member order), the fleet commander first.
 *
 * @param fleet - The fleet.
 * @returns Its ships, each once.
 */
export function toFleetShipOrder(fleet: SceneFleet): string[] {
  const ships = new Set<string>([fleet.commander]);
  for (const wing of fleet.wings) if (wing.commander) ships.add(wing.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) if (squad.commander) ships.add(squad.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) for (const member of squad.members) ships.add(member);
  return [...ships];
}

/**
 * Who commands a fleet once some ships are gone, by the default rule: its fleet commander while alive, else the first
 * live wing commander in wing order, else the first live squad commander, else the first live member. A fleet with a
 * personality picks by its own protocol instead.
 *
 * @param fleet - The fleet.
 * @param gone - The destroyed ships.
 * @returns The acting commander; null when nobody in the fleet is alive.
 */
export function toDefaultFleetSuccessor(fleet: SceneFleet, gone: ReadonlySet<string>): Maybe<string> {
  return toFleetShipOrder(fleet).find((ship) => !gone.has(ship)) ?? null;
}

/**
 * The overlay's acting commander for a fleet, when it holds a position in the fleet, is not gone and is not already
 * its commander.
 *
 * @param fleet - The fleet.
 * @param gone - The destroyed ships.
 * @param commanders - The overlay's acting commanders.
 * @returns The ship, or null.
 */
function overlayCommanderOf(fleet: SceneFleet, gone: ReadonlySet<string>, commanders: Maybe<ReadonlyMap<string, string>>): Maybe<string> {
  const ship = commanders?.get(fleet.id);
  return ship != null && ship !== fleet.commander && !gone.has(ship) && toFleetShipOrder(fleet).includes(ship) ? ship : null;
}

/**
 * The fleets as they fly once some ships are gone (destroyed): each gone ship leaves its fleet through the same
 * fleet ops a removal runs, so squads anchored on it fall back down the chain as remove_ship does. A gone fleet
 * commander first hands the fleet (update_fleet) to its successor: the overlay's acting commander (a personality
 * fleet's designate), else the default rule's (toDefaultFleetSuccessor); an acting commander the overlay names for a
 * fleet whose commander still flies takes the command the same way. A fleet with nobody alive is dropped. The overlay's
 * live calls and stances replace their groups' document lists and stances first. Never written to the document.
 *
 * @param scene - The document.
 * @param gone - The destroyed ships.
 * @param overlay - The page's live fleet state (its live calls and acting commanders).
 * @returns The live document, what changed per fleet and the repairs' warnings.
 */
export function toLiveFleetScene<S extends { readonly fleets?: SceneFleet[] }>(scene: S, gone: ReadonlySet<string>, overlay: LiveFleetOverlay = {}): LiveFleetView<S> {
  const fleets = scene.fleets ?? [];
  const touched = fleets.filter((fleet) => toFleetShipOrder(fleet).some((ship) => gone.has(ship)) || overlayCommanderOf(fleet, gone, overlay.commanders) != null);
  if (!touched.length && !overlay.calls?.size && !overlay.stances?.size) return { scene, changes: new Map(), warnings: [] };

  const cloned = structuredClone(fleets);
  if (overlay.calls?.size) spliceCalls(cloned, overlay.calls);
  if (overlay.stances?.size) spliceStances(cloned, overlay.stances);
  const draft: JsonObject = { fleets: cloned as unknown as JsonObject[] };
  const context: FleetOperationContext = { draft, where: 'live fleets', problems: [], warnings: [] };
  const changes = new Map<string, LiveFleetChange>();
  const dropped = new Set<string>();
  for (const fleet of touched) {
    const order = toFleetShipOrder(fleet);
    const destroyed = order.filter((ship) => gone.has(ship));
    const successor = overlayCommanderOf(fleet, gone, overlay.commanders) ?? toDefaultFleetSuccessor(fleet, gone);
    if (!successor) {
      dropped.add(fleet.id);
      changes.set(fleet.id, { destroyed, dropped: true });
      continue;
    }
    const acting = successor !== fleet.commander ? fleet.commander : undefined;
    if (acting) applyFleetOperation({ op: 'update_fleet', fleet: fleet.id, set: { commander: successor } }, context);
    changes.set(fleet.id, { ...(acting ? { actingFor: acting } : {}), destroyed });
  }
  draft['fleets'] = (draft['fleets'] as unknown as SceneFleet[]).filter((fleet) => !dropped.has(fleet.id)) as unknown as JsonObject[];
  for (const id of gone) removeShipFromFleets(id, context);
  return { scene: { ...scene, fleets: draft['fleets'] as unknown as SceneFleet[] }, changes, warnings: context.warnings };
}
