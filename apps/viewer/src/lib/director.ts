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
 * Fits (fittings.ts): a ship with a fit flies by it once the hub has resolved
 * its names and dogma: the dogma evaluator gives its flight numbers, HP,
 * resists and capacitor (flight.ts's dogma path), its prop mod is the fit's
 * own (shipPropModModuleOf), and get_state reports the fit's modules. Until
 * then, and without the EVE data, it flies the table path. A fit change
 * retunes the ship (the diff's `retuned`).
 *
 * Fitted modules (modules.ts): switch_modules runs them on EVE's cycle timing,
 * at Destiny's tick boundaries (DestinyWorld.OnBoundary); the prop module goes
 * through the same DestinyWorld calls as switch_prop_mods. A ship whose
 * modules' states change flies again with them (siege and triage change its
 * physics there, before orders), and its repairs land in the damage model
 * (damage.ts), which get_state's live defense reports.
 *
 * Target effects (target-effects.ts): webs, painters, points and scrams running
 * on a ship (fitted or not) go into its flight as incoming modifiers, so a web
 * slows its ball through SetPhysics and a point sets its tackle
 * (DestinyWorld.SetTackle: no warp; a scram also switches its MWD off and keeps
 * it off). Neuts, nos and remote capacitor transmitters move its live capacitor
 * (capacitor.ts) at each cycle start. get_state reports `targeted`.
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
 * Combat (locks.ts, combat.ts): set_target and engage lock the target on EVE's
 * lock time (ShipLocks, swept at each boundary), and turrets wait for the lock
 * (the ModuleCycle gate). Each boundary: shields recharge, locks advance,
 * engagements re-arm their guns, then the modules cycle; every turret shot is
 * rolled on Destiny's GetAccuracy and does EVE damage into the damage model
 * (CombatRules) before the OnShot listeners see it. Structure at 0 records a
 * kill (OnKill) and flags the ship destroyed: it takes no more damage, and
 * targets on it clear, until a load revives everyone.
 *
 * The cinematic camera (cinema.ts): a shot or sequence plays on generated hardpoints from the drawn ships, every
 * frame in TrackCamera, and the engine's FreeCamera draws it. A load cuts it; a camera change, a removed subject or the
 * pointer releases it back to the orbit camera (the pointer adopting the cinematic view). get_state reports it as
 * `cinema`, and the drawn camera as `camera.drawn`.
 *
 * Without a renderer (no WebGPU), the director still validates documents and
 * builds each ship's SOF values, so DNA mistakes surface; it just has nothing
 * to draw into.
 */

import type { Maybe } from '@dereekb/util';
import {
  applySceneOperations,
  HULL_SIZE_CLASSES,
  type CelestialTarget,
  type SceneObject,
  toCelestialTargets,
  toLocationTargetReports,
  createEmptyScene,
  diffScenes,
  fitTextOf,
  isFleetStructureOrder,
  normalizeFleetOrderRequest,
  toFleetOrderOperations,
  toPilotDelays,
  normalizePropModSwitch,
  normalizeModuleSwitch,
  normalizeScene,
  normalizeShipOrderRequest,
  resolveNamedOrderTarget,
  type ResolvedNamedOrderTarget,
  PROP_MOD_MODULE_NONE,
  SceneError,
  shipPropModModuleOf,
  selectFittedModules,
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
  type ShipOrderRequest,
  normalizeVec,
  scaleVec,
  normalizeHardpointSubject,
  toHardpointListing,
  type CinemaCelestial,
  type CinemaScene,
  type CinemaShip,
  type CinemaWarp,
  type HardpointListing,
  type SceneVector,
  type ShipCapacitor,
  type ShipDefense,
  type ShipDogmaInput,
  type ModuleSwitch,
  type ModuleSwitchState,
  defaultWeaponsOf,
  type DefaultWeapons,
  CELESTIAL_TARGET_PREFIX,
  CELESTIAL_TARGET_REFUSAL,
  normalizeTargetCommand,
  type ShotTargetKind,
  type WeaponShot,
  MAX_SKILLS_PILOT,
  DEFAULT_ENGAGE_MODULES,
  normalizeCeaseFireCommand,
  normalizeEngageCommand,
  sceneCombatOf,
  shipExplosionOf,
  type ShipExplosionChoice,
  type ShipKill,
  toLiveFleetScene,
  type LiveFleetView,
  shipLockLimit,
  incomingModifiersOf,
  incomingSourceLabel,
  microwarpdriveBlockNoteOf,
  TARGET_EFFECT_ATTRIBUTES,
  warpScrambleNoteOf,
  type DogmaIncomingModifier,
  type ModuleCategory,
  type ShipStatsInput
} from '@scene-director/scene';
import { CapacitorModel } from './capacitor';
import { CombatRules, type ShipCombatReport } from './combat';
import { type LockEvent, type LockTargeting, ShipLocks, type ShipLockReport } from './locks';
import { TICKS_PER_SECOND, type SceneClock } from './clock';
import { PageAudio } from './audio';
import { DriveBoosters } from './boosters';
import { CameraFollow, PickShip, ReframesAfterEdit, type FollowedShip, type PickSphere } from './camera';
import { CINEMA_DEFAULT_ASPECT, CinemaReleases, CinemaRig, type CinemaPlayer, type CinemaPlayResult, type CinemaReport } from './cinema';
import { AttachShipCurves, DEFAULT_SHIP_PHYSICS, DocumentRotation, type DestinyWorld, type PropModEvent, type PropModState, type ShipHull, type ShipMotion, type ShipPhysics, type ShipTackle } from './destiny';
import { DamageModel, type DamageReport } from './damage';
import { ExplosionFiles, ExplosionRemoveTick, ExplosionSchedule, type ExplosionTimes } from './explosion-plan';
import { ShipExplosions, type ShipExplosionReport } from './explosions';
import {
  DogmaStateOf,
  FitLookup,
  FleetModuleCountsOf,
  ResolveShipFitting,
  ShipCapacitorReportOf,
  ShipDefenseReportOf,
  ShipFitReportOf,
  ShipModuleSpecsOf,
  type FleetModuleCounts,
  type ResolvedShipFitting,
  type ShipCapacitorReport,
  type ShipDefenseReport,
  type ShipFitModule,
  type ShipFitReport,
  type ShipModuleRowState
} from './fittings';
import { HullStatsKey, HullStatsLookup, ResolveFlight, RunningFlight, type HullStatsAnswer, type ShipFlight } from './flight';
import { FleetOrders, type FleetOrderResult } from './fleet-orders';
import { FleetFollowing, type ShipFollowingReport } from './following';
import { Arrivals } from './arrivals';
import { EncodePng, type CameraEye, type DrawnCamera, type Engine, type EngineStats } from './engine';
import type { ToolHandler } from './link';
import { ReadDressParts } from './celestials';
import { LocationKey, LocationLookup } from './location';
import { ObjectBallRadius, ObjectStateRow, PlanCelestialTargetSync, type ShipOrders } from './objects';
import { ObjectForward, SceneObjects } from './scene-objects';
import { LocationDressing } from './location-dressing';
import { ModuleAudioPost } from './module-audio';
import { ModuleEffects, type ModuleEffectsReport } from './module-effects';
import { ModuleFxCommands } from './module-fx';
import { ShipModules, type CapacitorLanding, type ShipModuleEvent, type TargetingModule } from './modules';
import { ShotQueue, WeaponShotsOf } from './shots';
import { ShipTargets, type ShipTargetReport } from './targets';
import { PropModAudioEvents, PropModAudioStops } from './prop-mod-audio';
import { PropModKey, PropModLookup, PropModLookupTarget, ResolveShipPropMod, RigSizeOf, type PropModSource, type ResolvedShipPropMod } from './prop-mods';
import { ErrorText, ResourceValues } from './resources';
import { quat, vec3, type EveShip2, type Vec3 } from './runtime';
import { BuildShipValues, HydrateShip, RetireShips } from './ships';
import { CURRENT_KEY, type SceneStore } from './store';
import { TurretAudioPosts, TurretSoundQueue, type TurretAimTransition, type TurretShotSound, type TurretSoundFacts } from './turret-audio';
import { TurretFiles, TurretMountsOf, type TurretMountReport } from './turret-plan';
import { ShipTurrets, type TurretsReport } from './turrets';
import { WarpEffects, type WarpEffectsReport } from './warp-effects';
import { WarpFx, type WarpFlashCounts, type WarpFxCommand } from './warp-fx';
import { WeaponLookup } from './weapon-lookup';

/**
 * Radius assumed for a ship that is not built yet, for framing and distances.
 */
const UNBUILT_RADIUS = 100;
const DEFAULT_SCREENSHOT_WIDTH = 1280;
/**
 * The class-values note while a ship's /ship-stats lookup is in flight.
 */
const LOOKUP_PENDING_NOTE = "waiting for the hub's /ship-stats answer";

export type ShipStatus = 'queued' | 'building' | 'validated' | 'ready' | 'failed' | 'destroyed';

/**
 * A ship destroyed with death "explode": its kill, the explosion chosen, when the explosion starts (the killing shot's
 * draw plus its firing delay) and the boundary its ball leaves.
 */
interface ShipDeath {
  readonly kill: ShipKill;
  readonly choice: ShipExplosionChoice;
  readonly removeTick: number;
  /**
   * The scene clock the explosion starts at, once the killing shot drew (or was dropped).
   */
  start: Maybe<number>;
  begun: boolean;
  /**
   * Without a renderer: the schedule and how many of its sounds were posted.
   */
  schedule: Maybe<ExplosionTimes>;
  posted: number;
  /**
   * Its hull's drawing retired (the wreck switch).
   */
  hidden: boolean;
  /**
   * Its ball left both parks.
   */
  gone: boolean;
}

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

/**
 * A module switch_modules switched, with its state after the call.
 */
export interface SwitchedModule extends Omit<ShipModuleRowState, 'note' | 'cycle' | 'readyIn' | 'targetDistance'> {
  /**
   * Its key (`mid-2`).
   */
  readonly module: string;
  readonly name: string;
}

export interface SwitchModulesResult {
  readonly tick: number;
  readonly state: ModuleSwitchState;
  readonly ships: { readonly id: string; readonly modules: SwitchedModule[] }[];
  /**
   * Ships and modules left alone, with why (no fit, a selector matching none of its modules, a refusal).
   */
  readonly skipped: { readonly id: string; readonly module?: string; readonly reason: string }[];
}

/**
 * What set_target did.
 */
export interface SetTargetResult {
  readonly tick: number;
  readonly target: Maybe<string>;
  readonly ships: {
    readonly id: string;
    readonly target: Maybe<string>;
    readonly previous?: string;
    /**
     * The ship's turrets (its fit's, or its default guns).
     */
    readonly turrets: number;
    /**
     * Its running turrets that follow the change: a new target at their first cycle once it is locked, none at their
     * cycle end.
     */
    readonly retargeted: number;
    /**
     * Its lock on the target (locks.ts), or why it was refused; null without a target or targeting numbers.
     */
    readonly lock?: Maybe<ShipLockReportState>;
  }[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
}

/**
 * A lock in a tool result: its state, or why it was refused.
 */
export type ShipLockReportState = Omit<ShipLockReport, 'target'> | { readonly refused: string };

export interface EngageResult {
  readonly tick: number;
  readonly target: string;
  readonly ships: { readonly id: string; readonly target: string; readonly lock: Maybe<ShipLockReportState>; readonly modules: { readonly module: string; readonly name: string; readonly state: string }[] }[];
  readonly skipped: { readonly id: string; readonly module?: string; readonly reason: string }[];
  readonly warnings?: string[];
}

export interface CeaseFireResult {
  readonly tick: number;
  readonly ships: { readonly id: string; readonly modules: string[]; readonly unlocked?: true }[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
}

/**
 * Called with every kill at its tick boundary, with the killing shot (Director.OnKill).
 */
export type KillListener = (kill: ShipKill, shot: WeaponShot) => void;

/**
 * Called with every shot at its tick boundary, before it draws (Director.OnShot).
 */
export type ShotListener = (shot: WeaponShot) => void;

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
   * The hub's fit lookups (/fit/type, /dogma/types, /dogma/skills); a fresh one by default.
   */
  readonly fits?: FitLookup;
  /**
   * The hub's /weapon lookups (the turret graphics); a fresh one by default.
   */
  readonly weapons?: WeaponLookup;
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
  /**
   * What a target given by name resolved to (resolveNamedOrderTarget).
   */
  readonly resolved?: ResolvedNamedOrderTarget;
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
   * Ships added with warpIn: parked off-grid, then landed from warp (arrivals.ts).
   */
  readonly arrivals: Arrivals;
  /**
   * The scene location's system data from the hub, and its get_state report.
   */
  readonly location: LocationLookup;
  /**
   * What the location draws around the scene (location-dressing.ts): nebula, star, planets, moons, stations, gates.
   */
  readonly dressing: LocationDressing;
  /**
   * The scene's static objects as drawn (scene-objects.ts); their balls are the world's.
   */
  readonly objects: SceneObjects;
  /**
   * The location's stations and gates as order targets (`celestial:<id>`), each a static ball, and the location key
   * they were made for.
   */
  private readonly celestialTargets = new Map<string, CelestialTarget>();
  private celestialKey: Maybe<string> = null;
  /**
   * The engine sounds (audio.ts).
   */
  readonly audio: PageAudio;
  scene: Maybe<SceneDocument> = null;
  private readonly onChange: () => void;
  private readonly hullStats: HullStatsLookup;
  private readonly propMods: PropModLookup;
  private readonly fitLookup: FitLookup;
  private readonly weapons: WeaponLookup;
  /**
   * Weapon types whose /weapon lookup is in flight: when one lands every ship syncs its turrets.
   */
  private readonly weaponRequests = new Set<number>();
  /**
   * The default weapons of ships without a fit, per hull type and DNA race (defaultWeaponsOf).
   */
  private readonly defaultWeapons = new Map<string, DefaultWeapons>();
  /**
   * What each ship flies with, as get_state reports it.
   */
  private readonly flights = new Map<string, ShipFlight>();
  /**
   * Each fitted ship's fit as last resolved (fittings.ts): the text applied, the typed modules and the dogma input.
   */
  private readonly fittings = new Map<string, ResolvedShipFitting>();
  /**
   * The fitted modules' activation (modules.ts): every module but the prop mod, which stays DestinyWorld's.
   */
  readonly modules: ShipModules;
  /**
   * Each fitted ship's current HP and the repairs running on it (damage.ts).
   */
  readonly damage = new DamageModel();
  /**
   * Each fitted ship's live capacitor level (capacitor.ts): neuts, nos and transmitters move it.
   */
  readonly capacitor: CapacitorModel;
  /**
   * The GJ each capacitor warfare module moved at its latest cycle start, by `<ship>|<module>`.
   */
  private readonly capacitorMoved = new Map<string, number>();
  /**
   * A ship with incoming modifiers flown without them, for get_state's speed and signature factors.
   */
  private readonly unaffectedFlights = new Map<string, ShipFlight>();
  /**
   * The running modules' drawn effects (module-effects.ts); null without a renderer.
   */
  private readonly moduleEffects: Maybe<ModuleEffects>;
  /**
   * Every ship's guns on its drawn hull (turrets.ts); null without a renderer.
   */
  private readonly turrets: Maybe<ShipTurrets>;
  /**
   * The turret files and their firing effects as values, with or without a renderer: the sets mount from them and
   * their sound events name the turret sounds (turret-plan.ts).
   */
  private readonly turretFiles = new TurretFiles({ read: (path) => ResourceValues(path) });
  /**
   * Turret sounds waiting for their bursts to start (turret-audio.ts).
   */
  private readonly turretSounds = new TurretSoundQueue();
  /**
   * Every ship's target (set_target; targets.ts): what its turrets aim and fire at.
   */
  readonly targets: ShipTargets;
  /**
   * Every ship's target locks (locks.ts): turrets fire only at a locked target.
   */
  readonly locks: ShipLocks;
  /**
   * The shots' rolls and damage, kills and tallies (combat.ts).
   */
  readonly combat: CombatRules;
  /**
   * Ships engaged on their target (engage): the module selectors kept firing until cease_fire.
   */
  private readonly engagements = new Map<string, { readonly modules: readonly string[] }>();
  private readonly killListeners = new Set<KillListener>();
  /**
   * Ships destroyed with death "explode", until a load revives them or remove_ship removes them.
   */
  private readonly deaths = new Map<string, ShipDeath>();
  private readonly explosionFiles = new ExplosionFiles({ read: (path) => ResourceValues(path) });
  /**
   * The drawn explosions (explosions.ts); null without a renderer.
   */
  private readonly explosions: Maybe<ShipExplosions>;
  /**
   * Which warp flashes play when (warp-fx.ts), counted with or without a renderer.
   */
  private readonly warpFx: WarpFx;
  /**
   * The drawn warp flashes (warp-effects.ts); null without a renderer.
   */
  private readonly warpEffects: Maybe<WarpEffects>;
  /**
   * The live fleet view (toLiveFleetScene), memoized by document and destroyed set.
   */
  private liveFleets: Maybe<{ readonly scene: SceneDocument; readonly gone: string; readonly view: LiveFleetView<SceneDocument> }> = null;
  /**
   * The shield fraction each ship's impact overlay was last synced at by the recharge.
   */
  private readonly rechargeSynced = new Map<string, number>();
  /**
   * The shots raised at the boundaries, drawn one tick after their cycle start (shots.ts).
   */
  private readonly shots: ShotQueue;
  private readonly shotListeners = new Set<ShotListener>();
  /**
   * Per fitted ship: the module specs last given to the activation layer; per ship: the module states and the incoming
   * target effects its flight was computed with (FlownKey).
   */
  private readonly moduleSpecs = new Map<string, string>();
  private readonly flownStates = new Map<string, string>();
  /**
   * The camera following its target ship (camera.ts).
   */
  private readonly cameraFollow = new CameraFollow();
  /**
   * The cinematic camera (cinema.ts).
   */
  readonly cinema = new CinemaRig();
  /**
   * The location answer's celestials as the cinema reads them, kept per answer.
   */
  private cinemaCelestials: Maybe<{ readonly answer: object; readonly list: CinemaCelestial[] }> = null;
  /**
   * The camera a page change already applied, so the document write that follows does not frame it again.
   */
  private appliedCamera: Maybe<string> = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ engine, engineError, store, world, clock, onChange = () => undefined, hullStats = new HullStatsLookup(), propMods = new PropModLookup(), fits = new FitLookup(), weapons = new WeaponLookup(), audioDisabled = false }: DirectorOptions) {
    this.hullStats = hullStats;
    this.propMods = propMods;
    this.fitLookup = fits;
    this.weapons = weapons;
    this.engine = engine;
    this.engineError = engineError;
    this.store = store;
    this.world = world;
    this.clock = clock;
    this.onChange = onChange;
    // Fleets fly and take orders as they are live: the destroyed taken out (toLiveFleetScene).
    this.following = new FleetFollowing({ world, scene: () => this.LiveFleets()?.scene ?? null, radiusOf: (id) => this.FormationRadius(id) });
    this.orders = new FleetOrders({ world, following: this.following, scene: () => this.LiveFleets()?.scene ?? null });
    this.arrivals = new Arrivals({
      world,
      placement: (id) => this.scene?.ships.find((doc) => doc.id === id) ?? null,
      ready: (id) => this.ArrivalReady(id),
      fleetReady: (fleet) => this.following.Ready(fleet),
      groupOffsets: (fleet, leader, ships) => this.following.GroupOffsets(fleet, leader, ships),
      followState: (id) => this.following.Report(id)?.state ?? null
    });
    this.dressing = new LocationDressing({
      engine,
      parts: ReadDressParts(),
      retained: () => [...this.ShipRoots(), ...this.objects.Roots(), ...this.ModuleEffectRoots(), ...this.ExplosionRoots(), ...this.WarpEffectRoots()],
      onChange: () => this.onChange(),
      detachAudio: (build) => this.audio.Detached(build)
    });
    this.objects = new SceneObjects({ engine, retained: () => [...this.ShipRoots(), ...this.dressing.Roots(), ...this.ModuleEffectRoots(), ...this.ExplosionRoots(), ...this.WarpEffectRoots()], onChange: () => this.onChange(), onBuilt: (id) => this.ObjectBuilt(id), detachAudio: (build) => this.audio.Detached(build) });
    this.location = new LocationLookup({
      onChange: () => {
        this.Redress();
        this.onChange();
      }
    });
    // A module already running when audio turns on has played its one-shot activation: nothing to post.
    this.audio = new PageAudio({ disabled: audioDisabled, onChange: () => this.onChange() });
    world.OnPropMod((event) => this.PostPropModAudio(event));
    this.moduleEffects = engine
      ? new ModuleEffects({
          engine,
          ships: { ShipOf: (id) => this.live.get(id)?.ship ?? null, CurvesOf: (id) => world.Curves(id), RadiusOf: (id) => this.live.get(id)?.ship?.boundingSphereRadius || UNBUILT_RADIUS },
          retained: () => [...this.ShipRoots(), ...this.dressing.Roots(), ...this.objects.Roots(), ...this.ExplosionRoots(), ...this.WarpEffectRoots()],
          detachAudio: (build) => this.audio.Detached(build)
        })
      : null;
    this.explosions = engine
      ? new ShipExplosions({
          engine,
          files: this.explosionFiles,
          retained: () => [...this.ShipRoots(), ...this.dressing.Roots(), ...this.objects.Roots(), ...this.ModuleEffectRoots(), ...this.WarpEffectRoots()],
          detachAudio: (build) => this.audio.Detached(build),
          onHide: (id) => this.Hide(id),
          onSound: (id, event) => this.PostExplosionSound(id, event)
        })
      : null;
    this.warpFx = new WarpFx({
      RadiusOf: (id) => this.live.get(id)?.ship?.boundingSphereRadius || this.flights.get(id)?.radius || UNBUILT_RADIUS,
      DrawnPosition: (id, now) => {
        const curves = world.Curves(id);
        return curves ? (Array.from(curves.translation.GetValueAt__Ticks(now, vec3.create())) as SceneVector) : null;
      },
      InWarp: (id) => world.InWarp(id),
      get tick() {
        return world.tick;
      }
    });
    this.warpEffects = engine
      ? new WarpEffects({
          engine,
          retained: () => [...this.ShipRoots(), ...this.dressing.Roots(), ...this.objects.Roots(), ...this.ModuleEffectRoots(), ...this.ExplosionRoots()],
          detachAudio: (build) => this.audio.Detached(build)
        })
      : null;
    this.turrets = engine ? new ShipTurrets({ files: this.turretFiles, detachAudio: (build) => this.audio.Detached(build), drawnTarget: (id) => this.live.get(id)?.ship ?? this.objects.Entry(id)?.object ?? null }) : null;
    // A destroyed ship is no target: nothing locks, aims or runs a module on it.
    const live = (id: string): boolean => world.Curves(id) != null && !this.combat.IsDestroyed(id);
    this.targets = new ShipTargets({ HasShip: live, HasObject: (id) => this.IsAuthoredObject(id), SurfaceDistance: (a, b) => world.SurfaceDistance(a, b) });
    this.shots = new ShotQueue(world.master.tickInterval / 1000);
    this.capacitor = new CapacitorModel(world.master.tickInterval / 1000);
    this.locks = new ShipLocks({
      SurfaceDistance: (a, b) => world.SurfaceDistance(a, b),
      InWarp: (id) => world.InWarp(id),
      IsTargetable: (id) => live(id) || this.IsAuthoredObject(id),
      Targeting: (id) => this.LockTargeting(id),
      SignatureOf: (id) => this.SignatureOf(id),
      get tickSeconds() {
        return world.master.tickInterval / 1000;
      }
    });
    this.combat = new CombatRules({
      port: {
        Accuracy: (ship, target, numbers) => world.Accuracy(ship, target, numbers),
        Speed: (id) => world.Motion(id)?.speed ?? 0,
        Weapon: (ship, module) => this.modules.Spec(ship, module)?.combat ?? null,
        SignatureOf: (id) => this.SignatureOf(id),
        KindOf: (id) => this.targets.KindOf(id),
        get tickSeconds() {
          return world.master.tickInterval / 1000;
        }
      },
      damage: this.damage,
      onKill: (kill, shot) => this.Killed(kill, shot),
      onDamaged: (id) => this.SyncImpactState(id)
    });
    this.modules = new ShipModules({
      SurfaceDistance: (a, b) => world.SurfaceDistance(a, b),
      // An arriving ship runs nothing until it lands, as in warp.
      InWarp: (id) => world.InWarp(id) || world.Arriving(id),
      HasShip: live,
      HasObject: (id) => this.IsAuthoredObject(id),
      LockHold: (ship, target) => this.locks.Hold(ship, target, world.tick),
      get tickSeconds() {
        return world.master.tickInterval / 1000;
      }
    });
    // Shields recharge, then locks advance and engagements re-arm, then cycles land: right after the prop mods apply
    // and before orders, so a siege module's physics fly from that tick.
    world.OnBoundary((boundary) => {
      this.RemoveDead(boundary);
      this.SyncRecharged(this.combat.Recharge(world.master.tickInterval / 1000));
      this.LockEvents(this.locks.Boundary(boundary, this.WantedLocks()));
      this.Engagements(boundary);
      this.ModuleEvents(this.modules.Boundary(boundary));
      // Arriving groups plan once ready; their warp-ins start at this boundary at the earliest.
      this.arrivals.Boundary(boundary);
    });
    world.OnWarp((event) => {
      if (event.kind === 'enter') {
        this.locks.OnWarpEnter(event.id);
        const cleared = this.targets.OnWarpEnter(event.id);
        for (const { ship } of cleared) this.turrets?.Aim(ship, null);
        this.PostTurretAims(cleared.map(({ ship }) => ({ ship, aim: 'idle' })));
        this.ModuleEvents(this.modules.OnWarpEnter(event.id, event.tick));
      }
      this.PlayWarpFlashes(this.warpFx.OnWarp(event));
    });
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
      switch_modules: (args) => this.SwitchModules(args),
      set_target: (args) => this.SetTarget(args),
      engage: (args) => this.Engage(args),
      cease_fire: (args) => this.CeaseFire(args),
      order_fleet: (args) => this.OrderFleet(args),
      list_hardpoints: (args) => this.ListHardpoints(args),
      play_shot: (args) => this.PlayShot(args),
      play_sequence: (args) => this.PlayShot({ shots: args['shots'] }),
      stop_shot: (args) => this.StopShot(args),
      resume_shot: () => this.ResumeShot()
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
    if (this.IsDead(id)) throw new Error(`ship "${id}" was destroyed`);
    const named = this.NamedTarget({ order, from: id, where: 'order' });
    const normalized = normalizeShipOrderRequest(named.order, { ships, objects: this.TargetIds(), self: id });
    if (normalized.type === 'rejoin') return { id, order: normalized, tick: this.world.tick, following: this.following.Rejoin(id) };
    const refusal = this.world.OrderRefusal(id, normalized);
    if (refusal !== null || !this.world.Order(id, normalized)) throw new Error(refusal ?? `ship "${id}" or its target has no Destiny ball`);
    const following = this.following.Detach(id);
    return { id, order: normalized, tick: this.world.tick, ...(following ? { following } : {}), ...(named.resolved ? { resolved: named.resolved } : {}) };
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
    const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    const fc = this.scene?.fleets?.find((fleet) => fleet.id === record?.['fleet'])?.commander;
    const named = record ? this.NamedTarget({ order: record['order'], from: fc, where: 'order_fleet.order' }) : { order: undefined };
    const request = normalizeFleetOrderRequest(named.resolved ? { ...record, order: named.order } : input, { ships: new Set((this.scene?.ships ?? []).map((doc) => doc.id)), objects: this.TargetIds() });
    const resolved = named.resolved ? { resolved: named.resolved } : {};
    if (!isFleetStructureOrder(request.order)) return Promise.resolve({ ...this.orders.Fly(this.orders.Resolve(request)), ...resolved });
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
      if (this.IsDead(id)) {
        skipped.push({ id, reason: 'it was destroyed' });
        continue;
      }
      const why = doc?.propMod?.module == null && doc?.fit ? 'its fit has no MWD or AB' : `propMod.module "${this.PropModModule(doc)}"`;
      const refusal = this.FitsPropMod(doc) ? this.world.PropModRefusal(id, command.active) : `it fits no prop mod (${why})`;
      const result = refusal === null ? this.world.SwitchPropMod(id, command.active, { delay: delays.get(id) }) : null;
      if (result) {
        const module = this.flights.get(id)?.propMod?.name ?? String(this.PropModModule(doc));
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
   * Switches the selected ships' fitted modules live, on EVE's cycle timing (modules.ts): the prop module through the
   * same DestinyWorld calls as switch_prop_mods, the rest through the activation layer. Not saved.
   *
   * @param input - The switch_modules arguments: modules, state, target, delay and a selection.
   * @returns The tick, each switched module's state after the call, and what was skipped with why.
   * @throws {SceneError} When the switch is invalid, names an unknown ship, fleet, wing or squad, or a target that is
   *   no ship in the scene.
   */
  SwitchModules(input: unknown): SwitchModulesResult {
    const command = normalizeModuleSwitch(input);
    const scene = this.Current();
    const selected = selectFleetShips(scene, command);
    const problems = [...selected.problems];
    if (command.target?.startsWith(CELESTIAL_TARGET_PREFIX)) problems.push(`switch.target "${command.target}": ${CELESTIAL_TARGET_REFUSAL}`);
    else if (command.target && !scene.ships.some((doc) => doc.id === command.target) && !(scene.objects ?? []).some((doc) => doc.id === command.target)) problems.push(`switch.target: no ship or object "${command.target}"`);
    if (problems.length) throw new SceneError(problems);
    const docs = new Map(scene.ships.map((doc) => [doc.id, doc]));
    const key = `modules|${command.fleet ?? ''}|${command.wing ?? ''}|${command.squad ?? ''}`;
    const delays = toPilotDelays({ key, tick: this.world.tick, delay: command.delay ?? 0, ships: selected.ships, issuer: '' });
    const ships: SwitchModulesResult['ships'] = [];
    const skipped: SwitchModulesResult['skipped'] = [];
    for (const id of selected.ships) {
      const resolved = this.fittings.get(id);
      if (this.IsDead(id)) {
        skipped.push({ id, reason: 'it was destroyed' });
        continue;
      }
      if (!resolved?.dogma) {
        skipped.push({ id, reason: resolved ? `its fit has not resolved: ${resolved.note ?? 'waiting for the hub'}` : docs.get(id)?.fit ? 'its fit has not resolved yet' : 'it has no fit (ships[].fit)' });
        continue;
      }
      const { modules, unmatched } = selectFittedModules({ modules: resolved.modules }, command.modules);
      for (const selector of unmatched) skipped.push({ id, module: selector, reason: 'it fits no module matching it' });
      // Turrets fire at the ship's target: a switch's target becomes it first, as set_target would.
      const aimsTurrets = command.state === 'active' && command.target != null && command.target !== id && modules.some((module) => module.weapon === 'turret');
      if (aimsTurrets && command.target && this.targets.KindOf(command.target) && !this.world.InWarp(id) && !this.world.InWarp(command.target)) this.SetShipTarget(id, command.target);
      const switched: SwitchedModule[] = [];
      for (const module of modules) {
        const result = this.SwitchModule(id, module, command, delays.get(id) ?? 0);
        if (typeof result === 'string') skipped.push({ id, module: module.key, reason: result });
        else switched.push(result);
      }
      // Turrets switched on wait for the lock on the ship's target (EVE's pre-activation): make sure it is asked for.
      const aim = this.targets.Of(id);
      if (aim && command.state === 'active' && modules.some((module) => module.weapon === 'turret')) this.RequestLock(id, aim);
      if (switched.length) ships.push({ id, modules: switched });
    }
    this.onChange();
    return { tick: this.world.tick, state: command.state, ships, skipped };
  }

  /**
   * Points the selected ships' turrets at a ship or authored object and starts their locks, or clears their targets
   * (null), live and not saved. Running turrets retarget at their first cycle once the new target is locked; a cleared
   * target stops them at their cycle end, and ends the ship's engagement.
   *
   * @param input - The set_target arguments: target and a selection.
   * @returns The tick, each ship's target with its previous one, and what was skipped with why.
   * @throws {SceneError} When the command is invalid, names an unknown ship, fleet, wing or squad, or a target that is
   *   no ship or object in the scene.
   */
  SetTarget(input: unknown): SetTargetResult {
    const command = normalizeTargetCommand(input);
    const scene = this.Current();
    const selected = selectFleetShips(scene, command);
    const problems = [...selected.problems];
    const { target } = command;
    const kind = target ? this.targets.KindOf(target) : null;
    let why = '';
    if (target && scene.ships.some((doc) => doc.id === target)) why = this.combat.IsDestroyed(target) ? ' (it was destroyed)' : ' (it has no Destiny ball yet)';
    if (target && !kind) problems.push(`set_target.target: no ship or object "${target}"${why}`);
    if (problems.length) throw new SceneError(problems);
    const ships: SetTargetResult['ships'] = [];
    const skipped: SetTargetResult['skipped'] = [];
    for (const id of selected.ships) {
      let reason: Maybe<string> = null;
      if (target === id) reason = 'it cannot target itself';
      else if (this.combat.IsDestroyed(id)) reason = 'it was destroyed';
      else if (this.world.InWarp(id)) reason = 'it is in warp';
      else if (target && kind === 'ship' && this.world.InWarp(target)) reason = `its target "${target}" is in warp`;
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      const turrets = (this.fittings.get(id)?.modules ?? []).filter((module) => module.weapon === 'turret');
      const retargeted = this.modules.Running(id).filter((spec) => spec.activation.weapon === 'turret').length;
      const previous = this.SetShipTarget(id, target ?? null);
      if (!target) this.engagements.delete(id);
      const lock = target ? this.LockState(id, target, this.locks.Of(id).some((held) => held.target === target) ? null : this.RequestLock(id, target)) : null;
      ships.push({ id, target: target ?? null, ...(previous && previous !== target ? { previous } : {}), turrets: turrets.length, retargeted: previous === (target ?? null) ? 0 : retargeted, ...(lock ? { lock } : {}) });
    }
    this.onChange();
    return { tick: this.world.tick, target: target ?? null, ships, skipped };
  }

  /**
   * Arms the selected ships' weapons on a target: it becomes their target and they lock it, and their matching turrets
   * switch active, wait for the lock and fire. Each boundary an engaged ship's matching turrets back online switch active
   * again (Engagements), so they fire again after a lost lock or on a new set_target. It ends on cease_fire, set_target
   * null, the ship's death or removal, or a load; it survives the target's death (the guns hold for a new target).
   *
   * @param input - The engage arguments: target, modules (default ["turret"]) and a selection.
   * @returns The tick, each armed ship's lock and switched turrets, what was skipped with why, and team warnings.
   * @throws {SceneError} When the command is invalid, names an unknown ship, fleet, wing or squad, or a target that is no
   *   live ship or object in the scene.
   */
  Engage(input: unknown): EngageResult {
    const command = normalizeEngageCommand(input);
    const scene = this.Current();
    const selected = selectFleetShips(scene, command);
    const problems = [...selected.problems];
    const { target } = command;
    const kind = this.targets.KindOf(target);
    const inScene = scene.ships.some((doc) => doc.id === target);
    if (!kind) problems.push(`engage.target: no ship or object "${target}"${inScene ? (this.combat.IsDestroyed(target) ? ' (it was destroyed)' : ' (it has no Destiny ball yet)') : ''}`);
    if (problems.length) throw new SceneError(problems);
    const docs = new Map(scene.ships.map((doc) => [doc.id, doc]));
    const team = docs.get(target)?.team;
    const ships: EngageResult['ships'] = [];
    const skipped: EngageResult['skipped'] = [];
    const warnings: string[] = [];
    for (const id of selected.ships) {
      const resolved = this.fittings.get(id);
      const turrets = resolved?.dogma ? selectFittedModules({ modules: resolved.modules }, command.modules).modules.filter((module) => module.weapon === 'turret') : [];
      let reason: Maybe<string> = null;
      if (target === id) reason = 'it cannot engage itself';
      else if (this.combat.IsDestroyed(id)) reason = 'it was destroyed';
      else if (this.world.InWarp(id)) reason = 'it is in warp';
      else if (kind === 'ship' && this.world.InWarp(target)) reason = `its target "${target}" is in warp`;
      else if (!resolved?.dogma) reason = resolved ? `its fit has not resolved: ${resolved.note ?? 'waiting for the hub'}` : 'its weapons have not resolved yet';
      else if (!this.LockTargeting(id)) reason = 'it has no targeting numbers (no EVE dogma for its hull)';
      else if (!turrets.length) reason = `it fits no turret matching ${command.modules.join(', ')}`;
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      if (team && docs.get(id)?.team === team) warnings.push(`"${id}" and its target "${target}" are both on team "${team}"`);
      this.SetShipTarget(id, target);
      this.engagements.set(id, { modules: command.modules });
      const modules: EngageResult['ships'][number]['modules'] = [];
      for (const module of turrets) {
        const refusal = this.modules.Switch(id, module.key, 'active', { boundary: this.world.tick, target });
        if (refusal) skipped.push({ id, module: module.key, reason: refusal });
        else modules.push({ module: module.key, name: module.name, state: this.modules.CycleState(id, module.key) ?? 'online' });
      }
      const held = this.locks.Of(id).some((lock) => lock.target === target);
      ships.push({ id, target, lock: this.LockState(id, target, held ? null : this.RequestLock(id, target)), modules });
    }
    this.onChange();
    return { tick: this.world.tick, target, ships, skipped, ...(warnings.length ? { warnings } : {}) };
  }

  /**
   * Ends the selected ships' engagements: their engaged turrets switch online and stop at their cycle end. `unlock`
   * also clears their targets (as set_target null), and the lock sweep drops the locks.
   *
   * @param input - The cease_fire arguments: unlock and a selection.
   * @returns The tick, each ship's stopped turrets, and what was skipped with why.
   * @throws {SceneError} When the command is invalid or names an unknown ship, fleet, wing or squad.
   */
  CeaseFire(input: unknown): CeaseFireResult {
    const command = normalizeCeaseFireCommand(input);
    const scene = this.Current();
    const selected = selectFleetShips(scene, command);
    if (selected.problems.length) throw new SceneError([...selected.problems]);
    const ships: CeaseFireResult['ships'] = [];
    const skipped: CeaseFireResult['skipped'] = [];
    for (const id of selected.ships) {
      const engagement = this.engagements.get(id);
      this.engagements.delete(id);
      const resolved = this.fittings.get(id);
      const turrets = resolved?.dogma ? selectFittedModules({ modules: resolved.modules }, engagement?.modules ?? DEFAULT_ENGAGE_MODULES).modules.filter((module) => module.weapon === 'turret') : [];
      const modules: string[] = [];
      for (const module of turrets) {
        const state = this.modules.CycleState(id, module.key);
        if (state !== 'activating' && state !== 'active' && state !== 'reactivating') continue;
        if (!this.modules.Switch(id, module.key, 'online', { boundary: this.world.tick })) modules.push(module.key);
      }
      const unlocked = command.unlock && this.targets.Of(id) != null;
      if (unlocked) this.SetShipTarget(id, null);
      if (!engagement && !modules.length && !unlocked) skipped.push({ id, reason: 'it is not engaged and its turrets are not firing' });
      else ships.push({ id, modules, ...(unlocked ? { unlocked: true as const } : {}) });
    }
    this.onChange();
    return { tick: this.world.tick, ships, skipped };
  }

  /**
   * Listens to every weapon shot at its tick boundary, before it draws: the hook Combat rules builds on (it sets
   * `missed`, applies damage and calls SyncImpactState there). Listeners run in registration order; a throwing one is
   * logged and the rest still run.
   *
   * @param listener - Called with each shot.
   * @returns The unsubscribe.
   */
  OnShot(listener: ShotListener): () => void {
    this.shotListeners.add(listener);
    return () => {
      this.shotListeners.delete(listener);
    };
  }

  /**
   * Listens to every kill at its tick boundary, with the killing shot: for the fleet targeting lever and the automatic
   * camera. A listener that throws is logged and the rest still run.
   *
   * @param listener - Called with each kill.
   * @returns The unsubscribe.
   */
  OnKill(listener: KillListener): () => void {
    this.killListeners.add(listener);
    return () => {
      this.killListeners.delete(listener);
    };
  }

  /**
   * Re-arms a built ship's or object's impact overlay with its remaining HP fractions (the damage model's; full when
   * it tracks none), so the firing effects draw impacts on it: shield above 5 %, then armor, then hull.
   *
   * @param id - The ship or object id.
   */
  SyncImpactState(id: string): void {
    const drawn = this.live.get(id)?.ship ?? this.objects.Entry(id)?.object ?? null;
    if (typeof drawn?.SetImpactDamageState !== 'function') return;
    const fractions = this.damage.Fractions(id);
    drawn.SetImpactDamageState(fractions?.shield ?? 1, fractions?.armor ?? 1, fractions?.structure ?? 1);
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
   * Places the running modules' effects for the frame at `now` (beam ends from the drawn balls, overlays on rebuilt
   * hulls). Runs between world.Tick and engine.Frame.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveModuleEffects(now: number): void {
    this.moduleEffects?.Frame(now);
  }

  /**
   * Plays the warp-in flashes due on the frame at `now` (a ship drawn near its landing) and removes the flashes that
   * ran out. Runs between world.Tick and engine.Frame, after DriveModuleEffects.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveWarpEffects(now: number): void {
    this.PlayWarpFlashes(this.warpFx.Frame(now), now);
    this.warpEffects?.Frame(now);
  }

  /**
   * Draws warp flash commands (counted by warpFx with or without a renderer).
   *
   * @param commands - The commands.
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  private PlayWarpFlashes(commands: readonly WarpFxCommand[], now = this.clock.now): void {
    if (commands.length) this.warpEffects?.Play(commands, now);
  }

  /**
   * Draws the shots due by `now` (one tick after their exact cycle start), settles weapons whose last burst ran, and
   * keeps every ship's guns on its hull and on its target for the frame (an animated hull rebinds them to its bones
   * once they load; a rebuilt target is re-aimed). Then posts the turret sounds due: each drawn burst's firing and
   * impact events as it starts, and the guns' deploy and pack events (turret-audio.ts). Runs between world.Tick and
   * engine.Frame.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveTurrets(now: number): void {
    const drawn = this.shots.Due(now).flatMap((shot) => {
      const sound = this.DrawShot(shot, now);
      // The explosion starts as the killing shot's burst lands; a shot dropped at the draw starts it at once.
      if (shot.fatal) this.ExplosionStarts(shot.target, sound?.at ?? now);
      return sound ?? [];
    });
    if (drawn.length) this.turretSounds.Add(TurretAudioPosts({ shots: drawn, transitions: [], facts: (ship, module) => this.TurretSoundFactsOf(ship, module) }));
    for (const weapon of this.shots.Settled(now)) this.turrets?.Settle(weapon.ship, weapon.module);
    this.turrets?.Frame();
    for (const post of this.turretSounds.Due(now)) {
      // A ship that left (or not built into the world yet) posts nothing: its emitter is released with it.
      if (this.world.Curves(post.ship)) this.audio.Post({ ship: post.ship, tick: post.tick, events: post.events, placement: this.AudioPlacement(post.ship, now) });
    }
  }

  /**
   * Plays the destroyed ships' explosions for the frame at `now`: with a renderer they draw (explosions.ts: the hull
   * hides at the wreck switch, each blast posts its sound); without one the schedule (ExplosionSchedule) posts the
   * sounds and hides the hull. A killing shot that never drew starts its explosion two ticks after the kill. Runs after
   * DriveTurrets.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  DriveExplosions(now: number): void {
    const tickSeconds = this.world.master.tickInterval / 1000;
    for (const [id, death] of this.deaths) {
      if (death.start == null && this.world.tick >= death.kill.tick + 2) death.start = now;
      if (death.start == null || death.gone) continue;
      if (!death.begun) {
        const curves = this.world.Curves(id);
        if (this.explosions && curves) {
          death.begun = true;
          const seed = sceneCombatOf(this.scene ?? {}).seed;
          this.explosions.Start(id, { ship: this.live.get(id)?.ship ?? null, curves, choice: death.choice, radius: this.flights.get(id)?.radius ?? UNBUILT_RADIUS, at: death.start, seed });
        } else if (!this.explosions) {
          const path = death.choice.resPath;
          const facts = this.explosionFiles.Cached(path)?.facts ?? null;
          if (!facts && !this.explosionFiles.Failure(path)) continue;
          death.begun = true;
          death.schedule = ExplosionSchedule({ start: death.start / TICKS_PER_SECOND, facts, deathTick: death.kill.tick, lingerSeconds: death.choice.lingerSeconds, tickSeconds });
        }
      }
      const { schedule } = death;
      if (!schedule) continue;
      const seconds = now / TICKS_PER_SECOND;
      for (; death.posted < schedule.sounds.length && schedule.sounds[death.posted].at <= seconds; death.posted += 1) this.PostExplosionSound(id, schedule.sounds[death.posted].event);
      if (!death.hidden && seconds >= schedule.hide) this.Hide(id);
    }
    this.explosions?.Frame(now);
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
    // The rig runs without a renderer too, so get_state's cinema reports headless.
    const frame = this.cinema.Frame(now, () => this.CinemaScene(now));
    this.engine?.SetCinematicFrame(frame);
  }

  /**
   * Plays a camera shot or sequence (cinema.ts) from now.
   *
   * @param input - The shot, `{ shots: [...] }` or an array of shots; library references (`{ shot: "<name>" }`) too.
   * @param driver - Who asked, for get_state.
   * @returns The rig's state, the driver, the shots as played and any warnings.
   * @throws {Error} When the shot is invalid.
   */
  PlayShot(input: unknown, driver: CinemaPlayer = 'claude'): CinemaPlayResult & { readonly driver: CinemaPlayer } {
    const result = this.cinema.Play(input, this.clock.now, driver);
    this.onChange();
    return { ...result, driver };
  }

  /**
   * Stops the shot (stop_shot): by default hands the camera back to the user, the orbit camera adopting the shot's view
   * (and following its ship); `adopt: false` blends back to the orbit's previous view, `cut` skips the blend, and
   * `pause` freezes the shot instead.
   */
  StopShot({ pause = false, adopt = true, cut = false }: { readonly pause?: unknown; readonly adopt?: unknown; readonly cut?: unknown } = {}): CinemaReport {
    if (pause === true) this.cinema.Pause(this.clock.now);
    else this.ReleaseCinema({ adopt: adopt !== false, cut: cut === true, note: 'stop_shot handed the camera back' });
    this.onChange();
    return this.cinema.Report(this.clock.now);
  }

  /**
   * Resumes a paused shot, or replays the last stopped or released one from where it stopped (resume_shot).
   *
   * @throws {Error} When nothing is paused or stopped.
   */
  ResumeShot(): CinemaReport {
    this.cinema.Resume(this.clock.now, 'claude');
    this.onChange();
    return this.cinema.Report(this.clock.now);
  }

  /**
   * A subject's hardpoints on the scene as drawn now (list_hardpoints).
   *
   * @throws {Error} When the subject is invalid.
   */
  ListHardpoints(args: Record<string, unknown>): HardpointListing & { readonly warnings: string[] } {
    const { subject, problems, warnings } = normalizeHardpointSubject(args);
    if (!subject) throw new Error(`Invalid hardpoint subject:\n- ${problems.join('\n- ')}`);
    const status = this.location.Report()?.status;
    if (subject.celestial != null && status !== 'ready') warnings.push(`the location is ${status ?? 'not set'}: its celestials may be missing`);
    return { ...toHardpointListing(subject, this.CinemaScene(this.clock.now)), warnings };
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
    const memberships = this.scene ? toFleetMemberships(this.LiveFleets()?.scene ?? this.scene) : new Map<string, ShipFleetMembership>();
    const ships = (this.scene?.ships ?? []).map((doc) => this.ShipState(doc, memberships.get(doc.id)));
    const moduleRows = new Map(ships.map((ship) => [ship.id, ship.fit?.modules ?? []]));
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
    const renderer: ({ available: true; moduleEffects: Maybe<ModuleEffectsReport>; turrets: Maybe<TurretsReport>; warpEffects: Maybe<WarpEffectsReport> } & EngineStats) | { available: false; reason: string } = this.engine
      ? { available: true, ...this.engine.Stats(), moduleEffects: this.moduleEffects?.Report() ?? null, turrets: this.turrets?.Report() ?? null, warpEffects: this.warpEffects?.Report() ?? null }
      : { available: false, reason: this.engineError?.message ?? 'not started' };
    return {
      renderer,
      scene: this.scene ? { name: this.scene.name, universe: this.scene.environment.universe, ships: this.scene.ships.length, fleets: this.scene.fleets?.length ?? 0, objects: this.scene.objects?.length ?? 0 } : null,
      location: this.LocationState(),
      camera: this.engine ? { ...this.engine.camera.Get(), view: this.cinema.active ? 'cinema' : 'orbit', drawn: DrawnCameraReport(this.engine.DrawnCamera()) } : null,
      cinema: this.cinema.Report(this.clock.now),
      environment: this.engine?.Environment() ?? null,
      simulation: { tick: this.world.tick, seconds: Math.round(this.clock.seconds * 100) / 100, warpFlashes: this.warpFx.Counts() satisfies WarpFlashCounts },
      ships,
      ...(this.arrivals.Report().length ? { arrivals: this.arrivals.Report() } : {}),
      distances,
      objects: this.ObjectRows(),
      combat: this.SceneCombatState(),
      fleets: this.scene
        ? toFleetReports(this.LiveFleets()?.scene ?? this.scene).map((report) => ({
            ...report,
            ...this.LiveFleetChange(report.id),
            formation: this.following.FleetReport(report),
            propMods: this.FleetPropMods(report.ships),
            modules: FleetModuleCountsOf(report.ships.flatMap((id) => moduleRows.get(id) ?? [])) satisfies FleetModuleCounts,
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
    this.cinema.Release(this.clock.now, { note: 'frame_camera took the camera' });
    const camera: SceneCamera = { ...this.Current().camera, target: target ?? null };
    if (IsFiniteNumber(yaw)) camera.yaw = yaw;
    if (IsFiniteNumber(pitch)) camera.pitch = pitch;
    camera.distance = IsFiniteNumber(distance) ? distance : null;
    if (mode != null && !SCENE_CAMERA_MODES.includes(mode)) throw new Error(`mode must be one of ${SCENE_CAMERA_MODES.join(', ')}`);
    if (mode) camera.mode = mode;
    if (persist) return this.Serialize(() => this.Apply(applySceneOperations(this.Current(), [{ op: 'set_camera', camera }])));
    if (camera.target && !this.live.has(camera.target) && !this.objects.Has(camera.target)) throw new Error(`no ship or object "${camera.target}"`);
    if (camera.target && this.world.Arriving(camera.target)) throw new Error(`ship "${camera.target}" is arriving by warp; frame it once it lands (get_state arrivals), or play the warp-in shot`);
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

  private async Apply({ scene, warnings, arrivals }: NormalizedScene, { restart = false }: ApplyOptions = {}): Promise<object> {
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
    // A load revives the destroyed: they retire here and rebuild as retried ships. A patch keeps them dead.
    if (restart) this.Revive();
    for (const doc of diff.removed) {
      this.explosions?.Remove(doc.id);
      this.deaths.delete(doc.id);
    }
    const alive = (doc: SceneShip): boolean => !this.IsDead(doc.id);
    // A ship that failed before is retried whenever the scene is applied again.
    const changed = new Set([...diff.rebuilt, ...diff.added].map((doc) => doc.id));
    const retried = scene.ships.filter((doc) => !changed.has(doc.id) && (this.live.get(doc.id)?.status ?? 'failed') === 'failed');
    const builds = [...diff.rebuilt, ...diff.added, ...retried].filter(alive);
    for (const doc of [...diff.removed, ...diff.rebuilt.filter(alive)]) this.Retire(doc.id);
    // Removed and rebuilt objects retire with the ships; added, rebuilt and failed ones queue.
    const objectBuilds = this.objects.Apply(diff.objects, scene);
    const stopped: string[] = [];
    const moduleEvents: ShipModuleEvent[] = [];
    if (restart) this.arrivals.Clear();
    for (const doc of diff.removed) {
      this.arrivals.Remove(doc.id);
      stopped.push(...this.world.RemoveShip(doc.id));
      this.flights.delete(doc.id);
      this.fittings.delete(doc.id);
      moduleEvents.push(...this.modules.Remove(doc.id, this.world.tick));
      this.ForgetTarget(doc.id);
      this.locks.Remove(doc.id);
      this.combat.Remove(doc.id);
      this.engagements.delete(doc.id);
      this.rechargeSynced.delete(doc.id);
      this.damage.Remove(doc.id);
      this.capacitor.Remove(doc.id);
      this.unaffectedFlights.delete(doc.id);
      for (const key of [...this.capacitorMoved.keys()]) if (key.startsWith(`${doc.id}|`)) this.capacitorMoved.delete(key);
      this.moduleSpecs.delete(doc.id);
      this.flownStates.delete(doc.id);
      this.audio.Release(doc.id);
    }
    for (const doc of diff.objects.removed) {
      // Turrets on it stop at once, as on a removed ship.
      moduleEvents.push(...this.modules.Remove(doc.id, this.world.tick));
      this.ForgetTarget(doc.id);
      this.locks.Remove(doc.id);
      stopped.push(...this.world.RemoveObject(doc.id));
    }
    this.scene = scene;
    const cinema = CinemaReleases({ restart, cameraChanged: diff.camera, removed: [...diff.removed, ...diff.objects.removed].map((doc) => doc.id), subjects: this.cinema.Subjects() });
    const subjectLeft = this.cinema.Subjects().some((id) => diff.removed.some((doc) => doc.id === id) || diff.objects.removed.some((doc) => doc.id === id));
    // A load or a removed subject forgets the shot; a camera change keeps it resumable.
    if (cinema === 'cut') this.cinema.Stop(this.clock.now, { cut: true, forget: true, note: 'a scene load cut the shot' });
    else if (cinema === 'release') this.cinema.Release(this.clock.now, subjectLeft ? { note: 'its subject left the scene', forget: true } : { note: "the document's camera changed" });
    if (restart || diff.location) {
      this.location.Update(scene.location ?? null, { retry: restart });
      this.Redress(scene.location ?? null);
    }
    // The document's seed and death mode apply to later shots and deaths.
    this.combat.SetCombat(sceneCombatOf(scene));
    if (restart) {
      this.hullStats.ForgetFailures();
      this.propMods.ForgetFailures();
      this.fitLookup.ForgetFailures();
      this.weapons.ForgetFailures();
      this.turretFiles.ForgetFailures();
      this.explosionFiles.ForgetFailures();
      // A load restarts every module online (or offline as fitted) and every ship at full HP.
      moduleEvents.push(...this.modules.Clear(this.world.tick));
      // Targets, locks, shots and kills are live state: a load starts with none, every ship alive.
      this.targets.Clear();
      this.locks.Clear();
      this.combat.Clear();
      this.engagements.clear();
      this.rechargeSynced.clear();
      this.shots.Clear();
      this.turretSounds.Clear();
      this.turrets?.ClearAims();
      this.turrets?.ResetBursts();
      this.damage.Clear();
      this.capacitor.Clear();
      this.capacitorMoved.clear();
      this.unaffectedFlights.clear();
      this.moduleSpecs.clear();
      this.flownStates.clear();
    }
    // Modules that ran on or at a removed ship stop: their ships fly again without them (a load retunes every ship).
    if (restart) {
      this.ModuleOutputs(moduleEvents);
      this.moduleEffects?.Clear();
      this.warpFx.Clear();
      this.warpEffects?.Clear();
    } else this.ModuleEvents(moduleEvents);

    // Balls follow the document, not the renderer: a rebuilt ship keeps its ball and keeps flying. They are in place
    // before the store write, so an order arriving meanwhile always finds a ball for every document ship.
    for (const doc of scene.ships) {
      const before = previous.get(doc.id);
      if (this.IsDead(doc.id)) continue;
      if (!this.world.Curves(doc.id)) {
        const flight = this.Flight(doc, this.hullStats.Cached(doc));
        this.world.AddShip(doc, flight ?? DEFAULT_SHIP_PHYSICS);
        if (flight) this.flights.set(doc.id, flight);
      } else if (restart || !before || !SamePlacement(before, doc)) this.world.PlaceShip(doc);
    }
    // Arriving ships park off-grid before anything is built, so a hull never shows at its landing.
    const arrivalKeys = (arrivals ?? []).map((arrival) => this.arrivals.Add(arrival));
    const moved = new Set(diff.objects.moved.map((doc) => doc.id));
    const resized = new Set([...diff.objects.resized, ...diff.objects.rebuilt].map((doc) => doc.id));
    for (const doc of scene.objects ?? []) {
      const radius = ObjectBallRadius({ radius: doc.radius, sofRadius: this.objects.Entry(doc.id)?.sofRadius }).radius;
      if (!this.world.HasObject(doc.id)) this.world.AddObject(doc, radius);
      else if (moved.has(doc.id) || resized.has(doc.id)) this.world.AddObject(doc, radius);
    }
    const retuned = restart ? scene.ships : [...diff.added, ...diff.rebuilt, ...diff.retuned];
    for (const id of new Set(retuned.filter(alive).map((doc) => doc.id))) this.Retune(id);
    // The document's prop mod state applies at once, like a placement: on a load, for added ships, for ships whose
    // propMod.active changed, and off for a ship whose module became "none".
    const switching = new Map((restart ? scene.ships : [...diff.added, ...diff.switched]).map((doc) => [doc.id, doc]));
    for (const doc of diff.retuned) if (!this.FitsPropMod(doc)) switching.set(doc.id, doc);
    for (const doc of [...switching.values()].filter(alive)) this.world.SetPropModActive(doc.id, doc.propMod?.active === true && this.FitsPropMod(doc));
    if (restart) this.orders.Reset();
    stopped.push(...this.following.Reconcile({ regrouped: diff.regrouped.map((doc) => doc.id), restart }));
    await this.store.Put(CURRENT_KEY, scene);
    for (const doc of builds) this.live.set(doc.id, { id: doc.id, dna: doc.dna, status: 'queued', ship: null, error: null, diagnostics: [], hull: null });
    this.onChange();

    // Builds are serialized by SOF anyway; awaiting them in order keeps the report in document order. Objects build
    // after the ships, so a heavy structure never holds a ship back.
    for (const doc of builds) await this.Build(doc);
    for (const entry of objectBuilds) await this.objects.Build(entry);
    this.engine?.SetDrawReach(this.objects.Reach(scene), 'objects');
    // Built and (usually) answered: plan now, so the result says when they land.
    if (arrivalKeys.length) this.arrivals.Boundary(this.world.tick);

    const reframe = ReframesAfterEdit({ restart, cameraChanged: diff.camera, following: this.cameraFollow.following, removed: [...diff.removed, ...diff.objects.removed].map((doc) => doc.id) });
    if (reframe && JSON.stringify(scene.camera) !== this.appliedCamera) this.ApplyCamera(scene.camera);
    this.appliedCamera = null;
    this.onChange();
    return {
      scene,
      warnings,
      ships: scene.ships.map((doc) => this.ShipReport(doc.id)),
      ...(scene.objects?.length || diff.objects.removed.length ? { objects: (scene.objects ?? []).map((doc) => this.ObjectReport(doc.id)) } : {}),
      ...(arrivalKeys.length ? { arrivals: this.arrivals.Report(arrivalKeys) } : {}),
      changes: {
        added: diff.added.length,
        rebuilt: diff.rebuilt.length,
        retried: retried.length,
        moved: diff.moved.length,
        removed: diff.removed.length,
        regrouped: diff.regrouped.length,
        switched: diff.switched.length,
        stopped: stopped.length,
        ...(scene.objects?.length || diff.objects.removed.length ? { objects: { added: diff.objects.added.length, rebuilt: diff.objects.rebuilt.length, moved: diff.objects.moved.length, removed: diff.objects.removed.length } } : {})
      }
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
      // A ship destroyed while it built is not drawn once its explosion hid it.
      if (this.deaths.get(doc.id)?.hidden) {
        entry.status = 'destroyed';
        return;
      }
      this.Retune(doc.id);
      if (this.engine) {
        // Inert SOF audio: only the page's emitters play (PageAudio.Detached).
        const ship = this.audio.Detached(() => HydrateShip(values));
        const curves = this.world.Curves(doc.id);
        if (curves) AttachShipCurves(ship, curves);
        this.engine.AddShip(ship);
        entry.ship = ship;
        entry.status = 'ready';
        this.SyncTurrets(doc.id);
        this.SyncImpactState(doc.id);
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
   * (if the ship still names the same hull by then), again when its prop mod's /prop-mod lookup lands, and again when
   * its fit's lookups land.
   *
   * @param id - The ship id.
   */
  private Retune(id: string): void {
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    if (!doc || this.IsDead(id)) return;
    const cached = this.hullStats.Cached(doc);
    this.SetFlight(doc, cached);
    this.LookupPropMod(doc, cached);
    this.LookupFit(doc, cached);
    if (cached) return;
    const key = HullStatsKey(doc);
    void this.hullStats.Lookup(doc).then((answer) => {
      const current = this.scene?.ships.find((ship) => ship.id === id);
      if (!current || HullStatsKey(current) !== key || this.IsDead(id)) return;
      this.SetFlight(current, answer);
      // The hull's size may pick a different hull-sized module; its type lets the fit's dogma run.
      this.LookupPropMod(current, answer);
      this.LookupFit(current, answer);
      this.following.Reconcile();
      this.onChange();
    });
  }

  /**
   * Starts a fitted ship's fit lookups when its fit is still pending (or waiting on the hull, to resolve its names
   * meanwhile), and retunes the ship when they land, if it still has the same fit by then.
   *
   * @param doc - The current document ship.
   * @param answer - Its /ship-stats answer; null while that lookup is in flight.
   */
  private LookupFit(doc: SceneShip, answer: Maybe<HullStatsAnswer>): void {
    const hullTypeID = answer?.hull?.typeID;
    // A ship without a fit flies its default weapons, which need the hull's dogma record first.
    if (!doc.fit && hullTypeID != null && this.fitLookup.TypePending(hullTypeID)) {
      const key = HullStatsKey(doc);
      void this.fitLookup.LookupTypes([hullTypeID]).then(() => {
        const current = this.scene?.ships.find((ship) => ship.id === doc.id);
        if (!current || current.fit || HullStatsKey(current) !== key) return;
        const hull = this.hullStats.Cached(current);
        this.SetFlight(current, hull);
        this.LookupFit(current, hull);
        this.onChange();
      });
      return;
    }
    const resolved = this.fittings.get(doc.id);
    if (!resolved || resolved.dogma || (!resolved.pending && answer)) return;
    const { text } = resolved;
    void this.fitLookup.Prepare({ text, typeIDs: resolved.typeIDs }).then(() => {
      const current = this.scene?.ships.find((ship) => ship.id === doc.id);
      if (!current || this.FitTextOf(current) !== text) return;
      const hull = this.hullStats.Cached(current);
      this.SetFlight(current, hull);
      // A prop mod that resolved meanwhile may need one more type.
      if (this.fittings.get(current.id)?.pending) this.LookupFit(current, hull);
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
      // A prop mod replacing the fit's own needs its dogma.
      this.LookupFit(current, hull);
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
    return PropModLookupTarget(this.PropModModule(doc), RigSizeOf({ published: answer?.hull, hull: this.live.get(doc.id)?.hull }));
  }

  /**
   * Flies a ship with the numbers its lookup answer gives; on a resolution error it keeps its previous physics.
   *
   * @param doc - The current document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   */
  private SetFlight(doc: SceneShip, answer: Maybe<HullStatsAnswer>): void {
    if (this.IsDead(doc.id) || !this.FlyFlight(doc, answer)) return;
    // A refit that stopped running modules changes the states the flight was computed with: fly once more.
    const stoppedByRefit = this.SyncModules(doc);
    if (stoppedByRefit.length) this.FlyFlight(doc, answer);
    const defense = this.flights.get(doc.id)?.defense;
    if (defense) this.damage.SetDefense(doc.id, defense);
    else this.damage.Remove(doc.id);
    const capacitor = this.flights.get(doc.id)?.capacitor;
    if (capacitor) this.capacitor.Set(doc.id, capacitor, this.world.tick);
    else this.capacitor.Remove(doc.id);
    this.ModuleOutputs(stoppedByRefit);
    this.SyncTurrets(doc.id);
  }

  /**
   * Resolves a ship's flight and sets it on its ball.
   *
   * @param doc - The current document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   * @returns Whether it flies the new numbers.
   */
  private FlyFlight(doc: SceneShip, answer: Maybe<HullStatsAnswer>): boolean {
    const flight = this.Flight(doc, answer);
    let flown = false;
    if (flight) {
      try {
        this.world.SetPhysics(doc.id, flight);
        this.flights.set(doc.id, flight);
        this.world.SetTackle(doc.id, this.TackleOf(doc.id, flight));
        flown = true;
      } catch (error) {
        console.error(`ship ${doc.id}: cannot fly ${JSON.stringify(flight)} (${ErrorText(error)}); it keeps its previous physics`);
      }
    }
    return flown;
  }

  /**
   * Gives the activation layer a ship's modules when they changed (a fit resolving, a refit, a module's numbers moving
   * with another's state, such as triage's remote reps).
   *
   * @param doc - The current document ship.
   * @returns The `off` events of running modules the refit removed.
   */
  private SyncModules(doc: SceneShip): ShipModuleEvent[] {
    // A destroyed ship gets no module specs: no re-fly or refit re-adds its modules.
    if (this.IsDead(doc.id)) return [];
    const resolved = this.fittings.get(doc.id);
    const dogma = this.LiveDogma(doc.id, resolved?.dogma);
    const specs = resolved && dogma ? ShipModuleSpecsOf({ ...resolved, dogma }, this.fitLookup, doc.stats) : [];
    const signature = JSON.stringify(specs);
    let events: ShipModuleEvent[] = [];
    if (this.moduleSpecs.get(doc.id) !== signature) {
      this.moduleSpecs.set(doc.id, signature);
      events = this.modules.SetFit(doc.id, specs, this.world.tick);
    }
    return events;
  }

  /**
   * A fitted ship's dogma input with its modules' live states (the prop module's stays the fit's: flight.ts runs it).
   *
   * @param id - The ship id.
   * @param dogma - Its resolved fit's dogma input.
   * @returns The input; null without one.
   */
  private LiveDogma(id: string, dogma: Maybe<ShipDogmaInput>): Maybe<ShipDogmaInput> {
    if (!dogma) return null;
    const modules = (dogma.modules ?? []).map((module) => {
      const state = module.key === dogma.propModKey ? null : this.modules.CycleState(id, module.key, module.typeID);
      return state == null ? module : { ...module, state: DogmaStateOf(state) };
    });
    return { ...dogma, modules };
  }

  /**
   * Module events from a tick boundary, a warp, a removal or a load: every ship whose modules' states changed, or whose
   * incoming target effects changed (a web or point on it starting, stopping, or a new cycle's falloff), flies again
   * with them (HP, resists, signature, siege and triage physics, webs, tackle), then the repairs and capacitor
   * transfers land.
   *
   * @param events - The events.
   */
  private ModuleEvents(events: readonly ShipModuleEvent[]): void {
    const index = this.modules.TargetIndex();
    for (const doc of [...(this.scene?.ships ?? [])]) {
      if (!this.flownStates.has(doc.id)) continue;
      const dogma = this.fittings.get(doc.id)?.dogma;
      const key = FlownKey(dogma ? this.LiveDogma(doc.id, dogma) : null, index.get(doc.id) ?? []);
      if (key !== this.flownStates.get(doc.id)) this.SetFlight(doc, this.hullStats.Cached(doc));
    }
    this.ModuleOutputs(events);
  }

  /**
   * What tackle stops a ship doing, from its flight (warpScrambleStatus) and the scrams running on it.
   *
   * @param id - The ship id.
   * @param flight - Its flight, with the incoming modifiers.
   * @returns The reasons for DestinyWorld.SetTackle.
   */
  private TackleOf(id: string, flight: ShipFlight): ShipTackle {
    const warp = flight.warpScrambleStatus > 0 ? warpScrambleNoteOf({ status: flight.warpScrambleStatus, steps: flight.warpScrambleSteps ?? [] }) : null;
    const blockers = flight.propMod?.kind === 'microwarpdrive' ? this.modules.Targeting(id).filter((module) => module.spec.activation.targetEffect?.blocksMicrowarpdrive) : [];
    return { warp, propMod: microwarpdriveBlockNoteOf(blockers.map((module) => incomingSourceLabel({ from: module.from, name: module.spec.name, key: module.spec.key }))) };
  }

  /**
   * Lands a capacitor transfer on its target's live capacitor, scaled by the target's resistance.
   *
   * @param landing - The transfer.
   */
  private LandCapacitor(landing: CapacitorLanding): void {
    const numbers = this.capacitor.Numbers(landing.target);
    const key = `${landing.from}|${landing.module}`;
    if (!numbers) {
      this.capacitorMoved.delete(key);
      return;
    }
    let resistance = 1;
    if (landing.resistanceAttributeID === TARGET_EFFECT_ATTRIBUTES.energyWarfareResistance) resistance = numbers.energyWarfareResistance;
    else if (landing.resistanceAttributeID === TARGET_EFFECT_ATTRIBUTES.remoteCapacitorImpedance) resistance = numbers.remoteCapacitorImpedance;
    const amount = landing.amount * resistance;
    const tick = this.world.tick;
    let moved: number;
    if (landing.kind === 'neut') moved = this.capacitor.Drain(landing.target, amount, tick);
    else if (landing.kind === 'nos') moved = this.capacitor.Nos(landing.from, landing.target, amount, landing.override, tick);
    else moved = this.capacitor.Give(landing.target, amount, tick);
    this.capacitorMoved.set(key, moved);
  }

  /**
   * What module events do besides the ship's numbers: repairs land in the damage model, capacitor transfers in the
   * live capacitor, and the client's effects and sounds play (module-fx.ts, module-audio.ts, module-effects.ts).
   *
   * @param events - The events.
   */
  private ModuleOutputs(events: readonly ShipModuleEvent[]): void {
    if (!events.length) return;
    const repaired = new Set<string>();
    for (const landing of this.modules.RepairLandings(events)) {
      this.damage.Repair(landing.ship, landing.layer, landing.amount);
      repaired.add(landing.ship);
    }
    for (const id of repaired) this.SyncImpactState(id);
    for (const landing of this.modules.CapacitorLandings(events)) this.LandCapacitor(landing);
    this.Shots(events);
    const commands = ModuleFxCommands(events);
    const docs = new Map((this.scene?.ships ?? []).map((doc) => [doc.id, doc]));
    for (const command of commands) {
      const doc = docs.get(command.ship);
      // A removed ship's emitter is already released: its voices stopped with it.
      if (!doc) continue;
      const size = HULL_SIZE_CLASSES[RigSizeOf({ published: this.hullStats.Cached(doc)?.hull, hull: this.live.get(command.ship)?.hull })];
      const { ship, events: sounds, stops } = ModuleAudioPost(command, size);
      if (sounds.length || stops.length) this.audio.Post({ ship, tick: command.tick, events: sounds, stops, placement: this.AudioPlacement(ship, this.clock.now) });
    }
    this.moduleEffects?.Apply(commands, this.clock.now);
    this.onChange();
  }

  /**
   * Turns a boundary's turret cycle starts into shots: Combat rules decide and apply each one, the OnShot listeners see
   * it, then it queues to draw one tick after its exact start. A stopped turret settles once its last burst has run.
   *
   * @param events - The module events.
   */
  private Shots(events: readonly ShipModuleEvent[]): void {
    const turret = (ship: string, key: string) => this.fittings.get(ship)?.modules.find((module) => module.key === key && module.weapon === 'turret' && module.typeID != null) ?? null;
    const shots = WeaponShotsOf(events, {
      Turret: (ship, key) => {
        const module = turret(ship, key);
        const charge = module?.charge?.typeID == null ? null : { typeID: module.charge.typeID, name: module.charge.name };
        return module?.typeID == null ? null : { typeID: module.typeID, name: module.name, ...(charge ? { charge } : {}) };
      },
      KindOf: (id): Maybe<ShotTargetKind> => this.targets.KindOf(id),
      SurfaceDistance: (a, b) => this.world.SurfaceDistance(a, b)
    });
    // Combat rules roll and apply them in their fixed order first: the listeners see `missed` and `outcome`.
    if (shots.length) this.combat.Resolve(shots, shots[0].tick);
    for (const shot of shots) {
      for (const listener of [...this.shotListeners]) {
        try {
          listener(shot);
        } catch (error) {
          console.error(`a shot listener failed: ${ErrorText(error)}`);
        }
      }
    }
    if (shots.length) this.shots.Add(shots, this.clock.now);
    for (const event of events) if (event.kind === 'off' && turret(event.ship, event.module)) this.shots.Off(event.ship, event.module);
  }

  /**
   * Draws one shot's burst, unless its shooter or target is gone, either is in warp, or its set is not mounted.
   *
   * @param shot - The shot.
   * @param now - The scene clock, in integer 100 ns ticks.
   * @returns Its sounds' source, starting with the burst (the set's random firing delay after the draw; at once without
   *   a renderer); null when it was dropped or, with a renderer, its set did not draw it.
   */
  private DrawShot(shot: WeaponShot, now: number): Maybe<TurretShotSound> {
    // A destroyed target still has its ball: the killing shot and the overkill after it draw.
    const present = this.world.Curves(shot.ship) != null && (this.world.Curves(shot.target) != null || this.IsAuthoredObject(shot.target));
    if (!present || this.world.InWarp(shot.ship) || (shot.targetKind === 'ship' && this.world.InWarp(shot.target))) return null;
    const sound: Omit<TurretShotSound, 'at'> = { ship: shot.ship, module: shot.module, target: shot.target, targetKind: shot.targetKind, ...(shot.missed === true ? { missed: true } : {}), tick: shot.tick };
    if (!this.turrets) return { ...sound, at: now };
    const burst = this.turrets.Fire(shot.ship, shot.module, shot.target, shot.missed === true);
    if (!burst) return null;
    this.shots.Drawn(shot, now, burst.duration);
    return { ...sound, at: now + Math.round(burst.delay * TICKS_PER_SECOND) };
  }

  /**
   * Posts the deploy (a new target) or pack (none) sounds of ships whose guns changed aim, as they change.
   *
   * @param changes - The ships and their new aim.
   */
  private PostTurretAims(changes: readonly Pick<TurretAimTransition, 'ship' | 'aim'>[]): void {
    const transitions = changes.map(({ ship, aim }): TurretAimTransition => ({
      ship,
      aim,
      modules: (this.fittings.get(ship)?.modules ?? []).flatMap((module) => (module.weapon ? [module.key] : [])),
      tick: this.world.tick,
      at: this.clock.now
    }));
    this.turretSounds.Add(TurretAudioPosts({ shots: [], transitions, facts: (ship, module) => this.TurretSoundFactsOf(ship, module) }));
  }

  /**
   * A weapon module's sound events, read off its turret file and firing effect.
   *
   * @param ship - The ship id.
   * @param key - The module key.
   * @returns Them; null while the module's graphic or files load, or when it has none.
   */
  private TurretSoundFactsOf(ship: string, key: string): Maybe<TurretSoundFacts> {
    const typeID = this.fittings.get(ship)?.modules.find((module) => module.key === key && module.weapon)?.typeID;
    const resPath = typeID == null ? null : this.weapons.Cached(typeID)?.weapon?.resPath;
    return resPath ? (this.turretFiles.Cached(resPath)?.facts ?? null) : null;
  }

  /**
   * Asks for a ship's lock on a target, the locks its turrets still fire on kept (locks.ts).
   *
   * @param id - The ship id.
   * @param target - The ship or object.
   * @returns The refusal, or null.
   */
  private RequestLock(id: string, target: string): Maybe<string> {
    const wanted = new Set([target, ...(this.modules.TurretAims().get(id) ?? [])]);
    return this.locks.Request(id, target, this.world.tick, wanted);
  }

  /**
   * A ship's lock on a target as set_target and engage report it, or why it was refused.
   */
  private LockState(id: string, target: Maybe<string>, refusal: Maybe<string> = null): Maybe<ShipLockReportState> {
    const lock = target ? this.locks.Report(id, this.world.tick).find((report) => report.target === target) : null;
    let state: Maybe<ShipLockReportState> = null;
    if (refusal) state = { refused: refusal };
    else if (lock) {
      const { target: _target, ...rest } = lock;
      state = rest;
    }
    return state;
  }

  /**
   * Each ship's wanted locks at a boundary: its target and what its turrets aim at.
   */
  private WantedLocks(): Map<string, Set<string>> {
    const wanted = this.modules.TurretAims();
    for (const doc of this.scene?.ships ?? []) {
      const target = this.IsDead(doc.id) ? null : this.targets.Of(doc.id);
      if (target) wanted.set(doc.id, new Set([target, ...(wanted.get(doc.id) ?? [])]));
    }
    return wanted;
  }

  /**
   * A boundary's lock changes: a lost lock only notes (its turrets stop at their cycle end; locks.ts).
   */
  private LockEvents(events: readonly LockEvent[]): void {
    if (events.length) this.onChange();
  }

  /**
   * A ship's live targeting numbers for its locks: the dogma path's (ShipFlight.targeting), its lock count capped by the
   * max-skills pilot's; null on the table path (it fires unlocked).
   */
  private LockTargeting(id: string): Maybe<LockTargeting> {
    const targeting = this.flights.get(id)?.targeting;
    return targeting ? { scanResolution: targeting.scanResolution, maxTargetRange: targeting.maxTargetRange, maxLocks: shipLockLimit(targeting, MAX_SKILLS_PILOT) } : null;
  }

  /**
   * A target's live signature radius: a ship's as it flies (its MWD's bloom, painters), an object's ball radius.
   */
  private SignatureOf(id: string): number {
    const flight = this.flights.get(id);
    const motion = flight ? this.world.Motion(id) : null;
    return flight ? RunningFlight(flight, motion?.propMod.running === true).signatureRadius : (this.world.ObjectBall(id)?.radius ?? 0);
  }

  /**
   * Re-arms the impact overlays of ships whose shields the recharge raised by more than 0.1 %.
   */
  private SyncRecharged(ids: readonly string[]): void {
    for (const id of ids) {
      const shield = this.damage.Fractions(id)?.shield ?? 1;
      if (Math.abs(shield - (this.rechargeSynced.get(id) ?? -1)) <= 0.001) continue;
      this.rechargeSynced.set(id, shield);
      this.SyncImpactState(id);
    }
  }

  /**
   * Keeps every engaged ship's selected turrets firing at its target: those back online (a lost lock, a cleared then
   * new target) switch active again and wait for the lock.
   *
   * @param boundary - The master tick.
   */
  private Engagements(boundary: number): void {
    for (const [id, engagement] of this.engagements) {
      if (this.world.Curves(id) == null || this.combat.IsDestroyed(id)) {
        this.engagements.delete(id);
        continue;
      }
      const target = this.targets.Of(id);
      const resolved = this.fittings.get(id);
      if (!target || !resolved?.dogma || this.world.InWarp(id)) continue;
      const { modules } = selectFittedModules({ modules: resolved.modules }, engagement.modules);
      for (const module of modules) {
        if (module.weapon !== 'turret' || this.modules.CycleState(id, module.key) !== 'online') continue;
        this.modules.Switch(id, module.key, 'active', { boundary, target });
      }
    }
  }

  /**
   * A ship's structure reached 0: every target on it clears (its attackers' turrets stop), and the kill listeners
   * run. With death `explode` it is destroyed (Destroy): it explodes and its ball leaves after the explosion.
   */
  private Killed(kill: ShipKill, shot: WeaponShot): void {
    const cleared = this.targets.Forget(kill.ship);
    for (const { ship } of cleared) {
      this.ModuleOutputs(this.modules.Retarget(ship, null, this.world.tick));
      this.turrets?.Aim(ship, null);
    }
    this.PostTurretAims(cleared.map(({ ship }) => ({ ship, aim: 'idle' })));
    if (kill.mode === 'explode') this.Destroy(kill);
    for (const listener of [...this.killListeners]) {
      try {
        listener(kill, shot);
      } catch (error) {
        console.error(`a kill listener failed: ${ErrorText(error)}`);
      }
    }
  }

  /**
   * Sets a ship's target: its turrets aim at it, and its running ones follow it (modules.ts Retarget).
   *
   * @param id - The ship id.
   * @param target - The ship or object; null clears it.
   * @returns Its previous target.
   */
  private SetShipTarget(id: string, target: Maybe<string>): Maybe<string> {
    const previous = this.targets.Set(id, target);
    if (target) this.RequestLock(id, target);
    if (previous !== target) {
      this.ModuleOutputs(this.modules.Retarget(id, target, this.world.tick));
      this.turrets?.Aim(id, target);
      this.PostTurretAims([{ ship: id, aim: target == null ? 'idle' : 'targeting' }]);
    }
    return previous;
  }

  /**
   * Whether an id is one of the document's objects with a Destiny ball (not a location celestial): what a turret may
   * target besides ships.
   */
  private IsAuthoredObject(id: string): boolean {
    return !id.startsWith(CELESTIAL_TARGET_PREFIX) && this.world.HasObject(id) && (this.scene?.objects ?? []).some((doc) => doc.id === id);
  }

  /**
   * Clears every target on a ship or object that left the scene, and the shots of it or at it.
   *
   * @param id - The removed id.
   */
  private ForgetTarget(id: string): void {
    this.turrets?.Aim(id, null);
    const cleared = this.targets.Remove(id);
    for (const { ship } of cleared) {
      this.ModuleOutputs(this.modules.Retarget(ship, null, this.world.tick));
      this.turrets?.Aim(ship, null);
    }
    this.PostTurretAims(cleared.map(({ ship }) => ({ ship, aim: 'idle' })));
    this.shots.Forget(id);
    this.turretSounds.Forget(id);
  }

  /**
   * The module effects' roots, for every retire's retained set.
   */
  private ModuleEffectRoots(): object[] {
    return this.moduleEffects?.Roots() ?? [];
  }

  /**
   * Switches one fitted module for switch_modules.
   *
   * @param id - The ship id.
   * @param module - The module as the ship carries it.
   * @param command - The switch.
   * @param delay - The pilot's delay, whole ticks.
   * @returns Its state after the call, or why it was refused.
   */
  private SwitchModule(id: string, module: ShipFitModule, command: ModuleSwitch, delay: number): SwitchedModule | string {
    const { state } = command;
    const row = { module: module.key, name: module.name };
    let result: SwitchedModule | string;
    if (module.prop) {
      const on = state === 'active';
      const refusal = state === 'offline' ? "the prop mod is never switched offline (a fit's /OFFLINE marks it offline)" : this.world.PropModRefusal(id, on);
      const switched = refusal === null ? this.world.SwitchPropMod(id, on, { delay }) : null;
      result = switched
        ? {
            ...row,
            state: switched.state === 'off' ? 'online' : switched.state,
            ...(switched.at === undefined ? {} : { at: switched.at }),
            ...(switched.stopsIn === undefined ? {} : { stopsIn: switched.stopsIn }),
            ...(switched.respondsIn === undefined ? {} : { respondsIn: switched.respondsIn })
          }
        : (refusal ?? `ship "${id}" has no Destiny ball`);
    } else if (module.category === 'prop') {
      result = 'only the prop mod the ship flies (prop: true) runs; propMod.module picks it';
    } else if (state === 'offline' && (module.slot === 'rig' || module.slot === 'subsystem')) {
      result = `${module.slot === 'rig' ? 'rigs' : 'subsystems'} are always online`;
    } else {
      const target = module.weapon === 'turret' ? (this.targets.Of(id) ?? command.target) : command.target;
      const refusal = this.modules.Switch(id, module.key, state, { boundary: this.world.tick, target, delay });
      const live = refusal === null ? this.modules.State(id, module.key, this.world.tick) : null;
      result = live
        ? {
            ...row,
            state: live.state,
            ...(live.at === undefined ? {} : { at: live.at }),
            ...(live.stopsIn === undefined ? {} : { stopsIn: live.stopsIn }),
            ...(live.activatesIn === undefined ? {} : { activatesIn: live.activatesIn }),
            ...(live.respondsIn === undefined ? {} : { respondsIn: live.respondsIn }),
            ...(live.target === undefined ? {} : { target: live.target }),
            ...(live.nextTarget === undefined ? {} : { nextTarget: live.nextTarget }),
            ...(live.effectiveness === undefined ? {} : { effectiveness: live.effectiveness }),
            ...(live.cycleTime === undefined ? {} : { cycleTime: live.cycleTime })
          }
        : (refusal ?? `ship "${id}" fits no module ${module.key}`);
    }
    return result;
  }

  /**
   * A fitted module's live state for get_state: the prop mod's from Destiny (off reads online), the activation layer's
   * for the rest, else offline as fitted or online.
   *
   * @param id - The ship id.
   * @param module - The module as the ship carries it.
   * @param motion - The ship's Destiny motion.
   * @returns The row's live part.
   */
  private ModuleRowState(id: string, module: ShipFitModule, motion: Maybe<ShipMotion>): ShipModuleRowState {
    let row: ShipModuleRowState = { state: module.offline ? 'offline' : 'online' };
    if (module.prop) {
      const propMod = motion?.propMod;
      if (propMod && propMod.state !== 'off') row = { state: propMod.state, ...(propMod.at === undefined ? {} : { at: propMod.at }), ...(propMod.stopsIn === undefined ? {} : { stopsIn: propMod.stopsIn }) };
    } else {
      row = (module.typeID == null ? null : this.modules.CycleState(id, module.key, module.typeID)) == null ? row : (this.modules.State(id, module.key, this.world.tick) ?? row);
    }
    if (module.weapon) {
      const mount = this.WeaponMount(id, module);
      if (mount) row = { ...row, mount };
      const combat = this.modules.Spec(id, module.key)?.combat;
      if (combat) row = { ...row, combat: { damage: Object.fromEntries(Object.entries(combat.damage).map(([type, amount]) => [type, Round(amount, 2)])), volley: Round(combat.volley, 2), dps: Round(combat.dps, 1) } };
    }
    return row;
  }

  /**
   * A weapon module's turret set on the drawn hull: the graphic's lookup while it is pending or failed, then the
   * mount's (turrets.ts).
   *
   * @param id - The ship id.
   * @param module - The weapon module.
   * @returns The mount; null without a renderer or a type.
   */
  private WeaponMount(id: string, module: ShipFitModule): Maybe<TurretMountReport> {
    if (!this.turrets || module.typeID == null) return null;
    const answer = this.weapons.Cached(module.typeID);
    let mount: Maybe<TurretMountReport>;
    if (!answer) mount = { state: 'loading' };
    else if (!answer.weapon) mount = { state: 'failed', error: answer.note ?? 'no weapon graphic' };
    else mount = this.turrets.MountOf(id, module.key) ?? { state: 'loading' };
    return mount;
  }

  /**
   * A fitted ship's live defense: the damage model's HP, with its running local repairs and the remote repairs on it.
   *
   * @param id - The ship id.
   * @returns The report; null when the model does not track the ship (the table path).
   */
  private LiveDefense(id: string): Maybe<DamageReport> {
    if (!this.damage.Has(id)) return null;
    const repairs = { shield: 0, armor: 0, structure: 0 };
    for (const spec of this.modules.Running(id)) {
      const { repair, cycleTime } = spec.activation;
      if (repair && !repair.remote && cycleTime > 0) repairs[repair.layer] += repair.amount / cycleTime;
    }
    this.damage.SetRepairs(id, repairs);
    this.damage.SetIncoming(
      id,
      this.modules.Incoming(id).flatMap(({ from, spec, effectiveness }) => (spec.activation.repair ? [{ from, module: spec.key, layer: spec.activation.repair.layer, amount: spec.activation.repair.amount, cycleTime: spec.activation.cycleTime, effectiveness }] : []))
    );
    return this.damage.Report(id);
  }

  /**
   * A ship's flight numbers: its lookup answer, its SOF hull and its `stats`, through the max-skills pilot; a fitted
   * ship's through the dogma evaluator once its fit has resolved. Keeps the ship's resolved fit for get_state.
   *
   * @param doc - The document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   * @returns The numbers; null when they cannot be resolved (logged).
   */
  private Flight(doc: SceneShip, answer: Maybe<HullStatsAnswer>): Maybe<ShipFlight> {
    let flight: Maybe<ShipFlight> = null;
    try {
      const hull = this.live.get(doc.id)?.hull;
      const module = this.PropModModule(doc);
      const rigSize = RigSizeOf({ published: answer?.hull, hull });
      const target = PropModLookupTarget(module, rigSize);
      const propMod = ResolveShipPropMod({ module, rigSize, answer: target == null ? null : this.propMods.Cached(target) });
      const fitting = this.ResolveFitting(doc, answer, propMod);
      const dogma = this.LiveDogma(doc.id, fitting?.dogma);
      const targeting = this.modules.Targeting(doc.id);
      // Kept before the math, so a ship that cannot fly these states is not tried again every tick.
      this.flownStates.set(doc.id, FlownKey(dogma, targeting));
      const incoming = IncomingModifiersOf(targeting);
      const input = { published: answer?.hull, note: answer ? answer.note : LOOKUP_PENDING_NOTE, hull, overrides: doc.stats, propMod, dogma, compute: (stats: ShipStatsInput) => this.fitLookup.ShipStats(stats) };
      flight = ResolveFlight({ ...input, incoming });
      if (incoming.length) this.unaffectedFlights.set(doc.id, ResolveFlight(input));
      else this.unaffectedFlights.delete(doc.id);
    } catch (error) {
      console.error(`ship ${doc.id}: no flight numbers (${ErrorText(error)}); it keeps its previous physics`);
    }
    return flight;
  }

  /**
   * Resolves a ship's fit from the lookups so far and keeps it for get_state.
   *
   * @param doc - The document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   * @param propMod - The prop mod it flies; null for "none".
   * @returns The resolved fit; null for a ship without one.
   */
  private ResolveFitting(doc: SceneShip, answer: Maybe<HullStatsAnswer>, propMod: Maybe<ResolvedShipPropMod>): Maybe<ResolvedShipFitting> {
    const fitting = ResolveShipFitting({
      doc,
      scene: this.scene,
      lookup: this.fitLookup,
      hullTypeID: answer?.hull?.typeID ?? null,
      hullNote: answer ? answer.note : null,
      propMod: propMod ? { module: propMod.module, typeID: propMod.stats.typeID, name: propMod.stats.name, explicit: doc.propMod?.module != null } : null,
      fallback: this.DefaultFallback(doc, answer)
    });
    if (fitting) this.fittings.set(doc.id, fitting);
    else this.fittings.delete(doc.id);
    return fitting;
  }

  /**
   * The default weapons of a ship without a fit (defaultWeaponsOf over the hull's dogma record), memoized per hull type
   * and DNA race.
   *
   * @param doc - The document ship.
   * @param answer - Its /ship-stats answer; null while the lookup is in flight.
   * @returns Them; null for a ship with a fit, without the hull's EVE type, or while the hull's dogma is pending.
   */
  private DefaultWeaponsOf(doc: SceneShip, answer: Maybe<HullStatsAnswer>): Maybe<DefaultWeapons> {
    const typeID = answer?.hull?.typeID;
    const record = doc.fit || typeID == null ? null : this.fitLookup.Bundle()?.types[typeID];
    if (!record) return null;
    const sofRace = doc.dna.split(':')[2] ?? null;
    const key = `${typeID}|${sofRace ?? ''}`;
    let weapons = this.defaultWeapons.get(key);
    if (!weapons) {
      weapons = defaultWeaponsOf({ hull: record, sofRace });
      this.defaultWeapons.set(key, weapons);
    }
    return weapons;
  }

  /**
   * The fit a ship without one flies: its default weapons, keyed "default".
   */
  private DefaultFallback(doc: SceneShip, answer: Maybe<HullStatsAnswer>): Maybe<{ readonly text: string; readonly key: string }> {
    const text = this.DefaultWeaponsOf(doc, answer)?.text;
    return text ? { text, key: 'default' } : null;
  }

  /**
   * The fit text a ship resolves: its own, else its default weapons'.
   */
  private FitTextOf(doc: SceneShip): Maybe<string> {
    return doc.fit ? fitTextOf(doc, this.scene) : (this.DefaultWeaponsOf(doc, this.hullStats.Cached(doc))?.text ?? null);
  }

  /**
   * Why a ship without a fit has no default weapons fit (get_state's `fitNote`).
   *
   * @param doc - The document ship.
   * @returns The reason; null when the ship has a fit or one resolved.
   */
  private FitNote(doc: SceneShip): Maybe<string> {
    if (doc.fit || this.fittings.has(doc.id)) return null;
    const answer = this.hullStats.Cached(doc);
    const typeID = answer?.hull?.typeID;
    let note: string;
    if (!answer) note = "waiting for the hull's EVE type";
    else if (typeID == null) note = ['no default weapons: the hull has no EVE type', answer.note].filter(Boolean).join('; ');
    else if (this.fitLookup.TypeFailure(typeID)) note = `no default weapons: ${this.fitLookup.TypeFailure(typeID)}`;
    else note = this.DefaultWeaponsOf(doc, answer)?.note ?? "loading the hull's dogma for its default weapons";
    return note;
  }

  /**
   * Mounts a ship's weapons on its built hull (turrets.ts): its resolved fit's weapon modules (its own fit's or its
   * default weapons'), each once its /weapon graphic has landed. A landing graphic syncs every ship again. The
   * weapons' files load with or without a renderer: their sound events name the turret sounds.
   *
   * @param id - The ship id.
   */
  private SyncTurrets(id: string): void {
    const entry = this.live.get(id);
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    if (!entry || !doc) return;
    const resolved = this.fittings.get(id);
    for (const module of resolved?.modules ?? []) {
      const typeID = module.typeID;
      if (!module.weapon || typeID == null || this.weapons.Cached(typeID) || this.weaponRequests.has(typeID)) continue;
      this.weaponRequests.add(typeID);
      void this.weapons.Lookup(typeID).then(() => {
        this.weaponRequests.delete(typeID);
        for (const shipId of this.fittings.keys()) this.SyncTurrets(shipId);
        this.onChange();
      });
    }
    const mounts = TurretMountsOf(resolved, (typeID) => this.weapons.Cached(typeID)?.weapon ?? null);
    // Shared with the sets: each file loads once, and a failure is the mount's to report.
    for (const mount of mounts) this.turretFiles.Load(mount.resPath).catch(() => undefined);
    this.turrets?.Sync(id, entry.ship, doc.dna, mounts);
  }

  /**
   * The prop mod a ship flies: its document's module, else its fit's MWD or AB, else the hull-sized microwarpdrive.
   *
   * @param doc - The document ship.
   * @returns The canonical module.
   */
  private PropModModule(doc: Maybe<SceneShip>): PropModModule {
    return shipPropModModuleOf(doc, fitTextOf(doc, this.scene));
  }

  /**
   * Whether a ship flies a prop mod (its module is not "none").
   *
   * @param doc - The document ship.
   * @returns True when it does.
   */
  private FitsPropMod(doc: Maybe<SceneShip>): boolean {
    return this.PropModModule(doc) !== PROP_MOD_MODULE_NONE;
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

  /**
   * Whether an arriving ship may be planned: the hub answered its /ship-stats lookup (its warp speed and max velocity
   * are the hull's) and its SOF build settled, so it is drawn before it lands.
   *
   * @param id - The ship id.
   * @returns False while either is pending.
   */
  private ArrivalReady(id: string): boolean {
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    const status = this.live.get(id)?.status;
    return Boolean(doc && this.hullStats.Cached(doc)) && status !== 'queued' && status !== 'building';
  }

  private Retire(id: string): void {
    const entry = this.live.get(id);
    this.live.delete(id);
    // The sets come off the hull first: they are the page's, and RetireShips must not find them on it.
    this.turrets?.Remove(id);
    if (!entry?.ship || !this.engine) return;
    this.engine.RemoveShip(entry.ship);
    RetireShips([entry.ship], [...this.ShipRoots(), ...this.dressing.Roots(), ...this.objects.Roots(), ...this.ModuleEffectRoots(), ...this.ExplosionRoots(), ...this.WarpEffectRoots()]);
  }

  /**
   * Retires a destroyed ship's drawing at its explosion's wreck switch, keeping its live entry (`destroyed`, no hull):
   * its turrets come off, the hull leaves the scene, and the shots of it or at it still queued are dropped.
   *
   * @param id - The ship id.
   */
  private Hide(id: string): void {
    const death = this.deaths.get(id);
    if (!death || death.hidden) return;
    death.hidden = true;
    this.turrets?.Remove(id);
    this.shots.Forget(id);
    const entry = this.live.get(id);
    if (entry) {
      const { ship } = entry;
      entry.ship = null;
      entry.status = 'destroyed';
      if (ship && this.engine) {
        this.engine.RemoveShip(ship);
        RetireShips([ship], [...this.ShipRoots(), ...this.dressing.Roots(), ...this.objects.Roots(), ...this.ModuleEffectRoots(), ...this.ExplosionRoots(), ...this.WarpEffectRoots()]);
      }
    }
    this.onChange();
  }

  /**
   * What the live view changed in a fleet, for get_state: the dead FC its commander acts for, and its destroyed ships.
   */
  private LiveFleetChange(fleet: string): { readonly actingFor?: string; readonly destroyed?: readonly string[] } {
    const change = this.LiveFleets()?.changes.get(fleet);
    return change ? { ...(change.actingFor ? { actingFor: change.actingFor } : {}), destroyed: change.destroyed } : {};
  }

  /**
   * The explosions' roots, for every retire's retained set.
   */
  private ExplosionRoots(): object[] {
    return this.explosions?.Roots() ?? [];
  }

  /**
   * The warp flashes' roots, for every retire's retained set.
   */
  private WarpEffectRoots(): object[] {
    return this.warpEffects?.Roots() ?? [];
  }

  /**
   * Whether a ship was destroyed with death "explode" (its ball may still be on the parks): every tool and edit skips
   * it until a load revives it.
   *
   * @param id - The ship id.
   */
  private IsDead(id: string): boolean {
    return this.deaths.has(id);
  }

  /**
   * The document as its fleets fly: the destroyed taken out of their fleets (toLiveFleetScene), memoized.
   *
   * @returns The view, null without a scene.
   */
  private LiveFleets(): Maybe<LiveFleetView<SceneDocument>> {
    const scene = this.scene;
    if (!scene) return null;
    const gone = [...this.deaths.keys()].sort().join('|');
    if (this.liveFleets?.scene !== scene || this.liveFleets.gone !== gone) this.liveFleets = { scene, gone, view: toLiveFleetScene(scene, new Set(this.deaths.keys())) };
    return this.liveFleets.view;
  }

  /**
   * A destroyed ship's ball leaves both parks at the first boundary at or after its linger (ExplosionRemoveTick), with
   * or without a renderer: its emitter is released, its damage model dropped, and a cinema shot on it released.
   *
   * @param boundary - The master tick boundary.
   */
  private RemoveDead(boundary: number): void {
    for (const [id, death] of this.deaths) {
      if (death.gone || boundary < death.removeTick) continue;
      death.gone = true;
      this.Hide(id);
      this.world.RemoveShip(id);
      this.audio.Release(id);
      this.damage.Remove(id);
      this.capacitor.Remove(id);
      this.rechargeSynced.delete(id);
      if (this.cinema.Subjects().includes(id)) this.cinema.Release(this.clock.now, { note: 'its subject was destroyed', forget: true });
      this.onChange();
    }
  }

  /**
   * A load revives every destroyed ship: its explosion comes off, its ball is taken off (Apply adds it back fresh) and
   * its live entry retires, so it rebuilds as a retried ship.
   */
  private Revive(): void {
    for (const id of this.deaths.keys()) {
      this.explosions?.Remove(id);
      this.world.RemoveShip(id);
      this.audio.Release(id);
      this.Retire(id);
    }
    this.deaths.clear();
    this.liveFleets = null;
  }

  /**
   * A ship at 0 structure with death "explode": its modules stop and every module on it ("its target was destroyed"),
   * its locks go both ways, its engagement ends, its ball stops for good (DestinyWorld.Destroy: its followers and the
   * ships ordered at it stop), and its fleet re-plans without it. Its explosion is chosen and its file loaded; it
   * starts at the killing shot's draw (DriveTurrets) and plays in DriveExplosions.
   *
   * @param kill - The kill.
   */
  private Destroy(kill: ShipKill): void {
    const id = kill.ship;
    if (this.deaths.has(id)) return;
    const doc = this.scene?.ships.find((ship) => ship.id === id);
    const answer = doc ? this.hullStats.Cached(doc) : null;
    const typeID = answer?.hull?.typeID;
    const record = typeID == null ? null : this.fitLookup.Bundle()?.types[typeID];
    const choice = shipExplosionOf({
      groupID: record?.groupID,
      classRigSize: RigSizeOf({ published: answer?.hull, hull: this.live.get(id)?.hull }),
      raceID: record?.raceID,
      sofRace: doc?.dna.split(':')[2],
      seed: sceneCombatOf(this.scene ?? {}).seed,
      ship: id
    });
    const removeTick = ExplosionRemoveTick(kill.tick, choice.lingerSeconds, this.world.master.tickInterval / 1000);
    this.deaths.set(id, { kill, choice, removeTick, start: null, begun: false, schedule: null, posted: 0, hidden: false, gone: false });
    this.explosionFiles.Load(choice.resPath).catch((error: unknown) => console.warn(`ship ${id}: its explosion ${choice.resPath} did not load: ${ErrorText(error)}`));
    this.ModuleOutputs(this.modules.Remove(id, this.world.tick, 'its target was destroyed'));
    this.moduleSpecs.delete(id);
    this.locks.Remove(id);
    this.engagements.delete(id);
    if (this.targets.Of(id) != null) {
      this.targets.Set(id, null);
      this.turrets?.Aim(id, null);
    }
    this.world.Destroy(id);
    this.liveFleets = null;
    this.following.Reconcile();
    this.onChange();
  }

  /**
   * Starts a destroyed ship's explosion clock at its killing shot's draw (its burst's start), once.
   *
   * @param id - The destroyed ship.
   * @param at - The scene clock.
   */
  private ExplosionStarts(id: string, at: number): void {
    const death = this.deaths.get(id);
    if (death && death.start == null) death.start = at;
  }

  /**
   * Posts an explosion sound on the dying ship's own emitter.
   *
   * @param id - The ship id.
   * @param event - The sound event.
   */
  private PostExplosionSound(id: string, event: string): void {
    if (!this.world.Curves(id)) return;
    this.audio.Post({ ship: id, tick: this.world.tick, events: [event], placement: this.AudioPlacement(id, this.clock.now) });
  }

  /**
   * The built ships' roots, for every retire's retained set.
   */
  private ShipRoots(): EveShip2[] {
    return [...this.live.values()].map((entry) => entry.ship).filter((ship): ship is EveShip2 => ship !== null);
  }

  /**
   * order_ship and order_fleet take a target by name: an order whose target is no ship, object or celestial target id
   * is rewritten by resolveNamedOrderTarget before it is normalized (a body's warp becomes a warp to a point). Nothing
   * matching leaves the order alone, for the normalizer to refuse.
   *
   * @param input - The order as JSON, the ship it is measured from (order_fleet: the FC) and the message prefix.
   * @returns The order to normalize, and what the name resolved to.
   * @throws {SceneError} When the name is ambiguous or names a celestial that cannot be the target.
   */
  private NamedTarget(input: { readonly order: unknown; readonly from: Maybe<string>; readonly where: string }): { readonly order: unknown; readonly resolved?: ResolvedNamedOrderTarget } {
    const record = input.order !== null && typeof input.order === 'object' && !Array.isArray(input.order) ? (input.order as Record<string, unknown>) : null;
    const text = typeof record?.['target'] === 'string' ? record['target'].trim() : '';
    const known = this.TargetIds().has(text) || (this.scene?.ships ?? []).some((doc) => doc.id === text);
    if (!record || !text || known || record['point'] !== undefined) return { order: input.order };
    const answer = this.location.Answer();
    const result = resolveNamedOrderTarget({
      text,
      type: String(record['type']),
      range: record['range'],
      from: (input.from ? this.world.Motion(input.from)?.position : null) ?? [0, 0, 0],
      objects: this.scene?.objects ?? [],
      celestials: answer?.celestials ?? [],
      systemName: answer?.system.name,
      targets: new Set(this.celestialTargets.keys()),
      where: input.where
    });
    if (result && 'problem' in result) throw new SceneError([result.problem]);
    let named: { readonly order: unknown; readonly resolved?: ResolvedNamedOrderTarget } = { order: input.order };
    if (result?.resolved.point) {
      const order: Record<string, unknown> = { ...record, point: result.resolved.point, range: 0 };
      delete order['target'];
      named = { order, resolved: result.resolved };
    } else if (result) named = { order: { ...record, target: result.resolved.target }, resolved: result.resolved };
    return named;
  }

  /**
   * Every non-ship id order_ship takes as a target: the document's objects and the location's celestial targets.
   */
  private TargetIds(): Set<string> {
    return new Set([...(this.scene?.objects ?? []).map((doc) => doc.id), ...this.celestialTargets.keys()]);
  }

  /**
   * An object's build settled: without a document radius its ball takes the SOF radius, and the back clip re-reaches.
   */
  private ObjectBuilt(id: string): void {
    const doc = this.scene?.objects?.find((candidate) => candidate.id === id);
    if (!doc) return;
    if (doc.radius == null && this.world.HasObject(id)) this.world.SetObjectRadius(id, ObjectBallRadius({ sofRadius: this.objects.Entry(id)?.sofRadius }).radius);
    this.SyncImpactState(id);
    if (this.scene) this.engine?.SetDrawReach(this.objects.Reach(this.scene), 'objects');
  }

  private ObjectReport(id: string): object {
    const entry = this.objects.Entry(id);
    const doc = this.scene?.objects?.find((candidate) => candidate.id === id);
    return { id, dna: doc?.dna ?? entry?.dna ?? null, status: entry?.status ?? 'queued', ...(entry?.error ? { error: entry.error } : {}) };
  }

  /**
   * get_state.objects: one row per document object, with ship distances on the master balls.
   */
  private ObjectRows(): object[] {
    const ships = (this.scene?.ships ?? []).flatMap((doc) => {
      const motion = this.world.Motion(doc.id);
      return motion ? [{ id: doc.id, position: motion.position, radius: motion.physics.radius }] : [];
    });
    const orders = new Map<string, ShipOrders>(
      (this.scene?.ships ?? []).flatMap((doc) => {
        const motion = this.world.Motion(doc.id);
        return motion ? [[doc.id, { order: motion.order, pendingOrder: motion.pendingOrder ?? null }] as const] : [];
      })
    );
    return (this.scene?.objects ?? []).map((object) => ObjectStateRow({ object, entry: this.objects.Entry(object.id), ball: this.world.ObjectBall(object.id), ships, orders }));
  }

  /**
   * Keeps the celestial target balls in step with the location: a new location (or its answer) replaces them all, and
   * a cleared or failed one removes them, halting what flew at them.
   */
  private SyncCelestialTargets(location: Maybe<SceneLocation>): void {
    const answer = this.location.Answer();
    const nextKey = location && answer ? LocationKey(location) : null;
    const plan = PlanCelestialTargetSync({ currentKey: this.celestialKey, current: [...this.celestialTargets.keys()], nextKey, targets: answer ? toCelestialTargets(answer) : [] });
    for (const id of plan.remove) {
      this.world.RemoveObject(id);
      this.celestialTargets.delete(id);
    }
    for (const target of plan.add) {
      this.world.AddObject({ id: target.target, position: target.position }, target.radius);
      this.celestialTargets.set(target.target, target);
    }
    this.celestialKey = nextKey;
  }

  private ApplyCamera(camera: SceneCamera): void {
    const view = this.engine?.camera;
    if (!view) return;
    // A view already following a ship glides from where it is to the new framing.
    const previous = this.cameraFollow.following ? Array.from(view.focus) : null;
    view.Set({ yaw: camera.yaw, pitch: camera.pitch, fov: camera.fov });
    // A destroyed ship is not framed.
    const ships = (this.scene?.ships ?? []).filter((doc) => !this.IsDead(doc.id));
    const objects = this.scene?.objects ?? [];
    const docs = camera.target ? ships.filter((doc) => doc.id === camera.target) : ships;
    const object = camera.target && !docs.length ? (objects.find((doc) => doc.id === camera.target) ?? null) : null;
    let spheres: WorldSphere[] = docs.map((doc) => this.WorldSphere(doc, { landing: true }));
    if (object) spheres = [this.ObjectSphere(object)];
    else if (!camera.target && !ships.length) spheres = objects.map((doc) => this.ObjectSphere(doc));
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
    const target = camera.target ? (docs[0] ?? object) : null;
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
      const state = this.FitsPropMod(docs.get(id)) ? (this.world.Motion(id)?.propMod.state ?? 'off') : 'none';
      counts[state] += 1;
    }
    return counts;
  }

  /**
   * A ship as drawn at `now`: its ClientBall position and forward vector.
   */
  private DrawnShip(id: string, now: number): Maybe<FollowedShip> {
    const curves = this.world.Curves(id);
    const object = curves ? null : (this.scene?.objects?.find((doc) => doc.id === id) ?? null);
    let drawn: Maybe<FollowedShip> = null;
    if (curves) {
      const rotation = curves.rotation.GetValueAt__Ticks(now, CAMERA_TARGET_ROTATION);
      drawn = { position: curves.translation.GetValueAt__Ticks(now, CAMERA_TARGET_POSITION), forward: vec3.transformQuat(CAMERA_TARGET_FORWARD, SHIP_FORWARD, rotation) };
    } else if (object) {
      // A static object: following it changes nothing per frame, and chase sits behind its forward axis.
      drawn = { position: vec3.set(CAMERA_TARGET_POSITION, ...object.position), forward: vec3.set(CAMERA_TARGET_FORWARD, ...ObjectForward(object.rotation)) };
    }
    return drawn;
  }

  /**
   * The scene as drawn at `now`, for the cinematic camera: each ship's ClientBall position, rotation and velocity, its
   * SOF bounding sphere (UNBUILT_RADIUS until built), team, the fleets, the light, the location's celestials and the
   * objects (hulls to clear, waypoint anchors). Built only while a shot plays; the ClientBall caches its samples per time, so the renderer
   * draws the same values.
   */
  private CinemaScene(now: number): CinemaScene {
    const ships: CinemaShip[] = [];
    for (const doc of this.scene?.ships ?? []) {
      const curves = this.world.Curves(doc.id);
      if (!curves) continue;
      const position = curves.translation.GetValueAt__Ticks(now, vec3.create());
      const rotation = curves.rotation.GetValueAt__Ticks(now, quat.create());
      const velocity = curves.translation.GetValueDotAt__Ticks(now, vec3.create());
      const ship = this.engine ? this.live.get(doc.id)?.ship : null;
      const centre = ship ? vec3.add(vec3.create(), vec3.transformQuat(vec3.create(), ship.boundingSphereCenter, rotation), position) : position;
      ships.push({
        id: doc.id,
        position: ToVector(position),
        rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
        velocity: ToVector(velocity),
        frameCentre: ToVector(centre),
        frameRadius: ship?.boundingSphereRadius || UNBUILT_RADIUS,
        ...(doc.team ? { team: doc.team } : {})
      });
    }
    return {
      ships,
      fleets: this.scene?.fleets ?? [],
      sunDirection: this.SunDirection(),
      celestials: this.CinemaCelestials(),
      objects: (this.scene?.objects ?? []).map((doc) => {
        const sphere = this.ObjectSphere(doc);
        const rotation = DocumentRotation(doc.rotation);
        return { id: doc.id, centre: ToVector(sphere.centre), radius: sphere.radius, rotation: [rotation[0], rotation[1], rotation[2], rotation[3]] };
      }),
      aspect: this.engine?.Aspect() ?? CINEMA_DEFAULT_ASPECT,
      reach: this.engine?.camera.reach ?? 0,
      camera: this.engine?.DrawnCamera() ?? null,
      warpOf: (id) => this.CinemaWarp(id)
    };
  }

  /**
   * A ship's warp for the warp-landing hardpoint, read lazily from the Destiny master.
   */
  private CinemaWarp(id: string): Maybe<CinemaWarp> {
    const warp = this.world.Motion(id)?.warp;
    return warp ? { phase: warp.phase, landing: warp.landing } : null;
  }

  /**
   * The light's travel direction: the scene's, else away from the location's star, else straight down.
   */
  private SunDirection(): SceneVector {
    const live = this.engine?.scene.sunDirection;
    const star = live ? null : this.location.Answer()?.celestials.find((celestial) => celestial.kind === 'star');
    const toStar = star ? normalizeVec(star.position) : null;
    let direction: SceneVector = [0, -1, 0];
    if (live) direction = ToVector(live);
    else if (toStar) direction = scaleVec(toStar, -1);
    return direction;
  }

  /**
   * The location answer's celestials, origin-relative.
   */
  private CinemaCelestials(): CinemaCelestial[] {
    const answer = this.location.Answer();
    if (!answer) return [];
    if (this.cinemaCelestials?.answer !== answer) {
      this.cinemaCelestials = { answer, list: answer.celestials.map((celestial) => ({ id: celestial.id, name: celestial.name, kind: celestial.kind, position: celestial.position, radius: celestial.radius ?? 0 })) };
    }
    return this.cinemaCelestials.list;
  }

  /**
   * An object's world sphere: its drawn bounding sphere, else its ball radius at its position.
   */
  private ObjectSphere(doc: SceneObject): WorldSphere {
    const sphere = this.objects.Sphere(doc);
    return { centre: vec3.fromValues(...sphere.centre), radius: sphere.radius };
  }

  /**
   * The page's camera input on top of OrbitCamera's drag, pan and wheel: alt-click a ship to follow it, C switches
   * between orbit and chase, and a held drag keeps chase's look-around offset.
   */
  private AttachCameraControls(canvas: HTMLCanvasElement): void {
    // Capture listeners on the canvas run before OrbitCamera's own, so the orbit adopts the cinematic view first and the
    // drag or zoom continues from the image. Only the buttons that drag the view take it: a right-click (the context
    // menu) leaves the shot playing, and alt-click picks.
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.altKey && (event.button === 0 || event.button === 1)) this.TakeOverCinema();
      },
      { capture: true }
    );
    canvas.addEventListener('wheel', () => this.TakeOverCinema(), { capture: true, passive: true });
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
   * The pointer takes the camera from a playing or paused shot.
   */
  private TakeOverCinema(): void {
    if (!this.cinema.driving || !this.engine) return;
    this.ReleaseCinema({ adopt: true, note: 'the pointer took the camera' });
    this.onChange();
  }

  /**
   * Hands the camera back to the user: with `adopt` the orbit camera takes the cinematic eye and look (the roll and lens
   * ease back over the release blend) and follows the shot's ship when it framed one; the shot stays resumable.
   */
  private ReleaseCinema({ adopt, cut = false, note }: { readonly adopt: boolean; readonly cut?: boolean; readonly note: string }): void {
    const now = this.clock.now;
    const subjects = this.cinema.Subjects();
    const orbit = this.engine?.camera;
    const view = this.cinema.Release(now, { adopt: adopt && orbit != null, cut, note });
    if (view && orbit) {
      orbit.Set({ focus: view.focus, distance: view.distance, yaw: view.yaw, pitch: view.pitch });
      const drawn = subjects.length === 1 ? this.DrawnShip(subjects[0], now) : null;
      this.cameraFollow.Follow(drawn ? { id: subjects[0], position: drawn.position } : null, null, now);
    }
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
      for (const doc of this.scene?.objects ?? []) if (this.objects.Entry(doc.id)?.object) spheres.push({ id: doc.id, ...this.ObjectSphere(doc) });
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
    this.cinema.Release(this.clock.now, { note: 'a camera change took the camera' });
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
    this.SyncCelestialTargets(report?.status === 'ready' ? location : null);
  }

  /**
   * Get_state's location: the lookup's report plus what it dressed.
   */
  private LocationState(): Maybe<object> {
    const located = this.location.Report();
    return located ? { ...located, dressing: this.dressing.Report(), targets: toLocationTargetReports([...this.celestialTargets.values()]) } : null;
  }

  /**
   * A ship's bounding sphere in world space, centred on its ball; the ball alone when it is not built.
   */
  private WorldSphere(doc: SceneShip, { landing = false }: { readonly landing?: boolean } = {}): WorldSphere {
    const ship = this.live.get(doc.id)?.ship;
    // Framing puts a ship still arriving by warp at its landing, not off-grid.
    const arriving = landing && this.world.Arriving(doc.id) ? this.world.ArrivalOf(doc.id)?.landing : null;
    const position = vec3.fromValues(...(arriving ?? this.world.Motion(doc.id)?.position ?? doc.position));
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
  ): ShipReport & {
    name?: string;
    team?: string;
    worldPosition: number[];
    radius: number;
    following?: ShipFollowingReport;
    boosters?: ShipBoosterState;
    propMod: Maybe<ShipPropModState>;
    fit: Maybe<ShipFitReport>;
    fitNote?: string;
    target: Maybe<ShipTargetReport>;
    shots?: number;
    defense: Maybe<ShipDefenseReport | DamageReport>;
    capacitor: Maybe<ShipCapacitorReport>;
    targeted: Maybe<ShipTargetedReport>;
    targeting?: LockTargeting;
    locks?: ShipLockReport[];
    engaged?: { readonly modules: readonly string[] };
    combat?: ShipCombatReport & { readonly paperDps: number };
    destroyed?: { readonly tick: number; readonly by: string; readonly module: string; readonly weapon: string; readonly mode: string };
  } & Partial<ShipFleetMembership> &
    Omit<Partial<ShipMotion>, 'propMod'> {
    const sphere = this.WorldSphere(doc);
    const motion = this.world.Motion(doc.id);
    const flight = this.flights.get(doc.id);
    const following = this.following.Report(doc.id);
    const ship = this.engine ? this.live.get(doc.id)?.ship : null;
    const boosters: Maybe<ShipBoosterState> = ship?.boosters ? { maxVel: ship.boosters.maxVel, intensity: Math.round(ship.GetBoosterIntensity() * 100) / 100, warpIntensity: Math.round(ship.boosters.warpIntensity * 100) / 100 } : null;
    // Defense, capacitor and the warp scramble status are reported beside physics, not in it.
    let physics: Maybe<Omit<ShipFlight, 'defense' | 'capacitor' | 'warpScrambleStatus' | 'warpScrambleSteps'> | ShipPhysics> = motion?.physics;
    let defense: Maybe<ShipDefense> = null;
    let capacitor: Maybe<ShipCapacitor> = null;
    if (flight) {
      const { defense: flownDefense, capacitor: flownCapacitor, targeting: _targeting, warpScrambleStatus: _status, warpScrambleSteps: _steps, ...flown } = RunningFlight(flight, motion?.propMod.running === true);
      physics = flown;
      defense = flownDefense ?? null;
      capacitor = flownCapacitor ?? null;
    }
    const fitting = this.fittings.get(doc.id);
    const fitNote = this.FitNote(doc);
    const shots = this.shots.Count(doc.id);
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
      fit: fitting ? ShipFitReportOf(fitting, (module) => this.ModuleRowState(doc.id, module, motion)) : null,
      ...(fitNote ? { fitNote } : {}),
      target: this.targets.Report(doc.id),
      ...(shots ? { shots } : {}),
      defense: this.LiveDefense(doc.id) ?? (defense ? ShipDefenseReportOf(defense) : null),
      capacitor: capacitor ? ShipCapacitorReportOf(capacitor, this.capacitor.Report(doc.id, this.world.tick)) : null,
      targeted: this.TargetedState(doc.id, flight, motion),
      ...this.CombatState(doc.id),
      ...(boosters ? { boosters } : {})
    };
  }

  /**
   * A ship's targeting numbers, locks, engagement, combat tallies and death for get_state; each omitted when empty.
   *
   * @param id - The ship id.
   * @returns The fields.
   */
  private CombatState(id: string): {
    targeting?: LockTargeting;
    locks?: ShipLockReport[];
    engaged?: { readonly modules: readonly string[] };
    combat?: ShipCombatReport & { readonly paperDps: number };
    destroyed?: { readonly tick: number; readonly by: string; readonly module: string; readonly weapon: string; readonly mode: string; readonly explosion?: ShipExplosionReport & { readonly removesAt: number; readonly gone: boolean } };
  } {
    const tick = this.world.tick;
    const targeting = this.LockTargeting(id);
    const locks = this.locks.Report(id, tick);
    const engaged = this.engagements.get(id);
    const combat = this.combat.Report(id, tick);
    const kill = this.combat.KillOf(id);
    const paperDps = this.modules
      .TurretKeys(id)
      .map((key) => this.modules.Spec(id, key)?.combat?.dps ?? 0)
      .reduce((sum, dps) => sum + dps, 0);
    return {
      ...(targeting ? { targeting: { scanResolution: Round(targeting.scanResolution, 2), maxTargetRange: Math.round(targeting.maxTargetRange), maxLocks: targeting.maxLocks } } : {}),
      ...(locks.length ? { locks } : {}),
      ...(engaged ? { engaged: { modules: engaged.modules } } : {}),
      ...(combat ? { combat: { ...combat, paperDps: Round(paperDps, 1) } } : {}),
      ...(kill ? { destroyed: { tick: kill.tick, by: kill.by, module: kill.module, weapon: kill.weapon, mode: kill.mode, ...this.DeathState(id) } } : {})
    };
  }

  /**
   * A destroyed ship's explosion for get_state: the file, the drawn explosion's state, when its ball leaves and whether
   * it has.
   */
  private DeathState(id: string): { readonly explosion?: ShipExplosionReport & { readonly removesAt: number; readonly gone: boolean } } {
    const death = this.deaths.get(id);
    if (!death) return {};
    const drawn = this.explosions?.Report(id);
    const state = drawn?.state ?? (death.hidden ? 'done' : death.begun ? 'playing' : 'waiting');
    return { explosion: { ...(drawn ?? { state, file: death.choice.name }), removesAt: death.removeTick, gone: death.gone } };
  }

  /**
   * The scene's combat for get_state: the seed, the death mode, the shot totals and the kills.
   */
  private SceneCombatState(): object {
    const docs = new Map((this.scene?.ships ?? []).map((doc) => [doc.id, doc]));
    const { seed, death } = this.combat.settings;
    return {
      seed,
      death,
      ...this.combat.Totals(),
      kills: this.combat.Kills().map((kill) => ({ ship: kill.ship, ...(docs.get(kill.ship)?.name ? { name: docs.get(kill.ship)?.name } : {}), ...(docs.get(kill.ship)?.team ? { team: docs.get(kill.ship)?.team } : {}), by: kill.by, module: kill.module, weapon: kill.weapon, tick: kill.tick }))
    };
  }

  /**
   * What runs on a ship and what it does to it, for get_state.
   *
   * @param id - The ship id.
   * @param flight - What it flies with.
   * @param motion - Its Destiny motion.
   * @returns The report; null when nothing runs on it and it can warp.
   */
  private TargetedState(id: string, flight: Maybe<ShipFlight>, motion: Maybe<ShipMotion>): Maybe<ShipTargetedReport> {
    const targeting = this.modules.Targeting(id);
    const tackle = this.world.Tackle(id);
    const status = flight?.warpScrambleStatus ?? 0;
    const canWarp = !tackle?.warp;
    if (!targeting.length && canWarp) return null;
    const live = this.capacitor.Has(id);
    const by = targeting.map(({ from, spec, effectiveness }): ShipTargetedByRow => {
      const { activation } = spec;
      const effect = activation.targetEffect;
      const amount = effect?.capacitor?.amount ?? effect?.modifiers[0]?.amount ?? activation.repair?.amount;
      const moved = effect?.capacitor && live ? this.capacitorMoved.get(`${from}|${spec.key}`) : undefined;
      return {
        from,
        module: spec.key,
        name: spec.name,
        category: activation.category,
        effectiveness: Math.round(effectiveness * 1000) / 1000,
        ...(amount == null ? {} : { amount: Math.round(amount * 100) / 100 }),
        cycleTime: Math.round(activation.cycleTime * 100) / 100,
        ...(moved == null ? {} : { moved: Math.round(moved * 10) / 10 }),
        ...(effect?.capacitor && !live ? { note: 'no live capacitor (no fit)' } : {})
      };
    });
    const unaffected = this.unaffectedFlights.get(id);
    const running = motion?.propMod.running === true;
    const factor = (key: 'maxVelocity' | 'signatureRadius'): Maybe<number> => {
      if (!flight || !unaffected) return null;
      const base = RunningFlight(unaffected, running)[key];
      const value = base > 0 ? Math.round((RunningFlight(flight, running)[key] / base) * 1000) / 1000 : 1;
      return value === 1 ? null : value;
    };
    const speedFactor = factor('maxVelocity');
    const signatureFactor = factor('signatureRadius');
    const warpNote = tackle?.warp ?? warpScrambleNoteOf({ status, steps: flight?.warpScrambleSteps ?? [] });
    return {
      by,
      ...(speedFactor == null ? {} : { speedFactor }),
      ...(signatureFactor == null ? {} : { signatureFactor }),
      warpScrambleStatus: Math.round(status * 1000) / 1000,
      canWarp,
      ...(warpNote ? { warpNote } : {}),
      ...(tackle?.propMod ? { mwdBlocked: tackle.propMod } : {})
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
    if (!this.FitsPropMod(doc)) return null;
    const propMod = flight?.propMod;
    const report = motion?.propMod;
    const note = [report?.note, propMod?.note].filter(Boolean).join('; ');
    return {
      module: propMod?.module ?? this.PropModModule(doc),
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
 * The module states a flight was computed with, to tell when they changed.
 *
 * @param dogma - The live dogma input.
 * @returns A key; empty without dogma.
 */
function LiveStatesKey(dogma: Maybe<ShipDogmaInput>): string {
  return (dogma?.modules ?? []).map((module) => `${module.key}:${module.typeID}:${module.state}`).join(',');
}

/**
 * The running targeted modules that change a ship's flight or tackle: webs, painters, points and scrams.
 *
 * @param targeting - The running targeted modules on it (ShipModules.Targeting).
 * @returns Those with target modifiers or an MWD block.
 */
function FlightTargeting(targeting: readonly TargetingModule[]): TargetingModule[] {
  return targeting.filter(({ spec }) => {
    const effect = spec.activation.targetEffect;
    return effect != null && (effect.modifiers.length > 0 || effect.blocksMicrowarpdrive === true);
  });
}

/**
 * What a flight was computed with: the live module states and the incoming target effects (each module and its
 * effectiveness at its latest cycle start), to tell when either changed.
 *
 * @param dogma - The live dogma input; null on the table path.
 * @param targeting - The running targeted modules on the ship.
 * @returns A key.
 */
function FlownKey(dogma: Maybe<ShipDogmaInput>, targeting: readonly TargetingModule[]): string {
  const incoming = FlightTargeting(targeting).map(({ from, spec, applied }) => `${from}:${spec.key}:${spec.typeID}:${Math.round(applied * 10_000)}`);
  return `${LiveStatesKey(dogma)}|${incoming.join(',')}`;
}

/**
 * The incoming modifiers of the running targeted modules on a ship, each scaled by its effectiveness at its latest
 * cycle start.
 *
 * @param targeting - The running targeted modules on the ship.
 * @returns The modifiers for its flight.
 */
function IncomingModifiersOf(targeting: readonly TargetingModule[]): DogmaIncomingModifier[] {
  return incomingModifiersOf(FlightTargeting(targeting).flatMap(({ from, spec, applied }) => (spec.activation.targetEffect ? [{ from, key: spec.key, name: spec.name, effect: spec.activation.targetEffect, effectiveness: applied }] : [])));
}

/**
 * A running targeted module on a ship, in get_state's `targeted.by`.
 */
export interface ShipTargetedByRow {
  readonly from: string;
  readonly module: string;
  readonly name: string;
  readonly category: ModuleCategory;
  /**
   * Its falloff effectiveness now, 3 decimals.
   */
  readonly effectiveness: number;
  /**
   * Per cycle, before falloff: a web's or painter's percent, a point's strength, GJ for capacitor warfare, HP for a rep.
   */
  readonly amount?: number;
  readonly cycleTime: number;
  /**
   * GJ its latest cycle start moved (capacitor warfare).
   */
  readonly moved?: number;
  readonly note?: string;
}

/**
 * What runs on a ship and what it does, in get_state: null when nothing runs on it and it can warp.
 */
export interface ShipTargetedReport {
  readonly by: readonly ShipTargetedByRow[];
  /**
   * Max velocity with the webs over without them (physics already includes them); absent when 1.
   */
  readonly speedFactor?: number;
  readonly signatureFactor?: number;
  /**
   * With the points and scrams on it and its own modules: above 0 it cannot warp.
   */
  readonly warpScrambleStatus: number;
  readonly canWarp: boolean;
  readonly warpNote?: string;
  readonly mwdBlocked?: string;
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
 * A vector off a runtime sample.
 */
function ToVector(value: ArrayLike<number>): SceneVector {
  return [value[0], value[1], value[2]];
}

/**
 * Get_state's `camera.drawn`: the pose and clip planes the last frame drew with, rounded.
 */
function DrawnCameraReport(drawn: Maybe<DrawnCamera>): Maybe<object> {
  const round = (value: number, scale: number): number => Math.round(value * scale) / scale;
  return drawn ? { eye: drawn.eye.map((value) => round(value, 100)), look: drawn.look.map((value) => round(value, 100)), up: drawn.up.map((value) => round(value, 1000)), fov: round(drawn.fov, 100), near: round(drawn.near, 1000), far: Math.round(drawn.far) } : null;
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

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
