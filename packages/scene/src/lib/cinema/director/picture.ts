/**
 * What the camera director sees at a Destiny tick boundary: the picture (plain JSON the page builds from the Destiny
 * master and the combat tallies, so decisions are deterministic), and its own CinemaScene for checking candidates.
 *
 * The rig still frames every shot on the drawn samples; the director only needs each candidate's approximate first
 * pose (its validity and which side of the axis it looks from).
 */

import type { Maybe } from '@dereekb/util';
import type { CombatDeathMode } from '../../combat/document';
import type { SceneFleet } from '../../fleets/fleet';
import type { SceneVector } from '../../scene';
import type { CinemaCelestial, CinemaObject, CinemaScene, CinemaShip, CinemaWarp, CinemaWarpPhase } from '../subjects';
import { quatLookRotation, WORLD_UP } from '../vectors';

/**
 * The aspect the director judges framings at (the drawn view's varies; the choice must not).
 */
export const DIRECTOR_ASPECT = 16 / 9;

/**
 * A ship in the picture: master position and motion, health, the combat windows, and what it is doing.
 */
export interface DirectorShip {
  readonly id: string;
  /**
   * The document's name, when it has one (a named ship is more recognisable).
   */
  readonly name?: string;
  readonly team?: string;
  readonly position: SceneVector;
  readonly velocity: SceneVector;
  /**
   * m/s.
   */
  readonly speed: number;
  /**
   * The heading (+Z forward at yaw 0).
   */
  readonly forward: SceneVector;
  /**
   * The EVE (physics) radius, metres.
   */
  readonly radius: number;
  readonly maxVelocity?: number;
  /**
   * HP over max HP, 0..1.
   */
  readonly health?: number;
  /**
   * HP left and max HP (shield + armor + hull).
   */
  readonly remaining?: number;
  readonly total?: number;
  /**
   * HP per second taken over the last 5 s, repaired over the last 5 s, and dealt over the last 3 s.
   */
  readonly pressure?: number;
  readonly repaired?: number;
  readonly dealt?: number;
  /**
   * The ship it locks and shoots.
   */
  readonly target?: string;
  /**
   * The ships that shot it in the last 20 s.
   */
  readonly attackedBy?: readonly string[];
  /**
   * Its auto-repair target.
   */
  readonly repairing?: string;
  readonly propMod?: { readonly kind: 'mwd' | 'ab'; readonly running: boolean };
  /**
   * A Destiny warp in progress (landsIn: seconds to its landing, when known).
   */
  readonly warp?: { readonly phase: CinemaWarpPhase; readonly landing: SceneVector; readonly landsIn?: number };
  /**
   * An arrival by warp not landed yet (warpIn): out of the scene's ships until it lands.
   */
  readonly arriving?: { readonly landing: SceneVector; readonly landsIn?: number };
  /**
   * Destroyed at `tick` (scene ticks), removed from the scene in `removesIn` seconds.
   */
  readonly destroyed?: { readonly tick: number; readonly removesIn: number };
}

/**
 * An arrival group (Arrivals.Report()): who lands together.
 */
export interface DirectorArrival {
  readonly group: string;
  readonly fleet?: string;
  readonly ships: readonly string[];
  readonly state: string;
  /**
   * Seconds to the group's first landing; ≤ 0 once it has landed.
   */
  readonly lands?: number;
}

export interface CameraDirectorPicture {
  /**
   * The scene tick (ticks since the load), the key of every deterministic draw.
   */
  readonly tick: number;
  /**
   * Scene seconds.
   */
  readonly time: number;
  readonly death?: CombatDeathMode;
  /**
   * Every ship with a ball, the lingering dead included, in document order.
   */
  readonly ships: readonly DirectorShip[];
  /**
   * The live fleets (acting commanders).
   */
  readonly fleets: readonly SceneFleet[];
  /**
   * Each fleet's live called primaries (every group's).
   */
  readonly primaries?: Readonly<Record<string, readonly string[]>>;
  readonly arrivals?: readonly DirectorArrival[];
  readonly sunDirection: SceneVector;
  readonly celestials?: readonly CinemaCelestial[];
  readonly objects?: readonly CinemaObject[];
}

/**
 * The director's CinemaScene: ships at their master positions, framed on their EVE radius (built SOF radii depend on
 * build timing), the view at DIRECTOR_ASPECT; arriving ships apart; `warpOf` from the picture.
 *
 * @param picture - The picture.
 * @returns The scene.
 */
export function toDirectorScene(picture: CameraDirectorPicture): CinemaScene {
  const ships: CinemaShip[] = [];
  const arriving: CinemaShip[] = [];
  const warps = new Map<string, CinemaWarp>();
  for (const ship of picture.ships) {
    const cinema: CinemaShip = {
      id: ship.id,
      position: ship.position,
      rotation: quatLookRotation(ship.forward, WORLD_UP),
      velocity: ship.velocity,
      frameCentre: ship.position,
      frameRadius: ship.radius,
      radius: ship.radius,
      ...(ship.team == null ? {} : { team: ship.team })
    };
    if (ship.arriving) {
      arriving.push(cinema);
      warps.set(ship.id, { phase: 'arriving', landing: ship.arriving.landing });
    } else {
      ships.push(cinema);
      if (ship.warp) warps.set(ship.id, { phase: ship.warp.phase, landing: ship.warp.landing });
    }
  }
  return {
    ships,
    arriving,
    warpOf: (id: string): Maybe<CinemaWarp> => warps.get(id) ?? null,
    fleets: picture.fleets,
    sunDirection: picture.sunDirection,
    celestials: picture.celestials ?? [],
    objects: picture.objects ?? [],
    aspect: DIRECTOR_ASPECT
  };
}
