/**
 * Stand-in combat in the page: without EVE data (`--eve-data off`, `?eve=off`) every ship carries a stand-in fitting
 * with guns for its class (combat/stand-ins.ts), in place of its own fit or default weapons, neither of which can
 * evaluate offline. The fitting opens the combat pipeline one level below the fit:
 *
 * - its module specs (StandInModuleSpecsOf) give the activation layer turret activations and combat numbers, so locks,
 *   cycles, GetAccuracy hits, the damage model, kills, free fire and the FC brain's reach run unchanged;
 * - its `standIn` puts the class's defense and targeting on the flight (ResolveFlight), so the damage model tracks the
 *   ship and ShipLocks can lock;
 * - StandInHullOf gives the director a hull carrying the document's `standIn.class`, so the flight numbers, prop mod
 *   size and explosion timing follow the same class.
 *
 * No EVE file is asked for: the guns' type id is never looked up and nothing mounts on a cube.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { isInlineFit, type SceneShip, STAND_IN_FIT_KEY, STAND_IN_GUN_TYPE_ID, standInActivationOf, type StandInCombat, standInGunKeyOf, standInTurretNumbersOf, type ShipFitting } from '@scene-director/scene';
import type { ShipHull } from './destiny';
import { PROP_MOD_GROUP, type ResolvedShipFitting, type ShipFitModule } from './fittings';
import type { ShipModuleSpec } from './modules';

export interface StandInFittingInput {
  /**
   * The document ship (its own `fit` is named in the note).
   */
  readonly doc: Pick<SceneShip, 'fit'>;
  /**
   * Its class's stand-in numbers.
   */
  readonly combat: StandInCombat;
  /**
   * The prop mod it flies; null for "none".
   */
  readonly propMod: Maybe<{ readonly name: string; readonly typeID: number }>;
  /**
   * The no-EVE-data mode's note.
   */
  readonly note: Maybe<string>;
}

/**
 * A ship's stand-in fitting: its class's guns as `high-0 … high-<n−1>`, plus the prop mod it flies as `mid-0`.
 *
 * @param input - The ship, its class's numbers, its prop mod and the mode's note.
 * @returns The fitting, keyed "stand-in", with no dogma and nothing pending.
 */
export function StandInFittingOf(input: StandInFittingInput): ResolvedShipFitting {
  const { doc, combat, propMod } = input;
  const guns: ShipFitModule[] = Array.from({ length: combat.guns }, (_unused, index) => ({ key: standInGunKeyOf(index), name: combat.gun.name, typeID: STAND_IN_GUN_TYPE_ID, groupID: 0, slot: 'high', category: 'weapon', weapon: 'turret', line: index + 1 }));
  const prop: ShipFitModule[] = propMod ? [{ key: 'mid-0', name: propMod.name, typeID: propMod.typeID, groupID: PROP_MOD_GROUP, slot: 'mid', category: 'prop', prop: true, line: 0, note: 'the prop mod the ship flies' }] : [];
  const modules = [...guns, ...prop];
  const own = doc.fit ? (isInlineFit(doc.fit) ? 'inline' : doc.fit) : null;
  const note = [`${input.note ?? 'no EVE data'}: stand-in guns for its class (${combat.shipClass})`, own ? `its fit "${own}" needs the EVE data` : null].filter(Boolean).join('; ');
  const fitting: ShipFitting = {
    hull: `${combat.shipClass[0].toUpperCase()}${combat.shipClass.slice(1)} stand-in`,
    name: 'Stand-in weapons',
    modules,
    drones: [],
    charges: [],
    cargo: [],
    implants: [],
    unknown: [],
    empty: { low: 0, mid: 0, high: 0, rig: 0, subsystem: 0, service: 0 },
    warnings: []
  };
  return { text: '', key: STAND_IN_FIT_KEY, fitting, modules, dogma: null, pending: false, note, typeIDs: [], standIn: combat };
}

/**
 * The activation layer's specs for a stand-in fitting: one turret per gun; the prop mod stays Destiny's.
 *
 * @param fitting - The stand-in fitting.
 * @returns The specs; none for a fitting without `standIn`.
 */
export function StandInModuleSpecsOf(fitting: ResolvedShipFitting): ShipModuleSpec[] {
  const { standIn } = fitting;
  if (!standIn) return [];
  return fitting.modules.flatMap((module, index): ShipModuleSpec[] => (module.weapon === 'turret' ? [{ key: module.key, name: module.name, typeID: STAND_IN_GUN_TYPE_ID, offline: false, activation: standInActivationOf(standIn, module.key), combat: standInTurretNumbersOf(standIn, index) }] : []));
}

/**
 * The hull a stand-in flies by: the document's `standIn.class`, with no SOF category or radius.
 *
 * @param doc - The document ship.
 * @returns The hull; null without a class (the cruiser class then, as ShipClassOf gives).
 */
export function StandInHullOf(doc: Pick<SceneShip, 'standIn'>): Maybe<ShipHull> {
  const shipClass = doc.standIn?.class;
  return shipClass ? { category: null, radius: null, shipClass } : null;
}
