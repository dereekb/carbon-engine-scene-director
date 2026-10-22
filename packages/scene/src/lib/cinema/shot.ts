/**
 * The camera shot spec: a hardpoint (or a free pose), the moves played on it, how it starts, its lag, and the frame's
 * presentation. A sequence is shots played back to back. The viewer's CinemaRig plays them on the scene clock; the
 * MCP tools and timeline cues send the same JSON.
 *
 *   { hardpoint: { name, ship | fleet [+ wing | squad] | ships | teams, target?, celestial?, fill?, fov?, bank?, side? }
 *       | pose: { eye, look, up?, roll?, fov? },
 *     moves?: [...], duration?: s, transition?: { type: "cut" } | { type: "blend", duration?, easing? },
 *     lag?: { eye?, look? }, letterbox?: aspect | false, hud?: boolean, name? }
 *
 * Moves, each with `at?` (seconds into the shot it starts), `duration?` and `easing?`:
 *   dolly { distance }, truck { distance }, crane { distance }, push { factor }, zoom { fov },
 *   orbit { axis?, rate? | angle? }, roll { rate? | angle? }, spin { axis, rate? | angle? },
 *   path { points, frame?, look?, up? }, track { lag }, shake { amplitude, frequency?, decay? }
 *
 * A path flies the eye through waypoints (waypoints/waypoints.ts): bare [x, y, z] in `frame` (world, or the subject's
 * [forward, starboard, up]), points in space, or points riding on any ship or object, so a fly-through can pass over
 * another ship's hull as it flies. It looks along the path, at the subject, or at a waypoint, with its up from the base
 * pose, the world, or a hull. The hulls its waypoints ride on are exempt from the eye's hull clearance; `clearance`
 * (a multiple of each bounding radius, or false) sets it for the whole shot.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, readVector, reportUnknownKeys, type JsonObject } from '../json';
import type { SceneVector } from '../scene';
import { readWaypoint, readWaypoints, waypointAnchorId, type Waypoint } from '../waypoints/waypoints';
import { ENGAGEMENT_HARDPOINT_NAMES, GROUP_HARDPOINT_NAMES, hardpointKind, SHIP_HARDPOINT_NAMES, type HardpointRef } from './hardpoints';

export const CINEMA_EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const;
export type CinemaEasing = (typeof CINEMA_EASINGS)[number];

export const CAMERA_MOVE_TYPES = ['dolly', 'truck', 'crane', 'push', 'zoom', 'orbit', 'roll', 'spin', 'path', 'track', 'shake'] as const;
export type CameraMoveType = (typeof CAMERA_MOVE_TYPES)[number];

/**
 * An axis a move turns about: world up, the subject's up, the view's up, or a world vector.
 */
export type CameraMoveAxis = 'up' | 'subject-up' | 'view-up' | SceneVector;

export const CAMERA_MOVE_AXES = ['up', 'subject-up', 'view-up'] as const;

/**
 * The default blend into a shot, seconds.
 */
export const DEFAULT_BLEND_SECONDS = 1.5;

/**
 * The widest field of view a shot takes, degrees.
 */
export const MAX_SHOT_FOV = 120;
export const MIN_SHOT_FOV = 5;

interface CameraMoveTiming {
  /**
   * Seconds into the shot the move starts; default 0.
   */
  readonly at?: number;
  /**
   * Seconds it runs; default the shot's duration (rate moves: until the shot ends).
   */
  readonly duration?: number;
  readonly easing?: CinemaEasing;
}

export type CameraMove = CameraMoveTiming &
  (
    | { readonly type: 'dolly' | 'truck' | 'crane'; readonly distance: number }
    | { readonly type: 'push'; readonly factor: number }
    | { readonly type: 'zoom'; readonly fov: number }
    | { readonly type: 'orbit'; readonly axis: CameraMoveAxis; readonly rate?: number; readonly angle?: number }
    | { readonly type: 'roll'; readonly rate?: number; readonly angle?: number }
    | { readonly type: 'spin'; readonly axis: CameraMoveAxis; readonly rate?: number; readonly angle?: number }
    | { readonly type: 'path'; readonly points: readonly Waypoint[]; readonly frame: 'world' | 'subject'; readonly look: 'path' | 'subject' | Waypoint; readonly up: CameraPathUp }
    | { readonly type: 'track'; readonly lag: number }
    | { readonly type: 'shake'; readonly amplitude: number; readonly frequency: number; readonly decay?: number }
  );

/**
 * A path's up: the base pose's, world up, or a hull's (banked, so a pan over a rolled hull keeps it level in frame).
 */
export type CameraPathUp = 'base' | 'world' | { readonly ship: string } | { readonly object: string };

export interface CameraPoseSpec {
  readonly eye: SceneVector;
  readonly look: SceneVector;
  readonly up?: SceneVector;
  /**
   * Degrees about the view direction, on top of `up`.
   */
  readonly roll?: number;
  readonly fov?: number;
}

export type CameraTransition = { readonly type: 'cut' } | { readonly type: 'blend'; readonly duration: number; readonly easing: CinemaEasing };

export interface CameraShot {
  readonly name?: string;
  readonly hardpoint?: HardpointRef;
  readonly pose?: CameraPoseSpec;
  readonly moves: readonly CameraMove[];
  /**
   * Seconds; omitted holds until stopped.
   */
  readonly duration?: number;
  readonly transition: CameraTransition;
  /**
   * Time constants, seconds, of the eye and the look point trailing the shot (0: locked on).
   */
  readonly lag: { readonly eye: number; readonly look: number };
  /**
   * The frame's aspect while the shot plays (bars outside it); false for none; omitted keeps the page's.
   */
  readonly letterbox?: number | false;
  /**
   * False hides the overlay while the shot plays; omitted keeps the page's.
   */
  readonly hud?: boolean;
  /**
   * How far out of each hull's bounding sphere the eye is kept, as a multiple of its radius (default HULL_CLEARANCE);
   * false lets it anywhere. A path's anchor hulls are exempt either way.
   */
  readonly clearance?: number | false;
}

export interface CameraSequence {
  readonly shots: readonly CameraShot[];
}

export interface NormalizedCameraShot {
  readonly shot: Maybe<CameraShot>;
  readonly problems: string[];
  readonly warnings: string[];
}

export interface NormalizedCameraSequence {
  readonly sequence: Maybe<CameraSequence>;
  readonly problems: string[];
  readonly warnings: string[];
}

const SHOT_KEYS = new Set(['name', 'hardpoint', 'pose', 'moves', 'duration', 'transition', 'lag', 'letterbox', 'hud', 'clearance']);
const HARDPOINT_KEYS = new Set(['name', 'ship', 'fleet', 'wing', 'squad', 'ships', 'teams', 'target', 'celestial', 'fill', 'fov', 'bank', 'side']);
const POSE_KEYS = new Set(['eye', 'look', 'up', 'roll', 'fov']);
const TIMING_KEYS = ['type', 'at', 'duration', 'easing'];
const MOVE_KEYS: Record<CameraMoveType, readonly string[]> = {
  dolly: ['distance'],
  truck: ['distance'],
  crane: ['distance'],
  push: ['factor'],
  zoom: ['fov'],
  orbit: ['axis', 'rate', 'angle'],
  roll: ['rate', 'angle'],
  spin: ['axis', 'rate', 'angle'],
  path: ['points', 'frame', 'look', 'up'],
  track: ['lag'],
  shake: ['amplitude', 'frequency', 'decay']
};

/**
 * Normalizes one shot: every problem found, unknown keys dropped with a warning, defaults filled (a cut, no lag).
 *
 * @param input - The shot JSON.
 * @param where - Where it sits, for messages.
 */
export function normalizeCameraShot(input: unknown, where = 'shot'): NormalizedCameraShot {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(input)) return { shot: null, problems: [`${where} must be an object`], warnings };
  reportUnknownKeys(input, SHOT_KEYS, where, warnings);
  const { hardpoint, pose, moves, duration, transition, lag, letterbox, hud, name, clearance } = input;
  if ((hardpoint == null) === (pose == null)) problems.push(`${where} needs exactly one of hardpoint (a generated camera position) and pose (eye and look)`);
  const shot: { -readonly [K in keyof CameraShot]: CameraShot[K] } = { moves: [], transition: { type: 'cut' }, lag: { eye: 0, look: 0 } };
  if (name != null) {
    if (typeof name === 'string' && name.trim()) shot.name = name.trim();
    else problems.push(`${where}.name must be a non-empty string`);
  }
  const ref = hardpoint == null ? null : readHardpoint(hardpoint, `${where}.hardpoint`, problems, warnings);
  if (ref) shot.hardpoint = ref;
  const free = pose == null ? null : readPose(pose, `${where}.pose`, problems, warnings);
  if (free) shot.pose = free;
  if (duration != null) shot.duration = readPositive(duration, `${where}.duration`, problems);
  if (moves != null) {
    if (Array.isArray(moves)) shot.moves = moves.flatMap((move, index) => readMove(move, `${where}.moves[${index}]`, problems, warnings) ?? []);
    else problems.push(`${where}.moves must be an array`);
  }
  if (transition != null) shot.transition = readTransition(transition, `${where}.transition`, problems, warnings);
  if (lag != null) {
    if (isPlainObject(lag)) {
      reportUnknownKeys(lag, new Set(['eye', 'look']), `${where}.lag`, warnings);
      shot.lag = { eye: lag['eye'] == null ? 0 : readNonNegative(lag['eye'], `${where}.lag.eye`, problems), look: lag['look'] == null ? 0 : readNonNegative(lag['look'], `${where}.lag.look`, problems) };
    } else problems.push(`${where}.lag must be { eye?, look? } (seconds)`);
  }
  if (letterbox != null) {
    if (letterbox === false) shot.letterbox = false;
    else if (typeof letterbox === 'number' && Number.isFinite(letterbox) && letterbox >= 0.5 && letterbox <= 4) shot.letterbox = letterbox;
    else problems.push(`${where}.letterbox must be an aspect in [0.5, 4] (2.39 for scope) or false`);
  }
  if (hud != null) {
    if (typeof hud === 'boolean') shot.hud = hud;
    else problems.push(`${where}.hud must be true or false`);
  }
  if (clearance != null) {
    if (clearance === false) shot.clearance = false;
    else shot.clearance = readRange(clearance, `${where}.clearance`, problems, 0, 10);
  }
  for (const move of shot.moves) {
    if (move.type === 'path' && move.duration == null && shot.duration == null) problems.push(`${where}: a path move needs a duration (its own or the shot's)`);
  }
  return { shot: problems.length ? null : shot, problems, warnings };
}

/**
 * Normalizes a sequence: `{ shots: [...] }` or a bare array of shots. Every shot but the last needs a duration.
 */
export function normalizeCameraSequence(input: unknown, where = 'sequence'): NormalizedCameraSequence {
  const problems: string[] = [];
  const warnings: string[] = [];
  let list: unknown = input;
  if (isPlainObject(input)) {
    reportUnknownKeys(input, new Set(['shots']), where, warnings);
    list = input['shots'];
  }
  const shots: CameraShot[] = [];
  if (!Array.isArray(list) || !list.length) problems.push(`${where} must be a non-empty array of shots, or { shots: [...] }`);
  else {
    list.forEach((entry, index) => {
      const result = normalizeCameraShot(entry, `${where}.shots[${index}]`);
      problems.push(...result.problems);
      warnings.push(...result.warnings);
      if (result.shot) {
        if (result.shot.duration == null && index < list.length - 1) problems.push(`${where}.shots[${index}] needs a duration: only the last shot may hold`);
        shots.push(result.shot);
      }
    });
  }
  return { sequence: problems.length ? null : { shots }, problems, warnings };
}

function readHardpoint(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<HardpointRef> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object: { name, ship | fleet | ships | teams, ... }`);
    return null;
  }
  reportUnknownKeys(input, HARDPOINT_KEYS, where, warnings);
  const before = problems.length;
  const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
  const ref: { -readonly [K in keyof HardpointRef]: HardpointRef[K] } = { name };
  for (const key of ['ship', 'fleet', 'wing', 'squad', 'target'] as const) {
    const value = input[key];
    if (value == null) continue;
    if (typeof value === 'string' && value.trim()) ref[key] = value.trim();
    else problems.push(`${where}.${key} must be an id`);
  }
  if (input['ships'] != null) {
    const ships = input['ships'];
    if (Array.isArray(ships) && ships.length && ships.every((id) => typeof id === 'string' && id.trim())) ref.ships = ships.map((id) => (id as string).trim());
    else problems.push(`${where}.ships must be a non-empty array of ship ids`);
  }
  if (input['teams'] != null) {
    const teams = input['teams'];
    if (Array.isArray(teams) && teams.length === 2 && teams.every((team) => typeof team === 'string' && team.trim())) ref.teams = [(teams[0] as string).trim(), (teams[1] as string).trim()];
    else problems.push(`${where}.teams must be two team names`);
  }
  const celestial = input['celestial'];
  if (celestial != null) {
    if ((typeof celestial === 'string' && celestial.trim()) || (typeof celestial === 'number' && Number.isInteger(celestial))) ref.celestial = typeof celestial === 'string' ? celestial.trim() : celestial;
    else problems.push(`${where}.celestial must be a celestial id or name`);
  }
  if (input['fill'] != null) ref.fill = readRange(input['fill'], `${where}.fill`, problems, 0.05, 1.5);
  if (input['fov'] != null) ref.fov = readRange(input['fov'], `${where}.fov`, problems, MIN_SHOT_FOV, MAX_SHOT_FOV);
  if (input['bank'] != null) {
    if (typeof input['bank'] === 'boolean') ref.bank = input['bank'];
    else problems.push(`${where}.bank must be true or false`);
  }
  if (input['side'] != null) {
    if (input['side'] === 'port' || input['side'] === 'starboard') ref.side = input['side'];
    else problems.push(`${where}.side must be "port" or "starboard"`);
  }
  const kind = hardpointKind(ref);
  const names = kind === 'engagement' ? ENGAGEMENT_HARDPOINT_NAMES : kind === 'group' ? GROUP_HARDPOINT_NAMES : SHIP_HARDPOINT_NAMES;
  if (!name) problems.push(`${where}.name must be a hardpoint name`);
  else if (!names.includes(name)) {
    const others = kind === 'ship' ? '; group hardpoints (' + GROUP_HARDPOINT_NAMES.join(', ') + ') take fleet or ships, engagement ones (' + ENGAGEMENT_HARDPOINT_NAMES.join(', ') + ') teams' : '';
    problems.push(`${where}.name "${name}" is not a ${kind} hardpoint (${names.join(', ')})${others}`);
  }
  if (kind === 'ship' && ref.ship == null && name) problems.push(`${where} needs ship (the ship to frame)`);
  if ((ref.wing != null || ref.squad != null) && ref.fleet == null) problems.push(`${where}: wing and squad select within a fleet; give fleet too`);
  if (ref.wing != null && ref.squad != null) problems.push(`${where}: give wing or squad, not both`);
  if (ref.fleet != null && ref.ships != null) problems.push(`${where}: give fleet or ships, not both`);
  if (name === 'into-celestial' && ref.celestial == null) problems.push(`${where}: into-celestial needs celestial (an id or a name from get_state.location)`);
  return problems.length > before ? null : ref;
}

function readPose(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<CameraPoseSpec> {
  if (!isPlainObject(input)) {
    problems.push(`${where} must be { eye, look, up?, roll?, fov? }`);
    return null;
  }
  reportUnknownKeys(input, POSE_KEYS, where, warnings);
  const before = problems.length;
  const eye = readVector(input['eye'], `${where}.eye`, problems);
  const look = readVector(input['look'], `${where}.look`, problems);
  const pose: { -readonly [K in keyof CameraPoseSpec]: CameraPoseSpec[K] } = { eye, look };
  if (input['up'] != null) pose.up = readVector(input['up'], `${where}.up`, problems);
  if (input['roll'] != null) pose.roll = readRange(input['roll'], `${where}.roll`, problems, -360, 360);
  if (input['fov'] != null) pose.fov = readRange(input['fov'], `${where}.fov`, problems, MIN_SHOT_FOV, MAX_SHOT_FOV);
  if (problems.length === before && eye.every((value, axis) => value === look[axis])) problems.push(`${where}: eye and look must differ`);
  return problems.length > before ? null : pose;
}

function readTransition(input: unknown, where: string, problems: string[], warnings: string[]): CameraTransition {
  let transition: CameraTransition = { type: 'cut' };
  if (input === 'cut' || input === 'blend') input = { type: input };
  if (!isPlainObject(input) || (input['type'] !== 'cut' && input['type'] !== 'blend')) {
    problems.push(`${where} must be { type: "cut" } or { type: "blend", duration?, easing? }`);
  } else if (input['type'] === 'blend') {
    reportUnknownKeys(input, new Set(['type', 'duration', 'easing']), where, warnings);
    transition = { type: 'blend', duration: input['duration'] == null ? DEFAULT_BLEND_SECONDS : readPositive(input['duration'], `${where}.duration`, problems), easing: readEasing(input['easing'], `${where}.easing`, problems) ?? 'ease-in-out' };
  } else {
    reportUnknownKeys(input, new Set(['type']), where, warnings);
  }
  return transition;
}

function readMove(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<CameraMove> {
  if (!isPlainObject(input) || !CAMERA_MOVE_TYPES.includes(input['type'] as CameraMoveType)) {
    problems.push(`${where}.type must be one of ${CAMERA_MOVE_TYPES.join(', ')}`);
    return null;
  }
  const type = input['type'] as CameraMoveType;
  reportUnknownKeys(input, new Set([...TIMING_KEYS, ...MOVE_KEYS[type]]), where, warnings);
  const before = problems.length;
  const timing: { at?: number; duration?: number; easing?: CinemaEasing } = {};
  if (input['at'] != null) timing.at = readNonNegative(input['at'], `${where}.at`, problems);
  if (input['duration'] != null) timing.duration = readPositive(input['duration'], `${where}.duration`, problems);
  const easing = readEasing(input['easing'], `${where}.easing`, problems);
  if (easing) timing.easing = easing;
  let move: Maybe<CameraMove> = null;
  switch (type) {
    case 'dolly':
    case 'truck':
    case 'crane':
      move = { ...timing, type, distance: readFinite(input['distance'], `${where}.distance`, problems) };
      break;
    case 'push':
      move = { ...timing, type, factor: readRange(input['factor'], `${where}.factor`, problems, 0.01, 100) };
      break;
    case 'zoom':
      move = { ...timing, type, fov: readRange(input['fov'], `${where}.fov`, problems, MIN_SHOT_FOV, MAX_SHOT_FOV) };
      break;
    case 'orbit':
    case 'spin': {
      const axis = readAxis(input['axis'], `${where}.axis`, problems, type === 'orbit' ? 'subject-up' : null);
      move = { ...timing, type, axis: axis ?? 'up', ...readTurn(input, where, problems) };
      break;
    }
    case 'roll':
      move = { ...timing, type, ...readTurn(input, where, problems) };
      break;
    case 'path':
      move = readPath(input, where, problems, warnings, timing);
      break;
    case 'track':
      move = { ...timing, type, lag: readNonNegative(input['lag'], `${where}.lag`, problems) };
      break;
    case 'shake':
      move = {
        ...timing,
        type,
        amplitude: readRange(input['amplitude'], `${where}.amplitude`, problems, 0, 30),
        frequency: input['frequency'] == null ? 8 : readRange(input['frequency'], `${where}.frequency`, problems, 0.1, 60),
        ...(input['decay'] == null ? {} : { decay: readPositive(input['decay'], `${where}.decay`, problems) })
      };
      break;
  }
  return problems.length > before ? null : move;
}

function readTurn(input: JsonObject, where: string, problems: string[]): { rate?: number; angle?: number } {
  const { rate, angle } = input;
  if ((rate == null) === (angle == null)) problems.push(`${where} needs exactly one of rate (degrees per second) and angle (degrees over its duration)`);
  return rate == null ? (angle == null ? {} : { angle: readFinite(angle, `${where}.angle`, problems) }) : { rate: readFinite(rate, `${where}.rate`, problems) };
}

function readPath(input: JsonObject, where: string, problems: string[], warnings: string[], timing: CameraMoveTiming): Maybe<CameraMove> {
  const points = readWaypoints(input['points'], `${where}.points`, problems, warnings);
  const frame = input['frame'] ?? 'world';
  if (frame !== 'world' && frame !== 'subject') problems.push(`${where}.frame must be "world" or "subject" ([forward, starboard, up] metres off the subject)`);
  let look: 'path' | 'subject' | Waypoint = 'subject';
  const lookInput = input['look'];
  if (lookInput === 'path' || lookInput === 'subject') look = lookInput;
  else if (lookInput != null) look = readWaypoint(lookInput, `${where}.look`, problems, warnings) ?? 'subject';
  let up: CameraPathUp = 'base';
  const upInput = input['up'];
  if (upInput === 'base' || upInput === 'world') up = upInput;
  else if (isPlainObject(upInput) && typeof upInput['ship'] === 'string' && upInput['ship'].trim()) up = { ship: upInput['ship'].trim() };
  else if (isPlainObject(upInput) && typeof upInput['object'] === 'string' && upInput['object'].trim()) up = { object: upInput['object'].trim() };
  else if (upInput != null) problems.push(`${where}.up must be "base", "world", { ship } or { object }`);
  return { ...timing, type: 'path', points, frame: frame === 'subject' ? 'subject' : 'world', look, up };
}

function readAxis(input: unknown, where: string, problems: string[], fallback: Maybe<CameraMoveAxis>): Maybe<CameraMoveAxis> {
  let axis: Maybe<CameraMoveAxis> = fallback;
  if (input == null) {
    if (fallback == null) problems.push(`${where} is required: ${CAMERA_MOVE_AXES.join(', ')} or [x, y, z]`);
  } else if (typeof input === 'string') {
    if ((CAMERA_MOVE_AXES as readonly string[]).includes(input)) axis = input as CameraMoveAxis;
    else problems.push(`${where} must be one of ${CAMERA_MOVE_AXES.join(', ')} or [x, y, z]`);
  } else {
    const vector = readVector(input, where, problems);
    if (vector.every((value) => value === 0)) problems.push(`${where} must not be zero`);
    axis = vector;
  }
  return axis;
}

function readEasing(input: unknown, where: string, problems: string[]): Maybe<CinemaEasing> {
  if (input == null) return null;
  if (CINEMA_EASINGS.includes(input as CinemaEasing)) return input as CinemaEasing;
  problems.push(`${where} must be one of ${CINEMA_EASINGS.join(', ')}`);
  return null;
}

function readFinite(input: unknown, where: string, problems: string[]): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  problems.push(`${where} must be a finite number`);
  return 0;
}

function readRange(input: unknown, where: string, problems: string[], min: number, max: number): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= min && input <= max) return input;
  problems.push(`${where} must be a number in [${min}, ${max}]`);
  return min;
}

function readPositive(input: unknown, where: string, problems: string[]): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input;
  problems.push(`${where} must be a positive number of seconds`);
  return 1;
}

function readNonNegative(input: unknown, where: string, problems: string[]): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return input;
  problems.push(`${where} must be a number ≥ 0`);
  return 0;
}

/**
 * The ship and object ids a shot depends on: its hardpoint's ship and target, then the hulls its paths ride on, look at
 * or take their up from. Removing one ends the shot.
 */
export function cameraShotSubjects(shot: Maybe<CameraShot>): string[] {
  const ref = shot?.hardpoint;
  const ids = ref ? [ref.ship, ref.target] : [];
  ids.push(...cameraPathAnchors(shot));
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

/**
 * The hulls a shot's paths ride on, look at or take their up from: exempt from its hull clearance.
 */
export function cameraPathAnchors(shot: Maybe<CameraShot>): string[] {
  const ids: string[] = [];
  for (const move of shot?.moves ?? []) {
    if (move.type !== 'path') continue;
    for (const point of move.points) ids.push(waypointAnchorId(point) ?? '');
    if (typeof move.look !== 'string') ids.push(waypointAnchorId(move.look) ?? '');
    if (typeof move.up !== 'string') ids.push('ship' in move.up ? move.up.ship : move.up.object);
  }
  return [...new Set(ids.filter(Boolean))];
}
