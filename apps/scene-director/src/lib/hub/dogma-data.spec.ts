import { describe, expect, it } from 'vitest';
import { DogmaFixture, DogmaRoutes, MakeRoutedDogmaData } from './dogma-data.testing';
import { SDE } from './ship-data.testing';
import { ShipDataError } from './sde-client';

describe('DogmaData', () => {
  it('resolves a fit line name to its type, category and slot, mapping medium to mid', async () => {
    const { dogmaData } = MakeRoutedDogmaData();
    expect(await dogmaData.TypeByName('Warp Scrambler II', 'Rifter')).toEqual({ typeID: 448, name: 'Warp Scrambler II', groupID: 52, categoryID: 7, category: 'module', slot: 'mid' });
    expect(await dogmaData.TypeByName('Nanite Repair Paste')).toMatchObject({ typeID: 28668, category: 'charge', slot: null });
    expect(await dogmaData.TypeByName('Large Trimark Armor Pump I')).toMatchObject({ slot: 'rig' });
  });

  it('answers not-found for an unknown name and retries an unknown header hull on the anchor hull', async () => {
    const routes = DogmaRoutes();
    routes[`POST /eve/${SDE}/fitting/parse [Nope Hull, resolve]\nDamage Control II`] = { status: 400, json: { error: 'Unknown hull in EFT header: Nope Hull' } };
    const { dogmaData, calls } = MakeRoutedDogmaData(routes);
    await expect(dogmaData.TypeByName('No Such Thing')).rejects.toMatchObject({ failure: 'not-found', message: 'no EVE type is named "No Such Thing"' });
    expect(await dogmaData.TypeByName('Damage Control II', 'Nope Hull')).toMatchObject({ typeID: 2048, slot: 'low' });
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([`POST /eve/${SDE}/fitting/parse [Rifter, resolve]\nNo Such Thing`, `POST /eve/${SDE}/fitting/parse [Nope Hull, resolve]\nDamage Control II`, `POST /eve/${SDE}/fitting/parse [Rifter, resolve]\nDamage Control II`]);
  });

  it('caches names, and refuses an empty or multi-line name', async () => {
    const { dogmaData, calls } = MakeRoutedDogmaData();
    await dogmaData.TypeByName('Damage Control II');
    await dogmaData.TypeByName(' Damage Control II ');
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    await expect(dogmaData.TypeByName('a\nb')).rejects.toBeInstanceOf(ShipDataError);
  });

  it('builds the bundle the fixture holds: types, the effects they carry, the attributes those name', async () => {
    const fixture = DogmaFixture();
    const { dogmaData } = MakeRoutedDogmaData();
    const bundle = await dogmaData.Bundle([2048, 587, 2048, 99999999]);
    expect(Object.keys(bundle.types)).toEqual(['587', '2048']);
    expect(bundle.types['2048']).toEqual(fixture.types['2048']);
    expect(bundle.missing).toEqual([99999999]);
    expect(bundle.types['587'].raceID).toBe(2);
    expect(bundle.types['2048']).not.toHaveProperty('raceID');
    for (const effect of fixture.types['2048'].effects) expect(bundle.effects[effect]).toEqual(fixture.effects[effect]);
    expect(bundle.effects['2302'].modifiers).toContainEqual({ func: 'ItemModifier', domain: 'shipID', modifiedAttributeID: 267, modifyingAttributeID: 267, operation: 0 });
    expect(bundle.attributes['267']).toEqual({ attributeID: 267, name: 'armorEmDamageResonance', stackable: false, highIsGood: false, defaultValue: 1, maxAttributeID: 1527 });
    expect(bundle.attributes['1527']).toBeDefined();
  });

  it('carries an effect resistance attribute and the fixed tackle and resistance records', async () => {
    const { dogmaData } = MakeRoutedDogmaData();
    const bundle = await dogmaData.Bundle([12271, 527]);
    expect(bundle.effects['6187']).toMatchObject({ name: 'energyNeutralizerFalloff', resistanceAttributeID: 2045 });
    expect(bundle.effects['6426']).not.toHaveProperty('resistanceAttributeID');
    expect(bundle.types['527'].attributes['2138']).toBe(2115);
    for (const id of [97, 90, 104, 105, 1349, 1945, 2138, 2045, 2114, 2115, 6463]) expect(bundle.attributes[id]).toBeDefined();
    expect(bundle.attributes['2115']).toMatchObject({ name: 'stasisWebifierResistance', defaultValue: 1 });
  });

  it('lists every published skill once per hub', async () => {
    const { dogmaData, calls } = MakeRoutedDogmaData();
    const skills = await dogmaData.Skills();
    expect(Object.keys(skills.types)).toHaveLength(512);
    expect(skills.types['3394']?.name).toBe('Hull Upgrades');
    const made = calls.length;
    await dogmaData.Skills();
    expect(calls).toHaveLength(made);
  });

  it('maps an unprepared SDE to unavailable', async () => {
    const { dogmaData } = MakeRoutedDogmaData({ '/eve/latest/build': { json: { builds: { sde: '42' } } }, '/eve/42/types/2048?lang=en': { status: 404, json: { error: 'SDE build 42 is not prepared' } }, '/eve/42/sde/typeDogma/2048': { status: 404, json: { error: 'SDE build 42 is not prepared' } } });
    await expect(dogmaData.Bundle([2048])).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
