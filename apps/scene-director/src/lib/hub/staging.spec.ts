import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySceneOperations, defaultLocationRange, MAX_TIMELINE_SECONDS, sceneAtTimelineTime, findTool, layoutFleetFormation, type MapCelestial, normalizeScene, type SceneDocument, SceneError, type SceneFleet, type SceneVector, tangentHeading, toLocationPlacement } from '@scene-director/scene';
import { beforeAll, describe, expect, it } from 'vitest';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetPersonalityFileStore } from '../store/personality-files';
import { FleetCompositions } from './fleet-compositions';
import { FleetPersonalities } from './fleet-personalities';
import { Locations } from './locations';
import { MakeFakeMapData } from './map-data.testing';
import type { SavedScenesPage } from './saved-scenes';
import { FakeAddCue, FakeGetScene } from './scene-page.testing';
import { WARP_IN_DOCUMENT_WARNING } from './scene-places';
import { MakeFakeShipData, SDE, SHIP_ROUTES, TFI_DNA } from './ship-data.testing';
import { DefaultSquadRole, Staging } from './staging';
import { ToolError, type ToolArgs } from './tool-call';

const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
const GUARDIAN_DNA = 'ac3_t2:carthum:amarr';
const ROUTES = { ...SHIP_ROUTES, [`/eve/${SDE}/dna/resolve?name=Tempest%20Fleet%20Issue`]: { json: { typeID: '17732', graphicID: '11777', skinID: null, dna: TFI_DNA } } };

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
      const { scene, warnings, arrivals } = applySceneOperations(this.scene, args['operations']);
      this.scene = scene;
      result = { scene, warnings, ships: [], changes: {}, ...(arrivals ? { arrivals: arrivals.map((arrival) => ({ group: arrival.group, landing: arrival.landing, state: 'waiting' })) } : {}) };
    }
    return result;
  }
}

const FLEET_SCENE = {
  name: 'fleet',
  ships: [
    { id: 'fc', dna: TFI_DNA, type: 'Tempest Fleet Issue' },
    ...['tfi-1', 'tfi-2', 'tfi-3'].map((id, index) => ({ id, dna: TFI_DNA, type: 'Tempest Fleet Issue', position: [1500 * (index + 1), 0, 0] })),
    ...['guardian-1', 'guardian-2'].map((id, index) => ({ id, dna: GUARDIAN_DNA, type: 'Guardian', position: [30000 + 1000 * index, 0, 0] }))
  ],
  fleets: [
    {
      id: 'tfi',
      commander: 'fc',
      wings: [
        {
          id: 'wing-1',
          squads: [
            { id: 'dps', role: 'dps', members: ['tfi-1', 'tfi-2', 'tfi-3'] },
            { id: 'logi', role: 'logi', members: ['guardian-1', 'guardian-2'], anchor: { ship: 'guardian-1', range: 30000 } }
          ]
        }
      ]
    }
  ]
};

let compositions: FleetCompositions;
let personalities: FleetPersonalities;
let located: SceneDocument;
let cnap: MapCelestial;

function MakeStaging(page: SavedScenesPage = NO_PAGE): { readonly staging: Staging; readonly calls: string[] } {
  const { shipData, calls } = MakeFakeShipData(ROUTES);
  const { mapData } = MakeFakeMapData();
  return { staging: new Staging({ shipData, mapData, compositions, personalities, page }), calls };
}

async function Refused(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(Error);
  return error instanceof SceneError ? error.problems.join('\n') : String((error as Error).message);
}

beforeAll(async () => {
  const { shipData } = MakeFakeShipData(ROUTES);
  const { mapData } = MakeFakeMapData();
  personalities = new FleetPersonalities({ files: new FleetPersonalityFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-staging-personalities-'))), shipData, mapData, page: NO_PAGE });
  compositions = new FleetCompositions({ files: new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-staging-'))), shipData, mapData, personalities, page: NO_PAGE });
  const set = (await new Locations({ mapData, page: NO_PAGE }).SetLocation({ scene: { name: 'loc' }, celestial: CNAP, range: 30000 })) as { readonly scene: SceneDocument };
  located = set.scene;
  cnap = (await mapData.SystemCelestials(30000142)).find((celestial) => celestial.name === CNAP) as MapCelestial;
});

describe('add_ships', () => {
  it('resolves a hull name and adds numbered ships to a passed scene', async () => {
    const result = (await MakeStaging().staging.AddShips({ scene: { name: 'x' }, hull: 'Tempest Fleet Issue', count: 3 })) as Record<string, any>;
    expect(result['added'].ships).toEqual(['tempest-fleet-issue-01', 'tempest-fleet-issue-02', 'tempest-fleet-issue-03']);
    expect(result['hull']).toMatchObject({ typeID: 17732, group: 'Battleship', dna: TFI_DNA, radius: 250, dnaFrom: 'sde', radiusFrom: 'sde' });
    expect(result['loaded']).toBe(false);
    const ships = (result['scene'] as SceneDocument).ships;
    expect(ships[0]).toMatchObject({ type: 'Tempest Fleet Issue', name: 'Tempest Fleet Issue 1' });
    expect(Math.hypot(...(ships[1].position.map((value, axis) => value - ships[0].position[axis]) as SceneVector))).toBeGreaterThanOrEqual(848);
    expect(result['template']).toMatchObject({ schema: 'cjs-fleet/1', id: 'tempest-fleet-issue', commander: { hull: 'Tempest Fleet Issue', dna: TFI_DNA, radius: 250 } });
  });

  it("takes the hull from a fit's header, keeps the fit once and returns it in the template", async () => {
    const fit = '[Tempest Fleet Issue, Brawler]\nDamage Control II\n\n500MN Microwarpdrive II';
    const result = (await MakeStaging().staging.AddShips({ scene: { name: 'x' }, fit, count: 2 })) as Record<string, any>;
    const scene = result['scene'] as SceneDocument;
    expect(scene.ships.map((ship) => [ship.type, ship.fit])).toEqual([
      ['Tempest Fleet Issue', 'tempest-fleet-issue/brawler'],
      ['Tempest Fleet Issue', 'tempest-fleet-issue/brawler']
    ]);
    expect(scene.fits).toEqual({ 'tempest-fleet-issue/brawler': fit });
    expect(result['template']).toMatchObject({ commander: { hull: 'Tempest Fleet Issue', fit: 'brawler' }, fits: { brawler: fit } });
  });

  it('looks nothing up with dna and radius', async () => {
    const { staging, calls } = MakeStaging();
    const result = (await staging.AddShips({ scene: { name: 'x' }, dna: TFI_DNA, radius: 250, count: 2 })) as Record<string, any>;
    expect(result['added'].ships).toEqual(['mb2_t1-01', 'mb2_t1-02']);
    expect(calls).toEqual([]);
  });

  it('refuses an unknown hull without dna', async () => {
    const message = await Refused(MakeStaging().staging.AddShips({ scene: { name: 'x' }, hull: 'Nonexistent Hull' }));
    expect(message).toMatch(/hull "Nonexistent Hull" has no dna and could not be resolved through tools-core/u);
  });

  it('places the lead off a celestial of the location and faces one', async () => {
    const { staging } = MakeStaging();
    const result = (await staging.AddShips({ scene: located, hull: 'Guardian', near: { celestial: CNAP, range: 20000 }, facing: { celestial: CNAP } })) as Record<string, any>;
    const origin = located.location?.origin as SceneVector;
    const expected = toLocationPlacement({ kind: cnap.kind, position: cnap.position, radius: cnap.radius, range: 20000 + 80 }).origin as SceneVector;
    const lead = result['added'].lead;
    for (const axis of [0, 1, 2]) expect(Math.abs(lead.position[axis] - (expected[axis] - origin[axis]))).toBeLessThanOrEqual(1);
    const station = cnap.position.map((value, axis) => value - origin[axis]) as SceneVector;
    const yaw = (Math.atan2(station[0] - lead.position[0], station[2] - lead.position[2]) * 180) / Math.PI;
    expect(Math.abs(lead.heading - yaw)).toBeLessThan(0.01);
    expect(defaultLocationRange({ kind: cnap.kind, radius: cnap.radius })).toBe(5000);
  });

  it('refuses a celestial without a location, and ship-relative directions off a celestial', async () => {
    const { staging } = MakeStaging();
    expect(await Refused(staging.AddShips({ scene: { name: 'x' }, hull: 'Guardian', near: { celestial: CNAP } }))).toMatch(/set_location first, or give position/u);
    expect(await Refused(staging.AddShips({ scene: located, hull: 'Guardian', near: { celestial: CNAP, direction: 'ahead' } }))).toMatch(/follows a ship's heading/u);
  });

  it('joins a live squad at its formation slots with every fleet ship radius', async () => {
    const page = new FakePage(FLEET_SCENE);
    const result = (await MakeStaging(page).staging.AddShips({ hull: 'Tempest Fleet Issue', count: 2, fleet: { id: 'tfi', squad: 'dps' } })) as Record<string, any>;
    const patches = page.calls.filter((call) => call.name === 'patch_scene');
    expect(patches).toHaveLength(1);
    const operation = (patches[0].args['operations'] as Record<string, unknown>[])[0];
    expect(operation['radii']).toEqual({ fc: 250, 'tfi-1': 250, 'tfi-2': 250, 'tfi-3': 250, 'guardian-1': 80, 'guardian-2': 80 });
    expect(result['added'].fleet).toEqual({ id: 'tfi', squad: 'dps', commander: 'fc', created: null });
    const fleet = page.scene.fleets?.[0] as SceneFleet;
    const radii = new Map(page.scene.ships.map((ship) => [ship.id, ship.dna === GUARDIAN_DNA ? 80 : 250]));
    const slots = layoutFleetFormation({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: (id) => radii.get(id) ?? 500 });
    for (const id of result['added'].ships as string[]) expect(page.scene.ships.find((ship) => ship.id === id)?.position).toEqual(slots.get(id));
  });

  it('infers a new squad role from the EVE group', async () => {
    const page = new FakePage(FLEET_SCENE);
    const result = (await MakeStaging(page).staging.AddShips({ hull: 'Guardian', count: 2, fleet: { id: 'tfi', squad: {} } })) as Record<string, any>;
    expect(result['hull'].role).toBe('logi');
    const squad = page.scene.fleets?.[0].wings[0].squads[2];
    expect(squad).toMatchObject({ id: 'logi-2', role: 'logi', anchor: { ship: 'tfi-logi-2-01' } });
    expect(result['added'].fleet).toMatchObject({ squad: 'logi-2', created: 'squad' });
  });

  it('needs a tab or a scene', async () => {
    expect(await Refused(MakeStaging().staging.AddShips({ dna: TFI_DNA }))).toMatch(/Or pass "scene"/u);
  });

  it('warps in from a celestial (the heading from it), and warns that a document places them at their landing', async () => {
    const result = (await MakeStaging().staging.AddShips({ scene: located, hull: 'Guardian', count: 3, near: { celestial: CNAP, range: 20000 }, warpIn: { from: { celestial: CNAP }, stagger: 2 } })) as Record<string, any>;
    const origin = located.location?.origin as SceneVector;
    const station = cnap.position.map((value, axis) => Math.round(value - origin[axis])) as SceneVector;
    const lead = result['added'].lead;
    const yaw = (Math.atan2(lead.position[0] - station[0], lead.position[2] - station[2]) * 180) / Math.PI;
    expect(Math.abs(lead.heading - yaw)).toBeLessThan(0.01);
    expect(result['warnings']).toContain(WARP_IN_DOCUMENT_WARNING);
    expect(result['arrivals']).toBeUndefined();
  });

  it("does not add a near ship's heading under warpIn.from, and passes joins' warpIn and the page's arrivals through", async () => {
    const page = new FakePage(FLEET_SCENE);
    const { staging } = MakeStaging(page);
    await staging.AddShips({ hull: 'Tempest Fleet Issue', near: { ship: 'tfi-1' }, warpIn: { from: [0, 0, -100000] } });
    const free = (page.calls.at(-1)?.args['operations'] as Record<string, unknown>[])[0];
    expect(free['heading']).toBeUndefined();
    expect(free['warpIn']).toEqual({ from: [0, 0, -100000] });

    const joined = (await staging.AddShips({ hull: 'Tempest Fleet Issue', count: 2, fleet: { id: 'tfi', squad: 'dps' }, warpIn: { stagger: 3 } })) as Record<string, any>;
    const join = (page.calls.at(-1)?.args['operations'] as Record<string, unknown>[])[0];
    expect(join['warpIn']).toEqual({ stagger: 3 });
    expect(joined['arrivals']).toEqual([{ group: 'tfi/dps', landing: 'formation', state: 'waiting' }]);
    expect(joined['warnings']).not.toContain(WARP_IN_DOCUMENT_WARNING);
    expect(await Refused(staging.AddShips({ hull: 'Tempest Fleet Issue', fleet: { id: 'tfi', squad: 'dps' }, warpIn: { from: { celestial: CNAP } } }))).toMatch(/warpIn\.from/u);
  });
});

describe('at: a timeline cue', () => {
  it('add_ships becomes one patch_scene cue with the resolved op and its adds; a later cue builds near a ship it adds', async () => {
    const page = new FakePage(FLEET_SCENE);
    const { staging } = MakeStaging(page);
    const result = (await staging.AddShips({ hull: 'Guardian', count: 2, fleet: { new: true, id: 'red' }, team: 'red', position: [0, 0, 20000], warpIn: true, at: 5 })) as Record<string, any>;
    expect(page.calls.find((call) => call.name === 'get_scene')?.args).toEqual({ at: 5 });
    expect(page.scene.ships).toHaveLength(6);
    const cue = page.scene.timeline?.cues[0] as Record<string, any>;
    expect(result['cue']).toEqual(cue);
    expect(cue).toMatchObject({ id: 'cue-1', at: 5, name: 'add_ships 2 Guardian', adds: { fleets: ['red'] } });
    expect(cue['adds'].ships).toHaveLength(2);
    expect(cue['patch_scene'].operations).toEqual([{ op: 'add_ships', hull: 'Guardian', dna: GUARDIAN_DNA, radius: 80, count: 2, team: 'red', position: [0, 0, 20000], warpIn: true, fleet: { new: true, id: 'red', squad: { role: 'logi' } } }]);
    expect(result['added']).toBeUndefined();
    expect(result['template']).toBeDefined();

    const fc = sceneAtTimelineTime(page.scene, 5, applySceneOperations).fleets?.find((fleet) => fleet.id === 'red')?.commander as string;
    expect(await Refused(staging.AddShips({ hull: 'Tempest Fleet Issue', near: { ship: fc }, at: 4 }))).toMatch(new RegExp(`near.ship: no ship "${fc}"`, 'u'));
    const later = (await staging.AddShips({ hull: 'Tempest Fleet Issue', near: { ship: fc, range: 5000 }, at: 8, cue: 'escort' })) as Record<string, any>;
    expect(later['cue']).toMatchObject({ id: 'escort', at: 8 });
    expect(later['cue'].patch_scene.operations[0].position[2]).toBeGreaterThan(20000);
    expect(page.scene.timeline?.cues.map((candidate) => candidate.id)).toEqual(['cue-1', 'escort']);
  });

  it('a when cue with no at resolves on the scene at the end of the timeline, and arms once what it names exists', async () => {
    const page = new FakePage(FLEET_SCENE);
    const { staging } = MakeStaging(page);
    await staging.AddShips({ hull: 'Guardian', count: 2, fleet: { new: true, id: 'red' }, team: 'red', position: [0, 0, 20000], warpIn: true, at: 5 });
    const fc = sceneAtTimelineTime(page.scene, 5, applySceneOperations).fleets?.find((fleet) => fleet.id === 'red')?.commander as string;
    page.calls.length = 0;
    const result = (await staging.AddShips({ hull: 'Tempest Fleet Issue', near: { ship: fc, range: 5000 }, when: { arrival: { fleet: 'red' }, after: 2 }, cue: 'escort' })) as Record<string, any>;
    expect(page.calls.find((call) => call.name === 'get_scene')?.args).toEqual({ at: MAX_TIMELINE_SECONDS });
    expect(result['cue']).toMatchObject({ id: 'escort', when: { arrival: { fleet: 'red' }, after: 2 }, arms: 5 });
    expect(result['cue'].at).toBeUndefined();
    expect(result['cue'].patch_scene.operations[0].position[2]).toBeGreaterThan(20000);
    expect(await Refused(staging.AddShips({ hull: 'Tempest Fleet Issue', near: { ship: fc }, when: { kill: {} }, at: 4 }))).toMatch(new RegExp(`near.ship: no ship "${fc}"`, 'u'));
    expect(await Refused(staging.AddShips({ hull: 'Tempest Fleet Issue', when: 'later' }))).toMatch(/when must be an event/u);
  });

  it('stage_engagement cues on a passed scene, refused when the op fails on the scene as it will be then', async () => {
    const result = (await MakeStaging().staging.StageEngagement({
      scene: FLEET_SCENE,
      sides: [
        { ships: [{ hull: 'Rifter', count: 2 }], team: 'red' },
        { ships: [{ hull: 'Rifter', count: 2 }], team: 'blue' }
      ],
      center: [0, 0, 80000],
      at: 30,
      cue: 'brawl'
    })) as Record<string, any>;
    expect(result['loaded']).toBe(false);
    expect(result['scene'].ships).toHaveLength(6);
    expect(result['cue']).toMatchObject({ id: 'brawl', at: 30, name: 'stage_engagement red vs blue' });
    expect([...result['cue'].adds.fleets].sort()).toEqual(['blue', 'red']);
    expect(result['cue'].patch_scene.operations[0].sides[0].ships[0]).toMatchObject({ hull: 'Rifter', dna: 'mf4_t1:minmatarbase:minmatar', radius: 31 });
    expect(result['engagement']).toMatchObject({ center: [0, 0, 80000], teams: ['red', 'blue'] });
    expect(await Refused(MakeStaging().staging.StageEngagement({ scene: FLEET_SCENE, sides: [{ ships: [{ hull: 'Rifter' }], fleet: 'tfi' }, { ships: [{ hull: 'Rifter' }] }], at: 30 }))).toMatch(/tfi/u);
  });
});

describe('stage_engagement', () => {
  it('stages a built-in composition against a resolved ship list', async () => {
    const result = (await MakeStaging().staging.StageEngagement({
      scene: { name: 'x' },
      sides: [
        { composition: 'tfis' },
        {
          ships: [
            { hull: 'Guardian', count: 2 },
            { hull: 'Tempest Fleet Issue', count: 5 }
          ]
        }
      ]
    })) as Record<string, any>;
    const [blue, red] = result['engagement'].sides;
    expect(blue).toMatchObject({ team: 'blue', fleet: 'tfis', commander: 'tfis-fc' });
    expect(blue.ships).toHaveLength(44);
    expect(red).toMatchObject({ team: 'red', fleet: 'red', commander: 'red-fc' });
    expect(red.ships).toHaveLength(7);
    const scene = result['scene'] as SceneDocument;
    const redFleet = scene.fleets?.find((fleet) => fleet.id === 'red');
    expect(redFleet?.wings[0].squads.map((squad) => [squad.id, squad.role, squad.members.length])).toEqual([
      ['logi', 'logi', 1],
      ['dps', 'dps', 5]
    ]);
    expect(scene.ships.find((ship) => ship.id === 'red-fc')?.type).toBe('Guardian');
    const gap = red.lead.position[2] - blue.lead.position[2];
    expect(Math.abs(gap - (20000 + 250 + 80))).toBeLessThanOrEqual(2);
    expect(result['hulls'].length).toBeGreaterThan(2);
  });

  it("embeds each side's saved or inline personality in the same patch, and passes a built-in through", async () => {
    await personalities.Save({ personality: { schema: 'cjs-fleet-personality/1', id: 'staged-base', extends: 'kiter', pilots: { reaction: 0.9 } } });
    await personalities.Save({ personality: { schema: 'cjs-fleet-personality/1', id: 'staged-kiter', extends: 'staged-base', engage: 'on-sight' } });
    const result = (await MakeStaging().staging.StageEngagement({
      scene: { name: 'x' },
      sides: [
        { composition: 'tfis', personality: 'staged-kiter' },
        { ships: [{ hull: 'Guardian', count: 2, pilot: { reaction: 0.2 } }], personality: { schema: 'cjs-fleet-personality/1', id: 'inline-sniper', extends: 'sniper' } }
      ]
    })) as Record<string, any>;
    const [blue, red] = result['engagement'].sides;
    expect(blue.personality).toEqual({ name: 'staged-kiter', from: 'disk', chain: ['staged-kiter', 'kiter', 'line'], embedded: ['staged-kiter'] });
    expect(red.personality).toEqual({ name: 'inline-sniper', from: 'inline', chain: ['inline-sniper', 'sniper', 'line'], embedded: ['inline-sniper'] });
    const scene = result['scene'] as SceneDocument;
    // The saved chain is flattened: the scene's copy extends the built-in and carries its saved base's fields.
    expect(scene.personalities?.['staged-kiter']).toEqual({ schema: 'cjs-fleet-personality/1', id: 'staged-kiter', extends: 'kiter', engage: 'on-sight', pilots: { reaction: 0.9 } });
    expect(scene.fleets?.map((fleet) => [fleet.id, fleet.personality])).toEqual([
      ['tfis', 'staged-kiter'],
      ['red', 'inline-sniper']
    ]);
    expect(scene.ships.find((ship) => ship.id === 'red-fc')?.pilot).toEqual({ reaction: 0.2 });

    const builtIn = (await MakeStaging().staging.StageEngagement({
      scene: { name: 'x' },
      sides: [
        { composition: 'tfis', personality: 'Brawler' },
        { ships: [{ hull: 'Guardian' }], fleet: false }
      ]
    })) as Record<string, any>;
    expect(builtIn['engagement'].sides[0].personality).toEqual({ name: 'brawler', from: 'built-in', chain: ['brawler', 'line'] });
    expect((builtIn['scene'] as SceneDocument).personalities).toBeUndefined();
  });

  it("gives add_ships' new fleet a personality and every ship the pilot", async () => {
    const result = (await MakeStaging().staging.AddShips({ scene: { name: 'x' }, hull: 'Tempest Fleet Issue', count: 2, pilot: { command: 0.7 }, fleet: { new: true, id: 'pair', personality: { schema: 'cjs-fleet-personality/1', id: 'pair-style', extends: 'alpha' } } })) as Record<string, any>;
    expect(result['personality']).toEqual({ name: 'pair-style', from: 'inline', chain: ['pair-style', 'alpha', 'line'], embedded: ['pair-style'] });
    const scene = result['scene'] as SceneDocument;
    expect(scene.fleets?.[0]).toMatchObject({ id: 'pair', personality: 'pair-style' });
    expect(scene.ships.map((ship) => ship.pilot)).toEqual([{ command: 0.7 }, { command: 0.7 }]);
    expect(await Refused(MakeStaging().staging.AddShips({ scene: { name: 'x' }, hull: 'Tempest Fleet Issue', fleet: { new: true, personality: 'nobody' } }))).toMatch(/fleet\.personality: no fleet personality "nobody"/u);
  });

  it('centres off a celestial, tangent to it', async () => {
    const result = (await MakeStaging().staging.StageEngagement({ scene: located, near: { celestial: CNAP, range: 40000 }, sides: [{ ships: [{ hull: 'Guardian' }] }, { ships: [{ hull: 'Guardian' }] }] })) as Record<string, any>;
    const origin = located.location?.origin as SceneVector;
    const expected = toLocationPlacement({ kind: cnap.kind, position: cnap.position, radius: cnap.radius, range: 40000 }).origin as SceneVector;
    const center = result['engagement'].center as SceneVector;
    for (const axis of [0, 1, 2]) expect(Math.abs(center[axis] - (expected[axis] - origin[axis]))).toBeLessThanOrEqual(1);
    const station = cnap.position.map((value, axis) => Math.round(value - origin[axis])) as SceneVector;
    expect(result['engagement'].heading).toBeCloseTo(tangentHeading(station, center), 3);
  });

  it("passes each side's warpIn to the operation", async () => {
    const page = new FakePage({ name: 'tab' });
    const result = (await MakeStaging(page).staging.StageEngagement({ sides: [{ ships: [{ hull: 'Guardian', count: 2 }] }, { ships: [{ hull: 'Guardian' }], warpIn: { stagger: 5, together: false } }] })) as Record<string, any>;
    const operation = (page.calls.at(-1)?.args['operations'] as Record<string, any>[])[0];
    expect(operation['sides'][1].warpIn).toEqual({ stagger: 5, together: false });
    expect(operation['sides'][0].warpIn).toBeUndefined();
    expect(result['arrivals']).toEqual([{ group: 'red', landing: 'document', state: 'waiting' }]);
    const local = (await MakeStaging().staging.StageEngagement({ scene: { name: 'x' }, sides: [{ ships: [{ hull: 'Guardian' }], warpIn: true }, { ships: [{ hull: 'Guardian' }] }] })) as Record<string, any>;
    expect(local['warnings']).toContain(WARP_IN_DOCUMENT_WARNING);
  });

  it('surfaces the refusals', async () => {
    const { staging } = MakeStaging();
    const side = { ships: [{ hull: 'Guardian' }] };
    expect(await Refused(staging.StageEngagement({ scene: { name: 'x' }, sides: [side, { ...side, team: 'blue' }] }))).toMatch(/both sides are on team "blue"/u);
    expect(await Refused(staging.StageEngagement({ scene: { name: 'x' }, sides: [side, side, side] }))).toMatch(/must be two sides/u);
    expect(await Refused(staging.StageEngagement({ scene: { name: 'x' }, sides: [side, { composition: 'nope' }] }))).toMatch(/no fleet composition "nope"/u);
  });
});

describe('DefaultSquadRole', () => {
  it('maps EVE groups to roles, case-insensitively', () => {
    expect(DefaultSquadRole('Logistics')).toBe('logi');
    expect(DefaultSquadRole('force auxiliary')).toBe('logi');
    expect(DefaultSquadRole('Interdictor')).toBe('tackle');
    expect(DefaultSquadRole('Combat Recon Ship')).toBe('ewar');
    expect(DefaultSquadRole('Command Destroyer')).toBe('boost');
    expect(DefaultSquadRole('Supercarrier')).toBe('support');
    expect(DefaultSquadRole('Frigate')).toBe('dps');
    expect(DefaultSquadRole(null)).toBe('dps');
  });

  it('routes both tools to the hub', () => {
    expect(findTool('add_ships')?.where).toBe('hub');
    expect(findTool('stage_engagement')?.where).toBe('hub');
  });
});
