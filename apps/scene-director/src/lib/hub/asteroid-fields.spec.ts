import { expandAsteroidField, normalizeScene, type SceneAsteroidField, type SceneDocument, SceneError } from '@scene-director/scene';
import { beforeAll, describe, expect, it } from 'vitest';
import { MakeFakeAsteroidData } from './asteroid-data.testing';
import { AsteroidFieldTools } from './asteroid-fields';
import { Locations } from './locations';
import { MakeFakeMapData } from './map-data.testing';
import type { SavedScenesPage } from './saved-scenes';
import { MakeFakeShipData, SDE, SHIP_ROUTES, TFI_DNA } from './ship-data.testing';
import { ToolError } from './tool-call';

const BELT = 'Perimeter II - Asteroid Belt 1';
const ROUTES = { ...SHIP_ROUTES, [`/eve/${SDE}/dna/resolve?name=Tempest%20Fleet%20Issue`]: { json: { typeID: '17732', graphicID: '11777', skinID: null, dna: TFI_DNA } } };
const TFI_SCENE = { name: 'fields', ships: [{ id: 'tfi', dna: TFI_DNA, type: 'Tempest Fleet Issue', rotation: [90, 0, 0] }] };

const NO_PAGE: SavedScenesPage = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};

let beltScene: SceneDocument;

beforeAll(async () => {
  const set = (await new Locations({ mapData: MakeFakeMapData().mapData, page: NO_PAGE }).SetLocation({ scene: { name: 'belt' }, celestial: BELT })) as { readonly scene: SceneDocument };
  beltScene = set.scene;
});

function MakeTools(): AsteroidFieldTools {
  return new AsteroidFieldTools({ asteroidData: MakeFakeAsteroidData().asteroidData, shipData: MakeFakeShipData(ROUTES).shipData, mapData: MakeFakeMapData().mapData, page: NO_PAGE });
}

interface AddResult {
  readonly added: { readonly id: string; readonly position: number[]; readonly radius: number; readonly placed: number; readonly digest: string; readonly envelope: number };
  readonly ores: { readonly ore?: string; readonly faction?: string; readonly models: Record<string, number>; readonly from: string; readonly skipped?: string[] }[];
  readonly scene: SceneDocument;
  readonly loaded: boolean;
  readonly warnings: string[];
}

async function Add(args: Record<string, unknown>): Promise<AddResult> {
  return (await MakeTools().AddAsteroidField({ scene: TFI_SCENE, ...args })) as AddResult;
}

function Field(scene: SceneDocument, id: string): SceneAsteroidField {
  const found = scene.asteroidFields?.find((field) => field.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

async function Problems(args: Record<string, unknown>): Promise<string[]> {
  try {
    await Add(args);
  } catch (error) {
    if (error instanceof SceneError) return error.problems;
    if (error instanceof Error) return [error.message];
  }
  return [];
}

describe('add_asteroid_field', () => {
  it('resolves ore names, weights, factions and given rocks into one field', async () => {
    const result = await Add({ ores: ['Veldspar', { ore: 'Dark Ochre', weight: 2 }, { faction: 'ice_blue', name: 'Blue' }, { rocks: ['rock_01_m_v1a_whiteyellow:ore_veldspar:asteroid'], name: 'One rock' }], position: [0, 0, 80000], count: 200 });
    expect(result.loaded).toBe(false);
    expect(result.ores).toEqual([
      { ore: 'Veldspar', type: 1230, group: 'Veldspar', faction: 'ore_veldspar', models: { small: 4, medium: 4, large: 4 }, from: 'sde', skipped: ['as1_l_03_whitebrown', 'rock_01_field_v1a_whiteyellow'] },
      { ore: 'Dark Ochre', type: 1232, group: 'Dark Ochre', faction: 'crystal_darkochre', models: { small: 4, medium: 4, large: 4 }, from: 'sde' },
      { ore: 'Blue', faction: 'ice_blue', models: { small: 4, medium: 4, large: 4 }, from: 'faction' },
      { ore: 'One rock', models: { small: 1, medium: 1, large: 1 }, from: 'given' }
    ]);
    const field = Field(result.scene, result.added.id);
    expect(result.added.id).toBe('veldspar-01');
    expect(field.name).toBe('Veldspar, Dark Ochre, Blue and One rock field');
    expect(field.ores.map((ore) => [ore.ore, ore.type, ore.faction, ore.weight])).toEqual([
      ['Veldspar', 1230, 'ore_veldspar', undefined],
      ['Dark Ochre', 1232, 'crystal_darkochre', 2],
      ['Blue', undefined, 'ice_blue', undefined],
      ['One rock', undefined, undefined, undefined]
    ]);
    const expansion = expandAsteroidField(field);
    expect(result.added).toMatchObject({ placed: expansion.placed, digest: expansion.digest, envelope: expansion.envelope });
    expect(result.added.placed).toBeGreaterThan(190);
  });

  it('centres a field on an asteroid belt with the belt radius', async () => {
    const result = (await MakeTools().AddAsteroidField({ scene: beltScene, ores: ['Veldspar'], near: { celestial: BELT }, shape: 'disc', arc: 180 })) as AddResult;
    expect(Math.hypot(...result.added.position)).toBeLessThan(1);
    expect(result.added.radius).toBe(44425);
    const off = (await MakeTools().AddAsteroidField({ scene: beltScene, ores: ['Veldspar'], near: { celestial: BELT, range: 100000 }, radius: 10000 })) as AddResult;
    expect(Math.hypot(...off.added.position)).toBeCloseTo(100000, 0);
    expect(off.added.radius).toBe(10000);
  });

  it('places a field near a ship from its EVE radius to the field edge', async () => {
    const result = await Add({ ores: ['Veldspar'], id: 'belt', radius: 25000, near: { ship: 'tfi', range: 20000, direction: 'behind' } });
    const tfiRadius = 250;
    expect(Math.hypot(...Field(result.scene, 'belt').position)).toBeCloseTo(tfiRadius + 20000 + 25000, 2);
  });

  it('replaces a field in one patch with replace, and refuses a taken id without it', async () => {
    const first = await Add({ ores: ['Veldspar'], id: 'belt', position: [0, 0, 100000] });
    const tools = MakeTools();
    const replaced = (await tools.AddAsteroidField({ scene: first.scene, ores: ['Dark Ochre'], id: 'belt', position: [0, 0, 200000], replace: true })) as AddResult & { readonly replaced: string };
    expect(replaced.replaced).toBe('belt');
    expect(replaced.scene.asteroidFields).toHaveLength(1);
    expect(Field(replaced.scene, 'belt').ores[0].faction).toBe('crystal_darkochre');
    await expect(tools.AddAsteroidField({ scene: first.scene, ores: ['Dark Ochre'], id: 'belt' })).rejects.toThrow('asteroid field "belt" already exists');
  });

  it('fails atomically, naming each bad ore, and refuses a field past the scene extent', async () => {
    expect(await Problems({ ores: ['Veldspar', 'Tritanium', 'Mordunium'] })).toEqual(['ores[1] ("Tritanium"): Tritanium is a Mineral, not an asteroid ore', 'ores[2] ("Mordunium"): no SOF rock set is known for Mordunium (group Mordunium); give { faction: "<SOF rock faction>" } or { rocks: [dna, ...] }']);
    expect(await Problems({ ores: [{ weight: 2 }] })).toEqual(['ores[0] must be an ore name, { ore, weight? }, { faction, weight?, name? } or { rocks, weight?, name? }']);
    expect(await Problems({ ores: [] })).toEqual(['ores must be a list of 1 to 8 ores: names ("Veldspar"), { ore, weight? }, { faction, weight?, name? } or { rocks, weight?, name? }']);
    const far = await Problems({ ores: ['Veldspar'], position: [0, 0, 9_990_000], radius: 20000 });
    expect(far).toHaveLength(1);
    expect(far[0]).toMatch(/^asteroidFields\[0\] reaches 10,000 km from the scene origin/u);
    expect(normalizeScene(TFI_SCENE).scene.asteroidFields).toBeUndefined();
  });
});
