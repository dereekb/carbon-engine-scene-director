import type { Maybe } from '@dereekb/util';
import { lockTime } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { type LockTargeting, ShipLocks, type ShipLocksPort } from './locks';

/**
 * Ships on a line: distances are |x_a - x_b|; one-second ticks.
 */
class FakePort implements ShipLocksPort {
  readonly tickSeconds = 1;
  readonly x = new Map<string, number>([
    ['rifter', 0],
    ['punisher', 5000],
    ['ferox', 8000],
    ['astrahus', 20_000]
  ]);
  readonly targeting = new Map<string, LockTargeting>([
    ['rifter', { scanResolution: 825, maxTargetRange: 28_125, maxLocks: 2 }],
    ['ferox', { scanResolution: 243.75, maxTargetRange: 93_750, maxLocks: 8 }]
  ]);
  readonly warping = new Set<string>();

  SurfaceDistance(a: string, b: string): Maybe<number> {
    const [xa, xb] = [this.x.get(a), this.x.get(b)];
    return xa == null || xb == null ? null : Math.abs(xa - xb);
  }

  InWarp(id: string): boolean {
    return this.warping.has(id);
  }

  IsTargetable(id: string): boolean {
    return this.x.has(id);
  }

  Targeting(id: string): Maybe<LockTargeting> {
    return this.targeting.get(id) ?? null;
  }

  SignatureOf(id: string): number {
    return id === 'astrahus' ? 5000 : 37;
  }
}

function Wanted(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([ship, targets]) => [ship, new Set(targets)]));
}

describe('ShipLocks', () => {
  it('locks on boundaries: waiting, locking from the next boundary, locked at start + lock time', () => {
    const locks = new ShipLocks(new FakePort());
    const wanted = Wanted({ rifter: ['punisher'] });
    expect(locks.Request('rifter', 'punisher', 10)).toBeNull();
    expect(locks.Report('rifter', 10)).toEqual([{ target: 'punisher', state: 'waiting' }]);
    expect(locks.Hold('rifter', 'punisher', 10)).toBe('waiting for its lock on "punisher"');
    expect(locks.Boundary(11, wanted).map((event) => event.kind)).toEqual(['started']);
    const seconds = lockTime(825, 37);
    expect(seconds).toBeCloseTo(2.617, 3);
    expect(locks.Report('rifter', 11)).toEqual([{ target: 'punisher', state: 'locking', lockTime: 2.617, readyIn: 3 }]);
    expect(locks.Hold('rifter', 'punisher', 12)).toBe('waiting for its lock on "punisher" (2 s)');
    expect(locks.Boundary(12, wanted)).toEqual([]);
    expect(locks.Boundary(13, wanted)).toEqual([]);
    expect(locks.Boundary(14, wanted)).toEqual([{ kind: 'locked', ship: 'rifter', target: 'punisher', tick: 14 }]);
    expect(locks.IsLocked('rifter', 'punisher')).toBe(true);
    expect(locks.Hold('rifter', 'punisher', 14)).toBeNull();
    expect(locks.On('punisher')).toEqual(['rifter']);
    expect(locks.Of('rifter')).toEqual([{ ship: 'rifter', target: 'punisher', state: 'locked' }]);
  });

  it('waits out of targeting range, loses a lock whose target leaves it, and locks again when back', () => {
    const port = new FakePort();
    const locks = new ShipLocks(port);
    const wanted = Wanted({ rifter: ['punisher'] });
    port.x.set('punisher', 40_200);
    locks.Request('rifter', 'punisher', 0);
    expect(locks.Boundary(1, wanted)).toEqual([]);
    expect(locks.Report('rifter', 1)).toEqual([{ target: 'punisher', state: 'waiting', note: 'out of targeting range: 40.2 km, it locks at 28.1 km' }]);
    expect(locks.Hold('rifter', 'punisher', 1)).toBe('waiting for its lock on "punisher": out of targeting range: 40.2 km, it locks at 28.1 km');
    port.x.set('punisher', 5000);
    for (let tick = 2; tick <= 5; tick++) locks.Boundary(tick, wanted);
    expect(locks.IsLocked('rifter', 'punisher')).toBe(true);
    port.x.set('punisher', 30_000);
    expect(locks.Boundary(6, wanted)).toEqual([{ kind: 'lost', ship: 'rifter', target: 'punisher', tick: 6, why: 'out of targeting range' }]);
    expect(locks.Report('rifter', 6)[0].state).toBe('waiting');
    port.x.set('punisher', 5000);
    expect(locks.Boundary(7, wanted).map((event) => event.kind)).toEqual(['started']);
  });

  it('refuses a lock beyond the limit unless an unwanted one makes room, and refuses without targeting', () => {
    const locks = new ShipLocks(new FakePort());
    expect(locks.Request('rifter', 'punisher', 0)).toBeNull();
    expect(locks.Request('rifter', 'ferox', 0)).toBeNull();
    expect(locks.Request('rifter', 'astrahus', 0, new Set(['punisher', 'ferox']))).toBe('it holds 2 locks, its most');
    expect(locks.Request('rifter', 'astrahus', 0, new Set(['punisher']))).toBeNull();
    expect(locks.Of('rifter').map((lock) => lock.target)).toEqual(['punisher', 'astrahus']);
    expect(locks.Request('punisher', 'rifter', 0)).toBe('it cannot lock: no EVE dogma for its hull');
    expect(locks.Hold('punisher', 'rifter', 0)).toBeNull();
    expect(locks.Request('rifter', 'rifter', 0)).toBe('it cannot lock itself');
    expect(locks.Request('rifter', 'nobody', 0)).toBe('no ship or object "nobody" to lock');
  });

  it('sweeps: keeps the wanted and Kept locks, locks wanted targets on its own, and releases the rest', () => {
    const locks = new ShipLocks(new FakePort());
    locks.Request('ferox', 'punisher', 0);
    locks.Request('ferox', 'rifter', 0);
    expect(locks.Keep('ferox', 'astrahus', 0)).toBeNull();
    const events = locks.Boundary(1, Wanted({ ferox: ['punisher'] }));
    expect(events.filter((event) => event.kind === 'released')).toEqual([{ kind: 'released', ship: 'ferox', target: 'rifter', tick: 1, why: 'no longer wanted' }]);
    expect(locks.Of('ferox').map((lock) => lock.target)).toEqual(['punisher', 'astrahus']);
    locks.Boundary(2, Wanted({ ferox: ['punisher', 'rifter'] }));
    expect(locks.Of('ferox').map((lock) => [lock.target, lock.state])).toEqual([
      ['punisher', 'locking'],
      ['astrahus', 'locking'],
      ['rifter', 'locking']
    ]);
    locks.Release('ferox', 'astrahus');
    locks.Boundary(3, Wanted({ ferox: ['punisher', 'rifter'] }));
    expect(locks.Of('ferox').map((lock) => lock.target)).toEqual(['punisher', 'rifter']);
  });

  it('clears locks on a removal, a warp and a load', () => {
    const port = new FakePort();
    const locks = new ShipLocks(port);
    locks.Request('rifter', 'punisher', 0);
    locks.Request('ferox', 'punisher', 0);
    locks.Request('ferox', 'rifter', 0);
    locks.Remove('punisher');
    expect(locks.On('punisher')).toEqual([]);
    expect(locks.Of('ferox').map((lock) => lock.target)).toEqual(['rifter']);
    locks.OnWarpEnter('rifter');
    expect(locks.Of('ferox')).toEqual([]);
    locks.Request('ferox', 'rifter', 0);
    port.warping.add('rifter');
    expect(locks.Boundary(1, Wanted({ ferox: ['rifter'] }))).toEqual([{ kind: 'lost', ship: 'ferox', target: 'rifter', tick: 1, why: 'its target is gone' }]);
    port.warping.clear();
    locks.Request('ferox', 'rifter', 1);
    locks.Clear();
    expect(locks.Of('ferox')).toEqual([]);
  });

  it('lists the lockers on a target, locking or locked, never waiting', () => {
    const locks = new ShipLocks(new FakePort());
    const wanted = Wanted({ rifter: ['punisher'], ferox: ['punisher'] });
    locks.Request('rifter', 'punisher', 10);
    locks.Request('ferox', 'punisher', 10);
    expect(locks.Lockers('punisher')).toEqual([]);
    locks.Boundary(11, wanted);
    expect(locks.Lockers('punisher')).toEqual([
      { ship: 'rifter', target: 'punisher', state: 'locking' },
      { ship: 'ferox', target: 'punisher', state: 'locking' }
    ]);
    for (const tick of [12, 13, 14]) locks.Boundary(tick, wanted);
    expect(locks.Lockers('punisher')).toContainEqual({ ship: 'rifter', target: 'punisher', state: 'locked' });
    expect(locks.Lockers('rifter')).toEqual([]);
  });
});
