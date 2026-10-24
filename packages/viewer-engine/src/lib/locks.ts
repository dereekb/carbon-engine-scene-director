/**
 * Every ship's target locks on EVE's rules: a turret fires only at a locked target. Live state only, never written to
 * the document; a load clears it.
 *
 * - Lock time = 40000 / (scan resolution × asinh(signature)²) s (the package's lockTime), from the shooter's live scan
 *   resolution and the target's live signature, fixed when the lock starts.
 * - Lifecycle `waiting` → `locking` → `locked`, on tick boundaries: a lock starts at the first boundary after it is
 *   asked for, while the target is within the shooter's max targeting range (surface to surface); it completes at the
 *   first boundary at or after start + lock time. A target out of range waits (`out of targeting range`), and a
 *   locking or locked lock whose target leaves range is lost back to waiting.
 * - A target removed or destroyed, either ship entering warp, or a load clears the lock.
 * - The sweep (Boundary's `wanted`): a ship keeps only the locks it wants (its target, its turrets' targets, its
 *   Keeps) and locks every wanted target it has room for; the rest are released. A ship holds at most its maxLocks
 *   (its maxLockedTargets capped by the pilot's 12).
 * - Hold: why a turret must wait for its lock (`waiting for its lock on "x" (1.6 s)`); null once locked, and for a
 *   ship with no targeting numbers (no EVE dogma for its hull), which fires unlocked as before.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { lockTime } from '@scene-director/scene';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

/**
 * A shooter's live targeting numbers.
 */
export interface LockTargeting {
  /**
   * mm.
   */
  readonly scanResolution: number;
  /**
   * Metres.
   */
  readonly maxTargetRange: number;
  readonly maxLocks: number;
}

export interface ShipLocksPort {
  /**
   * Metres, surface to surface; null when either is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
  InWarp(id: string): boolean;
  /**
   * A live target: a ship that is not destroyed, or an authored object.
   */
  IsTargetable(id: string): boolean;
  /**
   * The shooter's live targeting; null: it cannot lock (no EVE dogma for its hull).
   */
  Targeting(id: string): Maybe<LockTargeting>;
  /**
   * The target's live signature radius (m): a ship's with its MWD bloom, an object's ball radius.
   */
  SignatureOf(id: string): number;
  readonly tickSeconds: number;
}

export type LockState = 'waiting' | 'locking' | 'locked';

export type LockEventKind = 'started' | 'locked' | 'lost' | 'released';

/**
 * A lock change at a boundary.
 */
export interface LockEvent {
  readonly kind: LockEventKind;
  readonly ship: string;
  readonly target: string;
  readonly tick: number;
  /**
   * Why a lock was lost or released.
   */
  readonly why?: string;
}

/**
 * A lock in get_state.
 */
export interface ShipLockReport {
  readonly target: string;
  readonly state: LockState;
  /**
   * Seconds (3 decimals), once it started.
   */
  readonly lockTime?: number;
  /**
   * Seconds until it completes (2 decimals), while locking.
   */
  readonly readyIn?: number;
  readonly note?: string;
}

/**
 * A ship's lock.
 */
export interface Lock {
  readonly ship: string;
  readonly target: string;
  readonly state: LockState;
}

interface LockEntry {
  readonly target: string;
  state: LockState;
  /**
   * The boundary it was asked for: it starts at a later one.
   */
  readonly requested: number;
  /**
   * Seconds, fixed at its start.
   */
  lockTime?: number;
  /**
   * The boundary it completes at.
   */
  done?: number;
  note?: string;
}

/**
 * Below this, a lock's completion counts as reached (float ticks).
 */
const LOCK_EPSILON = 1e-9;

/**
 * What a ShipLocks snapshot (sd-time) leaves out: its wiring (port).
 */
const LOCKS_CAPTURE: CaptureOptions = { wiring: ['port'] };

export class ShipLocks {
  private readonly port: ShipLocksPort;
  /**
   * Ship id → target id → its lock, in the order they were asked for.
   */
  private readonly ships = new Map<string, Map<string, LockEntry>>();
  private readonly keeps = new Map<string, Set<string>>();

  constructor(port: ShipLocksPort) {
    this.port = port;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, LOCKS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, LOCKS_CAPTURE, memo);
  }

  /**
   * Asks for a lock: it starts at the next boundary.
   *
   * @param ship - The shooter.
   * @param target - The ship or object to lock.
   * @param tick - The master tick now.
   * @param wanted - The ship's wanted locks now: a lock outside it may make room at the limit.
   * @returns The refusal, or null (also when it is already asked for).
   */
  Request(ship: string, target: string, tick: number, wanted?: ReadonlySet<string>): Maybe<string> {
    const targeting = this.port.Targeting(ship);
    const locks = this.ships.get(ship) ?? new Map<string, LockEntry>();
    let refusal: Maybe<string> = null;
    if (locks.has(target)) {
      refusal = null;
    } else if (!targeting) {
      refusal = 'it cannot lock: no EVE dogma for its hull';
    } else if (target === ship) {
      refusal = 'it cannot lock itself';
    } else if (!this.port.IsTargetable(target)) {
      refusal = `no ship or object "${target}" to lock`;
    } else if (locks.size >= targeting.maxLocks) {
      const free = [...locks.keys()].find((other) => !wanted?.has(other) && !this.keeps.get(ship)?.has(other));
      if (free == null) refusal = `it holds ${locks.size} locks, its most`;
      else locks.delete(free);
    }
    if (refusal === null && targeting && !locks.has(target) && target !== ship) {
      locks.set(target, { target, state: 'waiting', requested: tick });
      this.ships.set(ship, locks);
    }
    return refusal;
  }

  /**
   * Keeps a lock through the sweep (a pre-lock), and asks for it.
   *
   * @param ship - The shooter.
   * @param target - The target.
   * @param tick - The master tick now.
   * @returns The refusal, or null.
   */
  Keep(ship: string, target: string, tick: number): Maybe<string> {
    const keeps = this.keeps.get(ship) ?? new Set<string>();
    keeps.add(target);
    this.keeps.set(ship, keeps);
    return this.Request(ship, target, tick);
  }

  /**
   * Drops a Keep and the lock.
   */
  Release(ship: string, target: string): void {
    this.keeps.get(ship)?.delete(target);
    this.ships.get(ship)?.delete(target);
  }

  /**
   * Advances every lock to a tick boundary: the sweep, starts, completions and losses.
   *
   * @param tick - The master tick.
   * @param wanted - Each ship's wanted targets (its target, its turrets' targets); Keeps are added.
   * @returns The lock events, ship by ship.
   */
  Boundary(tick: number, wanted: ReadonlyMap<string, ReadonlySet<string>>): LockEvent[] {
    const events: LockEvent[] = [];
    for (const [ship, locks] of this.ships) {
      const wants = this.Wants(ship, wanted);
      for (const target of [...locks.keys()]) {
        if (!wants.has(target)) {
          locks.delete(target);
          events.push({ kind: 'released', ship, target, tick, why: 'no longer wanted' });
        }
      }
    }
    for (const ship of new Set([...wanted.keys(), ...this.keeps.keys()])) {
      for (const target of this.Wants(ship, wanted)) if (!this.ships.get(ship)?.has(target)) this.Request(ship, target, tick - 1, this.Wants(ship, wanted));
    }
    for (const [ship, locks] of this.ships) {
      const targeting = this.port.Targeting(ship);
      for (const [target, entry] of [...locks]) {
        const gone = !targeting || !this.port.IsTargetable(target) || this.port.InWarp(ship) || this.port.InWarp(target);
        if (gone) {
          locks.delete(target);
          events.push({ kind: 'lost', ship, target, tick, why: targeting ? 'its target is gone' : 'no EVE dogma for its hull' });
          continue;
        }
        const distance = this.port.SurfaceDistance(ship, target);
        const inRange = distance != null && distance <= targeting.maxTargetRange;
        if (!inRange) {
          if (entry.state !== 'waiting') events.push({ kind: 'lost', ship, target, tick, why: 'out of targeting range' });
          entry.state = 'waiting';
          delete entry.lockTime;
          delete entry.done;
          entry.note = `out of targeting range: ${Km(distance)}, it locks at ${Km(targeting.maxTargetRange)}`;
          continue;
        }
        if (entry.state === 'waiting' && tick > entry.requested) {
          const seconds = lockTime(targeting.scanResolution, this.port.SignatureOf(target));
          entry.state = 'locking';
          entry.lockTime = seconds;
          entry.done = Number.isFinite(seconds) ? Math.ceil(tick + seconds / this.port.tickSeconds - LOCK_EPSILON) : Infinity;
          delete entry.note;
          events.push({ kind: 'started', ship, target, tick });
        }
        if (entry.state === 'locking' && (entry.done ?? Infinity) <= tick) {
          entry.state = 'locked';
          events.push({ kind: 'locked', ship, target, tick });
        }
      }
      if (!locks.size) this.ships.delete(ship);
    }
    return events;
  }

  IsLocked(ship: string, target: string): boolean {
    return this.ships.get(ship)?.get(target)?.state === 'locked';
  }

  /**
   * Why a turret on a ship must wait before it fires at a target.
   *
   * @param ship - The shooter.
   * @param target - Its turret's target.
   * @param tick - The master tick now (for the seconds left).
   * @returns Null once locked (or for a ship that cannot lock); else the note.
   */
  Hold(ship: string, target: string, tick: number): Maybe<string> {
    if (!this.port.Targeting(ship)) return null;
    const entry = this.ships.get(ship)?.get(target);
    let hold: Maybe<string> = null;
    if (!entry) hold = `waiting for a lock on "${target}"`;
    else if (entry.state === 'locking') hold = `waiting for its lock on "${target}" (${Round(Math.max(0, (entry.done ?? tick) - tick) * this.port.tickSeconds, 1)} s)`;
    else if (entry.state === 'waiting') hold = entry.note ? `waiting for its lock on "${target}": ${entry.note}` : `waiting for its lock on "${target}"`;
    return hold;
  }

  /**
   * A ship's locks.
   */
  Of(ship: string): Lock[] {
    return [...(this.ships.get(ship)?.values() ?? [])].map((entry) => ({ ship, target: entry.target, state: entry.state }));
  }

  /**
   * The ships locking or locked on a target.
   */
  On(target: string): string[] {
    return [...this.ships].flatMap(([ship, locks]) => (locks.has(target) ? [ship] : []));
  }

  /**
   * The locks started or done on a target (`locking` or `locked`): who EVE shows as targeting it. A `waiting` lock
   * (requested, or out of range) does not count.
   */
  Lockers(target: string): Lock[] {
    return [...this.ships].flatMap(([ship, locks]) => {
      const entry = locks.get(target);
      return entry && (entry.state === 'locking' || entry.state === 'locked') ? [{ ship, target, state: entry.state }] : [];
    });
  }

  /**
   * A ship or object left the scene (or was destroyed): its own locks and every lock on it go.
   */
  Remove(id: string): void {
    this.ships.delete(id);
    this.keeps.delete(id);
    for (const [ship, locks] of this.ships) {
      locks.delete(id);
      this.keeps.get(ship)?.delete(id);
      if (!locks.size) this.ships.delete(ship);
    }
  }

  /**
   * A ship entered warp: its own locks and every lock on it break, as EVE does.
   */
  OnWarpEnter(id: string): void {
    this.ships.delete(id);
    for (const [ship, locks] of this.ships) {
      locks.delete(id);
      if (!locks.size) this.ships.delete(ship);
    }
  }

  /**
   * Forgets every lock and Keep (a load).
   */
  Clear(): void {
    this.ships.clear();
    this.keeps.clear();
  }

  /**
   * A ship's locks for get_state.
   *
   * @param ship - The ship id.
   * @param tick - The master tick now.
   * @returns Its locks, in the order they were asked for.
   */
  Report(ship: string, tick: number): ShipLockReport[] {
    return [...(this.ships.get(ship)?.values() ?? [])].map((entry) => ({
      target: entry.target,
      state: entry.state,
      ...(entry.lockTime != null && Number.isFinite(entry.lockTime) ? { lockTime: Round(entry.lockTime, 3) } : {}),
      ...(entry.state === 'locking' && entry.done != null && Number.isFinite(entry.done) ? { readyIn: Round(Math.max(0, entry.done - tick) * this.port.tickSeconds, 2) } : {}),
      ...(entry.note ? { note: entry.note } : {})
    }));
  }

  private Wants(ship: string, wanted: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
    return new Set([...(wanted.get(ship) ?? []), ...(this.keeps.get(ship) ?? [])]);
  }
}

function Km(metres: Maybe<number>): string {
  return metres == null ? 'unknown' : `${Round(metres / 1000, 1)} km`;
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
