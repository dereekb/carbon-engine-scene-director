/**
 * Which prop mod a ship flies and its numbers, in the page.
 *
 * - The module is the document's `propMod.module`, else DEFAULT_PROP_MOD_MODULE (the hull-sized microwarpdrive).
 *   "mwd" / "ab" become the Tech II module of that kind for the hull's rigSize: the SDE's when the hub named the hull,
 *   else the SOF class's (CLASS_RIG_SIZES).
 * - Numbers come from the hub's `GET /prop-mod` (tools-core's SDE), else BAKED_PROP_MODS, else the hull-sized Tech II
 *   module of the name's kind standing in (source "default", with a note).
 * - Lookups are cached per page session, like HullStatsLookup's: one request per key, failures cached with the hub's
 *   message until ForgetFailures (every load_scene / open_scene).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { type BakedPropMod, findBakedPropMod, findHullSizedPropMod, HULL_SIZE_CLASSES, type HullSizeClass, normalizePropModName, PROP_MOD_MODULE_AB, PROP_MOD_MODULE_NONE, type PropModKind, type PropModModule, type PropModStats, propModKindOfName, readRigSize, type RigSize } from '@scene-director/scene';
import type { ShipHull } from './destiny';
import { EVE_DATA_ON, type PageEveData } from './eve-data';
import { CLASS_RIG_SIZES, type PublishedHull, ShipClassOf } from './flight';

/**
 * Where a ship's prop mod numbers come from: the hub's EVE values, the built-in table, or the hull-sized module
 * standing in for one neither knows.
 */
export type PropModSource = 'sde' | 'baked' | 'default';

/**
 * A prop mod's numbers as fitted, with its identity.
 */
export interface PropModNumbers extends PropModStats {
  readonly typeID: number;
  readonly name: string;
}

/**
 * The prop mod a ship flies.
 */
export interface ResolvedShipPropMod {
  /**
   * The module as the document names it (or the default).
   */
  readonly module: PropModModule;
  readonly stats: PropModNumbers;
  readonly source: PropModSource;
  /**
   * Why the numbers are not the named module's own.
   */
  readonly note?: string;
  readonly size: HullSizeClass;
}

/**
 * What a /prop-mod lookup found: the module's numbers, or why there are none.
 */
export interface PropModAnswer {
  readonly propMod: Maybe<PropModNumbers>;
  readonly note: Maybe<string>;
}

/**
 * The cache key of a module lookup.
 *
 * @param module - A type id or a module name (not a keyword).
 * @returns `id:<n>`, or `name:<normalizePropModName>`.
 */
export function PropModKey(module: string | number): string {
  return typeof module === 'number' ? `id:${module}` : `name:${normalizePropModName(module)}`;
}

/**
 * The type id or name a ship's module is looked up by: "mwd" / "ab" sized for the hull, a type id, or a name.
 *
 * @param module - The canonical module.
 * @param rigSize - The hull's rigSize.
 * @returns The type id or name; null for "none".
 */
export function PropModLookupTarget(module: PropModModule, rigSize: RigSize): Maybe<string | number> {
  let target: Maybe<string | number> = module;
  if (module === PROP_MOD_MODULE_NONE) target = null;
  else if (module === 'mwd' || module === PROP_MOD_MODULE_AB) target = findHullSizedPropMod({ rigSize, kind: module === PROP_MOD_MODULE_AB ? 'afterburner' : 'microwarpdrive' })?.typeID ?? null;
  return target;
}

export interface RigSizeOfInput {
  readonly published: Maybe<PublishedHull>;
  readonly hull: Maybe<ShipHull>;
}

/**
 * A ship's hull size: the SDE rigSize when the hub named the hull, else its SOF class's.
 *
 * @param input - The hub's hull and the SOF hull.
 * @returns 1 small, 2 medium, 3 large or 4 capital.
 */
export function RigSizeOf(input: RigSizeOfInput): RigSize {
  return readRigSize(input.published?.published.rigSize) ?? CLASS_RIG_SIZES[ShipClassOf(input.hull)];
}

export interface ResolveShipPropModInput {
  readonly module: PropModModule;
  readonly rigSize: RigSize;
  /**
   * The hub's answer for the module, null before it settles.
   */
  readonly answer: Maybe<PropModAnswer>;
}

/**
 * A ship's prop mod and its numbers.
 *
 * @param input - The module, the hull's size and the hub's answer.
 * @returns The prop mod, or null for "none".
 */
export function ResolveShipPropMod(input: ResolveShipPropModInput): Maybe<ResolvedShipPropMod> {
  const { module, rigSize, answer } = input;
  const target = PropModLookupTarget(module, rigSize);
  if (target == null) return null;
  const size = HULL_SIZE_CLASSES[rigSize];
  let resolved: ResolvedShipPropMod;
  const baked = findBakedPropMod(target);
  if (answer?.propMod) {
    resolved = { module, stats: answer.propMod, source: 'sde', size };
  } else if (baked) {
    resolved = { module, stats: baked, source: 'baked', size, ...(answer?.note ? { note: answer.note } : {}) };
  } else {
    const kind: PropModKind = (typeof target === 'string' ? propModKindOfName(target) : null) ?? 'microwarpdrive';
    const stand = findBakedPropMod(findHullSizedPropMod({ rigSize, kind })?.typeID ?? 0) as BakedPropMod;
    const why = answer?.note ?? 'the EVE data has not answered yet';
    const named = typeof target === 'number' ? `type ${target}` : `"${target}"`;
    resolved = { module, stats: stand, source: 'default', size, note: `${stand.name} stands in for ${named}: ${why}` };
  }
  return resolved;
}

/**
 * The part of fetch a lookup uses.
 */
export type PropModFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'json'>>;

export interface PropModLookupOptions {
  /**
   * Defaults to the global fetch.
   */
  readonly fetch?: PropModFetch;
  /**
   * The tab's EVE data mode; off, every module answers at once with the mode's note (no request), so a named module
   * flies as the hull-sized stand-in and mwd / ab as their baked numbers.
   */
  readonly eveData?: PageEveData;
  /**
   * The hub route; defaults to `/prop-mod`.
   */
  readonly url?: string;
}

/**
 * How long a /prop-mod lookup may take: the hub's first one lists every propulsion module.
 */
export const PROP_MOD_LOOKUP_TIMEOUT_MS = 60_000;

/**
 * The page's /prop-mod lookups: one request per module per page session, answered synchronously once cached.
 */
export class PropModLookup {
  private readonly fetch: PropModFetch;
  private readonly url: string;
  private readonly answers = new Map<string, PropModAnswer>();
  private readonly requests = new Map<string, Promise<PropModAnswer>>();
  /**
   * The one answer in no-EVE-data mode; null with EVE data.
   */
  private readonly off: Maybe<PropModAnswer>;

  constructor(options: PropModLookupOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.url = options.url ?? '/prop-mod';
    const eveData = options.eveData ?? EVE_DATA_ON;
    this.off = eveData.on ? null : Object.freeze({ propMod: null, note: eveData.note });
  }

  /**
   * The cached answer for a module.
   *
   * @param module - A type id or a module name.
   * @returns The answer, or null before its lookup has settled.
   */
  Cached(module: string | number): Maybe<PropModAnswer> {
    return this.off ?? this.answers.get(PropModKey(module)) ?? null;
  }

  /**
   * Looks a module up, once per key; a failure is cached as a note and logged once.
   *
   * @param module - A type id or a module name.
   * @returns The answer; it never rejects.
   */
  Lookup(module: string | number): Promise<PropModAnswer> {
    if (this.off) return Promise.resolve(this.off);
    const key = PropModKey(module);
    const cached = this.answers.get(key);
    if (cached) return Promise.resolve(cached);
    let request = this.requests.get(key);
    if (!request) {
      request = this.Request(module).then((answer) => {
        this.answers.set(key, answer);
        this.requests.delete(key);
        if (!answer.propMod) console.warn(`prop mod ${key}: ${answer.note ?? 'no answer'}`);
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
    for (const [key, answer] of this.answers) if (!answer.propMod) this.answers.delete(key);
  }

  private async Request(module: string | number): Promise<PropModAnswer> {
    let answer: PropModAnswer;
    try {
      const response = await this.fetch(`${this.url}?module=${encodeURIComponent(String(module))}`, { signal: AbortSignal.timeout(PROP_MOD_LOOKUP_TIMEOUT_MS) });
      const body: unknown = await Promise.resolve(response.json()).catch(() => null);
      answer = response.status === 200 ? ReadPropModNumbers(body) : { propMod: null, note: ReadErrorMessage(body) ?? `the hub's /prop-mod answered ${response.status}` };
    } catch (error) {
      answer = { propMod: null, note: `the hub's /prop-mod did not answer (${error instanceof Error ? error.message : String(error)})` };
    }
    return answer;
  }
}

function ReadPropModNumbers(body: unknown): PropModAnswer {
  const propMod = Field(body, 'propMod');
  const valid = typeof Field(propMod, 'typeID') === 'number' && typeof Field(propMod, 'name') === 'string' && (Field(propMod, 'kind') === 'microwarpdrive' || Field(propMod, 'kind') === 'afterburner');
  return valid ? { propMod: propMod as PropModNumbers, note: null } : { propMod: null, note: "the hub's /prop-mod answer named no module" };
}

function ReadErrorMessage(body: unknown): Maybe<string> {
  const message = Field(Field(body, 'error'), 'message');
  return typeof message === 'string' ? message : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
