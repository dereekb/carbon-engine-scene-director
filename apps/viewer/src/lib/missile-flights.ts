/**
 * The missile flight book: every missile a launcher fired, from its launch to its end, beside its ball in
 * DestinyWorld. Live state only; a load clears it (Clear), and a removed shooter's flights go with it (Forget).
 *
 * - A launch (Add) captures the launcher's missile numbers then: a missile carries its damage and explosion to the
 *   target whatever happens to its launcher afterwards.
 * - Ends (End) come from DestinyWorld's missile events: a hit becomes a WeaponShot with `missile` for Combat rules
 *   (MissileShotOf); an expiry or a loss is a finished launch with no damage (Combat rules' Expire). A missile that
 *   lost its target finishes then, though it flies on to its expiry.
 * - Draw times: the replica draws a missile's ball at master time, with none of the ships' lag (GPU, 2026-10-23: the
 *   drawn ball reached its target a tick before the turret rule's T(boundary) + (at + 1 − tick) and had flown 8 km at
 *   that rule's launch). So a launch draws at its boundary, as its ball leaves the shooter, and an end at the boundary
 *   it is drained at (its ball got there during the tick before). Due(now) hands out the drawn launches and ends in
 *   draw order: with a renderer they draw the missile; without one they time the launcher and impact sounds and a
 *   kill's explosion start.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { MissileCombatNumbers, ShotTargetKind, WeaponShot } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import { MISSILE_BALL_LINGER_TICKS, type MissileEvent, type MissileReport } from './destiny';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

/**
 * Rows get_state lists at most.
 */
export const MISSILE_REPORT_ROWS = 40;

/**
 * Ticks an ended flight stays in the book after its end: its ball's linger plus the drawn lag.
 */
export const MISSILE_FLIGHT_KEEP_TICKS = MISSILE_BALL_LINGER_TICKS + 2;

/**
 * A flight's id: one per launcher cycle.
 *
 * @param ship - The shooter.
 * @param module - The launcher's module key.
 * @param activation - The launcher's activation since the load.
 * @param cycle - Its cycle within the activation.
 * @returns `<ship>|<module>|<activation>|<cycle>`.
 */
export function MissileFlightId(ship: string, module: string, activation: number, cycle: number): string {
  return `${ship}|${module}|${activation}|${cycle}`;
}

/**
 * One launch: a launcher cycle start with a target.
 */
export interface MissileLaunchRecord {
  readonly id: string;
  readonly ship: string;
  readonly module: string;
  readonly typeID: number;
  readonly name: string;
  readonly charge?: { readonly typeID: number; readonly name: string };
  readonly target: string;
  readonly targetKind: ShotTargetKind;
  readonly cycle: number;
  readonly activation: number;
  /**
   * The master tick boundary it launched at.
   */
  readonly tick: number;
  /**
   * The exact, fractional master tick its cycle started at (at most `tick`).
   */
  readonly at: number;
  /**
   * The launcher's numbers at launch; null without dogma (it does no damage).
   */
  readonly numbers: Maybe<MissileCombatNumbers>;
}

export type MissileFlightState = 'flying' | 'lost' | 'hit' | 'expired';

export interface MissileFlight extends MissileLaunchRecord {
  state: MissileFlightState;
  /**
   * Scene clock (100 ns ticks) its launch draws at.
   */
  readonly drawAt: number;
  /**
   * Why it was lost.
   */
  why: Maybe<string>;
  /**
   * Its end: the fractional master tick, the boundary it was drained at, and when it draws.
   */
  end: Maybe<{ readonly at: number; readonly tick: number; readonly drawAt: number }>;
  /**
   * Whether it finished for Combat rules (a hit, an expiry or a loss), once.
   */
  finished: boolean;
}

/**
 * What End made of an event.
 */
export interface MissileEnd {
  readonly flight: MissileFlight;
  readonly kind: MissileEvent['kind'];
  /**
   * Whether this event finished the launch: Combat rules resolves it (a hit) or records it (Expire, with `why`).
   */
  readonly finishes: boolean;
  readonly why?: string;
}

/**
 * A drawn moment: a launch, a hit (detonation) or a vanish (an expiry, a lost shooter's end, or a lost target's loss:
 * that missile flies on undrawn to its expiry).
 */
export interface MissileDue {
  readonly kind: 'launch' | 'hit' | 'vanish';
  readonly flight: MissileFlight;
  /**
   * Scene clock, 100 ns ticks.
   */
  readonly at: number;
}

/**
 * The scene's missiles in get_state.
 */
export interface MissileFlightsReport {
  readonly inFlight: number;
  readonly launched: number;
  readonly hits: number;
  readonly expired: number;
  readonly lost: number;
  readonly refused: number;
  readonly flights: readonly MissileFlightRow[];
}

export interface MissileFlightRow {
  readonly id: string;
  readonly ship: string;
  readonly module: string;
  readonly charge?: string;
  readonly target: string;
  readonly state: MissileFlightState;
  /**
   * The fractional master tick its cycle started at.
   */
  readonly launchedAt: number;
  /**
   * Seconds since its launch.
   */
  readonly age: number;
  readonly expiresIn?: number;
  /**
   * Metres, surface to surface to its target, while its ball is on the parks.
   */
  readonly distance?: number;
  readonly speed?: number;
  readonly why?: string;
}

/**
 * What a MissileFlights snapshot (sd-time) leaves out: its wiring (tickTicks, tickSeconds).
 */
const MISSILE_FLIGHTS_CAPTURE: CaptureOptions = { wiring: ['tickTicks', 'tickSeconds'] };

export class MissileFlights {
  /**
   * Scene clock ticks (100 ns) per Destiny tick.
   */
  private readonly tickTicks: number;
  private readonly tickSeconds: number;
  private readonly flights = new Map<string, MissileFlight>();
  private due: MissileDue[] = [];
  private readonly launched = new Map<string, number>();
  private readonly refusals = new Map<string, string>();
  private totals = { launched: 0, hits: 0, expired: 0, lost: 0, refused: 0 };

  /**
   * @param tickSeconds - Seconds per Destiny tick.
   */
  constructor(tickSeconds: number) {
    this.tickSeconds = tickSeconds;
    this.tickTicks = tickSeconds * TICKS_PER_SECOND;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, MISSILE_FLIGHTS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, MISSILE_FLIGHTS_CAPTURE, memo);
  }

  /**
   * Records a launch DestinyWorld took, and queues its drawn launch.
   *
   * @param launch - The launch.
   * @param now - The scene clock at its boundary, 100 ns ticks.
   * @returns The flight.
   */
  Add(launch: MissileLaunchRecord, now: number): MissileFlight {
    const flight: MissileFlight = { ...launch, state: 'flying', drawAt: this.DrawAt(now, launch.at, launch.tick), why: null, end: null, finished: false };
    this.flights.set(flight.id, flight);
    this.launched.set(flight.ship, (this.launched.get(flight.ship) ?? 0) + 1);
    this.refusals.delete(WeaponKey(flight.ship, flight.module));
    this.totals.launched += 1;
    this.Queue({ kind: 'launch', flight, at: flight.drawAt });
    return flight;
  }

  /**
   * Counts a launch DestinyWorld refused; the launcher's row notes it until its next launch.
   *
   * @param ship - The shooter.
   * @param module - The launcher.
   * @param why - DestinyWorld's refusal.
   */
  Refused(ship: string, module: string, why: string): void {
    this.totals.refused += 1;
    this.refusals.set(WeaponKey(ship, module), why);
  }

  /**
   * A launcher's latest refused launch, until it launches again.
   */
  RefusalOf(ship: string, module: string): Maybe<string> {
    return this.refusals.get(WeaponKey(ship, module)) ?? null;
  }

  /**
   * Applies a DestinyWorld missile event drained at a boundary.
   *
   * @param event - The event.
   * @param now - The scene clock at the boundary, 100 ns ticks.
   * @param boundary - The master tick it was drained at.
   * @returns What it ended, or null for a flight the book does not hold.
   */
  End(event: MissileEvent, now: number, boundary: number): Maybe<MissileEnd> {
    const flight = this.flights.get(event.id);
    if (!flight) return null;
    const finishes = !flight.finished;
    const wasLost = flight.state === 'lost';
    flight.finished = true;
    if (event.kind === 'lost') {
      flight.why = event.why ?? null;
      if (flight.state === 'flying') flight.state = 'lost';
      if (finishes) this.totals.lost += 1;
    } else if (event.kind === 'hit') {
      flight.state = 'hit';
      this.totals.hits += 1;
    } else {
      if (flight.state === 'flying') flight.state = 'expired';
      if (finishes) this.totals.expired += 1;
    }
    // A lost target's missile flies on undamaging to its expiry; its drawing vanishes at the loss (a drawn warhead left
    // on the hull would detonate there), so its later end queues nothing.
    if (event.kind === 'lost' && !event.ended && !wasLost) this.Queue({ kind: 'vanish', flight, at: this.DrawAt(now, event.at, boundary) });
    if (event.ended && !flight.end) {
      flight.end = { at: event.at, tick: boundary, drawAt: this.DrawAt(now, event.at, boundary) };
      if (!wasLost) this.Queue({ kind: event.kind === 'hit' ? 'hit' : 'vanish', flight, at: flight.end.drawAt });
    }
    return { flight, kind: event.kind, finishes, ...(flight.why ? { why: flight.why } : {}) };
  }

  /**
   * The WeaponShot of a flight's end, for Combat rules: the launcher's fields, distance 0, effectiveness 1, and the
   * missile's launch numbers.
   *
   * @param flight - The flight.
   * @param at - The end's fractional master tick.
   * @param boundary - The master tick it resolves at.
   * @returns The shot.
   */
  ShotOf(flight: MissileFlight, at: number, boundary: number): WeaponShot {
    return {
      ship: flight.ship,
      module: flight.module,
      typeID: flight.typeID,
      name: flight.name,
      ...(flight.charge ? { charge: flight.charge } : {}),
      target: flight.target,
      targetKind: flight.targetKind,
      cycle: flight.cycle,
      activation: flight.activation,
      tick: boundary,
      at,
      distance: 0,
      effectiveness: 1,
      missile: { id: flight.id, launchedAt: flight.at, damage: flight.numbers?.damage ?? null, explosion: flight.numbers?.explosion ?? null }
    };
  }

  /**
   * Takes the drawn launches and ends due by `now`, in draw order.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns The moments due.
   */
  Due(now: number): MissileDue[] {
    const index = this.due.findIndex((due) => due.at > now);
    return this.due.splice(0, index < 0 ? this.due.length : index);
  }

  /**
   * Drops ended flights MISSILE_FLIGHT_KEEP_TICKS after their end, at a boundary.
   *
   * @param boundary - The master tick.
   */
  Prune(boundary: number): void {
    for (const [id, flight] of this.flights) {
      if (flight.end && boundary - flight.end.tick >= MISSILE_FLIGHT_KEEP_TICKS) this.flights.delete(id);
    }
  }

  Flight(id: string): Maybe<MissileFlight> {
    return this.flights.get(id) ?? null;
  }

  /**
   * A ship's launches since the load and its missiles still flying (pursuing or lost and flying on).
   */
  Counts(ship: string): { readonly launched: number; readonly inFlight: number } {
    let inFlight = 0;
    for (const flight of this.flights.values()) if (flight.ship === ship && !flight.end) inFlight += 1;
    return { launched: this.launched.get(ship) ?? 0, inFlight };
  }

  /**
   * A launcher's missiles still flying.
   */
  InFlightOf(ship: string, module: string): number {
    let count = 0;
    for (const flight of this.flights.values()) if (flight.ship === ship && flight.module === module && !flight.end) count += 1;
    return count;
  }

  /**
   * Whether any missile was launched since the load.
   */
  get any(): boolean {
    return this.totals.launched > 0 || this.totals.refused > 0;
  }

  /**
   * get_state's scene-level missiles: totals and at most MISSILE_REPORT_ROWS flights, flying first, soonest end first.
   *
   * @param boundary - The master tick now.
   * @param missile - DestinyWorld.Missile: the ball's live state.
   * @returns The report.
   */
  Report(boundary: number, missile: (id: string) => Maybe<MissileReport>): MissileFlightsReport {
    const rows: { row: MissileFlightRow; order: number; ends: number }[] = [];
    let inFlight = 0;
    for (const flight of this.flights.values()) {
      if (!flight.end) inFlight += 1;
      const ball = missile(flight.id);
      const row: MissileFlightRow = {
        id: flight.id,
        ship: flight.ship,
        module: flight.module,
        ...(flight.charge ? { charge: flight.charge.name } : {}),
        target: flight.target,
        state: flight.state,
        launchedAt: Round(flight.at, 1000),
        age: Round((boundary - flight.at) * this.tickSeconds, 1000),
        ...(ball && !flight.end ? { expiresIn: ball.expiresIn } : {}),
        ...(ball?.distance != null ? { distance: ball.distance } : {}),
        ...(ball ? { speed: ball.speed } : {}),
        ...(flight.why ? { why: flight.why } : {})
      };
      rows.push({ row, order: STATE_ORDER[flight.state], ends: row.expiresIn ?? Infinity });
    }
    rows.sort((a, b) => a.order - b.order || a.ends - b.ends || Compare(a.row.id, b.row.id));
    const { launched, hits, expired, lost, refused } = this.totals;
    return { inFlight, launched, hits, expired, lost, refused, flights: rows.slice(0, MISSILE_REPORT_ROWS).map((entry) => entry.row) };
  }

  /**
   * A shooter left the scene: its flights and their drawn moments go.
   *
   * @param ship - The shooter.
   */
  Forget(ship: string): void {
    for (const [id, flight] of this.flights) if (flight.ship === ship) this.flights.delete(id);
    this.due = this.due.filter((due) => due.flight.ship !== ship);
    this.launched.delete(ship);
    for (const key of [...this.refusals.keys()]) if (key.startsWith(`${ship}\u0000`)) this.refusals.delete(key);
  }

  /**
   * A load: every flight, count and drawn moment goes.
   */
  Clear(): void {
    this.flights.clear();
    this.due = [];
    this.launched.clear();
    this.refusals.clear();
    this.totals = { launched: 0, hits: 0, expired: 0, lost: 0, refused: 0 };
  }

  private DrawAt(now: number, at: number, tick: number): number {
    return Math.round(now + Math.max(0, at - tick) * this.tickTicks);
  }

  private Queue(due: MissileDue): void {
    const index = this.due.findIndex((other) => other.at > due.at);
    this.due.splice(index < 0 ? this.due.length : index, 0, due);
  }
}

const STATE_ORDER: Readonly<Record<MissileFlightState, number>> = { flying: 0, lost: 1, hit: 2, expired: 3 };

function WeaponKey(ship: string, module: string): string {
  return `${ship}\u0000${module}`;
}

function Compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function Round(value: number, scale: number): number {
  return Math.round(value * scale) / scale + 0;
}
