import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { applySceneOperations, diffScenes, normalizeScene } from '../scene';
import { DEFAULT_COMBAT_DEATH, DEFAULT_COMBAT_SEED, MAX_COMBAT_SEED, normalizeSceneCombat, sceneCombatOf } from './document';

describe('normalizeSceneCombat', () => {
  it('reads the seed and death mode; null and empty are absent', () => {
    expect(normalizeSceneCombat({ seed: 7, death: 'flag' })).toEqual({ combat: { seed: 7, death: 'flag' }, problems: [], warnings: [] });
    expect(normalizeSceneCombat({ seed: 0 }).combat).toEqual({ seed: 0 });
    expect(normalizeSceneCombat({ seed: MAX_COMBAT_SEED }).combat).toEqual({ seed: MAX_COMBAT_SEED });
    expect(normalizeSceneCombat(undefined).combat).toBeNull();
    expect(normalizeSceneCombat(null).combat).toBeNull();
    expect(normalizeSceneCombat({}).combat).toBeNull();
    expect(normalizeSceneCombat({ seed: null, death: null }).combat).toBeNull();
  });

  it('refuses a seed out of range or not an integer and an unknown death; unknown keys warn', () => {
    expect(normalizeSceneCombat({ seed: -1 }).problems).toEqual([`combat.seed must be an integer from 0 to ${MAX_COMBAT_SEED}`]);
    expect(normalizeSceneCombat({ seed: 1.5 }).problems).toHaveLength(1);
    expect(normalizeSceneCombat({ seed: 2 ** 32 }).problems).toHaveLength(1);
    expect(normalizeSceneCombat({ seed: '3' }).problems).toHaveLength(1);
    expect(normalizeSceneCombat({ death: 'vanish' }).problems).toEqual(['combat.death must be one of explode, flag']);
    expect(normalizeSceneCombat('loud').problems).toEqual(['combat must be an object { seed?, death? }']);
    expect(normalizeSceneCombat({ seed: 3, rng: 'mt' })).toEqual({ combat: { seed: 3 }, problems: [], warnings: ['combat.rng is not a combat field and was dropped'] });
  });

  it('applies the defaults', () => {
    expect(sceneCombatOf({})).toEqual({ seed: DEFAULT_COMBAT_SEED, death: DEFAULT_COMBAT_DEATH });
    expect(sceneCombatOf({ combat: { death: 'flag' } })).toEqual({ seed: 1, death: 'flag' });
  });
});

describe('the document combat field', () => {
  const base = normalizeScene({ ships: [] }).scene;

  it('round-trips through normalizeScene and is omitted when empty', () => {
    const { scene, warnings } = normalizeScene({ ships: [], combat: { seed: 42, death: 'flag' } });
    expect(scene.combat).toEqual({ seed: 42, death: 'flag' });
    expect(warnings).toEqual([]);
    expect(normalizeScene(JSON.parse(JSON.stringify(scene))).scene).toEqual(scene);
    expect('combat' in normalizeScene({ ships: [], combat: {} }).scene).toBe(false);
    expect(catchSceneError(() => normalizeScene({ ships: [], combat: { seed: -2 } })).problems).toEqual([`combat.seed must be an integer from 0 to ${MAX_COMBAT_SEED}`]);
  });

  it('set_combat merges, null resets a field, and an emptied combat goes', () => {
    const seeded = applySceneOperations(base, [{ op: 'set_combat', seed: 9 }]).scene;
    expect(seeded.combat).toEqual({ seed: 9 });
    const flagged = applySceneOperations(seeded, [{ op: 'set_combat', death: 'flag' }]).scene;
    expect(flagged.combat).toEqual({ seed: 9, death: 'flag' });
    expect(applySceneOperations(flagged, [{ op: 'set_combat', seed: null }]).scene.combat).toEqual({ death: 'flag' });
    expect('combat' in applySceneOperations(flagged, [{ op: 'set_combat', seed: null, death: null }]).scene).toBe(false);
    expect(applySceneOperations(base, [{ op: 'set_combat', seed: 2, loud: true }]).warnings).toEqual(['operations[0].loud is not a set_combat field and was ignored']);
  });

  it('set_combat refuses an empty edit and bad values', () => {
    expect(catchSceneError(() => applySceneOperations(base, [{ op: 'set_combat' }])).problems).toEqual([`operations[0]: set_combat needs seed (an integer from 0 to ${MAX_COMBAT_SEED}, or null) or death (explode or flag, or null)`]);
    expect(catchSceneError(() => applySceneOperations(base, [{ op: 'set_combat', death: 'boom' }])).problems).toEqual(['combat.death must be one of explode, flag']);
  });

  it('flags a combat change in the diff', () => {
    const seeded = applySceneOperations(base, [{ op: 'set_combat', seed: 9 }]).scene;
    expect(diffScenes(base, seeded).combat).toBe(true);
    expect(diffScenes(seeded, seeded).combat).toBe(false);
    expect(diffScenes(null, base).combat).toBe(false);
    expect(diffScenes(null, seeded).combat).toBe(true);
  });
});
