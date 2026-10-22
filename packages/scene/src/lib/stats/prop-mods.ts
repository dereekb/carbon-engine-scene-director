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
 * The hull-sized table holds Tech II type ids and names only (ESI, 2026-10-21). A module's
 * attributes come from the SDE or explicit values; BAKED_PROP_MODS keeps the numbers of the
 * modules the page needs most, for when the SDE is absent.
 */

import type { Maybe } from '@dereekb/util';
import { MAX_TYPE_NAME_LENGTH } from '../json';

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
  /**
   * duration (73): ms per cycle as fitted; the Afterburner skill shortens an afterburner's.
   */
  readonly duration?: Maybe<number>;
  readonly typeID?: Maybe<number>;
  readonly name?: Maybe<string>;
}

/**
 * A prop mod whose numbers ship with the code.
 */
export interface BakedPropMod extends PropModStats {
  readonly typeID: number;
  readonly name: string;
  readonly duration: number;
}

/**
 * The SDE's rigSize attribute (1547): 1 small (frigates, destroyers), 2 medium (cruisers,
 * battlecruisers), 3 large (battleships), 4 capital.
 */
export type RigSize = 1 | 2 | 3 | 4;

/**
 * A hull's size class, as the engine audio stems name it (`ship_engine_<size>_...`).
 */
export type HullSizeClass = 'S' | 'M' | 'L' | 'XL';

export const HULL_SIZE_CLASSES: Readonly<Record<RigSize, HullSizeClass>> = { 1: 'S', 2: 'M', 3: 'L', 4: 'XL' };

/**
 * Reads a rigSize: 1, 2, 3 or 4.
 *
 * @param value - A candidate rigSize.
 * @returns The rigSize, or null when the value is not one.
 */
export function readRigSize(value: unknown): Maybe<RigSize> {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

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

/**
 * What a ship names as its prop mod: an EVE type name, a type id, `"mwd"` / `"ab"` (the
 * Tech II module of that kind sized for the hull) or `"none"` (no prop mod).
 */
export type PropModModule = string | number;

export const PROP_MOD_MODULE_NONE = 'none';

export const PROP_MOD_MODULE_MWD = 'mwd';

export const PROP_MOD_MODULE_AB = 'ab';

/**
 * What a ship naming no prop mod fits: the hull-sized Tech II microwarpdrive.
 */
export const DEFAULT_PROP_MOD_MODULE: PropModModule = PROP_MOD_MODULE_MWD;

/**
 * The prop mod modules that are no EVE type: a kind sized for the hull, or none.
 */
export type PropModModuleKeyword = typeof PROP_MOD_MODULE_NONE | typeof PROP_MOD_MODULE_MWD | typeof PROP_MOD_MODULE_AB;

const PROP_MOD_MODULE_KEYWORDS: ReadonlyMap<string, PropModModuleKeyword> = new Map<string, PropModModuleKeyword>([
  ['mwd', PROP_MOD_MODULE_MWD],
  ['microwarpdrive', PROP_MOD_MODULE_MWD],
  ['ab', PROP_MOD_MODULE_AB],
  ['afterburner', PROP_MOD_MODULE_AB],
  ['none', PROP_MOD_MODULE_NONE]
]);

/**
 * Canonicalizes a prop mod module: `mwd` / `microwarpdrive` → "mwd", `ab` / `afterburner` →
 * "ab", `none` → "none" (any case); a positive safe integer or an all-digits string is a type
 * id; any other name of at most MAX_TYPE_NAME_LENGTH is kept as written (trimmed).
 *
 * @param value - The candidate module.
 * @param where - Where it sits, for the problem.
 * @param problems - Collects the problem when the value is not a module.
 * @returns The canonical module, or null when the value is not one.
 */
export function readPropModModule(value: unknown, where: string, problems: string[]): Maybe<PropModModule> {
  let module: Maybe<PropModModule> = null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) module = value;
  else if (typeof value === 'string' && value.trim() && value.trim().length <= MAX_TYPE_NAME_LENGTH) {
    const trimmed = value.trim();
    const keyword = PROP_MOD_MODULE_KEYWORDS.get(trimmed.toLowerCase());
    if (keyword) module = keyword;
    else if (/^\d+$/u.test(trimmed) && Number.isSafeInteger(Number(trimmed)) && Number(trimmed) > 0) module = Number(trimmed);
    else module = trimmed;
  } else problems.push(`${where} must be a prop mod: an EVE module name of at most ${MAX_TYPE_NAME_LENGTH} characters, a type id, "mwd", "ab" or "none"`);
  return module;
}

/**
 * Whether a module is one of the keywords rather than an EVE type.
 *
 * @param module - A canonical module.
 * @returns True for "mwd", "ab" and "none".
 */
export function isPropModModuleKeyword(module: PropModModule): module is PropModModuleKeyword {
  return module === PROP_MOD_MODULE_NONE || module === PROP_MOD_MODULE_MWD || module === PROP_MOD_MODULE_AB;
}

/**
 * Normalizes a module name for matching: NFKC, lower case, whole-word `mwd` →
 * `microwarpdrive` and `ab` → `afterburner`, single spaces. "50MN MWD II" matches
 * "50MN Microwarpdrive II".
 *
 * @param name - A module name.
 * @returns The match key.
 */
export function normalizePropModName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bmwd\b/gu, 'microwarpdrive')
    .replace(/\bab\b/gu, 'afterburner')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The kind a module name names, by its words.
 *
 * @param name - A module name.
 * @returns The kind, or null when the name names neither a microwarpdrive nor an afterburner.
 */
export function propModKindOfName(name: string): Maybe<PropModKind> {
  const normalized = normalizePropModName(name);
  let kind: Maybe<PropModKind> = null;
  if (normalized.includes('microwarpdrive')) kind = 'microwarpdrive';
  else if (normalized.includes('afterburner')) kind = 'afterburner';
  return kind;
}

/**
 * The prop mods whose numbers ship with the code: the eight hull-sized Tech II modules and
 * the five the TFIs example names. Attributes as fitted, before skills, from tools-core's SDE
 * build 3632936 (typeDogma attributes 20, 567, 796, 554 and 73), checked 2026-10-22.
 */
export const BAKED_PROP_MODS: readonly BakedPropMod[] = [
  { typeID: 438, name: '1MN Afterburner II', kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e6, massAddition: 5e5, signatureRadiusBonus: 0, duration: 10_000 },
  { typeID: 440, name: '5MN Microwarpdrive II', kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e6, massAddition: 5e5, signatureRadiusBonus: 475, duration: 10_000 },
  { typeID: 12058, name: '10MN Afterburner II', kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 0, duration: 10_000 },
  { typeID: 12076, name: '50MN Microwarpdrive II', kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 475, duration: 10_000 },
  { typeID: 12068, name: '100MN Afterburner II', kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 0, duration: 10_000 },
  { typeID: 12084, name: '500MN Microwarpdrive II', kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 475, duration: 10_000 },
  { typeID: 41239, name: '10000MN Afterburner II', kind: 'afterburner', speedFactor: 135, speedBoostFactor: 1.5e9, massAddition: 5e8, signatureRadiusBonus: 0, duration: 20_000 },
  { typeID: 41253, name: '50000MN Microwarpdrive II', kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e9, massAddition: 5e8, signatureRadiusBonus: 475, duration: 20_000 },
  { typeID: 5945, name: '500MN Cold-Gas Enduring Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 500, duration: 10_000 },
  { typeID: 5975, name: '50MN Cold-Gas Enduring Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 500, duration: 10_000 },
  { typeID: 35662, name: '500MN Quad LiF Restrained Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 450, duration: 10_000 },
  { typeID: 35660, name: '50MN Quad LiF Restrained Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e7, massAddition: 5e6, signatureRadiusBonus: 450, duration: 10_000 },
  { typeID: 41238, name: '10000MN Monopropellant Enduring Afterburner', kind: 'afterburner', speedFactor: 125, speedBoostFactor: 1.5e9, massAddition: 5e8, signatureRadiusBonus: 0, duration: 20_000 }
];

const BAKED_PROP_MODS_BY_ID: ReadonlyMap<number, BakedPropMod> = new Map(BAKED_PROP_MODS.map((propMod) => [propMod.typeID, propMod]));

const BAKED_PROP_MODS_BY_NAME: ReadonlyMap<string, BakedPropMod> = new Map(BAKED_PROP_MODS.map((propMod) => [normalizePropModName(propMod.name), propMod]));

/**
 * A baked prop mod by type id or by name (matched as normalizePropModName does).
 *
 * @param module - A type id or a module name.
 * @returns The baked module, or null when it is not baked.
 */
export function findBakedPropMod(module: PropModModule): Maybe<BakedPropMod> {
  return (typeof module === 'number' ? BAKED_PROP_MODS_BY_ID.get(module) : BAKED_PROP_MODS_BY_NAME.get(normalizePropModName(module))) ?? null;
}
