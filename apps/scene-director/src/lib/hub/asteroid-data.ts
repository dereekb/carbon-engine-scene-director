/**
 * EVE ores for `add_asteroid_field`: an ore name resolved through tools-core to its asteroid type and group, the SOF
 * rock faction it draws with (a curated table: CCP's ore-to-graphics mapping is client data, not in the SDE), and that
 * faction's rock models from the SDE's `graphics` table, bucketed small, medium and large.
 *
 * It reads on the hub's pinned SDE build, like ObjectData: `graphics` is an SDE table. Exact-build data never changes,
 * so every lookup is cached per hub; a failed one is retried.
 */

import type { Maybe } from '@dereekb/util';
import { ASTEROID_ORE_NAMES, asteroidRockFaction, asteroidRockSet, type SceneAsteroidRocks } from '@scene-director/scene';
import { NormalizeMapName } from './locations';
import type { ObjectDataApi } from './object-data';
import { ShipDataError } from './ship-data';
import { ToolsCoreUnreachableError } from './sde-client';

const REQUEST_TIMEOUT_MS = 30000;

/**
 * The SDE's Asteroid category.
 */
export const ASTEROID_CATEGORY_ID = 25;

/**
 * How many close names a not-found error suggests.
 */
const CLOSE_NAMES = 5;

type JsonObject = Record<string, unknown>;

export interface AsteroidDataOptions {
  readonly objectData: ObjectDataApi;
  /**
   * tools-core origin.
   */
  readonly url: string;
  /**
   * The hub's pinned SDE build: `() => shipData.SdeBuild()`.
   */
  readonly sdeBuild: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export interface ResolvedAsteroidOre {
  /**
   * The asteroid type, or null when the name was a group's ("Common Moon Asteroids").
   */
  readonly typeID: Maybe<number>;
  /**
   * The canonical English name: the type's, or the group's.
   */
  readonly name: string;
  readonly groupID: Maybe<number>;
  readonly group: string;
  readonly faction: string;
  /**
   * Which table answered: the group's, or the ice base name's.
   */
  readonly factionFrom: 'group' | 'ice';
}

export interface AsteroidRockSetAnswer {
  readonly faction: string;
  readonly rocks: SceneAsteroidRocks;
  /**
   * The faction's hulls that are not field rocks (pre-built field meshes, abyssal rocks).
   */
  readonly skipped: string[];
  /**
   * Sizes filled from another bucket.
   */
  readonly notes: string[];
}

export interface AsteroidDataApi {
  /**
   * @throws {ShipDataError} `not-found` (no such ore, or not an asteroid), `invalid` (no rock set is known) or
   *   `unavailable` (no SDE).
   */
  Ore(name: string): Promise<ResolvedAsteroidOre>;
  /**
   * @throws {ShipDataError} `not-found` (no rock models) or `unavailable` (no SDE).
   */
  RockSet(faction: string): Promise<AsteroidRockSetAnswer>;
}

interface Answer {
  readonly status: number;
  readonly json: JsonObject;
}

export class AsteroidData implements AsteroidDataApi {
  private readonly objectData: ObjectDataApi;
  private readonly url: string;
  private readonly sdeBuild: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor({ objectData, url, sdeBuild, fetch: fetchImpl = globalThis.fetch }: AsteroidDataOptions) {
    this.objectData = objectData;
    this.url = url.replace(/\/+$/u, '');
    this.sdeBuild = sdeBuild;
    this.fetchImpl = fetchImpl;
  }

  async Ore(name: string): Promise<ResolvedAsteroidOre> {
    const query = name.trim();
    if (!query) throw new ShipDataError('invalid', 'an ore name is empty');
    return this.Cached(`ore:${NormalizeMapName(query)}`, () => this.ResolveOre(query));
  }

  async RockSet(faction: string): Promise<AsteroidRockSetAnswer> {
    const wanted = faction.trim();
    return this.Cached(`rocks:${wanted}`, async () => {
      const answer = await this.GetAnswer(`sde/graphics?field=sofFactionName&value=${encodeURIComponent(wanted)}&limit=200`, `the SOF faction "${wanted}"'s graphics`);
      await this.ThrowFailure(answer, `the SOF faction "${wanted}"'s graphics`);
      // rowCount is the whole graphics table, not the filtered rows: read the items.
      const hulls = (Array.isArray(answer.json['items']) ? answer.json['items'] : []).flatMap((item) => {
        const payload = ReadObject(ReadObject(item)['payload']);
        return payload['sofRaceName'] === 'asteroid' && payload['sofFactionName'] === wanted && typeof payload['sofHullName'] === 'string' ? [payload['sofHullName']] : [];
      });
      const set = asteroidRockSet({ faction: wanted, hulls });
      if (!set) throw new ShipDataError('not-found', `SOF faction "${wanted}" has no rock models in SDE build ${await this.sdeBuild()}` + (hulls.length ? ` (its asteroid hulls ${hulls.join(', ')} are not field rocks)` : ''));
      return set;
    });
  }

  private async ResolveOre(query: string): Promise<ResolvedAsteroidOre> {
    const wanted = NormalizeMapName(query);
    const groups = await this.AsteroidGroups();
    const found = await this.objectData.Search({ query, group: 'asteroid', placeable: false, limit: 50 });
    const item = found.items.find((candidate) => NormalizeMapName(candidate.name) === wanted && candidate.group != null && groups.has(NormalizeMapName(candidate.group)));
    let ore: Maybe<{ readonly typeID: Maybe<number>; readonly name: string; readonly group: string; readonly groupID: Maybe<number> }> = null;
    if (item?.group) ore = { typeID: item.typeID, name: item.name, group: item.group, groupID: groups.get(NormalizeMapName(item.group))?.id ?? null };
    else {
      const group = groups.get(wanted);
      if (group) ore = { typeID: null, name: group.name, group: group.name, groupID: group.id };
    }
    if (!ore) throw await this.NotAnOre(query);
    const faction = asteroidRockFaction({ group: ore.group, name: ore.name });
    if (!faction) throw new ShipDataError('invalid', `no SOF rock set is known for ${ore.name} (group ${ore.group}); give { faction: "<SOF rock faction>" } or { rocks: [dna, ...] }`);
    return { ...ore, faction: faction.faction, factionFrom: faction.from };
  }

  /**
   * The refusal for a name that is no asteroid ore: another kind of type ("Tritanium is a Mineral"), else close names.
   */
  private async NotAnOre(query: string): Promise<ShipDataError> {
    const wanted = NormalizeMapName(query);
    const any = await this.objectData.Search({ query, placeable: false, limit: 20 });
    const exact = any.items.find((candidate) => NormalizeMapName(candidate.name) === wanted);
    let error: ShipDataError;
    if (exact) error = new ShipDataError('not-found', `${exact.name} is ${Article(exact.group ?? exact.category ?? 'type')} ${exact.group ?? exact.category ?? 'type'}, not an asteroid ore`);
    else {
      const close = CloseOreNames(query);
      error = new ShipDataError('not-found', `no asteroid ore is named "${query}"` + (close.length ? `; close names: ${close.join(', ')}` : '') + `; known ores: ${ASTEROID_ORE_NAMES.join(', ')}`);
    }
    return error;
  }

  /**
   * The SDE's asteroid groups (category 25) by normalized name.
   */
  private async AsteroidGroups(): Promise<Map<string, { readonly id: number; readonly name: string }>> {
    return this.Cached('groups', async () => {
      const answer = await this.GetAnswer(`sde/groups?field=categoryID&value=${ASTEROID_CATEGORY_ID}&limit=200`, 'the asteroid groups');
      await this.ThrowFailure(answer, 'the asteroid groups');
      const groups = new Map<string, { readonly id: number; readonly name: string }>();
      for (const item of Array.isArray(answer.json['items']) ? answer.json['items'] : []) {
        const payload = ReadObject(ReadObject(item)['payload']);
        const id = typeof payload['_key'] === 'number' ? payload['_key'] : Number(payload['_key']);
        const name = ReadName(payload['name']);
        if (Number.isSafeInteger(id) && name) groups.set(NormalizeMapName(name), { id, name });
      }
      return groups;
    });
  }

  /**
   * Throws for an answer that is not 200: no SDE (5xx or "not prepared") is `unavailable`.
   */
  private async ThrowFailure(answer: Answer, what: string): Promise<void> {
    const error = typeof answer.json['error'] === 'string' ? answer.json['error'] : `answered ${answer.status}`;
    if (answer.status === 200) return;
    if (answer.status >= 500 || (answer.status === 404 && /not prepared/iu.test(error))) {
      const build = await this.sdeBuild();
      throw new ShipDataError('unavailable', `tools-core has no SDE for build ${build} (${error}). In the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${build} (Node 22).`);
    }
    if (answer.status === 404) throw new ShipDataError('not-found', `tools-core has no ${what} (${error})`);
    throw new ShipDataError('invalid', `tools-core refused ${what} (${error})`);
  }

  /**
   * One cached lookup per key; a rejected lookup leaves the cache so the next call retries.
   */
  private async Cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let entry = this.cache.get(key) as Maybe<Promise<T>>;
    if (!entry) {
      entry = load();
      this.cache.set(key, entry);
      entry.catch(() => this.cache.delete(key));
    }
    return entry;
  }

  private async GetAnswer(route: string, what: string): Promise<Answer> {
    const build = await this.sdeBuild();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/eve/${build}/${route}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw ToolsCoreUnreachableError(this.url, what, error);
    }
    return { status: response.status, json: ReadObject(await response.json().catch(() => null)) };
  }
}

/**
 * The known ore names closest to a query: a shared prefix, or a few letters apart.
 *
 * @param query - The name asked for.
 * @returns Up to CLOSE_NAMES names.
 */
export function CloseOreNames(query: string): string[] {
  const wanted = NormalizeMapName(query);
  return ASTEROID_ORE_NAMES.map((name) => ({ name, distance: EditDistance(wanted, NormalizeMapName(name)) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(wanted.length / 3)) || NormalizeMapName(entry.name).startsWith(wanted.slice(0, 4)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CLOSE_NAMES)
    .map((entry) => entry.name);
}

function EditDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

function Article(word: string): string {
  return /^[aeiou]/iu.test(word) ? 'an' : 'a';
}

function ReadObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * A localized name: a string, `{ text }` or `{ en }`.
 */
function ReadName(value: unknown): Maybe<string> {
  const object = ReadObject(value);
  const name = typeof value === 'string' ? value : (object['text'] ?? object['en']);
  return typeof name === 'string' && name ? name : null;
}
