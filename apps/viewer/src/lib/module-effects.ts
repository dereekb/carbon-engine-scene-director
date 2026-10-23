/**
 * The client's module effects, drawn (C6): module-fx.ts's commands become hull overlays, beams and the stasis web's
 * trigger in the live scene. One effect per command key (`<ship>|<module>`): `loading` while its file loads, `live`
 * once drawn, `failed` with the reason (reported in get_state until the module stops).
 *
 * - Files load once per path as values (ResourceValues) and every use hydrates a NEW object from them inside
 *   PageAudio.Detached, so the effect's own emitters never register with the page's audio (sd-runtime). Their
 *   `audio` / `stretchAudio` are dropped too: module-audio.ts posts the sounds, and nothing plays twice.
 * - Overlay (EveMeshOverlayEffect): attached to the ship's hull (its curve set plays on load), replayed every cycle,
 *   removed once the last replay has run. A rebuilt ship gets a fresh overlay.
 * - Beam: an EveStretch (cap transfer, neut, nos, scram, point) or EveStretch3 (remote reps) in scene.objects. Its ends
 *   are written every frame from the drawn ClientBall positions into its loaded `source` / `dest` Tr2TranslationAdapters'
 *   `value`, never through SetFiringTransform: on an EveStretch it also marks the stretch -Z forward, which turns a
 *   module beam away from its target (the turrets' muzzle path), and on an EveStretch3 it drops the adapters while its
 *   stretch modifier keeps sampling the loaded `dest` at Blue's clock. Re-fired every cycle; on a stop it stops firing
 *   and is removed BEAM_LINGER later.
 * - Trigger (the web's EveTransform): wrapped in an EveRootTransform on the target's curves, scaled to the target,
 *   played every cycle (curve LOD off: small on screen it would step at 1 Hz), removed TRIGGER_LINGER after its last
 *   play once the module stops.
 *
 * Runtime module (imports ./runtime): only the director, with a renderer, creates one.
 */

import type { Maybe } from '@dereekb/util';
import type { ModuleEffect } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { ShipCurves } from './destiny';
import type { Engine } from './engine';
import type { ModuleFxCommand } from './module-fx';
import { ErrorText, ResourceValues } from './resources';
import { addChild, CjsSchema, EveMeshOverlayEffect, EveRootTransform, EveStretch, EveStretch3, EveTransform, Tr2TranslationAdapter, vec3, type CjsModelValues, type EveShip2 } from './runtime';
import { RetireShips, type DetachAudio } from './ships';

/**
 * How long a stopped beam stays in the scene (its `play_end`), in seconds.
 */
export const BEAM_LINGER = 2;

/**
 * How long the web's trigger stays after its last play, in seconds.
 */
export const TRIGGER_LINGER = 5;

/**
 * The web's trigger effect is authored about this wide, in metres; it is scaled to twice the target's radius.
 */
export const TRIGGER_AUTHORED_SIZE = 2.7;

/**
 * The most recent effect errors get_state reports.
 */
export const MODULE_EFFECT_ERRORS_KEPT = 5;

export type ModuleEffectState = 'loading' | 'live' | 'failed';

/**
 * The page's ships as the effects see them.
 */
export interface ModuleEffectShips {
  /**
   * The ship's built hull, null while it builds or when it failed.
   */
  ShipOf(id: string): Maybe<EveShip2>;
  /**
   * The ship's ClientBall curves (what the camera draws), null once it is gone.
   */
  CurvesOf(id: string): Maybe<ShipCurves>;
  /**
   * The ship's drawn radius, metres.
   */
  RadiusOf(id: string): number;
}

export interface ModuleEffectsOptions {
  readonly engine: Engine;
  readonly ships: ModuleEffectShips;
  /**
   * Every other live graph root (ships, dressing, objects): a retired effect keeps what they share.
   */
  readonly retained: () => object[];
  readonly detachAudio: DetachAudio;
  /**
   * Reads an effect file as values; ResourceValues by default.
   */
  readonly read?: (path: string) => Promise<CjsModelValues>;
}

/**
 * get_state's module effects report.
 */
export interface ModuleEffectsReport {
  readonly live: number;
  readonly loading: number;
  readonly failed: number;
  /**
   * The most recent errors, newest last.
   */
  readonly errors: string[];
}

type DrawnEffect =
  | { readonly kind: 'overlay'; overlay: Maybe<EveMeshOverlayEffect>; ship: Maybe<EveShip2> }
  | { readonly kind: 'stretch'; readonly stretch: EveStretch; readonly source: Tr2TranslationAdapter; readonly dest: Tr2TranslationAdapter; added: boolean }
  | { readonly kind: 'stretch3'; readonly stretch: EveStretch3; readonly source: Tr2TranslationAdapter; readonly dest: Tr2TranslationAdapter; added: boolean }
  | { readonly kind: 'trigger'; readonly root: EveRootTransform; readonly web: EveTransform; added: boolean };

interface EffectEntry {
  readonly key: string;
  readonly ship: string;
  readonly target: Maybe<string>;
  readonly effect: ModuleEffect;
  state: ModuleEffectState;
  drawn: Maybe<DrawnEffect>;
  /**
   * The clock (100 ns ticks) at the last play.
   */
  playedAt: number;
  /**
   * When a stopped effect leaves (100 ns ticks).
   */
  removeAt: Maybe<number>;
  error: Maybe<string>;
}

const SOURCE = vec3.create();
const DEST = vec3.create();

export class ModuleEffects {
  private readonly engine: Engine;
  private readonly ships: ModuleEffectShips;
  private readonly retained: () => object[];
  private readonly detachAudio: DetachAudio;
  private readonly read: (path: string) => Promise<CjsModelValues>;
  private readonly entries = new Map<string, EffectEntry>();
  /**
   * Loaded effect files by path (a pending load until it lands; a failed load is forgotten).
   */
  private readonly values = new Map<string, CjsModelValues | Promise<CjsModelValues>>();
  private readonly errors: string[] = [];
  private now = 0;

  constructor({ engine, ships, retained, detachAudio, read = ResourceValues }: ModuleEffectsOptions) {
    this.engine = engine;
    this.ships = ships;
    this.retained = retained;
    this.detachAudio = detachAudio;
    this.read = read;
  }

  /**
   * Runs module effect commands.
   *
   * @param commands - The commands, in order.
   * @param now - The scene clock, in 100 ns ticks.
   */
  Apply(commands: readonly ModuleFxCommand[], now: number): void {
    this.now = Math.max(this.now, now);
    for (const command of commands) {
      const entry = this.entries.get(command.key);
      if (command.op === 'stop') {
        if (entry) this.Stop(entry, now);
      } else if (command.op === 'cycle' && entry) this.Replay(entry, now);
      else this.Start(command, now);
    }
  }

  /**
   * Places the effects for the frame at `now`: beam ends, overlays on rebuilt ships; removes stopped effects whose
   * time ran out and effects whose ship or target is gone. Runs between world.Tick and engine.Frame.
   *
   * @param now - The scene clock, in 100 ns ticks.
   */
  Frame(now: number): void {
    this.now = now;
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'live') continue;
      let keep = false;
      try {
        keep = (entry.removeAt == null || now < entry.removeAt) && this.Place(entry, now);
      } catch (error) {
        this.Fail(entry, error);
        continue;
      }
      if (!keep) this.Discard(entry);
    }
  }

  /**
   * Removes every effect (a load restarts every module).
   */
  Clear(): void {
    for (const entry of [...this.entries.values()]) this.Discard(entry);
  }

  /**
   * The drawn effects' roots, for every retire's retained set.
   */
  Roots(): object[] {
    const roots: object[] = [];
    for (const { drawn } of this.entries.values()) {
      if (drawn?.kind === 'overlay') {
        if (drawn.overlay) roots.push(drawn.overlay);
      } else if (drawn) roots.push(drawn.kind === 'trigger' ? drawn.root : drawn.stretch);
    }
    return roots;
  }

  Report(): ModuleEffectsReport {
    const counts: Record<ModuleEffectState, number> = { loading: 0, live: 0, failed: 0 };
    for (const entry of this.entries.values()) counts[entry.state] += 1;
    return { ...counts, errors: [...this.errors] };
  }

  private Start(command: ModuleFxCommand, now: number): void {
    const previous = this.entries.get(command.key);
    if (previous) this.Discard(previous);
    const entry: EffectEntry = { key: command.key, ship: command.ship, target: command.target ?? null, effect: command.effect, state: 'loading', drawn: null, playedAt: now, removeAt: null, error: null };
    this.entries.set(entry.key, entry);
    const values = this.Values(command.effect.resPath);
    if (values instanceof Promise) {
      values.then(
        () => {
          // Stopped (or replaced) while loading: nothing to draw.
          if (this.entries.get(entry.key) === entry) this.Draw(entry, this.now);
        },
        (error: unknown) => {
          if (this.entries.get(entry.key) === entry) this.Fail(entry, error);
        }
      );
    } else this.Draw(entry, now);
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

  /**
   * A new object from a loaded file, hydrated with the page's audio detached.
   */
  private Hydrate<T>(effect: ModuleEffect, type: abstract new (...args: never[]) => T): T {
    const values = this.values.get(effect.resPath);
    if (!values || values instanceof Promise) throw new Error('its file is not loaded');
    const object = this.detachAudio(() => CjsSchema.from<unknown>(values._type, structuredClone(values)));
    const typed = CjsSchema.cast(object, type);
    if (!typed) throw new Error(`it is a ${values._type}, not a ${type.name}`);
    return typed;
  }

  private Draw(entry: EffectEntry, now: number): void {
    try {
      entry.drawn = this.Build(entry);
      entry.state = 'live';
      entry.playedAt = now;
      if (!this.Place(entry, now)) this.Discard(entry);
    } catch (error) {
      this.Fail(entry, error);
    }
  }

  private Build(entry: EffectEntry): DrawnEffect {
    const { effect } = entry;
    let drawn: DrawnEffect;
    if (effect.kind === 'overlay') {
      // Attached to the hull in Place, once the ship is built.
      drawn = { kind: 'overlay', overlay: null, ship: null };
    } else if (effect.kind === 'trigger') {
      const web = this.Hydrate(effect, EveTransform);
      NoCurveLod(web);
      const root = new EveRootTransform();
      addChild(root, 'children', web);
      drawn = { kind: 'trigger', root, web, added: false };
    } else {
      const values = this.values.get(effect.resPath) as CjsModelValues;
      const stretch = values._type === 'EveStretch3' ? this.Hydrate(effect, EveStretch3) : this.Hydrate(effect, EveStretch);
      const source = CjsSchema.cast(stretch.source, Tr2TranslationAdapter);
      const dest = CjsSchema.cast(stretch.dest, Tr2TranslationAdapter);
      if (!source || !dest) throw new Error('its source and dest are not Tr2TranslationAdapters');
      stretch.audio = null;
      stretch.stretchAudio = null;
      drawn = stretch instanceof EveStretch3 ? { kind: 'stretch3', stretch, source, dest, added: false } : { kind: 'stretch', stretch, source, dest, added: false };
    }
    return drawn;
  }

  /**
   * Places a live effect for the frame; false when its ship or target is gone. The first placement adds it to the
   * scene and plays it.
   */
  private Place(entry: EffectEntry, now: number): boolean {
    const { drawn } = entry;
    let placed = false;
    if (drawn?.kind === 'overlay') placed = this.PlaceOverlay(entry, drawn);
    else if (drawn?.kind === 'trigger') {
      const curves = entry.target ? this.ships.CurvesOf(entry.target) : null;
      if (curves) {
        drawn.root.translationCurve = curves.translation;
        drawn.root.rotationCurve = curves.rotation;
        vec3.set(drawn.root.scaling, 1, 1, 1);
        vec3.scale(drawn.root.scaling, drawn.root.scaling, (2 * this.ships.RadiusOf(entry.target ?? '')) / TRIGGER_AUTHORED_SIZE);
        if (!drawn.added) {
          drawn.added = true;
          this.engine.AddObject(drawn.root);
          drawn.web.PlayCurveSet('play_start');
        }
        placed = true;
      }
    } else if (drawn) {
      const source = this.ships.CurvesOf(entry.ship);
      const target = entry.target ? this.ships.CurvesOf(entry.target) : null;
      if (source && target) {
        source.translation.GetValueAt__Ticks(now, SOURCE);
        target.translation.GetValueAt__Ticks(now, DEST);
        vec3.copy(drawn.source.value, SOURCE);
        vec3.copy(drawn.dest.value, DEST);
        if (!drawn.added) {
          drawn.added = true;
          this.engine.AddObject(drawn.stretch);
          drawn.stretch.StartFiring(0);
        }
        placed = true;
      }
    }
    return placed;
  }

  /**
   * Keeps an overlay on the ship's current hull: attached once it is built, and a fresh one on a rebuilt hull (the
   * old one went with the retired hull's graph).
   */
  private PlaceOverlay(entry: EffectEntry, drawn: Extract<DrawnEffect, { kind: 'overlay' }>): boolean {
    const ship = this.ships.ShipOf(entry.ship);
    if (ship !== drawn.ship) {
      this.DetachOverlay(drawn);
      if (ship) {
        const overlay = this.Hydrate(entry.effect, EveMeshOverlayEffect);
        ship.AddOverlayEffect(overlay);
        drawn.overlay = overlay;
        drawn.ship = ship;
        ReplayOverlay(overlay);
      }
    }
    return this.ships.CurvesOf(entry.ship) != null;
  }

  private DetachOverlay(drawn: Extract<DrawnEffect, { kind: 'overlay' }>): void {
    const { overlay, ship } = drawn;
    drawn.overlay = null;
    drawn.ship = null;
    if (!overlay) return;
    ship?.RemoveOverlayEffect(overlay);
    for (const effects of [overlay.opaqueEffects, overlay.decalEffects, overlay.transparentEffects, overlay.additiveEffects, overlay.distortionEffects]) {
      for (const effect of effects) effect.Destruct();
    }
  }

  private Replay(entry: EffectEntry, now: number): void {
    const { drawn } = entry;
    if (entry.state !== 'live' || !drawn) return;
    entry.playedAt = now;
    entry.removeAt = null;
    if (drawn.kind === 'overlay') {
      if (drawn.overlay) ReplayOverlay(drawn.overlay);
    } else if (drawn.kind === 'stretch') drawn.stretch.StartFiring(0);
    else if (drawn.kind === 'stretch3') drawn.stretch.PlayCurveSet('play_start');
    else drawn.web.PlayCurveSet('play_start');
  }

  private Stop(entry: EffectEntry, now: number): void {
    const { drawn } = entry;
    if (entry.state !== 'live' || !drawn) {
      // Loading (its load is dropped when it lands) or failed.
      this.entries.delete(entry.key);
      return;
    }
    let linger = 0;
    if (drawn.kind === 'overlay') linger = Math.max(0, entry.playedAt + (drawn.overlay?.curveSet?.GetMaxCurveDuration() ?? 0) * TICKS_PER_SECOND - now) / TICKS_PER_SECOND;
    else if (drawn.kind === 'trigger') linger = Math.max(0, entry.playedAt + TRIGGER_LINGER * TICKS_PER_SECOND - now) / TICKS_PER_SECOND;
    else {
      drawn.stretch.StopFiring();
      linger = BEAM_LINGER;
    }
    entry.removeAt = now + linger * TICKS_PER_SECOND;
  }

  private Fail(entry: EffectEntry, error: unknown): void {
    const message = `${entry.key} ${entry.effect.resPath}: ${ErrorText(error)}`;
    const { drawn } = entry;
    entry.drawn = null;
    entry.state = 'failed';
    entry.error = message;
    this.Record(message);
    if (drawn) this.Release(entry.key, drawn);
  }

  private Record(message: string): void {
    console.warn(`module effect failed: ${message}`);
    this.errors.push(message);
    if (this.errors.length > MODULE_EFFECT_ERRORS_KEPT) this.errors.shift();
  }

  private Discard(entry: EffectEntry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const { drawn } = entry;
    entry.drawn = null;
    if (drawn) this.Release(entry.key, drawn);
  }

  /**
   * Tears a drawn effect down (it is no longer an entry's, so the retained roots leave it out).
   */
  private Release(key: string, drawn: DrawnEffect): void {
    try {
      this.Teardown(drawn);
    } catch (error) {
      this.Record(`${key} teardown: ${ErrorText(error)}`);
    }
  }

  private Teardown(drawn: DrawnEffect): void {
    if (drawn.kind === 'overlay') {
      this.DetachOverlay(drawn);
      return;
    }
    const root = drawn.kind === 'trigger' ? drawn.root : drawn.stretch;
    if (drawn.added) this.engine.RemoveObject(root);
    if (drawn.kind === 'stretch3') for (const controller of drawn.stretch.controllers) controller.Unlink();
    RetireShips([root], [...this.retained(), ...this.Roots()]);
  }
}

/**
 * Plays an overlay's curve set from the start.
 */
function ReplayOverlay(overlay: EveMeshOverlayEffect): void {
  overlay.curveSet?.ResetTimeRange();
  overlay.curveSet?.Play();
}

/**
 * Turns a transform tree's curve LOD off: small on screen its curve sets would update at 1 Hz.
 */
export function NoCurveLod(transform: EveTransform): void {
  transform.useLodLevel = false;
  for (const child of transform.children) NoCurveLod(child);
}
