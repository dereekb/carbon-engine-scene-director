/**
 * Destiny's legacy orbit (`EvolveOldStyleOrbit`, CjsBallparkController; `g_useNewOrbit` is off): each tick the ship
 * thrusts at full cruise speed toward the tangent point of the ordered circle, blended into the circle's tangent by
 * `exp(−(r − d)² / 40000)`. It settles wider and slower than ordered (a Rifter ordered to 0 flies ~300 m at ~55 %).
 * The continuous closed form under-predicts tight orbits by 15-20 %, so the model is the same rule stepped in 2D at
 * Destiny's 1 s ticks with its exact integrator; the target sits still and the orbit plane does not precess (Destiny
 * turns it at 0.001 rad per tick).
 */

/**
 * The tangent blend's width: `exp(−(r − d)² / ORBIT_BLEND_SQUARED_METRES)`.
 */
export const ORBIT_BLEND_SQUARED_METRES = 40_000;

/**
 * The model's settled state is cached by these steps of its inputs.
 */
export const ORBIT_MODEL_STEPS = { speed: 0.5, tau: 0.01, range: 10, radii: 1 } as const;

/**
 * At most this many cached orbits; the cache starts over beyond it.
 */
export const ORBIT_MODEL_CACHE_SIZE = 20_000;

export interface LegacyOrbitInput {
  /**
   * The ship's cruise speed: max velocity × the order's speed fraction (m/s).
   */
  readonly speed: number;
  /**
   * τ (s): mass × agility / 1e6.
   */
  readonly tau: number;
  /**
   * The ordered range, surface to surface (m).
   */
  readonly range: number;
  /**
   * Both ships' radii summed (m).
   */
  readonly radii: number;
}

export interface LegacyOrbit {
  /**
   * The ordered range (m).
   */
  readonly ordered: number;
  /**
   * The settled range flown, surface to surface (m).
   */
  readonly distance: number;
  /**
   * The settled speed (m/s); all of it is transversal.
   */
  readonly speed: number;
  /**
   * The settled speed over the cruise speed.
   */
  readonly speedFraction: number;
  /**
   * rad/s: the settled speed over the centre distance.
   */
  readonly angular: number;
}

const ORBIT_CACHE = new Map<string, LegacyOrbit>();

function stepOf(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * The stepped 2D simulation: the target at the origin, the ship starting at rest on the ordered circle, run until
 * its distance and speed settle (or 60 τ + 200 ticks).
 *
 * @param input - The rounded inputs.
 * @returns The settled orbit.
 */
function simulateLegacyOrbit(input: LegacyOrbitInput): LegacyOrbit {
  const { speed, tau, range, radii } = input;
  const r = range + radii;
  const decay = tau > 0 ? Math.exp(-1 / tau) : 0;
  const lag = tau * (1 - decay);
  const minimumTicks = Math.ceil(10 * tau) + 20;
  const maximumTicks = Math.ceil(60 * tau) + 200;
  let [x, y, vx, vy] = [Math.max(r, 1), 0, 0, 0];
  let [lastDistance, lastSpeed] = [Number.NaN, Number.NaN];
  for (let tick = 0; tick < maximumTicks; tick++) {
    const d = Math.hypot(x, y);
    let [tx, ty] = d > 0 ? [-x / d, -y / d] : [0, 0];
    const [rx, ry] = [-ty, tx];
    const toComp = d * d - r * r;
    if (toComp >= 0 && d > 0) {
      const radComp = (r * Math.sqrt(toComp)) / d;
      const toward = toComp / d;
      [tx, ty] = [toward * tx + radComp * rx, toward * ty + radComp * ry];
      const length = Math.hypot(tx, ty);
      if (length > 0) [tx, ty] = [tx / length, ty / length];
    }
    const radialFactor = Math.exp(-((r - d) * (r - d)) / ORBIT_BLEND_SQUARED_METRES);
    const cosine = -(tx * rx + ty * ry);
    const determinant = 1 + radialFactor * radialFactor * (cosine * cosine - 1);
    const transverse = (radialFactor * cosine + (determinant > 0 ? Math.sqrt(determinant) : 0)) * (d - r >= 0 ? 1 : -1);
    const [ax, ay] = [(radialFactor * rx + transverse * tx) * speed, (radialFactor * ry + transverse * ty) * speed];
    [x, y] = [x + ax + (vx - ax) * lag, y + ay + (vy - ay) * lag];
    [vx, vy] = [ax + (vx - ax) * decay, ay + (vy - ay) * decay];
    const [distance, flown] = [Math.hypot(x, y), Math.hypot(vx, vy)];
    if (tick >= minimumTicks && Math.abs(distance - lastDistance) < 0.01 && Math.abs(flown - lastSpeed) < 0.001) break;
    [lastDistance, lastSpeed] = [distance, flown];
  }
  const centre = Math.hypot(x, y);
  const flownSpeed = Math.hypot(vx, vy);
  return { ordered: range, distance: Math.max(0, centre - radii), speed: flownSpeed, speedFraction: speed > 0 ? flownSpeed / speed : 0, angular: centre > 0 ? flownSpeed / centre : 0 };
}

/**
 * The orbit Destiny settles into for an order (memoized on ORBIT_MODEL_STEPS of its inputs).
 *
 * @param input - The cruise speed, τ, the ordered range and the radii.
 * @returns The settled range, speed and angular velocity.
 */
export function legacyOrbitOf(input: LegacyOrbitInput): LegacyOrbit {
  const rounded: LegacyOrbitInput = {
    speed: stepOf(input.speed, ORBIT_MODEL_STEPS.speed),
    tau: Math.max(ORBIT_MODEL_STEPS.tau, stepOf(input.tau, ORBIT_MODEL_STEPS.tau)),
    range: Math.max(0, stepOf(input.range, ORBIT_MODEL_STEPS.range)),
    radii: Math.max(0, stepOf(input.radii, ORBIT_MODEL_STEPS.radii))
  };
  const key = `${rounded.speed}|${rounded.tau}|${rounded.range}|${rounded.radii}`;
  let orbit = ORBIT_CACHE.get(key);
  if (!orbit) {
    if (ORBIT_CACHE.size >= ORBIT_MODEL_CACHE_SIZE) ORBIT_CACHE.clear();
    orbit = rounded.speed > 0 ? simulateLegacyOrbit(rounded) : { ordered: rounded.range, distance: rounded.range, speed: 0, speedFraction: 0, angular: 0 };
    ORBIT_CACHE.set(key, orbit);
  }
  return orbit;
}

export interface OrbitOrderInput extends Omit<LegacyOrbitInput, 'range'> {
  /**
   * The range to fly, surface to surface (m).
   */
  readonly distance: number;
}

/**
 * Bisection steps orbitOrderFor takes (to ORBIT_MODEL_STEPS.range).
 */
export const ORBIT_ORDER_BISECTIONS = 16;

/**
 * What to order to fly a range: the ordered range whose settled orbit flies `distance` (bisection on legacyOrbitOf).
 *
 * @param input - The cruise speed, τ, the radii and the range to fly.
 * @returns The range to order (m, to ORBIT_MODEL_STEPS.range); 0 when even an order of 0 flies wider.
 */
export function orbitOrderFor(input: OrbitOrderInput): number {
  const { distance } = input;
  const flown = (range: number) => legacyOrbitOf({ ...input, range }).distance;
  let [low, high] = [0, Math.max(0, distance)];
  let ordered = 0;
  if (flown(0) < distance) {
    for (let step = 0; step < ORBIT_ORDER_BISECTIONS && high - low > ORBIT_MODEL_STEPS.range; step++) {
      const middle = (low + high) / 2;
      if (flown(middle) < distance) low = middle;
      else high = middle;
    }
    ordered = stepOf((low + high) / 2, ORBIT_MODEL_STEPS.range);
  }
  return ordered;
}
