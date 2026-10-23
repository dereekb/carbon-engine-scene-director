import { combatHash } from '../combat/random';
import { unitHash } from '../fleets/orders';
import type { SceneVector } from '../scene';
import { type AsteroidRockSize, DISC_THICKNESS_RATIO, RING_INNER_RATIO, RING_THICKNESS_RATIO, type SceneAsteroidField } from './field';

/**
 * Two rocks keep at least their radii's sum times this apart.
 */
export const ROCK_GAP = 1.1;

/**
 * How many places a rock tries before it is dropped.
 */
export const MAX_PLACEMENT_TRIES = 16;

/**
 * Below this max / min ratio every rock is medium.
 */
const SINGLE_SIZE_RATIO = 1.0001;

const SEED_RANGE = 2 ** 32;

/**
 * A field's resolved shape: its defaults filled in.
 */
export interface AsteroidFieldGeometry {
  readonly shape: SceneAsteroidField['shape'];
  readonly radius: number;
  readonly innerRadius: number;
  /**
   * Disc and ring only (0 for a sphere).
   */
  readonly thickness: number;
  /**
   * Degrees (360 for a sphere).
   */
  readonly arc: number;
}

/**
 * One placed rock.
 */
export interface AsteroidFieldRock {
  /**
   * Its draw index k: the same k keeps the same ore, size, model and spin whatever the shape.
   */
  readonly index: number;
  /**
   * The index into the field's ores.
   */
  readonly ore: number;
  readonly dna: string;
  readonly size: AsteroidRockSize;
  /**
   * Metres: the instance scale (rock models are unit-sized).
   */
  readonly radius: number;
  /**
   * Field-local metres, before the field's rotation.
   */
  readonly position: SceneVector;
  /**
   * A unit quaternion `[x, y, z, w]`.
   */
  readonly rotation: readonly [number, number, number, number];
}

export interface AsteroidFieldCounts {
  readonly requested: number;
  readonly placed: number;
  readonly bySize: Readonly<Record<AsteroidRockSize, number>>;
  /**
   * Placed rocks per ore, in the field's ore order.
   */
  readonly byOre: readonly number[];
  /**
   * Distinct DNAs among the placed rocks.
   */
  readonly models: number;
}

export interface AsteroidFieldExpansion {
  readonly rocks: readonly AsteroidFieldRock[];
  readonly requested: number;
  readonly placed: number;
  /**
   * The radius around the field centre every placed rock fits in, metres (0 with none).
   */
  readonly envelope: number;
  /**
   * The rock radii where small turns medium and medium turns large.
   */
  readonly thresholds: readonly [number, number];
  readonly geometry: AsteroidFieldGeometry;
  /**
   * A hash of the placed rocks (14 hex digits): the hub and the page report it to prove they expanded the same rocks.
   */
  readonly digest: string;
  readonly counts: AsteroidFieldCounts;
}

/**
 * A field's shape with its defaults filled in: a ring's hole RING_INNER_RATIO of its radius, a disc's thickness
 * DISC_THICKNESS_RATIO and a ring's RING_THICKNESS_RATIO, a full circle.
 *
 * @param field - The field.
 * @returns The geometry.
 */
export function asteroidFieldGeometry(field: Pick<SceneAsteroidField, 'shape' | 'radius' | 'innerRadius' | 'thickness' | 'arc'>): AsteroidFieldGeometry {
  const { shape, radius } = field;
  const flat = shape !== 'sphere';
  return {
    shape,
    radius,
    innerRadius: field.innerRadius ?? (shape === 'ring' ? RING_INNER_RATIO * radius : 0),
    thickness: flat ? (field.thickness ?? radius * (shape === 'disc' ? DISC_THICKNESS_RATIO : RING_THICKNESS_RATIO)) : 0,
    arc: flat ? (field.arc ?? 360) : 360
  };
}

/**
 * The rock radii splitting a size range into small, medium and large: its log-thirds.
 *
 * @param size - `[min, max]` rock radii.
 * @returns `[t1, t2]`: under t1 is small, under t2 medium, else large. `[0, Infinity]` when min and max are (nearly)
 *   equal, which makes every rock medium.
 */
export function asteroidSizeThresholds(size: readonly [number, number]): [number, number] {
  const [min, max] = size;
  const ratio = max / min;
  return ratio < SINGLE_SIZE_RATIO ? [0, Infinity] : [min * ratio ** (1 / 3), min * ratio ** (2 / 3)];
}

/**
 * Turns a field into its rocks, deterministically. Each rock k draws from its own stream (mulberry32 seeded by
 * `unitHash("<seed>|<k>")`), in a fixed order: the ore (weighted), the radius (log-uniform in size), the spin (a
 * uniform quaternion), the model (from the ore's set for the radius's size), then up to MAX_PLACEMENT_TRIES places
 * in the shape. A place is accepted when no earlier rock is within the radii's sum times ROCK_GAP; a rock with no
 * place is dropped. So raising count keeps the first rocks, and a shape edit keeps each rock's ore, size, model and
 * spin. Pure: the hub and the page get the same rocks.
 *
 * @param field - A normalized field.
 * @returns The rocks and their summary.
 */
export function expandAsteroidField(field: SceneAsteroidField): AsteroidFieldExpansion {
  const geometry = asteroidFieldGeometry(field);
  const [min, max] = field.size;
  const ratio = max / min;
  const thresholds = asteroidSizeThresholds(field.size);
  const weights = field.ores.map((ore) => ore.weight ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const cell = 2 * max * ROCK_GAP;
  const grid = new Map<string, AsteroidFieldRock[]>();
  const rocks: AsteroidFieldRock[] = [];
  for (let k = 0; k < field.count; k++) {
    const random = mulberry32(Math.floor(unitHash(`${field.seed}|${k}`) * SEED_RANGE));
    const ore = pickWeighted(weights, random() * totalWeight);
    const radius = roundTo(min * ratio ** random(), 1e3);
    const rotation = uniformQuaternion(random(), random(), random());
    const size = sizeOf(radius, thresholds);
    const models = field.ores[ore]?.rocks[size] ?? [];
    const dna = models[Math.min(models.length - 1, Math.floor(random() * models.length))] ?? '';
    for (let attempt = 0; attempt < MAX_PLACEMENT_TRIES; attempt++) {
      const position = placeInShape(geometry, random);
      if (!fits(position, radius, grid, cell)) continue;
      const rock: AsteroidFieldRock = { index: k, ore, dna, size, radius, position, rotation };
      rocks.push(rock);
      const key = cellKey(position, cell);
      grid.set(key, [...(grid.get(key) ?? []), rock]);
      break;
    }
  }
  const bySize: Record<AsteroidRockSize, number> = { small: 0, medium: 0, large: 0 };
  const byOre = field.ores.map(() => 0);
  for (const rock of rocks) {
    bySize[rock.size] += 1;
    byOre[rock.ore] += 1;
  }
  const envelope = rocks.reduce((reach, rock) => Math.max(reach, Math.hypot(...rock.position) + rock.radius), 0);
  return {
    rocks,
    requested: field.count,
    placed: rocks.length,
    envelope: roundTo(envelope, 1e3),
    thresholds: [thresholds[0], thresholds[1]],
    geometry,
    digest: asteroidFieldDigest(rocks),
    counts: { requested: field.count, placed: rocks.length, bySize, byOre, models: new Set(rocks.map((rock) => rock.dna)).size }
  };
}

/**
 * A hash of placed rocks: cyrb53 over `dna|x|y|z|r|qx|qy|qz|qw` per rock, joined by `;`.
 *
 * @param rocks - The rocks.
 * @returns 14 hex digits.
 */
export function asteroidFieldDigest(rocks: readonly AsteroidFieldRock[]): string {
  const text = rocks.map((rock) => [rock.dna, ...rock.position, rock.radius, ...rock.rotation].join('|')).join(';');
  return combatHash(text).toString(16).padStart(14, '0');
}

/**
 * The size a rock radius draws its model from.
 *
 * @param radius - Metres.
 * @param thresholds - asteroidSizeThresholds of the field.
 * @returns The size.
 */
function sizeOf(radius: number, thresholds: readonly [number, number]): AsteroidRockSize {
  let size: AsteroidRockSize = 'large';
  if (thresholds[0] === 0) size = 'medium';
  else if (radius < thresholds[0]) size = 'small';
  else if (radius < thresholds[1]) size = 'medium';
  return size;
}

function placeInShape(geometry: AsteroidFieldGeometry, random: () => number): SceneVector {
  const { shape, radius, innerRadius } = geometry;
  let point: SceneVector;
  if (shape === 'sphere') {
    const y = 1 - 2 * random();
    const phi = 2 * Math.PI * random();
    const s = Math.sqrt(Math.max(0, 1 - y * y));
    const rho = Math.cbrt(random() * (radius ** 3 - innerRadius ** 3) + innerRadius ** 3);
    point = [rho * s * Math.sin(phi), rho * y, rho * s * Math.cos(phi)];
  } else {
    const a = random();
    const theta = (random() - 0.5) * ((geometry.arc * Math.PI) / 180);
    const rho = Math.sqrt(a * (radius ** 2 - innerRadius ** 2) + innerRadius ** 2);
    const height = (geometry.thickness / 2) * (random() + random() - 1);
    point = [rho * Math.sin(theta), height, rho * Math.cos(theta)];
  }
  return [roundTo(point[0], 1e3), roundTo(point[1], 1e3), roundTo(point[2], 1e3)];
}

function fits(position: SceneVector, radius: number, grid: ReadonlyMap<string, readonly AsteroidFieldRock[]>, cell: number): boolean {
  const [cx, cy, cz] = position.map((value) => Math.floor(value / cell));
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const other of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const gap = (radius + other.radius) * ROCK_GAP;
          const d = Math.hypot(position[0] - other.position[0], position[1] - other.position[1], position[2] - other.position[2]);
          if (d < gap) return false;
        }
      }
    }
  }
  return true;
}

function cellKey(position: SceneVector, cell: number): string {
  return position.map((value) => Math.floor(value / cell)).join(',');
}

function pickWeighted(weights: readonly number[], roll: number): number {
  let cumulative = 0;
  for (const [index, weight] of weights.entries()) {
    cumulative += weight;
    if (roll < cumulative) return index;
  }
  return Math.max(0, weights.length - 1);
}

/**
 * A uniformly random unit quaternion from three uniform draws (Shoemake), rounded to 1e-6.
 */
function uniformQuaternion(u1: number, u2: number, u3: number): readonly [number, number, number, number] {
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const q = [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)].map((value) => roundTo(value, 1e6));
  return [q[0], q[1], q[2], q[3]];
}

/**
 * mulberry32: a small, fast 32-bit generator, the same in Node and the browser.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rounds to 1 / scale, with no negative zero (so the digest and JSON agree).
 */
function roundTo(value: number, scale: number): number {
  return Math.round(value * scale) / scale + 0;
}
