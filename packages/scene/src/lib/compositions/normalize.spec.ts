import { describe, expect, it } from 'vitest';
import { FLEET_COMPOSITION_EXAMPLES } from './examples';
import { countFleetCompositionShips, normalizeFleetComposition } from './normalize';
import { RIFTER, TFI } from './compositions.spec-helper';

const EFT_TFI = '[Tempest Fleet Issue, [FL33T] Tempest Fleet Issue]\nDamage Control II';

describe('normalizeFleetComposition', () => {
  it('reads the shipped TFIs example with no problems and no warnings', () => {
    const result = normalizeFleetComposition({ input: FLEET_COMPOSITION_EXAMPLES[0] });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
    const composition = result.composition!;
    expect(countFleetCompositionShips(composition)).toBe(44);
    expect(composition.wings.flatMap((wing) => wing.squads)).toHaveLength(9);
  });

  it('accepts an FC-only composition and fills the schema and wings', () => {
    const result = normalizeFleetComposition({ input: { id: 'x', commander: { hull: 'Rifter', dna: RIFTER } } });
    expect(result.problems).toEqual([]);
    expect(result.composition).toEqual({ schema: 'cjs-fleet/1', id: 'x', commander: { hull: 'Rifter', dna: RIFTER }, wings: [] });
  });

  it('reports every problem together', () => {
    const line = { hull: 'Rifter', dna: RIFTER };
    const result = normalizeFleetComposition({
      input: {
        schema: 'cjs-scene/1',
        id: 'bad id',
        fits: { tfi: EFT_TFI },
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'a', role: 'brawler', ships: [{ ...line, count: 0 }] },
              { id: 'fc', role: 'dps', ships: [{ ...line, count: 1.5 }] },
              { id: 'LEAD', role: 'dps', ships: [{ ...line, fit: 'nope' }] },
              { id: 'b', role: 'dps', anchor: { on: 'ghost', range: -1 }, ships: [{ hull: 'Guardian', fit: 'tfi' }] }
            ]
          },
          {
            id: 'w',
            squads: [
              { id: 'a', role: 'dps', ships: [{ count: 2 }] },
              { id: 'c', role: 'dps', anchor: { on: 'c' }, ships: [{ dna: 'nope', radius: 0 }] },
              { id: 'd', role: 'dps', anchor: { on: 'empty' }, ships: [{ ...line, count: 257 }] },
              { id: 'empty', role: 'dps', ships: [] }
            ]
          }
        ]
      }
    });
    expect(result.composition).toBeNull();
    expect(result.problems).toEqual([
      'composition.schema must be "cjs-fleet/1", got "cjs-scene/1"',
      'composition.id must be 1-64 letters, digits, "_", "-" or "."',
      "composition.commander must be an object: the fleet commander's ship",
      'composition.wings[0].squads[0].role must be one of dps, logi, tackle, ewar, boost, support',
      'composition.wings[0].squads[0].ships[0].count must be an integer in [1, 256]',
      'composition.wings[0].squads[1].ships[0].count must be an integer in [1, 256]',
      'composition.wings[0].squads[2].ships[0].fit "nope" is not a key of fits',
      'composition.wings[0].squads[3].anchor.range must be a number of 0 or more (metres)',
      'composition.wings[0].squads[3].ships[0].hull "Guardian" does not match fit "tfi" ([Tempest Fleet Issue, [FL33T] Tempest Fleet Issue])',
      'composition.wings[0].squads[1].id "fc" is reserved: "fc" and "lead" name anchor targets',
      'composition.wings[0].squads[2].id "LEAD" is reserved: "fc" and "lead" name anchor targets',
      'composition.wings[1].squads[0].ships[0] names no hull: give hull (an EVE type name or id), dna, or a fit',
      'composition.wings[1].squads[1].ships[0].dna "nope" is not hull:faction:race[:commands]',
      "composition.wings[1].squads[1].ships[0].radius must be a number above 0 (metres, the hull's EVE radius)",
      'composition.wings[1].squads[2].ships[0].count must be an integer in [1, 256]',
      'composition.wings[1].id "w" is used more than once',
      'composition.wings[1].squads[0].id "a" is used more than once',
      'composition.wings[0].squads[3].anchor.on "ghost" is not "fc", "lead" or a squad id',
      'composition.wings[1].squads[1].anchor.on names the squad itself; use "lead" to anchor the squad on its first ship',
      'composition.wings[1].squads[2].anchor.on "empty" is a squad with no ships'
    ]);
  });

  it('reports more ships than a fleet holds', () => {
    const result = normalizeFleetComposition({
      input: {
        id: 'x',
        commander: { dna: TFI },
        wings: [
          {
            id: 'w',
            squads: [
              {
                id: 's',
                role: 'dps',
                ships: [
                  { dna: TFI, count: 200 },
                  { dna: TFI, count: 56 }
                ]
              }
            ]
          }
        ]
      }
    });
    expect(result.problems).toEqual(['composition has 257 ships counting the FC; a fleet holds at most 256']);
  });

  it('reports a squad anchor loop once', () => {
    const squad = (id: string, on: string): unknown => ({ id, role: 'dps', anchor: { on }, ships: [{ dna: TFI }] });
    const result = normalizeFleetComposition({ input: { id: 'x', commander: { dna: TFI }, wings: [{ id: 'w', squads: [squad('a', 'b'), squad('b', 'a')] }] } });
    expect(result.problems).toEqual(['composition: squads anchor on each other in a loop (a -> b -> a)']);
  });

  it('warns about and drops unknown keys', () => {
    const result = normalizeFleetComposition({ input: { id: 'x', version: 2, commander: { dna: TFI, count: 2 }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ dna: TFI, class: 'bs' }] }] }] } });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual(['composition.version is not a known field and was dropped', 'composition.commander.count is not a known field and was dropped', 'composition.wings[0].squads[0].ships[0].class is not a known field and was dropped']);
    expect(result.composition?.commander).toEqual({ dna: TFI });
    expect(result.composition?.wings[0].squads[0].ships[0]).toEqual({ dna: TFI });
  });

  it('keeps values as written: no hull from the fit; roles and fc / lead lower-cased', () => {
    const result = normalizeFleetComposition({
      input: { id: 'x', commander: { fit: 'tfi', dna: TFI }, fits: { tfi: EFT_TFI }, wings: [{ id: 'w', squads: [{ id: 's', role: 'DPS', anchor: { on: 'FC', range: 500 }, ships: [{ fit: 'tfi', dna: TFI }] }] }] }
    });
    expect(result.problems).toEqual([]);
    expect(result.composition?.commander).toEqual({ dna: TFI, fit: 'tfi' });
    expect(result.composition?.wings[0].squads[0]).toEqual({ id: 's', role: 'dps', anchor: { on: 'fc', range: 500 }, ships: [{ dna: TFI, fit: 'tfi' }] });
  });
});
