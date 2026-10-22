/**
 * The hub's client for tools-core's EVE SDE routes: the pinned SDE build, JSON GETs and POSTs under
 * `/eve/<build>/`, the failure mapping (`unavailable` for no SDE or no tools-core, `not-found`, `ambiguous`,
 * `invalid`), a per-hub lookup cache, and the readers for tools-core's shapes. ShipData and DogmaData share one.
 *
 * tools-core runs with `--no-sde-auto-prepare`, so an unprepared build answers 404 "not prepared"; that becomes an
 * `unavailable` error naming the prepare command.
 */

import type { Maybe } from '@dereekb/util';
import { ErrorMessage, ToolError } from './tool-call';

export const REQUEST_TIMEOUT_MS = 30000;

export type ShipDataFailure = 'unavailable' | 'not-found' | 'ambiguous' | 'invalid';

/**
 * A hull, prop mod or dogma lookup that failed, with why.
 */
export class ShipDataError extends ToolError {
  readonly failure: ShipDataFailure;

  constructor(failure: ShipDataFailure, message: string) {
    super(message);
    this.name = 'ShipDataError';
    this.failure = failure;
  }
}

export type JsonObject = Record<string, unknown>;

export interface SdeClientOptions {
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

export interface SdeRequest {
  /**
   * The route under `/eve/<build>/`.
   */
  readonly route: string;
  /**
   * What is asked for, for messages.
   */
  readonly what: string;
  readonly timeoutMs?: number;
}

/**
 * A type's `sde/typeDogma` row.
 */
export interface SdeTypeDogma {
  readonly attributes: ReadonlyMap<number, number>;
  readonly effects: ReadonlySet<number>;
  /**
   * The `isDefault` effect, when it has one.
   */
  readonly defaultEffect: Maybe<number>;
}

export class SdeClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private sdeBuild: Maybe<Promise<string>>;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor({ url, fetch: fetchImpl = globalThis.fetch, sdeBuild = null }: SdeClientOptions) {
    this.url = url.replace(/\/+$/u, '');
    this.fetchImpl = fetchImpl;
    this.sdeBuild = sdeBuild ? Promise.resolve(sdeBuild) : null;
  }

  /**
   * The SDE build every lookup reads, resolved once; retried after a failure.
   *
   * @returns The build.
   */
  async SdeBuild(): Promise<string> {
    this.sdeBuild ??= this.FetchSdeBuild().catch((error: unknown) => {
      this.sdeBuild = null;
      throw error;
    });
    return this.sdeBuild;
  }

  /**
   * One cached lookup per key; a rejected lookup leaves the cache so the next call retries.
   *
   * @param key - The cache key.
   * @param load - Loads the value.
   * @returns The value.
   */
  async Cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let entry = this.cache.get(key) as Maybe<Promise<T>>;
    if (!entry) {
      entry = load();
      this.cache.set(key, entry);
      entry.catch(() => this.cache.delete(key));
    }
    return entry;
  }

  /**
   * GETs a route of the pinned build.
   *
   * @param request - The route, what it is and the deadline.
   * @returns The JSON body.
   * @throws {ShipDataError} Mapped from tools-core's status.
   */
  async GetJson(request: SdeRequest): Promise<JsonObject> {
    return this.Request(request, null);
  }

  /**
   * POSTs JSON to a route of the pinned build.
   *
   * @param request - The route, what it is and the deadline.
   * @param body - The JSON body to send.
   * @returns The JSON answer.
   * @throws {ShipDataError} Mapped from tools-core's status.
   */
  async PostJson(request: SdeRequest, body: unknown): Promise<JsonObject> {
    return this.Request(request, body);
  }

  /**
   * A type's `types/<id>?lang=en` row, cached.
   *
   * @param typeID - The type id.
   * @returns The row.
   */
  async Type(typeID: number): Promise<JsonObject> {
    return this.Cached(`type:${typeID}`, () => this.GetJson({ route: `types/${typeID}?lang=en`, what: `type ${typeID}` }));
  }

  /**
   * A type's `sde/typeDogma/<id>` row (attribute values, effects, the default effect), cached.
   *
   * @param typeID - The type id.
   * @returns The dogma.
   */
  async TypeDogma(typeID: number): Promise<SdeTypeDogma> {
    return this.Cached(`typeDogma:${typeID}`, async () => {
      const body = await this.GetJson({ route: `sde/typeDogma/${typeID}`, what: `type ${typeID}'s dogma` });
      const payload = ReadObject(body['payload'] ?? body);
      const attributes = new Map<number, number>();
      for (const entry of ReadArray(payload['dogmaAttributes'])) {
        const id = ReadNumber(entry['attributeID']);
        const value = ReadNumber(entry['value']);
        if (id != null && value != null) attributes.set(id, value);
      }
      const entries = ReadArray(payload['dogmaEffects']);
      const effects = new Set(entries.map((entry) => ReadNumber(entry['effectID'])));
      const defaultEffect = ReadNumber(entries.find((entry) => entry['isDefault'] === true)?.['effectID']);
      return { attributes, effects: effects as ReadonlySet<number>, defaultEffect };
    });
  }

  private async FetchSdeBuild(): Promise<string> {
    const body = await this.Fetch({ path: `${this.url}/eve/latest/build`, what: 'the EVE build', timeoutMs: REQUEST_TIMEOUT_MS, body: null });
    const builds = ReadObject(body.json['builds']);
    const build = builds['sde'] ?? body.json['build'];
    if (!body.ok || (typeof build !== 'string' && typeof build !== 'number')) {
      throw new ShipDataError('unavailable', `tools-core at ${this.url} did not name an EVE build (${body.status})`);
    }
    return String(build);
  }

  private async Request({ route, what, timeoutMs = REQUEST_TIMEOUT_MS }: SdeRequest, payload: unknown): Promise<JsonObject> {
    const build = await this.SdeBuild();
    const body = await this.Fetch({ path: `${this.url}/eve/${build}/${route}`, what, timeoutMs, body: payload });
    const error = typeof body.json['error'] === 'string' ? body.json['error'] : `answered ${body.status}`;
    if (body.ok) return body.json;
    if (body.status >= 500 || (body.status === 404 && /not prepared/iu.test(error))) throw UnavailableSde({ build, error });
    if (body.status === 404) throw new ShipDataError('not-found', `tools-core has no ${what} (${error})`);
    if (body.status === 409) throw new ShipDataError('ambiguous', `${what} is ambiguous (${error}); use an EVE type id`);
    throw new ShipDataError('invalid', `tools-core refused ${what} (${error})`);
  }

  private async Fetch({ path, what, timeoutMs, body }: { readonly path: string; readonly what: string; readonly timeoutMs: number; readonly body: unknown }): Promise<{ readonly ok: boolean; readonly status: number; readonly json: JsonObject }> {
    let response: Response;
    try {
      const init: RequestInit = body == null ? { signal: AbortSignal.timeout(timeoutMs) } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) };
      response = await this.fetchImpl(path, init);
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

export function ReadObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function ReadArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(ReadObject) : [];
}

export function ReadNumber(value: unknown): Maybe<number> {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A type id, which some tools-core routes send as a string (`dna/resolve` does).
 *
 * @param value - The candidate.
 * @returns The id, or null.
 */
export function ReadTypeID(value: unknown): Maybe<number> {
  const typeID = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof typeID === 'number' && Number.isSafeInteger(typeID) && typeID > 0 ? typeID : null;
}

/**
 * A localized name: a string, `{ text }` or `{ en }`.
 *
 * @param value - The candidate.
 * @returns The name, or null.
 */
export function ReadName(value: unknown): Maybe<string> {
  const object = ReadObject(value);
  const name = typeof value === 'string' ? value : (object['text'] ?? object['en']);
  return typeof name === 'string' && name ? name : null;
}
