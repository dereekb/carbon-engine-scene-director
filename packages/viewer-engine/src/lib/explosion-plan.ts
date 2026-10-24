/**
 * The runtime-free half of the ship-death explosions: what the page reads off an explosion file
 * (`res:/fisfx/explosion/ecx_*.black`: an EveEffectRoot2 whose effect child is an EveChildExplosion), the files loaded
 * once each with or without a renderer, and the schedule of a kill (start, hull hide, end, ball removal, sounds) that a
 * headless page runs and the drawing refines.
 *
 * Node-tested: it imports nothing from ./runtime but types.
 */

import type { Maybe } from '@dereekb/util';
import type { ExplosionTiming } from '@scene-director/scene';
import type { CjsModelValues } from './runtime';

/**
 * Seconds past an explosion file's linger bound that a dead ship's ball stays: the killing shot's draw and its firing
 * delay come before the explosion starts.
 */
export const EXPLOSION_LINGER_MARGIN_SECONDS = 2;

export interface ExplosionFileFacts {
  /**
   * The EveChildExplosion's timing values (the runtime's defaults where the file has none), with the wreck switch's
   * offset from the global blast's start.
   */
  readonly timing: ExplosionTiming & { readonly wreckSwitchOffsetFromGlobalStart: number };
  /**
   * The sound events of the AudEventCurves named `local…` (one per local blast: `local`, the Triglavian dreadnought's
   * `local_explosion_sfx`) and `global…` (the global blast; that file has none).
   */
  readonly localEvents: string[];
  readonly globalEvents: string[];
  /**
   * The local blast variants the file carries.
   */
  readonly variants: number;
  /**
   * `list`: `localExplosions` and a `globalExplosion` container; `single`: the older `localExplosion` and
   * `globalExplosions` members (the Triglavian dreadnought's file). The runtime plays both.
   */
  readonly members: 'list' | 'single';
}

/**
 * Reads what the page needs from an explosion file's values.
 *
 * @param values - The `.black`'s values (an EveEffectRoot2).
 * @returns The facts, or null when the file has no EveChildExplosion.
 */
export function ExplosionFileFacts(values: unknown): Maybe<ExplosionFileFacts> {
  const children = Field(values, 'effectChildren');
  const child = (Array.isArray(children) ? children : []).find((candidate: unknown) => Field(candidate, '_type') === 'EveChildExplosion');
  if (!child) return null;
  const number = (key: string, fallback: number): number => {
    const value = Field(child, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const events = { local: [] as string[], global: [] as string[] };
  CollectSoundEvents(child, events, new Set());
  const locals = Field(child, 'localExplosions');
  const single = Field(child, 'localExplosion') != null;
  const variants = Array.isArray(locals) && locals.length ? locals.length : single ? 1 : 0;
  return {
    timing: {
      localExplosionInterval: number('localExplosionInterval', 1),
      localExplosionIntervalFactor: number('localExplosionIntervalFactor', 1),
      localExplosionDelay: number('localExplosionDelay', 0),
      globalExplosionDelay: number('globalExplosionDelay', 0),
      localDuration: number('localDuration', 0),
      globalDuration: number('globalDuration', 0),
      wreckSwitchOffsetFromGlobalStart: number('wreckSwitchOffsetFromGlobalStart', 0)
    },
    localEvents: [...new Set(events.local)],
    globalEvents: [...new Set(events.global)],
    variants,
    members: Array.isArray(locals) && locals.length ? 'list' : single ? 'single' : 'list'
  };
}

function CollectSoundEvents(value: unknown, into: { local: string[]; global: string[] }, seen: Set<unknown>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) CollectSoundEvents(item, into, seen);
    return;
  }
  if (Field(value, '_type') === 'AudEventCurve') {
    const name = Field(value, 'name');
    const keys = Field(value, 'keys');
    const found = (Array.isArray(keys) ? keys : []).map((key: unknown) => Field(key, 'value')).filter((event): event is string => typeof event === 'string' && event.length > 0);
    if (typeof name === 'string' && /^local/iu.test(name)) into.local.push(...found);
    else if (typeof name === 'string' && /^global/iu.test(name)) into.global.push(...found);
    return;
  }
  for (const item of Object.values(value)) CollectSoundEvents(item, into, seen);
}

/**
 * A loaded explosion file: its values and the facts.
 */
export interface ExplosionFile {
  readonly values: CjsModelValues;
  readonly facts: ExplosionFileFacts;
}

export interface ExplosionFilesOptions {
  /**
   * Reads a `.black` as values; the page passes ResourceValues.
   */
  readonly read: (path: string) => Promise<CjsModelValues>;
}

/**
 * Explosion files by path, each loaded once, with or without a renderer (a headless page still posts their sounds). A
 * failed load is kept with its error until ForgetFailures (every load / open).
 */
export class ExplosionFiles {
  private readonly read: (path: string) => Promise<CjsModelValues>;
  private readonly files = new Map<string, ExplosionFile>();
  private readonly failures = new Map<string, string>();
  private readonly loads = new Map<string, Promise<ExplosionFile>>();

  constructor(options: ExplosionFilesOptions) {
    this.read = options.read;
  }

  /**
   * A loaded file.
   *
   * @param path - The explosion's res path.
   * @returns It, or null while it loads, before it is asked for, or when it failed.
   */
  Cached(path: string): Maybe<ExplosionFile> {
    return this.files.get(path) ?? null;
  }

  /**
   * Why a file failed to load.
   *
   * @param path - The explosion's res path.
   * @returns The error, or null.
   */
  Failure(path: string): Maybe<string> {
    return this.failures.get(path) ?? null;
  }

  /**
   * Loads an explosion file once per path.
   *
   * @param path - The explosion's res path.
   * @returns The file; rejects when it fails to read or holds no EveChildExplosion.
   */
  Load(path: string): Promise<ExplosionFile> {
    const cached = this.files.get(path);
    if (cached) return Promise.resolve(cached);
    const failure = this.failures.get(path);
    if (failure) return Promise.reject(new Error(failure));
    let load = this.loads.get(path);
    if (!load) {
      load = this.LoadFile(path).then(
        (file) => {
          this.files.set(path, file);
          this.loads.delete(path);
          return file;
        },
        (error: unknown) => {
          this.failures.set(path, error instanceof Error ? error.message : String(error));
          this.loads.delete(path);
          throw error;
        }
      );
      this.loads.set(path, load);
    }
    return load;
  }

  /**
   * Forgets every failed load, so the next Load reads again.
   */
  ForgetFailures(): void {
    this.failures.clear();
  }

  private async LoadFile(path: string): Promise<ExplosionFile> {
    const values = await this.read(path);
    if (values._type !== 'EveEffectRoot2') throw new Error(`${path} is a ${String(values._type)}, not an EveEffectRoot2`);
    const facts = ExplosionFileFacts(values);
    if (!facts) throw new Error(`${path} holds no EveChildExplosion`);
    return { values, facts };
  }
}

/**
 * The master tick boundary a dead ship's ball leaves the parks at: the first at or after the death boundary +
 * ceil((linger + margin) / tick), the same with or without a renderer.
 *
 * @param deathTick - The kill's master tick boundary.
 * @param lingerSeconds - The chosen file's linger bound.
 * @param tickSeconds - Seconds per Destiny tick.
 * @returns The tick.
 */
export function ExplosionRemoveTick(deathTick: number, lingerSeconds: number, tickSeconds: number): number {
  return deathTick + Math.ceil((lingerSeconds + EXPLOSION_LINGER_MARGIN_SECONDS) / tickSeconds);
}

export interface ExplosionScheduleInput {
  /**
   * When the explosion starts, in seconds of page time: the killing shot's draw plus its set's firing delay.
   */
  readonly start: number;
  /**
   * The file's facts, null while it loads or when it failed (no sounds then; the hide falls back to the start).
   */
  readonly facts: Maybe<ExplosionFileFacts>;
  readonly deathTick: number;
  readonly lingerSeconds: number;
  readonly tickSeconds: number;
  /**
   * Seconds after the start the hull hides when there are no facts: a stand-in's pop without EVE data, which loads no
   * explosion file (stand-ins.ts STAND_IN_DEATH_SECONDS).
   */
  readonly hideAfter?: number;
}

export interface ExplosionSoundPost {
  readonly at: number;
  readonly part: 'local' | 'global';
  readonly event: string;
}

export interface ExplosionTimes {
  readonly start: number;
  /**
   * When the hull's drawing retires headless: the global blast's start (local and global delays, the blasts' spread
   * left out) plus the wreck switch offset. A drawn explosion hides at its own `wreckSwitchTime`.
   */
  readonly hide: number;
  /**
   * The start plus the linger bound.
   */
  readonly end: number;
  readonly removeTick: number;
  /**
   * The headless sound posts: the first local event at the start, the first global event at start + local delay +
   * global delay.
   */
  readonly sounds: ExplosionSoundPost[];
}

/**
 * The schedule of one kill's explosion for a page without a renderer, and its ball removal for every page.
 *
 * @param input - The start, the file's facts, the death tick, linger and tick length.
 * @returns The times.
 */
export function ExplosionSchedule(input: ExplosionScheduleInput): ExplosionTimes {
  const { start, facts, deathTick, lingerSeconds, tickSeconds } = input;
  const global = facts ? start + facts.timing.localExplosionDelay + facts.timing.globalExplosionDelay : start + (input.hideAfter ?? 0);
  const sounds: ExplosionSoundPost[] = [];
  if (facts?.localEvents.length) sounds.push({ at: start, part: 'local', event: facts.localEvents[0] });
  if (facts?.globalEvents.length) sounds.push({ at: global, part: 'global', event: facts.globalEvents[0] });
  return {
    start,
    hide: global + (facts?.timing.wreckSwitchOffsetFromGlobalStart ?? 0),
    end: start + lingerSeconds,
    removeTick: ExplosionRemoveTick(deathTick, lingerSeconds, tickSeconds),
    sounds
  };
}

/**
 * A destroyed ship's explosion as a time-control landing finds it (sd-time), in one time unit throughout.
 */
export interface ExplosionReplayDeath {
  /**
   * When its explosion starts; null while its killing shot has not drawn.
   */
  readonly start: Maybe<number>;
  /**
   * When its hull's drawing retires (the wreck switch, ExplosionTimes.hide); null when unknown (the file not loaded).
   */
  readonly hide: Maybe<number>;
  readonly begun: boolean;
  readonly hidden: boolean;
  /**
   * Its ball left the parks.
   */
  readonly gone: boolean;
}

/**
 * What a landing does with the explosions: `replay` restarts at the target (begun, schedule and posted reset, start =
 * the target), `hide` retires the hull now (its wreck switch passed while nothing drew), `restart` resets one that
 * starts after the target (it begins as usual at its start). Deaths in none of them follow the normal path.
 */
export interface ExplosionReplayPlan {
  readonly replay: string[];
  readonly hide: string[];
  readonly restart: string[];
}

/**
 * Which explosions a time-control jump plays again when it lands (sd-time): the re-simulation runs no drawing, so an
 * explosion that started before the target and whose hull is still visible at it replays from its start at the target;
 * one whose wreck switch passed stays hidden (hidden now when the re-simulation never hid it); one starting after the
 * target begins at its own start.
 *
 * @param deaths - The destroyed ships by id.
 * @param target - The landing, in the deaths' time unit.
 * @returns The plan.
 */
export function ExplosionReplays(deaths: Iterable<readonly [string, ExplosionReplayDeath]>, target: number): ExplosionReplayPlan {
  const plan = { replay: [] as string[], hide: [] as string[], restart: [] as string[] };
  for (const [id, death] of deaths) {
    if (death.gone || death.hidden || death.start == null) continue;
    if (death.start > target) {
      if (death.begun) plan.restart.push(id);
    } else if (death.hide != null && target >= death.hide) plan.hide.push(id);
    else plan.replay.push(id);
  }
  return plan;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
