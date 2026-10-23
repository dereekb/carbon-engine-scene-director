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

  it("reads a missile's impact effect from the launcher's ammunition and its EveMissile from the projectile", async () => {
    const { weaponData, calls } = MakeRoutedWeaponData();
    expect(await weaponData.Missile(20307, 25715)).toEqual({
      chargeTypeID: 20307,
      name: 'Scourge Heavy Assault Missile',
      launcherTypeID: 25715,
      impactResPath: 'res:/dx9/model/turret/launcher/heavyassault/heavyassault_impact_scourge.black',
      projectileGraphicID: 21937,
      projectileResPath: 'res:/dx9/model/turret/launcher/heavyassault/heavyassault_missile.black'
    });
    // A rapid light fires light missiles; ammunition is cached per launcher, projectiles per id.
    expect(await weaponData.Missile(210, 1877)).toMatchObject({ name: 'Scourge Light Missile', projectileGraphicID: 21938 });
    expect(await weaponData.Missile(211, 2404)).toMatchObject({ impactResPath: 'res:/dx9/model/turret/launcher/light/light_impact_inferno.black', projectileGraphicID: 21938 });
    expect(calls.filter((call) => call.includes('/weapons/'))).toEqual([`/eve/${SDE}/weapons/types/25715/ammunition`, `/eve/${SDE}/weapons/projectiles/21937`, `/eve/${SDE}/weapons/types/1877/ammunition`, `/eve/${SDE}/weapons/projectiles/21938`, `/eve/${SDE}/weapons/types/2404/ammunition`]);
  });

  it('answers not-found for a charge the launcher does not fire or without a projectile, invalid for bad ids', async () => {
    const routes = WeaponRoutes();
    routes[`/eve/${SDE}/weapons/types/9/ammunition`] = { json: [{ typeID: 209, name: { en: 'Scourge Heavy Missile' }, resPath: 'res:/x.black' }] };
    const { weaponData } = MakeRoutedWeaponData(routes);
    await expect(weaponData.Missile(209, 2404)).rejects.toMatchObject({ failure: 'not-found' });
    await expect(weaponData.Missile(209, 9)).rejects.toMatchObject({ failure: 'not-found' });
    await expect(weaponData.Missile(209, 448)).rejects.toMatchObject({ failure: 'not-found' });
    await expect(weaponData.Missile(0, 2410)).rejects.toMatchObject({ failure: 'invalid' });
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
