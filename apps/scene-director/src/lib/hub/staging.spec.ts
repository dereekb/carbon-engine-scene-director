import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySceneOperations, defaultLocationRange, findTool, layoutFleetFormation, type MapCelestial, normalizeScene, type SceneDocument, SceneError, type SceneFleet, type SceneVector, tangentHeading, toLocationPlacement } from '@scene-director/scene';
import { beforeAll, describe, expect, it } from 'vitest';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetCompositions } from './fleet-compositions';
import { Locations } from './locations';
import { MakeFakeMapData } from './map-data.testing';
import type { SavedScenesPage } from './saved-scenes';
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
    if (name === 'get_scene') result = this.scene;
    else if (name === 'patch_scene') {
      const { scene, warnings } = applySceneOperations(this.scene, args['operations']);
      this.scene = scene;
      result = { scene, warnings, ships: [], changes: {} };
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
let located: SceneDocument;
let cnap: MapCelestial;

function MakeStaging(page: SavedScenesPage = NO_PAGE): { readonly staging: Staging; readonly calls: string[] } {
  const { shipData, calls } = MakeFakeShipData(ROUTES);
  const { mapData } = MakeFakeMapData();
  return { staging: new Staging({ shipData, mapData, compositions, page }), calls };
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
  compositions = new FleetCompositions({ files: new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-staging-'))), shipData, page: NO_PAGE });
  const { mapData } = MakeFakeMapData();
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

  it('centres off a celestial, tangent to it', async () => {
    const result = (await MakeStaging().staging.StageEngagement({ scene: located, near: { celestial: CNAP, range: 40000 }, sides: [{ ships: [{ hull: 'Guardian' }] }, { ships: [{ hull: 'Guardian' }] }] })) as Record<string, any>;
    const origin = located.location?.origin as SceneVector;
    const expected = toLocationPlacement({ kind: cnap.kind, position: cnap.position, radius: cnap.radius, range: 40000 }).origin as SceneVector;
    const center = result['engagement'].center as SceneVector;
    for (const axis of [0, 1, 2]) expect(Math.abs(center[axis] - (expected[axis] - origin[axis]))).toBeLessThanOrEqual(1);
    const station = cnap.position.map((value, axis) => Math.round(value - origin[axis])) as SceneVector;
    expect(result['engagement'].heading).toBeCloseTo(tangentHeading(station, center), 3);
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
