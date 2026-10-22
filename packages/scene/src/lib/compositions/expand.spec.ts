import { describe, expect, it } from 'vitest';
import { toFleetMemberships } from '../fleets';
import type { SceneVector } from '../scene';
import { expandFleetComposition, type ExpandFleetCompositionInput } from './expand';
import { makeMiniComposition, requireComposition, TFI, tfisComposition } from './compositions.spec-helper';

const EMPTY = { ships: new Map<string, SceneVector>(), fleets: new Set<string>() };

function expand(input: Partial<ExpandFleetCompositionInput> = {}): ReturnType<typeof expandFleetComposition> {
  return expandFleetComposition({ composition: tfisComposition(), position: [0, 0, 0], heading: 0, existing: EMPTY, ...input });
}

describe('expandFleetComposition', () => {
  it('expands TFIs into 44 named ships and one fleet', () => {
    const { fleet, ships, problems, warnings } = expand();
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(ships).toHaveLength(44);
    expect(ships[0]).toEqual({ id: 'tfis-fc', dna: TFI, name: 'FC', position: [0, 0, 0], rotation: [0, 0, 0], type: 'Tempest Fleet Issue', propMod: { module: '500MN Cold-Gas Enduring Microwarpdrive' }, fit: 'tfis/tfi' });
    const byId = new Map(ships.map((ship) => [ship.id, ship]));
    expect(byId.get('tfis-dps-a-01')?.name).toBe('Tempest Fleet Issue 1');
    expect(byId.get('tfis-dps-b-10')?.name).toBe('Tempest Fleet Issue 10');
    expect(byId.get('tfis-logi-08')).toMatchObject({ name: 'Zarmazd 3', type: 'Zarmazd' });
    expect(byId.get('tfis-dreads-02')?.name).toBe('Revelation 2');
    expect(byId.get('tfis-fax-01')?.name).toBe('Apostle');
    expect(ships.at(-1)?.id).toBe('tfis-carriers-03');
    expect(ships.every((ship) => ship.rotation.join() === '0,0,0' && ship.team === undefined)).toBe(true);

    expect(fleet?.id).toBe('tfis');
    expect(fleet?.name).toBe('TFIs');
    expect(fleet?.commander).toBe('tfis-fc');
    expect(fleet?.wings.map((wing) => wing.id)).toEqual(['mainline', 'logistics', 'capitals']);
    const squads = new Map(fleet!.wings.flatMap((wing) => wing.squads).map((squad) => [squad.id, squad]));
    expect([...squads.keys()]).toEqual(['dps-a', 'dps-b', 'ewar', 'tackle', 'boost', 'logi', 'dreads', 'fax', 'carriers']);
    expect(squads.get('ewar')).toEqual({ id: 'ewar', name: 'Bhaalgorns', role: 'ewar', members: ['tfis-ewar-01', 'tfis-ewar-02', 'tfis-ewar-03', 'tfis-ewar-04', 'tfis-ewar-05'], anchor: { range: 2500 } });
    expect(squads.get('dps-a')?.anchor).toBeUndefined();
    expect(squads.get('logi')?.anchor).toEqual({ ship: 'tfis-logi-01' });
    expect(squads.get('fax')?.anchor).toEqual({ ship: 'tfis-logi-01', range: 5000 });
    expect(squads.get('dreads')?.anchor).toEqual({ range: 10000 });
  });

  it('produces the anchors toFleetMemberships resolves', () => {
    const memberships = toFleetMemberships({ fleets: [expand().fleet!] });
    expect(memberships.get('tfis-fc')).toMatchObject({ anchor: null, commands: ['fleet'] });
    expect(memberships.get('tfis-dps-a-05')?.anchor).toEqual({ ship: 'tfis-fc', range: 1000 });
    expect(memberships.get('tfis-logi-01')?.anchor).toEqual({ ship: 'tfis-fc', range: 30000 });
    expect(memberships.get('tfis-logi-06')?.anchor).toEqual({ ship: 'tfis-logi-01', range: 1000 });
    expect(memberships.get('tfis-fax-01')?.anchor).toEqual({ ship: 'tfis-logi-01', range: 5000 });
    expect(memberships.get('tfis-carriers-02')?.anchor).toEqual({ ship: 'tfis-fc', range: 15000 });
  });

  it('puts the team and heading on every ship', () => {
    const { ships } = expand({ team: 'blue', heading: 45 });
    expect(ships.every((ship) => ship.team === 'blue' && ship.rotation.join() === '45,0,0')).toBe(true);
  });

  it('numbers the fleet id until it and its ship ids are free', () => {
    expect(expand({ existing: { ships: new Map(), fleets: new Set(['tfis']) } }).fleet?.id).toBe('tfis-2');
    expect(expand({ existing: { ships: new Map([['tfis-2-fc', [0, 0, 0]]]), fleets: new Set(['tfis']) } }).fleet?.id).toBe('tfis-3');
  });

  it('refuses a taken explicit fleet id and ids over 64 characters', () => {
    expect(expand({ fleet: 'tfis', existing: { ships: new Map(), fleets: new Set(['tfis']) } }).problems).toEqual(['composition: fleet "tfis" already exists in the scene; give another fleet id or omit it']);
    expect(expand({ fleet: 'x', existing: { ships: new Map([['x-fc', [0, 0, 0]]]), fleets: new Set() } }).problems).toEqual(['composition: ship "x-fc" already exists in the scene; give another fleet id or omit it']);
    const long = 'f'.repeat(60);
    const { problems, fleet } = expand({ composition: requireComposition(makeMiniComposition()), fleet: long });
    expect(fleet).toBeNull();
    expect(problems).toEqual([
      `composition.wings[0].squads[0].ships[0]: ship id "${long}-dps-01" is longer than 64 characters; use a shorter fleet or squad id`,
      `composition.wings[0].squads[0].ships[0]: ship id "${long}-dps-02" is longer than 64 characters; use a shorter fleet or squad id`,
      `composition.wings[0].squads[0].ships[0]: ship id "${long}-dps-03" is longer than 64 characters; use a shorter fleet or squad id`,
      `composition.wings[0].squads[1].ships[0]: ship id "${long}-logi-01" is longer than 64 characters; use a shorter fleet or squad id`,
      `composition.wings[0].squads[1].ships[0]: ship id "${long}-logi-02" is longer than 64 characters; use a shorter fleet or squad id`
    ]);
  });

  it('needs every line dna, and warns once about missing radii', () => {
    const composition = requireComposition({
      id: 'g',
      commander: { hull: 'Guardian' },
      wings: [
        {
          id: 'w',
          squads: [
            {
              id: 's',
              role: 'dps',
              ships: [
                { hull: 'Megathron', count: 2, dna: 'gb1_t1:gallentebase:gallente' },
                { hull: 'Guardian', dna: 'ac3_t2:carthum:amarr' }
              ]
            }
          ]
        }
      ]
    });
    expect(expand({ composition, where: 'operations[0].composition' }).problems).toEqual(['operations[0].composition.commander: hull "Guardian" has no dna. The add_fleet_composition tool resolves hull names to DNA through tools-core; patch_scene needs every ship line\'s dna.']);
    composition.commander.dna = 'ac3_t2:carthum:amarr';
    const { problems, warnings } = expand({ composition });
    expect(problems).toEqual([]);
    expect(warnings).toEqual(['fleet "g": no radius for Guardian, Megathron; their spacing assumes 500 m. Give each ship line a radius, or add the fleet with the add_fleet_composition tool, which reads it from the EVE data.']);
  });

  it('warns when ships land on ships already in the scene', () => {
    const { warnings } = expand({ composition: requireComposition(makeMiniComposition()), existing: { ships: new Map([['rifter', [0, 0, 100]]]), fleets: new Set() } });
    expect(warnings).toEqual(['fleet "mini": 1 ship lands within 500 m of ships already in the scene (mini-fc near "rifter"); add the fleet at another position']);
  });

  it('gives each ship the prop mod of its line, else of its fit, else nothing', () => {
    const { ships } = expand();
    const modules = new Map(ships.map((ship) => [ship.id, ship.propMod?.module]));
    expect(modules.get('tfis-logi-01')).toBe('10MN Afterburner II');
    expect(modules.get('tfis-logi-08')).toBe('50MN Cold-Gas Enduring Microwarpdrive');
    expect(modules.get('tfis-carriers-01')).toBe('10000MN Monopropellant Enduring Afterburner');
    expect(modules.get('tfis-dreads-01')).toBe('none');
    expect(modules.get('tfis-fax-01')).toBe('none');
    expect(ships.every((ship) => ship.propMod?.active === undefined)).toBe(true);

    const mini = makeMiniComposition();
    const wings = mini['wings'] as { squads: { ships: Record<string, unknown>[] }[] }[];
    wings[0].squads[0].ships[0]['propMod'] = 'AB';
    wings[0].squads[1].ships[0]['fit'] = 'logi';
    mini['fits'] = { logi: '[Guardian, Logi]\n\nDamage Control II\n\n10MN Afterburner II\n' };
    const expanded = expand({ composition: requireComposition(mini) }).ships;
    expect(expanded.map((ship) => ship.propMod?.module ?? null)).toEqual([null, 'ab', 'ab', 'ab', '10MN Afterburner II', '10MN Afterburner II']);
  });
});
