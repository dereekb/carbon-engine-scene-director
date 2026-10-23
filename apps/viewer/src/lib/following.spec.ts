import type { Maybe } from '@dereekb/util';
import { applySceneOperations, diffScenes, normalizeScene, toFleetFollowPlans, toFleetGroupFollowPlans, toFleetGroupOffsets, type FleetGroupKind, type SceneDocument } from '@scene-director/scene';
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld, type ShipPhysics } from './destiny';
import { FleetFollowing } from './following';
import { RoundTrip } from './state-capture.spec-helper';

const PHYSICS: ShipPhysics = { mass: 1.2e6, agility: 3.2, maxVelocity: 400, radius: 40 };
const RIFTER = 'mf1_t1:minmatarbase:minmatar';

/**
 * An FC, a DPS squad of two on the FC, a logi squad of two on its own lead at 5 km, a spare ship and a loner.
 */
function MakeScene(): SceneDocument {
  return normalizeScene({
    ships: ['fc', 'd1', 'd2', 'l1', 'l2', 'spare', 'loner'].map((id, index) => ({ id, dna: RIFTER, position: id === 'fc' ? [0, 0, 0] : [3000 * index, 0, -2000 * index] })),
    fleets: [
      {
        id: 'f',
        commander: 'fc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'dps', role: 'dps', members: ['d1', 'd2'] },
              { id: 'logi', role: 'logi', commander: 'l1', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 } }
            ]
          }
        ]
      }
    ]
  }).scene;
}

/**
 * A world and a FleetFollowing driven the way the director drives them.
 */
class Rig {
  scene: SceneDocument = MakeScene();
  readonly world = new DestinyWorld();
  readonly radii = new Map<string, Maybe<number>>();
  readonly following = new FleetFollowing({ world: this.world, scene: () => this.scene, radiusOf: (id) => (this.radii.has(id) ? this.radii.get(id) : PHYSICS.radius) });
  now = CLOCK_EPOCH_TICKS;

  constructor() {
    for (const doc of this.scene.ships) this.world.AddShip(doc, PHYSICS);
  }

  Edit(operations: unknown[]): string[] {
    const next = applySceneOperations(this.scene, operations).scene;
    const diff = diffScenes(this.scene, next);
    const stopped: string[] = [];
    for (const doc of diff.removed) stopped.push(...this.world.RemoveShip(doc.id));
    this.scene = next;
    for (const doc of diff.moved) this.world.PlaceShip(doc);
    stopped.push(...this.following.Reconcile({ regrouped: diff.regrouped.map((doc) => doc.id) }));
    return stopped;
  }

  Run(seconds: number): void {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      this.now += Math.round(TICKS_PER_SECOND / 60);
      this.world.Tick(this.now);
    }
  }
}

describe('FleetFollowing', () => {
  it('follows every member but the FC with its plan, and nothing else', () => {
    const rig = new Rig();
    expect(rig.following.Reconcile()).toEqual([]);
    const fleet = rig.scene.fleets![0];
    const plans = toFleetFollowPlans({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: () => PHYSICS.radius });
    for (const id of ['d1', 'd2', 'l1', 'l2']) {
      const plan = plans.get(id)!;
      expect(rig.world.Following(id), id).toEqual({ anchor: plan.anchor.ship, range: plan.anchor.range, frame: 'fc', direction: plan.slot.direction, slotRange: plan.slot.range, speed: 1 });
    }
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'fc', range: 5000 });
    expect(rig.world.Following('l2')).toMatchObject({ anchor: 'l1', range: 1000 });
    for (const id of ['fc', 'spare', 'loner']) expect(rig.world.Following(id), id).toBeNull();
  });

  it('waits for settled radii, then follows, and keeps the follows when the fleet is unready again', () => {
    const rig = new Rig();
    rig.radii.set('d2', null);
    rig.following.Reconcile();
    expect(rig.world.Following('d1')).toBeNull();
    expect(rig.following.Report('d1')).toEqual({ state: 'waiting', anchor: 'fc', range: 1000 });
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toMatchObject({ ready: false, following: 4, waiting: 4 });

    rig.radii.delete('d2');
    rig.following.Reconcile();
    const follow = rig.world.Following('d1');
    expect(follow).toMatchObject({ anchor: 'fc', frame: 'fc' });

    rig.radii.set('l2', null);
    expect(rig.following.Reconcile()).toEqual([]);
    expect(rig.world.Following('d1')).toBe(follow);
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' }).ready).toBe(false);
  });

  it('detaches a member on an order and rejoins it, and refuses to rejoin the FC or a ship in no fleet', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    expect(rig.world.Order('d1', { type: 'stop' })).toBe(true);
    expect(rig.following.Detach('d1')).toBe('detached');
    expect(rig.following.Detach('fc')).toBeNull();
    expect(rig.following.Detach('loner')).toBeNull();
    expect(rig.following.Report('d1')).toEqual({ state: 'detached', anchor: 'fc', range: 1000 });
    expect(rig.following.Reconcile()).toEqual([]);
    expect(rig.world.Following('d1')).toBeNull();

    const report = rig.following.Rejoin('d1');
    expect(report).toMatchObject({ anchor: 'fc', range: 1000, slot: { range: 1000 } });
    expect(report.state).not.toBe('detached');
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc' });
    expect(() => rig.following.Rejoin('fc')).toThrow(/follows nobody/u);
    expect(() => rig.following.Rejoin('loner')).toThrow(/in no fleet/u);
  });

  it('clears the detached state on a regroup or a restart, but not on a placement', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    for (const id of ['d1', 'd2']) {
      rig.world.Order(id, { type: 'stop' });
      rig.following.Detach(id);
    }
    rig.Edit([{ op: 'update_ship', id: 'd2', set: { position: [100, 0, -9000] } }]);
    expect(rig.following.Report('d2')?.state).toBe('detached');
    rig.Edit([{ op: 'move_to_squad', ships: ['d1'], fleet: 'f', squad: 'logi' }]);
    expect(rig.following.Report('d1')?.state).not.toBe('detached');
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'l1', range: 1000 });
    expect(rig.following.Report('d2')?.state).toBe('detached');
    rig.following.Reconcile({ restart: true });
    expect(rig.following.Report('d2')?.state).not.toBe('detached');
  });

  it('stops ships whose following ends, with a note, and re-anchors the followers of a removed lead', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    expect(rig.Edit([{ op: 'remove_from_fleet', ships: ['d1'] }])).toEqual(['d1']);
    expect(rig.world.Motion('d1')?.orderNote).toBe('stopped: no longer following (it left fleet "f")');

    expect(rig.Edit([{ op: 'remove_ship', id: 'l1' }])).toEqual([]);
    expect(rig.world.Following('l2')).toMatchObject({ anchor: 'fc', range: 5000 });

    expect(rig.Edit([{ op: 'update_fleet', fleet: 'f', set: { commander: 'd2' } }])).toEqual(['d2']);
    expect(rig.world.Motion('d2')?.orderNote).toBe('stopped: no longer following (it is the fleet commander of "f")');
    expect(rig.world.Following('l2')).toMatchObject({ frame: 'd2' });

    expect(rig.Edit([{ op: 'remove_fleet', fleet: 'f' }])).toEqual(['l2']);
    expect(rig.world.Motion('l2')?.orderNote).toBe('stopped: no longer following (fleet "f" was removed)');
  });

  it('issues nothing on a reconcile that changes nothing', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    const follow = vi.spyOn(rig.world, 'Follow');
    const unfollow = vi.spyOn(rig.world, 'Unfollow');
    rig.following.Reconcile();
    rig.Edit([{ op: 'update_ship', id: 'loner', set: { name: 'Loner' } }]);
    expect(follow).not.toHaveBeenCalled();
    expect(unfollow).not.toHaveBeenCalled();
  });

  it('leaves piloted members alone, keeps their slot until their pilot orders them, and rejoins them after', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    expect(rig.following.SetPiloted(new Set(['d1']))).toEqual([]);
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc' });
    expect(rig.following.Report('d1')).toEqual({ state: 'piloting', anchor: 'fc', range: 1000 });
    expect(rig.world.Order('d1', { type: 'stop' })).toBe(true);
    expect(rig.following.Reconcile()).toEqual([]);
    expect(rig.world.Following('d1')).toBeNull();
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toMatchObject({ piloting: 1, detached: 0 });
    expect(rig.following.SetPiloted(new Set(['d1']))).toEqual([]);
    rig.following.SetPiloted(new Set());
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc' });
    expect(rig.following.Report('d1')?.state).not.toBe('piloting');
  });

  it('reports each member and the fleet', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    rig.world.Order('d2', { type: 'stop' });
    rig.following.Detach('d2');
    rig.Run(90);
    const d1 = rig.following.Report('d1');
    expect(d1).toMatchObject({ state: 'in-formation', anchor: 'fc', range: 1000, slot: { range: 1000, direction: [0, 0, -1] } });
    expect(Math.abs((d1?.distance ?? 0) - 1000)).toBeLessThanOrEqual(250);
    expect(d1?.slotError).toBeLessThanOrEqual(250);
    expect(rig.following.Report('fc')).toBeNull();
    expect(rig.following.Report('loner')).toBeNull();
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toEqual({ ready: true, heading: [0, 0], following: 4, inFormation: 3, catchingUp: 0, holding: 0, warping: 0, leading: 0, detached: 1, piloting: 0, waiting: 0, arriving: 0 });
  });

  it('reports members holding while the FC is in warp, then catching up', () => {
    const rig = new Rig();
    rig.following.Reconcile();
    rig.Run(30);
    expect(rig.world.Order('fc', { type: 'warp', point: [0, 0, 300_000], range: 0 })).toBe(true);
    const phase = (): Maybe<string> => rig.world.Motion('fc')?.warp?.phase;
    for (let second = 0; phase() !== 'warping' && phase() !== 'exiting'; second++) {
      if (second > 30) throw new Error(`the FC never warped: ${phase()}`);
      rig.Run(1);
    }
    rig.Run(2);
    expect(phase()).not.toBe('landed');
    for (const id of ['d1', 'd2', 'l1', 'l2']) expect(rig.following.Report(id), id).toMatchObject({ state: 'holding', warping: 'fc' });
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toMatchObject({ following: 4, holding: 4, inFormation: 0, catchingUp: 0 });
    for (let second = 0; phase() !== 'landed'; second++) {
      if (second > 30) throw new Error(`the FC never landed: ${phase()}`);
      rig.Run(1);
    }
    rig.Run(2);
    const d1 = rig.following.Report('d1');
    expect(d1?.state).toBe('catching-up');
    expect(d1?.warping).toBeUndefined();
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toMatchObject({ holding: 0, catchingUp: 4 });
  });
});

describe('FleetFollowing groups apart', () => {
  const GROUP = (kind: FleetGroupKind, id: string, leader: string, ships: string[]) => ({ key: `f/${kind}/${id}`, group: { fleet: 'f', kind, id }, leader, ships });
  const LAYOUT = (rig: Rig) => ({ fleet: rig.scene.fleets![0], origin: [0, 0, 0] as [number, number, number], heading: 0, radiusOf: () => PHYSICS.radius });

  function Apart(rig: Rig, kind: FleetGroupKind, id: string, leader: string, ships: string[]): void {
    rig.following.Reconcile();
    expect(rig.world.Order(leader, { type: 'stop' })).toBe(true);
    rig.following.BreakAway(GROUP(kind, id, leader, ships));
  }

  it("keeps the logi squad's in-group anchors on its lead, framed by the lead", () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'logi', 'l1', ['l1', 'l2']);
    expect(rig.world.Following('l1')).toBeNull();
    const plan = toFleetGroupFollowPlans({ ...LAYOUT(rig), leader: 'l1', ships: ['l1', 'l2'] }).get('l2')!;
    expect(rig.world.Following('l2')).toEqual({ anchor: 'l1', range: 1000, frame: 'l1', direction: plan.slot.direction, slotRange: plan.slot.range, speed: 1 });
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc', frame: 'fc' });
    expect(rig.following.ApartOf('l2')).toEqual(GROUP('squad', 'logi', 'l1', ['l1', 'l2']));
    expect(rig.following.Apart('f/squad/logi')?.leader).toBe('l1');
  });

  it('re-roots the dps squad on its leader at its at-rest offset', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'dps', 'd1', ['d1', 'd2']);
    const offset = toFleetGroupOffsets({ ...LAYOUT(rig), leader: 'd1', ships: ['d2'] }).get('d2')!;
    const reach = Math.hypot(...offset);
    const follow = rig.world.Following('d2')!;
    expect(follow).toMatchObject({ anchor: 'd1', frame: 'd1', range: Math.round(reach - 2 * PHYSICS.radius) });
    for (let axis = 0; axis < 3; axis++) expect(follow.direction[axis]).toBeCloseTo(offset[axis] / reach, 9);
    expect(rig.following.GroupOffsets('f', 'd1', ['d2'])?.get('d2')).toEqual(offset);
  });

  it('reports leading and warping, and counts them in the fleet report', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'dps', 'd1', ['d1', 'd2']);
    expect(rig.following.Report('d1')).toEqual({ state: 'leading', anchor: 'fc', range: 1000, group: { kind: 'squad', id: 'dps', leader: 'd1' } });
    rig.Run(5);
    expect(rig.following.Report('d2')).toMatchObject({ anchor: 'd1', group: { kind: 'squad', id: 'dps', leader: 'd1' } });
    expect(rig.world.WarpInFormation('l2', { leader: 'l1', offset: [0, 0, -1000] })).toBe(true);
    expect(rig.following.Report('l2')).toMatchObject({ state: 'warping', warping: 'l1' });
    expect(rig.following.FleetReport({ id: 'f', commander: 'fc' })).toMatchObject({ following: 4, leading: 1, warping: 1 });
  });

  it('regroups ships back onto their fleet plans, and a leader regrouping dissolves its group', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'dps', 'd1', ['d1', 'd2']);
    rig.following.Regroup(['d1', 'd2']);
    expect(rig.following.Apart('f/squad/dps')).toBeNull();
    expect(rig.world.Following('d1')).toMatchObject({ anchor: 'fc', frame: 'fc' });
    expect(rig.world.Following('d2')).toMatchObject({ anchor: 'fc', frame: 'fc' });

    Apart(rig, 'wing', 'w', 'd1', ['d1', 'd2', 'l1', 'l2']);
    rig.following.Regroup(['l2']);
    expect(rig.following.Apart('f/wing/w')?.ships).toEqual(['d1', 'd2', 'l1']);
    expect(rig.world.Following('l2')).toMatchObject({ anchor: 'l1', frame: 'fc' });
    expect(rig.world.Following('l1')).toMatchObject({ anchor: 'd1', frame: 'd1' });
  });

  it('flies the most specific group apart, and a wing breaking away absorbs the groups inside it', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'logi', 'l1', ['l1', 'l2']);
    expect(rig.world.Order('d1', { type: 'stop' })).toBe(true);
    rig.following.BreakAway(GROUP('wing', 'w', 'd1', ['d1', 'd2', 'l1', 'l2']));
    expect(rig.following.Apart('f/squad/logi')).toBeNull();
    expect(rig.world.Following('l1')).toMatchObject({ frame: 'd1' });

    expect(rig.world.Order('l1', { type: 'stop' })).toBe(true);
    rig.following.BreakAway(GROUP('squad', 'logi', 'l1', ['l1', 'l2']));
    expect(rig.following.Apart('f/wing/w')).not.toBeNull();
    expect(rig.following.ApartOf('l2')?.key).toBe('f/squad/logi');
    expect(rig.world.Following('l2')).toMatchObject({ anchor: 'l1', frame: 'l1' });
    expect(rig.world.Following('d2')).toMatchObject({ anchor: 'd1', frame: 'd1' });
    expect(rig.following.Report('l1')).toMatchObject({ state: 'leading', group: { kind: 'squad', id: 'logi', leader: 'l1' } });
  });

  it("dissolves on a regrouping edit, a restart or the fleet's removal", () => {
    const edited = new Rig();
    Apart(edited, 'squad', 'dps', 'd1', ['d1', 'd2']);
    edited.Edit([{ op: 'set_anchor', fleet: 'f', squad: 'dps', anchor: { range: 2000 } }]);
    expect(edited.following.Apart('f/squad/dps')).toBeNull();
    expect(edited.world.Following('d1')).toMatchObject({ anchor: 'fc', range: 2000 });

    const restarted = new Rig();
    Apart(restarted, 'squad', 'dps', 'd1', ['d1', 'd2']);
    restarted.following.Reconcile({ restart: true });
    expect(restarted.following.Apart('f/squad/dps')).toBeNull();
    expect(restarted.world.Following('d1')).toMatchObject({ anchor: 'fc' });

    const removed = new Rig();
    Apart(removed, 'squad', 'dps', 'd1', ['d1', 'd2']);
    removed.Edit([{ op: 'remove_fleet', fleet: 'f' }]);
    expect(removed.following.Apart('f/squad/dps')).toBeNull();
    expect(removed.world.Following('d2')).toBeNull();
  });

  it('keeps a leader leading on Detach and refuses its rejoin', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'dps', 'd1', ['d1', 'd2']);
    expect(rig.following.Detach('d1')).toBe('leading');
    expect(rig.following.Report('d1')?.state).toBe('leading');
    expect(() => rig.following.Rejoin('d1')).toThrow('ship "d1" leads squad "dps" apart from fleet "f"; order_fleet regroup brings the group back');
    expect(rig.following.Detach('d2')).toBe('detached');
    expect(rig.world.Order('d2', { type: 'stop' })).toBe(true);
    rig.following.Rejoin('d2');
    expect(rig.world.Following('d2')).toMatchObject({ anchor: 'd1', frame: 'd1' });
  });

  it('keeps the follows apart while the fleet is unready', () => {
    const rig = new Rig();
    Apart(rig, 'squad', 'dps', 'd1', ['d1', 'd2']);
    const before = rig.world.Following('d2');
    rig.radii.set('l2', null);
    expect(rig.following.Ready('f')).toBe(false);
    expect(rig.following.GroupOffsets('f', 'd1', ['d2'])).toBeNull();
    rig.following.Reconcile();
    expect(rig.world.Following('d2')).toEqual(before);
    expect(rig.world.Following('d1')).toBeNull();
  });
});

describe('FleetFollowing snapshots (sd-time)', () => {
  it('restores detached, planned and apart groups with the world, and then flies what an uncaptured twin flies', () => {
    const build = (): Rig => {
      const rig = new Rig();
      rig.following.Reconcile();
      rig.world.Order('d1', { type: 'stop' });
      rig.following.Detach('d1');
      rig.Run(3);
      return rig;
    };
    const rig = build();
    const twin = build();
    const world = rig.world.Snapshot();
    const now = rig.now;
    const ships = ['fc', 'd1', 'd2', 'l1', 'l2'];
    const trip = RoundTrip(
      rig.following,
      (f) => [ships.map((id) => f.Report(id)), f.FleetReport({ id: 'f', commander: 'fc' })],
      (f) => {
        f.Rejoin('d1');
        rig.world.Order('l1', { type: 'stop' });
        f.BreakAway({ key: 'f/squad/logi', group: { fleet: 'f', kind: 'squad', id: 'logi' }, leader: 'l1', ships: ['l1', 'l2'] });
        rig.Run(4);
      },
      () => {
        rig.world.Restore(world);
        rig.now = now;
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
    for (const each of [rig, twin]) {
      each.world.Order('fc', { type: 'direction', direction: [1, 0, 0], speed: 1 });
      each.Run(6);
    }
    expect(ships.map((id) => rig.world.Motion(id))).toEqual(ships.map((id) => twin.world.Motion(id)));
    expect(ships.map((id) => rig.following.Report(id))).toEqual(ships.map((id) => twin.following.Report(id)));
  });
});
