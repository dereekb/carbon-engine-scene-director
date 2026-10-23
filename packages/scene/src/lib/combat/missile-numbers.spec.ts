import { describe, expect, it } from 'vitest';
import { evaluateShipDogma } from '../fitting/dogma';
import { parseEftFit } from '../fitting/eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID } from '../fitting/fitting.spec-helper';
import { toDogmaModules, typeEftFit } from '../fitting/typed-fit';
import { defaultWeaponsOf } from '../weapons/default-weapons';
import { missileApplication, vortonApplication } from './accuracy';
import { missileCombatNumbersOf, missileFlightTime, missileRange, NO_MISSILE_NOTE } from './missile-numbers';
import { shipWeaponsOf } from './weapon-numbers';

/**
 * A fit's EFT text evaluated with max skills.
 *
 * @param text - The fit.
 * @returns The evaluated ship.
 */
function fitted(text: string) {
  const fitting = typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
  return evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: fixtureTypeID(fitting.hull), modules: toDogmaModules(fitting) });
}

function launchers(hull: string, launcher: string, missile: string, count: number, lows: readonly string[] = []): string {
  return [`[${hull}, test]`, ...(lows.length ? lows : ['[Empty Low slot]']), '', '[Empty Med slot]', '', ...Array.from({ length: count }, () => `${launcher}, ${missile}`)].join('\n');
}

const CARACAL_DEFAULT = defaultWeaponsOf({ hull: DOGMA_FIXTURE.types[fixtureTypeID('Caracal')] }).text ?? '';

describe('missileCombatNumbersOf', () => {
  // Hand-computed with Pyfa's formulas (the missiles plan §1.6), max skills.
  it("gives a default Caracal's heavy missiles: 6.1965 s, 204.875 kinetic, 9,675 m/s, 94.33 km", () => {
    const ship = fitted(CARACAL_DEFAULT);
    const numbers = missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
    expect(numbers).toMatchObject({ kind: 'missile', name: 'Heavy Missile Launcher II', charge: { typeID: 209, name: 'Scourge Heavy Missile' }, mass: 1000, radius: 300 });
    expect(numbers?.cycleTime).toBeCloseTo(6.1965, 6);
    expect(numbers?.damage.kinetic).toBeCloseTo(204.875, 6);
    expect(numbers?.damage.em).toBe(0);
    expect(numbers?.volley).toBeCloseTo(204.875, 6);
    expect(numbers?.velocity).toBeCloseTo(9675, 6);
    expect(numbers?.flightTime).toBeCloseTo(9.75 + 202 / 9675, 9);
    expect(numbers?.range.lower).toBeCloseTo(86_873, 0);
    expect(numbers?.range.upper).toBeCloseTo(96_548, 0);
    expect(numbers?.range.upperChance).toBeCloseTo(0.771, 3);
    expect((numbers?.range.mean ?? 0) / 1000).toBeCloseTo(94.33, 2);
    expect(numbers?.explosion.radius).toBeCloseTo(105, 6);
    expect(numbers?.explosion.velocity).toBeCloseTo(127.5, 6);
    expect(numbers?.explosion.drf).toBe(0.682);
    const weapons = shipWeaponsOf(ship, DOGMA_FIXTURE);
    expect(weapons).toMatchObject({ turrets: 0, launchers: 5 });
    expect(weapons.volley).toBeCloseTo(1024.375, 3);
    expect(weapons.dps).toBeCloseTo(165.3, 1);
    expect(weapons.damage.kinetic).toBeCloseTo(weapons.dps, 9);
  });

  it("gives a Kestrel's light missiles their hull's +25 %: 8.8128 s, 142.66, 63.28 km", () => {
    const ship = fitted(launchers('Kestrel', 'Light Missile Launcher II', 'Scourge Light Missile', 4));
    const numbers = missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
    expect(numbers?.cycleTime).toBeCloseTo(8.8128, 6);
    expect(numbers?.volley).toBeCloseTo(142.656, 3);
    expect(numbers?.velocity).toBeCloseTo(8437.5, 6);
    expect(numbers?.flightTime).toBeCloseTo(7.505, 3);
    expect((numbers?.range.lower ?? 0) / 1000).toBeCloseTo(59.02, 2);
    expect((numbers?.range.upper ?? 0) / 1000).toBeCloseTo(67.45, 2);
    expect((numbers?.range.mean ?? 0) / 1000).toBeCloseTo(63.28, 2);
    expect(numbers?.explosion).toEqual({ radius: expect.closeTo(30, 6), velocity: expect.closeTo(255, 6), drf: 0.604 });
    const weapons = shipWeaponsOf(ship, DOGMA_FIXTURE);
    expect(weapons.volley).toBeCloseTo(570.6, 1);
    expect(weapons.dps).toBeCloseTo(64.7, 1);
  });

  it("gives a Raven's cruise missiles 8.5408 s, 515.63, 222.08 km", () => {
    const ship = fitted(launchers('Raven', 'Cruise Missile Launcher II', 'Scourge Cruise Missile', 6));
    const numbers = missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
    expect(numbers?.cycleTime).toBeCloseTo(8.5408, 4);
    expect(numbers?.volley).toBeCloseTo(515.625, 3);
    expect(numbers?.velocity).toBeCloseTo(10_575, 6);
    expect(numbers?.flightTime).toBeCloseTo(21.024, 3);
    expect((numbers?.range.lower ?? 0) / 1000).toBeCloseTo(221.825, 2);
    expect((numbers?.range.upper ?? 0) / 1000).toBeCloseTo(232.4, 2);
    expect((numbers?.range.mean ?? 0) / 1000).toBeCloseTo(222.075, 2);
    expect(numbers?.explosion.radius).toBeCloseTo(247.5, 6);
    expect(shipWeaponsOf(ship, DOGMA_FIXTURE).dps).toBeCloseTo(362.2, 1);
  });

  it("gives a Drake's heavy missiles its +50 % kinetic: 8.262 s, 307.31, 78.61 km", () => {
    const ship = fitted(launchers('Drake', 'Heavy Missile Launcher II', 'Scourge Heavy Missile', 6));
    const numbers = missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0');
    expect(numbers?.cycleTime).toBeCloseTo(8.262, 3);
    expect(numbers?.volley).toBeCloseTo(307.31, 2);
    expect(numbers?.velocity).toBeCloseTo(8062.5, 6);
    expect((numbers?.range.mean ?? 0) / 1000).toBeCloseTo(78.61, 2);
    expect(shipWeaponsOf(ship, DOGMA_FIXTURE).dps).toBeCloseTo(223.2, 1);
  });

  it('multiplies the damage by the character missileDamageMultiplier a Ballistic Control System raises', () => {
    const bare = missileCombatNumbersOf(fitted(CARACAL_DEFAULT), DOGMA_FIXTURE, 'high-0');
    const text = launchers('Caracal', 'Heavy Missile Launcher II', 'Scourge Heavy Missile', 5, ['Ballistic Control System II']);
    const withBcs = missileCombatNumbersOf(fitted(text), DOGMA_FIXTURE, 'high-0');
    expect(withBcs?.volley).toBeCloseTo((bare?.volley ?? 0) * 1.1, 6);
    expect(withBcs?.cycleTime).toBeCloseTo((bare?.cycleTime ?? 0) * 0.895, 6);
  });

  it('fires nothing without a missile', () => {
    const numbers = missileCombatNumbersOf(fitted(['[Caracal, test]', '', '', 'Heavy Missile Launcher II'].join('\n')), DOGMA_FIXTURE, 'high-0');
    expect(numbers).toMatchObject({ kind: 'missile', volley: 0, dps: 0, velocity: 0, flightTime: 0, note: NO_MISSILE_NOTE, range: { lower: 0, upper: 0, mean: 0 } });
    expect(numbers?.charge).toBeUndefined();
  });

  it('is null for a key the ship lacks and a module that is no launcher (a probe launcher has no launcherFitted)', () => {
    const ship = fitted(['[Caracal, test]', 'Ballistic Control System II', '', '[Empty Med slot]', '', 'Heavy Missile Launcher II, Scourge Heavy Missile', 'Core Probe Launcher II, Core Scanner Probe I'].join('\n'));
    expect(missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-0')).not.toBeNull();
    expect(missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-1')).toBeNull();
    expect(missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'high-9')).toBeNull();
    expect(missileCombatNumbersOf(ship, DOGMA_FIXTURE, 'low-0')).toBeNull();
  });
});

describe('missileFlightTime and missileRange', () => {
  it('adds the ship-radius bonus to the explosion delay', () => {
    expect(missileFlightTime({ explosionDelay: 9750, velocity: 9675, shipRadius: 202 })).toBeCloseTo(9.7709, 4);
    expect(missileFlightTime({ explosionDelay: 9750, velocity: 0, shipRadius: 202 })).toBe(0);
  });

  it("flies floor(T) or ceil(T) whole ticks, the longer with chance T − floor(T) (EVE University's 7.5 s: 50 / 50)", () => {
    const range = missileRange({ velocity: 1000, flightTime: 7.5, mass: 1000, agility: 1.445e-4, shipRadius: 0 });
    expect(range.lower).toBeCloseTo(7000, 0);
    expect(range.upper).toBeCloseTo(8000, 0);
    expect(range.upperChance).toBe(0.5);
    expect(range.mean).toBeCloseTo(7500, 0);
    const whole = missileRange({ velocity: 1000, flightTime: 8, mass: 1000, agility: 1.445e-4, shipRadius: 100 });
    expect(whole).toEqual({ lower: whole.upper, upper: expect.closeTo(7900, 0), upperChance: 0, mean: whole.upper });
  });

  it('flies at half speed while accelerating (mass × agility / 1e6 seconds)', () => {
    const range = missileRange({ velocity: 1000, flightTime: 2, mass: 1e6, agility: 1, shipRadius: 0 });
    expect(range.lower).toBeCloseTo(500 + 1000, 6);
  });
});

describe('missileApplication', () => {
  const heavy = { explosionRadius: 105, explosionVelocity: 127.5, drf: 0.682 };

  it('applies fully to a big target, by S / E to a small one at rest', () => {
    expect(missileApplication({ ...heavy, signatureRadius: 325, targetSpeed: 0 })).toBe(1);
    expect(missileApplication({ ...heavy, signatureRadius: 37, targetSpeed: 0 })).toBeCloseTo(37 / 105, 12);
  });

  it('takes the drf term for a fast small target', () => {
    const factor = missileApplication({ ...heavy, signatureRadius: 37, targetSpeed: 2000 });
    expect(factor).toBeCloseTo((((37 / 105) * 127.5) / 2000) ** 0.682, 12);
    expect(factor).toBeLessThan(37 / 105);
  });

  it('gives nothing to a signature of 0, everything without an explosion radius', () => {
    expect(missileApplication({ ...heavy, signatureRadius: 0, targetSpeed: 0 })).toBe(0);
    expect(missileApplication({ ...heavy, explosionRadius: 0, signatureRadius: 37, targetSpeed: 500 })).toBe(1);
    expect(missileApplication({ ...heavy, explosionVelocity: 0, signatureRadius: 37, targetSpeed: 500 })).toBeCloseTo(37 / 105, 12);
  });

  it('is what vortons apply', () => {
    expect(vortonApplication).toBe(missileApplication);
  });
});
