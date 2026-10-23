import type { Maybe } from '@dereekb/util';
import { layoutFleetFormation, normalizeFleetOrderRequest, normalizeScene, normalizeShipOrder, toLiveFleetScene, type SceneDocument, type SceneFleet, type SceneVector, type ShipOrder } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { FleetOrders } from './fleet-orders';
import { CaptureFleetHeirs, HeirOrderOf, InheritFleetOrders, type FleetHeir, type FleetInheritance } from './fleet-succession';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { FleetFollowing } from './following';

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5 } };
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3 } };

const HULLS: Record<string, PublishedHull> = { fc: TFI, wc: TFI, d1: TFI, d2: RIFTER, d3: RIFTER, x: RIFTER };
const FLIGHTS = new Map<string, ShipFlight>(Object.entries(HULLS).map(([id, hull]) => [id, ResolveFlight({ published: hull, hull: null, overrides: null })]));
const DNA = 'mf1_t1:minmatarbase:minmatar';

const FLEET = { id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'wc', squads: [{ id: 'dps', role: 'dps', commander: 'd1', members: ['d1', 'd2', 'd3'] }] }] };

/**
 * The FC (a TFI) at the origin facing +Z, its wing commander (a TFI, in no squad: it anchors up on the FC) and a dps
 * squad, every ship in its at-rest slot; `x` (a Rifter, in no fleet) 20 km off to the side.
 */
function MakeScene(): SceneDocument {
  const fleetIds = ['fc', 'wc', 'd1', 'd2', 'd3'];
  const radiusOf = (id: string): number => FLIGHTS.get(id)!.radius;
  const fleet = normalizeScene({ ships: fleetIds.map((id) => ({ id, dna: DNA })), fleets: [FLEET] }).scene.fleets![0] as SceneFleet;
  const layout = layoutFleetFormation({ fleet, origin: [0, 0, 0], heading: 0, radiusOf });
  return normalizeScene({ ships: [...fleetIds.map((id) => ({ id, dna: DNA, position: layout.get(id) })), { id: 'x', dna: DNA, position: [20_000, 0, 0] }], fleets: [FLEET] }).scene;
}

/**
 * A world with its FleetFollowing and FleetOrders over the live fleets (the destroyed taken out), killing as
 * Director.Destroy does: inside a boundary listener, the heirs captured before DestinyWorld.Destroy and ordered on
 * after the re-plan.
 */
class Rig {
  readonly scene: SceneDocument = MakeScene();
  readonly world = new DestinyWorld();
  readonly gone = new Set<string>();
  readonly following = new FleetFollowing({ world: this.world, scene: () => this.Live(), radiusOf: (id) => FLIGHTS.get(id)?.radius ?? null });
  readonly orders = new FleetOrders({ world: this.world, following: this.following, scene: () => this.Live() });
  inherited: FleetInheritance[] = [];
  now = CLOCK_EPOCH_TICKS;
  private killing: Maybe<string> = null;

  constructor() {
    for (const doc of this.scene.ships) this.world.AddShip(doc, FLIGHTS.get(doc.id)!);
    this.world.OnBoundary(() => {
      if (this.killing) this.Kill(this.killing);
      this.killing = null;
    });
    this.following.Reconcile();
    this.Step(3);
  }

  private live: Maybe<{ readonly gone: number; readonly view: SceneDocument }> = null;

  /**
   * The document as the fleets fly it (Director.LiveFleets), memoized on the deaths.
   */
  Live(): SceneDocument {
    if (this.live?.gone !== this.gone.size) this.live = { gone: this.gone.size, view: toLiveFleetScene(this.scene, this.gone).scene };
    return this.live.view;
  }

  OrderFleet(order: object): void {
    const request = normalizeFleetOrderRequest({ fleet: 'f', order }, { ships: new Set(this.scene.ships.map((doc) => doc.id)) });
    this.orders.Fly(this.orders.Resolve(request));
  }

  /**
   * Director.Destroy's fleet half.
   */
  Kill(id: string): void {
    const commanded = (this.Live().fleets ?? []).filter((fleet) => fleet.commander === id).map((fleet) => fleet.id);
    this.gone.add(id);
    const fleets = this.Live().fleets ?? [];
    const heirs = CaptureFleetHeirs(
      this.world,
      id,
      commanded.flatMap((fleet) => {
        const heir = fleets.find((candidate) => candidate.id === fleet)?.commander;
        return heir ? [[fleet, heir] as const] : [];
      })
    );
    this.world.Destroy(id);
    this.following.Reconcile();
    this.inherited = InheritFleetOrders(this.world, heirs);
  }

  /**
   * Kills a ship at the next boundary, as combat does, and steps through it.
   */
  KillAtBoundary(id: string): void {
    this.killing = id;
    this.Step(1);
  }

  Step(seconds: number): void {
    for (let second = 0; second < seconds; second++) {
      this.now += TICKS_PER_SECOND;
      this.world.Tick(this.now);
    }
  }

  Speed(id: string): number {
    return this.world.Motion(id)?.speed ?? 0;
  }
}

function Unit(vector: ArrayLike<number>): SceneVector {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

const NORTH = normalizeShipOrder({ type: 'direction', direction: [0, 0, 1] });

describe('fleet succession: the FC dies, the fleet flies on', () => {
  it("the heir inherits the FC's order at the death boundary: its speed never drops and the fleet re-forms on it", () => {
    const rig = new Rig();
    rig.OrderFleet({ type: 'direction', direction: [0, 0, 1] });
    rig.Step(40);
    const before = rig.Speed('wc');
    expect(before).toBeGreaterThan(100);

    rig.KillAtBoundary('fc');
    expect(rig.inherited).toEqual([{ fleet: 'f', heir: 'wc', order: NORTH, delay: 0, source: 'inherited' }]);
    expect(rig.world.Motion('wc')?.order).toEqual(NORTH);
    expect(rig.Live().fleets?.[0].commander).toBe('wc');
    const speeds = [rig.Speed('wc')];
    for (let second = 0; second < 5; second++) {
      rig.Step(1);
      speeds.push(rig.Speed('wc'));
    }
    // Halted, it would lose 8 % of its speed in the first tick (a TFI's 11.9 s agility time constant).
    for (const speed of speeds) expect(speed).toBeGreaterThanOrEqual(before * 0.98);
    for (const id of ['d1', 'd2', 'd3']) {
      expect(rig.following.Report(id)?.anchor).toBe('wc');
      expect(rig.Speed(id)).toBeGreaterThan(50);
    }
  });

  it('an FC flying at the heir hands it on along its velocity instead', () => {
    const rig = new Rig();
    rig.world.Order('fc', normalizeShipOrder({ type: 'direction', direction: [1, 0, 1] }));
    rig.Step(30);
    rig.world.Order('fc', normalizeShipOrder({ type: 'approach', target: 'wc' }));
    rig.Step(1);
    const motion = rig.world.Motion('fc')!;
    expect(motion.speed).toBeGreaterThan(50);

    rig.KillAtBoundary('fc');
    expect(rig.inherited).toHaveLength(1);
    const [inherited] = rig.inherited;
    expect(inherited.source).toBe('along');
    expect(inherited.order.type).toBe('direction');
    const direction = inherited.order.type === 'direction' ? inherited.order.direction : [0, 0, 0];
    const along = Unit(motion.velocity);
    for (let axis = 0; axis < 3; axis++) expect(direction[axis]).toBeCloseTo(along[axis], 1);
  });

  it('an FC aligning to warp hands the heir a direction toward its landing; the members re-form on the heir', () => {
    const rig = new Rig();
    rig.world.Order('fc', normalizeShipOrder({ type: 'warp', point: [0, 0, 400_000] }));
    rig.Step(3);
    expect(rig.world.Motion('fc')?.warp?.phase).toBe('aligning');

    rig.KillAtBoundary('fc');
    expect(rig.inherited.map((entry) => entry.source)).toEqual(['landing']);
    const order = rig.world.Motion('wc')!.order;
    expect(order.type).toBe('direction');
    if (order.type === 'direction') expect(order.direction[2]).toBeGreaterThan(0.99);
    rig.Step(3);
    expect(rig.world.Motion('wc')?.warp).toBeUndefined();
    expect(rig.following.Report('d2')?.anchor).toBe('wc');
  });

  it('a detached heir keeps its own order; a stopped FC hands on nothing', () => {
    const detached = new Rig();
    detached.OrderFleet({ type: 'direction', direction: [0, 0, 1] });
    detached.world.Order('wc', normalizeShipOrder({ type: 'direction', direction: [1, 0, 0] }));
    detached.following.Detach('wc');
    detached.Step(5);
    detached.KillAtBoundary('fc');
    expect(detached.inherited).toEqual([]);
    expect(detached.world.Motion('wc')?.order).toEqual(normalizeShipOrder({ type: 'direction', direction: [1, 0, 0] }));

    const stopped = new Rig();
    stopped.KillAtBoundary('fc');
    expect(stopped.inherited).toEqual([]);
    expect(stopped.world.Motion('wc')?.order.type).toBe('stop');
  });
});

describe('HeirOrderOf', () => {
  const MOTION: FleetHeir['motion'] = { order: NORTH, velocity: [0, 0, 100], speed: 100, physics: { mass: 1, agility: 1, maxVelocity: 200, radius: 50 } };
  const HEIR: FleetHeir = { fleet: 'f', dead: 'fc', heir: 'wc', motion: MOTION, position: [0, 0, 0], inFormation: true };
  const NONE = (): Maybe<string> => null;

  it('carries a pending order with its response delay over the applied one', () => {
    const pendingOrder: ShipOrder = normalizeShipOrder({ type: 'goto', point: [0, 0, 9000] });
    expect(HeirOrderOf({ ...HEIR, motion: { ...MOTION, pendingOrder, respondsIn: 3 } }, NONE)).toEqual({ order: pendingOrder, delay: 3, source: 'inherited' });
    expect(HeirOrderOf(HEIR, NONE)).toEqual({ order: NORTH, delay: 0, source: 'inherited' });
  });

  it('falls back along the velocity at speed over max velocity for a refused order, and to nothing below SETTLE_SPEED', () => {
    const refused = HeirOrderOf(HEIR, (order) => (order.type === 'direction' && order.direction[0] === 0 && order.speed === 1 ? 'refused' : null));
    expect(refused).toEqual({ order: { type: 'direction', direction: [0, 0, 1], speed: 0.5 }, delay: 0, source: 'along' });
    const slow = { ...HEIR, motion: { ...MOTION, order: normalizeShipOrder({ type: 'orbit', target: 'wc', range: 1000 }), velocity: [0, 0, 0.5] as SceneVector, speed: 0.5 } };
    expect(HeirOrderOf(slow, NONE)).toBeNull();
  });

  it('inherits nothing from a stop, and nothing for an heir out of formation', () => {
    expect(HeirOrderOf({ ...HEIR, motion: { ...MOTION, order: normalizeShipOrder({ type: 'stop' }) } }, NONE)).toBeNull();
    expect(HeirOrderOf({ ...HEIR, inFormation: false }, NONE)).toBeNull();
  });
});
