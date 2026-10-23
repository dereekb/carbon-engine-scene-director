import type { Maybe } from '@dereekb/util';
import { ASTEROID_ROCK_SIZES, type AsteroidRockSize, type SceneAsteroidRocks } from './field';

/**
 * SOF rock factions by asteroid group name (SDE category 25), lower case. CCP's ore-to-graphics mapping is client data
 * (`groupgraphics.fsdbinary`), not in the SDE, so this table is curated: each faction's rock hulls come live from the
 * SDE's `graphics` table (race `asteroid`).
 */
export const ASTEROID_GROUP_FACTIONS: Readonly<Record<string, string>> = {
  arkonor: 'crystal_arkonor',
  bistot: 'crystal_bistot',
  crokite: 'crystal_crokite',
  'dark ochre': 'crystal_darkochre',
  gneiss: 'ore_gneiss',
  hedbergite: 'crystal_hedbergite',
  hemorphite: 'crystal_hemorphite',
  jaspet: 'crystal_jaspet',
  kernite: 'ore_kernite',
  mercoxit: 'crystal_mercoxit',
  omber: 'ore_omber',
  plagioclase: 'ore_plagioclase',
  pyroxeres: 'ore_pyroxeres',
  scordite: 'ore_scordite',
  spodumain: 'crystal_spodumain',
  veldspar: 'ore_veldspar',
  fluorite: 'crystal_fluorite',
  tyranite: 'tyranite',
  'ubiquitous moon asteroids': 'r04',
  'common moon asteroids': 'r08',
  'uncommon moon asteroids': 'r16',
  'rare moon asteroids': 'r32',
  'exceptional moon asteroids': 'r64'
};

/**
 * The SDE's Ice group: every ice shares it, so its look goes by the type's base name (ICE_FACTIONS).
 */
export const ICE_GROUP_NAME = 'ice';

/**
 * SOF rock factions by ice base name, lower case.
 */
export const ICE_FACTIONS: Readonly<Record<string, string>> = {
  'blue ice': 'ice_blue',
  'clear icicle': 'ice_clearicicle',
  'dark glitter': 'ice_darkglitter',
  gelidus: 'ice_gelidus',
  'glacial mass': 'ice_glacialmass',
  'glare crust': 'ice_glarecrust',
  krystallos: 'ice_krystallos',
  'white glaze': 'ice_whiteglaze'
};

/**
 * The ores add_asteroid_field knows by name, for messages and the tool description.
 */
export const ASTEROID_ORE_NAMES: readonly string[] = [
  'Veldspar',
  'Scordite',
  'Pyroxeres',
  'Plagioclase',
  'Omber',
  'Kernite',
  'Jaspet',
  'Hemorphite',
  'Hedbergite',
  'Gneiss',
  'Dark Ochre',
  'Crokite',
  'Bistot',
  'Arkonor',
  'Spodumain',
  'Mercoxit',
  'Blue Ice',
  'Clear Icicle',
  'Glacial Mass',
  'White Glaze',
  'Glare Crust',
  'Dark Glitter',
  'Gelidus',
  'Krystallos',
  'Ubiquitous Moon Asteroids',
  'Common Moon Asteroids',
  'Uncommon Moon Asteroids',
  'Rare Moon Asteroids',
  'Exceptional Moon Asteroids',
  'Fluorite',
  'Tyranite'
];

export interface AsteroidRockFaction {
  readonly faction: string;
  /**
   * Which table answered: the group's, or the ice base name's.
   */
  readonly from: 'group' | 'ice';
}

/**
 * The SOF rock faction an asteroid type draws with.
 *
 * @param input - The type's group name and English name.
 * @param input.group - The SDE group name, e.g. "Veldspar", "Ice", "Common Moon Asteroids".
 * @param input.name - The type name, e.g. "Blue Ice IV-Grade" or "Compressed Veldspar".
 * @returns The faction, or null when the table has none.
 */
export function asteroidRockFaction(input: { readonly group: Maybe<string>; readonly name: string }): Maybe<AsteroidRockFaction> {
  const group = (input.group ?? '').trim().toLowerCase();
  let result: Maybe<AsteroidRockFaction> = null;
  if (group === ICE_GROUP_NAME) {
    const faction = ICE_FACTIONS[asteroidBaseName(input.name)];
    if (faction) result = { faction, from: 'ice' };
  } else {
    const faction = ASTEROID_GROUP_FACTIONS[group];
    if (faction) result = { faction, from: 'group' };
  }
  return result;
}

/**
 * An ore name without its compression prefix and grade suffix, lower case: "Batch Compressed Blue Ice IV-Grade" is
 * "blue ice".
 *
 * @param name - The type name.
 * @returns The base name.
 */
export function asteroidBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(?:batch\s+)?compressed\s+/u, '')
    .replace(/\s+(?:0|i{1,3}|iv)-grade$/u, '')
    .replace(/\s+/gu, ' ');
}

const SIZED_ROCK = /^(?:rock|crystal|ice)_\d{2}_(s|m|l)_v\d+a_[a-z]+$/u;

/**
 * A rock hull with no size in its name (Tyranite's `crystal_04v1`): it serves every size.
 */
const UNSIZED_ROCK = /^(?:rock|crystal|ice)_\d{2}v\d+$/u;

const SIZE_LETTERS: Readonly<Record<string, AsteroidRockSize>> = { s: 'small', m: 'medium', l: 'large' };

/**
 * Which model set a SOF rock hull belongs to.
 *
 * @param hull - The SOF hull name, e.g. `rock_01_m_v1a_whiteyellow`.
 * @returns small, medium or large; `any` for a rock hull with no size (`crystal_04v1`); null for anything else (the
 *   pre-built `*_field_*` meshes and the `as1_*` abyssal rocks), which a field skips.
 */
export function asteroidRockSize(hull: string): Maybe<AsteroidRockSize | 'any'> {
  const name = hull.trim().toLowerCase();
  const sized = SIZED_ROCK.exec(name);
  let size: Maybe<AsteroidRockSize | 'any'> = null;
  if (sized) size = SIZE_LETTERS[sized[1]];
  else if (UNSIZED_ROCK.test(name)) size = 'any';
  return size;
}

export interface AsteroidRockSet {
  readonly faction: string;
  readonly rocks: SceneAsteroidRocks;
  /**
   * Hulls that are not field rocks.
   */
  readonly skipped: string[];
  /**
   * Sizes filled from another bucket.
   */
  readonly notes: string[];
}

/**
 * Buckets a SOF faction's rock hulls into a field's three model sets, as DNAs `<hull>:<faction>:asteroid`, sorted.
 * An empty bucket borrows the nearest filled one (medium, then the other size); unsized rocks fill every bucket when
 * the faction has no sized ones.
 *
 * @param input - The faction and its hull names.
 * @param input.faction - The SOF faction.
 * @param input.hulls - Its hulls of race `asteroid`.
 * @returns The rock set, or null when no hull is a field rock.
 */
export function asteroidRockSet(input: { readonly faction: string; readonly hulls: readonly string[] }): Maybe<AsteroidRockSet> {
  const { faction, hulls } = input;
  const rocks: SceneAsteroidRocks = { small: [], medium: [], large: [] };
  const unsized: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const hull of [...new Set(hulls)].sort()) {
    const size = asteroidRockSize(hull);
    const dna = `${hull}:${faction}:asteroid`;
    if (size === 'any') unsized.push(dna);
    else if (size) rocks[size].push(dna);
    else skipped.push(hull);
  }
  const empty = ASTEROID_ROCK_SIZES.every((size) => !rocks[size].length);
  if (empty && unsized.length) for (const size of ASTEROID_ROCK_SIZES) rocks[size] = [...unsized];
  else skipped.push(...unsized.map((dna) => dna.split(':')[0]));
  if (ASTEROID_ROCK_SIZES.every((size) => !rocks[size].length)) return null;
  for (const size of ASTEROID_ROCK_SIZES) {
    if (rocks[size].length) continue;
    const donor = (['medium', ...ASTEROID_ROCK_SIZES.filter((other) => other !== 'medium')] as AsteroidRockSize[]).find((other) => rocks[other].length) as AsteroidRockSize;
    rocks[size] = [...rocks[donor]];
    notes.push(`${faction} has no ${size} rocks; ${size} uses its ${donor} ones`);
  }
  return { faction, rocks, skipped, notes };
}
