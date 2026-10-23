/**
 * Which client death explosion a destroyed ship plays (`res:/fisfx/explosion/ecx_<name>.black`), and how long it lasts.
 * The client picks one through its explosion buckets (a graphic's `explosionBucketID`), which the public SDE drops and
 * tools-core cannot decode; this table maps size class and race onto the same files instead.
 */

import type { Maybe } from '@dereekb/util';
import { HULL_SIZE_CLASSES, type HullSizeClass, readRigSize, type RigSize } from '../stats/prop-mods';
import { combatPick } from './random';

/**
 * The most local blasts the page plays on a hull (a keyed subset of its damage locators).
 */
export const MAX_LOCAL_BLASTS = 8;

/**
 * An explosion file's EveChildExplosion timing values (seconds; the runtime's defaults where the file has none).
 */
export interface ExplosionTiming {
  readonly localExplosionInterval: number;
  readonly localExplosionIntervalFactor: number;
  readonly localExplosionDelay: number;
  readonly globalExplosionDelay: number;
  readonly localDuration: number;
  readonly globalDuration: number;
}

const timing = (localExplosionInterval: number, localExplosionIntervalFactor: number, globalExplosionDelay: number, localDuration: number, globalDuration: number): ExplosionTiming => ({
  localExplosionInterval,
  localExplosionIntervalFactor,
  localExplosionDelay: 0,
  globalExplosionDelay,
  localDuration,
  globalDuration
});

/**
 * The timing values of the files the table uses, read through tools-core (`?format=json`) from resources build 3632936
 * on 2026-10-23 (floats rounded to 4 decimals). The Triglavian dreadnought's file carries the older single
 * `localExplosion` / `globalExplosions` members instead of `localExplosions` / `globalExplosion`.
 */
export const SHIP_EXPLOSION_TIMINGS: Readonly<Record<string, ExplosionTiming>> = {
  generic_explosive_short_01a: timing(0.1, 0.966, 1.5, 15, 13),
  generic_explosive_short_01b: timing(0.1, 0.966, 2.1, 15, 20),
  generic_explosive_01a: timing(0.66, 0.97, 0.42, 15, 15),
  generic_explosive_01b: timing(0.66, 0.97, 0.42, 22.4666, 25),
  generic_explosive_01c: timing(0.22, 0.99, 8, 15, 21),
  generic_explosive_long_01a: timing(1.1, 0.98, 1, 20, 42),
  generic_explosive_long_01b: timing(0.75, 0.98, 1, 20, 40),
  generic_explosive_long_01c: timing(0.5, 0.99, 8, 20, 24),
  titan_amarr_explosive_01a: timing(1.1, 0.98, 0, 20, 35),
  titan_caldari_explosive_01a: timing(1.1, 0.98, 0, 20, 35),
  titan_gallente_explosive_01a: timing(1.1, 0.98, 0, 20, 35),
  titan_minmatar_explosive_01a: timing(1.1, 0.98, 0, 20, 35),
  titan_angel_explosive_01a: timing(1.042, 0.9333, 0, 20, 35),
  triglavian_explosive_01a: timing(0.42, 0.98, 4.2, 15, 38),
  triglavian_explosive_tgdn01_t1: timing(0.42, 0.98, 0, 15, 38),
  drifter_cruiser_explosive_01a: timing(0.42, 0.98, 4.2, 15, 38),
  drifter_explosive_01a: timing(0.42, 0.98, 4.2, 15, 38),
  sleeper_explosive_01a: timing(0.42, 0.98, 2.75, 15, 40)
};

/**
 * An upper bound on an explosion's `totalDuration` with `blasts` local blasts (the runtime's CalculateExplosionTimes
 * with every triFloatRandom01 at its 1 maximum): `max(localDelay + localDuration + S, globalDelay + S +
 * globalDuration)`, S the blasts' intervals summed, `interval × (1 − factor^N) / (1 − factor)`.
 *
 * @param values - The file's timing.
 * @param blasts - How many local blasts play.
 * @returns Seconds.
 */
export function explosionDurationBound(values: ExplosionTiming, blasts: number = MAX_LOCAL_BLASTS): number {
  const { localExplosionInterval: interval, localExplosionIntervalFactor: factor } = values;
  const spread = factor === 1 ? interval * blasts : (interval * (1 - factor ** blasts)) / (1 - factor);
  const delays = blasts > 0 ? { local: values.localExplosionDelay, global: values.globalExplosionDelay } : { local: 0, global: 0 };
  return Math.max(delays.local + values.localDuration + spread, delays.global + spread + values.globalDuration);
}

export interface ShipExplosionFile {
  /**
   * The file's name without `ecx_` and `.black` (`generic_explosive_01a`).
   */
  readonly name: string;
  readonly resPath: string;
  /**
   * Seconds the ball stays after the death: the file's duration bound with MAX_LOCAL_BLASTS, rounded up.
   */
  readonly lingerSeconds: number;
  /**
   * The hull bounding radius (m) the authored size suits; the page scales the explosion by `max(1, radius /
   * referenceRadius)`. Starting values per size class; the real-GPU check calibrates them.
   */
  readonly referenceRadius: number;
}

/**
 * The starting reference radius per size class.
 */
export const EXPLOSION_REFERENCE_RADII: Readonly<Record<HullSizeClass, number>> = { S: 40, M: 150, L: 450, XL: 1500 };

function explosionFile(name: string, size: HullSizeClass): ShipExplosionFile {
  return { name, resPath: `res:/fisfx/explosion/ecx_${name}.black`, lingerSeconds: Math.ceil(explosionDurationBound(SHIP_EXPLOSION_TIMINGS[name])), referenceRadius: EXPLOSION_REFERENCE_RADII[size] };
}

/**
 * The files by choice: generic variants per size class, titans by race, and the Triglavian, Drifter and Sleeper ones.
 */
export const SHIP_EXPLOSIONS = {
  S: ['generic_explosive_short_01a', 'generic_explosive_short_01b'].map((name) => explosionFile(name, 'S')),
  M: ['generic_explosive_01a', 'generic_explosive_01b', 'generic_explosive_01c'].map((name) => explosionFile(name, 'M')),
  L: ['generic_explosive_long_01a', 'generic_explosive_long_01b', 'generic_explosive_long_01c'].map((name) => explosionFile(name, 'L')),
  titan: Object.fromEntries(['amarr', 'caldari', 'gallente', 'minmatar', 'angel'].map((race) => [race, explosionFile(`titan_${race}_explosive_01a`, 'XL')])) as Readonly<Record<string, ShipExplosionFile>>,
  titanFallback: explosionFile('generic_explosive_long_01a', 'XL'),
  triglavian: explosionFile('triglavian_explosive_01a', 'M'),
  triglavianDreadnought: explosionFile('triglavian_explosive_tgdn01_t1', 'XL'),
  drifterCruiser: explosionFile('drifter_cruiser_explosive_01a', 'M'),
  drifter: explosionFile('drifter_explosive_01a', 'L'),
  sleeper: explosionFile('sleeper_explosive_01a', 'M')
} as const;

export const TITAN_GROUP = 30;
export const DREADNOUGHT_GROUP = 485;
export const TRIGLAVIAN_RACE_ID = 135;

export interface ShipExplosionInput {
  readonly groupID?: Maybe<number>;
  /**
   * The hull's rigSize (1547).
   */
  readonly rigSize?: Maybe<number>;
  /**
   * The SOF class's rig size, for a hull without rigSize.
   */
  readonly classRigSize?: Maybe<RigSize>;
  /**
   * The SDE race (135 Triglavian).
   */
  readonly raceID?: Maybe<number>;
  /**
   * The DNA's SOF race (`amarr`, `triglavian`, `jove`, `sleeper`, ...).
   */
  readonly sofRace?: Maybe<string>;
  readonly seed: number;
  /**
   * The ship id: the variant is keyed by (seed, ship).
   */
  readonly ship: string;
}

export interface ShipExplosionChoice extends ShipExplosionFile {
  readonly size: HullSizeClass;
}

/**
 * The death explosion a hull plays: titans by race, then Triglavian (their dreadnoughts' own file), Drifter and Sleeper
 * hulls, else a generic variant for the size class (S short, M normal, L and XL long), the variant keyed by seed and
 * ship.
 *
 * @param input - The hull's group, size and race, the seed and the ship id.
 * @returns The file, its linger and reference radius, and the size class.
 */
export function shipExplosionOf(input: ShipExplosionInput): ShipExplosionChoice {
  const { groupID, rigSize, classRigSize, raceID, sofRace, seed, ship } = input;
  const size = HULL_SIZE_CLASSES[readRigSize(rigSize) ?? classRigSize ?? 1];
  const race = raceID === TRIGLAVIAN_RACE_ID ? 'triglavian' : (sofRace?.trim().toLowerCase() ?? '');
  const pick = (files: readonly ShipExplosionFile[]): ShipExplosionFile => files[combatPick(seed, `explosion|${ship}`, files.length)];
  let file: ShipExplosionFile;
  if (groupID === TITAN_GROUP) file = SHIP_EXPLOSIONS.titan[race] ?? SHIP_EXPLOSIONS.titanFallback;
  else if (race === 'triglavian') file = groupID === DREADNOUGHT_GROUP ? SHIP_EXPLOSIONS.triglavianDreadnought : SHIP_EXPLOSIONS.triglavian;
  else if (race === 'jove' || race === 'drifter') file = size === 'M' ? SHIP_EXPLOSIONS.drifterCruiser : SHIP_EXPLOSIONS.drifter;
  else if (race === 'sleeper') file = SHIP_EXPLOSIONS.sleeper;
  else if (size === 'S') file = pick(SHIP_EXPLOSIONS.S);
  else if (size === 'M') file = pick(SHIP_EXPLOSIONS.M);
  else file = pick(SHIP_EXPLOSIONS.L);
  return { ...file, size };
}
