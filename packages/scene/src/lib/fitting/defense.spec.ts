import { describe, expect, it } from 'vitest';
import { localRepairRates, moduleNumbersOf, shipCapacitorOf, shipDefenseOf, shipTargetingOf } from './defense';
import { type DogmaModuleState, evaluateShipDogma } from './dogma';
import { DAMNATION_ID, DOGMA_FIXTURE, fixtureTypeID, RIFTER_ID } from './fitting.spec-helper';

function fitted(hullTypeID: number, ...entries: [string, DogmaModuleState, string?][]) {
  return evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID, modules: entries.map(([name, state, charge], index) => ({ key: `slot-${index}`, typeID: fixtureTypeID(name), state, ...(charge == null ? {} : { chargeTypeID: fixtureTypeID(charge) }) })) });
}

describe('shipDefenseOf', () => {
  it("gives a bare Rifter tools-core's HP, resists, capacitor and recharge", () => {
    const rifter = fitted(RIFTER_ID);
    const defense = shipDefenseOf(rifter);
    expect([defense.shield.hp, defense.armor.hp, defense.structure.hp]).toEqual([562.5, 562.5, 437.5]);
    expect(defense.shield.resists).toEqual({ em: 0, thermal: 20, kinetic: 40, explosive: 50 });
    expect(defense.armor.resonances).toEqual({ em: 0.4, thermal: 0.65, kinetic: 0.75, explosive: 0.9 });
    expect(defense.shieldRecharge).toBe(468.75);
    expect(defense.armor.ehp).toBeCloseTo(562.5 / ((0.4 + 0.65 + 0.75 + 0.9) / 4), 9);
    expect(defense.ehp).toBeCloseTo(defense.shield.ehp + defense.armor.ehp + defense.structure.ehp, 9);
    const capacitor = shipCapacitorOf(rifter, DOGMA_FIXTURE, []);
    expect(capacitor).toEqual({ capacity: 312.5, rechargeTime: 93.75, peakRecharge: (2.5 * 312.5) / 93.75, drain: 0, stable: true, stableAt: 1, energyWarfareResistance: 1, remoteCapacitorImpedance: 1 });
  });

  it('adds a plate, then a damage control and two membranes, then a shield extender', () => {
    const plate = fitted(RIFTER_ID, ['200mm Steel Plates II', 'online']);
    expect(plate.attribute('armorHP')).toBe(1312.5);
    // Armor Layering V and Advanced Armor Layering V cut the plate's 150,000 kg to 101,250.
    expect(plate.attribute('mass')).toBe(1_168_250);
    const tanked = fitted(RIFTER_ID, ['200mm Steel Plates II', 'online'], ['Damage Control II', 'online'], ['Multispectrum Energized Membrane II', 'online'], ['Multispectrum Energized Membrane II', 'online']);
    const armor = shipDefenseOf(tanked).armor;
    expect(armor.resonances.em).toBeCloseTo(0.4 * 0.85 * 0.75 * (1 - 0.25 * 0.86911998), 8);
    expect(armor.resonances.em).toBeCloseTo(0.199594, 6);
    expect(armor.resists.em).toBe(80.04);
    const extended = fitted(RIFTER_ID, ['Medium Shield Extender II', 'online']);
    expect(extended.attribute('shieldCapacity')).toBe(1937.5);
    expect(extended.attribute('signatureRadius')).toBe(42);
  });

  it('counts an active hardener, not an online one', () => {
    const resonances = (state: DogmaModuleState) => shipDefenseOf(fitted(RIFTER_ID, ['Multispectrum Shield Hardener II', state])).shield.resonances;
    expect(resonances('online')).toEqual(shipDefenseOf(fitted(RIFTER_ID)).shield.resonances);
    expect(resonances('active').em).toBeCloseTo(0.675, 12);
    expect(resonances('active').explosive).toBeCloseTo(0.5 * 0.675, 12);
  });
});

describe('module numbers', () => {
  it("multiplies an ancillary armor repairer's repair while it has paste", () => {
    const dry = fitted(DAMNATION_ID, ['Large Ancillary Armor Repairer', 'active']);
    const pasted = fitted(DAMNATION_ID, ['Large Ancillary Armor Repairer', 'active', 'Nanite Repair Paste']);
    const without = moduleNumbersOf(dry, DOGMA_FIXTURE, 'slot-0');
    const withPaste = moduleNumbersOf(pasted, DOGMA_FIXTURE, 'slot-0');
    expect(without?.repair).toEqual({ layer: 'armor', amount: 518, remote: false });
    expect(withPaste?.repair?.amount).toBe(3 * 518);
    expect(withPaste?.cycleTime).toBe(11.25);
    expect(localRepairRates(pasted, DOGMA_FIXTURE, ['slot-0']).armor).toBeCloseTo(1554 / 11.25, 9);
    expect(localRepairRates(pasted, DOGMA_FIXTURE, []).armor).toBe(0);
  });

  it('reads cycle, capacitor and range from the default effect, and null for a key the ship lacks', () => {
    const ship = fitted(RIFTER_ID, ['Warp Scrambler II', 'active'], ['Large Remote Armor Repairer II', 'active']);
    const scram = moduleNumbersOf(ship, DOGMA_FIXTURE, 'slot-0');
    expect(scram?.range).toBeGreaterThan(0);
    expect(scram?.capacitorNeed).toBeGreaterThan(0);
    expect(scram?.repair).toBeNull();
    expect(moduleNumbersOf(ship, DOGMA_FIXTURE, 'slot-1')?.repair).toEqual(expect.objectContaining({ layer: 'armor', remote: true }));
    expect(localRepairRates(ship, DOGMA_FIXTURE, ['slot-1']).armor).toBe(0);
    expect(moduleNumbersOf(ship, DOGMA_FIXTURE, 'slot-9')).toBeNull();
  });
});

describe('shipCapacitorOf', () => {
  it('drains by capacitor need over cycle time; a big enough drain runs out', () => {
    const ship = fitted(RIFTER_ID, ['Multispectrum Shield Hardener II', 'active'], ['Large Armor Repairer II', 'active']);
    const hardener = moduleNumbersOf(ship, DOGMA_FIXTURE, 'slot-0');
    const stable = shipCapacitorOf(ship, DOGMA_FIXTURE, ['slot-0']);
    expect(stable.drain).toBeCloseTo((hardener?.capacitorNeed ?? 0) / (hardener?.cycleTime ?? 1), 12);
    expect(stable.stable).toBe(true);
    expect(stable.stableAt).toBeGreaterThan(0.25);
    expect(stable.stableAt).toBeLessThan(1);
    const drained = shipCapacitorOf(ship, DOGMA_FIXTURE, ['slot-0', 'slot-1']);
    expect(drained.stable).toBe(false);
    expect(drained.lastsFor).toBeGreaterThan(0);
    expect(drained.lastsFor).toBeLessThan(312.5 / (drained.drain - drained.peakRecharge));
  });

  it("an active microwarpdrive's online effect cuts the capacitor", () => {
    expect(fitted(RIFTER_ID, ['5MN Microwarpdrive II', 'active']).attribute('capacitorCapacity')).toBe(250);
  });
});

describe('shipTargetingOf', () => {
  it("reads the ship's lock range, scan resolution and locked targets", () => {
    const rifter = fitted(RIFTER_ID);
    const targeting = shipTargetingOf(rifter);
    expect(targeting).toEqual({ maxTargetRange: rifter.attribute(76), scanResolution: rifter.attribute(564), maxLockedTargets: rifter.attribute(192) });
    expect(targeting.maxTargetRange).toBeGreaterThan(0);
  });
});
