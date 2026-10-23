import { describe, expect, it } from 'vitest';
import { ASTEROID_GROUP_FACTIONS, asteroidBaseName, asteroidRockFaction, asteroidRockSet, asteroidRockSize } from './ores';

/**
 * The 14 `ore_veldspar` hulls tools-core's SDE `graphics` table answered (build 3646012).
 */
const VELDSPAR_HULLS = [
  'rock_01_m_v1a_whiteyellow',
  'rock_01_m_v2a_whiteyellow',
  'rock_01_m_v3a_whiteyellow',
  'rock_01_m_v4a_whiteyellow',
  'rock_01_field_v1a_whiteyellow',
  'rock_01_l_v1a_whiteyellow',
  'rock_01_l_v2a_whiteyellow',
  'rock_01_l_v3a_whiteyellow',
  'rock_01_l_v4a_whiteyellow',
  'rock_01_s_v1a_whiteyellow',
  'rock_01_s_v2a_whiteyellow',
  'rock_01_s_v3a_whiteyellow',
  'rock_01_s_v4a_whiteyellow',
  'as1_l_03_whitebrown'
];

describe('asteroidRockFaction', () => {
  it('maps every group in the table, by its own name', () => {
    for (const [group, faction] of Object.entries(ASTEROID_GROUP_FACTIONS)) expect(asteroidRockFaction({ group: group.toUpperCase(), name: 'Any' })).toEqual({ faction, from: 'group' });
    expect(asteroidRockFaction({ group: 'Veldspar', name: 'Batch Compressed Veldspar II-Grade' })).toEqual({ faction: 'ore_veldspar', from: 'group' });
  });

  it('maps ice by its base name, grades and compression stripped', () => {
    expect(asteroidRockFaction({ group: 'Ice', name: 'Blue Ice' })).toEqual({ faction: 'ice_blue', from: 'ice' });
    expect(asteroidRockFaction({ group: 'Ice', name: 'Blue Ice IV-Grade' })).toEqual({ faction: 'ice_blue', from: 'ice' });
    expect(asteroidRockFaction({ group: 'Ice', name: 'Compressed Glacial Mass' })).toEqual({ faction: 'ice_glacialmass', from: 'ice' });
    expect(asteroidBaseName('Batch Compressed Dark Ochre 0-Grade')).toBe('dark ochre');
  });

  it('answers null for unmapped ores and non-ores', () => {
    expect(asteroidRockFaction({ group: 'Mordunium', name: 'Mordunium' })).toBeNull();
    expect(asteroidRockFaction({ group: 'Ice', name: 'Azure Ice' })).toBeNull();
    expect(asteroidRockFaction({ group: 'Mineral', name: 'Tritanium' })).toBeNull();
    expect(asteroidRockFaction({ group: null, name: 'Veldspar' })).toBeNull();
  });
});

describe('asteroidRockSize', () => {
  it('classifies the 12 Veldspar rocks and skips the field mesh and the abyssal rock', () => {
    const sizes = VELDSPAR_HULLS.map(asteroidRockSize);
    expect(sizes.filter((size) => size === 'small')).toHaveLength(4);
    expect(sizes.filter((size) => size === 'medium')).toHaveLength(4);
    expect(sizes.filter((size) => size === 'large')).toHaveLength(4);
    expect(asteroidRockSize('rock_01_field_v1a_whiteyellow')).toBeNull();
    expect(asteroidRockSize('as1_l_03_whitebrown')).toBeNull();
    expect(asteroidRockSize('crystal_04v1')).toBe('any');
  });
});

describe('asteroidRockSet', () => {
  it('buckets and sorts the DNAs and names the skipped hulls', () => {
    const set = asteroidRockSet({ faction: 'ore_veldspar', hulls: VELDSPAR_HULLS });
    expect(set?.rocks.small).toEqual(['rock_01_s_v1a_whiteyellow:ore_veldspar:asteroid', 'rock_01_s_v2a_whiteyellow:ore_veldspar:asteroid', 'rock_01_s_v3a_whiteyellow:ore_veldspar:asteroid', 'rock_01_s_v4a_whiteyellow:ore_veldspar:asteroid']);
    expect(set?.rocks.large).toHaveLength(4);
    expect(set?.skipped).toEqual(['as1_l_03_whitebrown', 'rock_01_field_v1a_whiteyellow']);
    expect(set?.notes).toEqual([]);
  });

  it('fills an empty bucket from medium, then the other size, and uses unsized rocks for all', () => {
    const noSmall = asteroidRockSet({ faction: 'f', hulls: ['rock_01_m_v1a_grey', 'rock_01_l_v1a_grey'] });
    expect(noSmall?.rocks.small).toEqual(['rock_01_m_v1a_grey:f:asteroid']);
    expect(noSmall?.notes).toEqual(['f has no small rocks; small uses its medium ones']);
    const largeOnly = asteroidRockSet({ faction: 'f', hulls: ['rock_01_l_v1a_grey'] });
    expect(largeOnly?.rocks.medium).toEqual(['rock_01_l_v1a_grey:f:asteroid']);
    const tyranite = asteroidRockSet({ faction: 'tyranite', hulls: ['crystal_04v2', 'crystal_04v1'] });
    expect(tyranite?.rocks).toEqual({ small: ['crystal_04v1:tyranite:asteroid', 'crystal_04v2:tyranite:asteroid'], medium: ['crystal_04v1:tyranite:asteroid', 'crystal_04v2:tyranite:asteroid'], large: ['crystal_04v1:tyranite:asteroid', 'crystal_04v2:tyranite:asteroid'] });
    expect(asteroidRockSet({ faction: 'f', hulls: ['as1_l_03_whitebrown'] })).toBeNull();
  });
});
