import { describe, expect, it } from 'vitest';
import { catchSceneError, TFI, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import { sampleShips } from '../selectors/select';
import { immuneLayersOf, immunityWarning, normalizeImmunityCommand, normalizeShipImmunity, sameImmunity, toSceneImmunity } from './immunity';

const BASE: SceneDocument = normalizeScene({ ...TFI_FLEET_SCENE, ships: TFI_FLEET_SCENE.ships.map((ship) => ({ ...ship, team: ship.id.startsWith('guardian') ? 'Logi' : 'blue' })) }).scene;

function immuneOf(scene: SceneDocument): Record<string, unknown> {
  return Object.fromEntries(scene.ships.filter((ship) => ship.immune != null).map((ship) => [ship.id, ship.immune]));
}

function apply(operations: unknown[], scene: SceneDocument = BASE) {
  return applySceneOperations(scene, operations);
}

describe('normalizeShipImmunity', () => {
  const read = (input: unknown) => normalizeShipImmunity({ input, where: 'ships[2].immune' });

  it('reads true, a list in layer order, and all three as true', () => {
    expect(read(true)).toEqual({ immune: true, problems: [] });
    expect(read(['armor'])).toEqual({ immune: ['armor'], problems: [] });
    expect(read(['Structure', 'shield', 'shield'])).toEqual({ immune: ['shield', 'structure'], problems: [] });
    expect(read(['structure', 'armor', 'SHIELD'])).toEqual({ immune: true, problems: [] });
  });

  it('false, null, absent and [] mean not immune', () => {
    for (const input of [false, null, undefined, []]) expect(read(input), JSON.stringify(input)).toEqual({ immune: null, problems: [] });
  });

  it('refuses hull with a hint, and anything else', () => {
    expect(read(['hull']).problems).toEqual(['ships[2].immune: "hull" is not a layer (the hull layer is structure)']);
    const shape = 'ships[2].immune must be true, false, or a list of layers (shield, armor, structure)';
    for (const input of ['yes', {}, [1], 3, ['shield', 'capacitor']]) expect(read(input).problems, JSON.stringify(input)).toEqual([shape]);
  });
});

describe('immuneLayersOf, toSceneImmunity and sameImmunity', () => {
  it('lists the layers, indexes only immune ships, and compares by layer', () => {
    expect(immuneLayersOf({ immune: true })).toEqual(['shield', 'armor', 'structure']);
    expect(immuneLayersOf({ immune: ['structure'] })).toEqual(['structure']);
    expect(immuneLayersOf({})).toEqual([]);
    expect(immuneLayersOf({ immune: false })).toEqual([]);
    const index = toSceneImmunity({ ships: [{ id: 'a', immune: true }, { id: 'b' }, { id: 'c', immune: ['armor', 'structure'] }] });
    expect([...index]).toEqual([
      ['a', ['shield', 'armor', 'structure']],
      ['c', ['armor', 'structure']]
    ]);
    expect(sameImmunity(true, ['shield', 'armor', 'structure'])).toBe(true);
    expect(sameImmunity(undefined, false)).toBe(true);
    expect(sameImmunity(null, [])).toBe(true);
    expect(sameImmunity(['armor'], ['structure'])).toBe(false);
    expect(sameImmunity(true, undefined)).toBe(false);
  });
});

describe('normalizeImmunityCommand', () => {
  it('needs immune and a selector, and refuses unknown keys', () => {
    expect(normalizeImmunityCommand({ fleet: 'tfi', squad: 'logi', immune: true })).toEqual({ fleet: 'tfi', squad: 'logi', immune: true });
    expect(normalizeImmunityCommand({ all: true, team: 'red', immune: false })).toEqual({ all: true, team: ['red'], immune: false });
    expect(normalizeImmunityCommand({ ships: ['a'], immune: ['Structure'] })).toEqual({ ships: ['a'], immune: ['structure'] });
    expect(normalizeImmunityCommand({ ships: ['a'], immune: null })).toEqual({ ships: ['a'], immune: false });
    expect(catchSceneError(() => normalizeImmunityCommand({ ships: ['a'] })).problems).toEqual(['set_immunity needs immune (true, false, or a list of layers: shield, armor, structure)']);
    expect(catchSceneError(() => normalizeImmunityCommand({ immune: true, role: 'logi', layers: 1 })).problems).toEqual(['set_immunity.layers is not a set_immunity field', 'set_immunity needs exactly one of ships (ship ids), fleet (a fleet id, optionally with wing or squad) and all (every ship in the scene)']);
    expect(catchSceneError(() => normalizeImmunityCommand({ all: true, immune: ['hull'] })).problems).toEqual(['set_immunity.immune: "hull" is not a layer (the hull layer is structure)']);
    expect(catchSceneError(() => normalizeImmunityCommand('all')).problems).toEqual(['set_immunity must be an object { ships | fleet [, wing | squad] | all, role?, team?, hull?, state?, sample?, immune }']);
  });

  it('keeps hull and state for the page to resolve', () => {
    expect(normalizeImmunityCommand({ all: true, hull: 'Guardian', state: 'alive', immune: true })).toEqual({ all: true, hull: ['Guardian'], state: ['alive'], immune: true });
  });
});

describe('the set_immunity op', () => {
  it('sets a squad immune, and false deletes it', () => {
    const immune = apply([{ op: 'set_immunity', fleet: 'tfi', squad: 'logi', immune: true }]).scene;
    expect(immuneOf(immune)).toEqual({ 'guardian-1': true, 'guardian-2': true });
    expect(immuneOf(apply([{ op: 'set_immunity', ships: ['guardian-2'], immune: false }], immune).scene)).toEqual({ 'guardian-1': true });
  });

  it('replaces: a list replaces true', () => {
    const immune = apply([{ op: 'set_immunity', fleet: 'tfi', immune: true }]).scene;
    const scene = apply([{ op: 'set_immunity', ships: ['fc'], immune: ['structure', 'armor'] }], immune).scene;
    expect(immuneOf(scene)['fc']).toEqual(['armor', 'structure']);
    expect(immuneOf(scene)['tfi-1']).toBe(true);
  });

  it('selects the scene by team, and samples on the combat seed', () => {
    expect(Object.keys(immuneOf(apply([{ op: 'set_immunity', all: true, team: 'logi', immune: true }]).scene))).toEqual(['guardian-1', 'guardian-2']);
    expect(Object.keys(immuneOf(apply([{ op: 'set_immunity', fleet: 'tfi', role: 'dps', immune: ['structure'] }]).scene))).toEqual(['tfi-1', 'tfi-2', 'tfi-3']);
    const seeded = apply([
      { op: 'set_combat', seed: 77 },
      { op: 'set_immunity', all: true, sample: 2, immune: true }
    ]).scene;
    expect(Object.keys(immuneOf(seeded))).toEqual(
      sampleShips(
        BASE.ships.map((ship) => ship.id),
        { count: 2 },
        77
      )
    );
  });

  it('refuses hull and state, naming the tool, and unknown ids', () => {
    expect(catchSceneError(() => apply([{ op: 'set_immunity', all: true, hull: 'Guardian', immune: true }])).problems).toEqual(["operations[0].hull reads the live scene (each ship's EVE type): use the set_immunity tool, which resolves them in the viewer"]);
    expect(catchSceneError(() => apply([{ op: 'set_immunity', all: true, state: 'alive', immune: true }])).problems).toEqual(["operations[0].state reads the live scene (each ship's state): use the set_immunity tool, which resolves them in the viewer"]);
    expect(catchSceneError(() => apply([{ op: 'set_immunity', ships: ['ghost'], immune: true }])).problems).toEqual(['operations[0]: no ship "ghost"']);
    expect(catchSceneError(() => apply([{ op: 'set_immunity', fleet: 'tfi' }])).problems).toEqual(['operations[0] needs immune (true, false, or a list of layers: shield, armor, structure)']);
  });

  it('warns about unknown keys and unmatched filters, and still applies', () => {
    const { scene, warnings } = apply([{ op: 'set_immunity', fleet: 'tfi', team: ['blue', 'red'], layer: 'armor', immune: true }]);
    expect(Object.keys(immuneOf(scene))).toEqual(['fc', 'tfi-1', 'tfi-2', 'tfi-3']);
    expect(warnings).toEqual(['operations[0].layer is not a set_immunity field and was ignored', 'operations[0].team "red" matches no ship in fleet "tfi" (teams there: blue, Logi)']);
  });

  it('composes after an op that adds the ships, in the same patch', () => {
    const { scene } = apply([
      { op: 'add_ships', dna: TFI, count: 2, prefix: 'new', position: [0, 0, 20000] },
      { op: 'set_immunity', ships: ['new-01', 'new-02'], immune: ['structure'] }
    ]);
    expect(immuneOf(scene)).toEqual({ 'new-01': ['structure'], 'new-02': ['structure'] });
  });

  it('update_ship sets and clears it, and remove_ship takes it with the ship', () => {
    const immune = apply([{ op: 'update_ship', id: 'tfi-1', set: { immune: ['armor'] } }]).scene;
    expect(immuneOf(immune)).toEqual({ 'tfi-1': ['armor'] });
    expect(immuneOf(apply([{ op: 'update_ship', id: 'tfi-1', set: { immune: null } }], immune).scene)).toEqual({});
    expect(immuneOf(apply([{ op: 'remove_ship', id: 'tfi-1' }], immune).scene)).toEqual({});
    expect(catchSceneError(() => apply([{ op: 'update_ship', id: 'tfi-1', set: { immune: 'yes' } }])).problems).toEqual(['ships[1].immune must be true, false, or a list of layers (shield, armor, structure)']);
  });
});

describe('immunityWarning', () => {
  it('says what the shots will do', () => {
    expect(immunityWarning('hero', ['shield', 'armor', 'structure'])).toBe('"hero" is immune to damage: the guns lock, fire and hit, but it takes none');
    expect(immunityWarning('hero', ['armor', 'structure'])).toBe('"hero" cannot be destroyed: its armor and structure are immune (only its shield drops)');
    expect(immunityWarning('hero', ['structure'])).toBe('"hero" cannot be destroyed: its structure is immune (its shield and armor still drop)');
    expect(immunityWarning('hero', ['armor'])).toBe('"hero" is immune on its armor: hits stop there while it has HP');
    expect(immunityWarning('hero', ['shield', 'armor'])).toBe('"hero" is immune on its shield and armor: hits stop there while they have HP');
    expect(immunityWarning('hero', [])).toBeNull();
  });
});
