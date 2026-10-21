/**
 * Ships: SOF values from DNA, hydration into live EveShip2 graphs, placement
 * curves, and retirement of a removed ship's device resources.
 */

import { FileExists, FilesReady, ResourceBytes } from "./resources.js";
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
  vec3
} from "./runtime.js";

/** The client's one generic booster trail mesh (Carbon leaves the setting empty for the client to fill). */
const VOLUMETRIC_TRAIL = "res:/dx9/model/ship/booster/volumetrictrail.gr2";
/** A faction-insert lookup that never arrives should not hold a build for ever. */
const FILE_INDEX_WAIT_MS = 15000;

let sofReady = null;
let buildQueue = Promise.resolve();

function GetSof()
{
  sofReady ??= (async () =>
  {
    const sof = await new EveSOF().Register({
      lazyData: { source: path => ResourceBytes(path), exists: path => FileExists(path) },
      // The host's object loader, so effect children are inlined as model values
      // the way Carbon's SOF inlines them, instead of emitted as EveChildRef.
      resources: {
        getObject: async path =>
        {
          const read = CjsBlackFormat.read(await ResourceBytes(path), { emit: "json" });
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
 * @param {string} dna SOF DNA.
 * @returns {Promise<{ values: object, diagnostics: unknown[] }>}
 */
export function BuildShipValues(dna)
{
  const run = buildQueue.then(async () =>
  {
    const sof = await GetSof();
    await Promise.race([ FilesReady(), new Promise(done => setTimeout(done, FILE_INDEX_WAIT_MS)) ]);
    let values;
    try
    {
      const inspection = await sof.InspectDna(dna);
      if (!inspection.valid) throw new Error(`DNA "${dna}" is not buildable: ${inspection.error}`);
      values = await sof.BuildValuesFromDNAAsync(dna);
    }
    catch (error)
    {
      // A lazy catalog learns a name is unknown when its record file is missing.
      const missing = /spaceobjectfactory\/(hulls|factions|races)\/([^/]+)\.black: 404/u.exec(error.message);
      if (missing) throw new Error(`unknown ${missing[1].slice(0, -1)} "${missing[2]}" in "${dna}"; search_hulls lists valid ${missing[1]}`);
      throw error;
    }
    const diagnostics = (await sof.GetBuildDiagnostics()) ?? [];
    return { values, diagnostics };
  });
  buildQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Turns model values into a live ship and starts its controllers (unstarted,
 * no state machine runs, so heat and state effects never show). A failed
 * hydration retires whatever device resources it had already registered.
 */
export function HydrateShip(values)
{
  const before = new Set(TriDevice.GetResourcesRegistered());
  try
  {
    const ship = CjsSchema.from(values._type, values);
    // The client binds m_speed to the ball's velocity; unbound, boosters stay dark.
    ship.speed = new TriFloat();
    ship.StartControllers();
    return ship;
  }
  catch (error)
  {
    const managed = new Set(TriDevice.GetResourcesRegistered());
    for (const resource of TriDevice.GetResourcesRegistered())
    {
      if (before.has(resource) || !IsShipResource(resource)) continue;
      if (TakesManagedSet(resource)) resource.Destroy(managed);
      else resource.Destroy();
    }
    throw error;
  }
}

/**
 * Destroys the ship-owned resources of `roots` that no ship in `retained`
 * still reaches. Collect first: destroying a mesh clears shared references.
 */
export function RetireShips(roots, retained)
{
  const keep = new Set();
  const candidates = new Set();
  for (const root of retained) EachModel(root, model => { keep.add(model); });
  for (const root of roots) EachModel(root, model => { if (IsShipResource(model)) candidates.add(model); });

  // Pin and impostor effects have explicit JavaScript lifetimes but no device registration.
  for (const model of [ ...candidates ])
  {
    if (CjsSchema.cast(model, Tr2ImpostorManager))
    {
      for (const effect of model._ownedEffects) candidates.add(effect);
      if (model.effect) candidates.add(model.effect);
    }
    else if (CjsSchema.cast(model, EveSpherePin))
    {
      for (const effect of model._ownedEffects) candidates.add(effect);
      if (model.pinEffect) candidates.add(model.pinEffect);
      if (model.pickEffect) candidates.add(model.pickEffect);
    }
  }

  const managed = new Set([ ...keep, ...candidates ]);
  for (const model of candidates)
  {
    if (keep.has(model)) continue;
    if (TakesManagedSet(model)) model.Destroy(managed);
    else model.Destroy();
  }
}

/** A position that holds still: the ship's ball stand-in until movement arrives. */
export class StaticPosition extends ITriVectorFunction
{
  value = vec3.create();

  constructor(position = [ 0, 0, 0 ])
  {
    super();
    this.Set(position);
  }

  Set(position)
  {
    vec3.set(this.value, position[0], position[1], position[2]);
  }

  Update__Ticks(_time, out) { return vec3.copy(out, this.value); }
  GetValueAt__Ticks(_time, out) { return vec3.copy(out, this.value); }
  GetValueDotAt__Ticks(_time, out) { return vec3.set(out, 0, 0, 0); }
  GetValueDoubleDotAt__Ticks(_time, out) { return vec3.set(out, 0, 0, 0); }
}

/** A fixed orientation from [yaw, pitch, roll] degrees: yaw about +Y, then pitch about +X, then roll about +Z. */
export class StaticRotation extends ITriQuaternionFunction
{
  value = quat.create();

  constructor(rotation = [ 0, 0, 0 ])
  {
    super();
    this.Set(rotation);
  }

  Set([ yaw, pitch, roll ])
  {
    const radians = Math.PI / 180;
    const yawQ = quat.setAxisAngle(quat.create(), [ 0, 1, 0 ], yaw * radians);
    const pitchQ = quat.setAxisAngle(quat.create(), [ 1, 0, 0 ], pitch * radians);
    const rollQ = quat.setAxisAngle(quat.create(), [ 0, 0, 1 ], roll * radians);
    quat.multiply(this.value, yawQ, quat.multiply(this.value, pitchQ, rollQ));
  }

  Update__Ticks(_time, out) { return quat.copy(out, this.value); }
  GetValueAt__Ticks(_time, out) { return quat.copy(out, this.value); }
}

/** Places a live ship at a document ship's position and rotation. */
export function PlaceShip(ship, { position, rotation })
{
  if (ship.translationCurve instanceof StaticPosition) ship.translationCurve.Set(position);
  else ship.translationCurve = new StaticPosition(position);
  if (ship.rotationCurve instanceof StaticRotation) ship.rotationCurve.Set(rotation);
  else ship.rotationCurve = new StaticRotation(rotation);
}

/** Visits a graph's root and every object reachable from it, once each. */
function EachModel(root, visit)
{
  visit(root);
  for (const model of blue.FindAllReferences(root).keys()) visit(model);
}

function IsShipResource(model)
{
  return CjsSchema.cast(model, Tr2GrannyPrimitiveSet) || CjsSchema.cast(model, Tr2ParticleSystem) || CjsSchema.cast(model, Tr2InstancedMesh)
    || CjsSchema.cast(model, Tr2RuntimeInstanceData) || CjsSchema.cast(model, Tr2DirectInstanceData) || CjsSchema.cast(model, EveChildBehaviorSystem)
    || CjsSchema.cast(model, Tr2ImpostorManager) || CjsSchema.cast(model, EveSpherePin) || CjsSchema.cast(model, EveChildLineSet) || CjsSchema.cast(model, Tr2CurveLineSet);
}

function TakesManagedSet(model)
{
  return CjsSchema.cast(model, EveChildLineSet) || CjsSchema.cast(model, EveSpherePin) || CjsSchema.cast(model, Tr2ImpostorManager);
}
