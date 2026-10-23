import type { Maybe } from '@dereekb/util';
import { normalizeScene, type CalledTargetStatus, type FleetGroup, type SceneDocument, toFleetGroupKey } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { FleetTargets, type FleetTargetsPort, type FleetTargetsSync } from './fleet-targets';

const TFI = 'tfi:amarr:amarr';
const RED = ['r1', 'r2', 'r3', 'r4'];
const BLUE = ['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2', 'gfc'];

interface Calls {
  readonly fleet?: string[];
  readonly w1?: string[];
  readonly dps?: string[];
  readonly logi?: string[];
  readonly tackle?: string[];
}

/**
 * The scene package's TWO_WINGS: w1 under wc1 (a dps squad the FC sits in, commanded by a1, and a logi squad), w2 (a
 * tackle squad), a second fleet g that calls nothing, red ships to call and a ship in no fleet.
 */
const twoWings = (calls: Calls = {}, options: { readonly tackle?: string[] } = {}): SceneDocument =>
  normalizeScene({
    ships: [...BLUE, ...RED, 'solo'].map((id) => ({ id, dna: TFI })),
    fleets: [
      {
        id: 'f',
        commander: 'fc',
        ...(calls.fleet ? { targets: calls.fleet } : {}),
        wings: [
          {
            id: 'w1',
            commander: 'wc1',
            ...(calls.w1 ? { targets: calls.w1 } : {}),
            squads: [
              { id: 'dps', role: 'dps', commander: 'a1', members: ['fc', 'a1', 'a2', 'a3'], ...(calls.dps ? { targets: calls.dps } : {}) },
              { id: 'logi', role: 'logi', members: ['l1', 'l2'], ...(calls.logi ? { targets: calls.logi } : {}) }
            ]
          },
          { id: 'w2', squads: [{ id: 'tackle', role: 'tackle', members: options.tackle ?? ['b1', 'b2'], ...(calls.tackle ? { targets: calls.tackle } : {}) }] }
        ]
      },
      { id: 'g', commander: 'gfc' }
    ]
  }).scene;

interface FakePort extends FleetTargetsPort {
  readonly targets: Map<string, string>;
  readonly statuses: Map<string, CalledTargetStatus>;
  readonly cannot: Set<string>;
}

const fakePort = (): FakePort => {
  const targets = new Map<string, string>();
  const statuses = new Map<string, CalledTargetStatus>();
  const cannot = new Set<string>();
  return {
    targets,
    statuses,
    cannot,
    Status: (id) => statuses.get(id) ?? 'live',
    CanTarget: (ship) => !cannot.has(ship),
    TargetOf: (ship): Maybe<string> => targets.get(ship) ?? null,
    tickSeconds: 1
  };
};

/**
 * A lever on a fake port whose sync applies its changes, as the director's SetShipTarget would.
 */
const lever = () => {
  const port = fakePort();
  const targets = new FleetTargets(port);
  const sync = (scene: SceneDocument, tick = 0): FleetTargetsSync => {
    const result = targets.Sync(scene, tick);
    for (const { ship, target } of result.changes) {
      if (target) port.targets.set(ship, target);
      else port.targets.delete(ship);
    }
    return result;
  };
  return { port, targets, sync };
};

const targetsOf = (port: FakePort, ships: readonly string[]) => Object.fromEntries(ships.map((ship) => [ship, port.targets.get(ship) ?? null]));

describe('FleetTargets', () => {
  it('gives each member the nearest live call: squad, wing, fleet; the FC the fleet only; logi their own squad only', () => {
    const { port, targets, sync } = lever();
    const result = sync(twoWings({ fleet: ['r1', 'r2'], w1: ['r2'], dps: ['r3'] }));
    expect(targetsOf(port, BLUE)).toEqual({ fc: 'r1', wc1: 'r2', a1: 'r3', a2: 'r3', a3: 'r3', l1: null, l2: null, b1: 'r1', b2: 'r1', gfc: null });
    expect(result.changes.map((change) => change.ship)).toEqual(['fc', 'a1', 'a2', 'a3', 'wc1', 'b1', 'b2']);
    expect(result.changes.find((change) => change.ship === 'a1')?.group).toEqual({ fleet: 'f', kind: 'squad', id: 'dps' });
    expect(targets.Report('l1', 0)).toEqual({ state: 'logi' });
    expect(targets.Report('fc', 0)).toEqual({ state: 'following', group: { fleet: 'f', kind: 'fleet', id: 'f' }, primary: 'r1' });
    expect(targets.Report('gfc', 0)).toBeNull();
    expect(targets.Report('solo', 0)).toBeNull();
    expect(targets.Source('a1')).toBe('called');
    expect(targets.Armed()).toEqual(['fc', 'a1', 'a2', 'a3', 'wc1', 'b1', 'b2']);
    expect(targets.GroupReport({ fleet: 'f', kind: 'squad', id: 'dps' })).toEqual({ primary: 'r3', queue: [], following: 3 });
    expect(targets.GroupReport({ fleet: 'f', kind: 'fleet', id: 'f' })).toEqual({ primary: 'r1', queue: ['r2'], following: 3 });
    expect(targets.GroupReport({ fleet: 'f', kind: 'squad', id: 'logi' })).toBeNull();
  });

  it("makes a logi squad shoot its own squad's call", () => {
    const { port, sync } = lever();
    sync(twoWings({ fleet: ['r1'], logi: ['r4'] }));
    expect(targetsOf(port, ['l1', 'l2', 'a1'])).toEqual({ l1: 'r4', l2: 'r4', a1: 'r1' });
  });

  it("falls back to the wing's, then the fleet's call when a squad's targets are all dead", () => {
    const { port, targets, sync } = lever();
    const scene = twoWings({ fleet: ['r1'], w1: ['r2'], dps: ['r3'] });
    sync(scene);
    port.statuses.set('r3', 'destroyed');
    const result = sync(scene, 1);
    expect(targetsOf(port, ['a1', 'a2', 'a3', 'fc'])).toEqual({ a1: 'r2', a2: 'r2', a3: 'r2', fc: 'r1' });
    expect(result.primaries).toEqual([{ group: { fleet: 'f', kind: 'squad', id: 'dps' }, primary: null, previous: 'r3', tick: 1 }]);
    expect(targets.GroupReport({ fleet: 'f', kind: 'squad', id: 'dps' })).toEqual({ primary: null, queue: [], skipped: [{ id: 'r3', why: 'destroyed' }], following: 0 });
    port.statuses.set('r2', 'missing');
    sync(scene, 2);
    expect(targetsOf(port, ['a1', 'wc1'])).toEqual({ a1: 'r1', wc1: 'r1' });
  });

  it('leaves an own target alone until it clears, then the ship rejoins the call', () => {
    const { port, targets, sync } = lever();
    const scene = twoWings({ fleet: ['r1', 'r2'] });
    sync(scene);
    port.targets.set('b1', 'r4');
    targets.Own('b1');
    expect(sync(scene, 1).changes).toEqual([]);
    expect(targets.Source('b1')).toBe('own');
    expect(targets.Report('b1', 1)?.state).toBe('own-target');
    expect(targets.Armed()).not.toContain('b1');
    // An own target equal to the primary stays own when the primary moves on.
    port.targets.set('b2', 'r1');
    targets.Own('b2');
    sync(twoWings({ fleet: ['r2'] }), 2);
    expect(targetsOf(port, ['b1', 'b2', 'a1'])).toEqual({ b1: 'r4', b2: 'r1', a1: 'r2' });
    port.targets.delete('b1');
    const result = sync(twoWings({ fleet: ['r2'] }), 3);
    expect(result.changes).toEqual([{ ship: 'b1', target: 'r2', group: { fleet: 'f', kind: 'fleet', id: 'f' } }]);
    expect(targets.Source('b1')).toBe('called');
  });

  it('holds a member on its call unarmed, stands one down, and re-arms both on a list change or Respond', () => {
    const { port, targets, sync } = lever();
    const scene = twoWings({ fleet: ['r1', 'r2', 'r3'] });
    sync(scene);
    expect(targets.Hold('b1', 'hold')).toBe(true);
    expect(targets.Hold('b2', 'stand-down')).toBe(true);
    expect(targets.Hold('solo', 'hold')).toBe(false);
    const result = sync(scene, 1);
    expect(result.changes).toEqual([{ ship: 'b2', target: null, group: null }]);
    expect(targetsOf(port, ['b1', 'b2'])).toEqual({ b1: 'r1', b2: null });
    expect(targets.Armed()).not.toContain('b1');
    expect(targets.Report('b1', 1)?.state).toBe('holding');
    expect(targets.Report('b2', 1)?.state).toBe('stood-down');
    expect(targets.PreLocks('b1')).toEqual(['r2', 'r3']);
    expect(targets.PreLocks('b2')).toEqual([]);
    // A patch keeping the list keeps the holds; a change to it re-arms.
    sync(scene, 2);
    expect(targets.Armed()).not.toContain('b1');
    sync(twoWings({ fleet: ['r1', 'r2'] }), 3);
    expect(targetsOf(port, ['b1', 'b2'])).toEqual({ b1: 'r1', b2: 'r1' });
    expect(targets.Armed()).toEqual(expect.arrayContaining(['b1', 'b2']));
    targets.Hold('b1', 'hold');
    targets.Respond(['b1'], new Map(), 4);
    expect(targets.Armed()).toContain('b1');
    targets.Hold('b1', 'hold');
    targets.Rearm(['b1']);
    expect(targets.Armed()).toContain('b1');
  });

  it("keeps a delayed pilot's target until its response tick", () => {
    const { port, targets, sync } = lever();
    sync(twoWings({ fleet: ['r1'] }), 10);
    targets.Hold('b2', 'hold');
    targets.Respond(['fc', 'b1', 'b2'], new Map([['b2', 3]]), 10);
    sync(twoWings({ fleet: ['r2', 'r1'] }), 10);
    expect(targetsOf(port, ['fc', 'b1', 'b2'])).toEqual({ fc: 'r2', b1: 'r2', b2: 'r1' });
    expect(targets.Report('b2', 11)).toEqual({ state: 'responding', group: { fleet: 'f', kind: 'fleet', id: 'f' }, primary: 'r2', respondsIn: 2 });
    expect(targets.Armed()).not.toContain('b2');
    expect(targets.SkipReason('b2', { fleet: 'f', kind: 'fleet', id: 'f' }, 11)).toBe('it responds in 2 s');
    sync(twoWings({ fleet: ['r2', 'r1'] }), 12);
    expect(port.targets.get('b2')).toBe('r1');
    sync(twoWings({ fleet: ['r2', 'r1'] }), 13);
    expect(port.targets.get('b2')).toBe('r2');
    expect(targets.Armed()).toContain('b2');
  });

  it('skips a warping target, advances past a dead one to its pre-locked next, and caps the pre-locks', () => {
    const { port, targets, sync } = lever();
    const scene = twoWings({ fleet: ['r1', 'r2', 'r3', 'r4'] });
    port.statuses.set('r1', 'warping');
    sync(scene);
    expect(port.targets.get('b1')).toBe('r2');
    expect(targets.GroupReport({ fleet: 'f', kind: 'fleet', id: 'f' })?.skipped).toEqual([{ id: 'r1', why: 'warping' }]);
    port.statuses.delete('r1');
    sync(scene, 1);
    expect(port.targets.get('b1')).toBe('r1');
    expect(targets.PreLocks('b1')).toEqual(['r2', 'r3']);
    port.statuses.set('r1', 'destroyed');
    port.targets.delete('b1');
    sync(scene, 2);
    expect(port.targets.get('b1')).toBe('r2');
    expect(targets.PreLocks('b1')).toEqual(['r3', 'r4']);
    expect(targets.PreLocks('l1')).toEqual([]);
  });

  it('reports primary changes, forgets a ship that cannot target, drops leavers and clears on a load', () => {
    const { port, targets, sync } = lever();
    expect(sync(twoWings({ fleet: ['r1', 'r2'] })).primaries).toEqual([{ group: { fleet: 'f', kind: 'fleet', id: 'f' }, primary: 'r1', previous: null, tick: 0 }]);
    expect(sync(twoWings({ fleet: ['r1', 'r2'] }), 1).primaries).toEqual([]);
    port.cannot.add('b1');
    port.targets.delete('b1');
    expect(sync(twoWings({ fleet: ['r1', 'r2'] }), 2).changes).toEqual([]);
    expect(targets.Report('b1', 2)?.state).toBe('in-warp');
    expect(targets.Armed()).not.toContain('b1');
    port.cannot.delete('b1');
    expect(sync(twoWings({ fleet: ['r1', 'r2'] }), 3).changes).toEqual([{ ship: 'b1', target: 'r1', group: { fleet: 'f', kind: 'fleet', id: 'f' } }]);
    // b2 leaves the fleet: its called target clears.
    expect(sync(twoWings({ fleet: ['r1', 'r2'] }, { tackle: ['b1'] }), 4).changes).toEqual([{ ship: 'b2', target: null, group: null }]);
    expect(sync(twoWings({}, { tackle: ['b1'] }), 5).primaries).toEqual([{ group: { fleet: 'f', kind: 'fleet', id: 'f' }, primary: null, previous: 'r1', tick: 5 }]);
    expect(targetsOf(port, BLUE)).toEqual(Object.fromEntries(BLUE.map((ship) => [ship, null])));
    sync(twoWings({ fleet: ['r1'] }), 6);
    targets.Forget('b1');
    expect(targets.Armed()).not.toContain('b1');
    targets.Clear();
    expect(targets.Armed()).toEqual([]);
    expect(targets.GroupReport({ fleet: 'f', kind: 'fleet', id: 'f' })).toBeNull();
    expect(sync(twoWings({ fleet: ['r1'] }), 7).primaries).toHaveLength(1);
  });

  it('gives the same changes for the same inputs', () => {
    const run = () => {
      const { sync } = lever();
      return [sync(twoWings({ fleet: ['r1', 'r2'], dps: ['r3'], tackle: ['r4'] })), sync(twoWings({ fleet: ['r2'], dps: ['r3'], tackle: ['r4'] }), 1)];
    };
    expect(run()).toEqual(run());
  });
});

const FLEET_F: FleetGroup = { fleet: 'f', kind: 'fleet', id: 'f' };
const FREE_F = new Set([toFleetGroupKey(FLEET_F)]);
const MEMBERS = ['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2'];

/**
 * A lever with free fire: red ships 1, 2, 3 and 4 km off every blue ship (r1 nearest), each blue ship's reach 10 km
 * unless set, and a pilot reaction of `delay` ticks before a new pick.
 */
const freeLever = (delay = 0) => {
  const port = fakePort();
  const distances = new Map<string, number>(RED.map((id, index) => [id, 1000 * (index + 1)]));
  const reach = new Map<string, number>();
  const targets = new FleetTargets({
    ...port,
    FreeFireView: (ship) => ({ hostiles: RED.filter((id) => (port.statuses.get(id) ?? 'live') === 'live').map((id) => ({ id, distance: distances.get(id) ?? 0 })), reach: reach.get(ship) ?? 10_000 }),
    FreeFireDelay: () => delay
  });
  const sync = (scene: SceneDocument, tick = 0, free: ReadonlySet<string> = FREE_F): FleetTargetsSync => {
    const result = targets.Sync(scene, tick, free);
    for (const { ship, target } of result.changes) {
      if (target) port.targets.set(ship, target);
      else port.targets.delete(ship);
    }
    return result;
  };
  return { port, distances, reach, targets, sync };
};

describe('FleetTargets free fire', () => {
  it('lets members without a call pick the nearest hostile within their own reach; never logi or another fleet', () => {
    const { port, reach, targets, sync } = freeLever();
    reach.set('b2', 500);
    const result = sync(twoWings());
    expect(targetsOf(port, [...MEMBERS, 'gfc'])).toEqual({ fc: 'r1', wc1: 'r1', a1: 'r1', a2: 'r1', a3: 'r1', l1: null, l2: null, b1: 'r1', b2: null, gfc: null });
    expect(result.changes[0]).toEqual({ ship: 'fc', target: 'r1', group: FLEET_F, free: true });
    expect(targets.Source('a1')).toBe('free');
    expect(targets.FreeOf('a1')).toEqual({ target: 'r1', group: FLEET_F });
    expect(targets.Armed()).toEqual(['fc', 'a1', 'a2', 'a3', 'wc1', 'b1']);
    expect(targets.PreLocks('a1')).toEqual([]);
    expect(targets.Report('a1', 0)).toEqual({ state: 'free-fire', group: FLEET_F, free: 'r1' });
    expect(targets.Report('b2', 0)).toEqual({ state: 'free-fire', group: FLEET_F });
    expect(targets.Report('l1', 0)).toBeNull();
    expect(targets.Report('gfc', 0)).toBeNull();
  });

  it('gives way to a call at once, and picks again after its reaction once the call or its pick is gone', () => {
    const { port, distances, targets, sync } = freeLever(3);
    sync(twoWings(), 0);
    expect(targetsOf(port, ['fc', 'a1'])).toEqual({ fc: null, a1: null });
    expect(targets.Report('a1', 0)).toEqual({ state: 'free-fire', group: FLEET_F, picksIn: 3 });
    sync(twoWings(), 3);
    expect(targetsOf(port, ['fc', 'a1', 'b1'])).toEqual({ fc: 'r1', a1: 'r1', b1: 'r1' });
    // A squad call takes over at once; the FC takes only the fleet's call, so it keeps its pick.
    const called = sync(twoWings({ dps: ['r2'] }), 4);
    expect(called.changes).toEqual([
      { ship: 'a1', target: 'r2', group: { fleet: 'f', kind: 'squad', id: 'dps' } },
      { ship: 'a2', target: 'r2', group: { fleet: 'f', kind: 'squad', id: 'dps' } },
      { ship: 'a3', target: 'r2', group: { fleet: 'f', kind: 'squad', id: 'dps' } }
    ]);
    expect(targets.Source('a1')).toBe('called');
    expect(targets.Source('fc')).toBe('free');
    // r1 dies (the kill clears its shooters' targets): they pick again 3 ticks later.
    port.statuses.set('r1', 'destroyed');
    for (const ship of ['fc', 'wc1', 'b1', 'b2']) port.targets.delete(ship);
    sync(twoWings({ dps: ['r2'] }), 5);
    expect(targets.Report('fc', 5)).toEqual({ state: 'free-fire', group: FLEET_F, picksIn: 3 });
    sync(twoWings({ dps: ['r2'] }), 8);
    expect(targetsOf(port, ['fc', 'a1', 'b1'])).toEqual({ fc: 'r2', a1: 'r2', b1: 'r2' });
    // A pick that leaves the ship's reach is dropped at once and picked again after the reaction.
    distances.set('r2', 20_000);
    sync(twoWings(), 9);
    expect(targetsOf(port, ['fc', 'a1'])).toEqual({ fc: null, a1: null });
    sync(twoWings(), 12);
    expect(targetsOf(port, ['fc', 'a1'])).toEqual({ fc: 'r3', a1: 'r3' });
  });

  it("takes a free-fire order after each pilot's delay, the rest after their reaction", () => {
    const { port, targets, sync } = freeLever(5);
    targets.FreeFire(['fc', 'a1', 'a2'], new Map([['a2', 2]]), 10);
    sync(twoWings(), 10);
    expect(targetsOf(port, ['fc', 'a1', 'a2', 'b1'])).toEqual({ fc: 'r1', a1: 'r1', a2: null, b1: null });
    expect(targets.Report('a2', 10)).toEqual({ state: 'responding', respondsIn: 2 });
    sync(twoWings(), 12);
    expect(targetsOf(port, ['a2', 'b1'])).toEqual({ a2: 'r1', b1: null });
    sync(twoWings(), 15);
    expect(port.targets.get('b1')).toBe('r1');
  });

  it('keeps an own target; hold keeps a free pick unarmed, stand-down and free fire off clear it', () => {
    const { port, targets, sync } = freeLever();
    const scene = twoWings();
    sync(scene, 0);
    port.targets.set('a3', 'r4');
    targets.Own('a3');
    expect(targets.Hold('a2', 'hold')).toBe(true);
    expect(targets.Hold('b1', 'stand-down')).toBe(true);
    sync(scene, 1);
    expect(targetsOf(port, ['a2', 'a3', 'b1'])).toEqual({ a2: 'r1', a3: 'r4', b1: null });
    expect(targets.Source('a3')).toBe('own');
    expect(targets.Armed()).not.toContain('a2');
    expect(targets.Report('b1', 1)?.state).toBe('stood-down');
    const off = sync(scene, 2, new Set());
    expect(off.changes.map((change) => [change.ship, change.target])).toEqual([
      ['fc', null],
      ['a1', null],
      ['a2', null],
      ['wc1', null],
      ['b2', null]
    ]);
    expect(targetsOf(port, ['a3'])).toEqual({ a3: 'r4' });
    expect(targets.Report('a1', 2)).toBeNull();
    expect(targets.Armed()).toEqual([]);
  });
});
