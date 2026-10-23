/**
 * Warp events → warp flash commands: the client's warp-out and warp-in effects (sd-destiny `warp` doc, "Flashes").
 *
 * - `warp-out` when a ship enters proper warp (OnWarp `enter`), at where warp began, along the warp: never for an
 *   arrival (it waited off-grid).
 * - `warp-in` once per warp, when the ship's DRAWN ball first comes within max(WARP_IN_TRIGGER_DISTANCE,
 *   WARP_IN_TRIGGER_RADII × radius) of its landing: the exit event lags the visible arrival by seconds. The exit
 *   plays it when no frame did (a ship drawn nowhere, or a warp shorter than a frame).
 * - A placement or a removal ends the warp without an exit: the next frame drops it, no flash.
 * - Variant and scale by the ship's SOF radius: `warp_in_glow` from WARP_IN_GLOW_RADIUS up, else `warp_in_noglow`;
 *   every flash scaled radius / WARP_FLASH_AUTHORED_RADIUS, clamped.
 *
 * Counted with or without a renderer (get_state `simulation.warpFlashes`); warp-effects.ts draws the commands.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '@scene-director/scene';
import type { WarpEvent } from './destiny';

export const WARP_OUT_START_PATH = 'res:/fisfx/jump/warp/warp_out_start.black';
export const WARP_OUT_PATH = 'res:/fisfx/jump/warp/warp_out.black';
export const WARP_IN_GLOW_PATH = 'res:/fisfx/jump/warp/warp_in_glow.black';
export const WARP_IN_NOGLOW_PATH = 'res:/fisfx/jump/warp/warp_in_noglow.black';

/**
 * The warp-in flash plays once the drawn ship is this close to its landing (metres), or WARP_IN_TRIGGER_RADII radii
 * when that is more.
 */
export const WARP_IN_TRIGGER_DISTANCE = 2000;
export const WARP_IN_TRIGGER_RADII = 4;

/**
 * Ships at least this big (SOF radius, metres) get the glowing warp-in flash.
 */
export const WARP_IN_GLOW_RADIUS = 150;

/**
 * The radius (metres) the flashes are drawn at scale 1 for, and the scale's clamp. The floor is 0.5 since the GPU check
 * (2026-10-23): a Rifter's flash at 0.25 read as a faint dot from 5 km.
 */
export const WARP_FLASH_AUTHORED_RADIUS = 250;
export const WARP_FLASH_SCALE_MIN = 0.5;
export const WARP_FLASH_SCALE_MAX = 8;

export type WarpFxKind = 'warp-out' | 'warp-in';

export interface WarpFxCommand {
  readonly kind: WarpFxKind;
  readonly ship: string;
  /**
   * The effect files played together, in order.
   */
  readonly files: readonly string[];
  /**
   * Scene metres: where warp began (warp-out) or the landing (warp-in).
   */
  readonly position: SceneVector;
  /**
   * The rotation turning the effects' +Z onto the warp direction, [x, y, z, w].
   */
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /**
   * The master tick it was made on.
   */
  readonly tick: number;
}

/**
 * The page's ships as the flashes see them.
 */
export interface WarpFxShips {
  /**
   * The ship's SOF radius, metres.
   */
  RadiusOf(id: string): number;
  /**
   * The ship's drawn position at `now` (100 ns ticks), null once it is gone.
   */
  DrawnPosition(id: string, now: number): Maybe<SceneVector>;
  /**
   * Whether the ship is still in proper warp: false after a placement or a removal ended it.
   */
  InWarp(id: string): boolean;
  /**
   * The master tick.
   */
  readonly tick: number;
}

/**
 * get_state's `simulation.warpFlashes`: flashes made since the page loaded.
 */
export interface WarpFlashCounts {
  readonly warpOut: number;
  readonly warpIn: number;
}

interface TrackedWarp {
  readonly landing: SceneVector;
  readonly direction: SceneVector;
}

export class WarpFx {
  private readonly ships: WarpFxShips;
  private readonly tracked = new Map<string, TrackedWarp>();
  private warpOut = 0;
  private warpIn = 0;

  constructor(ships: WarpFxShips) {
    this.ships = ships;
  }

  /**
   * A warp event's commands: a warp-out on entering (not for an arrival), the fallback warp-in on an exit no frame
   * played.
   *
   * @param event - The OnWarp event.
   * @returns The commands.
   */
  OnWarp(event: WarpEvent): WarpFxCommand[] {
    const commands: WarpFxCommand[] = [];
    if (event.kind === 'enter') {
      this.tracked.set(event.id, { landing: event.landing, direction: event.direction });
      if (!event.arrival) {
        commands.push(this.Command('warp-out', event.id, [WARP_OUT_START_PATH, WARP_OUT_PATH], event.position, event.direction));
        this.warpOut += 1;
      }
    } else {
      const warp = this.tracked.get(event.id);
      if (warp) commands.push(this.WarpIn(event.id, warp));
    }
    return commands;
  }

  /**
   * The warp-ins due on the frame at `now`: each tracked ship drawn within its trigger distance of its landing.
   * Drops warps a placement or removal ended.
   *
   * @param now - The scene clock, in 100 ns ticks.
   * @returns The commands.
   */
  Frame(now: number): WarpFxCommand[] {
    const commands: WarpFxCommand[] = [];
    for (const [id, warp] of [...this.tracked]) {
      const position = this.ships.InWarp(id) ? this.ships.DrawnPosition(id, now) : null;
      if (!position) this.tracked.delete(id);
      else if (Distance(position, warp.landing) <= WarpInTriggerDistance(this.ships.RadiusOf(id))) commands.push(this.WarpIn(id, warp));
    }
    return commands;
  }

  /**
   * Forgets every tracked warp (a load).
   */
  Clear(): void {
    this.tracked.clear();
  }

  /**
   * Whether a ship's warp-in flash is still to come.
   */
  Tracking(id: string): boolean {
    return this.tracked.has(id);
  }

  Counts(): WarpFlashCounts {
    return { warpOut: this.warpOut, warpIn: this.warpIn };
  }

  private WarpIn(id: string, warp: TrackedWarp): WarpFxCommand {
    this.tracked.delete(id);
    this.warpIn += 1;
    return this.Command('warp-in', id, [WarpInFlashPath(this.ships.RadiusOf(id))], warp.landing, warp.direction);
  }

  private Command(kind: WarpFxKind, ship: string, files: readonly string[], position: SceneVector, direction: SceneVector): WarpFxCommand {
    return { kind, ship, files, position, rotation: RotationToward(direction), scale: WarpFlashScale(this.ships.RadiusOf(ship)), tick: this.ships.tick };
  }
}

/**
 * How close (metres) a ship of this radius is drawn to its landing when its warp-in flash plays.
 */
export function WarpInTriggerDistance(radius: number): number {
  return Math.max(WARP_IN_TRIGGER_DISTANCE, WARP_IN_TRIGGER_RADII * radius);
}

/**
 * The warp-in flash file for a ship of this SOF radius.
 */
export function WarpInFlashPath(radius: number): string {
  return radius >= WARP_IN_GLOW_RADIUS ? WARP_IN_GLOW_PATH : WARP_IN_NOGLOW_PATH;
}

/**
 * The flashes' scale for a ship of this SOF radius.
 */
export function WarpFlashScale(radius: number): number {
  const scale = Number.isFinite(radius) ? radius / WARP_FLASH_AUTHORED_RADIUS : 1;
  return Math.min(WARP_FLASH_SCALE_MAX, Math.max(WARP_FLASH_SCALE_MIN, scale));
}

/**
 * The shortest-arc rotation turning +Z onto `direction` (a unit vector); identity for a zero vector.
 *
 * @param direction - The direction.
 * @returns The quaternion, [x, y, z, w].
 */
export function RotationToward(direction: SceneVector): [number, number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return [0, 0, 0, 1];
  const [x, y, z] = [direction[0] / length, direction[1] / length, direction[2] / length];
  // +Z × d = (-y, x, 0); w = 1 + z. Opposite +Z: a half turn about Y.
  if (z < -1 + 1e-9) return [0, 1, 0, 0];
  const w = 1 + z;
  const norm = Math.hypot(y, x, w);
  return [(0 - y) / norm, x / norm, 0, w / norm];
}

function Distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
