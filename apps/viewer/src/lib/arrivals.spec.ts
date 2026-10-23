import { type SceneArrival, type SceneShip, type SceneVector, toArrivalLane } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { type ArrivalsConfig, Arrivals, PlanArrivals, type PlanArrivalShip, WARP_IN_HIDDEN_DISTANCE, WarpInMinDistance } from './arrivals';
import type { DestinyWorld, WarpEvent } from './destiny';
import { Fly, Gap, GUARDIAN, Harness, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { WARP_IN_BACKDATE_TICKS, WarpDropOutTime, WarpFactor, WarpRemainingAt } from './warp';

const rifter = Fly(RIFTER);
const guardian = Fly(GUARDIAN);
const tfi = Fly(TFI);
const LANE = toArrivalLane(0);

function Profile(world: DestinyWorld): (factor: number, distance: number) => ReturnType<DestinyWorld['WarpProfile']> {
  return (factor, distance) => world.WarpProfile(factor, distance);
}

function PlanShip(id: string, flight: typeof rifter, offset = 0, landing: SceneVector = [0, 0, 0]): PlanArrivalShip {
  return { id, landing, factor: WarpFactor(flight.warpSpeed ?? 4), maxVelocity: flight.maxVelocity, offset };
}

describe('PlanArrivals', () => {
  const world = new Harness().world;
  const profile = Profile(world);

  it('picks the shortest lane that keeps each hull hidden when its warp-in begins', () => {
    for (const flight of [rifter, guardian, tfi]) {
      const numbers = { factor: WarpFactor(flight.warpSpeed ?? 4), maxVelocity: flight.maxVelocity, profile };
      const min = WarpInMinDistance(numbers);
      expect(WarpRemainingAt(profile(numbers.factor, min), WARP_IN_BACKDATE_TICKS + 1)).toBeGreaterThanOrEqual(WARP_IN_HIDDEN_DISTANCE);
      expect(WarpRemainingAt(profile(numbers.factor, min * 0.99), WARP_IN_BACKDATE_TICKS + 1)).toBeLessThan(WARP_IN_HIDDEN_DISTANCE);
    }
  });

  it('together: every ship lands within the stagger of the slowest hull, the leader first', () => {
    const ships = [PlanShip('fc', tfi, 0), PlanShip('a', rifter, 1.5), PlanShip('b', guardian, 3.2), PlanShip('c', rifter, 0.4)];
    const plans = PlanArrivals({ ships, lane: LANE, boundary: 100, together: true, profile });
    const fc = plans[0];
    for (const [index, plan] of plans.entries()) {
      expect(plan.lands - fc.lands).toBeCloseTo(ships[index].offset, 3);
      expect(plan.at).toBeGreaterThanOrEqual(100);
      const numbers = { factor: ships[index].factor, maxVelocity: ships[index].maxVelocity, profile };
      expect(plan.distance).toBeGreaterThanOrEqual(WarpInMinDistance(numbers) - 1e-6);
      expect(Gap(plan.from, plan.landing)).toBeCloseTo(plan.distance, 0);
    }
    // The slowest hull (the TFI) starts first, at the boundary.
    expect(fc.at).toBe(100);
    expect(Math.min(...plans.map((plan) => plan.at))).toBe(100);
    expect(PlanArrivals({ ships, lane: LANE, boundary: 100, together: true, profile })).toEqual(plans);
  });

  it('by speed: each hull lands at its own pace plus its offset', () => {
    const ships = [PlanShip('fc', tfi, 0), PlanShip('a', rifter, 2)];
    const [slow, fast] = PlanArrivals({ ships, lane: LANE, boundary: 50, together: false, profile });
    expect(slow.at).toBe(50);
    const numbers = { factor: ships[1].factor, maxVelocity: ships[1].maxVelocity, profile };
    const natural = WarpDropOutTime(profile(numbers.factor, WarpInMinDistance(numbers)), rifter.maxVelocity) - WARP_IN_BACKDATE_TICKS;
    expect(fast.lands).toBeCloseTo(natural + 2, 3);
    expect(fast.lands).toBeLessThan(slow.lands);
  });

  it('plans with the smaller backdate of a world in its first ticks', () => {
    const [plan] = PlanArrivals({ ships: [PlanShip('a', rifter)], lane: LANE, boundary: 2, together: true, profile });
    const numbers = { factor: WarpFactor(rifter.warpSpeed ?? 4), maxVelocity: rifter.maxVelocity, profile };
    expect(plan.lands).toBeCloseTo(WarpDropOutTime(profile(numbers.factor, WarpInMinDistance(numbers)), rifter.maxVelocity) - 2, 3);
  });
});

interface World {
  readonly harness: Harness;
  readonly arrivals: Arrivals;
  readonly placements: Map<string, Pick<SceneShip, 'position' | 'rotation'>>;
  readonly exits: Map<string, number>;
  readonly enters: Map<string, number>;
}

function MakeWorld(ships: readonly [string, typeof rifter, SceneVector][], config: Partial<ArrivalsConfig> = {}): World {
  const harness = new Harness();
  const { world } = harness;
  const placements = new Map<string, Pick<SceneShip, 'position' | 'rotation'>>();
  for (const [id, flight, position] of ships) {
    world.AddShip(Ship(id, position), flight);
    placements.set(id, { position, rotation: [0, 0, 0] });
  }
  const arrivals = new Arrivals({ world, placement: (id) => placements.get(id) ?? null, ready: () => true, fleetReady: () => true, groupOffsets: () => null, followState: () => null, ...config });
  world.OnBoundary((boundary) => arrivals.Boundary(boundary));
  const exits = new Map<string, number>();
  const enters = new Map<string, number>();
  world.OnWarp((event: WarpEvent) => (event.kind === 'exit' ? exits : enters).set(event.id, world.tick));
  return { harness, arrivals, placements, exits, enters };
}

function Group(ships: string[], extra: Partial<SceneArrival> = {}): SceneArrival {
  return { where: 'spec', group: 'g', leader: ships[0], ships, lane: LANE, landing: 'document', stagger: 4, together: true, ...extra };
}

describe('Arrivals', () => {
  it('parks the ships off-grid at once, then lands them staggered at their placements on the planned ticks', () => {
    const { harness, arrivals, exits, enters } = MakeWorld([
      ['a', rifter, [0, 0, 0]],
      ['b', rifter, [500, 0, 0]],
      ['c', guardian, [-500, 0, 0]]
    ]);
    harness.Ticks(6);
    const key = arrivals.Add(Group(['a', 'b', 'c']));
    for (const id of ['a', 'b', 'c']) expect(harness.world.Motion(id)?.position[2]).toBeLessThan(-1_000_000);
    expect(arrivals.Report()[0]).toMatchObject({ group: key, state: 'waiting' });
    arrivals.Boundary(harness.world.tick);
    const planned = arrivals.Report()[0];
    expect(planned.state).toBe('scheduled');
    expect(planned.lands?.first).toBeGreaterThan(0);
    const landTicks = new Map(planned.ships.map((ship) => [ship.id, harness.world.tick + (ship.landsIn ?? 0)]));
    // How far each ship is from its landing on the first tick of its warp-in.
    const firstSeen = new Map<string, number>();
    harness.Until(
      () => exits.size === 3,
      200,
      () => {
        for (const id of ['a', 'b', 'c']) if (enters.has(id) && !firstSeen.has(id)) firstSeen.set(id, Gap(harness.world.Motion(id)?.position ?? [0, 0, 0], harness.world.Motion(id)?.arrival?.landing ?? [0, 0, 0]));
      }
    );
    for (const id of ['a', 'b', 'c']) expect(firstSeen.get(id)).toBeGreaterThanOrEqual(WARP_IN_HIDDEN_DISTANCE);
    // Hidden while warping until the last ticks; lands where it was placed, on the planned tick.
    for (const [id, position] of [
      ['a', [0, 0, 0]],
      ['b', [500, 0, 0]],
      ['c', [-500, 0, 0]]
    ] as const) {
      expect(Math.abs((exits.get(id) ?? 0) - (landTicks.get(id) ?? 0))).toBeLessThanOrEqual(1);
      expect(Gap(harness.world.Motion(id)?.position ?? [0, 0, 0], position)).toBeLessThan(1_000);
    }
    expect(new Set(exits.values()).size).toBeGreaterThanOrEqual(2);
    expect(exits.get('a')).toBe(Math.min(...exits.values()));
    harness.Ticks(30);
    expect(arrivals.Report()[0]?.state ?? 'formed').toBe('formed');
  });

  it('waits for the ships to be ready, then plans after the timeout', () => {
    const { harness, arrivals } = MakeWorld([['a', rifter, [0, 0, 0]]], { ready: () => false });
    harness.Ticks(6);
    arrivals.Add(Group(['a']));
    harness.Ticks(10);
    expect(arrivals.Report()[0].state).toBe('waiting');
    harness.Ticks(12);
    const report = arrivals.Report()[0];
    expect(report.state).not.toBe('waiting');
    expect(report.notes?.[0]).toMatch(/without every ship's flight numbers/);
  });

  it("lands a join at its slots around the FC's live position, along its heading", () => {
    const offsets = new Map<string, SceneVector>([['m', [0, 0, -3000]]]);
    const { harness, arrivals, exits } = MakeWorld(
      [
        ['fc', tfi, [10_000, 0, 0]],
        ['m', rifter, [10_000, 0, 0]]
      ],
      { groupOffsets: () => offsets }
    );
    harness.Ticks(6);
    harness.world.PlaceShip({ id: 'fc', position: [20_000, 0, 5_000], rotation: [90, 0, 0] });
    arrivals.Add(Group(['m'], { fleet: 'f', leader: 'fc', landing: 'formation', lane: toArrivalLane(0) }));
    arrivals.Boundary(harness.world.tick);
    const landing = harness.world.ArrivalOf('m')?.landing ?? [0, 0, 0];
    // 3 km behind an FC facing +X.
    expect(landing[0]).toBeCloseTo(17_000, 0);
    expect(landing[2]).toBeCloseTo(5_000, 0);
    const from = harness.world.ArrivalOf('m')?.from ?? [0, 0, 0];
    expect(from[0]).toBeLessThan(landing[0] - WARP_IN_HIDDEN_DISTANCE);
    harness.Until(() => exits.has('m'), 200);
    expect(Gap(harness.world.Motion('m')?.position ?? [0, 0, 0], landing)).toBeLessThan(1_000);
  });

  it('drops a ship placed before it lands, and forgets removed ships and cleared groups', () => {
    const { harness, arrivals } = MakeWorld([
      ['a', rifter, [0, 0, 0]],
      ['b', rifter, [500, 0, 0]]
    ]);
    harness.Ticks(6);
    arrivals.Add(Group(['a', 'b']));
    harness.world.PlaceShip({ id: 'b', position: [0, 0, 0], rotation: [0, 0, 0] });
    arrivals.Boundary(harness.world.tick);
    const report = arrivals.Report()[0];
    expect(report.ships.find((ship) => ship.id === 'b')).toMatchObject({ state: 'dropped', note: 'placed before it landed' });
    expect(report.ships.find((ship) => ship.id === 'a')?.state).toBe('scheduled');
    arrivals.Remove('a');
    arrivals.Remove('b');
    expect(arrivals.Report()).toEqual([]);
    arrivals.Add(Group(['a']));
    arrivals.Clear();
    expect(arrivals.Report()).toEqual([]);
  });

  it('places a ship that cannot move at its landing', () => {
    const { harness, arrivals } = MakeWorld([['a', rifter, [0, 0, 0]]]);
    harness.Ticks(6);
    arrivals.Add(Group(['a']));
    harness.world.SetPhysics('a', { ...rifter, maxVelocity: 0 });
    arrivals.Boundary(harness.world.tick);
    expect(arrivals.Report()[0].ships[0]).toMatchObject({ state: 'dropped', note: expect.stringMatching(/placed at its landing/) });
    expect(Gap(harness.world.Motion('a')?.position ?? [1, 1, 1], [0, 0, 0])).toBeLessThan(1);
  });
});
