/**
 * The page's `/weapon?type=` lookups: a fitted weapon's graphic (its turret `.black`, slot and SOF faction), one request
 * per type per page session, answered synchronously once cached (PropModLookup's pattern).
 *
 * - No answer, 502, 503 or 504 is retried after WEAPON_LOOKUP_RETRY_DELAYS_MS (FitLookup's rule: a fleet's burst of
 *   lookups can meet a dropped tools-core connection).
 * - A failure is cached with the hub's message until ForgetFailures (every load_scene / open_scene) and logged once.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { readWeaponGraphic, type WeaponGraphic } from '@scene-director/scene';
import { EVE_DATA_ON, type PageEveData } from './eve-data';

/**
 * A weapon type's graphic, or why there is none.
 */
export interface WeaponAnswer {
  readonly weapon: Maybe<WeaponGraphic>;
  readonly note: Maybe<string>;
}

/**
 * The part of fetch a lookup uses.
 */
export type WeaponFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'json'>>;

export interface WeaponLookupOptions {
  /**
   * The tab's EVE data mode; off, every lookup answers at once with the mode's note (no request).
   */
  readonly eveData?: PageEveData;
  /**
   * Defaults to the global fetch.
   */
  readonly fetch?: WeaponFetch;
  /**
   * The hub route; defaults to `/weapon`.
   */
  readonly url?: string;
  /**
   * Defaults to WEAPON_LOOKUP_RETRY_DELAYS_MS.
   */
  readonly retryDelaysMs?: readonly number[];
}

/**
 * How long one /weapon request may take.
 */
export const WEAPON_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Waits before retrying a lookup the hub could not answer (no answer, 502, 503, 504).
 */
export const WEAPON_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Statuses worth a retry; 0 is no answer at all.
 */
const RETRIED_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export class WeaponLookup {
  private readonly fetch: WeaponFetch;
  private readonly url: string;
  private readonly retryDelaysMs: readonly number[];
  private readonly answers = new Map<number, WeaponAnswer>();
  private readonly requests = new Map<number, Promise<WeaponAnswer>>();
  /**
   * The one answer in no-EVE-data mode; null with EVE data.
   */
  private readonly off: Maybe<WeaponAnswer>;

  constructor(options: WeaponLookupOptions = {}) {
    const eveData = options.eveData ?? EVE_DATA_ON;
    this.off = eveData.on ? null : Object.freeze({ weapon: null, note: eveData.note });
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.url = options.url ?? '/weapon';
    this.retryDelaysMs = options.retryDelaysMs ?? WEAPON_LOOKUP_RETRY_DELAYS_MS;
  }

  /**
   * The cached answer for a weapon type.
   *
   * @param typeID - The weapon's type id.
   * @returns The answer, or null before its lookup has settled.
   */
  Cached(typeID: number): Maybe<WeaponAnswer> {
    return this.off ?? this.answers.get(typeID) ?? null;
  }

  /**
   * Looks a weapon type up, once per type; a failure is cached as a note and logged once.
   *
   * @param typeID - The weapon's type id.
   * @returns The answer; it never rejects.
   */
  Lookup(typeID: number): Promise<WeaponAnswer> {
    if (this.off) return Promise.resolve(this.off);
    const cached = this.answers.get(typeID);
    if (cached) return Promise.resolve(cached);
    let request = this.requests.get(typeID);
    if (!request) {
      request = this.Request(typeID).then((answer) => {
        this.answers.set(typeID, answer);
        this.requests.delete(typeID);
        if (!answer.weapon) console.warn(`weapon ${typeID}: ${answer.note ?? 'no answer'}`);
        return answer;
      });
      this.requests.set(typeID, request);
    }
    return request;
  }

  /**
   * Forgets every failed lookup, so the next Lookup asks again.
   */
  ForgetFailures(): void {
    for (const [typeID, answer] of this.answers) if (!answer.weapon) this.answers.delete(typeID);
  }

  private async Request(typeID: number): Promise<WeaponAnswer> {
    let result = await this.RequestOnce(typeID);
    for (const delay of this.retryDelaysMs) {
      if (!RETRIED_STATUSES.has(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      result = await this.RequestOnce(typeID);
    }
    return result.answer;
  }

  private async RequestOnce(typeID: number): Promise<{ readonly answer: WeaponAnswer; readonly status: number }> {
    let result: { readonly answer: WeaponAnswer; readonly status: number };
    try {
      const response = await this.fetch(`${this.url}?type=${typeID}`, { signal: AbortSignal.timeout(WEAPON_LOOKUP_TIMEOUT_MS) });
      const body: unknown = await Promise.resolve(response.json()).catch(() => null);
      const weapon = response.status === 200 ? readWeaponGraphic(body) : null;
      let note: Maybe<string> = null;
      if (response.status !== 200) note = ReadErrorMessage(body) ?? `the hub's /weapon answered ${response.status}`;
      else if (!weapon) note = "the hub's /weapon answer is not a weapon graphic";
      result = { answer: { weapon, note }, status: response.status };
    } catch (error) {
      result = { answer: { weapon: null, note: `the hub's /weapon did not answer (${error instanceof Error ? error.message : String(error)})` }, status: 0 };
    }
    return result;
  }
}

function ReadErrorMessage(body: unknown): Maybe<string> {
  const message = Field(Field(body, 'error'), 'message');
  return typeof message === 'string' ? message : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
