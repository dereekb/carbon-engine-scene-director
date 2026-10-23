/**
 * Camera hardpoints, generated from the live scene and never stored: each is a pure function of the drawn positions,
 * headings, hull radii, fleet membership and teams, re-evaluated every frame.
 *
 * - Ship hardpoints scale by the hull's SOF bounding radius and stand in the ship's level frame (or its banked one).
 * - Group hardpoints (a fleet, wing or squad, or a list of ships) scale by the formation's extent, in the leader's
 *   level frame.
 * - Engagement hardpoints stand on the axis between two teams.
 * - Landmark hardpoints frame a scene object or a location celestial against the scene's ships.
 *
 * Anchored hardpoints hold their eye once placed: the flyby's is placed when the shot starts and holds while the ship
 * flies past; warp-landing's (and its look) once the group's warp is known, so the ships streak in and stop in front of
 * the lens.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import { MIN_WARP_DISTANCE } from '../orders';
import { fitDistance, viewHalfExtents } from './framing';
import type { CameraPose } from './pose';
import { aheadOf, CINEMA_ARRIVING_NOTE, engagementFrame, findLandmark, groupFrame, landmarkFrame, nearestEnemyCentroid, nearestOtherShip, sceneFocus, selectCinemaGroup, shipFrame, type CinemaLandmark, type CinemaScene, type CinemaShip, type CinemaWarp, type SubjectFrame } from './subjects';
import { addScaledVec, addVec, crossVec, distanceVec, dotVec, fromFrame, lengthVec, normalizeVec, orthogonalizeVec, scaleVec, subVec, WORLD_UP } from './vectors';

export type HardpointKind = 'ship' | 'group' | 'engagement' | 'landmark';

export const HARDPOINT_KINDS: readonly HardpointKind[] = ['ship', 'group', 'engagement', 'landmark'];

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
  readonly special?: 'over-the-shoulder' | 'flyby' | 'warp-landing';
  /**
   * The eye is placed when the shot starts and holds.
   */
  readonly anchored?: boolean;
  readonly description: string;
}

/**
 * What warp-landing does, for a ship or a group.
 */
const WARP_LANDING_DESCRIPTION = "at the landing point of the group's warp (or of its arrival by warp, warpIn), ahead of it and to one side, looking back up the warp lane, so the ships streak in and stop in front of the lens; a group with no warp is framed where it is; the eye and look hold once a warp is known";

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
  { name: 'flyby', direction: [1, 0.4, 0.13], fill: 0.5, fov: 40, up: 'frame', special: 'flyby', anchored: true, description: "a fixed point ahead on the ship's path, panning as it flies past" },
  { name: 'warp-landing', direction: [1, 0, 0], fill: 0.8, fov: 50, up: 'frame', special: 'warp-landing', anchored: true, description: WARP_LANDING_DESCRIPTION }
];

export interface GroupHardpointRow {
  readonly name: string;
  readonly fill: number;
  readonly fov: number;
  readonly anchored?: boolean;
  readonly description: string;
}

export const GROUP_HARDPOINTS: readonly GroupHardpointRow[] = [
  { name: 'behind-fc', fill: 0.85, fov: 55, description: "behind the group's rear and above, looking past its leader at the nearest enemy (else ahead)" },
  { name: 'flank-port', fill: 0.85, fov: 40, description: 'off the port flank, the formation in profile' },
  { name: 'flank-starboard', fill: 0.85, fov: 40, description: 'off the starboard flank, the formation in profile' },
  { name: 'top-down', fill: 0.85, fov: 45, description: "straight down on the formation, the leader's heading at the top of the frame" },
  { name: 'leading-edge', fill: 0.85, fov: 50, description: 'ahead of the formation, looking back at it' },
  { name: 'warp-landing', fill: 0.8, fov: 50, anchored: true, description: WARP_LANDING_DESCRIPTION }
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
  { name: 'into-celestial', fill: 0.75, fov: 55, description: 'across the battle toward a celestial (`celestial`: an id or a name from the location) or a scene object (`object`)' }
];

export interface LandmarkHardpointRow {
  readonly name: string;
  readonly fill: number;
  readonly fov: number;
  readonly description: string;
}

export const LANDMARK_HARDPOINTS: readonly LandmarkHardpointRow[] = [
  { name: 'establishing', fill: 0.6, fov: 50, description: "beyond the scene's ships from the landmark, a little above, looking past them at it: the ships in the lower third, never under 12% of the frame" },
  { name: 'hero', fill: 0.75, fov: 30, description: 'a front three-quarter on the landmark (`side`), on a longer lens' },
  { name: 'foreground', fill: 1, fov: 45, description: "behind the landmark's limb and to one side (`side`), looking past it at the scene's ships" }
];

export const SHIP_HARDPOINT_NAMES = SHIP_HARDPOINTS.map((row) => row.name);
export const GROUP_HARDPOINT_NAMES = GROUP_HARDPOINTS.map((row) => row.name);
export const ENGAGEMENT_HARDPOINT_NAMES = ENGAGEMENT_HARDPOINTS.map((row) => row.name);
export const LANDMARK_HARDPOINT_NAMES = LANDMARK_HARDPOINTS.map((row) => row.name);

/**
 * How far from the origin a landmark hardpoint's eye may stand, metres: past it, drawn ships jitter in float32.
 */
export const MAX_LANDMARK_EYE_DISTANCE = 1e8;

/**
 * Warp-landing's smallest framed radius, metres, so the exit coast never reaches the eye.
 */
export const MIN_WARP_LANDING_RADIUS = 2000;
/**
 * Warp-landing's eye: degrees to the side of the lane, and up.
 */
export const WARP_LANDING_YAW = 25;
export const WARP_LANDING_PITCH = 12;
/**
 * The share of a group warp-landing frames: the hulls nearest the reference, leaving out logi or tackle far off the main
 * body (they land deeper up the lane, in frame or just past it).
 */
export const WARP_LANDING_CORE = 0.8;

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
   * Into-celestial's celestial, or a landmark subject: an id or a name.
   */
  readonly celestial?: string | number;
  /**
   * A landmark subject (a scene object id), or into-celestial's target.
   */
  readonly object?: string;
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
   * Which side the overlook (of the axis), warp-landing (of the lane) and the landmark hero and foreground take.
   */
  readonly side?: 'port' | 'starboard';
}

/**
 * Which kind of subject a hardpoint reference names: an engagement name, else a group when it selects a fleet or ships,
 * else a landmark when it names an object or a celestial, else a ship.
 */
export function hardpointKind(ref: Pick<HardpointRef, 'name' | 'fleet' | 'ships' | 'object' | 'celestial'>): HardpointKind {
  let kind: HardpointKind = 'ship';
  if (ENGAGEMENT_HARDPOINT_NAMES.includes(ref.name)) kind = 'engagement';
  else if (ref.fleet != null || ref.ships != null) kind = 'group';
  else if (ref.object != null || ref.celestial != null) kind = 'landmark';
  return kind;
}

/**
 * Which kind of subject a hardpoint subject (no name) selects: a group, a ship, a landmark, else the engagement.
 */
export function hardpointSubjectKind(subject: Pick<HardpointRef, 'fleet' | 'ships' | 'ship' | 'object' | 'celestial'>): HardpointKind {
  let kind: HardpointKind = 'engagement';
  if (subject.fleet != null || subject.ships != null) kind = 'group';
  else if (subject.object != null || subject.celestial != null) kind = 'landmark';
  else if (subject.ship != null) kind = 'ship';
  return kind;
}

/**
 * The hardpoint names of a kind.
 */
export function hardpointNames(kind: HardpointKind): readonly string[] {
  const names: Record<HardpointKind, readonly string[]> = { ship: SHIP_HARDPOINT_NAMES, group: GROUP_HARDPOINT_NAMES, engagement: ENGAGEMENT_HARDPOINT_NAMES, landmark: LANDMARK_HARDPOINT_NAMES };
  return names[kind];
}

/**
 * What an anchored hardpoint holds once placed: its eye (the flyby), and its look and framed radius (warp-landing).
 */
export interface HardpointAnchor {
  readonly eye: SceneVector;
  readonly look?: SceneVector;
  readonly radius?: number;
}

export interface ResolvedHardpoint {
  readonly pose: Maybe<CameraPose>;
  /**
   * The frame the hardpoint stood in.
   */
  readonly subject: Maybe<SubjectFrame>;
  /**
   * What an anchored hardpoint placed (flyby, warp-landing): pass it back on later frames.
   */
  readonly anchor?: HardpointAnchor;
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
export function resolveHardpoint(ref: HardpointRef, scene: CinemaScene, anchor?: Maybe<HardpointAnchor>): ResolvedHardpoint {
  const kind = hardpointKind(ref);
  let resolved: ResolvedHardpoint;
  if (kind === 'engagement') resolved = resolveEngagementHardpoint(ref, scene);
  else if (kind === 'group') resolved = resolveGroupHardpoint(ref, scene, anchor);
  else if (kind === 'landmark') resolved = resolveLandmarkHardpoint(ref, scene);
  else resolved = resolveShipHardpoint(ref, scene, anchor);
  return resolved;
}

function resolveShipHardpoint(ref: HardpointRef, scene: CinemaScene, anchor: Maybe<HardpointAnchor>): ResolvedHardpoint {
  const row = SHIP_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  const ship = ref.ship == null ? null : scene.ships.find((candidate) => candidate.id === ref.ship);
  if (!row) return { pose: null, subject: null, note: `no ship hardpoint "${ref.name}" (${SHIP_HARDPOINT_NAMES.join(', ')})` };
  const arriving = ship || ref.ship == null ? null : scene.arriving?.find((candidate) => candidate.id === ref.ship);
  if (arriving) return row.special === 'warp-landing' ? resolveWarpLanding(ref, scene, [arriving], arriving, arriving.id, ref.fov ?? row.fov, ref.fill ?? row.fill, anchor) : { pose: null, subject: null, note: `ship ${arriving.id} is ${CINEMA_ARRIVING_NOTE}` };
  if (!ship) return { pose: null, subject: null, note: ref.ship == null ? `hardpoint "${ref.name}" needs a ship` : `no ship "${ref.ship}" in the scene` };
  const frame = shipFrame(ship, ref.bank === true);
  const fov = ref.fov ?? row.fov;
  const fill = ref.fill ?? row.fill;
  let resolved: ResolvedHardpoint;
  if (row.special === 'over-the-shoulder') resolved = overTheShoulder(ref, scene, ship, frame, fov);
  else if (row.special === 'flyby') resolved = flyby(frame, fov, anchor?.eye);
  else if (row.special === 'warp-landing') resolved = resolveWarpLanding(ref, scene, [ship], ship, ship.id, fov, fill, anchor);
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
  return { pose: { eye: [...eye], look: frame.centre, up: [...WORLD_UP], fov }, subject: frame, anchor: { eye: [...eye] } };
}

/**
 * Warp-landing: downstream of the group's landing, WARP_LANDING_YAW to one side and WARP_LANDING_PITCH up, looking back
 * up the lane at where the formation settles. While the reference ship aligns, the landing formation is its formation
 * where it stands, moved to the landing and turned to the lane; once in warp, the landings themselves. Ships still
 * arriving by warp count as in warp from the start: their landings are known, the lane runs from where they wait. The
 * eye and look are anchored on the first frame that sees a warp in progress; a landed one frames its landing
 * unanchored, since Destiny keeps reporting a landed warp until the next one resolves.
 *
 * @param ref - The hardpoint (`side`).
 * @param scene - The drawn scene (`warpOf`).
 * @param ships - The group.
 * @param leader - Its leader: the reference ship when it warps.
 * @param label - The group, for notes.
 * @param fov - Degrees.
 * @param fill - The landing formation's share of the frame.
 * @param anchor - The pose placed on an earlier frame.
 */
function resolveWarpLanding(ref: HardpointRef, scene: CinemaScene, ships: readonly CinemaShip[], leader: CinemaShip, label: string, fov: number, fill: number, anchor: Maybe<HardpointAnchor>): ResolvedHardpoint {
  if (anchor?.look) {
    const view = normalizeVec(subVec(anchor.look, anchor.eye)) ?? [0, 0, -1];
    const up = Math.abs(dotVec(view, WORLD_UP)) > 0.98 ? (orthogonalizeVec([0, 0, 1], view) ?? [1, 0, 0]) : (orthogonalizeVec(WORLD_UP, view) ?? [...WORLD_UP]);
    const forward = normalizeVec([-view[0], 0, -view[2]]) ?? [0, 0, 1];
    const r = anchor.radius ?? MIN_WARP_LANDING_RADIUS;
    const subject: SubjectFrame = { centre: [...anchor.look], radius: r, forward, up: [...WORLD_UP], starboard: crossVec(forward, WORLD_UP), velocity: [...leader.velocity], extents: { forward: [-r, r], starboard: [-r, r], up: [-r, r] } };
    return { pose: { eye: [...anchor.eye], look: [...anchor.look], up, fov }, subject, anchor, note: `holding on the landing of ${label}'s warp` };
  }
  const warpOf = scene.warpOf ?? (() => null);
  let reference: CinemaShip = leader;
  let warp = warpOf(leader.id);
  // A ship still to land from warp outranks a landed leader (the first of a staggered arrival is down already).
  const pick = (accept: (candidate: CinemaWarp) => boolean): void => {
    for (const ship of ships) {
      const candidate = warpOf(ship.id);
      if (candidate && accept(candidate)) {
        reference = ship;
        warp = candidate;
        break;
      }
    }
  };
  if (warp?.phase === 'landed') pick((candidate) => candidate.phase === 'arriving');
  if (!warp) pick(() => true);
  const lead = shipFrame(reference);
  let centre: SceneVector;
  let radius: number;
  let lane: SceneVector;
  let note: string;
  let placed = false;
  const hulls = (list: readonly CinemaShip[]): LandingPoint[] => list.map((ship) => ({ point: ship.frameCentre, radius: ship.frameRadius }));
  if (!warp) {
    ({ centre, radius } = landingCore(hulls(ships), leader.frameCentre));
    lane = shipFrame(leader).forward;
    note = `no warp in progress: framing ${label} where it is (the shot moves to the landing once it warps)`;
  } else {
    const toward = subVec(warp.landing, reference.frameCentre);
    lane = lengthVec(toward) > Math.max(1000, 5 * reference.frameRadius) ? (normalizeVec(toward) ?? lead.forward) : lead.forward;
    if (warp.phase === 'aligning') {
      // A formation warp lands every slot in the leader's heading at warp, the lane: carry the formation's offset from
      // the reference's heading frame into the lane's.
      const core = landingCore(hulls(ships), reference.frameCentre);
      const offset = subVec(core.centre, reference.frameCentre);
      const laneUp = Math.abs(dotVec(lane, WORLD_UP)) > 0.98 ? lead.forward : (orthogonalizeVec(WORLD_UP, lane) ?? [...WORLD_UP]);
      centre = fromFrame(warp.landing, { forward: lane, up: laneUp, starboard: crossVec(lane, laneUp) }, [dotVec(offset, lead.forward), dotVec(offset, lead.starboard), dotVec(offset, lead.up)]);
      radius = core.radius;
    } else {
      const landings: LandingPoint[] = [];
      for (const ship of ships) {
        const shipWarp = ship.id === reference.id ? warp : warpOf(ship.id);
        // A member's landing farther than a warp's minimum from the reference's is an earlier warp's (pilot delay).
        if (shipWarp && shipWarp.phase !== 'aligning' && distanceVec(shipWarp.landing, warp.landing) < MIN_WARP_DISTANCE) landings.push({ point: shipWarp.landing, radius: ship.frameRadius });
      }
      ({ centre, radius } = landingCore(landings, warp.landing));
    }
    note = `${label} is ${warp.phase}`;
    // A landed warp may be a stale one (Destiny keeps it until the next warp resolves): frame the landing, unanchored,
    // so the next warp still anchors.
    placed = warp.phase !== 'landed';
  }
  radius = Math.max(radius, MIN_WARP_LANDING_RADIUS);
  const distance = fitDistance(radius, fov, scene.aspect, fill);
  const up = Math.abs(dotVec(lane, WORLD_UP)) > 0.98 ? lead.forward : (orthogonalizeVec(WORLD_UP, lane) ?? [...WORLD_UP]);
  const starboard = crossVec(lane, up);
  const side = scaleVec(starboard, ref.side === 'port' ? -1 : 1);
  const yaw = (WARP_LANDING_YAW * Math.PI) / 180;
  const pitch = (WARP_LANDING_PITCH * Math.PI) / 180;
  const direction = normalizeVec(addScaledVec(scaleVec(addScaledVec(scaleVec(lane, Math.cos(yaw)), side, Math.sin(yaw)), Math.cos(pitch)), up, Math.sin(pitch))) ?? lane;
  const eye = addScaledVec(centre, direction, distance);
  const subject: SubjectFrame = { centre, radius, forward: lane, up, starboard, velocity: [...leader.velocity], extents: { forward: [-radius, radius], starboard: [-radius, radius], up: [-radius, radius] } };
  return { pose: { eye, look: [...centre], up, fov }, subject, note, ...(placed ? { anchor: { eye: [...eye], look: [...centre], radius } } : {}) };
}

interface LandingPoint {
  readonly point: SceneVector;
  readonly radius: number;
}

/**
 * The core of a formation or its landings: the WARP_LANDING_CORE share of the hulls nearest the reference (its slot),
 * so logi or tackle far off the main body do not shrink it to a few pixels; its centroid and bounding radius.
 */
function landingCore(points: readonly LandingPoint[], reference: SceneVector): { centre: SceneVector; radius: number } {
  const sorted = [...points].sort((a, b) => distanceVec(a.point, reference) - distanceVec(b.point, reference));
  const core = sorted.slice(0, Math.max(1, Math.ceil(WARP_LANDING_CORE * sorted.length)));
  const centre = scaleVec(
    core.reduce<SceneVector>((sum, entry) => addVec(sum, entry.point), [0, 0, 0]),
    1 / Math.max(1, core.length)
  );
  let radius = 0;
  for (const entry of core) radius = Math.max(radius, distanceVec(entry.point, centre) + entry.radius);
  return { centre, radius };
}

function resolveGroupHardpoint(ref: HardpointRef, scene: CinemaScene, anchor: Maybe<HardpointAnchor>): ResolvedHardpoint {
  const row = GROUP_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  if (!row) return { pose: null, subject: null, note: `no group hardpoint "${ref.name}" (${GROUP_HARDPOINT_NAMES.join(', ')})` };
  const selection = ref.ships ? { ships: ref.ships } : { fleet: ref.fleet, ...(ref.wing == null ? {} : { wing: ref.wing }), ...(ref.squad == null ? {} : { squad: ref.squad }) };
  // Warp-landing frames ships still arriving by warp too (at their landings); every other hardpoint only the landed.
  const group = selectCinemaGroup(scene, selection, { arriving: row.name === 'warp-landing' });
  if (!group.leader) return { pose: null, subject: null, note: group.arriving.length && !group.ships.length ? `${groupLabel(ref)} ${(ref.ships?.length ?? 0) > 1 ? 'are' : 'is'} ${CINEMA_ARRIVING_NOTE}` : group.problems.join('; ') || 'the group has no ships' };
  const fov = ref.fov ?? row.fov;
  const fill = ref.fill ?? row.fill;
  if (row.name === 'warp-landing') return resolveWarpLanding(ref, scene, group.ships, group.leader, groupLabel(ref), fov, fill, anchor);
  const frame = groupFrame(group.ships, group.leader);
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
 * A group subject, for notes: "fleet tfis", "squad dps-a of fleet tfis", "ship x" or "4 ships".
 */
function groupLabel(ref: HardpointRef): string {
  let label: string;
  if (ref.ships) label = ref.ships.length === 1 ? `ship ${ref.ships[0]}` : `${ref.ships.length} ships`;
  else if (ref.wing != null) label = `wing ${ref.wing} of fleet ${ref.fleet}`;
  else if (ref.squad != null) label = `squad ${ref.squad} of fleet ${ref.fleet}`;
  else label = `fleet ${ref.fleet}`;
  return label;
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
    } else if (ref.object != null) {
      const object = scene.objects?.find((candidate) => candidate.id === ref.object);
      away = object ? normalizeVec(subVec(frame.centre, object.centre)) : null;
      if (!object) missing = `no object "${ref.object}" in the scene`;
    } else {
      const celestial = findCelestial(scene, ref.celestial);
      away = celestial ? normalizeVec(subVec(frame.centre, celestial.position)) : null;
      if (!celestial) missing = ref.celestial == null ? 'into-celestial needs a celestial (an id or a name) or an object' : `no celestial "${ref.celestial}" at this location`;
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

/**
 * A landmark hardpoint: the subject is a scene object or a location celestial, framed against the scene's ships.
 */
function resolveLandmarkHardpoint(ref: HardpointRef, scene: CinemaScene): ResolvedHardpoint {
  const row = LANDMARK_HARDPOINTS.find((candidate) => candidate.name === ref.name);
  if (!row) return { pose: null, subject: null, note: `no landmark hardpoint "${ref.name}" (${LANDMARK_HARDPOINT_NAMES.join(', ')})` };
  const landmark = findLandmark(scene, ref);
  if (!landmark) return { pose: null, subject: null, note: ref.object != null ? `no object "${ref.object}" in the scene` : `no celestial "${ref.celestial}" at this location` };
  const focus = sceneFocus(scene, ref.teams);
  const frame = landmarkFrame(landmark, focus.centre);
  const fov = ref.fov ?? row.fov;
  const fill = ref.fill ?? row.fill;
  const c = landmark.centre;
  const r = landmark.radius;
  const sign = ref.side === 'port' ? -1 : 1;
  let pose: CameraPose;
  let note: Maybe<string> = null;
  if (row.name === 'establishing') {
    const direction = swing(frame, 0, 8);
    if (focus.ships) {
      const near = 1.5 * focus.radius + 2000;
      const far = Math.max(near, fitDistance(focus.radius, fov, scene.aspect, 0.12));
      const s = Math.min(far, Math.max(near, fitDistance(r, fov, scene.aspect, fill) - distanceVec(focus.centre, c)));
      pose = { eye: addScaledVec(focus.centre, direction, s), look: [...c], up: frame.up, fov };
    } else {
      pose = { eye: addScaledVec(c, direction, fitDistance(r, fov, scene.aspect, fill)), look: [...c], up: frame.up, fov };
    }
  } else if (row.name === 'hero') {
    pose = { eye: addScaledVec(c, swing(frame, sign * 50, 15), fitDistance(r, fov, scene.aspect, fill)), look: [...c], up: frame.up, fov };
  } else {
    let eye = addScaledVec(c, frame.forward, -1.2 * r);
    eye = addScaledVec(eye, frame.starboard, sign * 1.3 * r);
    eye = addScaledVec(eye, frame.up, 0.25 * r);
    let look: SceneVector = [...focus.centre];
    if (!focus.ships) {
      note = 'no ships: looking past the landmark toward the origin';
      if (distanceVec(look, c) < 2 * r) look = addScaledVec(c, frame.forward, 10 * r);
    }
    const view = normalizeVec(subVec(look, eye)) ?? frame.forward;
    pose = { eye, look, up: orthogonalizeVec(frame.up, view) ?? frame.up, fov };
  }
  let resolved: ResolvedHardpoint = { pose, subject: frame, ...(note ? { note } : {}) };
  if (lengthVec(pose.eye) > MAX_LANDMARK_EYE_DISTANCE) {
    resolved = { pose: null, subject: frame, note: `too far from the scene for a ${row.name} shot (float32): use ${row.name === 'establishing' ? 'into-celestial' : 'establishing or into-celestial'}` };
  }
  return resolved;
}

/**
 * A direction off a frame's forward, swung `yaw` degrees toward starboard and pitched `pitch` degrees up.
 */
function swing(frame: SubjectFrame, yaw: number, pitch: number): SceneVector {
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  const level = addScaledVec(scaleVec(frame.forward, Math.cos(a)), frame.starboard, Math.sin(a));
  return normalizeVec(addScaledVec(scaleVec(level, Math.cos(b)), frame.up, Math.sin(b))) ?? frame.forward;
}

export interface ListedHardpoint {
  readonly name: string;
  readonly kind: HardpointKind;
  readonly description: string;
  readonly pose: Maybe<CameraPose>;
  readonly anchored?: boolean;
  readonly note?: string;
}

/**
 * A hardpoint subject: a hardpoint reference without its name.
 */
export type HardpointSubject = Omit<HardpointRef, 'name'>;

/**
 * Every hardpoint of a subject, resolved on the scene as drawn: a ship's (with `ship`), a group's (with `fleet` or
 * `ships`), a landmark's (with `object` or `celestial`, plus into-celestial aimed at it), or the engagement's (none).
 * Anchored hardpoints resolve as if a shot started now.
 */
export function listHardpoints(subject: HardpointSubject, scene: CinemaScene): ListedHardpoint[] {
  const kind = hardpointSubjectKind(subject);
  const rows: { readonly name: string; readonly description: string; readonly anchored?: boolean; readonly kind: HardpointKind }[] = [];
  if (kind === 'group') rows.push(...GROUP_HARDPOINTS.map((row) => ({ ...row, kind })));
  else if (kind === 'ship') rows.push(...SHIP_HARDPOINTS.map((row) => ({ ...row, kind })));
  else if (kind === 'landmark') {
    rows.push(...LANDMARK_HARDPOINTS.map((row) => ({ ...row, kind })));
    const into = ENGAGEMENT_HARDPOINTS.find((row) => row.name === 'into-celestial');
    if (into) rows.push({ ...into, kind: 'engagement' });
  } else rows.push(...ENGAGEMENT_HARDPOINTS.map((row) => ({ ...row, kind })));
  return rows.map((row) => {
    const resolved = resolveHardpoint({ ...subject, name: row.name }, scene);
    return { name: row.name, kind: row.kind, description: row.description, pose: resolved.pose, ...(row.anchored ? { anchored: true } : {}), ...(resolved.note ? { note: resolved.note } : {}) };
  });
}

/**
 * One hardpoint in list_hardpoints: scene metres around the origin (0.01 m), unit vectors to 0.001, fov to 0.1°.
 */
export interface HardpointListingEntry {
  readonly name: string;
  readonly kind: HardpointKind;
  readonly description: string;
  readonly eye?: number[];
  readonly look?: number[];
  readonly up?: number[];
  readonly fov?: number;
  /**
   * Eye to look, metres (0.1 m).
   */
  readonly distance?: number;
  readonly anchored?: boolean;
  readonly note?: string;
}

/**
 * What list_hardpoints reports: the subject's frame and every hardpoint on it.
 */
export interface HardpointListing {
  readonly kind: HardpointKind;
  readonly subject: Maybe<Record<string, unknown>>;
  readonly hardpoints: HardpointListingEntry[];
}

/**
 * The list_hardpoints report for a subject on the scene as drawn.
 */
export function toHardpointListing(subject: HardpointSubject, scene: CinemaScene): HardpointListing {
  const kind = hardpointSubjectKind(subject);
  const hardpoints = listHardpoints(subject, scene).map((entry): HardpointListingEntry => {
    const pose = entry.pose;
    return {
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      ...(pose ? { eye: roundVec(pose.eye, 100), look: roundVec(pose.look, 100), up: roundVec(pose.up, 1000), fov: round(pose.fov, 10), distance: round(distanceVec(pose.eye, pose.look), 10) } : {}),
      ...(entry.anchored ? { anchored: true } : {}),
      ...(entry.note ? { note: entry.note } : {})
    };
  });
  return { kind, subject: subjectReport(subject, scene, kind), hardpoints };
}

function subjectReport(subject: HardpointSubject, scene: CinemaScene, kind: HardpointKind): Maybe<Record<string, unknown>> {
  let frame: Maybe<SubjectFrame> = null;
  let ids: Record<string, unknown> = {};
  let extra: Record<string, unknown> = {};
  if (kind === 'ship') {
    const ship = scene.ships.find((candidate) => candidate.id === subject.ship);
    if (ship) frame = shipFrame(ship, subject.bank === true);
    ids = { ship: subject.ship, ...(scene.arriving?.some((candidate) => candidate.id === subject.ship) ? { arriving: true } : {}) };
  } else if (kind === 'group') {
    const selection = subject.ships ? { ships: subject.ships } : { fleet: subject.fleet, ...(subject.wing == null ? {} : { wing: subject.wing }), ...(subject.squad == null ? {} : { squad: subject.squad }) };
    const group = selectCinemaGroup(scene, selection);
    if (group.leader) {
      frame = groupFrame(group.ships, group.leader);
      extra = { leader: group.leader.id, count: group.ships.length };
    }
    if (group.arriving.length) extra = { ...extra, arriving: group.arriving.length };
    ids = subject.ships ? { ships: subject.ships } : { fleet: subject.fleet, ...(subject.wing == null ? {} : { wing: subject.wing }), ...(subject.squad == null ? {} : { squad: subject.squad }) };
  } else if (kind === 'landmark') {
    const landmark: Maybe<CinemaLandmark> = findLandmark(scene, subject);
    if (landmark) {
      frame = landmarkFrame(landmark, sceneFocus(scene, subject.teams).centre);
      ids = { [landmark.kind]: landmark.id, ...(landmark.name ? { name: landmark.name } : {}) };
    } else ids = subject.object != null ? { object: subject.object } : { celestial: subject.celestial };
  } else {
    const engagement = engagementFrame(scene, subject.teams);
    if (engagement) {
      frame = engagement;
      extra = { teams: engagement.teams, a: roundVec(engagement.a, 100), b: roundVec(engagement.b, 100) };
    }
  }
  // A subject still arriving by warp has no frame yet, but says so.
  const arriving = ids['arriving'] != null || extra['arriving'] != null;
  return frame ? { kind, ...ids, centre: roundVec(frame.centre, 100), radius: round(frame.radius, 10), forward: roundVec(frame.forward, 1000), up: roundVec(frame.up, 1000), starboard: roundVec(frame.starboard, 1000), ...extra } : arriving ? { kind, ...ids, ...extra } : null;
}

function round(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

function roundVec(vector: Readonly<SceneVector>, scale: number): number[] {
  return vector.map((value) => round(value, scale));
}
