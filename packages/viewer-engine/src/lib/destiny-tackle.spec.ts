import type { SceneShip, SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld, FIRST_SHIP_BALL_ID, type PropModEvent, type ShipMotion, type WarpEvent } from './destiny';
import { ResolveFlight, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3, rigSize: 3 } };

const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) });
const tfi = ResolveFlight({ published: TFI, hull: null, overrides: null });

const AWAY: SceneVector = [0, 0, 500_000];
const POINTED = 'warp scramble status 1 (tackle: Warp Disruptor II (mid-0) +1): above 0 it cannot warp';
const SCRAMMED = 'a warp scrambler blocks its microwarpdrive (tackle: Warp Scrambler II (mid-1))';

/**
 * A world driven the way the page drives it: one clock, the parks evolved to it.
 */
class Harness {
  readonly world = new DestinyWorld();
  now = CLOCK_EPOCH_TICKS;

  Ticks(count: number): void {
    const end = this.world.tick + count;
    while (this.world.tick < end) {
      this.now += FRAME_TICKS;
      this.world.Tick(this.now);
    }
  }
}

function Ship(id: string, position: SceneVector): Pick<SceneShip, 'id' | 'position' | 'rotation'> {
  return { id, position, rotation: [0, 0, 0] };
}

function Motion(world: DestinyWorld, id: string): ShipMotion {
  const motion = world.Motion(id);
  if (!motion) throw new Error(`no motion for ${id}`);
  return motion;
}

function SameParks(world: DestinyWorld, ballId: number): void {
  const master = world.master.GetBall(ballId);
  const replica = world.replica.GetBall(ballId);
  expect(master && replica).toBeTruthy();
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'mode', 'maxVelocity'] as const) expect(replica?.[key]).toBe(master?.[key]);
}

describe('DestinyWorld tackle: warp', () => {
  it('refuses a warp order while pointed and takes it once the point is gone', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.SetTackle('a', { warp: POINTED, propMod: null });
    expect(world.Tackle('a')).toEqual({ warp: POINTED, propMod: null });
    expect(world.OrderRefusal('a', { type: 'warp', point: AWAY, range: 0 })).toBe(`ship "a" cannot warp: ${POINTED}`);
    expect(world.Order('a', { type: 'warp', point: AWAY, range: 0 })).toBe(false);
    expect(world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 })).toBe(true);
    world.SetTackle('a', { warp: null, propMod: null });
    expect(world.Order('a', { type: 'warp', point: AWAY, range: 0 })).toBe(true);
    harness.Ticks(1);
    expect(Motion(world, 'a').order).toMatchObject({ type: 'warp' });
  });

  it('drops a pending or delayed warp order when the point lands, keeping the current order', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.Ticks(1);
    world.Order('a', { type: 'warp', point: AWAY, range: 0 }, { delay: 3 });
    world.SetTackle('a', { warp: POINTED, propMod: null });
    harness.Ticks(4);
    const motion = Motion(world, 'a');
    expect(motion.pendingOrder ?? null).toBeNull();
    expect(motion.order).toMatchObject({ type: 'direction' });
    expect(motion.orderNote).toBe(`dropped: the warp order (${POINTED})`);
  });

  it('cancels a warp still aligning into a direction order along it, on both parks, before the evolve that would start it', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    const warps: WarpEvent[] = [];
    world.OnWarp((event) => warps.push(event));
    world.Order('a', { type: 'warp', point: AWAY, range: 0 });
    harness.Ticks(2);
    expect(Motion(world, 'a').warp?.phase).toBe('aligning');
    const stop = world.OnBoundary(() => world.SetTackle('a', { warp: POINTED, propMod: null }));
    harness.Ticks(1);
    stop();
    const motion = Motion(world, 'a');
    expect(motion.order).toEqual({ type: 'direction', direction: [0, 0, 1], speed: 1 });
    expect(motion.orderNote).toBe(`warp cancelled: ${POINTED}`);
    expect(motion.warp ?? null).toBeNull();
    harness.Ticks(10);
    expect(warps).toEqual([]);
    expect(Motion(world, 'a').speed).toBeGreaterThan(0.9 * rifter.maxVelocity);
    SameParks(world, FIRST_SHIP_BALL_ID);
  });

  it('drops a formation warp: the member follows again while its leader warps', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    world.AddShip(Ship('m0', [0, 0, -1281]), rifter);
    expect(world.Follow('m0', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 })).toBe(true);
    harness.Ticks(3);
    expect(world.Order('fc', { type: 'warp', point: AWAY, range: 0 })).toBe(true);
    expect(world.WarpInFormation('m0', { leader: 'fc', offset: [0, 0, -1281] })).toBe(true);
    harness.Ticks(1);
    expect(Motion(world, 'm0').warp?.phase).toBe('aligning');
    world.SetTackle('m0', { warp: POINTED, propMod: null });
    expect(world.FormationWarpOf('m0')).toBeNull();
    expect(Motion(world, 'm0').orderNote).toBe(`dropped: its formation warp (${POINTED})`);
    expect(Motion(world, 'm0').order).toMatchObject({ type: 'keep-at-range', target: 'fc' });
    expect(world.Following('m0')).not.toBeNull();
    for (let tick = 0; tick < 40 && Motion(world, 'fc').warp?.phase !== 'warping'; tick++) harness.Ticks(1);
    expect(Motion(world, 'fc').warp?.phase).toBe('warping');
    harness.Ticks(1);
    expect(world.InWarp('m0')).toBe(false);
    expect(world.FollowHold('m0')).toBe('fc');
    SameParks(world, FIRST_SHIP_BALL_ID + 1);
  });

  it('keeps tackle across a placement', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.SetTackle('a', { warp: POINTED, propMod: SCRAMMED });
    world.PlaceShip(Ship('a', [5000, 0, 0]));
    expect(world.Tackle('a')).toEqual({ warp: POINTED, propMod: SCRAMMED });
    world.SetTackle('a', { warp: null, propMod: null });
    expect(world.Tackle('a')).toEqual({ warp: null, propMod: null });
    world.RemoveShip('a');
    expect(world.Tackle('a')).toBeNull();
  });
});

describe('DestinyWorld tackle: the microwarpdrive', () => {
  function Cruising(): { harness: Harness; world: DestinyWorld; events: PropModEvent[] } {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    harness.Ticks(5);
    const events: PropModEvent[] = [];
    world.OnPropMod((event) => events.push(event));
    return { harness, world, events };
  }

  it('switches a running MWD off at once with an off event, on both parks', () => {
    const { harness, world, events } = Cruising();
    world.SwitchPropMod('a', true);
    harness.Ticks(1);
    expect(Motion(world, 'a').propMod?.state).toBe('active');
    world.SetTackle('a', { warp: null, propMod: SCRAMMED });
    expect(events.map((event) => `${event.kind}:${event.cause}`)).toEqual(['on:switch', 'off:tackle']);
    expect(Motion(world, 'a').propMod).toMatchObject({ state: 'off', note: `off: ${SCRAMMED}` });
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.maxVelocity).toBe(Math.fround(rifter.maxVelocity));
    SameParks(world, FIRST_SHIP_BALL_ID);
    world.SetTackle('a', { warp: null, propMod: null });
    harness.Ticks(2);
    expect(Motion(world, 'a').propMod?.state).toBe('off');
  });

  it('refuses switching on, keeps the document state off, and notes a queued switch-on at its boundary', () => {
    const { harness, world, events } = Cruising();
    world.SwitchPropMod('a', true, { delay: 2 });
    world.SetTackle('a', { warp: null, propMod: SCRAMMED });
    expect(world.PropModRefusal('a', true)).toBe(`ship "a" cannot switch its prop mod on: ${SCRAMMED}`);
    expect(world.PropModRefusal('a', false)).toBeNull();
    expect(world.SwitchPropMod('a', true)).toBeNull();
    harness.Ticks(3);
    expect(Motion(world, 'a').propMod).toMatchObject({ state: 'off', note: `not switched on: ship "a" cannot switch its prop mod on: ${SCRAMMED}` });
    world.SetPropModActive('a', true);
    expect(Motion(world, 'a').propMod).toMatchObject({ state: 'off', note: `not switched on: ${SCRAMMED}` });
    expect(events).toEqual([]);
    world.SetTackle('a', { warp: null, propMod: null });
    expect(world.SwitchPropMod('a', true)).toMatchObject({ state: 'activating' });
  });
});
