import type { Maybe } from '@dereekb/util';
import type { DefenseLayerName, ModuleActivation, SceneDocument, SceneFleet } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { AutoRepair, type AutoRepairCondition, type AutoRepairPort } from './auto-repair';
import type { RemoteRepairerState, ShipModuleSpec } from './modules';
import { RoundTrip } from './state-capture.spec-helper';

const LRAR: ModuleActivation = {
  key: '',
  category: 'remote-armor-repairer',
  groupID: 325,
  refusal: null,
  targeted: true,
  warpSafe: false,
  cycleTime: 6,
  capacitorNeed: 0,
  range: 20_000,
  falloff: 20_000,
  repair: { layer: 'armor', amount: 512, remote: true },
  reactivationDelay: 0,
  maxGroupActive: 0,
  maxGroupOnline: 0,
  flight: false,
  reach: 60_000
};

interface FakeModule {
  key: string;
  spec: ShipModuleSpec;
  state: RemoteRepairerState['state'];
  target: Maybe<string>;
  retarget?: string;
}

interface FakeShip {
  team?: string;
  condition: AutoRepairCondition;
  armor: number;
  taken: number;
  hostileLocks: number;
  modules: FakeModule[];
  locks: string[];
}

interface SwitchCall {
  readonly id: string;
  readonly key: string;
  readonly request: 'active' | 'online';
  readonly target?: string;
  readonly retarget?: boolean;
}

const ARMOR_MAX = 1000;

function Rep(key: string, activation: Partial<ModuleActivation> = {}): FakeModule {
  return { key, spec: { key, name: key, typeID: 3_000, offline: false, activation: { ...LRAR, key, ...activation } }, state: 'online', target: null };
}

function Ship(input: Partial<FakeShip> = {}): FakeShip {
  return { condition: 'ready', armor: ARMOR_MAX, taken: 0, hostileLocks: 0, modules: [], locks: [], ...input };
}

/**
 * Fleet b: FC b1, squad dps [b2, d1], squad logi (role logi) [g1, g2].
 */
function Fleet(edit: (fleet: SceneFleet) => void = () => undefined): SceneFleet {
  const fleet: SceneFleet = {
    id: 'b',
    commander: 'b1',
    wings: [
      {
        id: 'w',
        squads: [
          { id: 'dps', role: 'dps', members: ['b2', 'd1'] },
          { id: 'logi', role: 'logi', members: ['g1', 'g2'] }
        ]
      }
    ]
  };
  edit(fleet);
  return fleet;
}

class Harness {
  readonly ships = new Map<string, FakeShip>();
  readonly switches: SwitchCall[] = [];
  readonly distances = new Map<string, number>();
  fleet: SceneFleet;
  tick = 100;
  readonly autoRepair: AutoRepair;

  constructor(ships: Record<string, Partial<FakeShip>>, fleet = Fleet()) {
    for (const [id, ship] of Object.entries(ships)) this.ships.set(id, Ship(ship));
    this.fleet = fleet;
    const port: AutoRepairPort = {
      tickSeconds: 1,
      Scene: () => ({ ships: [...this.ships].map(([id, ship]) => ({ id, ...(ship.team ? { team: ship.team } : {}) })), fleets: [this.fleet] }) as unknown as Pick<SceneDocument, 'ships' | 'fleets'>,
      Condition: (id) => this.ships.get(id)?.condition ?? 'waiting',
      Health: (id) => {
        const ship = this.ships.get(id);
        return ship ? ({ shield: { hp: 0, max: 0 }, armor: { hp: ship.armor, max: ARMOR_MAX }, structure: { hp: 500, max: 500 } } satisfies Record<DefenseLayerName, { hp: number; max: number }>) : null;
      },
      Taken: (id) => this.ships.get(id)?.taken ?? 0,
      HostileLocks: (id) => this.ships.get(id)?.hostileLocks ?? 0,
      SurfaceDistance: (a, b) => this.distances.get([a, b].sort().join('|')) ?? 5_000,
      Targeting: () => ({ scanResolution: 400, maxTargetRange: 80_000, maxLocks: 6 }),
      Locks: (id) => this.ships.get(id)?.locks ?? [],
      RemoteRepairers: (id) => (this.ships.get(id)?.modules ?? []).map((module) => ({ ...module })),
      IncomingReps: (id) =>
        [...this.ships].flatMap(([from, ship]) => ship.modules.filter((module) => module.target === id && (module.state === 'active' || module.state === 'stopping')).map((module) => ({ from, module: module.key, hps: (module.spec.activation.repair?.amount ?? 0) / module.spec.activation.cycleTime }))),
      Switch: (id, key, request, options) => this.Switch({ id, key, request, ...(options?.target ? { target: options.target } : {}), ...(options?.retarget ? { retarget: true } : {}) })
    };
    this.autoRepair = new AutoRepair({ port });
  }

  Distance(a: string, b: string, metres: number): void {
    this.distances.set([a, b].sort().join('|'), metres);
  }

  Module(id: string, key: string): FakeModule {
    const module = this.ships.get(id)?.modules.find((row) => row.key === key);
    if (!module) throw new Error(`no module ${id}/${key}`);
    return module;
  }

  /**
   * One boundary: the sync, then the module layer advances (activating runs, stopping ends, a retarget is taken).
   */
  Step(): boolean {
    const switched = this.autoRepair.Sync(this.tick);
    for (const ship of this.ships.values()) {
      for (const module of ship.modules) {
        if (module.state === 'activating') module.state = 'active';
        else if (module.state === 'stopping') {
          module.state = 'online';
          module.target = null;
        } else if (module.state === 'active' && module.retarget) {
          module.target = module.retarget;
          delete module.retarget;
        }
      }
    }
    this.tick += 1;
    return switched;
  }

  private Switch(call: SwitchCall): Maybe<string> {
    this.switches.push(call);
    const module = this.Module(call.id, call.key);
    let refusal: Maybe<string> = null;
    if (call.request === 'active') {
      if ((module.state === 'active' || module.state === 'stopping') && module.target !== call.target) {
        if (call.retarget) {
          module.retarget = call.target;
          module.state = 'active';
        } else refusal = `it is running on "${module.target}"; switch it online first`;
      } else if (module.state === 'stopping') module.state = 'active';
      else {
        module.state = 'activating';
        module.target = call.target;
      }
    } else if (module.state === 'active') module.state = 'stopping';
    else if (module.state === 'activating') {
      module.state = 'online';
      module.target = null;
    }
    return refusal;
  }
}

function Logi(): FakeModule[] {
  return [Rep('lrar1'), Rep('lrar2')];
}

describe('AutoRepair', () => {
  it('a logi squad repairs a shot member by default; a dps squad ship does not until its squad turns on', () => {
    const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, b2: {}, d1: { modules: Logi() }, g1: { modules: Logi() }, g2: {} });
    expect(harness.Step()).toBe(true);
    expect(harness.switches).toEqual([
      { id: 'g1', key: 'lrar1', request: 'active', target: 'b1', retarget: true },
      { id: 'g1', key: 'lrar2', request: 'active', target: 'b1', retarget: true }
    ]);
    harness.Step();
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'repairing', on: true, source: 'default', policy: 'urgent', target: 'b1', reason: 'under-fire', layer: 'armor', hps: 170.7 });
    expect(harness.autoRepair.Report('d1', harness.tick)).toMatchObject({ state: 'off', on: false, source: 'default' });
    expect(harness.autoRepair.Report('b2', harness.tick)).toBeNull();

    harness.fleet = Fleet((fleet) => (fleet.wings[0].squads[0].autoRepair = { on: true }));
    harness.ships.get('b2')!.taken = 1_500;
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches.map((call) => `${call.id}/${call.key}>${call.target}`)).toEqual(['d1/lrar1>b2', 'd1/lrar2>b2']);
    expect(harness.autoRepair.FleetReport('b', harness.tick)).toMatchObject({
      logi: 2,
      repairing: 2,
      locking: 0,
      targets: [
        { target: 'b2', logi: ['d1'] },
        { target: 'b1', logi: ['g1'] }
      ]
    });
  });

  it('switches with retarget: a running rep takes its new target at its next cycle start; out-of-reach reps go online', () => {
    const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, b2: {}, g1: { modules: [Rep('long'), Rep('short', { range: 2_000, falloff: 1_000 })] } });
    harness.Distance('b1', 'g1', 1_000);
    harness.Step();
    harness.Step();
    expect(harness.Module('g1', 'short').state).toBe('active');
    // b1 drifts out of the short rep's reach (2 km + 2 × 1 km), still in the long one's.
    harness.Distance('b1', 'g1', 10_000);
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches).toEqual([{ id: 'g1', key: 'short', request: 'online' }]);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'repairing', modules: [{ module: 'long', state: 'active' }] });
    // b2 comes under far heavier fire: the long rep retargets at its next cycle start.
    harness.ships.get('b1')!.taken = 0;
    harness.ships.get('b1')!.armor = ARMOR_MAX;
    harness.ships.get('b2')!.taken = 3_000;
    harness.ships.get('b2')!.armor = 300;
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches).toContainEqual({ id: 'g1', key: 'long', request: 'active', target: 'b2', retarget: true });
    expect(harness.Module('g1', 'long').target).toBe('b2');
  });

  it('turns off: owned reps switch online and the logi reports off', () => {
    const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, g1: { modules: Logi() } });
    harness.Step();
    harness.Step();
    harness.fleet = Fleet((fleet) => (fleet.wings[0].squads[1].autoRepair = { on: false }));
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches).toEqual([
      { id: 'g1', key: 'lrar1', request: 'online' },
      { id: 'g1', key: 'lrar2', request: 'online' }
    ]);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'off', on: false, source: 'squad', why: 'auto-repair is off on its squad' });
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches).toEqual([]);
    expect(harness.autoRepair.FleetReport('b', harness.tick)).toMatchObject({ logi: 0, off: 1, targets: [] });
  });

  it('Manual lets go without switching; a settings change or Rearm hands the logi back', () => {
    const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, g1: { modules: Logi() } });
    harness.Step();
    expect(harness.autoRepair.IsAuto('g1')).toBe(true);
    harness.autoRepair.Manual('g1');
    expect(harness.autoRepair.IsAuto('g1')).toBe(false);
    harness.Module('g1', 'lrar1').state = 'online';
    harness.Module('g1', 'lrar2').state = 'online';
    harness.switches.length = 0;
    harness.Step();
    harness.Step();
    expect(harness.switches).toEqual([]);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'manual' });

    harness.fleet = Fleet((fleet) => (fleet.wings[0].squads[1].autoRepair = { policy: 'damaged' }));
    harness.Step();
    expect(harness.switches.map((call) => call.target)).toEqual(['b1', 'b1']);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ policy: 'damaged', policySource: 'squad', target: 'b1' });

    harness.autoRepair.Manual('g1');
    harness.autoRepair.Rearm(['g1']);
    harness.switches.length = 0;
    harness.Step();
    // Its engaged reps are adopted: already on b1, nothing to switch, and it repairs on.
    expect(harness.switches).toEqual([]);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'repairing', target: 'b1' });
  });

  it('a target that dies or warps drops out and the next sync picks again', () => {
    const harness = new Harness({ b1: { taken: 2_000, armor: 300 }, b2: { taken: 500, armor: 900 }, g1: { modules: Logi() } });
    harness.Step();
    expect(harness.Module('g1', 'lrar1').target).toBe('b1');
    harness.ships.get('b1')!.condition = 'destroyed';
    harness.Step();
    harness.Step();
    expect(harness.Module('g1', 'lrar1').target).toBe('b2');
    harness.ships.get('b2')!.condition = 'in-warp';
    harness.switches.length = 0;
    harness.Step();
    expect(harness.switches.map((call) => call.request)).toEqual(['online', 'online']);
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ state: 'idle', reason: 'idle' });
    expect(harness.autoRepair.Report('b1', harness.tick)).toBeNull();
  });

  it('exposes pre-locks, keeps reps it does not own out of its coverage, and forgets', () => {
    const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, b2: { taken: 400 }, d1: { hostileLocks: 2 }, g1: { modules: Logi(), locks: ['d1'] }, g2: { modules: Logi() } });
    // g2 is taken over and runs both reps on b1 by hand: b1 counts as covered by others.
    harness.autoRepair.Manual('g2');
    for (const module of harness.ships.get('g2')!.modules) Object.assign(module, { state: 'active', target: 'b1' });
    harness.Step();
    expect(harness.Module('g1', 'lrar1').target).toBe('b2');
    expect(harness.autoRepair.PreLocks().get('g1')).toEqual(['d1', 'b1']);
    // Its own reps on b2 do not count as others' reps on the next pass: it keeps b2 as under-fire.
    harness.Step();
    expect(harness.autoRepair.Report('g1', harness.tick)).toMatchObject({ target: 'b2', reason: 'under-fire', state: 'repairing' });
    harness.autoRepair.Forget('g1');
    expect(harness.autoRepair.PreLocks().has('g1')).toBe(false);
    harness.autoRepair.Clear();
    expect(harness.autoRepair.Report('g2', harness.tick)).toBeNull();
    expect(harness.autoRepair.IsAuto('g2')).toBe(true);
  });

  it('is deterministic: the same inputs give the same switches', () => {
    const run = (): SwitchCall[] => {
      const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, b2: { taken: 1_000, armor: 600 }, g1: { modules: Logi() }, g2: { modules: Logi() } });
      for (let step = 0; step < 4; step += 1) harness.Step();
      return harness.switches;
    };
    const first = run();
    expect(first.map((call) => `${call.id}>${call.target}`)).toEqual(['g1>b1', 'g1>b1', 'g2>b2', 'g2>b2']);
    expect(run()).toEqual(first);
  });
});

describe('AutoRepair snapshots (sd-time)', () => {
  it('restores owned reps, targets and passes, and the next sync switches what an uncaptured twin switches', () => {
    const build = (): Harness => {
      const harness = new Harness({ b1: { taken: 1_000, armor: 600 }, b2: {}, d1: { modules: Logi() }, g1: { modules: Logi() }, g2: {} });
      harness.Step();
      harness.Step();
      return harness;
    };
    const harness = build();
    const twin = build();
    const saved = { ships: structuredClone([...harness.ships]), fleet: harness.fleet, tick: harness.tick, switches: harness.switches.length };
    const trip = RoundTrip(
      harness.autoRepair,
      (a) => [['g1', 'd1', 'b1'].map((id) => a.Report(id, saved.tick)), a.FleetReport('b', saved.tick), [...a.PreLocks()]],
      () => {
        harness.fleet = Fleet((fleet) => (fleet.wings[0].squads[0].autoRepair = { on: true }));
        harness.ships.get('b2')!.taken = 1_500;
        harness.Step();
        harness.autoRepair.Manual('g1');
        harness.Step();
      },
      () => {
        harness.ships.clear();
        for (const [id, ship] of saved.ships) harness.ships.set(id, ship);
        harness.fleet = saved.fleet;
        harness.tick = saved.tick;
        harness.switches.length = saved.switches;
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
    for (const rig of [harness, twin]) {
      rig.ships.get('b1')!.taken = 0;
      rig.ships.get('b2')!.taken = 2_000;
      rig.Step();
      rig.Step();
    }
    expect(harness.switches).toEqual(twin.switches);
    expect(harness.autoRepair.Report('g1', harness.tick)).toEqual(twin.autoRepair.Report('g1', twin.tick));
  });
});
