/**
 * EVE object types for the objects tools (`add_objects`, `search_objects`): a type name or id resolved through
 * tools-core to its type id, name, group, category, SDE radius and SOF DNA, and a name search over the SDE's types.
 *
 * ShipData refuses anything that is not a ship, so objects resolve here, on ShipData's pinned SDE build (MapData is
 * the precedent for a second tools-core client). tools-core's `dna/resolve` answers 500 for a type with no graphic
 * (Tritanium) or a graphic that is not SOF (a sun); that is classified from the type record, never read as "no SDE".
 * Exact-build data never changes, so every lookup is cached per hub; a failed one is retried.
 */

import type { Maybe } from '@dereekb/util';
import { NormalizeMapName } from './locations';
import { ShipDataError } from './ship-data';
import { ErrorMessage } from './tool-call';

const REQUEST_TIMEOUT_MS = 30000;

/**
 * How many rows `sde/types?query=` reads per search: a substring search over every text field.
 */
export const OBJECT_SEARCH_ROWS = 500;

export const DEFAULT_OBJECT_SEARCH_LIMIT = 20;

export const MAX_OBJECT_SEARCH_LIMIT = 50;

/**
 * How many close names a not-found error suggests.
 */
const CLOSE_NAMES = 5;

const SEARCH_HINT = 'search_objects lists types that can';

type JsonObject = Record<string, unknown>;

export interface ObjectDataOptions {
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

/**
 * Names an object type: a type id, or an exact English type name (any case).
 */
export interface ObjectTypeLookup {
  readonly type: number | string;
}

export interface ResolvedObjectType {
  readonly typeID: number;
  /**
   * The canonical English name.
   */
  readonly name: string;
  readonly group: Maybe<string>;
  readonly groupID: Maybe<number>;
  readonly category: Maybe<string>;
  readonly categoryID: Maybe<number>;
  readonly graphicID: number;
  /**
   * The SDE radius, metres; null when the type has none.
   */
  readonly radius: Maybe<number>;
  readonly dna: string;
  readonly published: boolean;
  readonly sdeBuild: string;
}

export interface ObjectSearchInput {
  /**
   * Part of an English type name.
   */
  readonly query: string;
  /**
   * A case-insensitive part of the group or category name, e.g. "wreck", "citadel", "structure".
   */
  readonly group?: Maybe<string>;
  /**
   * Default DEFAULT_OBJECT_SEARCH_LIMIT, at most MAX_OBJECT_SEARCH_LIMIT.
   */
  readonly limit?: Maybe<number>;
  /**
   * Keep only types with SOF DNA (default true).
   */
  readonly placeable?: Maybe<boolean>;
}

export interface ObjectSearchItem {
  readonly typeID: number;
  readonly name: string;
  readonly group: Maybe<string>;
  readonly category: Maybe<string>;
  readonly radius?: number;
  readonly dna?: string;
  readonly published: boolean;
}

export interface ObjectSearchAnswer {
  readonly query: string;
  /**
   * Rows whose name (and group, when given) matched, before the placeable check and the limit.
   */
  readonly total: number;
  readonly items: ObjectSearchItem[];
  readonly note?: string;
}

/**
 * The lookups the objects tools need; tests stand in for them.
 */
export interface ObjectDataApi {
  Type(lookup: ObjectTypeLookup): Promise<ResolvedObjectType>;
  Search(input: ObjectSearchInput): Promise<ObjectSearchAnswer>;
}

interface Answer {
  readonly status: number;
  readonly json: JsonObject;
}

/**
 * One `sde/types?query=` row.
 */
interface SearchRow {
  readonly typeID: number;
  readonly name: string;
  readonly groupID: Maybe<number>;
  readonly graphicID: Maybe<number>;
  readonly radius: Maybe<number>;
  readonly published: boolean;
}

export class ObjectData implements ObjectDataApi {
  private readonly url: string;
  private readonly sdeBuild: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor({ url, sdeBuild, fetch: fetchImpl = globalThis.fetch }: ObjectDataOptions) {
    this.url = url.replace(/\/$/u, '');
    this.sdeBuild = sdeBuild;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Resolves a type name or id to its SOF DNA, SDE radius, group and category.
   *
   * @param lookup - The type.
   * @returns The type.
   * @throws {ShipDataError} `not-found`, `ambiguous`, `invalid` (no graphic, not SOF) or `unavailable` (no SDE).
   */
  async Type(lookup: ObjectTypeLookup): Promise<ResolvedObjectType> {
    const { type } = lookup;
    let resolved: ResolvedObjectType;
    if (typeof type === 'number') resolved = await this.TypeById(type);
    else if (typeof type === 'string' && type.trim()) resolved = await this.TypeByName(type.trim());
    else throw new ShipDataError('invalid', 'type must be an EVE type id or name');
    return resolved;
  }

  /**
   * Types whose English name contains the query, ranked exact, prefix, word prefix, then substring; then shorter
   * names; then type id.
   *
   * @param input - The query, group filter, limit and whether only placeable types count.
   * @returns The answer.
   */
  async Search(input: ObjectSearchInput): Promise<ObjectSearchAnswer> {
    const query = input.query.trim();
    const limit = Math.min(MAX_OBJECT_SEARCH_LIMIT, Math.max(1, Math.round(input.limit ?? DEFAULT_OBJECT_SEARCH_LIMIT)));
    const placeable = input.placeable ?? true;
    const rows = await this.SearchRows(query);
    let matched = RankRows(rows, query);
    const groups = new Map<number, { readonly group: Maybe<string>; readonly category: Maybe<string> }>();
    await Promise.all([...new Set(matched.flatMap((row) => (row.groupID == null ? [] : [row.groupID])))].map(async (id) => groups.set(id, await this.GroupNames(id))));
    const named = (row: SearchRow): { readonly group: Maybe<string>; readonly category: Maybe<string> } => (row.groupID == null ? { group: null, category: null } : (groups.get(row.groupID) ?? { group: null, category: null }));
    const groupText = input.group?.trim() ? NormalizeMapName(input.group) : null;
    if (groupText) matched = matched.filter((row) => [named(row).group, named(row).category].some((text) => text != null && NormalizeMapName(text).includes(groupText)));

    const items: ObjectSearchItem[] = [];
    let dropped = 0;
    const candidates = placeable ? matched.filter((row) => row.graphicID != null) : matched;
    dropped += matched.length - candidates.length;
    for (const row of candidates.slice(0, placeable ? 2 * limit : limit)) {
      if (items.length >= limit) break;
      const dna = placeable ? await this.IdDnaText(row.typeID) : null;
      if (placeable && !dna) {
        dropped += 1;
        continue;
      }
      items.push({ typeID: row.typeID, name: row.name, ...named(row), ...(row.radius == null ? {} : { radius: row.radius }), ...(dna ? { dna } : {}), published: row.published });
    }
    const notes = [];
    if (placeable && dropped) notes.push(`${dropped} matching type(s) have no SOF graphic and were left out (placeable: false lists them)`);
    if (rows.length >= OBJECT_SEARCH_ROWS) notes.push(`the SDE search stopped at ${OBJECT_SEARCH_ROWS} rows; narrow the query`);
    return { query, total: matched.length, items, ...(notes.length ? { note: notes.join('; ') } : {}) };
  }

  private async TypeById(typeID: number): Promise<ResolvedObjectType> {
    const record = await this.TypeRecord(typeID);
    if (record.status === 404) throw new ShipDataError('not-found', `tools-core has no EVE type ${typeID}`);
    await this.ThrowFailure(record, `type ${typeID}`);
    const type = record.json;
    const name = ReadName(type['name']) ?? `type ${typeID}`;
    const group = ReadName(type['groupName']);
    const label = `type ${typeID} "${name}"` + (group ? ` (${group})` : '');
    const graphicID = ReadId(type['graphicID']);
    if (graphicID == null) throw new ShipDataError('invalid', `${label} has no graphic, so it cannot be placed; ${SEARCH_HINT}`);
    const dna = await this.IdDnaText(typeID);
    if (!dna) throw new ShipDataError('invalid', `${label} has graphic ${graphicID} but no SOF DNA: it is not a space object the page can build (set_location's dressing draws stars, planets and moons); ${SEARCH_HINT}`);
    return {
      typeID,
      name,
      group,
      groupID: ReadId(type['groupID']),
      category: ReadName(type['categoryName']),
      categoryID: ReadId(type['categoryID']),
      graphicID,
      radius: ReadPositive(type['radius']),
      dna,
      published: type['published'] === true,
      sdeBuild: await this.sdeBuild()
    };
  }

  private async TypeByName(name: string): Promise<ResolvedObjectType> {
    const answer = await this.NameDna(name);
    const error = AnswerError(answer);
    let resolved: ResolvedObjectType;
    if (answer.status === 200) {
      const typeID = ReadId(answer.json['typeID']);
      if (typeID == null) throw new ShipDataError('invalid', `tools-core answered no type id for "${name}"`);
      resolved = await this.TypeById(typeID);
    } else if (answer.status === 404 && /not prepared/iu.test(error)) {
      throw await this.Unavailable(error);
    } else if (answer.status === 404) {
      const close = await this.CloseNames(name);
      const named = close.map((text) => JSON.stringify(text)).join(', ');
      throw new ShipDataError('not-found', `no EVE type is named "${name}"` + (close.length ? `; close names: ${named}` : '') + '; search_objects finds more');
    } else if (answer.status === 409) {
      const ids = (await this.ExactRows(name)).map((row) => row.typeID);
      const listed = ids.length ? ` (${ids.join(', ')})` : '';
      throw new ShipDataError('ambiguous', `"${name}" names ${ids.length > 1 ? ids.length : 'several'} EVE types${listed}; give a type id`);
    } else if (answer.status >= 500) {
      const exact = await this.ExactRows(name);
      if (exact.length !== 1) throw await this.Unavailable(error);
      resolved = await this.TypeById(exact[0].typeID);
    } else {
      throw new ShipDataError('invalid', `tools-core refused EVE type "${name}" (${error})`);
    }
    return resolved;
  }

  /**
   * Up to CLOSE_NAMES names near a name that matched nothing: the search for it, else for it one or two characters
   * shorter (a typo at the end).
   */
  private async CloseNames(name: string): Promise<string[]> {
    let names: string[] = [];
    for (const query of [name, name.slice(0, -1), name.slice(0, -2)]) {
      if (names.length || query.trim().length < 3) break;
      names = RankRows(await this.SearchRows(query), query)
        .slice(0, CLOSE_NAMES)
        .map((row) => row.name);
    }
    return names;
  }

  private async ExactRows(name: string): Promise<SearchRow[]> {
    const wanted = NormalizeMapName(name);
    return (await this.SearchRows(name)).filter((row) => NormalizeMapName(row.name) === wanted);
  }

  private async TypeRecord(typeID: number): Promise<Answer> {
    return this.Cached(`type:${typeID}`, () => this.GetAnswer(`types/${typeID}?lang=en`, `type ${typeID}`));
  }

  private async NameDna(name: string): Promise<Answer> {
    return this.Cached(`name:${NormalizeMapName(name)}`, () => this.GetAnswer(`dna/resolve?name=${encodeURIComponent(name)}`, `EVE type "${name}"`));
  }

  /**
   * A type's SOF DNA, or null when dna/resolve has none for it (no graphic, or not SOF).
   */
  private async IdDnaText(typeID: number): Promise<Maybe<string>> {
    const answer = await this.Cached(`dna:${typeID}`, () => this.GetAnswer(`dna/resolve?typeID=${typeID}`, `type ${typeID}'s DNA`));
    if (answer.status === 404 && /not prepared/iu.test(AnswerError(answer))) throw await this.Unavailable(AnswerError(answer));
    const dna = answer.status === 200 ? answer.json['dna'] : null;
    return typeof dna === 'string' && dna ? dna : null;
  }

  private async SearchRows(query: string): Promise<SearchRow[]> {
    return this.Cached(`search:${NormalizeMapName(query)}`, async () => {
      const answer = await this.GetAnswer(`sde/types?query=${encodeURIComponent(query)}&limit=${OBJECT_SEARCH_ROWS}`, `the SDE types matching "${query}"`);
      await this.ThrowFailure(answer, `the SDE types matching "${query}"`);
      return (Array.isArray(answer.json['items']) ? answer.json['items'] : []).flatMap((item): SearchRow[] => {
        const row = ReadObject(item);
        const payload = ReadObject(row['payload']);
        const typeID = ReadId(payload['_key'] ?? row['id']);
        const name = ReadName(payload['name']);
        return typeID == null || !name ? [] : [{ typeID, name, groupID: ReadId(payload['groupID']), graphicID: ReadId(payload['graphicID']), radius: ReadPositive(payload['radius']), published: payload['published'] === true }];
      });
    });
  }

  private async GroupNames(groupID: number): Promise<{ readonly group: Maybe<string>; readonly category: Maybe<string> }> {
    const group = await this.Cached(`group:${groupID}`, () => this.GetAnswer(`sde/groups/${groupID}`, `group ${groupID}`));
    const payload = ReadObject(group.json['payload']);
    const categoryID = ReadId(payload['categoryID']);
    const category = categoryID == null ? null : await this.Cached(`category:${categoryID}`, () => this.GetAnswer(`sde/categories/${categoryID}`, `category ${categoryID}`));
    return { group: ReadName(payload['name']), category: category ? ReadName(ReadObject(category.json['payload'])['name']) : null };
  }

  /**
   * Throws for an answer that is not 200: no SDE (5xx or "not prepared") is `unavailable`.
   */
  private async ThrowFailure(answer: Answer, what: string): Promise<void> {
    const error = AnswerError(answer);
    if (answer.status === 200) return;
    if (answer.status >= 500 || (answer.status === 404 && /not prepared/iu.test(error))) throw await this.Unavailable(error);
    if (answer.status === 404) throw new ShipDataError('not-found', `tools-core has no ${what} (${error})`);
    throw new ShipDataError('invalid', `tools-core refused ${what} (${error})`);
  }

  private async Unavailable(error: string): Promise<ShipDataError> {
    const build = await this.sdeBuild();
    return new ShipDataError('unavailable', `tools-core has no SDE for build ${build} (${error}). In the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${build} (Node 22).`);
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

  /**
   * GETs a route of the pinned build: the status and body, never throwing for a status (only for an unreachable
   * tools-core).
   */
  private async GetAnswer(route: string, what: string): Promise<Answer> {
    const build = await this.sdeBuild();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/eve/${build}/${route}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new ShipDataError('unavailable', `tools-core at ${this.url} is unreachable for ${what}: ${ErrorMessage(error)}`);
    }
    return { status: response.status, json: ReadObject(await response.json().catch(() => null)) };
  }
}

/**
 * The rows whose English name contains the query, ranked.
 *
 * @param rows - The search rows.
 * @param query - The text.
 * @returns The matching rows, best first.
 */
function RankRows(rows: readonly SearchRow[], query: string): SearchRow[] {
  const wanted = NormalizeMapName(query);
  const rank = (name: string): number => {
    const text = NormalizeMapName(name);
    let value = 4;
    if (text === wanted) value = 0;
    else if (text.startsWith(wanted)) value = 1;
    else if (text.split(/[\s()-]+/u).some((word, index, words) => words.slice(index).join(' ').startsWith(wanted))) value = 2;
    else if (text.includes(wanted)) value = 3;
    return value;
  };
  return rows
    .map((row) => ({ row, rank: rank(row.name) }))
    .filter((entry) => entry.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.row.name.length - b.row.name.length || a.row.typeID - b.row.typeID)
    .map((entry) => entry.row);
}

function AnswerError(answer: Answer): string {
  return typeof answer.json['error'] === 'string' ? answer.json['error'] : `answered ${answer.status}`;
}

function ReadObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * An id, which some tools-core routes send as a string (`dna/resolve`, `sde/types` rows).
 */
function ReadId(value: unknown): Maybe<number> {
  const id = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function ReadPositive(value: unknown): Maybe<number> {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A localized name: a string, `{ text }` or `{ en }`.
 */
function ReadName(value: unknown): Maybe<string> {
  const object = ReadObject(value);
  const name = typeof value === 'string' ? value : (object['text'] ?? object['en']);
  return typeof name === 'string' && name ? name : null;
}
