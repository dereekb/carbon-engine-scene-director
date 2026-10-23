import type { JsonObject } from '../json';
import type { SceneFleet } from './fleet';
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
 * The ships of a fleet in fleet order: wing commanders in wing order, then squad commanders, then members (wing,
 * squad, member order), the fleet commander first.
 *
 * @param fleet - The fleet.
 * @returns Its ships, each once.
 */
function fleetOrder(fleet: SceneFleet): string[] {
  const ships = new Set<string>([fleet.commander]);
  for (const wing of fleet.wings) if (wing.commander) ships.add(wing.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) if (squad.commander) ships.add(squad.commander);
  for (const wing of fleet.wings) for (const squad of wing.squads) for (const member of squad.members) ships.add(member);
  return [...ships];
}

/**
 * The fleets as they fly once some ships are gone (destroyed): each gone ship leaves its fleet through the same
 * fleet ops a removal runs, so squads anchored on it fall back down the chain as remove_ship does. A gone fleet
 * commander first hands the fleet (update_fleet) to the first live wing commander in wing order, else the first live
 * squad commander, else the first live member. A fleet with nobody alive is dropped. Never written to the document.
 *
 * @param scene - The document.
 * @param gone - The destroyed ships.
 * @returns The live document, what changed per fleet and the repairs' warnings.
 */
export function toLiveFleetScene<S extends { readonly fleets?: SceneFleet[] }>(scene: S, gone: ReadonlySet<string>): LiveFleetView<S> {
  const fleets = scene.fleets ?? [];
  const touched = fleets.filter((fleet) => fleetOrder(fleet).some((ship) => gone.has(ship)));
  if (!touched.length) return { scene, changes: new Map(), warnings: [] };

  const draft: JsonObject = { fleets: structuredClone(fleets) as unknown as JsonObject[] };
  const context: FleetOperationContext = { draft, where: 'live fleets', problems: [], warnings: [] };
  const changes = new Map<string, LiveFleetChange>();
  const dropped = new Set<string>();
  for (const fleet of touched) {
    const order = fleetOrder(fleet);
    const destroyed = order.filter((ship) => gone.has(ship));
    const successor = order.find((ship) => !gone.has(ship));
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
