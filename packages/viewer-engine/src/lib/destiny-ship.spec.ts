// A real EveShip2 needs the Trinity classes registered; this spec loads them (slower than destiny.spec.ts).
import '@carbonenginejs/runtime/trinity';
import { blue } from '@carbonenginejs/runtime/blue';
import { CjsSchema } from '@carbonenginejs/runtime/schema';
import { TriFloat, type EveShip2 } from '@carbonenginejs/runtime/trinity';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DriveBoosters } from './boosters';
import { AttachShipCurves, DestinyWorld, DocumentRotation } from './destiny';
import { vec3 } from './runtime-sim';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);

describe('a Destiny ball driving an EveShip2', () => {
  it('places, moves and turns the ship through UpdateWorldTransform, and stays out of the ship graph', () => {
    const world = new DestinyWorld();
    const doc = { id: 'a', position: [3000, 0, 500] as [number, number, number], rotation: [90, 10, 20] as [number, number, number] };
    world.AddShip(doc, { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30 });
    const curves = world.Curves('a');
    if (!curves) throw new Error('no curves');
    const ship = CjsSchema.from<EveShip2>('EveShip2', { _type: 'EveShip2' });
    AttachShipCurves(ship, curves);

    let now = CLOCK_EPOCH_TICKS;
    const run = (seconds: number): void => {
      for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
        now += FRAME_TICKS;
        world.Tick(now);
        ship.UpdateWorldTransform(now);
      }
    };

    ship.UpdateWorldTransform(now);
    expect(Array.from(ship.worldPosition)).toEqual(doc.position);
    run(2);
    expect(Array.from(ship.worldPosition)).toEqual(doc.position);
    expect(Array.from(ship.worldVelocity)).toEqual([0, 0, 0]);
    const expected = DocumentRotation(doc.rotation);
    const dot = Array.from(ship.worldRotation).reduce((sum, value, index) => sum + value * expected[index], 0);
    expect(1 - Math.abs(dot)).toBeLessThan(1e-6);
    expect(curves.rotation.value).toEqual(ship.worldRotation);

    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    run(5);
    expect(ship.worldPosition[2]).toBeGreaterThan(600);
    expect(ship.worldPosition[0]).toBeCloseTo(3000, 3);
    expect(vec3.length(ship.worldVelocity)).toBeGreaterThan(100);

    // RetireShips walks the ship graph; it must reach the curves, never the parks.
    const reached = [...blue.FindAllReferences(ship).keys()];
    expect(reached).toContain(curves.translation);
    expect(reached).not.toContain(world.replica);
    expect(reached).not.toContain(world.master);
  });

  it('drives the booster set from the ball speed: dark at rest, steady at full speed, warp colours only in warp', () => {
    const world = new DestinyWorld();
    world.AddShip({ id: 'a', position: [0, 0, 0], rotation: [0, 0, 0] }, { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30, warpSpeed: 5 });
    const curves = world.Curves('a');
    if (!curves) throw new Error('no curves');
    const ship = CjsSchema.from<EveShip2>('EveShip2', { _type: 'EveShip2', boosters: { _type: 'EveBoosterSet2' } });
    const boosters = ship.boosters;
    if (!boosters) throw new Error('no booster set');
    ship.speed = new TriFloat();
    AttachShipCurves(ship, curves);

    let now = CLOCK_EPOCH_TICKS;
    const velocity = new Float32Array(3);
    const peak = { intensity: 0, warpIntensity: 0 };
    // The page's order (main.ts and Director.DriveBoosters), then what EveShip2.UpdateSyncronous / UpdateAsyncronous do.
    const frame = (): void => {
      now += FRAME_TICKS;
      world.Tick(now);
      curves.translation.GetValueDotAt__Ticks(now, velocity);
      DriveBoosters(ship, { speed: Math.hypot(velocity[0], velocity[1], velocity[2]), maxVelocity: 350 });
      ship.UpdateWorldTransform(now);
      if (ship.speed) ship.speed.value = vec3.length(ship.worldVelocity);
      ship.UpdateBoosters({ GetTime: () => now, GetDeltaT: () => 1 / 60 });
      peak.intensity = Math.max(peak.intensity, ship.GetBoosterIntensity());
      peak.warpIntensity = Math.max(peak.warpIntensity, boosters.warpIntensity);
    };
    const run = (seconds: number): void => {
      for (let index = 0; index < Math.round(seconds * 60); index++) frame();
    };

    run(2);
    expect(ship.GetBoosterIntensity()).toBe(0);
    expect(boosters.warpIntensity).toBe(0);
    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    run(15);
    expect(ship.GetBoosterIntensity()).toBeCloseTo(0.8, 1);
    expect(boosters.warpIntensity).toBe(0);
    expect(boosters.maxVel).toBe(350);
    expect(ship.maxSpeed).toBe(350);

    world.Order('a', { type: 'warp', point: [0, 0, 400_000], range: 0 });
    for (let index = 0; world.Motion('a')?.warp?.phase !== 'landed'; index++) {
      if (index > 60 * 60) throw new Error('the warp did not land');
      frame();
    }
    expect(peak.intensity).toBeCloseTo(2, 2);
    expect(peak.warpIntensity).toBe(1);
    run(10);
    expect(boosters.warpIntensity).toBe(0);
    expect(ship.GetBoosterIntensity()).toBeLessThan(0.1);
  });

  it('an MWD pushes the boosters to the cap with boosters.maxVel still the base max velocity, and they return after it stops', () => {
    const world = new DestinyWorld();
    world.AddShip({ id: 'a', position: [0, 0, 0], rotation: [0, 0, 0] }, { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30, warpSpeed: 5, propMod: { mass: 1.7e6, maxVelocity: 2500, cycleTime: 10 } });
    const curves = world.Curves('a');
    if (!curves) throw new Error('no curves');
    const ship = CjsSchema.from<EveShip2>('EveShip2', { _type: 'EveShip2', boosters: { _type: 'EveBoosterSet2' } });
    const boosters = ship.boosters;
    if (!boosters) throw new Error('no booster set');
    ship.speed = new TriFloat();
    AttachShipCurves(ship, curves);

    let now = CLOCK_EPOCH_TICKS;
    const velocity = new Float32Array(3);
    const run = (seconds: number): void => {
      for (let index = 0; index < Math.round(seconds * 60); index++) {
        now += FRAME_TICKS;
        world.Tick(now);
        curves.translation.GetValueDotAt__Ticks(now, velocity);
        DriveBoosters(ship, { speed: Math.hypot(velocity[0], velocity[1], velocity[2]), maxVelocity: 350 });
        ship.UpdateWorldTransform(now);
        if (ship.speed) ship.speed.value = vec3.length(ship.worldVelocity);
        ship.UpdateBoosters({ GetTime: () => now, GetDeltaT: () => 1 / 60 });
      }
    };

    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    run(15);
    expect(ship.GetBoosterIntensity()).toBeCloseTo(0.8, 1);
    world.SwitchPropMod('a', true);
    run(15);
    expect(world.Motion('a')?.speed).toBeGreaterThan(2000);
    expect(ship.GetBoosterIntensity()).toBeCloseTo(2, 2);
    expect(boosters.maxVel).toBe(350);
    expect(boosters.warpIntensity).toBe(0);
    world.SwitchPropMod('a', false);
    run(40);
    expect(world.Motion('a')?.propMod.state).toBe('off');
    expect(ship.GetBoosterIntensity()).toBeCloseTo(0.8, 1);
  });
});
