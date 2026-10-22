/**
 * Camera hardpoints, generated from the live scene and never stored: each is a pure function of the drawn positions,
 * headings, hull radii, fleet membership and teams, re-evaluated every frame.
 *
 * - Ship hardpoints scale by the hull's SOF bounding radius and stand in the ship's level frame (or its banked one).
 * - Group hardpoints (a fleet, wing or squad, or a list of ships) scale by the formation's extent, in the leader's
 *   level frame.
 * - Engagement hardpoints stand on the axis between two teams.
 *
 * The flyby is anchored: its eye is placed once, when the shot starts, and holds while the ship flies past.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import { fitDistance, viewHalfExtents } from './framing';
import type { CameraPose } from './pose';
import { aheadOf, engagementFrame, groupFrame, nearestEnemyCentroid, nearestOtherShip, selectCinemaGroup, shipFrame, type CinemaScene, type CinemaShip, type SubjectFrame } from './subjects';
import { addScaledVec, crossVec, dotVec, lengthVec, normalizeVec, orthogonalizeVec, subVec, WORLD_UP } from './vectors';

export type HardpointKind = 'ship' | 'group' | 'engagement';

/**
 * A ship hardpoint as data: the eye's direction from the hull in the ship's frame, how much of the frame the hull
 * fills, and the lens.
 */
export interface ShipHardpointRow {
  readonly name: string;
  /**
   * [forward, starboard, up] from the hull's centre to the eye (any length).
   */
  readonly direction: readonly [number, number, number];
  /**
   * The share of the view's smaller half extent the hull spans.
   */
  readonly fill: number;
  /**
   * Degrees.
   */
  readonly fov: number;
  /**
   * The camera's up: the frame's up, or the ship's forward (looking straight down or up at it).
   */
  readonly up: 'frame' | 'forward';
  /**
   * Where the camera looks, in hull radii off the centre along [forward, starboard, up].
   */
  readonly look?: readonly [number, number, number];
  /**
   * Hardpoints computed by hand rather than from the row.
   */
  readonly special?: 'over-the-shoulder' | 'flyby';
  /**
   * The eye is placed when the shot starts and holds.
   */
  readonly anchored?: boolean;
  readonly description: string;
}

export const SHIP_HARDPOINTS: readonly ShipHardpointRow[] = [
  { name: 'chase', direction: [-1, 0, 0.2], fill: 0.4, fov: 50, up: 'frame', look: [0.8, 0, 0], description: 'behind and a little above, looking past the hull along its heading' },
  { name: 'rear-quarter-port-high', direction: [-1, -1, 0.55], fill: 0.55, fov: 45, up: 'frame', description: 'behind the port quarter, above' },
  { name: 'rear-quarter-port-low', direction: [-1, -1, -0.4], fill: 0.55, fov: 45, up: 'frame', description: 'behind the port quarter, below' },
  { name: 'rear-quarter-starboard-high', direction: [-1, 1, 0.55], fill: 0.55, fov: 45, up: 'frame', description: 'behind the starboard quarter, above' },
  { name: 'rear-quarter-starboard-low', direction: [-1, 1, -0.4], fill: 0.55, fov: 45, up: 'frame', description: 'behind the starboard quarter, below' },
  { name: 'hero-port', direction: [1, -0.8, 0.2], fill: 0.6, fov: 30, up: 'frame', description: 'front three-quarter off the port bow, on a longer lens' },
  { name: 'hero-starboard', direction: [1, 0.8, 0.2], fill: 0.6, fov: 30, up: 'frame', description: 'front three-quarter off the starboard bow, on a longer lens' },
  { name: 'bow-on', direction: [1, 0, 0.06], fill: 0.55, fov: 40, up: 'frame', description: 'dead ahead, the hull flying at the lens' },
  { name: 'broadside-port', direction: [0, -1, 0.1], fill: 0.8, fov: 40, up: 'frame', description: 'square off the port side, the hull in profile' },
  { name: 'broadside-starboard', direction: [0, 1, 0.1], fill: 0.8, fov: 40, up: 'frame', description: 'square off the starboard side, the hull in profile' },
  { name: 'belly', direction: [-0.2, 0, -1], fill: 0.6, fov: 45, up: 'forward', description: 'under the hull looking up, the bow at the top of the frame' },
  { name: 'top-down', direction: [0, 0, 1], fill: 0.6, fov: 45, up: 'forward', description: 'straight down on the hull, the bow at the top of the frame' },
  {
    name: 'over-the-shoulder',
    direction: [-1, 0.4, 0.25],
    fill: 0.5,
    fov: 45,
    up: 'frame',
    special: 'over-the-shoulder',
    description: 'behind and to starboard of the hull, looking at its target (the `target` ship; default the nearest enemy)'
  },
  { name: 'flyby', direction: [1, 0.4, 0.13], fill: 0.5, fov: 40, up: 'frame', special: 'flyby', anchored: true, description: "a fixed point ahead on the ship's path, panning as it flies past" }
];

export interface GroupHardpointRow {
  readonly name: string;
  readonly fill: number;
  readonly fov: number;
  readonly description: string;
}

export const GROUP_HARDPOINTS: readonly GroupHardpointRow[] = [
  { name: 'behind-fc', fill: 0.85, fov: 55, description: "behind the group's rear and above, looking past its leader at the nearest enemy (else ahead)" },
  { name: 'flank-port', fill: 0.85, fov: 40, description: 'off the port flank, the formation in profile' },
  { name: 'flank-starboard', fill: 0.85, fov: 40, description: 'off the starboard flank, the formation in profile' },
  { name: 'top-down', fill: 0.85, fov: 45, description: "straight down on the formation, the leader's heading at the top of the frame" },
  { name: 'leading-edge', fill: 0.85, fov: 50, description: 'ahead of the formation, looking back at it' }
];

export interface EngagementHardpointRow {
  readonly name: string;
  readonly fill: number;
  readonly fov: number;
  readonly description: string;
}

export const ENGAGEMENT_HARDPOINTS: readonly EngagementHardpointRow[] = [
  { name: 'overlook', fill: 0.9, fov: 50, description: 'high and wide over the centroid, off one side of the axis between the teams, every ship in frame' },
  { name: 'into-sun', fill: 0.75, fov: 55, description: 'across the battle into the sun' },
  { name: 'into-celestial', fill: 0.75, fov: 55, description: 'across the battle toward a celestial (`celestial`: an id or a name from the location)' }
];

export const SHIP_HARDPOINT_NAMES = SHIP_HARDPOINTS.map((row) => row.name);
export const GROUP_HARDPOINT_NAMES = GROUP_HARDPOINTS.map((row) => row.name);
export const ENGAGEMENT_HARDPOINT_NAMES = ENGAGEMENT_HARDPOINTS.map((row) => row.name);

/**
 * Which hardpoint, on which subject.
 */
export interface HardpointRef {
  readonly name: string;
  /**
   * A ship subject.
   */
  readonly ship?: string;
  /**
   * A group subject: a fleet, narrowed by wing or squad, or a list of ships.
   */
  readonly fleet?: string;
  readonly wing?: string;
  readonly squad?: string;
  readonly ships?: readonly string[];
  /**
   * An engagement's two teams; default the two with the most ships.
   */
  readonly teams?: readonly [string, string];
  /**
   * Over-the-shoulder's target ship.
   */
  readonly target?: string;
  /**
   * Into-celestial's celestial: an id or a name.
   */
  readonly celestial?: string | number;
  /**
   * Overrides the row's fill.
   */
  readonly fill?: number;
  /**
   * Overrides the row's fov, degrees.
   */
  readonly fov?: number;
  /**
   * Stand in the hull's banked frame rather than its level one.
   */
  readonly bank?: boolean;
  /**
   * Which side of the axis the overlook takes.
   */
  readonly side?: 'port' | 'starboard';
}

/**
 * Which kind of subject a hardpoint reference names: an engagement name, else a group when it selects a fleet or ships,
 * else a ship.
 */
export function hardpointKind(ref: Pick<HardpointRef, 'name' | 'fleet' | 'ships'>): HardpointKind {
  let kind: HardpointKind = 'ship';
  if (ENGAGEMENT_HARDPOINT_NAMES.includes(ref.name)) kind = 'engagement';
  else if (ref.fleet != null || ref.ships != null) kind = 'group';
  return kind;
}

export interface ResolvedHardpoint {
  readonly pose: Maybe<CameraPose>;
  /**
   * The frame the hardpoint stood in.
   */
  readonly subject: Maybe<SubjectFrame>;
  /**
   * The anchored eye (flyby): pass it back on later frames.
   */
  readonly anchor?: SceneVector;
  /**
   * Why there is no pose, or what was substituted.
   */
  readonly note?: string;
}

/**
 * Resolves a hardpoint on the scene as drawn.
 *
 * @param ref - The hardpoint and its subject.
 * @param scene - The drawn scene.
 * @param anchor - An anchored hardpoint's eye from its first frame.
 * @returns The pose, or none with a note (an unknown name, a subject not in the scene).
 */
export function resolveHardpoint(ref: HardpointRef, scene: CinemaScene, anchor?: Maybe<SceneVector>): ResolvedHardpoint {
  const kind = hardpointKind(ref);
  let resolved: ResolvedHardpoint;
  if (kind === 'engagement') resolved = resolveEngagementHardpoint(ref, scene);
  else if (kind === 'group') resolved = resolveGroupHardpoint(ref, scene);
  else resolved = resolveShipHardpoint(ref, scene, anchor);
  return resolved;
}

function resolveShipHardpoint(ref: HardpointRef, scene: CinemaScene, anchor: Maybe<SceneVector>): ResolvedHardpoint {
  const row = SHIP_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  const ship = ref.ship == null ? null : scene.ships.find((candidate) => candidate.id === ref.ship);
  if (!row) return { pose: null, subject: null, note: `no ship hardpoint "${ref.name}" (${SHIP_HARDPOINT_NAMES.join(', ')})` };
  if (!ship) return { pose: null, subject: null, note: ref.ship == null ? `hardpoint "${ref.name}" needs a ship` : `no ship "${ref.ship}" in the scene` };
  const frame = shipFrame(ship, ref.bank === true);
  const fov = ref.fov ?? row.fov;
  const fill = ref.fill ?? row.fill;
  let resolved: ResolvedHardpoint;
  if (row.special === 'over-the-shoulder') resolved = overTheShoulder(ref, scene, ship, frame, fov);
  else if (row.special === 'flyby') resolved = flyby(frame, fov, anchor);
  else {
    const distance = fitDistance(frame.radius, fov, scene.aspect, fill);
    const eye = addScaledVec(frame.centre, inFrame(frame, row.direction), distance);
    const look = row.look ? addScaledVec(frame.centre, inFrame(frame, row.look, false), frame.radius) : frame.centre;
    resolved = { pose: { eye, look, up: row.up === 'forward' ? frame.forward : frame.up, fov }, subject: frame };
  }
  return resolved;
}

function overTheShoulder(ref: HardpointRef, scene: CinemaScene, ship: CinemaShip, frame: SubjectFrame, fov: number): ResolvedHardpoint {
  const named = ref.target == null ? null : scene.ships.find((candidate) => candidate.id === ref.target);
  const target = named ?? (ref.target == null ? nearestOtherShip(scene, ship) : null);
  let resolved: ResolvedHardpoint;
  if (!target) {
    resolved = { pose: null, subject: frame, note: ref.target == null ? 'over-the-shoulder needs another ship to look at' : `no target ship "${ref.target}" in the scene` };
  } else {
    const toTarget = normalizeVec(subVec(target.frameCentre, frame.centre)) ?? frame.forward;
    const side = normalizeVec(crossVec(toTarget, frame.up)) ?? frame.starboard;
    const up = orthogonalizeVec(frame.up, toTarget) ?? frame.up;
    const r = frame.radius;
    let eye = addScaledVec(frame.centre, toTarget, -2.4 * r);
    eye = addScaledVec(eye, side, 1.0 * r);
    eye = addScaledVec(eye, up, 0.6 * r);
    resolved = { pose: { eye, look: [...target.frameCentre], up, fov }, subject: frame, ...(ref.target == null ? { note: `looking at ${target.id}` } : {}) };
  }
  return resolved;
}

/**
 * Seconds of flight ahead a flyby's eye waits at, at the ship's drawn speed.
 */
export const FLYBY_LEAD_SECONDS = 4;

function flyby(frame: SubjectFrame, fov: number, anchor: Maybe<SceneVector>): ResolvedHardpoint {
  let eye = anchor;
  if (!eye) {
    const speed = lengthVec(frame.velocity);
    const direction = speed > 1 ? (normalizeVec(frame.velocity) ?? frame.forward) : frame.forward;
    const r = frame.radius;
    eye = addScaledVec(frame.centre, direction, Math.max(6 * r, speed * FLYBY_LEAD_SECONDS));
    eye = addScaledVec(eye, frame.starboard, 2.5 * r);
    eye = addScaledVec(eye, frame.up, 0.8 * r);
  }
  return { pose: { eye: [...eye], look: frame.centre, up: [...WORLD_UP], fov }, subject: frame, anchor: [...eye] };
}

function resolveGroupHardpoint(ref: HardpointRef, scene: CinemaScene): ResolvedHardpoint {
  const row = GROUP_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  if (!row) return { pose: null, subject: null, note: `no group hardpoint "${ref.name}" (${GROUP_HARDPOINT_NAMES.join(', ')})` };
  const selection = ref.ships ? { ships: ref.ships } : { fleet: ref.fleet, ...(ref.wing == null ? {} : { wing: ref.wing }), ...(ref.squad == null ? {} : { squad: ref.squad }) };
  const group = selectCinemaGroup(scene, selection);
  if (!group.leader) return { pose: null, subject: null, note: group.problems.join('; ') || 'the group has no ships' };
  const frame = groupFrame(group.ships, group.leader);
  const fov = ref.fov ?? row.fov;
  const fill = ref.fill ?? row.fill;
  const { halfWidth, halfHeight } = viewHalfExtents(fov, scene.aspect);
  const { extents } = frame;
  const halfLength = Math.max(-extents.forward[0], extents.forward[1]);
  const halfBeam = Math.max(-extents.starboard[0], extents.starboard[1]);
  const halfHeightExtent = Math.max(-extents.up[0], extents.up[1]);
  const lead = group.leader.frameRadius;
  let pose: CameraPose;
  let note: Maybe<string> = null;
  if (row.name === 'behind-fc') {
    const enemy = nearestEnemyCentroid(scene, group.leader.team, frame.centre);
    const aim = (enemy ? normalizeVec(subVec(enemy, frame.centre)) : null) ?? frame.forward;
    const up = orthogonalizeVec(frame.up, aim) ?? frame.up;
    let rear = 0;
    for (const ship of group.ships) rear = Math.max(rear, -dotVec(subVec(ship.frameCentre, frame.centre), aim) + ship.frameRadius);
    const pad = Math.max(4 * lead, (0.15 * frame.radius) / fill);
    let eye = addScaledVec(frame.centre, aim, -(rear + pad));
    eye = addScaledVec(eye, up, 0.3 * frame.radius + 2 * lead);
    pose = { eye, look: enemy ?? aheadOf(frame, 3 * frame.radius), up, fov };
    if (!enemy) note = 'no enemy team: looking ahead';
  } else if (row.name === 'flank-port' || row.name === 'flank-starboard') {
    const starboard = row.name === 'flank-starboard';
    const side = starboard ? frame.starboard : frame.starboard.map((value) => -value);
    const beam = starboard ? extents.starboard[1] : -extents.starboard[0];
    const distance = beam + Math.max(halfLength / (halfWidth * fill), halfHeightExtent / (halfHeight * fill));
    const look = midpoint(frame);
    pose = { eye: addScaledVec(addScaledVec(look, side as SceneVector, distance), frame.up, 0.1 * distance), look, up: frame.up, fov };
  } else if (row.name === 'top-down') {
    const distance = extents.up[1] + Math.max(halfBeam / (halfWidth * fill), halfLength / (halfHeight * fill));
    const look = midpoint(frame);
    pose = { eye: addScaledVec(look, frame.up, distance), look, up: frame.forward, fov };
  } else {
    const pad = Math.max(4 * lead, 0.1 * frame.radius);
    const eye = addScaledVec(addScaledVec(frame.centre, frame.forward, extents.forward[1] + pad + Math.max(halfBeam / halfWidth, halfHeightExtent / halfHeight) * 0.5), frame.up, 0.12 * frame.radius + lead);
    pose = { eye, look: frame.centre, up: frame.up, fov };
  }
  return { pose, subject: frame, ...(note ? { note } : {}) };
}

/**
 * The centre of a frame's extents box.
 */
function midpoint(frame: SubjectFrame): SceneVector {
  const { extents } = frame;
  let point = addScaledVec(frame.centre, frame.forward, (extents.forward[0] + extents.forward[1]) / 2);
  point = addScaledVec(point, frame.starboard, (extents.starboard[0] + extents.starboard[1]) / 2);
  return addScaledVec(point, frame.up, (extents.up[0] + extents.up[1]) / 2);
}

function resolveEngagementHardpoint(ref: HardpointRef, scene: CinemaScene): ResolvedHardpoint {
  const row = ENGAGEMENT_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  const frame = engagementFrame(scene, ref.teams);
  if (!row) return { pose: null, subject: null, note: `no engagement hardpoint "${ref.name}"` };
  if (!frame) return { pose: null, subject: null, note: ref.teams ? `no ships on teams ${ref.teams.join(' and ')}` : 'the scene has no ships' };
  const fov = ref.fov ?? row.fov;
  const distance = fitDistance(frame.radius, fov, scene.aspect, ref.fill ?? row.fill);
  let resolved: ResolvedHardpoint;
  const note = frame.teams.length < 2 ? 'fewer than two teams: framing every ship' : null;
  if (row.name === 'overlook') {
    const side = ref.side === 'port' ? -1 : 1;
    const direction = normalizeVec(addScaledVec(addScaledVec(frame.starboard.map((value) => value * side * 0.75) as SceneVector, frame.up, 0.65), frame.forward, -0.1)) ?? frame.up;
    resolved = { pose: { eye: addScaledVec(frame.centre, direction, distance), look: frame.centre, up: [...WORLD_UP], fov }, subject: frame };
  } else {
    let away: Maybe<SceneVector>;
    let missing: Maybe<string> = null;
    if (row.name === 'into-sun') {
      away = normalizeVec(scene.sunDirection);
      if (!away) missing = 'no sun direction';
    } else {
      const celestial = findCelestial(scene, ref.celestial);
      away = celestial ? normalizeVec(subVec(frame.centre, celestial.position)) : null;
      if (!celestial) missing = ref.celestial == null ? 'into-celestial needs a celestial (an id or a name)' : `no celestial "${ref.celestial}" at this location`;
    }
    if (away) {
      // Looking straight up or down: square the frame's heading as up instead of world up.
      const up = Math.abs(dotVec(away, WORLD_UP)) > 0.98 ? frame.forward : [...WORLD_UP];
      resolved = { pose: { eye: addScaledVec(frame.centre, away, distance), look: frame.centre, up: up as SceneVector, fov }, subject: frame };
    } else {
      resolved = { pose: null, subject: frame, note: missing ?? 'no direction' };
    }
  }
  return note && resolved.pose ? { ...resolved, note: resolved.note ? `${resolved.note}; ${note}` : note } : resolved;
}

/**
 * A celestial by id (a number, "40009081" or "celestial:40009081") or by name (case-insensitive).
 */
export function findCelestial(scene: CinemaScene, key: Maybe<string | number>): Maybe<{ readonly position: SceneVector; readonly name: string; readonly id: number }> {
  const celestials = scene.celestials ?? [];
  let found = null;
  if (typeof key === 'number') found = celestials.find((candidate) => candidate.id === key);
  else if (typeof key === 'string') {
    const text = key.trim().replace(/^celestial:/u, '');
    const id = /^\d+$/u.test(text) ? Number(text) : null;
    found = celestials.find((candidate) => candidate.id === id) ?? celestials.find((candidate) => candidate.name.toLowerCase() === text.toLowerCase()) ?? null;
  }
  return found ?? null;
}

/**
 * A direction given in a frame's [forward, starboard, up] axes, in world space.
 *
 * @param frame - The frame.
 * @param components - The components.
 * @param normalize - Unit length (true) or as given.
 */
function inFrame(frame: SubjectFrame, components: readonly [number, number, number], normalize = true): SceneVector {
  let vector = addScaledVec([0, 0, 0], frame.forward, components[0]);
  vector = addScaledVec(vector, frame.starboard, components[1]);
  vector = addScaledVec(vector, frame.up, components[2]);
  return normalize ? (normalizeVec(vector) ?? frame.forward) : vector;
}

export interface ListedHardpoint {
  readonly name: string;
  readonly kind: HardpointKind;
  readonly description: string;
  readonly pose: Maybe<CameraPose>;
  readonly note?: string;
}

/**
 * Every hardpoint of a subject, resolved on the scene as drawn: a ship's (with `ship`), a group's (with `fleet` or
 * `ships`), or the engagement's (neither).
 */
export function listHardpoints(subject: Omit<HardpointRef, 'name'>, scene: CinemaScene): ListedHardpoint[] {
  let rows: readonly { readonly name: string; readonly description: string }[];
  let kind: HardpointKind;
  if (subject.fleet != null || subject.ships != null) {
    rows = GROUP_HARDPOINTS;
    kind = 'group';
  } else if (subject.ship != null) {
    rows = SHIP_HARDPOINTS;
    kind = 'ship';
  } else {
    rows = ENGAGEMENT_HARDPOINTS;
    kind = 'engagement';
  }
  return rows.map((row) => {
    const resolved = resolveHardpoint({ ...subject, name: row.name }, scene);
    return { name: row.name, kind, description: row.description, pose: resolved.pose, ...(resolved.note ? { note: resolved.note } : {}) };
  });
}
