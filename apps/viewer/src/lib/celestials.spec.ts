import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_LOCATION_DRESSING_PARTS, toLocationDressingPlan, type LocationDressingPlan } from '@scene-director/scene';
import { DYNAMIC_RESOURCE_STANDIN, DressingReport, DressingSlot, DressingText, PatchDynamicResources, PatchHeightMap, PlanDressingChanges, ReadDressParts, type DressingEntryState } from './celestials';

const BLACK = 'res:/texture/global/black.dds';
const HEIGHT = 'res:/dx9/model/worldobject/planet/terrestrial/terrestrial04_h_hi.dds';

describe('PatchHeightMap()', () => {
  it("binds heightMap1 into the client's bake placeholder only", () => {
    const values = {
      _type: 'EvePlanet',
      effectChildren: [
        {
          _type: 'EveChildMesh',
          mesh: {
            opaqueAreas: [
              {
                effect: {
                  resources: [
                    { _type: 'TriTextureParameter', name: 'HeightMap', resourcePath: BLACK },
                    { _type: 'TriTextureParameter', name: 'CityLight', resourcePath: BLACK }
                  ]
                }
              }
            ]
          }
        }
      ]
    };
    expect(PatchHeightMap(values, HEIGHT)).toBe(1);
    const resources = values.effectChildren[0].mesh.opaqueAreas[0].effect.resources;
    expect(resources[0].resourcePath).toBe(HEIGHT);
    expect(resources[1].resourcePath).toBe(BLACK);
  });

  it("leaves a gas giant's own height map and a moon without one alone", () => {
    const gas = { resources: [{ _type: 'TriTextureParameter', name: 'HeightMap', resourcePath: 'res:/dx9/model/worldobject/planet/gasgiant/gasgiant_mixer_tex.dds' }] };
    expect(PatchHeightMap(gas, HEIGHT)).toBe(0);
    expect(gas.resources[0].resourcePath).toContain('gasgiant_mixer_tex');
    expect(PatchHeightMap({ resources: [{ _type: 'TriTextureParameter', name: 'DiffuseMap', resourcePath: BLACK }] }, HEIGHT)).toBe(0);
  });

  it('counts a shared parameter once and matches any case', () => {
    const shared = { _type: 'TriTextureParameter', name: 'HeightMap', resourcePath: 'RES:/Texture/Global/Black.dds' };
    expect(PatchHeightMap({ a: shared, b: [shared] }, HEIGHT)).toBe(1);
    expect(shared.resourcePath).toBe(HEIGHT);
  });
});

describe('PatchDynamicResources()', () => {
  it("stands in for a station's dynamic video screens and leaves other paths alone", () => {
    const screen = { _type: 'TriTextureParameter', name: 'VideoMap', resourcePath: 'dynamic:/inspacevideos/caldari_ad_01' };
    const values = { mesh: { areas: [{ effect: { resources: [screen, { _type: 'TriTextureParameter', name: 'DiffuseMap', resourcePath: 'res:/a.dds' }] } }] }, again: [screen] };
    expect(PatchDynamicResources(values)).toEqual(['inspacevideos']);
    expect(screen.resourcePath).toBe(DYNAMIC_RESOURCE_STANDIN);
    expect(values.mesh.areas[0].effect.resources[1].resourcePath).toBe('res:/a.dds');
    expect(PatchDynamicResources({ path: 'res:/b.dds' })).toEqual([]);
  });
});

describe('ReadDressParts()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dresses everything by default and with all, nothing with off or none', () => {
    const none = { nebula: false, sun: false, planets: false, objects: false };
    expect(ReadDressParts('')).toEqual(ALL_LOCATION_DRESSING_PARTS);
    expect(ReadDressParts('?dress=all')).toEqual(ALL_LOCATION_DRESSING_PARTS);
    expect(ReadDressParts('?dress=off')).toEqual(none);
    expect(ReadDressParts('?post=off&dress=none')).toEqual(none);
  });

  it('reads a list of parts and warns about unknown names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(ReadDressParts('?dress=nebula,sun')).toEqual({ nebula: true, sun: true, planets: false, objects: false });
    expect(warn).not.toHaveBeenCalled();
    expect(ReadDressParts('?dress=planets,bogus')).toEqual({ nebula: false, sun: false, planets: true, objects: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('PlanDressingChanges()', () => {
  it('keeps matching slots, rebuilds changed ones, builds new ones and retires gone ones', () => {
    const current = new Map([
      ['planet:1', 'a.black'],
      ['station:2', 'cs1:caldaribase:caldari'],
      ['moon:3', 'b.black'],
      ['stargate:4', 'csg:caldaribase:caldari']
    ]);
    const changes = PlanDressingChanges(current, [
      { slot: 'stargate:4', key: 'csg:caldaribase:caldari' },
      { slot: 'station:5', key: 'cs3:caldaribase:caldari' },
      { slot: 'planet:1', key: 'a.black' },
      { slot: 'moon:3', key: 'c.black' }
    ]);
    expect(changes).toEqual({ keep: ['stargate:4', 'planet:1'], build: ['station:5', 'moon:3'], retire: ['station:2', 'moon:3'] });
  });
});

describe('DressingReport()', () => {
  const plan: LocationDressingPlan = toLocationDressingPlan({
    answer: {
      system: {
        id: 1,
        name: 'Here',
        securityStatus: 1,
        securityClass: 'A',
        constellation: null,
        region: { id: 2, name: 'There' },
        nebula: 'res:/dx9/scene/universe/c02_cube.black',
        star: { id: 10, name: 'Here - Star', typeID: 1, radius: 5e8, spectralClass: null, temperature: null, luminosity: null, light: null, graphic: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black' }
      },
      origin: [0, 0, 0],
      sdeBuild: '1',
      celestials: [
        { id: 20, kind: 'moon', name: 'Here I - Moon 1', typeID: 1, radius: 1.6e6, radiusFrom: 'map', position: [3e6, 0, 0], distance: 3e6, orbit: null, graphics: { shaderPreset: 'moon.black' } },
        { id: 21, kind: 'planet', name: 'Here I', typeID: 1, radius: 1.9e7, radiusFrom: 'map', position: [1e10, 0, 0], distance: 1e10, orbit: null, graphics: { shaderPreset: 'gas.black' } },
        { id: 30, kind: 'station', name: 'Here I - Moon 1 - Plant', typeID: 1, radius: 1e5, radiusFrom: 'type', position: [0, 0, 1.3e5], distance: 1.3e5, orbit: null, graphics: { sofDna: 'cs1:caldaribase:caldari' } },
        { id: 31, kind: 'station', name: 'Tiny', typeID: 1, radius: 10, radiusFrom: 'type', position: [0, 0, 1e9], distance: 1e9, orbit: null, graphics: { sofDna: 'cs1:caldaribase:caldari' } },
        { id: 10, kind: 'star', name: 'Here - Star', typeID: 1, radius: 5e8, radiusFrom: 'map', position: [0, 4e11, 0], distance: 4e11, orbit: null, graphics: {} }
      ]
    }
  });
  const nebula = { path: 'res:/dx9/scene/universe/c02_cube.black', state: 'drawn' as const };
  const drawn = (overrides: Record<string, DressingEntryState> = {}): Map<string, DressingEntryState> =>
    new Map<string, DressingEntryState>([[DressingSlot('sun', 10), { state: 'drawn' }], [DressingSlot('moon', 20), { state: 'drawn' }], [DressingSlot('planet', 21), { state: 'drawn' }], [DressingSlot('station', 30), { state: 'drawn', sofRadius: 156561.4 }], ...Object.entries(overrides)]);

  it('counts each kind and lists the dressed things in plan order', () => {
    const report = DressingReport({ parts: ALL_LOCATION_DRESSING_PARTS, plan, entries: drawn(), nebula, sunDressing: { template: 'env_sun_blue_sun_01a', flare: 'blue_sun' } });
    expect(report.state).toBe('ready');
    expect(report.counts.moon).toEqual({ drawn: 1, validated: 0, loading: 0, failed: 0, skipped: 0 });
    expect(report.counts.station).toEqual({ drawn: 1, validated: 0, loading: 0, failed: 0, skipped: 1 });
    expect(report.objects.map((object) => object.id)).toEqual([20, 21, 30]);
    expect(report.objects[0]).toEqual({ id: 20, kind: 'moon', name: 'Here I - Moon 1', state: 'drawn', distance: 3000000, radius: 1600000, drawnRadius: 1600000 });
    expect(report.objects[1].scaled).toBe(true);
    expect(report.objects[2].sofRadius).toBe(156561);
    expect(report.sun).toMatchObject({ id: 10, template: 'env_sun_blue_sun_01a', flare: 'blue_sun', distance: 4e11, state: 'drawn' });
    expect(DressingText(report)).toBe('c02_cube · Here - Star · 1 planet, 1 moon · 1 station, 0 gates');
  });

  it('puts off before failed before loading before partial before ready', () => {
    const failedMoon = drawn({ [DressingSlot('moon', 20)]: { state: 'failed', error: 'no such file' } });
    const partial = DressingReport({ parts: ALL_LOCATION_DRESSING_PARTS, plan, entries: failedMoon, nebula });
    expect(partial.state).toBe('partial');
    expect(partial.objects[0].error).toBe('no such file');
    expect(partial.objects[1].error).toBeUndefined();
    expect(DressingText(partial)).toBe('c02_cube · Here - Star · 1 planet, 0 moons · 1 station, 0 gates · 1 failed');

    const loading = DressingReport({ parts: ALL_LOCATION_DRESSING_PARTS, plan, entries: drawn({ [DressingSlot('station', 30)]: { state: 'loading' }, [DressingSlot('moon', 20)]: { state: 'failed', error: 'x' } }), nebula });
    expect(loading.state).toBe('loading');
    expect(DressingText(loading)).toBe('loading (2 of 3)');
    expect(DressingReport({ parts: ALL_LOCATION_DRESSING_PARTS, plan: null, entries: new Map() }).state).toBe('loading');

    const failed = DressingReport({ parts: ALL_LOCATION_DRESSING_PARTS, plan: null, entries: new Map(), error: 'the hub did not answer' });
    expect(failed).toMatchObject({ state: 'failed', error: 'the hub did not answer', objects: [] });
    expect(DressingText(failed)).toBe('failed: the hub did not answer');

    const off = DressingReport({ parts: { nebula: false, sun: false, planets: false, objects: false }, plan, entries: drawn(), nebula, error: 'x' });
    expect(off.state).toBe('off');
    expect(off.objects).toEqual([]);
    expect(off.counts.station).toEqual({ drawn: 0, validated: 0, loading: 0, failed: 0, skipped: 0 });
    expect(DressingText(off)).toBe('off');
  });

  it('reports nothing without a report', () => {
    expect(DressingText(null)).toBeNull();
  });
});
