/**
 * The scene location's system data, from the hub's `/map/system` (the hub subtracts the origin in float64, so every
 * position here is origin-relative and float32 holds), and the get_state report built from it. `location-dressing.ts`
 * draws the location (nebula, sun, planets, stations, gates) from `Answer()`.
 *
 * Node-tested: it imports nothing from the runtime.
 */

import type { Maybe } from '@dereekb/util';
import { type LocationReport, type LocationStatus, type MapSystemAnswer, type SceneLocation, toLocationReport } from '@scene-director/scene';

export const LOCATION_TIMEOUT_MS = 30_000;

export type LocationFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'json'>>;

export interface LocationLookupOptions {
  readonly fetch?: LocationFetch;
  /**
   * The hub route; `/map/system` by default.
   */
  readonly url?: string;
  /**
   * Called when an answer lands or a fetch fails.
   */
  readonly onChange?: () => void;
}

export interface LocationUpdateOptions {
  /**
   * Fetch again when the last fetch failed (a load or open of the scene).
   */
  readonly retry?: boolean;
}

type LocationOutcome = { readonly answer: MapSystemAnswer } | { readonly error: string };

/**
 * The fetch key: the system and the exact origin. Anything else in the location (names, the anchor) is the document's.
 *
 * @param location - The document's location.
 * @returns The key.
 */
export function LocationKey(location: SceneLocation): string {
  return `${location.system}@${location.origin.join(',')}`;
}

/**
 * The overlay row: "Jita · 30.0 km off Jita IV - Moon 4 - Caldari Navy Assembly Plant", "Jita", "Jita (loading)" or
 * "Jita (failed: ...)".
 *
 * @param report - Get_state's location.
 * @returns The panel text.
 */
export function LocationText(report: LocationReport): string {
  const system = report.system.name ?? `system ${report.system.id}`;
  const anchor = report.anchor;
  let text = system;
  if (report.status === 'loading') text = `${system} (loading)`;
  else if (report.status === 'failed') text = `${system} (failed: ${report.error ?? 'no answer'})`;
  else if (anchor && 'distance' in anchor) {
    const off = anchor.surfaceDistance ?? anchor.distance;
    text = `${system} · ${(off / 1000).toFixed(1)} km ${anchor.surfaceDistance == null ? 'from' : 'off'} ${anchor.name}`;
  }
  return text;
}

/**
 * Follows the document's location: fetches its system when the system or origin changes (or on retry after a failure),
 * drops late answers for an old key, and keeps the get_state report current.
 */
export class LocationLookup {
  private readonly fetch: LocationFetch;
  private readonly url: string;
  private readonly onChange: () => void;
  private location: Maybe<SceneLocation> = null;
  private key: Maybe<string> = null;
  private status: LocationStatus = 'loading';
  private error: Maybe<string> = null;
  private answer: Maybe<MapSystemAnswer> = null;
  private report: Maybe<LocationReport> = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: LocationLookupOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.url = options.url ?? '/map/system';
    this.onChange = options.onChange ?? (() => undefined);
  }

  /**
   * Follows the document's location: fetches when the system or origin changes, or on retry after a failure; null
   * clears everything.
   *
   * @param location - The document's location, or null.
   * @param options - Whether to retry a failed fetch.
   */
  Update(location: Maybe<SceneLocation>, { retry = false }: LocationUpdateOptions = {}): void {
    this.location = location;
    if (location) {
      const key = LocationKey(location);
      if (key !== this.key || (retry && this.status === 'failed')) this.Fetch(key, location);
    } else {
      this.key = null;
      this.answer = null;
      this.error = null;
      this.status = 'loading';
    }
    this.report = this.BuildReport();
  }

  /**
   * Get_state's location: null without one.
   */
  Report(): Maybe<LocationReport> {
    return this.report;
  }

  /**
   * The last answer, for the dressing entry: positions relative to the origin, nearest first.
   */
  Answer(): Maybe<MapSystemAnswer> {
    return this.answer;
  }

  /**
   * Settles once the current fetch has landed (or failed).
   */
  async Settled(): Promise<void> {
    return this.pending;
  }

  private Fetch(key: string, location: SceneLocation): void {
    this.key = key;
    this.status = 'loading';
    this.error = null;
    this.answer = null;
    const url = `${this.url}?id=${location.system}&origin=${location.origin.map(String).join(',')}`;
    this.pending = this.fetch(url, { signal: AbortSignal.timeout(LOCATION_TIMEOUT_MS) })
      .then(
        async (response): Promise<LocationOutcome> => {
          const body: unknown = await response.json().catch(() => null);
          return response.status === 200 && IsMapSystemAnswer(body) ? { answer: body } : { error: HubErrorMessage(body) ?? `the hub's /map/system answered ${response.status}` };
        },
        (error: unknown): LocationOutcome => ({ error: `the hub's /map/system did not answer (${error instanceof Error ? error.message : String(error)})` })
      )
      .then((outcome) => {
        if (this.key !== key) return;
        if ('answer' in outcome) {
          this.answer = outcome.answer;
          this.status = 'ready';
        } else {
          this.status = 'failed';
          this.error = outcome.error;
          console.warn(`location ${key}: ${outcome.error}`);
        }
        this.report = this.BuildReport();
        this.onChange();
      });
  }

  private BuildReport(): Maybe<LocationReport> {
    return this.location ? toLocationReport({ location: this.location, answer: this.answer, status: this.status, error: this.error }) : null;
  }
}

function IsMapSystemAnswer(value: unknown): value is MapSystemAnswer {
  const answer = value as Maybe<Partial<MapSystemAnswer>>;
  return answer != null && typeof answer === 'object' && typeof answer.system?.id === 'number' && Array.isArray(answer.celestials);
}

/**
 * The hub's `{ error: { message } }`.
 */
function HubErrorMessage(body: unknown): Maybe<string> {
  const error = body && typeof body === 'object' ? (body as { readonly error?: { readonly message?: unknown } }).error : null;
  return typeof error?.message === 'string' && error.message ? error.message : null;
}
