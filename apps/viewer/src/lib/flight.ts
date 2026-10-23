/**
 * A ship's flight numbers in the page: its Ship stats, the same pipeline the hub's ship_stats tool runs.
 *
 * - One pipeline everywhere: published values, then the document's `stats` overrides, then the max-skills pilot,
 *   through the shared computeShipStats. `stats` therefore means the same thing with or without the SDE.
 * - Published values come from the hub's `GET /ship-stats` (tools-core's SDE). When the EVE data cannot name the hull
 *   (no SDE, an unknown DNA), class values by SOF hull category or bounding radius stand in, through the same math.
 *   All four `stats` pin the numbers whatever the hull.
 * - The ball radius is the hull's EVE radius (SDE `radius`) when the hub answered, as EVE measures ranges on it; else
 *   the SOF bounding radius, else DEFAULT_FLIGHT_RADIUS. Framing and get_state's `radius` keep the SOF sphere.
 * - Warp speed is the hull's warpSpeedMultiplier (AU/s; no skill changes it), else its class value.
 * - A prop mod (prop-mods.ts) runs through the same math: `propMod` is the ship's running numbers, which
 *   RunningFlight swaps in while the module runs. `maxVelocity` and the rest stay prop-mod-off.
 * - A fitted ship whose fit has resolved (fittings.ts) flies the dogma path instead: the same computeShipStats with
 *   `dogma`, its modules online (the prop mod's running numbers with that module active), and reports its defense and
 *   capacitor. `math` says which path ran.
 * - `incoming` (webs, painters, points and scrams running on the ship) goes to both computes, so a running MWD is
 *   webbed too; `warpScrambleStatus` says whether it can warp (above 0 it cannot).
 * - Lookups are cached per page session by the hub's own key (the EVE type, else the DNA's hull:faction:race); failures
 *   are cached with the hub's message until ForgetFailures (every load_scene / open_scene).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  type AppliedBonus,
  computeShipStats,
  type DogmaIncomingModifier,
  HULL_STAT_OVERRIDE_KEYS,
  type HullSizeClass,
  type HullStatOverrides,
  type HullStats,
  type PropModKind,
  type PropModModule,
  type RigSize,
  type SceneShip,
  type ShipCapacitor,
  type ShipDefense,
  type ShipDogmaInput,
  type ShipStats,
  type ShipStatsInput,
  type ShipStatsMath
} from '@scene-director/scene';
import type { ShipHull, ShipPhysics, ShipPropMod } from './destiny';
import type { PropModSource, ResolvedShipPropMod } from './prop-mods';
import { DEFAULT_WARP_SPEED } from './warp';

/**
 * Where a ship's flight numbers come from: the hub's EVE values, the document's four stats, or class values.
 */
export type FlightSource = 'sde' | 'stats' | 'class';

/**
 * A hull the hub named, with its published (unskilled) values.
 */
export interface PublishedHull {
  readonly typeID: number;
  readonly name: string;
  readonly published: HullStats;
}

/**
 * Seconds per prop mod cycle when the module has no duration.
 */
export const DEFAULT_PROP_MOD_CYCLE_TIME = 10;

/**
 * A ship's prop mod and the numbers it flies while the module runs.
 */
export interface ShipFlightPropMod extends ShipPropMod {
  readonly module: PropModModule;
  readonly name: string;
  readonly typeID?: number;
  readonly kind: PropModKind;
  readonly size: HullSizeClass;
  readonly source: PropModSource;
  readonly note?: string;
  /**
   * m, the MWD bloom included.
   */
  readonly signatureRadius: number;
  readonly alignTime: number;
  /**
   * The capacitor with the module running (the dogma path).
   */
  readonly capacitor?: ShipCapacitor;
}

/**
 * What a ship flies with, and where the numbers came from.
 */
export interface ShipFlight extends ShipPhysics {
  /**
   * m.
   */
  readonly signatureRadius: number;
  /**
   * Seconds to reach 75 % of max velocity from a standstill.
   */
  readonly alignTime: number;
  /**
   * AU/s.
   */
  readonly warpSpeed: number;
  readonly source: FlightSource;
  /**
   * The EVE type, when the hub named one.
   */
  readonly typeID?: number;
  readonly typeName?: string;
  /**
   * Why class values were used.
   */
  readonly note?: string;
  readonly propMod?: ShipFlightPropMod;
  /**
   * `dogma` for a fitted ship whose fit resolved, else `table` (the hull's published values and the skill table).
   */
  readonly math: ShipStatsMath;
  /**
   * HP, resists and EHP per layer (the dogma path); absent on the table path.
   */
  readonly defense?: ShipDefense;
  /**
   * The capacitor with the modules online (the dogma path); absent on the table path.
   */
  readonly capacitor?: ShipCapacitor;
  /**
   * warpScrambleStatus with the points and scrams on it and its own modules: above 0 it cannot warp.
   */
  readonly warpScrambleStatus: number;
  /**
   * The steps that changed warpScrambleStatus, when any did.
   */
  readonly warpScrambleSteps?: readonly AppliedBonus[];
}

export interface ResolveFlightInput {
  /**
   * The hull the hub named; null when it could not.
   */
  readonly published: Maybe<PublishedHull>;
  /**
   * Why there is no published hull.
   */
  readonly note?: Maybe<string>;
  /**
   * The SOF hull's category and bounding radius; null until the ship is built.
   */
  readonly hull: Maybe<ShipHull>;
  /**
   * The document ship's `stats`.
   */
  readonly overrides: Maybe<HullStatOverrides>;
  /**
   * The ship's prop mod; null or absent when it fits none.
   */
  readonly propMod?: Maybe<ResolvedShipPropMod>;
  /**
   * The ship's resolved fit (fittings.ts): the dogma path runs, `published` then gives only the type and radius.
   */
  readonly dogma?: Maybe<ShipDogmaInput>;
  /**
   * Modifiers other ships' modules put on it (incomingModifiersOf): webs, painters, points, scrams.
   */
  readonly incoming?: Maybe<readonly DogmaIncomingModifier[]>;
  /**
   * computeShipStats, or a memoized one (FitLookup.ShipStats).
   */
  readonly compute?: (input: ShipStatsInput) => ShipStats;
}

export type ShipClass = 'frigate' | 'destroyer' | 'cruiser' | 'battlecruiser' | 'battleship' | 'capital' | 'titan';

/**
 * Class values, not dogma: published-like numbers for a class, used only when the EVE data cannot name the hull. With
 * the max-skills pilot a frigate aligns in about 3.6 s and a battleship flies 137.5 m/s with about an 11 s align.
 */
// Warp speeds (AU/s) are the SDE's warpSpeedMultiplier by class, build 3632936 (2026-10-20).
export const CLASS_HULLS: Readonly<Record<ShipClass, HullStats>> = {
  frigate: { mass: 1.2e6, agility: 3.2, maxVelocity: 350, signatureRadius: 35, warpSpeedMultiplier: 5 },
  destroyer: { mass: 1.7e6, agility: 3.5, maxVelocity: 260, signatureRadius: 65, warpSpeedMultiplier: 4.5 },
  cruiser: { mass: 1.1e7, agility: 0.5, maxVelocity: 230, signatureRadius: 130, warpSpeedMultiplier: 4 },
  battlecruiser: { mass: 1.3e7, agility: 0.7, maxVelocity: 160, signatureRadius: 270, warpSpeedMultiplier: 3.5 },
  battleship: { mass: 1e8, agility: 0.12, maxVelocity: 110, signatureRadius: 400, warpSpeedMultiplier: 3 },
  capital: { mass: 1.1e9, agility: 0.035, maxVelocity: 80, signatureRadius: 11_000, warpSpeedMultiplier: 1.5 },
  titan: { mass: 2.4e9, agility: 0.025, maxVelocity: 70, signatureRadius: 18_000, warpSpeedMultiplier: 1.5 }
};

/**
 * SOF hull categories by class. Names other than frigate and battleship are unconfirmed; an unknown category falls
 * back to the radius bands.
 */
export const CATEGORY_CLASSES: Readonly<Record<string, ShipClass>> = {
  frigate: 'frigate',
  destroyer: 'destroyer',
  cruiser: 'cruiser',
  battlecruiser: 'battlecruiser',
  battleship: 'battleship',
  carrier: 'capital',
  dreadnought: 'capital',
  supercarrier: 'capital',
  forceauxiliary: 'capital',
  titan: 'titan'
};

/**
 * The hull size (rigSize) of each class: it picks the hull-sized prop mod when the EVE data cannot name the hull.
 */
export const CLASS_RIG_SIZES: Readonly<Record<ShipClass, RigSize>> = { frigate: 1, destroyer: 1, cruiser: 2, battlecruiser: 2, battleship: 3, capital: 4, titan: 4 };

/**
 * Bounding radius (m) upper bounds by class; anything larger is a titan.
 */
export const RADIUS_BANDS: readonly (readonly [number, ShipClass])[] = [
  [75, 'frigate'],
  [150, 'destroyer'],
  [350, 'cruiser'],
  [600, 'battlecruiser'],
  [1500, 'battleship'],
  [5000, 'capital']
];

/**
 * m: the ball radius when neither the hub nor SOF gives one.
 */
export const DEFAULT_FLIGHT_RADIUS = 100;

/**
 * How long a /ship-stats lookup may take: the hub's first DNA search may build tools-core's DNA index.
 */
export const HULL_STATS_TIMEOUT_MS = 90_000;

/**
 * A hull's class, by its SOF category, else its bounding radius; the cruiser class when nothing is known.
 *
 * @param hull - The SOF hull's category and bounding radius.
 * @returns The class.
 */
export function ShipClassOf(hull: Maybe<ShipHull>): ShipClass {
  const category = hull?.category?.toLowerCase().replaceAll(/[^a-z]/gu, '');
  let shipClass: Maybe<ShipClass> = category ? CATEGORY_CLASSES[category] : null;
  if (!shipClass && IsPositive(hull?.radius)) {
    const radius = hull.radius;
    shipClass = RADIUS_BANDS.find(([bound]) => radius < bound)?.[1] ?? 'titan';
  }
  return shipClass ?? 'cruiser';
}

/**
 * Class values for a hull, by its SOF category, else its bounding radius; the cruiser class when nothing is known.
 *
 * @param hull - The SOF hull's category and bounding radius.
 * @returns Published-like class values.
 */
export function ClassHull(hull: Maybe<ShipHull>): HullStats {
  return CLASS_HULLS[ShipClassOf(hull)];
}

/**
 * A ship's flight numbers: published (or class) values, then the document's overrides, then the max-skills pilot.
 *
 * @param input - The hub's hull, the SOF hull and the document's stats.
 * @returns What the ship flies with.
 * @throws {RangeError} From computeShipStats, when a value is out of range.
 */
export function ResolveFlight(input: ResolveFlightInput): ShipFlight {
  const { published, note, hull, overrides, propMod, dogma } = input;
  const incoming = input.incoming?.length ? input.incoming : null;
  const compute = (stats: ShipStatsInput): ShipStats => (input.compute ?? computeShipStats)(incoming ? { ...stats, incoming } : stats);
  const pinned = HULL_STAT_OVERRIDE_KEYS.every((key) => overrides?.[key] != null);
  let source: FlightSource = 'class';
  if (pinned) source = 'stats';
  else if (published || dogma) source = 'sde';
  const base = source === 'class' ? ClassHull(hull) : (published?.published ?? null);
  let stats: ShipStats;
  let running: Maybe<ShipStats> = null;
  if (dogma) {
    stats = compute({ hull: null, overrides, dogma });
    const propModKey = dogma.propModKey;
    if (propMod && propModKey != null) running = compute({ hull: null, overrides, dogma: { ...dogma, modules: (dogma.modules ?? []).map((module) => (module.key === propModKey ? { ...module, state: 'active' } : module)) } });
  } else {
    stats = compute({ hull: source === 'stats' ? null : base, overrides });
    if (propMod) running = compute({ hull: source === 'stats' ? null : base, overrides, propMod: propMod.stats });
  }
  let radius = DEFAULT_FLIGHT_RADIUS;
  if (IsPositive(stats.radius) && dogma) radius = stats.radius;
  else if (IsPositive(published?.published.radius)) radius = published.published.radius;
  else if (IsPositive(hull?.radius)) radius = hull.radius;
  const warpSpeed = [stats.warpSpeedMultiplier, published?.published.warpSpeedMultiplier].find(IsPositive) ?? ClassHull(hull).warpSpeedMultiplier ?? DEFAULT_WARP_SPEED;
  const warpScrambleSteps = stats.applied.filter((step) => step.attribute === 'warpScrambleStatus');
  return {
    mass: stats.mass,
    agility: stats.agility,
    maxVelocity: stats.maxVelocity,
    radius,
    warpSpeed,
    signatureRadius: stats.signatureRadius,
    alignTime: stats.alignTime,
    source,
    ...(published ? { typeID: published.typeID, typeName: published.name } : {}),
    ...(source === 'class' && note ? { note } : {}),
    ...(propMod && running
      ? {
          propMod: {
            module: propMod.module,
            name: propMod.stats.name,
            typeID: propMod.stats.typeID,
            kind: propMod.stats.kind,
            size: propMod.size,
            source: propMod.source,
            ...(propMod.note ? { note: propMod.note } : {}),
            mass: running.mass,
            maxVelocity: running.maxVelocity,
            signatureRadius: running.signatureRadius,
            alignTime: running.alignTime,
            cycleTime: running.propModCycleTime ?? DEFAULT_PROP_MOD_CYCLE_TIME,
            ...(running.capacitor ? { capacitor: running.capacitor } : {})
          }
        }
      : {}),
    math: stats.math,
    ...(stats.defense ? { defense: stats.defense } : {}),
    ...(stats.capacitor ? { capacitor: stats.capacitor } : {}),
    warpScrambleStatus: stats.warpScrambleStatus,
    ...(warpScrambleSteps.length ? { warpScrambleSteps } : {})
  };
}

/**
 * The numbers a ship flies now: its prop mod's mass, max velocity, signature radius, align time and capacitor while the
 * module runs, else its own.
 *
 * @param flight - The ship's flight.
 * @param running - Whether its prop mod runs.
 * @returns The flight as get_state's physics reports it.
 */
export function RunningFlight(flight: ShipFlight, running: boolean): ShipFlight {
  const propMod = running ? flight.propMod : null;
  return propMod ? { ...flight, mass: propMod.mass, maxVelocity: propMod.maxVelocity, signatureRadius: propMod.signatureRadius, alignTime: propMod.alignTime, ...(propMod.capacitor ? { capacitor: propMod.capacitor } : {}) } : flight;
}

/**
 * The ship fields a /ship-stats lookup reads.
 */
export type HullStatsShip = Pick<SceneShip, 'dna' | 'type'>;

/**
 * The cache key for a ship's lookup: the hub's own resolution, so ships naming the same type, or sharing a DNA's
 * hull:faction:race, share one request.
 *
 * @param ship - The document ship.
 * @returns `type:<type>` when the ship names one, else `dna:<hull:faction:race>`, lower case.
 */
export function HullStatsKey(ship: HullStatsShip): string {
  const type = ship.type == null ? '' : String(ship.type).trim();
  return type ? `type:${type.toLowerCase()}` : `dna:${ship.dna.split(':').slice(0, 3).join(':').toLowerCase()}`;
}

/**
 * What a lookup found: the hull, or why there is none.
 */
export interface HullStatsAnswer {
  readonly hull: Maybe<PublishedHull>;
  readonly note: Maybe<string>;
}

/**
 * The part of fetch a lookup uses.
 */
export type HullStatsFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'json'>>;

export interface HullStatsLookupOptions {
  /**
   * Defaults to the global fetch.
   */
  readonly fetch?: HullStatsFetch;
  /**
   * The hub route; defaults to `/ship-stats`.
   */
  readonly url?: string;
}

/**
 * The page's /ship-stats lookups: one request per key per page session, answered synchronously once cached.
 */
export class HullStatsLookup {
  private readonly fetch: HullStatsFetch;
  private readonly url: string;
  private readonly answers = new Map<string, HullStatsAnswer>();
  private readonly requests = new Map<string, Promise<HullStatsAnswer>>();

  constructor(options: HullStatsLookupOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.url = options.url ?? '/ship-stats';
  }

  /**
   * The cached answer for a ship.
   *
   * @param ship - The document ship.
   * @returns The answer, or null before its lookup has settled.
   */
  Cached(ship: HullStatsShip): Maybe<HullStatsAnswer> {
    return this.answers.get(HullStatsKey(ship)) ?? null;
  }

  /**
   * Looks a ship's hull up, once per key; a failure is cached as a note and logged once.
   *
   * @param ship - The document ship.
   * @returns The answer; it never rejects.
   */
  Lookup(ship: HullStatsShip): Promise<HullStatsAnswer> {
    const key = HullStatsKey(ship);
    const cached = this.answers.get(key);
    if (cached) return Promise.resolve(cached);
    let request = this.requests.get(key);
    if (!request) {
      request = this.Request(ship).then((answer) => {
        this.answers.set(key, answer);
        this.requests.delete(key);
        if (!answer.hull) console.warn(`ship stats for ${key}: ${answer.note ?? 'no answer'}`);
        return answer;
      });
      this.requests.set(key, request);
    }
    return request;
  }

  /**
   * Forgets every failed lookup, so the next Lookup asks again (after the SDE is prepared, say).
   */
  ForgetFailures(): void {
    for (const [key, answer] of this.answers) if (!answer.hull) this.answers.delete(key);
  }

  private async Request(ship: HullStatsShip): Promise<HullStatsAnswer> {
    let url = `${this.url}?dna=${encodeURIComponent(ship.dna)}`;
    if (ship.type != null) url += `&type=${encodeURIComponent(String(ship.type))}`;
    let answer: HullStatsAnswer;
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(HULL_STATS_TIMEOUT_MS) });
      const body: unknown = await Promise.resolve(response.json()).catch(() => null);
      answer = response.status === 200 ? ReadPublishedHull(body) : { hull: null, note: ReadErrorMessage(body) ?? `the hub's /ship-stats answered ${response.status}` };
    } catch (error) {
      answer = { hull: null, note: `the hub's /ship-stats did not answer (${error instanceof Error ? error.message : String(error)})` };
    }
    return answer;
  }
}

/**
 * The hull in a 200 /ship-stats answer.
 *
 * @param body - The parsed JSON.
 * @returns The hull, or a note when the answer names none.
 */
function ReadPublishedHull(body: unknown): HullStatsAnswer {
  const hull = Field(body, 'hull');
  const typeID = Field(hull, 'typeID');
  const name = Field(hull, 'name');
  const published = Field(hull, 'published');
  const valid = typeof typeID === 'number' && typeof name === 'string' && published !== null && typeof published === 'object';
  const note = Field(hull, 'note');
  return valid ? { hull: { typeID, name, published: published as HullStats }, note: null } : { hull: null, note: typeof note === 'string' ? note : "the hub's /ship-stats answer named no hull" };
}

function ReadErrorMessage(body: unknown): Maybe<string> {
  const message = Field(Field(body, 'error'), 'message');
  return typeof message === 'string' ? message : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function IsPositive(value: Maybe<number>): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
