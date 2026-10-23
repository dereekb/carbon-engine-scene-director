import { describe, expect, it } from 'vitest';
import { EFFECTLESS_CATEGORIES, falloffEffectiveness, moduleActivationOf, moduleReach, NO_MISSILE_REFUSAL } from './activation';
import { evaluateShipDogma } from './dogma';
import { parseEftFit } from './eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID, GUARDIAN_ID, REVELATION_ID, RIFTER_ID } from './fitting.spec-helper';
import { toDogmaModules, typeEftFit } from './typed-fit';

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

  it('marks siege as changing the flight, carries target effects, and refuses passive modules', () => {
    const [siege] = activations(REVELATION_ID, 'Siege Module II');
    expect(siege).toMatchObject({ category: 'siege', flight: true, warpSafe: false, refusal: null });
    const [web, scram, plate, point, neut] = activations(RIFTER_ID, 'Stasis Webifier II', 'Warp Scrambler II', '200mm Steel Plates II', 'Warp Disruptor II', 'Heavy Energy Neutralizer II');
    expect(web).toMatchObject({ category: 'web', targeted: true, targetEffect: { effect: 'remoteWebifierFalloff' } });
    for (const module of [web, scram, point, neut]) expect(module?.note).toBeUndefined();
    expect(scram?.targetEffect?.blocksMicrowarpdrive).toBe(true);
    expect(point?.targetEffect?.modifiers).toEqual([{ attributeID: 104, operation: 2, amount: 1 }]);
    expect(neut?.targetEffect?.capacitor).toEqual({ kind: 'neut', amount: 600 });
    expect(EFFECTLESS_CATEGORIES).toEqual({
      'command-burst': 'cycles without effect: command burst buffs are not modelled yet',
      'cap-booster': 'cycles without effect: cap boosters do not refill the live capacitor yet',
      'weapon-disruptor': 'cycles without effect: weapons are not modelled yet',
      'sensor-dampener': 'cycles without effect: locks are not modelled yet',
      ecm: 'cycles without effect: locks are not modelled yet'
    });
    expect(web?.reach).toBe(moduleReach(web ?? { range: null, falloff: null }));
    expect(web?.reach).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(scram).toMatchObject({ category: 'scram', targeted: true, falloff: null });
    expect(plate?.refusal).toBe('it is passive: it is only online or offline');
    expect(plate?.reach).toBe(Number.POSITIVE_INFINITY);
  });

  it('runs a turret on its target at any range, on its rate of fire', () => {
    const [gun] = activations(RIFTER_ID, '200mm AutoCannon II');
    expect(gun).toMatchObject({ category: 'weapon', weapon: 'turret', refusal: null, targeted: true, warpSafe: false, reach: Number.POSITIVE_INFINITY });
    expect(gun?.note).toBeUndefined();
    expect(gun?.range).toBeGreaterThan(0);
    expect(gun?.falloff).toBeGreaterThan(0);
    expect(gun?.cycleTime).toBeGreaterThan(0);
    expect(gun?.cycleTime).toBeLessThan(5);
  });

  it('runs a launcher on its target at any range, on its rate of fire, and refuses bomb launchers and launchers without missiles', () => {
    const text = ['[Caracal, test]', '[Empty Low slot]', '', '[Empty Med slot]', '', 'Heavy Missile Launcher II, Scourge Heavy Missile', 'Heavy Missile Launcher II', 'Bomb Launcher I'].join('\n');
    const fitting = typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
    const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: fixtureTypeID(fitting.hull), modules: toDogmaModules(fitting) });
    const [launcher, empty, bombs] = ['high-0', 'high-1', 'high-2'].map((key) => moduleActivationOf(ship, DOGMA_FIXTURE, key));
    expect(launcher).toMatchObject({ category: 'weapon', weapon: 'launcher', refusal: null, targeted: true, warpSafe: false, reach: Number.POSITIVE_INFINITY });
    expect(launcher?.cycleTime).toBeCloseTo(6.1965, 4);
    expect(launcher?.note).toBeUndefined();
    expect(empty).toMatchObject({ weapon: 'launcher', refusal: NO_MISSILE_REFUSAL });
    expect(bombs?.refusal).toBe('bomb launchers are not modelled yet');
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
