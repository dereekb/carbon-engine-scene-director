import type { Maybe } from '@dereekb/util';
import { normalizeScene, type CalledTargetStatus, type SceneDocument } from '@scene-director/scene';
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
