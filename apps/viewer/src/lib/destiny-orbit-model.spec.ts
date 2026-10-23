import { legacyOrbitOf } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { FIRST_SHIP_BALL_ID } from './destiny';
import { GUARDIAN, Harness, RequireMotion, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight, RunningFlight, type PublishedHull, type ShipFlight } from './flight';
import { ResolveShipPropMod } from './prop-mods';

/**
 * The piloting math's orbit model (legacyOrbitOf, the stepped 2D legacy orbit) against Destiny's own orbits on the
 * parks: each ship orbits a twin until it settles, and the flown range and speed must match the model within 1 %.
 */

function FlightOf(hull: PublishedHull, rigSize: 1 | 2 | 3): ShipFlight {
  return ResolveFlight({ published: hull, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize, answer: null }) });
}

interface Settled {
  readonly distance: number;
  readonly speed: number;
  readonly radii: number;
}

/**
 * Orbits `a` around a twin `t` at a range, its prop mod on or off, one Destiny tick at a time until it settles.
 *
 * @param flight - Both ships' flight.
 * @param range - The ordered range (m).
 * @param propMod - Whether `a` runs its prop mod.
 * @returns The settled surface distance and speed (means over the last 10 ticks) and the radii.
 */
function Orbit(flight: ShipFlight, range: number, propMod: boolean): Settled {
  const harness = new Harness();
  const { world } = harness;
  world.AddShip(Ship('a', [range + 3000, 0, 0]), flight);
  world.AddShip(Ship('t', [0, 0, 0]), flight);
  if (propMod) world.SetPropModActive('a', true);
  world.Order('a', { type: 'orbit', target: 't', range, speed: 1 });
  const running = RunningFlight(flight, propMod);
  const tau = (running.mass * running.agility) / 1e6;
  let now = CLOCK_EPOCH_TICKS;
  const step = () => {
    now += TICKS_PER_SECOND;
    world.Tick(now);
  };
  for (let tick = 0; tick < Math.ceil(40 * tau) + 120; tick++) step();
  const [distances, speeds] = [[] as number[], [] as number[]];
  for (let tick = 0; tick < 10; tick++) {
    step();
    const motion = RequireMotion(world, 'a');
    distances.push(motion.targetDistance ?? Number.NaN);
    speeds.push(motion.speed);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const radii = (world.master.GetBall(FIRST_SHIP_BALL_ID)?.radius ?? 0) + (world.master.GetBall(FIRST_SHIP_BALL_ID + 1)?.radius ?? 0);
  return { distance: mean(distances), speed: mean(speeds), radii };
}

describe('legacyOrbitOf against Destiny', () => {
  const cases: readonly [string, PublishedHull, 1 | 2 | 3, number, boolean][] = [
    ['Rifter', RIFTER, 1, 0, false],
    ['Rifter', RIFTER, 1, 500, false],
    ['Rifter', RIFTER, 1, 1000, false],
    ['Rifter', RIFTER, 1, 2500, false],
    ['Rifter', RIFTER, 1, 5000, false],
    ['Rifter', RIFTER, 1, 10_000, true],
    ['Guardian', GUARDIAN, 2, 1000, false],
    ['Guardian', GUARDIAN, 2, 10_000, true],
    ['Tempest Fleet Issue', TFI, 3, 2500, false],
    ['Tempest Fleet Issue', TFI, 3, 10_000, true]
  ];
  for (const [name, hull, rigSize, range, propMod] of cases) {
    it(`flies a ${name} ordered to ${range} m${propMod ? ' on its MWD' : ''} where the model says`, () => {
      const flight = FlightOf(hull, rigSize);
      const running = RunningFlight(flight, propMod);
      const settled = Orbit(flight, range, propMod);
      const model = legacyOrbitOf({ speed: running.maxVelocity, tau: (running.mass * running.agility) / 1e6, range, radii: settled.radii });
      expect(Math.abs(settled.distance - model.distance) / settled.distance, `flown ${settled.distance} vs ${model.distance}`).toBeLessThan(0.01);
      expect(Math.abs(settled.speed - model.speed) / settled.speed, `speed ${settled.speed} vs ${model.speed}`).toBeLessThan(0.01);
    });
  }
});
