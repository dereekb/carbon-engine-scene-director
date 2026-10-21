/**
 * The director owns the scene document and keeps the live scene matching it.
 * Every tool that edits the scene produces a new normalized document; the
 * director diffs it against the current one and does only the work the diff
 * names: build added ships, rebuild ships whose DNA changed, move ships whose
 * placement changed, retire removed ones.
 *
 * Without a renderer (no WebGPU), the director still validates documents and
 * builds each ship's SOF values, so DNA mistakes surface; it just has nothing
 * to draw into.
 */

import { applySceneOperations, createEmptyScene, diffScenes, normalizeScene, SceneError } from "../shared/scene.js";
import { EncodePng } from "./engine.js";
import { quat, vec3 } from "./runtime.js";
import { BuildShipValues, HydrateShip, PlaceShip, RetireShips } from "./ships.js";
import { CURRENT_KEY } from "./store.js";

/** Radius assumed for a ship that is not built yet, for framing and distances. */
const UNBUILT_RADIUS = 100;

export class Director
{
  /**
   * @param {object} options
   * @param {import("./engine.js").Engine|null} options.engine
   * @param {Error|null} options.engineError Why there is no engine.
   * @param {import("./store.js").SceneStore} options.store
   * @param {() => void} [options.onChange] Called after any visible change.
   */
  constructor({ engine, engineError, store, onChange = () => {} })
  {
    this.engine = engine;
    this.engineError = engineError;
    this.store = store;
    this.scene = null;
    this.live = new Map();
    this._onChange = onChange;
    this._queue = Promise.resolve();
  }

  /** Tool handlers by name, for the hub link. */
  Handlers()
  {
    return {
      load_scene: ({ scene }) => this.Load(scene),
      get_scene: () => this.scene,
      patch_scene: ({ operations }) => this._Serialize(() => this._Apply(applySceneOperations(this._Current(), operations))),
      save_scene: ({ name }) => this.Save(name),
      list_scenes: () => this.store.List(),
      open_scene: ({ name }) => this.Open(name),
      delete_scene: async ({ name }) => ({ deleted: await this.store.Delete(RequireName(name)), name }),
      get_state: () => this.State(),
      screenshot: ({ maxWidth }) => this.Screenshot(maxWidth),
      frame_camera: args => this.FrameCamera(args)
    };
  }

  /** Replaces the scene with a document. */
  Load(input)
  {
    return this._Serialize(() => this._Apply(normalizeScene(input)));
  }

  async Save(name)
  {
    const scene = this._Current();
    const key = RequireName(name ?? scene.name);
    if (key === CURRENT_KEY) throw new Error(`"${CURRENT_KEY}" is reserved`);
    await this.store.Put(key, { ...scene, name: key });
    return { saved: key, ships: scene.ships.length };
  }

  async Open(name)
  {
    const scene = await this.store.Get(RequireName(name));
    if (!scene) throw new Error(`no saved scene "${name}"; list_scenes shows what is saved`);
    return this.Load(scene);
  }

  State()
  {
    const ships = (this.scene?.ships ?? []).map(doc => this._ShipState(doc));
    const distances = [];
    for (let a = 0; a < ships.length; a++)
    {
      for (let b = a + 1; b < ships.length; b++)
      {
        const centre = vec3.distance(ships[a].worldPosition, ships[b].worldPosition);
        distances.push({
          between: [ ships[a].id, ships[b].id ],
          centreToCentre: Math.round(centre),
          surfaceToSurface: Math.round(Math.max(0, centre - ships[a].radius - ships[b].radius))
        });
      }
    }
    return {
      renderer: this.engine ? { available: true, ...this.engine.Stats() } : { available: false, reason: this.engineError?.message ?? "not started" },
      scene: this.scene ? { name: this.scene.name, universe: this.scene.environment.universe, ships: this.scene.ships.length } : null,
      camera: this.engine?.camera.Get() ?? null,
      ships,
      distances
    };
  }

  async Screenshot(maxWidth = 1280)
  {
    if (!this.engine) throw new Error(`no renderer: ${this.engineError?.message ?? "not started"}`);
    const frame = await this.engine.Capture();
    const { png, width, height } = await EncodePng(frame, Math.max(64, Number(maxWidth) || 1280));
    return { image: { data: ToBase64(png), mimeType: "image/png" }, width, height, rendered: [ frame.width, frame.height ] };
  }

  /** Points the camera without editing the document unless `persist`. */
  async FrameCamera({ target, yaw, pitch, distance, persist = false } = {})
  {
    const camera = { ...this._Current().camera, target: target ?? null };
    if (Number.isFinite(yaw)) camera.yaw = yaw;
    if (Number.isFinite(pitch)) camera.pitch = pitch;
    camera.distance = Number.isFinite(distance) ? distance : null;
    if (persist) return this._Serialize(() => this._Apply(applySceneOperations(this._Current(), [ { op: "set_camera", camera } ])));
    if (camera.target && !this.live.has(camera.target)) throw new Error(`no ship "${camera.target}"`);
    this._ApplyCamera(camera);
    return { camera: this.engine?.camera.Get() ?? null };
  }

  _Current()
  {
    return this.scene ?? createEmptyScene();
  }

  /** Scene edits run one at a time, in arrival order. */
  _Serialize(action)
  {
    const run = this._queue.then(action);
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _Apply({ scene, warnings })
  {
    // Changing the universe re-creates the scene's environment, which is
    // initialized with the device; a reload is the reliable way to do it.
    if (this.engine && this.engine.universe !== scene.environment.universe)
    {
      await this.store.Put(CURRENT_KEY, scene);
      setTimeout(() => location.reload(), 200);
      return { reloading: true, note: "The environment changed, so the viewer is reloading with the new scene. Call get_state in a few seconds.", warnings };
    }

    const diff = diffScenes(this.scene, scene);
    // A ship that failed before is retried whenever the scene is applied again.
    const changed = new Set([ ...diff.rebuilt, ...diff.added ].map(doc => doc.id));
    const retried = scene.ships.filter(doc => !changed.has(doc.id) && (this.live.get(doc.id)?.status ?? "failed") === "failed");
    const builds = [ ...diff.rebuilt, ...diff.added, ...retried ];
    for (const doc of [ ...diff.removed, ...diff.rebuilt ]) this._Retire(doc.id);
    this.scene = scene;
    await this.store.Put(CURRENT_KEY, scene);

    for (const doc of diff.moved)
    {
      const entry = this.live.get(doc.id);
      if (entry?.ship) PlaceShip(entry.ship, doc);
    }
    for (const doc of builds) this.live.set(doc.id, { id: doc.id, dna: doc.dna, status: "queued", ship: null, error: null, diagnostics: [] });
    this._onChange();

    // Builds are serialized by SOF anyway; awaiting them in order keeps the report in document order.
    for (const doc of builds) await this._Build(doc);

    this._ApplyCamera(scene.camera);
    this._onChange();
    return {
      scene,
      warnings,
      ships: scene.ships.map(doc => this._ShipReport(doc.id)),
      changes: { added: diff.added.length, rebuilt: diff.rebuilt.length, retried: retried.length, moved: diff.moved.length, removed: diff.removed.length }
    };
  }

  async _Build(doc)
  {
    const entry = this.live.get(doc.id);
    entry.status = "building";
    this._onChange();
    try
    {
      const { values, diagnostics } = await BuildShipValues(doc.dna);
      entry.diagnostics = diagnostics.slice(0, 10).map(item => (typeof item === "string" ? item : JSON.stringify(item)));
      if (this.live.get(doc.id) !== entry) return;
      if (!this.engine)
      {
        entry.status = "validated";
        return;
      }
      const ship = HydrateShip(values);
      PlaceShip(ship, doc);
      this.engine.AddShip(ship);
      entry.ship = ship;
      entry.status = "ready";
    }
    catch (error)
    {
      entry.status = "failed";
      entry.error = error.message;
      console.error(`ship ${doc.id} (${doc.dna}) failed: ${error.message}`);
    }
    finally
    {
      this._onChange();
    }
  }

  _Retire(id)
  {
    const entry = this.live.get(id);
    this.live.delete(id);
    if (!entry?.ship) return;
    this.engine.RemoveShip(entry.ship);
    RetireShips([ entry.ship ], [ ...this.live.values() ].map(other => other.ship).filter(Boolean));
  }

  _ApplyCamera(camera)
  {
    const view = this.engine?.camera;
    if (!view) return;
    view.Set({ yaw: camera.yaw, pitch: camera.pitch, fov: camera.fov });
    const docs = camera.target ? this.scene.ships.filter(doc => doc.id === camera.target) : this.scene.ships;
    const spheres = docs.map(doc => this._WorldSphere(doc));
    if (!spheres.length) return view.Set({ focus: [ 0, 0, 0 ], distance: camera.distance ?? 1000 });

    const centre = vec3.create();
    for (const sphere of spheres) vec3.add(centre, centre, sphere.centre);
    vec3.scale(centre, centre, 1 / spheres.length);
    const radius = Math.max(...spheres.map(sphere => vec3.distance(centre, sphere.centre) + sphere.radius));
    if (camera.distance) view.Set({ focus: centre, distance: camera.distance });
    else view.Fit(centre, radius);
  }

  /** A ship's bounding sphere in world space; the document's placement when it is not built. */
  _WorldSphere(doc)
  {
    const ship = this.live.get(doc.id)?.ship;
    const position = vec3.fromValues(...doc.position);
    if (!ship) return { centre: position, radius: UNBUILT_RADIUS };
    const centre = vec3.transformQuat(vec3.create(), ship.boundingSphereCenter, ship.rotationCurve?.value ?? quat.create());
    return { centre: vec3.add(centre, centre, position), radius: ship.boundingSphereRadius || UNBUILT_RADIUS };
  }

  _ShipState(doc)
  {
    const sphere = this._WorldSphere(doc);
    return { ...this._ShipReport(doc.id), name: doc.name, team: doc.team, worldPosition: Array.from(sphere.centre).map(Math.round), radius: Math.round(sphere.radius) };
  }

  _ShipReport(id)
  {
    const entry = this.live.get(id);
    if (!entry) return { id, status: "unknown" };
    return {
      id,
      dna: entry.dna,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.diagnostics.length ? { diagnostics: entry.diagnostics } : {})
    };
  }
}

function RequireName(name)
{
  if (typeof name !== "string" || !name.trim()) throw new SceneError([ "a scene name is required" ]);
  return name.trim();
}

function ToBase64(bytes)
{
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
