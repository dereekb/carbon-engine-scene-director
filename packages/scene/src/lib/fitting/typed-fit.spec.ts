import type { Maybe } from '@dereekb/util';
import { describe, expect, it } from 'vitest';
import { tfisComposition } from '../compositions/compositions.spec-helper';
import type { FitTypeAnswer } from './dogma-bundle';
import { parseEftFit } from './eft';
import { DOGMA_FIXTURE, fixtureAnswer, fixtureTypeID } from './fitting.spec-helper';
import { eftTypeNames, fittingTypeIDs, type ShipFitting, toDogmaModules, typeEftFit } from './typed-fit';

const FITS = tfisComposition().fits ?? {};

function typed(text: string, answer: (name: string) => Maybe<FitTypeAnswer> = fixtureAnswer): ShipFitting {
  return typeEftFit(parseEftFit(text), { answer, bundle: DOGMA_FIXTURE });
}

describe('typeEftFit', () => {
  it('keys the TFI fit by slot in written order and types what the fixture knows', () => {
    const tfi = typed(FITS['tfi']);
    expect(tfi.hull).toBe('Tempest Fleet Issue');
    const keys = tfi.modules.map((module) => module.key);
    expect(keys).toEqual(['low-0', 'low-1', 'low-2', 'low-3', 'low-4', 'low-5', 'low-6', 'mid-0', 'mid-1', 'mid-2', 'mid-3', 'mid-4', 'high-0', 'high-1', 'high-2', 'high-3', 'high-4', 'high-5', 'high-6', 'high-7', 'rig-0', 'rig-1', 'rig-2']);
    const known = Object.fromEntries(tfi.modules.filter((module) => module.typeID != null).map((module) => [module.key, [module.name, module.category]]));
    expect(known).toEqual({
      'low-0': ['Damage Control II', 'damage-control'],
      'low-1': ['Imperial Navy 1600mm Steel Plates', 'other'],
      'low-2': ['Imperial Navy 1600mm Steel Plates', 'other'],
      'mid-0': ['500MN Cold-Gas Enduring Microwarpdrive', 'prop'],
      'mid-4': ['Warp Disruptor II', 'point'],
      'high-0': ['800mm Repeating Cannon II', 'weapon'],
      'high-1': ['800mm Repeating Cannon II', 'weapon'],
      'high-2': ['Heavy Energy Neutralizer II', 'neut'],
      'high-3': ['800mm Repeating Cannon II', 'weapon'],
      'high-4': ['800mm Repeating Cannon II', 'weapon'],
      'high-5': ['Heavy Energy Neutralizer II', 'neut'],
      'high-6': ['800mm Repeating Cannon II', 'weapon'],
      'high-7': ['800mm Repeating Cannon II', 'weapon'],
      'rig-0': ['Large Trimark Armor Pump I', 'other'],
      'rig-1': ['Large Trimark Armor Pump I', 'other'],
      'rig-2': ['Large Trimark Armor Pump I', 'other']
    });
    expect(tfi.modules.filter((module) => module.prop).map((module) => module.key)).toEqual(['mid-0']);
  });

  it('keeps cargo modules out of the fit and sorts cargo by category', () => {
    const tfi = typed(FITS['tfi']);
    const cargoModules = tfi.cargo.filter((item) => item.category === 'module').map((item) => item.name);
    expect(cargoModules).toEqual(['100MN Afterburner II', 'Signature Radius Suppressor I', 'Stasis Webifier II', 'Warp Scrambler II']);
    expect(tfi.charges.map((item) => [item.name, item.quantity])).toEqual([
      ['Barrage L', 1800],
      ['Hail L', 2000],
      ['Nanite Repair Paste', 250],
      ['Republic Fleet EMP L', 1000]
    ]);
    for (const name of cargoModules) expect(fittingTypeIDs(tfi)).not.toContain(fixtureTypeID(name));
    expect(tfi.modules.some((module) => module.name === '100MN Afterburner II')).toBe(false);
    expect(tfi.unknown).toContain('Republic Fleet Fusion L');
  });

  it('marks turrets and launchers by their effects, and ids the cargo charges for dogma', () => {
    const tfi = typed(FITS['tfi']);
    expect(tfi.modules.filter((module) => module.weapon).map((module) => [module.key, module.weapon])).toEqual(['high-0', 'high-1', 'high-3', 'high-4', 'high-6', 'high-7'].map((key) => [key, 'turret']));
    expect(typed('[Caracal, x]\nHeavy Missile Launcher II').modules[0]).toMatchObject({ category: 'weapon', weapon: 'launcher' });
    expect(typeEftFit(parseEftFit(FITS['tfi']), { answer: fixtureAnswer }).modules.some((module) => module.weapon)).toBe(false);
    expect(fittingTypeIDs(tfi)).toEqual(expect.arrayContaining(['Barrage L', 'Hail L', 'Republic Fleet EMP L'].map(fixtureTypeID)));
  });

  it("keeps the Damnation's lowercase /offline bursts offline and its cargo bursts out of the fit", () => {
    const burst = (name: string): Maybe<FitTypeAnswer> => (name.endsWith('Command Burst II') ? { typeID: name.startsWith('Armor') ? 43552 : 43555, name, groupID: 1770, categoryID: 7, category: 'module', slot: 'high' } : fixtureAnswer(name));
    const damnation = typed(FITS['damnation'], burst);
    const bursts = damnation.modules.filter((module) => module.category === 'command-burst');
    expect(bursts.map((module) => [module.name, module.offline])).toEqual([
      ['Armor Command Burst II', true],
      ['Armor Command Burst II', true],
      ['Armor Command Burst II', true],
      ['Skirmish Command Burst II', true],
      ['Skirmish Command Burst II', undefined],
      ['Information Command Burst II', undefined],
      ['Information Command Burst II', undefined]
    ]);
    expect(damnation.cargo.filter((item) => item.name.endsWith('Command Burst II')).map((item) => item.name)).toEqual(['Information Command Burst II', 'Skirmish Command Burst II']);
    const states = toDogmaModules(damnation);
    for (const module of bursts) expect(states.find((entry) => entry.key === module.key)?.state).toBe(module.offline ? 'offline' : 'online');
    expect(states.find((entry) => entry.key === 'low-0')?.state).toBe('online');
  });

  it('counts the Devoter empty high slot without keying it', () => {
    const devoter = typed(FITS['devoter']);
    expect(devoter.empty.high).toBe(1);
    expect(devoter.modules.filter((module) => module.slot === 'high').map((module) => module.key)).toEqual(['high-0', 'high-1', 'high-2', 'high-3', 'high-4']);
  });

  it('flags only the first prop mod, slots a module by its type, and lists unknown names', () => {
    const fit = typed(['[Rifter, test]', 'Nanite Repair Paste', '', '1MN Afterburner II', '5MN Microwarpdrive II', 'Not A Module, Not A Charge', '', 'Damage Control II', '', '', 'Nanite Repair Paste x10'].join('\n'));
    expect(fit.modules.map((module) => [module.key, module.name, module.prop ?? false])).toEqual([
      ['mid-0', '1MN Afterburner II', true],
      ['mid-1', '5MN Microwarpdrive II', false],
      ['mid-2', 'Not A Module', false],
      ['low-0', 'Damage Control II', false]
    ]);
    expect(fit.modules[2]).toEqual(expect.objectContaining({ typeID: null, groupID: null, category: 'other', charge: { name: 'Not A Charge', typeID: null } }));
    expect(fit.unknown).toEqual(['Not A Module', 'Not A Charge']);
    expect(fit.warnings).toEqual(['line 2: "Nanite Repair Paste" is a charge, not a module; counted as cargo']);
    expect(fit.charges.map((item) => item.quantity)).toEqual([10, 1]);
  });
});

describe('fit dogma inputs', () => {
  it('names each type once, ids the fitted modules and charges, and states them', () => {
    const text = ['[Damnation, test]', 'Large Ancillary Armor Repairer, Nanite Repair Paste', 'Damage Control II /OFFLINE', 'Damage Control II', '', '', 'Nanite Repair Paste x50'].join('\n');
    expect(eftTypeNames(parseEftFit(text))).toEqual(['Large Ancillary Armor Repairer', 'Nanite Repair Paste', 'Damage Control II']);
    const fit = typed(text);
    expect(fittingTypeIDs(fit)).toEqual([33103, 28668, 2048]);
    expect(toDogmaModules(fit)).toEqual([
      { key: 'low-0', typeID: 33103, state: 'online', chargeTypeID: 28668 },
      { key: 'low-1', typeID: 2048, state: 'offline' },
      { key: 'low-2', typeID: 2048, state: 'online' }
    ]);
    expect(toDogmaModules(fit, (module, fallback) => (module.key === 'low-0' ? 'active' : fallback))[0].state).toBe('active');
  });
});
