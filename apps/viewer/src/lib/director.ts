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

import type { Maybe } from '@dereekb/util';
import { applySceneOperations, createEmptyScene, diffScenes, normalizeScene, SceneError, type NormalizedScene, type SceneCamera, type SceneDocument, type SceneShip } from '@scene-director/scene';
import { EncodePng, type Engine, type EngineStats } from './engine';
import type { ToolHandler } from './link';
import { ErrorText } from './resources';
import { quat, vec3, type EveShip2, type Vec3 } from './runtime';
import { BuildShipValues, HydrateShip, PlaceShip, RetireShips } from './ships';
import { CURRENT_KEY, type SceneStore } from './store';

/**
 * Radius assumed for a ship that is not built yet, for framing and distances.
 */
const UNBUILT_RADIUS = 100;
const DEFAULT_SCREENSHOT_WIDTH = 1280;

export type ShipStatus = 'queued' | 'building' | 'validated' | 'ready' | 'failed';

/**
 * A document ship's live counterpart.
 */
export interface LiveShip {
  readonly id: string;
  readonly dna: string;
  status: ShipStatus;
  ship: Maybe<EveShip2>;
  error: Maybe<string>;
  diagnostics: string[];
}

export interface ShipReport {
  readonly id: string;
  readonly dna?: string;
  readonly status: ShipStatus | 'unknown';
  readonly error?: string;
  readonly diagnostics?: string[];
}

export interface DirectorOptions {
  readonly engine: Maybe<Engine>;
  /**
   * Why there is no engine.
   */
  readonly engineError: Maybe<Error>;
  readonly store: SceneStore;
  /**
   * Called after any visible change.
   */
  readonly onChange?: () => void;
}

interface WorldSphere {
  readonly centre: Vec3;
  readonly radius: number;
}

interface FrameCameraArgs {
  readonly target?: Maybe<string>;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly distance?: number;
  readonly persist?: boolean;
}

export class Director {
  readonly engine: Maybe<Engine>;
  readonly engineError: Maybe<Error>;
  readonly store: SceneStore;
  readonly live = new Map<string, LiveShip>();
  scene: Maybe<SceneDocument> = null;
  private readonly onChange: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ engine, engineError, store, onChange = () => undefined }: DirectorOptions) {
    this.engine = engine;
    this.engineError = engineError;
    this.store = store;
    this.onChange = onChange;
  }

  /**
   * Tool handlers by name, for the hub link.
   */
  Handlers(): Record<string, ToolHandler> {
    return {
      load_scene: ({ scene }) => this.Load(scene),
      get_scene: () => this.scene,
      patch_scene: ({ operations }) => this.Serialize(() => this.Apply(applySceneOperations(this.Current(), operations))),
      save_scene: ({ name }) => this.Save(name),
      list_scenes: () => this.store.List(),
      open_scene: ({ name }) => this.Open(name),
      delete_scene: async ({ name }) => ({ deleted: await this.store.Delete(RequireName(name)), name }),
      get_state: () => this.State(),
      screenshot: ({ maxWidth }) => this.Screenshot(maxWidth),
      frame_camera: (args) => this.FrameCamera(args as FrameCameraArgs)
    };
  }

  /**
   * Replaces the scene with a document.
   */
  Load(input: unknown): Promise<unknown> {
    return this.Serialize(() => this.Apply(normalizeScene(input)));
  }

  async Save(name: unknown): Promise<{ saved: string; ships: number }> {
    const scene = this.Current();
    const key = RequireName(name ?? scene.name);
    if (key === CURRENT_KEY) throw new Error(`"${CURRENT_KEY}" is reserved`);
    await this.store.Put(key, { ...scene, name: key });
    return { saved: key, ships: scene.ships.length };
  }

  async Open(name: unknown): Promise<unknown> {
    const key = RequireName(name);
    const scene = await this.store.Get(key);
    if (!scene) throw new Error(`no saved scene "${key}"; list_scenes shows what is saved`);
    return this.Load(scene);
  }

  State(): object {
    const ships = (this.scene?.ships ?? []).map((doc) => this.ShipState(doc));
    const distances = [];
    for (let a = 0; a < ships.length; a++) {
      for (let b = a + 1; b < ships.length; b++) {
        const centre = vec3.distance(ships[a].worldPosition, ships[b].worldPosition);
        distances.push({
          between: [ships[a].id, ships[b].id],
          centreToCentre: Math.round(centre),
          surfaceToSurface: Math.round(Math.max(0, centre - ships[a].radius - ships[b].radius))
        });
      }
    }
    const renderer: ({ available: true } & EngineStats) | { available: false; reason: string } = this.engine ? { available: true, ...this.engine.Stats() } : { available: false, reason: this.engineError?.message ?? 'not started' };
    return {
      renderer,
      scene: this.scene ? { name: this.scene.name, universe: this.scene.environment.universe, ships: this.scene.ships.length } : null,
      camera: this.engine?.camera.Get() ?? null,
      ships,
      distances
    };
  }

  async Screenshot(maxWidth: unknown): Promise<object> {
    if (!this.engine) throw new Error(`no renderer: ${this.engineError?.message ?? 'not started'}`);
    const frame = await this.engine.Capture();
    const { png, width, height } = await EncodePng(frame, Math.max(64, Number(maxWidth) || DEFAULT_SCREENSHOT_WIDTH));
    return { image: { data: ToBase64(png), mimeType: 'image/png' }, width, height, rendered: [frame.width, frame.height] };
  }

  /**
   * Points the camera without editing the document unless `persist`.
   */
  async FrameCamera({ target, yaw, pitch, distance, persist = false }: FrameCameraArgs = {}): Promise<unknown> {
    const camera: SceneCamera = { ...this.Current().camera, target: target ?? null };
    if (IsFiniteNumber(yaw)) camera.yaw = yaw;
    if (IsFiniteNumber(pitch)) camera.pitch = pitch;
    camera.distance = IsFiniteNumber(distance) ? distance : null;
    if (persist) return this.Serialize(() => this.Apply(applySceneOperations(this.Current(), [{ op: 'set_camera', camera }])));
    if (camera.target && !this.live.has(camera.target)) throw new Error(`no ship "${camera.target}"`);
    this.ApplyCamera(camera);
    return { camera: this.engine?.camera.Get() ?? null };
  }

  private Current(): SceneDocument {
    return this.scene ?? createEmptyScene();
  }

  /**
   * Scene edits run one at a time, in arrival order.
   */
  private Serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async Apply({ scene, warnings }: NormalizedScene): Promise<object> {
    // Changing the universe re-creates the scene's environment, which is
    // initialized with the device; a reload is the reliable way to do it.
    if (this.engine && this.engine.universe !== scene.environment.universe) {
      await this.store.Put(CURRENT_KEY, scene);
      setTimeout(() => location.reload(), 200);
      return { reloading: true, note: 'The environment changed, so the viewer is reloading with the new scene. Call get_state in a few seconds.', warnings };
    }

    const diff = diffScenes(this.scene, scene);
    // A ship that failed before is retried whenever the scene is applied again.
    const changed = new Set([...diff.rebuilt, ...diff.added].map((doc) => doc.id));
    const retried = scene.ships.filter((doc) => !changed.has(doc.id) && (this.live.get(doc.id)?.status ?? 'failed') === 'failed');
    const builds = [...diff.rebuilt, ...diff.added, ...retried];
    for (const doc of [...diff.removed, ...diff.rebuilt]) this.Retire(doc.id);
    this.scene = scene;
    await this.store.Put(CURRENT_KEY, scene);

    for (const doc of diff.moved) {
      const entry = this.live.get(doc.id);
      if (entry?.ship) PlaceShip(entry.ship, doc);
    }
    for (const doc of builds) this.live.set(doc.id, { id: doc.id, dna: doc.dna, status: 'queued', ship: null, error: null, diagnostics: [] });
    this.onChange();

    // Builds are serialized by SOF anyway; awaiting them in order keeps the report in document order.
    for (const doc of builds) await this.Build(doc);

    this.ApplyCamera(scene.camera);
    this.onChange();
    return {
      scene,
      warnings,
      ships: scene.ships.map((doc) => this.ShipReport(doc.id)),
      changes: { added: diff.added.length, rebuilt: diff.rebuilt.length, retried: retried.length, moved: diff.moved.length, removed: diff.removed.length }
    };
  }

  private async Build(doc: SceneShip): Promise<void> {
    const entry = this.live.get(doc.id);
    if (!entry) return;
    entry.status = 'building';
    this.onChange();
    try {
      const { values, diagnostics } = await BuildShipValues(doc.dna);
      entry.diagnostics = diagnostics.slice(0, 10).map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      if (this.live.get(doc.id) !== entry) return;
      if (this.engine) {
        const ship = HydrateShip(values);
        PlaceShip(ship, doc);
        this.engine.AddShip(ship);
        entry.ship = ship;
        entry.status = 'ready';
      } else {
        entry.status = 'validated';
      }
    } catch (error) {
      entry.status = 'failed';
      entry.error = ErrorText(error);
      console.error(`ship ${doc.id} (${doc.dna}) failed: ${entry.error}`);
    } finally {
      this.onChange();
    }
  }

  private Retire(id: string): void {
    const entry = this.live.get(id);
    this.live.delete(id);
    if (!entry?.ship || !this.engine) return;
    this.engine.RemoveShip(entry.ship);
    const retained = [...this.live.values()].map((other) => other.ship).filter((ship): ship is EveShip2 => ship !== null);
    RetireShips([entry.ship], retained);
  }

  private ApplyCamera(camera: SceneCamera): void {
    const view = this.engine?.camera;
    if (!view) return;
    view.Set({ yaw: camera.yaw, pitch: camera.pitch, fov: camera.fov });
    const ships = this.scene?.ships ?? [];
    const docs = camera.target ? ships.filter((doc) => doc.id === camera.target) : ships;
    const spheres = docs.map((doc) => this.WorldSphere(doc));
    if (spheres.length) {
      const centre = vec3.create();
      for (const sphere of spheres) vec3.add(centre, centre, sphere.centre);
      vec3.scale(centre, centre, 1 / spheres.length);
      const radius = Math.max(...spheres.map((sphere) => vec3.distance(centre, sphere.centre) + sphere.radius));
      if (camera.distance) view.Set({ focus: centre, distance: camera.distance });
      else view.Fit(centre, radius);
    } else {
      view.Set({ focus: [0, 0, 0], distance: camera.distance ?? 1000 });
    }
  }

  /**
   * A ship's bounding sphere in world space; the document's placement when it is not built.
   */
  private WorldSphere(doc: SceneShip): WorldSphere {
    const ship = this.live.get(doc.id)?.ship;
    const position = vec3.fromValues(...doc.position);
    let sphere: WorldSphere;
    if (ship) {
      const centre = vec3.transformQuat(vec3.create(), ship.boundingSphereCenter, ship.rotationCurve?.value ?? quat.create());
      sphere = { centre: vec3.add(centre, centre, position), radius: ship.boundingSphereRadius || UNBUILT_RADIUS };
    } else {
      sphere = { centre: position, radius: UNBUILT_RADIUS };
    }
    return sphere;
  }

  private ShipState(doc: SceneShip): ShipReport & { name?: string; team?: string; worldPosition: number[]; radius: number } {
    const sphere = this.WorldSphere(doc);
    return { ...this.ShipReport(doc.id), name: doc.name, team: doc.team, worldPosition: Array.from(sphere.centre).map(Math.round), radius: Math.round(sphere.radius) };
  }

  private ShipReport(id: string): ShipReport {
    const entry = this.live.get(id);
    if (!entry) return { id, status: 'unknown' };
    return {
      id,
      dna: entry.dna,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.diagnostics.length ? { diagnostics: entry.diagnostics } : {})
    };
  }
}

/**
 * A trimmed, non-empty scene name.
 *
 * @param name - The candidate name.
 * @returns The trimmed name.
 * @throws {SceneError} When the name is missing or blank.
 */
function RequireName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new SceneError(['a scene name is required']);
  return name.trim();
}

/**
 * Narrows to a finite number.
 *
 * @param value - Anything.
 * @returns True when the value is a finite number.
 */
function IsFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Base64 of a byte array, in chunks small enough for String.fromCharCode.
 *
 * @param bytes - The bytes.
 * @returns Their base64 text.
 */
function ToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCodePoint(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
