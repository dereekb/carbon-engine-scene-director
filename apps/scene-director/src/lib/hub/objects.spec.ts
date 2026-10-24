import { applySceneOperations, findTool, normalizeScene, type SceneDocument, SceneError } from '@scene-director/scene';
import { beforeAll, describe, expect, it } from 'vitest';
import { Locations } from './locations';
import { MakeFakeMapData } from './map-data.testing';
import { ASTRAHUS_DNA, MakeFakeObjectData, OBJECT_ROUTES, RESOURCES, RUINED_GATE_DNA, TITAN_WRECK_DNA, WRECK_DNA } from './object-data.testing';
import { ObjectTools } from './objects';
import type { SavedScenesPage } from './saved-scenes';
import { FakeAddCue, FakeGetScene } from './scene-page.testing';
import { type Answer, MakeFakeShipData, SDE, SHIP_ROUTES, TFI_DNA } from './ship-data.testing';
import { ToolError, type ToolArgs } from './tool-call';

const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
const ROUTES = { ...SHIP_ROUTES, [`/eve/${SDE}/dna/resolve?name=Tempest%20Fleet%20Issue`]: { json: { typeID: '17732', graphicID: '11777', skinID: null, dna: TFI_DNA } } };
const TFI_SCENE = { name: 'objects', ships: [{ id: 'tfi', dna: TFI_DNA, type: 'Tempest Fleet Issue', rotation: [90, 0, 0] }] };

const NO_PAGE: SavedScenesPage = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};

/**
 * A tab holding a document: get_scene returns it, patch_scene applies the operations and records them.
 */
class FakePage implements SavedScenesPage {
  scene: SceneDocument;
  readonly calls: { readonly name: string; readonly args: ToolArgs }[] = [];

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
    this.calls.push({ name, args });
    let result: unknown = null;
    if (name === 'get_scene') result = FakeGetScene(this.scene, args);
    else if (name === 'patch_scene' && (args['at'] != null || args['when'] != null)) ({ scene: this.scene, result } = FakeAddCue(this.scene, args));
    else if (name === 'patch_scene') {
      const { scene, warnings } = applySceneOperations(this.scene, args['operations']);
      this.scene = scene;
      result = { scene, warnings, ships: [], changes: {} };
    }
    return result;
  }
}

function MakeTools(page: SavedScenesPage = NO_PAGE, routes: Record<string, Answer> = OBJECT_ROUTES): ObjectTools {
  return new ObjectTools({ objectData: MakeFakeObjectData(routes).objectData, shipData: MakeFakeShipData(ROUTES).shipData, mapData: MakeFakeMapData().mapData, page });
}

async function Refused(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(Error);
  return error instanceof SceneError ? error.problems.join('\n') : String((error as Error).message);
}

let located: SceneDocument;

beforeAll(async () => {
  const set = (await new Locations({ mapData: MakeFakeMapData().mapData, page: NO_PAGE }).SetLocation({ scene: { name: 'loc' }, celestial: CNAP, range: 30000 })) as { readonly scene: SceneDocument };
  located = set.scene;
});

describe('add_objects', () => {
  it('fills dna, radius and the canonical type from a name, all lines in one patch_scene', async () => {
    const page = new FakePage(TFI_SCENE);
    const result = (await MakeTools(page).AddObjects({
      objects: [
        { type: 'astrahus', id: 'astra', near: { ship: 'tfi', range: 30000 } },
        { type: 'Minmatar Frigate Wreck', count: 3, spacing: 1000, near: { object: 'astra', range: 3000, direction: 'behind' } }
      ]
    })) as Record<string, any>;
    expect(page.calls.filter((call) => call.name === 'patch_scene')).toHaveLength(1);
    expect(result['added'].map((added: { id: string }) => added.id)).toEqual(['astra', 'minmatar-frigate-wreck-01', 'minmatar-frigate-wreck-02', 'minmatar-frigate-wreck-03']);
    const astra = page.scene.objects?.[0];
    expect(astra).toEqual({ id: 'astra', dna: ASTRAHUS_DNA, type: 'Astrahus', name: 'Astrahus', position: [75250, 0, 0], rotation: [90, 0, 0], radius: 45000 });
    expect(page.scene.objects?.[1]).toMatchObject({ dna: WRECK_DNA, radius: 70, position: [75250 - 48070, 0, 0] });
    expect(result['types']).toEqual([
      { type: 'astrahus', typeID: 35832, name: 'Astrahus', group: 'Citadel', category: 'Structure', dna: ASTRAHUS_DNA, radius: 45000, dnaFrom: 'sde', radiusFrom: 'sde' },
      { type: 'Minmatar Frigate Wreck', typeID: 26550, name: 'Minmatar Frigate Wreck', group: 'Wreck', category: 'Celestial', dna: WRECK_DNA, radius: 70, dnaFrom: 'sde', radiusFrom: 'sof', sdeRadius: 14 }
    ]);
  });

  it('with at becomes one patch_scene cue holding the resolved lines and their adds, adding nothing now', async () => {
    const page = new FakePage(TFI_SCENE);
    const result = (await MakeTools(page).AddObjects({ type: 'astrahus', id: 'astra', near: { ship: 'tfi', range: 30000 }, at: 12 })) as Record<string, any>;
    expect(page.calls.map((call) => call.name)).toEqual(['get_scene', 'patch_scene']);
    expect(page.calls[0].args).toEqual({ at: 12 });
    expect(page.scene.objects ?? []).toEqual([]);
    const cue = page.scene.timeline?.cues[0] as Record<string, any>;
    expect(result['cue']).toEqual(cue);
    expect(cue).toMatchObject({ id: 'cue-1', at: 12, name: 'add_objects astrahus', adds: { objects: ['astra'] } });
    expect(cue['patch_scene'].operations).toEqual([{ op: 'add_objects', type: 'Astrahus', id: 'astra', near: { ship: 'tfi', range: 30000 }, dna: ASTRAHUS_DNA, radius: 45000, radii: { tfi: 250 } }]);
    expect(result['added']).toBeUndefined();
    expect(result['types'][0]).toMatchObject({ name: 'Astrahus', dnaFrom: 'sde' });
  });

  it("spaces, places and orbits titan wrecks on their model's radius, not the SDE's 14 m", async () => {
    const result = (await MakeTools().AddObjects({
      scene: { name: 'x' },
      objects: [
        { type: 'Astrahus', id: 'astra', position: [0, 0, 100000] },
        { type: 'Minmatar Titan Wreck', count: 3, near: { object: 'astra', range: 5000 } }
      ]
    })) as Record<string, any>;
    const wrecks = (result['scene'] as SceneDocument).objects?.filter((object) => object.dna === TITAN_WRECK_DNA) ?? [];
    expect(wrecks).toHaveLength(3);
    expect(wrecks.every((wreck) => wreck.radius === 10891)).toBe(true);
    expect(wrecks[0].position).toEqual([0, 0, 100000 + 45000 + 5000 + 10891]);
    for (const [index, wreck] of wrecks.entries()) {
      for (const other of wrecks.slice(index + 1)) expect(Math.hypot(...wreck.position.map((value, axis) => value - other.position[axis]))).toBeGreaterThanOrEqual(32772);
    }
    expect(result['types'][1]).toMatchObject({ typeID: 26556, radius: 10891, radiusFrom: 'sof', sdeRadius: 14 });
  });

  it('warns of ships inside a titan wreck and of a spacing under two radii', async () => {
    const inside = (await MakeTools().AddObjects({ scene: TFI_SCENE, type: 'Minmatar Titan Wreck', id: 'wreck', position: [8000, 0, 0] })) as Record<string, any>;
    expect(inside['warnings'].join('\n')).toMatch(/wreck overlaps ships "tfi" \(inside its 10,891 m radius\)/u);
    const packed = (await MakeTools().AddObjects({ scene: { name: 'x' }, type: 'Minmatar Titan Wreck', count: 2, spacing: 5000, position: [0, 0, 500000] })) as Record<string, any>;
    expect(packed['warnings'].join('\n')).toMatch(/spacing 5000 m is under two radii \(21782 m\), so the objects overlap/u);
  });

  it('adds a wreck with no radius, and says why, when its SOF hull cannot be read', async () => {
    const routes = { ...OBJECT_ROUTES, [`/eve/${RESOURCES}/sof/hulls/mt1_t1_wreck`]: { status: 501, json: { error: 'SOF service is not configured' } } };
    const result = (await MakeTools(NO_PAGE, routes).AddObjects({ scene: { name: 'x' }, type: 'Minmatar Titan Wreck', position: [0, 0, 500000] })) as Record<string, any>;
    const wreck = (result['scene'] as SceneDocument).objects?.[0];
    expect(wreck?.dna).toBe(TITAN_WRECK_DNA);
    expect(wreck).not.toHaveProperty('radius');
    expect(result['types'][0]).toMatchObject({ radius: null, radiusFrom: 'none' });
    const warnings = result['warnings'].join('\n');
    expect(warnings).toMatch(/placeholder radius and its model's \(SOF hull "mt1_t1_wreck"\) could not be read \(tools-core answered 501 for the SOF hull "mt1_t1_wreck" \(SOF service is not configured\)\)/u);
    expect(warnings).toMatch(/no radius; the page uses the SOF bounding radius once built/u);
  });

  it('takes a numeric type with its name, a top-level line, and returns a passed scene unloaded', async () => {
    const result = (await MakeTools().AddObjects({ scene: { name: 'x' }, type: 16737, position: [0, 0, 50000] })) as Record<string, any>;
    expect(result['loaded']).toBe(false);
    expect(result['scene'].objects).toEqual([{ id: 'ruined-stargate-01', dna: RUINED_GATE_DNA, type: 16737, name: 'Ruined Stargate 1', position: [0, 0, 50000], rotation: [0, 0, 0], radius: 5991 }]);
  });

  it('places off a celestial of the location and faces one', async () => {
    const result = (await MakeTools().AddObjects({ scene: located, type: 'Ruined Stargate', id: 'ruin', near: { celestial: CNAP, range: 20000 }, facing: { celestial: CNAP } })) as Record<string, any>;
    const ruin = result['scene'].objects[0];
    const cnap = located.location?.anchor?.offset ?? [0, 0, 0];
    const centre = [-cnap[0], -cnap[1], -cnap[2]];
    expect(Math.hypot(ruin.position[0] - centre[0], ruin.position[1] - centre[1], ruin.position[2] - centre[2])).toBeCloseTo(100000 + 20000 + 5991, -1);
    expect(await Refused(MakeTools().AddObjects({ scene: { name: 'x' }, type: 'Ruined Stargate', near: { celestial: CNAP } }))).toMatch(/set_location first/u);
  });

  it('refuses a type with no graphic, naming its line, and adds nothing', async () => {
    const page = new FakePage(TFI_SCENE);
    const message = await Refused(MakeTools(page).AddObjects({ objects: [{ type: 'Astrahus' }, { type: 'Tritanium' }] }));
    expect(message).toBe('objects[1] ("Tritanium"): type 34 "Tritanium" (Mineral) has no graphic, so it cannot be placed; search_objects lists types that can');
    expect(page.calls.some((call) => call.name === 'patch_scene')).toBe(false);
    expect(await Refused(MakeTools().AddObjects({ scene: { name: 'x' }, objects: [{ type: 'Astrahus', position: [0, 0, 2e7] }] }))).toMatch(/20,000 km from the scene origin/u);
    expect(await Refused(MakeTools().AddObjects({ scene: { name: 'x' }, objects: [] }))).toMatch(/non-empty array/u);
  });

  it('answers search_objects and needs a query', async () => {
    const tools = MakeTools();
    const answer = (await tools.Call('search_objects', { query: 'Astrahus', limit: 1 })) as Record<string, any>;
    expect(answer['items'].map((item: { name: string }) => item.name)).toEqual(['Astrahus']);
    expect(await Refused(tools.SearchObjects({}))).toMatch(/query is required/u);
    expect(tools.Call('get_state', {})).toBeNull();
    expect(findTool('add_objects')?.where).toBe('hub');
    expect(findTool('search_objects')?.where).toBe('hub');
  });
});
