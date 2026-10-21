/**
 * Ships: SOF values from DNA, hydration into live EveShip2 graphs, placement
 * curves, and retirement of a removed ship's device resources.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneShip } from '@scene-director/scene';
import { ErrorText, FileExists, FilesReady, ResourceBytes } from './resources';
import {
  blue,
  CjsBlackFormat,
  CjsSchema,
  EveChildBehaviorSystem,
  EveChildLineSet,
  EveSOF,
  EveSpherePin,
  ITriQuaternionFunction,
  ITriVectorFunction,
  quat,
  Tr2CurveLineSet,
  Tr2DirectInstanceData,
  Tr2GrannyPrimitiveSet,
  Tr2ImpostorManager,
  Tr2InstancedMesh,
  Tr2ParticleSystem,
  Tr2RuntimeInstanceData,
  TriDevice,
  TriFloat,
  vec3,
  type CjsModelValues,
  type EveShip2,
  type Quat,
  type Vec3
} from './runtime';

/**
 * The client's one generic booster trail mesh (Carbon leaves the setting empty for the client to fill).
 */
const VOLUMETRIC_TRAIL = 'res:/dx9/model/ship/booster/volumetrictrail.gr2';
/**
 * A faction-insert lookup that never arrives should not hold a build for ever.
 */
const FILE_INDEX_WAIT_MS = 15000;
const DEGREES = Math.PI / 180;
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
    return { values, diagnostics };
  });
  buildQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
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
  const before = new Set(TriDevice.GetResourcesRegistered());
  try {
    const ship = CjsSchema.from<EveShip2>(values._type, values);
    // The client binds m_speed to the ball's velocity; unbound, boosters stay dark.
    ship.speed = new TriFloat();
    ship.StartControllers();
    return ship;
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
 * A position that holds still: the ship's ball stand-in until movement arrives.
 */
export class StaticPosition extends ITriVectorFunction {
  readonly value: Vec3 = vec3.create();

  constructor(position: ArrayLike<number> = [0, 0, 0]) {
    super();
    this.Set(position);
  }

  Set(position: ArrayLike<number>): void {
    vec3.set(this.value, position[0], position[1], position[2]);
  }

  // The base *__Ticks methods pass arguments in the opposite order from their docs, so each one is overridden.
  override Update__Ticks(_time: number, out: Vec3): Vec3 {
    return vec3.copy(out, this.value);
  }

  override GetValueAt__Ticks(_time: number, out: Vec3): Vec3 {
    return vec3.copy(out, this.value);
  }

  override GetValueDotAt__Ticks(_time: number, out: Vec3): Vec3 {
    return vec3.set(out, 0, 0, 0);
  }

  override GetValueDoubleDotAt__Ticks(_time: number, out: Vec3): Vec3 {
    return vec3.set(out, 0, 0, 0);
  }
}

/**
 * A fixed orientation from [yaw, pitch, roll] degrees: yaw about +Y, then pitch about +X, then roll about +Z.
 */
export class StaticRotation extends ITriQuaternionFunction {
  readonly value: Quat = quat.create();

  constructor(rotation: ArrayLike<number> = [0, 0, 0]) {
    super();
    this.Set(rotation);
  }

  Set(rotation: ArrayLike<number>): void {
    const yawQ = quat.setAxisAngle(quat.create(), [0, 1, 0], rotation[0] * DEGREES);
    const pitchQ = quat.setAxisAngle(quat.create(), [1, 0, 0], rotation[1] * DEGREES);
    const rollQ = quat.setAxisAngle(quat.create(), [0, 0, 1], rotation[2] * DEGREES);
    quat.multiply(this.value, yawQ, quat.multiply(this.value, pitchQ, rollQ));
  }

  override Update__Ticks(_time: number, out: Quat): Quat {
    return quat.copy(out, this.value);
  }

  override GetValueAt__Ticks(_time: number, out: Quat): Quat {
    return quat.copy(out, this.value);
  }
}

/**
 * Places a live ship at a document ship's position and rotation.
 *
 * @param ship - The live ship.
 * @param placement - The document ship's position and rotation.
 */
export function PlaceShip(ship: EveShip2, { position, rotation }: Pick<SceneShip, 'position' | 'rotation'>): void {
  if (ship.translationCurve instanceof StaticPosition) ship.translationCurve.Set(position);
  else ship.translationCurve = new StaticPosition(position);
  if (ship.rotationCurve instanceof StaticRotation) ship.rotationCurve.Set(rotation);
  else ship.rotationCurve = new StaticRotation(rotation);
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
