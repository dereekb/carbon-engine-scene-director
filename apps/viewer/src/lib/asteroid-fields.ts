/**
 * The page's asteroid field drawing as pure values (node-tested; no runtime import): the expanded rocks grouped per
 * rock model (and spatial cell), each group one `EveChildMesh` whose mesh is the rock's SOF mesh turned into a
 * `Tr2InstancedMesh` with a `Tr2RuntimeInstanceData` of its rocks, as SOF's own instanced layout path builds them
 * (EveSOF.js `CreateLayoutInstancedMesh`, `packInstanceMatrix`). One meshless root per field holds them all.
 * SceneFields (scene-fields.ts) builds the templates and hydrates the root. The runtime coupling: sd-asteroid-fields.
 */

import type { Maybe } from '@dereekb/util';
import { ASTEROID_FIELD_NEAREST_SHIPS, type AsteroidFieldExpansion, type AsteroidRockSize, type SceneAsteroidField, type SceneAsteroidFieldStateReport, type SceneAsteroidFieldStatus, type SceneVector } from '@scene-director/scene';
import { NearestShips, type ShipSphere } from './objects';

/**
 * The side of a spatial cell rocks are grouped by (one draw group per model per cell), metres. Infinity draws each
 * model as one group: the runtime picks a child's LOD by its nearest instance and culls the child as a whole, so cells
 * are the knob when a field near the camera costs too much.
 */
export const FIELD_CELL_SIZE = Infinity;

/**
 * An instanced child's minimum screen size, as SOF writes it for instanced placements (MIN_MESH_SCREEN_SIZE).
 */
export const FIELD_MIN_SCREEN_SIZE = 2.5;

/**
 * The instance stream layout: a copy of the runtime's SOF_INSTANCE_LAYOUT (EveSOF.js), pinned by the spec. The shader
 * reads the rows as TEXCOORD8..14. Re-check it against EveSOF.js on a runtime pin bump.
 */
export const FIELD_INSTANCE_LAYOUT: readonly FieldInstanceLayoutElement[] = [
  { usage: 'TEXCOORD', usageIndex: 0, type: 'FLOAT32_4', name: 'transform0' },
  { usage: 'TEXCOORD', usageIndex: 1, type: 'FLOAT32_4', name: 'transform1' },
  { usage: 'TEXCOORD', usageIndex: 2, type: 'FLOAT32_4', name: 'transform2' },
  { usage: 'TEXCOORD', usageIndex: 3, type: 'FLOAT32_4', name: 'lastTransform0' },
  { usage: 'TEXCOORD', usageIndex: 4, type: 'FLOAT32_4', name: 'lastTransform1' },
  { usage: 'TEXCOORD', usageIndex: 5, type: 'FLOAT32_4', name: 'lastTransform2' },
  { usage: 'TEXCOORD', usageIndex: 6, type: 'BYTE_4', name: 'boneIndex' }
];

/**
 * The shader permutation an instanced child's areas draw with (quadenvironmentv5 carries it).
 */
export const FIELD_INSTANCED_OPTION = { name: 'SPACE_OBJECT_INSTANCED_ATTACHMENT', value: 'SOIA_ENABLED' } as const;

const MESH_AREA_LISTS = ['opaqueAreas', 'transparentAreas', 'additiveAreas', 'distortionAreas', 'depthAreas'] as const;

export interface FieldInstanceLayoutElement {
  readonly usage: string;
  readonly usageIndex: number;
  readonly type: string;
  readonly name: string;
}

/**
 * One instance row, in FIELD_INSTANCE_LAYOUT's names: the transpose rows of the instance matrix.
 */
export interface FieldInstanceRow {
  readonly transform0: number[];
  readonly transform1: number[];
  readonly transform2: number[];
  readonly lastTransform0: number[];
  readonly lastTransform1: number[];
  readonly lastTransform2: number[];
  readonly boneIndex: number;
}

/**
 * The rocks of one model in one cell: one instanced child.
 */
export interface FieldDrawGroup {
  readonly dna: string;
  /**
   * The cell key (`"all"` when cells are off).
   */
  readonly cell: string;
  readonly rows: FieldInstanceRow[];
  /**
   * The rocks' centres' box, field-local metres (the runtime widens it by the largest instance).
   */
  readonly aabbMin: SceneVector;
  readonly aabbMax: SceneVector;
  /**
   * The largest rock radius in the group: the mesh's maxInstanceSize.
   */
  readonly maxScale: number;
}

export interface FieldDrawPlanResult {
  /**
   * In the order rock models first appear among the rocks, then by cell key.
   */
  readonly groups: FieldDrawGroup[];
  readonly cells: number;
}

/**
 * Groups a field's placed rocks per model and cell.
 *
 * @param input - The expansion, and the cell size.
 * @param input.expansion - The field's expandAsteroidField result.
 * @param input.cellSize - The cell side, metres (FIELD_CELL_SIZE).
 * @returns The draw groups.
 */
export function FieldDrawPlan(input: { readonly expansion: Pick<AsteroidFieldExpansion, 'rocks'>; readonly cellSize?: number }): FieldDrawPlanResult {
  const { expansion, cellSize = FIELD_CELL_SIZE } = input;
  const byModel = new Map<string, Map<string, { rows: FieldInstanceRow[]; min: number[]; max: number[]; maxScale: number }>>();
  const cells = new Set<string>();
  for (const rock of expansion.rocks) {
    const cell = Number.isFinite(cellSize) && cellSize > 0 ? rock.position.map((axis) => Math.floor(axis / cellSize)).join(',') : 'all';
    cells.add(cell);
    let model = byModel.get(rock.dna);
    if (!model) byModel.set(rock.dna, (model = new Map()));
    let group = model.get(cell);
    if (!group) model.set(cell, (group = { rows: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], maxScale: 0 }));
    group.rows.push(PackInstance(rock.position, rock.rotation, rock.radius));
    for (let axis = 0; axis < 3; axis++) {
      group.min[axis] = Math.min(group.min[axis], rock.position[axis]);
      group.max[axis] = Math.max(group.max[axis], rock.position[axis]);
    }
    group.maxScale = Math.max(group.maxScale, rock.radius);
  }
  const groups: FieldDrawGroup[] = [];
  for (const [dna, model] of byModel) {
    for (const cell of [...model.keys()].sort()) {
      const group = model.get(cell);
      if (group) groups.push({ dna, cell, rows: group.rows, aabbMin: [group.min[0], group.min[1], group.min[2]], aabbMax: [group.max[0], group.max[1], group.max[2]], maxScale: group.maxScale });
    }
  }
  return { groups, cells: cells.size };
}

/**
 * One instance row: the matrix `T(position) · R(rotation) · S(scale)` (gl-matrix column-major) packed as SOF's
 * `packInstanceMatrix` packs it, `transformN = [mN, mN+4, mN+8, mN+12]`, with `lastTransform*` copies and bone 0.
 *
 * @param position - Field-local metres.
 * @param rotation - A unit quaternion `[x, y, z, w]`.
 * @param scale - The uniform scale: the rock radius (rock models are unit-sized).
 * @returns The row.
 */
export function PackInstance(position: ArrayLike<number>, rotation: ArrayLike<number>, scale: number): FieldInstanceRow {
  const [x, y, z, w] = [rotation[0], rotation[1], rotation[2], rotation[3]];
  const transform0 = [(1 - 2 * (y * y + z * z)) * scale, 2 * (x * y - z * w) * scale, 2 * (x * z + y * w) * scale, position[0]];
  const transform1 = [2 * (x * y + z * w) * scale, (1 - 2 * (x * x + z * z)) * scale, 2 * (y * z - x * w) * scale, position[1]];
  const transform2 = [2 * (x * z - y * w) * scale, 2 * (y * z + x * w) * scale, (1 - 2 * (x * x + y * y)) * scale, position[2]];
  return { transform0, transform1, transform2, lastTransform0: [...transform0], lastTransform1: [...transform1], lastTransform2: [...transform2], boneIndex: 0 };
}

/**
 * What a field takes from one rock DNA's SOF values.
 */
export interface RockTemplate {
  /**
   * The SOF `Tr2Mesh` values (geometry and areas), cloned per draw group.
   */
  readonly mesh: Readonly<Record<string, unknown>>;
  readonly castShadow: boolean;
  readonly reflectionMode: number;
  /**
   * The SOF root's type (`EveStation2` for rock hulls): the field root takes it.
   */
  readonly rootType: string;
  readonly inheritProperties: Maybe<unknown>;
}

/**
 * Reads a rock template from a DNA's SOF model values.
 *
 * @param values - BuildShipValues(dna).values.
 * @returns The template.
 * @throws When the values hold no single SOF mesh.
 */
export function RockTemplateOf(values: Readonly<Record<string, unknown>>): RockTemplate {
  const mesh = values['mesh'] as Maybe<Record<string, unknown>>;
  if (!mesh || typeof mesh !== 'object' || mesh['_type'] !== 'Tr2Mesh' || typeof mesh['geometryResPath'] !== 'string') throw new Error(`not a single-mesh SOF object (${String(values['_type'])}, mesh ${mesh ? String(mesh['_type']) : 'none'})`);
  return {
    mesh,
    castShadow: values['castShadow'] !== false,
    reflectionMode: typeof values['reflectionMode'] === 'number' ? values['reflectionMode'] : 0,
    rootType: typeof values['_type'] === 'string' ? values['_type'] : 'EveStation2',
    inheritProperties: values['inheritProperties'] ?? null
  };
}

export interface FieldRootInput {
  readonly plan: FieldDrawPlanResult;
  /**
   * Per DNA; a group whose DNA has no template is left out.
   */
  readonly templates: ReadonlyMap<string, RockTemplate>;
  /**
   * The field's envelope radius, metres: the root's bounding sphere.
   */
  readonly envelope: number;
  /**
   * False draws no rock shadows (`?fields=noshadow`); else each template's own.
   */
  readonly castShadow?: boolean;
}

/**
 * Composes one field's root model values: a meshless SOF root (no controllers, observers, locators or impact overlay)
 * whose one placement container holds an instanced child per draw group.
 *
 * @param input - The plan, the templates, the envelope and the shadow switch.
 * @returns The values for CjsSchema.from.
 * @throws When no group has a template.
 */
export function FieldRootValues(input: FieldRootInput): Record<string, unknown> {
  const { plan, templates, envelope, castShadow } = input;
  const objects: Record<string, unknown>[] = [];
  let first: Maybe<RockTemplate> = null;
  for (const group of plan.groups) {
    const template = templates.get(group.dna);
    if (!template) continue;
    first ??= template;
    objects.push({
      _type: 'EveChildMesh',
      name: group.dna,
      mesh: InstancedMeshValues(template, group),
      castShadow: castShadow ?? template.castShadow,
      reflectionMode: template.reflectionMode,
      minScreenSize: FIELD_MIN_SCREEN_SIZE,
      decals: [],
      attachments: [],
      lights: []
    });
  }
  if (!first) throw new Error('no rock model of the field built');
  const radius = Math.max(envelope, 1);
  return {
    _type: first.rootType,
    boundingSphereCenter: [0, 0, 0],
    boundingSphereRadius: radius,
    shapeEllipsoidCenter: [0, 0, 0],
    shapeEllipsoidRadius: [radius, radius, radius],
    dynamicBoundingSphereEnabled: false,
    castShadow: castShadow ?? first.castShadow,
    isAnimated: false,
    reflectionMode: first.reflectionMode,
    mesh: null,
    effectChildren: [
      {
        _type: 'EveChildContainer',
        name: 'asteroid field',
        objects,
        curveSets: [],
        attachments: [],
        observers: [],
        lights: [],
        controllers: [],
        alwaysOn: true,
        origin: 1,
        isPlacementRoot: true
      }
    ],
    children: [],
    curveSets: [],
    modelRotationCurve: null,
    modelTranslationCurve: null,
    attachments: [],
    decals: [],
    impactOverlay: null,
    customMasks: [],
    lights: [],
    externalParameters: [],
    controllers: [],
    observers: [],
    locators: [],
    locatorSets: [],
    ...(first.inheritProperties ? { inheritProperties: structuredClone(first.inheritProperties) } : {})
  };
}

/**
 * A template's mesh as a Tr2InstancedMesh of one group's rocks (DYNAMIC_SCALED bounds), every area effect drawing the
 * instanced permutation.
 *
 * @param template - The rock's template.
 * @param group - The draw group.
 * @returns The mesh values.
 */
function InstancedMeshValues(template: RockTemplate, group: FieldDrawGroup): Record<string, unknown> {
  const mesh = structuredClone(template.mesh) as Record<string, unknown>;
  for (const list of MESH_AREA_LISTS) {
    for (const area of (mesh[list] as Maybe<Record<string, unknown>[]>) ?? []) {
      const effect = area['effect'] as Maybe<Record<string, unknown>>;
      if (!effect) continue;
      const options = Array.isArray(effect['options']) ? (effect['options'] as { name?: unknown }[]) : [];
      if (!options.some((option) => option.name === FIELD_INSTANCED_OPTION.name)) options.push({ _type: 'Tr2ShaderOption', ...FIELD_INSTANCED_OPTION } as { name: string });
      effect['options'] = options;
    }
  }
  return {
    ...mesh,
    _type: 'Tr2InstancedMesh',
    boundsMethod: 2,
    instanceMeshIndex: 0,
    minBounds: [0, 0, 0],
    maxBounds: [0, 0, 0],
    maxInstanceSize: group.maxScale,
    instanceGeometryResource: {
      _type: 'Tr2RuntimeInstanceData',
      name: '',
      particleSystem: null,
      layout: FIELD_INSTANCE_LAYOUT.map((element) => ({ ...element })),
      rows: group.rows,
      explicitBoundingBox: true,
      aabbMin: [...group.aabbMin],
      aabbMax: [...group.aabbMax]
    }
  };
}

/**
 * What a field's state row reads from its page entry.
 */
export interface FieldEntryState {
  readonly status: SceneAsteroidFieldStatus;
  readonly error?: Maybe<string>;
  readonly expansion?: Maybe<Pick<AsteroidFieldExpansion, 'requested' | 'placed' | 'envelope' | 'digest' | 'counts'>>;
  readonly models?: Maybe<{ readonly total: number; readonly built: number; readonly failed: number; readonly failedDnas?: readonly string[] }>;
  readonly cells?: number;
}

/**
 * A field's world sphere for framing and the back clip: its envelope around its centre, else (not expanded yet) the
 * field radius plus its largest rock.
 *
 * @param field - The document field.
 * @param envelope - The expansion's envelope, when expanded.
 * @returns The centre and radius.
 */
export function FieldSphere(field: Pick<SceneAsteroidField, 'position' | 'radius' | 'size'>, envelope?: Maybe<number>): { readonly centre: SceneVector; readonly radius: number } {
  return { centre: field.position, radius: envelope != null && envelope > 0 ? envelope : field.radius + field.size[1] };
}

/**
 * How far the camera's back clip must reach for the scene's fields: the farthest field's far side, twice over.
 *
 * @param spheres - Each field's FieldSphere.
 * @returns Metres.
 */
export function FieldReach(spheres: readonly { readonly centre: SceneVector; readonly radius: number }[]): number {
  return spheres.reduce((reach, sphere) => Math.max(reach, Math.hypot(...sphere.centre) + 2 * sphere.radius), 0);
}

/**
 * One field's get_state row.
 *
 * @param input - The document field, its page entry and the ships.
 * @param input.field - The document field.
 * @param input.entry - Its page entry (null before Apply).
 * @param input.ships - Every live ship's drawn position and radius.
 * @returns The row.
 */
export function AsteroidFieldStateRow(input: { readonly field: SceneAsteroidField; readonly entry: Maybe<FieldEntryState>; readonly ships: readonly ShipSphere[] }): SceneAsteroidFieldStateReport {
  const { field, entry, ships } = input;
  const expansion = entry?.expansion;
  const bySize: Record<AsteroidRockSize, number> = { small: expansion?.counts.bySize.small ?? 0, medium: expansion?.counts.bySize.medium ?? 0, large: expansion?.counts.bySize.large ?? 0 };
  const sphere = FieldSphere(field, expansion?.envelope);
  const models = entry?.models ?? { total: 0, built: 0, failed: 0 };
  return {
    id: field.id,
    ...(field.name == null ? {} : { name: field.name }),
    status: entry?.status ?? 'queued',
    ...(entry?.error ? { error: entry.error } : {}),
    position: field.position,
    rotation: field.rotation,
    shape: field.shape,
    radius: field.radius,
    ...(field.innerRadius == null ? {} : { innerRadius: field.innerRadius }),
    ...(field.thickness == null ? {} : { thickness: field.thickness }),
    ...(field.arc == null ? {} : { arc: field.arc }),
    seed: field.seed,
    rocks: {
      requested: expansion?.requested ?? field.count,
      placed: expansion?.placed ?? 0,
      bySize,
      byOre: field.ores.map((ore, index) => ({ ore: ore.ore ?? ore.faction ?? `ore ${index + 1}`, rocks: expansion?.counts.byOre[index] ?? 0 }))
    },
    models: { total: models.total, built: models.built, failed: models.failed, ...(models.failedDnas?.length ? { failedDnas: [...models.failedDnas] } : {}) },
    cells: entry?.cells ?? 0,
    envelope: Math.round(expansion?.envelope ?? 0),
    distance: Math.round(Math.hypot(...field.position)),
    digest: expansion?.digest ?? '',
    nearestShips: NearestShips({ position: sphere.centre, radius: sphere.radius, ships, limit: ASTEROID_FIELD_NEAREST_SHIPS })
  };
}

/**
 * The overlay's fields row: `"2 · 450 rocks · 2 ready"`.
 *
 * @param rows - The fields' state rows.
 * @returns The text, or null with no fields.
 */
export function AsteroidFieldsText(rows: readonly { readonly status: SceneAsteroidFieldStatus; readonly rocks: { readonly placed: number } }[]): Maybe<string> {
  const counts = new Map<SceneAsteroidFieldStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const order: SceneAsteroidFieldStatus[] = ['ready', 'validated', 'off', 'building', 'queued', 'failed'];
  const rocks = rows.reduce((sum, row) => sum + row.rocks.placed, 0);
  return rows.length ? [String(rows.length), `${rocks.toLocaleString('en-US')} rocks`, ...order.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${status}`)].join(' · ') : null;
}
