import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySceneOperations, type MapCelestial, normalizeScene, type SceneDocument, type SceneVector, toLocationPlacement } from '@scene-director/scene';
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetPersonalityFileStore } from '../store/personality-files';
import { FleetCompositions, requireFleetComposition, resolveCompositionHulls, resolveCompositionPropMods } from './fleet-compositions';
import { FleetPersonalities } from './fleet-personalities';
import { Locations } from './locations';
import { MakeFakeMapData } from './map-data.testing';
import type { SavedScenesPage } from './saved-scenes';
import { FakeAddCue, FakeGetScene } from './scene-page.testing';
import { WARP_IN_DOCUMENT_WARNING } from './scene-places';
import { MakeFakeShipData, PROP_MOD_LISTING_ROUTE, TFI_DNA } from './ship-data.testing';
import { ToolError, type ToolArgs } from './tool-call';

const GUARDIAN = 'ac3_t2:carthum:amarr';
const NO_PAGE = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};

const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';

/**
 * A tab holding a document: get_scene returns it; patch_scene applies the operations, records them and answers with
 * a stand-in arrivals report, as the page does for warpIn.
 */
class FakePage implements SavedScenesPage {
  scene: SceneDocument;
  readonly patches: Record<string, unknown>[][] = [];

  constructor(scene: unknown) {
    this.scene = normalizeScene(scene).scene;
  }

  Connected(): boolean {
    return true;
  }

  NotConnected(): ToolError {
    return new ToolError('not connected');
  }

  async Call(name: string, args: ToolArgs = {}): Promise<unknown> {
    let result: unknown = null;
    if (name === 'get_scene') result = FakeGetScene(this.scene, args);
    else if (name === 'patch_scene' && (args['at'] != null || args['when'] != null)) ({ scene: this.scene, result } = FakeAddCue(this.scene, args));
    else if (name === 'patch_scene') {
      this.patches.push(args['operations'] as Record<string, unknown>[]);
      const { scene, warnings, arrivals } = applySceneOperations(this.scene, args['operations']);
      this.scene = scene;
      result = { scene, warnings, changes: {}, ...(arrivals ? { arrivals: arrivals.map((arrival) => ({ group: arrival.group, state: 'waiting', ships: arrival.ships.length })) } : {}) };
    }
    return result;
  }
}

let compositions: FleetCompositions;
let calls: string[];

function MakeCompositions(page: SavedScenesPage, files: FleetCompositionFileStore): FleetCompositions {
  const fake = MakeFakeShipData();
  calls = fake.calls;
  const mapData = MakeFakeMapData().mapData;
  return new FleetCompositions({ files, shipData: fake.shipData, mapData, personalities: new FleetPersonalities({ files: personalityFiles, shipData: fake.shipData, mapData, page }), page });
}

let personalityFiles: FleetPersonalityFileStore;

beforeEach(async () => {
  personalityFiles = new FleetPersonalityFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-compositions-personalities-')));
  compositions = MakeCompositions(NO_PAGE, new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-compositions-'))));
});

describe('resolveCompositionPropMods', () => {
  it('checks each distinct module once, explicit or from the fit, and skips the keywords', async () => {
    const fake = MakeFakeShipData();
    const composition = requireFleetComposition({
      id: 'p',
      commander: { hull: 'Guardian', dna: GUARDIAN, propMod: '10MN AB II' },
      wings: [
        {
          id: 'w',
          squads: [
            {
              id: 'a',
              role: 'dps',
              ships: [
                { hull: 'Guardian', dna: GUARDIAN, count: 2, propMod: '10mn afterburner ii' },
                { hull: 'Guardian', dna: GUARDIAN, propMod: 'mwd' }
              ]
            },
            {
              id: 'b',
              role: 'logi',
              ships: [
                { hull: 'Guardian', dna: GUARDIAN, fit: 'g' },
                { hull: 'Guardian', dna: GUARDIAN, propMod: 12084 },
                { hull: 'Guardian', dna: GUARDIAN, propMod: 'Odd Module' }
              ]
            }
          ]
        }
      ],
      fits: { g: '[Guardian, g]\n50MN Microwarpdrive II\n' }
    });
    const { propMods, warnings } = await resolveCompositionPropMods({ composition, shipData: fake.shipData });
    expect(propMods).toEqual([
      { module: '10MN AB II', typeID: 12058, name: '10MN Afterburner II', from: 'sde' },
      { module: '50MN Microwarpdrive II', typeID: 12076, name: '50MN Microwarpdrive II', from: 'sde' },
      { module: 12084, typeID: 12084, name: '500MN Microwarpdrive II', from: 'sde' },
      { module: 'Odd Module', from: 'unknown', note: 'no propulsion module is named "Odd Module"' }
    ]);
    expect(warnings).toEqual(['prop mod "Odd Module" is not a propulsion module in the EVE data (no propulsion module is named "Odd Module"); those ships fly the hull-sized default']);
    expect(fake.calls.filter((call) => call === PROP_MOD_LISTING_ROUTE)).toHaveLength(1);
  });

  it('reports a module it could not check as unchecked, without a warning', async () => {
    const fake = MakeFakeShipData({ '/eve/latest/build': 'network-error' });
    const composition = requireFleetComposition({ id: 'p', commander: { hull: 'Guardian', dna: GUARDIAN, propMod: '10MN AB II' } });
    const { propMods, warnings } = await resolveCompositionPropMods({ composition, shipData: fake.shipData });
    expect(propMods).toMatchObject([{ module: '10MN AB II', from: 'unchecked' }]);
    expect(warnings).toEqual([]);
  });
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
    expect(unknown.problems).toEqual([expect.stringMatching(/^hull "Nopeship" has no dna and could not be resolved from the EVE data: /u)]);

    const offline = MakeFakeShipData({ '/eve/latest/build': 'network-error' }).shipData;
    const missing = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian' } }), shipData: offline });
    expect(missing.problems).toEqual([expect.stringMatching(/^hull "Guardian" has no dna and could not be resolved from the EVE data: .*tools-core/u)]);

    const withDna = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian', dna: GUARDIAN } }), shipData: offline });
    expect(withDna.problems).toEqual([]);
    expect(withDna.warnings).toEqual([expect.stringMatching(/^hull "Guardian" could not be looked up .*its radius defaults to 500 m$/u)]);
    expect(withDna.hulls).toEqual([{ hull: 'Guardian', dna: GUARDIAN, radius: 500, dnaFrom: 'composition', radiusFrom: 'default' }]);
  });

  it('warns when a line looks like another SOF hull than the EVE data says', async () => {
    const resolved = await resolveCompositionHulls({ composition: requireFleetComposition({ id: 'x', commander: { hull: 'Guardian', dna: 'mb2_t1:minmatarnavy:minmatar' } }), shipData: MakeFakeShipData().shipData });
    expect(resolved.warnings).toEqual(['hull "Guardian" is ac3_t2 in the EVE data, but its line\'s dna is mb2_t1:minmatarnavy:minmatar; the ship looks like mb2_t1 and flies as Guardian']);
    expect(resolved.hulls[0]).toMatchObject({ dna: 'mb2_t1:minmatarnavy:minmatar', radius: 80, dnaFrom: 'composition', radiusFrom: 'sde' });
  });
});

describe('FleetCompositions', () => {
  it('adds the built-in TFIs to a passed scene with no tab and no hull lookup', async () => {
    for (const name of ['tfis', 'TFIs']) {
      const result = (await compositions.call('add_fleet_composition', { name, position: [0, 0, 0], scene: { name: 'empty' } })) as { added: { fleet: string; ships: string[] }; loaded: boolean; scene: { name: string; ships: unknown[] } };
      expect(result.loaded).toBe(false);
      expect(result.added.fleet).toBe('tfis');
      expect(result.added.ships).toHaveLength(44);
      expect(result.scene.ships).toHaveLength(44);
    }
    expect(calls.filter((call) => call.includes('/dna/') || call.includes('/dogma/types/'))).toEqual([]);
  });

  it("embeds a saved personality, over the composition's, in the same patch", async () => {
    await personalityFiles.Put('my-brawler', { schema: 'cjs-fleet-personality/1', id: 'my-brawler', extends: 'brawler', engage: 'on-sight' });
    const result = (await compositions.call('add_fleet_composition', { name: 'tfis', personality: 'My-Brawler', position: [0, 0, 0], scene: { name: 'empty' } })) as { personality: object; scene: SceneDocument };
    expect(result.personality).toEqual({ name: 'my-brawler', from: 'disk', chain: ['my-brawler', 'brawler', 'line'], embedded: ['my-brawler'] });
    expect(result.scene.fleets?.[0].personality).toBe('my-brawler');
    expect(result.scene.personalities?.['my-brawler']).toMatchObject({ extends: 'brawler', engage: 'on-sight' });
    const tfis = ((await compositions.call('get_fleet_composition', { name: 'tfis' })) as { composition: object }).composition;
    const sniper = (await compositions.call('add_fleet_composition', { composition: { ...tfis, personality: 'sniper' }, position: [0, 0, 0], scene: { name: 'empty' } })) as { personality: object; scene: SceneDocument };
    expect(sniper.personality).toEqual({ name: 'sniper', from: 'built-in', chain: ['sniper', 'line'] });
    expect(sniper.scene.personalities).toBeUndefined();
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', personality: 'nobody', position: [0, 0, 0], scene: { name: 'empty' } })).rejects.toThrow(/no fleet personality "nobody"/u);
  });

  it('refuses composition and name together, and neither, and explains a missing tab', async () => {
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', composition: {}, position: [0, 0, 0] })).rejects.toThrow(/not both/u);
    await expect(compositions.call('add_fleet_composition', { position: [0, 0, 0] })).rejects.toThrow(/give composition .* or name/u);
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0] })).rejects.toThrow(/No viewer tab is connected\. Or pass "scene"/u);
    await expect(compositions.call('add_fleet_composition', { name: 'nope', position: [0, 0, 0] })).rejects.toThrow(/no fleet composition "nope"/u);
  });

  it('refuses position and near together, and neither', async () => {
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0], near: { ship: 'x' }, scene: { name: 'x' } })).rejects.toThrow(/give position or near, not both/u);
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', scene: { name: 'x' } })).rejects.toThrow(/position or near is required/u);
  });

  it('places the FC off a celestial on its radius, warping in from another, and warns that a document places them', async () => {
    const { mapData } = MakeFakeMapData();
    const located = ((await new Locations({ mapData, page: NO_PAGE }).SetLocation({ scene: { name: 'loc' }, celestial: CNAP, range: 30000 })) as { readonly scene: SceneDocument }).scene;
    const celestials = await mapData.SystemCelestials(30000142);
    const cnap = celestials.find((celestial) => celestial.name === CNAP) as MapCelestial;
    const star = celestials.find((celestial) => celestial.kind === 'star') as MapCelestial;
    const result = (await compositions.call('add_fleet_composition', { name: 'tfis', scene: located, near: { celestial: CNAP, range: 20000 }, warpIn: { from: { celestial: star.name }, stagger: 6 } })) as { added: { commander: string }; scene: SceneDocument; warnings: string[] };
    const origin = located.location?.origin as SceneVector;
    const expected = toLocationPlacement({ kind: cnap.kind, position: cnap.position, radius: cnap.radius, range: 20000 + 250 }).origin as SceneVector;
    const fc = result.scene.ships.find((ship) => ship.id === result.added.commander);
    for (const axis of [0, 1, 2]) expect(Math.abs((fc?.position[axis] ?? 0) - (expected[axis] - origin[axis]))).toBeLessThanOrEqual(1);
    const from = star.position.map((value, axis) => Math.round(value - origin[axis])) as SceneVector;
    const yaw = (Math.atan2((fc?.position[0] ?? 0) - from[0], (fc?.position[2] ?? 0) - from[2]) * 180) / Math.PI;
    expect(Math.abs((((fc?.rotation[0] ?? 0) - yaw + 540) % 360) - 180)).toBeLessThan(0.01);
    expect(result.warnings).toContain(WARP_IN_DOCUMENT_WARNING);
  });

  it("takes a near ship's heading, sends warpIn to the tab and passes its arrivals back; from overrides the heading", async () => {
    const files = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-compositions-')));
    const page = new FakePage({ name: 'tab', ships: [{ id: 'anchor', dna: TFI_DNA, rotation: [90, 0, 0] }] });
    const tab = MakeCompositions(page, files);
    const result = (await tab.call('add_fleet_composition', { name: 'tfis', near: { ship: 'anchor', range: 10000 }, warpIn: true })) as { added: { commander: string }; arrivals: unknown; warnings: string[] };
    const operation = page.patches[0][0];
    expect(operation).toMatchObject({ warpIn: true, heading: 90 });
    const fc = page.scene.ships.find((ship) => ship.id === result.added.commander);
    expect(fc?.position[0]).toBeGreaterThanOrEqual(10000 + 250);
    expect(Math.abs(fc?.position[2] ?? 1)).toBeLessThanOrEqual(1);
    expect(result.arrivals).toEqual([{ group: 'tfis', state: 'waiting', ships: 44 }]);
    expect(result.warnings).not.toContain(WARP_IN_DOCUMENT_WARNING);

    await tab.call('add_fleet_composition', { name: 'tfis', near: { ship: 'anchor', range: 10000 }, warpIn: { from: [0, 0, -100000] } });
    const second = page.patches[1][0];
    expect(second['heading']).toBeUndefined();
    expect(second['warpIn']).toEqual({ from: [0, 0, -100000] });
  });

  it('with at becomes a patch_scene cue with dna filled and its adds, adding nothing now', async () => {
    const files = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'fleet-compositions-')));
    const page = new FakePage({ name: 'tab', ships: [{ id: 'anchor', dna: TFI_DNA }] });
    const tab = MakeCompositions(page, files);
    const composition = { id: 'red', commander: { hull: 'Rifter' }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ hull: 'Rifter', count: 2 }] }] }] };
    const result = (await tab.call('add_fleet_composition', { composition, position: [0, 0, 25000], heading: 180, team: 'red', warpIn: true, at: 5, cue: 'red-lands' })) as Record<string, any>;
    expect(page.patches).toEqual([]);
    expect(page.scene.ships.map((ship) => ship.id)).toEqual(['anchor']);
    const cue = page.scene.timeline?.cues[0] as Record<string, any>;
    expect(result['cue']).toEqual(cue);
    expect(cue).toMatchObject({ id: 'red-lands', at: 5, name: 'add_fleet_composition red', adds: { fleets: ['red'] } });
    expect(cue['adds'].ships).toHaveLength(3);
    const operation = cue['patch_scene'].operations[0];
    expect(operation).toMatchObject({ op: 'add_fleet_composition', position: [0, 0, 25000], heading: 180, team: 'red', warpIn: true });
    expect(operation.composition.commander).toMatchObject({ dna: 'mf4_t1:minmatarbase:minmatar', radius: 31 });
    expect(result['added']).toBeUndefined();
    expect(result['hulls'][0]).toMatchObject({ hull: 'Rifter', dnaFrom: 'sde' });
  });

  it('cues on a passed scene, and refuses a bad at or a cue without at', async () => {
    const result = (await compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0], scene: { name: 'x' }, at: 3 })) as Record<string, any>;
    expect(result['loaded']).toBe(false);
    expect(result['scene'].ships).toEqual([]);
    expect(result['scene'].timeline.cues).toEqual([result['cue']]);
    expect(result['cue'].adds.ships).toHaveLength(44);
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0], scene: { name: 'x' }, cue: 'late' })).rejects.toThrow(/cue \(the cue id\) goes with at/u);
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0], scene: { name: 'x' }, at: -1 })).rejects.toThrow(/at must be seconds of timeline time/u);
  });

  it('refuses a warpIn.from celestial without a location', async () => {
    await expect(compositions.call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0], scene: { name: 'x' }, warpIn: { from: { celestial: CNAP } } })).rejects.toThrow(/warpIn\.from\.celestial: the scene has no location/u);
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
