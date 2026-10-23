/**
 * The client's warp flashes, drawn: warp-fx.ts's commands become one-shot effects in the live scene (sd-destiny
 * `warp` doc, "Flashes").
 *
 * - Files load once per path as values (ResourceValues); every play hydrates a NEW EveTransform from them inside
 *   PageAudio.Detached (sd-runtime), with curve LOD off (small on screen its curve sets would step at 1 Hz).
 * - Each flash is wrapped in an EveRootTransform on fixed curves (ships.ts CreateStaticCurves) at the command's
 *   position, turned so the effect's +Z runs along the warp (the warp-out trace is a beam along +Z), and scaled.
 * - Added with Engine.AddObject, every curve set in its tree played (PlayCurveSets: warp_out_start's are on a child),
 *   and removed WARP_EFFECT_LINGER after its longest curve set. At most WARP_EFFECTS_LIVE_MAX at once: a flash over the
 *   cap is skipped (counted).
 * - Teardown retires the root (RetireShips) against every other live root; the director joins Roots() into every
 *   retained set.
 *
 * Runtime module (imports ./runtime): only the director, with a renderer, creates one.
 */

import type { Maybe } from '@dereekb/util';
import { TICKS_PER_SECOND } from './clock';
import type { Engine } from './engine';
import { NoCurveLod } from './module-effects';
import { ErrorText, ResourceValues } from './resources';
import { addChild, CjsSchema, EveRootTransform, EveTransform, quat, vec3, type CjsModelValues } from './runtime';
import { CreateStaticCurves, PlaceStatic, RetireShips, type DetachAudio } from './ships';
import type { WarpFxCommand } from './warp-fx';

/**
 * Seconds a flash stays past its longest curve set.
 */
export const WARP_EFFECT_LINGER = 0.5;

/**
 * The most flashes drawn at once (loading included).
 */
export const WARP_EFFECTS_LIVE_MAX = 64;

/**
 * The most recent flash errors get_state reports.
 */
export const WARP_EFFECT_ERRORS_KEPT = 5;

export interface WarpEffectsOptions {
  readonly engine: Engine;
  /**
   * Every other live graph root (ships, dressing, objects, module effects, explosions): a retired flash keeps what
   * they share.
   */
  readonly retained: () => object[];
  readonly detachAudio: DetachAudio;
  /**
   * Reads an effect file as values; ResourceValues by default.
   */
  readonly read?: (path: string) => Promise<CjsModelValues>;
}

/**
 * get_state's `renderer.warpEffects`.
 */
export interface WarpEffectsReport {
  readonly live: number;
  readonly loading: number;
  /**
   * Flashes that failed to load or draw since the page loaded.
   */
  readonly failed: number;
  /**
   * Flashes skipped over WARP_EFFECTS_LIVE_MAX since the page loaded.
   */
  readonly skipped: number;
  /**
   * The most recent errors, newest last.
   */
  readonly errors: string[];
}

interface FlashEntry {
  readonly command: WarpFxCommand;
  readonly path: string;
  root: Maybe<EveRootTransform>;
  /**
   * When it leaves (100 ns ticks); null while it loads.
   */
  removeAt: Maybe<number>;
}

export class WarpEffects {
  private readonly engine: Engine;
  private readonly retained: () => object[];
  private readonly detachAudio: DetachAudio;
  private readonly read: (path: string) => Promise<CjsModelValues>;
  private readonly entries = new Set<FlashEntry>();
  /**
   * Loaded effect files by path (a pending load until it lands; a failed load is forgotten).
   */
  private readonly values = new Map<string, CjsModelValues | Promise<CjsModelValues>>();
  private readonly errors: string[] = [];
  private failed = 0;
  private skipped = 0;
  private now = 0;

  constructor({ engine, retained, detachAudio, read = ResourceValues }: WarpEffectsOptions) {
    this.engine = engine;
    this.retained = retained;
    this.detachAudio = detachAudio;
    this.read = read;
  }

  /**
   * Plays warp flash commands: one flash per file.
   *
   * @param commands - The commands, in order.
   * @param now - The scene clock, in 100 ns ticks.
   */
  Play(commands: readonly WarpFxCommand[], now: number): void {
    this.now = Math.max(this.now, now);
    for (const command of commands) {
      for (const path of command.files) {
        if (this.entries.size >= WARP_EFFECTS_LIVE_MAX) {
          this.skipped += 1;
          continue;
        }
        const entry: FlashEntry = { command, path, root: null, removeAt: null };
        this.entries.add(entry);
        const values = this.Values(path);
        if (values instanceof Promise) {
          values.then(
            () => {
              // Cleared while loading: nothing to draw.
              if (this.entries.has(entry)) this.Draw(entry, this.now);
            },
            (error: unknown) => {
              if (this.entries.has(entry)) this.Fail(entry, error);
            }
          );
        } else this.Draw(entry, now);
      }
    }
  }

  /**
   * Removes the flashes whose time ran out. Runs between world.Tick and engine.Frame.
   *
   * @param now - The scene clock, in 100 ns ticks.
   */
  Frame(now: number): void {
    this.now = now;
    for (const entry of [...this.entries]) {
      if (entry.removeAt != null && now >= entry.removeAt) this.Discard(entry);
    }
  }

  /**
   * Removes every flash (a load).
   */
  Clear(): void {
    for (const entry of [...this.entries]) this.Discard(entry);
  }

  /**
   * The drawn flashes' roots, for every retire's retained set.
   */
  Roots(): object[] {
    const roots: object[] = [];
    for (const { root } of this.entries) if (root) roots.push(root);
    return roots;
  }

  Report(): WarpEffectsReport {
    let live = 0;
    for (const entry of this.entries) if (entry.root) live += 1;
    return { live, loading: this.entries.size - live, failed: this.failed, skipped: this.skipped, errors: [...this.errors] };
  }

  private Values(path: string): CjsModelValues | Promise<CjsModelValues> {
    let values = this.values.get(path);
    if (!values) {
      const pending = this.read(path).then(
        (loaded) => {
          this.values.set(path, loaded);
          return loaded;
        },
        (error: unknown) => {
          this.values.delete(path);
          throw error;
        }
      );
      this.values.set(path, pending);
      values = pending;
    }
    return values;
  }

  private Draw(entry: FlashEntry, now: number): void {
    try {
      const values = this.values.get(entry.path);
      if (!values || values instanceof Promise) throw new Error('its file is not loaded');
      const object = this.detachAudio(() => CjsSchema.from<unknown>(values._type, structuredClone(values)));
      const effect = CjsSchema.cast(object, EveTransform);
      if (!effect) throw new Error(`it is a ${values._type}, not an EveTransform`);
      NoCurveLod(effect);
      const { command } = entry;
      const curves = CreateStaticCurves();
      PlaceStatic(curves, command.position, quat.copy(quat.create(), command.rotation));
      const root = new EveRootTransform();
      root.translationCurve = curves.translation;
      root.rotationCurve = curves.rotation;
      vec3.set(root.scaling, command.scale, command.scale, command.scale);
      addChild(root, 'children', effect);
      entry.root = root;
      this.engine.AddObject(root);
      PlayAll(effect);
      entry.removeAt = now + (LongestCurveSet(effect) + WARP_EFFECT_LINGER) * TICKS_PER_SECOND;
    } catch (error) {
      this.Fail(entry, error);
    }
  }

  private Fail(entry: FlashEntry, error: unknown): void {
    this.failed += 1;
    this.Record(`${entry.command.kind} on ${entry.command.ship} ${entry.path}: ${ErrorText(error)}`);
    this.Discard(entry);
  }

  private Record(message: string): void {
    console.warn(`warp flash failed: ${message}`);
    this.errors.push(message);
    if (this.errors.length > WARP_EFFECT_ERRORS_KEPT) this.errors.shift();
  }

  private Discard(entry: FlashEntry): void {
    this.entries.delete(entry);
    const { root } = entry;
    entry.root = null;
    if (!root) return;
    try {
      this.engine.RemoveObject(root);
      RetireShips([root], [...this.retained(), ...this.Roots()]);
    } catch (error) {
      this.Record(`${entry.command.kind} on ${entry.command.ship} teardown: ${ErrorText(error)}`);
    }
  }
}

/**
 * Plays every curve set in a transform tree.
 */
function PlayAll(transform: EveTransform): void {
  transform.PlayCurveSets();
  for (const child of transform.children) PlayAll(child);
}

/**
 * The longest curve set in a transform tree, in seconds.
 */
function LongestCurveSet(transform: EveTransform): number {
  let longest = 0;
  for (const curveSet of transform.curveSets) longest = Math.max(longest, curveSet.GetMaxCurveDuration());
  for (const child of transform.children) longest = Math.max(longest, LongestCurveSet(child));
  return longest;
}
