/**
 * Logi repair-target selection: which fleet member each logi repairs, runtime-free so the page's AutoRepair and the
 * specs share it. A pass looks at every logi of one fleet at once:
 *
 * - Tiers: a member under fire whose reps do not cover it comes first, then a member under fire that is covered, then
 *   a calm member to top off. "Under fire" is HP lost to shots over the last REPAIR_PRESSURE_SECONDS.
 * - A policy orders a tier: `urgent` (the shortest time to live), `damaged` (the lowest HP) or `shot-at` (the most
 *   incoming damage). Top-offs rank by the logi's layer.
 * - Coverage: reps worth REPAIR_COVER_MARGIN of a member's incoming damage cover it, so the next logi takes another
 *   member. One primary gets every logi; split fire gets split reps.
 * - Sticky: a logi keeps its target unless a better tier appears, or a member at least REPAIR_SWITCH_RATIO times as
 *   urgent in the same tier. It leaves a target that is healed and calm, gone (dead, warping) or out of reach.
 * - Each logi pre-locks up to REPAIR_PRE_LOCKS members under fire or yellow-boxed by hostile ships.
 *
 * A logi repairs per layer: its remote repairers of one layer choose together, each layer independently.
 */

import type { Maybe } from '@dereekb/util';
import { falloffEffectiveness, moduleReach } from '../fitting/activation';
import { DEFENSE_LAYERS, type DefenseLayerName } from '../fitting/defense';
import type { AutoRepairPolicy } from './auto-repair';

/**
 * The window "under fire" and pressure are measured over, in seconds: about two armor rep cycles.
 */
export const REPAIR_PRESSURE_SECONDS = 10;

/**
 * Reps worth this much of a member's pressure cover it.
 */
export const REPAIR_COVER_MARGIN = 1.25;

/**
 * In the same tier, a logi leaves its target only for a member at least this many times as urgent.
 */
export const REPAIR_SWITCH_RATIO = 2;

/**
 * A calm member below this fraction of its layer is topped off; once picked it is repaired to full.
 */
export const REPAIR_TOP_OFF_FRACTION = 0.95;

/**
 * HP: within this of max counts as full.
 */
export const REPAIR_FULL_HP = 1;

/**
 * A new target must lie within optimal + this many falloffs (50 % effectiveness at 1) of one of the logi's reps.
 */
export const REPAIR_SELECTION_FALLOFFS = 1;

/**
 * Pre-locks per logi.
 */
export const REPAIR_PRE_LOCKS = 2;

/**
 * `unreachable` rows per choice.
 */
export const REPAIR_UNREACHABLE_ROWS = 3;

/**
 * Why a logi repairs what it repairs: its target's tier, or why it has none.
 */
export const REPAIR_REASONS = ['under-fire', 'covering', 'topping-off', 'idle', 'out-of-range'] as const;

export type RepairReason = (typeof REPAIR_REASONS)[number];

export interface RepairLayerHealth {
  readonly hp: number;
  readonly max: number;
}

/**
 * A fleet member a logi may repair.
 */
export interface RepairCandidate {
  readonly id: string;
  readonly layers: Readonly<Record<DefenseLayerName, RepairLayerHealth>>;
  /**
   * HP it lost to shots over the last REPAIR_PRESSURE_SECONDS.
   */
  readonly taken: number;
  /**
   * Ships outside its fleet (and its team) locking or locked on it: "yellow-boxed".
   */
  readonly hostileLocks: number;
  /**
   * HP/s of remote repairs on it that this pass does not assign (manual switches, logi off auto-repair).
   */
  readonly otherReps: number;
}

/**
 * One remote repairer of a logi.
 */
export interface RepairModule {
  /**
   * Its key in the ship's fit.
   */
  readonly key: string;
  readonly layer: DefenseLayerName;
  /**
   * HP per cycle at full effectiveness.
   */
  readonly amount: number;
  /**
   * Seconds.
   */
  readonly cycleTime: number;
  /**
   * Optimal range, metres; null for no range limit.
   */
  readonly range: Maybe<number>;
  readonly falloff: Maybe<number>;
}

export interface RepairLogi {
  readonly id: string;
  readonly policy: AutoRepairPolicy;
  readonly modules: readonly RepairModule[];
  /**
   * Its maxTargetRange; Infinity without targeting numbers (it repairs unlocked).
   */
  readonly lockRange: number;
  /**
   * Surface distance to each candidate, metres. A candidate without one is out of its reach.
   */
  readonly distances: ReadonlyMap<string, number>;
  /**
   * Its target per layer from the last pass: the incumbent.
   */
  readonly current: Partial<Record<DefenseLayerName, string>>;
  /**
   * Ships it holds a lock on (any state): pre-locks prefer them.
   */
  readonly locks: ReadonlySet<string>;
}

export interface RepairUnreachable {
  readonly id: string;
  /**
   * Metres.
   */
  readonly distance: number;
  /**
   * HP/s.
   */
  readonly pressure: number;
}

/**
 * A logi's choice for one layer.
 */
export interface RepairChoice {
  readonly layer: DefenseLayerName;
  /**
   * The member it repairs; null when it repairs nobody.
   */
  readonly target: Maybe<string>;
  readonly reason: RepairReason;
  /**
   * The target is the incumbent, kept.
   */
  readonly kept: boolean;
  /**
   * The keys of its repairers of this layer that reach the target: they run on it.
   */
  readonly modules: string[];
  /**
   * The keys of the rest: they stay off.
   */
  readonly idle: string[];
  /**
   * HP/s it lands on the target, after falloff.
   */
  readonly hps: number;
  /**
   * The target's pressure (HP/s it takes).
   */
  readonly pressure: number;
  /**
   * HP/s of reps on the target before this choice: other logi of the pass, and reps the pass does not assign.
   */
  readonly reps: number;
  /**
   * The target's HP left over its max, every layer.
   */
  readonly fraction: number;
  /**
   * The target's HP left on this layer.
   */
  readonly layerFraction: number;
  readonly hpLeft: number;
  /**
   * Metres to the target.
   */
  readonly distance: Maybe<number>;
  /**
   * How far its reps reach a new target: optimal + REPAIR_SELECTION_FALLOFFS falloffs, capped by its lock range.
   */
  readonly reach: number;
  /**
   * For out-of-range: the members needing reps beyond it, the most pressed first.
   */
  readonly unreachable?: RepairUnreachable[];
}

export interface RepairPlan {
  readonly logi: string;
  /**
   * One per layer it carries remote repairers for, in DEFENSE_LAYERS order.
   */
  readonly choices: RepairChoice[];
  /**
   * Members to lock ahead of need.
   */
  readonly preLocks: string[];
}

export interface ChooseRepairTargetsInput {
  readonly candidates: readonly RepairCandidate[];
  /**
   * In fleet order: earlier logi choose first.
   */
  readonly logi: readonly RepairLogi[];
}

type Tier = 1 | 2 | 3;

const TIER_REASONS: Readonly<Record<Tier, RepairReason>> = { 1: 'under-fire', 2: 'covering', 3: 'topping-off' };

interface CandidateFacts {
  readonly candidate: RepairCandidate;
  readonly pressure: number;
  readonly underFire: boolean;
  readonly hpLeft: number;
  readonly fraction: number;
}

interface Rated {
  readonly facts: CandidateFacts;
  readonly tier: Tier;
  readonly score: number;
  readonly distance: number;
}

/**
 * HP/s one repairer lands at a distance.
 *
 * @param module - The repairer.
 * @param distance - Surface distance, metres.
 * @returns HP/s after falloff; 0 beyond its reach.
 */
export function repairModuleHps(module: RepairModule, distance: number): number {
  const reaches = distance <= moduleReach(module);
  return reaches && module.cycleTime > 0 ? (module.amount * falloffEffectiveness({ distance, range: module.range, falloff: module.falloff })) / module.cycleTime : 0;
}

function layerFractionOf(candidate: RepairCandidate, layer: DefenseLayerName): number {
  const { hp, max } = candidate.layers[layer];
  return max > 0 ? hp / max : 1;
}

function isLayerFull(candidate: RepairCandidate, layer: DefenseLayerName): boolean {
  const { hp, max } = candidate.layers[layer];
  return hp >= max - REPAIR_FULL_HP;
}

function factsOf(candidate: RepairCandidate): CandidateFacts {
  let hpLeft = 0;
  let max = 0;
  for (const layer of DEFENSE_LAYERS) {
    hpLeft += candidate.layers[layer].hp;
    max += candidate.layers[layer].max;
  }
  return { candidate, pressure: candidate.taken / REPAIR_PRESSURE_SECONDS, underFire: candidate.taken > 0, hpLeft, fraction: max > 0 ? hpLeft / max : 1 };
}

interface RateInput {
  readonly facts: CandidateFacts;
  readonly layer: DefenseLayerName;
  readonly reps: number;
  readonly incumbent: boolean;
  readonly policy: AutoRepairPolicy;
}

/**
 * A candidate's tier and score for one logi layer, or null when it needs nothing from it.
 *
 * @param input - The candidate, the layer, the reps on it so far, whether it is the incumbent and the policy.
 * @returns Its tier and score (higher is more urgent).
 */
function rate(input: RateInput): Maybe<{ readonly tier: Tier; readonly score: number }> {
  const { facts, layer, reps, incumbent, policy } = input;
  const { candidate, pressure, underFire, hpLeft, fraction } = facts;
  const need = pressure * REPAIR_COVER_MARGIN - reps;
  let tier: Maybe<Tier> = null;
  if (underFire && need > 0) tier = 1;
  else if (underFire) tier = 2;
  else if (incumbent ? !isLayerFull(candidate, layer) : layerFractionOf(candidate, layer) < REPAIR_TOP_OFF_FRACTION) tier = 3;

  let result: Maybe<{ readonly tier: Tier; readonly score: number }> = null;
  if (tier === 3) result = { tier, score: 1 - layerFractionOf(candidate, layer) };
  else if (tier != null && policy === 'damaged') result = { tier, score: 1 - fraction };
  else if (tier != null && policy === 'shot-at') result = { tier, score: pressure };
  else if (tier != null) result = { tier, score: (tier === 1 ? need : pressure) / Math.max(1, hpLeft) };
  return result;
}

/**
 * Orders rated candidates, the most urgent first: the lower tier, the higher score, then the higher pressure, the lower
 * fraction and the id.
 *
 * @param a - One.
 * @param b - The other.
 * @returns The sort order.
 */
function compareRated(a: Rated, b: Rated): number {
  return a.tier - b.tier || b.score - a.score || b.facts.pressure - a.facts.pressure || a.facts.fraction - b.facts.fraction || compareIds(a.facts.candidate.id, b.facts.candidate.id);
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The reach of a set of repairers.
 *
 * @param modules - The repairers.
 * @param falloffs - Falloffs past optimal.
 * @returns The farthest, metres.
 */
function reachOf(modules: readonly RepairModule[], falloffs: number): number {
  let reach = 0;
  for (const module of modules) reach = Math.max(reach, module.range == null ? Number.POSITIVE_INFINITY : module.range + falloffs * Math.max(0, module.falloff ?? 0));
  return reach;
}

interface ChooseLayerInput {
  readonly logi: RepairLogi;
  readonly layer: DefenseLayerName;
  readonly modules: readonly RepairModule[];
  readonly facts: readonly CandidateFacts[];
  readonly reps: Map<string, number>;
}

function chooseLayer(input: ChooseLayerInput): RepairChoice {
  const { logi, layer, modules, facts, reps } = input;
  const reach = Math.min(logi.lockRange, reachOf(modules, REPAIR_SELECTION_FALLOFFS));
  const keepReach = Math.min(logi.lockRange, reachOf(modules, 2));
  const incumbentId = logi.current[layer];
  const eligible: Rated[] = [];
  const beyond: Rated[] = [];
  let incumbent: Maybe<Rated> = null;

  for (const candidateFacts of facts) {
    const { id } = candidateFacts.candidate;
    const distance = logi.distances.get(id);
    if (id === logi.id || distance == null) continue;
    const isIncumbent = id === incumbentId;
    const rating = rate({ facts: candidateFacts, layer, reps: reps.get(id) ?? 0, incumbent: isIncumbent, policy: logi.policy });
    if (!rating) continue;
    const rated: Rated = { facts: candidateFacts, ...rating, distance };
    if (distance <= (isIncumbent ? keepReach : reach)) {
      eligible.push(rated);
      if (isIncumbent) incumbent = rated;
    } else {
      beyond.push(rated);
    }
  }

  eligible.sort(compareRated);
  let chosen: Maybe<Rated> = eligible[0];
  const best = chosen;
  if (incumbent && best && best !== incumbent) {
    const switches = best.tier < incumbent.tier || (best.tier === incumbent.tier && best.score > incumbent.score && best.score >= incumbent.score * REPAIR_SWITCH_RATIO);
    if (!switches) chosen = incumbent;
  }

  const keys = modules.map((module) => module.key);
  let choice: RepairChoice;
  if (chosen) {
    const { facts: target, distance, tier } = chosen;
    const reaching = modules.filter((module) => distance <= moduleReach(module));
    const hps = reaching.reduce((sum, module) => sum + repairModuleHps(module, distance), 0);
    const before = reps.get(target.candidate.id) ?? 0;
    reps.set(target.candidate.id, before + hps);
    const used = new Set(reaching.map((module) => module.key));
    choice = {
      layer,
      target: target.candidate.id,
      reason: TIER_REASONS[tier],
      kept: chosen === incumbent,
      modules: keys.filter((key) => used.has(key)),
      idle: keys.filter((key) => !used.has(key)),
      hps,
      pressure: target.pressure,
      reps: before,
      fraction: target.fraction,
      layerFraction: layerFractionOf(target.candidate, layer),
      hpLeft: target.hpLeft,
      distance,
      reach
    };
  } else {
    const unreachable = beyond
      .sort((a, b) => b.facts.pressure - a.facts.pressure || a.distance - b.distance || compareIds(a.facts.candidate.id, b.facts.candidate.id))
      .slice(0, REPAIR_UNREACHABLE_ROWS)
      .map((rated) => ({ id: rated.facts.candidate.id, distance: rated.distance, pressure: rated.facts.pressure }));
    choice = {
      layer,
      target: null,
      reason: unreachable.length ? 'out-of-range' : 'idle',
      kept: false,
      modules: [],
      idle: keys,
      hps: 0,
      pressure: 0,
      reps: 0,
      fraction: 1,
      layerFraction: 1,
      hpLeft: 0,
      distance: null,
      reach,
      ...(unreachable.length ? { unreachable } : {})
    };
  }
  return choice;
}

function preLocksOf(logi: RepairLogi, facts: readonly CandidateFacts[], targets: ReadonlySet<string>): string[] {
  const rows = facts.filter((candidateFacts) => {
    const { id, hostileLocks } = candidateFacts.candidate;
    const distance = logi.distances.get(id);
    return id !== logi.id && !targets.has(id) && distance != null && distance <= logi.lockRange && (candidateFacts.underFire || hostileLocks > 0);
  });
  const rank = (candidateFacts: CandidateFacts): number => (logi.locks.has(candidateFacts.candidate.id) ? 0 : 2) + (candidateFacts.underFire ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || b.pressure - a.pressure || b.candidate.hostileLocks - a.candidate.hostileLocks || compareIds(a.candidate.id, b.candidate.id));
  return rows.slice(0, REPAIR_PRE_LOCKS).map((candidateFacts) => candidateFacts.candidate.id);
}

/**
 * Chooses every logi's repair targets for one fleet: per layer, layers in DEFENSE_LAYERS order and logi in the given
 * order, each seeing the reps the logi before it assigned. Deterministic: candidate order does not matter.
 *
 * @param input - The fleet's candidates and its logi.
 * @returns One plan per logi that carries remote repairers, in the given order.
 */
export function chooseRepairTargets(input: ChooseRepairTargetsInput): RepairPlan[] {
  const facts = input.candidates.map(factsOf).sort((a, b) => compareIds(a.candidate.id, b.candidate.id));
  const reps = new Map<string, number>(facts.map((candidateFacts) => [candidateFacts.candidate.id, candidateFacts.candidate.otherReps]));
  const choices = new Map<string, RepairChoice[]>(input.logi.map((logi) => [logi.id, []]));

  for (const layer of DEFENSE_LAYERS) {
    for (const logi of input.logi) {
      const modules = logi.modules.filter((module) => module.layer === layer);
      if (modules.length) choices.get(logi.id)?.push(chooseLayer({ logi, layer, modules, facts, reps }));
    }
  }

  return input.logi
    .filter((logi) => logi.modules.length)
    .map((logi) => {
      const logiChoices = choices.get(logi.id) ?? [];
      const targets = new Set(logiChoices.map((choice) => choice.target).filter((target): target is string => target != null));
      return { logi: logi.id, choices: logiChoices, preLocks: preLocksOf(logi, facts, targets) };
    });
}

function hpsText(value: number): string {
  return value.toFixed(1);
}

function kmText(metres: number): string {
  return Number.isFinite(metres) ? `${(metres / 1000).toFixed(1)} km` : 'any range';
}

function percentText(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/**
 * Why a logi repairs what it repairs, as get_state's `why`.
 *
 * @param choice - Its choice for one layer.
 * @param policy - Its policy.
 * @returns E.g. `"b1" is under fire: 103.3 HP/s against 0.0 HP/s of reps, about 15 s to live`.
 */
export function repairChoiceWhy(choice: RepairChoice, policy: AutoRepairPolicy): string {
  const { target, reason } = choice;
  let why: string;
  if (target != null && reason === 'under-fire') {
    const net = choice.pressure - choice.reps;
    const life = net > 0 ? `, about ${Math.round(choice.hpLeft / net)} s to live` : `, short of ${Math.round(REPAIR_COVER_MARGIN * 100)} % cover`;
    const extra = policy === 'damaged' ? `, ${percentText(choice.fraction)} of its HP left` : '';
    why = `"${target}" is under fire: ${hpsText(choice.pressure)} HP/s against ${hpsText(choice.reps)} HP/s of reps${policy === 'shot-at' ? '' : life}${extra}`;
  } else if (target != null && reason === 'covering') {
    why = `"${target}" is under fire and covered (${hpsText(choice.reps + choice.hps)} of ${hpsText(choice.pressure)} HP/s); no member needs it more`;
  } else if (target != null) {
    why = `"${target}" is calm with ${choice.layer} at ${percentText(choice.layerFraction)}`;
  } else if (reason === 'out-of-range' && choice.unreachable?.length) {
    const [first] = choice.unreachable;
    why = `"${first.id}" ${first.pressure > 0 ? 'is under fire' : 'needs reps'} ${kmText(first.distance)} off; its reps reach ${kmText(choice.reach)}`;
  } else {
    why = 'no fleet member in reach needs reps';
  }
  return choice.kept ? `${why} (kept: it still needs reps)` : why;
}
