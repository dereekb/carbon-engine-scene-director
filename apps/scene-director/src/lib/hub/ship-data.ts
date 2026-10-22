/**
 * Hull and prop-mod values from tools-core's EVE SDE, for the ship stats math.
 *
 * A scene ship resolves to an EVE type this way:
 *   1. an explicit `type` wins: a number is a type id, a string an exact English type
 *      name (`dna/resolve?name=`);
 *   2. otherwise the DNA's base `hull:faction:race` is matched in tools-core's DNA index
 *      (`dna/search`): bare-hull exact matches only, the lowest type id wins and the
 *      others are reported as candidates so a person can set `type`.
 *
 * The SDE build is tools-core's `builds.sde`, pinned once per hub. tools-core runs with
 * `--no-sde-auto-prepare`, so an unprepared build answers 404 "not prepared"; that
 * becomes an `unavailable` error naming the prepare command. Lookups are cached per hub
 * (a failed one is retried). tools-core's typed dogma sections lack the prop-mod
 * attributes, rigSize and the capital agility hooks, so those are read by attribute id
 * from `sde/typeDogma`.
 */

import type { Maybe } from '@dereekb/util';
import { type HullStats, normalizePropModName, type PropModKind, type PropModStats, type PropModType } from '@scene-director/scene';
import { ErrorMessage, ToolError } from './tool-call';

/*
 * EVE dogma ids (ESI, Tranquility, 2026-10-21).
 */
export const RIG_SIZE_ATTRIBUTE = 1547;
export const ADVANCED_AGILITY_ATTRIBUTE = 853;
export const ADVANCED_CAPITAL_AGILITY_ATTRIBUTE = 874;
export const SPEED_FACTOR_ATTRIBUTE = 20;
export const SPEED_BOOST_FACTOR_ATTRIBUTE = 567;
export const MASS_ADDITION_ATTRIBUTE = 796;
export const SIGNATURE_RADIUS_BONUS_ATTRIBUTE = 554;
export const DURATION_ATTRIBUTE = 73;
export const MWD_EFFECT = 6730;
export const AB_EFFECT = 6731;
export const PROPULSION_MODULE_GROUP = 46;

/**
 * The first `dna/search` builds tools-core's DNA index, so it gets a long deadline.
 */
const DNA_SEARCH_TIMEOUT_MS = 60000;
const REQUEST_TIMEOUT_MS = 30000;
const DNA_SEARCH_LIMIT = 50;

export type ShipDataFailure = 'unavailable' | 'not-found' | 'ambiguous' | 'invalid';

/**
 * A hull or prop mod lookup that failed, with why.
 */
export class ShipDataError extends ToolError {
  readonly failure: ShipDataFailure;

  constructor(failure: ShipDataFailure, message: string) {
    super(message);
    this.name = 'ShipDataError';
    this.failure = failure;
  }
}

export interface ShipDataOptions {
  /**
   * tools-core origin.
   */
  readonly url: string;
  readonly fetch?: typeof fetch;
  /**
   * Exact SDE build to pin; tools-core's `builds.sde` when absent.
   */
  readonly sdeBuild?: Maybe<string>;
}

/**
 * Names a hull: a scene ship's DNA and/or its explicit EVE type.
 */
export interface HullLookup {
  readonly dna?: Maybe<string>;
  readonly type?: Maybe<number | string>;
}

export interface ResolvedHull {
  readonly typeID: number;
  readonly name: string;
  readonly group: Maybe<string>;
  /**
   * The DNA tools-core holds for the type (a name lookup), or the DNA that was searched.
   */
  readonly dna: Maybe<string>;
  readonly resolvedFrom: 'type' | 'dna';
  /**
   * Other bare-hull types with the same DNA base, when the DNA picked the type.
   */
  readonly candidates: readonly { readonly typeID: number }[];
  readonly sdeBuild: string;
  readonly published: HullStats;
}

export interface ResolvedPropMod extends PropModStats {
  readonly typeID: number;
  readonly name: string;
}

/**
 * The SDE lookups the ship stats need; tests stand in a fake.
 */
export interface ShipDataApi {
  SdeBuild(): Promise<string>;
  Hull(lookup: HullLookup): Promise<ResolvedHull>;
  PropMod(typeID: number): Promise<ResolvedPropMod>;
  PropModByName(name: string): Promise<ResolvedPropMod>;
}

/**
 * How many close names an unknown module name lists.
 */
const PROP_MOD_CANDIDATE_LIMIT = 5;

type JsonObject = Record<string, unknown>;

interface TypeDogma {
  readonly attributes: ReadonlyMap<number, number>;
  readonly effects: ReadonlySet<number>;
}

interface ResolvedType {
  readonly typeID: number;
  readonly dna: Maybe<string>;
  readonly resolvedFrom: 'type' | 'dna';
  readonly candidates: readonly { readonly typeID: number }[];
}

interface GetJsonConfig {
  readonly route: string;
  readonly what: string;
  readonly timeoutMs?: number;
}

export class ShipData implements ShipDataApi {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private sdeBuild: Maybe<Promise<string>>;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor({ url, fetch: fetchImpl = globalThis.fetch, sdeBuild = null }: ShipDataOptions) {
    this.url = url.replace(/\/+$/u, '');
    this.fetchImpl = fetchImpl;
    this.sdeBuild = sdeBuild ? Promise.resolve(sdeBuild) : null;
  }

  /**
   * The SDE build every lookup reads, resolved once; retried after a failure.
   */
  async SdeBuild(): Promise<string> {
    this.sdeBuild ??= this.FetchSdeBuild().catch((error: unknown) => {
      this.sdeBuild = null;
      throw error;
    });
    return this.sdeBuild;
  }

  /**
   * A hull's EVE type and published values.
   *
   * @param lookup - The DNA and/or explicit type.
   * @returns The type, how it was picked and its values.
   * @throws {ShipDataError} When the SDE is unavailable or the hull cannot be resolved.
   */
  async Hull(lookup: HullLookup): Promise<ResolvedHull> {
    const resolved = await this.ResolveType(lookup);
    const sdeBuild = await this.SdeBuild();
    const [type, dogma, typeDogma] = await Promise.all([this.Type(resolved.typeID), this.Cached(`dogma:${resolved.typeID}`, () => this.GetJson({ route: `dogma/types/${resolved.typeID}?sections=navigation,targeting`, what: `type ${resolved.typeID}'s dogma` })), this.TypeDogma(resolved.typeID)]);
    const base = ReadObject(dogma['base']);
    const name = ReadName(type['name']) ?? `type ${resolved.typeID}`;
    const published: HullStats = {
      mass: ReadNumber(type['mass']) ?? 0,
      maxVelocity: ReadNumber(base['maxVelocity']) ?? 0,
      agility: ReadNumber(base['agility']) ?? 0,
      signatureRadius: ReadNumber(base['signatureRadius']) ?? 0,
      radius: ReadNumber(type['radius']),
      warpSpeedMultiplier: ReadNumber(base['warpSpeedMultiplier']),
      rigSize: typeDogma.attributes.get(RIG_SIZE_ATTRIBUTE) ?? null,
      advancedAgility: typeDogma.attributes.get(ADVANCED_AGILITY_ATTRIBUTE) ?? null,
      advancedCapitalAgility: typeDogma.attributes.get(ADVANCED_CAPITAL_AGILITY_ATTRIBUTE) ?? null
    };
    if (!(published.mass > 0) || !(published.agility > 0)) {
      throw new ShipDataError('invalid', `type ${resolved.typeID} (${name}) has no ${published.mass > 0 ? 'agility' : 'mass'}; it is not a ship`);
    }
    return { ...resolved, name, group: ReadName(type['groupName']), sdeBuild, published };
  }

  /**
   * A propulsion module's values.
   *
   * @param typeID - The module's EVE type id.
   * @returns Its kind, speed factor, thrust, mass addition and signature bloom.
   * @throws {ShipDataError} When the SDE is unavailable or the type is not a propulsion module.
   */
  async PropMod(typeID: number): Promise<ResolvedPropMod> {
    const [type, dogma] = await Promise.all([this.Type(typeID), this.TypeDogma(typeID)]);
    const name = ReadName(type['name']) ?? `type ${typeID}`;
    if (ReadNumber(type['groupID']) !== PROPULSION_MODULE_GROUP) {
      throw new ShipDataError('invalid', `type ${typeID} (${name}) is not a propulsion module (group ${PROPULSION_MODULE_GROUP})`);
    }
    const signatureRadiusBonus = dogma.attributes.get(SIGNATURE_RADIUS_BONUS_ATTRIBUTE) ?? 0;
    let kind: PropModKind = signatureRadiusBonus > 0 ? 'microwarpdrive' : 'afterburner';
    if (dogma.effects.has(MWD_EFFECT)) kind = 'microwarpdrive';
    else if (dogma.effects.has(AB_EFFECT)) kind = 'afterburner';
    return {
      typeID,
      name,
      kind,
      speedFactor: dogma.attributes.get(SPEED_FACTOR_ATTRIBUTE) ?? 0,
      speedBoostFactor: dogma.attributes.get(SPEED_BOOST_FACTOR_ATTRIBUTE) ?? 0,
      massAddition: dogma.attributes.get(MASS_ADDITION_ATTRIBUTE) ?? 0,
      signatureRadiusBonus,
      duration: dogma.attributes.get(DURATION_ATTRIBUTE) ?? null
    };
  }

  /**
   * A propulsion module by its English name, matched exactly after normalizePropModName (any case, MWD / AB
   * abbreviated), then read as PropMod does.
   *
   * @param name - The module name.
   * @returns The module's numbers.
   * @throws {ShipDataError} When the SDE is unavailable or no propulsion module has the name (listing close names).
   */
  async PropModByName(name: string): Promise<ResolvedPropMod> {
    const types = await this.PropModTypes();
    const key = normalizePropModName(name);
    const found = types.get(key);
    if (!found) {
      const words = key.split(' ').filter((word) => word.length > 1);
      const candidates = [...types.values()].filter((type) => words.every((word) => normalizePropModName(type.name).includes(word))).slice(0, PROP_MOD_CANDIDATE_LIMIT);
      const names = candidates.map((type) => `"${type.name}"`).join(', ');
      const hint = candidates.length ? `; close names: ${names}` : '';
      throw new ShipDataError('not-found', `no propulsion module is named "${name}"${hint}`);
    }
    return this.PropMod(found.typeID);
  }

  /**
   * Every published propulsion module (group 46), by normalized English name, read once per hub. dna/resolve
   * cannot resolve modules (they have no graphic, so it answers 500), so this lists the group through tools-core's
   * SDE inspection route instead (~650 KB, all languages).
   *
   * @returns The modules by normalizePropModName key.
   */
  private async PropModTypes(): Promise<ReadonlyMap<string, PropModType>> {
    return this.Cached('propModTypes', async () => {
      const body = await this.GetJson({ route: `sde/types?field=groupID&value=${PROPULSION_MODULE_GROUP}&limit=1000`, what: 'the propulsion modules' });
      const types = new Map<string, PropModType>();
      for (const item of ReadArray(body['items'])) {
        const payload = ReadObject(item['payload']);
        const typeID = ReadTypeID(payload['_key'] ?? item['id']);
        const name = ReadName(payload['name']);
        if (typeID != null && name && payload['published'] !== false) types.set(normalizePropModName(name), { typeID, name });
      }
      return types;
    });
  }

  private async ResolveType({ dna, type }: HullLookup): Promise<ResolvedType> {
    let resolved: Promise<ResolvedType>;
    if (typeof type === 'number') {
      resolved = this.resolveTypeID(type, dna ?? null);
    } else if (typeof type === 'string' && type.trim()) {
      resolved = this.ResolveTypeName(type.trim());
    } else if (dna) {
      resolved = this.ResolveDna(dna);
    } else {
      resolved = Promise.reject(new ShipDataError('invalid', 'name the hull by dna or type'));
    }
    return resolved;
  }

  /**
   * A type id's lookup; without a DNA it asks tools-core for the type's DNA, best effort (a failure leaves it null).
   *
   * @param typeID - The EVE type id.
   * @param dna - The DNA the lookup gave, if any.
   * @returns The type and its DNA.
   */
  private async resolveTypeID(typeID: number, dna: Maybe<string>): Promise<ResolvedType> {
    const found =
      dna ??
      (await this.Cached(`typeid:${typeID}`, () => this.GetJson({ route: `dna/resolve?typeID=${typeID}`, what: `type ${typeID}'s DNA` })).then(
        (body) => (typeof body['dna'] === 'string' ? body['dna'] : null),
        () => null
      ));
    return { typeID, dna: found, resolvedFrom: 'type', candidates: [] };
  }

  private async ResolveTypeName(name: string): Promise<ResolvedType> {
    const body = await this.Cached(`name:${name.toLowerCase()}`, () => this.GetJson({ route: `dna/resolve?name=${encodeURIComponent(name)}`, what: `EVE type "${name}"` }));
    const typeID = ReadTypeID(body['typeID']);
    if (typeID == null) throw new ShipDataError('not-found', `tools-core has no EVE type named "${name}"`);
    return { typeID, dna: typeof body['dna'] === 'string' ? body['dna'] : null, resolvedFrom: 'type', candidates: [] };
  }

  private async ResolveDna(dna: string): Promise<ResolvedType> {
    const base = dna.split(':').slice(0, 3).join(':').toLowerCase();
    const body = await this.Cached(`dna:${base}`, () => this.GetJson({ route: `dna/search?q=${encodeURIComponent(base)}&limit=${DNA_SEARCH_LIMIT}`, what: `hull "${base}"`, timeoutMs: DNA_SEARCH_TIMEOUT_MS }));
    const matches = Array.isArray(body['matches']) ? (body['matches'] as unknown[]).map(ReadObject) : [];
    const typeIDs = [
      ...new Set(
        matches
          .filter((match) => match['skinID'] == null && String(match['base'] ?? '').toLowerCase() === base)
          .map((match) => ReadTypeID(match['typeID']))
          .filter((typeID): typeID is number => typeID != null)
      )
    ].sort((a, b) => a - b);
    if (!typeIDs.length) throw new ShipDataError('not-found', `no EVE ship type has the DNA "${base}"; set the ship's type (an EVE type id or name), or give all four stats`);
    return { typeID: typeIDs[0], dna: base, resolvedFrom: 'dna', candidates: typeIDs.slice(1).map((typeID) => ({ typeID })) };
  }

  private async Type(typeID: number): Promise<JsonObject> {
    return this.Cached(`type:${typeID}`, () => this.GetJson({ route: `types/${typeID}?lang=en`, what: `type ${typeID}` }));
  }

  private async TypeDogma(typeID: number): Promise<TypeDogma> {
    return this.Cached(`typeDogma:${typeID}`, async () => {
      const body = await this.GetJson({ route: `sde/typeDogma/${typeID}`, what: `type ${typeID}'s dogma` });
      const payload = ReadObject(body['payload'] ?? body);
      const attributes = new Map<number, number>();
      for (const entry of ReadArray(payload['dogmaAttributes'])) {
        const id = ReadNumber(entry['attributeID']);
        const value = ReadNumber(entry['value']);
        if (id != null && value != null) attributes.set(id, value);
      }
      const effects = new Set(ReadArray(payload['dogmaEffects']).map((entry) => ReadNumber(entry['effectID'])));
      return { attributes, effects: effects as ReadonlySet<number> };
    });
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

  private async FetchSdeBuild(): Promise<string> {
    const body = await this.Fetch({ path: `${this.url}/eve/latest/build`, what: 'the EVE build', timeoutMs: REQUEST_TIMEOUT_MS });
    const builds = ReadObject(body.json['builds']);
    const build = builds['sde'] ?? body.json['build'];
    if (!body.ok || (typeof build !== 'string' && typeof build !== 'number')) {
      throw new ShipDataError('unavailable', `tools-core at ${this.url} did not name an EVE build (${body.status})`);
    }
    return String(build);
  }

  private async GetJson({ route, what, timeoutMs = REQUEST_TIMEOUT_MS }: GetJsonConfig): Promise<JsonObject> {
    const build = await this.SdeBuild();
    const body = await this.Fetch({ path: `${this.url}/eve/${build}/${route}`, what, timeoutMs });
    const error = typeof body.json['error'] === 'string' ? body.json['error'] : `answered ${body.status}`;
    if (body.ok) return body.json;
    if (body.status >= 500 || (body.status === 404 && /not prepared/iu.test(error))) throw UnavailableSde({ build, error });
    if (body.status === 404) throw new ShipDataError('not-found', `tools-core has no ${what} (${error})`);
    if (body.status === 409) throw new ShipDataError('ambiguous', `${what} is ambiguous (${error}); use an EVE type id`);
    throw new ShipDataError('invalid', `tools-core refused ${what} (${error})`);
  }

  private async Fetch({ path, what, timeoutMs }: { readonly path: string; readonly what: string; readonly timeoutMs: number }): Promise<{ readonly ok: boolean; readonly status: number; readonly json: JsonObject }> {
    let response: Response;
    try {
      response = await this.fetchImpl(path, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ShipDataError('unavailable', `tools-core at ${this.url} is unreachable for ${what}: ${ErrorMessage(error)}`);
    }
    const json = ReadObject(await response.json().catch(() => null));
    return { ok: response.ok, status: response.status, json };
  }
}

function UnavailableSde({ build, error }: { readonly build: string; readonly error: string }): ShipDataError {
  return new ShipDataError('unavailable', `tools-core has no SDE for build ${build} (${error}). In the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${build} (Node 22), or give the ship all four stats.`);
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
 * A type id, which some tools-core routes send as a string (`dna/resolve` does).
 */
function ReadTypeID(value: unknown): Maybe<number> {
  const typeID = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof typeID === 'number' && Number.isSafeInteger(typeID) && typeID > 0 ? typeID : null;
}

/**
 * A localized name: a string, `{ text }` or `{ en }`.
 */
function ReadName(value: unknown): Maybe<string> {
  const object = ReadObject(value);
  const name = typeof value === 'string' ? value : (object['text'] ?? object['en']);
  return typeof name === 'string' && name ? name : null;
}
