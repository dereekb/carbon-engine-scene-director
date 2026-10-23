/**
 * What a ship's guns mount from, before the runtime gets involved: one mount per fitted weapon module with a graphic
 * (TurretMountsOf), a key that changes with them (TurretMountsKey), and the turret and firing-effect files as values,
 * loaded once per path, with what the page reads off them (TurretFiles, TurretFileFacts).
 *
 * - Mounts come from the resolved fit's typed modules (`weapon: 'turret' | 'launcher'`), offline ones included, in key
 *   order; the EFT text is never read again. A ship without a fit mounts its default weapons fit the same way.
 * - The files load with or without a renderer, so their sound events can be checked headless.
 *
 * Node-tested: it imports nothing from ./runtime but types.
 */

import type { Maybe } from '@dereekb/util';
import type { WeaponGraphic } from '@scene-director/scene';
import type { ResolvedShipFitting } from './fittings';
import type { CjsModelValues } from './runtime';

/**
 * A fitted weapon to mount on the ship's hull.
 */
export interface TurretMount {
  /**
   * The fitted module's key (`high-3`).
   */
  readonly key: string;
  readonly typeID: number;
  readonly name: string;
  readonly kind: 'turret' | 'launcher';
  /**
   * The weapon's turret `.black` (an EveTurretSet).
   */
  readonly resPath: string;
  /**
   * The SOF faction its graphic is painted with; null paints it from the ship's DNA.
   */
  readonly faction: Maybe<string>;
  /**
   * Its EVE high slot index (`high-<n>`), when its key names one.
   */
  readonly highIndex: Maybe<number>;
}

export type TurretMountState = 'loading' | 'mounted' | 'failed' | 'unplaced';

/**
 * A weapon row's mount in get_state.
 */
export interface TurretMountReport {
  /**
   * The locator base the set binds (`locator_turret_4`), once placed.
   */
  readonly locator?: string;
  readonly state: TurretMountState;
  /**
   * Turret models drawn (one per lettered locator), once mounted.
   */
  readonly models?: number;
  readonly error?: string;
}

const HIGH_KEY = /^high-(\d+)$/u;

/**
 * The high slot index of a module key.
 *
 * @param key - A fitted module key.
 * @returns The index of a `high-<n>` key, else null.
 */
export function HighIndexOf(key: string): Maybe<number> {
  const match = HIGH_KEY.exec(key);
  return match ? Number(match[1]) : null;
}

/**
 * One mount per fitted weapon module that has a resolved type and a graphic, offline ones included, in key order (high
 * slots by index, then the rest by key).
 *
 * @param resolved - The ship's resolved fit (its own or its default weapons); null without one.
 * @param graphicOf - A weapon type's graphic (the /weapon answer), null while unknown or when it has none.
 * @returns The mounts.
 */
export function TurretMountsOf(resolved: Maybe<Pick<ResolvedShipFitting, 'modules'>>, graphicOf: (typeID: number) => Maybe<WeaponGraphic>): TurretMount[] {
  const mounts = (resolved?.modules ?? []).flatMap((module): TurretMount[] => {
    const graphic = module.weapon && module.typeID != null ? graphicOf(module.typeID) : null;
    return graphic && module.typeID != null ? [{ key: module.key, typeID: module.typeID, name: module.name, kind: graphic.kind, resPath: graphic.resPath, faction: graphic.sofFactionName ?? null, highIndex: HighIndexOf(module.key) }] : [];
  });
  return mounts.sort((a, b) => CompareMountKeys(a, b));
}

function CompareMountKeys(a: TurretMount, b: TurretMount): number {
  let order: number;
  if (a.highIndex != null && b.highIndex != null) order = a.highIndex - b.highIndex;
  else if (a.highIndex != null) order = -1;
  else if (b.highIndex != null) order = 1;
  else order = a.key < b.key ? -1 : Number(a.key > b.key);
  return order;
}

/**
 * A key that changes whenever a ship's mounts do (a refit, a graphic that landed): the ship then remounts.
 *
 * @param mounts - The mounts.
 * @returns The key.
 */
export function TurretMountsKey(mounts: readonly TurretMount[]): string {
  return JSON.stringify(mounts.map((mount) => [mount.key, mount.typeID, mount.resPath, mount.faction]));
}

/**
 * The sound events one of a firing effect's AudEventCurves carries.
 */
export interface TurretSoundCurve {
  /**
   * The curve's name (`PlayTurretFX`, `PlayTurretImpact`).
   */
  readonly curve: string;
  /**
   * The emitter it would post on (`TurretFX`, `TurretImpact`).
   */
  readonly emitter: Maybe<string>;
  readonly events: string[];
}

/**
 * What the page reads off a turret file and its firing effect.
 */
export interface TurretFileFacts {
  /**
   * The locator collection the set mounts on (`locator_turret_`, `locator_xl_`, ...).
   */
  readonly locatorName: string;
  readonly firingEffectResPath: Maybe<string>;
  /**
   * The turret's movement sounds: deploying to target and packing back to idle.
   */
  readonly deployEvent: Maybe<string>;
  readonly packEvent: Maybe<string>;
  /**
   * The firing effect's start curves (`play_start`) that carry sounds.
   */
  readonly sounds: TurretSoundCurve[];
  /**
   * The firing sound events (every start curve but the impact ones).
   */
  readonly fireEvents: string[];
  /**
   * The impact sound events (start curves named for impacts).
   */
  readonly impactEvents: string[];
}

/**
 * Reads what the page needs from a turret's values and its firing effect's.
 *
 * @param turret - The turret `.black`'s values (an EveTurretSet).
 * @param fx - The firing effect's values (an EveTurretFiringFX), when loaded.
 * @returns The facts; missing fields read as null or empty.
 */
export function TurretFileFacts(turret: unknown, fx: unknown = null): TurretFileFacts {
  const curves = Field(Field(fx, 'startCurveSet'), 'curves');
  const sounds = (Array.isArray(curves) ? curves : []).flatMap((curve: unknown): TurretSoundCurve[] => {
    const keys = Field(curve, 'keys');
    const events = (Array.isArray(keys) ? keys : []).map((key: unknown) => Field(key, 'value')).filter((value): value is string => typeof value === 'string' && value.length > 0);
    return Field(curve, '_type') === 'AudEventCurve' && events.length ? [{ curve: Text(Field(curve, 'name')) ?? '', emitter: Text(Field(Field(Field(curve, 'sourceTriObserver'), 'observer'), 'name')), events }] : [];
  });
  const impact = (sound: TurretSoundCurve): boolean => /impact/iu.test(sound.curve);
  return {
    locatorName: Text(Field(turret, 'locatorName')) ?? '',
    firingEffectResPath: Text(Field(turret, 'firingEffectResPath')),
    deployEvent: Text(Field(turret, 'idleToTargetingMovementAudioEvent')),
    packEvent: Text(Field(turret, 'targetingToIdleMovementAudioEvent')),
    sounds,
    fireEvents: sounds.filter((sound) => !impact(sound)).flatMap((sound) => sound.events),
    impactEvents: sounds.filter(impact).flatMap((sound) => sound.events)
  };
}

/**
 * A loaded turret file: its values, its firing effect's (null when that failed or it names none), and the facts.
 */
export interface TurretFile {
  readonly turret: CjsModelValues;
  readonly fx: Maybe<CjsModelValues>;
  /**
   * Why the firing effect did not load.
   */
  readonly fxError: Maybe<string>;
  readonly facts: TurretFileFacts;
}

export interface TurretFilesOptions {
  /**
   * Reads a `.black` (or `.red`) as values; the page passes ResourceValues.
   */
  readonly read: (path: string) => Promise<CjsModelValues>;
}

/**
 * Turret files by path, each loaded once with its firing effect. A failed load is kept with its error until
 * ForgetFailures (every load / open).
 */
export class TurretFiles {
  private readonly read: (path: string) => Promise<CjsModelValues>;
  private readonly files = new Map<string, TurretFile>();
  private readonly failures = new Map<string, string>();
  private readonly loads = new Map<string, Promise<TurretFile>>();

  constructor(options: TurretFilesOptions) {
    this.read = options.read;
  }

  /**
   * A loaded file.
   *
   * @param path - The turret's res path.
   * @returns It, or null while it loads, before it is asked for, or when it failed.
   */
  Cached(path: string): Maybe<TurretFile> {
    return this.files.get(path) ?? null;
  }

  /**
   * Why a file failed to load.
   *
   * @param path - The turret's res path.
   * @returns The error, or null.
   */
  Failure(path: string): Maybe<string> {
    return this.failures.get(path) ?? null;
  }

  /**
   * Loads a turret file and its firing effect, once per path.
   *
   * @param path - The turret's res path.
   * @returns The file; rejects with the turret file's error (a failed firing effect only sets `fxError`).
   */
  Load(path: string): Promise<TurretFile> {
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

  private async LoadFile(path: string): Promise<TurretFile> {
    const turret = await this.read(path);
    if (turret._type !== 'EveTurretSet') throw new Error(`${path} is a ${String(turret._type)}, not an EveTurretSet`);
    const fxPath = TurretFileFacts(turret).firingEffectResPath;
    let fx: Maybe<CjsModelValues> = null;
    let fxError: Maybe<string> = null;
    if (fxPath) {
      try {
        fx = await this.read(fxPath);
      } catch (error) {
        fxError = error instanceof Error ? error.message : String(error);
      }
    } else fxError = 'the turret names no firing effect';
    return { turret, fx, fxError, facts: TurretFileFacts(turret, fx) };
  }
}

function Text(value: unknown): Maybe<string> {
  return typeof value === 'string' && value.length ? value : null;
}

function Field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
