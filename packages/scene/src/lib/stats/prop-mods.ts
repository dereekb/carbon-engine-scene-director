/**
 * Propulsion modules (group 46): microwarpdrives and afterburners.
 *
 * Their effects (6730 moduleBonusMicrowarpdrive, 6731 moduleBonusAfterburner) carry no
 * dogma modifiers; the game applies them in code. computeShipStats follows the game as
 * Pyfa's Effect6730 / Effect6731 do and EVE University's "Propulsion equipment" page
 * states: add massAddition to the ship's mass, then multiply maxVelocity by
 * `1 + speedFactor × speedBoostFactor / mass / 100`, and (MWD only) the signature radius
 * by `1 + signatureRadiusBonus / 100`.
 *
 * The hull-sized table holds Tech II type ids and names only (ESI, 2026-10-21); a
 * module's attributes always come from the SDE or from explicit values.
 */

import type { Maybe } from '@dereekb/util';

export type PropModKind = 'microwarpdrive' | 'afterburner';

/**
 * The attributes of a prop mod as fitted (before the pilot's skills).
 */
export interface PropModStats {
  readonly kind: PropModKind;
  /**
   * speedFactor (20): the percent velocity boost before the thrust/mass scaling.
   */
  readonly speedFactor: number;
  /**
   * speedBoostFactor (567): the module's thrust in newtons.
   */
  readonly speedBoostFactor: number;
  /**
   * massAddition (796): kg added to the ship while the module runs.
   */
  readonly massAddition: number;
  /**
   * signatureRadiusBonus (554): percent signature bloom; 0 for an afterburner.
   */
  readonly signatureRadiusBonus: number;
  readonly typeID?: Maybe<number>;
  readonly name?: Maybe<string>;
}

/**
 * The SDE's rigSize attribute (1547): 1 small (frigates, destroyers), 2 medium (cruisers,
 * battlecruisers), 3 large (battleships), 4 capital.
 */
export type RigSize = 1 | 2 | 3 | 4;

export interface PropModType {
  readonly typeID: number;
  readonly name: string;
}

/**
 * The Tech II prop mod sized for each hull size.
 */
export const HULL_SIZED_PROP_MODS: Readonly<Record<RigSize, Readonly<Record<PropModKind, PropModType>>>> = {
  1: { microwarpdrive: { typeID: 440, name: '5MN Microwarpdrive II' }, afterburner: { typeID: 438, name: '1MN Afterburner II' } },
  2: { microwarpdrive: { typeID: 12076, name: '50MN Microwarpdrive II' }, afterburner: { typeID: 12058, name: '10MN Afterburner II' } },
  3: { microwarpdrive: { typeID: 12084, name: '500MN Microwarpdrive II' }, afterburner: { typeID: 12068, name: '100MN Afterburner II' } },
  4: { microwarpdrive: { typeID: 41253, name: '50000MN Microwarpdrive II' }, afterburner: { typeID: 41239, name: '10000MN Afterburner II' } }
};

export interface FindHullSizedPropModInput {
  readonly rigSize: Maybe<number>;
  readonly kind: PropModKind;
}

/**
 * The Tech II prop mod of a kind sized for a hull.
 *
 * @param input - The hull's rigSize and the kind of prop mod.
 * @returns The module's type id and name, or null when the size is unknown.
 */
export function findHullSizedPropMod(input: FindHullSizedPropModInput): Maybe<PropModType> {
  const sized = input.rigSize == null ? undefined : (HULL_SIZED_PROP_MODS as Readonly<Record<number, Maybe<Readonly<Record<PropModKind, PropModType>>>>>)[input.rigSize];
  return sized?.[input.kind] ?? null;
}

const PROP_MOD_KIND_ALIASES: ReadonlyMap<string, PropModKind> = new Map<string, PropModKind>([
  ['mwd', 'microwarpdrive'],
  ['microwarpdrive', 'microwarpdrive'],
  ['ab', 'afterburner'],
  ['afterburner', 'afterburner']
]);

/**
 * Reads a prop mod kind: "mwd" / "microwarpdrive" or "ab" / "afterburner", any case.
 *
 * @param value - A candidate kind.
 * @returns The kind, or null when the value is not one.
 */
export function readPropModKind(value: unknown): Maybe<PropModKind> {
  return typeof value === 'string' ? (PROP_MOD_KIND_ALIASES.get(value.trim().toLowerCase()) ?? null) : null;
}
