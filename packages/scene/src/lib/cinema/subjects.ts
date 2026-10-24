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

/**
 * A ship's warp phases as the camera reads them: Destiny's ShipWarp.phase, or `arriving` for a ship still landing from
 * warp (parked off-grid, scheduled or in its warp-in: the arrival report).
 */
export const CINEMA_WARP_PHASES = ['aligning', 'warping', 'exiting', 'landed', 'arriving'] as const;
export type CinemaWarpPhase = (typeof CINEMA_WARP_PHASES)[number];

/**
 * Why a hardpoint other than warp-landing has no pose on a subject that has not landed yet.
 */
export const CINEMA_ARRIVING_NOTE = 'still arriving by warp: play warp-in, or wait for it to land';

/**
 * A ship's warp: its phase and where it lands (Destiny's landing point once in warp, the estimate while aligning, an
 * arrival's landing), origin-relative scene metres.
 */
export interface CinemaWarp {
  readonly phase: CinemaWarpPhase;
  readonly landing: SceneVector;
}

export interface CinemaScene {
  /**
   * The ships on grid: every drawn ship but those still arriving.
   */
  readonly ships: readonly CinemaShip[];
  /**
   * Ships still arriving by warp (parked off-grid, scheduled or in their warp-in), as drawn: out of `ships`, so no
   * framing, clearance or team counts them until they land; only warp-landing frames them (at their landings).
   */
  readonly arriving?: readonly CinemaShip[];
  /**
   * The drawn spheres of arriving ships in their warp-in within the hidden distance of their landings: the clip planes
   * reach them (so the streak in is drawn), nothing else does.
   */
  readonly incoming?: readonly CinemaSphere[];
  /**
   * A ship's warp, or null when it is not warping: read lazily, only by the warp-landing hardpoint.
   */
  readonly warpOf?: (id: string) => Maybe<CinemaWarp>;
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
  /**
   * A memo for a scene read many times unchanged (the camera director resolves dozens of hardpoints on one scene per
   * step): when set, team, group and engagement selections are computed once per key. Never set it on a scene that
   * changes after it is built.
   */
  readonly memo?: Map<string, unknown>;
}

/**
 * `compute()` once per key on a scene with a memo; every time on one without.
 *
 * @param scene - The scene.
 * @param key - What is computed, with its arguments.
 * @param compute - The computation.
 */
export function cinemaMemo<T>(scene: CinemaScene, key: string, compute: () => T): T {
  const memo = scene.memo;
  let value: T;
  if (!memo) value = compute();
  else if (memo.has(key)) value = memo.get(key) as T;
  else {
    value = compute();
    memo.set(key, value);
  }
  return value;
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
  /**
   * The selected ships still arriving by warp (in `ships` too with `arriving: true`).
   */
  readonly arriving: CinemaShip[];
  readonly problems: string[];
}

/**
 * The drawn ships of a fleet selection (fleets/selection.ts) and its leader: the fleet's commander, the wing's
 * commander, the squad's commander, else the first ship selected. Ships still arriving by warp are left out of `ships`
 * unless `arriving` (warp-landing frames them); a selection of arriving ships only has the CINEMA_ARRIVING_NOTE
 * problem.
 *
 * @param scene - The drawn scene.
 * @param selection - The fleet, wing, squad or ships.
 * @param options - `arriving`: keep ships still arriving by warp in `ships`.
 */
export function selectCinemaGroup(scene: CinemaScene, selection: FleetSelection, { arriving = false }: { readonly arriving?: boolean } = {}): SelectedCinemaGroup {
  return cinemaMemo(scene, `group|${arriving}|${cinemaSelectionKey(selection)}`, () => computeCinemaGroup(scene, selection, arriving));
}

/**
 * A selection's memo key.
 */
export function cinemaSelectionKey(selection: FleetSelection): string {
  return `${selection.fleet ?? ''}|${selection.wing ?? ''}|${selection.squad ?? ''}|${(selection.ships ?? []).join(',')}`;
}

function computeCinemaGroup(scene: CinemaScene, selection: FleetSelection, arriving: boolean): SelectedCinemaGroup {
  const { pool, byId, landed } = cinemaMemo(scene, 'pool', () => {
    const all = [...scene.ships, ...(scene.arriving ?? [])];
    return { pool: all, byId: new Map(all.map((ship) => [ship.id, ship])), landed: new Set(scene.ships.map((ship) => ship.id)) };
  });
  const { ships: ids, problems } = selectFleetShips({ ships: pool, fleets: scene.fleets ?? [] }, selection, 'subject');
  const selected = ids.flatMap((id) => byId.get(id) ?? []);
  const incoming = selected.filter((ship) => !landed.has(ship.id));
  const ships = arriving ? selected : selected.filter((ship) => landed.has(ship.id));
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
  if (!ships.length && !problems.length) problems.push(incoming.length ? CINEMA_ARRIVING_NOTE : 'subject: the selection holds no ships');
  return { ships, leader, arriving: incoming, problems };
}

/**
 * The ships of each team, the largest first (ties in document order). Ships with no team are left out.
 */
export function cinemaTeams(scene: CinemaScene): { readonly team: string; readonly ships: CinemaShip[] }[] {
  return cinemaMemo(scene, 'teams', () => computeCinemaTeams(scene));
}

function computeCinemaTeams(scene: CinemaScene): { readonly team: string; readonly ships: CinemaShip[] }[] {
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
  return cinemaMemo(scene, `engagement|${teams?.join('|') ?? ''}`, () => computeEngagementFrame(scene, teams));
}

function computeEngagementFrame(scene: CinemaScene, teams?: readonly [string, string]): Maybe<EngagementFrame> {
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
  const centroids = cinemaMemo(scene, 'team-centroids', () =>
    cinemaTeams(scene).map((side) => ({
      team: side.team,
      centre: scaleVec(
        side.ships.reduce<SceneVector>((sum, ship) => addVec(sum, ship.frameCentre), [0, 0, 0]),
        1 / side.ships.length
      )
    }))
  );
  for (const { team: other, centre } of centroids) {
    if (other === team) continue;
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

/**
 * A landmark's radius when its celestial gives none, metres.
 */
export const DEFAULT_LANDMARK_RADIUS = 1000;

/**
 * A landmark subject: a scene object or a location celestial.
 */
export interface CinemaLandmark {
  readonly kind: 'object' | 'celestial';
  readonly id: string | number;
  readonly name?: string;
  readonly centre: SceneVector;
  readonly radius: number;
  /**
   * An object's facing (its rotation's forward); celestials have none.
   */
  readonly forward?: SceneVector;
}

/**
 * A landmark by object id or by celestial (an id, "celestial:<id>" or an exact name, case-insensitive).
 */
export function findLandmark(scene: CinemaScene, ref: { readonly object?: string; readonly celestial?: string | number }): Maybe<CinemaLandmark> {
  let landmark: Maybe<CinemaLandmark> = null;
  if (ref.object != null) {
    const object = scene.objects?.find((candidate) => candidate.id === ref.object);
    if (object) landmark = { kind: 'object', id: object.id, centre: [...object.centre], radius: object.radius, forward: headingAxes(object.rotation).forward };
  } else if (ref.celestial != null) {
    const celestials = scene.celestials ?? [];
    let found: Maybe<CinemaCelestial> = null;
    if (typeof ref.celestial === 'number') found = celestials.find((candidate) => candidate.id === ref.celestial);
    else {
      const text = ref.celestial.trim().replace(/^celestial:/u, '');
      const id = /^\d+$/u.test(text) ? Number(text) : null;
      found = celestials.find((candidate) => candidate.id === id) ?? celestials.find((candidate) => candidate.name.toLowerCase() === text.toLowerCase());
    }
    if (found) landmark = { kind: 'celestial', id: found.id, name: found.name, centre: [...found.position], radius: found.radius > 0 ? found.radius : DEFAULT_LANDMARK_RADIUS };
  }
  return landmark;
}

/**
 * Where the scene's action is: the engagement frame's centre and radius, or the origin with radius 0 when there are no
 * ships.
 */
export function sceneFocus(scene: CinemaScene, teams?: readonly [string, string]): { readonly centre: SceneVector; readonly radius: number; readonly ships: boolean } {
  const frame = engagementFrame(scene, teams);
  return frame ? { centre: frame.centre, radius: frame.radius, ships: true } : { centre: [0, 0, 0], radius: 0, ships: false };
}

/**
 * A landmark's frame: forward from the landmark toward the scene's focus (else its own facing, else +Z), up squared from
 * world up, extents ±r.
 */
export function landmarkFrame(landmark: CinemaLandmark, focus: SceneVector): SubjectFrame {
  const toward = normalizeVec(subVec(focus, landmark.centre)) ?? (landmark.forward ? normalizeVec(landmark.forward) : null) ?? [0, 0, 1];
  const up = Math.abs(dotVec(toward, WORLD_UP)) > NEAR_VERTICAL ? (orthogonalizeVec([0, 0, 1], toward) ?? [1, 0, 0]) : (orthogonalizeVec(WORLD_UP, toward) ?? [0, 1, 0]);
  const r = landmark.radius;
  return { centre: [...landmark.centre], radius: r, forward: toward, up, starboard: crossVec(toward, up), velocity: [0, 0, 0], extents: { forward: [-r, r], starboard: [-r, r], up: [-r, r] } };
}
