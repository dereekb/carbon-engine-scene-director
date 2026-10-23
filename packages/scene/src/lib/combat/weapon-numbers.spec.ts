import { describe, expect, it } from 'vitest';
import { evaluateShipDogma } from '../fitting/dogma';
import { parseEftFit } from '../fitting/eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID, RIFTER_ID } from '../fitting/fitting.spec-helper';
import { toDogmaModules, typeEftFit } from '../fitting/typed-fit';
import { defaultWeaponsOf } from '../weapons/default-weapons';
import { NO_CHARGE_DAMAGE_NOTE, shipWeaponsOf, turretCombatNumbersOf } from './weapon-numbers';

/**
 * A hull with its default fit, evaluated with max skills.
 *
 * @param hull - The hull's name.
 * @returns The evaluated ship.
 */
function defaultFitted(hull: string) {
  const record = DOGMA_FIXTURE.types[fixtureTypeID(hull)];
  const text = defaultWeaponsOf({ hull: record }).text;
  if (!text) throw new Error(`${hull} has no default weapons`);
  const fitting = typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
  return evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: record.typeID, modules: toDogmaModules(fitting) });
}

describe('turretCombatNumbersOf', () => {
  it("gives the default fits' damage, cycle, DPS and application numbers", () => {
    const rows = [
      ['Rifter', 3, 65.748, 1.6875, 116.89, 393.75, 750, 9675],
      ['Punisher', 4, 68.31, 2.52, 108.43, 307.8125, 3937.5, 3125],
      ['Ferox', 6, 197.814, 4.194, 283.0, 7.38, 30_375, 16_875],
      ['Megathron', 7, 334.719, 4.2525, 550.98, 8.930625, 4500, 12_500]
    ] as const;
    for (const [hull, turrets, volley, cycleTime, dps, tracking, optimal, falloff] of rows) {
      const ship = defaultFitted(hull);
      const numbers = turretCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
      expect(numbers, hull).toMatchObject({ kind: 'tracking', cycleTime, tracking, optimal, falloff, signatureResolution: 40000 });
      expect(numbers?.volley, hull).toBeCloseTo(volley, 3);
      const weapons = shipWeaponsOf(ship, DOGMA_FIXTURE);
      expect(weapons.turrets, hull).toBe(turrets);
      expect(weapons.launchers, hull).toBe(0);
      expect(weapons.volley, hull).toBeCloseTo(turrets * volley, 2);
      expect(weapons.dps, hull).toBeCloseTo(dps, 1);
    }
  });

  it("splits the Rifter's EMP S damage by type: 3.465 × skills = 5.479 per point", () => {
    const numbers = turretCombatNumbersOf(defaultFitted('Rifter'), DOGMA_FIXTURE, 'high-0');
    expect(numbers?.damage.em).toBeCloseTo(49.311, 3);
    expect(numbers?.damage.kinetic).toBeCloseTo(5.479, 3);
    expect(numbers?.damage.explosive).toBeCloseTo(10.958, 3);
    expect(numbers?.damage.thermal).toBe(0);
    expect(numbers?.charge).toEqual({ typeID: fixtureTypeID('EMP S'), name: 'EMP S' });
    expect(numbers?.note).toBeUndefined();
  });

  it('does no damage without a charge, with a note', () => {
    const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, modules: [{ key: 'high-0', typeID: fixtureTypeID('200mm AutoCannon II'), state: 'online' }] });
    const numbers = turretCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
    expect(numbers).toMatchObject({ volley: 0, dps: 0, damage: { em: 0, thermal: 0, kinetic: 0, explosive: 0 }, note: NO_CHARGE_DAMAGE_NOTE });
    expect(numbers?.charge).toBeUndefined();
  });

  it("spools a Vedmak's disintegrator and gives it no falloff", () => {
    const numbers = turretCombatNumbersOf(defaultFitted('Vedmak'), DOGMA_FIXTURE, 'high-0');
    expect(numbers).toMatchObject({ kind: 'disintegrator', falloff: null, tracking: 52.5, cycleTime: 3.96, spool: { perCycle: 0.07, max: 2.125 } });
    expect(numbers?.volley).toBeCloseTo(588.225, 3);
    expect(numbers?.optimal).toBeCloseTo(32_896.875, 3);
    expect(numbers?.dps).toBeCloseTo(148.54, 2);
  });

  it("gives a Stormbringer's vorton projector its explosion numbers and no tracking", () => {
    const numbers = turretCombatNumbersOf(defaultFitted('Stormbringer'), DOGMA_FIXTURE, 'high-0');
    expect(numbers).toMatchObject({ kind: 'vorton', name: 'Medium Vorton Projector II', falloff: null, tracking: null, signatureResolution: null, explosion: { drf: 0.5 } });
    expect(numbers?.explosion?.radius).toBeGreaterThan(100);
    expect(numbers?.explosion?.velocity).toBeGreaterThan(100);
    expect(numbers?.spool).toBeUndefined();
  });

  it('is null for a key the ship lacks and a module that is no turret', () => {
    const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: RIFTER_ID, modules: [{ key: 'mid-0', typeID: fixtureTypeID('Stasis Webifier II'), state: 'online' }] });
    expect(turretCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0')).toBeNull();
    expect(turretCombatNumbersOf(ship, DOGMA_FIXTURE, 'mid-0')).toBeNull();
    expect(shipWeaponsOf(ship, DOGMA_FIXTURE)).toEqual({ turrets: 0, launchers: 0, volley: 0, dps: 0, damage: { em: 0, thermal: 0, kinetic: 0, explosive: 0 } });
  });
});
