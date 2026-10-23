/**
 * A ship's effective flight numbers: its hull's published values, then any per-ship
 * overrides, then the pilot's skills, then an active prop mod.
 *
 * The output fields `mass`, `maxVelocity`, `agility` and `radius` are exactly what a
 * Destiny ball takes (CjsBallparkController's AddBall / SetBallMass / SetMaxSpeed /
 * SetBallAgility / SetBallRadius). Speed fraction (throttle) is an order's concern, not
 * a stat. Align time is derived: EVE enters warp at 75 % of max velocity, and a ball's
 * time constant is `mass × agility / 1e6` seconds, so align time is
 * `-ln(0.25) × mass × agility / 1e6` (exact; the server's warp waits for a whole tick).
 *
 * Incoming webs and painters (`incoming`) chain after the prop mod, penalized among
 * themselves; points and scrams add to warpScrambleStatus.
 *
 * Not modelled on this table path: hull trait bonuses, rigs, implants, boosters, fleet
 * command bursts, heat (overloadSpeedFactorBonus), other modules and stacking penalties
 * against them, and server tick rounding. With one prop mod there is nothing to
 * stack-penalize against, and skills are exempt. Sources: EVE's typeDogma / dogmaEffects
 * (ESI, 2026-10-21), Pyfa's Effect6730 / Effect6731, EVE University's "Propulsion equipment".
 *
 * With `dogma` (a fit's modules and a dogma bundle) the numbers come from the dogma
 * evaluator instead (fitting/dogma.ts), which also gives HP, resists, capacitor and
 * targeting. For a bare hull or a lone prop mod both paths give the same numbers.
 */

import type { Maybe } from '@dereekb/util';
import { moduleNumbersOf, type ShipCapacitor, shipCapacitorOf, type ShipDefense, shipDefenseOf, type ShipTargeting, shipTargetingOf } from '../fitting/defense';
import { applyIncomingModifiers, DOGMA_ATTRIBUTES, type DogmaIncomingModifier, type DogmaModuleInput, type DogmaShip, evaluateShipDogma } from '../fitting/dogma';
import type { DogmaBundle } from '../fitting/dogma-bundle';
import { MAX_SKILLS_PILOT, type PilotContext, readSkillLevel } from './pilot';
import type { PropModStats } from './prop-mods';
import { SHIP_SKILLS, type ShipSkill } from './skills';

/**
 * Destiny's friction constant (CjsBallparkController `mFriction`): a ball's time
 * constant is `mass × agility / DESTINY_FRICTION` seconds.
 */
export const DESTINY_FRICTION = 1_000_000;

/**
 * The fraction of max velocity a ship must reach to enter warp.
 */
export const ALIGN_VELOCITY_FRACTION = 0.75;

/**
 * A hull's published values, as the SDE has them.
 */
export interface HullStats {
  /**
   * kg.
   */
  readonly mass: number;
  /**
   * m/s.
   */
  readonly maxVelocity: number;
  /**
   * The inertia modifier: a multiplier on mass in Destiny's acceleration.
   */
  readonly agility: number;
  /**
   * m.
   */
  readonly signatureRadius: number;
  /**
   * The ball radius in m (collision and orbit distance).
   */
  readonly radius?: Maybe<number>;
  /**
   * AU/s.
   */
  readonly warpSpeedMultiplier?: Maybe<number>;
  /**
   * 1 small, 2 medium, 3 large, 4 capital; picks the hull-sized prop mod.
   */
  readonly rigSize?: Maybe<number>;
  /**
   * advancedAgility (853), carried by capital hulls (normally 1); Advanced Spaceship Command scales it.
   */
  readonly advancedAgility?: Maybe<number>;
  /**
   * advancedCapitalAgility (874), carried by capital hulls (normally 1); Capital Ships scales it.
   */
  readonly advancedCapitalAgility?: Maybe<number>;
  /**
   * warpScrambleStatus (104): the hull's own warp core strength, negated (0 for most hulls, −2 on a Venture).
   */
  readonly warpScrambleStatus?: Maybe<number>;
}

/**
 * The hull values a scene ship can override.
 */
export const HULL_STAT_OVERRIDE_KEYS = ['mass', 'maxVelocity', 'agility', 'signatureRadius'] as const;

export type HullStatOverrideKey = (typeof HULL_STAT_OVERRIDE_KEYS)[number];

/**
 * Per-ship replacements for a hull's published values, applied before the pilot and the prop mod.
 */
export type HullStatOverrides = { readonly [K in HullStatOverrideKey]?: number };

interface StatRule {
  readonly min: number;
  readonly inclusive: boolean;
  readonly expectation: string;
}

const STAT_RULES: Readonly<Record<HullStatOverrideKey, StatRule>> = {
  mass: { min: 0, inclusive: false, expectation: 'must be a positive number (kg)' },
  maxVelocity: { min: 0, inclusive: true, expectation: 'must be a number of 0 or more (m/s)' },
  agility: { min: 0, inclusive: false, expectation: 'must be a positive number' },
  signatureRadius: { min: 0, inclusive: false, expectation: 'must be a positive number (m)' }
};

export interface NormalizeHullStatOverridesInput {
  readonly input: unknown;
  /**
   * Where the overrides sit, for messages, e.g. "ships[0].stats".
   */
  readonly where: string;
}

export interface NormalizedHullStatOverrides {
  /**
   * The valid overrides, or null when none were given.
   */
  readonly overrides: Maybe<HullStatOverrides>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates per-ship stat overrides. Unknown keys warn and are dropped; a null key, an
 * empty object or null means no override.
 *
 * @param config - The candidate overrides and where they sit.
 * @returns The overrides with every problem and warning found.
 */
export function normalizeHullStatOverrides(config: NormalizeHullStatOverridesInput): NormalizedHullStatOverrides {
  const { input, where } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const overrides: Partial<Record<HullStatOverrideKey, number>> = {};

  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    problems.push(`${where} must be an object of mass, maxVelocity, agility and signatureRadius`);
  } else if (input != null) {
    const record = input as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record)) if (!isOverrideKey(key)) warnings.push(`${where}.${key} is not a known stat and was dropped`);
    // Canonical key order, so two equal override sets serialize the same.
    for (const key of HULL_STAT_OVERRIDE_KEYS) {
      const value = record[key];
      if (value == null) continue;
      if (isStatValue(key, value)) overrides[key] = value;
      else problems.push(`${where}.${key} ${STAT_RULES[key].expectation}`);
    }
  }

  return { overrides: Object.keys(overrides).length ? overrides : null, problems, warnings };
}

export interface ShipStatsInput {
  /**
   * The hull's published values; null when the overrides give all four values.
   */
  readonly hull: Maybe<HullStats>;
  readonly overrides?: Maybe<HullStatOverrides>;
  /**
   * Defaults to MAX_SKILLS_PILOT.
   */
  readonly pilot?: Maybe<PilotContext>;
  /**
   * The prop mod running, if any. Ignored with `dogma` (the fit's prop module is its prop mod).
   */
  readonly propMod?: Maybe<PropModStats>;
  /**
   * The ship's fit for the dogma evaluator; `hull` is then ignored.
   */
  readonly dogma?: Maybe<ShipDogmaInput>;
  /**
   * Modifiers other ships' modules put on it (webs, painters, points, scrams: incomingModifiersOf). The dogma path
   * evaluates them with its own modules and resistances; the table path applies maxVelocity and signatureRadius after
   * the prop mod, and warpScrambleStatus, with no resistance.
   */
  readonly incoming?: Maybe<readonly DogmaIncomingModifier[]>;
}

/**
 * A fitted ship for the dogma path of computeShipStats.
 */
export interface ShipDogmaInput {
  readonly bundle: DogmaBundle;
  readonly hullTypeID: number;
  /**
   * The fitted modules with their states (typed-fit's toDogmaModules).
   */
  readonly modules?: readonly DogmaModuleInput[];
  /**
   * The key of the ship's prop mod (the typed fit's `prop` module): its cycle is propModCycleTime and its running is
   * propModActive.
   */
  readonly propModKey?: Maybe<string>;
}

/**
 * Where a ShipStats' numbers came from: the skill table (a hull's published values) or the dogma evaluator (a fit).
 */
export type ShipStatsMath = 'table' | 'dogma';

export type ShipStatsAttribute = HullStatOverrideKey | 'propModSpeedFactor' | 'propModDuration' | 'warpScrambleStatus';

/**
 * One step of the math, for answers that show their work.
 */
export interface AppliedBonus {
  /**
   * "stats override", a skill and level such as "Navigation V", or the prop mod's name.
   */
  readonly source: string;
  readonly attribute: ShipStatsAttribute;
  readonly from: number;
  readonly to: number;
}

export interface ShipStats {
  /**
   * kg, including an active prop mod's mass addition.
   */
  readonly mass: number;
  /**
   * m/s.
   */
  readonly maxVelocity: number;
  readonly agility: number;
  /**
   * m.
   */
  readonly signatureRadius: number;
  /**
   * The hull's ball radius in m, unchanged; null when unknown.
   */
  readonly radius: Maybe<number>;
  /**
   * AU/s, unchanged; null when unknown.
   */
  readonly warpSpeedMultiplier: Maybe<number>;
  /**
   * Seconds to reach 75 % of max velocity from a standstill.
   */
  readonly alignTime: number;
  /**
   * warpScrambleStatus (104) with the points and scrams on it and its own modules (a warp core stabilizer, siege):
   * above 0 it cannot warp. `applied` lists the steps that changed it.
   */
  readonly warpScrambleStatus: number;
  readonly propModActive: boolean;
  /**
   * Seconds per prop mod cycle with the pilot's skills; null without a prop mod or its duration.
   */
  readonly propModCycleTime: Maybe<number>;
  /**
   * The pilot context's name.
   */
  readonly pilot: string;
  readonly applied: readonly AppliedBonus[];
  readonly math: ShipStatsMath;
  /**
   * HP, resists and EHP per layer; null on the table path.
   */
  readonly defense: Maybe<ShipDefense>;
  /**
   * The capacitor with the active modules running; null on the table path.
   */
  readonly capacitor: Maybe<ShipCapacitor>;
  /**
   * Lock range, scan resolution and locked targets; null on the table path.
   */
  readonly targeting: Maybe<ShipTargeting>;
}

const ROMAN_LEVELS = ['0', 'I', 'II', 'III', 'IV', 'V'] as const;

const WARP_SCRAMBLE_STATUS = 104;

/**
 * Computes a ship's effective flight numbers.
 *
 * @param input - The hull's published values, overrides, the pilot and the prop mod.
 * @returns The numbers the ship flies by, with the steps that produced them.
 * @throws {RangeError} When a value is missing or out of range, naming the field.
 */
export function computeShipStats(input: ShipStatsInput): ShipStats {
  const { hull, overrides, propMod, dogma } = input;
  const pilot = input.pilot ?? MAX_SKILLS_PILOT;
  if (dogma) {
    for (const key of HULL_STAT_OVERRIDE_KEYS) {
      const value = overrides?.[key];
      if (value != null && !isStatValue(key, value)) throw new RangeError(`overrides.${key} ${STAT_RULES[key].expectation}`);
    }
    const ship = evaluateShipDogma({ bundle: dogma.bundle, hullTypeID: dogma.hullTypeID, overrides, modules: dogma.modules, pilot, incoming: input.incoming });
    return dogmaShipStats({ ship, bundle: dogma.bundle, overrides, propModKey: dogma.propModKey });
  }
  const applied: AppliedBonus[] = [];
  if (propMod) checkPropMod(propMod);
  const values: Record<ShipStatsAttribute, number> = { ...readBaseValues({ hull, overrides, applied }), propModSpeedFactor: propMod?.speedFactor ?? 0, propModDuration: propMod?.duration ?? 0, warpScrambleStatus: hull?.warpScrambleStatus ?? 0 };
  const step = (source: string, attribute: ShipStatsAttribute, change: (from: number) => number): void => {
    const from = values[attribute];
    values[attribute] = change(from);
    applied.push({ source, attribute, from, to: values[attribute] });
  };

  for (const [hook, name] of [
    [hull?.advancedAgility, 'advancedAgility'],
    [hull?.advancedCapitalAgility, 'advancedCapitalAgility']
  ] as const) {
    if (hook != null && !(Number.isFinite(hook) && hook > 0)) throw new RangeError(`hull.${name} must be a positive number`);
    if (hook != null && hook !== 1) step(`hull ${name}`, 'agility', (agility) => agility * hook);
  }

  for (const skill of SHIP_SKILLS) {
    const level = readSkillLevel(pilot.skillLevel(skill), `pilot "${pilot.name}" ${skill.name}`);
    const attribute = skillAttribute({ skill, hull, propMod });
    if (level > 0 && attribute) step(skillSource(skill, level), attribute, (from) => from * (1 + (skill.bonusPerLevel * level) / 100));
  }

  if (propMod) {
    const source = propMod.name ?? 'prop mod';
    if (propMod.massAddition > 0) step(source, 'mass', (mass) => mass + propMod.massAddition);
    step(source, 'maxVelocity', (maxVelocity) => maxVelocity * (1 + (values.propModSpeedFactor * propMod.speedBoostFactor) / values.mass / 100));
    if (propMod.signatureRadiusBonus > 0) step(source, 'signatureRadius', (signatureRadius) => signatureRadius * (1 + propMod.signatureRadiusBonus / 100));
  }

  const incoming = input.incoming ?? [];
  for (const [attribute, id] of [
    ['maxVelocity', DOGMA_ATTRIBUTES.maxVelocity],
    ['signatureRadius', DOGMA_ATTRIBUTES.signatureRadius]
  ] as const) {
    const modifiers = incoming.filter((modifier) => modifier.attributeID === id);
    if (!modifiers.length) continue;
    for (const { source, to } of applyIncomingModifiers({ base: values[attribute], modifiers, stackable: false }).steps) step(source, attribute, () => to);
  }
  for (const modifier of incoming) {
    if (modifier.attributeID !== WARP_SCRAMBLE_STATUS || (modifier.operation !== 2 && modifier.operation !== 3)) continue;
    step(modifier.source, 'warpScrambleStatus', (status) => (modifier.operation === 2 ? status + modifier.amount : status - modifier.amount));
  }

  return {
    mass: values.mass,
    maxVelocity: values.maxVelocity,
    agility: values.agility,
    signatureRadius: values.signatureRadius,
    radius: hull?.radius ?? null,
    warpSpeedMultiplier: hull?.warpSpeedMultiplier ?? null,
    alignTime: computeAlignTime(values.mass, values.agility),
    warpScrambleStatus: values.warpScrambleStatus,
    propModActive: propMod != null,
    propModCycleTime: propMod?.duration == null ? null : values.propModDuration / 1000,
    pilot: pilot.name,
    applied,
    math: 'table',
    defense: null,
    capacitor: null,
    targeting: null
  };
}

export interface DogmaShipStatsInput {
  /**
   * The evaluated ship (evaluateShipDogma).
   */
  readonly ship: DogmaShip;
  readonly bundle: DogmaBundle;
  /**
   * The overrides it was evaluated with, for the `stats override` steps.
   */
  readonly overrides?: Maybe<HullStatOverrides>;
  readonly propModKey?: Maybe<string>;
}

/**
 * The stats of an evaluated ship: its flight numbers, defense, capacitor (with its active modules running) and
 * targeting. `applied` lists the steps that made mass, maxVelocity, agility and signatureRadius; propModCycleTime is
 * the prop module's cycle whatever its state.
 *
 * @param input - The evaluated ship, its bundle, the overrides and the prop mod's key.
 * @returns The stats, `math: 'dogma'`.
 */
export function dogmaShipStats(input: DogmaShipStatsInput): ShipStats {
  const { ship, bundle, overrides, propModKey } = input;
  const applied: AppliedBonus[] = [];
  const values = {} as Record<HullStatOverrideKey, number>;
  for (const key of HULL_STAT_OVERRIDE_KEYS) {
    const id = DOGMA_ATTRIBUTES[key];
    const published = key === 'mass' ? (ship.hull.mass ?? ship.hull.attributes[id]) : ship.hull.attributes[id];
    const override = overrides?.[key];
    if (override != null && published != null && override !== published) applied.push({ source: 'stats override', attribute: key, from: published, to: override });
    for (const step of ship.trace(id)) if (step.from !== step.to) applied.push({ source: step.source, attribute: key, from: step.from, to: step.to });
    values[key] = ship.attribute(id);
  }
  for (const step of ship.trace(WARP_SCRAMBLE_STATUS)) if (step.from !== step.to) applied.push({ source: step.source, attribute: 'warpScrambleStatus', from: step.from, to: step.to });
  const active = [...ship.modules].flatMap(([key, module]) => (module.state === 'active' ? [key] : []));
  const prop = propModKey == null ? null : ship.modules.get(propModKey);
  const radius = ship.attribute(DOGMA_ATTRIBUTES.radius);
  const warpSpeedMultiplier = ship.attribute(DOGMA_ATTRIBUTES.warpSpeedMultiplier);
  return {
    ...values,
    radius: radius > 0 ? radius : null,
    warpSpeedMultiplier: warpSpeedMultiplier > 0 ? warpSpeedMultiplier : null,
    alignTime: computeAlignTime(values.mass, values.agility),
    warpScrambleStatus: ship.attribute(WARP_SCRAMBLE_STATUS),
    propModActive: prop?.state === 'active',
    propModCycleTime: prop && propModKey != null ? (moduleNumbersOf(ship, bundle, propModKey)?.cycleTime ?? null) : null,
    pilot: ship.pilot,
    applied,
    math: 'dogma',
    defense: shipDefenseOf(ship),
    capacitor: shipCapacitorOf(ship, bundle, active),
    targeting: shipTargetingOf(ship)
  };
}

/**
 * Seconds a ship needs to reach 75 % of its max velocity from a standstill.
 *
 * @param mass - Kg.
 * @param agility - The ship's agility.
 * @returns The align time in seconds.
 */
export function computeAlignTime(mass: number, agility: number): number {
  return (-Math.log(1 - ALIGN_VELOCITY_FRACTION) * mass * agility) / DESTINY_FRICTION;
}

interface ReadBaseValuesInput {
  readonly hull: Maybe<HullStats>;
  readonly overrides: Maybe<HullStatOverrides>;
  readonly applied: AppliedBonus[];
}

function readBaseValues(input: ReadBaseValuesInput): Record<HullStatOverrideKey, number> {
  const { hull, overrides, applied } = input;
  const values = {} as Record<HullStatOverrideKey, number>;
  for (const key of HULL_STAT_OVERRIDE_KEYS) {
    const override = overrides?.[key];
    const published = hull?.[key];
    if (override == null && hull == null) throw new RangeError(`overrides.${key} is required when the hull's published values are unknown`);
    const value = override ?? published;
    if (!isStatValue(key, value)) throw new RangeError(`${override == null ? 'hull' : 'overrides'}.${key} ${STAT_RULES[key].expectation}`);
    if (override != null && published != null && override !== published) applied.push({ source: 'stats override', attribute: key, from: published, to: override });
    values[key] = value;
  }
  return values;
}

function checkPropMod(propMod: PropModStats): void {
  for (const key of ['speedFactor', 'speedBoostFactor', 'massAddition', 'signatureRadiusBonus'] as const) {
    const value = propMod[key];
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new RangeError(`propMod.${key} must be a number of 0 or more`);
  }
  if (propMod.duration != null && !(Number.isFinite(propMod.duration) && propMod.duration > 0)) throw new RangeError('propMod.duration must be a positive number (ms)');
}

interface SkillAttributeInput {
  readonly skill: ShipSkill;
  readonly hull: Maybe<HullStats>;
  readonly propMod: Maybe<PropModStats>;
}

/**
 * What a skill changes for this ship, or null when it does not apply (a capital skill on a
 * subcapital hull, Acceleration Control with no prop mod). Afterburner shortens only an
 * afterburner's cycle: its effect targets modules requiring the Afterburner skill, which
 * every afterburner and no microwarpdrive does, so the module's kind stands in for that.
 */
function skillAttribute(input: SkillAttributeInput): Maybe<ShipStatsAttribute> {
  const { skill, hull, propMod } = input;
  let attribute: Maybe<ShipStatsAttribute> = null;
  switch (skill.target) {
    case 'maxVelocity':
    case 'agility':
      attribute = skill.target;
      break;
    case 'advancedAgility':
    case 'advancedCapitalAgility':
      attribute = hull?.[skill.target] == null ? null : 'agility';
      break;
    case 'propModSpeedFactor':
      attribute = propMod ? 'propModSpeedFactor' : null;
      break;
    case 'afterburnerDuration':
      attribute = propMod?.kind === 'afterburner' && propMod.duration != null ? 'propModDuration' : null;
      break;
  }
  return attribute;
}

function skillSource(skill: ShipSkill, level: number): string {
  const capital = skill.target === 'advancedAgility' || skill.target === 'advancedCapitalAgility' ? ' (capital hull)' : '';
  return `${skill.name} ${ROMAN_LEVELS[level]}${capital}`;
}

function isOverrideKey(key: string): key is HullStatOverrideKey {
  return (HULL_STAT_OVERRIDE_KEYS as readonly string[]).includes(key);
}

function isStatValue(key: HullStatOverrideKey, value: unknown): value is number {
  const rule = STAT_RULES[key];
  return typeof value === 'number' && Number.isFinite(value) && (rule.inclusive ? value >= rule.min : value > rule.min);
}
