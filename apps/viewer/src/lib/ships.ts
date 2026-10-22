/**
 * Ships: SOF values from DNA, hydration into live EveShip2 graphs, and
 * retirement of a removed ship's device resources. Destiny balls place and
 * move them (destiny.ts).
 */

import type { Maybe } from '@dereekb/util';
import { ErrorText, FileExists, FilesReady, ResourceBytes } from './resources';
import {
  blue,
  CjsBlackFormat,
  CjsSchema,
  EveChildBehaviorSystem,
  EveChildLineSet,
  EveSOF,
  EveSpherePin,
  Tr2CurveLineSet,
  Tr2DirectInstanceData,
  Tr2GrannyPrimitiveSet,
  Tr2ImpostorManager,
  Tr2InstancedMesh,
  Tr2ParticleSystem,
  Tr2RuntimeInstanceData,
  TriDevice,
  TriFloat,
  Tr2RotationAdapter,
  Tr2TranslationAdapter,
  quat,
  vec3,
  type CjsModelValues,
  type EveShip2,
  type EveSpaceObject2,
  type Quat
} from './runtime';
import type { SceneVector } from '@scene-director/scene';
import { PatchDynamicResources } from './celestials';
import type { ShipHull } from './destiny';

/**
 * The client's one generic booster trail mesh (Carbon leaves the setting empty for the client to fill).
 */
const VOLUMETRIC_TRAIL = 'res:/dx9/model/ship/booster/volumetrictrail.gr2';
/**
 * A faction-insert lookup that never arrives should not hold a build for ever.
 */
const FILE_INDEX_WAIT_MS = 15000;
/**
 * A lazy catalog learns a name is unknown when its record file is missing.
 */
const MISSING_SOF_RECORD = /spaceobjectfactory\/(hulls|factions|races)\/([^/]+)\.black: 404/u;

/**
 * A device resource or effect the page may tear down. Runtime ca8b32652 renamed Destroy() to Destruct(); some have neither.
 */
interface Teardownable {
  Destruct?(managed?: Set<unknown>): void;
  Destroy?(managed?: Set<unknown>): void;
}

/**
 * A ship's model values from SOF, with what SOF had to say about the build.
 */
export interface ShipBuild {
  readonly values: CjsModelValues;
  readonly diagnostics: unknown[];
  /**
   * The hull's class and size, for the ball's physics; null when SOF has no record for it.
   */
  readonly hull: Maybe<ShipHull>;
}

let sofReady: Maybe<Promise<EveSOF>> = null;
let buildQueue: Promise<unknown> = Promise.resolve();

/**
 * The shared SOF instance, registered and initialized on first use.
 *
 * @returns The SOF.
 */
function GetSof(): Promise<EveSOF> {
  sofReady ??= (async () => {
    const sof = await new EveSOF().Register({
      lazyData: { source: (path) => ResourceBytes(path), exists: (path) => FileExists(path) },
      // The host's object loader, so effect children are inlined as model values
      // the way Carbon's SOF inlines them, instead of emitted as EveChildRef.
      resources: {
        getObject: async (path) => {
          const read = CjsBlackFormat.read(await ResourceBytes(path), { emit: 'json' });
          return (read.root ?? read).object ?? null;
        }
      },
      volumetricTrailPath: VOLUMETRIC_TRAIL
    });
    await sof.InitializeAsync();
    return sof;
  })();
  return sofReady;
}

/**
 * Builds a ship's model values from DNA. Builds run one at a time: they share
 * one lazily growing SOF catalog.
 *
 * @param dna - SOF DNA.
 * @returns The model values and SOF's build diagnostics.
 */
export function BuildShipValues(dna: string): Promise<ShipBuild> {
  const run = buildQueue.then(async (): Promise<ShipBuild> => {
    const sof = await GetSof();
    await Promise.race([FilesReady(), new Promise((done) => setTimeout(done, FILE_INDEX_WAIT_MS))]);
    let values: CjsModelValues;
    try {
      const inspection = await sof.InspectDna(dna);
      if (!inspection.valid) throw new Error(`DNA "${dna}" is not buildable: ${inspection.error}`);
      values = await sof.BuildValuesFromDNAAsync(dna);
    } catch (error) {
      const missing = MISSING_SOF_RECORD.exec(ErrorText(error));
      if (missing) throw new Error(`unknown ${missing[1].slice(0, -1)} "${missing[2]}" in "${dna}"; search_hulls lists valid ${missing[1]}`, { cause: error });
      throw error;
    }
    const diagnostics = (await sof.GetBuildDiagnostics()) ?? [];
    return { values, diagnostics, hull: await ReadHull(sof, dna) };
  });
  buildQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * The SOF record of a DNA's hull, reduced to what the ball's physics use.
 *
 * @param sof - The SOF.
 * @param dna - SOF DNA.
 * @returns The hull's category and bounding radius, or null when it cannot be read.
 */
async function ReadHull(sof: EveSOF, dna: string): Promise<Maybe<ShipHull>> {
  try {
    const data = await sof.GetHullData(dna.split(':')[0]);
    if (!data) return null;
    const radius = data.boundingSphere?.[3];
    return { category: data.category ?? null, radius: typeof radius === 'number' ? radius : null };
  } catch (error) {
    console.warn(`hull data for "${dna}" is unavailable (${ErrorText(error)}); the ship flies with default physics`);
    return null;
  }
}

/**
 * Turns model values into a live ship and starts its controllers (unstarted,
 * no state machine runs, so heat and state effects never show). A failed
 * hydration retires whatever device resources it had already registered.
 *
 * @param values - SOF model values.
 * @returns The live ship.
 */
export function HydrateShip(values: CjsModelValues): EveShip2 {
  // EveShip2.UpdateSyncronous fills speed from the translation curve's velocity every frame; unset, boosters stay dark.
  return HydrateSofObject<EveShip2>(values, (ship) => {
    ship.speed = new TriFloat();
  });
}

/**
 * Hydrates SOF (or any model) values into a live object, runs `prepare`, then starts its controllers; a failed
 * hydration tears down the resources it registered. Stations and stargates use it as is.
 *
 * @param values - The model values.
 * @param prepare - Binds what must exist before the controllers start.
 * @returns The object.
 */
/**
 * The fixed curves a static SOF object sits on: the location dressing's stations and gates, and the scene's objects.
 */
export interface StaticCurves {
  readonly translation: Tr2TranslationAdapter;
  readonly rotation: Tr2RotationAdapter;
}

/**
 * New fixed curves at the origin, unrotated.
 *
 * @returns The curves.
 */
export function CreateStaticCurves(): StaticCurves {
  return { translation: new Tr2TranslationAdapter(), rotation: new Tr2RotationAdapter() };
}

/**
 * Places fixed curves: a move needs no rebuild.
 *
 * @param curves - The curves.
 * @param position - Scene metres.
 * @param rotation - The orientation.
 */
export function PlaceStatic(curves: StaticCurves, position: ArrayLike<number>, rotation: Quat): void {
  vec3.set(curves.translation.value, position[0], position[1], position[2]);
  quat.copy(curves.rotation.value, rotation);
}

export interface StaticObjectBuild {
  /**
   * The hydrated object on its curves, or null when it was built to values only.
   */
  readonly object: Maybe<EveSpaceObject2>;
  /**
   * The SOF hull's bounding radius, else the values' bounding sphere.
   */
  readonly sofRadius: Maybe<number>;
  /**
   * The bounding sphere's centre in the object's frame, when the values give one.
   */
  readonly sofCentre: Maybe<SceneVector>;
  /**
   * The `dynamic:/` resources drawn as a stand-in.
   */
  readonly dynamic: string[];
  readonly diagnostics: unknown[];
}

/**
 * Runs a SOF hydration with the runtime's audio seams detached (PageAudio.Detached), so the object's own emitters stay
 * headless.
 */
export type DetachAudio = <T>(build: () => T) => T;

/**
 * The one static SOF path: builds an object's values from its DNA (queued with the ship builds), blanks its
 * `dynamic:/` video screens, and hydrates it on fixed curves when `hydrate()` (asked after the build) says so.
 *
 * @param input - The DNA, the curves, and whether to hydrate.
 * @param input.dna - SOF DNA.
 * @param input.curves - The fixed curves to bind.
 * @param input.hydrate - Asked once the values are built: false builds to values only (no renderer, or retired).
 * @param input.detachAudio - Wraps the hydration.
 * @returns The build.
 */
export async function BuildStaticObject(input: { readonly dna: string; readonly curves: StaticCurves; readonly hydrate: () => boolean; readonly detachAudio: DetachAudio }): Promise<StaticObjectBuild> {
  const { dna, curves, hydrate, detachAudio } = input;
  const build = await BuildShipValues(dna);
  const dynamic = PatchDynamicResources(build.values);
  const sphere = build.values['boundingSphereRadius'];
  const centre = build.values['boundingSphereCenter'];
  const sofRadius = build.hull?.radius ?? (typeof sphere === 'number' ? sphere : null);
  const sofCentre = ArrayLike3(centre);
  let object: Maybe<EveSpaceObject2> = null;
  if (hydrate()) {
    object = detachAudio(() =>
      HydrateSofObject<EveSpaceObject2>(build.values, (built) => {
        built.translationCurve = curves.translation;
        built.rotationCurve = curves.rotation;
      })
    );
  }
  return { object, sofRadius, sofCentre, dynamic, diagnostics: build.diagnostics };
}

function ArrayLike3(value: unknown): Maybe<SceneVector> {
  const list = value as ArrayLike<unknown> | null;
  return list && typeof list === 'object' && list.length === 3 && [0, 1, 2].every((index) => typeof list[index] === 'number') ? [Number(list[0]), Number(list[1]), Number(list[2])] : null;
}

export function HydrateSofObject<T extends { StartControllers(): void }>(values: CjsModelValues, prepare?: (object: T) => void): T {
  const before = new Set(TriDevice.GetResourcesRegistered());
  try {
    const object = CjsSchema.from<T>(values._type, values);
    prepare?.(object);
    object.StartControllers();
    return object;
  } catch (error) {
    // Cleanup must never replace the hydration error, which is the one worth reading.
    const managed = new Set<unknown>(TriDevice.GetResourcesRegistered());
    for (const resource of TriDevice.GetResourcesRegistered()) {
      if (before.has(resource) || !IsShipResource(resource)) continue;
      try {
        Teardown(resource, managed);
      } catch (cleanupError) {
        console.warn(`cleanup after a failed hydration: ${ErrorText(cleanupError)}`);
      }
    }
    throw error;
  }
}

/**
 * Destroys the ship-owned resources of `roots` that no ship in `retained`
 * still reaches. Collect first: destroying a mesh clears shared references.
 * It retires any SOF or planet graph, not only ships.
 *
 * @param roots - The ships being removed.
 * @param retained - The ships that stay.
 */
export function RetireShips(roots: object[], retained: object[]): void {
  const keep = new Set<object>();
  const candidates = new Set<Teardownable>();
  for (const root of retained) EachModel(root, (model) => keep.add(model));
  for (const root of roots) {
    EachModel(root, (model) => {
      if (IsShipResource(model)) candidates.add(model);
    });
  }

  // Pin and impostor effects have explicit JavaScript lifetimes but no device registration.
  // Iterate a copy: the loop adds those effects to the set it walks.
  for (const model of Array.from(candidates)) {
    const impostors = CjsSchema.cast(model, Tr2ImpostorManager);
    const pin = CjsSchema.cast(model, EveSpherePin);
    const effects = impostors ? [...(impostors._ownedEffects ?? []), impostors.effect] : [...(pin?._ownedEffects ?? []), pin?.pinEffect, pin?.pickEffect];
    for (const effect of effects) if (effect) candidates.add(effect);
  }

  const managed = new Set<unknown>([...keep, ...candidates]);
  for (const model of candidates) {
    if (!keep.has(model)) Teardown(model, managed);
  }
}

/**
 * Runs a model's own teardown, whichever name it has.
 *
 * @param model - The resource or effect.
 * @param managed - Everything being torn down together, for the types that take it.
 */
function Teardown(model: Teardownable, managed: Set<unknown>): void {
  const teardown = model.Destruct ?? model.Destroy;
  if (typeof teardown !== 'function') return;
  if (TakesManagedSet(model)) teardown.call(model, managed);
  else teardown.call(model);
}

/**
 * Visits a graph's root and every object reachable from it, once each.
 *
 * @param root - The graph root.
 * @param visit - Called with each object.
 */
function EachModel(root: object, visit: (model: object) => void): void {
  visit(root);
  for (const model of blue.FindAllReferences(root).keys()) visit(model);
}

const SHIP_RESOURCE_TYPES = [Tr2GrannyPrimitiveSet, Tr2ParticleSystem, Tr2InstancedMesh, Tr2RuntimeInstanceData, Tr2DirectInstanceData, EveChildBehaviorSystem, Tr2ImpostorManager, EveSpherePin, EveChildLineSet, Tr2CurveLineSet];
const MANAGED_SET_TYPES = [EveChildLineSet, EveSpherePin, Tr2ImpostorManager];

/**
 * Whether a model is a ship-owned resource the page retires.
 *
 * @param model - Any object in a ship graph.
 * @returns True for the resource types a removed ship releases.
 */
function IsShipResource(model: unknown): model is Teardownable {
  return SHIP_RESOURCE_TYPES.some((type) => CjsSchema.cast(model, type));
}

/**
 * Whether a model's teardown takes the set of everything being torn down.
 *
 * @param model - The resource.
 * @returns True for the types whose teardown takes the managed set.
 */
function TakesManagedSet(model: unknown): boolean {
  return MANAGED_SET_TYPES.some((type) => CjsSchema.cast(model, type));
}
