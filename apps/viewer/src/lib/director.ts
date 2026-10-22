/**
 * The director owns the scene document and keeps the live scene matching it.
 * Every tool that edits the scene produces a new normalized document; the
 * director diffs it against the current one and does only the work the diff
 * names: build added ships, rebuild ships whose DNA changed, move ships whose
 * placement changed, retire removed ones.
 *
 * Every document ship also has a Destiny ball (destiny.ts), whether or not it is
 * built: the ball drives the built ship's curves, and get_state reports its
 * motion. Loading a document restarts every ship at rest at its placement; a
 * patch places only the ships whose placement it changes. Every ship flies at
 * its Ship-stats numbers (flight.ts): the hub's published values for its hull,
 * its `stats` and the max-skills pilot, retuned when the hub answers. Removing
 * a ship stops its followers.
 *
 * Without a renderer (no WebGPU), the director still validates documents and
 * builds each ship's SOF values, so DNA mistakes surface; it just has nothing
 * to draw into.
 */

import type { Maybe } from '@dereekb/util';
import { applySceneOperations, createEmptyScene, diffScenes, normalizeScene, normalizeShipOrder, SceneError, toFleetMemberships, toFleetReports, type NormalizedScene, type SceneCamera, type SceneDocument, type SceneShip, type ShipFleetMembership, type ShipOrder } from '@scene-director/scene';
import type { SceneClock } from './clock';
import { AttachShipCurves, DEFAULT_SHIP_PHYSICS, DocumentRotation, type DestinyWorld, type ShipHull, type ShipMotion } from './destiny';
import { HullStatsKey, HullStatsLookup, ResolveFlight, type HullStatsAnswer, type ShipFlight } from './flight';
import { EncodePng, type Engine, type EngineStats } from './engine';
import type { ToolHandler } from './link';
import { ErrorText } from './resources';
import { vec3, type EveShip2, type Vec3 } from './runtime';
import { BuildShipValues, HydrateShip, RetireShips } from './ships';
import { CURRENT_KEY, type SceneStore } from './store';

/**
 * Radius assumed for a ship that is not built yet, for framing and distances.
 */
const UNBUILT_RADIUS = 100;
const DEFAULT_SCREENSHOT_WIDTH = 1280;
/**
 * The class-values note while a ship's /ship-stats lookup is in flight.
 */
const LOOKUP_PENDING_NOTE = "waiting for the hub's /ship-stats answer";

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
  /**
   * The hull's class and size once the build has read them.
   */
  hull: Maybe<ShipHull>;
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
   * The Destiny simulation the ships fly in.
   */
  readonly world: DestinyWorld;
  /**
   * The clock the world and the renderer run on.
   */
  readonly clock: SceneClock;
  /**
   * Called after any visible change.
   */
  readonly onChange?: () => void;
  /**
   * The hub's /ship-stats lookups; a fresh one by default.
   */
  readonly hullStats?: HullStatsLookup;
}

interface ApplyOptions {
  /**
   * Put every kept ship back at rest at its placement (load_scene).
   */
  readonly restart?: boolean;
}

export interface OrderShipResult {
  readonly id: string;
  readonly order: ShipOrder;
  /**
   * The Destiny tick when the order was given; it applies at the next one.
   */
  readonly tick: number;
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
  readonly world: DestinyWorld;
  readonly clock: SceneClock;
  readonly live = new Map<string, LiveShip>();
  scene: Maybe<SceneDocument> = null;
  private readonly onChange: () => void;
  private readonly hullStats: HullStatsLookup;
  /**
   * What each ship flies with, as get_state reports it.
   */
  private readonly flights = new Map<string, ShipFlight>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ engine, engineError, store, world, clock, onChange = () => undefined, hullStats = new HullStatsLookup() }: DirectorOptions) {
    this.hullStats = hullStats;
    this.engine = engine;
    this.engineError = engineError;
    this.store = store;
    this.world = world;
    this.clock = clock;
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
      frame_camera: (args) => this.FrameCamera(args as FrameCameraArgs),
      order_ship: ({ id, order }) => this.OrderShip(id, order)
    };
  }

  /**
   * Replaces the scene with a document.
   */
  Load(input: unknown): Promise<unknown> {
    return this.Serialize(() => this.Apply(normalizeScene(input), { restart: true }));
  }

  /**
   * Gives a ship a live movement order; it applies at the next Destiny tick and is not saved.
   *
   * @param id - The ship id.
   * @param order - The order as JSON; a target must be another ship in the scene.
   * @returns The normalized order and the tick it was given at.
   * @throws {Error} When no ship has the id, or the order is invalid (a SceneError with every problem).
   */
  OrderShip(id: unknown, order: unknown): OrderShipResult {
    const ships = new Set((this.scene?.ships ?? []).map((doc) => doc.id));
    if (typeof id !== 'string' || !ships.has(id)) throw new Error(`no ship "${String(id)}"`);
    const normalized = normalizeShipOrder(order, { ships, self: id });
    if (!this.world.Order(id, normalized)) throw new Error(`ship "${id}" or its target has no Destiny ball`);
    return { id, order: normalized, tick: this.world.tick };
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
    const memberships = this.scene ? toFleetMemberships(this.scene) : new Map<string, ShipFleetMembership>();
    const ships = (this.scene?.ships ?? []).map((doc) => this.ShipState(doc, memberships.get(doc.id)));
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
      scene: this.scene ? { name: this.scene.name, universe: this.scene.environment.universe, ships: this.scene.ships.length, fleets: this.scene.fleets?.length ?? 0 } : null,
      camera: this.engine?.camera.Get() ?? null,
      environment: this.engine?.Environment() ?? null,
      simulation: { tick: this.world.tick, seconds: Math.round(this.clock.seconds * 100) / 100 },
      ships,
      distances,
      fleets: this.scene ? toFleetReports(this.scene) : []
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

  private async Apply({ scene, warnings }: NormalizedScene, { restart = false }: ApplyOptions = {}): Promise<object> {
    // Changing the universe re-creates the scene's environment, which is
    // initialized with the device; a reload is the reliable way to do it.
    if (this.engine && this.engine.universe !== scene.environment.universe) {
      await this.store.Put(CURRENT_KEY, scene);
      setTimeout(() => location.reload(), 200);
      return { reloading: true, note: 'The environment changed, so the viewer is reloading with the new scene. Call get_state in a few seconds.', warnings };
    }

    const previous = new Map((this.scene?.ships ?? []).map((doc) => [doc.id, doc]));
    const diff = diffScenes(this.scene, scene);
    // A ship that failed before is retried whenever the scene is applied again.
    const changed = new Set([...diff.rebuilt, ...diff.added].map((doc) => doc.id));
    const retried = scene.ships.filter((doc) => !changed.has(doc.id) && (this.live.get(doc.id)?.status ?? 'failed') === 'failed');
    const builds = [...diff.rebuilt, ...diff.added, ...retried];
    for (const doc of [...diff.removed, ...diff.rebuilt]) this.Retire(doc.id);
    const stopped: string[] = [];
    for (const doc of diff.removed) {
      stopped.push(...this.world.RemoveShip(doc.id));
      this.flights.delete(doc.id);
    }
    this.scene = scene;
    if (restart) this.hullStats.ForgetFailures();

    // Balls follow the document, not the renderer: a rebuilt ship keeps its ball and keeps flying. They are in place
    // before the store write, so an order arriving meanwhile always finds a ball for every document ship.
    for (const doc of scene.ships) {
      const before = previous.get(doc.id);
      if (!this.world.Curves(doc.id)) {
        const flight = this.Flight(doc, this.hullStats.Cached(doc));
        this.world.AddShip(doc, flight ?? DEFAULT_SHIP_PHYSICS);
        if (flight) this.flights.set(doc.id, flight);
      } else if (restart || !before || !SamePlacement(before, doc)) this.world.PlaceShip(doc);
    }
    const retuned = restart ? scene.ships : [...diff.added, ...diff.rebuilt, ...diff.retuned];
    for (const id of new Set(retuned.map((doc) => doc.id))) this.Retune(id);
    await this.store.Put(CURRENT_KEY, scene);
    for (const doc of builds) this.live.set(doc.id, { id: doc.id, dna: doc.dna, status: 'queued', ship: null, error: null, diagnostics: [], hull: null });
    this.onChange();

    // Builds are serialized by SOF anyway; awaiting them in order keeps the report in document order.
    for (const doc of builds) await this.Build(doc);

    this.ApplyCamera(scene.camera);
    this.onChange();
    return {
      scene,
      warnings,
      ships: scene.ships.map((doc) => this.ShipReport(doc.id)),
      changes: { added: diff.added.length, rebuilt: diff.rebuilt.length, retried: retried.length, moved: diff.moved.length, removed: diff.removed.length, regrouped: diff.regrouped.length, stopped: stopped.length }
    };
  }

  private async Build(doc: SceneShip): Promise<void> {
    const entry = this.live.get(doc.id);
    if (!entry) return;
    entry.status = 'building';
    this.onChange();
    try {
      const { values, diagnostics, hull } = await BuildShipValues(doc.dna);
      entry.diagnostics = diagnostics.slice(0, 10).map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      if (this.live.get(doc.id) !== entry) return;
      entry.hull = hull;
      this.Retune(doc.id);
      if (this.engine) {
        const ship = HydrateShip(values);
        const curves = this.world.Curves(doc.id);
        if (curves) AttachShipCurves(ship, curves);
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

  /**
   * Re-resolves a ship's flight numbers from what is known now, then once more when its /ship-stats lookup lands
   * (if the ship still names the same hull by then).
   *
   * @param id - The ship id.
   */
  private Retune(id: string): void {
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    if (!doc) return;
    const cached = this.hullStats.Cached(doc);
    this.SetFlight(doc, cached);
    if (cached) return;
    const key = HullStatsKey(doc);
    void this.hullStats.Lookup(doc).then((answer) => {
      const current = this.scene?.ships.find((ship) => ship.id === id);
      if (!current || HullStatsKey(current) !== key) return;
      this.SetFlight(current, answer);
      this.onChange();
    });
  }

  /**
   * Flies a ship with the numbers its lookup answer gives; on a resolution error it keeps its previous physics.
   *
   * @param doc - The current document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   */
  private SetFlight(doc: SceneShip, answer: Maybe<HullStatsAnswer>): void {
    const flight = this.Flight(doc, answer);
    if (!flight) return;
    try {
      this.world.SetPhysics(doc.id, flight);
      this.flights.set(doc.id, flight);
    } catch (error) {
      console.error(`ship ${doc.id}: cannot fly ${JSON.stringify(flight)} (${ErrorText(error)}); it keeps its previous physics`);
    }
  }

  /**
   * A ship's flight numbers: its lookup answer, its SOF hull and its `stats`, through the max-skills pilot.
   *
   * @param doc - The document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   * @returns The numbers; null when they cannot be resolved (logged).
   */
  private Flight(doc: SceneShip, answer: Maybe<HullStatsAnswer>): Maybe<ShipFlight> {
    let flight: Maybe<ShipFlight> = null;
    try {
      flight = ResolveFlight({ published: answer?.hull, note: answer ? answer.note : LOOKUP_PENDING_NOTE, hull: this.live.get(doc.id)?.hull, overrides: doc.stats });
    } catch (error) {
      console.error(`ship ${doc.id}: no flight numbers (${ErrorText(error)}); it keeps its previous physics`);
    }
    return flight;
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
   * A ship's bounding sphere in world space, centred on its ball; the ball alone when it is not built.
   */
  private WorldSphere(doc: SceneShip): WorldSphere {
    const ship = this.live.get(doc.id)?.ship;
    const position = vec3.fromValues(...(this.world.Motion(doc.id)?.position ?? doc.position));
    let sphere: WorldSphere;
    if (ship) {
      const centre = vec3.transformQuat(vec3.create(), ship.boundingSphereCenter, ship.rotationCurve?.value ?? DocumentRotation(doc.rotation));
      sphere = { centre: vec3.add(centre, centre, position), radius: ship.boundingSphereRadius || UNBUILT_RADIUS };
    } else {
      sphere = { centre: position, radius: UNBUILT_RADIUS };
    }
    return sphere;
  }

  private ShipState(doc: SceneShip, membership: Maybe<ShipFleetMembership>): ShipReport & { name?: string; team?: string; worldPosition: number[]; radius: number } & Partial<ShipFleetMembership> & Partial<ShipMotion> {
    const sphere = this.WorldSphere(doc);
    const motion = this.world.Motion(doc.id);
    return { ...this.ShipReport(doc.id), name: doc.name, team: doc.team, ...membership, worldPosition: Array.from(sphere.centre).map(Math.round), radius: Math.round(sphere.radius), ...motion, physics: this.flights.get(doc.id) ?? motion?.physics };
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
 * Whether two versions of a document ship sit at the same placement.
 *
 * @param a - One version.
 * @param b - The other.
 * @returns True when position and rotation match.
 */
function SamePlacement(a: SceneShip, b: SceneShip): boolean {
  return a.position.every((value, index) => value === b.position[index]) && a.rotation.every((value, index) => value === b.rotation[index]);
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
