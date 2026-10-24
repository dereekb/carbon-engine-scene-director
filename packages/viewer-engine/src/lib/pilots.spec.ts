import type { Maybe } from '@dereekb/util';
import { type FleetGroup, type FleetShipFacts, type PilotStance, type PilotWeapon, type ResolvedShipStance, type ShipCombatProfile, type ShipOrder, toFleetGroupKey } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import type { DestinyWorld } from './destiny';
import { BallStates, GUARDIAN, Harness, RequireMotion, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { CombatProfileOf } from './pilot-facts';
import { ShipPilots, type PilotFormation, type PilotTackleModule, type ShipPilotsPort } from './pilots';
import { ResolveShipPropMod } from './prop-mods';
import { RoundTrip } from './state-capture.spec-helper';

const PUNISHER: PublishedHull = { typeID: 597, name: 'Punisher', published: { mass: 1_047_000, maxVelocity: 325, agility: 3.36, signatureRadius: 40, radius: 40, warpSpeedMultiplier: 5, rigSize: 1 } };

const AUTOCANNONS: PilotWeapon = { kind: 'tracking', dps: 120, optimal: 4000, falloff: 10_000, tracking: 0.4, signatureResolution: 40 };

const LASERS: PilotWeapon = { kind: 'tracking', dps: 150, optimal: 6000, falloff: 2500, tracking: 0.25, signatureResolution: 40 };

function FlightOf(hull: PublishedHull, propMod: boolean): ShipFlight {
  return ResolveFlight({ published: hull, hull: null, overrides: null, propMod: propMod ? ResolveShipPropMod({ module: 'mwd', rigSize: hull.published.rigSize as 1 | 2 | 3, answer: null }) : null });
}

function ProfileOf(flight: ShipFlight, rest: Partial<ShipCombatProfile> = {}): ShipCombatProfile {
  const profile = CombatProfileOf({ flight, specs: [], maxHp: 3000 });
  if (!profile) throw new Error('no profile');
  return { ...profile, ehp: 3000, ...rest };
}

function Own(id: string, stance: Partial<PilotStance> & Pick<PilotStance, 'type'>): ResolvedShipStance {
  const pilot: PilotStance = { on: null, range: 'ideal', propMods: 'auto', disengage: 0.35, ...stance };
  return { type: pilot.type, on: pilot.on ?? 'focus', range: pilot.range, propMods: pilot.propMods, formation: 'in-line', disengage: pilot.disengage, sources: { type: 'ship', propMods: 'ship', formation: 'default', disengage: 'default' }, flownBy: id, pilot };
}

function InLine(id: string, group: FleetGroup, leader: string, stance: Pick<PilotStance, 'type'>): ResolvedShipStance {
  const base = Own(id, stance);
  const { pilot, ...rest } = base;
  return { ...rest, group, sources: { ...base.sources, type: group.kind }, flownBy: leader, ...(leader === id ? { pilot } : {}) };
}

interface FakeShip {
  facts: FleetShipFacts;
  order: Maybe<ShipOrder>;
  tackle: PilotTackleModule[];
}

/**
 * A port over hand-made facts (no world): every call is recorded.
 */
class FakePort implements ShipPilotsPort {
  readonly tickSeconds = 1;
  stances = new Map<string, ResolvedShipStance>();
  due = new Map<string, number>();
  ships = new Map<string, FakeShip>();
  orders: { id: string; order: ShipOrder }[] = [];
  propMods: { id: string; active: boolean }[] = [];
  switches: { id: string; key: string; active: boolean; target?: string }[] = [];
  formations: PilotFormation[] = [];
  attackedBy: { id: string; at: number }[] = [];

  Add(facts: FleetShipFacts, tackle: PilotTackleModule[] = []): void {
    this.ships.set(facts.id, { facts, order: null, tackle });
  }

  Stances(): ReadonlyMap<string, ResolvedShipStance> {
    return this.stances;
  }

  StanceDue(id: string): Maybe<number> {
    return this.due.get(id) ?? null;
  }

  Facts(): readonly FleetShipFacts[] {
    return [...this.ships.values()].map((ship) => ship.facts);
  }

  Settled(): boolean {
    return true;
  }

  OrderOf(id: string): Maybe<ShipOrder> {
    return this.ships.get(id)?.order ?? null;
  }

  CalledOf(): Maybe<string> {
    return null;
  }

  AttackedBy(): readonly { readonly id: string; readonly at: number }[] {
    return this.attackedBy;
  }

  Order(id: string, order: ShipOrder): void {
    this.orders.push({ id, order });
    const ship = this.ships.get(id);
    if (ship) ship.order = order;
  }

  SwitchPropMod(id: string, active: boolean): number {
    this.propMods.push({ id, active });
    return 0;
  }

  Tackle(id: string): readonly PilotTackleModule[] {
    return this.ships.get(id)?.tackle ?? [];
  }

  SwitchTackle(id: string, key: string, active: boolean, target?: string): Maybe<string> {
    this.switches.push({ id, key, active, ...(target ? { target } : {}) });
    const module = this.ships.get(id)?.tackle.find((each) => each.key === key);
    if (module) Object.assign(module, { running: active, target: active ? target : null });
    return null;
  }

  Formation(formation: PilotFormation): void {
    this.formations.push(formation);
  }
}

const RIFTER_PROFILE = ProfileOf(FlightOf(RIFTER, true), { weapons: [AUTOCANNONS] });
const PUNISHER_PROFILE = ProfileOf(FlightOf(PUNISHER, false), { weapons: [LASERS], tackle: { web: 8000, webFactor: 0.4 } });

function Facts(id: string, team: string, position: [number, number, number], profile: ShipCombatProfile, rest: Partial<FleetShipFacts> = {}): FleetShipFacts {
  return { id, team, position, radius: profile.radius, health: 1, remaining: profile.ehp, dps: 0, signature: profile.flight.signature, speed: profile.flight.speed, velocity: [0, 0, 0], profile, ...rest };
}

describe('ShipPilots', () => {
  it('flies a ship with its own stance and takes it out of the formation', () => {
    const port = new FakePort();
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', Own('rifter', { type: 'kite' }));
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    expect(port.formations.at(-1)?.piloted.has('rifter')).toBe(true);
    expect(port.orders.length).toBe(1);
    expect(pilots.Flies('rifter')).toBe(true);
    const report = pilots.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, 100);
    expect(report.state).toBe('closing');
    expect(report.focus).toBe('punisher');
    expect(report.window?.[0]).toBeGreaterThanOrEqual(9500);
    expect(report.decisions?.[0]?.tool).toBe('order_ship');
  });

  it('changes nothing with no stance anywhere', () => {
    const port = new FakePort();
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', { ...Own('rifter', { type: 'kite' }), type: 'in-line', flownBy: null, pilot: undefined, sources: { type: 'default', propMods: 'default', formation: 'default', disengage: 'default' } });
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    expect(port.orders).toEqual([]);
    expect(port.formations.at(-1)).toEqual({ piloted: new Set(), apart: [], regroup: [] });
    expect(pilots.Has('rifter')).toBe(false);
  });

  it('flies an in-line squad stance apart on its leader and regroups it when cleared', () => {
    const port = new FakePort();
    const group: FleetGroup = { fleet: 'f', kind: 'squad', id: 's' };
    port.Add(Facts('a', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('b', 'red', [500, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('a', InLine('a', group, 'a', { type: 'brawl' }));
    port.stances.set('b', InLine('b', group, 'a', { type: 'brawl' }));
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    expect(port.formations.at(-1)?.apart).toEqual([{ key: toFleetGroupKey(group), group, leader: 'a', ships: ['a', 'b'] }]);
    expect(port.formations.at(-1)?.piloted.size).toBe(0);
    expect(port.orders.map((each) => each.id)).toEqual(['a']);
    expect(pilots.Report('b', port.stances.get('b') as ResolvedShipStance, 100).state).toBe('in-line');
    port.stances.clear();
    pilots.Step(101);
    expect(port.formations.at(-1)?.regroup).toEqual(['a', 'b']);
    expect(pilots.Has('a')).toBe(false);
  });

  it('keeps the previous stance until the pilot responds to a live stance order', () => {
    const port = new FakePort();
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', Own('rifter', { type: 'kite' }));
    port.due.set('rifter', 105);
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    expect(port.orders).toEqual([]);
    expect(pilots.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, 100).pending).toEqual({ type: 'kite', flownBy: 'rifter', at: 105, in: 5 });
    pilots.Step(104);
    expect(port.orders).toEqual([]);
    pilots.Step(105);
    expect(port.orders.length).toBe(1);
    expect(pilots.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, 105).pending).toBeUndefined();
  });

  it('holds a pilot a model took over until it is released', () => {
    const port = new FakePort();
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', Own('rifter', { type: 'kite' }));
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    pilots.Manual(['rifter']);
    const ship = port.ships.get('rifter') as FakeShip;
    ship.order = { type: 'stop' };
    pilots.Step(101);
    expect(port.orders.length).toBe(1);
    expect(pilots.Flies('rifter')).toBe(false);
    expect(pilots.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, 101).state).toBe('manual');
    pilots.Release(['rifter']);
    pilots.Step(102);
    expect(port.orders.length).toBe(2);
  });

  it('runs its tackle on the focus in range and stops only what it switched on', () => {
    const port = new FakePort();
    const tackle: PilotTackleModule[] = [{ key: 'point', kind: 'point', range: 24_000, running: false }];
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE), tackle);
    port.Add(Facts('punisher', 'blue', [15_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', Own('rifter', { type: 'tackle' }));
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    expect(port.switches).toEqual([{ id: 'rifter', key: 'point', active: true, target: 'punisher' }]);
    pilots.Step(101);
    expect(port.switches.length).toBe(1);
    port.stances.clear();
    pilots.Step(102);
    expect(port.switches.at(-1)).toEqual({ id: 'rifter', key: 'point', active: false });
  });

  it('round-trips a snapshot', () => {
    const port = new FakePort();
    port.Add(Facts('rifter', 'red', [0, 0, 0], RIFTER_PROFILE));
    port.Add(Facts('punisher', 'blue', [40_000, 0, 0], PUNISHER_PROFILE));
    port.stances.set('rifter', Own('rifter', { type: 'kite' }));
    const pilots = new ShipPilots({ port });
    pilots.Step(100);
    const result = RoundTrip(
      pilots,
      (owner) => owner.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, 100),
      (owner) => owner.Manual(['rifter'])
    );
    expect(result.after).toEqual(result.before);
    expect(result.again).toEqual(result.snapshot);
    expect(result.mutated).not.toEqual(result.before);
  });

  it('steps 50 loose pilots against 10 hostiles cheaply', () => {
    const port = new FakePort();
    for (let index = 0; index < 50; index++) {
      const angle = (index / 50) * 2 * Math.PI;
      const id = `red-${index}`;
      port.Add(Facts(id, 'red', [Math.cos(angle) * 30_000, 0, Math.sin(angle) * 30_000], RIFTER_PROFILE));
      port.stances.set(id, { ...Own(id, { type: 'auto' }), formation: 'loose', sources: { type: 'role', propMods: 'default', formation: 'fleet', disengage: 'default' } });
    }
    for (let index = 0; index < 10; index++) port.Add(Facts(`blue-${index}`, 'blue', [index * 500, 0, 0], PUNISHER_PROFILE));
    const pilots = new ShipPilots({ port });
    const started = performance.now();
    const boundaries = 20;
    for (let boundary = 0; boundary < boundaries; boundary++) pilots.Step(100 + boundary);
    const perBoundary = (performance.now() - started) / boundaries;
    console.info(`50 loose pilots against 10 hostiles: ${perBoundary.toFixed(2)} ms per boundary`);
    expect(port.formations.at(-1)?.piloted.size).toBe(50);
    expect(perBoundary).toBeLessThan(250);
  });
});

/**
 * A port over a Destiny world: the facts from the parks, orders and prop mods on them.
 */
class WorldPort extends FakePort {
  health = new Map<string, number>();

  constructor(
    readonly world: DestinyWorld,
    readonly profiles: ReadonlyMap<string, { readonly team: string; readonly profile: ShipCombatProfile }>
  ) {
    super();
  }

  override Facts(): readonly FleetShipFacts[] {
    const facts: FleetShipFacts[] = [];
    for (const [id, { team, profile }] of this.profiles) {
      const motion = RequireMotion(this.world, id);
      const health = this.health.get(id) ?? 1;
      facts.push(Facts(id, team, motion.position, profile, { velocity: motion.velocity, radius: motion.physics.radius, health, remaining: health * profile.ehp, remainingEhp: health * profile.ehp, ...(motion.propMod.running ? { propModOn: true } : {}) }));
    }
    return facts;
  }

  override OrderOf(id: string): Maybe<ShipOrder> {
    const motion = this.world.Motion(id);
    return motion ? (motion.pendingOrder ?? motion.order) : null;
  }

  override Order(id: string, order: ShipOrder): void {
    this.orders.push({ id, order });
    if (!this.world.Order(id, order)) throw new Error(this.world.OrderRefusal(id, order) ?? 'refused');
  }

  override SwitchPropMod(id: string, active: boolean): number {
    this.propMods.push({ id, active });
    this.world.SwitchPropMod(id, active);
    return 0;
  }
}

interface Flown {
  readonly harness: Harness;
  readonly port: WorldPort;
  readonly pilots: ShipPilots;
  readonly distances: number[];
}

/**
 * Flies ships on the parks with the pilots stepping at every boundary, one Destiny tick per second.
 *
 * @param setup - Adds the ships and their orders; returns the port's profiles and the pilots' stances.
 * @param seconds - How long.
 * @param onTick - Per tick, after the boundary (the second, the port).
 * @returns The run and the distance between the first two ships per tick.
 */
function FlyPilots(setup: (world: DestinyWorld) => { readonly profiles: Map<string, { team: string; profile: ShipCombatProfile }>; readonly stances: Map<string, ResolvedShipStance> }, seconds: number, onTick?: (second: number, port: WorldPort, pilots: ShipPilots) => void): Flown {
  const harness = new Harness();
  const { world } = harness;
  const { profiles, stances } = setup(world);
  const port = new WorldPort(world, profiles);
  port.stances = stances;
  const pilots = new ShipPilots({ port });
  world.OnBoundary((boundary) => pilots.Step(boundary));
  const [a, b] = [...profiles.keys()];
  const distances: number[] = [];
  let now = CLOCK_EPOCH_TICKS;
  for (let second = 0; second < seconds; second++) {
    now += TICKS_PER_SECOND;
    world.Tick(now);
    distances.push(world.SurfaceDistance(a, b) ?? Number.NaN);
    onTick?.(second, port, pilots);
  }
  return { harness, port, pilots, distances };
}

function RifterOnPunisher(world: DestinyWorld) {
  world.AddShip(Ship('rifter', [0, 0, 0]), FlightOf(RIFTER, true));
  world.AddShip(Ship('punisher', [25_000, 0, 0]), FlightOf(PUNISHER, false));
  world.Order('punisher', { type: 'approach', target: 'rifter', speed: 1 });
  return {
    profiles: new Map([
      ['rifter', { team: 'red', profile: RIFTER_PROFILE }],
      ['punisher', { team: 'blue', profile: PUNISHER_PROFILE }]
    ]),
    stances: new Map([['rifter', Own('rifter', { type: 'kite' })]])
  };
}

describe('ShipPilots on the parks', () => {
  it('holds a kiting Rifter at 9-14 km on a Punisher-like brawler for 120 s', () => {
    const { distances, port } = FlyPilots(RifterOnPunisher, 160);
    const held = distances.slice(40);
    expect(Math.min(...held)).toBeGreaterThan(9000);
    expect(Math.max(...held)).toBeLessThan(14_000);
    expect(port.propMods.some((each) => each.active)).toBe(true);
  });

  it('aligns a Rifter on its MWD: aligning, then aligned once 75 % of its top speed is along the line', () => {
    const stance = Own('rifter', { type: 'align', to: [0, 0, 10_000_000], propMods: 'always' });
    const states: string[] = [];
    const along: number[] = [];
    let flying: Maybe<DestinyWorld> = null;
    const { port } = FlyPilots(
      (world) => {
        flying = world;
        return { ...RifterOnPunisher(world), stances: new Map([['rifter', stance]]) };
      },
      40,
      (second, _port, pilots) => {
        states.push(pilots.Report('rifter', stance, second).state);
        along.push(flying?.Motion('rifter')?.velocity[2] ?? 0);
      }
    );
    const top = RIFTER_PROFILE.propMod?.speed ?? Number.NaN;
    const first = states.indexOf('aligned');
    expect(states.slice(0, 2)).toContain('aligning');
    expect(first).toBeGreaterThan(0);
    expect(along[first]).toBeGreaterThanOrEqual(0.75 * top - 1);
    expect(states.slice(first).every((state) => state === 'aligned')).toBe(true);
    expect(port.propMods.some((each) => each.id === 'rifter' && each.active)).toBe(true);
  });

  it('flies the same run twice to the same ball states', () => {
    const first = FlyPilots(RifterOnPunisher, 60);
    const second = FlyPilots(RifterOnPunisher, 60);
    expect(BallStates(second.harness.world, 'master', 2)).toEqual(BallStates(first.harness.world, 'master', 2));
    expect(second.port.orders).toEqual(first.port.orders);
  });

  it('orbits logi on a moving squad leader inside 20-30 km', () => {
    const { distances } = FlyPilots((world) => {
      world.AddShip(Ship('leader', [0, 0, 0]), FlightOf(TFI, false));
      world.AddShip(Ship('logi', [10_000, 0, 5000]), FlightOf(GUARDIAN, true));
      world.Order('leader', { type: 'direction', direction: [1, 0, 0], speed: 1 });
      const logi = ProfileOf(FlightOf(GUARDIAN, true), { reps: [{ layer: 'armor', hps: 85, optimal: 24_000, falloff: 0 }] });
      return {
        profiles: new Map([
          ['leader', { team: 'red', profile: ProfileOf(FlightOf(TFI, false)) }],
          ['logi', { team: 'red', profile: logi }]
        ]),
        stances: new Map([['logi', Own('logi', { type: 'orbit', on: 'leader', range: [20_000, 30_000], propMods: 'always' })]])
      };
    }, 180);
    const held = distances.slice(60);
    expect(Math.min(...held)).toBeGreaterThan(20_000);
    expect(Math.max(...held)).toBeLessThan(30_000);
  });

  it('burns out at its disengage HP and re-engages once repaired', () => {
    const states: string[] = [];
    const { distances } = FlyPilots(RifterOnPunisher, 140, (second, port, pilots) => {
      port.attackedBy = [{ id: 'punisher', at: second }];
      if (second === 40) port.health.set('rifter', 0.3);
      if (second === 100) port.health.set('rifter', 0.6);
      states.push(pilots.Report('rifter', port.stances.get('rifter') as ResolvedShipStance, second).state);
    });
    expect(distances[39]).toBeLessThan(14_000);
    expect(Math.max(...distances.slice(40, 100))).toBeGreaterThan(16_000);
    expect(Math.min(...distances.slice(120))).toBeGreaterThan(9000);
    expect(Math.max(...distances.slice(125))).toBeLessThan(16_000);
    expect(states.slice(42, 50)).toContain('disengaging');
    expect(states.slice(50, 100)).toContain('waiting');
    expect(states.slice(102)).not.toContain('disengaging');
  });
});
