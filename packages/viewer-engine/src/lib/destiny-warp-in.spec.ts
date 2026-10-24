import type { Maybe } from '@dereekb/util';
import { toFollowTolerance, type SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIP_PHYSICS, type DestinyWorld, type PropModEvent, type ShipFollow, type WarpEvent } from './destiny';
import { BallStates, Fly, GUARDIAN, Gap, Harness, RequireMotion, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { WarpInBackdate, WarpInExitTicks, WarpRemainingAt } from './warp';

const rifter = Fly(RIFTER);
const guardian = Fly(GUARDIAN);
const tfi = Fly(TFI);

const LANDING: SceneVector = [5_000, 0, 20_000];
const LANE: SceneVector = [0.6, 0, 0.8];
// A million km out: a Rifter is still ~114,000 km away on the first tick of its warp-in, far off-grid.
const DISTANCE = 1e9;
const LANE_YAW = (Math.atan2(LANE[0], LANE[2]) * 180) / Math.PI;

function From(distance = DISTANCE, landing: SceneVector = LANDING): SceneVector {
  return [landing[0] - LANE[0] * distance, landing[1] - LANE[1] * distance, landing[2] - LANE[2] * distance];
}

function ExpectLockstep(world: DestinyWorld, balls: number): void {
  expect(world.master.currentTime).toBe(world.replica.currentTime);
  expect(BallStates(world, 'replica', balls)).toEqual(BallStates(world, 'master', balls));
}

/**
 * A world six ticks on (so EntityWarpIn's backdate is whole), with one ship at the origin.
 */
function WithShip(physics = rifter, id = 'r'): Harness {
  const harness = new Harness();
  harness.world.AddShip(Ship(id, [0, 0, 0]), physics);
  harness.Ticks(6);
  return harness;
}

/**
 * The master tick a warp-in started at `at` reports its exit at.
 */
function ExitTick(world: DestinyWorld, at: number, factor: number, distance: number, maxVelocity: number): number {
  return at + WarpInExitTicks(world.WarpProfile(factor, distance), maxVelocity, WarpInBackdate(at));
}

describe('DestinyWorld arrivals', () => {
  it('parks a ship off-grid at rest, facing its landing, and refuses what Destiny cannot warp in', () => {
    const harness = WithShip();
    const { world } = harness;
    const from = From();
    expect(world.ArrivalRefusal('r', { from: [LANDING[0], LANDING[1], LANDING[2] - 100_000], landing: LANDING, at: null })).toMatch(/would warp in from 100 km away; EVE warps only 150 km or more/u);
    expect(world.ArrivalRefusal('nope', { from, landing: LANDING, at: null })).toMatch(/has no Destiny ball/u);
    expect(world.ArrivalRefusal('r', { from: [Number.NaN, 0, 0], landing: LANDING, at: null })).toMatch(/finite/u);
    expect(world.ArrivalRefusal('r', { from, landing: LANDING, at: null, factor: 1.5 })).toMatch(/positive int32/u);
    world.AddShip(Ship('still', [0, 0, 1000]), { ...DEFAULT_SHIP_PHYSICS, maxVelocity: 0 });
    expect(world.Arrive('still', { from, landing: LANDING, at: world.tick })).toBe(false);
    expect(world.ArrivalRefusal('still', { from, landing: LANDING, at: null })).toMatch(/cannot warp in: its max velocity is 0/u);

    expect(world.Arrive('r', { from, landing: LANDING, at: null, roll: 10 })).toBe(true);
    harness.Ticks(4, () => ExpectLockstep(world, 2));
    const motion = RequireMotion(world, 'r');
    expect(Gap(motion.position, from)).toBeLessThan(0.01);
    expect(motion.speed).toBe(0);
    expect(motion.mode).toBe('stop');
    expect(motion.heading[0]).toBeCloseTo(LANE_YAW, 1);
    expect(motion.heading[1]).toBeCloseTo(0, 1);
    expect(motion.arrival).toEqual({ state: 'parked', from: motion.arrival?.from, landing: LANDING });
    expect(Gap(motion.arrival?.from ?? [0, 0, 0], from)).toBeLessThan(0.01);
    expect(world.Arriving('r')).toBe(true);
  });

  it('refuses orders, prop mods and formation warps while a ship arrives, and orders at it', () => {
    const harness = WithShip(ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) }));
    const { world } = harness;
    world.AddShip(Ship('o', [0, 0, -2000]), rifter);
    expect(world.Arrive('r', { from: From(), landing: LANDING, at: null })).toBe(true);
    expect(world.OrderRefusal('r', { type: 'stop' })).toBe('ship "r" is arriving by warp; it takes orders once it lands');
    expect(world.Order('r', { type: 'stop' })).toBe(false);
    expect(world.OrderRefusal('o', { type: 'approach', target: 'r', speed: 1 })).toBe('target "r" is arriving by warp');
    expect(world.PropModRefusal('r', true)).toBe('ship "r" is arriving by warp; switch its prop mod on once it lands');
    world.SetPropModActive('r', true);
    expect(RequireMotion(world, 'r').propMod.state).toBe('off');
    expect(RequireMotion(world, 'r').propMod.note).toBe('not switched on: arriving by warp');
    world.AddShip(Ship('fc', [0, 0, 5000]), tfi);
    expect(world.Follow('r', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 })).toBe(true);
    expect(world.WarpInFormation('r', { leader: 'fc', offset: [0, 0, -1000] })).toBe(false);

    const at = world.tick + 1;
    expect(world.Arrive('r', { from: From(), landing: LANDING, at })).toBe(true);
    const landsIn = RequireMotion(world, 'r').arrival?.landsIn;
    expect(landsIn).toBe(ExitTick(world, at, 5000, DISTANCE, rifter.maxVelocity) - world.tick);
    expect(world.OrderRefusal('r', { type: 'stop' })).toBe(`ship "r" is arriving by warp; it takes orders once it lands, in about ${landsIn} s`);
  });

  it('warps in at its boundary with no align, on both parks, and drops out on the tick Destiny’s profile gives', () => {
    const harness = WithShip();
    const { world } = harness;
    const events: WarpEvent[] = [];
    world.OnWarp((event) => events.push(event));
    const from = From();
    const at = world.tick + 2;
    const exitTick = ExitTick(world, at, 5000, DISTANCE, rifter.maxVelocity);
    expect(world.Arrive('r', { from, landing: LANDING, at })).toBe(true);
    expect(RequireMotion(world, 'r').arrival).toMatchObject({ state: 'scheduled', startsIn: 2, landsIn: exitTick - world.tick });

    harness.Ticks(2, () => ExpectLockstep(world, 1));
    expect(RequireMotion(world, 'r').arrival?.state).toBe('scheduled');
    expect(RequireMotion(world, 'r').position).toEqual(RequireMotion(world, 'r').arrival?.from);
    harness.Ticks(1);
    const first = RequireMotion(world, 'r');
    expect(world.tick).toBe(at + 1);
    expect(first.arrival?.state).toBe('warping');
    expect(first.mode).toBe('warp');
    expect(first.order).toEqual({ type: 'warp', point: LANDING, range: 0 });
    expect(first.warp?.phase).not.toBe('aligning');
    expect(first.warp?.arrival).toBe(true);
    expect(first.warp?.landsIn).toBe(exitTick - world.tick);
    // EntityWarpIn starts the profile WARP_IN_BACKDATE_TICKS in: the first evolve puts it where Destiny's profile is then.
    const remaining = WarpRemainingAt(world.WarpProfile(5000, DISTANCE), WarpInBackdate(at));
    expect(Math.abs(Gap(first.position, LANDING) - remaining) / remaining).toBeLessThan(1e-6);
    expect(remaining).toBeGreaterThan(2_000_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'enter', id: 'r', tick: at + 1, landing: LANDING, warpSpeed: 5, arrival: true });
    expect(Gap(events[0].position, from)).toBeLessThan(0.01);
    expect(Gap(events[0].direction, LANE)).toBeLessThan(1e-9);

    harness.Until(
      () => RequireMotion(world, 'r').arrival?.state === 'landed',
      40,
      () => ExpectLockstep(world, 1)
    );
    expect(world.tick).toBe(exitTick);
    expect(events.map((event) => [event.kind, event.tick, event.arrival])).toEqual([
      ['enter', at + 1, true],
      ['exit', exitTick, true]
    ]);
    const landed = RequireMotion(world, 'r');
    expect(landed.arrival).toMatchObject({ state: 'landed', landedAt: exitTick });
    expect(landed.warp).toMatchObject({ phase: 'landed', arrival: true, progress: 1 });
    expect(world.Arriving('r')).toBe(false);
    harness.Ticks(5);
    const rest = RequireMotion(world, 'r');
    expect(Gap(rest.position, LANDING)).toBeLessThan(1000);
    expect(rest.heading[0]).toBeCloseTo(LANE_YAW, 0);
    for (const park of ['master', 'replica'] as const) expect(world[park].GetBall(1000)?.isMassive).toBe(false);
    expect(world.Order('r', { type: 'stop' })).toBe(true);
    expect(world.ArrivalOf('r')).toBeNull();
  });

  it('switches a running prop mod off as it enters warp', () => {
    const harness = WithShip(ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) }));
    const { world } = harness;
    const events: PropModEvent[] = [];
    world.OnPropMod((event) => events.push(event));
    world.SetPropModActive('r', true);
    expect(world.Arrive('r', { from: From(), landing: LANDING, at: world.tick })).toBe(true);
    harness.Ticks(1);
    expect(RequireMotion(world, 'r').propMod).toMatchObject({ state: 'off', note: 'off: entered warp' });
    expect(events.map((event) => [event.kind, event.cause])).toEqual([
      ['on', 'document'],
      ['off', 'warp']
    ]);
  });

  it('draws the approach along its lane without a jump back, landing where the master does', () => {
    const harness = WithShip();
    const { world } = harness;
    const from = From();
    expect(world.Arrive('r', { from, landing: LANDING, at: world.tick + 1 })).toBe(true);
    harness.Sample('r');
    let along = -Infinity;
    let worst = 0;
    let frames = 0;
    harness.Until(
      () => RequireMotion(world, 'r').arrival?.state === 'landed',
      40,
      undefined,
      () => {
        const drawn = harness.Sample('r').position;
        const offset = [drawn[0] - from[0], drawn[1] - from[1], drawn[2] - from[2]];
        const s = offset[0] * LANE[0] + offset[1] * LANE[1] + offset[2] * LANE[2];
        expect(Number.isFinite(s)).toBe(true);
        // float32 drawn positions a million km out: allow their rounding.
        expect(s).toBeGreaterThanOrEqual(along - Math.max(1, Math.hypot(drawn[0], drawn[1], drawn[2]) * 2e-7));
        worst = Math.max(worst, Math.hypot(offset[0] - LANE[0] * s, offset[1] - LANE[1] * s, offset[2] - LANE[2] * s) / Math.max(1, DISTANCE - s));
        along = Math.max(along, s);
        frames++;
      }
    );
    expect(frames).toBeGreaterThan(60);
    expect(worst).toBeLessThan(1e-3);
    harness.Ticks(4);
    expect(Gap(harness.Sample('r').position, RequireMotion(world, 'r').position)).toBeLessThan(300);
  });

  it('ends at a placement or a new arrival; a ship in its warp-in cannot re-park', () => {
    const harness = WithShip();
    const { world } = harness;
    expect(world.Arrive('r', { from: From(), landing: LANDING, at: null })).toBe(true);
    const far = From(2 * DISTANCE);
    expect(world.Arrive('r', { from: far, landing: LANDING, at: world.tick + 1 })).toBe(true);
    expect(Gap(RequireMotion(world, 'r').position, far)).toBeLessThan(1);
    expect(RequireMotion(world, 'r').arrival?.state).toBe('scheduled');
    world.PlaceShip(Ship('r', [0, 0, 0]));
    expect(world.ArrivalOf('r')).toBeNull();
    harness.Ticks(3);
    expect(RequireMotion(world, 'r')).toMatchObject({ mode: 'stop', position: [0, 0, 0] });

    expect(world.Arrive('r', { from: From(), landing: LANDING, at: world.tick })).toBe(true);
    harness.Ticks(1);
    expect(world.ArrivalRefusal('r', { from: From(), landing: LANDING, at: null })).toBe('ship "r" is in warp');
    world.AddShip(Ship('gone', [0, 0, 0]), rifter);
    expect(world.Arrive('gone', { from: From(), landing: LANDING, at: world.tick + 1 })).toBe(true);
    world.RemoveShip('gone');
    harness.Ticks(2);
  });

  describe('fleets', () => {
    function FollowOf(anchor: string, direction: SceneVector): ShipFollow {
      return { anchor, range: 1000, frame: 'fc', direction, slotRange: 1000, speed: 1 };
    }

    it('lands members ahead of their FC, holds them stopped until it lands, then they fly to their slots', () => {
      const harness = new Harness();
      const { world } = harness;
      const fcLanding = LANDING;
      const memberLanding: SceneVector = [LANDING[0], LANDING[1], LANDING[2] - 3000];
      world.AddShip(Ship('fc', [0, 0, 0]), tfi);
      world.AddShip(Ship('m0', [0, 0, -2000]), rifter);
      expect(world.Follow('m0', FollowOf('fc', [0, 0, -1]))).toBe(true);
      harness.Ticks(6);
      const at = world.tick + 1;
      expect(world.Arrive('fc', { from: From(), landing: fcLanding, at })).toBe(true);
      expect(world.Arrive('m0', { from: From(DISTANCE, memberLanding), landing: memberLanding, at, leader: 'fc' })).toBe(true);
      expect(RequireMotion(world, 'm0').arrival?.landsIn).toBeLessThan(RequireMotion(world, 'fc').arrival?.landsIn ?? 0);

      let held = 0;
      harness.Until(
        () => RequireMotion(world, 'fc').arrival?.state === 'landed',
        80,
        () => {
          ExpectLockstep(world, 2);
          const m0 = RequireMotion(world, 'm0');
          // Steer holds it from the boundary after its exit.
          if (m0.arrival?.state === 'landed' && world.tick > (m0.arrival.landedAt ?? Infinity)) {
            held++;
            expect(world.FollowHold('m0')).toBe('fc');
            expect(Gap(m0.position, memberLanding)).toBeLessThan(1000);
          }
        }
      );
      expect(held).toBeGreaterThan(3);
      harness.Ticks(1);
      const m0 = RequireMotion(world, 'm0');
      expect(m0.arrival).toBeUndefined();
      expect(m0.order).toEqual({ type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 });
      expect(world.FollowHold('m0')).toBeNull();
      harness.Until(
        () => (RequireMotion(world, 'm0').slotError ?? Infinity) <= toFollowTolerance({ slotRange: 1000, anchorSpeed: RequireMotion(world, 'fc').speed }),
        60,
        () => ExpectLockstep(world, 2)
      );
    });

    it('holds a chained logi that landed for its lead, and a present member for an arriving FC', () => {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('fc', [0, 0, 0]), rifter);
      world.AddShip(Ship('lead', [0, 0, -2000]), tfi);
      world.AddShip(Ship('logi', [0, 0, -4000]), guardian);
      world.AddShip(Ship('here', [3000, 0, 0]), rifter);
      expect(world.Follow('lead', FollowOf('fc', [0, 0, -1]))).toBe(true);
      expect(world.Follow('logi', FollowOf('lead', [0, 0, -1]))).toBe(true);
      expect(world.Follow('here', FollowOf('fc', [1, 0, 0]))).toBe(true);
      harness.Ticks(6);
      const at = world.tick + 1;
      const landings: Record<string, SceneVector> = { fc: LANDING, lead: [LANDING[0], 0, LANDING[2] - 2000], logi: [LANDING[0], 0, LANDING[2] - 4000] };
      // The Rifter FC lands first, the Guardian logi next, its TFI lead last.
      for (const id of ['fc', 'lead', 'logi']) expect(world.Arrive(id, { from: From(DISTANCE, landings[id]), landing: landings[id], at, ...(id === 'fc' ? {} : { leader: 'fc' }) })).toBe(true);
      const landsIn = (id: string): number => RequireMotion(world, id).arrival?.landsIn ?? NaN;
      expect(landsIn('fc')).toBeLessThan(landsIn('logi'));
      expect(landsIn('logi')).toBeLessThan(landsIn('lead'));

      const here = RequireMotion(world, 'here').position;
      let logiHeld = 0;
      let hereHeld = 0;
      harness.Until(
        () => RequireMotion(world, 'lead').arrival?.state === 'landed',
        80,
        () => {
          ExpectLockstep(world, 4);
          if (world.Arriving('fc')) {
            hereHeld++;
            expect(world.FollowHold('here')).toBe('fc');
            expect(Gap(RequireMotion(world, 'here').position, here)).toBeLessThan(2000);
          }
          const logi = RequireMotion(world, 'logi').arrival;
          if (logi?.state === 'landed' && world.tick > (logi.landedAt ?? Infinity)) {
            logiHeld++;
            expect(world.FollowHold('logi')).toBe('lead');
            expect(RequireMotion(world, 'logi').speed).toBeLessThan(150);
          }
        }
      );
      expect(hereHeld).toBeGreaterThan(3);
      expect(logiHeld).toBeGreaterThan(3);
      harness.Ticks(1);
      expect(RequireMotion(world, 'lead').arrival).toBeUndefined();
      expect(RequireMotion(world, 'logi').arrival).toBeUndefined();
      expect(RequireMotion(world, 'logi').order).toMatchObject({ type: 'keep-at-range', target: 'lead' });
      // The FC has no follow: it keeps its landed arrival until an order or a placement.
      const fc: Maybe<string> = RequireMotion(world, 'fc').arrival?.state ?? null;
      expect(fc).toBe('landed');
    });
  });
});
