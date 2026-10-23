/**
 * Module categories: what a fitted module is for, by its EVE group with effect refinements (SDE 3632936). They are
 * the keywords switch_modules selects modules by, and they decide which modules the activation layer can run.
 */

import type { Maybe } from '@dereekb/util';

export const MODULE_CATEGORIES = [
  'prop',
  'hardener',
  'shield-booster',
  'armor-repairer',
  'hull-repairer',
  'remote-armor-repairer',
  'remote-shield-booster',
  'remote-capacitor',
  'remote-hull-repairer',
  'web',
  'scram',
  'point',
  'neut',
  'nos',
  'sensor-booster',
  'tracking-computer',
  'weapon-disruptor',
  'sensor-dampener',
  'target-painter',
  'ecm',
  'cap-booster',
  'siege',
  'triage',
  'command-burst',
  'sig-suppressor',
  'damage-control',
  'weapon',
  'other'
] as const;

export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

/**
 * The category of each module group.
 */
export const MODULE_CATEGORY_GROUPS: Readonly<Record<number, ModuleCategory>> = {
  46: 'prop',
  328: 'hardener',
  77: 'hardener',
  1150: 'hardener',
  40: 'shield-booster',
  1156: 'shield-booster',
  62: 'armor-repairer',
  1199: 'armor-repairer',
  63: 'hull-repairer',
  325: 'remote-armor-repairer',
  2018: 'remote-armor-repairer',
  41: 'remote-shield-booster',
  67: 'remote-capacitor',
  585: 'remote-hull-repairer',
  65: 'web',
  71: 'neut',
  68: 'nos',
  212: 'sensor-booster',
  213: 'tracking-computer',
  291: 'weapon-disruptor',
  208: 'sensor-dampener',
  379: 'target-painter',
  201: 'ecm',
  76: 'cap-booster',
  1770: 'command-burst',
  1154: 'sig-suppressor',
  60: 'damage-control'
};

/**
 * Effects that refine a group: the warp scrambler (5934) and disruptor (39) share group 52; siege (6582) and triage
 * (6581) share 515; turrets (42 turretFitted) and launchers (40 launcherFitted) are weapons in any group.
 */
export const MODULE_CATEGORY_EFFECTS: Readonly<Record<number, ModuleCategory>> = { 5934: 'scram', 39: 'point', 6582: 'siege', 6581: 'triage', 42: 'weapon', 40: 'weapon' };

/**
 * A module's category.
 *
 * @param groupID - Its EVE group.
 * @param effects - Its effect ids, when known (needed for scram / point, siege / triage and weapons).
 * @returns The category.
 */
export function moduleCategoryOf(groupID: number, effects: Maybe<readonly number[]> = null): ModuleCategory {
  const refined = effects?.map((effect) => MODULE_CATEGORY_EFFECTS[effect]).find(Boolean);
  return refined ?? MODULE_CATEGORY_GROUPS[groupID] ?? 'other';
}

/**
 * Whether a word is a module category.
 *
 * @param word - The candidate.
 * @returns True for a ModuleCategory.
 */
export function isModuleCategory(word: string): word is ModuleCategory {
  return (MODULE_CATEGORIES as readonly string[]).includes(word);
}
