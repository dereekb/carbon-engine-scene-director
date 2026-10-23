import type { MissileCombatNumbers } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './clock';
import type { MissileEvent, MissileReport } from './destiny';
import { MISSILE_FLIGHT_KEEP_TICKS, MISSILE_REPORT_ROWS, MissileFlightId, MissileFlights, type MissileLaunchRecord } from './missile-flights';
import { RoundTrip } from './state-capture.spec-helper';

// A Caracal's HML II with Scourge Heavy at max skills (plan §1.6).
const NUMBERS = {
  key: 'high-0',
  typeID: 2410,
  name: 'Heavy Missile Launcher II',
  kind: 'missile',
  damage: { em: 0, thermal: 0, kinetic: 204.875, explosive: 0 },
  volley: 204.875,
  cycleTime: 6.1965,
  dps: 33.06,
  velocity: 9675,
  flightTime: 9.771,
  mass: 1000,
  agility: 0.0001,
  radius: 300,
  range: { lower: 86_870, upper: 96_550, upperChance: 0.771, mean: 94_330 },
  explosion: { radius: 105, velocity: 127.5, drf: 0.682 }
} as unknown as MissileCombatNumbers;

const NOW = 1_000 * TICKS_PER_SECOND;

function Launch(overrides: Partial<MissileLaunchRecord> = {}): MissileLaunchRecord {
  const base = { ship: 'caracal', module: 'high-0', activation: 1, cycle: 1, ...overrides };
  return {
    id: MissileFlightId(base.ship, base.module, base.activation, base.cycle),
    typeID: 2410,
    name: 'Heavy Missile Launcher II',
    charge: { typeID: 209, name: 'Scourge Heavy Missile' },
    target: 'punisher',
    targetKind: 'ship',
    tick: 100,
    at: 99.4,
    numbers: NUMBERS,
    ...base
  };
}

function Event(kind: MissileEvent['kind'], overrides: Partial<MissileEvent> = {}): MissileEvent {
  return { kind, id: 'caracal|high-0|1|1', owner: 'caracal', target: 'punisher', at: 102.25, tick: 103, ended: kind !== 'lost', ...overrides };
}

describe('MissileFlights', () => {
  it('draws a launch at its boundary (the replica draws missile balls at master time) and counts it', () => {
    const flights = new MissileFlights(1);
    const flight = flights.Add(Launch(), NOW);
    expect(flight.id).toBe('caracal|high-0|1|1');
    expect(flight.drawAt).toBe(NOW);
    expect(flights.Counts('caracal')).toEqual({ launched: 1, inFlight: 1 });
    expect(flights.InFlightOf('caracal', 'high-0')).toBe(1);
    expect(flights.Due(NOW - 1)).toEqual([]);
    expect(flights.Due(NOW)).toMatchObject([{ kind: 'launch', flight: { id: flight.id } }]);
  });

  it('turns a hit into a missile WeaponShot carrying its launch numbers, and draws the detonation', () => {
    const flights = new MissileFlights(1);
    flights.Add(Launch(), NOW);
    flights.Due(Infinity);
    const end = flights.End(Event('hit'), NOW + 3 * TICKS_PER_SECOND, 103);
    expect(end).toMatchObject({ kind: 'hit', finishes: true, flight: { state: 'hit' } });
    // Drained at boundary 103: its ball reached the target during the tick before, so it draws at once.
    expect(end?.flight.end?.drawAt).toBe(NOW + 3 * TICKS_PER_SECOND);
    const shot = end ? flights.ShotOf(end.flight, 102.25, 103) : null;
    expect(shot).toEqual({
      ship: 'caracal',
      module: 'high-0',
      typeID: 2410,
      name: 'Heavy Missile Launcher II',
      charge: { typeID: 209, name: 'Scourge Heavy Missile' },
      target: 'punisher',
      targetKind: 'ship',
      cycle: 1,
      activation: 1,
      tick: 103,
      at: 102.25,
      distance: 0,
      effectiveness: 1,
      missile: { id: 'caracal|high-0|1|1', launchedAt: 99.4, damage: NUMBERS.damage, explosion: NUMBERS.explosion }
    });
    expect(flights.Counts('caracal')).toEqual({ launched: 1, inFlight: 0 });
    expect(flights.Due(Infinity)).toMatchObject([{ kind: 'hit' }]);
  });

  it('finishes a lost target once: the loss finishes it, the later expiry only ends its flight', () => {
    const flights = new MissileFlights(1);
    flights.Add(Launch(), NOW);
    expect(flights.End(Event('lost', { why: 'its target entered warp', at: 101 }), NOW, 101)).toMatchObject({ finishes: true, why: 'its target entered warp', flight: { state: 'lost' } });
    expect(flights.Counts('caracal').inFlight).toBe(1);
    expect(flights.End(Event('expired', { at: 109.17 }), NOW + 9 * TICKS_PER_SECOND, 110)).toMatchObject({ finishes: false, kind: 'expired', flight: { state: 'lost' } });
    expect(flights.Counts('caracal').inFlight).toBe(0);
    // The drawing vanishes at the loss (its boundary), not at the expiry.
    expect(flights.Due(Infinity).map((due) => [due.kind, due.at])).toEqual([
      ['launch', NOW],
      ['vanish', NOW]
    ]);
    expect(flights.Report(110, () => null)).toMatchObject({ launched: 1, hits: 0, lost: 1, expired: 0 });
  });

  it('lists the missiles drawn at a time: launched and taken, not ended or with their end still to draw', () => {
    const flights = new MissileFlights(1);
    const S = TICKS_PER_SECOND;
    const pursuing = flights.Add(Launch(), NOW);
    const hitting = flights.Add(Launch({ cycle: 2 }), NOW);
    const hit = flights.Add(Launch({ cycle: 3 }), NOW);
    const lost = flights.Add(Launch({ cycle: 4 }), NOW);
    const later = flights.Add(Launch({ cycle: 5 }), NOW + 4 * S);
    flights.Due(NOW + 1 * S);
    flights.End(Event('hit', { id: hitting.id }), NOW + 3 * S, 103);
    flights.End(Event('hit', { id: hit.id }), NOW + 2 * S, 102);
    flights.End(Event('lost', { id: lost.id, why: 'its target entered warp' }), NOW + 2 * S, 102);
    flights.Due(NOW + 2 * S);
    expect(flights.InFlightAt(NOW + 2.5 * S).map((flight) => flight.id)).toEqual([pursuing.id, hitting.id]);
    // Its launch not taken yet: the next frame draws it with its burst.
    expect(flights.InFlightAt(NOW + 5 * S).map((flight) => flight.id)).not.toContain(later.id);
  });

  it('vanishes at once for a lost shooter, and counts an expiry', () => {
    const flights = new MissileFlights(1);
    flights.Add(Launch(), NOW);
    flights.Add(Launch({ cycle: 2, at: 105.6, tick: 106 }), NOW);
    expect(flights.End(Event('lost', { why: 'its ship entered warp', ended: true, at: 103 }), NOW, 103)?.finishes).toBe(true);
    flights.End(Event('expired', { id: 'caracal|high-0|1|2', at: 115.4 }), NOW, 116);
    expect(flights.Report(116, () => null)).toMatchObject({ inFlight: 0, lost: 1, expired: 1 });
  });

  it('reports flying first, soonest end first, with the ball state, at most MISSILE_REPORT_ROWS rows', () => {
    const flights = new MissileFlights(1);
    for (let cycle = 1; cycle <= MISSILE_REPORT_ROWS + 5; cycle++) flights.Add(Launch({ cycle }), NOW);
    flights.End(Event('hit', { id: 'caracal|high-0|1|1' }), NOW, 103);
    const ball = (id: string): MissileReport => ({ id, owner: 'caracal', target: 'punisher', state: 'flying', position: [0, 0, 0], velocity: [0, 0, 9675], speed: 9675, mode: 'missile', distance: 1000, expiresIn: 100 - Number(id.split('|')[3]) });
    const report = flights.Report(101, ball);
    expect(report).toMatchObject({ inFlight: MISSILE_REPORT_ROWS + 4, launched: MISSILE_REPORT_ROWS + 5, hits: 1, refused: 0 });
    expect(report.flights).toHaveLength(MISSILE_REPORT_ROWS);
    expect(report.flights[0]).toEqual({ id: 'caracal|high-0|1|45', ship: 'caracal', module: 'high-0', charge: 'Scourge Heavy Missile', target: 'punisher', state: 'flying', launchedAt: 99.4, age: 1.6, expiresIn: 55, distance: 1000, speed: 9675 });
    expect(report.flights.some((row) => row.state === 'hit')).toBe(false);
  });

  it('notes a refused launch until the launcher launches again', () => {
    const flights = new MissileFlights(1);
    flights.Refused('caracal', 'high-0', 'target "punisher" is in warp');
    expect(flights.RefusalOf('caracal', 'high-0')).toBe('target "punisher" is in warp');
    expect(flights.any).toBe(true);
    flights.Add(Launch(), NOW);
    expect(flights.RefusalOf('caracal', 'high-0')).toBeNull();
    expect(flights.Report(100, () => null).refused).toBe(1);
  });

  it('prunes ended flights, forgets a removed shooter and clears on a load', () => {
    const flights = new MissileFlights(1);
    flights.Add(Launch(), NOW);
    flights.Add(Launch({ ship: 'drake' }), NOW);
    flights.End(Event('hit'), NOW, 103);
    flights.Prune(103 + MISSILE_FLIGHT_KEEP_TICKS - 1);
    expect(flights.Flight('caracal|high-0|1|1')).not.toBeNull();
    flights.Prune(103 + MISSILE_FLIGHT_KEEP_TICKS);
    expect(flights.Flight('caracal|high-0|1|1')).toBeNull();
    expect(flights.Counts('caracal').launched).toBe(1);
    flights.Forget('drake');
    expect(flights.Counts('drake')).toEqual({ launched: 0, inFlight: 0 });
    expect(flights.Due(Infinity).map((due) => due.flight.ship)).toEqual(['caracal', 'caracal']);
    flights.Clear();
    expect(flights.any).toBe(false);
    expect(flights.Report(110, () => null)).toEqual({ inFlight: 0, launched: 0, hits: 0, expired: 0, lost: 0, refused: 0, flights: [] });
  });
});

describe('MissileFlights snapshots (sd-time)', () => {
  it('restores the flights, the due moments, refusals and totals', () => {
    const flights = new MissileFlights(1);
    flights.Add(Launch(), NOW);
    flights.Add(Launch({ cycle: 2, tick: 101 }), NOW + TICKS_PER_SECOND);
    flights.Refused('caracal', 'high-1', 'no charges');
    flights.Due(NOW);
    flights.End(Event('hit'), NOW + 3 * TICKS_PER_SECOND, 103);
    const trip = RoundTrip(
      flights,
      (f) => [f.Report(103, () => null), f.Counts('caracal'), f.RefusalOf('caracal', 'high-1'), f.Flight('caracal|high-0|1|2')],
      (f) => {
        f.Add(Launch({ cycle: 3, tick: 104 }), NOW + 4 * TICKS_PER_SECOND);
        f.End(Event('expired', { id: 'caracal|high-0|1|2', at: 110, tick: 110 }), NOW + 10 * TICKS_PER_SECOND, 110);
        f.Prune(110 + MISSILE_FLIGHT_KEEP_TICKS);
        f.Forget('caracal');
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
    expect(flights.Due(NOW + 2 * TICKS_PER_SECOND)).toMatchObject([{ kind: 'launch', flight: { id: 'caracal|high-0|1|2' } }]);
  });
});
