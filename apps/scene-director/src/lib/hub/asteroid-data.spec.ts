import { describe, expect, it } from 'vitest';
import { ASTEROID_ROUTES, MakeFakeAsteroidData } from './asteroid-data.testing';
import { CloseOreNames } from './asteroid-data';
import { SDE } from './ship-data.testing';

describe('AsteroidData', () => {
  it('resolves an ore name to its type, group and SOF rock faction', async () => {
    const { asteroidData } = MakeFakeAsteroidData();
    expect(await asteroidData.Ore('Veldspar')).toEqual({ typeID: 1230, name: 'Veldspar', groupID: 462, group: 'Veldspar', faction: 'ore_veldspar', factionFrom: 'group' });
    expect(await asteroidData.Ore('Dark Ochre IV-Grade')).toMatchObject({ typeID: 46675, name: 'Dark Ochre IV-Grade', faction: 'crystal_darkochre' });
    expect(await asteroidData.Ore('Blue Ice IV-Grade')).toMatchObject({ typeID: 17975, group: 'Ice', faction: 'ice_blue', factionFrom: 'ice' });
    expect(await asteroidData.Ore('Common Moon Asteroids')).toEqual({ typeID: null, name: 'Common Moon Asteroids', groupID: 1920, group: 'Common Moon Asteroids', faction: 'r08', factionFrom: 'group' });
  });

  it('refuses unmapped ores, non-ores and unknown names', async () => {
    const { asteroidData } = MakeFakeAsteroidData();
    await expect(asteroidData.Ore('Mordunium')).rejects.toThrow('no SOF rock set is known for Mordunium (group Mordunium); give { faction: "<SOF rock faction>" } or { rocks: [dna, ...] }');
    await expect(asteroidData.Ore('Tritanium')).rejects.toThrow('Tritanium is a Mineral, not an asteroid ore');
    await expect(asteroidData.Ore('Veldsparr')).rejects.toThrow(/^no asteroid ore is named "Veldsparr"; close names: Veldspar; known ores: Veldspar, Scordite/u);
    expect(CloseOreNames('dark ocher')).toEqual(['Dark Ochre', 'Dark Glitter']);
  });

  it('buckets a faction rock set from the SDE graphics table', async () => {
    const { asteroidData } = MakeFakeAsteroidData();
    const veldspar = await asteroidData.RockSet('ore_veldspar');
    expect(veldspar.rocks.small).toHaveLength(4);
    expect(veldspar.rocks.medium[0]).toBe('rock_01_m_v1a_whiteyellow:ore_veldspar:asteroid');
    expect(veldspar.rocks.large).toHaveLength(4);
    expect(veldspar.skipped).toEqual(['as1_l_03_whitebrown', 'rock_01_field_v1a_whiteyellow']);
    expect((await asteroidData.RockSet('r08')).rocks.medium).toHaveLength(8);
    await expect(asteroidData.RockSet('ore_nothing')).rejects.toThrow(`SOF faction "ore_nothing" has no rock models in SDE build ${SDE}`);
  });

  it('caches each lookup once and reads a 500 as no SDE', async () => {
    const { asteroidData, calls } = MakeFakeAsteroidData();
    await asteroidData.Ore('Veldspar');
    await asteroidData.Ore('veldspar');
    await asteroidData.RockSet('ore_veldspar');
    await asteroidData.RockSet('ore_veldspar');
    expect(calls.filter((call) => call.includes('sde/groups?field=categoryID'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('value=ore_veldspar'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('types?query=Veldspar'))).toHaveLength(1);
    const broken = MakeFakeAsteroidData({ ...ASTEROID_ROUTES, [`/eve/${SDE}/sde/graphics?field=sofFactionName&value=ice_blue&limit=200`]: { status: 500, json: { error: 'SDE not prepared' } } });
    await expect(broken.asteroidData.RockSet('ice_blue')).rejects.toThrow(`tools-core has no SDE for build ${SDE} (SDE not prepared). In the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${SDE} (Node 22).`);
  });
});
