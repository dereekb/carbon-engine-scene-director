/**
 * Weapon graphics from tools-core: `weapons/types/<id>` gives a turret's or launcher's `.black`, its slot collection
 * and size, and the SOF faction of its graphic. The page mounts fitted weapons from these (the hub's `GET /weapon`).
 * A type with no weapon graphic answers 404 (`not-found`). Cached per hub.
 */

import { readWeaponGraphic, type WeaponGraphic } from '@scene-director/scene';
import { ReadName, type SdeClient, ShipDataError } from './sde-client';

export interface WeaponDataApi {
  /**
   * A weapon type's graphic.
   */
  Weapon(typeID: number): Promise<WeaponGraphic>;
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
}
