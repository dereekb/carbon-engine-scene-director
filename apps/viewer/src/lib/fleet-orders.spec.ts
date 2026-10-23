import type { Maybe } from '@dereekb/util';
import { applySceneOperations, diffScenes, layoutFleetFormation, normalizeFleetOrderRequest, normalizeScene, toFleetOrderOperations, type FleetGroupKind, type SceneDocument, type SceneFleet, type SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { FleetOrders, type FleetOrderResult } from './fleet-orders';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { FleetFollowing } from './following';

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5 } };
const GUARDIAN: PublishedHull = { typeID: 11987, name: 'Guardian', published: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80, warpSpeedMultiplier: 4 } };
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3 } };

const HULLS: Record<string, PublishedHull> = { fc: TFI, wc: RIFTER, d1: RIFTER, d2: RIFTER, d3: RIFTER, l1: GUARDIAN, l2: GUARDIAN };
const FLIGHTS = new Map<string, ShipFlight>(Object.entries(HULLS).map(([id, hull]) => [id, ResolveFlight({ published: hull, hull: null, overrides: null })]));
const WARP = { type: 'warp', point: [0, 0, 400_000] } as const;

const FLEET = {
  id: 'f',
  commander: 'fc',
  wings: [
    {
      id: 'w',
      commander: 'wc',
      squads: [
        { id: 'dps', role: 'dps', commander: 'd1', members: ['d1', 'd2', 'd3'] },
        { id: 'logi', role: 'logi', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 } }
      ]
    }
  ]
};

/**
 * The FC (a TFI) at the origin facing +Z, its wing commander, a dps squad of Rifters (commander d1) and a logi squad
 * of Guardians on its lead l1 at 5 km, every ship in its at-rest slot.
 */
function MakeScene(): SceneDocument {
  const radiusOf = (id: string): number => FLIGHTS.get(id)!.radius;
  const fleet = normalizeScene({ ships: Object.keys(HULLS).map((id) => ({ id, dna: 'mf1_t1:minmatarbase:minmatar' })), fleets: [FLEET] }).scene.fleets![0] as SceneFleet;
  const layout = layoutFleetFormation({ fleet, origin: [0, 0, 0], heading: 0, radiusOf });
  return normalizeScene({ ships: Object.keys(HULLS).map((id) => ({ id, dna: 'mf1_t1:minmatarbase:minmatar', position: layout.get(id) })), fleets: [FLEET] }).scene;
}

/**
 * A world, its FleetFollowing and FleetOrders, driven as the director drives them, in 1 s frames (one tick a call).
 */
class Rig {
  scene: SceneDocument = MakeScene();
  readonly world = new DestinyWorld();
  readonly following = new FleetFollowing({ world: this.world, scene: () => this.scene, radiusOf: (id) => FLIGHTS.get(id)?.radius ?? null });
  readonly orders = new FleetOrders({ world: this.world, following: this.following, scene: () => this.scene });
  now = CLOCK_EPOCH_TICKS;

  constructor() {
    for (const doc of this.scene.ships) this.world.AddShip(doc, FLIGHTS.get(doc.id)!);
    this.following.Reconcile();
    this.Step(3);
  }

  /**
   * order_fleet as Director.OrderFleet runs it: resolve, apply the document ops, then fly.
   */
  Order(request: object): FleetOrderResult {
    const resolved = this.orders.Resolve(normalizeFleetOrderRequest(request, { ships: new Set(this.scene.ships.map((doc) => doc.id)), objects: new Set(this.world.ObjectIds()) }));
    const operations = toFleetOrderOperations(this.scene, resolved);
    if (operations.length) this.Edit(operations);
    return this.orders.Fly(resolved);
  }

  Edit(operations: unknown[]): void {
    const next = applySceneOperations(this.scene, operations).scene;
    const diff = diffScenes(this.scene, next);
    this.scene = next;
    this.following.Reconcile({ regrouped: diff.regrouped.map((doc) => doc.id) });
  }

  Step(seconds: number): void {
    for (let second = 0; second < seconds; second++) {
      this.now += TICKS_PER_SECOND;
      this.world.Tick(this.now);
    }
  }

  Until(done: () => boolean, limit: number, onTick?: () => void): void {
    for (let second = 0; !done(); second++) {
      if (second >= limit) throw new Error(`not done after ${limit} s`);
      this.Step(1);
      onTick?.();
    }
  }

  Command(kind: FleetGroupKind, id: string) {
    return this.orders.GroupReport({ fleet: 'f', kind, id });
  }

  State(id: string): Maybe<string> {
    return this.following.Report(id)?.state;
  }

  Phase(id: string): Maybe<string> {
    return this.world.Motion(id)?.warp?.phase;
  }

  InFormation(ids: readonly string[]): boolean {
    return ids.every((id) => this.State(id) === 'in-formation');
  }
}

const MEMBERS = ['wc', 'd1', 'd2', 'd3', 'l1', 'l2'];

function ShipIds(result: FleetOrderResult): string[] {
  return (result.ships as readonly (string | { readonly id: string })[]).map((ship) => (typeof ship === 'string' ? ship : ship.id));
}

function Gap(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('FleetOrders', () => {
  it('moves the fleet through its FC: members keep following, moving then idle', () => {
    const rig = new Rig();
    expect(rig.InFormation(MEMBERS)).toBe(true);
    expect(rig.Command('fleet', 'f')).toEqual({ state: 'idle', leader: 'fc' });
    const result = rig.Order({ fleet: 'f', order: { type: 'direction', direction: [0, 0, 1] } });
    expect(result).toMatchObject({ fleet: 'f', by: 'fc', leader: 'fc', order: { type: 'direction', direction: [0, 0, 1], speed: 1 }, ships: ['fc', ...MEMBERS] });
    rig.Step(10);
    expect(rig.Command('fleet', 'f')).toMatchObject({ state: 'moving', leader: 'fc', order: { type: 'direction' }, last: { order: { type: 'direction' }, by: 'fc' } });
    for (const id of MEMBERS) expect(rig.world.Following(id)?.frame, id).toBe('fc');
    rig.Order({ fleet: 'f', order: { type: 'stop' } });
    rig.Until(() => rig.Command('fleet', 'f').state === 'idle', 200);
    expect(rig.Command('fleet', 'f').last?.order).toEqual({ type: 'stop' });
  });

  it('moves a squad on its commander: it flies apart until regroup brings it back', () => {
    const rig = new Rig();
    const result = rig.Order({ fleet: 'f', squad: 'dps', order: { type: 'goto', point: [8000, 0, 0] } });
    expect(result).toMatchObject({ squad: 'dps', by: 'd1', leader: 'd1', ships: ['d1', 'd2', 'd3'] });
    expect(rig.world.Following('d1')).toBeNull();
    expect(rig.world.Following('d2')).toMatchObject({ anchor: 'd1', frame: 'd1' });
    expect(rig.following.Report('d1')).toMatchObject({ state: 'leading', group: { kind: 'squad', id: 'dps', leader: 'd1' } });
    rig.Step(3);
    expect(rig.Command('squad', 'dps')).toMatchObject({ state: 'moving', leader: 'd1', away: true, order: { type: 'goto' } });
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'fc' });
    rig.Until(() => rig.Command('squad', 'dps').state === 'broken-off', 200);
    expect(rig.Command('squad', 'dps')).toMatchObject({ leader: 'd1', away: true });
    rig.Until(() => rig.InFormation(['d2', 'd3']), 60);
    expect(rig.following.Report('d2')).toMatchObject({ anchor: 'd1', group: { leader: 'd1' } });

    const back = rig.Order({ fleet: 'f', squad: 'dps', order: { type: 'regroup' } });
    expect(back).toMatchObject({ leader: 'd1', ships: ['d1', 'd2', 'd3'], warping: [] });
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc', frame: 'fc' });
    expect(rig.Command('squad', 'dps')).toMatchObject({ state: 'regrouping', regrouping: 3 });
    rig.Until(() => rig.Command('squad', 'dps').state === 'idle', 300);
    expect(rig.InFormation(['d1', 'd2', 'd3'])).toBe(true);
    expect(rig.Command('squad', 'dps').away).toBeUndefined();
  });

  it('takes a warp only from a commander of the group', () => {
    expect(() => new Rig().Order({ fleet: 'f', by: 'd2', order: WARP })).toThrow(/ship "d2" has no command over fleet "f"/u);
    expect(() => new Rig().Order({ fleet: 'f', wing: 'w', by: 'd1', order: WARP })).toThrow(/ship "d1" has no command over wing "w" of fleet "f"/u);
    expect(() => new Rig().Order({ fleet: 'f', by: 'd1', order: WARP })).toThrow(/no command over fleet "f"/u);
    expect(new Rig().Order({ fleet: 'f', squad: 'dps', by: 'd1', order: WARP })).toMatchObject({ by: 'd1', leader: 'd1' });
    const wing = new Rig().Order({ fleet: 'f', wing: 'w', by: 'wc', order: WARP });
    expect(wing).toMatchObject({ by: 'wc', leader: 'wc', skipped: [] });
    expect(ShipIds(wing)).toEqual(['d1', 'd2', 'd3', 'l1', 'l2']);
  });

  it('warps the fleet in formation, regrouping detached members, skipping ships in warp or too close', () => {
    const rig = new Rig();
    // d3 detached by an order; d2 in its own warp; l2 140 km short of where its slot will land.
    expect(rig.world.Order('d3', { type: 'stop' })).toBe(true);
    expect(rig.following.Detach('d3')).toBe('detached');
    expect(rig.world.Order('d2', { type: 'warp', point: [0, 300_000, 0], range: 0 })).toBe(true);
    rig.following.Detach('d2');
    rig.Until(() => rig.Phase('d2') === 'warping', 30);
    const l2Slot = rig.following.GroupOffsets('f', 'fc', ['l2'])!.get('l2')!;
    const fcAt = rig.world.Motion('fc')!.position;
    rig.world.PlaceShip({ id: 'l2', position: [fcAt[0] + l2Slot[0], fcAt[1] + l2Slot[1], 400_000 + l2Slot[2] - 140_000], rotation: [0, 0, 0] });

    const result = rig.Order({ fleet: 'f', order: WARP });
    expect(result.landing).toEqual([0, 0, 400_000]);
    expect(result.skipped).toEqual([
      { id: 'd2', reason: 'in warp; it keeps its own warp' },
      { id: 'l2', reason: 'its slot is 140 km away; EVE warps only 150 km or more, so it flies there' }
    ]);
    const warping = result.ships as readonly { readonly id: string; readonly landing: SceneVector }[];
    expect(warping.map((ship) => ship.id)).toEqual(['wc', 'd1', 'd3', 'l1']);
    for (const ship of warping) expect(Gap(ship.landing, [0, 0, 400_000]), ship.id).toBeLessThan(10_000);
    expect(rig.State('d3')).toBe('warping');
    expect(rig.world.Following('d3')).toMatchObject({ anchor: 'fc' });
    expect(rig.world.Motion('d2')?.warp?.phase).toBe('warping');
    expect(rig.following.Report('d2')?.state).toBe('detached');

    rig.Step(1);
    expect(rig.Command('fleet', 'f')).toMatchObject({ state: 'warping', warp: { leader: 'fc', aligning: 5, warping: 0, landed: 0, dropped: 0, skipped: 2 } });
    let sawWarping = false;
    rig.Until(
      () => rig.Phase('fc') === 'landed',
      120,
      () => {
        sawWarping ||= (rig.Command('fleet', 'f').warp?.warping ?? 0) > 0;
      }
    );
    expect(sawWarping).toBe(true);
    const landedAt = new Map(['wc', 'd1', 'd3', 'l1'].map((id) => [id, rig.world.Motion(id)!.position]));
    rig.Until(() => rig.InFormation(['wc', 'd1', 'd3', 'l1']), 60);
    for (const [id, at] of landedAt) expect(Gap(rig.world.Motion(id)!.position, at), id).toBeLessThan(3000);
    rig.Until(() => rig.Command('fleet', 'f').state === 'idle', 60);
    expect(rig.Command('fleet', 'f').warp).toBeUndefined();
  });

  it('warps the fleet to an object or a celestial target in formation: every member warps and lands in its slot', () => {
    // A station-sized object and a celestial target: static balls, which the landing prediction reads like a ship's.
    const targets = [
      { id: 'station', position: [0, 0, 600_000] as SceneVector, radius: 5000 },
      { id: 'celestial:60003760', position: [0, 600_000, 0] as SceneVector, radius: 100_000 }
    ];
    for (const target of targets) {
      const rig = new Rig();
      rig.world.AddObject(target, target.radius);
      const result = rig.Order({ fleet: 'f', order: { type: 'warp', target: target.id, range: 10_000 } });
      // The FC lands both radii plus the range short of the centre.
      expect(Gap(result.landing as SceneVector, target.position), target.id).toBeCloseTo(10_000 + target.radius + FLIGHTS.get('fc')!.radius, -1);
      expect(result.skipped, target.id).toEqual([]);
      const warping = result.ships as readonly { readonly id: string; readonly landing: SceneVector }[];
      expect(
        warping.map((ship) => ship.id),
        target.id
      ).toEqual(MEMBERS);
      rig.Until(() => rig.Phase('fc') === 'landed', 150);
      rig.Until(() => rig.InFormation(MEMBERS), 90);
      for (const ship of warping) expect(Gap(rig.world.Motion(ship.id)!.position, ship.landing), `${target.id} ${ship.id}`).toBeLessThan(3000);
    }
  });

  it('leaves a tackled member out of a fleet warp, regrouped, and refuses a warp a tackled FC leads', () => {
    const rig = new Rig();
    const pointed = 'warp scramble status 1 (red: Warp Disruptor II (mid-0) +1): above 0 it cannot warp';
    rig.world.SetTackle('d1', { warp: pointed, propMod: null });
    const result = rig.Order({ fleet: 'f', order: WARP });
    expect(result.skipped).toEqual([{ id: 'd1', reason: `cannot warp: ${pointed}` }]);
    expect((result.ships as readonly { readonly id: string }[]).map((ship) => ship.id)).not.toContain('d1');
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc' });
    rig.Step(1);
    expect(rig.world.FormationWarpOf('d1')).toBeNull();
    rig.world.SetTackle('fc', { warp: pointed, propMod: null });
    expect(() => rig.Order({ fleet: 'f', order: WARP })).toThrow(`ship "fc" cannot warp: ${pointed}`);
  });

  it('warps a squad apart on its lead, and a far regroup warps it back in formation', () => {
    const rig = new Rig();
    const result = rig.Order({ fleet: 'f', squad: 'logi', order: { type: 'warp', point: [300_000, 0, 0] } });
    expect(result).toMatchObject({ by: 'wc', leader: 'l1', skipped: [] });
    expect(ShipIds(result)).toEqual(['l2']);
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc' });
    rig.Until(() => rig.Phase('l1') === 'landed' && rig.State('l2') === 'in-formation', 120);
    expect(rig.following.Report('l2')).toMatchObject({ anchor: 'l1', group: { kind: 'squad', id: 'logi', leader: 'l1' } });
    expect(Gap(rig.world.Motion('l1')!.position, [300_000, 0, 0])).toBeLessThan(2000);
    expect(rig.Command('squad', 'logi')).toMatchObject({ away: true, leader: 'l1' });
    expect(rig.Command('fleet', 'f').state).toBe('idle');

    const back = rig.Order({ fleet: 'f', squad: 'logi', order: { type: 'regroup' } });
    expect(back.warping).toEqual(['l1', 'l2']);
    expect(rig.State('l2')).toBe('warping');
    expect(rig.Command('squad', 'logi').state).toBe('regrouping');
    rig.Until(() => rig.InFormation(['l1', 'l2']), 120);
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'fc', frame: 'fc' });
    expect(Gap(rig.world.Motion('l1')!.position, rig.world.Motion('fc')!.position)).toBeLessThan(10_000);
    rig.Until(() => rig.Command('squad', 'logi').state === 'idle', 30);
  });

  it('staggers a delayed fleet warp: each pilot aligns after its own delay, and the fleet still lands in formation', () => {
    const rig = new Rig();
    const result = rig.Order({ fleet: 'f', delay: 1, order: WARP });
    const delays = result.delays!;
    expect(Object.keys(delays)).toEqual(['fc', ...MEMBERS]);
    expect(delays['fc']).toBe(0);
    expect(new Set(Object.values(delays)).size).toBeGreaterThan(2);
    const ticks = new Map<string, number>();
    for (let second = 1; ticks.size < MEMBERS.length + 1 && second <= 30; second++) {
      rig.Step(1);
      for (const id of ['fc', ...MEMBERS]) if (!ticks.has(id) && rig.world.Motion(id)?.mode === 'warp') ticks.set(id, second);
    }
    for (const id of ['fc', ...MEMBERS]) expect(ticks.get(id), id).toBe(delays[id] + 1);
    rig.Until(() => rig.Phase('fc') === 'landed', 120);
    rig.Until(() => rig.InFormation(MEMBERS), 90);
    rig.Until(() => rig.Command('fleet', 'f').state === 'idle', 60);
  });

  it('records document orders: break-off sets the home, regroup restores it', () => {
    const rig = new Rig();
    const broken = rig.Order({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: 12000 } });
    expect(broken).toMatchObject({ by: 'wc', leader: 'l1', order: { type: 'break-off', range: 12000 } });
    const logi = () => rig.scene.fleets![0].wings[0].squads[1];
    expect(logi()).toMatchObject({ anchor: { ship: 'l1', range: 12000 }, home: { ship: 'l1', range: 5000 } });
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'fc', range: 12000 });
    expect(rig.Command('squad', 'logi')).toMatchObject({ state: 'broken-off', home: { ship: 'l1', range: 5000 }, last: { order: { type: 'break-off' }, by: 'wc' } });

    rig.Order({ fleet: 'f', squad: 'logi', order: { type: 'regroup' } });
    expect(logi()).toEqual({ id: 'logi', role: 'logi', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 } });
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'fc', range: 5000 });
    expect(rig.Command('squad', 'logi').home).toBeUndefined();

    rig.Order({ fleet: 'f', order: { type: 'anchor', range: 2000 } });
    expect(rig.world.Following('d2')).toMatchObject({ anchor: 'fc', range: 2000 });
    expect(rig.Command('fleet', 'f').last?.order).toEqual({ type: 'anchor', range: 2000 });
  });

  it("records a targets order, at its given tick, and leaves the group's following alone", () => {
    const rig = new Rig();
    const before = MEMBERS.map((id) => rig.world.Following(id));
    const called = rig.Order({ fleet: 'f', squad: 'dps', order: { type: 'targets', set: ['l1', 'l2'] } });
    expect(called).toMatchObject({ by: 'd1', leader: 'd1', order: { type: 'targets', set: ['l1', 'l2'] }, ships: ['d1', 'd2', 'd3'] });
    expect(rig.scene.fleets![0].wings[0].squads[0].targets).toEqual(['l1', 'l2']);
    expect(MEMBERS.map((id) => rig.world.Following(id))).toEqual(before);
    expect(rig.Command('squad', 'dps')).toMatchObject({ state: 'idle', last: { order: { type: 'targets' }, by: 'd1', tick: called.tick } });

    const cleared = rig.orders.Fly(rig.orders.Resolve(normalizeFleetOrderRequest({ fleet: 'f', squad: 'dps', delay: 1, order: { type: 'targets', clear: true } })), { tick: called.tick - 5 });
    expect(cleared.tick).toBe(called.tick - 5);
    expect(Object.keys(cleared.delays ?? {})).toEqual(['d1', 'd2', 'd3']);
    expect(rig.Command('squad', 'dps').last).toMatchObject({ order: { type: 'targets', clear: true }, tick: called.tick - 5 });
  });

  it('refuses a wing or squad move or a warp on an unplanned fleet, and Reset forgets every record', () => {
    const rig = new Rig();
    const waiting = new FleetFollowing({ world: rig.world, scene: () => rig.scene, radiusOf: (id) => (id === 'l2' ? null : (FLIGHTS.get(id)?.radius ?? null)) });
    const orders = new FleetOrders({ world: rig.world, following: waiting, scene: () => rig.scene });
    const resolve = (request: object) => orders.Resolve(normalizeFleetOrderRequest(request));
    expect(() => orders.Fly(resolve({ fleet: 'f', order: WARP }))).toThrow(/fleet "f" is not planned yet/u);
    expect(() => orders.Fly(resolve({ fleet: 'f', squad: 'dps', order: { type: 'stop' } }))).toThrow(/is not planned yet/u);
    expect(() => orders.Fly(resolve({ fleet: 'f', order: { type: 'warp', point: [0, 0, 1000] } }))).toThrow(/would land 1 km away/u);

    rig.Order({ fleet: 'f', squad: 'dps', order: { type: 'goto', point: [8000, 0, 0] } });
    expect(rig.Command('squad', 'dps').last).toBeDefined();
    rig.orders.Reset();
    expect(rig.Command('squad', 'dps').last).toBeUndefined();
  });
});
