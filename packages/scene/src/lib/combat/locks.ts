/**
 * EVE's target locks: lock time from scan resolution and signature, and how many locks a ship and its pilot hold.
 */

import type { ShipTargeting } from '../fitting/defense';
import type { PilotContext, SkillReference } from '../stats/pilot';

/**
 * Lock time = LOCK_TIME_CONSTANT / (scanResolution × asinh(signatureRadius)²) seconds.
 */
export const LOCK_TIME_CONSTANT = 40000;

/**
 * The character's own lock limit (type 1373's maxLockedTargets) before skills.
 */
export const CHARACTER_BASE_LOCKS = 2;

/**
 * Each level adds one lock to the pilot's limit.
 */
export const TARGET_MANAGEMENT: SkillReference = { typeID: 3429, name: 'Target Management' };
export const ADVANCED_TARGET_MANAGEMENT: SkillReference = { typeID: 3430, name: 'Advanced Target Management' };

/**
 * Seconds to lock a target: `40000 / (scanResolution(mm) × asinh(signatureRadius(m))²)`.
 *
 * @param scanResolution - The shooter's live scan resolution (mm).
 * @param signatureRadius - The target's live signature radius (m).
 * @returns Seconds; Infinity when either is not positive.
 */
export function lockTime(scanResolution: number, signatureRadius: number): number {
  let seconds = Infinity;
  if (scanResolution > 0 && signatureRadius > 0 && Number.isFinite(scanResolution) && Number.isFinite(signatureRadius)) {
    const asinh = Math.asinh(signatureRadius);
    seconds = LOCK_TIME_CONSTANT / (scanResolution * asinh * asinh);
  }
  return seconds;
}

/**
 * The pilot's lock limit: the character's 2 plus one per level of Target Management and Advanced Target Management
 * (12 for the max-skills pilot).
 *
 * @param pilot - The pilot.
 * @returns The most locks the pilot holds.
 */
export function pilotLockLimit(pilot: PilotContext): number {
  return CHARACTER_BASE_LOCKS + pilot.skillLevel(TARGET_MANAGEMENT) + pilot.skillLevel(ADVANCED_TARGET_MANAGEMENT);
}

/**
 * The most locks a ship holds: its own maxLockedTargets, capped by its pilot's limit.
 *
 * @param targeting - The ship's evaluated targeting numbers.
 * @param pilot - Its pilot.
 * @returns The lock count.
 */
export function shipLockLimit(targeting: Pick<ShipTargeting, 'maxLockedTargets'>, pilot: PilotContext): number {
  return Math.max(0, Math.floor(Math.min(targeting.maxLockedTargets, pilotLockLimit(pilot))));
}
