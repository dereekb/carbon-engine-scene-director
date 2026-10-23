/**
 * Fit data from tools-core's SDE: a fit line's name resolved to its EVE type and slot, and the dogma a fit needs
 * (types, effects with their modifiers, attributes with their stacking rules) as one DogmaBundle.
 *
 * - Names: tools-core's `POST fitting/parse` with a one-line EFT text, `[<hull>, resolve]\n<name>`, one name per call
 *   (the whole-text parse drops `/OFFLINE`, fails on `Module, Charge` and on any unknown name). An unknown header hull
 *   is retried on the anchor hull `Rifter`. Names are exact, case-sensitive English names, as EFT writes them; cached
 *   per name.
 * - Bundles close over every effect the types carry and every attribute those effects and modifiers name, plus
 *   FIXED_ATTRIBUTE_IDS (what the stats read) and each attribute's `maxAttributeID`.
 * - Skills: every published type of category 16, once per hub.
 */

import type { Maybe } from '@dereekb/util';
import { type DogmaAttributeRecord, type DogmaBundle, type DogmaEffectRecord, type DogmaModifierRecord, type DogmaTypeRecord, type EftSlot, type FitTypeAnswer, fitTypeCategoryOf } from '@scene-director/scene';
import { type JsonObject, ReadArray, ReadName, ReadNumber, ReadObject, ReadTypeID, type SdeClient, ShipDataError } from './sde-client';

/**
 * The hull a name lookup's EFT header uses when the fit's own hull is unknown: any published hull works.
 */
export const ANCHOR_HULL = 'Rifter';

/**
 * The EVE category of skills.
 */
export const SKILL_CATEGORY = 16;

/**
 * The most type ids one `/dogma/types` call takes.
 */
export const MAX_DOGMA_TYPE_IDS = 200;

/**
 * Attributes every bundle carries: the type columns (mass 4, radius 162, capacity 38, volume 161), skill level 280,
 * required skills 182 / 183 / 184 / 1285 / 1289 / 1290, reactivation delay 669, max group active / online 763 / 978,
 * HP (263 shield, 265 armor, 9 hull), shield recharge 479, the 12 resonances, capacitor 482 / 55, signature 552,
 * speed 37, agility 70, targeting 76 / 564 / 192, the prop mod numbers 20 / 567 / 796 / 554, duration 73, capacitor
 * need 6, range 54 / falloff 158 / falloffEffectiveness 2044, the rep amounts 68 / 84 / 83 and the ancillary multiplier
 * 1886.
 */
export const FIXED_ATTRIBUTE_IDS: readonly number[] = [4, 162, 38, 161, 280, 182, 183, 184, 1285, 1289, 1290, 669, 763, 978, 263, 265, 9, 479, 271, 272, 273, 274, 267, 268, 269, 270, 113, 111, 109, 110, 482, 55, 552, 37, 70, 76, 564, 192, 20, 567, 796, 554, 73, 6, 54, 158, 2044, 68, 84, 83, 1886];

/**
 * How many tools-core requests a bundle runs at once.
 */
const REQUEST_CONCURRENCY = 16;

const SKILL_LIST_LIMIT = 1000;

const SLOT_NAMES: Readonly<Record<string, EftSlot>> = { low: 'low', medium: 'mid', mid: 'mid', high: 'high', rig: 'rig', subsystem: 'subsystem', service: 'service' };

export interface DogmaDataApi {
  SdeBuild(): Promise<string>;
  /**
   * A fit line's name as its EVE type and slot.
   */
  TypeByName(name: string, hull?: Maybe<string>): Promise<FitTypeAnswer>;
  /**
   * The bundle of the given types (ids the SDE lacks are listed in `missing`).
   */
  Bundle(typeIDs: readonly number[]): Promise<DogmaBundle>;
  /**
   * The bundle of every published skill.
   */
  Skills(): Promise<DogmaBundle>;
}

export class DogmaData implements DogmaDataApi {
  private readonly sde: SdeClient;

  constructor({ sde }: { readonly sde: SdeClient }) {
    this.sde = sde;
  }

  async SdeBuild(): Promise<string> {
    return this.sde.SdeBuild();
  }

  /**
   * A fit line's name as its EVE type and slot.
   *
   * @param name - An exact English type name (case-sensitive, as EFT writes it).
   * @param hull - The fit's header hull; an unknown one falls back to ANCHOR_HULL.
   * @returns The type.
   * @throws {ShipDataError} `not-found` for an unknown name, `unavailable` without an SDE.
   */
  async TypeByName(name: string, hull: Maybe<string> = null): Promise<FitTypeAnswer> {
    const trimmed = name.trim();
    if (!trimmed || /[\r\n]/u.test(trimmed)) throw new ShipDataError('invalid', 'a fit type name must be one non-empty line');
    return this.sde.Cached(`fit-type:${trimmed}`, async () => {
      const parsed = await this.ParseName(trimmed, hull?.trim() || ANCHOR_HULL).catch((error: unknown) => {
        if (hull && error instanceof ShipDataError && /unknown hull/iu.test(error.message)) return this.ParseName(trimmed, ANCHOR_HULL);
        throw error;
      });
      const item = ReadArray(parsed['items'])[0];
      const typeID = ReadTypeID(item?.['typeID']);
      if (!item || typeID == null) throw new ShipDataError('not-found', `no EVE type is named "${trimmed}"`);
      const type = await this.sde.Type(typeID);
      const groupID = ReadNumber(type['groupID']) ?? 0;
      const categoryID = ReadNumber(type['categoryID']) ?? 0;
      return { typeID, name: ReadName(item['name']) ?? ReadName(type['name']) ?? trimmed, groupID, categoryID, category: fitTypeCategoryOf(categoryID), slot: typeof item['slot'] === 'string' ? (SLOT_NAMES[item['slot']] ?? null) : null };
    });
  }

  /**
   * The bundle of the given types: their records, every effect they carry, and every attribute those name.
   *
   * @param typeIDs - The type ids.
   * @returns The bundle; ids the SDE lacks are in `missing`.
   */
  async Bundle(typeIDs: readonly number[]): Promise<DogmaBundle> {
    const sdeBuild = await this.SdeBuild();
    const ids = [...new Set(typeIDs)];
    const missing: number[] = [];
    const records = await MapLimited(ids, async (typeID) =>
      this.TypeRecord(typeID).catch((error: unknown) => {
        if (error instanceof ShipDataError && error.failure === 'not-found') {
          missing.push(typeID);
          return null;
        }
        throw error;
      })
    );
    const types: Record<string, DogmaTypeRecord> = {};
    for (const record of records) if (record) types[record.typeID] = record;

    const effectIDs = [...new Set(Object.values(types).flatMap((type) => type.effects))];
    const effects: Record<string, DogmaEffectRecord> = {};
    for (const effect of await MapLimited(effectIDs, (effectID) => this.Effect(effectID))) effects[effect.effectID] = effect;

    const attributeIDs = new Set<number>(FIXED_ATTRIBUTE_IDS);
    for (const effect of Object.values(effects)) {
      for (const modifier of effect.modifiers) {
        attributeIDs.add(modifier.modifiedAttributeID);
        attributeIDs.add(modifier.modifyingAttributeID);
      }
      for (const id of [effect.durationAttributeID, effect.dischargeAttributeID, effect.rangeAttributeID, effect.falloffAttributeID, effect.trackingSpeedAttributeID]) if (id != null) attributeIDs.add(id);
    }
    const attributes = await this.Attributes(attributeIDs);
    return { sdeBuild, types, effects, attributes, ...(missing.length ? { missing: missing.sort((a, b) => a - b) } : {}) };
  }

  /**
   * The bundle of every published skill (category 16), cached per hub.
   *
   * @returns The bundle.
   */
  async Skills(): Promise<DogmaBundle> {
    return this.sde.Cached('dogma-skills', async () => {
      const groups = await this.sde.GetJson({ route: `sde/groups?field=categoryID&value=${SKILL_CATEGORY}&limit=${SKILL_LIST_LIMIT}`, what: 'the skill groups' });
      const groupIDs = ReadArray(groups['items']).flatMap((item) => {
        const payload = ReadObject(item['payload']);
        const id = ReadNumber(payload['_key']);
        return id != null && payload['published'] !== false ? [id] : [];
      });
      const listings = await MapLimited(groupIDs, (groupID) => this.sde.GetJson({ route: `sde/types?field=groupID&value=${groupID}&limit=${SKILL_LIST_LIMIT}`, what: `skill group ${groupID}` }));
      const skillIDs = listings.flatMap((listing) =>
        ReadArray(listing['items']).flatMap((item) => {
          const payload = ReadObject(item['payload']);
          const id = ReadNumber(payload['_key']);
          return id != null && payload['published'] === true ? [id] : [];
        })
      );
      return this.Bundle(skillIDs.sort((a, b) => a - b));
    });
  }

  private async ParseName(name: string, hull: string): Promise<JsonObject> {
    try {
      return await this.sde.PostJson({ route: 'fitting/parse', what: `the fit type "${name}"` }, { text: `[${hull}, resolve]\n${name}` });
    } catch (error) {
      if (error instanceof ShipDataError && /unknown type in eft text/iu.test(error.message)) throw new ShipDataError('not-found', `no EVE type is named "${name}"`);
      throw error;
    }
  }

  private async TypeRecord(typeID: number): Promise<DogmaTypeRecord> {
    const [type, dogma] = await Promise.all([this.sde.Type(typeID), this.sde.TypeDogma(typeID)]);
    const columns: Partial<Record<'mass' | 'radius' | 'capacity' | 'volume', number>> = {};
    for (const key of ['mass', 'radius', 'capacity', 'volume'] as const) {
      const value = ReadNumber(type[key]);
      if (value != null) columns[key] = value;
    }
    const raceID = ReadNumber(type['raceID']);
    return {
      typeID,
      name: ReadName(type['name']) ?? `type ${typeID}`,
      groupID: ReadNumber(type['groupID']) ?? 0,
      categoryID: ReadNumber(type['categoryID']) ?? 0,
      published: type['published'] === true,
      ...columns,
      ...(raceID == null ? {} : { raceID }),
      attributes: Object.fromEntries(dogma.attributes),
      effects: [...dogma.effects].filter((id): id is number => typeof id === 'number'),
      ...(dogma.defaultEffect == null ? {} : { defaultEffect: dogma.defaultEffect })
    };
  }

  private async Effect(effectID: number): Promise<DogmaEffectRecord> {
    return this.sde.Cached(`dogma-effect:${effectID}`, async () => ToEffectRecord(effectID, ReadObject((await this.sde.GetJson({ route: `sde/dogmaEffects/${effectID}`, what: `dogma effect ${effectID}` }))['payload'])));
  }

  private async Attribute(attributeID: number): Promise<Maybe<DogmaAttributeRecord>> {
    return this.sde.Cached(`dogma-attribute:${attributeID}`, async () => {
      const body = await this.sde.GetJson({ route: `sde/dogmaAttributes/${attributeID}`, what: `dogma attribute ${attributeID}` }).catch((error: unknown) => {
        if (error instanceof ShipDataError && error.failure === 'not-found') return null;
        throw error;
      });
      return body ? ToAttributeRecord(attributeID, ReadObject(body['payload'])) : null;
    });
  }

  /**
   * The attribute records of the ids, plus the attributes their `maxAttributeID`s name.
   */
  private async Attributes(ids: ReadonlySet<number>): Promise<Record<string, DogmaAttributeRecord>> {
    const attributes: Record<string, DogmaAttributeRecord> = {};
    let pending = [...ids];
    while (pending.length) {
      const records = await MapLimited(pending, (id) => this.Attribute(id));
      for (const record of records) if (record) attributes[record.attributeID] = record;
      pending = [...new Set(records.flatMap((record) => (record?.maxAttributeID != null && attributes[record.maxAttributeID] == null ? [record.maxAttributeID] : [])))];
    }
    return attributes;
  }
}

function ToEffectRecord(effectID: number, payload: JsonObject): DogmaEffectRecord {
  const modifiers = ReadArray(payload['modifierInfo']).flatMap((info): DogmaModifierRecord[] => {
    const modifiedAttributeID = ReadNumber(info['modifiedAttributeID']);
    const modifyingAttributeID = ReadNumber(info['modifyingAttributeID']);
    const operation = ReadNumber(info['operation']);
    const groupID = ReadNumber(info['groupID']);
    const skillTypeID = ReadNumber(info['skillTypeID']);
    return typeof info['func'] === 'string' && modifiedAttributeID != null && modifyingAttributeID != null && operation != null
      ? [{ func: info['func'], domain: typeof info['domain'] === 'string' ? info['domain'] : '', modifiedAttributeID, modifyingAttributeID, operation, ...(groupID == null ? {} : { groupID }), ...(skillTypeID == null ? {} : { skillTypeID }) }]
      : [];
  });
  const optional: Partial<Record<'durationAttributeID' | 'dischargeAttributeID' | 'rangeAttributeID' | 'falloffAttributeID' | 'trackingSpeedAttributeID', number>> = {};
  for (const key of ['durationAttributeID', 'dischargeAttributeID', 'rangeAttributeID', 'falloffAttributeID', 'trackingSpeedAttributeID'] as const) {
    const value = ReadNumber(payload[key]);
    if (value != null) optional[key] = value;
  }
  return {
    effectID,
    name: typeof payload['name'] === 'string' ? payload['name'] : `effect ${effectID}`,
    category: ReadNumber(payload['effectCategoryID']) ?? 0,
    guid: typeof payload['guid'] === 'string' ? payload['guid'] : '',
    warpSafe: payload['isWarpSafe'] === true,
    offensive: payload['isOffensive'] === true,
    assistance: payload['isAssistance'] === true,
    ...optional,
    modifiers
  };
}

function ToAttributeRecord(attributeID: number, payload: JsonObject): DogmaAttributeRecord {
  const maxAttributeID = ReadNumber(payload['maxAttributeID']);
  return {
    attributeID,
    name: typeof payload['name'] === 'string' ? payload['name'] : `attribute ${attributeID}`,
    stackable: payload['stackable'] !== false,
    highIsGood: payload['highIsGood'] !== false,
    defaultValue: ReadNumber(payload['defaultValue']) ?? 0,
    ...(maxAttributeID == null ? {} : { maxAttributeID })
  };
}

/**
 * Maps items through an async function, REQUEST_CONCURRENCY at a time, keeping their order.
 *
 * @param items - The items.
 * @param map - The function.
 * @returns The results in order.
 */
export async function MapLimited<T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, items.length) }, worker));
  return results;
}
