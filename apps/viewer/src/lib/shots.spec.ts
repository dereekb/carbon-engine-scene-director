import type { Maybe } from '@dereekb/util';
import type { WeaponShot } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './clock';
import type { ShipModuleEvent } from './modules';
import { ShotQueue, WeaponShotsOf, type WeaponShotsPort } from './shots';

const PORT: WeaponShotsPort = {
  Turret: (ship, module) => (ship === 'rifter' && module.startsWith('high-') ? { typeID: 2889, name: '200mm AutoCannon II', charge: { typeID: 185, name: 'EMP S' } } : null),
  KindOf: (target): Maybe<'ship' | 'object'> => ({ punisher: 'ship' as const, astrahus: 'object' as const })[target] ?? null,
  SurfaceDistance: (_a, b) => (b === 'punisher' ? 5000.6 : 30_000)
};

function Event(kind: ShipModuleEvent['kind'], extra: Partial<ShipModuleEvent> = {}): ShipModuleEvent {
  return { kind, tick: 10, cycle: 2, activation: 3, ship: 'rifter', module: 'high-0', cycleTime: 2.5, target: 'punisher', effectiveness: 0.75, at: 9.5, ...extra };
}

function Shot(extra: Partial<WeaponShot> = {}): WeaponShot {
  return { ship: 'rifter', module: 'high-0', typeID: 2889, name: '200mm AutoCannon II', target: 'punisher', targetKind: 'ship', cycle: 1, activation: 1, tick: 10, at: 10, distance: 5000, effectiveness: 1, ...extra };
}

describe('WeaponShotsOf', () => {
  it('fires a shot for every turret cycle start on a target', () => {
    const shots = WeaponShotsOf([Event('end'), Event('cycle'), Event('cycle', { module: 'high-1', target: 'astrahus', at: undefined, effectiveness: undefined }), Event('cycle', { module: 'mid-0' }), Event('cycle', { target: undefined }), Event('off')], PORT);
    expect(shots).toEqual([
      { ship: 'rifter', module: 'high-0', typeID: 2889, name: '200mm AutoCannon II', charge: { typeID: 185, name: 'EMP S' }, target: 'punisher', targetKind: 'ship', cycle: 2, activation: 3, tick: 10, at: 9.5, distance: 5001, effectiveness: 0.75 },
      { ship: 'rifter', module: 'high-1', typeID: 2889, name: '200mm AutoCannon II', charge: { typeID: 185, name: 'EMP S' }, target: 'astrahus', targetKind: 'object', cycle: 2, activation: 3, tick: 10, at: 10, distance: 30_000, effectiveness: 1 }
    ]);
  });
});

describe('ShotQueue', () => {
  const S = TICKS_PER_SECOND;

  it('draws a shot one tick after its exact cycle start, in draw order, and counts it', () => {
    const queue = new ShotQueue(1);
    queue.Add([Shot({ at: 10 }), Shot({ module: 'high-1', at: 9.25 })], 100 * S);
    expect(queue.Count('rifter')).toBe(2);
    expect(queue.Due(100.2 * S)).toEqual([]);
    expect(queue.Due(100.25 * S).map((shot) => shot.module)).toEqual(['high-1']);
    expect(queue.pending).toBe(1);
    expect(queue.Due(101 * S).map((shot) => shot.module)).toEqual(['high-0']);
    expect(queue.Count('punisher')).toBe(0);
  });

  it('settles a stopped weapon once its queued shots drew and its last burst ran', () => {
    const queue = new ShotQueue(1);
    queue.Add([Shot()], 10 * S);
    queue.Off('rifter', 'high-0');
    expect(queue.Settled(10.5 * S)).toEqual([]);
    const [shot] = queue.Due(11 * S);
    queue.Drawn(shot, 11 * S, 1.5);
    expect(queue.Settled(12 * S)).toEqual([]);
    expect(queue.Settled(12.5 * S)).toEqual([{ ship: 'rifter', module: 'high-0' }]);
    expect(queue.Settled(20 * S)).toEqual([]);
    queue.Off('rifter', 'high-1');
    queue.Add([Shot({ module: 'high-1' })], 21 * S);
    expect(queue.Settled(30 * S)).toEqual([]);
  });

  it('forgets the shots of or at a removed id, and everything on a load', () => {
    const queue = new ShotQueue(1);
    queue.Add([Shot(), Shot({ ship: 'ferox' }), Shot({ ship: 'ferox', target: 'astrahus', targetKind: 'object' })], 0);
    queue.Forget('punisher');
    expect(queue.Due(10 * S).map((shot) => [shot.ship, shot.target])).toEqual([['ferox', 'astrahus']]);
    queue.Clear();
    expect(queue.Count('ferox')).toBe(0);
  });
});
