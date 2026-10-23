import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Maybe } from '@dereekb/util';
import { expect } from 'vitest';
import type { HullStats } from '../stats/ship-stats';
import { type DogmaBundle, type FitTypeAnswer, fitTypeCategoryOf, readDogmaBundle } from './dogma-bundle';
import type { EftSlot } from './eft';

/**
 * The committed dogma fixture (SDE 3632936), read from disk: the package never imports it.
 *
 * @returns The bundle.
 */
export function loadDogmaFixture(): DogmaBundle {
  const read = readDogmaBundle(JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'fixtures/dogma-3632936.json'), 'utf8')));
  expect(read.problems).toEqual([]);
  return read.bundle as DogmaBundle;
}

export const DOGMA_FIXTURE: DogmaBundle = loadDogmaFixture();

/**
 * Slot effects: loPower, medPower, hiPower, rigSlot, subSystem, serviceSlot.
 */
const SLOT_EFFECTS: ReadonlyMap<number, EftSlot> = new Map([
  [11, 'low'],
  [13, 'mid'],
  [12, 'high'],
  [2663, 'rig'],
  [3772, 'subsystem'],
  [6306, 'service']
]);

const ANSWERS_BY_NAME: ReadonlyMap<string, FitTypeAnswer> = new Map(
  Object.values(DOGMA_FIXTURE.types).map((type) => [
    type.name,
    {
      typeID: type.typeID,
      name: type.name,
      groupID: type.groupID,
      categoryID: type.categoryID,
      category: fitTypeCategoryOf(type.categoryID),
      slot: type.effects.map((id) => SLOT_EFFECTS.get(id)).find((slot) => slot != null) ?? null
    }
  ])
);

/**
 * `/fit/type` answered from the fixture: exact names, null for a type the fixture lacks.
 *
 * @param name - The name as written.
 * @returns The answer.
 */
export function fixtureAnswer(name: string): Maybe<FitTypeAnswer> {
  return ANSWERS_BY_NAME.get(name) ?? null;
}

/**
 * A fixture type's id by exact name.
 *
 * @param name - The type name.
 * @returns The type id.
 * @throws {RangeError} When the fixture lacks it.
 */
export function fixtureTypeID(name: string): number {
  const answer = fixtureAnswer(name);
  if (!answer) throw new RangeError(`the dogma fixture has no type "${name}"`);
  return answer.typeID;
}

/**
 * A hull's published values from the fixture, as the hub's ShipData reads them.
 *
 * @param typeID - The hull type id.
 * @returns The values the table path takes.
 */
export function fixtureHullStats(typeID: number): HullStats {
  const type = DOGMA_FIXTURE.types[typeID];
  const attribute = (id: number): number => type.attributes[id];
  return {
    mass: type.mass as number,
    maxVelocity: attribute(37),
    agility: attribute(70),
    signatureRadius: attribute(552),
    radius: type.radius ?? null,
    warpSpeedMultiplier: attribute(600) ?? null,
    rigSize: attribute(1547) ?? null,
    advancedAgility: attribute(853) ?? null,
    advancedCapitalAgility: attribute(874) ?? null,
    warpScrambleStatus: attribute(104) ?? null
  };
}

export const RIFTER_ID = 587;
export const TFI_ID = 17732;
export const GUARDIAN_ID = 11987;
export const REVELATION_ID = 19720;
export const DAMNATION_ID = 22474;
export const VINDICATOR_ID = 17740;
export const BHAALGORN_ID = 17920;
export const FEROX_ID = 16227;
