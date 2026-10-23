import { describe, expect, it } from 'vitest';
import { expandAsteroidField, normalizeScene, type SceneAsteroidField } from '@scene-director/scene';
import { AsteroidFieldsText, AsteroidFieldStateRow, FIELD_INSTANCE_LAYOUT, FieldDrawPlan, FieldLodIndex, FieldLodMeshes, FieldReach, FieldRootValues, FieldSphere, PackInstance, RockTemplateOf, type RockTemplate } from './asteroid-fields';
import { ROCK_DNA, ROCK_VALUES } from './asteroid-fields.spec-helper';

const OTHER_DNA = 'rock_01_m_v2a_whiteyellow:ore_veldspar:asteroid';

function Field(input: object): SceneAsteroidField {
  const scene = normalizeScene({ asteroidFields: [{ id: 'belt', ores: [{ ore: 'Veldspar', rocks: [ROCK_DNA, OTHER_DNA] }], ...input }] }).scene;
  const field = scene.asteroidFields?.[0];
  if (!field) throw new Error('no field');
  return field;
}

function Templates(): Map<string, RockTemplate> {
  const template = RockTemplateOf(ROCK_VALUES);
  return new Map([
    [ROCK_DNA, template],
    [OTHER_DNA, template]
  ]);
}

type Values = Record<string, unknown>;

function Children(root: Values): Values[] {
  const [container] = root['effectChildren'] as Values[];
  return container['objects'] as Values[];
}

describe('asteroid fields: the instanced composer', () => {
  const field = Field({ count: 40, radius: 20000, size: [300, 1000] });
  const expansion = expandAsteroidField(field);

  it('pins the instance layout to SOF_INSTANCE_LAYOUT (EveSOF.js)', () => {
    expect(FIELD_INSTANCE_LAYOUT).toEqual([
      { usage: 'TEXCOORD', usageIndex: 0, type: 'FLOAT32_4', name: 'transform0' },
      { usage: 'TEXCOORD', usageIndex: 1, type: 'FLOAT32_4', name: 'transform1' },
      { usage: 'TEXCOORD', usageIndex: 2, type: 'FLOAT32_4', name: 'transform2' },
      { usage: 'TEXCOORD', usageIndex: 3, type: 'FLOAT32_4', name: 'lastTransform0' },
      { usage: 'TEXCOORD', usageIndex: 4, type: 'FLOAT32_4', name: 'lastTransform1' },
      { usage: 'TEXCOORD', usageIndex: 5, type: 'FLOAT32_4', name: 'lastTransform2' },
      { usage: 'TEXCOORD', usageIndex: 6, type: 'BYTE_4', name: 'boneIndex' }
    ]);
  });

  it('packs T · R · S as packInstanceMatrix does: the matrix rows, last copies, bone 0', () => {
    const half = Math.SQRT1_2;
    const row = PackInstance([1, 2, 3], [0, half, 0, half], 2);
    const expected = [
      [0, 0, 2, 1],
      [0, 2, 0, 2],
      [-2, 0, 0, 3]
    ];
    for (const [index, name] of (['transform0', 'transform1', 'transform2'] as const).entries()) {
      row[name].forEach((value, axis) => expect(value).toBeCloseTo(expected[index][axis], 12));
    }
    expect(row.lastTransform0).toEqual(row.transform0);
    expect(row.lastTransform0).not.toBe(row.transform0);
    expect(row.lastTransform2).toEqual(row.transform2);
    expect(row.boneIndex).toBe(0);
    expect(PackInstance([0, 0, 0], [0, 0, 0, 1], 3).transform1).toEqual([0, 3, 0, 0]);
  });

  it('groups the rocks per model, one group each without cells, with their box and largest rock', () => {
    const plan = FieldDrawPlan({ expansion });
    expect(plan.cells).toBe(1);
    expect(new Set(plan.groups.map((group) => group.dna))).toEqual(new Set([ROCK_DNA, OTHER_DNA]));
    expect(plan.groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(expansion.placed);
    for (const group of plan.groups) {
      const rocks = expansion.rocks.filter((rock) => rock.dna === group.dna);
      expect(group.cell).toBe('all');
      expect(group.maxScale).toBe(Math.max(...rocks.map((rock) => rock.radius)));
      expect(group.aabbMin[0]).toBe(Math.min(...rocks.map((rock) => rock.position[0])));
      expect(group.aabbMax[2]).toBe(Math.max(...rocks.map((rock) => rock.position[2])));
    }
  });

  it('splits groups by cell when the cell size is finite', () => {
    const plan = FieldDrawPlan({ expansion, cellSize: 10000 });
    expect(plan.cells).toBeGreaterThan(1);
    expect(plan.groups.length).toBeGreaterThan(2);
    expect(plan.groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(expansion.placed);
    for (const group of plan.groups) {
      const cell = group.cell.split(',').map(Number);
      for (const row of group.rows) expect([row.transform0[3], row.transform1[3], row.transform2[3]].map((axis) => Math.floor(axis / 10000))).toEqual(cell);
    }
  });

  it('reads a rock template from SOF values, and refuses values without one mesh', () => {
    const template = RockTemplateOf(ROCK_VALUES);
    expect(template.rootType).toBe('EveStation2');
    expect(template.castShadow).toBe(true);
    expect(template.reflectionMode).toBe(3);
    expect(template.mesh['geometryResPath']).toBe('res:/dx9/model/celestial/asteroid/rock_01/medium/rock_01_m_v1.gr2');
    expect(() => RockTemplateOf({ _type: 'EveStation2', mesh: null })).toThrow('not a single-mesh SOF object (EveStation2, mesh none)');
  });

  it('composes one meshless root with an instanced child per model on the instanced permutation', () => {
    const plan = FieldDrawPlan({ expansion });
    const root = FieldRootValues({ plan, templates: Templates(), envelope: expansion.envelope });
    expect(root['_type']).toBe('EveStation2');
    expect(root['mesh']).toBeNull();
    expect(root['boundingSphereRadius']).toBe(expansion.envelope);
    expect(root['boundingSphereCenter']).toEqual([0, 0, 0]);
    expect(root['controllers']).toEqual([]);
    expect(root['locators']).toEqual([]);
    expect(root['locatorSets']).toEqual([]);
    expect(root['impactOverlay']).toBeNull();
    const [container] = root['effectChildren'] as Values[];
    expect(container).toMatchObject({ _type: 'EveChildContainer', alwaysOn: true, origin: 1, isPlacementRoot: true });
    const children = Children(root);
    expect(children.map((child) => child['name'])).toEqual(plan.groups.map((group) => group.dna));
    for (const [index, child] of children.entries()) {
      const group = plan.groups[index];
      expect(child).toMatchObject({ _type: 'EveChildMesh', castShadow: true, reflectionMode: 3, minScreenSize: 2.5 });
      const mesh = child['mesh'] as Values;
      expect(mesh).toMatchObject({ _type: 'Tr2InstancedMesh', boundsMethod: 2, instanceMeshIndex: 0, maxInstanceSize: group.maxScale, geometryResPath: 'res:/dx9/model/celestial/asteroid/rock_01/medium/rock_01_m_v1.gr2' });
      const data = mesh['instanceGeometryResource'] as Values;
      expect(data).toMatchObject({ _type: 'Tr2RuntimeInstanceData', explicitBoundingBox: true, aabbMin: group.aabbMin, aabbMax: group.aabbMax, layout: FIELD_INSTANCE_LAYOUT });
      expect(data['rows']).toHaveLength(group.rows.length);
      for (const area of mesh['opaqueAreas'] as Values[]) {
        const options = (area['effect'] as Values)['options'] as Values[];
        expect(options.map((option) => `${option['name']}=${option['value']}`)).toEqual(['SPACE_OBJECT_TRANSPARENCY=SOT_OPAQUE', 'SPACE_OBJECT_PPT_ENABLED=SOPPT_DISABLED', 'SPACE_OBJECT_INSTANCED_ATTACHMENT=SOIA_ENABLED']);
      }
    }
    // The template stays untouched for the next field.
    const template = RockTemplateOf(ROCK_VALUES);
    const options = (((template.mesh['opaqueAreas'] as Values[])[0]['effect'] as Values)['options'] as Values[]).map((option) => option['name']);
    expect(options).not.toContain('SPACE_OBJECT_INSTANCED_ATTACHMENT');
  });

  it('drops shadows on request and leaves out models without a template', () => {
    const plan = FieldDrawPlan({ expansion });
    const root = FieldRootValues({ plan, templates: new Map([[ROCK_DNA, RockTemplateOf(ROCK_VALUES)]]), envelope: expansion.envelope, castShadow: false });
    expect(root['castShadow']).toBe(false);
    expect(Children(root).map((child) => [child['name'], child['castShadow']])).toEqual([[ROCK_DNA, false]]);
    expect(() => FieldRootValues({ plan, templates: new Map(), envelope: 1 })).toThrow('no rock model of the field built');
  });

  it("reads a rock geometry's LOD meshes and picks the smallest one covering the screen size", () => {
    // rock_01_m_v1.gr2's meshes (2026-10-23): the base, then one mesh per LOD.
    const lods = FieldLodMeshes(['v3Shape', 'v3Shape LOD 640', 'v3Shape LOD 320', 'v3Shape LOD 160', 'v3Shape LOD 80', 'v3Shape LOD 40', 'v3Shape LOD 20']);
    expect(lods.map((lod) => [lod.index, lod.pixels])).toEqual([
      [6, 20],
      [5, 40],
      [4, 80],
      [3, 160],
      [2, 320],
      [1, 640]
    ]);
    expect(FieldLodIndex(lods, 7)).toBe(6);
    expect(FieldLodIndex(lods, 20)).toBe(6);
    expect(FieldLodIndex(lods, 21)).toBe(5);
    expect(FieldLodIndex(lods, 600)).toBe(1);
    expect(FieldLodIndex(lods, 641)).toBe(0);
    expect(FieldLodIndex(FieldLodMeshes(['v3Shape', null]), 5)).toBe(0);
  });

  it('frames and reaches a field by its envelope, else its radius and largest rock', () => {
    const moved = { ...field, position: [3000, 0, 4000] as [number, number, number] };
    expect(FieldSphere(moved)).toEqual({ centre: [3000, 0, 4000], radius: 21000 });
    expect(FieldSphere(moved, 18000)).toEqual({ centre: [3000, 0, 4000], radius: 18000 });
    expect(FieldReach([FieldSphere(moved, 18000)])).toBe(5000 + 36000);
    expect(FieldReach([])).toBe(0);
  });

  it('reports a compact state row and the overlay text', () => {
    const entry = { status: 'ready' as const, expansion, models: { total: 2, built: 2, failed: 0 }, cells: 1 };
    const row = AsteroidFieldStateRow({ field, entry, ships: [{ id: 'rifter', position: [0, 0, 30000], radius: 30 }] });
    expect(row).toMatchObject({ id: 'belt', status: 'ready', shape: 'sphere', radius: 20000, seed: field.seed, digest: expansion.digest, cells: 1, distance: 0 });
    expect(row.rocks).toEqual({ requested: 40, placed: expansion.placed, bySize: expansion.counts.bySize, byOre: [{ ore: 'Veldspar', rocks: expansion.placed }] });
    expect(row.models).toEqual({ total: 2, built: 2, failed: 0 });
    expect(row.envelope).toBe(Math.round(expansion.envelope));
    expect(row.nearestShips).toEqual([{ id: 'rifter', distance: Math.round(30000 - expansion.envelope - 30) }]);
    const queued = AsteroidFieldStateRow({ field, entry: null, ships: [] });
    expect(queued).toMatchObject({ status: 'queued', digest: '', envelope: 0, rocks: { requested: 40, placed: 0 } });
    expect(AsteroidFieldsText([row, { status: 'building', rocks: { placed: 1200 } }])).toBe(`2 · ${(expansion.placed + 1200).toLocaleString('en-US')} rocks · 1 ready · 1 building`);
    expect(AsteroidFieldsText([])).toBeNull();
  });
});
