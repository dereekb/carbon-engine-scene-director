/**
 * Fake tools-core routes for ObjectData, with the shapes tools-core answered live (SDE 3632936).
 */

import { ObjectData } from './object-data';
import { type Answer, FakeToolsCoreFetch, SDE, TOOLS_CORE } from './ship-data.testing';

export const ASTRAHUS_DNA = 'cm1_t1:upwell:generic';
export const WRECK_DNA = 'wreck_s:genericbase:generic';
export const RUINED_GATE_DNA = 'ghg_wreck:genericbase:generic';
export const STATION_DNA = 'cs3:caldaribase:caldari';

interface FakeType {
  readonly typeID: number;
  readonly name: string;
  readonly groupID: number;
  readonly group: string;
  readonly categoryID: number;
  readonly category: string;
  readonly graphicID?: number;
  readonly radius?: number;
  readonly published: boolean;
  /**
   * The SOF DNA, or null when dna/resolve answers 500.
   */
  readonly dna: string | null;
}

export const OBJECT_TYPES: readonly FakeType[] = [
  { typeID: 35832, name: 'Astrahus', groupID: 1657, group: 'Citadel', categoryID: 65, category: 'Structure', graphicID: 21137, radius: 45000, published: true, dna: ASTRAHUS_DNA },
  { typeID: 40644, name: 'Astrahus Wreck', groupID: 186, group: 'Wreck', categoryID: 2, category: 'Celestial', graphicID: 21455, radius: 45000, published: false, dna: 'cm1_t1_wreck:upwell:generic' },
  { typeID: 16737, name: 'Ruined Stargate', groupID: 226, group: 'Large Collidable Object', categoryID: 2, category: 'Celestial', graphicID: 1234, radius: 5991, published: false, dna: RUINED_GATE_DNA },
  { typeID: 26550, name: 'Minmatar Frigate Wreck', groupID: 186, group: 'Wreck', categoryID: 2, category: 'Celestial', graphicID: 3115, radius: 14, published: false, dna: WRECK_DNA },
  { typeID: 1531, name: 'Caldari Trading Station', groupID: 15, group: 'Station', categoryID: 3, category: 'Station', graphicID: 1374, radius: 33400, published: false, dna: STATION_DNA },
  { typeID: 34, name: 'Tritanium', groupID: 18, group: 'Mineral', categoryID: 4, category: 'Material', published: true, dna: null },
  { typeID: 3796, name: 'Sun G5 (Yellow)', groupID: 6, group: 'Sun', categoryID: 2, category: 'Celestial', graphicID: 21468, radius: 10000, published: false, dna: null },
  { typeID: 3797, name: 'Sun G5 (Yellow)', groupID: 6, group: 'Sun', categoryID: 2, category: 'Celestial', graphicID: 21469, radius: 10000, published: false, dna: null }
];

/**
 * A row whose name does not hold the query: a description-only match, as tools-core's substring search returns.
 */
const DESCRIPTION_ROW = { table: 'types', id: '33333', payload: { _key: 33333, name: { en: 'Sleeper Data Analyzer' }, groupID: 186, published: false, description: { en: 'Drifter wrecks and an Astrahus...' } } };

function Row(type: FakeType): unknown {
  return { table: 'types', id: String(type.typeID), payload: { _key: type.typeID, name: { en: type.name }, groupID: type.groupID, ...(type.graphicID ? { graphicID: type.graphicID } : {}), ...(type.radius ? { radius: type.radius } : {}), published: type.published } };
}

function Search(query: string, types: readonly FakeType[], extra: unknown[] = []): Record<string, Answer> {
  return { [`/eve/${SDE}/sde/types?query=${encodeURIComponent(query)}&limit=500`]: { json: { items: [...types.map(Row), ...extra] } } };
}

function TypeRoutes(type: FakeType): Record<string, Answer> {
  const record = {
    typeID: type.typeID,
    groupID: type.groupID,
    ...(type.graphicID ? { graphicID: type.graphicID } : {}),
    ...(type.radius ? { radius: type.radius } : {}),
    published: type.published,
    name: { text: type.name, language: 'en' },
    groupName: { text: type.group, language: 'en' },
    categoryID: type.categoryID,
    categoryName: { text: type.category, language: 'en' }
  };
  const dna: Answer = type.dna ? { json: { typeID: String(type.typeID), graphicID: String(type.graphicID), dna: type.dna } } : { status: 500, json: { error: 'Internal tool error' } };
  return { [`/eve/${SDE}/types/${type.typeID}?lang=en`]: { json: record }, [`/eve/${SDE}/dna/resolve?typeID=${type.typeID}`]: dna };
}

const byName = (name: string): FakeType => OBJECT_TYPES.find((type) => type.name === name) as FakeType;

export const OBJECT_ROUTES: Record<string, Answer> = {
  '/eve/latest/build': { json: { builds: { sde: SDE } } },
  ...Object.assign({}, ...OBJECT_TYPES.map(TypeRoutes)),
  ...Object.assign(
    {},
    ...['Astrahus', 'Ruined Stargate', 'Minmatar Frigate Wreck', 'Caldari Trading Station'].map((name) => ({
      [`/eve/${SDE}/dna/resolve?name=${encodeURIComponent(name.toLowerCase())}`]: { json: { typeID: String(byName(name).typeID), dna: byName(name).dna } },
      [`/eve/${SDE}/dna/resolve?name=${encodeURIComponent(name)}`]: { json: { typeID: String(byName(name).typeID), dna: byName(name).dna } }
    }))
  ),
  [`/eve/${SDE}/dna/resolve?name=Tritanium`]: { status: 500, json: { error: 'Internal tool error' } },
  [`/eve/${SDE}/dna/resolve?name=Sun%20G5%20(Yellow)`]: { status: 409, json: { error: 'SDE name "Sun G5 (Yellow)" has 3 identities' } },
  [`/eve/${SDE}/dna/resolve?name=Astrahuss`]: { status: 404, json: { error: 'SDE name "Astrahuss" not found' } },
  ...Search('Astrahus', [byName('Astrahus'), byName('Astrahus Wreck')], [DESCRIPTION_ROW]),
  ...Search('Astrahuss', []),
  ...Search('Tritanium', [byName('Tritanium')]),
  ...Search('Sun G5 (Yellow)', [byName('Sun G5 (Yellow)'), OBJECT_TYPES[7]]),
  ...Search('Wreck', [byName('Astrahus Wreck'), byName('Minmatar Frigate Wreck')]),
  [`/eve/${SDE}/sde/groups/1657`]: { json: { payload: { _key: 1657, categoryID: 65, name: { en: 'Citadel' } } } },
  [`/eve/${SDE}/sde/groups/186`]: { json: { payload: { _key: 186, categoryID: 2, name: { en: 'Wreck' } } } },
  [`/eve/${SDE}/sde/groups/18`]: { json: { payload: { _key: 18, categoryID: 4, name: { en: 'Mineral' } } } },
  [`/eve/${SDE}/sde/categories/65`]: { json: { payload: { _key: 65, name: { en: 'Structure' } } } },
  [`/eve/${SDE}/sde/categories/2`]: { json: { payload: { _key: 2, name: { en: 'Celestial' } } } },
  [`/eve/${SDE}/sde/categories/4`]: { json: { payload: { _key: 4, name: { en: 'Material' } } } }
};

/**
 * An ObjectData over the fake routes.
 *
 * @param routes - The routes; default OBJECT_ROUTES.
 * @returns The ObjectData and the routes it asked for.
 */
export function MakeFakeObjectData(routes: Record<string, Answer> = OBJECT_ROUTES): { readonly objectData: ObjectData; readonly calls: string[] } {
  const fake = FakeToolsCoreFetch(routes);
  return { objectData: new ObjectData({ url: `${TOOLS_CORE}/`, sdeBuild: async () => SDE, fetch: fake.fetch }), calls: fake.calls };
}
