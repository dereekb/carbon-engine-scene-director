/**
 * A ship's fit in the page: the hub's fit lookups, and the typed fit and dogma input they resolve to.
 *
 * - Names resolve one `GET /fit/type?name=&hull=` at a time (the hub is GET-only and a whole fit does not fit in a
 *   URL). Dogma comes from `GET /dogma/types?ids=` (ids batched per microtask, at most MAX_FIT_DOGMA_TYPE_IDS per
 *   request) and `GET /dogma/skills` (once). Everything lands in one merged bundle per page session; failures are cached
 *   with the hub's message until ForgetFailures (every load_scene / open_scene), as HullStatsLookup's are.
 * - ResolveShipFitting is synchronous over those caches: the typed fit (provisional keys while names are pending), and
 *   the dogma input once the hull, the modules, their charges and the skills are all in, else why not.
 * - The prop mod a ship flies is its fit's first MWD / AB (shipPropModModuleOf). An explicit `propMod.module` naming
 *   another replaces that module; one on a fit without a prop mod is added as an extra mid module; "none" leaves the
 *   fit's prop mod offline.
 * - Evaluations are memoized per bundle (ShipStats): a 44-ship TFIs fleet flies 13 fits.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { ShipModuleSpec } from './modules';
import type { TurretMountReport } from './turret-plan';
import {
  computeShipStats,
  DAMAGE_TYPES,
  DEFENSE_LAYERS,
  type DamageType,
  type DefenseLayerName,
  type DogmaBundle,
  type DogmaModuleState,
  type DogmaShip,
  eftTypeNames,
  evaluateShipDogma,
  type EvaluateShipDogmaInput,
  type EftFit,
  type ChargedModule,
  type FittedModule,
  type FitTypeAnswer,
  fitTextOf,
  fittingTypeIDs,
  isInlineFit,
  loadCargoCharges,
  DEFAULT_MISSILE_LOADED,
  defaultMissileOf,
  missileDamageTypeOf,
  mergeDogmaBundles,
  missileCombatNumbersOf,
  moduleActivationOf,
  normalizePropModName,
  parseEftFit,
  PROP_MOD_MODULE_AB,
  PROP_MOD_MODULE_MWD,
  type PropModModule,
  readDogmaBundle,
  readFitTypeAnswer,
  type SceneDocument,
  type SceneShip,
  type ShipCapacitor,
  type ShipDefense,
  type ShipDogmaInput,
  type ShipFitting,
  type ShipStats,
  type ShipStatsInput,
  type HullStatOverrides,
  toDogmaModules,
  turretCombatNumbersOf,
  typeEftFit
} from '@scene-director/scene';

/**
 * The most type ids one `/dogma/types` request carries (the hub's MAX_DOGMA_TYPE_IDS).
 */
export const MAX_FIT_DOGMA_TYPE_IDS = 200;

/**
 * How long a fit lookup may take: the hub's first `/dogma/skills` reads every published skill (~5 s).
 */
export const FIT_LOOKUP_TIMEOUT_MS = 90_000;

/**
 * Waits before retrying a lookup the hub could not answer (no answer, 502, 503, 504): a burst of a fleet's lookups can
 * meet a dropped tools-core connection, and a failure is cached for the page session.
 */
export const FIT_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Statuses worth a retry; 0 is no answer at all.
 */
const RETRIED_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

/**
 * The prop mod group (MWDs and ABs).
 */
const PROP_MOD_GROUP = 46;

/**
 * What a `/fit/type` lookup found: the type, or why there is none.
 */
export interface FitNameAnswer {
  readonly type: Maybe<FitTypeAnswer>;
  readonly note: Maybe<string>;
  /**
   * The hub could not look names up at all (no SDE, no tools-core, no answer): the fit then has no dogma. A name the
   * EVE data does not know is not unavailable, just unknown.
   */
  readonly unavailable: boolean;
}

/**
 * The part of fetch a lookup uses.
 */
export type FitFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'json'>>;

export interface FitLookupOptions {
  /**
   * Defaults to the global fetch.
   */
  readonly fetch?: FitFetch;
  /**
   * The hub routes; default `/fit/type`, `/dogma/types` and `/dogma/skills`.
   */
  readonly typeUrl?: string;
  readonly typesUrl?: string;
  readonly skillsUrl?: string;
  /**
   * Defaults to FIT_LOOKUP_RETRY_DELAYS_MS.
   */
  readonly retryDelaysMs?: readonly number[];
}

export interface PrepareFitInput {
  /**
   * The fit's EFT text.
   */
  readonly text: string;
  /**
   * Other types its dogma needs: the hull, a replacing prop mod.
   */
  readonly typeIDs?: readonly Maybe<number>[];
}

interface GetResult {
  readonly body: unknown;
  readonly note: Maybe<string>;
  readonly status: number;
}

interface TypeBatch {
  readonly ids: number[];
  readonly done: Promise<void>;
}

/**
 * The page's fit lookups: names, dogma types and skills, once each per page session, answered synchronously once
 * cached. Every lookup settles; none rejects.
 */
export class FitLookup {
  private readonly fetch: FitFetch;
  private readonly typeUrl: string;
  private readonly typesUrl: string;
  private readonly skillsUrl: string;
  private readonly retryDelaysMs: readonly number[];
  private readonly parsed = new Map<string, EftFit>();
  private readonly names = new Map<string, FitNameAnswer>();
  private readonly nameRequests = new Map<string, Promise<FitNameAnswer>>();
  /**
   * Types the EVE data does not have, and types whose request failed, with why.
   */
  private readonly typeFailures = new Map<number, string>();
  private readonly typeRequests = new Map<number, Promise<void>>();
  private batch: Maybe<TypeBatch> = null;
  private skillsLoaded = false;
  private skillsNote: Maybe<string> = null;
  private skillsRequest: Maybe<Promise<void>> = null;
  private bundle: Maybe<DogmaBundle> = null;
  private readonly stats = new WeakMap<DogmaBundle, Map<string, ShipStats>>();
  private readonly ships = new WeakMap<DogmaBundle, Map<string, DogmaShip>>();

  constructor(options: FitLookupOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.typeUrl = options.typeUrl ?? '/fit/type';
    this.typesUrl = options.typesUrl ?? '/dogma/types';
    this.skillsUrl = options.skillsUrl ?? '/dogma/skills';
    this.retryDelaysMs = options.retryDelaysMs ?? FIT_LOOKUP_RETRY_DELAYS_MS;
  }

  /**
   * A fit's text parsed, once per text.
   *
   * @param text - The EFT text.
   * @returns The parsed fit.
   */
  Parse(text: string): EftFit {
    let fit = this.parsed.get(text);
    if (!fit) {
      fit = parseEftFit(text);
      this.parsed.set(text, fit);
    }
    return fit;
  }

  /**
   * The cached answer for a name.
   *
   * @param name - The name as written.
   * @returns The answer, or null before its lookup has settled.
   */
  Name(name: string): Maybe<FitNameAnswer> {
    return this.names.get(name) ?? null;
  }

  /**
   * The session's merged bundle: every type, effect and attribute looked up so far, the skills included.
   *
   * @returns The bundle, or null before anything has landed.
   */
  Bundle(): Maybe<DogmaBundle> {
    return this.bundle;
  }

  /**
   * Whether every published skill has landed.
   */
  get skillsReady(): boolean {
    return this.skillsLoaded;
  }

  /**
   * Why the skills did not land.
   */
  get skillsFailure(): Maybe<string> {
    return this.skillsNote;
  }

  /**
   * Why a type has no dogma: the EVE data lacks it, or its request failed.
   *
   * @param id - The type id.
   * @returns The reason, or null when it is in the bundle or still to be looked up.
   */
  TypeFailure(id: number): Maybe<string> {
    return this.typeFailures.get(id) ?? null;
  }

  /**
   * Whether a type's dogma is still to come (not in the bundle, not failed).
   *
   * @param id - The type id.
   * @returns True while it is pending or not asked for yet.
   */
  TypePending(id: number): boolean {
    return this.bundle?.types[id] == null && !this.typeFailures.has(id);
  }

  /**
   * Looks every part of a fit up: its names, then the types its dogma needs, and the skills.
   *
   * @param input - The fit's text and the other types it needs.
   * @returns Settles when every lookup has; never rejects.
   */
  async Prepare(input: PrepareFitInput): Promise<void> {
    const fit = this.Parse(input.text);
    const skills = this.LookupSkills();
    await Promise.all(eftTypeNames(fit).map((name) => this.LookupName(name, fit.hull)));
    const typed = typeEftFit(fit, { answer: (name) => this.Name(name)?.type ?? null });
    const ids = [...(input.typeIDs ?? []), ...fittingTypeIDs(typed)].filter((id): id is number => id != null);
    await Promise.all([this.LookupTypes(ids), skills]);
  }

  /**
   * Looks a name up, once per name.
   *
   * @param name - The exact English name.
   * @param hull - The fit's header hull (tools-core resolves the name in a fit for it).
   * @returns The answer; it never rejects.
   */
  LookupName(name: string, hull: string): Promise<FitNameAnswer> {
    const cached = this.names.get(name);
    if (cached) return Promise.resolve(cached);
    let request = this.nameRequests.get(name);
    if (!request) {
      request = this.RequestName(name, hull).then((answer) => {
        this.names.set(name, answer);
        this.nameRequests.delete(name);
        if (answer.unavailable) console.warn(`fit name "${name}": ${answer.note ?? 'no answer'}`);
        return answer;
      });
      this.nameRequests.set(name, request);
    }
    return request;
  }

  /**
   * Looks types up that the bundle does not have yet, batching every id asked for in one turn of the event loop.
   *
   * @param ids - The type ids.
   * @returns Settles when every id has; never rejects.
   */
  LookupTypes(ids: Iterable<number>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of new Set(ids)) {
      if (!this.TypePending(id)) continue;
      let request = this.typeRequests.get(id);
      if (!request) {
        request = this.QueueType(id);
        this.typeRequests.set(id, request);
      }
      waits.push(request);
    }
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * Looks every published skill up, once.
   *
   * @returns Settles when they have landed or failed; never rejects.
   */
  LookupSkills(): Promise<void> {
    if (this.skillsLoaded || this.skillsNote) return Promise.resolve();
    this.skillsRequest ??= this.Get(this.skillsUrl, '/dogma/skills').then(({ body, note }) => {
      const read = body ? readDogmaBundle(body) : null;
      if (read?.bundle) {
        this.Merge(read.bundle);
        this.skillsLoaded = true;
      } else {
        this.skillsNote = note ?? `the hub's /dogma/skills answer is no dogma bundle (${read?.problems.join('; ') ?? 'empty'})`;
        console.warn(`fit skills: ${this.skillsNote}`);
      }
      this.skillsRequest = null;
    });
    return this.skillsRequest;
  }

  /**
   * A ship's stats, memoized per bundle for dogma inputs (computeShipStats otherwise). A ship with incoming modifiers
   * (webs, points on it) is not memoized: their falloff scaling changes per cycle, and the director re-flies a target
   * only when the set changes, so such entries would pile up.
   *
   * @param input - The computeShipStats input.
   * @returns The stats.
   * @throws {RangeError} From computeShipStats.
   */
  ShipStats(input: ShipStatsInput): ShipStats {
    const { dogma } = input;
    if (!dogma || input.incoming?.length) return computeShipStats(input);
    let memo = this.stats.get(dogma.bundle);
    if (!memo) {
      memo = new Map();
      this.stats.set(dogma.bundle, memo);
    }
    const key = JSON.stringify([dogma.hullTypeID, dogma.modules ?? [], dogma.propModKey ?? null, input.overrides ?? null, input.pilot?.name ?? null]);
    let stats = memo.get(key);
    if (!stats) {
      stats = computeShipStats(input);
      memo.set(key, stats);
    }
    return stats;
  }

  /**
   * A ship evaluated, memoized per bundle and input (its modules' activation numbers come from it).
   *
   * @param input - The evaluator input.
   * @returns The evaluated ship.
   * @throws {RangeError} From evaluateShipDogma.
   */
  Evaluate(input: EvaluateShipDogmaInput): DogmaShip {
    let memo = this.ships.get(input.bundle);
    if (!memo) {
      memo = new Map();
      this.ships.set(input.bundle, memo);
    }
    const key = JSON.stringify([input.hullTypeID, input.modules ?? [], input.overrides ?? null, input.pilot?.name ?? null]);
    let ship = memo.get(key);
    if (!ship) {
      ship = evaluateShipDogma(input);
      memo.set(key, ship);
    }
    return ship;
  }

  /**
   * Forgets every failed lookup, so the next Prepare asks again (after the SDE is prepared, say).
   */
  ForgetFailures(): void {
    for (const [name, answer] of this.names) if (!answer.type) this.names.delete(name);
    this.typeFailures.clear();
    this.skillsNote = null;
  }

  private QueueType(id: number): Promise<void> {
    if (!this.batch) {
      const ids: number[] = [];
      const done = Promise.resolve().then(() => {
        this.batch = null;
        return this.RequestTypes(ids);
      });
      this.batch = { ids, done };
    }
    this.batch.ids.push(id);
    return this.batch.done;
  }

  private async RequestTypes(ids: readonly number[]): Promise<void> {
    const chunks: number[][] = [];
    for (let index = 0; index < ids.length; index += MAX_FIT_DOGMA_TYPE_IDS) chunks.push(ids.slice(index, index + MAX_FIT_DOGMA_TYPE_IDS));
    await Promise.all(
      chunks.map(async (chunk) => {
        const { body, note } = await this.Get(`${this.typesUrl}?ids=${chunk.join(',')}`, '/dogma/types');
        const read = body ? readDogmaBundle(body) : null;
        if (read?.bundle) {
          this.Merge(read.bundle);
          for (const id of chunk) if (!read.bundle.types[id]) this.typeFailures.set(id, `the EVE data has no type ${id}`);
        } else {
          const why = note ?? `the hub's /dogma/types answer is no dogma bundle (${read?.problems.join('; ') ?? 'empty'})`;
          for (const id of chunk) this.typeFailures.set(id, why);
          console.warn(`fit types ${chunk.join(',')}: ${why}`);
        }
        for (const id of chunk) this.typeRequests.delete(id);
      })
    );
  }

  private Merge(bundle: DogmaBundle): void {
    this.bundle = this.bundle ? mergeDogmaBundles(this.bundle, bundle) : bundle;
  }

  private async RequestName(name: string, hull: string): Promise<FitNameAnswer> {
    const { body, note, status } = await this.Get(`${this.typeUrl}?name=${encodeURIComponent(name)}&hull=${encodeURIComponent(hull)}`, '/fit/type');
    const type = body ? readFitTypeAnswer(body) : null;
    let answer: FitNameAnswer;
    if (type) answer = { type, note: null, unavailable: false };
    else if (status === 400 || status === 404) answer = { type: null, note: note ?? `the EVE data has no type named "${name}"`, unavailable: false };
    else answer = { type: null, note: note ?? "the hub's /fit/type answer named no type", unavailable: true };
    return answer;
  }

  /**
   * GETs a hub route, retrying after FIT_LOOKUP_RETRY_DELAYS_MS while the hub cannot answer.
   *
   * @param url - The URL.
   * @param route - The route, for messages.
   * @returns The 200 body, or the last error's note and status (0 when the hub did not answer).
   */
  private async Get(url: string, route: string): Promise<GetResult> {
    let result = await this.GetOnce(url, route);
    for (const delay of this.retryDelaysMs) {
      if (!RETRIED_STATUSES.has(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      result = await this.GetOnce(url, route);
    }
    return result;
  }

  private async GetOnce(url: string, route: string): Promise<GetResult> {
    let result: GetResult;
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(FIT_LOOKUP_TIMEOUT_MS) });
      const body: unknown = await Promise.resolve(response.json()).catch(() => null);
      result = response.status === 200 ? { body, note: null, status: 200 } : { body: null, note: ReadErrorMessage(body) ?? `the hub's ${route} answered ${response.status}`, status: response.status };
    } catch (error) {
      result = { body: null, note: `the hub's ${route} did not answer (${error instanceof Error ? error.message : String(error)})`, status: 0 };
    }
    return result;
  }
}

/**
 * The prop mod a fitted ship flies, as the page resolved it (prop-mods.ts).
 */
export interface ShipFitPropMod {
  /**
   * The module as the ship flies it (shipPropModModuleOf).
   */
  readonly module: PropModModule;
  readonly typeID: number;
  readonly name: string;
  /**
   * The document names it (`propMod.module`), so it replaces the fit's own when it names another.
   */
  readonly explicit: boolean;
}

/**
 * A module as the ship carries it: the typed fit's, with why it differs from the fit, and the charge a turret loaded
 * from cargo (loadCargoCharges).
 */
export interface ShipFitModule extends ChargedModule {
  readonly note?: string;
}

/**
 * The fit a ship without one flies (the director's default weapons fit), keyed like a document fit.
 */
export interface ShipFitFallback {
  readonly text: string;
  readonly key: string;
}

export interface ResolveShipFittingInput {
  readonly doc: SceneShip;
  /**
   * The document, for its fits.
   */
  readonly scene: Maybe<Pick<SceneDocument, 'fits'>>;
  readonly lookup: FitLookup;
  /**
   * The ship's EVE type (the hub's /ship-stats answer); null while that is in flight or when it named none.
   */
  readonly hullTypeID: Maybe<number>;
  /**
   * Why there is no hull type.
   */
  readonly hullNote?: Maybe<string>;
  /**
   * The prop mod the ship flies; null for "none".
   */
  readonly propMod?: Maybe<ShipFitPropMod>;
  /**
   * The fit of a ship without one (its default weapons); never used when the ship has a fit.
   */
  readonly fallback?: Maybe<ShipFitFallback>;
  /**
   * The DNA's SOF race: a launcher's default missile follows the hull's SDE race, else this.
   */
  readonly sofRace?: Maybe<string>;
}

export interface ResolvedShipFitting {
  /**
   * The fit's text, as applied.
   */
  readonly text: string;
  /**
   * The ship's `fit`: a key of the document's fits, or "inline"; the fallback's key for a ship without one.
   */
  readonly key: string;
  /**
   * Set when the fit is the fallback (the ship has no fit of its own).
   */
  readonly default?: true;
  /**
   * The typed fit; while names are pending its keys are the text's, and pending names are not `unknown` yet.
   */
  readonly fitting: ShipFitting;
  /**
   * The modules as the ship carries them: the prop mod replaced, added or left offline (ShipFitPropMod), turrets
   * without a charge loaded from cargo.
   */
  readonly modules: ShipFitModule[];
  /**
   * The dogma path's input; null while lookups are pending, or without the EVE data (note says why).
   */
  readonly dogma: Maybe<ShipDogmaInput>;
  /**
   * Lookups are still to land: FitLookup.Prepare with typeIDs, then resolve again.
   */
  readonly pending: boolean;
  readonly note: Maybe<string>;
  /**
   * The types the fit's dogma needs besides its modules and charges: the hull, a replacing prop mod and the default
   * missiles of launchers with none.
   */
  readonly typeIDs: number[];
}

/**
 * A ship's fit, typed and ready for the dogma path as far as the lookups allow.
 *
 * @param input - The ship, the document, the lookups, the hull's type and the prop mod.
 * @returns The resolution; null for a ship without a fit.
 */
export function ResolveShipFitting(input: ResolveShipFittingInput): Maybe<ResolvedShipFitting> {
  const { doc, scene, lookup, hullTypeID, hullNote, propMod, fallback, sofRace = null } = input;
  const own = doc.fit ? fitTextOf(doc, scene) : null;
  const text = own ?? fallback?.text;
  if (!text) return null;
  const key = own && doc.fit ? (isInlineFit(doc.fit) ? 'inline' : doc.fit) : (fallback?.key ?? 'default');
  const fit = lookup.Parse(text);
  const names = eftTypeNames(fit);
  const answers = names.map((name) => lookup.Name(name));
  const pendingNames = names.filter((_name, index) => !answers[index]);
  const unavailable = answers.find((answer) => answer?.unavailable);
  const bundle = lookup.Bundle();
  const typed = typeEftFit(fit, { answer: (name) => lookup.Name(name)?.type ?? null, bundle });
  const fitting = pendingNames.length ? { ...typed, unknown: typed.unknown.filter((name) => !pendingNames.includes(name)) } : typed;
  // While names are pending the fit's own prop mod may not be typed yet: nothing is added or replaced until they land.
  const withPropMod = pendingNames.length ? { modules: fitting.modules, propModKey: null, extraTypeID: null } : WithPropMod(fitting, propMod ?? null);
  const { propModKey, extraTypeID } = withPropMod;
  // A weapon without a charge takes the first one in cargo that fits it, once the bundle holds both; a launcher with
  // none there takes the hull race's default missile, whose dogma joins typeIDs.
  const damageType = missileDamageTypeOf(hullTypeID == null ? null : (bundle?.types[hullTypeID]?.raceID ?? null), sofRace);
  const modules: ShipFitModule[] = pendingNames.length ? withPropMod.modules : loadCargoCharges(withPropMod.modules, fitting.charges, bundle, { defaultMissile: (launcher) => defaultMissileOf(launcher, damageType) });
  const defaultMissiles = modules.flatMap((module) => (module.chargeNote === DEFAULT_MISSILE_LOADED && module.charge?.typeID != null ? [module.charge.typeID] : []));
  const typeIDs = [...new Set([hullTypeID, extraTypeID, ...defaultMissiles].filter((id): id is number => id != null))];
  const needed = [...typeIDs, ...fittingTypeIDs({ ...fitting, modules })];
  let note: Maybe<string> = null;
  let pending = false;
  const typeFailure = needed.map((id) => lookup.TypeFailure(id)).find(Boolean);
  if (unavailable) {
    note = `the fit's modules need the EVE data: ${unavailable.note ?? 'the hub did not answer'}`;
  } else if (pendingNames.length) {
    pending = true;
    note = `resolving ${pendingNames.length} of the fit's ${names.length} names`;
  } else if (hullTypeID == null) {
    note = hullNote ? `the fit's modules need the hull's EVE type: ${hullNote}` : "waiting for the hull's EVE type";
  } else if (lookup.TypeFailure(hullTypeID)) {
    note = `the fit's modules need the hull's dogma: ${lookup.TypeFailure(hullTypeID)}`;
  } else if (lookup.skillsFailure) {
    note = `the fit's modules need the skills' dogma: ${lookup.skillsFailure}`;
  } else if (!lookup.skillsReady || needed.some((id) => lookup.TypePending(id))) {
    pending = true;
    note = "loading the fit's dogma";
  }
  let dogma: Maybe<ShipDogmaInput> = null;
  if (!note && bundle && hullTypeID != null) {
    dogma = { bundle, hullTypeID, modules: toDogmaModules({ ...fitting, modules }), propModKey };
    if (typeFailure) note = `left out of dogma: ${typeFailure}`;
  }
  return { text, key, ...(own ? {} : { default: true as const }), fitting, modules, dogma, pending, note, typeIDs };
}

interface WithPropModResult {
  readonly modules: ShipFitModule[];
  readonly propModKey: Maybe<string>;
  /**
   * A prop mod type the fit does not carry (a replacement or an addition).
   */
  readonly extraTypeID: Maybe<number>;
}

/**
 * The fit's modules with the ship's prop mod: the fit's own, replaced by an explicit one that names another, added as
 * an extra mid module when the fit has none, or left offline for "none".
 *
 * @param fitting - The typed fit.
 * @param propMod - The prop mod the ship flies; null for "none".
 * @returns The modules, the prop module's key and any type the fit does not carry.
 */
function WithPropMod(fitting: ShipFitting, propMod: Maybe<ShipFitPropMod>): WithPropModResult {
  const fitProp = fitting.modules.find((module) => module.prop);
  let result: WithPropModResult = { modules: fitting.modules, propModKey: fitProp?.key ?? null, extraTypeID: null };
  if (!propMod) {
    if (fitProp) {
      const { prop: _prop, ...rest } = fitProp;
      const offline: ShipFitModule = { ...rest, offline: true, note: 'propMod.module "none": left offline' };
      result = { modules: fitting.modules.map((module) => (module === fitProp ? offline : module)), propModKey: null, extraTypeID: null };
    }
  } else if (fitProp) {
    if (propMod.explicit && !NamesModule(propMod, fitProp)) {
      const replaced: ShipFitModule = { ...fitProp, typeID: propMod.typeID, name: propMod.name, groupID: PROP_MOD_GROUP, note: `propMod.module ${JSON.stringify(propMod.module)} replaces the fit's ${fitProp.name}` };
      result = { modules: fitting.modules.map((module) => (module === fitProp ? replaced : module)), propModKey: fitProp.key, extraTypeID: propMod.typeID };
    }
  } else {
    const used = fitting.modules.filter((module) => module.slot === 'mid').map((module) => Number(module.key.slice('mid-'.length)));
    const key = `mid-${used.length ? Math.max(...used) + 1 : 0}`;
    const added: ShipFitModule = { key, name: propMod.name, typeID: propMod.typeID, groupID: PROP_MOD_GROUP, slot: 'mid', category: 'prop', prop: true, line: 0, note: 'the prop mod the ship flies; not in the fit' };
    result = { modules: [...fitting.modules, added], propModKey: key, extraTypeID: propMod.typeID };
  }
  return result;
}

/**
 * Whether an explicit prop mod names the fit's own module: the same type, or the same name.
 */
function NamesModule(propMod: ShipFitPropMod, module: FittedModule): boolean {
  const { module: named } = propMod;
  const keyword = named === PROP_MOD_MODULE_MWD || named === PROP_MOD_MODULE_AB;
  return propMod.typeID === module.typeID || (typeof named === 'string' && !keyword && normalizePropModName(named) === normalizePropModName(module.name));
}

/**
 * The modules a fitted ship's activation layer runs (modules.ts): every resolved module but the prop mod, with how it
 * activates, from the ship evaluated with its fit's states.
 *
 * @param resolved - The ship's resolved fit, with its dogma input.
 * @param lookup - The lookups, for the memoized evaluation.
 * @param overrides - The document ship's `stats`.
 * @returns The specs; none until the fit has dogma.
 */
export function ShipModuleSpecsOf(resolved: ResolvedShipFitting, lookup: FitLookup, overrides: Maybe<HullStatOverrides> = null): ShipModuleSpec[] {
  const { dogma } = resolved;
  if (!dogma) return [];
  const ship = lookup.Evaluate({ bundle: dogma.bundle, hullTypeID: dogma.hullTypeID, modules: dogma.modules, overrides });
  return resolved.modules.flatMap((module): ShipModuleSpec[] => {
    const activation = module.prop || module.typeID == null ? null : moduleActivationOf(ship, dogma.bundle, module.key);
    const combat = activation?.weapon === 'turret' ? turretCombatNumbersOf(ship, dogma.bundle, module.key) : null;
    const missile = activation?.weapon === 'launcher' ? missileCombatNumbersOf(ship, dogma.bundle, module.key) : null;
    return activation && module.typeID != null ? [{ key: module.key, name: module.name, typeID: module.typeID, offline: module.offline === true, activation, ...(combat ? { combat } : {}), ...(missile ? { missile } : {}) }] : [];
  });
}

/**
 * A fitted module's live state in get_state: the activation layer's (modules.ts), the prop mod's from Destiny.
 */
export type ShipModuleState = 'offline' | 'online' | 'activating' | 'active' | 'stopping' | 'reactivating';

export const SHIP_MODULE_STATES: readonly ShipModuleState[] = ['offline', 'online', 'activating', 'active', 'stopping', 'reactivating'];

/**
 * A module row in get_state: module, name and state always, the rest only when they apply.
 */
export interface ShipModuleRow extends ShipModuleRowState {
  readonly module: string;
  readonly name: string;
  readonly charge?: string;
  readonly prop?: true;
}

/**
 * A module row's live part: its state, and its cycle, timing, target and note when they apply.
 */
export interface ShipModuleRowState {
  readonly state: ShipModuleState;
  readonly cycle?: { readonly number: number; readonly endsIn: number };
  readonly at?: number;
  readonly stopsIn?: number;
  readonly activatesIn?: number;
  readonly readyIn?: number;
  readonly respondsIn?: number;
  readonly target?: string;
  /**
   * A running turret's next target (it retargets at its next cycle).
   */
  readonly nextTarget?: string;
  readonly targetDistance?: number;
  readonly effectiveness?: number;
  /**
   * While it runs: seconds per cycle, a gun's rate of fire.
   */
  readonly cycleTime?: number;
  /**
   * A weapon's turret set on the drawn hull (with a renderer).
   */
  readonly mount?: TurretMountReport;
  /**
   * A turret's damage per shot by type, volley and paper DPS (turretCombatNumbersOf, rounded); a launcher's per missile,
   * with the missile's velocity (m/s), flight time (s) and range (m: EVE's whole-tick lower and upper, the upper's
   * chance, the mean) (missileCombatNumbersOf).
   */
  readonly combat?: ShipModuleCombatRow;
  /**
   * A launcher's missiles still flying.
   */
  readonly inFlight?: number;
  readonly note?: string;
}

/**
 * A weapon row's combat numbers in get_state.
 */
export interface ShipModuleCombatRow {
  readonly damage: Readonly<Record<string, number>>;
  readonly volley: number;
  readonly dps: number;
  readonly velocity?: number;
  readonly flightTime?: number;
  readonly range?: { readonly lower: number; readonly upper: number; readonly upperChance: number; readonly mean: number };
}

/**
 * A ship's fit in get_state.
 */
export interface ShipFitReport {
  readonly name: string;
  /**
   * The key of the document's fits, or "inline"; "default" for the default weapons of a ship without a fit.
   */
  readonly key: string;
  /**
   * Set for a ship's default weapons fit (never in the document).
   */
  readonly default?: true;
  readonly hull: string;
  /**
   * The hull's EVE type the fit's dogma runs on.
   */
  readonly typeID?: number;
  readonly unknown: string[];
  readonly modules: ShipModuleRow[];
  readonly drones: { readonly name: string; readonly quantity: number }[];
  /**
   * `dogma` when the fit sets the ship's numbers, else `table` (note says why).
   */
  readonly math: 'dogma' | 'table';
  readonly note?: string;
}

/**
 * A ship's fit for get_state.
 *
 * @param resolved - The ship's resolved fit.
 * @param stateOf - A module's live state (and its cycle, target and note).
 * @returns The report.
 */
export function ShipFitReportOf(resolved: ResolvedShipFitting, stateOf: (module: ShipFitModule) => ShipModuleRowState): ShipFitReport {
  const { fitting, modules, dogma, note } = resolved;
  return {
    name: fitting.name,
    key: resolved.key,
    ...(resolved.default ? { default: true as const } : {}),
    hull: fitting.hull,
    ...(dogma ? { typeID: dogma.hullTypeID } : {}),
    unknown: fitting.unknown,
    modules: modules.map((module) => {
      const { note, ...live } = stateOf(module);
      const notes = [module.note, module.chargeNote, note].filter(Boolean).join('; ');
      return { module: module.key, name: module.name, ...live, ...(module.charge ? { charge: module.charge.name } : {}), ...(module.prop ? { prop: true as const } : {}), ...(notes ? { note: notes } : {}) };
    }),
    drones: fitting.drones.map((drone) => ({ name: drone.name, quantity: drone.quantity })),
    math: dogma ? 'dogma' : 'table',
    ...(note ? { note } : {})
  };
}

/**
 * A module's dogma state for its live state: offline stays offline, running states are active.
 *
 * @param state - The live state.
 * @returns The dogma state.
 */
export function DogmaStateOf(state: ShipModuleState): DogmaModuleState {
  let dogma: DogmaModuleState = 'online';
  if (state === 'offline') dogma = 'offline';
  else if (state === 'active' || state === 'stopping') dogma = 'active';
  return dogma;
}

/**
 * A defense layer in get_state: current and max HP, resists (percent) and omni EHP.
 */
export interface DefenseLayerReport {
  readonly hp: number;
  readonly max: number;
  readonly resists: Readonly<Record<DamageType, number>>;
  readonly ehp: number;
}

export type ShipDefenseReport = Readonly<Record<DefenseLayerName, DefenseLayerReport>> & { readonly ehp: number; readonly shieldRecharge: number };

/**
 * A ship's defense for get_state: the evaluated max HP (the damage model's current HP comes later, so hp is max).
 *
 * @param defense - The evaluated defense.
 * @returns The report, rounded.
 */
export function ShipDefenseReportOf(defense: ShipDefense): ShipDefenseReport {
  const layer = (name: DefenseLayerName): DefenseLayerReport => {
    const { hp, resists, ehp } = defense[name];
    return { hp: Round(hp, 1), max: Round(hp, 1), resists: Object.fromEntries(DAMAGE_TYPES.map((type) => [type, resists[type]])) as Record<DamageType, number>, ehp: Math.round(ehp) };
  };
  const [shield, armor, structure] = DEFENSE_LAYERS.map(layer);
  return { shield, armor, structure, ehp: Math.round(defense.ehp), shieldRecharge: Round(defense.shieldRecharge, 2) };
}

/**
 * A ship's capacitor in get_state, rounded: the evaluated numbers, the live level (capacitor.ts) when the page keeps
 * one, and its capacitor warfare resistances when they are not 1.
 */
export type ShipCapacitorReport = Omit<ShipCapacitor, 'energyWarfareResistance' | 'remoteCapacitorImpedance'> & {
  /**
   * GJ now, 1 decimal.
   */
  readonly level?: number;
  /**
   * level / capacity, 3 decimals.
   */
  readonly fraction?: number;
  readonly energyWarfareResistance?: number;
  readonly remoteCapacitorImpedance?: number;
};

/**
 * A ship's capacitor for get_state, rounded.
 *
 * @param capacitor - The evaluated capacitor.
 * @param live - Its live level, when the page keeps one.
 * @returns The report.
 */
export function ShipCapacitorReportOf(capacitor: ShipCapacitor, live: Maybe<{ readonly level: number; readonly fraction: number }> = null): ShipCapacitorReport {
  return {
    ...(live ? { level: Round(live.level, 1), fraction: Round(live.fraction, 3) } : {}),
    capacity: Round(capacitor.capacity, 2),
    rechargeTime: Round(capacitor.rechargeTime, 2),
    peakRecharge: Round(capacitor.peakRecharge, 3),
    drain: Round(capacitor.drain, 3),
    stable: capacitor.stable,
    ...(capacitor.stableAt == null ? {} : { stableAt: Round(capacitor.stableAt, 3) }),
    ...(capacitor.lastsFor == null ? {} : { lastsFor: Round(capacitor.lastsFor, 1) }),
    ...(capacitor.energyWarfareResistance === 1 ? {} : { energyWarfareResistance: Round(capacitor.energyWarfareResistance, 3) }),
    ...(capacitor.remoteCapacitorImpedance === 1 ? {} : { remoteCapacitorImpedance: Round(capacitor.remoteCapacitorImpedance, 3) })
  };
}

/**
 * A fleet's fitted modules in get_state, by state.
 */
export type FleetModuleCounts = Record<ShipModuleState, number>;

/**
 * Counts module rows by state.
 *
 * @param rows - Every member's module rows.
 * @returns The counts.
 */
export function FleetModuleCountsOf(rows: Iterable<Pick<ShipModuleRow, 'state'>>): FleetModuleCounts {
  const counts = Object.fromEntries(SHIP_MODULE_STATES.map((state) => [state, 0])) as FleetModuleCounts;
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ReadErrorMessage(body: unknown): Maybe<string> {
  const message = Field(Field(body, 'error'), 'message');
  return typeof message === 'string' ? message : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
