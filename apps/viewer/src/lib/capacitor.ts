/**
 * The live capacitor level of every fitted ship, for capacitor warfare (target-effects.ts): neuts and nos drain it,
 * remote capacitor transmitters fill it, and it recharges on EVE's curve in between.
 *
 * - Recharge: `dC/dt = 10·Cmax/τ·(√c − c)` (c the fraction full, τ the recharge time), the curve shipCapacitorOf uses.
 *   With u = √c it is `du/dt = 5/τ·(1 − u)`, so `√c(t) = 1 + (√c0 − 1)·e^(−5t/τ)`: exact for any step, so the level is
 *   recharged lazily, from its last change to the time asked.
 * - A ship starts full. A new evaluation (a refit, a hardener's states, a capacity bonus) keeps the fraction.
 * - Nos: drains only while the target holds more than the shooter, and never below the shooter's level (absolute GJ,
 *   EVE's rule since Odyssey 1.1), unless its nosOverride is set; the shooter gains what was drained, up to its
 *   capacity.
 * - Not here (the live-capacitor follow-up): the ship's own modules using it, modules stopping when it runs dry, cap
 *   boosters. The static drain, stable and stableAt / lastsFor stay the evaluated numbers.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';

/**
 * The evaluated numbers the live level runs on (ShipCapacitor's).
 */
export interface CapacitorNumbers {
  /**
   * GJ.
   */
  readonly capacity: number;
  /**
   * Seconds to recharge from empty.
   */
  readonly rechargeTime: number;
  /**
   * The fraction of a neut's or nos' amount it takes.
   */
  readonly energyWarfareResistance: number;
  /**
   * The fraction of a transmitter's amount it takes.
   */
  readonly remoteCapacitorImpedance: number;
}

export interface CapacitorReport {
  /**
   * GJ.
   */
  readonly level: number;
  /**
   * level / capacity, 0-1.
   */
  readonly fraction: number;
}

interface CapacitorEntry {
  numbers: CapacitorNumbers;
  /**
   * The level at `at`.
   */
  level: number;
  at: number;
}

export class CapacitorModel {
  private readonly tickSeconds: number;
  private readonly ships = new Map<string, CapacitorEntry>();

  /**
   * @param tickSeconds - Seconds per tick, the unit every `tick` argument counts in (default 1: Destiny's).
   */
  constructor(tickSeconds = 1) {
    this.tickSeconds = tickSeconds;
  }

  /**
   * Gives a ship its evaluated numbers: full the first time, the same fraction (recharged to `tick` first) after.
   *
   * @param id - The ship id.
   * @param numbers - Its capacitor.
   * @param tick - Now.
   */
  Set(id: string, numbers: CapacitorNumbers, tick: number): void {
    const entry = this.ships.get(id);
    if (!entry) {
      this.ships.set(id, { numbers, level: Math.max(0, numbers.capacity), at: tick });
      return;
    }
    const fraction = this.FractionAt(entry, tick);
    entry.numbers = numbers;
    entry.level = fraction * Math.max(0, numbers.capacity);
    entry.at = tick;
  }

  Has(id: string): boolean {
    return this.ships.has(id);
  }

  Remove(id: string): void {
    this.ships.delete(id);
  }

  Clear(): void {
    this.ships.clear();
  }

  /**
   * A ship's evaluated numbers.
   *
   * @param id - The ship id.
   * @returns Them, or null for a ship without a live capacitor.
   */
  Numbers(id: string): Maybe<CapacitorNumbers> {
    return this.ships.get(id)?.numbers ?? null;
  }

  /**
   * A ship's level now.
   *
   * @param id - The ship id.
   * @param tick - Now.
   * @returns GJ, or null for a ship without a live capacitor.
   */
  Level(id: string, tick: number): Maybe<number> {
    const entry = this.ships.get(id);
    return entry ? this.LevelAt(entry, tick) : null;
  }

  /**
   * Takes capacitor from a ship (a neut).
   *
   * @param id - The ship id.
   * @param amount - GJ asked for.
   * @param tick - Now.
   * @returns GJ taken: at most its level; 0 without a live capacitor.
   */
  Drain(id: string, amount: number, tick: number): number {
    const entry = this.ships.get(id);
    if (!entry) return 0;
    const level = this.Settle(entry, tick);
    const taken = Math.min(level, Math.max(0, amount));
    entry.level = level - taken;
    return taken;
  }

  /**
   * Gives a ship capacitor (a transmitter, a nos' gain).
   *
   * @param id - The ship id.
   * @param amount - GJ given.
   * @param tick - Now.
   * @returns GJ it took: at most capacity − level; 0 without a live capacitor.
   */
  Give(id: string, amount: number, tick: number): number {
    const entry = this.ships.get(id);
    if (!entry) return 0;
    const level = this.Settle(entry, tick);
    const given = Math.min(Math.max(0, entry.numbers.capacity - level), Math.max(0, amount));
    entry.level = level + given;
    return given;
  }

  /**
   * A nos cycle: drains the target only while it holds more than the shooter, never below the shooter's level (unless
   * `override`), and gives the shooter what it drained, up to its capacity.
   *
   * @param from - The shooter.
   * @param to - The target.
   * @param amount - GJ per cycle (after effectiveness and resistance).
   * @param override - nosOverride: drain whatever the levels.
   * @param tick - Now.
   * @returns GJ drained from the target.
   */
  Nos(from: string, to: string, amount: number, override: boolean, tick: number): number {
    const target = this.Level(to, tick);
    if (target == null) return 0;
    const shooter = this.Level(from, tick) ?? 0;
    const room = override ? target : Math.max(0, target - shooter);
    const drained = this.Drain(to, Math.min(Math.max(0, amount), room), tick);
    this.Give(from, drained, tick);
    return drained;
  }

  /**
   * A ship's level for get_state.
   *
   * @param id - The ship id.
   * @param tick - Now.
   * @returns The level and the fraction, or null without a live capacitor.
   */
  Report(id: string, tick: number): Maybe<CapacitorReport> {
    const entry = this.ships.get(id);
    if (!entry) return null;
    const level = this.LevelAt(entry, tick);
    return { level, fraction: entry.numbers.capacity > 0 ? level / entry.numbers.capacity : 0 };
  }

  private Settle(entry: CapacitorEntry, tick: number): number {
    entry.level = this.LevelAt(entry, tick);
    entry.at = Math.max(entry.at, tick);
    return entry.level;
  }

  private LevelAt(entry: CapacitorEntry, tick: number): number {
    return this.FractionAt(entry, tick) * Math.max(0, entry.numbers.capacity);
  }

  private FractionAt(entry: CapacitorEntry, tick: number): number {
    const { capacity, rechargeTime } = entry.numbers;
    if (!(capacity > 0)) return 0;
    const start = Math.min(1, Math.max(0, entry.level / capacity));
    const seconds = Math.max(0, tick - entry.at) * this.tickSeconds;
    let fraction = 1;
    if (seconds <= 0) fraction = start;
    else if (rechargeTime > 0) fraction = CapacitorFractionAfter({ fraction: start, seconds, rechargeTime });
    return fraction;
  }
}

/**
 * EVE's recharge curve in closed form.
 *
 * @param input - The fraction full now, the seconds that pass and the recharge time (s).
 * @returns The fraction full after them: `(1 + (√c0 − 1)·e^(−5t/τ))²`.
 */
export function CapacitorFractionAfter(input: { readonly fraction: number; readonly seconds: number; readonly rechargeTime: number }): number {
  const { fraction, seconds, rechargeTime } = input;
  const root = 1 + (Math.sqrt(Math.min(1, Math.max(0, fraction))) - 1) * Math.exp((-5 * seconds) / rechargeTime);
  return root * root;
}
