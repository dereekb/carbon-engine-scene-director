import { describe, expect, it } from 'vitest';
import { readWeaponGraphic } from './graphic';

/**
 * The hub's `/weapon?type=2913` answer (tools-core `weapons/types/2913`, SDE 3632936), ammunition trimmed.
 */
const AUTOCANNON = { typeID: 2913, name: '425mm AutoCannon II', kind: 'turret', slot: 'turrets', size: 2, resPath: 'res:/dx9/model/turret/projectile/auto/m/auto_425mm_t1.black', sofFactionName: 'brutor', chargeSize: 2, ammunitionTypeIDs: [186, 187, 193] };

describe('readWeaponGraphic', () => {
  it('reads the live 425mm AutoCannon II record', () => {
    expect(readWeaponGraphic(AUTOCANNON)).toEqual(AUTOCANNON);
    expect(readWeaponGraphic({ ...AUTOCANNON, sofFactionName: '', chargeSize: undefined, ammunitionTypeIDs: [1, 'x'] })).toEqual({ typeID: 2913, name: '425mm AutoCannon II', kind: 'turret', slot: 'turrets', size: 2, resPath: AUTOCANNON.resPath, ammunitionTypeIDs: [1] });
  });

  it('rejects junk', () => {
    expect(readWeaponGraphic(null)).toBeNull();
    expect(readWeaponGraphic({ ...AUTOCANNON, kind: 'drone' })).toBeNull();
    expect(readWeaponGraphic({ ...AUTOCANNON, slot: 'bays' })).toBeNull();
    expect(readWeaponGraphic({ ...AUTOCANNON, resPath: 'res:/dx9/model/turret/auto.red' })).toBeNull();
    expect(readWeaponGraphic({ ...AUTOCANNON, typeID: -1 })).toBeNull();
  });
});
