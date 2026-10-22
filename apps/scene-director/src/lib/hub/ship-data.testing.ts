import { ShipData } from './ship-data';

/**
 * A tools-core stand-in for the ship stats specs: the routes ShipData reads, with the
 * response shapes tools-core sends (checked live against SDE build 3632936) and the
 * published values of a few hulls and prop mods (EVE typeDogma, 2026-10-21).
 */

export const TOOLS_CORE = 'http://tools-core.test';
export const SDE = '3632936';

export type Answer = { readonly status?: number; readonly json: unknown } | 'network-error';

/**
 * A tools-core stand-in answering the routes ShipData uses with the shapes tools-core sends (checked live, build 3632936).
 */
export function FakeToolsCoreFetch(routes: Record<string, Answer>): { readonly fetch: typeof fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url.slice(TOOLS_CORE.length));
    const answer = routes[url.slice(TOOLS_CORE.length)];
    if (answer === 'network-error') throw new TypeError('fetch failed');
    const { status = 200, json } = answer ?? { status: 404, json: { error: `no route ${url}` } };
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

function TypeDogma(attributes: Record<number, number>, effects: number[] = []): Answer {
  return {
    json: {
      target: 'eve',
      table: 'typeDogma',
      payload: { dogmaAttributes: Object.entries(attributes).map(([attributeID, value]) => ({ attributeID: Number(attributeID), value })), dogmaEffects: effects.map((effectID) => ({ effectID, isDefault: false })) }
    }
  };
}

function Hull(config: { readonly typeID: number; readonly name: string; readonly group: string; readonly mass: number; readonly radius: number; readonly base: Record<string, number>; readonly dogma: Record<number, number> }): Record<string, Answer> {
  const { typeID, name, group, mass, radius, base, dogma } = config;
  return {
    [`/eve/${SDE}/types/${typeID}?lang=en`]: { json: { typeID, groupID: 1, mass, radius, published: true, name: { text: name, language: 'en' }, groupName: { text: group, language: 'en' } } },
    [`/eve/${SDE}/dogma/types/${typeID}?sections=navigation,targeting`]: { json: { typeID, sections: ['navigation', 'targeting'], base, effective: base } },
    [`/eve/${SDE}/sde/typeDogma/${typeID}`]: TypeDogma(dogma)
  };
}

/**
 * tools-core's group 46 listing (`sde/types?field=groupID&value=46`), which PropModByName reads.
 */
export const PROP_MOD_LISTING_ROUTE = `/eve/${SDE}/sde/types?field=groupID&value=46&limit=1000`;

function PropModRow(typeID: number, name: string, published = true): unknown {
  return { table: 'types', id: String(typeID), payload: { _key: typeID, groupID: 46, name: { de: `${name} (de)`, en: name }, published } };
}

function PropModRoutes(config: { readonly typeID: number; readonly name: string; readonly groupID?: number; readonly attributes: Record<number, number>; readonly effects: number[] }): Record<string, Answer> {
  const { typeID, name, groupID = 46, attributes, effects } = config;
  return {
    [`/eve/${SDE}/types/${typeID}?lang=en`]: { json: { typeID, groupID, mass: 0, name: { text: name, language: 'en' } } },
    [`/eve/${SDE}/sde/typeDogma/${typeID}`]: TypeDogma(attributes, effects)
  };
}

export const TFI_DNA = 'mb2_t1:minmatarnavy:minmatar';

/**
 * TFI 17732, Guardian 11987, Revelation 19720, five prop mods and the group 46 listing, as tools-core serves them.
 */
export const SHIP_ROUTES: Record<string, Answer> = {
  '/eve/latest/build': { json: { build: '3632940', builds: { resources: '3632940', sde: SDE } } },
  [`/eve/${SDE}/dna/search?q=${encodeURIComponent(TFI_DNA)}&limit=50`]: {
    json: {
      matches: [
        { base: TFI_DNA, typeID: 639, skinID: 10429, dna: TFI_DNA, exact: true },
        { base: TFI_DNA, typeID: 17732, skinID: null, dna: TFI_DNA, exact: true },
        { base: `${TFI_DNA}x`, typeID: 1, skinID: null, dna: `${TFI_DNA}x`, exact: false },
        { base: TFI_DNA, typeID: 90000, skinID: null, dna: TFI_DNA, exact: true }
      ]
    }
  },
  [`/eve/${SDE}/dna/search?q=${encodeURIComponent('zz9_t1:nobody:amarr')}&limit=50`]: { json: { query: 'zz9_t1:nobody:amarr', total: 0, matches: [] } },
  [`/eve/${SDE}/dna/resolve?name=Guardian`]: { json: { typeID: '11987', graphicID: '1916', skinID: null, dna: 'ac3_t2:carthum:amarr' } },
  [`/eve/${SDE}/dna/resolve?typeID=17732`]: { json: { typeID: '17732', graphicID: '11777', skinID: null, dna: TFI_DNA } },
  [`/eve/${SDE}/dna/resolve?name=Tempest`]: { status: 409, json: { error: 'SDE name "Tempest" is ambiguous' } },
  ...Hull({ typeID: 17732, name: 'Tempest Fleet Issue', group: 'Battleship', mass: 103_300_000, radius: 250, base: { maxVelocity: 130, agility: 0.115, warpSpeedMultiplier: 3, signatureRadius: 350 }, dogma: { 1547: 3 } }),
  ...Hull({ typeID: 11987, name: 'Guardian', group: 'Logistics', mass: 11_980_000, radius: 80, base: { maxVelocity: 209, agility: 0.61, warpSpeedMultiplier: 4, signatureRadius: 70 }, dogma: { 1547: 2 } }),
  ...Hull({ typeID: 19720, name: 'Revelation', group: 'Dreadnought', mass: 1_290_000_000, radius: 1700, base: { maxVelocity: 75, agility: 0.044, warpSpeedMultiplier: 1.5, signatureRadius: 11_100 }, dogma: { 1547: 4, 853: 1, 874: 1 } }),
  ...Hull({ typeID: 90000, name: 'Odd Tempest', group: 'Battleship', mass: 1, radius: 1, base: { maxVelocity: 1, agility: 1, signatureRadius: 1 }, dogma: {} }),
  ...Hull({ typeID: 35833, name: 'Astrahus', group: 'Citadel', mass: 1e10, radius: 1, base: { maxVelocity: 0, signatureRadius: 1 }, dogma: {} }),
  ...PropModRoutes({ typeID: 12084, name: '500MN Microwarpdrive II', attributes: { 20: 510, 567: 1.5e8, 796: 5e7, 554: 475, 73: 10_000 }, effects: [16, 6730] }),
  ...PropModRoutes({ typeID: 12058, name: '10MN Afterburner II', attributes: { 20: 135, 567: 1.5e7, 796: 5e6, 73: 10_000 }, effects: [16, 6731] }),
  ...PropModRoutes({ typeID: 12076, name: '50MN Microwarpdrive II', attributes: { 20: 510, 567: 1.5e7, 796: 5e6, 554: 475, 73: 10_000 }, effects: [16, 6730] }),
  ...PropModRoutes({ typeID: 5945, name: '500MN Cold-Gas Enduring Microwarpdrive', attributes: { 20: 505, 567: 1.5e8, 796: 5e7, 554: 500, 73: 10_000 }, effects: [16, 6730] }),
  [PROP_MOD_LISTING_ROUTE]: {
    json: {
      target: 'eve',
      table: 'types',
      filter: { field: 'groupID', value: '46' },
      items: [
        PropModRow(438, '1MN Afterburner II'),
        PropModRow(440, '5MN Microwarpdrive II'),
        PropModRow(12058, '10MN Afterburner II'),
        PropModRow(12076, '50MN Microwarpdrive II'),
        PropModRow(12084, '500MN Microwarpdrive II'),
        PropModRow(5945, '500MN Cold-Gas Enduring Microwarpdrive'),
        PropModRow(99999, 'Unpublished Microwarpdrive', false)
      ]
    }
  },
  ...PropModRoutes({ typeID: 3001, name: 'Some Gun', groupID: 55, attributes: {}, effects: [] })
};

/**
 * A ShipData reading the fake tools-core.
 *
 * @param routes - The routes to answer; the hulls and prop mods above by default.
 * @returns The ShipData and the list of paths it requested.
 */
export function MakeFakeShipData(routes: Record<string, Answer> = SHIP_ROUTES): { readonly shipData: ShipData; readonly calls: string[] } {
  const fake = FakeToolsCoreFetch(routes);
  return { shipData: new ShipData({ url: `${TOOLS_CORE}/`, fetch: fake.fetch }), calls: fake.calls };
}

/**
 * Tools-core with no prepared SDE: every SDE route of one hull answers 404 "not prepared".
 *
 * @param build - The SDE build tools-core names.
 * @param typeID - The hull asked for.
 * @returns The routes.
 */
export function UnpreparedSdeRoutes(build: string, typeID: number): Record<string, Answer> {
  const notPrepared: Answer = { status: 404, json: { error: `EVE SDE build ${build} is not prepared; run cjs-sde-prepare` } };
  return {
    '/eve/latest/build': { json: { builds: { sde: build } } },
    [`/eve/${build}/types/${typeID}?lang=en`]: notPrepared,
    [`/eve/${build}/dogma/types/${typeID}?sections=navigation,targeting`]: notPrepared,
    [`/eve/${build}/sde/typeDogma/${typeID}`]: notPrepared
  };
}
