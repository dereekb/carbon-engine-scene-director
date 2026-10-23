import { describe, expect, it } from 'vitest';
import { falloffEffectiveness, moduleActivationOf, moduleReach } from './activation';
import { evaluateShipDogma } from './dogma';
import { DOGMA_FIXTURE, fixtureTypeID, GUARDIAN_ID, REVELATION_ID, RIFTER_ID } from './fitting.spec-helper';

function activations(hullTypeID: number, ...names: string[]) {
  const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID, modules: names.map((name, index) => ({ key: `m-${index}`, typeID: fixtureTypeID(name), state: 'online' })) });
  return names.map((_name, index) => moduleActivationOf(ship, DOGMA_FIXTURE, `m-${index}`));
}

describe('moduleActivationOf', () => {
  it('runs hardeners and local reps warp safe, and remote reps on a target with their reach', () => {
    const [hardener, repairer, remote] = activations(GUARDIAN_ID, 'Domination Thermal Armor Hardener', 'Large Armor Repairer II', 'Large Remote Armor Repairer II');
    expect(hardener).toMatchObject({ category: 'hardener', refusal: null, targeted: false, warpSafe: true, flight: false, repair: null });
    expect(hardener?.note).toBeUndefined();
    expect(repairer).toMatchObject({ category: 'armor-repairer', targeted: false, warpSafe: true, repair: { layer: 'armor', remote: false } });
    expect(remote).toMatchObject({ category: 'remote-armor-repairer', refusal: null, targeted: true, warpSafe: false, repair: { layer: 'armor', remote: true } });
    expect(remote?.range).toBeGreaterThan(0);
    expect(remote?.falloff).toBeGreaterThan(0);
    expect(remote?.cycleTime).toBeGreaterThan(0);
  });

  it('marks siege as changing the flight, notes target effects not modelled, and refuses weapons and passive modules', () => {
    const [siege] = activations(REVELATION_ID, 'Siege Module II');
    expect(siege).toMatchObject({ category: 'siege', flight: true, warpSafe: false, refusal: null });
    const [web, scram, plate, gun] = activations(RIFTER_ID, 'Stasis Webifier II', 'Warp Scrambler II', '200mm Steel Plates II', '800mm Repeating Cannon II');
    expect(web).toMatchObject({ category: 'web', targeted: true, note: 'cycles without effect on its target yet' });
    expect(scram).toMatchObject({ category: 'scram', targeted: true, falloff: null });
    expect(plate?.refusal).toBe('it is passive: it is only online or offline');
    expect(gun?.refusal).toBe('weapons are not modelled yet (the Turrets entry)');
  });
});

describe('falloffEffectiveness and moduleReach', () => {
  it('is 1 within optimal, a half at one falloff, and reaches optimal plus two falloffs', () => {
    expect(falloffEffectiveness({ distance: 5000, range: 6000, falloff: 3000 })).toBe(1);
    expect(falloffEffectiveness({ distance: 9000, range: 6000, falloff: 3000 })).toBe(0.5);
    expect(falloffEffectiveness({ distance: 12_000, range: 6000, falloff: 3000 })).toBe(0.0625);
    expect(falloffEffectiveness({ distance: 6001, range: 6000, falloff: null })).toBe(0);
    expect(moduleReach({ range: 6000, falloff: 3000 })).toBe(12_000);
    expect(moduleReach({ range: 7500, falloff: null })).toBe(7500);
    expect(moduleReach({ range: null, falloff: null })).toBe(Number.POSITIVE_INFINITY);
  });
});
