/**
 * The director's framings: what it can put on screen for a subject, at which scale, and the play_shot JSON for it.
 * Library shots are used where one exists (with duration, transition, lag and presentation overridden); the rest are
 * explicit hardpoint shots with a default look lag.
 *
 * Each framing also gives the hardpoint the director resolves on its own scene to check the candidate (a pose exists,
 * the eye is clear) and to judge its side of the axis.
 */

import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../../json';
import type { HardpointRef } from '../hardpoints';
import type { DirectorScale } from './command';
import type { DirectorGroupSubject, DirectorSubject, DirectorSubjectKind } from './interest';

export const DIRECTOR_FRAMING_NAMES = [
  'hero',
  'rear-quarter',
  'broadside',
  'bow-on',
  'flyby',
  'top-down',
  'chase',
  'kill',
  'over-the-shoulder',
  'behind-fc',
  'flank',
  'leading-edge',
  'group-top-down',
  'warp-in',
  'overlook',
  'overlook-pull-out',
  'into-sun',
  'into-celestial',
  'battle-fly-through',
  'establishing'
] as const;

export type DirectorFramingName = (typeof DIRECTOR_FRAMING_NAMES)[number];

/**
 * The fill a kill framing frames its victim at, so the explosion fits (a larger hull: KILL_FILL_LARGE).
 */
export const KILL_FILL = 0.25;
export const KILL_FILL_LARGE = 0.4;
export const KILL_FILL_LARGE_RADIUS = 300;
/**
 * The look lag of the director's explicit hardpoint shots, seconds.
 */
export const DIRECTOR_LOOK_LAG = 0.3;

export interface DirectorFramingRow {
  readonly name: DirectorFramingName;
  readonly subject: DirectorSubjectKind;
  /**
   * Its scale; `group`: wide on a whole fleet, medium on a wing, squad or handful.
   */
  readonly scale: DirectorScale | 'group';
  readonly weight: number;
  /**
   * Its variants (a side, or a kill's hardpoint); none: one candidate.
   */
  readonly variants?: readonly string[];
  /**
   * It crosses the axis on purpose (the fly-through): its side is its start side, and the kept side flips after it.
   */
  readonly crossing?: boolean;
  /**
   * The library shot it plays, when one.
   */
  readonly library?: string;
  readonly description: string;
}

const SIDES = ['port', 'starboard'] as const;

export const DIRECTOR_FRAMINGS: readonly DirectorFramingRow[] = [
  { name: 'hero', subject: 'ship', scale: 'close', weight: 1.0, variants: SIDES, library: 'hero', description: 'the front three-quarter on a long lens' },
  { name: 'rear-quarter', subject: 'ship', scale: 'close', weight: 0.8, variants: SIDES, description: 'behind a quarter, above' },
  { name: 'broadside', subject: 'ship', scale: 'close', weight: 0.7, variants: SIDES, description: 'the hull in profile' },
  { name: 'bow-on', subject: 'ship', scale: 'close', weight: 0.6, description: 'dead ahead, while it flies over 30 % of its top speed' },
  { name: 'flyby', subject: 'ship', scale: 'close', weight: 1.0, library: 'flyby', description: 'a fixed point on its path, while it flies over 100 m/s' },
  { name: 'top-down', subject: 'ship', scale: 'close', weight: 0.3, description: 'straight down on the hull' },
  { name: 'chase', subject: 'ship', scale: 'medium', weight: 0.9, library: 'chase', description: 'behind it, while it flies over 20 % of its top speed' },
  { name: 'kill', subject: 'ship', scale: 'medium', weight: 1.2, variants: ['hero-port', 'hero-starboard', 'broadside-port', 'broadside-starboard'], description: 'a doomed or exploding ship, framed loose for the blast' },
  { name: 'over-the-shoulder', subject: 'pair', scale: 'medium', weight: 1.1, variants: SIDES, library: 'over-the-shoulder', description: 'over a shooter, logi or attacker at its target' },
  { name: 'behind-fc', subject: 'group', scale: 'group', weight: 1.0, description: 'behind the group past its leader at the enemy (an enemy exists)' },
  { name: 'flank', subject: 'group', scale: 'group', weight: 0.8, variants: SIDES, description: 'the formation in profile' },
  { name: 'leading-edge', subject: 'group', scale: 'group', weight: 0.7, description: 'ahead of the formation looking back (its leader moving)' },
  { name: 'group-top-down', subject: 'group', scale: 'wide', weight: 0.5, description: 'straight down on the formation' },
  { name: 'warp-in', subject: 'group', scale: 'wide', weight: 1.3, variants: SIDES, library: 'warp-in', description: 'at the landing of an arriving or warping group' },
  { name: 'overlook', subject: 'engagement', scale: 'wide', weight: 0.9, variants: SIDES, description: 'high and wide over the fight, off one side of the axis' },
  { name: 'overlook-pull-out', subject: 'engagement', scale: 'wide', weight: 1.1, variants: SIDES, library: 'overlook-pull-out', description: 'the overlook pulling out, in the first 10 s after the fleets engage' },
  { name: 'into-sun', subject: 'engagement', scale: 'wide', weight: 0.8, library: 'into-sun', description: 'across the fight into the sun (more than 15° off vertical)' },
  { name: 'into-celestial', subject: 'engagement', scale: 'wide', weight: 0.6, library: 'into-celestial', description: 'across the fight toward a landmark near it' },
  { name: 'battle-fly-through', subject: 'engagement', scale: 'wide', weight: 0.7, variants: SIDES, crossing: true, library: 'battle-fly-through', description: 'a pass through the fight from one side of the axis to the other (intensity over 0.5)' },
  { name: 'establishing', subject: 'landmark', scale: 'wide', weight: 1.0, library: 'establishing', description: 'a landmark with the ships in front of it' }
];

export const DIRECTOR_FRAMING_ROWS: ReadonlyMap<DirectorFramingName, DirectorFramingRow> = new Map(DIRECTOR_FRAMINGS.map((row) => [row.name, row]));

/**
 * A framing's scale on a subject.
 */
export function framingScale(row: DirectorFramingRow, subject: DirectorSubject): DirectorScale {
  let scale: DirectorScale = row.scale === 'group' ? 'medium' : row.scale;
  if (row.scale === 'group') scale = subject.kind === 'group' && subject.whole ? 'wide' : 'medium';
  return scale;
}

export interface DirectorFramingOptions {
  /**
   * Seconds; omitted holds.
   */
  readonly duration?: number;
  readonly transition: { readonly type: 'cut' } | { readonly type: 'blend'; readonly duration: number; readonly easing?: string };
  readonly letterbox?: Maybe<number | false>;
  readonly hud?: Maybe<boolean>;
  /**
   * The engagement's core-fill factor (≥ 1): engagement framings frame its core.
   */
  readonly coreFactor?: number;
  /**
   * The axis teams for engagement framings.
   */
  readonly teams?: Maybe<readonly [string, string]>;
  /**
   * The kill framing's victim radius, metres.
   */
  readonly radius?: number;
  /**
   * into-celestial's landmark.
   */
  readonly landmark?: { readonly object?: string; readonly celestial?: number };
}

export interface DirectorFramingShot {
  /**
   * The play_shot JSON.
   */
  readonly shot: JsonObject;
  /**
   * What the director resolves to check it.
   */
  readonly hardpoint: HardpointRef;
}

/**
 * The engagement framings' default fills (their hardpoints' rows), scaled by the core factor.
 */
const ENGAGEMENT_FILLS: Readonly<Record<string, number>> = { overlook: 0.9, 'overlook-pull-out': 1.15, 'into-sun': 0.75, 'into-celestial': 0.75, 'battle-fly-through': 0.9 };

function groupKeys(subject: DirectorGroupSubject): JsonObject {
  let keys: JsonObject;
  if (subject.ships) keys = { ships: [...subject.ships] };
  else keys = { fleet: subject.fleet, ...(subject.wing ? { wing: subject.wing } : {}), ...(subject.squad ? { squad: subject.squad } : {}) };
  return keys;
}

/**
 * The play_shot JSON for a framing on a subject, and the hardpoint to check it with.
 *
 * @param row - The framing.
 * @param subject - Its subject (of the row's kind).
 * @param variant - The variant (a side; a kill's hardpoint).
 * @param options - Duration, transition, presentation and the framing's own options.
 * @returns The shot, or null when the subject is not of the row's kind.
 */
export function toFramingShot(row: DirectorFramingRow, subject: DirectorSubject, variant: Maybe<string>, options: DirectorFramingOptions): Maybe<DirectorFramingShot> {
  const side = variant === 'port' || variant === 'starboard' ? variant : null;
  const common: JsonObject = {
    ...(options.duration == null ? {} : { duration: options.duration }),
    end: 'hold',
    transition: options.transition,
    ...(options.letterbox == null ? {} : { letterbox: options.letterbox }),
    ...(options.hud == null ? {} : { hud: options.hud }),
    name: ['director', row.name, ...(variant ? [variant] : [])].join(' ')
  };
  const explicit = (hardpoint: HardpointRef): DirectorFramingShot => ({ shot: { hardpoint: { ...hardpoint }, lag: { look: DIRECTOR_LOOK_LAG }, ...common }, hardpoint });
  const library = (keys: JsonObject, hardpoint: HardpointRef): DirectorFramingShot => ({ shot: { shot: row.library, ...keys, ...(side ? { side } : {}), ...common }, hardpoint });
  let built: Maybe<DirectorFramingShot> = null;
  if (subject.kind === 'ship' && row.subject === 'ship') {
    const ship = subject.ship;
    if (row.name === 'hero') built = library({ ship }, { name: `hero-${side ?? 'port'}`, ship });
    else if (row.name === 'rear-quarter') built = explicit({ name: `rear-quarter-${side ?? 'port'}-high`, ship });
    else if (row.name === 'broadside') built = explicit({ name: `broadside-${side ?? 'port'}`, ship });
    else if (row.name === 'bow-on' || row.name === 'top-down') built = explicit({ name: row.name, ship });
    else if (row.name === 'flyby') built = library({ ship }, { name: 'flyby', ship });
    else if (row.name === 'chase') built = library({ ship }, { name: 'chase', ship });
    else if (row.name === 'kill') {
      const fill = (options.radius ?? 0) > KILL_FILL_LARGE_RADIUS ? KILL_FILL_LARGE : KILL_FILL;
      built = explicit({ name: variant ?? 'hero-port', ship, fill });
    }
  } else if (subject.kind === 'pair' && row.subject === 'pair') {
    built = library({ ship: subject.ship, target: subject.target }, { name: 'over-the-shoulder', ship: subject.ship, target: subject.target, ...(side ? { side } : {}) });
  } else if (subject.kind === 'group' && row.subject === 'group') {
    const keys = groupKeys(subject);
    const ref = keys as unknown as Omit<HardpointRef, 'name'>;
    if (row.name === 'warp-in') built = library(keys, { name: 'warp-landing', ...ref, ...(side ? { side } : {}) });
    else if (row.name === 'flank') built = explicit({ name: `flank-${side ?? 'port'}`, ...ref });
    else if (row.name === 'group-top-down') built = explicit({ name: 'top-down', ...ref });
    else built = explicit({ name: row.name, ...ref });
  } else if (subject.kind === 'engagement' && row.subject === 'engagement') {
    const teams = options.teams ? { teams: [...options.teams] } : {};
    const teamsRef = options.teams ? { teams: options.teams } : {};
    // A hardpoint's fill tops out at 1.5 (shot.ts).
    const fill = Math.min(1.5, Math.round((ENGAGEMENT_FILLS[row.name] ?? 0.9) * (options.coreFactor ?? 1) * 100) / 100);
    const fillKey = (options.coreFactor ?? 1) > 1 ? { fill } : {};
    if (row.name === 'overlook') built = explicit({ name: 'overlook', ...teamsRef, ...(side ? { side } : {}), ...fillKey });
    else if (row.name === 'into-celestial') {
      const landmark = options.landmark;
      if (landmark) {
        const target = landmark.object != null ? { object: landmark.object } : { celestial: landmark.celestial };
        built = library({ ...teams, ...target, ...fillKey }, { name: 'into-celestial', ...teamsRef, ...target, ...fillKey });
      }
    } else {
      const hardpoint = row.name === 'into-sun' ? 'into-sun' : 'overlook';
      const libraryFill = row.name === 'overlook-pull-out' ? { fill } : fillKey;
      // The fly-through's side is its start side; the library's default start is port.
      built = library({ ...teams, ...libraryFill }, { name: hardpoint, ...teamsRef, ...(side && hardpoint === 'overlook' ? { side } : {}), ...libraryFill });
    }
  } else if (subject.kind === 'landmark' && row.subject === 'landmark') {
    const target = subject.object != null ? { object: subject.object } : { celestial: subject.celestial };
    built = library(target, { name: 'establishing', ...target });
  }
  return built;
}
