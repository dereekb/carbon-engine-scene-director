import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetCompositions, requireFleetComposition, resolveCompositionHulls } from './fleet-compositions';
import { MakeFakeShipData } from './ship-data.testing';
import { ToolError } from './tool-call';

const GUARDIAN = 'ac3_t2:carthum:amarr';
const NO_PAGE = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};

let compositions: FleetCompositions;
let calls: string[];

beforeEach(async () => {
  const fake = MakeFakeShipData();
  calls = fake.calls;
  const files = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-compositions-')));
  compositions = new FleetCompositions({ files, shipData: fake.shipData, page: NO_PAGE });
});

describe('resolveCompositionHulls', () => {
  it('fills a line from the EVE data, and looks up nothing for a complete line', async () => {
    const { shipData, calls: requests } = MakeFakeShipData();
    const composition = requireFleetComposition({ id: 'g', commander: { hull: 'Guardian', dna: GUARDIAN, radius: 80 }, wings: [{ id: 'w', squads: [{ id: 's', role: 'logi', ships: [{ hull: 'guardian', count: 2 }] }] }] });
    const resolved = await resolveCompositionHulls({ composition, shipData });
    expect(resolved.problems).toEqual([]);
    expect(resolved.composition.wings[0].squads[0].ships[0]).toMatchObject({ dna: GUARDIAN, radius: 80 });
    expect(resolved.hulls).toEqual([{ hull: 'Guardian', typeID: 11987, dna: GUARDIAN, radius: 80, dnaFrom: 'sde', radiusFrom: 'sde' }]);
    expect(composition.wings[0].squads[0].ships[0].dna).toBeUndefined();

    const complete = MakeFakeShipData();
    const done = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'g', commander: { hull: 'Guardian', dna: GUARDIAN, radius: 80 } }), shipData: complete.shipData });
    expect(done.hulls).toEqual([{ hull: 'Guardian', dna: GUARDIAN, radius: 80, dnaFrom: 'composition', radiusFrom: 'composition' }]);
    expect(complete.calls).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('makes an unresolvable hull without dna a problem, and one with dna a warning', async () => {
    const unknown = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Nopeship' } }), shipData: MakeFakeShipData().shipData });
    expect(unknown.problems).toEqual([expect.stringMatching(/^hull "Nopeship" has no dna and could not be resolved through tools-core: /u)]);

    const offline = MakeFakeShipData({ '/eve/latest/build': 'network-error' }).shipData;
    const missing = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian' } }), shipData: offline });
    expect(missing.problems).toEqual([expect.stringMatching(/^hull "Guardian" has no dna and could not be resolved through tools-core: .*tools-core/u)]);

    const withDna = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian', dna: GUARDIAN } }), shipData: offline });
    expect(withDna.problems).toEqual([]);
    expect(withDna.warnings).toEqual([expect.stringMatching(/^hull "Guardian" could not be looked up through tools-core .*its radius defaults to 500 m$/u)]);
    expect(withDna.hulls).toEqual([{ hull: 'Guardian', dna: GUARDIAN, radius: 500, dnaFrom: 'composition', radiusFrom: 'default' }]);
  });

  it('warns when a line looks like another SOF hull than the EVE data says', async () => {
    const resolved = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian', dna: 'mb2_t1:minmatarnavy:minmatar' } }), shipData: MakeFakeShipData().shipData });
    expect(resolved.warnings).toEqual(['hull "Guardian" is ac3_t2 in the EVE data, but its line\'s dna is mb2_t1:minmatarnavy:minmatar; the ship looks like mb2_t1 and flies as Guardian']);
    expect(resolved.hulls[0]).toMatchObject({ dna: 'mb2_t1:minmatarnavy:minmatar', radius: 80, dnaFrom: 'composition', radiusFrom: 'sde' });
  });
});

describe('FleetCompositions', () => {
  it('adds the built-in TFIs to a passed scene with no tab and no tools-core request', async () => {
    for (const name of ['tfis', 'TFIs']) {
      const result = (await compositions.call('add_fleet_composition', { name, position: [0, 0, 0], scene: { name: 'empty' } })) as { added: { fleet: string; ships: string[] }; loaded: boolean; scene: { name: string; ships: unknown[] } };
      expect(result.loaded).toBe(false);
      expect(result.added.fleet).toBe('tfis');
      expect(result.added.ships).toHaveLength(44);
      expect(result.scene.ships).toHaveLength(44);
    }
    expect(calls).toEqual([]);
  });

  it('refuses composition and name together, and neither, and explains a missing tab', async () => {
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', composition: {}, position: [0, 0, 0] })).rejects.toThrow(/not both/u);
    await expect(compositions.call('add_fleet_composition', { position: [0, 0, 0] })).rejects.toThrow(/give composition .* or name/u);
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0] })).rejects.toThrow(/No viewer tab is connected\. Or pass "scene"/u);
    await expect(compositions.call('add_fleet_composition', { name: 'nope', position: [0, 0, 0] })).rejects.toThrow(/no fleet composition "nope"/u);
  });

  it('saves, lists, gets and deletes, with the example read-only and shadowed by a save', async () => {
    const listed = (await compositions.call('list_fleet_compositions', {})) as { compositions: unknown[] };
    expect(listed.compositions).toEqual([{ name: 'TFIs', id: 'tfis', store: 'example', ships: 44, squads: 9 }]);
    const example = (await compositions.call('get_fleet_composition', { name: 'tfis' })) as { store: string; composition: { id: string } };
    expect(example).toMatchObject({ name: 'TFIs', store: 'example', ships: 44 });

    const saved = (await compositions.call('save_fleet_composition', { composition: { ...example.composition, wings: [] } })) as { saved: string; note: string };
    expect(saved).toMatchObject({ saved: 'TFIs', store: 'disk', ships: 1, note: expect.stringMatching(/shadows the built-in example "TFIs"/u) });
    const shadowed = (await compositions.call('list_fleet_compositions', {})) as { compositions: { name: string; store: string; ships: number }[] };
    expect(shadowed.compositions.map(({ name, store, ships }) => `${store}:${name}:${ships}`)).toEqual(['disk:TFIs:1']);
    expect(await compositions.call('get_fleet_composition', { name: 'tfis' })).toMatchObject({ store: 'disk', ships: 1 });

    expect(await compositions.call('delete_fleet_composition', { name: 'tfis' })).toMatchObject({ deleted: true, name: 'tfis' });
    expect(await compositions.call('delete_fleet_composition', { name: 'tfis' })).toEqual({ deleted: false, name: 'tfis', note: '"TFIs" is a built-in example; examples are read-only' });
    expect(compositions.call('get_scene', {})).toBeNull();
  });
});
