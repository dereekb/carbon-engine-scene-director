/**
 * The scene's asteroid fields on the page: each field expands to its seeded rocks (the same rocks the hub expanded),
 * and draws as one meshless SOF root on fixed curves holding an instanced child per rock model (asteroid-fields.ts
 * composes the values). Each rock DNA's SOF values build once per page session, shared by every field. A move
 * re-places the curves; a rebuild hydrates the new root before the old one leaves, so an edit never blanks the field.
 * Every frame each instanced child draws its rock's LOD mesh for its nearest rock's screen size (DriveLod). Rocks cast
 * no shadows (the shadow passes cost 4× the rest on the GPU, A3); `?fields=shadow` turns them on, `?fields=off` draws
 * none (`off`). Without a renderer fields build to values (`validated`). Rocks are draw-only: no Destiny balls
 * (sd-asteroid-fields).
 */

import type { Maybe } from '@dereekb/util';
import { expandAsteroidField, type AsteroidFieldExpansion, type SceneAsteroidField, type SceneAsteroidFieldsDiff, type SceneAsteroidFieldStatus, type SceneDocument } from '@scene-director/scene';
import { FIELD_CELL_SIZE, FieldDrawPlan, FieldLodIndex, FieldLodMeshes, FieldReach, FieldRootValues, FieldSphere, RockTemplateOf, type FieldEntryState, type FieldLodMesh, type RockTemplate } from './asteroid-fields';
import { DocumentRotation } from './destiny';
import type { Engine } from './engine';
import { EVE_DATA_ON, type PageEveData } from './eve-data';
import { ErrorText } from './resources';
import { CjsSchema, EveChildContainer, EveChildMesh, Tr2InstancedMesh, type CjsModelValues, type EveSpaceObject2 } from './runtime';
import { BuildShipValues, CreateStaticCurves, HydrateSofObject, PlaceStatic, RetireShips, type DetachAudio, type StaticCurves } from './ships';

/**
 * The `?fields=` switch: `off` draws no field (an fps baseline), `shadow` lets rocks cast shadows.
 */
export const FIELDS_SWITCH: Maybe<'off' | 'shadow'> = ReadFieldsSwitch(globalThis.location?.search ?? '');

/**
 * One instanced child's LOD state: its mesh, and its geometry's LOD meshes once the geometry has loaded.
 */
interface FieldLodChild {
  readonly child: EveChildMesh;
  readonly mesh: Tr2InstancedMesh;
  lods: Maybe<FieldLodMesh[]>;
}

/**
 * Each rock DNA's template for the page session; a failed build is forgotten so the next build retries it.
 */
const templates = new Map<string, Promise<RockTemplate>>();

export interface SceneFieldsOptions {
  readonly engine: Maybe<Engine>;
  /**
   * Everything else still drawn (ships, the dressing, objects), which retiring a field must keep.
   */
  readonly retained: () => object[];
  readonly onChange: () => void;
  /**
   * Hydrates roots with the audio seams detached (PageAudio.Detached).
   */
  readonly detachAudio: DetachAudio;
  /**
   * The tab's EVE data mode; off, fields are placed but build and draw no rock: their status is `off` with the note.
   */
  readonly eveData?: PageEveData;
}

/**
 * One field's build.
 */
export interface SceneFieldEntry extends FieldEntryState {
  readonly id: string;
  field: SceneAsteroidField;
  status: SceneAsteroidFieldStatus;
  error: Maybe<string>;
  /**
   * Why the status is `off` with no EVE data.
   */
  note?: Maybe<string>;
  expansion: Maybe<AsteroidFieldExpansion>;
  models: Maybe<{ total: number; built: number; failed: number; failedDnas: string[] }>;
  cells: number;
  root: Maybe<EveSpaceObject2>;
  readonly curves: StaticCurves;
  /**
   * The root still drawn while a rebuild hydrates (swapped out once the new root is in the scene).
   */
  previous: Maybe<EveSpaceObject2>;
}

export class SceneFields {
  private readonly engine: Maybe<Engine>;
  private readonly retained: () => object[];
  private readonly onChange: () => void;
  private readonly detachAudio: DetachAudio;
  private readonly eveData: PageEveData;
  private readonly entries = new Map<string, SceneFieldEntry>();
  /**
   * Every hydrated root's instanced children, for DriveLod.
   */
  private readonly lodChildren = new Map<EveSpaceObject2, FieldLodChild[]>();

  constructor(options: SceneFieldsOptions) {
    this.engine = options.engine;
    this.retained = options.retained;
    this.onChange = options.onChange;
    this.detachAudio = options.detachAudio;
    this.eveData = options.eveData ?? EVE_DATA_ON;
  }

  /**
   * Retires removed fields, queues added and rebuilt ones (and retries failed ones), and re-places moved ones.
   *
   * @param diff - What changed in the fields.
   * @param scene - The document now shown.
   * @returns The entries to build, in document order.
   */
  Apply(diff: SceneAsteroidFieldsDiff, scene: SceneDocument): SceneFieldEntry[] {
    for (const field of diff.removed) this.Retire(field.id);
    const queue = new Set([...diff.added, ...diff.rebuilt].map((field) => field.id));
    for (const field of scene.asteroidFields ?? []) {
      const entry = this.entries.get(field.id);
      if (!entry || entry.status === 'failed') queue.add(field.id);
      else entry.field = field;
    }
    for (const field of diff.moved) {
      const entry = this.entries.get(field.id);
      if (entry) PlaceStatic(entry.curves, field.position, DocumentRotation(field.rotation));
    }
    const builds: SceneFieldEntry[] = [];
    for (const field of scene.asteroidFields ?? []) {
      if (!queue.has(field.id)) continue;
      const old = this.entries.get(field.id);
      // A rebuild keeps drawing the old root on the same curves until the new one is in.
      const previous = old ? (old.root ?? old.previous) : null;
      if (old) {
        old.root = null;
        old.previous = null;
      }
      const curves = old?.curves ?? CreateStaticCurves();
      PlaceStatic(curves, field.position, DocumentRotation(field.rotation));
      const entry: SceneFieldEntry = { id: field.id, field, status: 'queued', error: null, expansion: null, models: null, cells: 0, root: null, curves, previous };
      this.entries.set(field.id, entry);
      builds.push(entry);
    }
    if (builds.length || diff.removed.length || diff.moved.length) this.onChange();
    return builds;
  }

  /**
   * Expands one field, builds its rock templates, composes its root and (with a renderer) hydrates it into the scene,
   * then swaps out the root it replaces. A field retired or rebuilt meanwhile is dropped.
   *
   * @param entry - The entry Apply returned.
   */
  async Build(entry: SceneFieldEntry): Promise<void> {
    entry.status = 'building';
    this.onChange();
    try {
      const expansion = expandAsteroidField(entry.field);
      entry.expansion = expansion;
      const plan = FieldDrawPlan({ expansion, cellSize: FIELD_CELL_SIZE });
      entry.cells = plan.cells;
      const dnas = [...new Set(plan.groups.map((group) => group.dna))];
      if (!this.eveData.on) {
        // No EVE data: the rocks are placed (the expansion and the plan are pure) but no model is built or drawn.
        entry.models = { total: dnas.length, built: 0, failed: 0, failedDnas: [] };
        entry.status = 'off';
        entry.note = this.eveData.note;
      } else {
        const built = new Map<string, RockTemplate>();
        const failedDnas: string[] = [];
        let firstError: Maybe<string> = null;
        for (const dna of dnas) {
          try {
            built.set(dna, await Template(dna));
          } catch (error) {
            failedDnas.push(dna);
            firstError ??= `${dna}: ${ErrorText(error)}`;
            console.warn(`asteroid field ${entry.id}: rock ${dna}: ${ErrorText(error)}`);
          }
        }
        entry.models = { total: dnas.length, built: built.size, failed: failedDnas.length, failedDnas };
        if (dnas.length && !built.size) throw new Error(`no rock model built (${firstError})`);
        if (dnas.length) {
          const values = FieldRootValues({ plan, templates: built, envelope: expansion.envelope, castShadow: FIELDS_SWITCH === 'shadow' ? undefined : false });
          if (this.engine && FIELDS_SWITCH !== 'off' && this.Current(entry)) {
            entry.root = this.detachAudio(() =>
              HydrateSofObject<EveSpaceObject2>(values as CjsModelValues, (root) => {
                root.translationCurve = entry.curves.translation;
                root.rotationCurve = entry.curves.rotation;
              })
            );
            this.lodChildren.set(entry.root, LodChildren(entry.root));
            if (this.Current(entry)) this.engine.AddObject(entry.root);
          }
        }
        entry.status = FIELDS_SWITCH === 'off' && this.engine ? 'off' : entry.root ? 'ready' : 'validated';
      }
    } catch (error) {
      entry.status = 'failed';
      entry.error = ErrorText(error);
      console.warn(`asteroid field ${entry.id}: ${entry.error}`);
    }
    this.SwapOut(entry);
    if (!this.Current(entry)) this.Teardown(entry);
    this.onChange();
  }

  /**
   * Points each drawn rock model at its LOD mesh for its nearest rock's screen size, measured by the last scene update
   * (so a frame late). Runs every frame before engine.Frame.
   */
  DriveLod(): void {
    for (const children of this.lodChildren.values()) {
      for (const entry of children) {
        const size = Math.min(entry.child.currentInstanceScreenSize, entry.child.currentScreenSize);
        if (!(size >= 0)) continue;
        entry.lods ??= ReadLodMeshes(entry.mesh);
        if (entry.lods) entry.mesh.meshIndex = FieldLodIndex(entry.lods, size);
      }
    }
  }

  Has(id: string): boolean {
    return this.entries.has(id);
  }

  Entry(id: string): Maybe<SceneFieldEntry> {
    return this.entries.get(id) ?? null;
  }

  /**
   * The hydrated field roots (and any still drawn through a rebuild), for every other retire's retained set.
   *
   * @returns The roots.
   */
  Roots(): object[] {
    return [...this.entries.values()].flatMap((entry) => [entry.root, entry.previous].filter((root): root is EveSpaceObject2 => root != null));
  }

  /**
   * A field's world sphere: its envelope around its centre once expanded.
   *
   * @param field - The document field.
   * @returns The centre and radius.
   */
  Sphere(field: SceneAsteroidField): { readonly centre: SceneAsteroidField['position']; readonly radius: number } {
    return FieldSphere(field, this.entries.get(field.id)?.expansion?.envelope);
  }

  /**
   * How far the camera's back clip must reach for the scene's fields.
   *
   * @param scene - The document shown.
   * @returns Metres.
   */
  Reach(scene: SceneDocument): number {
    return FieldReach((scene.asteroidFields ?? []).map((field) => this.Sphere(field)));
  }

  /**
   * Forgets every field (a full reload).
   */
  Clear(): void {
    for (const id of [...this.entries.keys()]) this.Retire(id);
  }

  private Current(entry: SceneFieldEntry): boolean {
    return this.entries.get(entry.id) === entry;
  }

  /**
   * Takes the root a rebuild replaced out of the scene, now that the new one is in (or failed).
   *
   * @param entry - The rebuilt entry.
   */
  private SwapOut(entry: SceneFieldEntry): void {
    const previous = entry.previous;
    entry.previous = null;
    if (!previous) return;
    this.engine?.RemoveObject(previous);
    this.RetireRoot(entry.id, previous);
  }

  private Retire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.root) this.engine?.RemoveObject(entry.root);
    if (entry.previous) this.engine?.RemoveObject(entry.previous);
    this.Teardown(entry);
  }

  private Teardown(entry: SceneFieldEntry): void {
    for (const root of [entry.root, entry.previous]) if (root) this.RetireRoot(entry.id, root);
    entry.root = null;
    entry.previous = null;
  }

  private RetireRoot(id: string, root: EveSpaceObject2): void {
    this.lodChildren.delete(root);
    try {
      RetireShips([root], [...this.retained(), ...this.Roots().filter((other) => other !== root)]);
    } catch (error) {
      console.warn(`asteroid field ${id}: retiring: ${ErrorText(error)}`);
    }
  }
}

/**
 * A rock DNA's template, built once per page session over the shared SOF queue.
 *
 * @param dna - The rock's SOF DNA.
 * @returns The template.
 */
function Template(dna: string): Promise<RockTemplate> {
  let template = templates.get(dna);
  if (!template) {
    template = BuildShipValues(dna).then((build) => RockTemplateOf(build.values as Record<string, unknown>));
    templates.set(dna, template);
    template.catch(() => templates.delete(dna));
  }
  return template;
}

/**
 * A hydrated field root's instanced children.
 *
 * @param root - The field root.
 * @returns Each child with its instanced mesh.
 */
function LodChildren(root: EveSpaceObject2): FieldLodChild[] {
  return root.effectChildren.flatMap((container) =>
    (CjsSchema.cast(container, EveChildContainer)?.objects ?? []).flatMap((object) => {
      const child = CjsSchema.cast(object, EveChildMesh);
      const mesh = child ? CjsSchema.cast(child.mesh, Tr2InstancedMesh) : null;
      return child && mesh ? [{ child, mesh, lods: null }] : [];
    })
  );
}

/**
 * A rock mesh's LOD meshes, once its geometry has loaded.
 *
 * @param mesh - The instanced mesh.
 * @returns The LOD meshes, or null while the geometry loads.
 */
function ReadLodMeshes(mesh: Tr2InstancedMesh): Maybe<FieldLodMesh[]> {
  try {
    const geometry = mesh.GetGeometryResource();
    const count = geometry?.GetMeshCount() ?? 0;
    return geometry && count > 0 ? FieldLodMeshes(Array.from({ length: count }, (_, index) => geometry.GetMeshName(index))) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the `?fields=` switch.
 *
 * @param search - `location.search`.
 * @returns `off`, `shadow`, or null.
 */
export function ReadFieldsSwitch(search: string): Maybe<'off' | 'shadow'> {
  const value = new URLSearchParams(search).get('fields')?.trim().toLowerCase();
  return value === 'off' || value === 'shadow' ? value : null;
}
