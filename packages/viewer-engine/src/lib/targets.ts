/**
 * Every ship's target: the ship or authored object its turrets aim and fire at (set_target, switch_modules turret
 * `target`). Live state only, never written to the document; a load clears it.
 *
 * - Set / Of / Clear.
 * - Remove: a removed ship drops its own target, and every target on a removed ship or object clears ("its target is
 *   gone").
 * - OnWarpEnter: a ship entering warp drops its own target and every target on it, as EVE breaks the lock.
 * - Report: `{ id, kind, distance }` for get_state, the surface distance from the port.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { ShotTargetKind } from '@scene-director/scene';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

export interface ShipTargetsPort {
  HasShip(id: string): boolean;
  HasObject(id: string): boolean;
  /**
   * Metres, surface to surface; null when either is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
}

/**
 * A ship's target in get_state.
 */
export interface ShipTargetReport {
  readonly id: string;
  readonly kind: ShotTargetKind;
  /**
   * Metres, surface to surface (whole metres); null when it cannot be measured.
   */
  readonly distance: Maybe<number>;
}

/**
 * A ship whose target a removal or a warp cleared.
 */
export interface ClearedTarget {
  readonly ship: string;
  readonly previous: string;
}

/**
 * What a ShipTargets snapshot (sd-time) leaves out: its wiring (port).
 */
const TARGETS_CAPTURE: CaptureOptions = { wiring: ['port'] };

export class ShipTargets {
  private readonly port: ShipTargetsPort;
  private readonly targets = new Map<string, string>();

  constructor(port: ShipTargetsPort) {
    this.port = port;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, TARGETS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, TARGETS_CAPTURE, memo);
  }

  /**
   * The kind of a target id: a ship, an authored object, or null when there is no such thing.
   *
   * @param id - The target id.
   * @returns Its kind.
   */
  KindOf(id: string): Maybe<ShotTargetKind> {
    let kind: Maybe<ShotTargetKind> = null;
    if (this.port.HasShip(id)) kind = 'ship';
    else if (this.port.HasObject(id)) kind = 'object';
    return kind;
  }

  /**
   * Sets or clears a ship's target.
   *
   * @param id - The ship id.
   * @param target - The ship or object it targets; null clears it.
   * @returns Its previous target.
   */
  Set(id: string, target: Maybe<string>): Maybe<string> {
    const previous = this.targets.get(id) ?? null;
    if (target == null) this.targets.delete(id);
    else this.targets.set(id, target);
    return previous;
  }

  Of(id: string): Maybe<string> {
    return this.targets.get(id) ?? null;
  }

  /**
   * Forgets every target (a load).
   */
  Clear(): void {
    this.targets.clear();
  }

  /**
   * A ship or object left the scene: its own target goes, and every ship targeting it loses its target.
   *
   * @param id - The removed id.
   * @returns The ships that targeted it.
   */
  Remove(id: string): ClearedTarget[] {
    this.targets.delete(id);
    return this.ClearOn(id);
  }

  /**
   * A ship entered warp: it drops its own target and every ship targeting it loses its target.
   *
   * @param id - The ship id.
   * @returns Every target cleared, its own first.
   */
  OnWarpEnter(id: string): ClearedTarget[] {
    const own = this.targets.get(id);
    this.targets.delete(id);
    return [...(own ? [{ ship: id, previous: own }] : []), ...this.ClearOn(id)];
  }

  /**
   * A target was destroyed: every ship targeting it loses its target (its own stays).
   *
   * @param target - The ship id.
   * @returns The ships that targeted it.
   */
  Forget(target: string): ClearedTarget[] {
    return this.ClearOn(target);
  }

  /**
   * The ships targeting an id.
   *
   * @param target - The ship or object id.
   * @returns Their ids, in the order they took it.
   */
  On(target: string): string[] {
    return [...this.targets].flatMap(([ship, aim]) => (aim === target ? [ship] : []));
  }

  /**
   * A ship's target for get_state.
   *
   * @param id - The ship id.
   * @returns The report, or null without a target.
   */
  Report(id: string): Maybe<ShipTargetReport> {
    const target = this.targets.get(id);
    const kind = target ? this.KindOf(target) : null;
    const distance = target ? this.port.SurfaceDistance(id, target) : null;
    return target && kind ? { id: target, kind, distance: distance == null ? null : Math.round(distance) } : null;
  }

  private ClearOn(target: string): ClearedTarget[] {
    const cleared: ClearedTarget[] = [];
    for (const ship of this.On(target)) {
      this.targets.delete(ship);
      cleared.push({ ship, previous: target });
    }
    return cleared;
  }
}
