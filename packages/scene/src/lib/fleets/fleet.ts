import type { SceneAutoRepair } from '../logi/auto-repair';

/**
 * EVE fleet structure in the scene document: a fleet commander (FC), wings, and squads with a role and an
 * anchor. It is validated, edited, saved and reported here, and the page flies it (Follow the FC): every member
 * but the FC keeps range on its resolved anchor in its formation slot (following.ts), behind the FC's heading.
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
  /**
   * The anchor a broken-off squad regroups to: what its anchor was when order_fleet broke it off (`{}` for the
   * defaults). Not part of the anchor rules (toFleetAnchors ignores it); order_fleet regroup restores it and clears it.
   */
  home?: SceneSquadAnchor;
  /**
   * The group's opening called targets: ship or authored-object ids in kill order (fleets/targets.ts), the call a load
   * starts with; order_fleet's targets order then calls live. The first live entry is its primary, the live entries
   * after it its queue. Omitted when it calls none.
   */
  targets?: string[];
  /**
   * The group's logi auto-repair settings (logi/auto-repair.ts): each key inherits from the group above when omitted.
   */
  autoRepair?: SceneAutoRepair;
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
  /**
   * The group's opening called targets: ship or authored-object ids in kill order (fleets/targets.ts), the call a load
   * starts with; order_fleet's targets order then calls live. The first live entry is its primary, the live entries
   * after it its queue. Omitted when it calls none.
   */
  targets?: string[];
  /**
   * The group's logi auto-repair settings (logi/auto-repair.ts): each key inherits from the group above when omitted.
   */
  autoRepair?: SceneAutoRepair;
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
  /**
   * The fleet's personality (personalities/personality.ts): a built-in name or a key of the document's
   * `personalities`. The page's brain runs a personality fleet's fight: calls, succession, movement and prop mods.
   * Omitted: the fleet does only what it is told.
   */
  personality?: string;
  /**
   * The group's opening called targets: ship or authored-object ids in kill order (fleets/targets.ts), the call a load
   * starts with; order_fleet's targets order then calls live. The first live entry is its primary, the live entries
   * after it its queue. Omitted when it calls none.
   */
  targets?: string[];
  /**
   * The group's logi auto-repair settings (logi/auto-repair.ts): each key inherits from the group above when omitted.
   */
  autoRepair?: SceneAutoRepair;
  wings: SceneWing[];
}
