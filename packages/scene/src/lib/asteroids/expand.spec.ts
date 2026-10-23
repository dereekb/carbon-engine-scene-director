import { describe, expect, it } from 'vitest';
import { BLUE_ICE_ROCKS, DARK_OCHRE_ROCKS, VELDSPAR_ROCKS } from './asteroids.spec-helper';
import { asteroidFieldGeometry, asteroidSizeThresholds, expandAsteroidField, ROCK_GAP } from './expand';
import { normalizeAsteroidFields, type SceneAsteroidField } from './field';

function field(input: Record<string, unknown>): SceneAsteroidField {
  const { fields, problems } = normalizeAsteroidFields({ input: [{ id: 'f', ores: [{ rocks: VELDSPAR_ROCKS }, { rocks: DARK_OCHRE_ROCKS }], ...input }], takenIds: new Set() });
  expect(problems).toEqual([]);
  return (fields as SceneAsteroidField[])[0];
}

function radial(position: readonly number[]): number {
  return Math.hypot(position[0], position[2]);
}

describe('expandAsteroidField', () => {
  it('is deterministic', () => {
    const a = expandAsteroidField(field({ seed: 42, count: 300 }));
    const b = expandAsteroidField(field({ seed: 42, count: 300 }));
    expect(a.digest).toBe(b.digest);
    expect(a.rocks).toEqual(b.rocks);
    expect(a.digest).toMatch(/^[0-9a-f]{14}$/u);
    expect(expandAsteroidField(field({ seed: 43, count: 300 })).digest).not.toBe(a.digest);
  });

  it('keeps the first rocks when count rises', () => {
    const small = expandAsteroidField(field({ seed: 5, count: 150 }));
    const large = expandAsteroidField(field({ seed: 5, count: 200 }));
    expect(small.placed).toBe(150);
    expect(large.rocks.slice(0, 150)).toEqual(small.rocks);
  });

  it('keeps each rock ore, size, model and spin across a shape edit', () => {
    const sphere = expandAsteroidField(field({ seed: 9, count: 100 }));
    const ring = expandAsteroidField(field({ seed: 9, count: 100, shape: 'ring', radius: 40000 }));
    const strip = (rocks: typeof sphere.rocks): unknown[] => rocks.map(({ index, ore, dna, size, rotation }) => ({ index, ore, dna, size, rotation }));
    expect(strip(ring.rocks)).toEqual(strip(sphere.rocks));
    expect(ring.rocks[0].position).not.toEqual(sphere.rocks[0].position);
  });

  it('places every rock inside its shape', () => {
    const shell = expandAsteroidField(field({ count: 400, innerRadius: 12000 }));
    for (const rock of shell.rocks) {
      const distance = Math.hypot(...rock.position);
      expect(distance).toBeGreaterThanOrEqual(12000 - 0.01);
      expect(distance).toBeLessThanOrEqual(20000 + 0.01);
    }
    for (const shape of ['disc', 'ring'] as const) {
      const flat = expandAsteroidField(field({ count: 400, shape, radius: 40000, arc: 120, size: [100, 800] }));
      const geometry = asteroidFieldGeometry(flat.geometry);
      expect(flat.placed).toBeGreaterThan(390);
      for (const rock of flat.rocks) {
        expect(radial(rock.position)).toBeGreaterThanOrEqual(geometry.innerRadius - 0.01);
        expect(radial(rock.position)).toBeLessThanOrEqual(40000 + 0.01);
        expect(Math.abs(rock.position[1])).toBeLessThanOrEqual(geometry.thickness / 2 + 0.01);
        expect(Math.abs((Math.atan2(rock.position[0], rock.position[2]) * 180) / Math.PI)).toBeLessThanOrEqual(60 + 0.01);
      }
    }
    expect(asteroidFieldGeometry({ shape: 'ring', radius: 30000 })).toEqual({ shape: 'ring', radius: 30000, innerRadius: 18000, thickness: 5000, arc: 360 });
    expect(asteroidFieldGeometry({ shape: 'disc', radius: 30000 })).toEqual({ shape: 'disc', radius: 30000, innerRadius: 0, thickness: 7500, arc: 360 });
  });

  it('never overlaps two rocks', () => {
    const { rocks } = expandAsteroidField(field({ count: 500 }));
    for (let i = 0; i < rocks.length; i++) {
      for (let j = i + 1; j < rocks.length; j++) {
        const [a, b] = [rocks[i], rocks[j]];
        expect(Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2])).toBeGreaterThanOrEqual((a.radius + b.radius) * ROCK_GAP - 0.01);
      }
    }
  });

  it('keeps radii in size, buckets them by the log-thirds, and makes every rock medium when min = max', () => {
    const expansion = expandAsteroidField(field({ count: 600, size: [100, 2700] }));
    const [t1, t2] = asteroidSizeThresholds([100, 2700]);
    expect(t1).toBeCloseTo(300, 6);
    expect(t2).toBeCloseTo(900, 6);
    for (const rock of expansion.rocks) {
      expect(rock.radius).toBeGreaterThanOrEqual(100);
      expect(rock.radius).toBeLessThanOrEqual(2700);
      expect(rock.size).toBe(rock.radius < t1 ? 'small' : rock.radius < t2 ? 'medium' : 'large');
      expect([...VELDSPAR_ROCKS[rock.size], ...DARK_OCHRE_ROCKS[rock.size]]).toContain(rock.dna);
      expect(Math.hypot(...rock.rotation)).toBeCloseTo(1, 5);
    }
    expect(Object.values(expansion.counts.bySize).every((count) => count > 100)).toBe(true);
    const single = expandAsteroidField(field({ count: 50, size: [500, 500] }));
    expect(single.counts.bySize).toEqual({ small: 0, medium: 50, large: 0 });
  });

  it('respects ore weights', () => {
    const { counts } = expandAsteroidField(field({ count: 2000, radius: 200000, ores: [{ rocks: VELDSPAR_ROCKS, weight: 3 }, { rocks: BLUE_ICE_ROCKS }] }));
    expect(counts.placed).toBe(2000);
    expect(counts.byOre[0] / 2000).toBeGreaterThan(0.7);
    expect(counts.byOre[0] / 2000).toBeLessThan(0.8);
    expect(counts.models).toBe(24);
  });

  it('drops rocks that do not fit', () => {
    const dense = expandAsteroidField(field({ radius: 5000, size: [1000, 1200], count: 200 }));
    expect(dense.placed).toBeLessThan(dense.requested);
    expect(dense.placed).toBeGreaterThan(0);
    expect(dense.envelope).toBeLessThanOrEqual(5000 + 1200 + 0.01);
  });

  it('expands 2,000 rocks quickly', () => {
    const start = performance.now();
    const expansion = expandAsteroidField(field({ count: 2000, radius: 100000 }));
    expect(expansion.placed).toBe(2000);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('pins the digest of a small fixed field', () => {
    const expansion = expandAsteroidField(field({ id: 'pinned', seed: 1234, count: 20, radius: 10000, size: [100, 1000], shape: 'disc', ores: [{ rocks: VELDSPAR_ROCKS }] }));
    expect(expansion.placed).toBe(20);
    expect(expansion.rocks[0]).toEqual(PINNED_FIRST_ROCK);
    expect(expansion.digest).toBe(PINNED_DIGEST);
  });
});

/**
 * Pinned 2026-10-23: an accidental change to the draw order, the hashes or the rounding shows here.
 */
const PINNED_DIGEST = '194c9520b812e0';
const PINNED_FIRST_ROCK = { index: 0, ore: 0, dna: 'rock_01_m_v2a_whiteyellow:ore_veldspar:asteroid', size: 'medium', radius: 312.954, position: [3814.201, -747.988, -7724.491], rotation: [-0.107506, 0.128474, -0.457162, -0.873464] };
