/**
 * The scene's static objects on the page: one SOF build per document object through the shared static path
 * (BuildStaticObject, as the location dressing builds stations and gates), on fixed curves at its document position
 * and rotation. A move re-places the curves; a dna change rebuilds. Without a renderer objects build to values
 * (`validated`). Their Destiny balls are DestinyWorld's (the Director keeps both in step).
 */

import type { Maybe } from '@dereekb/util';
import type { SceneDocument, SceneObject, SceneObjectsDiff, SceneObjectStatus, SceneVector } from '@scene-director/scene';
import { DocumentRotation } from './destiny';
import type { Engine } from './engine';
import { ObjectBallRadius, ObjectReach, type ObjectEntryState } from './objects';
import { ErrorText } from './resources';
import { vec3, type EveSpaceObject2 } from './runtime';
import { BuildStaticObject, CreateStaticCurves, PlaceStatic, RetireShips, type StaticCurves } from './ships';

export interface SceneObjectsOptions {
  readonly engine: Maybe<Engine>;
  /**
   * Everything else still drawn (ships, the dressing), which retiring an object must keep.
   */
  readonly retained: () => object[];
  readonly onChange: () => void;
  /**
   * Called once a build settles, with its SOF radius.
   */
  readonly onBuilt: (id: string, sofRadius: Maybe<number>) => void;
}

/**
 * One object's build.
 */
export interface SceneObjectEntry extends ObjectEntryState {
  readonly id: string;
  readonly dna: string;
  status: SceneObjectStatus;
  object: Maybe<EveSpaceObject2>;
  readonly curves: StaticCurves;
  sofRadius: Maybe<number>;
  sofCentre: Maybe<SceneVector>;
  error: Maybe<string>;
  diagnostics: unknown[];
}

export class SceneObjects {
  private readonly engine: Maybe<Engine>;
  private readonly retained: () => object[];
  private readonly onChange: () => void;
  private readonly onBuilt: (id: string, sofRadius: Maybe<number>) => void;
  private readonly entries = new Map<string, SceneObjectEntry>();

  constructor(options: SceneObjectsOptions) {
    this.engine = options.engine;
    this.retained = options.retained;
    this.onChange = options.onChange;
    this.onBuilt = options.onBuilt;
  }

  /**
   * Retires removed and rebuilt objects, queues added and rebuilt ones (and retries failed ones), and re-places moved
   * ones.
   *
   * @param diff - What changed in the objects.
   * @param scene - The document now shown.
   * @returns The entries to build, in document order.
   */
  Apply(diff: SceneObjectsDiff, scene: SceneDocument): SceneObjectEntry[] {
    for (const object of [...diff.removed, ...diff.rebuilt]) this.Retire(object.id);
    const queue = new Set([...diff.added, ...diff.rebuilt].map((object) => object.id));
    for (const object of scene.objects ?? []) {
      const entry = this.entries.get(object.id);
      if (entry?.status === 'failed') {
        this.Retire(object.id);
        queue.add(object.id);
      } else if (!entry) {
        queue.add(object.id);
      }
    }
    for (const object of diff.moved) {
      const entry = this.entries.get(object.id);
      if (entry) PlaceStatic(entry.curves, object.position, DocumentRotation(object.rotation));
    }
    const builds: SceneObjectEntry[] = [];
    for (const object of scene.objects ?? []) {
      if (!queue.has(object.id)) continue;
      const curves = CreateStaticCurves();
      PlaceStatic(curves, object.position, DocumentRotation(object.rotation));
      const entry: SceneObjectEntry = { id: object.id, dna: object.dna, status: 'queued', object: null, curves, sofRadius: null, sofCentre: null, error: null, diagnostics: [] };
      this.entries.set(object.id, entry);
      builds.push(entry);
    }
    if (builds.length || diff.removed.length || diff.moved.length) this.onChange();
    return builds;
  }

  /**
   * Builds one entry's object and adds it to the scene, unless it was retired meanwhile.
   *
   * @param entry - The entry Apply returned.
   */
  async Build(entry: SceneObjectEntry): Promise<void> {
    entry.status = 'building';
    this.onChange();
    try {
      const build = await BuildStaticObject({ dna: entry.dna, curves: entry.curves, hydrate: () => Boolean(this.engine) && this.entries.get(entry.id) === entry });
      if (build.dynamic.length > 0) console.info(`object ${entry.id}: dynamic resources ${build.dynamic.join(', ')} drawn as a stand-in`);
      entry.sofRadius = build.sofRadius;
      entry.sofCentre = build.sofCentre;
      entry.diagnostics = build.diagnostics;
      entry.object = build.object;
      if (build.object && this.entries.get(entry.id) === entry) this.engine?.AddObject(build.object);
      entry.status = build.object ? 'ready' : 'validated';
    } catch (error) {
      entry.status = 'failed';
      entry.error = ErrorText(error);
      console.warn(`object ${entry.id} (${entry.dna}): ${entry.error}`);
    }
    if (this.entries.get(entry.id) !== entry) this.Teardown(entry);
    else this.onBuilt(entry.id, entry.sofRadius);
    this.onChange();
  }

  Has(id: string): boolean {
    return this.entries.has(id);
  }

  Entry(id: string): Maybe<SceneObjectEntry> {
    return this.entries.get(id) ?? null;
  }

  /**
   * The hydrated object roots, for every other retire's retained set.
   *
   * @returns The roots.
   */
  Roots(): object[] {
    return [...this.entries.values()].flatMap((entry) => (entry.object ? [entry.object] : []));
  }

  /**
   * An object's world sphere for framing and picking: its drawn bounding sphere, else its ball radius at its position.
   *
   * @param object - The document object.
   * @returns The centre and radius.
   */
  Sphere(object: SceneObject): { readonly centre: SceneVector; readonly radius: number } {
    const entry = this.entries.get(object.id);
    let sphere = { centre: object.position, radius: ObjectBallRadius({ radius: object.radius, sofRadius: entry?.sofRadius }).radius };
    if (entry?.sofRadius != null) {
      const offset = entry.sofCentre ? vec3.transformQuat(vec3.create(), entry.sofCentre, DocumentRotation(object.rotation)) : [0, 0, 0];
      sphere = { centre: [object.position[0] + offset[0], object.position[1] + offset[1], object.position[2] + offset[2]], radius: entry.sofRadius };
    }
    return sphere;
  }

  /**
   * How far the camera's back clip must reach for the scene's objects.
   *
   * @param scene - The document shown.
   * @returns Metres.
   */
  Reach(scene: SceneDocument): number {
    return ObjectReach((scene.objects ?? []).map((object) => ({ position: object.position, radius: object.radius, sofRadius: this.entries.get(object.id)?.sofRadius })));
  }

  /**
   * Forgets every object (a full reload).
   */
  Clear(): void {
    for (const id of [...this.entries.keys()]) this.Retire(id);
  }

  private Retire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.object) this.engine?.RemoveObject(entry.object);
    this.Teardown(entry);
  }

  private Teardown(entry: SceneObjectEntry): void {
    const root = entry.object;
    entry.object = null;
    if (!root) return;
    try {
      RetireShips([root], [...this.retained(), ...this.Roots()]);
    } catch (error) {
      console.warn(`object ${entry.id}: retiring: ${ErrorText(error)}`);
    }
  }
}

/**
 * The forward axis of an object's document rotation, for chase framing.
 *
 * @param rotation - `[yaw, pitch, roll]` degrees.
 * @returns The unit forward vector.
 */
export function ObjectForward(rotation: SceneVector): SceneVector {
  const forward = vec3.transformQuat(vec3.create(), [0, 0, 1], DocumentRotation(rotation));
  return [forward[0], forward[1], forward[2]];
}
