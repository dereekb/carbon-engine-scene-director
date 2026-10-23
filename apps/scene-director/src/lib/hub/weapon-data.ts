/**
 * Weapon graphics from tools-core: `weapons/types/<id>` gives a turret's or launcher's `.black`, its slot collection
 * and size, and the SOF faction of its graphic. The page mounts fitted weapons from these (the hub's `GET /weapon`).
 * A type with no weapon graphic answers 404 (`not-found`). Missiles (the hub's `GET /missile`): a launcher's
 * `weapons/types/<id>/ammunition` row for the charge (its impact effect and projectile graphic id), then
 * `weapons/projectiles/<id>` (the EveMissile). Cached per hub: weapons and projectiles per id, ammunition per launcher.
 */

import { type MissileGraphic, readMissileGraphic, readWeaponGraphic, type WeaponGraphic } from '@scene-director/scene';
import { type JsonObject, ReadName, ReadNumber, type SdeClient, ShipDataError } from './sde-client';

export interface WeaponDataApi {
  /**
   * A weapon type's graphic.
   */
  Weapon(typeID: number): Promise<WeaponGraphic>;
  /**
   * A missile's graphics when a launcher fires it.
   */
  Missile(chargeTypeID: number, launcherTypeID: number): Promise<MissileGraphic>;
}

export class WeaponData implements WeaponDataApi {
  private readonly sde: SdeClient;

  constructor({ sde }: { readonly sde: SdeClient }) {
    this.sde = sde;
  }

  /**
   * A weapon type's graphic.
   *
   * @param typeID - The weapon's EVE type id.
   * @returns The graphic.
   * @throws {ShipDataError} `not-found` for a type with no weapon graphic, `unavailable` without an SDE.
   */
  async Weapon(typeID: number): Promise<WeaponGraphic> {
    if (!Number.isSafeInteger(typeID) || typeID <= 0) throw new ShipDataError('invalid', 'type must be an EVE type id');
    return this.sde.Cached(`weapon:${typeID}`, async () => {
      const body = await this.sde.GetJson({ route: `weapons/types/${typeID}`, what: `weapon graphic for type ${typeID}` });
      const graphic = readWeaponGraphic({ ...body, typeID: body['typeID'] ?? typeID, name: ReadName(body['name']) ?? `type ${typeID}` });
      if (!graphic) throw new ShipDataError('not-found', `tools-core's weapon record for type ${typeID} has no usable graphic`);
      return graphic;
    });
  }

  /**
   * A missile's graphics when a launcher fires it: the charge's impact effect and its projectile (EveMissile).
   *
   * @param chargeTypeID - The missile's EVE type id.
   * @param launcherTypeID - The launcher's EVE type id.
   * @returns The graphics.
   * @throws {ShipDataError} `invalid` for ids that are not ids, `not-found` for a charge the launcher does not fire or
   * one with no projectile graphic, `unavailable` without an SDE.
   */
  async Missile(chargeTypeID: number, launcherTypeID: number): Promise<MissileGraphic> {
    for (const id of [chargeTypeID, launcherTypeID]) if (!Number.isSafeInteger(id) || id <= 0) throw new ShipDataError('invalid', 'charge and launcher must be EVE type ids');
    const rows = await this.Ammunition(launcherTypeID);
    const row = rows.find((candidate) => ReadNumber(candidate['typeID']) === chargeTypeID);
    if (!row) throw new ShipDataError('not-found', `launcher type ${launcherTypeID} does not fire charge type ${chargeTypeID}`);
    const projectileGraphicID = ReadNumber(row['projectileGraphicID']);
    if (projectileGraphicID == null) throw new ShipDataError('not-found', `charge type ${chargeTypeID} has no projectile graphic`);
    const projectile = await this.Projectile(projectileGraphicID);
    const graphic = readMissileGraphic({ chargeTypeID, name: ReadName(row['name']) ?? `type ${chargeTypeID}`, launcherTypeID, impactResPath: row['resPath'], projectileGraphicID, projectileResPath: projectile['resPath'] });
    if (!graphic) throw new ShipDataError('not-found', `tools-core's missile records for charge type ${chargeTypeID} have no usable graphics`);
    return graphic;
  }

  private Ammunition(launcherTypeID: number): Promise<JsonObject[]> {
    return this.sde.Cached(`ammunition:${launcherTypeID}`, () => this.sde.GetJsonArray({ route: `weapons/types/${launcherTypeID}/ammunition`, what: `ammunition for launcher type ${launcherTypeID}` }));
  }

  private Projectile(graphicID: number): Promise<JsonObject> {
    return this.sde.Cached(`projectile:${graphicID}`, () => this.sde.GetJson({ route: `weapons/projectiles/${graphicID}`, what: `projectile graphic ${graphicID}` }));
  }
}
