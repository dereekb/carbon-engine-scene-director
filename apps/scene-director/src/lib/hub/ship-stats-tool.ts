/**
 * The `ship_stats` hub tool and the `GET /ship-stats` route: a hull's published flight
 * values from tools-core's SDE, and the numbers it flies by with a pilot (every skill at
 * V unless told otherwise), optionally with a prop mod running. The math is the shared,
 * runtime-free `computeShipStats`, so the page computes the same numbers.
 *
 * With a `fit` (EFT text) the hub resolves its names and the dogma bundle (DogmaData) and
 * the numbers come from the dogma evaluator: HP, resists, capacitor and targeting too, the
 * fit's prop mod as `withPropMod`, and the `active` modules running as `withActive`. Turret rows carry their combat
 * numbers (damage per shot by type, volley, DPS, tracking), launcher rows their missiles' (damage per missile,
 * volley, DPS, velocity, flight time, range, explosion), and the stats their sum (`weapons`), from the same
 * turretCombatNumbersOf / missileCombatNumbersOf the page runs; empty guns load a fitting charge from cargo and empty
 * launchers a fitting missile, else the hull race's default missile, as on the page.
 */

import type { Maybe } from '@dereekb/util';
import {
  computeShipStats,
  createPilotContext,
  DEFENSE_ATTRIBUTES,
  type DogmaBundle,
  type DogmaModuleState,
  type DogmaShip,
  type DogmaTraceStep,
  type DamageVector,
  DEFAULT_MISSILE_LOADED,
  defaultMissileOf,
  dogmaShipStats,
  eftTypeNames,
  evaluateShipDogma,
  type FittedModule,
  type FitTypeAnswer,
  fittingTypeIDs,
  loadCargoCharges,
  MAX_FIT_LENGTH,
  mergeDogmaBundles,
  type MissileCombatNumbers,
  missileCombatNumbersOf,
  missileDamageTypeOf,
  type MissileRange,
  type ModuleNumbers,
  moduleNumbersOf,
  parseEftFit,
  readEftPropMod,
  selectFittedModules,
  type ShipFitting,
  toDogmaModules,
  typeEftFit,
  findBakedPropMod,
  findHullSizedPropMod,
  HULL_STAT_OVERRIDE_KEYS,
  type HullStatOverrides,
  MAX_SKILLS_PILOT,
  normalizeHullStatOverrides,
  type PilotContext,
  type PilotContextConfig,
  PROP_MOD_MODULE_NONE,
  type PropModKind,
  type PropModStats,
  readPropModKind,
  SceneError,
  type ShipStats,
  type ShipWeapons,
  shipWeaponsOf,
  type TurretCombatNumbers,
  turretCombatNumbersOf
} from '@scene-director/scene';
import { type DogmaDataApi, MapLimited } from './dogma-data';
import { type ResolvedHull, type ResolvedPropMod, ShipDataError, type ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

const DNA_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+(:\S+)*$/u;
const TYPE_ID_TEXT = /^\d+$/u;

export interface ShipStatsAnswer {
  readonly hull: {
    readonly typeID?: number;
    readonly name?: string;
    readonly group?: Maybe<string>;
    readonly dna?: Maybe<string>;
    /**
     * How the EVE type was picked: an explicit type, the DNA, or none (all four stats given).
     */
    readonly resolvedFrom: 'type' | 'dna' | 'stats';
    readonly candidates: readonly { readonly typeID: number }[];
    readonly sdeBuild?: string;
    readonly published?: ResolvedHull['published'];
    readonly overrides?: HullStatOverrides;
    /**
     * Why the published values are missing although a hull was named.
     */
    readonly note?: string;
  };
  readonly pilot: string;
  readonly propMod: Maybe<PropModStats>;
  /**
   * Why the prop mod's numbers are the built-in ones (the SDE was unavailable).
   */
  readonly propModNote?: string;
  /**
   * As flown by the pilot, with no prop mod running.
   */
  readonly stats: FittedShipStats;
  /**
   * As flown by the pilot with the prop mod running.
   */
  readonly withPropMod?: FittedShipStats;
  /**
   * The typed fit, when one was given and its names resolved.
   */
  readonly fit?: FitSummary;
  /**
   * Why a given fit was not evaluated (no SDE): the stats are the hull's, with the fit's prop mod.
   */
  readonly fitNote?: string;
  /**
   * The fit with the `active` modules running.
   */
  readonly withActive?: { readonly modules: readonly string[]; readonly stats: FittedShipStats };
  /**
   * `active` modules that were left off (fitted /OFFLINE).
   */
  readonly activeNote?: string;
  /**
   * With `trace`: every dogma step behind the flight, HP, resonance and capacitor attributes (of `withActive` when
   * given, else of `stats`), by attribute name.
   */
  readonly trace?: Readonly<Record<string, readonly DogmaTraceStep[]>>;
}

/**
 * Ship stats, with a fit's turrets and launchers summed (`weapons`: counts, volley, paper DPS and DPS by type) when it
 * fits any.
 */
export type FittedShipStats = ShipStats & { readonly weapons?: ShipWeapons };

export interface FitSummary {
  readonly name: string;
  readonly hull: string;
  /**
   * The fitted modules. `cycleTime` (s, 2 decimals: a gun's rate of fire), `range` and `falloff` (m) are the
   * evaluated module's (of `withActive` when given), each omitted when the module has none. Turrets add `damage` (per
   * shot by type, before quality), `volley`, `dps`, `tracking` and `signatureResolution`, and a vorton's `explosion`
   * or a disintegrator's `spool`.
   */
  readonly modules: readonly FitSummaryModule[];
  readonly drones: readonly { readonly name: string; readonly quantity: number }[];
  /**
   * Names tools-core does not know; their lines play no part.
   */
  readonly unknown: readonly string[];
  readonly warnings: readonly string[];
}

export interface FitSummaryModule {
  readonly key: string;
  readonly name: string;
  readonly typeID: Maybe<number>;
  readonly slot: string;
  readonly category: string;
  readonly offline?: true;
  readonly charge?: string;
  readonly prop?: true;
  readonly cycleTime?: number;
  readonly range?: number;
  readonly falloff?: number;
  readonly damage?: DamageVector;
  readonly volley?: number;
  readonly dps?: number;
  readonly tracking?: number;
  readonly signatureResolution?: number;
  readonly explosion?: TurretCombatNumbers['explosion'];
  readonly spool?: TurretCombatNumbers['spool'];
  /**
   * A launcher's missile: max velocity (m/s), flight time (s) and range (m: the whole-tick cases, the longer's chance,
   * the mean). `range` stays a turret's optimal.
   */
  readonly velocity?: number;
  readonly flightTime?: number;
  readonly missileRange?: MissileRange;
  readonly note?: string;
}

/**
 * The attributes `trace` reports, beside the flight four: shield, armor and hull HP, their resonances, capacitor.
 */
const TRACE_ATTRIBUTE_IDS: readonly number[] = [4, 37, 70, 552, ...Object.values(DEFENSE_ATTRIBUTES).flatMap((layer) => [layer.hp, ...Object.values(layer.resonances)]), 482, 55];

/**
 * A prop mod argument: a kind sized for the hull, a module type id or name, or explicit values.
 */
type PropModArgument = { readonly kind: PropModKind } | { readonly typeID: number } | { readonly name: string } | { readonly stats: PropModStats };

interface ShipStatsArguments {
  readonly dna: Maybe<string>;
  readonly type: Maybe<number | string>;
  readonly propMod: Maybe<PropModArgument>;
  readonly overrides: Maybe<HullStatOverrides>;
  readonly pilot: PilotContext;
  readonly fit: Maybe<string>;
  readonly active: Maybe<readonly string[]>;
  readonly trace: boolean;
}

/**
 * Answers `ship_stats`.
 *
 * @param shipData - The SDE lookups.
 * @param args - Dna, type, propMod, stats, pilot, fit, active and trace.
 * @param dogmaData - The fit lookups; without them a fit flies by its hull and prop mod.
 * @returns The hull, the pilot, the prop mod and the stats with and without it (and with the active modules).
 * @throws {SceneError} When the arguments are invalid.
 * @throws {ShipDataError} When the hull or the prop mod cannot be resolved.
 */
export async function AnswerShipStats(shipData: ShipDataApi, args: ToolArgs, dogmaData: Maybe<DogmaDataApi> = null): Promise<ShipStatsAnswer> {
  const { dna, type, propMod: givenPropMod, overrides, pilot, fit, active, trace } = ReadShipStatsArguments(args);
  const complete = HULL_STAT_OVERRIDE_KEYS.every((key) => overrides?.[key] != null);

  let hull: Maybe<ResolvedHull> = null;
  let note: Maybe<string> = null;
  if (dna || type != null) {
    try {
      hull = await shipData.Hull({ dna, type });
    } catch (error) {
      if (!(complete && error instanceof ShipDataError && error.failure === 'unavailable')) throw error;
      note = `${error.message} The four stats were used instead.`;
    }
  }

  let fitted: Maybe<ResolvedFit> = null;
  let fitNote: Maybe<string> = null;
  if (fit && hull && dogmaData) {
    try {
      fitted = await ResolveFit(dogmaData, { text: fit, hullTypeID: hull.typeID, sofRace: hull.dna?.split(':')[2] ?? null });
    } catch (error) {
      if (!(error instanceof ShipDataError && error.failure === 'unavailable')) throw error;
      fitNote = `${error.message} The hull's values and the fit's prop mod were used instead.`;
    }
  } else if (fit) {
    fitNote = "the fit's modules need the SDE; the hull's values and the fit's prop mod were used instead.";
  }
  const propModule = fitted?.fitting.modules.find((module) => module.prop) ?? null;
  const fitPropMod = fit && !fitted ? readEftPropMod(fit) : null;
  let propModArgument: Maybe<PropModArgument> = givenPropMod;
  if (propModule?.typeID != null) propModArgument = { typeID: propModule.typeID };
  else if (fitPropMod) propModArgument = { name: fitPropMod };

  let propMod: Maybe<PropModStats> = null;
  let propModNote: Maybe<string> = null;
  if (propModArgument && 'stats' in propModArgument) {
    propMod = propModArgument.stats;
  } else if (propModArgument) {
    const resolved = await ResolveModule(shipData, { argument: propModArgument, rigSize: hull?.published.rigSize });
    propMod = resolved.propMod;
    propModNote = resolved.note;
  }

  const compute = (running: Maybe<PropModStats>): ShipStats => {
    try {
      return computeShipStats({ hull: hull?.published ?? null, overrides, pilot, propMod: running });
    } catch (error) {
      throw new ToolError(ErrorMessage(error));
    }
  };

  if (fitted && hull) return AnswerFitted({ hull, overrides, pilot, propMod, propModNote, fitted, propModule, active, trace });

  return {
    hull: hull
      ? { typeID: hull.typeID, name: hull.name, group: hull.group, dna: hull.dna, resolvedFrom: hull.resolvedFrom, candidates: hull.candidates, sdeBuild: hull.sdeBuild, published: hull.published, ...(overrides ? { overrides } : {}) }
      : { resolvedFrom: 'stats', candidates: [], ...(overrides ? { overrides } : {}), ...(note ? { note } : {}) },
    pilot: pilot.name,
    propMod,
    ...(propModNote ? { propModNote } : {}),
    stats: compute(null),
    ...(propMod ? { withPropMod: compute(propMod) } : {}),
    ...(fitNote ? { fitNote } : {})
  };
}

interface ResolvedFit {
  readonly fitting: ShipFitting;
  readonly bundle: DogmaBundle;
}

/**
 * Resolves a fit's names (one tools-core call per unique name, cached by DogmaData) and its dogma bundle: the hull,
 * the fitted modules and charges, and every skill. Charges load as on the page (loadCargoCharges): launchers with
 * none take the hull race's default missile, whose dogma a second bundle fetches when the first lacks it.
 */
async function ResolveFit(dogmaData: DogmaDataApi, input: { readonly text: string; readonly hullTypeID: number; readonly sofRace?: Maybe<string> }): Promise<ResolvedFit> {
  const parsed = parseEftFit(input.text);
  const answers = new Map<string, FitTypeAnswer>();
  await MapLimited(eftTypeNames(parsed), async (name) => {
    try {
      answers.set(name, await dogmaData.TypeByName(name, parsed.hull));
    } catch (error) {
      if (!(error instanceof ShipDataError && (error.failure === 'not-found' || error.failure === 'invalid'))) throw error;
    }
  });
  const answer = (name: string): Maybe<FitTypeAnswer> => answers.get(name) ?? null;
  const ids = fittingTypeIDs(typeEftFit(parsed, { answer }));
  let bundle = mergeDogmaBundles(await dogmaData.Bundle([input.hullTypeID, ...ids]), await dogmaData.Skills());
  const fitting = typeEftFit(parsed, { answer, bundle });
  const damageType = missileDamageTypeOf(bundle.types[input.hullTypeID]?.raceID ?? null, input.sofRace ?? null);
  const modules = loadCargoCharges(fitting.modules, fitting.charges, bundle, { defaultMissile: (launcher) => defaultMissileOf(launcher, damageType) });
  const missing = [...new Set(modules.flatMap((module) => (module.chargeNote === DEFAULT_MISSILE_LOADED && module.charge?.typeID != null && !bundle.types[module.charge.typeID] ? [module.charge.typeID] : [])))];
  if (missing.length) bundle = mergeDogmaBundles(bundle, await dogmaData.Bundle(missing));
  return { fitting: { ...fitting, modules }, bundle };
}

interface AnswerFittedInput {
  readonly hull: ResolvedHull;
  readonly overrides: Maybe<HullStatOverrides>;
  readonly pilot: PilotContext;
  readonly propMod: Maybe<PropModStats>;
  readonly propModNote: Maybe<string>;
  readonly fitted: ResolvedFit;
  readonly propModule: Maybe<FittedModule>;
  readonly active: Maybe<readonly string[]>;
  readonly trace: boolean;
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function FitModuleRow(module: FittedModule & { readonly chargeNote?: string }, numbers: Maybe<ModuleNumbers>, combat: Maybe<TurretCombatNumbers>, missile: Maybe<MissileCombatNumbers>): FitSummaryModule {
  const { cycleTime, range, falloff } = numbers ?? {};
  const weapon = combat ?? missile;
  return {
    key: module.key,
    name: module.name,
    typeID: module.typeID,
    slot: module.slot,
    category: module.category,
    ...(module.offline ? { offline: true as const } : {}),
    ...(module.charge ? { charge: module.charge.name } : {}),
    ...(module.prop ? { prop: true as const } : {}),
    ...(cycleTime ? { cycleTime: Math.round(cycleTime * 100) / 100 } : {}),
    ...(range ? { range: Math.round(range) } : {}),
    ...(falloff ? { falloff: Math.round(falloff) } : {}),
    ...(weapon
      ? {
          damage: { em: Round(weapon.damage.em, 2), thermal: Round(weapon.damage.thermal, 2), kinetic: Round(weapon.damage.kinetic, 2), explosive: Round(weapon.damage.explosive, 2) },
          volley: Round(weapon.volley, 2),
          dps: Round(weapon.dps, 2)
        }
      : {}),
    ...(combat
      ? {
          ...(combat.tracking == null ? {} : { tracking: Round(combat.tracking, 4) }),
          ...(combat.signatureResolution == null ? {} : { signatureResolution: combat.signatureResolution }),
          ...(combat.explosion ? { explosion: combat.explosion } : {}),
          ...(combat.spool ? { spool: combat.spool } : {})
        }
      : {}),
    ...(missile && missile.velocity > 0
      ? {
          velocity: Round(missile.velocity, 2),
          flightTime: Round(missile.flightTime, 3),
          missileRange: { lower: Math.round(missile.range.lower), upper: Math.round(missile.range.upper), upperChance: Round(missile.range.upperChance, 3), mean: Math.round(missile.range.mean) },
          explosion: { radius: Round(missile.explosion.radius, 2), velocity: Round(missile.explosion.velocity, 2), drf: missile.explosion.drf }
        }
      : {}),
    ...(missile?.note ? { note: missile.note } : module.chargeNote && module.weapon === 'launcher' ? { note: module.chargeNote } : {})
  };
}

function WithWeapons(stats: ShipStats, ship: DogmaShip, bundle: DogmaBundle): FittedShipStats {
  const weapons = shipWeaponsOf(ship, bundle);
  return weapons.turrets || weapons.launchers ? { ...stats, weapons } : stats;
}

function AnswerFitted(input: AnswerFittedInput): ShipStatsAnswer {
  const { hull, overrides, pilot, propMod, propModNote, fitted, propModule, active, trace } = input;
  const { fitting, bundle } = fitted;
  const evaluate = (running: ReadonlySet<FittedModule>) => {
    try {
      const ship = evaluateShipDogma({ bundle, hullTypeID: hull.typeID, overrides, pilot, modules: toDogmaModules(fitting, (module, fallback): DogmaModuleState => (fallback === 'online' && running.has(module) ? 'active' : fallback)) });
      return { ship, stats: WithWeapons(dogmaShipStats({ ship, bundle, overrides, propModKey: propModule?.key }), ship, bundle) };
    } catch (error) {
      throw new ToolError(ErrorMessage(error));
    }
  };
  const bare = evaluate(new Set());
  let withActive: Maybe<{ readonly modules: FittedModule[]; readonly stats: FittedShipStats; readonly ship: ReturnType<typeof evaluate>['ship'] }> = null;
  let activeNote: Maybe<string> = null;
  if (active) {
    const selected = selectFittedModules(fitting, active);
    const unmatched = selected.unmatched.map((selector) => JSON.stringify(selector)).join(', ');
    if (unmatched) throw new ToolError(`active: no fitted module matches ${unmatched} (use a module key such as "mid-0", a category such as "hardener", "all" or a module name; fit.modules lists them)`);
    const offline = selected.modules.filter((module) => module.offline || module.typeID == null);
    const leftOff = offline.map((module) => [module.key, module.name, module.offline ? '(offline)' : '(unknown)'].join(' ')).join(', ');
    if (leftOff) activeNote = `left off: ${leftOff}`;
    const running = selected.modules.filter((module) => !offline.includes(module));
    const evaluated = evaluate(new Set(running));
    withActive = { modules: running, stats: evaluated.stats, ship: evaluated.ship };
  }
  const traced = withActive?.ship ?? bare.ship;
  return {
    hull: { typeID: hull.typeID, name: hull.name, group: hull.group, dna: hull.dna, resolvedFrom: hull.resolvedFrom, candidates: hull.candidates, sdeBuild: hull.sdeBuild, published: hull.published, ...(overrides ? { overrides } : {}) },
    pilot: pilot.name,
    propMod,
    ...(propModNote ? { propModNote } : {}),
    stats: bare.stats,
    ...(propModule && !propModule.offline ? { withPropMod: evaluate(new Set([propModule])).stats } : {}),
    fit: {
      name: fitting.name,
      hull: fitting.hull,
      modules: fitting.modules.map((module) => FitModuleRow(module, moduleNumbersOf(traced, bundle, module.key), turretCombatNumbersOf(traced, bundle, module.key), missileCombatNumbersOf(traced, bundle, module.key))),
      drones: fitting.drones.map((drone) => ({ name: drone.name, quantity: drone.quantity })),
      unknown: fitting.unknown,
      warnings: fitting.warnings
    },
    ...(withActive ? { withActive: { modules: withActive.modules.map((module) => module.key), stats: withActive.stats } } : {}),
    ...(activeNote ? { activeNote } : {}),
    ...(trace ? { trace: Object.fromEntries(TRACE_ATTRIBUTE_IDS.flatMap((id) => (traced.trace(id).length ? [[bundle.attributes[id]?.name ?? String(id), traced.trace(id)]] : []))) } : {})
  };
}

export interface PropModAnswer {
  readonly propMod: ResolvedPropMod;
  readonly sdeBuild: string;
}

/**
 * Answers `GET /prop-mod?module=`: a module's numbers by type id or EVE name, for the page. "mwd", "ab" and "none"
 * depend on the hull, so the page sizes them itself.
 *
 * @param shipData - The SDE lookups.
 * @param args - module: a type id or a module name.
 * @returns The module's numbers and the SDE build they came from.
 * @throws {ToolError} When module is missing or a keyword.
 * @throws {ShipDataError} When the module cannot be resolved.
 */
export async function AnswerPropMod(shipData: ShipDataApi, args: ToolArgs): Promise<PropModAnswer> {
  const value = args['module'];
  const problems: string[] = [];
  const argument = ReadPropModArgument(value, problems);
  if (value == null || problems.length) throw new ToolError(problems[0] ?? 'module is required: a propulsion module type id or EVE name');
  if (!argument || 'kind' in argument || 'stats' in argument) throw new ToolError(`module "${String(value)}" depends on the hull: size "mwd" / "ab" with HULL_SIZED_PROP_MODS and ask for its type id`);
  const propMod = 'typeID' in argument ? await shipData.PropMod(argument.typeID) : await shipData.PropModByName((argument as { readonly name: string }).name);
  return { propMod, sdeBuild: await shipData.SdeBuild() };
}

interface ResolveModuleInput {
  readonly argument: Exclude<PropModArgument, { readonly stats: PropModStats }>;
  readonly rigSize: Maybe<number>;
}

/**
 * A kind, type id or name as module numbers: from the SDE, or the built-in numbers when the SDE is unavailable and
 * the module is one of BAKED_PROP_MODS.
 */
async function ResolveModule(shipData: ShipDataApi, input: ResolveModuleInput): Promise<{ readonly propMod: PropModStats; readonly note: Maybe<string> }> {
  const { argument, rigSize } = input;
  const sized = 'kind' in argument ? findHullSizedPropMod({ rigSize, kind: argument.kind }) : null;
  if ('kind' in argument && !sized) throw new ToolError("the hull's size is unknown; pass a module type id or name, or explicit prop mod values");
  const typeID = 'typeID' in argument ? argument.typeID : sized?.typeID;
  let result: { readonly propMod: PropModStats; readonly note: Maybe<string> };
  try {
    result = { propMod: typeID == null ? await shipData.PropModByName((argument as { readonly name: string }).name) : await shipData.PropMod(typeID), note: null };
  } catch (error) {
    const baked = error instanceof ShipDataError && error.failure === 'unavailable' ? findBakedPropMod(typeID ?? (argument as { readonly name: string }).name) : null;
    if (!baked) throw error;
    result = { propMod: baked, note: `${ErrorMessage(error)} The built-in numbers of ${baked.name} (SDE build 3632936) were used.` };
  }
  return result;
}

function ReadShipStatsArguments(args: ToolArgs): ShipStatsArguments {
  const problems: string[] = [];

  const dnaValue = args['dna'];
  let dna: Maybe<string> = null;
  if (typeof dnaValue === 'string' && DNA_PATTERN.test(dnaValue.trim())) dna = dnaValue.trim();
  else if (dnaValue != null) problems.push('dna must be a SOF DNA string, hull:faction:race[:commands]');

  const typeValue = args['type'];
  let type: Maybe<number | string> = null;
  if (typeof typeValue === 'number' && Number.isSafeInteger(typeValue) && typeValue > 0) type = typeValue;
  else if (typeof typeValue === 'string' && TYPE_ID_TEXT.test(typeValue.trim()) && Number(typeValue) > 0) type = Number(typeValue);
  else if (typeof typeValue === 'string' && typeValue.trim()) type = typeValue.trim();
  else if (typeValue != null) problems.push('type must be a positive integer type id or an EVE type name');

  const propMod = ReadPropModArgument(args['propMod'], problems);

  const fitValue = args['fit'];
  let fit: Maybe<string> = null;
  if (typeof fitValue === 'string' && fitValue.trim().startsWith('[') && fitValue.length <= MAX_FIT_LENGTH) {
    fit = fitValue.trim();
    const parsed = parseEftFit(fit);
    problems.push(...parsed.problems.map((problem) => `fit: ${problem}`));
    if (!dna && type == null && parsed.hull) type = parsed.hull;
    if (propMod) problems.push("propMod and fit do not go together: the fit's prop mod is the one it flies");
  } else if (fitValue != null) {
    problems.push(`fit must be EFT text starting with "[Hull, Fit name]", at most ${MAX_FIT_LENGTH} characters`);
  }

  const activeValue = args['active'];
  let active: Maybe<readonly string[]> = null;
  const activeList = typeof activeValue === 'string' ? [activeValue] : activeValue;
  if (Array.isArray(activeList) && activeList.length && activeList.every((entry) => typeof entry === 'string' && entry.trim())) active = activeList as string[];
  else if (activeValue != null) problems.push('active must be a list of module selectors: module keys ("mid-0"), categories ("hardener"), "all" or module names');
  if (active && fitValue == null) problems.push('active needs a fit');

  const traceValue = args['trace'];
  if (traceValue != null && typeof traceValue !== 'boolean') problems.push('trace must be true or false');

  const stats = normalizeHullStatOverrides({ input: args['stats'], where: 'stats' });
  problems.push(...stats.problems);
  const complete = HULL_STAT_OVERRIDE_KEYS.every((key) => stats.overrides?.[key] != null);
  if (!dna && type == null && !complete) problems.push('name the hull by dna or type, or give all four stats (mass, maxVelocity, agility, signatureRadius)');

  const pilot = ReadPilot(args['pilot'], problems);

  if (problems.length) throw new SceneError(problems);
  return { dna, type, propMod, overrides: stats.overrides, pilot, fit, active, trace: traceValue === true };
}

function ReadPropModArgument(value: unknown, problems: string[]): Maybe<PropModArgument> {
  const kind = readPropModKind(value);
  let propMod: Maybe<PropModArgument> = null;
  if (kind) {
    propMod = { kind };
  } else if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && TYPE_ID_TEXT.test(value.trim()) && Number(value) > 0)) {
    propMod = { typeID: Number(value) };
  } else if (typeof value === 'string' && value.trim().toLowerCase() === PROP_MOD_MODULE_NONE) {
    problems.push('propMod "none" fits no prop mod; omit propMod instead');
  } else if (typeof value === 'string' && value.trim()) {
    propMod = { name: value.trim() };
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Readonly<Record<string, unknown>>;
    const numbers = ['speedFactor', 'speedBoostFactor', 'massAddition', 'signatureRadiusBonus'].map((key) => {
      const field = object[key] ?? (key === 'signatureRadiusBonus' ? 0 : undefined);
      const valid = typeof field === 'number' && Number.isFinite(field) && field >= 0;
      if (!valid) problems.push(`propMod.${key} must be a number of 0 or more`);
      return valid ? field : 0;
    });
    const explicitKind = object['kind'] == null ? null : readPropModKind(object['kind']);
    if (object['kind'] != null && !explicitKind) problems.push('propMod.kind must be "mwd" or "ab"');
    const [speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus] = numbers;
    const name = typeof object['name'] === 'string' ? object['name'] : null;
    const duration = object['duration'];
    if (duration != null && !(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) problems.push('propMod.duration must be a positive number (ms)');
    propMod = { stats: { kind: explicitKind ?? (signatureRadiusBonus > 0 ? 'microwarpdrive' : 'afterburner'), speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus, name, ...(typeof duration === 'number' ? { duration } : {}) } };
  } else if (value != null) {
    problems.push('propMod must be "mwd", "ab", a module type id or name, or { speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus?, duration? }');
  }
  return propMod;
}

function ReadPilot(value: unknown, problems: string[]): PilotContext {
  let pilot: PilotContext = MAX_SKILLS_PILOT;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Readonly<Record<string, unknown>>;
    try {
      pilot = createPilotContext({
        name: typeof object['name'] === 'string' ? object['name'] : 'custom',
        skills: (object['skills'] ?? undefined) as PilotContextConfig['skills'],
        defaultLevel: (object['defaultLevel'] ?? undefined) as number | undefined
      });
    } catch (error) {
      problems.push(`pilot: ${ErrorMessage(error)}`);
    }
  } else if (value != null) {
    problems.push('pilot must be an object: { "skills": { "<skill name or type id>": level }, "defaultLevel"? }');
  }
  return pilot;
}
