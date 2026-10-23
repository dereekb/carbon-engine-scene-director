import type { SceneVector } from '../scene';
import { missileCombatNumbersOf } from '../combat/missile-numbers';
import { turretCombatNumbersOf } from '../combat/weapon-numbers';
import { evaluateShipDogma } from '../fitting/dogma';
import { parseEftFit } from '../fitting/eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureHullStats, fixtureTypeID } from '../fitting/fitting.spec-helper';
import { toDogmaModules, typeEftFit } from '../fitting/typed-fit';
import { findBakedPropMod } from '../stats/prop-mods';
import { computeShipStats } from '../stats/ship-stats';
import { defaultWeaponsOf } from '../weapons/default-weapons';
import { pilotWeaponOfMissile, pilotWeaponOfTurret, type PilotWeapon } from './application';
import type { PilotContact } from './envelope';
import { agilityTimeConstant } from './kinematics';
import type { PilotTackle, ShipCombatProfile } from './profile';

/**
 * Combat profiles of fixture hulls for the piloting specs: max skills, the hull's default weapons fit (sd-weapons),
 * a baked prop mod, and tackle given by hand.
 */

export interface FixtureProfileConfig {
  readonly hull: string;
  /**
   * A baked prop mod's name.
   */
  readonly propMod?: string;
  readonly tackle?: PilotTackle;
  readonly reps?: ShipCombatProfile['reps'];
}

/**
 * A fixture hull's combat profile.
 *
 * @param config - The hull, its prop mod, tackle and reps.
 * @returns The profile.
 */
export function fixtureProfile(config: FixtureProfileConfig): ShipCombatProfile {
  const { hull, propMod, tackle, reps } = config;
  const typeID = fixtureTypeID(hull);
  const record = DOGMA_FIXTURE.types[typeID];
  const text = defaultWeaponsOf({ hull: record }).text;
  const modules = text ? toDogmaModules(typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE })) : [];
  const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: typeID, modules });
  const weapons: PilotWeapon[] = [];
  for (const key of ship.modules.keys()) {
    const turret = turretCombatNumbersOf(ship, DOGMA_FIXTURE, key);
    const missile = turret ? null : missileCombatNumbersOf(ship, DOGMA_FIXTURE, key);
    if (turret) weapons.push(pilotWeaponOfTurret(turret));
    else if (missile) weapons.push(pilotWeaponOfMissile(missile));
  }
  const hullStats = fixtureHullStats(typeID);
  const fitted = computeShipStats({ hull: hullStats, dogma: { bundle: DOGMA_FIXTURE, hullTypeID: typeID, modules } });
  const off = computeShipStats({ hull: hullStats });
  const baked = propMod ? findBakedPropMod(propMod) : null;
  const on = baked ? computeShipStats({ hull: hullStats, propMod: baked }) : null;
  return {
    flight: { speed: off.maxVelocity, signature: off.signatureRadius, tau: agilityTimeConstant(off.mass, off.agility) },
    propMod: on && baked ? { kind: baked.kind === 'microwarpdrive' ? 'mwd' : 'ab', speed: on.maxVelocity, signature: on.signatureRadius, tau: agilityTimeConstant(on.mass, on.agility) } : null,
    radius: hullStats.radius ?? 50,
    ehp: fitted.defense?.ehp ?? 1000,
    weapons,
    tackle: tackle ?? {},
    lockRange: fitted.targeting?.maxTargetRange ?? 50_000,
    reps: reps ?? []
  };
}

export interface ContactConfig {
  readonly id: string;
  readonly profile: ShipCombatProfile;
  readonly position?: SceneVector;
  readonly velocity?: SceneVector;
  readonly propModOn?: boolean;
  /**
   * HP fraction left (default 1).
   */
  readonly health?: number;
  readonly scrammed?: boolean;
  readonly webFactor?: number;
}

/**
 * A ship in a pilot's picture.
 *
 * @param config - Its id, profile and state.
 * @returns The contact.
 */
export function contactOf(config: ContactConfig): PilotContact {
  const { id, profile, position, velocity, propModOn, health, scrammed, webFactor } = config;
  return { id, profile, position: position ?? [0, 0, 0], velocity: velocity ?? [0, 0, 0], radius: profile.radius, propModOn: propModOn ?? false, remaining: profile.ehp * (health ?? 1), scrammed, webFactor };
}

export const WARP_DISRUPTOR_RANGE = 24_000;

export const WARP_SCRAMBLER_RANGE = 9000;

export const STASIS_WEBIFIER_RANGE = 10_000;

export const RIFTER_PROFILE = fixtureProfile({ hull: 'Rifter', propMod: '5MN Microwarpdrive II' });

export const PUNISHER_PROFILE = fixtureProfile({ hull: 'Punisher', propMod: '5MN Microwarpdrive II' });

export const CARACAL_PROFILE = fixtureProfile({ hull: 'Caracal', propMod: '50MN Microwarpdrive II' });

export const MEGATHRON_PROFILE = fixtureProfile({ hull: 'Megathron', propMod: '500MN Microwarpdrive II' });
