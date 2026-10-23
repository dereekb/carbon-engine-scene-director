/**
 * The EVE dogma data a fit needs, as the hub serves it from tools-core's SDE (`/dogma/types`, `/dogma/skills`) and the
 * page and the dogma evaluator read it: types with their attributes and effects, the effects' modifiers, and the
 * attributes' stacking rules. Plain JSON, no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import type { EftSlot } from './eft';

/**
 * One `modifierInfo` entry of a dogma effect.
 */
export interface DogmaModifierRecord {
  /**
   * ItemModifier, LocationModifier, LocationGroupModifier, LocationRequiredSkillModifier, OwnerRequiredSkillModifier
   * or EffectStopper.
   */
  readonly func: string;
  /**
   * shipID, charID, itemID, otherID, targetID, structureID or target.
   */
  readonly domain: string;
  readonly modifiedAttributeID: number;
  readonly modifyingAttributeID: number;
  /**
   * -1 preAssign, 0 preMul, 1 preDiv, 2 modAdd, 3 modSub, 4 postMul, 5 postDiv, 6 postPercent, 7 postAssign.
   */
  readonly operation: number;
  /**
   * LocationGroupModifier's group.
   */
  readonly groupID?: number;
  /**
   * LocationRequiredSkillModifier's and OwnerRequiredSkillModifier's skill.
   */
  readonly skillTypeID?: number;
}

export interface DogmaEffectRecord {
  readonly effectID: number;
  readonly name: string;
  /**
   * 0 passive, 1 active, 2 target, 3 area, 4 online, 5 overload, 6 dungeon, 7 system.
   */
  readonly category: number;
  /**
   * The client effect it plays (`effects.ShieldBoosting`), or "".
   */
  readonly guid: string;
  readonly warpSafe: boolean;
  readonly offensive: boolean;
  readonly assistance: boolean;
  readonly durationAttributeID?: number;
  readonly dischargeAttributeID?: number;
  readonly rangeAttributeID?: number;
  readonly falloffAttributeID?: number;
  readonly trackingSpeedAttributeID?: number;
  /**
   * The target's attribute that scales a target effect (energyWarfareResistance 2045 for neuts and nos,
   * remoteCapacitorImpedance 6463 for transmitters).
   */
  readonly resistanceAttributeID?: number;
  readonly modifiers: DogmaModifierRecord[];
}

export interface DogmaAttributeRecord {
  readonly attributeID: number;
  readonly name: string;
  readonly stackable: boolean;
  readonly highIsGood: boolean;
  readonly defaultValue: number;
  /**
   * The attribute whose value caps this one.
   */
  readonly maxAttributeID?: number;
}

export interface DogmaTypeRecord {
  readonly typeID: number;
  readonly name: string;
  readonly groupID: number;
  readonly categoryID: number;
  readonly published: boolean;
  /**
   * Type columns, not typeDogma attributes: the evaluator seeds attributes 4, 162, 38 and 161 from them.
   */
  readonly mass?: number;
  readonly radius?: number;
  readonly capacity?: number;
  readonly volume?: number;
  /**
   * The type's race (1 Caldari, 2 Minmatar, 4 Amarr, 8 Gallente, 16 Jove, 128 ORE, 135 Triglavian, 168 EDENCOM), when
   * it has one: a hull's default weapons follow it.
   */
  readonly raceID?: number;
  /**
   * The type's dogma attribute values by attribute id.
   */
  readonly attributes: Record<string, number>;
  readonly effects: number[];
  /**
   * The `isDefault` effect: a module's activation effect.
   */
  readonly defaultEffect?: number;
}

export interface DogmaBundle {
  readonly sdeBuild: string;
  readonly types: Record<string, DogmaTypeRecord>;
  readonly effects: Record<string, DogmaEffectRecord>;
  readonly attributes: Record<string, DogmaAttributeRecord>;
  /**
   * Type ids asked for that the SDE does not have.
   */
  readonly missing?: number[];
}

/**
 * What a fit line's type is, coarsely, by its EVE category.
 */
export type FitTypeCategory = 'ship' | 'module' | 'charge' | 'drone' | 'fighter' | 'implant' | 'subsystem' | 'structure-module' | 'other';

/**
 * EVE category ids by FitTypeCategory.
 */
export const FIT_TYPE_CATEGORY_IDS: Readonly<Record<Exclude<FitTypeCategory, 'other'>, number>> = { ship: 6, module: 7, charge: 8, drone: 18, implant: 20, subsystem: 32, 'structure-module': 66, fighter: 87 };

/**
 * A fit line's name resolved to its EVE type (the hub's `/fit/type`).
 */
export interface FitTypeAnswer {
  readonly typeID: number;
  /**
   * The canonical English name.
   */
  readonly name: string;
  readonly groupID: number;
  readonly categoryID: number;
  readonly category: FitTypeCategory;
  /**
   * The slot its slot effect names, or null when it fits no slot (drones, charges, cargo).
   */
  readonly slot: Maybe<EftSlot>;
}

/**
 * The FitTypeCategory of an EVE category id.
 *
 * @param categoryID - The category id.
 * @returns The category, `other` for any not listed.
 */
export function fitTypeCategoryOf(categoryID: number): FitTypeCategory {
  const found = Object.entries(FIT_TYPE_CATEGORY_IDS).find(([, id]) => id === categoryID);
  return (found?.[0] as Maybe<FitTypeCategory>) ?? 'other';
}

/**
 * Merges bundles of one SDE build: later records replace earlier ones; `missing` keeps the ids no bundle has.
 *
 * @param bundles - The bundles, at least one.
 * @returns The merged bundle.
 */
export function mergeDogmaBundles(...bundles: readonly DogmaBundle[]): DogmaBundle {
  const types: Record<string, DogmaTypeRecord> = {};
  const effects: Record<string, DogmaEffectRecord> = {};
  const attributes: Record<string, DogmaAttributeRecord> = {};
  const missing = new Set<number>();
  for (const bundle of bundles) {
    Object.assign(types, bundle.types);
    Object.assign(effects, bundle.effects);
    Object.assign(attributes, bundle.attributes);
    for (const id of bundle.missing ?? []) missing.add(id);
  }
  const stillMissing = [...missing].filter((id) => types[id] == null);
  return { sdeBuild: bundles[0]?.sdeBuild ?? '', types, effects, attributes, ...(stillMissing.length ? { missing: stillMissing } : {}) };
}

export interface ReadDogmaBundleResult {
  readonly bundle: Maybe<DogmaBundle>;
  readonly problems: string[];
}

/**
 * Validates a hub answer as a DogmaBundle (the page reads untrusted JSON). Malformed records are dropped with a
 * problem; a value that is no bundle at all gives no bundle.
 *
 * @param value - The candidate.
 * @returns The bundle and what was dropped.
 */
export function readDogmaBundle(value: unknown): ReadDogmaBundleResult {
  const problems: string[] = [];
  if (!isPlainObject(value) || typeof value['sdeBuild'] !== 'string' || !isPlainObject(value['types']) || !isPlainObject(value['effects']) || !isPlainObject(value['attributes'])) {
    return { bundle: null, problems: ['a dogma bundle needs sdeBuild, types, effects and attributes'] };
  }
  const types = readRecords(value['types'], { problems, what: 'type', read: readTypeRecord });
  const effects = readRecords(value['effects'], { problems, what: 'effect', read: readEffectRecord });
  const attributes = readRecords(value['attributes'], { problems, what: 'attribute', read: readAttributeRecord });
  const missing = Array.isArray(value['missing']) ? value['missing'].filter((id): id is number => isId(id)) : [];
  return { bundle: { sdeBuild: value['sdeBuild'], types, effects, attributes, ...(missing.length ? { missing } : {}) }, problems };
}

/**
 * Validates a hub `/fit/type` answer.
 *
 * @param value - The candidate.
 * @returns The answer, or null when it is malformed.
 */
export function readFitTypeAnswer(value: unknown): Maybe<FitTypeAnswer> {
  let answer: Maybe<FitTypeAnswer> = null;
  if (isPlainObject(value) && isId(value['typeID']) && typeof value['name'] === 'string' && isId(value['groupID']) && isId(value['categoryID'])) {
    const slot = typeof value['slot'] === 'string' && FIT_SLOT_NAMES.has(value['slot']) ? (value['slot'] as EftSlot) : null;
    answer = { typeID: value['typeID'], name: value['name'], groupID: value['groupID'], categoryID: value['categoryID'], category: fitTypeCategoryOf(value['categoryID']), slot };
  }
  return answer;
}

const FIT_SLOT_NAMES = new Set<string>(['low', 'mid', 'high', 'rig', 'subsystem', 'service']);

function readRecords<T>(input: Record<string, unknown>, context: { readonly problems: string[]; readonly what: string; readonly read: (value: unknown) => Maybe<T> }): Record<string, T> {
  const records: Record<string, T> = {};
  for (const [id, value] of Object.entries(input)) {
    const record = context.read(value);
    if (record) records[id] = record;
    else context.problems.push(`dogma ${context.what} ${id} is malformed and was dropped`);
  }
  return records;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalNumbers<K extends string>(value: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const read: Partial<Record<K, number>> = {};
  for (const key of keys) if (isNumber(value[key])) read[key] = value[key];
  return read;
}

function readTypeRecord(value: unknown): Maybe<DogmaTypeRecord> {
  let record: Maybe<DogmaTypeRecord> = null;
  if (isPlainObject(value) && isId(value['typeID']) && typeof value['name'] === 'string' && isId(value['groupID']) && isId(value['categoryID']) && isPlainObject(value['attributes']) && Array.isArray(value['effects'])) {
    const attributes: Record<string, number> = {};
    for (const [id, amount] of Object.entries(value['attributes'])) if (isNumber(amount)) attributes[id] = amount;
    record = {
      typeID: value['typeID'],
      name: value['name'],
      groupID: value['groupID'],
      categoryID: value['categoryID'],
      published: value['published'] === true,
      ...optionalNumbers(value, ['mass', 'radius', 'capacity', 'volume', 'raceID', 'defaultEffect'] as const),
      attributes,
      effects: value['effects'].filter((id): id is number => isId(id))
    };
  }
  return record;
}

function readEffectRecord(value: unknown): Maybe<DogmaEffectRecord> {
  let record: Maybe<DogmaEffectRecord> = null;
  if (isPlainObject(value) && isId(value['effectID']) && typeof value['name'] === 'string' && isId(value['category']) && Array.isArray(value['modifiers'])) {
    const modifiers = value['modifiers']
      .filter(isPlainObject)
      .flatMap((modifier): DogmaModifierRecord[] =>
        typeof modifier['func'] === 'string' && typeof modifier['domain'] === 'string' && isId(modifier['modifiedAttributeID']) && isId(modifier['modifyingAttributeID']) && isNumber(modifier['operation'])
          ? [{ func: modifier['func'], domain: modifier['domain'], modifiedAttributeID: modifier['modifiedAttributeID'], modifyingAttributeID: modifier['modifyingAttributeID'], operation: modifier['operation'], ...optionalNumbers(modifier, ['groupID', 'skillTypeID'] as const) }]
          : []
      );
    record = {
      effectID: value['effectID'],
      name: value['name'],
      category: value['category'],
      guid: typeof value['guid'] === 'string' ? value['guid'] : '',
      warpSafe: value['warpSafe'] === true,
      offensive: value['offensive'] === true,
      assistance: value['assistance'] === true,
      ...optionalNumbers(value, ['durationAttributeID', 'dischargeAttributeID', 'rangeAttributeID', 'falloffAttributeID', 'trackingSpeedAttributeID', 'resistanceAttributeID'] as const),
      modifiers
    };
  }
  return record;
}

function readAttributeRecord(value: unknown): Maybe<DogmaAttributeRecord> {
  let record: Maybe<DogmaAttributeRecord> = null;
  if (isPlainObject(value) && isId(value['attributeID']) && typeof value['name'] === 'string') {
    record = {
      attributeID: value['attributeID'],
      name: value['name'],
      stackable: value['stackable'] !== false,
      highIsGood: value['highIsGood'] !== false,
      defaultValue: isNumber(value['defaultValue']) ? value['defaultValue'] : 0,
      ...optionalNumbers(value, ['maxAttributeID'] as const)
    };
  }
  return record;
}
