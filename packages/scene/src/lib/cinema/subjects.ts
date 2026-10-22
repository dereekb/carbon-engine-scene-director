/**
 * What the cinematic camera frames: the live scene as drawn this frame (CinemaScene), and the subject frames the
 * hardpoints stand in: one ship, a fleet group, or two teams facing each other.
 *
 * Every input is a drawn sample (the ClientBall the renderer draws), so the camera sits on the image, not on the
 * Destiny master, which runs up to a tick ahead.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneFleet } from '../fleets/fleet';
import { selectFleetShips, type FleetSelection } from '../fleets/selection';
import type { SceneVector } from '../scene';
import type { CinemaSphere } from './framing';
import type { CameraPose } from './pose';
import type { WaypointAnchor } from '../waypoints/waypoints';
import { addScaledVec, addVec, crossVec, distanceVec, dotVec, headingAxes, normalizeVec, orthogonalizeVec, scaleVec, subVec, WORLD_UP, type CinemaQuaternion } from './vectors';

/**
 * Below this |forward · up| a heading counts as level enough to square against world up.
 */
const NEAR_VERTICAL = 0.98;

/**
 * A ship as drawn this frame.
 */
export interface CinemaShip {
  readonly id: string;
  /**
   * The drawn ball position.
   */
  readonly position: SceneVector;
  /**
   * The drawn rotation, [x, y, z, w].
   */
  readonly rotation: CinemaQuaternion;
  /**
   * The drawn velocity, m/s.
   */
  readonly velocity: SceneVector;
  /**
   * The SOF bounding sphere's centre in world space (the ball position while the hull is not built).
   */
  readonly frameCentre: SceneVector;
  /**
   * The SOF bounding sphere's radius (100 m while not built): what framing and hull clearance use.
   */
  readonly frameRadius: number;
  /**
   * The EVE radius (physics).
   */
  readonly radius?: number;
  readonly team?: string;
}

/**
 * A celestial the camera can look toward: origin-relative scene metres.
 */
export interface CinemaCelestial {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly position: SceneVector;
  readonly radius: number;
}

/**
 * A static object as drawn: its bounding sphere and its rotation.
 */
export interface CinemaObject extends CinemaSphere {
  readonly id: string;
  readonly rotation: CinemaQuaternion;
}

export interface CinemaScene {
  readonly ships: readonly CinemaShip[];
  /**
   * The document's fleets, for group subjects.
   */
  readonly fleets?: readonly SceneFleet[];
  /**
   * The light's travel direction (EveSpaceScene.sunDirection): toward the sun is minus this.
   */
  readonly sunDirection: SceneVector;
  readonly celestials?: readonly CinemaCelestial[];
  /**
   * The scene's objects (stations, structures, wrecks): hulls to keep the eye out of and to clip for, and anchors for
   * waypoints.
   */
  readonly objects?: readonly CinemaObject[];
  /**
   * The view's width / height.
   */
  readonly aspect: number;
  /**
   * Metres from the origin the far plane must reach.
   */
  readonly reach?: number;
  /**
   * The pose the page drew last frame (a blend into the first shot starts from it); null without a renderer.
   */
  readonly camera?: Maybe<CameraPose>;
}

/**
 * Extents of a group along its frame's axes, metres from its centre: [min, max].
 */
export interface SubjectExtents {
  readonly forward: readonly [number, number];
  readonly starboard: readonly [number, number];
  readonly up: readonly [number, number];
}

/**
 * Where a subject is and which way it faces.
 */
export interface SubjectFrame {
  readonly centre: SceneVector;
  /**
   * The bounding radius about the centre.
   */
  readonly radius: number;
  readonly forward: SceneVector;
  readonly up: SceneVector;
  /**
   * forward × up.
   */
  readonly starboard: SceneVector;
  readonly velocity: SceneVector;
  readonly extents: SubjectExtents;
}

/**
 * A ship's frame: level (its heading squared against world up; the drawn up when it points near vertical) or banked
 * (its drawn axes).
 *
 * @param ship - The drawn ship.
 * @param bank - True to roll with the hull.
 */
export function shipFrame(ship: CinemaShip, bank = false): SubjectFrame {
  const r = ship.frameRadius;
  return { centre: [...ship.frameCentre], radius: r, ...headingAxes(ship.rotation, bank), velocity: [...ship.velocity], extents: { forward: [-r, r], starboard: [-r, r], up: [-r, r] } };
}

/**
 * A group's frame: the centroid of its hulls, its bounding radius, and the leader's level heading.
 *
 * @param ships - The group, at least one.
 * @param leader - The ship whose heading the frame takes; default the first.
 */
export function groupFrame(ships: readonly CinemaShip[], leader: CinemaShip = ships[0]): SubjectFrame {
  const lead = shipFrame(leader);
  let centre: SceneVector = [0, 0, 0];
  for (const ship of ships) centre = addVec(centre, ship.frameCentre);
  centre = scaleVec(centre, 1 / Math.max(1, ships.length));
  let radius = 0;
  const extents = { forward: [0, 0], starboard: [0, 0], up: [0, 0] } as { forward: [number, number]; starboard: [number, number]; up: [number, number] };
  for (const ship of ships) {
    const offset = subVec(ship.frameCentre, centre);
    radius = Math.max(radius, distanceVec(ship.frameCentre, centre) + ship.frameRadius);
    for (const axis of ['forward', 'starboard', 'up'] as const) {
      const along = dotVec(offset, lead[axis]);
      extents[axis][0] = Math.min(extents[axis][0], along - ship.frameRadius);
      extents[axis][1] = Math.max(extents[axis][1], along + ship.frameRadius);
    }
  }
  return { ...lead, centre, radius, velocity: [...leader.velocity], extents };
}

export interface SelectedCinemaGroup {
  readonly ships: CinemaShip[];
  readonly leader: Maybe<CinemaShip>;
  readonly problems: string[];
}

/**
 * The drawn ships of a fleet selection (fleets/selection.ts) and its leader: the fleet's commander, the wing's
 * commander, the squad's commander, else the first ship selected.
 */
export function selectCinemaGroup(scene: CinemaScene, selection: FleetSelection): SelectedCinemaGroup {
  const { ships: ids, problems } = selectFleetShips({ ships: scene.ships, fleets: scene.fleets ?? [] }, selection, 'subject');
  const byId = new Map(scene.ships.map((ship) => [ship.id, ship]));
  const ships = ids.flatMap((id) => byId.get(id) ?? []);
  const fleet = selection.fleet == null ? null : (scene.fleets ?? []).find((candidate) => candidate.id === selection.fleet);
  let leaderId: Maybe<string> = null;
  if (fleet && selection.wing != null) {
    const wing = fleet.wings.find((candidate) => candidate.id === selection.wing);
    leaderId = wing?.commander ?? wing?.squads.find((squad) => squad.commander)?.commander ?? null;
  } else if (fleet && selection.squad != null) {
    leaderId = fleet.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === selection.squad)?.commander ?? null;
  } else if (fleet) {
    leaderId = fleet.commander;
  }
  const leader = (leaderId ? ships.find((ship) => ship.id === leaderId) : null) ?? ships[0] ?? null;
  if (!ships.length && !problems.length) problems.push('subject: the selection holds no ships');
  return { ships, leader, problems };
}

/**
 * The ships of each team, the largest first (ties in document order). Ships with no team are left out.
 */
export function cinemaTeams(scene: CinemaScene): { readonly team: string; readonly ships: CinemaShip[] }[] {
  const teams = new Map<string, CinemaShip[]>();
  for (const ship of scene.ships) {
    if (ship.team == null) continue;
    const list = teams.get(ship.team) ?? [];
    list.push(ship);
    teams.set(ship.team, list);
  }
  return [...teams.entries()].map(([team, ships]) => ({ team, ships })).sort((a, b) => b.ships.length - a.ships.length);
}

/**
 * Two sides of an engagement.
 */
export interface EngagementFrame extends SubjectFrame {
  /**
   * Each side's centroid; equal when there is only one side.
   */
  readonly a: SceneVector;
  readonly b: SceneVector;
  readonly teams: readonly string[];
}

/**
 * The engagement's frame: every ship of the two teams, forward along the axis from team a's centroid to team b's (the
 * largest teams by default). With fewer than two teams, every ship, forward along the first ship's heading.
 *
 * @param scene - The drawn scene.
 * @param teams - The two teams; default the two with the most ships.
 */
export function engagementFrame(scene: CinemaScene, teams?: readonly [string, string]): Maybe<EngagementFrame> {
  const all = cinemaTeams(scene);
  const picked = teams ? teams.map((team) => all.find((entry) => entry.team === team) ?? { team, ships: [] }) : all.slice(0, 2);
  const sides = picked.filter((side) => side.ships.length);
  const ships = sides.length === 2 ? [...sides[0].ships, ...sides[1].ships] : teams ? sides.flatMap((side) => side.ships) : [...scene.ships];
  if (!ships.length) return null;
  const centroid = (list: readonly CinemaShip[]): SceneVector =>
    scaleVec(
      list.reduce<SceneVector>((sum, ship) => addVec(sum, ship.frameCentre), [0, 0, 0]),
      1 / list.length
    );
  const a = sides.length === 2 ? centroid(sides[0].ships) : centroid(ships);
  const b = sides.length === 2 ? centroid(sides[1].ships) : a;
  const frame = groupFrame(ships);
  const axis = normalizeVec(subVec(b, a));
  let oriented = frame;
  if (axis) {
    const up = Math.abs(dotVec(axis, WORLD_UP)) > NEAR_VERTICAL ? (orthogonalizeVec(frame.forward, axis) ?? [0, 0, 1]) : (orthogonalizeVec(WORLD_UP, axis) ?? [0, 1, 0]);
    oriented = { ...frame, forward: axis, up, starboard: crossVec(axis, up) };
  }
  return { ...oriented, a, b, teams: sides.map((side) => side.team) };
}

/**
 * The nearest centroid of a team other than `team`, or null when there is none.
 */
export function nearestEnemyCentroid(scene: CinemaScene, team: Maybe<string>, from: SceneVector): Maybe<SceneVector> {
  let best: Maybe<SceneVector> = null;
  let bestDistance = Infinity;
  for (const side of cinemaTeams(scene)) {
    if (side.team === team) continue;
    const centre = scaleVec(
      side.ships.reduce<SceneVector>((sum, ship) => addVec(sum, ship.frameCentre), [0, 0, 0]),
      1 / side.ships.length
    );
    const distance = distanceVec(centre, from);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = centre;
    }
  }
  return best;
}

/**
 * The nearest ship to `ship`, preferring another team's.
 */
export function nearestOtherShip(scene: CinemaScene, ship: CinemaShip): Maybe<CinemaShip> {
  let best: Maybe<CinemaShip> = null;
  let bestScore = Infinity;
  for (const other of scene.ships) {
    if (other.id === ship.id) continue;
    const enemy = ship.team != null && other.team != null && other.team !== ship.team;
    const score = distanceVec(other.frameCentre, ship.frameCentre) * (enemy ? 1 : 1e6);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

/**
 * Every hull in the scene as a sphere, ships and objects, less the ids exempted.
 *
 * @param scene - The drawn scene.
 * @param exempt - Hulls left out (a fly-over's anchors).
 */
export function cinemaSpheres(scene: CinemaScene, exempt?: ReadonlySet<string>): CinemaSphere[] {
  const keep = (id: string): boolean => !exempt?.has(id);
  return [...scene.ships.filter((ship) => keep(ship.id)).map((ship) => ({ centre: ship.frameCentre, radius: ship.frameRadius })), ...(scene.objects ?? []).filter((object) => keep(object.id))];
}

/**
 * A waypoint anchor of the scene: a ship's SOF sphere and drawn rotation, or an object's.
 */
export function cinemaAnchor(scene: CinemaScene, ref: { readonly ship?: string; readonly object?: string }): Maybe<WaypointAnchor> {
  let anchor: Maybe<WaypointAnchor> = null;
  if (ref.ship != null) {
    const ship = scene.ships.find((candidate) => candidate.id === ref.ship);
    if (ship) anchor = { centre: ship.frameCentre, rotation: ship.rotation, radius: ship.frameRadius };
  } else if (ref.object != null) {
    anchor = scene.objects?.find((candidate) => candidate.id === ref.object) ?? null;
  }
  return anchor;
}

/**
 * A point `metres` ahead of a frame's centre along its forward axis.
 */
export function aheadOf(frame: SubjectFrame, metres: number): SceneVector {
  return addScaledVec(frame.centre, frame.forward, metres);
}
