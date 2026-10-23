import { describe, expect, it } from 'vitest';
import { tfisComposition } from '../compositions/compositions.spec-helper';
import { parseEftFit } from '../fitting/eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID } from '../fitting/fitting.spec-helper';
import { type ShipFitting, typeEftFit } from '../fitting/typed-fit';
import { CHARGE_LOADED_FROM_CARGO, chargeFitsModule, DEFAULT_MISSILE_LOADED, loadCargoCharges, NO_CHARGE_LOADED } from './charges';
import { defaultMissileOf } from './default-missiles';

const FITS = tfisComposition().fits ?? {};

function typed(text: string): ShipFitting {
  return typeEftFit(parseEftFit(text), { answer: fixtureAnswer, bundle: DOGMA_FIXTURE });
}

function record(name: string) {
  return DOGMA_FIXTURE.types[fixtureTypeID(name)];
}

describe('chargeFitsModule', () => {
  it('matches charge group and size', () => {
    expect(chargeFitsModule(record('800mm Repeating Cannon II'), record('Barrage L'))).toBe(true);
    expect(chargeFitsModule(record('800mm Repeating Cannon II'), record('EMP S'))).toBe(false);
    expect(chargeFitsModule(record('800mm Repeating Cannon II'), record('Multifrequency L'))).toBe(false);
    expect(chargeFitsModule(record('Dual Giga Pulse Laser II'), record('Conflagration XL'))).toBe(true);
    expect(chargeFitsModule(record('Medium Vorton Projector II'), record('ElectroPunch Ultra M'))).toBe(true);
  });
});

describe('loadCargoCharges', () => {
  it("loads the TFI's guns with the first fitting cargo charge, Barrage L, and leaves the rest alone", () => {
    const tfi = typed(FITS['tfi']);
    const loaded = loadCargoCharges(tfi.modules, tfi.charges, DOGMA_FIXTURE);
    const guns = loaded.filter((module) => module.weapon === 'turret');
    expect(guns.map((module) => module.key)).toEqual(['high-0', 'high-1', 'high-3', 'high-4', 'high-6', 'high-7']);
    for (const gun of guns) expect(gun).toMatchObject({ charge: { name: 'Barrage L', typeID: 12775 }, chargeNote: CHARGE_LOADED_FROM_CARGO });
    expect(loaded.find((module) => module.key === 'high-2')).toBe(tfi.modules.find((module) => module.key === 'high-2'));
  });

  it("loads the Revelation's XL lasers with Conflagration XL", () => {
    const revelation = typed(FITS['revelation']);
    const guns = loadCargoCharges(revelation.modules, revelation.charges, DOGMA_FIXTURE).filter((module) => module.weapon === 'turret');
    expect(guns.map((module) => [module.name, module.charge?.name, module.chargeNote])).toEqual(Array.from({ length: 3 }, () => ['Dual Giga Pulse Laser II', 'Conflagration XL', CHARGE_LOADED_FROM_CARGO]));
  });

  it('keeps a loaded charge, notes a turret with none to load, and gives a turret no default', () => {
    const fit = typed(['[Tempest Fleet Issue, test]', '800mm Repeating Cannon II, Hail L', '800mm Repeating Cannon II', 'Heavy Missile Launcher II', '', '', 'EMP S x100'].join('\n'));
    const loaded = loadCargoCharges(fit.modules, fit.charges, DOGMA_FIXTURE, { defaultMissile: (launcher) => defaultMissileOf(launcher, 'kinetic') });
    expect(loaded.map((module) => [module.key, module.charge?.name ?? null, module.chargeNote ?? null])).toEqual([
      ['high-0', 'Hail L', null],
      ['high-1', null, NO_CHARGE_LOADED],
      ['high-2', 'Scourge Heavy Missile', DEFAULT_MISSILE_LOADED]
    ]);
  });

  it('loads a launcher with the first fitting missile in cargo, else the default missile, else nothing', () => {
    const text = ['[Caracal, test]', '[Empty Low slot]', '', '[Empty Med slot]', '', 'Heavy Missile Launcher II', 'Heavy Missile Launcher II, Nova Heavy Missile', 'Light Missile Launcher II', 'Core Probe Launcher II', '', '', 'Scourge Light Missile x100', 'Mjolnir Heavy Missile x100'].join('\n');
    const fit = typed(text);
    const kinetic = { defaultMissile: (launcher: Parameters<typeof defaultMissileOf>[0]) => defaultMissileOf(launcher, 'kinetic') };
    expect(loadCargoCharges(fit.modules, fit.charges, DOGMA_FIXTURE, kinetic).map((module) => [module.key, module.charge?.name ?? null, module.chargeNote ?? null])).toEqual([
      ['high-0', 'Mjolnir Heavy Missile', CHARGE_LOADED_FROM_CARGO],
      ['high-1', 'Nova Heavy Missile', null],
      ['high-2', 'Scourge Light Missile', CHARGE_LOADED_FROM_CARGO],
      ['high-3', null, null]
    ]);
    const empty = typed(['[Caracal, test]', '[Empty Low slot]', '', '[Empty Med slot]', '', 'Heavy Missile Launcher II', '', '', 'EMP S x100'].join('\n'));
    expect(loadCargoCharges(empty.modules, empty.charges, DOGMA_FIXTURE, kinetic)[0]).toMatchObject({ charge: { name: 'Scourge Heavy Missile', typeID: 209 }, chargeNote: DEFAULT_MISSILE_LOADED });
    expect(loadCargoCharges(empty.modules, empty.charges, DOGMA_FIXTURE)[0]).toMatchObject({ chargeNote: NO_CHARGE_LOADED });
    expect(loadCargoCharges(empty.modules, empty.charges, DOGMA_FIXTURE)[0].charge).toBeUndefined();
  });

  it('leaves modules the bundle lacks as they are', () => {
    const tfi = typed(FITS['tfi']);
    expect(loadCargoCharges(tfi.modules, tfi.charges, null)).toEqual(tfi.modules);
  });
});
