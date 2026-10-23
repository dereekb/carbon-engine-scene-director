/**
 * The named shot library: shots a director calls by name ("pull out over the battle", "watch the fleet land"), each a
 * pure builder of an explicit shot (cinema/shot.ts) for a subject, its options and a duration.
 *
 *   { shot: "<name>", ...subject (ship | fleet [+ wing | squad] | ships | teams | object | celestial, target?),
 *     fov?, fill?, bank?, side?, duration?, ...overrides }
 *
 * - Subject keys and `fov`, `fill`, `bank` go on the hardpoint; `side` and `duration` go to the builder, so moves timed
 *   in halves of the shot scale with it.
 * - `end`, `transition`, `lag`, `letterbox`, `hud`, `clearance` and `name` replace the library's; `moves` are added after
 *   its own (a roll or a shake on a library shot).
 * - Every library move is scale-free (factors, angles, fovs, radius-scaled paths), so a shot fits any subject size.
 * - Library shots hold their last frame once their duration is up (`end: "hold"`).
 *
 * normalizeCameraShot expands a reference at play time, so a timeline cue can embed `{ shot: "<name>" }` unchanged.
 */

import type { Maybe } from '@dereekb/util';
import { reportUnknownKeys, type JsonObject } from '../json';

/**
 * What a library shot frames: the engagement (two teams), a group (a fleet, wing, squad or ships; also a lone ship), a
 * ship, or a landmark (a scene object or a location celestial).
 */
export type CameraShotLibrarySubject = 'engagement' | 'group' | 'ship' | 'landmark';

export interface LibraryShotArgs {
  /**
   * The hardpoint's subject keys and its fov, fill and bank, as given.
   */
  readonly hardpoint: JsonObject;
  readonly side?: 'port' | 'starboard';
  /**
   * Seconds: the override, else the entry's default; undefined holds until stopped.
   */
  readonly duration?: number;
}

export interface CameraShotLibraryEntry {
  readonly name: string;
  readonly description: string;
  readonly subject: CameraShotLibrarySubject;
  /**
   * The subject keys and options it reads.
   */
  readonly options: readonly string[];
  /**
   * Seconds; undefined holds until stopped.
   */
  readonly duration?: number;
  /**
   * A reference list_shots shows.
   */
  readonly example: JsonObject;
  /**
   * The explicit shot for a subject, options and duration.
   */
  readonly build: (args: LibraryShotArgs) => JsonObject;
}

const EASE = 'ease-in-out';

function blend(duration: number): JsonObject {
  return { type: 'blend', duration, easing: EASE };
}

function timed(duration: Maybe<number>): JsonObject {
  return duration == null ? {} : { duration };
}

export const CAMERA_SHOT_LIBRARY: readonly CameraShotLibraryEntry[] = [
  {
    name: 'overlook-pull-out',
    description: 'the battlefield overlook, slowly pulling out and turning over both fleets, then holding on the wide',
    subject: 'engagement',
    options: ['teams', 'side'],
    duration: 24,
    example: { shot: 'overlook-pull-out' },
    build: ({ hardpoint, side, duration }) => ({
      hardpoint: { name: 'overlook', fill: 1.15, ...(side ? { side } : {}), ...hardpoint },
      ...timed(duration),
      transition: blend(2),
      moves: [
        { type: 'push', factor: 2.2, easing: EASE },
        { type: 'orbit', axis: 'up', angle: 18, easing: EASE }
      ],
      lag: { look: 0.5 }
    })
  },
  {
    name: 'into-sun',
    description: 'across the battle into the sun, the ships in silhouette against the flare, turning slowly and closing the lens',
    subject: 'engagement',
    options: ['teams'],
    duration: 16,
    example: { shot: 'into-sun' },
    build: ({ hardpoint, duration }) => intoLight('into-sun', hardpoint, duration)
  },
  {
    name: 'into-celestial',
    description: 'across the battle toward a celestial or a scene object behind it, turning slowly and closing the lens',
    subject: 'engagement',
    options: ['celestial', 'object', 'teams'],
    duration: 16,
    example: { shot: 'into-celestial', celestial: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
    build: ({ hardpoint, duration }) => intoLight('into-celestial', hardpoint, duration)
  },
  {
    name: 'battle-fly-through',
    description: 'a low pass through the heat of the battle, across the axis between the fleets from port to starboard, zooming in then out',
    subject: 'engagement',
    options: ['teams'],
    duration: 18,
    example: { shot: 'battle-fly-through' },
    build: ({ hardpoint, duration }) => {
      const half = (duration ?? 18) / 2;
      return {
        hardpoint: { name: 'overlook', ...hardpoint },
        ...timed(duration),
        transition: blend(1.5),
        moves: [
          {
            type: 'path',
            frame: 'subject',
            units: 'radii',
            look: 'subject',
            easing: EASE,
            points: [
              [-0.3, -1.4, 0.3],
              [-0.12, -0.55, 0.1],
              [0.05, 0.3, 0.04],
              [0.2, 0.85, 0.08],
              [0.35, 1.45, 0.25]
            ]
          },
          { type: 'zoom', fov: 30, duration: half, easing: EASE },
          { type: 'zoom', fov: 55, at: half, duration: half, easing: EASE }
        ],
        lag: { eye: 0.15, look: 0.6 }
      };
    }
  },
  {
    name: 'warp-in',
    description: 'waits at the landing of a fleet, wing, squad or ship in warp, looking back up the lane as it streaks in and settles (cuts there: a blend would swing across the lane)',
    subject: 'group',
    options: ['fleet', 'wing', 'squad', 'ships', 'ship', 'side'],
    example: { shot: 'warp-in', fleet: 'tfis' },
    build: ({ hardpoint, side, duration }) => ({
      hardpoint: { name: 'warp-landing', ...(side ? { side } : {}), ...hardpoint },
      ...timed(duration),
      transition: { type: 'cut' },
      lag: { look: 0.3 }
    })
  },
  {
    name: 'establishing',
    description: "a landmark (a station, structure or celestial) with the scene's ships in front of it, easing in",
    subject: 'landmark',
    options: ['object', 'celestial', 'teams', 'side'],
    duration: 14,
    example: { shot: 'establishing', celestial: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
    build: ({ hardpoint, side, duration }) => ({
      hardpoint: { name: 'establishing', ...(side ? { side } : {}), ...hardpoint },
      ...timed(duration),
      transition: blend(2),
      moves: [{ type: 'push', factor: 0.85, easing: EASE }],
      lag: { look: 0.4 }
    })
  },
  {
    name: 'chase',
    description: 'behind and a little above the ship, looking past it along its heading, trailing its turns',
    subject: 'ship',
    options: ['ship'],
    example: { shot: 'chase', ship: 'tfis-fc' },
    build: ({ hardpoint, duration }) => ({ hardpoint: { name: 'chase', ...hardpoint }, ...timed(duration), transition: blend(1.5), lag: { eye: 0.35, look: 0.15 } })
  },
  {
    name: 'hero',
    description: 'the front three-quarter on a long lens (`side`, default port), swinging toward the beam and easing in',
    subject: 'ship',
    options: ['ship', 'side'],
    duration: 10,
    example: { shot: 'hero', ship: 'tfis-fc' },
    build: ({ hardpoint, side, duration }) => ({
      hardpoint: { name: side === 'starboard' ? 'hero-starboard' : 'hero-port', ...hardpoint },
      ...timed(duration),
      transition: blend(1.5),
      moves: [
        { type: 'orbit', axis: 'subject-up', angle: side === 'starboard' ? -25 : 25, easing: EASE },
        { type: 'push', factor: 0.85, easing: EASE }
      ],
      lag: { look: 0.2 }
    })
  },
  {
    name: 'flyby',
    description: "a fixed point ahead on the ship's path, panning as it flies past",
    subject: 'ship',
    options: ['ship'],
    duration: 10,
    example: { shot: 'flyby', ship: 'tfis-fc' },
    build: ({ hardpoint, duration }) => ({ hardpoint: { name: 'flyby', ...hardpoint }, ...timed(duration), transition: { type: 'cut' }, lag: { look: 0.15 } })
  },
  {
    name: 'over-the-shoulder',
    description: 'behind and to starboard of the ship, looking at its target (`target`; default the nearest enemy)',
    subject: 'ship',
    options: ['ship', 'target'],
    example: { shot: 'over-the-shoulder', ship: 'tfis-fc' },
    build: ({ hardpoint, duration }) => ({ hardpoint: { name: 'over-the-shoulder', ...hardpoint }, ...timed(duration), transition: blend(1.5), lag: { look: 0.4 } })
  }
];

function intoLight(name: string, hardpoint: JsonObject, duration: Maybe<number>): JsonObject {
  return {
    hardpoint: { name, ...hardpoint },
    ...timed(duration),
    transition: blend(2),
    moves: [
      { type: 'orbit', axis: 'up', angle: 12, easing: EASE },
      { type: 'zoom', fov: 42, easing: EASE }
    ],
    lag: { look: 0.4 }
  };
}

export const CAMERA_SHOT_NAMES = CAMERA_SHOT_LIBRARY.map((entry) => entry.name);

/**
 * The subject keys a library reference may carry; each entry reads those in its options.
 */
const LIBRARY_SUBJECT_KEYS = ['ship', 'fleet', 'wing', 'squad', 'ships', 'teams', 'object', 'celestial', 'target'] as const;
const LIBRARY_HARDPOINT_OPTIONS = ['fov', 'fill', 'bank'] as const;
const LIBRARY_REPLACED_KEYS = ['end', 'transition', 'lag', 'letterbox', 'hud', 'clearance', 'name'] as const;
const LIBRARY_KEYS = new Set<string>(['shot', 'side', 'duration', 'moves', ...LIBRARY_SUBJECT_KEYS, ...LIBRARY_HARDPOINT_OPTIONS, ...LIBRARY_REPLACED_KEYS]);

/**
 * Expands a library reference into the explicit shot it names.
 *
 * @param input - `{ shot: "<name>", ...subject, ...options, ...overrides }`.
 * @param where - Where it sits, for messages.
 * @param problems - Receives every problem.
 * @param warnings - Receives one warning per unknown or unused key.
 * @returns The explicit shot JSON (with `library`), or null when the reference is invalid.
 */
export function expandLibraryShot(input: JsonObject, where: string, problems: string[], warnings: string[]): Maybe<JsonObject> {
  const before = problems.length;
  const name = input['shot'];
  const entry = typeof name === 'string' ? CAMERA_SHOT_LIBRARY.find((candidate) => candidate.name === name.trim()) : null;
  if (!entry) {
    problems.push(`${where}.shot must be a library shot: ${CAMERA_SHOT_NAMES.join(', ')} (list_shots)`);
    return null;
  }
  reportUnknownKeys(input, LIBRARY_KEYS, where, warnings);
  const hardpoint: JsonObject = {};
  for (const key of [...LIBRARY_SUBJECT_KEYS, ...LIBRARY_HARDPOINT_OPTIONS]) {
    if (input[key] == null) continue;
    if ((LIBRARY_SUBJECT_KEYS as readonly string[]).includes(key) && !entry.options.includes(key)) {
      warnings.push(`${where}.${key} is not used by the ${entry.name} shot (it reads ${entry.options.join(', ')})`);
      continue;
    }
    hardpoint[key] = input[key];
  }
  const has = (key: string): boolean => hardpoint[key] != null;
  if (entry.subject === 'ship' && !has('ship')) problems.push(`${where}: the ${entry.name} shot needs ship (the ship to frame)`);
  else if (entry.subject === 'group' && !has('fleet') && !has('ships') && !has('ship')) problems.push(`${where}: the ${entry.name} shot needs fleet (+ wing | squad), ships or ship`);
  else if (entry.subject === 'landmark' && !has('object') && !has('celestial')) problems.push(`${where}: the ${entry.name} shot needs object (a scene object id) or celestial (an id or a name from get_state.location)`);
  else if (entry.name === 'into-celestial' && !has('object') && !has('celestial')) problems.push(`${where}: the into-celestial shot needs celestial (an id or a name from get_state.location) or object (an object id)`);
  const side = input['side'];
  if (side != null && side !== 'port' && side !== 'starboard') problems.push(`${where}.side must be "port" or "starboard"`);
  const duration = input['duration'] ?? entry.duration;
  if (duration != null && !(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) problems.push(`${where}.duration must be a positive number of seconds`);
  if (problems.length > before) return null;
  const built: JsonObject = { ...entry.build({ hardpoint, ...(side === 'port' || side === 'starboard' ? { side } : {}), ...(typeof duration === 'number' ? { duration } : {}) }), end: 'hold', library: entry.name };
  for (const key of LIBRARY_REPLACED_KEYS) {
    if (input[key] !== undefined) built[key] = input[key];
  }
  const moves = input['moves'];
  if (moves != null) built['moves'] = Array.isArray(moves) && Array.isArray(built['moves']) ? [...built['moves'], ...moves] : moves;
  return built;
}
