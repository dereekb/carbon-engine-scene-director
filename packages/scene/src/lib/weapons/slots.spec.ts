import { describe, expect, it } from 'vitest';
import { assignTurretSlots, CLASSIC_TURRET_LOCATOR, turretLocatorSlots, type TurretSlotMount } from './slots';

/**
 * Locator names `<prefix><slot><letter>` for each slot, `letters` per slot.
 */
function locators(prefix: string, slots: readonly number[], letters = 'ab'): string[] {
  return slots.flatMap((slot) => [...letters].map((letter) => `${prefix}${slot}${letter}`));
}

function classic(key: string, highIndex: number | null): TurretSlotMount {
  return { key, locatorName: CLASSIC_TURRET_LOCATOR, highIndex };
}

describe('turretLocatorSlots', () => {
  it('counts lettered locators per slot and collection', () => {
    const slots = turretLocatorSlots([...locators('locator_turret_', [1], 'abc'), ...locators('locator_turret_', [2, 3, 4]), 'locator_xl_1a', 'locator_damage_1', 'Locator_Turret_5a']);
    expect([...(slots.get('locator_turret_') ?? [])]).toEqual([
      [1, 3],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 1]
    ]);
    expect([...(slots.get('locator_xl_') ?? [])]).toEqual([[1, 1]]);
  });
});

describe('assignTurretSlots', () => {
  const TFI_LOCATORS = locators('locator_turret_', [1, 2, 3, 4, 5, 6, 7, 8]);

  it("mounts the TFI's interleaved guns on their high slots' hardpoints", () => {
    const mounts = [0, 1, 3, 4, 6, 7].map((index) => classic(`high-${index}`, index));
    const assigned = assignTurretSlots(mounts, TFI_LOCATORS);
    expect(assigned.map((slot) => slot.slot)).toEqual([1, 2, 4, 5, 7, 8]);
    expect(assigned[2]).toEqual({ key: 'high-3', collection: 'locator_turret_', slot: 4, locator: 'locator_turret_4', models: 2, placed: true });
  });

  it('moves a gun whose hardpoint the hull lacks to the lowest free slot, after the others take theirs', () => {
    const rifter = [...locators('locator_turret_', [1], 'abc'), ...locators('locator_turret_', [2, 3, 4])];
    const assigned = assignTurretSlots([classic('high-6', 6), classic('high-1', 1), classic('high-0', 0), classic('x', null)], rifter);
    expect(assigned.map((slot) => [slot.key, slot.slot, slot.models])).toEqual([
      ['high-6', 3, 2],
      ['high-1', 2, 2],
      ['high-0', 1, 3],
      ['x', 4, 2]
    ]);
  });

  it('leaves guns beyond the hull slots unplaced', () => {
    const assigned = assignTurretSlots(
      [0, 1, 2].map((index) => classic(`high-${index}`, index)),
      locators('locator_turret_', [1, 2])
    );
    expect(assigned[2]).toEqual({ key: 'high-2', collection: 'locator_turret_', slot: null, locator: null, models: 0, placed: false });
  });

  it('numbers XL, launcher and atomic sets by mount order, unplaced past the collection', () => {
    const revelation = [...locators('locator_xl_', [1, 2, 3]), ...TFI_LOCATORS];
    const xl = [0, 1, 2, 3].map((index): TurretSlotMount => ({ key: `high-${index}`, locatorName: 'locator_xl_', highIndex: index }));
    expect(assignTurretSlots(xl, revelation).map((slot) => [slot.collection, slot.slot, slot.placed])).toEqual([
      ['locator_xl_', 1, true],
      ['locator_xl_', 2, true],
      ['locator_xl_', 3, true],
      ['locator_xl_', null, false]
    ]);
    const mixed: TurretSlotMount[] = [{ key: 'high-0', locatorName: 'locator_launcher_', highIndex: 0 }, classic('high-1', 1), { key: 'high-2', locatorName: 'locator_atomic_', highIndex: 2 }, { key: 'high-3', locatorName: 'locator_launcher_', highIndex: 3 }];
    const hull = [...TFI_LOCATORS, ...locators('locator_launcher_', [1, 2, 3, 4, 5, 6]), 'locator_atomic_1a'];
    expect(assignTurretSlots(mixed, hull).map((slot) => slot.locator)).toEqual(['locator_launcher_1', 'locator_turret_2', 'locator_atomic_1', 'locator_launcher_2']);
  });

  it('mounts a set on the classic slots when the hull lacks its collection, never past slot 9', () => {
    const assigned = assignTurretSlots([{ key: 'high-0', locatorName: 'locator_xl_', highIndex: 0 }], TFI_LOCATORS);
    expect(assigned[0]).toMatchObject({ collection: 'locator_turret_', slot: 1, placed: true });
    expect(turretLocatorSlots(['locator_turret_10a']).size).toBe(0);
    const nine = assignTurretSlots([classic('high-8', 8), classic('high-9', 9)], locators('locator_turret_', [9]));
    expect(nine.map((slot) => slot.slot)).toEqual([9, null]);
  });
});
