import type { Maybe } from '@dereekb/util';
import { describeMetres } from '../personalities/targeting';
import { candidateRangesOf, envelopePointOf, type EnvelopeInput, type EnvelopePoint, type PilotPosture } from './envelope';
import { canRunPropModOf, maxSpeedOf, tackleRangeOf } from './profile';
import type { IdealStanceType, ShipStancePropMods } from './stance';

/**
 * The ideal range: the range, posture and prop mod state that score best against the focus, kill rate − risk × death
 * rate, under the stance's hard constraints; the window of near-best ranges around it (the pilot acts only when it
 * leaves it); and who dictates range (a faster focus that wants another range holds it there).
 */

/**
 * How much a stance weighs its own death against the kill: score = kill rate − risk × death rate. Support weighs only
 * its safety.
 */
export const STANCE_RISK: Readonly<Record<IdealStanceType | 'auto', number>> = { kite: 3, snipe: 3, auto: 2, tackle: 2, brawl: 0.75, support: 1 };

/**
 * The window holds the contiguous ranges around the best that score within this share of it.
 */
export const IDEAL_WINDOW_SHARE = 0.1;

/**
 * Scores within this share of the best tie: kite and snipe take the farthest of them, the others the nearest, and a
 * run of tied ranges is held at its middle.
 */
export const IDEAL_TIE_SHARE = 0.01;

/**
 * A tackler holds its focus inside this share of its point (or scram) range.
 */
export const TACKLE_HOLD_SHARE = 0.9;

/**
 * The postures each stance type may hold.
 */
export const STANCE_POSTURES: Readonly<Record<IdealStanceType, readonly PilotPosture[]>> = {
  kite: ['orbit', 'keep-at-range'],
  brawl: ['orbit', 'keep-at-range'],
  tackle: ['orbit', 'keep-at-range'],
  snipe: ['keep-at-range'],
  support: ['keep-at-range']
};

/**
 * The order `auto` prefers among equal scores: the safer first.
 */
export const AUTO_STANCE_CHOICES: readonly IdealStanceType[] = ['snipe', 'kite', 'brawl'];

export interface IdealRangeInput extends EnvelopeInput {
  readonly type: IdealStanceType | 'auto';
  /**
   * `never` weighs the prop mod off only; `always` on only (when it can run); otherwise both.
   */
  readonly propMods?: ShipStancePropMods;
  /**
   * Whether a faster focus may dictate the range (default true; false when weighing the focus's own side).
   */
  readonly dictation?: boolean;
}

export interface IdealRange {
  /**
   * The stance type the range is for (`auto`'s pick).
   */
  readonly type: IdealStanceType;
  /**
   * The range to fly, surface to surface (m).
   */
  readonly ideal: number;
  /**
   * The near-best ranges around it (m).
   */
  readonly window: readonly [number, number];
  readonly posture: PilotPosture;
  readonly propMod: boolean;
  /**
   * What to order to fly the ideal range (an orbit's ordered range).
   */
  readonly ordered: number;
  readonly out: number;
  readonly in: number;
  readonly score: number;
  /**
   * Who sets the range: this ship when it is at least as fast as the focus (prop mods on, webs applied), else the
   * focus.
   */
  readonly dictates: 'self' | 'focus';
  /**
   * The focus dictates and holds another range: the ideal is its range.
   */
  readonly dictated: boolean;
  /**
   * The trade at the dictated range is lost: burn out.
   */
  readonly disengage: boolean;
  /**
   * No range met the stance's hard constraints; the least bad one is taken.
   */
  readonly constrained: boolean;
  readonly why: string;
}

interface ScoredPoint {
  readonly point: EnvelopePoint;
  readonly score: number;
  readonly allowed: boolean;
}

function scoreOf(point: EnvelopePoint, risk: number, type: IdealStanceType): number {
  return type === 'support' ? -point.deathRate : point.killRate - risk * point.deathRate;
}

/**
 * The focus's longest turret optimal: inside it its guns apply in full, so kite and snipe stay out of it.
 *
 * @param input - The envelope input.
 * @returns Metres; 0 for a focus without turrets.
 */
function focusTurretOptimalOf(input: EnvelopeInput): number {
  return input.focus.profile.weapons.reduce((optimal, weapon) => (weapon.kind !== 'missile' && weapon.dps > 0 ? Math.max(optimal, weapon.optimal) : optimal), 0);
}

function isAllowed(point: EnvelopePoint, type: IdealStanceType, input: EnvelopeInput): boolean {
  let allowed = true;
  if (type === 'kite' || type === 'snipe') allowed = point.tackledBy.length === 0 && point.range >= focusTurretOptimalOf(input);
  else if (type === 'support') allowed = point.tackledBy.length === 0;
  else if (type === 'tackle') {
    const hold = tackleRangeOf(input.self.profile.tackle);
    allowed = hold <= 0 || point.range <= TACKLE_HOLD_SHARE * hold;
  }
  return allowed;
}

function propModStatesOf(input: IdealRangeInput): boolean[] {
  const canRun = canRunPropModOf(input.self.profile, input.self.scrammed);
  let states: boolean[];
  if (!canRun || input.propMods === 'never') states = [false];
  else if (input.propMods === 'always') states = [true];
  else states = [false, true];
  return states;
}

function scorePointsOf(input: IdealRangeInput, type: IdealStanceType, ranges: readonly number[]): ScoredPoint[] {
  const risk = STANCE_RISK[type];
  const scored: ScoredPoint[] = [];
  for (const range of ranges) {
    for (const posture of STANCE_POSTURES[type]) {
      for (const propMod of propModStatesOf(input)) {
        const point = envelopePointOf({ ...input, range, posture, propMod });
        if (point) scored.push({ point, score: scoreOf(point, risk, type), allowed: isAllowed(point, type, input) });
      }
    }
  }
  return scored;
}

/**
 * The best-scoring point at each range.
 *
 * @param points - Scored points.
 * @returns By range.
 */
function bestByRangeOf(points: readonly ScoredPoint[]): Map<number, ScoredPoint> {
  const byRange = new Map<number, ScoredPoint>();
  for (const point of points) {
    const held = byRange.get(point.point.range);
    if (!held || point.score > held.score) byRange.set(point.point.range, point);
  }
  return byRange;
}

/**
 * The contiguous run of candidate ranges around one whose best score stays at or above a threshold.
 *
 * @param byRange - The best point at each range.
 * @param ranges - The candidate ranges, ascending.
 * @param index - The index to grow from.
 * @param threshold - The lowest score kept.
 * @returns The run's first and last index.
 */
function runAround(byRange: ReadonlyMap<number, ScoredPoint>, ranges: readonly number[], index: number, threshold: number): [number, number] {
  const scoreAt = (at: number) => byRange.get(ranges[at])?.score ?? Number.NEGATIVE_INFINITY;
  let [low, high] = [index, index];
  while (low > 0 && scoreAt(low - 1) >= threshold) low--;
  while (high < ranges.length - 1 && scoreAt(high + 1) >= threshold) high++;
  return [low, high];
}

/**
 * The best point: the top score; among scores within IDEAL_TIE_SHARE of it, the farthest range for kite and snipe
 * and the nearest for the others; then the middle of the tied run around it (a plateau of equal scores is held at
 * its middle, not its edge).
 *
 * @param points - Scored points.
 * @param ranges - The candidate ranges, ascending.
 * @param type - The stance type.
 * @returns The best point; null without points.
 */
function bestOf(points: readonly ScoredPoint[], ranges: readonly number[], type: IdealStanceType): Maybe<ScoredPoint> {
  const byRange = bestByRangeOf(points);
  const top = Math.max(...[...byRange.values()].map((point) => point.score));
  const tie = top - IDEAL_TIE_SHARE * Math.abs(top) - Number.EPSILON;
  const tied = ranges.filter((range) => (byRange.get(range)?.score ?? Number.NEGATIVE_INFINITY) >= tie);
  let best: Maybe<ScoredPoint> = null;
  if (tied.length) {
    const pick = type === 'kite' || type === 'snipe' ? tied[tied.length - 1] : tied[0];
    const [low, high] = runAround(byRange, ranges, ranges.indexOf(pick), tie);
    const middle = (ranges[low] + ranges[high]) / 2;
    let closest = low;
    for (let index = low; index <= high; index++) if (Math.abs(ranges[index] - middle) < Math.abs(ranges[closest] - middle)) closest = index;
    best = byRange.get(ranges[closest]) ?? null;
  }
  return best;
}

/**
 * The window: the contiguous candidate ranges around the best whose best score stays within IDEAL_WINDOW_SHARE of it.
 *
 * @param points - The scored points the best was taken from.
 * @param best - The best.
 * @param ranges - The candidate ranges, ascending.
 * @returns [min, max] metres.
 */
function windowOf(points: readonly ScoredPoint[], best: ScoredPoint, ranges: readonly number[]): [number, number] {
  const top = Math.max(...points.map((point) => point.score));
  const [low, high] = runAround(bestByRangeOf(points), ranges, ranges.indexOf(best.point.range), top - IDEAL_WINDOW_SHARE * Math.abs(top) - Number.EPSILON);
  return [ranges[low], ranges[high]];
}

function describePoint(point: EnvelopePoint): string {
  return `${point.posture} at ${describeMetres(point.range)}${point.propMod ? ', prop mod on' : ''}: out ${Math.round(point.out)} / in ${Math.round(point.in)} dps`;
}

/**
 * One stance type's ideal, without dictation.
 *
 * @param input - The pilot, its focus, the hostiles and the stance.
 * @param type - The stance type.
 * @param ranges - The candidate ranges.
 * @returns The ideal; null when no range can be held.
 */
function idealOfType(input: IdealRangeInput, type: IdealStanceType, ranges: readonly number[]): Maybe<IdealRange> {
  const scored = scorePointsOf(input, type, ranges);
  const allowed = scored.filter((point) => point.allowed);
  const constrained = allowed.length === 0;
  const pool = constrained ? scored : allowed;
  const best = bestOf(pool, ranges, type);
  let ideal: Maybe<IdealRange> = null;
  if (best) {
    const { point, score } = best;
    ideal = {
      type,
      ideal: point.range,
      window: windowOf(pool, best, ranges),
      posture: point.posture,
      propMod: point.propMod,
      ordered: point.ordered,
      out: point.out,
      in: point.in,
      score,
      dictates: 'self',
      dictated: false,
      disengage: false,
      constrained,
      why: `${type}: ${describePoint(point)}${constrained ? ' (no range keeps the stance; least bad)' : ''}`
    };
  }
  return ideal;
}

/**
 * The ideal range against the focus for a stance type (`auto` weighs snipe, kite and brawl by kill rate −
 * STANCE_RISK.auto × death rate at each one's ideal and takes the best, the first of them on a tie within
 * IDEAL_TIE_SHARE). When the focus is faster (prop mods on,
 * webs applied) and its own best range lies outside the window, it dictates: the pilot takes the posture that suffers
 * least at that range, and disengages when the trade there is lost.
 *
 * @param input - The pilot, its focus, the hostiles, the stance type and prop mod rule.
 * @returns The ideal; null when no range can be held (no candidate ranges).
 */
export function idealRangeOf(input: IdealRangeInput): Maybe<IdealRange> {
  const ranges = candidateRangesOf(input);
  let ideal: Maybe<IdealRange> = null;
  if (input.type === 'auto') {
    let bestScore = Number.NEGATIVE_INFINITY;
    const notes: string[] = [];
    for (const type of AUTO_STANCE_CHOICES) {
      const candidate = idealOfType(input, type, ranges);
      if (candidate) {
        const kill = candidate.out / Math.max(1, input.focus.remaining);
        const death = Math.max(0, candidate.in - (input.incomingReps ?? 0)) / Math.max(1, input.self.remaining);
        const score = kill - STANCE_RISK.auto * death;
        notes.push(`${type} ${score.toExponential(2)}`);
        if (!candidate.constrained && (ideal == null || score > bestScore + IDEAL_TIE_SHARE * Math.abs(bestScore))) {
          bestScore = score;
          ideal = candidate;
        }
      }
    }
    ideal ??= idealOfType(input, 'brawl', ranges);
    if (ideal) ideal = { ...ideal, why: `auto picks ${ideal.type} (${notes.join(', ')}); ${ideal.why}` };
  } else ideal = idealOfType(input, input.type, ranges);
  if (ideal && input.dictation !== false && ideal.type !== 'support') ideal = dictatedIdealOf(input, ideal);
  return ideal;
}

/**
 * Applies dictation: a faster focus that wants a range outside the window holds it there.
 *
 * @param input - The pilot's input.
 * @param ideal - Its own ideal.
 * @returns The ideal, dictated when the focus is faster and wants elsewhere.
 */
function dictatedIdealOf(input: IdealRangeInput, ideal: IdealRange): IdealRange {
  const { self, focus } = input;
  const selfMax = maxSpeedOf(self.profile, self.scrammed, self.webFactor ?? 1);
  const focusMax = maxSpeedOf(focus.profile, focus.scrammed, focus.webFactor ?? 1);
  let result: IdealRange = { ...ideal, dictates: focusMax > selfMax ? 'focus' : 'self' };
  if (focusMax > selfMax) {
    const theirs = idealRangeOf({ self: focus, focus: self, hostiles: [self], type: 'auto', dictation: false });
    if (theirs && (theirs.ideal < ideal.window[0] || theirs.ideal > ideal.window[1])) {
      const range = theirs.ideal;
      const scored = scorePointsOf(input, ideal.type, [range]);
      const best = bestOf(scored, [range], ideal.type);
      if (best) {
        const { point, score } = best;
        result = {
          ...result,
          ideal: range,
          window: theirs.window,
          posture: point.posture,
          propMod: point.propMod,
          ordered: point.ordered,
          out: point.out,
          in: point.in,
          score,
          dictated: true,
          disengage: score < 0,
          why: `${focus.id} is faster (${Math.round(focusMax)} vs ${Math.round(selfMax)} m/s) and holds ${describeMetres(range)}: ${describePoint(point)}${score < 0 ? '; the trade is lost' : ''}`
        };
      }
    }
  }
  return result;
}
