/**
 * set_hp: the live command that sets ships' shield, armor and structure HP (battle damage for a shot, or a low-HP fight),
 * and the pure maths the page runs for each ship. What the set_hp tool runs, and what a timeline beat will embed.
 *
 * Every value is the HP a layer is left with: HP (a number), a percent of the max (`"40%"`), or a seeded random draw
 * `{ min, max, distribution? }`. A command sets layers (each named one; the others keep their HP) or the `total` (the
 * three combined, taken off a full ship shield first, then armor, then structure: the damage spill). Draws are keyed by
 * (seed, ship, target), so the same call on the same scene gives every ship the same HP in any selection order.
 */

import { DEFENSE_LAYERS, type DefenseLayerName } from '../fitting/defense';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { isPlainObject } from '../json';
import { SceneError } from '../scene';
import { applyLayeredDamage } from './damage';
import { DEFAULT_HP_DISTRIBUTION, type DistributionRange, distributionQuantile, HP_DISTRIBUTIONS, type HpDistribution } from './distributions';
import { MAX_COMBAT_SEED } from './document';
import { combatUnit } from './random';

/**
 * What a set is for: `cinematic` never kills (structure the set writes keeps CINEMATIC_MIN_STRUCTURE_HP), `gameplay`
 * plays EVE's rule (a ship left at 0 structure is destroyed at the next tick boundary, as combat.death says).
 */
export const HP_SET_INTENTS = ['cinematic', 'gameplay'] as const;

export type HpSetIntent = (typeof HP_SET_INTENTS)[number];

export const DEFAULT_HP_SET_INTENT: HpSetIntent = 'cinematic';

/**
 * The structure a cinematic set leaves at least, in HP.
 */
export const CINEMATIC_MIN_STRUCTURE_HP = 1;

/**
 * What a value can set: a layer, or the three combined.
 */
export const HP_SET_TARGETS = ['shield', 'armor', 'structure', 'total'] as const;

export type HpSetTarget = (typeof HP_SET_TARGETS)[number];

/**
 * HP (a number ≥ 0) or a percent of the max (`"40%"`, 0 to 100).
 */
export type HpAmountValue = number | string;

/**
 * A seeded random draw. Its min, max, mean, sd and mode are all HP or all percent (a percent sd is points of the max).
 */
export interface HpRangeValue {
  readonly min: HpAmountValue;
  readonly max: HpAmountValue;
  readonly distribution: HpDistribution;
  /**
   * The normal's mean and standard deviation (normal only; default the middle and the range over 4).
   */
  readonly mean?: HpAmountValue;
  readonly sd?: HpAmountValue;
  /**
   * The triangular's mode (triangular only; default the middle).
   */
  readonly mode?: HpAmountValue;
}

export type HpSetValue = HpAmountValue | HpRangeValue;

export interface HpSetCommand extends FleetSelection {
  readonly shield?: HpSetValue;
  readonly armor?: HpSetValue;
  readonly structure?: HpSetValue;
  /**
   * The HP left across the three layers; not with shield, armor or structure.
   */
  readonly total?: HpSetValue;
  readonly intent: HpSetIntent;
  /**
   * Keys the random draws; default the document's combat seed.
   */
  readonly seed?: number;
}

/**
 * An amount read: HP, or a percent of the max.
 */
export interface HpAmount {
  readonly unit: 'hp' | 'percent';
  readonly value: number;
}

const HP_SET_KEYS = new Set<string>(['intent', 'seed', ...HP_SET_TARGETS, ...FLEET_SELECTION_KEYS]);
const HP_RANGE_KEYS = new Set<string>(['min', 'max', 'distribution', 'mean', 'sd', 'mode']);
const HP_RANGE_AMOUNT_KEYS = ['min', 'max', 'mean', 'sd', 'mode'] as const;
const PERCENT_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/;

const HP_VALUE_HINT = 'HP (a number of 0 or more), a percent of the max ("40%", 0% to 100%) or a random draw { min, max, distribution? }';

/**
 * Reads an amount already validated (normalizeHpSetCommand's output).
 *
 * @param value - HP or `"<p>%"`.
 * @returns Its unit and number.
 */
export function readHpAmount(value: HpAmountValue): HpAmount {
  const percent = typeof value === 'string' ? PERCENT_PATTERN.exec(value) : null;
  return percent ? { unit: 'percent', value: Number(percent[1]) } : { unit: 'hp', value: Number(value) };
}

function normalizeAmount(value: unknown, path: string, problems: string[]): HpAmountValue | undefined {
  let result: HpAmountValue | undefined;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) result = value;
    else problems.push(`${path} must be a finite number of HP, 0 or more`);
  } else if (typeof value === 'string') {
    const percent = PERCENT_PATTERN.exec(value);
    if (!percent) problems.push(`${path} "${value}" is not a percent ("40%")`);
    else if (Number(percent[1]) < 0 || Number(percent[1]) > 100) problems.push(`${path} "${value.trim()}": percentages run from 0% to 100%`);
    else result = `${Number(percent[1])}%`;
  } else {
    problems.push(`${path} must be ${HP_VALUE_HINT}`);
  }
  return result;
}

function normalizeRange(input: Readonly<Record<string, unknown>>, path: string, problems: string[]): HpRangeValue | undefined {
  const before = problems.length;
  for (const key of Object.keys(input)) if (!HP_RANGE_KEYS.has(key)) problems.push(`${path}.${key} is not a range field (min, max, distribution, mean, sd, mode)`);
  if (input['min'] == null || input['max'] == null) problems.push(`${path} needs min and max`);
  const distributionInput = input['distribution'];
  const known = distributionInput == null || (typeof distributionInput === 'string' && (HP_DISTRIBUTIONS as readonly string[]).includes(distributionInput));
  const distribution = known && distributionInput != null ? (distributionInput as HpDistribution) : DEFAULT_HP_DISTRIBUTION;
  if (!known) problems.push(`${path}.distribution must be one of ${HP_DISTRIBUTIONS.join(', ')}`);
  const amounts: Partial<Record<(typeof HP_RANGE_AMOUNT_KEYS)[number], HpAmountValue>> = {};
  for (const key of HP_RANGE_AMOUNT_KEYS) {
    const value = input[key];
    if (value == null) continue;
    const amount = normalizeAmount(value, `${path}.${key}`, problems);
    if (amount != null) amounts[key] = amount;
  }
  if (known) {
    if (distribution !== 'normal') for (const key of ['mean', 'sd'] as const) if (input[key] != null) problems.push(`${path}.${key} is for the normal distribution`);
    if (distribution !== 'triangular' && input['mode'] != null) problems.push(`${path}.mode is for the triangular distribution`);
  }
  const read = Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, readHpAmount(value)])) as Partial<Record<(typeof HP_RANGE_AMOUNT_KEYS)[number], HpAmount>>;
  const units = new Set(Object.values(read).map((amount) => amount.unit));
  if (units.size > 1) {
    problems.push(`${path}: min, max, mean, sd and mode use one unit: all HP or all percent`);
  } else if (read.min && read.max) {
    if (read.min.value > read.max.value) problems.push(`${path}: min is above max`);
    else
      for (const key of ['mean', 'mode'] as const) {
        const amount = read[key];
        if (amount && (amount.value < read.min.value || amount.value > read.max.value)) problems.push(`${path}.${key} must be within min and max`);
      }
  }
  if (read.sd && read.sd.value <= 0) problems.push(`${path}.sd must be above 0`);
  let result: HpRangeValue | undefined;
  if (problems.length === before && amounts.min != null && amounts.max != null) {
    result = { min: amounts.min, max: amounts.max, distribution, ...(amounts.mean != null ? { mean: amounts.mean } : {}), ...(amounts.sd != null ? { sd: amounts.sd } : {}), ...(amounts.mode != null ? { mode: amounts.mode } : {}) };
  }
  return result;
}

function normalizeValue(value: unknown, path: string, problems: string[]): HpSetValue | undefined {
  return isPlainObject(value) ? normalizeRange(value, path, problems) : normalizeAmount(value, path, problems);
}

/**
 * Validates a set_hp command: a selection (exactly one of `ships` and `fleet`, a fleet narrowed by `wing` or `squad`),
 * `shield` / `armor` / `structure` or `total` (each HP, `"<p>%"` or a range), optional `intent` (default cinematic) and
 * `seed` (an integer 0 … 2³² − 1). Unknown keys are problems.
 *
 * @param input - The candidate command.
 * @param where - Where it sits, for messages.
 * @returns The command, its values normalized (percents trimmed, a range's distribution filled in).
 * @throws {SceneError} With every problem found.
 */
export function normalizeHpSetCommand(input: unknown, where = 'set_hp'): HpSetCommand {
  const problems: string[] = [];
  let result: HpSetCommand = { intent: DEFAULT_HP_SET_INTENT };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ships | fleet [, wing | squad], shield? | armor? | structure? | total?, intent?, seed? }`);
  } else {
    for (const key of Object.keys(input)) if (!HP_SET_KEYS.has(key)) problems.push(`${where}.${key} is not a set_hp field${key === 'hull' ? ' (the hull layer is structure)' : ''}`);
    const values: Partial<Record<HpSetTarget, HpSetValue>> = {};
    for (const target of HP_SET_TARGETS) {
      if (input[target] == null) continue;
      const value = normalizeValue(input[target], `${where}.${target}`, problems);
      if (value != null) values[target] = value;
    }
    const given = HP_SET_TARGETS.filter((target) => input[target] != null);
    if (!given.length) problems.push(`${where} needs shield, armor, structure or total`);
    else if (given.includes('total') && given.length > 1) problems.push(`${where}: give total, or shield / armor / structure, not both`);
    const intent = input['intent'];
    if (intent != null && !(typeof intent === 'string' && (HP_SET_INTENTS as readonly string[]).includes(intent))) problems.push(`${where}.intent must be one of ${HP_SET_INTENTS.join(', ')}`);
    const seed = input['seed'];
    if (seed != null && !(typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_COMBAT_SEED)) problems.push(`${where}.seed must be an integer from 0 to ${MAX_COMBAT_SEED}`);
    const selection = readFleetSelection(input, where, problems);
    result = { ...selection, ...values, intent: typeof intent === 'string' ? (intent as HpSetIntent) : DEFAULT_HP_SET_INTENT, ...(typeof seed === 'number' ? { seed } : {}) };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}

/**
 * Whether a command draws any value at random (its result then reports the seed).
 *
 * @param command - The command.
 * @returns True when a value is a range.
 */
export function hpSetHasRandom(command: HpSetCommand): boolean {
  return HP_SET_TARGETS.some((target) => isPlainObject(command[target]));
}

/**
 * The values a command sets, by target.
 *
 * @param command - The command.
 * @returns The values given.
 */
export function hpSetValuesOf(command: HpSetCommand): Partial<Record<HpSetTarget, HpSetValue>> {
  return Object.fromEntries(HP_SET_TARGETS.filter((target) => command[target] != null).map((target) => [target, command[target]]));
}

/**
 * A ship's roll for one target: cyrb53 of `seed|hp|<ship>|<target>` over 2⁵³.
 *
 * @param seed - The command's seed, else the document's combat seed.
 * @param ship - The ship id.
 * @param target - The layer or `total`.
 * @returns A uniform roll in [0, 1).
 */
export function hpSetRoll(seed: number, ship: string, target: HpSetTarget): number {
  return combatUnit(seed, `hp|${ship}|${target}`);
}

const UNIT_RESONANCES = { em: 1, thermal: 1, kinetic: 1, explosive: 1 } as const;

/**
 * The layers a total leaves: the deficit (Σ max − total) taken off a full ship through applyLayeredDamage at unit
 * resonances, shield first, then armor, then structure, each spilling on as damage does.
 *
 * @param maxes - Each layer's max HP.
 * @param total - The HP to leave across the three, at most Σ max.
 * @returns Each layer's HP.
 */
export function drainTotalHp(maxes: Readonly<Record<DefenseLayerName, number>>, total: number): Record<DefenseLayerName, number> {
  const full = DEFENSE_LAYERS.reduce((sum, layer) => sum + maxes[layer], 0);
  const deficit = Math.max(0, full - total);
  const layers = { shield: { hp: maxes.shield, resonances: UNIT_RESONANCES }, armor: { hp: maxes.armor, resonances: UNIT_RESONANCES }, structure: { hp: maxes.structure, resonances: UNIT_RESONANCES } };
  const after = applyLayeredDamage(layers, { em: deficit, thermal: 0, kinetic: 0, explosive: 0 }).layers;
  return { shield: after.shield.hp, armor: after.armor.hp, structure: after.structure.hp };
}

/**
 * A layer's HP now and its max.
 */
export interface HpSetLayer {
  readonly hp: number;
  readonly max: number;
}

export interface ResolveHpSetInput {
  /**
   * The ship's layers now (DamageModel.Health).
   */
  readonly layers: Readonly<Record<DefenseLayerName, HpSetLayer>>;
  readonly command: HpSetCommand;
  readonly ship: string;
  /**
   * The seed the draws use: the command's, else the document's combat seed.
   */
  readonly seed: number;
}

/**
 * What a target was set to: its HP and, for a draw, the roll.
 */
export interface ResolvedHpSetTarget {
  readonly hp: number;
  readonly roll?: number;
}

export interface ResolvedHpSet {
  /**
   * Each layer's HP after the set (the layers not named keep theirs).
   */
  readonly hp: Readonly<Record<DefenseLayerName, number>>;
  /**
   * The HP each named target was set to (a total: the total, before the cinematic floor).
   */
  readonly set: Partial<Record<HpSetTarget, ResolvedHpSetTarget>>;
  /**
   * Why a value moved: above the max, the cinematic floor.
   */
  readonly clamped: readonly string[];
  /**
   * A gameplay set that left structure at 0: the ship dies at the next tick boundary.
   */
  readonly destroys: boolean;
}

function hpText(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

function amountHp(amount: HpAmount, max: number): number {
  return amount.unit === 'percent' ? (max * amount.value) / 100 : amount.value;
}

function resolveValue(value: HpSetValue, max: number, target: HpSetTarget, roll: () => number, clamped: string[]): ResolvedHpSetTarget {
  let result: ResolvedHpSetTarget;
  if (typeof value === 'object') {
    const min = amountHp(readHpAmount(value.min), max);
    const top = amountHp(readHpAmount(value.max), max);
    const range: DistributionRange = { min: Math.min(min, max), max: Math.min(top, max) };
    if (top > max) clamped.push(`${target} range ${hpText(min)}–${hpText(top)} HP is above its max ${hpText(max)}: drawn up to ${hpText(max)}`);
    const into = (amount: HpAmountValue | undefined): number | undefined => (amount == null ? undefined : Math.min(range.max, Math.max(range.min, amountHp(readHpAmount(amount), max))));
    const sd = value.sd == null ? undefined : amountHp(readHpAmount(value.sd), max);
    const u = roll();
    result = { hp: distributionQuantile(value.distribution, u, { ...range, mean: into(value.mean), sd, mode: into(value.mode) }), roll: u };
  } else {
    const hp = amountHp(readHpAmount(value), max);
    if (hp > max) clamped.push(`${target} ${hpText(hp)} HP is above its max ${hpText(max)}: set to ${hpText(max)}`);
    result = { hp: Math.min(hp, max) };
  }
  return result;
}

/**
 * Resolves a set for one ship: each named layer's value against its max (or the total against Σ max, drained from full),
 * draws keyed by (seed, ship, target), HP above a max set to the max, and the intent rule (cinematic: structure the set
 * writes keeps CINEMATIC_MIN_STRUCTURE_HP; gameplay: 0 structure destroys).
 *
 * @param input - The ship's layers, the command, the ship id and the seed.
 * @returns Each layer's HP, what each target was set to, the clamped notes and whether the ship dies.
 */
export function resolveHpSet(input: ResolveHpSetInput): ResolvedHpSet {
  const { layers, command, ship, seed } = input;
  const clamped: string[] = [];
  const set: Partial<Record<HpSetTarget, ResolvedHpSetTarget>> = {};
  const hp: Record<DefenseLayerName, number> = { shield: 0, armor: 0, structure: 0 };
  for (const layer of DEFENSE_LAYERS) hp[layer] = Math.min(layers[layer].max, Math.max(0, layers[layer].hp));
  if (command.total != null) {
    const maxes = { shield: layers.shield.max, armor: layers.armor.max, structure: layers.structure.max };
    const total = resolveValue(command.total, maxes.shield + maxes.armor + maxes.structure, 'total', () => hpSetRoll(seed, ship, 'total'), clamped);
    set.total = total;
    Object.assign(hp, drainTotalHp(maxes, total.hp));
  } else {
    for (const layer of DEFENSE_LAYERS) {
      const value = command[layer];
      if (value == null) continue;
      const resolved = resolveValue(value, layers[layer].max, layer, () => hpSetRoll(seed, ship, layer), clamped);
      set[layer] = resolved;
      hp[layer] = resolved.hp;
    }
  }
  const writesStructure = command.total != null || command.structure != null;
  const floor = Math.min(CINEMATIC_MIN_STRUCTURE_HP, layers.structure.max);
  if (command.intent === 'cinematic' && writesStructure && hp.structure < floor) {
    hp.structure = floor;
    clamped.push(`structure held at ${hpText(floor)} HP: a cinematic set never kills`);
  }
  const destroys = command.intent === 'gameplay' && layers.structure.max > 0 && hp.structure <= 0;
  return { hp, set, clamped, destroys };
}
