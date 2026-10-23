import { describe, expect, it } from 'vitest';
import { evaluateShipDogma } from './dogma';
import { moduleActivationOf } from './activation';
import { MODULE_EFFECTS, moduleEffectOf, moduleEffectSounds, nearestSoundDuration } from './effects';
import { DOGMA_FIXTURE, fixtureTypeID, GUARDIAN_ID } from './fitting.spec-helper';

describe('module effects', () => {
  it("names each fixture module's client effect by its default effect's guid", () => {
    const names = ['Domination Thermal Armor Hardener', 'Large Remote Armor Repairer II', 'Stasis Webifier II', 'Medium Shield Booster II', 'Damage Control II', '10MN Afterburner II'];
    const ship = evaluateShipDogma({ bundle: DOGMA_FIXTURE, hullTypeID: GUARDIAN_ID, modules: names.map((name, index) => ({ key: `m-${index}`, typeID: fixtureTypeID(name), state: 'online' })) });
    const effects = names.map((_name, index) => moduleEffectOf(moduleActivationOf(ship, DOGMA_FIXTURE, `m-${index}`)?.effectGuid));
    expect(effects.map((effect) => effect && [effect.kind, effect.resPath])).toEqual([
      ['overlay', 'res:/dx9/model/effect/armorhardening_skinned.black'],
      ['beam', 'res:/fisfx/module/remotearmorrepair_st_t1a.black'],
      ['trigger', 'res:/fisfx/module/stasisweb_tr_t1a.black'],
      ['overlay', 'res:/dx9/model/effect/shieldboosting_skinned.black'],
      null,
      null
    ]);
    expect(Object.keys(MODULE_EFFECTS)).toHaveLength(16);
  });

  it('fills the sound events by size and cycle, and stops loops when the module stops', () => {
    const hardener = MODULE_EFFECTS['effects.ArmorHardening'];
    expect(moduleEffectSounds(hardener, 'on', { size: 'M', cycleTime: 24 })).toEqual({ events: ['ship_effect_M_armorhardener_play'], stops: [] });
    expect(moduleEffectSounds(hardener, 'cycle', { size: 'M', cycleTime: 24 })).toEqual({ events: [], stops: [] });
    expect(moduleEffectSounds(hardener, 'off', { size: 'M', cycleTime: 24 })).toEqual({ events: ['ship_effect_M_armorhardener_stop'], stops: ['ship_effect_M_armorhardener_play'] });
    expect(moduleEffectSounds(MODULE_EFFECTS['effects.ShieldBoosting'], 'cycle', { size: 'L', cycleTime: 3 }).events).toEqual(['ship_effect_L_shieldboost_play']);
    expect(moduleEffectSounds(MODULE_EFFECTS['effects.RemoteArmourRepair'], 'on', { size: 'M', cycleTime: 6 }).events).toEqual(['remote_shipeffect_switch_size_M', 'remote_shipeffect_switch_duration_6000', 'remote_armorrepair']);
    expect(moduleEffectSounds(MODULE_EFFECTS['effects.RemoteArmourRepair'], 'off', { size: 'M', cycleTime: 6 })).toEqual({ events: ['remote_shipeffect_stop'], stops: ['remote_armorrepair'] });
    expect([nearestSoundDuration(4900), nearestSoundDuration(24000), nearestSoundDuration(100)]).toEqual([5000, 20000, 2500]);
  });
});
