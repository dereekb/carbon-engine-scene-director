import type { Maybe, SuggestedString } from '@dereekb/util';
import type { SceneVector } from '../scene';

/**
 * A stance: how a pilot (or a group's leader) flies against its focus. The document's `stance` on fleets, wings,
 * squads and ships, and the live stance orders, resolve to one PilotStance per piloted ship (sd-piloting).
 */

export const SHIP_STANCE_TYPES = ['in-line', 'hold', 'orbit', 'keep-at-range', 'approach', 'kite', 'brawl', 'snipe', 'tackle', 'support', 'align', 'auto'] as const;

export type ShipStanceType = (typeof SHIP_STANCE_TYPES)[number];

/**
 * The stance types that pick their own range from both sides' numbers (idealRangeOf).
 */
export const IDEAL_STANCE_TYPES = ['kite', 'brawl', 'snipe', 'tackle', 'support'] as const;

export type IdealStanceType = (typeof IDEAL_STANCE_TYPES)[number];

/**
 * The deterministic levers: the pilot flies the order on its `on` ship inside its range band.
 */
export const LEVER_STANCE_TYPES = ['orbit', 'keep-at-range', 'approach'] as const;

export type LeverStanceType = (typeof LEVER_STANCE_TYPES)[number];

export const SHIP_STANCE_RANGE_KEYWORDS = ['ideal', 'optimal', 'falloff', 'lock', 'point', 'scram', 'web', 'reps'] as const;

export type ShipStanceRangeKeyword = (typeof SHIP_STANCE_RANGE_KEYWORDS)[number];

/**
 * Metres, a [min, max] band, or a keyword the pilot measures from its own numbers.
 */
export type ShipStanceRange = number | readonly [number, number] | ShipStanceRangeKeyword;

export const SHIP_STANCE_PROP_MODS = ['never', 'closing', 'always', 'auto'] as const;

export type ShipStancePropMods = (typeof SHIP_STANCE_PROP_MODS)[number];

export const SHIP_STANCE_FORMATIONS = ['in-line', 'loose'] as const;

export type ShipStanceFormation = (typeof SHIP_STANCE_FORMATIONS)[number];

/**
 * What a stance flies on: `focus` (the ship's own target, else its group's called primary, else the nearest hostile),
 * a ship id, or a squad / wing (its leader).
 */
export type ShipStanceOn = SuggestedString<'focus'> | { readonly squad: string } | { readonly wing: string };

/**
 * Where an `align` stance points: a ship or object id, `celestial:<id>`, a place name (resolved on the page as order
 * targets are), or a point (origin-relative metres). Unset: away from the hostiles.
 */
export type ShipStanceTo = string | SceneVector;

/**
 * An align stance counts as aligned once the ship's speed along its line reaches this share of its top speed now
 * (Destiny's warp threshold): a warp given then leaves at once.
 */
export const ALIGNED_SPEED_SHARE = 0.75;

/**
 * A stance as written on a fleet, wing, squad or ship (every key optional; the levels resolve key by key).
 */
export interface ShipStance {
  readonly type?: ShipStanceType;
  readonly on?: ShipStanceOn;
  /**
   * `align`: where it points (travels with type, as on and range do).
   */
  readonly to?: ShipStanceTo;
  readonly range?: ShipStanceRange;
  readonly propMods?: ShipStancePropMods;
  readonly formation?: ShipStanceFormation;
  /**
   * The HP fraction to burn out at.
   */
  readonly disengage?: number;
}

/**
 * The HP fraction a pilot burns out at when its stance sets none.
 */
export const DEFAULT_DISENGAGE = 0.35;

/**
 * A disengaged pilot re-engages this far above its disengage fraction.
 */
export const REENGAGE_MARGIN = 0.15;

/**
 * The stance one pilot flies: the type resolved (never `in-line`), what it flies on as a ship id (null: its focus),
 * the range, prop mods and disengage fraction.
 */
export interface PilotStance {
  readonly type: Exclude<ShipStanceType, 'in-line'>;
  /**
   * The ship the stance flies on (a lever's anchor, a support's friend); null flies on the focus.
   */
  readonly on?: Maybe<string>;
  /**
   * `align`: where it points, as written (the page resolves it to a point for the pilot's picture).
   */
  readonly to?: Maybe<ShipStanceTo>;
  readonly range: ShipStanceRange;
  readonly propMods: ShipStancePropMods;
  readonly disengage: number;
}

/**
 * Whether a stance type picks its own range.
 *
 * @param type - The stance type.
 * @returns True for kite, brawl, snipe, tackle and support.
 */
export function isIdealStanceType(type: string): type is IdealStanceType {
  return (IDEAL_STANCE_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a stance type is a deterministic lever.
 *
 * @param type - The stance type.
 * @returns True for orbit, keep-at-range and approach.
 */
export function isLeverStanceType(type: string): type is LeverStanceType {
  return (LEVER_STANCE_TYPES as readonly string[]).includes(type);
}
