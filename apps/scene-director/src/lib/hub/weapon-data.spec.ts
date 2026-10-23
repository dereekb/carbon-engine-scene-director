import { describe, expect, it } from 'vitest';
import { SDE } from './ship-data.testing';
import { MakeRoutedWeaponData, WeaponRoutes } from './weapon-data.testing';

describe('WeaponData', () => {
  it("reads tools-core's weapon record as a WeaponGraphic", async () => {
    const { weaponData } = MakeRoutedWeaponData();
    const autocannon = await weaponData.Weapon(2913);
    expect(autocannon).toMatchObject({ typeID: 2913, name: '425mm AutoCannon II', kind: 'turret', slot: 'turrets', size: 2, resPath: 'res:/dx9/model/turret/projectile/auto/m/auto_425mm_t1.black', sofFactionName: 'brutor', chargeSize: 2 });
    expect(autocannon.ammunitionTypeIDs).toContain(193);
    expect(await weaponData.Weapon(37298)).toMatchObject({ slot: 'xlTurrets', sofFactionName: 'sarum' });
    expect(await weaponData.Weapon(2410)).toMatchObject({ kind: 'launcher', slot: 'launchers' });
    expect(await weaponData.Weapon(54748)).not.toHaveProperty('sofFactionName');
  });

  it('answers not-found for a type with no weapon graphic or an unusable record, and refuses a bad id', async () => {
    const routes = WeaponRoutes();
    routes[`/eve/${SDE}/weapons/types/1`] = { json: { typeID: 1, kind: 'turret', resPath: 'nope' } };
    const { weaponData } = MakeRoutedWeaponData(routes);
    await expect(weaponData.Weapon(448)).rejects.toMatchObject({ failure: 'not-found' });
    await expect(weaponData.Weapon(1)).rejects.toMatchObject({ failure: 'not-found' });
    await expect(weaponData.Weapon(-3)).rejects.toMatchObject({ failure: 'invalid' });
  });

  it('caches per hub', async () => {
    const { weaponData, calls } = MakeRoutedWeaponData();
    await weaponData.Weapon(2913);
    await weaponData.Weapon(2913);
    expect(calls.filter((call) => call.includes('weapons/types'))).toEqual([`/eve/${SDE}/weapons/types/2913`]);
  });

  it('maps an unprepared SDE or an unreachable tools-core to unavailable', async () => {
    const unprepared = MakeRoutedWeaponData({ '/eve/latest/build': { json: { builds: { sde: '42' } } }, '/eve/42/weapons/types/2913': { status: 404, json: { error: 'SDE build 42 is not prepared' } } });
    await expect(unprepared.weaponData.Weapon(2913)).rejects.toMatchObject({ failure: 'unavailable' });
    const down = MakeRoutedWeaponData({ '/eve/latest/build': 'network-error' });
    await expect(down.weaponData.Weapon(2913)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
