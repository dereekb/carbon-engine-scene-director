/**
 * The runtime-free half of the drawn missiles: what the page reads off a missile's files (the charge's EveMissile
 * `.black` and its impact effect, MissileFileFacts), the files loaded once each with or without a renderer
 * (MissileFiles: a headless page still posts the impact sound), and the schedule of every drawn missile
 * (MissileDrawPlan): when it starts, vanishes, is forced, frozen and removed, when its impact plays, and the caps.
 *
 * - A flight draws from its burst start (the launch draw plus its launcher set's firing delay) until every warhead is
 *   DEAD. The runtime detonates a hit by itself on the drawn hull; the page queues its callback (Detonated) and plays
 *   the impact then when the missile arrived on its target (its ball reached it: the master's contact, found at the
 *   boundary after), else once the master end is known to be a hit. An arrived missile whose master end is an expiry
 *   at that same boundary (the edge of its range) still shows its impact; it does no damage.
 * - A missile arrives once its drawn ball reaches its target (within the missile's ball radius plus the target's), or,
 *   with its hit known, has passed its closest approach: its curve is frozen there, its target kept. The ball itself
 *   flies straight on past the target (Destiny's master hit is found at the boundary after the contact, and the ball
 *   then goes straight on), and the warhead's time-to-target estimate would grow with it, so the warhead would never
 *   reach its locator (GPU, 2026-10-23: frozen 9.5 km past the target, or detonated 28 km past it at the linger's
 *   freeze); a still ball freezes the estimate and the warhead finishes its flight onto the hull. A missile that
 *   arrived and then expires or is lost explodes silently.
 * - A flight whose master end is an expiry or a loss vanishes at its drawn end: its target is nulled, and its warhead
 *   then explodes silently (no impact).
 * - A hit whose warhead has not detonated MISSILE_FALLBACK_TICKS after its draw time (an unbuilt or hidden target) is
 *   forced (its target nulled), and its impact plays where it detonates.
 * - A missile still live when its ball has left the parks is frozen on a fixed curve and its target nulled (a removed
 *   ClientBall samples (0, −3.4e38, 0)).
 * - Over MISSILES_LIVE_MAX live missiles a flight flies undrawn (`skipped`); over MISSILE_IMPACTS_LIVE_MAX live impacts
 *   a detonation plays its sound and kill without an impact effect. The simulation never changes.
 *
 * Node-tested: it imports nothing from ./runtime but types.
 */

import type { Maybe } from '@dereekb/util';
import type { MissileGraphic } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { CjsModelValues } from './runtime';

/**
 * Drawn missiles live at once; a launch over it flies undrawn.
 */
export const MISSILES_LIVE_MAX = 256;

/**
 * Impact effects playing at once; a detonation over it plays no impact effect.
 */
export const MISSILE_IMPACTS_LIVE_MAX = 64;

/**
 * Destiny ticks after a hit's draw time its warhead is forced to detonate (it detonates about half a second after its
 * arrival on the GPU).
 */
export const MISSILE_FALLBACK_TICKS = 2;

/**
 * Seconds an impact plays when its file has no `duration` (the files say 6).
 */
export const MISSILE_IMPACT_DEFAULT_DURATION = 6;

export interface MissileFileFacts {
  /**
   * The projectile's warheads (EveMissileWarhead), 1 in every T1 file.
   */
  readonly warheads: number;
  /**
   * Seconds the impact plays (its EveEffectRoot2's `duration`; the page removes it then).
   */
  readonly impactDuration: number;
  /**
   * The impact's sound events: its Tr2ActionPlaySound actions' (`missile_explosion_kinetic_medium_play`), then any
   * AudEventCurve's.
   */
  readonly impactEvents: string[];
}

/**
 * Reads what the page needs from a missile's projectile and impact values.
 *
 * @param projectile - The projectile `.black`'s values (an EveMissile).
 * @param impact - The impact `.black`'s values (an EveEffectRoot2).
 * @returns The facts; missing fields read as 0, the default duration or none.
 */
export function MissileFileFacts(projectile: unknown, impact: unknown): MissileFileFacts {
  const warheads = Field(projectile, 'warheads');
  const duration = Field(impact, 'duration');
  const actions: string[] = [];
  const curves: string[] = [];
  CollectSoundEvents(impact, { actions, curves }, new Set());
  return {
    warheads: Array.isArray(warheads) ? warheads.length : 0,
    impactDuration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : MISSILE_IMPACT_DEFAULT_DURATION,
    impactEvents: [...new Set([...actions, ...curves])]
  };
}

function CollectSoundEvents(value: unknown, into: { actions: string[]; curves: string[] }, seen: Set<unknown>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) CollectSoundEvents(item, into, seen);
    return;
  }
  const type = Field(value, '_type');
  if (type === 'Tr2ActionPlaySound') {
    const event = Field(value, 'event');
    if (typeof event === 'string' && event.length) into.actions.push(event);
    return;
  }
  if (type === 'AudEventCurve') {
    const keys = Field(value, 'keys');
    for (const key of Array.isArray(keys) ? keys : []) {
      const event = Field(key, 'value');
      if (typeof event === 'string' && event.length) into.curves.push(event);
    }
    return;
  }
  for (const item of Object.values(value)) CollectSoundEvents(item, into, seen);
}

/**
 * A loaded missile: its projectile and impact values and the facts.
 */
export interface MissileFile {
  readonly projectileResPath: string;
  readonly impactResPath: string;
  readonly projectile: CjsModelValues;
  readonly impact: CjsModelValues;
  readonly facts: MissileFileFacts;
}

export interface MissileFilesOptions {
  /**
   * Reads a `.black` as values; the page passes ResourceValues.
   */
  readonly read: (path: string) => Promise<CjsModelValues>;
}

/**
 * Missile files by (projectile, impact) path, each pair loaded once, with or without a renderer. A failed load is kept
 * with its error until ForgetFailures (every load / open).
 */
export class MissileFiles {
  private readonly read: (path: string) => Promise<CjsModelValues>;
  private readonly files = new Map<string, MissileFile>();
  private readonly failures = new Map<string, string>();
  private readonly loads = new Map<string, Promise<MissileFile>>();

  constructor(options: MissileFilesOptions) {
    this.read = options.read;
  }

  /**
   * A loaded missile.
   *
   * @param graphic - The missile's graphic (the /missile answer).
   * @returns It, or null while it loads, before it is asked for, or when it failed.
   */
  Cached(graphic: Pick<MissileGraphic, 'projectileResPath' | 'impactResPath'>): Maybe<MissileFile> {
    return this.files.get(FilesKey(graphic)) ?? null;
  }

  /**
   * Why a missile's files failed to load.
   *
   * @param graphic - The missile's graphic.
   * @returns The error, or null.
   */
  Failure(graphic: Pick<MissileGraphic, 'projectileResPath' | 'impactResPath'>): Maybe<string> {
    return this.failures.get(FilesKey(graphic)) ?? null;
  }

  /**
   * Pairs loading now.
   */
  get loading(): number {
    return this.loads.size;
  }

  /**
   * Loads a missile's projectile and impact files, once per pair.
   *
   * @param graphic - The missile's graphic.
   * @returns The files; rejects when either fails to read or is not the class it should be.
   */
  Load(graphic: Pick<MissileGraphic, 'projectileResPath' | 'impactResPath'>): Promise<MissileFile> {
    const key = FilesKey(graphic);
    const cached = this.files.get(key);
    if (cached) return Promise.resolve(cached);
    const failure = this.failures.get(key);
    if (failure) return Promise.reject(new Error(failure));
    let load = this.loads.get(key);
    if (!load) {
      load = this.LoadFiles(graphic).then(
        (file) => {
          this.files.set(key, file);
          this.loads.delete(key);
          return file;
        },
        (error: unknown) => {
          this.failures.set(key, error instanceof Error ? error.message : String(error));
          this.loads.delete(key);
          throw error;
        }
      );
      this.loads.set(key, load);
    }
    return load;
  }

  /**
   * Forgets every failed load, so the next Load reads again.
   */
  ForgetFailures(): void {
    this.failures.clear();
  }

  private async LoadFiles(graphic: Pick<MissileGraphic, 'projectileResPath' | 'impactResPath'>): Promise<MissileFile> {
    const { projectileResPath, impactResPath } = graphic;
    const [projectile, impact] = await Promise.all([this.read(projectileResPath), this.read(impactResPath)]);
    if (projectile._type !== 'EveMissile') throw new Error(`${projectileResPath} is a ${String(projectile._type)}, not an EveMissile`);
    if (impact._type !== 'EveEffectRoot2') throw new Error(`${impactResPath} is a ${String(impact._type)}, not an EveEffectRoot2`);
    const facts = MissileFileFacts(projectile, impact);
    if (!facts.warheads) throw new Error(`${projectileResPath} holds no warhead`);
    return { projectileResPath, impactResPath, projectile, impact, facts };
  }
}

function FilesKey(graphic: Pick<MissileGraphic, 'projectileResPath' | 'impactResPath'>): string {
  return `${graphic.projectileResPath}|${graphic.impactResPath}`;
}

/**
 * Where a drawn missile is: waiting for its burst start, flying (drawn), or ending (its target nulled: vanished, forced
 * or frozen; it detonates on its own).
 */
export type MissileDrawState = 'waiting' | 'flying' | 'ending';

/**
 * What the drawing reports about a live missile each frame.
 */
export interface MissileDrawProbe {
  /**
   * Whether its ball is still on the parks.
   */
  BallLive(id: string): boolean;
  /**
   * Whether its drawn ball has reached its target (within both ball radii).
   */
  Reached(id: string): boolean;
  /**
   * Whether its drawn ball is moving away from its closest approach to its target.
   */
  Passed(id: string): boolean;
  /**
   * Whether every one of its warheads is DEAD.
   */
  Dead(id: string): boolean;
}

/**
 * A detonation whose impact plays now: where, and whether an impact effect draws (false over the cap).
 */
export interface MissileImpactCommand {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly draw: boolean;
  /**
   * The impact's token, to end it (MissileDrawCommands.impactsEnded) when `draw`.
   */
  readonly token: number;
}

/**
 * What the drawing does this frame.
 */
export interface MissileDrawCommands {
  /**
   * Flights whose burst starts: take a missile from the pool and launch it.
   */
  readonly start: string[];
  /**
   * Missiles whose ball reached the target (or passed it, with the hit known): freeze the curve where the ball is,
   * keeping the target (the warhead flies onto it).
   */
  readonly arrive: string[];
  /**
   * Flights that ended without a hit: null the target (it explodes silently).
   */
  readonly vanish: string[];
  /**
   * Hits not detonated by their fallback time: null the target (it explodes where it is, with its impact).
   */
  readonly force: string[];
  /**
   * Live missiles whose ball left: freeze them on their last sample and null the target.
   */
  readonly freeze: string[];
  /**
   * Missiles whose warheads are all DEAD: off the scene and back to the pool.
   */
  readonly remove: string[];
  /**
   * Detonations of hits: post the impact sound, start a kill's explosion, draw the impact when `draw`.
   */
  readonly impacts: MissileImpactCommand[];
  /**
   * Impact tokens whose duration ran: off the scene and back to the pool.
   */
  readonly impactsEnded: number[];
}

export interface MissileDrawReport {
  /**
   * Drawn missiles flying or ending.
   */
  readonly live: number;
  /**
   * Flights waiting for their burst start.
   */
  readonly waiting: number;
  readonly impacts: number;
  readonly detonated: number;
  readonly vanished: number;
  readonly forced: number;
  readonly frozen: number;
  /**
   * Flights flown undrawn: over the cap, or their files not loaded at the burst start.
   */
  readonly skipped: number;
  /**
   * Impacts not drawn over the cap.
   */
  readonly impactsSkipped: number;
}

interface DrawEntry {
  readonly id: string;
  state: MissileDrawState;
  readonly startAt: number;
  readonly impactSeconds: number;
  /**
   * Its master hit's draw time.
   */
  hitAt: Maybe<number>;
  /**
   * Its master end's draw time when it ended without a hit.
   */
  vanishAt: Maybe<number>;
  /**
   * Where its warhead detonated, once it did.
   */
  detonation: Maybe<readonly [number, number, number]>;
  /**
   * Its target was nulled for a vanish or a freeze without a hit: its detonation plays nothing.
   */
  silent: boolean;
  forced: boolean;
  frozen: boolean;
  arrived: boolean;
  resolved: boolean;
  removed: boolean;
}

export interface MissileDrawPlanOptions {
  readonly maxLive?: number;
  readonly maxImpacts?: number;
  /**
   * Seconds per Destiny tick.
   */
  readonly tickSeconds: number;
}

/**
 * The drawn missiles' schedule (module header). Times are scene clock, 100 ns ticks.
 */
export class MissileDrawPlan {
  private readonly maxLive: number;
  private readonly maxImpacts: number;
  private readonly fallbackTicks: number;
  private readonly entries = new Map<string, DrawEntry>();
  private impacts: { readonly token: number; readonly endsAt: number }[] = [];
  private nextToken = 1;
  private totals = { detonated: 0, vanished: 0, forced: 0, frozen: 0, skipped: 0, impactsSkipped: 0 };

  constructor(options: MissileDrawPlanOptions) {
    this.maxLive = options.maxLive ?? MISSILES_LIVE_MAX;
    this.maxImpacts = options.maxImpacts ?? MISSILE_IMPACTS_LIVE_MAX;
    this.fallbackTicks = Math.round(MISSILE_FALLBACK_TICKS * options.tickSeconds * TICKS_PER_SECOND);
  }

  /**
   * A drawn launch: its missile starts at `startAt` unless the cap is full.
   *
   * @param id - The flight id.
   * @param startAt - Its burst start.
   * @param impactSeconds - How long its impact plays.
   * @returns Whether it draws; false counts it skipped.
   */
  Launch(id: string, startAt: number, impactSeconds: number): boolean {
    const live = [...this.entries.values()].filter((entry) => !entry.removed).length;
    if (live >= this.maxLive || this.entries.has(id)) {
      this.totals.skipped += 1;
      return false;
    }
    this.entries.set(id, { id, state: 'waiting', startAt, impactSeconds, hitAt: null, vanishAt: null, detonation: null, silent: false, forced: false, frozen: false, arrived: false, resolved: false, removed: false });
    return true;
  }

  /**
   * A flight that could not draw after all (its files not loaded, its pool failed): it flies undrawn.
   *
   * @param id - The flight id.
   */
  Skip(id: string): void {
    if (this.entries.delete(id)) this.totals.skipped += 1;
  }

  /**
   * Whether a flight's master hit is known.
   *
   * @param id - The flight id.
   */
  HitKnown(id: string): boolean {
    return this.entries.get(id)?.hitAt != null;
  }

  /**
   * Whether a flight is drawn (its end then plays through the drawing).
   *
   * @param id - The flight id.
   */
  Drawn(id: string): boolean {
    const entry = this.entries.get(id);
    return entry != null && !entry.resolved;
  }

  /**
   * Its master end is a hit, drawn at `at`.
   *
   * @param id - The flight id.
   * @param at - The hit's draw time.
   * @returns Whether the drawing plays it; false: the caller plays the impact sound and kill at `at` itself.
   */
  Hit(id: string, at: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.resolved || entry.state === 'waiting') {
      if (entry?.state === 'waiting') this.Drop(entry);
      return false;
    }
    entry.hitAt = at;
    // A freeze without a known end made it silent: the hit makes it play.
    if (!entry.vanishAt) entry.silent = false;
    return true;
  }

  /**
   * Its master end is an expiry or a loss, drawn at `at`: it vanishes then.
   *
   * @param id - The flight id.
   * @param at - The end's draw time.
   */
  Vanish(id: string, at: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.resolved) return;
    if (entry.state === 'waiting') this.Drop(entry);
    else if (entry.hitAt == null) entry.vanishAt = at;
  }

  /**
   * The runtime detonated the flight's warhead at `position` (its explosion callback, run after the frame).
   *
   * @param id - The flight id.
   * @param position - The warhead's explosion position.
   */
  Detonated(id: string, position: ArrayLike<number>): void {
    const entry = this.entries.get(id);
    if (!entry || entry.detonation) return;
    entry.detonation = [position[0], position[1], position[2]];
  }

  /**
   * Stops drawing a flight at once (its shooter or target left the scene, its drawn target is gone): it explodes
   * silently, or with its impact when it was a hit.
   *
   * @param id - The flight id.
   * @returns Whether a live missile needs its target nulled.
   */
  Release(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.resolved) return false;
    if (entry.state === 'waiting') {
      this.Drop(entry);
      return false;
    }
    if (entry.hitAt == null) entry.silent = true;
    const live = entry.state === 'flying' && !entry.detonation;
    entry.state = 'ending';
    return live;
  }

  /**
   * The frame's commands.
   *
   * @param now - The scene clock.
   * @param probe - The drawn missiles' balls and warheads.
   * @returns What to do.
   */
  Frame(now: number, probe: MissileDrawProbe): MissileDrawCommands {
    const commands: MissileDrawCommands = { start: [], arrive: [], vanish: [], force: [], freeze: [], remove: [], impacts: [], impactsEnded: [] };
    const ended = this.impacts.filter((impact) => impact.endsAt <= now);
    if (ended.length) {
      this.impacts = this.impacts.filter((impact) => impact.endsAt > now);
      commands.impactsEnded.push(...ended.map((impact) => impact.token));
    }
    for (const entry of [...this.entries.values()]) {
      if (entry.state === 'waiting') {
        if (entry.startAt > now) continue;
        entry.state = 'flying';
        commands.start.push(entry.id);
        continue;
      }
      if (entry.detonation && !entry.resolved) this.Resolve(entry, now, commands);
      if (!entry.removed && !entry.detonation) {
        if (entry.state === 'flying' && !entry.arrived && !entry.frozen && entry.vanishAt == null && (probe.Reached(entry.id) || (entry.hitAt != null && entry.hitAt <= now && probe.Passed(entry.id)))) {
          entry.arrived = true;
          commands.arrive.push(entry.id);
        }
        if (entry.state === 'flying' && entry.vanishAt != null && entry.vanishAt <= now) {
          entry.state = 'ending';
          entry.silent = true;
          this.totals.vanished += 1;
          commands.vanish.push(entry.id);
        } else if (entry.state === 'flying' && entry.hitAt != null && now >= entry.hitAt + this.fallbackTicks) {
          entry.state = 'ending';
          entry.forced = true;
          this.totals.forced += 1;
          commands.force.push(entry.id);
        } else if (!entry.frozen && !entry.arrived && !probe.BallLive(entry.id)) {
          entry.frozen = true;
          if (entry.hitAt == null) entry.silent = true;
          entry.state = 'ending';
          this.totals.frozen += 1;
          commands.freeze.push(entry.id);
        }
      }
      if (!entry.removed && probe.Dead(entry.id)) {
        entry.removed = true;
        commands.remove.push(entry.id);
      }
      // Kept past its removal until its detonation is resolved (a hit drained after the drawn detonation).
      if (entry.removed && (entry.resolved || !entry.detonation)) this.entries.delete(entry.id);
    }
    return commands;
  }

  /**
   * Forgets every flight, impact and count (a load); the drawing takes its missiles off itself.
   */
  Clear(): void {
    this.entries.clear();
    this.impacts = [];
    this.totals = { detonated: 0, vanished: 0, forced: 0, frozen: 0, skipped: 0, impactsSkipped: 0 };
  }

  /**
   * The flights the plan holds (waiting, live, or removed with a detonation to resolve).
   */
  Ids(): string[] {
    return [...this.entries.keys()];
  }

  StateOf(id: string): Maybe<MissileDrawState> {
    return this.entries.get(id)?.state ?? null;
  }

  Report(): MissileDrawReport {
    const entries = [...this.entries.values()];
    return {
      live: entries.filter((entry) => entry.state !== 'waiting' && !entry.removed).length,
      waiting: entries.filter((entry) => entry.state === 'waiting').length,
      impacts: this.impacts.length,
      ...this.totals
    };
  }

  private Resolve(entry: DrawEntry, now: number, commands: MissileDrawCommands): void {
    const position = entry.detonation;
    if (!position) return;
    if (entry.silent || (entry.vanishAt != null && entry.hitAt == null)) {
      entry.resolved = true;
      return;
    }
    // Detonated before its master end was known and not on its target: wait for it.
    if (entry.hitAt == null && !entry.arrived) return;
    entry.resolved = true;
    this.totals.detonated += 1;
    const draw = this.impacts.length < this.maxImpacts;
    const token = draw ? this.nextToken++ : 0;
    if (draw) this.impacts.push({ token, endsAt: now + Math.round(entry.impactSeconds * TICKS_PER_SECOND) });
    else this.totals.impactsSkipped += 1;
    commands.impacts.push({ id: entry.id, position, draw, token });
  }

  private Drop(entry: DrawEntry): void {
    this.entries.delete(entry.id);
    this.totals.skipped += 1;
  }
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
