/**
 * A weapon's graphic, as the hub's `GET /weapon?type=<typeID>` serves it from tools-core's `weapons/types/<id>`: the
 * turret `.black` to mount, its slot collection and size, and the SOF faction that paints it; a missile's graphics
 * (`GET /missile`). Plain JSON, no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';

/**
 * tools-core's weapon slot collections: classic turrets, XL turrets (dreadnoughts and titans), launchers, the
 * Triglavian atomic and the EDENCOM chain collections.
 */
export const WEAPON_SLOTS = ['turrets', 'xlTurrets', 'launchers', 'atomics', 'chains'] as const;

export type WeaponSlot = (typeof WEAPON_SLOTS)[number];

export interface WeaponGraphic {
  readonly typeID: number;
  readonly name: string;
  readonly kind: 'turret' | 'launcher';
  readonly slot: WeaponSlot;
  /**
   * 1 small, 2 medium, 3 large, 4 capital.
   */
  readonly size: number;
  /**
   * The weapon's `.black` (an EveTurretSet).
   */
  readonly resPath: string;
  /**
   * The SOF faction the turret graphic is painted with (`brutor`); absent when the graphic names none.
   */
  readonly sofFactionName?: string;
  readonly chargeSize?: number;
  readonly ammunitionTypeIDs?: number[];
}

const RES_PATH_PATTERN = /^res:\/[^\s]+\.black$/iu;

/**
 * Validates a hub `/weapon` answer (the page reads untrusted JSON).
 *
 * @param value - The candidate.
 * @returns The graphic, or null when it is malformed.
 */
export function readWeaponGraphic(value: unknown): Maybe<WeaponGraphic> {
  let graphic: Maybe<WeaponGraphic> = null;
  if (
    isPlainObject(value) &&
    isId(value['typeID']) &&
    typeof value['name'] === 'string' &&
    (value['kind'] === 'turret' || value['kind'] === 'launcher') &&
    (WEAPON_SLOTS as readonly unknown[]).includes(value['slot']) &&
    isId(value['size']) &&
    typeof value['resPath'] === 'string' &&
    RES_PATH_PATTERN.test(value['resPath'])
  ) {
    const faction = value['sofFactionName'];
    const ammunition = Array.isArray(value['ammunitionTypeIDs']) ? value['ammunitionTypeIDs'].filter(isId) : null;
    graphic = {
      typeID: value['typeID'],
      name: value['name'],
      kind: value['kind'],
      slot: value['slot'] as WeaponSlot,
      size: value['size'],
      resPath: value['resPath'],
      ...(typeof faction === 'string' && faction ? { sofFactionName: faction } : {}),
      ...(isId(value['chargeSize']) ? { chargeSize: value['chargeSize'] } : {}),
      ...(ammunition ? { ammunitionTypeIDs: ammunition } : {})
    };
  }
  return graphic;
}

/**
 * A missile's graphics, as the hub's `GET /missile?charge=<id>&launcher=<id>` serves them from tools-core's
 * `weapons/types/<launcher>/ammunition` (the charge's impact effect) and `weapons/projectiles/<id>` (the EveMissile).
 */
export interface MissileGraphic {
  readonly chargeTypeID: number;
  /**
   * The charge's name.
   */
  readonly name: string;
  readonly launcherTypeID: number;
  /**
   * The impact effect's `.black` (an EveEffectRoot2), per size and damage type.
   */
  readonly impactResPath: string;
  readonly projectileGraphicID: number;
  /**
   * The missile's `.black` (an EveMissile), one per size.
   */
  readonly projectileResPath: string;
}

/**
 * Validates a hub `/missile` answer (the page reads untrusted JSON): ids and `res:/….black` paths only.
 *
 * @param value - The candidate.
 * @returns The graphic, or null when it is malformed.
 */
export function readMissileGraphic(value: unknown): Maybe<MissileGraphic> {
  let graphic: Maybe<MissileGraphic> = null;
  if (
    isPlainObject(value) &&
    isId(value['chargeTypeID']) &&
    typeof value['name'] === 'string' &&
    isId(value['launcherTypeID']) &&
    isId(value['projectileGraphicID']) &&
    typeof value['impactResPath'] === 'string' &&
    RES_PATH_PATTERN.test(value['impactResPath']) &&
    typeof value['projectileResPath'] === 'string' &&
    RES_PATH_PATTERN.test(value['projectileResPath'])
  ) {
    graphic = {
      chargeTypeID: value['chargeTypeID'],
      name: value['name'],
      launcherTypeID: value['launcherTypeID'],
      impactResPath: value['impactResPath'],
      projectileGraphicID: value['projectileGraphicID'],
      projectileResPath: value['projectileResPath']
    };
  }
  return graphic;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
