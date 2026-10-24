import { describe, expect, it } from 'vitest';
import { distributionQuantile, type HpDistribution, normalCdf, normalQuantile, triangularQuantile, truncatedNormalQuantile, uniformQuantile } from './distributions';
import { hpSetRoll } from './hp-set';

describe('uniformQuantile', () => {
  it('is linear between the ends', () => {
    expect(uniformQuantile(0, { min: 10, max: 90 })).toBe(10);
    expect(uniformQuantile(0.5, { min: 10, max: 90 })).toBe(50);
    expect(uniformQuantile(0.25, { min: 10, max: 90 })).toBe(30);
    expect(uniformQuantile(0.999999, { min: 10, max: 90 })).toBeCloseTo(90, 3);
  });
});

describe('triangularQuantile', () => {
  it('runs from min to max through the mode', () => {
    const range = { min: 0, max: 100, mode: 80 };
    expect(triangularQuantile(0, range)).toBe(0);
    expect(triangularQuantile(1 - 1e-12, range)).toBeCloseTo(100, 3);
    expect(triangularQuantile(0.8, range)).toBeCloseTo(80, 10);
    expect(triangularQuantile(0.5, { min: 0, max: 100 })).toBeCloseTo(50, 10);
  });

  it('takes a mode at either end without dividing by zero', () => {
    for (const u of [0, 0.3, 0.7, 0.999]) {
      const low = triangularQuantile(u, { min: 0, max: 10, mode: 0 });
      const high = triangularQuantile(u, { min: 0, max: 10, mode: 10 });
      expect(Number.isFinite(low) && low >= 0 && low <= 10).toBe(true);
      expect(Number.isFinite(high) && high >= 0 && high <= 10).toBe(true);
    }
    expect(triangularQuantile(0.4, { min: 5, max: 5 })).toBe(5);
  });
});

describe('normalCdf and normalQuantile', () => {
  it('match the table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(Math.abs(normalCdf(1.959964) - 0.975)).toBeLessThan(1e-6);
    expect(Math.abs(normalQuantile(0.975) - 1.959964)).toBeLessThan(1e-6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normalQuantile(1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('invert each other over [-6, 6]', () => {
    for (let x = -6; x <= 6; x += 0.25) expect(Math.abs(normalQuantile(normalCdf(x)) - x)).toBeLessThan(1e-5);
  });
});

describe('truncatedNormalQuantile', () => {
  it('gives the mean at u 0.5 on a symmetric range and stays inside', () => {
    expect(truncatedNormalQuantile(0.5, { min: 10, max: 90 })).toBeCloseTo(50, 6);
    for (let u = 0; u < 1; u += 0.01) {
      const value = truncatedNormalQuantile(u, { min: 10, max: 90, mean: 85, sd: 3 });
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(90);
    }
    expect(truncatedNormalQuantile(0.3, { min: 60, max: 90, mean: 60, sd: 1 })).toBeGreaterThan(60);
  });

  it('tends to uniform with a huge sd and stays at the mean with a tiny one', () => {
    expect(truncatedNormalQuantile(0.25, { min: 0, max: 100, sd: 1000 })).toBeCloseTo(25, 1);
    expect(truncatedNormalQuantile(0.1, { min: 0, max: 100, mean: 40, sd: 1e-6 })).toBeCloseTo(40, 4);
    expect(truncatedNormalQuantile(0.9, { min: 0, max: 100, mean: 40, sd: 1e-6 })).toBeCloseTo(40, 4);
  });
});

describe('100,000 keyed draws', () => {
  const COUNT = 100_000;

  function draw(distribution: HpDistribution, range: { min: number; max: number; mean?: number; sd?: number; mode?: number }): number[] {
    return Array.from({ length: COUNT }, (_, index) => distributionQuantile(distribution, hpSetRoll(1, `s${index}`, 'armor'), range));
  }

  function moments(values: readonly number[]): { mean: number; sd: number } {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return { mean, sd: Math.sqrt(variance) };
  }

  it('uniform 10–90: mean 50, every decile 10 %', () => {
    const values = draw('uniform', { min: 10, max: 90 });
    expect(Math.abs(moments(values).mean - 50)).toBeLessThan(0.3);
    const deciles = new Array<number>(10).fill(0);
    for (const value of values) deciles[Math.min(9, Math.floor((value - 10) / 8))] += 1;
    for (const decile of deciles) expect(Math.abs(decile / COUNT - 0.1)).toBeLessThan(0.005);
    expect(values.every((value) => value >= 10 && value <= 90)).toBe(true);
  });

  it('normal 10–90 at the defaults: mean 50, sd 17.59', () => {
    const values = draw('normal', { min: 10, max: 90 });
    const { mean, sd } = moments(values);
    expect(Math.abs(mean - 50)).toBeLessThan(0.2);
    expect(Math.abs(sd - 17.5925)).toBeLessThan(0.15);
    expect(values.every((value) => value >= 10 && value <= 90)).toBe(true);
  });

  it('normal 0–100 at mean 70, sd 25: mean 64.72, sd 20.41', () => {
    const values = draw('normal', { min: 0, max: 100, mean: 70, sd: 25 });
    const { mean, sd } = moments(values);
    expect(Math.abs(mean - 64.7225)).toBeLessThan(0.25);
    expect(Math.abs(sd - 20.4058)).toBeLessThan(0.2);
    expect(values.every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('triangular 0–100, mode 80: mean 60', () => {
    const values = draw('triangular', { min: 0, max: 100, mode: 80 });
    expect(Math.abs(moments(values).mean - 60)).toBeLessThan(0.3);
    expect(values.every((value) => value >= 0 && value <= 100)).toBe(true);
  });
});
