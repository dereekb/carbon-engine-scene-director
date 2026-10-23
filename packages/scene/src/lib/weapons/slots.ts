/**
 * Turret slots: which hardpoint locators each fitted weapon mounts on, from the locator names of the built hull.
 *
 * The runtime (`EveMobile.RebuildTurretPositions`) mounts a set whose `locatorName` contains `_turret_` on its
 * `slotNumber` (one character, so 1-9): every `locator_turret_<slot>a, b, c...` gets one turret model. Any other
 * collection (`locator_xl_`, `locator_launcher_`, `locator_atomic_`, `locator_chain_`) ignores `slotNumber`: the
 * engine numbers that collection's sets 1, 2, ... in mount order, and a hull without the collection mounts the set on
 * `locator_turret_<slotNumber>` instead. Classic turrets take their EVE high slot's hardpoint (index + 1), else the
 * lowest unused classic slot the hull has.
 */

import type { Maybe } from '@dereekb/util';

/**
 * The classic turret locator collection.
 */
export const CLASSIC_TURRET_LOCATOR = 'locator_turret_';

/**
 * The locator collections turret sets mount on.
 */
export const TURRET_LOCATOR_COLLECTIONS = [CLASSIC_TURRET_LOCATOR, 'locator_xl_', 'locator_launcher_', 'locator_atomic_', 'locator_chain_'] as const;

/**
 * The highest slot a set can name (the runtime reads one digit).
 */
export const MAX_TURRET_SLOT = 9;

/**
 * Locator slots by collection prefix: slot number → how many lettered locators (a, b, c...) it has.
 */
export type TurretLocatorSlots = ReadonlyMap<string, ReadonlyMap<number, number>>;

const LOCATOR_PATTERN = /^(locator_[a-z]+_)([1-9])([a-z])/u;

/**
 * The turret locator slots a hull has.
 *
 * @param locatorNames - The built hull's locator names (and its animation bones, for an animated hull).
 * @returns The slots by collection prefix.
 */
export function turretLocatorSlots(locatorNames: readonly string[]): TurretLocatorSlots {
  const letters = new Map<string, Map<number, Set<string>>>();
  for (const name of locatorNames) {
    const match = LOCATOR_PATTERN.exec(name.toLowerCase());
    if (match) {
      const [, prefix, digit, letter] = match;
      const slots = letters.get(prefix) ?? new Map<number, Set<string>>();
      letters.set(prefix, slots);
      const slot = Number(digit);
      slots.set(slot, (slots.get(slot) ?? new Set<string>()).add(letter));
    }
  }
  return new Map([...letters].map(([prefix, slots]) => [prefix, new Map([...slots].sort(([a], [b]) => a - b).map(([slot, found]) => [slot, found.size]))]));
}

/**
 * A weapon to mount.
 */
export interface TurretSlotMount {
  /**
   * The fitted module's key.
   */
  readonly key: string;
  /**
   * The set's `locatorName` (its turret file's): the collection it mounts on.
   */
  readonly locatorName: string;
  /**
   * Its EVE high slot index (`high-<n>`), when known.
   */
  readonly highIndex: Maybe<number>;
}

export interface TurretSlotAssignment {
  readonly key: string;
  /**
   * The collection it mounts on: its own, or the classic one on a hull that lacks it.
   */
  readonly collection: string;
  /**
   * The `slotNumber` to set (classic slots), or the number the engine gives it (other collections); null when
   * unplaced.
   */
  readonly slot: Maybe<number>;
  /**
   * The locator base it binds (`locator_turret_4`), or null when unplaced.
   */
  readonly locator: Maybe<string>;
  /**
   * How many turret models the set draws (one per lettered locator).
   */
  readonly models: number;
  /**
   * Whether the set has a hardpoint; an unplaced set is not mounted.
   */
  readonly placed: boolean;
}

/**
 * Assigns each weapon its slot on a hull. Classic turrets first take their high slot's hardpoint when the hull has
 * it, then the rest take the lowest unused classic slots in mount order; other collections are numbered in mount
 * order. Beyond the hull's slots a weapon is unplaced.
 *
 * @param mounts - The weapons, in mount order (their keys' order).
 * @param locatorNames - The built hull's locator names.
 * @returns One assignment per mount, in mount order.
 */
export function assignTurretSlots(mounts: readonly TurretSlotMount[], locatorNames: readonly string[]): TurretSlotAssignment[] {
  const slots = turretLocatorSlots(locatorNames);
  const classic = slots.get(CLASSIC_TURRET_LOCATOR) ?? new Map<number, number>();
  const collectionOf = (mount: TurretSlotMount): string => (mount.locatorName.includes('_turret_') || !slots.has(mount.locatorName) ? CLASSIC_TURRET_LOCATOR : mount.locatorName);
  const assigned = new Map<string, TurretSlotAssignment>();
  const used = new Set<number>();
  const place = (key: string, collection: string, slot: Maybe<number>, models: number): void => {
    assigned.set(key, slot == null ? { key, collection, slot: null, locator: null, models: 0, placed: false } : { key, collection, slot, locator: `${collection}${slot}`, models, placed: true });
  };
  const classicMounts = mounts.filter((mount) => collectionOf(mount) === CLASSIC_TURRET_LOCATOR);
  for (const mount of classicMounts) {
    const preferred = mount.highIndex == null ? null : mount.highIndex + 1;
    if (preferred != null && preferred <= MAX_TURRET_SLOT && classic.has(preferred) && !used.has(preferred)) {
      used.add(preferred);
      place(mount.key, CLASSIC_TURRET_LOCATOR, preferred, classic.get(preferred) ?? 0);
    }
  }
  const free = [...classic.keys()].filter((slot) => slot <= MAX_TURRET_SLOT && !used.has(slot));
  for (const mount of classicMounts) {
    if (!assigned.has(mount.key)) {
      const slot = free.shift() ?? null;
      place(mount.key, CLASSIC_TURRET_LOCATOR, slot, slot == null ? 0 : (classic.get(slot) ?? 0));
    }
  }
  const counters = new Map<string, number>();
  for (const mount of mounts) {
    const collection = collectionOf(mount);
    if (collection !== CLASSIC_TURRET_LOCATOR) {
      const collectionSlots = slots.get(collection) ?? new Map<number, number>();
      const number = (counters.get(collection) ?? 0) + 1;
      counters.set(collection, number);
      const total = Math.max(0, ...collectionSlots.keys());
      place(mount.key, collection, number <= total ? number : null, collectionSlots.get(number) ?? 0);
    }
  }
  return mounts.map((mount) => assigned.get(mount.key) as TurretSlotAssignment);
}
