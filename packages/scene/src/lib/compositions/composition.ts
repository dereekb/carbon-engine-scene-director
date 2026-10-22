import type { SquadRole } from '../fleets';

/**
 * A fleet composition: a doctrine fleet written once (an FC, wings, and squads of hull lines with counts, roles
 * and anchors) and dropped into a scene as many times as wanted. Expanding one (expandFleetComposition) yields
 * unique-id ships in formation plus one `fleets` entry of the scene document.
 *
 * Ranges are EVE ranges: metres, surface to surface. A line's `propMod` and `fit` are stored for later entries
 * (prop mods, turrets) and not applied yet.
 */

export const FLEET_COMPOSITION_SCHEMA = 'cjs-fleet/1';

/**
 * EVE's fleet size cap: the FC plus every squad ship.
 */
export const MAX_FLEET_SHIPS = 256;

/**
 * The longest EFT fit text a composition keeps.
 */
export const MAX_FIT_LENGTH = 20_000;

/**
 * The anchor target naming the fleet commander.
 */
export const COMPOSITION_ANCHOR_FC = 'fc';

/**
 * The anchor target naming the squad's own lead (its first ship), which keeps the range on the FC while the rest
 * anchor up on it.
 */
export const COMPOSITION_ANCHOR_LEAD = 'lead';

/**
 * One ship of a composition: the FC, or the template for each ship of a squad line.
 */
export interface CompositionShip {
  /**
   * The EVE type the ship flies as: an exact English type name or a type id. Becomes each ship's `type`. Omitted:
   * the hull its fit's EFT header names.
   */
  hull?: string | number;
  /**
   * SOF DNA (hull:faction:race). The patch operation needs it on every line; the add_fleet_composition tool fills
   * it from the EVE data.
   */
  dna?: string;
  /**
   * The hull's EVE radius (the SDE `radius`) in metres, for spacing. The add_fleet_composition tool fills it.
   */
  radius?: number;
  /**
   * The ship name base: the FC's name, or each line ship's name before its number.
   */
  name?: string;
  /**
   * Stored for the prop mods entry: a module type name, "mwd" / "ab", or a module type id.
   */
  propMod?: string | number;
  /**
   * A key of the composition's `fits`. Stored for the turrets entry.
   */
  fit?: string;
}

export interface CompositionShipLine extends CompositionShip {
  /**
   * How many ships the line adds. Default 1.
   */
  count?: number;
}

/**
 * What a squad keeps range on, as written.
 */
export interface CompositionAnchor {
  /**
   * `fc`, `lead` (the squad's first ship keeps the range on the FC, the rest anchor up on it) or another squad's id
   * (its first ship). Default: `lead` for logi, `fc` for every other role.
   */
  on?: string;
  /**
   * Metres, surface to surface. Omitted: the scene's default range for the squad's role.
   */
  range?: number;
}

export interface CompositionSquad {
  /**
   * Unique across the composition's wings; `fc` and `lead` are reserved.
   */
  id: string;
  name?: string;
  role: SquadRole;
  anchor?: CompositionAnchor;
  ships: CompositionShipLine[];
}

export interface CompositionWing {
  /**
   * Unique in the composition.
   */
  id: string;
  name?: string;
  squads: CompositionSquad[];
}

export interface FleetComposition {
  schema: typeof FLEET_COMPOSITION_SCHEMA;
  /**
   * The default fleet id and ship id prefix.
   */
  id: string;
  /**
   * The fleet's name in the scene, and the composition's saved name.
   */
  name?: string;
  description?: string;
  /**
   * Where the doctrine comes from, usually a URL.
   */
  source?: string;
  /**
   * The fleet commander, in EVE's fleet commander slot (in no squad).
   */
  commander: CompositionShip;
  wings: CompositionWing[];
  /**
   * EFT fit text by key, for the lines' `fit`.
   */
  fits?: Record<string, string>;
}
