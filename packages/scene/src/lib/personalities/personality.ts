import { SQUAD_ROLES } from '../fleets/fleet';

/**
 * A fleet personality: an FC's playstyle, written once and picked per fleet (`fleets[].personality`). The page's brain
 * (fleet-commanders) runs a personality fleet's fight from it: who commands and how well, who takes over when the FC
 * dies and how long that takes, how fast pilots answer, when the fleet opens fire, what it calls and in what order,
 * how it moves and when it runs its prop mods. Every lever it pulls is a tool call a model can make.
 *
 * A template as written sets any subset of its sections and fields; `extends` names the template it overrides (a
 * built-in or a key of the document's `personalities`), and every unset field takes its base's, down to `line`
 * (resolveFleetPersonality). Times are seconds, ranges metres, abilities and reactions 0..1 (higher is better).
 */

export const FLEET_PERSONALITY_SCHEMA = 'cjs-fleet-personality/1';

/**
 * The root personality every chain ends at: `line` is complete, so a resolved personality has every field.
 */
export const DEFAULT_FLEET_PERSONALITY = 'line';

/**
 * When the fleet opens fire: at the first hostile within lock reach, once a candidate is within targeting reach, or
 * only once a hostile shoots a member.
 */
export const FLEET_ENGAGE_RULES = ['on-sight', 'in-range', 'when-attacked'] as const;
export type FleetEngageRule = (typeof FLEET_ENGAGE_RULES)[number];

/**
 * The priority tiers a call ranks hostiles by: `fc` is an enemy fleet commander, the rest a hostile's squad role (a
 * ship in no fleet counts as `dps`).
 */
export const FLEET_TARGET_ROLES = ['fc', ...SQUAD_ROLES] as const;
export type FleetTargetRole = (typeof FLEET_TARGET_ROLES)[number];

/**
 * How a call orders hostiles of one tier: nearest first, least HP left, most damaged (lowest HP fraction), most HP
 * left, most paper DPS, commanders (FC, wing, squad) first, fastest, biggest or smallest signature.
 */
export const FLEET_TARGET_PREFERENCES = ['nearest', 'weakest', 'damaged', 'toughest', 'dangerous', 'commander', 'fastest', 'biggest', 'smallest'] as const;
export type FleetTargetPreference = (typeof FLEET_TARGET_PREFERENCES)[number];

/**
 * A fleet range by its guns: the median lock range, turret optimal, or turret optimal + falloff (missiles count their
 * mean flight range for both).
 */
export const FLEET_REACHES = ['lock', 'optimal', 'falloff'] as const;
export type FleetReachName = (typeof FLEET_REACHES)[number];

/**
 * A fleet range: a named reach or metres.
 */
export type FleetReach = FleetReachName | number;

/**
 * When a call moves off its primary: only once it dies (or leaves reach), or also when a higher tier comes into reach.
 */
export const FLEET_TARGET_SWITCHES = ['on-kill', 'on-better'] as const;
export type FleetTargetSwitch = (typeof FLEET_TARGET_SWITCHES)[number];

/**
 * How the fleet moves on its focus (the primary, else the nearest hostile): close to range and hold it, keep range
 * and back off inside it, hold range from afar, or stay where it is.
 */
export const FLEET_STANCES = ['brawl', 'kite', 'snipe', 'hold'] as const;
export type FleetStance = (typeof FLEET_STANCES)[number];

/**
 * When the fleet runs its prop mods: never, while closing on its range, or always once engaged or closing.
 */
export const FLEET_PROP_MOD_RULES = ['never', 'closing', 'always'] as const;
export type FleetPropModRule = (typeof FLEET_PROP_MOD_RULES)[number];

/**
 * The succession protocol's steps, tried in order: the most able FC-capable member, the command chain (wing
 * commanders, then squad commanders), anyone (fleet order).
 */
export const FLEET_SUCCESSION_STEPS = ['most-able', 'chain', 'anyone'] as const;
export type FleetSuccessionStep = (typeof FLEET_SUCCESSION_STEPS)[number];

/**
 * The shortest handover: a designate never takes command sooner than this many seconds after the FC dies.
 */
export const MIN_FLEET_HANDOVER = 2;

export const MAX_FLEET_HANDOVER = 300;

export const MAX_FLEET_BACKUPS = 10;

export const MAX_FLEET_TARGET_QUEUE = 10;

/**
 * An ability or reaction: one value, or `[lo, hi]` for seeded draws between them.
 */
export type FleetTraitRange = number | readonly [number, number];

export interface FleetPersonalityCommand {
  /**
   * The FC's and the backups' command ability, when their pilots set none. 1 decides at once; 0 waits up to 10 s.
   */
  ability: FleetTraitRange;
  /**
   * How many members besides the FC are FC-capable (wing commanders, squad commanders, boost squads' members, then
   * seeded members), drawing `ability` when their pilots set none.
   */
  backups: number;
  /**
   * The succession protocol's steps in order; a step no live member meets falls to the next.
   */
  succession: FleetSuccessionStep[];
  /**
   * The longest handover in seconds, for a designate of ability 0; ability 1 takes MIN_FLEET_HANDOVER.
   */
  handover: number;
}

export interface FleetPersonalityPilots {
  /**
   * Every member's reaction, when its pilot sets none. 1 answers at once; 0 up to 10 s late.
   */
  reaction: FleetTraitRange;
}

export interface FleetPersonalityTargeting {
  /**
   * The tiers in call order; a role left out ranks after every listed one.
   */
  priority: FleetTargetRole[];
  prefer: FleetTargetPreference;
  /**
   * How far out a hostile can be called.
   */
  reach: FleetReach;
  /**
   * How many targets the call queues behind its primary.
   */
  queue: number;
  switch: FleetTargetSwitch;
  /**
   * Whether the FC calls targets once engaged. False: it calls none and clears its own call once (a fleet left to
   * free fire, or to a model's or the console's calls).
   */
  calls: boolean;
  /**
   * Whether the fleet turns free fire on once engaged: a member with no live call picks the nearest hostile it can
   * reach. False: the brain turns it off when it finds it on (a lever no model took).
   */
  freeFire: boolean;
}

export interface FleetPersonalityMovement {
  stance: FleetStance;
  /**
   * The range the stance keeps on its focus.
   */
  range: FleetReach;
  propMods: FleetPropModRule;
}

/**
 * A template as written: every section and field optional except `id`.
 */
export interface FleetPersonality {
  schema: typeof FLEET_PERSONALITY_SCHEMA;
  /**
   * The template's name in the library: a built-in name, a saved template's file name, or the document key it sits
   * under.
   */
  id: string;
  /**
   * The template it overrides. Omitted: `line` (the root itself extends nothing).
   */
  extends?: string;
  name?: string;
  /**
   * When to pick it, in a sentence a model choosing a personality reads.
   */
  description?: string;
  command?: Partial<FleetPersonalityCommand>;
  pilots?: Partial<FleetPersonalityPilots>;
  engage?: FleetEngageRule;
  targeting?: Partial<FleetPersonalityTargeting>;
  movement?: Partial<FleetPersonalityMovement>;
}

/**
 * A template with its `extends` chain merged: every field set.
 */
export interface ResolvedFleetPersonality {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /**
   * The chain from this template to the root, this one first (`["brawler", "line"]`).
   */
  readonly chain: readonly string[];
  readonly command: Readonly<FleetPersonalityCommand>;
  readonly pilots: Readonly<FleetPersonalityPilots>;
  readonly engage: FleetEngageRule;
  readonly targeting: Readonly<FleetPersonalityTargeting>;
  readonly movement: Readonly<FleetPersonalityMovement>;
}
