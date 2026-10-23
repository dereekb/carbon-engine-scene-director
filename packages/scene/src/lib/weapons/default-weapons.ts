/**
 * Default weapons: the guns a ship without a fit carries. One Tech II turret per turret hardpoint, picked by the hull's
 * size and race, each loaded with a matching Tech I charge; a hull with launcher hardpoints only gets launchers, each
 * loaded with the race's Tech I missile (default-missiles.ts). The result is EFT text, so a default fit runs through the same pipeline
 * as a document fit (names, dogma, activation, get_state). Names checked against SDE 3632936.
 */

import type { Maybe } from '@dereekb/util';
import type { DogmaTypeRecord } from '../fitting/dogma-bundle';
import { HULL_SIZE_CLASSES, type HullSizeClass, readRigSize, type RigSize } from '../stats/prop-mods';
import { DEFAULT_MISSILES, missileDamageTypeOf } from './default-missiles';

/**
 * The turret families a default fit picks from.
 */
export const WEAPON_FAMILIES = ['projectile', 'laser', 'rail', 'blaster', 'disintegrator', 'vorton'] as const;

export type WeaponFamily = (typeof WEAPON_FAMILIES)[number];

/**
 * An EVE type a default fit names.
 */
export interface DefaultWeaponType {
  readonly name: string;
  readonly typeID: number;
}

/**
 * A default turret and the charge it loads.
 */
export interface DefaultTurret {
  readonly turret: DefaultWeaponType;
  readonly charge: DefaultWeaponType;
}

/**
 * The default turret of each family and size; null where the family has no gun of that size (no XL vorton projector).
 */
export const DEFAULT_TURRETS: Readonly<Record<WeaponFamily, Readonly<Record<HullSizeClass, Maybe<DefaultTurret>>>>> = {
  projectile: {
    S: { turret: { name: '200mm AutoCannon II', typeID: 2889 }, charge: { name: 'EMP S', typeID: 185 } },
    M: { turret: { name: '425mm AutoCannon II', typeID: 2913 }, charge: { name: 'EMP M', typeID: 193 } },
    L: { turret: { name: '800mm Repeating Cannon II', typeID: 2929 }, charge: { name: 'EMP L', typeID: 201 } },
    XL: { turret: { name: 'Hexa 2500mm Repeating Cannon II', typeID: 37306 }, charge: { name: 'EMP XL', typeID: 17668 } }
  },
  laser: {
    S: { turret: { name: 'Small Focused Pulse Laser II', typeID: 3041 }, charge: { name: 'Multifrequency S', typeID: 246 } },
    M: { turret: { name: 'Heavy Pulse Laser II', typeID: 3520 }, charge: { name: 'Multifrequency M', typeID: 254 } },
    L: { turret: { name: 'Mega Pulse Laser II', typeID: 3057 }, charge: { name: 'Multifrequency L', typeID: 262 } },
    XL: { turret: { name: 'Dual Giga Pulse Laser II', typeID: 37298 }, charge: { name: 'Multifrequency XL', typeID: 17686 } }
  },
  rail: {
    S: { turret: { name: '150mm Railgun II', typeID: 3074 }, charge: { name: 'Antimatter Charge S', typeID: 222 } },
    M: { turret: { name: '250mm Railgun II', typeID: 3082 }, charge: { name: 'Antimatter Charge M', typeID: 230 } },
    L: { turret: { name: '425mm Railgun II', typeID: 3090 }, charge: { name: 'Antimatter Charge L', typeID: 238 } },
    XL: { turret: { name: 'Dual 1000mm Railgun II', typeID: 37303 }, charge: { name: 'Antimatter Charge XL', typeID: 17648 } }
  },
  blaster: {
    S: { turret: { name: 'Light Neutron Blaster II', typeID: 3178 }, charge: { name: 'Antimatter Charge S', typeID: 222 } },
    M: { turret: { name: 'Heavy Neutron Blaster II', typeID: 3146 }, charge: { name: 'Antimatter Charge M', typeID: 230 } },
    L: { turret: { name: 'Neutron Blaster Cannon II', typeID: 3186 }, charge: { name: 'Antimatter Charge L', typeID: 238 } },
    XL: { turret: { name: 'Ion Siege Blaster II', typeID: 37302 }, charge: { name: 'Antimatter Charge XL', typeID: 17648 } }
  },
  disintegrator: {
    S: { turret: { name: 'Light Entropic Disintegrator II', typeID: 47914 }, charge: { name: 'Baryon Exotic Plasma S', typeID: 47924 } },
    M: { turret: { name: 'Heavy Entropic Disintegrator II', typeID: 47918 }, charge: { name: 'Baryon Exotic Plasma M', typeID: 47928 } },
    L: { turret: { name: 'Supratidal Entropic Disintegrator II', typeID: 47922 }, charge: { name: 'Baryon Exotic Plasma L', typeID: 47932 } },
    XL: { turret: { name: 'Ultratidal Entropic Disintegrator I', typeID: 52915 }, charge: { name: 'Baryon Exotic Plasma XL', typeID: 52916 } }
  },
  vorton: {
    S: { turret: { name: 'Small Vorton Projector II', typeID: 54742 }, charge: { name: 'ElectroPunch Ultra S', typeID: 54784 } },
    M: { turret: { name: 'Medium Vorton Projector II', typeID: 54748 }, charge: { name: 'ElectroPunch Ultra M', typeID: 54786 } },
    L: { turret: { name: 'Large Vorton Projector II', typeID: 54753 }, charge: { name: 'ElectroPunch Ultra L', typeID: 54783 } },
    XL: null
  }
};

/**
 * The default launcher of each size, for hulls with launcher hardpoints only; no capital launcher.
 */
export const DEFAULT_LAUNCHERS: Readonly<Record<HullSizeClass, Maybe<DefaultWeaponType>>> = {
  S: { name: 'Light Missile Launcher II', typeID: 2404 },
  M: { name: 'Heavy Missile Launcher II', typeID: 2410 },
  L: { name: 'Cruise Missile Launcher II', typeID: 19739 },
  XL: null
};

/**
 * The missile group each default launcher fires: light 384, heavy 385, cruise 386.
 */
export const DEFAULT_LAUNCHER_MISSILE_GROUPS: Readonly<Record<HullSizeClass, Maybe<number>>> = { S: 384, M: 385, L: 386, XL: null };

/**
 * The weapon family of each SDE race: 1 Caldari, 2 Minmatar, 4 Amarr, 8 Gallente, 135 Triglavian, 168 EDENCOM.
 * Pirate hulls carry their primary race (Machariel 2, Bhaalgorn 4); Jove (16) and ORE (128) fall through to the DNA.
 */
export const RACE_WEAPON_FAMILIES: Readonly<Record<number, WeaponFamily>> = { 1: 'rail', 2: 'projectile', 4: 'laser', 8: 'blaster', 135: 'disintegrator', 168: 'vorton' };

/**
 * The weapon family of each SOF race (the DNA's third part), when the SDE gives no race. `concord` is EDENCOM's.
 */
export const SOF_RACE_WEAPON_FAMILIES: Readonly<Record<string, WeaponFamily>> = {
  amarr: 'laser',
  sansha: 'laser',
  bloodraider: 'laser',
  caldari: 'rail',
  guristas: 'rail',
  gallente: 'blaster',
  serpentis: 'blaster',
  minmatar: 'projectile',
  angel: 'projectile',
  triglavian: 'disintegrator',
  concord: 'vorton'
};

/**
 * The family when neither the SDE nor the DNA names a race.
 */
export const DEFAULT_WEAPON_FAMILY: WeaponFamily = 'projectile';

/**
 * Attack battlecruisers (Tornado, Oracle, Naga, Talos): rig size 2, large turrets.
 */
export const ATTACK_BATTLECRUISER_GROUP = 1201;

/**
 * The name a default fit's header gives.
 */
export const DEFAULT_WEAPONS_FIT_NAME = 'Default weapons';

/**
 * Hull attributes: 102 turretSlotsLeft (turret hardpoints), 101 launcherSlotsLeft, 14 hiSlots, 1547 rigSize.
 */
export const TURRET_HARDPOINTS_ATTRIBUTE = 102;
export const LAUNCHER_HARDPOINTS_ATTRIBUTE = 101;
export const HIGH_SLOTS_ATTRIBUTE = 14;
export const RIG_SIZE_ATTRIBUTE = 1547;

export interface DefaultWeaponsInput {
  /**
   * The hull's dogma record (its name, group, race and attributes).
   */
  readonly hull: DogmaTypeRecord;
  /**
   * The DNA's SOF race, for a hull the SDE gives no race.
   */
  readonly sofRace?: Maybe<string>;
  /**
   * The SOF class's rig size, for a hull without rigSize.
   */
  readonly classRigSize?: Maybe<RigSize>;
}

export interface DefaultWeapons {
  /**
   * The default fit as EFT text, or null when the hull gets none (see `note`).
   */
  readonly text: Maybe<string>;
  readonly kind: Maybe<'turret' | 'launcher'>;
  /**
   * The turret family (from the race); null for launchers and for no weapons.
   */
  readonly family: Maybe<WeaponFamily>;
  readonly size: HullSizeClass;
  readonly count: number;
  readonly weapon: Maybe<DefaultWeaponType>;
  readonly charge: Maybe<DefaultWeaponType>;
  readonly note?: string;
}

/**
 * The turret family of a hull: its SDE race, else its DNA's SOF race, else projectiles.
 *
 * @param raceID - The SDE race, when known.
 * @param sofRace - The DNA's SOF race, when known.
 * @returns The family.
 */
export function weaponFamilyOf(raceID: Maybe<number>, sofRace: Maybe<string> = null): WeaponFamily {
  return (raceID == null ? null : RACE_WEAPON_FAMILIES[raceID]) ?? (sofRace ? SOF_RACE_WEAPON_FAMILIES[sofRace.trim().toLowerCase()] : null) ?? DEFAULT_WEAPON_FAMILY;
}

/**
 * A hull's weapon size: its rigSize (attack battlecruisers large), else the SOF class's, else small.
 *
 * @param hull - The hull record.
 * @param classRigSize - The SOF class's rig size.
 * @returns S, M, L or XL.
 */
export function weaponSizeOf(hull: Pick<DogmaTypeRecord, 'groupID' | 'attributes'>, classRigSize: Maybe<RigSize> = null): HullSizeClass {
  const rigSize: RigSize = hull.groupID === ATTACK_BATTLECRUISER_GROUP ? 3 : (readRigSize(hull.attributes[RIG_SIZE_ATTRIBUTE]) ?? classRigSize ?? 1);
  return HULL_SIZE_CLASSES[rigSize];
}

/**
 * The default weapons of a hull without a fit: one turret per turret hardpoint (at most one per high slot) by size and
 * race with its charge; else one launcher per launcher hardpoint; else none, with a note.
 *
 * @param input - The hull record, and the DNA race and class size fallbacks.
 * @returns The weapons and their EFT text.
 */
export function defaultWeaponsOf(input: DefaultWeaponsInput): DefaultWeapons {
  const { hull, sofRace = null, classRigSize = null } = input;
  const size = weaponSizeOf(hull, classRigSize);
  const highSlots = hull.attributes[HIGH_SLOTS_ATTRIBUTE];
  const cap = (count: number): number => Math.max(0, Math.floor(highSlots == null ? count : Math.min(count, highSlots)));
  const turrets = cap(hull.attributes[TURRET_HARDPOINTS_ATTRIBUTE] ?? 0);
  const launchers = cap(hull.attributes[LAUNCHER_HARDPOINTS_ATTRIBUTE] ?? 0);
  let result: DefaultWeapons;
  if (turrets > 0) {
    const family = weaponFamilyOf(hull.raceID ?? null, sofRace);
    const pick = DEFAULT_TURRETS[family][size];
    result = pick
      ? {
          text: defaultFitText(
            hull.name,
            Array.from({ length: turrets }, () => `${pick.turret.name}, ${pick.charge.name}`)
          ),
          kind: 'turret',
          family,
          size,
          count: turrets,
          weapon: pick.turret,
          charge: pick.charge
        }
      : { text: null, kind: null, family, size, count: 0, weapon: null, charge: null, note: `${hull.name} has no default ${family} turret of size ${size}` };
  } else if (launchers > 0) {
    const launcher = DEFAULT_LAUNCHERS[size];
    const group = DEFAULT_LAUNCHER_MISSILE_GROUPS[size];
    const missile = group == null ? null : (DEFAULT_MISSILES[group]?.[missileDamageTypeOf(hull.raceID ?? null, sofRace)] ?? null);
    result = launcher
      ? {
          text: defaultFitText(
            hull.name,
            Array.from({ length: launchers }, () => (missile ? `${launcher.name}, ${missile.name}` : launcher.name))
          ),
          kind: 'launcher',
          family: null,
          size,
          count: launchers,
          weapon: launcher,
          charge: missile
        }
      : { text: null, kind: null, family: null, size, count: 0, weapon: null, charge: null, note: `${hull.name} has no default launcher of size ${size}` };
  } else {
    result = { text: null, kind: null, family: null, size, count: 0, weapon: null, charge: null, note: `${hull.name} has no weapon hardpoints` };
  }
  return result;
}

/**
 * EFT text with empty low and mid sections, so the weapon lines key as `high-<n>` before their names resolve.
 */
function defaultFitText(hull: string, highs: readonly string[]): string {
  return [`[${hull}, ${DEFAULT_WEAPONS_FIT_NAME}]`, '[Empty Low slot]', '', '[Empty Med slot]', '', ...highs].join('\n');
}
