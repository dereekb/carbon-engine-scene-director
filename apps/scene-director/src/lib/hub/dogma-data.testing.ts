import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DogmaBundle, DogmaTypeRecord, EftSlot, FitTypeAnswer } from '@scene-director/scene';
import { fitTypeCategoryOf, mergeDogmaBundles } from '@scene-director/scene';
import { DogmaData, type DogmaDataApi, SKILL_CATEGORY } from './dogma-data';
import { SdeClient, ShipDataError } from './sde-client';
import { type Answer, SDE, TOOLS_CORE } from './ship-data.testing';

/**
 * The committed dogma fixture (packages/scene/src/lib/fitting/fixtures): the hub's own `/dogma/types` and
 * `/dogma/skills` answers for SDE build 3632936, merged (capture steps: the sd-fittings ref).
 */
export const DOGMA_FIXTURE_PATH = path.resolve(import.meta.dirname, '../../../../../packages/scene/src/lib/fitting/fixtures/dogma-3632936.json');

/**
 * The fixture, read once.
 *
 * @returns The bundle.
 */
export function DogmaFixture(): DogmaBundle {
  cachedFixture ??= JSON.parse(readFileSync(DOGMA_FIXTURE_PATH, 'utf8')) as DogmaBundle;
  return cachedFixture;
}

let cachedFixture: DogmaBundle | null = null;

/**
 * The slot effects of EVE modules (loPower, medPower, hiPower, rigSlot, subSystem).
 */
const SLOT_EFFECTS: Readonly<Record<number, EftSlot>> = { 11: 'low', 13: 'mid', 12: 'high', 2663: 'rig', 3772: 'subsystem' };

const TOOLS_CORE_SLOTS: Readonly<Record<EftSlot, string>> = { low: 'low', mid: 'medium', high: 'high', rig: 'rig', subsystem: 'subsystem', service: 'service' };

/**
 * A fixture type's slot, from its slot effect.
 *
 * @param type - The type record.
 * @returns The slot, or null.
 */
export function FixtureSlot(type: DogmaTypeRecord): EftSlot | null {
  return type.effects.map((effect) => SLOT_EFFECTS[effect]).find(Boolean) ?? null;
}

/**
 * tools-core routes rebuilt from the fixture, in the shapes tools-core sends (checked live, build 3632936):
 * `types/<id>?lang=en`, `sde/typeDogma/<id>`, `sde/dogmaEffects/<id>`, `sde/dogmaAttributes/<id>`, the skill group
 * and type listings, and `POST fitting/parse` per name (key `POST fitting/parse <text>`).
 *
 * @returns The routes.
 */
export function DogmaRoutes(): Record<string, Answer> {
  const fixture = DogmaFixture();
  const base = `/eve/${SDE}`;
  const routes: Record<string, Answer> = { '/eve/latest/build': { json: { build: SDE, builds: { sde: SDE } } } };
  const groups = new Map<number, number[]>();
  for (const type of Object.values(fixture.types)) {
    routes[`${base}/types/${type.typeID}?lang=en`] = { json: { typeID: type.typeID, groupID: type.groupID, categoryID: type.categoryID, published: type.published, mass: type.mass, radius: type.radius, capacity: type.capacity, volume: type.volume, name: { text: type.name, language: 'en' } } };
    routes[`${base}/sde/typeDogma/${type.typeID}`] = {
      json: { table: 'typeDogma', payload: { dogmaAttributes: Object.entries(type.attributes).map(([attributeID, value]) => ({ attributeID: Number(attributeID), value })), dogmaEffects: type.effects.map((effectID) => ({ effectID, isDefault: effectID === type.defaultEffect })) } }
    };
    if (type.categoryID === SKILL_CATEGORY) groups.set(type.groupID, [...(groups.get(type.groupID) ?? []), type.typeID]);
    const slot = FixtureSlot(type);
    routes[`POST ${base}/fitting/parse [Rifter, resolve]\n${type.name}`] = { json: { shipTypeID: 587, items: [{ typeID: type.typeID, name: type.name, quantity: 1, slot: slot ? TOOLS_CORE_SLOTS[slot] : null, fitted: slot != null, category: fitTypeCategoryOf(type.categoryID) }] } };
  }
  for (const effect of Object.values(fixture.effects)) {
    const { effectID, name, category, guid, warpSafe, offensive, assistance, modifiers, ...attributeIds } = effect;
    routes[`${base}/sde/dogmaEffects/${effectID}`] = { json: { table: 'dogmaEffects', payload: { _key: effectID, name, effectCategoryID: category, guid, isWarpSafe: warpSafe, isOffensive: offensive, isAssistance: assistance, ...attributeIds, ...(modifiers.length ? { modifierInfo: modifiers } : {}) } } };
  }
  for (const attribute of Object.values(fixture.attributes)) {
    routes[`${base}/sde/dogmaAttributes/${attribute.attributeID}`] = {
      json: { table: 'dogmaAttributes', payload: { _key: attribute.attributeID, name: attribute.name, stackable: attribute.stackable, highIsGood: attribute.highIsGood, defaultValue: attribute.defaultValue, ...(attribute.maxAttributeID == null ? {} : { maxAttributeID: attribute.maxAttributeID }) } }
    };
  }
  routes[`${base}/sde/groups?field=categoryID&value=${SKILL_CATEGORY}&limit=1000`] = { json: { items: [...groups.keys()].map((id) => ({ payload: { _key: id, categoryID: SKILL_CATEGORY, published: true } })) } };
  for (const [groupID, ids] of groups) routes[`${base}/sde/types?field=groupID&value=${groupID}&limit=1000`] = { json: { items: ids.map((id) => ({ payload: { _key: id, groupID, published: true } })) } };
  return routes;
}

/**
 * A tools-core stand-in for GETs and `POST fitting/parse`: an unknown name answers tools-core's 400.
 *
 * @param routes - The routes.
 * @returns The fetch and the calls made (paths, POSTs as `POST <path> <text>`).
 */
export function FakeDogmaFetch(routes: Record<string, Answer>): { readonly fetch: typeof fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).slice(TOOLS_CORE.length);
    const text = init?.method === 'POST' ? String((JSON.parse(String(init.body)) as { text: string }).text) : null;
    const key = text == null ? url : `POST ${url} ${text}`;
    calls.push(key);
    const answer = routes[key];
    if (answer === 'network-error') throw new TypeError('fetch failed');
    const missing = text == null ? { status: 404, json: { error: `no route ${url}` } } : { status: 400, json: { error: `Unknown type in EFT text: ${text.split('\n')[1]}` } };
    const { status = 200, json } = answer ?? missing;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

/**
 * A DogmaData over fake tools-core routes rebuilt from the fixture.
 *
 * @param routes - The routes. Default DogmaRoutes().
 * @returns The DogmaData and the calls it made.
 */
export function MakeRoutedDogmaData(routes: Record<string, Answer> = DogmaRoutes()): { readonly dogmaData: DogmaData; readonly calls: string[] } {
  const { fetch, calls } = FakeDogmaFetch(routes);
  return { dogmaData: new DogmaData({ sde: new SdeClient({ url: TOOLS_CORE, fetch }) }), calls };
}

/**
 * An in-memory DogmaDataApi over the fixture, for specs that need the answers, not the routes.
 *
 * @returns The fake.
 */
export function MakeFakeDogmaData(): DogmaDataApi {
  const fixture = DogmaFixture();
  const byName = new Map(Object.values(fixture.types).map((type) => [type.name, type]));
  return {
    SdeBuild: async () => SDE,
    TypeByName: async (name: string): Promise<FitTypeAnswer> => {
      const type = byName.get(name.trim());
      if (!type) throw new ShipDataError('not-found', `no EVE type is named "${name.trim()}"`);
      return { typeID: type.typeID, name: type.name, groupID: type.groupID, categoryID: type.categoryID, category: fitTypeCategoryOf(type.categoryID), slot: FixtureSlot(type) };
    },
    Bundle: async (ids: readonly number[]) => {
      const types = Object.fromEntries(ids.flatMap((id) => (fixture.types[id] ? [[id, fixture.types[id]]] : [])));
      const missing = ids.filter((id) => !fixture.types[id]);
      return mergeDogmaBundles({ sdeBuild: SDE, types, effects: fixture.effects, attributes: fixture.attributes, ...(missing.length ? { missing } : {}) });
    },
    Skills: async () => ({ ...fixture, types: Object.fromEntries(Object.entries(fixture.types).filter(([, type]) => type.categoryID === SKILL_CATEGORY)) })
  };
}
