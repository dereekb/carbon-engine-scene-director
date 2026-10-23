/**
 * Fake tools-core routes for AsteroidData, with the shapes and ids tools-core answered live on 2026-10-23 (captured
 * with curl against SDE build 3646012, served here on the fixture SDE build): `sde/types?query=` rows (cut to the
 * name hits), `sde/groups?field=categoryID&value=25` (the asteroid groups), and the `sde/graphics?field=sofFactionName`
 * rows of `ore_veldspar` (all 14), `crystal_darkochre` and `ice_blue`.
 */

import { AsteroidData } from './asteroid-data';
import { ObjectData } from './object-data';
import { type Answer, FakeToolsCoreFetch, SDE, TOOLS_CORE } from './ship-data.testing';

interface FakeOre {
  readonly typeID: number;
  readonly name: string;
  readonly groupID: number;
}

const ORES: readonly FakeOre[] = [
  { typeID: 1230, name: 'Veldspar', groupID: 462 },
  { typeID: 17470, name: 'Veldspar II-Grade', groupID: 462 },
  { typeID: 28432, name: 'Batch Compressed Veldspar', groupID: 462 },
  { typeID: 1232, name: 'Dark Ochre', groupID: 453 },
  { typeID: 46675, name: 'Dark Ochre IV-Grade', groupID: 453 },
  { typeID: 16264, name: 'Blue Ice', groupID: 465 },
  { typeID: 17975, name: 'Blue Ice IV-Grade', groupID: 465 },
  { typeID: 74521, name: 'Mordunium', groupID: 4513 },
  { typeID: 34, name: 'Tritanium', groupID: 18 }
];

/**
 * The asteroid groups (category 25) the fixture uses, as the category list names them.
 */
const ASTEROID_GROUPS: readonly [number, string][] = [
  [453, 'Dark Ochre'],
  [460, 'Scordite'],
  [462, 'Veldspar'],
  [465, 'Ice'],
  [1920, 'Common Moon Asteroids'],
  [4513, 'Mordunium']
];

const GROUP_NAMES: Readonly<Record<number, string>> = { ...Object.fromEntries(ASTEROID_GROUPS), 18: 'Mineral' };

/**
 * `ore_veldspar`'s 14 graphics rows: 12 rocks, the pre-built field mesh and an abyssal rock.
 */
export const VELDSPAR_HULLS = [
  'rock_01_m_v1a_whiteyellow',
  'rock_01_m_v2a_whiteyellow',
  'rock_01_m_v3a_whiteyellow',
  'rock_01_m_v4a_whiteyellow',
  'rock_01_field_v1a_whiteyellow',
  'rock_01_l_v1a_whiteyellow',
  'rock_01_l_v2a_whiteyellow',
  'rock_01_l_v3a_whiteyellow',
  'rock_01_l_v4a_whiteyellow',
  'rock_01_s_v1a_whiteyellow',
  'rock_01_s_v2a_whiteyellow',
  'rock_01_s_v3a_whiteyellow',
  'rock_01_s_v4a_whiteyellow',
  'as1_l_03_whitebrown'
];

function Rocks(family: string): string[] {
  return ['s', 'm', 'l'].flatMap((size) => [1, 2, 3, 4].map((shape) => family.replace('%', `${size}_v${shape}a`)));
}

function Search(query: string, names: readonly string[]): Record<string, Answer> {
  const rows = ORES.filter((ore) => names.includes(ore.name)).map((ore) => ({ table: 'types', id: String(ore.typeID), payload: { _key: ore.typeID, name: { en: ore.name }, groupID: ore.groupID, published: true } }));
  return { [`/eve/${SDE}/sde/types?query=${encodeURIComponent(query)}&limit=500`]: { json: { items: rows } } };
}

function Graphics(faction: string, hulls: readonly string[]): Record<string, Answer> {
  // rowCount is the whole graphics table, as tools-core answers it.
  const items = hulls.map((hull, index) => ({ table: 'graphics', id: String(20561 + index), payload: { _key: 20561 + index, sofFactionName: faction, sofHullName: hull, sofRaceName: 'asteroid' } }));
  return { [`/eve/${SDE}/sde/graphics?field=sofFactionName&value=${faction}&limit=200`]: { json: { table: 'graphics', rowCount: 6072, limit: 200, offset: 0, items } } };
}

export const ASTEROID_ROUTES: Record<string, Answer> = {
  ...Search('Veldspar', ['Veldspar', 'Veldspar II-Grade', 'Batch Compressed Veldspar']),
  ...Search('veldspar', ['Veldspar', 'Veldspar II-Grade', 'Batch Compressed Veldspar']),
  ...Search('Dark Ochre', ['Dark Ochre', 'Dark Ochre IV-Grade']),
  ...Search('Dark Ochre IV-Grade', ['Dark Ochre IV-Grade']),
  ...Search('Blue Ice', ['Blue Ice', 'Blue Ice IV-Grade']),
  ...Search('Blue Ice IV-Grade', ['Blue Ice IV-Grade']),
  ...Search('Mordunium', ['Mordunium']),
  ...Search('Tritanium', ['Tritanium']),
  ...Search('Veldsparr', []),
  ...Search('Common Moon Asteroids', []),
  ...Object.assign({}, ...Object.entries(GROUP_NAMES).map(([id, name]) => ({ [`/eve/${SDE}/sde/groups/${id}`]: { json: { payload: { _key: Number(id), categoryID: Number(id) === 18 ? 4 : 25, name: { en: name } } } } }))),
  [`/eve/${SDE}/sde/categories/25`]: { json: { payload: { _key: 25, name: { en: 'Asteroid' } } } },
  [`/eve/${SDE}/sde/categories/4`]: { json: { payload: { _key: 4, name: { en: 'Material' } } } },
  [`/eve/${SDE}/sde/groups?field=categoryID&value=25&limit=200`]: { json: { table: 'groups', rowCount: 1611, items: ASTEROID_GROUPS.map(([id, name]) => ({ table: 'groups', id: String(id), payload: { _key: id, categoryID: 25, name: { en: name } } })) } },
  ...Graphics('ore_veldspar', VELDSPAR_HULLS),
  ...Graphics('crystal_darkochre', Rocks('crystal_02_%_yellowred')),
  ...Graphics('ice_blue', Rocks('ice_01_%_whiteblue')),
  ...Graphics('r08', [...Rocks('rock_02_%_whiteyellow'), ...Rocks('crystal_02_%_yellowred')]),
  ...Graphics('ore_nothing', [])
};

/**
 * An AsteroidData over the fake routes.
 *
 * @param routes - The routes; default ASTEROID_ROUTES.
 * @returns The AsteroidData and the routes it asked for.
 */
export function MakeFakeAsteroidData(routes: Record<string, Answer> = ASTEROID_ROUTES): { readonly asteroidData: AsteroidData; readonly calls: string[] } {
  const fake = FakeToolsCoreFetch(routes);
  const objectData = new ObjectData({ url: TOOLS_CORE, sdeBuild: async () => SDE, resourceBuild: async () => SDE, fetch: fake.fetch });
  return { asteroidData: new AsteroidData({ objectData, url: `${TOOLS_CORE}/`, sdeBuild: async () => SDE, fetch: fake.fetch }), calls: fake.calls };
}
