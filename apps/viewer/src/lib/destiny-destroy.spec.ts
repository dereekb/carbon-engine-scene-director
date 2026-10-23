import type { SceneShip, SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld, type PropModEvent, type ShipMotion } from './destiny';
import { ResolveFlight, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) });

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

const FOLLOW = { range: 1000, direction: [1, 0, 0] as SceneVector, slotRange: 1000, speed: 1 };

describe('DestinyWorld.Destroy', () => {
  it('stops the ship on both parks, switches its prop mod off and refuses it from then on', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.AddShip(Ship('b', [0, 0, 20_000]), rifter);
    const events: PropModEvent[] = [];
    world.OnPropMod((event) => events.push(event));
    world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    world.SwitchPropMod('a', true);
    harness.Ticks(4);
    expect(Motion(world, 'a').speed).toBeGreaterThan(0);

    expect(world.IsDestroyed('a')).toBe(false);
    expect(world.Destroy('a')).toEqual([]);
    expect(world.IsDestroyed('a')).toBe(true);
    expect(world.Destroy('a')).toEqual([]);
    expect(events.map((event) => `${event.kind}:${event.cause}`)).toEqual(['on:switch', 'off:destroyed']);
    expect(Motion(world, 'a')).toMatchObject({ order: { type: 'stop' }, orderNote: 'destroyed', propMod: { state: 'off' } });

    expect(world.OrderRefusal('a', { type: 'stop' })).toBe('ship "a" was destroyed');
    expect(world.Order('a', { type: 'stop' })).toBe(false);
    expect(world.OrderRefusal('b', { type: 'approach', target: 'a', speed: 1 })).toBe('target "a" was destroyed');
    expect(world.PropModRefusal('a', true)).toBe('ship "a" was destroyed');
    expect(world.SwitchPropMod('a', true)).toBeNull();
    world.SetPropModActive('a', true);
    expect(Motion(world, 'a').propMod.state).toBe('off');
    expect(world.Follow('a', { ...FOLLOW, anchor: 'b', frame: 'b' })).toBe(false);
    expect(world.Follow('b', { ...FOLLOW, anchor: 'a', frame: 'a' })).toBe(false);
    const before = Motion(world, 'a').position;
    world.PlaceShip(Ship('a', [0, 0, -5000]));
    expect(Motion(world, 'a').position).toEqual(before);
  });

  it('stops the ships following it, ordered at it or queued at it', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('dead', [0, 0, 0]), rifter);
    world.AddShip(Ship('orbiter', [3000, 0, 0]), rifter);
    world.AddShip(Ship('follower', [0, 0, 3000]), rifter);
    world.AddShip(Ship('queued', [0, 3000, 0]), rifter);
    world.AddShip(Ship('bystander', [9000, 0, 0]), rifter);
    world.Order('orbiter', { type: 'orbit', target: 'dead', range: 2000, speed: 1 });
    world.Order('bystander', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    expect(world.Follow('follower', { ...FOLLOW, anchor: 'dead', frame: 'dead' })).toBe(true);
    harness.Ticks(2);
    world.Order('queued', { type: 'approach', target: 'dead', speed: 1 }, { delay: 3 });

    expect(world.Destroy('dead')).toEqual(['orbiter', 'follower', 'queued']);
    for (const id of ['orbiter', 'follower', 'queued']) expect(Motion(world, id), id).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: target "dead" was destroyed' });
    expect(world.Following('follower')).toBeNull();
    expect(Motion(world, 'bystander').order.type).toBe('direction');
    harness.Ticks(4);
    expect(Motion(world, 'queued').order.type).toBe('stop');
  });

  it('RemoveShip takes the ball off later, and the id comes back alive', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Destroy('a');
    harness.Ticks(2);
    expect(world.Curves('a')).toBeTruthy();
    world.RemoveShip('a');
    expect(world.Curves('a')).toBeNull();
    expect(world.IsDestroyed('a')).toBe(false);
    world.AddShip(Ship('a', [100, 0, 0]), rifter);
    expect(world.IsDestroyed('a')).toBe(false);
    expect(world.Order('a', { type: 'stop' })).toBe(true);
  });
});
