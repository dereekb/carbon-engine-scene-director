import { describe, expect, it } from 'vitest';
import { readMissileGraphic, readWeaponGraphic } from './graphic';

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

/**
 * The hub's `/missile?charge=209&launcher=2410` answer (tools-core SDE 3632936).
 */
const SCOURGE_HEAVY = { chargeTypeID: 209, name: 'Scourge Heavy Missile', launcherTypeID: 2410, impactResPath: 'res:/dx9/model/turret/launcher/heavy/heavy_impact_scourge.black', projectileGraphicID: 21936, projectileResPath: 'res:/dx9/model/turret/launcher/heavy/heavy_missile.black' };

describe('readMissileGraphic', () => {
  it('reads the Scourge Heavy Missile answer and rejects junk', () => {
    expect(readMissileGraphic({ ...SCOURGE_HEAVY, extra: 1 })).toEqual(SCOURGE_HEAVY);
    expect(readMissileGraphic(null)).toBeNull();
    expect(readMissileGraphic({ ...SCOURGE_HEAVY, impactResPath: 'res:/dx9/model/turret/launcher/heavy/heavy_impact_scourge.red' })).toBeNull();
    expect(readMissileGraphic({ ...SCOURGE_HEAVY, projectileResPath: 'https://example.com/x.black' })).toBeNull();
    expect(readMissileGraphic({ ...SCOURGE_HEAVY, chargeTypeID: '209' })).toBeNull();
  });
});
