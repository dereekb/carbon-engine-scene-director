/**
 * EVE fleet structure in the scene document: a fleet commander (FC), wings, and squads with a role and an
 * anchor. It is document structure only: validated, edited, saved and reported, but nothing moves because
 * of it yet (Follow the FC flies it later).
 *
 * `team` is independent of fleets: a ship's team is the side it is on (hostility, for combat), while a
 * fleet is who commands it and where it flies. Fleets neither set nor check teams, and a fleet may mix them.
 *
 * Ranges are EVE ranges: metres, surface to surface, as the overview and Destiny's FollowBall measure them.
 */

export const SQUAD_ROLES = ['dps', 'logi', 'tackle', 'ewar', 'boost', 'support'] as const;

export type SquadRole = (typeof SQUAD_ROLES)[number];

/**
 * EVE's "anchor up": the keep range on an anchor when no range is called.
 */
export const DEFAULT_ANCHOR_UP_RANGE = 1000;

/**
 * The keep range a squad holds on its anchor when its anchor gives none. Logi fly separately, about 30 km off.
 */
export const DEFAULT_ANCHOR_RANGES: Readonly<Record<SquadRole, number>> = {
  dps: DEFAULT_ANCHOR_UP_RANGE,
  logi: 30000,
  tackle: DEFAULT_ANCHOR_UP_RANGE,
  ewar: DEFAULT_ANCHOR_UP_RANGE,
  boost: DEFAULT_ANCHOR_UP_RANGE,
  support: DEFAULT_ANCHOR_UP_RANGE
};

/**
 * The commands a ship can hold, in canonical order.
 */
export const FLEET_COMMANDS = ['fleet', 'wing', 'squad'] as const;

export type FleetCommand = (typeof FLEET_COMMANDS)[number];

/**
 * What a squad keeps range on. Both values are stored as written, not filled in, so an omitted value follows
 * later changes to the fleet commander or the squad's role.
 */
export interface SceneSquadAnchor {
  /**
   * The ship the squad anchors on: the FC, a wing commander or a squad member of the same fleet. Omitted: the
   * fleet commander, whoever that is. One of the squad's own members (not the FC) is the squad's lead, as a
   * logi anchor is: it keeps the range on the FC and the other members anchor up on it.
   */
  ship?: string;
  /**
   * Metres, surface to surface. Omitted: DEFAULT_ANCHOR_RANGES for the squad's role.
   */
  range?: number;
}

export interface SceneSquad {
  /**
   * Unique within the fleet, across its wings.
   */
  id: string;
  name?: string;
  role: SquadRole;
  /**
   * One of the squad's members.
   */
  commander?: string;
  /**
   * Ship ids. A ship sits in at most one squad across every fleet.
   */
  members: string[];
  anchor?: SceneSquadAnchor;
}

export interface SceneWing {
  /**
   * Unique within the fleet.
   */
  id: string;
  name?: string;
  /**
   * A ship of this fleet that sits in one of this wing's squads or in none, and commands no other wing.
   */
  commander?: string;
  squads: SceneSquad[];
}

export interface SceneFleet {
  /**
   * Unique in the scene.
   */
  id: string;
  name?: string;
  /**
   * The fleet commander's ship: the root of every anchor chain and the fleet's heading. It sits in one of the
   * fleet's squads, or in none (EVE's FC slot).
   */
  commander: string;
  wings: SceneWing[];
}
