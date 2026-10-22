/**
 * tools-core's map routes for the location tools: search by name, one system, its celestials, one celestial by id.
 * Positions are float64 system metres (the star at [0, 0, 0]); galactic `position`s are never read.
 *
 * It reads the hub's single pinned SDE build (ShipData's) and maps tools-core's answers to ShipDataError as ShipData
 * does, so the hub's error-to-status mapping covers both. The map row's `radius` is null for stations and stargates,
 * so their radius comes from the type's SDE `radius`; the generic star, planet and moon types carry a 10 km
 * placeholder, so the map row's radius wins whenever it has one. Exact-build data never changes, so every route is
 * cached for the hub's lifetime (a failed lookup is retried).
 */

import type { Maybe } from '@dereekb/util';
import { type CelestialKind, isCelestialKind, type MapCelestial, type MapCelestialGraphics, type MapNamedRecord, type MapStar, type MapSystem, type SceneVector } from '@scene-director/scene';
import { ShipDataError } from './ship-data';
import { ErrorMessage } from './tool-call';

const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_SEARCH_LIMIT = 20;
const GRAPHICS_KEYS = ['sofDna', 'resFilePath', 'shaderPreset', 'heightMap1', 'heightMap2'] as const;
/**
 * The celestials route's kind arrays, in the order tools-core sends them.
 */
const CELESTIAL_GROUPS: readonly CelestialKind[] = ['star', 'planet', 'moon', 'asteroidBelt', 'station', 'stargate'];

export interface MapDataOptions {
  /**
   * tools-core origin.
   */
  readonly url: string;
  /**
   * The hub's pinned SDE build: `() => shipData.SdeBuild()`.
   */
  readonly sdeBuild: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /**
   * Diagnostics sink for dropped rows; nothing by default.
   */
  readonly log?: (line: string) => void;
}

export interface MapIndexState {
  readonly present: boolean;
  readonly degraded: boolean;
}

export interface MapSearchItem {
  readonly kind: string;
  readonly id: number;
  readonly name: string;
  readonly solarSystemID?: number;
  readonly constellationID?: number;
  readonly regionID?: number;
}

export interface MapSearchAnswer {
  readonly query: string;
  readonly total: number;
  readonly searchable: string[];
  readonly items: MapSearchItem[];
}

export interface MapSearchInput {
  readonly query: string;
  readonly kinds?: Maybe<readonly string[]>;
  readonly limit?: number;
}

/**
 * The map lookups the location tools need; tests use a MapData over a fake fetch.
 */
export interface MapDataApi {
  SdeBuild(): Promise<string>;
  Index(): Promise<MapIndexState>;
  Search(input: MapSearchInput): Promise<MapSearchAnswer>;
  System(id: number): Promise<MapSystem>;
  /**
   * The system's celestials in tools-core's order: the star, planets, moons, asteroid belts, stations, stargates.
   */
  SystemCelestials(id: number): Promise<MapCelestial[]>;
  Celestial(id: number): Promise<MapCelestial & { readonly solarSystemID: number }>;
}

type JsonObject = Record<string, unknown>;

export class MapData implements MapDataApi {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sdeBuild: () => Promise<string>;
  private readonly log: (line: string) => void;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor({ url, sdeBuild, fetch: fetchImpl = globalThis.fetch, log = () => undefined }: MapDataOptions) {
    this.url = url.replace(/\/+$/u, '');
    this.sdeBuild = sdeBuild;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  async SdeBuild(): Promise<string> {
    return this.sdeBuild();
  }

  /**
   * Whether tools-core's map index is there and whole. A failed lookup counts as present and whole: it only feeds notes.
   */
  async Index(): Promise<MapIndexState> {
    return this.GetJson({ route: 'map', what: 'the map' }).then(
      (body) => {
        const index = ReadObject(body['index']);
        return { present: index['present'] !== false, degraded: index['degraded'] === true };
      },
      () => ({ present: true, degraded: false })
    );
  }

  /**
   * Tools-core's map search: a case-insensitive substring, exact names first, then prefixes, then shorter names.
   *
   * @param input - The text, the kinds to search and the limit.
   * @returns The answer, its items read leniently.
   */
  async Search({ query, kinds, limit = DEFAULT_SEARCH_LIMIT }: MapSearchInput): Promise<MapSearchAnswer> {
    const kind = kinds?.length ? `&kind=${kinds.join(',')}` : '';
    const route = `map/search?q=${encodeURIComponent(query)}${kind}&limit=${limit}`;
    const body = await this.GetJson({ route, what: `a map search for "${query}"` });
    const items: MapSearchItem[] = [];
    for (const item of ReadArray(body['items'])) {
      const id = ReadId(item['id']);
      const name = ReadText(item['name']);
      if (id == null || !name) continue;
      const solarSystemID = ReadId(item['solarSystemID']);
      const constellationID = ReadId(item['constellationID']);
      const regionID = ReadId(item['regionID']);
      items.push({
        kind: String(item['kind'] ?? ''),
        id,
        name,
        ...(solarSystemID == null ? {} : { solarSystemID }),
        ...(constellationID == null ? {} : { constellationID }),
        ...(regionID == null ? {} : { regionID })
      });
    }
    const searchable = Array.isArray(body['searchable']) ? body['searchable'].map(String) : [];
    return { query: typeof body['query'] === 'string' ? body['query'] : query, total: ReadNumber(body['total']) ?? items.length, searchable, items };
  }

  /**
   * One solar system: its name, security, constellation, region, nebula and star.
   *
   * @param id - The system's EVE id.
   * @returns The system.
   * @throws {ShipDataError} `not-found` for an unknown id, `unavailable` without a prepared SDE.
   */
  async System(id: number): Promise<MapSystem> {
    return this.Cached(`system:${id}`, async () => {
      const body = await this.GetJson({ route: `map/systems/${id}?expand=all`, what: `solar system ${id}` });
      const derived = ReadObject(body['derived']);
      const nebula = ReadText(ReadObject(ReadObject(ReadObject(derived['scene'])['nebula'])['graphics'])['scene']) ?? ReadText(ReadObject(ReadObject(derived['nebula'])['graphics'])['scene']);
      return {
        id: ReadId(body['id']) ?? id,
        name: ReadText(body['name']) ?? `system ${id}`,
        securityStatus: ReadNumber(body['securityStatus']),
        securityClass: ReadText(body['securityClass']),
        constellation: ReadNamedRecord(body['constellation']),
        region: ReadNamedRecord(body['region']),
        nebula,
        star: ReadStar(derived['star'])
      };
    });
  }

  async SystemCelestials(id: number): Promise<MapCelestial[]> {
    return this.Cached(`celestials:${id}`, async () => {
      const body = await this.GetJson({ route: `map/systems/${id}/celestials?expand=all`, what: `solar system ${id}'s celestials` });
      const groups = ReadObject(body['celestials']);
      const rows = CELESTIAL_GROUPS.flatMap((kind) => ReadArray(groups[kind]).map((row) => ({ kind, row })));
      return Promise.all(rows.map(({ kind, row }) => this.ReadCelestial(row, kind))).then((celestials) => celestials.filter((celestial): celestial is MapCelestial => celestial != null));
    });
  }

  async Celestial(id: number): Promise<MapCelestial & { readonly solarSystemID: number }> {
    return this.Cached(`celestial:${id}`, async () => {
      const body = await this.GetJson({ route: `map/celestials/${id}?expand=all`, what: `celestial ${id}` });
      const celestial = await this.ReadCelestial(body, null);
      const solarSystemID = ReadId(body['solarSystemID']);
      if (!celestial || solarSystemID == null) throw new ShipDataError('invalid', `tools-core's celestial ${id} has no ${celestial ? 'solar system' : 'kind or position'}`);
      return { ...celestial, solarSystemID };
    });
  }

  /**
   * One celestial row; null (logged) for a row without a known kind or a position.
   */
  private async ReadCelestial(row: JsonObject, group: Maybe<CelestialKind>): Promise<Maybe<MapCelestial>> {
    const kind = isCelestialKind(row['kind']) ? row['kind'] : group;
    const id = ReadId(row['id']);
    const position = kind === 'star' ? (ReadVector(row['position']) ?? [0, 0, 0]) : ReadVector(row['position']);
    if (!kind || id == null || !position) {
      this.log(`map: dropped celestial ${String(row['id'])} (${!kind || id == null ? 'no kind or id' : 'no position'})`);
      return null;
    }
    const derived = ReadObject(row['derived']);
    const typeID = ReadId(row['typeID']);
    const mapRadius = ReadNumber(row['radius']);
    let radius: Maybe<number> = null;
    let radiusFrom: MapCelestial['radiusFrom'] = null;
    if (mapRadius != null && mapRadius > 0) {
      radius = mapRadius;
      radiusFrom = 'map';
    } else if (typeID != null) {
      radius = await this.TypeRadius(typeID);
      radiusFrom = radius == null ? null : 'type';
    }
    const orbitRecord = ReadObject(derived['orbit']);
    const orbitID = ReadId(orbitRecord['id']);
    const orbit = orbitID != null && isCelestialKind(orbitRecord['kind']) ? { id: orbitID, kind: orbitRecord['kind'] } : null;
    const graphicsRecord = ReadObject(derived['graphics']);
    const graphics: Partial<Record<keyof MapCelestialGraphics, string>> = {};
    for (const key of GRAPHICS_KEYS) {
      const value = ReadText(graphicsRecord[key]);
      if (value) graphics[key] = value;
    }
    const rotation = ReadQuaternion(ReadObject(derived['orientation'])['rotation']);
    const destinationRecord = ReadObject(row['destination']);
    const destinationSystem = ReadId(destinationRecord['solarSystemID']);
    const destinationGate = ReadId(destinationRecord['stargateID']);
    return {
      id,
      kind,
      name: ReadText(ReadObject(derived['name'])['text']) ?? `${kind} ${id}`,
      typeID,
      radius,
      radiusFrom,
      position,
      orbit,
      graphics,
      ...(rotation ? { rotation } : {}),
      ...(destinationSystem != null && destinationGate != null ? { destination: { system: destinationSystem, stargate: destinationGate } } : {})
    };
  }

  /**
   * A type's SDE radius, one cached lookup per type; null when the type has none or cannot be read.
   */
  private async TypeRadius(typeID: number): Promise<Maybe<number>> {
    return this.Cached(`type:${typeID}`, () => this.GetJson({ route: `types/${typeID}?lang=en`, what: `type ${typeID}` })).then(
      (type) => {
        const radius = ReadNumber(type['radius']);
        return radius != null && radius > 0 ? radius : null;
      },
      () => null
    );
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

  private async GetJson({ route, what }: { readonly route: string; readonly what: string }): Promise<JsonObject> {
    const build = await this.SdeBuild();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/eve/${build}/${route}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new ShipDataError('unavailable', `tools-core at ${this.url} is unreachable for ${what}: ${ErrorMessage(error)}`);
    }
    const json = ReadObject(await response.json().catch(() => null));
    const error = typeof json['error'] === 'string' ? json['error'] : `answered ${response.status}`;
    if (response.ok) return json;
    if (response.status >= 500 || (response.status === 404 && /not prepared/iu.test(error))) {
      throw new ShipDataError('unavailable', `tools-core has no SDE for build ${build} (${error}). In the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${build} (Node 22).`);
    }
    if (response.status === 404) throw new ShipDataError('not-found', `tools-core has no ${what} (${error})`);
    if (response.status === 409) throw new ShipDataError('ambiguous', `${what} is ambiguous (${error})`);
    throw new ShipDataError('invalid', `tools-core refused ${what} (${error})`);
  }
}

function ReadStar(value: unknown): Maybe<MapStar> {
  const star = ReadObject(value);
  const id = ReadId(star['id']);
  if (id == null) return null;
  const light = ReadObject(star['light']);
  const color = ReadVector(light['color']);
  const intensity = ReadNumber(light['intensity']);
  return {
    id,
    name: ReadText(star['name']) ?? `star ${id}`,
    typeID: ReadId(star['typeID']),
    radius: ReadNumber(star['radius']),
    spectralClass: ReadText(star['spectralClass']),
    temperature: ReadNumber(star['temperature']),
    luminosity: ReadNumber(star['luminosity']),
    light: color && intensity != null ? { color, intensity } : null,
    graphic: ReadText(ReadObject(star['graphics'])['resFilePath'])
  };
}

function ReadNamedRecord(value: unknown): Maybe<MapNamedRecord> {
  const record = ReadObject(value);
  const id = ReadId(record['id']);
  const name = ReadText(record['name']);
  return id != null && name ? { id, name } : null;
}

function ReadObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function ReadArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(ReadObject) : [];
}

function ReadNumber(value: unknown): Maybe<number> {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An EVE id: a positive safe integer, or its decimal string.
 */
function ReadId(value: unknown): Maybe<number> {
  const id = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function ReadVector(value: unknown): Maybe<SceneVector> {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component)) ? [value[0], value[1], value[2]] : null;
}

function ReadQuaternion(value: unknown): Maybe<[number, number, number, number]> {
  return Array.isArray(value) && value.length === 4 && value.every((component) => typeof component === 'number' && Number.isFinite(component)) ? [value[0], value[1], value[2], value[3]] : null;
}

/**
 * A non-empty string, or a localized `{ text }`.
 */
function ReadText(value: unknown): Maybe<string> {
  const text = typeof value === 'string' ? value : ReadObject(value)['text'];
  return typeof text === 'string' && text ? text : null;
}
