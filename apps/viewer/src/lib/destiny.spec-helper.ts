/**
 * Shared fixtures for the DestinyWorld specs: a world driven the way the page drives it (one clock, the parks evolved
 * to it, then the curves sampled at it), fixture hulls and small helpers. It imports no vitest, so the app's tsconfig
 * may include it; `expect` stays in the specs.
 */

import type { SceneShip, SceneVector } from '@scene-director/scene';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld, FIRST_SHIP_BALL_ID, type ShipMotion } from './destiny';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { quat, vec3, type Quat, type Vec3 } from './runtime-sim';

export const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
export const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
export const GUARDIAN: PublishedHull = { typeID: 11987, name: 'Guardian', published: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80, warpSpeedMultiplier: 4, rigSize: 2 } };
export const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3, rigSize: 3 } };

export type Placement = Pick<SceneShip, 'id' | 'position' | 'rotation'>;

/**
 * The max-skills Ship-stats numbers of a fixture hull.
 *
 * @param hull - The hull.
 * @returns Its flight.
 */
export function Fly(hull: PublishedHull): ShipFlight {
  return ResolveFlight({ published: hull, hull: null, overrides: null });
}

export function Ship(id: string, position: SceneVector, rotation: SceneVector = [0, 0, 0]): Placement {
  return { id, position, rotation };
}

export function RequireMotion(world: DestinyWorld, id: string): ShipMotion {
  const motion = world.Motion(id);
  if (!motion) throw new Error(`no motion for ${id}`);
  return motion;
}

export function Gap(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export interface Sample {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly rotation: Quat;
}

/**
 * A world driven the way the page drives it: 60 frames a second on one clock, the parks evolved to it, then every
 * tracked curve sampled at it.
 */
export class Harness {
  readonly world = new DestinyWorld();
  now = CLOCK_EPOCH_TICKS;
  private readonly samples = new Map<string, Sample>();

  /**
   * Runs frames for a time, sampling every tracked ship each frame.
   *
   * @param seconds - Scene seconds.
   * @param onFrame - Called after each frame.
   */
  Run(seconds: number, onFrame?: () => void): void {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      this.now += FRAME_TICKS;
      this.world.Tick(this.now);
      for (const id of this.samples.keys()) this.Sample(id);
      onFrame?.();
    }
  }

  /**
   * Samples a ship's curves now, and tracks it from then on.
   *
   * @param id - The ship id.
   * @returns Its drawn position, velocity and rotation.
   */
  Sample(id: string): Sample {
    const curves = this.world.Curves(id);
    if (!curves) throw new Error(`no curves for ${id}`);
    const sample = {
      position: curves.translation.Update__Ticks(this.now, vec3.create()),
      velocity: curves.translation.GetValueDotAt__Ticks(this.now, vec3.create()),
      rotation: curves.rotation.Update__Ticks(this.now, quat.create())
    };
    this.samples.set(id, sample);
    return sample;
  }

  /**
   * Runs frames until the world has evolved `count` more ticks, calling back after each one.
   *
   * @param count - Ticks.
   * @param onTick - Called after each evolved tick.
   * @param onFrame - Called after each frame.
   */
  Ticks(count: number, onTick?: () => void, onFrame?: () => void): void {
    const end = this.world.tick + count;
    let tick = this.world.tick;
    while (this.world.tick < end) {
      this.Run(1 / 60, onFrame);
      if (this.world.tick !== tick) {
        tick = this.world.tick;
        onTick?.();
      }
    }
  }

  /**
   * Runs ticks until `done`, at most `limit`.
   *
   * @param done - Checked before each tick.
   * @param limit - Ticks.
   * @param onTick - Called after each evolved tick.
   * @param onFrame - Called after each frame.
   * @throws {Error} When `done` is still false after `limit` ticks.
   */
  Until(done: () => boolean, limit: number, onTick?: () => void, onFrame?: () => void): void {
    for (let tick = 0; !done(); tick++) {
      if (tick >= limit) throw new Error(`not done after ${limit} ticks`);
      this.Ticks(1, onTick, onFrame);
    }
  }
}

/**
 * Every ship ball's state on a park, for lockstep checks.
 *
 * @param world - The world.
 * @param park - Which park.
 * @param balls - How many ship balls from FIRST_SHIP_BALL_ID.
 * @returns One row per ball: position, velocity, mode, heading and physics.
 */
export function BallStates(world: DestinyWorld, park: 'master' | 'replica', balls: number): number[][] {
  const rows: number[][] = [];
  for (let id = FIRST_SHIP_BALL_ID; id < FIRST_SHIP_BALL_ID + balls; id++) {
    const ball = world[park].GetBall(id);
    rows.push(ball ? [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz, ball.mode, ball.mNewYaw, ball.mNewPitch, ball.mass, ball.maxVelocity, ball.agility, ball.effectStamp] : []);
  }
  return rows;
}
