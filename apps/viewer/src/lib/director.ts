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
 * a ship stops its followers. A warp order aligns, warps and lands the ship
 * (destiny.ts); get_state reports its phase and progress.
 *
 * Boosters follow the ball speed (boosters.ts): every frame, before drawing,
 * each built ship's booster set takes its max velocity as the reference speed
 * and its drawn speed for the warp colours.
 *
 * Prop mods (prop-mods.ts): every ship fits the module its document names, or
 * the hull-sized microwarpdrive, with the hub's EVE numbers for it (else
 * built-in ones). switch_prop_mods switches them live on EVE's cycle timing
 * (destiny.ts); the document's `propMod.active` applies at once on a load and
 * on a patch that changes it. Each change posts the engine sound on the ship's
 * emitter (audio.ts, prop-mod-audio.ts).
 *
 * Fleets fly (Follow the FC, following.ts): every fleet member but the FC
 * keeps range on its resolved anchor in its formation slot, re-planned at the
 * end of every edit and whenever a radius settles. Ordering the FC moves its
 * fleet. An order on a member takes it out of formation until a rejoin order,
 * a fleet edit that regroups it, or a load.
 *
 * Fleet orders (order_fleet, fleet-orders.ts): a fleet, wing or squad order
 * goes to the group's leader, given by a ship commanding the group. A move
 * flies the leader (a wing or squad then flies apart on it until a regroup), a
 * warp lands the whole group in formation, and anchor, break-off and regroup
 * edit the document's anchors through the edit queue, as patch_scene does,
 * before their live half. get_state reports each group's command.
 *
 * Without a renderer (no WebGPU), the director still validates documents and
 * builds each ship's SOF values, so DNA mistakes surface; it just has nothing
 * to draw into.
 */

import type { Maybe } from '@dereekb/util';
import {
  applySceneOperations,
  createEmptyScene,
  DEFAULT_PROP_MOD_MODULE,
  diffScenes,
  fitsPropMod,
  isFleetStructureOrder,
  normalizeFleetOrderRequest,
  toFleetOrderOperations,
  toPilotDelays,
  normalizePropModSwitch,
  normalizeScene,
  normalizeShipOrderRequest,
  SceneError,
  selectFleetShips,
  toFleetMemberships,
  toFleetReports,
  SCENE_CAMERA_MODES,
  type HullSizeClass,
  type NormalizedScene,
  type PropModKind,
  type PropModModule,
  type SceneCamera,
  type SceneCameraMode,
  type SceneDocument,
  type SceneLocation,
  type SceneShip,
  type ShipFleetMembership,
  type ShipOrderRequest
} from '@scene-director/scene';
import type { SceneClock } from './clock';
import { PageAudio } from './audio';
import { DriveBoosters } from './boosters';
import { CameraFollow, PickShip, ReframesAfterEdit, type FollowedShip, type PickSphere } from './camera';
import { AttachShipCurves, DEFAULT_SHIP_PHYSICS, DocumentRotation, type DestinyWorld, type PropModEvent, type PropModState, type ShipHull, type ShipMotion } from './destiny';
import { HullStatsKey, HullStatsLookup, ResolveFlight, RunningFlight, type HullStatsAnswer, type ShipFlight } from './flight';
import { FleetOrders, type FleetOrderResult } from './fleet-orders';
import { FleetFollowing, type ShipFollowingReport } from './following';
import { EncodePng, type CameraEye, type Engine, type EngineStats } from './engine';
import type { ToolHandler } from './link';
import { ReadDressParts } from './celestials';
import { LocationLookup } from './location';
import { LocationDressing } from './location-dressing';
import { PropModAudioEvents, PropModAudioStops } from './prop-mod-audio';
import { PropModKey, PropModLookup, PropModLookupTarget, ResolveShipPropMod, RigSizeOf, type PropModSource } from './prop-mods';
import { ErrorText } from './resources';
import { quat, vec3, type EveShip2, type Vec3 } from './runtime';
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

/**
 * A built ship's booster set, for the real-GPU check.
 */
export interface ShipBoosterState {
  /**
   * m/s: the reference speed (the ship's max velocity).
   */
  readonly maxVel: number;
  /**
   * The booster intensity, 0 to 2 (0.01).
   */
  readonly intensity: number;
  /**
   * The warp colours' blend, 0 to 1 (0.01).
   */
  readonly warpIntensity: number;
}

/**
 * The ClientBall velocity scratch for DriveBoosters.
 */
const BOOSTER_VELOCITY = new Float32Array(3);

/**
 * The ClientBall samples TrackCamera reads.
 */
const CAMERA_TARGET_POSITION = new Float32Array(3);
const CAMERA_TARGET_ROTATION = new Float32Array(4);
const CAMERA_TARGET_FORWARD = new Float32Array(3);

/**
 * A ship's forward axis in its own frame (a heading of yaw 0 faces +Z).
 */
const SHIP_FORWARD = new Float32Array([0, 0, 1]);
/**
 * A ship's up axis in its own frame.
 */
const SHIP_UP = new Float32Array([0, 1, 0]);

/**
 * A ship's prop mod in get_state: the module, its state and the numbers the ship flies while it runs.
 */
export interface ShipPropModState {
  /**
   * As the document names it, or the default.
   */
  readonly module: PropModModule;
  readonly name?: string;
  readonly typeID?: number;
  readonly kind?: PropModKind;
  readonly size?: HullSizeClass;
  readonly source?: PropModSource;
  readonly note?: string;
  readonly state: PropModState;
  /**
   * Seconds.
   */
  readonly cycleTime?: number;
  readonly since?: number;
  readonly at?: number;
  readonly stopsIn?: number;
  readonly maxVelocity?: number;
  readonly mass?: number;
  /**
   * m, the MWD bloom included.
   */
  readonly signatureRadius?: number;
  readonly alignTime?: number;
}

/**
 * A fleet's prop mods in get_state, by state; none counts the ships fitting none.
 */
export type FleetPropModCounts = Record<PropModState | 'none', number>;

/**
 * A ship switch_prop_mods switched (or found already in the state asked for).
 */
export interface SwitchedPropMod {
  readonly id: string;
  /**
   * The module's name.
   */
  readonly module: string;
  readonly state: PropModState;
  /**
   * The tick an activation applies at.
   */
  readonly at?: number;
  /**
   * Seconds until a stopping module stops.
   */
  readonly stopsIn?: number;
  /**
   * With a delay: seconds until the pilot makes the switch (state is the one before it).
   */
  readonly respondsIn?: number;
}

export interface SwitchPropModsResult {
  readonly tick: number;
  readonly active: boolean;
  readonly ships: SwitchedPropMod[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
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
  /**
   * The hub's /prop-mod lookups; a fresh one by default.
   */
  readonly propMods?: PropModLookup;
  /**
   * `?audio=off`: the page never turns audio on.
   */
  readonly audioDisabled?: boolean;
}

interface ApplyOptions {
  /**
   * Put every kept ship back at rest at its placement (load_scene).
   */
  readonly restart?: boolean;
}

export interface OrderShipResult {
  readonly id: string;
  readonly order: ShipOrderRequest;
  /**
   * The Destiny tick when the order was given; it applies at the next one.
   */
  readonly tick: number;
  /**
   * `detached` when the order took a fleet member out of formation, `leading` when the ship leads a wing or squad apart
   * from its fleet (it keeps leading); its following report for a rejoin.
   */
  readonly following?: 'detached' | 'leading' | ShipFollowingReport;
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
  readonly mode?: SceneCameraMode;
  readonly persist?: boolean;
}

export class Director {
  readonly engine: Maybe<Engine>;
  readonly engineError: Maybe<Error>;
  readonly store: SceneStore;
  readonly world: DestinyWorld;
  readonly clock: SceneClock;
  readonly live = new Map<string, LiveShip>();
  /**
   * The fleets' following (Follow the FC).
   */
  readonly following: FleetFollowing;
  /**
   * order_fleet's live half and each group's command report.
   */
  readonly orders: FleetOrders;
  /**
   * The scene location's system data from the hub, and its get_state report.
   */
  readonly location: LocationLookup;
  /**
   * What the location draws around the scene (location-dressing.ts): nebula, star, planets, moons, stations, gates.
   */
  readonly dressing: LocationDressing;
  /**
   * The engine sounds (audio.ts).
   */
  readonly audio: PageAudio;
  scene: Maybe<SceneDocument> = null;
  private readonly onChange: () => void;
  private readonly hullStats: HullStatsLookup;
  private readonly propMods: PropModLookup;
  /**
   * What each ship flies with, as get_state reports it.
   */
  private readonly flights = new Map<string, ShipFlight>();
  /**
   * The camera following its target ship (camera.ts).
   */
  private readonly cameraFollow = new CameraFollow();
  /**
   * The camera a page change already applied, so the document write that follows does not frame it again.
   */
  private appliedCamera: Maybe<string> = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ engine, engineError, store, world, clock, onChange = () => undefined, hullStats = new HullStatsLookup(), propMods = new PropModLookup(), audioDisabled = false }: DirectorOptions) {
    this.hullStats = hullStats;
    this.propMods = propMods;
    this.engine = engine;
    this.engineError = engineError;
    this.store = store;
    this.world = world;
    this.clock = clock;
    this.onChange = onChange;
    this.following = new FleetFollowing({ world, scene: () => this.scene, radiusOf: (id) => this.FormationRadius(id) });
    this.orders = new FleetOrders({ world, following: this.following, scene: () => this.scene });
    this.dressing = new LocationDressing({
      engine,
      parts: ReadDressParts(),
      retained: () => [...this.live.values()].map((entry) => entry.ship).filter((ship): ship is EveShip2 => ship !== null),
      onChange: () => this.onChange()
    });
    this.location = new LocationLookup({
      onChange: () => {
        this.Redress();
        this.onChange();
      }
    });
    // A module already running when audio turns on has played its one-shot activation: nothing to post.
    this.audio = new PageAudio({ disabled: audioDisabled, onChange: () => this.onChange() });
    world.OnPropMod((event) => this.PostPropModAudio(event));
    if (engine) this.AttachCameraControls(engine.canvas);
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
      order_ship: ({ id, order }) => this.OrderShip(id, order),
      switch_prop_mods: (args) => this.SwitchPropMods(args),
      order_fleet: (args) => this.OrderFleet(args)
    };
  }

  /**
   * Replaces the scene with a document.
   */
  Load(input: unknown): Promise<unknown> {
    return this.Serialize(() => this.Apply(normalizeScene(input), { restart: true }));
  }

  /**
   * Gives a ship a live movement order; it applies at the next Destiny tick and is not saved. A movement order on a
   * fleet member (not the FC) takes it out of formation; rejoin puts it back.
   *
   * @param id - The ship id.
   * @param order - The order as JSON; a target must be another ship in the scene.
   * @returns The normalized order, the tick it was given at, and what it did to the ship's following.
   * @throws {Error} When no ship has the id, the order is invalid (a SceneError with every problem), or a rejoin is
   *   for the FC or a ship in no fleet.
   */
  OrderShip(id: unknown, order: unknown): OrderShipResult {
    const ships = new Set((this.scene?.ships ?? []).map((doc) => doc.id));
    if (typeof id !== 'string' || !ships.has(id)) throw new Error(`no ship "${String(id)}"`);
    const normalized = normalizeShipOrderRequest(order, { ships, self: id });
    if (normalized.type === 'rejoin') return { id, order: normalized, tick: this.world.tick, following: this.following.Rejoin(id) };
    const refusal = this.world.OrderRefusal(id, normalized);
    if (refusal !== null || !this.world.Order(id, normalized)) throw new Error(refusal ?? `ship "${id}" or its target has no Destiny ball`);
    const following = this.following.Detach(id);
    return { id, order: normalized, tick: this.world.tick, ...(following ? { following } : {}) };
  }

  /**
   * Orders a fleet, wing or squad (order_fleet): resolved against the document, given by a ship commanding the group.
   * Moves and warps fly at once (live, not saved); anchor, break-off and regroup edit the document's anchors through
   * the edit queue, as patch_scene does, then run their live half (regroup's rejoins and warps back).
   *
   * @param input - The order_fleet arguments: fleet, wing or squad, by, order.
   * @returns What the order did; document orders add their operations and the patch result (its ship reports under
   *   `builds`, so `ships` stays the ordered ships).
   * @throws {SceneError} When the request is invalid, names an unknown group, or comes from a ship without command of it.
   * @throws {Error} When the leader refuses the order, or the fleet is not planned yet for a wing or squad move or a warp.
   */
  OrderFleet(input: unknown): Promise<object> {
    const request = normalizeFleetOrderRequest(input, { ships: new Set((this.scene?.ships ?? []).map((doc) => doc.id)) });
    if (!isFleetStructureOrder(request.order)) return Promise.resolve(this.orders.Fly(this.orders.Resolve(request)));
    return this.Serialize(async () => {
      // Resolved against the document current at its turn in the queue.
      const resolved = this.orders.Resolve(request);
      const operations = toFleetOrderOperations(this.Current(), resolved);
      const patch = operations.length ? ((await this.Apply(applySceneOperations(this.Current(), operations))) as { readonly ships?: unknown }) : null;
      const { ships: builds, ...rest } = patch ?? {};
      const result: FleetOrderResult = this.orders.Fly(resolved);
      return { ...result, operations, ...(patch ? { ...rest, builds } : {}) };
    });
  }

  /**
   * Switches the selected ships' prop mods on or off, live, on EVE's cycle timing (DestinyWorld.SwitchPropMod). Not
   * saved; set_prop_mods edits the document's state at load.
   *
   * @param input - The switch_prop_mods arguments: active and a selection (ships, or a fleet with a wing or squad).
   * @returns The tick, each switched ship's state after the call, and the ships skipped with why.
   * @throws {SceneError} When the switch is invalid or names an unknown ship, fleet, wing or squad.
   */
  SwitchPropMods(input: unknown): SwitchPropModsResult {
    const command = normalizePropModSwitch(input);
    const scene = this.Current();
    const selected = selectFleetShips(scene, command);
    if (selected.problems.length) throw new SceneError(selected.problems);
    const docs = new Map(scene.ships.map((doc) => [doc.id, doc]));
    const key = `prop-mods|${command.fleet ?? ''}|${command.wing ?? ''}|${command.squad ?? ''}`;
    const delays = toPilotDelays({ key, tick: this.world.tick, delay: command.delay ?? 0, ships: selected.ships, issuer: '' });
    const ships: SwitchedPropMod[] = [];
    const skipped: SwitchPropModsResult['skipped'] = [];
    for (const id of selected.ships) {
      const doc = docs.get(id);
      const refusal = fitsPropMod(doc?.propMod) ? this.world.PropModRefusal(id, command.active) : `it fits no prop mod (propMod.module "${ShipPropModModule(doc)}")`;
      const result = refusal === null ? this.world.SwitchPropMod(id, command.active, { delay: delays.get(id) }) : null;
      if (result) {
        const module = this.flights.get(id)?.propMod?.name ?? String(ShipPropModModule(doc));
        ships.push({
          id,
          module,
          state: result.state,
          ...(result.at === undefined ? {} : { at: result.at }),
          ...(result.stopsIn === undefined ? {} : { stopsIn: result.stopsIn }),
          ...(result.respondsIn === undefined ? {} : { respondsIn: result.respondsIn })
        });
      } else {
        skipped.push({ id, reason: refusal ?? `ship "${id}" has no Destiny ball` });
      }
    }
    this.onChange();
    return { tick: this.world.tick, active: command.active, ships, skipped };
  }

  /**
   * Places the audio listener at the camera and each ship's emitter at the drawn ship, then runs the audio frame at
   * `now`. Runs between world.Tick and engine.Frame.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveAudio(now: number): void {
    this.audio.Frame({ now, listener: this.engine?.camera.Eye() ?? null, placementOf: (id) => this.AudioPlacement(id, now) });
  }

  /**
   * Feeds every built ship's booster set from its drawn ball speed, for the frame at `now`. Runs between world.Tick
   * and engine.Frame; the ClientBall caches its sample per time, so the renderer draws the same velocity.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveBoosters(now: number): void {
    for (const live of this.live.values()) {
      const curves = live.ship ? this.world.Curves(live.id) : null;
      if (!live.ship || !curves) continue;
      curves.translation.GetValueDotAt__Ticks(now, BOOSTER_VELOCITY);
      const speed = Math.hypot(BOOSTER_VELOCITY[0], BOOSTER_VELOCITY[1], BOOSTER_VELOCITY[2]);
      // The flight's maxVelocity stays prop-mod-off (get_state's physics swaps in the running numbers), so a running MWD
      // pushes the boosters toward the runtime's cap of 2.
      DriveBoosters(live.ship, { speed, maxVelocity: this.flights.get(live.id)?.maxVelocity ?? DEFAULT_SHIP_PHYSICS.maxVelocity });
    }
  }

  /**
   * Moves the camera with the ship it targets, for the frame at `now`, in the document's camera mode (camera.ts).
   * Runs between world.Tick and engine.Frame and samples the ClientBall the renderer draws.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  TrackCamera(now: number): void {
    const view = this.engine?.camera;
    if (view) this.cameraFollow.Frame(now, view, (id) => this.DrawnShip(id, now));
  }

  /**
   * The ship the camera follows.
   */
  get followedShip(): Maybe<string> {
    return this.cameraFollow.following;
  }

  /**
   * Follows a ship with the camera, keeping the view's angles and zoom (alt-click, the overlay's follow buttons); null
   * frames every ship instead.
   */
  FollowShip(id: Maybe<string>): void {
    this.ChangeCamera({ target: id });
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
      location: this.LocationState(),
      camera: this.engine?.camera.Get() ?? null,
      environment: this.engine?.Environment() ?? null,
      simulation: { tick: this.world.tick, seconds: Math.round(this.clock.seconds * 100) / 100 },
      ships,
      distances,
      fleets: this.scene
        ? toFleetReports(this.scene).map((report) => ({
            ...report,
            formation: this.following.FleetReport(report),
            propMods: this.FleetPropMods(report.ships),
            command: this.orders.GroupReport({ fleet: report.id, kind: 'fleet', id: report.id }),
            wings: report.wings.map((wing) => ({
              ...wing,
              command: this.orders.GroupReport({ fleet: report.id, kind: 'wing', id: wing.id }),
              squads: wing.squads.map((squad) => ({ ...squad, command: this.orders.GroupReport({ fleet: report.id, kind: 'squad', id: squad.id }) }))
            }))
          }))
        : [],
      audio: this.audio.Report()
    };
  }

  async Screenshot(maxWidth: unknown): Promise<object> {
    if (!this.engine) throw new Error(`no renderer: ${this.engineError?.message ?? 'not started'}`);
    const frame = await this.engine.Capture();
    const { png, width, height } = await EncodePng(frame, Math.max(64, Number(maxWidth) || DEFAULT_SCREENSHOT_WIDTH));
    return { image: { data: ToBase64(png), mimeType: 'image/png' }, width, height, rendered: [frame.width, frame.height] };
  }

  /**
   * Points the camera without editing the document unless `persist`. A camera following a ship keeps following through
   * scene edits (camera.ts's ReframesAfterEdit).
   */
  async FrameCamera({ target, yaw, pitch, distance, mode, persist = false }: FrameCameraArgs = {}): Promise<unknown> {
    const camera: SceneCamera = { ...this.Current().camera, target: target ?? null };
    if (IsFiniteNumber(yaw)) camera.yaw = yaw;
    if (IsFiniteNumber(pitch)) camera.pitch = pitch;
    camera.distance = IsFiniteNumber(distance) ? distance : null;
    if (mode != null && !SCENE_CAMERA_MODES.includes(mode)) throw new Error(`mode must be one of ${SCENE_CAMERA_MODES.join(', ')}`);
    if (mode) camera.mode = mode;
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
    // initialized with the device; a reload is the reliable way to do it (and
    // the reload trick CLAUDE.md names). A location's region nebula swaps in
    // live instead (Engine.SetNebula, location-dressing.ts).
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
      this.audio.Release(doc.id);
    }
    this.scene = scene;
    if (restart || diff.location) {
      this.location.Update(scene.location ?? null, { retry: restart });
      this.Redress(scene.location ?? null);
    }
    if (restart) {
      this.hullStats.ForgetFailures();
      this.propMods.ForgetFailures();
    }

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
    // The document's prop mod state applies at once, like a placement: on a load, for added ships, for ships whose
    // propMod.active changed, and off for a ship whose module became "none".
    const switching = new Map((restart ? scene.ships : [...diff.added, ...diff.switched]).map((doc) => [doc.id, doc]));
    for (const doc of diff.retuned) if (!fitsPropMod(doc.propMod)) switching.set(doc.id, doc);
    for (const doc of switching.values()) this.world.SetPropModActive(doc.id, doc.propMod?.active === true && fitsPropMod(doc.propMod));
    if (restart) this.orders.Reset();
    stopped.push(...this.following.Reconcile({ regrouped: diff.regrouped.map((doc) => doc.id), restart }));
    await this.store.Put(CURRENT_KEY, scene);
    for (const doc of builds) this.live.set(doc.id, { id: doc.id, dna: doc.dna, status: 'queued', ship: null, error: null, diagnostics: [], hull: null });
    this.onChange();

    // Builds are serialized by SOF anyway; awaiting them in order keeps the report in document order.
    for (const doc of builds) await this.Build(doc);

    const reframe = ReframesAfterEdit({ restart, cameraChanged: diff.camera, following: this.cameraFollow.following, removed: diff.removed.map((doc) => doc.id) });
    if (reframe && JSON.stringify(scene.camera) !== this.appliedCamera) this.ApplyCamera(scene.camera);
    this.appliedCamera = null;
    this.onChange();
    return {
      scene,
      warnings,
      ships: scene.ships.map((doc) => this.ShipReport(doc.id)),
      changes: { added: diff.added.length, rebuilt: diff.rebuilt.length, retried: retried.length, moved: diff.moved.length, removed: diff.removed.length, regrouped: diff.regrouped.length, switched: diff.switched.length, stopped: stopped.length }
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
      // The build settles the ship's radius when the hub has no SDE radius for it.
      this.following.Reconcile();
      this.onChange();
    }
  }

  /**
   * Re-resolves a ship's flight numbers from what is known now, then once more when its /ship-stats lookup lands
   * (if the ship still names the same hull by then), and again when its prop mod's /prop-mod lookup lands.
   *
   * @param id - The ship id.
   */
  private Retune(id: string): void {
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    if (!doc) return;
    const cached = this.hullStats.Cached(doc);
    this.SetFlight(doc, cached);
    this.LookupPropMod(doc, cached);
    if (cached) return;
    const key = HullStatsKey(doc);
    void this.hullStats.Lookup(doc).then((answer) => {
      const current = this.scene?.ships.find((ship) => ship.id === id);
      if (!current || HullStatsKey(current) !== key) return;
      this.SetFlight(current, answer);
      // The hull's size may pick a different hull-sized module.
      this.LookupPropMod(current, answer);
      this.following.Reconcile();
      this.onChange();
    });
  }

  /**
   * Starts a ship's /prop-mod lookup when its answer is not cached, and retunes the ship when it lands (if the ship
   * still fits the same module by then).
   *
   * @param doc - The current document ship.
   * @param answer - Its /ship-stats answer; null while that lookup is in flight.
   */
  private LookupPropMod(doc: SceneShip, answer: Maybe<HullStatsAnswer>): void {
    const target = this.PropModTarget(doc, answer);
    if (target == null || this.propMods.Cached(target)) return;
    const key = PropModKey(target);
    void this.propMods.Lookup(target).then(() => {
      const current = this.scene?.ships.find((ship) => ship.id === doc.id);
      const hull = current ? this.hullStats.Cached(current) : null;
      const now = current ? this.PropModTarget(current, hull) : null;
      if (!current || now == null || PropModKey(now) !== key) return;
      this.SetFlight(current, hull);
      this.onChange();
    });
  }

  /**
   * The type id or name a ship's prop mod is looked up by.
   *
   * @param doc - The document ship.
   * @param answer - Its /ship-stats answer; null while that lookup is in flight.
   * @returns It, or null for "none".
   */
  private PropModTarget(doc: SceneShip, answer: Maybe<HullStatsAnswer>): Maybe<string | number> {
    return PropModLookupTarget(ShipPropModModule(doc), RigSizeOf({ published: answer?.hull, hull: this.live.get(doc.id)?.hull }));
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
      const hull = this.live.get(doc.id)?.hull;
      const module = ShipPropModModule(doc);
      const rigSize = RigSizeOf({ published: answer?.hull, hull });
      const target = PropModLookupTarget(module, rigSize);
      const propMod = ResolveShipPropMod({ module, rigSize, answer: target == null ? null : this.propMods.Cached(target) });
      flight = ResolveFlight({ published: answer?.hull, note: answer ? answer.note : LOOKUP_PENDING_NOTE, hull, overrides: doc.stats, propMod });
    } catch (error) {
      console.error(`ship ${doc.id}: no flight numbers (${ErrorText(error)}); it keeps its previous physics`);
    }
    return flight;
  }

  /**
   * A ship's ball radius once it is settled, for its fleet's formation: the hub has answered its /ship-stats lookup,
   * and either gave the hull's EVE radius or its SOF build has finished (its bounding radius then stands in).
   *
   * @param id - The ship id.
   * @returns The radius in metres; null while it may still change.
   */
  private FormationRadius(id: string): Maybe<number> {
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    const answer = doc ? this.hullStats.Cached(doc) : null;
    const status = this.live.get(id)?.status;
    const settled = Boolean(answer) && ((answer?.hull?.published.radius ?? 0) > 0 || status === 'validated' || status === 'ready' || status === 'failed');
    return settled ? (this.flights.get(id)?.radius ?? this.world.Motion(id)?.physics.radius ?? null) : null;
  }

  private Retire(id: string): void {
    const entry = this.live.get(id);
    this.live.delete(id);
    if (!entry?.ship || !this.engine) return;
    this.engine.RemoveShip(entry.ship);
    const retained = [...this.live.values()].map((other) => other.ship).filter((ship): ship is EveShip2 => ship !== null);
    RetireShips([entry.ship], [...retained, ...this.dressing.Roots()]);
  }

  private ApplyCamera(camera: SceneCamera): void {
    const view = this.engine?.camera;
    if (!view) return;
    // A view already following a ship glides from where it is to the new framing.
    const previous = this.cameraFollow.following ? Array.from(view.focus) : null;
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
    // Framing placed the focus off the master ball; TrackCamera moves it on from there.
    const target = camera.target ? docs[0] : null;
    this.cameraFollow.mode = camera.mode;
    this.cameraFollow.Follow(target ? { id: target.id, position: this.world.Motion(target.id)?.position ?? target.position } : null, previous ? previous.map((value, axis) => value - view.focus[axis]) : null, this.clock.now);
  }

  /**
   * Posts a prop mod change's engine sound on the ship's emitter (DestinyWorld.OnPropMod).
   */
  private PostPropModAudio(event: PropModEvent): void {
    const propMod = this.flights.get(event.id)?.propMod;
    if (propMod) this.audio.Post({ ship: event.id, tick: event.tick, events: PropModAudioEvents(event.kind, propMod), stops: PropModAudioStops(event.kind, propMod), placement: this.AudioPlacement(event.id, this.clock.now) });
  }

  /**
   * Where a ship is drawn at `now`, for its audio emitter: its ClientBall position, forward and up vectors.
   */
  private AudioPlacement(id: string, now: number): Maybe<CameraEye> {
    const curves = this.world.Curves(id);
    let placement: Maybe<CameraEye> = null;
    if (curves) {
      const rotation = curves.rotation.GetValueAt__Ticks(now, quat.create());
      placement = {
        position: Array.from(curves.translation.GetValueAt__Ticks(now, vec3.create())),
        front: Array.from(vec3.transformQuat(vec3.create(), SHIP_FORWARD, rotation)),
        up: Array.from(vec3.transformQuat(vec3.create(), SHIP_UP, rotation))
      };
    }
    return placement;
  }

  /**
   * A fleet's prop mods by state.
   *
   * @param ships - The ships holding a position in the fleet.
   * @returns The counts.
   */
  private FleetPropMods(ships: readonly string[]): FleetPropModCounts {
    const counts: FleetPropModCounts = { activating: 0, active: 0, stopping: 0, off: 0, none: 0 };
    const docs = new Map((this.scene?.ships ?? []).map((doc) => [doc.id, doc]));
    for (const id of ships) {
      const state = fitsPropMod(docs.get(id)?.propMod) ? (this.world.Motion(id)?.propMod.state ?? 'off') : 'none';
      counts[state] += 1;
    }
    return counts;
  }

  /**
   * A ship as drawn at `now`: its ClientBall position and forward vector.
   */
  private DrawnShip(id: string, now: number): Maybe<FollowedShip> {
    const curves = this.world.Curves(id);
    let drawn: Maybe<FollowedShip> = null;
    if (curves) {
      const rotation = curves.rotation.GetValueAt__Ticks(now, CAMERA_TARGET_ROTATION);
      drawn = { position: curves.translation.GetValueAt__Ticks(now, CAMERA_TARGET_POSITION), forward: vec3.transformQuat(CAMERA_TARGET_FORWARD, SHIP_FORWARD, rotation) };
    }
    return drawn;
  }

  /**
   * The page's camera input on top of OrbitCamera's drag, pan and wheel: alt-click a ship to follow it, C switches
   * between orbit and chase, and a held drag keeps chase's look-around offset.
   */
  private AttachCameraControls(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.altKey && event.button === 0) {
        event.preventDefault();
        this.PickTarget(event, canvas);
      } else {
        this.cameraFollow.dragging = true;
      }
    });
    const release = (): void => {
      this.cameraFollow.dragging = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey) this.ChangeCamera({ mode: this.cameraFollow.mode === 'chase' ? 'orbit' : 'chase' });
    });
  }

  /**
   * Follows the ship under the pointer, when there is one.
   */
  private PickTarget(event: PointerEvent, canvas: HTMLCanvasElement): void {
    const view = this.engine?.camera;
    if (view) {
      const box = canvas.getBoundingClientRect();
      const now = this.clock.now;
      const spheres: PickSphere[] = [];
      for (const live of this.live.values()) {
        const curves = this.world.Curves(live.id);
        if (live.ship && curves) {
          const rotation = curves.rotation.GetValueAt__Ticks(now, quat.create());
          const centre = vec3.transformQuat(vec3.create(), live.ship.boundingSphereCenter, rotation);
          vec3.add(centre, centre, curves.translation.GetValueAt__Ticks(now, vec3.create()));
          spheres.push({ id: live.id, centre, radius: live.ship.boundingSphereRadius || UNBUILT_RADIUS });
        }
      }
      const id = PickShip({ view: view.eve.GetViewMatrix().transform, projection: view.eve.GetProjection().transform, width: box.width, height: box.height }, event.clientX - box.left, event.clientY - box.top, spheres);
      if (id) this.FollowShip(id);
    }
  }

  /**
   * A camera change made in the page (alt-click, C, the overlay's follow buttons), with the live angles and distance so
   * the view stays where it is. The view moves at once; the document's camera is written after, through the edit
   * queue, which may be busy building ships, and that apply skips re-framing the same camera.
   */
  private ChangeCamera(change: Partial<SceneCamera>): void {
    const view = this.engine?.camera;
    const live = view ? { yaw: Math.round((((view.yaw % 360) + 360) % 360) * 10) / 10, pitch: Math.round(view.pitch * 10) / 10, distance: Math.max(1, Math.round(view.distance)) } : {};
    const camera: SceneCamera = { ...this.Current().camera, ...live, ...change };
    this.ApplyCamera(camera);
    this.appliedCamera = JSON.stringify(camera);
    this.onChange();
    this.Serialize(() => this.Apply(applySceneOperations(this.Current(), [{ op: 'set_camera', camera: { ...live, ...change } }]))).catch((error: unknown) => console.warn(`camera change failed: ${ErrorText(error)}`));
  }

  /**
   * Re-dresses the scene for its location and the location's answer (idempotent; location-dressing.ts).
   */
  private Redress(location: Maybe<SceneLocation> = this.scene?.location ?? null): void {
    const report = this.location.Report();
    this.dressing.Update({ location, answer: this.location.Answer(), status: report?.status ?? 'loading', error: report?.error });
  }

  /**
   * Get_state's location: the lookup's report plus what it dressed.
   */
  private LocationState(): Maybe<object> {
    const located = this.location.Report();
    return located ? { ...located, dressing: this.dressing.Report() } : null;
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

  private ShipState(
    doc: SceneShip,
    membership: Maybe<ShipFleetMembership>
  ): ShipReport & { name?: string; team?: string; worldPosition: number[]; radius: number; following?: ShipFollowingReport; boosters?: ShipBoosterState; propMod: Maybe<ShipPropModState> } & Partial<ShipFleetMembership> & Omit<Partial<ShipMotion>, 'propMod'> {
    const sphere = this.WorldSphere(doc);
    const motion = this.world.Motion(doc.id);
    const flight = this.flights.get(doc.id);
    const following = this.following.Report(doc.id);
    const ship = this.engine ? this.live.get(doc.id)?.ship : null;
    const boosters: Maybe<ShipBoosterState> = ship?.boosters ? { maxVel: ship.boosters.maxVel, intensity: Math.round(ship.GetBoosterIntensity() * 100) / 100, warpIntensity: Math.round(ship.boosters.warpIntensity * 100) / 100 } : null;
    const physics = flight ? RunningFlight(flight, motion?.propMod.running === true) : motion?.physics;
    return {
      ...this.ShipReport(doc.id),
      name: doc.name,
      team: doc.team,
      ...membership,
      ...(following ? { following } : {}),
      worldPosition: Array.from(sphere.centre).map(Math.round),
      radius: Math.round(sphere.radius),
      ...motion,
      physics,
      propMod: this.PropModState(doc, flight, motion),
      ...(boosters ? { boosters } : {})
    };
  }

  /**
   * A ship's prop mod in get_state: the flight's module and running numbers, with the world's state.
   *
   * @param doc - The document ship.
   * @param flight - What it flies with.
   * @param motion - Its Destiny motion.
   * @returns The report; null for a ship fitting "none".
   */
  private PropModState(doc: SceneShip, flight: Maybe<ShipFlight>, motion: Maybe<ShipMotion>): Maybe<ShipPropModState> {
    if (!fitsPropMod(doc.propMod)) return null;
    const propMod = flight?.propMod;
    const report = motion?.propMod;
    const note = [report?.note, propMod?.note].filter(Boolean).join('; ');
    return {
      module: propMod?.module ?? ShipPropModModule(doc),
      ...(propMod ? { name: propMod.name, typeID: propMod.typeID, kind: propMod.kind, size: propMod.size, source: propMod.source } : {}),
      ...(note ? { note } : {}),
      state: report?.state ?? 'off',
      ...(propMod ? { cycleTime: propMod.cycleTime } : {}),
      ...(report?.since === undefined ? {} : { since: report.since }),
      ...(report?.at === undefined ? {} : { at: report.at }),
      ...(report?.stopsIn === undefined ? {} : { stopsIn: report.stopsIn }),
      ...(propMod ? { maxVelocity: propMod.maxVelocity, mass: propMod.mass, signatureRadius: propMod.signatureRadius, alignTime: propMod.alignTime } : {})
    };
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
 * The prop mod a ship fits: its document's module, else the hull-sized microwarpdrive.
 *
 * @param doc - The document ship.
 * @returns The canonical module.
 */
function ShipPropModModule(doc: Maybe<SceneShip>): PropModModule {
  return doc?.propMod?.module ?? DEFAULT_PROP_MOD_MODULE;
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
