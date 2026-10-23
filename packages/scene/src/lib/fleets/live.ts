import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../json';
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
 * The fleets as they fly once some ships are gone (destroyed): each gone ship leaves its fleet through the same
 * fleet ops a removal runs, so squads anchored on it fall back down the chain as remove_ship does. A gone fleet
 * commander first hands the fleet (update_fleet) to its successor (toDefaultFleetSuccessor). A fleet with nobody alive
 * is dropped. The overlay's live calls replace
 * their groups' document lists first. Never written to the document.
 *
 * @param scene - The document.
 * @param gone - The destroyed ships.
 * @param overlay - The page's live fleet state (its live calls).
 * @returns The live document, what changed per fleet and the repairs' warnings.
 */
export function toLiveFleetScene<S extends { readonly fleets?: SceneFleet[] }>(scene: S, gone: ReadonlySet<string>, overlay: LiveFleetOverlay = {}): LiveFleetView<S> {
  const fleets = scene.fleets ?? [];
  const touched = fleets.filter((fleet) => toFleetShipOrder(fleet).some((ship) => gone.has(ship)));
  if (!touched.length && !overlay.calls?.size) return { scene, changes: new Map(), warnings: [] };

  const cloned = structuredClone(fleets);
  if (overlay.calls?.size) spliceCalls(cloned, overlay.calls);
  const draft: JsonObject = { fleets: cloned as unknown as JsonObject[] };
  const context: FleetOperationContext = { draft, where: 'live fleets', problems: [], warnings: [] };
  const changes = new Map<string, LiveFleetChange>();
  const dropped = new Set<string>();
  for (const fleet of touched) {
    const order = toFleetShipOrder(fleet);
    const destroyed = order.filter((ship) => gone.has(ship));
    const successor = toDefaultFleetSuccessor(fleet, gone);
    if (!successor) {
      dropped.add(fleet.id);
      changes.set(fleet.id, { destroyed, dropped: true });
      continue;
    }
    const acting = gone.has(fleet.commander) ? fleet.commander : undefined;
    if (acting) applyFleetOperation({ op: 'update_fleet', fleet: fleet.id, set: { commander: successor } }, context);
    changes.set(fleet.id, { ...(acting ? { actingFor: acting } : {}), destroyed });
  }
  draft['fleets'] = (draft['fleets'] as unknown as SceneFleet[]).filter((fleet) => !dropped.has(fleet.id)) as unknown as JsonObject[];
  for (const id of gone) removeShipFromFleets(id, context);
  return { scene: { ...scene, fleets: draft['fleets'] as unknown as SceneFleet[] }, changes, warnings: context.warnings };
}
