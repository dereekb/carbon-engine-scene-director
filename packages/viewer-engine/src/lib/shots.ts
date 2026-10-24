/**
 * Weapon shots: one per turret cycle start on a target (WeaponShotsOf), raised at the tick boundary to the director's
 * OnShot listeners, then drawn by the ShotQueue one tick after the cycle's exact start.
 *
 * - A shot of a cycle that started at the fractional master tick `at` and was raised at boundary `tick` draws at scene
 *   clock T(boundary) + (at + 1 − tick) ticks: so a 4.25 s gun fires every 4.25 s on screen, not on whole ticks, and the
 *   draw always follows its boundary event (once Combat rules has decided the hit).
 * - The queue counts the shots per ship since the load, and settles a weapon after its `off`: once its queued shots
 *   have drawn and its last burst has run (the firing effect's duration after the draw), its set may return to
 *   TARGETING or IDLE.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { ShotTargetKind, WeaponShot } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { ShipModuleEvent } from './modules';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

/**
 * What WeaponShotsOf needs to know about the shooter's weapons and the targets.
 */
export interface WeaponShotsPort {
  /**
   * A ship's turret module: its type, name and loaded charge; null for a module that is no turret.
   */
  Turret(ship: string, module: string): Maybe<{ readonly typeID: number; readonly name: string; readonly charge?: { readonly typeID: number; readonly name: string } }>;
  KindOf(target: string): Maybe<ShotTargetKind>;
  /**
   * Metres, surface to surface; null when either is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
}

/**
 * The shots a batch of boundary events fires: every turret `cycle` event with a target.
 *
 * @param events - The module events.
 * @param port - The weapons and targets.
 * @returns The shots, in event order.
 */
export function WeaponShotsOf(events: readonly ShipModuleEvent[], port: WeaponShotsPort): WeaponShot[] {
  const shots: WeaponShot[] = [];
  for (const event of events) {
    if (event.kind !== 'cycle' || !event.target) continue;
    const weapon = port.Turret(event.ship, event.module);
    const targetKind = port.KindOf(event.target);
    const distance = port.SurfaceDistance(event.ship, event.target);
    if (!weapon || !targetKind || distance == null) continue;
    shots.push({
      ship: event.ship,
      module: event.module,
      typeID: weapon.typeID,
      name: weapon.name,
      ...(weapon.charge ? { charge: { typeID: weapon.charge.typeID, name: weapon.charge.name } } : {}),
      target: event.target,
      targetKind,
      cycle: event.cycle,
      activation: event.activation,
      tick: event.tick,
      at: event.at ?? event.tick,
      distance: Math.round(distance),
      effectiveness: event.effectiveness ?? 1
    });
  }
  return shots;
}

/**
 * A weapon the queue settles: its ship and module key.
 */
export interface SettledWeapon {
  readonly ship: string;
  readonly module: string;
}

interface QueuedShot {
  readonly shot: WeaponShot;
  /**
   * Scene clock, 100 ns ticks.
   */
  readonly drawAt: number;
}

/**
 * What a ShotQueue snapshot (sd-time) leaves out: its wiring (tickTicks).
 */
const SHOT_QUEUE_CAPTURE: CaptureOptions = { wiring: ['tickTicks'] };

export class ShotQueue {
  /**
   * Scene clock ticks (100 ns) per Destiny tick.
   */
  private readonly tickTicks: number;
  private queued: QueuedShot[] = [];
  private readonly counts = new Map<string, number>();
  /**
   * When each weapon's last drawn burst ends, by `ship module`.
   */
  private readonly burstEnds = new Map<string, number>();
  private readonly stopped = new Map<string, SettledWeapon>();

  /**
   * @param tickSeconds - Seconds per Destiny tick.
   */
  constructor(tickSeconds: number) {
    this.tickTicks = tickSeconds * TICKS_PER_SECOND;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, SHOT_QUEUE_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, SHOT_QUEUE_CAPTURE, memo);
  }

  /**
   * Queues a boundary's shots and counts them.
   *
   * @param shots - The shots (after the OnShot listeners).
   * @param now - The scene clock at the boundary, 100 ns ticks.
   */
  Add(shots: readonly WeaponShot[], now: number): void {
    for (const shot of shots) {
      this.counts.set(shot.ship, (this.counts.get(shot.ship) ?? 0) + 1);
      this.stopped.delete(WeaponKey(shot.ship, shot.module));
      this.queued.push({ shot, drawAt: Math.round(now + (shot.at + 1 - shot.tick) * this.tickTicks) });
    }
    this.queued.sort((a, b) => a.drawAt - b.drawAt);
  }

  /**
   * Takes the shots due by `now`, in draw order.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns The shots to draw (or drop).
   */
  Due(now: number): WeaponShot[] {
    const due: WeaponShot[] = [];
    while (this.queued.length && this.queued[0].drawAt <= now) {
      const next = this.queued.shift();
      if (next) due.push(next.shot);
    }
    return due;
  }

  /**
   * Records a drawn burst, so its weapon settles only once it has run.
   *
   * @param shot - The shot drawn.
   * @param now - The scene clock, 100 ns ticks.
   * @param duration - Seconds the burst draws (the firing effect's duration).
   */
  Drawn(shot: Pick<WeaponShot, 'ship' | 'module'>, now: number, duration: number): void {
    const key = WeaponKey(shot.ship, shot.module);
    this.burstEnds.set(key, Math.max(this.burstEnds.get(key) ?? 0, Math.round(now + Math.max(0, duration) * TICKS_PER_SECOND)));
  }

  /**
   * A weapon stopped (its `off`): it settles once its queued shots have drawn and its last burst has run.
   *
   * @param ship - The ship id.
   * @param module - The module key.
   */
  Off(ship: string, module: string): void {
    this.stopped.set(WeaponKey(ship, module), { ship, module });
  }

  /**
   * Takes the stopped weapons that have settled by `now`.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns Them, in the order they stopped.
   */
  Settled(now: number): SettledWeapon[] {
    const settled: SettledWeapon[] = [];
    for (const [key, weapon] of this.stopped) {
      const queued = this.queued.some(({ shot }) => shot.ship === weapon.ship && shot.module === weapon.module);
      if (queued || (this.burstEnds.get(key) ?? 0) > now) continue;
      this.stopped.delete(key);
      this.burstEnds.delete(key);
      settled.push(weapon);
    }
    return settled;
  }

  /**
   * Shots raised by a ship since the load.
   *
   * @param ship - The ship id.
   * @returns The count.
   */
  Count(ship: string): number {
    return this.counts.get(ship) ?? 0;
  }

  /**
   * Shots raised and not drawn yet.
   */
  get pending(): number {
    return this.queued.length;
  }

  /**
   * Drops the queued shots of a ship, or at a ship or object, that left the scene.
   *
   * @param id - The ship or object id.
   */
  Forget(id: string): void {
    this.queued = this.queued.filter(({ shot }) => shot.ship !== id && shot.target !== id);
    for (const [key, weapon] of this.stopped) if (weapon.ship === id) this.stopped.delete(key);
    for (const key of [...this.burstEnds.keys()]) if (key.startsWith(`${id} `)) this.burstEnds.delete(key);
  }

  /**
   * Forgets everything (a load): queued shots, counts and settles.
   */
  Clear(): void {
    this.queued = [];
    this.counts.clear();
    this.burstEnds.clear();
    this.stopped.clear();
  }
}

function WeaponKey(ship: string, module: string): string {
  return `${ship} ${module}`;
}
