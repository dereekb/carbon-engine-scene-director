import { afterEach, describe, expect, it, vi } from 'vitest';
import { DogmaData } from './dogma-data';
import { EveDataStatusOf, HubEveDataSources, NoEveDataError, NoEveDataSources } from './eve-data';
import { ShipData, ShipDataError } from './ship-data';
import { WeaponData } from './weapon-data';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NoEveDataSources', () => {
  it('rejects every lookup at once with an unavailable NoEveDataError naming the mode, and never fetches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sources = NoEveDataSources();
    const lookups: (() => Promise<unknown>)[] = [
      () => sources.toolsCore.ResolveBuild(),
      () => sources.toolsCore.ResourceUrl('x.black'),
      () => sources.toolsCore.ResFileIndexUrl(),
      () => sources.toolsCore.AudioLibraryUrl(),
      () => sources.toolsCore.AudioPathUrl('x'),
      () => sources.toolsCore.SofCatalog('hulls'),
      () => sources.shipData.SdeBuild(),
      () => sources.shipData.Hull({ dna: 'af1_t1:minmatarbase:minmatar' }),
      () => sources.shipData.PropMod(12076),
      () => sources.shipData.PropModByName('10MN AB II'),
      () => sources.dogmaData.TypeByName('Damage Control II'),
      () => sources.dogmaData.Bundle([2048]),
      () => sources.dogmaData.Skills(),
      () => sources.weaponData.Weapon(2929),
      () => sources.weaponData.Missile(1, 2),
      () => sources.mapData.Index(),
      () => sources.mapData.Search({ query: 'Jita' }),
      () => sources.mapData.System(30000142),
      () => sources.mapData.SystemCelestials(30000142),
      () => sources.mapData.Celestial(40009077),
      () => sources.objectData.Type({ type: 'Astrahus' }),
      () => sources.objectData.Search({ query: 'Astrahus' }),
      () => sources.asteroidData.Ore('Veldspar'),
      () => sources.asteroidData.RockSet('veldspar')
    ];
    for (const lookup of lookups) {
      const error = await lookup().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NoEveDataError);
      expect(error).toBeInstanceOf(ShipDataError);
      expect((error as ShipDataError).failure).toBe('unavailable');
      expect((error as Error).message).toMatch(/needs EVE data, and this hub runs without EVE data \(--eve-data off/u);
    }
    expect(await sources.toolsCore.Status()).toMatchObject({ reachable: false, build: null, error: expect.stringMatching(/--eve-data off/u) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says what works instead', async () => {
    const sources = NoEveDataSources();
    await expect(sources.shipData.Hull({ type: 'Rifter' })).rejects.toThrow(/the hull lookup for "Rifter" needs EVE data.*name hulls by dna/u);
    await expect(sources.objectData.Type({ type: 'Astrahus' })).rejects.toThrow(/place it by dna/u);
  });
});

describe('HubEveDataSources', () => {
  it('ignores injected sources with the mode off', async () => {
    const shipData = { SdeBuild: vi.fn(), Hull: vi.fn(), PropMod: vi.fn(), PropModByName: vi.fn() };
    const sources = HubEveDataSources({ mode: 'off', shipData });
    await expect(sources.shipData.Hull({ dna: 'x' })).rejects.toBeInstanceOf(NoEveDataError);
    expect(shipData.Hull).not.toHaveBeenCalled();
  });

  it('shares one SDE client between the default ship, dogma and weapon data with tools-core', () => {
    const sources = HubEveDataSources({ mode: 'tools-core' });
    expect(sources.shipData).toBeInstanceOf(ShipData);
    const sde = (sources.shipData as ShipData).sde;
    expect(sources.dogmaData).toBeInstanceOf(DogmaData);
    expect(sources.weaponData).toBeInstanceOf(WeaponData);
    expect(Reflect.get(sources.dogmaData, 'sde')).toBe(sde);
    expect(Reflect.get(sources.weaponData, 'sde')).toBe(sde);
  });
});

describe('EveDataStatusOf', () => {
  it('has a note only while off', () => {
    expect(EveDataStatusOf('tools-core')).toEqual({ mode: 'tools-core' });
    expect(EveDataStatusOf('off')).toMatchObject({ mode: 'off', note: expect.stringMatching(/^no EVE data: .*stand-in cubes/u) });
  });
});
