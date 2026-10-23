import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SdeClient } from './sde-client';
import { type Answer, FakeToolsCoreFetch, SDE, TOOLS_CORE } from './ship-data.testing';
import { WeaponData, type WeaponDataApi } from './weapon-data';

/**
 * tools-core's `weapons/types/<id>` records for every default weapon (packages/scene `DEFAULT_TURRETS` /
 * `DEFAULT_LAUNCHERS`, which include the dogma fixture's turrets), captured live from SDE build 3632936.
 */
export const WEAPON_FIXTURE_PATH = path.resolve(import.meta.dirname, '../../../../../packages/scene/src/lib/weapons/fixtures/weapons-3632936.json');

/**
 * The captured records by type id, read once.
 *
 * @returns The records.
 */
export function WeaponFixture(): Record<string, Record<string, unknown>> {
  cachedFixture ??= JSON.parse(readFileSync(WEAPON_FIXTURE_PATH, 'utf8')) as Record<string, Record<string, unknown>>;
  return cachedFixture;
}

let cachedFixture: Record<string, Record<string, unknown>> | null = null;

/**
 * tools-core routes for the captured records; any other type answers tools-core's 404.
 *
 * @returns The routes.
 */
export function WeaponRoutes(): Record<string, Answer> {
  const routes: Record<string, Answer> = { '/eve/latest/build': { json: { build: SDE, builds: { sde: SDE } } } };
  for (const [id, record] of Object.entries(WeaponFixture())) routes[`/eve/${SDE}/weapons/types/${id}`] = { json: record };
  return routes;
}

/**
 * A WeaponData over fake tools-core routes.
 *
 * @param routes - The routes. Default WeaponRoutes().
 * @returns The WeaponData and the calls it made.
 */
export function MakeRoutedWeaponData(routes: Record<string, Answer> = WeaponRoutes()): { readonly weaponData: WeaponData; readonly calls: string[] } {
  const { fetch, calls } = FakeToolsCoreFetch(routes);
  return { weaponData: new WeaponData({ sde: new SdeClient({ url: TOOLS_CORE, fetch }) }), calls };
}

/**
 * A WeaponDataApi over the captured records (another type answers `not-found`).
 *
 * @returns The fake.
 */
export function MakeFakeWeaponData(): WeaponDataApi {
  return MakeRoutedWeaponData().weaponData;
}
