/**
 * The distributions set_hp draws from: each maps one uniform roll `u` in [0, 1) into a range through its inverse CDF
 * (its quantile), so one keyed roll per ship and layer gives a draw that replays. Pure.
 */

/**
 * The distributions a random HP value draws from.
 */
export const HP_DISTRIBUTIONS = ['uniform', 'normal', 'triangular'] as const;

export type HpDistribution = (typeof HP_DISTRIBUTIONS)[number];

export const DEFAULT_HP_DISTRIBUTION: HpDistribution = 'uniform';

/**
 * A normal's default standard deviation is the range over this many: ±2 sd span it.
 */
export const DEFAULT_NORMAL_SD_SPANS = 4;

/**
 * A range to draw in, in one unit (HP once resolved for a ship).
 */
export interface DistributionRange {
  readonly min: number;
  readonly max: number;
  /**
   * The normal's mean; default the middle.
   */
  readonly mean?: number;
  /**
   * The normal's standard deviation; default the range over DEFAULT_NORMAL_SD_SPANS.
   */
  readonly sd?: number;
  /**
   * The triangular's mode; default the middle.
   */
  readonly mode?: number;
}

function clampInto(value: number, range: DistributionRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * The uniform quantile: `min + u (max − min)`.
 *
 * @param u - The roll in [0, 1).
 * @param range - The range.
 * @returns The value.
 */
export function uniformQuantile(u: number, range: DistributionRange): number {
  return range.min + u * (range.max - range.min);
}

/**
 * The triangular quantile (min a, max b, mode c): `a + √(u (b − a)(c − a))` below `(c − a)/(b − a)`, else
 * `b − √((1 − u)(b − a)(b − c))`.
 *
 * @param u - The roll in [0, 1).
 * @param range - The range; `mode` defaults to the middle.
 * @returns The value.
 */
export function triangularQuantile(u: number, range: DistributionRange): number {
  const { min, max } = range;
  const width = max - min;
  let result = min;
  if (width > 0) {
    const mode = clampInto(range.mode ?? (min + max) / 2, range);
    result = u < (mode - min) / width ? min + Math.sqrt(u * width * (mode - min)) : max - Math.sqrt((1 - u) * width * (max - mode));
  }
  return result;
}

/**
 * The complementary error function (Numerical Recipes' Chebyshev fit, fractional error under 1.2e-7 everywhere, so the
 * tails keep their relative accuracy).
 *
 * @param x - The argument.
 * @returns erfc(x).
 */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const tail = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? tail : 2 - tail;
}

/**
 * The standard normal CDF Φ.
 *
 * @param x - The argument.
 * @returns Φ(x).
 */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const ACKLAM_LOW = 0.02425;

function acklamTail(q: number): number {
  const [c0, c1, c2, c3, c4, c5] = ACKLAM_C;
  const [d0, d1, d2, d3] = ACKLAM_D;
  return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
}

/**
 * The standard normal quantile Φ⁻¹ (Acklam's rational approximation, relative error under 1.2e-9).
 *
 * @param p - The probability.
 * @returns Φ⁻¹(p); −∞ at 0 and +∞ at 1.
 */
export function normalQuantile(p: number): number {
  let result: number;
  if (p <= 0) {
    result = Number.NEGATIVE_INFINITY;
  } else if (p >= 1) {
    result = Number.POSITIVE_INFINITY;
  } else if (p < ACKLAM_LOW) {
    result = acklamTail(Math.sqrt(-2 * Math.log(p)));
  } else if (p > 1 - ACKLAM_LOW) {
    result = -acklamTail(Math.sqrt(-2 * Math.log(1 - p)));
  } else {
    const [a0, a1, a2, a3, a4, a5] = ACKLAM_A;
    const [b0, b1, b2, b3, b4] = ACKLAM_B;
    const q = p - 0.5;
    const r = q * q;
    result = ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) / (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
  }
  return result;
}

/**
 * The normal truncated to the range, by its inverse CDF: `μ + σ Φ⁻¹(Φ(α) + u (Φ(β) − Φ(α)))`, α and β the bounds in
 * sd from the mean. Every draw keeps the normal's shape inside the range; none piles onto a bound as clamping would. A
 * range wholly above the mean is drawn mirrored, so its upper tail keeps its precision.
 *
 * @param u - The roll in [0, 1).
 * @param range - The range; `mean` defaults to the middle, `sd` to the range over DEFAULT_NORMAL_SD_SPANS.
 * @returns The value.
 */
export function truncatedNormalQuantile(u: number, range: DistributionRange): number {
  const { min, max } = range;
  const mean = range.mean ?? (min + max) / 2;
  const sd = range.sd ?? (max - min) / DEFAULT_NORMAL_SD_SPANS;
  let result = mean;
  if (max > min && sd > 0) {
    const alpha = (min - mean) / sd;
    const beta = (max - mean) / sd;
    if (alpha > 0) {
      const low = normalCdf(-beta);
      result = mean - sd * normalQuantile(low + (1 - u) * (normalCdf(-alpha) - low));
    } else {
      const low = normalCdf(alpha);
      result = mean + sd * normalQuantile(low + u * (normalCdf(beta) - low));
    }
  }
  return clampInto(result, range);
}

/**
 * A draw from a distribution, clamped into [min, max] (float safety: every quantile already lands inside).
 *
 * @param distribution - The distribution.
 * @param u - The roll in [0, 1).
 * @param range - The range.
 * @returns The value.
 */
export function distributionQuantile(distribution: HpDistribution, u: number, range: DistributionRange): number {
  let value: number;
  switch (distribution) {
    case 'normal':
      value = truncatedNormalQuantile(u, range);
      break;
    case 'triangular':
      value = triangularQuantile(u, range);
      break;
    default:
      value = uniformQuantile(u, range);
  }
  return clampInto(value, range);
}
