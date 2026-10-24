/**
 * The page's `/missile?charge=&launcher=` lookups: a launcher's missile graphics (the charge's EveMissile `.black` and
 * its impact effect), one request per (charge, launcher) per page session, answered synchronously once cached
 * (WeaponLookup's pattern).
 *
 * - No answer, 502, 503 or 504 is retried after MISSILE_LOOKUP_RETRY_DELAYS_MS.
 * - A failure is cached with the hub's message until ForgetFailures (every load_scene / open_scene) and logged once.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { readMissileGraphic, type MissileGraphic } from '@scene-director/scene';
import { EVE_DATA_ON, type PageEveData } from './eve-data';
import type { WeaponFetch } from './weapon-lookup';

/**
 * A missile's graphics, or why there are none.
 */
export interface MissileAnswer {
  readonly missile: Maybe<MissileGraphic>;
  readonly note: Maybe<string>;
}

export interface MissileLookupOptions {
  /**
   * The tab's EVE data mode; off, every lookup answers at once with the mode's note (no request).
   */
  readonly eveData?: PageEveData;
  /**
   * Defaults to the global fetch.
   */
  readonly fetch?: WeaponFetch;
  /**
   * The hub route; defaults to `/missile`.
   */
  readonly url?: string;
  /**
   * Defaults to MISSILE_LOOKUP_RETRY_DELAYS_MS.
   */
  readonly retryDelaysMs?: readonly number[];
}

/**
 * How long one /missile request may take.
 */
export const MISSILE_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Waits before retrying a lookup the hub could not answer (no answer, 502, 503, 504).
 */
export const MISSILE_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Statuses worth a retry; 0 is no answer at all.
 */
const RETRIED_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export class MissileLookup {
  private readonly fetch: WeaponFetch;
  private readonly url: string;
  private readonly retryDelaysMs: readonly number[];
  private readonly answers = new Map<string, MissileAnswer>();
  private readonly requests = new Map<string, Promise<MissileAnswer>>();
  /**
   * The one answer in no-EVE-data mode; null with EVE data.
   */
  private readonly off: Maybe<MissileAnswer>;

  constructor(options: MissileLookupOptions = {}) {
    const eveData = options.eveData ?? EVE_DATA_ON;
    this.off = eveData.on ? null : Object.freeze({ missile: null, note: eveData.note });
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.url = options.url ?? '/missile';
    this.retryDelaysMs = options.retryDelaysMs ?? MISSILE_LOOKUP_RETRY_DELAYS_MS;
  }

  /**
   * The cached answer for a charge in a launcher.
   *
   * @param charge - The charge's type id.
   * @param launcher - The launcher's type id.
   * @returns The answer, or null before its lookup has settled.
   */
  Cached(charge: number, launcher: number): Maybe<MissileAnswer> {
    return this.off ?? this.answers.get(MissileKey(charge, launcher)) ?? null;
  }

  /**
   * Looks a charge in a launcher up, once per pair; a failure is cached as a note and logged once.
   *
   * @param charge - The charge's type id.
   * @param launcher - The launcher's type id.
   * @returns The answer; it never rejects.
   */
  Lookup(charge: number, launcher: number): Promise<MissileAnswer> {
    if (this.off) return Promise.resolve(this.off);
    const key = MissileKey(charge, launcher);
    const cached = this.answers.get(key);
    if (cached) return Promise.resolve(cached);
    let request = this.requests.get(key);
    if (!request) {
      request = this.Request(charge, launcher).then((answer) => {
        this.answers.set(key, answer);
        this.requests.delete(key);
        if (!answer.missile) console.warn(`missile ${charge} in launcher ${launcher}: ${answer.note ?? 'no answer'}`);
        return answer;
      });
      this.requests.set(key, request);
    }
    return request;
  }

  /**
   * Forgets every failed lookup, so the next Lookup asks again.
   */
  ForgetFailures(): void {
    for (const [key, answer] of this.answers) if (!answer.missile) this.answers.delete(key);
  }

  private async Request(charge: number, launcher: number): Promise<MissileAnswer> {
    let result = await this.RequestOnce(charge, launcher);
    for (const delay of this.retryDelaysMs) {
      if (!RETRIED_STATUSES.has(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      result = await this.RequestOnce(charge, launcher);
    }
    return result.answer;
  }

  private async RequestOnce(charge: number, launcher: number): Promise<{ readonly answer: MissileAnswer; readonly status: number }> {
    let result: { readonly answer: MissileAnswer; readonly status: number };
    try {
      const response = await this.fetch(`${this.url}?charge=${charge}&launcher=${launcher}`, { signal: AbortSignal.timeout(MISSILE_LOOKUP_TIMEOUT_MS) });
      const body: unknown = await Promise.resolve(response.json()).catch(() => null);
      const missile = response.status === 200 ? readMissileGraphic(body) : null;
      let note: Maybe<string> = null;
      if (response.status !== 200) note = ReadErrorMessage(body) ?? `the hub's /missile answered ${response.status}`;
      else if (!missile) note = "the hub's /missile answer is not a missile graphic";
      result = { answer: { missile, note }, status: response.status };
    } catch (error) {
      result = { answer: { missile: null, note: `the hub's /missile did not answer (${error instanceof Error ? error.message : String(error)})` }, status: 0 };
    }
    return result;
  }
}

function MissileKey(charge: number, launcher: number): string {
  return `${charge}|${launcher}`;
}

function ReadErrorMessage(body: unknown): Maybe<string> {
  const message = Field(Field(body, 'error'), 'message');
  return typeof message === 'string' ? message : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
