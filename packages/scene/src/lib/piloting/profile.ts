import type { Maybe } from '@dereekb/util';
import { maxWeaponReachOf, type PilotWeapon } from './application';

/**
 * A ship's plain combat profile: what the piloting math needs to know of a ship, with no runtime or dogma behind it.
 * The page builds it from the ship's flight, modules and damage model; specs build it from the dogma fixture.
 */

export type PilotPropModKind = 'mwd' | 'ab';

/**
 * How a ship flies in one prop mod state.
 */
export interface PilotFlight {
  /**
   * Max velocity (m/s).
   */
  readonly speed: number;
  /**
   * Signature radius (m).
   */
  readonly signature: number;
  /**
   * τ (s): mass × agility / 1e6.
   */
  readonly tau: number;
}

export interface PilotPropMod extends PilotFlight {
  readonly kind: PilotPropModKind;
}

/**
 * Tackle the ship fits, by its activation range (m). A scram also blocks its target's MWD.
 */
export interface PilotTackle {
  readonly point?: Maybe<number>;
  readonly scram?: Maybe<number>;
  readonly web?: Maybe<number>;
  /**
   * The web's speed multiplier on its target (0.4 for a −60 % web).
   */
  readonly webFactor?: Maybe<number>;
}

export type PilotRepairLayer = 'shield' | 'armor' | 'hull';

/**
 * A remote repairer.
 */
export interface PilotRemoteRepair {
  readonly layer: PilotRepairLayer;
  /**
   * HP per second it repairs at full effectiveness.
   */
  readonly hps: number;
  readonly optimal: number;
  readonly falloff: number;
}

export interface ShipCombatProfile {
  /**
   * The prop mod off.
   */
  readonly flight: PilotFlight;
  /**
   * The prop mod on; null without one.
   */
  readonly propMod?: Maybe<PilotPropMod>;
  readonly radius: number;
  /**
   * Effective HP at full health against even damage.
   */
  readonly ehp: number;
  readonly weapons: readonly PilotWeapon[];
  readonly tackle: PilotTackle;
  /**
   * Max targeting range (m).
   */
  readonly lockRange: number;
  readonly reps: readonly PilotRemoteRepair[];
}

/**
 * Whether a ship's prop mod can run: a scrammed ship's MWD cannot (an AB still can).
 *
 * @param profile - The ship.
 * @param scrammed - Whether a scram holds it.
 * @returns True when it fits a prop mod that can run.
 */
export function canRunPropModOf(profile: Pick<ShipCombatProfile, 'propMod'>, scrammed = false): boolean {
  return profile.propMod != null && !(scrammed && profile.propMod.kind === 'mwd');
}

/**
 * How a ship flies with its prop mod on or off.
 *
 * @param profile - The ship.
 * @param propModOn - Whether its prop mod runs (ignored when it cannot).
 * @param scrammed - Whether a scram holds it (an MWD then stays off).
 * @returns Speed, signature and τ.
 */
export function flightOf(profile: Pick<ShipCombatProfile, 'flight' | 'propMod'>, propModOn: boolean, scrammed = false): PilotFlight {
  return propModOn && canRunPropModOf(profile, scrammed) && profile.propMod ? profile.propMod : profile.flight;
}

/**
 * A ship's top speed: its prop mod on when it can run, times a web's factor.
 *
 * @param profile - The ship.
 * @param scrammed - Whether a scram holds it.
 * @param webFactor - The speed multiplier of the webs on it (1 for none).
 * @returns Speed (m/s).
 */
export function maxSpeedOf(profile: Pick<ShipCombatProfile, 'flight' | 'propMod'>, scrammed = false, webFactor = 1): number {
  return flightOf(profile, true, scrammed).speed * webFactor;
}

/**
 * How far a ship holds a target: its point, else its scram (0 without either).
 *
 * @param tackle - Its tackle.
 * @returns Metres.
 */
export function tackleRangeOf(tackle: PilotTackle): number {
  return Math.max(tackle.point ?? 0, tackle.scram ?? 0);
}

/**
 * How far a ship's weapons reach, capped at its lock range.
 *
 * @param profile - The ship.
 * @returns Metres.
 */
export function shipReachOf(profile: Pick<ShipCombatProfile, 'weapons' | 'lockRange'>): number {
  return Math.min(profile.lockRange, maxWeaponReachOf(profile.weapons));
}

/**
 * Remote repair reach: an armor or hull repairer's optimal, a shield repairer's optimal + ½ falloff (the shortest of a
 * ship's repairers).
 *
 * @param reps - The repairers.
 * @returns Metres; 0 without repairers.
 */
export function repairReachOf(reps: readonly PilotRemoteRepair[]): number {
  const reaches = reps.map((rep) => (rep.layer === 'shield' ? rep.optimal + rep.falloff / 2 : rep.optimal));
  return reaches.length ? Math.min(...reaches) : 0;
}

/**
 * Remote repair at a distance: EVE's falloff curve `0.5 ^ (max(0, d − optimal) / falloff)²` on each repairer.
 *
 * @param reps - The repairers.
 * @param distance - Surface distance (m).
 * @returns HP per second.
 */
export function remoteRepairAt(reps: readonly PilotRemoteRepair[], distance: number): number {
  return reps.reduce((sum, rep) => {
    const beyond = Math.max(0, distance - rep.optimal);
    const effectiveness = beyond === 0 ? 1 : rep.falloff > 0 ? 0.5 ** ((beyond / rep.falloff) ** 2) : 0;
    return sum + rep.hps * effectiveness;
  }, 0);
}
