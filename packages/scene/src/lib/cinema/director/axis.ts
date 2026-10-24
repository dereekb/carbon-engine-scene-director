/**
 * The axis of action and the 180° rule.
 *
 * - The axis runs from team a's centroid to team b's (the axis teams); with no two teams, along the level velocity of
 *   the followed ship, else of the biggest moving fleet's FC (over AXIS_MIN_SPEED); else there is no axis and no rule.
 *   Starboard is axis × world up.
 * - A shot's side is the screen direction it looks across the line, not where its eye stands (a close eye sits on its
 *   subject's side of the line whichever way it looks): −sign(view · starboard), neutral within AXIS_NEUTRAL_SINE.
 * - A lean (the eye's side of the subject) breaks ties between neutral shots.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../../scene';
import type { CameraPose } from '../pose';
import { addVec, crossVec, dotVec, normalizeVec, scaleVec, subVec, WORLD_UP } from '../vectors';
import type { DirectorPictureFacts } from './interest';
import type { CameraDirectorPicture, DirectorShip } from './picture';

/**
 * |sin| of the angle between a view and the axis below which a shot is neutral (20°).
 */
export const AXIS_NEUTRAL_SINE = 0.34;
/**
 * The axis turning more than this since the side was set resets the side, degrees.
 */
export const AXIS_RESET_DEGREES = 60;
/**
 * A motion axis needs this level speed, m/s.
 */
export const AXIS_MIN_SPEED = 20;

export type DirectorSide = 'starboard' | 'port' | 'neutral';

export interface DirectorAxis {
  readonly kind: 'teams' | 'motion';
  readonly teams?: readonly [string, string];
  /**
   * The ship whose motion sets a motion axis.
   */
  readonly ship?: string;
  readonly forward: SceneVector;
  readonly starboard: SceneVector;
  /**
   * What the axis is about: a change of it resets the side.
   */
  readonly key: string;
}

/**
 * The side the director keeps, and the axis it was set on.
 */
export interface DirectorSideMemory {
  readonly value: 1 | -1;
  readonly forward: SceneVector;
  readonly key: string;
}

function level(vector: Readonly<SceneVector>): SceneVector {
  return [vector[0], 0, vector[2]];
}

function axisFrom(forward: Maybe<SceneVector>, rest: Omit<DirectorAxis, 'forward' | 'starboard'>): Maybe<DirectorAxis> {
  const starboard = forward ? normalizeVec(crossVec(forward, WORLD_UP)) : null;
  return forward && starboard ? { ...rest, forward, starboard } : null;
}

/**
 * The axis of action this boundary.
 *
 * @param picture - The picture.
 * @param facts - Its facts (the axis teams, the landed ships, the followed ship).
 * @returns The axis, or null when there is none.
 */
export function directorAxis(picture: CameraDirectorPicture, facts: DirectorPictureFacts): Maybe<DirectorAxis> {
  let axis: Maybe<DirectorAxis> = null;
  const teams = facts.teams;
  if (teams) {
    const centroid = (team: string): Maybe<SceneVector> => {
      const ships = facts.landed.filter((ship) => ship.team === team);
      return ships.length
        ? scaleVec(
            ships.reduce<SceneVector>((sum, ship) => addVec(sum, ship.position), [0, 0, 0]),
            1 / ships.length
          )
        : null;
    };
    const a = centroid(teams[0]);
    const b = centroid(teams[1]);
    if (a && b) axis = axisFrom(normalizeVec(level(subVec(b, a))), { kind: 'teams', teams, key: `teams:${teams[0]}|${teams[1]}` });
  }
  if (!axis) {
    const moving = (id: Maybe<string>): Maybe<DirectorShip> => {
      const ship = id == null ? null : facts.ships.get(id)?.ship;
      const speed = ship ? Math.hypot(ship.velocity[0], ship.velocity[2]) : 0;
      return ship && !ship.destroyed && !ship.arriving && speed > AXIS_MIN_SPEED ? ship : null;
    };
    let ship = moving(facts.followedShip);
    if (!ship) {
      const sizes = picture.fleets.map((fleet) => ({ fleet, size: facts.landed.filter((candidate) => facts.fleetOf.get(candidate.id) === fleet.id).length }));
      for (const { fleet } of sizes.sort((x, y) => y.size - x.size)) {
        ship = moving(fleet.commander);
        if (ship) break;
      }
    }
    if (ship) axis = axisFrom(normalizeVec(level(ship.velocity)), { kind: 'motion', ship: ship.id, key: `motion:${ship.id}` });
  }
  return axis;
}

/**
 * Which side of the line a view looks across from: +1 starboard, −1 port, 0 neutral.
 *
 * @param pose - The eye and look.
 * @param axis - The axis.
 */
export function viewSideOf(pose: Pick<CameraPose, 'eye' | 'look'>, axis: DirectorAxis): -1 | 0 | 1 {
  const view = normalizeVec(subVec(pose.look, pose.eye));
  const across = view ? dotVec(view, axis.starboard) : 0;
  let side: -1 | 0 | 1 = 0;
  if (across <= -AXIS_NEUTRAL_SINE) side = 1;
  else if (across >= AXIS_NEUTRAL_SINE) side = -1;
  return side;
}

/**
 * A flyby's side, judged at its pass: from its anchored eye to the nearest point of the ship's path.
 *
 * @param eye - The flyby's eye.
 * @param ship - The ship (position and velocity, else its forward).
 * @param axis - The axis.
 */
export function flybyViewSide(eye: SceneVector, ship: Pick<DirectorShip, 'position' | 'velocity' | 'forward'>, axis: DirectorAxis): -1 | 0 | 1 {
  const direction = normalizeVec(ship.velocity) ?? normalizeVec(ship.forward) ?? [0, 0, 1];
  const along = dotVec(subVec(eye, ship.position), direction);
  const nearest = addVec(ship.position, scaleVec(direction, along));
  return viewSideOf({ eye, look: nearest }, axis);
}

/**
 * Which side of the subject the eye stands: +1 starboard, −1 port, 0 on the line.
 */
export function leanOf(eye: SceneVector, centre: SceneVector, axis: DirectorAxis): -1 | 0 | 1 {
  const offset = dotVec(subVec(eye, centre), axis.starboard);
  let lean: -1 | 0 | 1 = 0;
  if (offset > 1e-6) lean = 1;
  else if (offset < -1e-6) lean = -1;
  return lean;
}

export function sideName(value: number): DirectorSide {
  let side: DirectorSide = 'neutral';
  if (value > 0) side = 'starboard';
  else if (value < 0) side = 'port';
  return side;
}

/**
 * Whether the kept side no longer applies: no axis, another axis (teams changed, another ship's motion), or the axis
 * turned more than AXIS_RESET_DEGREES since the side was set.
 */
export function axisResets(side: Maybe<DirectorSideMemory>, axis: Maybe<DirectorAxis>): boolean {
  let resets = false;
  if (side) resets = !axis || side.key !== axis.key || dotVec(side.forward, axis.forward) < Math.cos((AXIS_RESET_DEGREES * Math.PI) / 180);
  return resets;
}
