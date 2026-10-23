import { describe, expect, it } from 'vitest';
import { explosionDurationBound, MAX_LOCAL_BLASTS, SHIP_EXPLOSION_TIMINGS, SHIP_EXPLOSIONS, type ShipExplosionFile, shipExplosionOf } from './explosions';

/**
 * Every file under `res:/fisfx/explosion/` in resources build 3632936's res index (captured 2026-10-23).
 */
const EXPLOSION_PATHS: readonly string[] = [
  'ecx_concord_structure_l_01a.black',
  'ecx_deathless_structure_l_explosive_01a.black',
  'ecx_drifter_cruiser_explosive_01a.black',
  'ecx_drifter_explosive_01a.black',
  'ecx_drifter_explosive_short_01a.black',
  'ecx_drifter_structure_l_explosive_01a.black',
  'ecx_edencom_structure_l_explosive_01a.black',
  'ecx_edencom_structure_xl_explosive_01a.black',
  'ecx_generic_asteroid_rw_01a.black',
  'ecx_generic_container_explosion_01a.black',
  'ecx_generic_container_gaseous_01a.black',
  'ecx_generic_corpse_explosive_01a.black',
  'ecx_generic_explosive_01a.black',
  'ecx_generic_explosive_01b.black',
  'ecx_generic_explosive_01c.black',
  'ecx_generic_explosive_long_01a.black',
  'ecx_generic_explosive_long_01b.black',
  'ecx_generic_explosive_long_01c.black',
  'ecx_generic_explosive_short_01a.black',
  'ecx_generic_explosive_short_01b.black',
  'ecx_generic_pod_explosive_01a.black',
  'ecx_generic_structure_l_01a.black',
  'ecx_generic_structure_m_01a.black',
  'ecx_generic_structure_xl_01a.black',
  'ecx_lco_fast_explosive_01a.black',
  'ecx_lco_generic_explosive_01a.black',
  'ecx_lco_generic_explosive_01b.black',
  'ecx_lco_generic_explosive_01c.black',
  'ecx_moonchunk_explosive_01a.black',
  'ecx_moonchunk_explosivespecial_01a.black',
  'ecx_ore_explosive_01a.black',
  'ecx_pod_generic_explosive_01a.black',
  'ecx_sleeper_explosive_01a.black',
  'ecx_titan_amarr_explosive_01a.black',
  'ecx_titan_angel_explosive_01a.black',
  'ecx_titan_caldari_explosive_01a.black',
  'ecx_titan_gallente_explosive_01a.black',
  'ecx_titan_minmatar_explosive_01a.black',
  'ecx_triglavian_explosive_01a.black',
  'ecx_triglavian_explosive_sentry_01a.black',
  'ecx_triglavian_explosive_tgdn01_t1.black',
  'ecx_triglavian_lootcontainer_01a.black',
  'ecx_triglavian_structure_s_explosive_01a.black',
  'ecx_triglavian_structure_tfu_explosive_01a.black',
  'ecx_triglavian_structure_xl_explosive_01a.black',
  'ecx_triglavian_structure_xl_explosive_02a.black',
  'ecx_upwell_explosive_01a.black',
  'ecx_upwell_explosive_long_01a.black',
  'ecx_upwell_explosive_short_01a.black',
  'ecx_upwell_freighter_explosive_01a.black',
  'ecx_upwell_industrial_explosive_01a.black',
  'ecx_upwell_skyhook_explosive_01a.black',
  'fire/wreckfire_generic_1200.black',
  'fire/wreckfire_generic_150.black',
  'fire/wreckfire_generic_15000.black',
  'fire/wreckfire_generic_150_4m.black',
  'fire/wreckfire_generic_1600.black',
  'fire/wreckfire_generic_1600_4m.black',
  'fire/wreckfire_generic_1600_4m_damped.black',
  'fire/wreckfire_generic_3500.black',
  'fire/wreckfire_generic_3500_4m.black',
  'fire/wreckfire_generic_50000.black',
  'fire/wreckfire_generic_800.black',
  'fire/wreckfire_generic_800_4m.black',
  'holographic/ecx_holographic_large_01a.black',
  'holographic/ecx_holographic_medium_01a.black',
  'holographic/ecx_holographic_small_01a.black',
  'holographic/ecx_holographic_xl_01a.black'
].map((path) => `res:/fisfx/explosion/${path}`);

const TABLE: readonly ShipExplosionFile[] = [
  ...SHIP_EXPLOSIONS.S,
  ...SHIP_EXPLOSIONS.M,
  ...SHIP_EXPLOSIONS.L,
  ...Object.values(SHIP_EXPLOSIONS.titan),
  SHIP_EXPLOSIONS.titanFallback,
  SHIP_EXPLOSIONS.triglavian,
  SHIP_EXPLOSIONS.triglavianDreadnought,
  SHIP_EXPLOSIONS.drifterCruiser,
  SHIP_EXPLOSIONS.drifter,
  SHIP_EXPLOSIONS.sleeper
];

describe('SHIP_EXPLOSIONS', () => {
  it('names files that exist, each with captured timing', () => {
    expect(EXPLOSION_PATHS).toHaveLength(68);
    for (const file of TABLE) {
      expect(EXPLOSION_PATHS, file.name).toContain(file.resPath);
      expect(SHIP_EXPLOSION_TIMINGS[file.name], file.name).toBeDefined();
    }
  });

  it('lingers at least as long as the explosion can play with the most local blasts', () => {
    for (const file of TABLE) {
      const bound = explosionDurationBound(SHIP_EXPLOSION_TIMINGS[file.name], MAX_LOCAL_BLASTS);
      expect(file.lingerSeconds, file.name).toBeGreaterThanOrEqual(bound);
      expect(file.lingerSeconds - bound, file.name).toBeLessThan(1);
    }
    const linger = (name: string) => TABLE.find((file) => file.name === name)?.lingerSeconds;
    expect([linger('generic_explosive_short_01a'), linger('generic_explosive_01a'), linger('generic_explosive_long_01a'), linger('titan_amarr_explosive_01a')]).toEqual([16, 21, 52, 44]);
  });

  it('bounds the duration by the delays, the blasts summed and the durations', () => {
    const values = SHIP_EXPLOSION_TIMINGS['generic_explosive_01a'];
    const spread = (0.66 * (1 - 0.97 ** 8)) / (1 - 0.97);
    expect(explosionDurationBound(values)).toBeCloseTo(Math.max(15 + spread, 0.42 + spread + 15), 9);
    expect(explosionDurationBound(values, 0)).toBe(15);
  });
});

describe('shipExplosionOf', () => {
  const pathOf = (input: Parameters<typeof shipExplosionOf>[0]) => shipExplosionOf(input).name;

  it('picks a generic variant by size class, keyed by seed and ship', () => {
    expect(['generic_explosive_short_01a', 'generic_explosive_short_01b']).toContain(pathOf({ rigSize: 1, seed: 1, ship: 'rifter' }));
    expect(['generic_explosive_01a', 'generic_explosive_01b', 'generic_explosive_01c']).toContain(pathOf({ rigSize: 2, seed: 1, ship: 'ferox' }));
    expect(['generic_explosive_long_01a', 'generic_explosive_long_01b', 'generic_explosive_long_01c']).toContain(pathOf({ rigSize: 3, seed: 1, ship: 'megathron' }));
    expect(pathOf({ rigSize: 4, seed: 1, ship: 'carrier' })).toMatch(/^generic_explosive_long_01/u);
    expect(shipExplosionOf({ classRigSize: 2, seed: 1, ship: 'x' }).size).toBe('M');
    expect(shipExplosionOf({ seed: 1, ship: 'x' }).size).toBe('S');
    expect(pathOf({ rigSize: 2, seed: 1, ship: 'ferox' })).toBe(pathOf({ rigSize: 2, seed: 1, ship: 'ferox' }));
    const variants = new Set(Array.from({ length: 60 }, (_, index) => pathOf({ rigSize: 2, seed: 1, ship: `ferox-${index}` })));
    expect(variants.size).toBe(3);
  });

  it('gives titans their race, and Triglavian, Drifter and Sleeper hulls their own', () => {
    expect(pathOf({ groupID: 30, rigSize: 4, sofRace: 'Amarr', seed: 1, ship: 'avatar' })).toBe('titan_amarr_explosive_01a');
    expect(pathOf({ groupID: 30, rigSize: 4, sofRace: 'angel', seed: 1, ship: 'vanquisher' })).toBe('titan_angel_explosive_01a');
    expect(pathOf({ groupID: 30, rigSize: 4, sofRace: 'sansha', seed: 1, ship: 'komodo' })).toBe('generic_explosive_long_01a');
    expect(pathOf({ groupID: 485, rigSize: 4, raceID: 135, seed: 1, ship: 'zirnitra' })).toBe('triglavian_explosive_tgdn01_t1');
    expect(pathOf({ rigSize: 1, sofRace: 'triglavian', seed: 1, ship: 'damavik' })).toBe('triglavian_explosive_01a');
    expect(pathOf({ rigSize: 2, sofRace: 'jove', seed: 1, ship: 'drifter' })).toBe('drifter_cruiser_explosive_01a');
    expect(pathOf({ rigSize: 3, sofRace: 'drifter', seed: 1, ship: 'drifter-bs' })).toBe('drifter_explosive_01a');
    expect(pathOf({ rigSize: 2, sofRace: 'sleeper', seed: 1, ship: 'sleeper' })).toBe('sleeper_explosive_01a');
    expect(shipExplosionOf({ groupID: 30, rigSize: 4, sofRace: 'caldari', seed: 1, ship: 'leviathan' })).toMatchObject({ resPath: 'res:/fisfx/explosion/ecx_titan_caldari_explosive_01a.black', referenceRadius: 1500, size: 'XL' });
  });
});
