import { describe, expect, it } from 'vitest';
import { ALL_LOCATION_DRESSING_PARTS, DEFAULT_LENS_FLARE, DEFAULT_SUN_TEMPLATE, MAX_DRESSED_OBJECTS, PLANET_PASS_FAR_DISTANCE, PLANET_PASS_KNEE_DISTANCE, toLocationDressingPlan, toPlanetPassDistance, toSunDressingNames } from './dressing';
import { JITA_CELESTIALS, PERIMETER_2500_ORIGIN, jitaAnswer, syntheticStations } from './dressing.spec-helper';
import { CNAP_30KM_ORIGIN, MOON, expectVectorClose, vectorLength } from './location.spec-helper';
import type { SceneVector } from '../scene';

describe('toPlanetPassDistance()', () => {
  it('keeps the true distance up to the knee', () => {
    expect(toPlanetPassDistance(1e9)).toBe(1e9);
    expect(toPlanetPassDistance(PLANET_PASS_KNEE_DISTANCE)).toBe(PLANET_PASS_KNEE_DISTANCE);
  });

  it('is continuous with slope 1 at the knee', () => {
    const knee = PLANET_PASS_KNEE_DISTANCE;
    expect(Math.abs(toPlanetPassDistance(knee + 1) - toPlanetPassDistance(knee) - 1)).toBeLessThan(1e-6);
  });

  it('increases strictly, never above the true distance, and stays inside the far plane', () => {
    let previous = 0;
    for (let exponent = 3; exponent <= 15.3; exponent += 0.05) {
      const distance = 10 ** exponent;
      const drawn = toPlanetPassDistance(distance);
      expect(drawn).toBeGreaterThan(previous);
      expect(drawn).toBeLessThanOrEqual(distance);
      previous = drawn;
    }
    expect(toPlanetPassDistance(2e15)).toBeLessThan(0.75 * PLANET_PASS_FAR_DISTANCE);
  });

  it('matches the worked numbers', () => {
    const expected: [number, number][] = [
      [1e10, 8.4657e9],
      [1e11, 1.9979e10],
      [4.499e11, 2.7498e10],
      [1e12, 3.1492e10],
      [6e12, 4.045e10],
      [1e14, 5.4517e10],
      [2e15, 6.9496e10]
    ];
    for (const [distance, drawn] of expected) expect(Math.abs(toPlanetPassDistance(distance) - drawn) / drawn).toBeLessThan(1e-4);
  });
});

describe('toSunDressingNames()', () => {
  it('names the template and flare after the sun graphic', () => {
    expect(toSunDressingNames('res:/dx9/model/celestial/sun/sun_blue_sun_01a.black')).toEqual({ graphic: 'sun_blue_sun_01a', templates: ['env_sun_blue_sun_01a', DEFAULT_SUN_TEMPLATE], flares: ['blue_sun', DEFAULT_LENS_FLARE] });
  });

  it('tries the _01a variant before the default, without duplicates', () => {
    expect(toSunDressingNames('res:/dx9/model/celestial/sun/sun_yellow_01b.black')).toEqual({ graphic: 'sun_yellow_01b', templates: ['env_sun_yellow_01b', 'env_sun_yellow_01a'], flares: ['yellow'] });
    expect(toSunDressingNames('res:/dx9/model/celestial/sun/sun_blue_small_02a.black').templates).toEqual(['env_sun_blue_small_02a', 'env_sun_blue_small_01a', DEFAULT_SUN_TEMPLATE]);
    expect(toSunDressingNames('res:/dx9/model/celestial/sun/sun_orange_radiating_01c.black').flares).toEqual(['orange_radiating', DEFAULT_LENS_FLARE]);
  });

  it('maps the Triglavian suns to their flares', () => {
    const blue = toSunDressingNames('res:/dx9/model/celestial/sun/sun_blue_kspace_triglavian_01a.black');
    expect(blue.flares).toEqual(['sun_kspace_triglavian_01a_fromblue', DEFAULT_LENS_FLARE]);
    expect(blue.templates).toEqual(['env_sun_blue_kspace_triglavian_01a', DEFAULT_SUN_TEMPLATE]);
    expect(toSunDressingNames('res:/dx9/model/celestial/sun/sun_yellow_kspace_triglavian_01b.black').flares).toEqual(['sun_kspace_triglavian_01b_fromyellow', DEFAULT_LENS_FLARE]);
  });

  it('falls back to the defaults for anything that is not a sun graphic', () => {
    const defaults = { graphic: null, templates: [DEFAULT_SUN_TEMPLATE], flares: [DEFAULT_LENS_FLARE] };
    expect(toSunDressingNames(null)).toEqual(defaults);
    expect(toSunDressingNames('res:/foo/bar.black')).toEqual(defaults);
    expect(toSunDressingNames('RES:/DX9/MODEL/CELESTIAL/SUN/SUN_BLUE_SUN_01A.BLACK').graphic).toBe('sun_blue_sun_01a');
  });
});

describe('toLocationDressingPlan()', () => {
  describe('30 km off the CNAP', () => {
    const plan = toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN) });

    it('dresses The Forge nebula and the star at a pulled-in distance with its angular size', () => {
      expect(plan.nebula).toBe('res:/dx9/scene/universe/c02_cube.black');
      const sun = plan.sun;
      expect(sun?.id).toBe(40009076);
      expect(sun?.disc).toBe(true);
      expect(sun?.templates[0]).toBe('env_sun_blue_sun_01a');
      expect(sun?.flares[0]).toBe('blue_sun');
      expect(Math.abs((sun?.distance ?? 0) - 4.498755e11)).toBeLessThan(1e5);
      const drawnDistance = vectorLength(sun?.drawnPosition ?? [0, 0, 0]);
      expect(Math.abs(drawnDistance - toPlanetPassDistance(sun?.distance ?? 0))).toBeLessThan(1);
      expectVectorClose(
        (sun?.drawnPosition ?? []).map((component) => component / drawnDistance),
        (sun?.position ?? []).map((component) => component / (sun?.distance ?? 1)),
        1e-9
      );
      expect(Math.abs((sun?.drawnRadius ?? 0) / drawnDistance - (sun?.radius ?? 0) / (sun?.distance ?? 1))).toBeLessThan(1e-12);
      expect(sun?.scale).toBe(2 * (sun?.drawnRadius ?? 0));
      expectVectorClose(
        (sun?.position ?? []).map((component) => component / (sun?.distance ?? 1)),
        [0.2385, 0.0417, -0.9702],
        1e-4
      );
    });

    it('draws the moon, the gas giant and Moon 6 biggest first, at their true distances', () => {
      expect(plan.bodies.map((body) => body.id)).toEqual([40009087, 40009082, 40009089]);
      for (const body of plan.bodies) {
        expect(body.scaled).toBe(false);
        expect(body.template).toBe(JITA_CELESTIALS.find((celestial) => celestial.id === body.id)?.graphics.shaderPreset);
        expect(body.drawnRadius).toBe(body.radius);
      }
      expect(plan.bodies[0].heightMap).toBe('res:/dx9/model/worldobject/planet/moon/moon01_h.dds');
      expect(plan.skipped.moon.tooSmall).toBe(1);
      expect(plan.skipped.planet.tooSmall).toBe(1);
    });

    it('builds the CNAP and the Bureau Offices, unrotated, and nothing smaller', () => {
      expect(plan.objects.map((object) => object.id)).toEqual([60003760, 60003466]);
      for (const object of plan.objects) expect(object.rotation).toEqual([0, 0, 0, 1]);
      expect(plan.objects[0].dna).toBe('jita:caldarinavy:caldari');
      expect(plan.skipped.stargate.tooSmall).toBe(4);
      expect(plan.skipped.station.tooSmall).toBe(2);
      expect(Math.abs(plan.reach - (1143412 + 2 * 45734))).toBeLessThan(2);
    });
  });

  describe('2.5 km off the Perimeter gate', () => {
    const plan = toLocationDressingPlan({ answer: jitaAnswer(PERIMETER_2500_ORIGIN) });

    it('builds the gates turned by their quaternions and the Quafe station', () => {
      expect(plan.objects.map((object) => object.id)).toEqual([50001249, 60015262, 50013921, 50001250]);
      expect(plan.skipped.stargate.tooSmall).toBe(1);
      for (const object of plan.objects.filter((candidate) => candidate.kind === 'stargate')) {
        expect(object.rotation).toEqual(JITA_CELESTIALS.find((celestial) => celestial.id === object.id)?.rotation);
      }
      expectVectorClose(rotateZ(plan.objects[0].rotation), [-0.7139, 0.2096, -0.6682], 1e-4);
    });

    it('draws Jita VIII and pulls the far star in', () => {
      expect(plan.bodies.map((body) => body.id)).toEqual([40009123]);
      expect(Math.abs(vectorLength(plan.sun?.drawnPosition ?? [0, 0, 0]) - 4.021e10) / 4.021e10).toBeLessThan(1e-3);
      expect(plan.sun?.drawnRadius).toBeLessThan(plan.sun?.radius ?? 0);
    });
  });

  it('switches every part off, counting what it leaves out', () => {
    const plan = toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN), parts: { nebula: false, sun: false, planets: false, objects: false } });
    expect(plan.nebula).toBeNull();
    expect(plan.sun).toBeNull();
    expect(plan.bodies).toEqual([]);
    expect(plan.objects).toEqual([]);
    expect(plan.reach).toBe(0);
    for (const kind of ['planet', 'moon', 'station', 'stargate'] as const) {
      expect(plan.skipped[kind].disabled).toBe(JITA_CELESTIALS.filter((celestial) => celestial.kind === kind).length);
    }
  });

  it('leaves the objects alone when only the planets are off', () => {
    const all = toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN) });
    const plan = toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN), parts: { ...ALL_LOCATION_DRESSING_PARTS, planets: false } });
    expect(plan.bodies).toEqual([]);
    expect(plan.objects).toEqual(all.objects);
    expect(plan.sun).toEqual(all.sun);
  });

  it('keeps the biggest objects up to the cap', () => {
    const origin: SceneVector = [0, 0, 1e12];
    const plan = toLocationDressingPlan({ answer: jitaAnswer(origin, syntheticStations(origin, 20)) });
    expect(plan.objects).toHaveLength(MAX_DRESSED_OBJECTS);
    expect(plan.objects.map((object) => object.id)).toEqual([61000019, 61000018, 61000017, 61000016, 61000015, 61000014, 61000013, 61000012]);
    expect(plan.skipped.station.overCap).toBe(12);
  });

  it('skips a body the origin is inside and a station without SOF DNA', () => {
    const inside: SceneVector = [MOON.position[0] + 1e6, MOON.position[1], MOON.position[2]];
    const stripped = JITA_CELESTIALS.map((celestial) => (celestial.id === 60003760 ? { ...celestial, graphics: {} } : celestial));
    const plan = toLocationDressingPlan({ answer: jitaAnswer(inside, stripped) });
    expect(plan.skipped.moon.inside).toBe(1);
    expect(plan.bodies.map((body) => body.id)).not.toContain(MOON.id);
    expect(plan.skipped.station.noGraphic).toBe(1);
  });

  it('keys the plan by system, origin and parts', () => {
    const a = toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN) });
    expect(toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN) }).key).toBe(a.key);
    expect(toLocationDressingPlan({ answer: jitaAnswer(PERIMETER_2500_ORIGIN) }).key).not.toBe(a.key);
    expect(toLocationDressingPlan({ answer: jitaAnswer(CNAP_30KM_ORIGIN), parts: { ...ALL_LOCATION_DRESSING_PARTS, sun: false } }).key).not.toBe(a.key);
  });
});

/**
 * Rotates +Z by an xyzw quaternion.
 */
function rotateZ(q: readonly number[]): number[] {
  const [x, y, z, w] = q;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
