import { describe, expect, it } from 'vitest';
import { hostile, member, picture, REACH } from './personalities.spec-helper';
import { pickFreeFireTarget, rankFleetTargets, toFleetCall, toFleetEngaged, toFleetTargetingReach } from './targeting';

const ids = (ships: readonly { readonly id: string }[]) => ships.map((ship) => ship.id);

describe('rankFleetTargets', () => {
  const hostiles = [hostile('d1', 5000), hostile('l1', 25_000, { role: 'logi' }), hostile('t1', 8000, { role: 'tackle' }), hostile('l2', 12_000, { role: 'logi' }), hostile('far', 40_000, { role: 'logi' })];

  it('ranks by tier, then nearest, inside reach', () => {
    expect(ids(rankFleetTargets({ hostiles, targeting: { priority: ['logi', 'tackle', 'dps'], prefer: 'nearest' }, reach: 30_000 }))).toEqual(['l2', 'l1', 't1', 'd1']);
  });

  it('puts unlisted roles after every listed one', () => {
    expect(ids(rankFleetTargets({ hostiles, targeting: { priority: ['tackle'], prefer: 'nearest' }, reach: 30_000 }))).toEqual(['t1', 'd1', 'l2', 'l1']);
  });

  it('orders a tier by its preference, then nearest, then id', () => {
    const tier = [hostile('a', 9000, { remaining: 500, health: 0.9, dps: 50, speed: 900, signature: 400 }), hostile('b', 3000, { remaining: 2000, health: 0.2, dps: 300, speed: 200, signature: 40 }), hostile('c', 3000, { remaining: 2000, health: 0.2, dps: 300, speed: 200, signature: 40, commands: ['squad'] })];
    const rank = (prefer: Parameters<typeof rankFleetTargets>[0]['targeting']['prefer']) => ids(rankFleetTargets({ hostiles: tier, targeting: { priority: [], prefer }, reach: 50_000 }));
    expect(rank('nearest')).toEqual(['b', 'c', 'a']);
    expect(rank('weakest')).toEqual(['a', 'b', 'c']);
    expect(rank('damaged')).toEqual(['b', 'c', 'a']);
    expect(rank('toughest')).toEqual(['b', 'c', 'a']);
    expect(rank('dangerous')).toEqual(['b', 'c', 'a']);
    expect(rank('commander')).toEqual(['c', 'b', 'a']);
    expect(rank('fastest')).toEqual(['a', 'b', 'c']);
    expect(rank('biggest')).toEqual(['a', 'b', 'c']);
    expect(rank('smallest')).toEqual(['b', 'c', 'a']);
  });

  it('caps the targeting reach at the lock range', () => {
    expect(toFleetTargetingReach('falloff', REACH)).toBe(30_000);
    expect(toFleetTargetingReach(90_000, REACH)).toBe(60_000);
    expect(toFleetTargetingReach(90_000, { lock: 0, optimal: 0, falloff: 0 })).toBe(90_000);
  });
});

describe('toFleetCall', () => {
  const targeting = { priority: ['logi', 'tackle', 'dps'] as ('logi' | 'tackle' | 'dps')[], prefer: 'nearest' as const, reach: 'falloff' as const, queue: 2, switch: 'on-kill' as const };
  const hostiles = [hostile('d1', 5000), hostile('t1', 8000, { role: 'tackle' }), hostile('l1', 25_000, { role: 'logi' }), hostile('l2', 45_000, { role: 'logi' })];

  it('calls the top candidate and queues the next ones', () => {
    expect(toFleetCall({ picture: picture({ hostiles }), targeting }).call).toEqual(['l1', 't1', 'd1']);
    expect(toFleetCall({ picture: picture({ hostiles }), targeting: { ...targeting, queue: 0 } }).call).toEqual(['l1']);
  });

  it('keeps its primary on-kill even when a better target comes into reach', () => {
    const decision = toFleetCall({ picture: picture({ hostiles, call: ['d1'] }), targeting });
    expect(decision.call[0]).toBe('d1');
    expect(decision.why).toContain('keeps d1');
  });

  it('switches on-better to a higher tier in reach', () => {
    const decision = toFleetCall({ picture: picture({ hostiles, call: ['d1'] }), targeting: { ...targeting, switch: 'on-better' } });
    expect(decision.call).toEqual(['l1', 't1', 'd1']);
    expect(decision.why).toContain('better');
    expect(toFleetCall({ picture: picture({ hostiles, call: ['l1'] }), targeting: { ...targeting, switch: 'on-better' } }).call[0]).toBe('l1');
  });

  it('drops a primary that is gone or out of reach', () => {
    expect(toFleetCall({ picture: picture({ hostiles, call: ['dead', 't1'] }), targeting }).call).toEqual(['l1', 't1', 'd1']);
    expect(toFleetCall({ picture: picture({ hostiles, call: ['l2'] }), targeting }).call[0]).toBe('l1');
  });

  it('refills the queue, keeping its live entries in order', () => {
    expect(toFleetCall({ picture: picture({ hostiles, call: ['t1', 'd1'] }), targeting }).call).toEqual(['t1', 'd1', 'l1']);
    expect(toFleetCall({ picture: picture({ hostiles, call: ['t1', 'gone', 'l1'] }), targeting }).call).toEqual(['t1', 'l1', 'd1']);
  });

  it('calls nothing when nothing is in reach', () => {
    const decision = toFleetCall({ picture: picture({ hostiles: [hostile('far', 50_000)], call: ['far'] }), targeting });
    expect(decision.call).toEqual([]);
    expect(decision.why).toContain('nothing within 30 km');
  });
});

describe('toFleetEngaged', () => {
  const reach = { reach: 'falloff' as const };

  it('on-sight engages at lock range, in-range at targeting reach', () => {
    const near = picture({ hostiles: [hostile('h', 50_000)] });
    expect(toFleetEngaged({ engage: 'on-sight', picture: near, targeting: reach, was: false }).engaged).toBe(true);
    expect(toFleetEngaged({ engage: 'in-range', picture: near, targeting: reach, was: false }).engaged).toBe(false);
    expect(toFleetEngaged({ engage: 'in-range', picture: picture({ hostiles: [hostile('h', 20_000)] }), targeting: reach, was: false })).toEqual({ engaged: true, why: 'h within 30 km' });
    expect(toFleetEngaged({ engage: 'on-sight', picture: picture({ hostiles: [hostile('h', 70_000)] }), targeting: reach, was: false }).engaged).toBe(false);
  });

  it('when-attacked engages once a hostile shoots a member', () => {
    const quiet = picture({ hostiles: [hostile('h', 5000)] });
    expect(toFleetEngaged({ engage: 'when-attacked', picture: quiet, targeting: reach, was: false }).engaged).toBe(false);
    const shot = picture({ hostiles: [hostile('h', 5000)], members: [member('fc'), member('m1', { attackedBy: ['h'] })] });
    expect(toFleetEngaged({ engage: 'when-attacked', picture: shot, targeting: reach, was: false })).toEqual({ engaged: true, why: 'h shot m1' });
  });

  it('stays engaged while a hostile is in the picture, and drops once none is', () => {
    expect(toFleetEngaged({ engage: 'in-range', picture: picture({ hostiles: [hostile('h', 200_000)] }), targeting: reach, was: true }).engaged).toBe(true);
    expect(toFleetEngaged({ engage: 'in-range', picture: picture(), targeting: reach, was: true }).engaged).toBe(false);
  });
});

describe('pickFreeFireTarget', () => {
  it('picks the nearest hostile within the ship reach, ties by id', () => {
    expect(
      pickFreeFireTarget({
        hostiles: [
          { id: 'b', distance: 9000 },
          { id: 'a', distance: 9000 },
          { id: 'c', distance: 12_000 }
        ],
        reach: 10_000
      })
    ).toBe('a');
    expect(pickFreeFireTarget({ hostiles: [{ id: 'c', distance: 12_000 }], reach: 10_000 })).toBeNull();
  });
});
