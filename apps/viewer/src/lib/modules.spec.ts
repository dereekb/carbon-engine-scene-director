import type { Maybe } from '@dereekb/util';
import type { ModuleActivation } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { ShipModules, type ShipModuleEvent, type ShipModuleSpec, type ShipModulesPort } from './modules';

const BASE: ModuleActivation = {
  key: '',
  category: 'hardener',
  groupID: 328,
  refusal: null,
  targeted: false,
  warpSafe: true,
  cycleTime: 10,
  capacitorNeed: 10,
  range: null,
  falloff: null,
  repair: null,
  reactivationDelay: 0,
  maxGroupActive: 0,
  maxGroupOnline: 0,
  flight: false
};

function Spec(key: string, activation: Partial<ModuleActivation> = {}, extra: Partial<ShipModuleSpec> = {}): ShipModuleSpec {
  return { key, name: key, typeID: 1, offline: false, activation: { ...BASE, key, ...activation }, ...extra };
}

const REMOTE_REP: Partial<ModuleActivation> = { category: 'remote-armor-repairer', groupID: 325, targeted: true, warpSafe: false, cycleTime: 5, range: 6000, falloff: 3000, repair: { layer: 'armor', amount: 300, remote: true } };

/**
 * A world of points on a line: distances are |x_a - x_b|, no radii.
 */
class FakePort implements ShipModulesPort {
  readonly tickSeconds = 1;
  readonly x = new Map<string, number>([
    ['logi', 0],
    ['fc', 4000],
    ['far', 50_000]
  ]);
  readonly warping = new Set<string>();

  SurfaceDistance(a: string, b: string): Maybe<number> {
    const [xa, xb] = [this.x.get(a), this.x.get(b)];
    return xa == null || xb == null ? null : Math.abs(xa - xb);
  }

  InWarp(id: string): boolean {
    return this.warping.has(id);
  }

  HasShip(id: string): boolean {
    return this.x.has(id);
  }
}

function Kinds(events: readonly ShipModuleEvent[]): string[] {
  return events.map((event) => `${event.ship}:${event.module}:${event.kind}${event.cycle}@${event.tick}${event.why ? ` (${event.why})` : ''}`);
}

function Run(modules: ShipModules, from: number, to: number): string[] {
  const events: string[] = [];
  for (let tick = from; tick <= to; tick++) events.push(...Kinds(modules.Boundary(tick)));
  return events;
}

describe('ShipModules', () => {
  it('runs a hardener, refuses what cannot run, and keeps group limits', () => {
    const modules = new ShipModules(new FakePort());
    modules.SetFit('logi', [Spec('low-0'), Spec('low-1', { maxGroupActive: 1, groupID: 515, category: 'siege' }), Spec('low-2', { maxGroupActive: 1, groupID: 515, category: 'siege' }), Spec('low-3', { refusal: 'it is passive: it is only online or offline' })], 0);
    expect(modules.Switch('logi', 'low-0', 'active', { boundary: 0 })).toBeNull();
    expect(modules.State('logi', 'low-0', 0)).toEqual({ state: 'activating', at: 0 });
    expect(Run(modules, 0, 0)).toEqual(['logi:low-0:on1@0', 'logi:low-0:cycle1@0']);
    expect(modules.Switch('logi', 'low-1', 'active', { boundary: 1 })).toBeNull();
    expect(modules.Switch('logi', 'low-2', 'active', { boundary: 1 })).toBe('at most 1 of its group may run at once');
    expect(modules.Switch('logi', 'low-3', 'active', { boundary: 1 })).toBe('it is passive: it is only online or offline');
    expect(modules.Switch('logi', 'mid-9', 'active', { boundary: 1 })).toBe('ship "logi" fits no module mid-9');
    expect(modules.Running('logi').map((spec) => spec.key)).toEqual(['low-0']);
  });

  it('starts modules beyond maxGroupOnline offline, and keeps states across a refit by key and type', () => {
    const modules = new ShipModules(new FakePort());
    modules.SetFit('logi', [Spec('low-0', { maxGroupOnline: 1, groupID: 60 }), Spec('low-1', { maxGroupOnline: 1, groupID: 60 }), Spec('low-2')], 0);
    expect(modules.CycleState('logi', 'low-1')).toBe('offline');
    expect(modules.State('logi', 'low-1', 0)?.note).toBe('offline: at most 1 of its group may be online');
    expect(modules.Switch('logi', 'low-1', 'online', { boundary: 0 })).toBe('at most 1 of its group may be online');
    modules.Switch('logi', 'low-2', 'active', { boundary: 0 });
    Run(modules, 0, 0);
    expect(Kinds(modules.SetFit('logi', [Spec('low-0'), Spec('low-2')], 1))).toEqual([]);
    expect(modules.CycleState('logi', 'low-2')).toBe('active');
    expect(modules.CycleState('logi', 'low-2', 2)).toBeNull();
    expect(Kinds(modules.SetFit('logi', [Spec('low-0'), Spec('low-2', {}, { typeID: 2 })], 2))).toEqual(['logi:low-2:off1@2 (refitted)']);
    expect(modules.CycleState('logi', 'low-2')).toBe('online');
    expect(modules.CycleState('logi', 'low-2', 2)).toBe('online');
  });

  it('clears every ship on a load, stopping the running modules at once', () => {
    const modules = new ShipModules(new FakePort());
    modules.SetFit('logi', [Spec('low-0'), Spec('high-0', REMOTE_REP)], 0);
    modules.Switch('logi', 'low-0', 'active', { boundary: 0 });
    modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'fc' });
    Run(modules, 0, 0);
    expect(Kinds(modules.Clear(3))).toEqual(['logi:low-0:off1@3 (the scene was loaded)', 'logi:high-0:off1@3 (the scene was loaded)']);
    expect(modules.CycleState('logi', 'low-0')).toBeNull();
    expect(modules.Incoming('fc')).toEqual([]);
  });

  it('runs a remote repairer on a target in reach, with its falloff effectiveness, and lands its repair at the cycle end', () => {
    const port = new FakePort();
    const modules = new ShipModules(port);
    modules.SetFit('logi', [Spec('high-0', REMOTE_REP)], 0);
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0 })).toBe('it needs a target: a ship id');
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'logi' })).toBe('it cannot target its own ship');
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'astrahus' })).toBe('no ship "astrahus" (a targeted module runs on a ship, not an object)');
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'far' })).toBe('"far" is out of range: 50000 m, it reaches 12000 m');
    port.x.set('fc', 9000);
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'fc' })).toBeNull();
    expect(modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'far' })).toBe('it is running on "fc"; switch it online first');
    const events = modules.Boundary(0);
    expect(modules.State('logi', 'high-0', 0)).toEqual({ state: 'active', cycle: { number: 1, endsIn: 5 }, target: 'fc', targetDistance: 9000, effectiveness: 0.5 });
    const ends = [...events];
    for (let tick = 1; tick <= 5; tick++) ends.push(...modules.Boundary(tick));
    expect(modules.RepairLandings(ends)).toEqual([{ ship: 'fc', layer: 'armor', amount: 150, from: 'logi', module: 'high-0' }]);
    expect(modules.Incoming('fc')).toEqual([{ from: 'logi', spec: expect.objectContaining({ key: 'high-0' }), effectiveness: 0.5 }]);
  });

  it('stops a targeted module at its cycle end out of reach, and at once when its target goes or warps', () => {
    const port = new FakePort();
    const modules = new ShipModules(port);
    modules.SetFit('logi', [Spec('high-0', REMOTE_REP), Spec('high-1', REMOTE_REP)], 0);
    modules.Switch('logi', 'high-0', 'active', { boundary: 0, target: 'fc' });
    Run(modules, 0, 1);
    port.x.set('fc', 20_000);
    expect(Run(modules, 2, 5)).toEqual(['logi:high-0:end1@5', 'logi:high-0:off1@5']);
    expect(modules.State('logi', 'high-0', 5)?.note).toBe('stopping: its target is out of range');
    port.x.set('fc', 4000);
    modules.Switch('logi', 'high-0', 'active', { boundary: 6, target: 'fc' });
    Run(modules, 6, 6);
    port.warping.add('fc');
    expect(Kinds(modules.OnWarpEnter('fc', 7))).toEqual(['logi:high-0:off1@7 (its target entered warp)']);
    port.warping.delete('fc');
    modules.Switch('logi', 'high-1', 'active', { boundary: 8, target: 'fc' });
    Run(modules, 8, 8);
    expect(Kinds(modules.Remove('fc', 9))).toEqual(['logi:high-1:off1@9 (its target is gone)']);
  });

  it("stops a ship's modules that are not warp safe as it enters warp, and refuses activation in warp", () => {
    const port = new FakePort();
    const modules = new ShipModules(port);
    modules.SetFit('fc', [Spec('low-0'), Spec('mid-0', { category: 'siege', warpSafe: false })], 0);
    modules.Switch('fc', 'low-0', 'active', { boundary: 0 });
    modules.Switch('fc', 'mid-0', 'active', { boundary: 0 });
    Run(modules, 0, 0);
    port.warping.add('fc');
    expect(Kinds(modules.OnWarpEnter('fc', 1))).toEqual(['fc:mid-0:off1@1 (entered warp)']);
    expect(modules.CycleState('fc', 'low-0')).toBe('active');
    expect(modules.Switch('fc', 'mid-0', 'active', { boundary: 2 })).toBe('ship "fc" is in warp');
  });

  it('makes a delayed switch at its tick, waits out reactivation, and lands shield boosts at the cycle start', () => {
    const modules = new ShipModules(new FakePort());
    modules.SetFit('fc', [Spec('mid-0', { category: 'shield-booster', groupID: 40, cycleTime: 4, reactivationDelay: 6, repair: { layer: 'shield', amount: 200, remote: false } })], 0);
    modules.Switch('fc', 'mid-0', 'active', { boundary: 0, delay: 2 });
    expect(modules.State('fc', 'mid-0', 0)).toEqual({ state: 'online', respondsIn: 2 });
    const events: ShipModuleEvent[] = [];
    for (let tick = 0; tick <= 2; tick++) events.push(...modules.Boundary(tick));
    expect(modules.RepairLandings(events)).toEqual([{ ship: 'fc', layer: 'shield', amount: 200, from: 'fc', module: 'mid-0' }]);
    modules.Switch('fc', 'mid-0', 'online', { boundary: 3 });
    expect(Run(modules, 3, 6)).toEqual(['fc:mid-0:end1@6', 'fc:mid-0:off1@6']);
    modules.Switch('fc', 'mid-0', 'active', { boundary: 7 });
    expect(modules.State('fc', 'mid-0', 7)).toEqual({ state: 'reactivating', readyIn: 5, activatesIn: 5 });
    expect(Run(modules, 7, 12)).toEqual(['fc:mid-0:on1@12', 'fc:mid-0:cycle1@12']);
  });
});

describe('DestinyWorld.OnBoundary', () => {
  it('calls back at each due boundary after the prop mods apply and before orders', () => {
    const world = new DestinyWorld();
    const physics = { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30, propMod: { mass: 1.7e6, maxVelocity: 2000, cycleTime: 10 } };
    world.AddShip({ id: 'a', position: [0, 0, 0], rotation: [0, 0, 0] }, physics);
    world.AddShip({ id: 'b', position: [5000, 0, 0], rotation: [0, 0, 0] }, physics);
    const seen: { readonly boundary: number; readonly prop: Maybe<string>; readonly pending: boolean; readonly distance: Maybe<number> }[] = [];
    world.OnBoundary((boundary) => seen.push({ boundary, prop: world.Motion('a')?.propMod.state, pending: world.Motion('a')?.pendingOrder != null, distance: world.SurfaceDistance('a', 'b') }));
    world.SwitchPropMod('a', true);
    world.Order('a', { type: 'stop' });
    let now = CLOCK_EPOCH_TICKS;
    for (let frame = 0; frame < 90; frame++) world.Tick((now += Math.round(TICKS_PER_SECOND / 60)));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toMatchObject({ prop: 'active', pending: true, distance: 4940 });
    expect(world.InWarp('a')).toBe(false);
  });
});
