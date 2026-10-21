/**
 * The skills that move a ship's flight numbers, as EVE's dogma data defines them.
 *
 * Each skill's own effect multiplies its bonus attribute by the skill level, and a
 * second effect applies the result to the ship (or, for Acceleration Control, to the
 * fitted propulsion module) as a postPercent: `value × (1 + bonusPerLevel × level / 100)`.
 *
 * Checked against EVE's typeDogma / dogmaEffects (ESI, Tranquility, 2026-10-21):
 * - Navigation (3449): velocityBonus (315) +5 → effect 394, ship maxVelocity (37)
 * - Evasive Maneuvering (3453): agilityBonus (151) -5 → effect 395, ship agility (70)
 * - Spaceship Command (3327): agilityBonus (151) -2 → effect 395, ship agility (70)
 * - Advanced Spaceship Command (20342): agilityBonus (151) -5 → effect 1614, ship advancedAgility (853);
 *   the hull's effect 1615 then multiplies agility by it. Only capital hulls carry 853.
 * - Capital Ships (20533): agilityBonus (151) -5 → effect 1616, ship advancedCapitalAgility (874);
 *   the hull's effect 1617 then multiplies agility by it. Capitals only.
 * - Acceleration Control (3452): speedFBonus (318) +5 → effect 1176, propulsion modules' (group 46) speedFactor (20)
 *
 * Checked and excluded, since they touch only capacitor or duration: Afterburner (3450),
 * Fuel Conservation (3451), High Speed Maneuvering (3454) and Warp Drive Operation (3455).
 * No skill changes mass or signature radius. Re-check this table when CCP rebalances.
 */

/**
 * What a ship skill changes.
 */
export type ShipSkillTarget = 'maxVelocity' | 'agility' | 'advancedAgility' | 'advancedCapitalAgility' | 'propModSpeedFactor';

export interface ShipSkill {
  /**
   * EVE type id of the skill.
   */
  readonly typeID: number;
  /**
   * English skill name.
   */
  readonly name: string;
  /**
   * Percent change per trained level (negative lowers the value).
   */
  readonly bonusPerLevel: number;
  readonly target: ShipSkillTarget;
}

export const NAVIGATION_SKILL: ShipSkill = { typeID: 3449, name: 'Navigation', bonusPerLevel: 5, target: 'maxVelocity' };

export const EVASIVE_MANEUVERING_SKILL: ShipSkill = { typeID: 3453, name: 'Evasive Maneuvering', bonusPerLevel: -5, target: 'agility' };

export const SPACESHIP_COMMAND_SKILL: ShipSkill = { typeID: 3327, name: 'Spaceship Command', bonusPerLevel: -2, target: 'agility' };

export const ADVANCED_SPACESHIP_COMMAND_SKILL: ShipSkill = { typeID: 20342, name: 'Advanced Spaceship Command', bonusPerLevel: -5, target: 'advancedAgility' };

export const CAPITAL_SHIPS_SKILL: ShipSkill = { typeID: 20533, name: 'Capital Ships', bonusPerLevel: -5, target: 'advancedCapitalAgility' };

export const ACCELERATION_CONTROL_SKILL: ShipSkill = { typeID: 3452, name: 'Acceleration Control', bonusPerLevel: 5, target: 'propModSpeedFactor' };

/**
 * Every skill the stats math applies, in the order it applies them.
 */
export const SHIP_SKILLS: readonly ShipSkill[] = [NAVIGATION_SKILL, EVASIVE_MANEUVERING_SKILL, SPACESHIP_COMMAND_SKILL, ADVANCED_SPACESHIP_COMMAND_SKILL, CAPITAL_SHIPS_SKILL, ACCELERATION_CONTROL_SKILL];
