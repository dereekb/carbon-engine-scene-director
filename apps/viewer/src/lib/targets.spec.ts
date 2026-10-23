import type { Maybe } from '@dereekb/util';
import { describe, expect, it } from 'vitest';
import { ShipTargets, type ShipTargetsPort } from './targets';

class FakePort implements ShipTargetsPort {
  readonly ships = new Set(['rifter', 'punisher', 'ferox']);
  readonly objects = new Set(['astrahus']);

  HasShip(id: string): boolean {
    return this.ships.has(id);
  }

  HasObject(id: string): boolean {
    return this.objects.has(id);
  }

  SurfaceDistance(a: string, b: string): Maybe<number> {
    return [a, b].every((id) => this.ships.has(id) || this.objects.has(id)) ? 5000.4 : null;
  }
}

describe('ShipTargets', () => {
  it('sets, reports and clears a target on a ship or an object', () => {
    const targets = new ShipTargets(new FakePort());
    expect(targets.Set('rifter', 'punisher')).toBeNull();
    expect(targets.Set('rifter', 'astrahus')).toBe('punisher');
    expect(targets.Report('rifter')).toEqual({ id: 'astrahus', kind: 'object', distance: 5000 });
    targets.Set('ferox', 'punisher');
    expect(targets.Report('ferox')).toEqual({ id: 'punisher', kind: 'ship', distance: 5000 });
    expect(targets.KindOf('nothing')).toBeNull();
    expect(targets.Set('ferox', null)).toBe('punisher');
    expect(targets.Of('ferox')).toBeNull();
    expect(targets.Report('ferox')).toBeNull();
    targets.Clear();
    expect(targets.Of('rifter')).toBeNull();
  });

  it('clears every target on a removed ship or object, and the removed ship its own', () => {
    const port = new FakePort();
    const targets = new ShipTargets(port);
    targets.Set('rifter', 'punisher');
    targets.Set('ferox', 'punisher');
    targets.Set('punisher', 'astrahus');
    port.ships.delete('punisher');
    expect(targets.Remove('punisher')).toEqual([
      { ship: 'rifter', previous: 'punisher' },
      { ship: 'ferox', previous: 'punisher' }
    ]);
    expect(targets.On('astrahus')).toEqual([]);
    targets.Set('rifter', 'astrahus');
    expect(targets.Remove('astrahus')).toEqual([{ ship: 'rifter', previous: 'astrahus' }]);
  });

  it("breaks a warping ship's own target and every target on it", () => {
    const targets = new ShipTargets(new FakePort());
    targets.Set('rifter', 'punisher');
    targets.Set('punisher', 'rifter');
    targets.Set('ferox', 'astrahus');
    expect(targets.OnWarpEnter('rifter')).toEqual([
      { ship: 'rifter', previous: 'punisher' },
      { ship: 'punisher', previous: 'rifter' }
    ]);
    expect(targets.Of('ferox')).toBe('astrahus');
  });
});
