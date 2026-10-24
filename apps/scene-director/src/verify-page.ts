/**
 * Drives the real page in headless Chromium through the hub's tools, against
 * a running tools-core. Headless Chromium here usually has no WebGPU adapter,
 * so this checks everything except drawing: boot, the hub link, SOF builds
 * from real EVE data, scene edits, and IndexedDB storage. With a GPU it also
 * saves a screenshot to .scratch/verify.png.
 *
 *   node dist/apps/scene-director/verify-page.js [--tools-core http://127.0.0.1:5510] [--viewer <dir>] [--headed]
 */

import type { Maybe } from '@dereekb/util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  DEFAULT_UNIVERSE,
  MAX_SCENE_DISTANCE,
  formationSpacing,
  toFollowTolerance,
  type FleetGroupCommandReport,
  type FleetReport,
  type LocationDressingReport,
  type LocationReport,
  type LocationTargetReport,
  type MapSystemAnswer,
  type SceneDocument,
  type SceneLocation,
  type SceneAsteroidFieldStateReport,
  type SceneObjectStateReport,
  type SceneVector,
  type ShipFleetMembership,
  type ShipOverview,
  type ShipScriptReport,
  type TimelineSummary,
  type TimeReport,
  type CueReport,
  type SceneCue
} from '@scene-director/scene';
import { AudioBankCache } from './lib/hub/audio-cache';
import { Hub } from './lib/hub/hub';
import { ShipDataError } from './lib/hub/ship-data';
import type { ShipStatsAnswer } from './lib/hub/ship-stats-tool';
import { ErrorMessage, ErrorProblems } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
import { FleetCompositionFileStore } from './lib/store/composition-files';
import { FleetPersonalityFileStore } from './lib/store/personality-files';
import { SceneFileStore } from './lib/store/scene-files';

/**
 * The shapes of the tool answers this script reads.
 */
interface ViewerStatus {
  readonly connectedTabs: number;
}

interface ShipReport {
  readonly id: string;
  readonly status: string;
  readonly error?: string;
}

interface SceneResult {
  readonly scene: { readonly name: string; readonly ships: unknown[]; readonly fleets?: unknown[] };
  readonly ships: ShipReport[];
  readonly changes: Record<string, number>;
}

interface SceneListing {
  readonly scenes: { readonly name: string; readonly store: string }[];
}

interface ShipOrderState {
  readonly type: string;
  readonly target?: string;
  readonly range?: number;
  readonly point?: [number, number, number];
  readonly speed?: number;
}

interface ShipPhysicsState {
  readonly mass: number;
  readonly agility: number;
  readonly maxVelocity: number;
  readonly radius: number;
  readonly signatureRadius: number;
  readonly alignTime: number;
  readonly warpSpeed?: number;
  readonly source: string;
  readonly typeID?: number;
  readonly typeName?: string;
  readonly note?: string;
}

interface ShipState extends Partial<ShipFleetMembership> {
  readonly id: string;
  readonly status?: string;
  readonly position?: [number, number, number];
  readonly velocity?: [number, number, number];
  readonly speed?: number;
  readonly mode?: string;
  readonly order?: ShipOrderState;
  readonly pendingOrder?: ShipOrderState;
  readonly orderNote?: string;
  readonly targetDistance?: number;
  readonly physics?: ShipPhysicsState;
  readonly heading?: [number, number];
  readonly slotError?: number;
  readonly following?: ShipFollowingState;
  readonly warp?: ShipWarpState;
  readonly arrival?: ShipArrivalState;
  readonly boosters?: { readonly maxVel: number; readonly intensity: number; readonly warpIntensity: number };
  readonly propMod?: Maybe<ShipPropModState>;
  readonly fit?: Maybe<ShipFitState>;
  readonly fitNote?: string;
  readonly target?: Maybe<{ readonly id: string; readonly kind: 'ship' | 'object'; readonly distance: Maybe<number>; readonly source?: 'own' | 'called' | 'free' }>;
  readonly call?: ShipCallState;
  readonly autoRepair?: ShipAutoRepairState;
  readonly shots?: number;
  readonly defense?: Maybe<ShipDefenseState>;
  readonly capacitor?: Maybe<ShipCapacitorState>;
  readonly targeted?: Maybe<ShipTargetedState>;
  readonly targeting?: { readonly scanResolution: number; readonly maxTargetRange: number; readonly maxLocks: number };
  readonly locks?: ShipLockState[];
  readonly engaged?: { readonly modules: string[] };
  readonly combat?: ShipCombatState;
  readonly missiles?: { readonly launched: number; readonly inFlight: number };
  readonly destroyed?: {
    readonly tick: number;
    readonly by: string;
    readonly module: string;
    readonly weapon: string;
    readonly mode: string;
    readonly explosion?: { readonly state: string; readonly file: string; readonly removesAt: number; readonly gone: boolean };
  };
}

/**
 * A lock in get_state and in set_target / engage answers (the viewer's locks.ts ShipLockReport).
 */
interface ShipLockState {
  readonly target?: string;
  readonly state?: 'waiting' | 'locking' | 'locked';
  readonly lockTime?: number;
  readonly readyIn?: number;
  readonly note?: string;
  readonly refused?: string;
}

/**
 * A shot row in get_state's combat (the viewer's combat.ts CombatRow).
 */
interface CombatRowState {
  readonly tick: number;
  readonly target?: string;
  readonly from?: string;
  readonly module: string;
  readonly result: string;
  readonly chance: number;
  readonly quality: number;
  readonly damage: number;
  readonly layer?: 'shield' | 'armor' | 'structure';
  readonly note?: string;
  readonly missile?: true;
}

/**
 * get_state's scene-level `missiles` (the viewer's missile-flights.ts MissileFlightsReport).
 */
interface MissilesState {
  readonly inFlight: number;
  readonly launched: number;
  readonly hits: number;
  readonly expired: number;
  readonly lost: number;
  readonly refused: number;
  readonly flights: {
    readonly id: string;
    readonly ship: string;
    readonly module: string;
    readonly charge?: string;
    readonly target: string;
    readonly state: 'flying' | 'lost' | 'hit' | 'expired';
    readonly launchedAt: number;
    readonly age: number;
    readonly expiresIn?: number;
    readonly distance?: number;
    readonly speed?: number;
    readonly why?: string;
  }[];
}

/**
 * get_state's per-ship `combat` (the viewer's combat.ts ShipCombatReport).
 */
interface ShipCombatState {
  readonly dealt: number;
  readonly taken: number;
  readonly dps: { readonly dealt: number; readonly taken: number };
  readonly shots: number;
  readonly hits: number;
  readonly misses: number;
  readonly lastHits: CombatRowState[];
  readonly lastTaken: CombatRowState[];
  readonly paperDps: number;
  readonly repairs?: ShipRepairsState;
}

/**
 * A fleet member's logi auto-repair in get_state (the viewer's auto-repair.ts AutoRepairReport).
 */
interface ShipAutoRepairState {
  readonly state: string;
  readonly on: boolean;
  readonly policy: string;
  readonly source: string;
  readonly policySource: string;
  readonly target?: string;
  readonly reason?: string;
  readonly why: string;
  readonly since?: number;
  readonly layer?: string;
  readonly modules?: { readonly module: string; readonly state: string }[];
  readonly hps?: number;
  readonly preLocks?: string[];
  readonly note?: string;
}

/**
 * A fleet's logi auto-repair in get_state (the viewer's auto-repair.ts AutoRepairFleetReport).
 */
interface FleetAutoRepairState {
  readonly logi: number;
  readonly repairing: number;
  readonly locking: number;
  readonly idle: number;
  readonly outOfRange: number;
  readonly manual: number;
  readonly off: number;
  readonly targets: { readonly target: string; readonly logi: string[]; readonly hps: number }[];
}

/**
 * A ship's repair tallies in get_state (the viewer's combat.ts ShipRepairReport).
 */
interface ShipRepairsState {
  readonly received: number;
  readonly given: number;
  readonly hps: { readonly received: number; readonly given: number };
  readonly lastReceived: { readonly tick: number; readonly from: string; readonly module: string; readonly layer: string; readonly amount: number; readonly nominal: number }[];
}

/**
 * engage's answer (the viewer's director.ts EngageResult).
 */
interface EngageResult {
  readonly tick: number;
  readonly target: string;
  readonly ships: { readonly id: string; readonly target: string; readonly lock: Maybe<ShipLockState>; readonly modules: { readonly module: string; readonly state: string }[] }[];
  readonly skipped: { readonly id: string; readonly module?: string; readonly reason: string }[];
  readonly warnings?: string[];
}

/**
 * get_state's `targeted` (the viewer's director.ts ShipTargetedReport).
 */
interface ShipTargetedState {
  readonly by: { readonly from: string; readonly module: string; readonly name: string; readonly category: string; readonly effectiveness: number; readonly amount?: number; readonly cycleTime: number; readonly moved?: number; readonly note?: string }[];
  readonly speedFactor?: number;
  readonly signatureFactor?: number;
  readonly warpScrambleStatus: number;
  readonly canWarp: boolean;
  readonly warpNote?: string;
  readonly mwdBlocked?: string;
}

/**
 * get_state's `fit` (the viewer's fittings.ts ShipFitReport).
 */
interface ShipFitState {
  readonly name: string;
  readonly key: string;
  readonly default?: true;
  readonly typeID?: number;
  readonly unknown: string[];
  readonly modules: ShipModuleRowState[];
  readonly math: 'dogma' | 'table';
  readonly note?: string;
}

/**
 * A fitted module's row in get_state's `fit.modules`.
 */
interface ShipModuleRowState {
  readonly module: string;
  readonly name: string;
  readonly state: string;
  readonly cycle?: { readonly number: number; readonly endsIn: number };
  readonly stopsIn?: number;
  readonly target?: string;
  readonly nextTarget?: string;
  readonly effectiveness?: number;
  readonly cycleTime?: number;
  readonly charge?: string;
  readonly mount?: { readonly locator?: string; readonly state: string; readonly models?: number; readonly error?: string };
  readonly prop?: true;
  readonly combat?: { readonly damage: Record<string, number>; readonly volley: number; readonly dps: number; readonly velocity?: number; readonly flightTime?: number; readonly range?: { readonly lower: number; readonly upper: number; readonly upperChance: number; readonly mean: number } };
  readonly inFlight?: number;
  readonly note?: string;
}

/**
 * switch_modules' answer (the viewer's director.ts SwitchModulesResult).
 */
interface SwitchModulesResult {
  readonly tick: number;
  readonly state: string;
  readonly ships: { readonly id: string; readonly modules: { readonly module: string; readonly name: string; readonly state: string; readonly at?: number; readonly stopsIn?: number; readonly target?: string; readonly nextTarget?: string; readonly effectiveness?: number; readonly cycleTime?: number }[] }[];
  readonly skipped: { readonly id: string; readonly module?: string; readonly reason: string }[];
  readonly notes?: string[];
}

/**
 * set_target's answer (the viewer's director.ts SetTargetResult).
 */
interface SetTargetResult {
  readonly tick: number;
  readonly target: Maybe<string>;
  readonly ships: { readonly id: string; readonly target: Maybe<string>; readonly previous?: string; readonly source?: 'own' | 'called'; readonly turrets: number; readonly launchers?: number; readonly retargeted: number; readonly lock?: Maybe<ShipLockState> }[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
}

type DamageResists = Readonly<Record<'em' | 'thermal' | 'kinetic' | 'explosive', number>>;

/**
 * get_state's `defense` (the viewer's fittings.ts ShipDefenseReport).
 */
type ShipDefenseState = Readonly<Record<'shield' | 'armor' | 'structure', { readonly hp: number; readonly max: number; readonly resists: DamageResists; readonly ehp: number }>> & {
  readonly ehp: number;
  readonly shieldRecharge: number;
  readonly incoming?: { readonly from: string; readonly module: string; readonly layer: string; readonly effectiveness: number }[];
};

interface ShipCapacitorState {
  readonly capacity: number;
  readonly rechargeTime: number;
  /**
   * The live level in GJ (fitted ships on the dogma path).
   */
  readonly level?: number;
  readonly fraction?: number;
}

interface ShipPropModState {
  readonly module: string | number;
  readonly name?: string;
  readonly typeID?: number;
  readonly source?: string;
  readonly note?: string;
  readonly state: 'off' | 'activating' | 'active' | 'stopping';
  readonly cycleTime?: number;
  readonly stopsIn?: number;
  readonly maxVelocity?: number;
  readonly signatureRadius?: number;
}

interface SwitchPropModsResult {
  readonly tick: number;
  readonly active: boolean;
  readonly ships: { readonly id: string; readonly module: string; readonly state: string; readonly at?: number; readonly stopsIn?: number }[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
}

interface AudioState {
  readonly state: string;
  readonly error?: string;
  readonly emitters: number;
  /**
   * Audio game objects registered with the runtime's manager: the page's emitters and the listener.
   */
  readonly gameObjects?: number;
  /**
   * Registered audio game objects that are neither the page's emitters nor the listener, by name (omitted when none).
   */
  readonly foreign?: Readonly<Record<string, number>>;
  readonly posted: { readonly tick: number; readonly ship: string; readonly event: string; readonly played: boolean; readonly undecodable?: boolean; readonly muted?: boolean }[];
  /**
   * Events the runtime decodes none of the media of: recorded, never sent.
   */
  readonly undecodable?: string[];
  readonly frameErrors?: number;
  readonly rescheduled?: number;
  readonly backendErrors?: number;
  readonly context?: string;
}

interface ShipWarpState {
  readonly phase: 'aligning' | 'warping' | 'exiting' | 'landed';
  readonly landing: [number, number, number];
  readonly warpSpeed: number;
  readonly alignTicks?: number;
  readonly distance?: number;
  readonly remaining: number;
  readonly progress: number;
  readonly landsIn?: number;
}

/**
 * get_state's `arrival` on a ship landing from warp (destiny.ts ShipArrivalReport).
 */
interface ShipArrivalState {
  readonly state: 'parked' | 'scheduled' | 'warping' | 'landed';
  readonly from: SceneVector;
  readonly landing: SceneVector;
  readonly landsIn?: number;
  readonly landedAt?: number;
  readonly leader?: string;
}

/**
 * What an arrival watch saw of one ship: the least distance from its landing while it waited, the greatest while it
 * was in warp, where it warped from and to, and the tick it dropped out of warp.
 */
interface ArrivalSeen {
  waitedFrom: number;
  warpedFrom: number;
  from: Maybe<SceneVector>;
  landing: Maybe<SceneVector>;
  landedAt: Maybe<number>;
}

/**
 * get_state's `arrivals` (and an add's result `arrivals`): one group of ships landing from warp.
 */
interface ArrivalGroupState {
  readonly group: string;
  readonly fleet?: string;
  readonly state: string;
  readonly counts: Record<string, number>;
  readonly ships: { readonly id: string; readonly state: string }[];
}

interface ShipFollowingState {
  readonly state: string;
  readonly anchor: string;
  readonly range: number;
  readonly slot?: { readonly range: number; readonly direction: SceneVector };
  readonly distance?: number;
  readonly slotError?: number;
  readonly warping?: string;
  readonly group?: { readonly kind: string; readonly id: string; readonly leader: string };
}

interface FleetFormationState {
  readonly ready: boolean;
  readonly heading: [number, number];
  readonly following: number;
  readonly inFormation: number;
  readonly catchingUp: number;
  readonly holding: number;
  readonly warping: number;
  readonly leading: number;
  readonly detached: number;
  readonly waiting: number;
}

/**
 * get_state's `simulation.warpFlashes`: the warp flashes played since the page loaded.
 */
interface WarpFlashState {
  readonly warpOut: number;
  readonly warpIn: number;
}

/**
 * A personality fleet's brain in get_state (fleets[].fc).
 */
interface FleetBrainState {
  readonly personality: string;
  readonly ship: string;
  readonly ability: number;
  readonly state: string;
  readonly successor?: string;
  readonly takesOverIn?: number;
  readonly engaged: boolean;
  readonly hostiles: number;
  readonly manual: readonly string[];
  readonly held?: true;
  readonly pending: readonly { readonly lever: string; readonly dueIn: number; readonly why: string }[];
  readonly decisions: readonly { readonly tick: number; readonly lever: string; readonly tool: string; readonly args: { readonly by?: string; readonly order?: { readonly type?: string; readonly set?: readonly string[] } }; readonly why: string; readonly refused?: string }[];
}

interface ViewerState {
  readonly renderer: { readonly available: boolean; readonly adapter?: string; readonly reason?: string };
  readonly environment: Maybe<{ readonly background: { readonly ready: boolean }; readonly dressing: { readonly state: string } }>;
  readonly simulation: { readonly tick: number; readonly seconds: number; readonly warpFlashes?: WarpFlashState };
  readonly ships: ShipState[];
  readonly arrivals?: ArrivalGroupState[];
  readonly distances: { readonly centreToCentre: number }[];
  readonly fleets: (FleetReport & {
    readonly actingFor?: string;
    readonly destroyed?: string[];
    readonly formation?: FleetFormationState;
    readonly propMods?: Record<string, number>;
    readonly modules?: Record<string, number>;
    readonly command?: FleetGroupCommandReport;
    readonly autoRepair?: FleetAutoRepairState;
    readonly fc?: FleetBrainState;
  })[];
  readonly location?: Maybe<LocationReport & { readonly dressing?: Maybe<LocationDressingReport>; readonly targets?: LocationTargetReport[] }>;
  readonly audio?: AudioState;
  readonly objects?: SceneObjectStateReport[];
  readonly asteroidFields?: SceneAsteroidFieldStateReport[];
  readonly scene?: Maybe<{ readonly asteroidFields?: number }>;
  readonly cinema?: CinemaStateReport;
  readonly combat?: { readonly seed: number; readonly death: string; readonly shots: number; readonly hits: number; readonly repaired?: number; readonly kills: { readonly ship: string; readonly by: string; readonly module: string; readonly weapon: string; readonly tick: number }[] };
  readonly missiles?: MissilesState;
}

/**
 * get_state's `cinema` (the viewer's cinema.ts CinemaRig.Report).
 */
interface CinemaStateReport {
  readonly state: 'idle' | 'playing' | 'paused' | 'releasing';
  readonly driver: 'claude' | 'director' | 'timeline' | 'user';
  readonly shot: Maybe<{
    readonly library?: string;
    readonly hardpoint?: { readonly name: string };
    readonly elapsed: number;
    readonly duration: Maybe<number>;
    readonly progress: Maybe<number>;
    readonly holding?: boolean;
  }>;
  readonly sequence: Maybe<{ readonly index: number; readonly count: number; readonly elapsed: number; readonly duration: Maybe<number>; readonly progress: Maybe<number> }>;
  readonly resumable: Maybe<{ readonly index: number; readonly count: number; readonly elapsed: number }>;
  readonly pose: Maybe<{ readonly eye: number[]; readonly look: number[] }>;
  readonly near: Maybe<number>;
  readonly note: Maybe<string>;
  readonly director?: DirectorStateReport;
}

/**
 * get_state.cinema.director (packages/scene cinema/director/report.ts), the parts the director checks read.
 */
interface DirectorStateReport {
  readonly on: boolean;
  readonly state: 'off' | 'waiting' | 'driving' | 'paused' | 'yielded';
  readonly yieldedTo?: 'user' | 'claude' | 'timeline';
  readonly source?: string;
  readonly pick?: { readonly framing: string; readonly shot: { readonly subject: string }; readonly scale: string; readonly side: string; readonly since: number; readonly score: number; readonly why: string; readonly event?: { readonly kind: string } };
  readonly axis?: { readonly kind: 'teams' | 'motion'; readonly side: string };
  readonly cuts: number;
  readonly cost: { readonly lastMs: number; readonly maxMs: number };
  readonly note?: string;
}

/**
 * One cut of the director's log (cinema/director/step.ts DirectorCutLogEntry).
 */
interface DirectorCutReport {
  readonly tick: number;
  readonly at: number;
  readonly framing: string;
  readonly subject: string;
  readonly scale: string;
  readonly side: 'port' | 'starboard' | 'neutral';
  readonly crossing?: true;
  readonly free?: true;
  readonly why: string;
}

/**
 * list_hardpoints' answer.
 */
interface HardpointListingResult {
  readonly kind: string;
  readonly subject: Maybe<{ readonly centre: number[]; readonly radius: number; readonly teams?: string[] }>;
  readonly hardpoints: { readonly name: string; readonly eye?: number[]; readonly look?: number[]; readonly note?: string }[];
  readonly warnings: string[];
}

interface AddAsteroidFieldResult {
  readonly added: { readonly id: string; readonly position: SceneVector; readonly radius: number; readonly count: number; readonly placed: number; readonly envelope: number; readonly digest: string };
  readonly ores: { readonly ore?: string; readonly models: { readonly small: number; readonly medium: number; readonly large: number } }[];
  readonly warnings: string[];
}

interface FieldChanges {
  readonly changes: { readonly asteroidFields?: { readonly added: number; readonly rebuilt: number; readonly moved: number; readonly removed: number } };
}

interface AddObjectsResult {
  readonly added: { readonly id: string; readonly position: SceneVector; readonly radius?: number }[];
  readonly types: { readonly typeID: number; readonly radius: number; readonly radiusFrom: string; readonly sdeRadius?: number }[];
  readonly scene: SceneDocument;
  readonly warnings: string[];
}

interface MapSearchResult {
  readonly items: { readonly kind: string; readonly id: number; readonly name: string; readonly system?: { readonly id: number; readonly name?: string } }[];
}

interface SystemResult {
  readonly nebula: Maybe<string>;
  readonly counts: Record<string, number>;
  readonly celestials: { readonly id: number; readonly kind: string; readonly name: string; readonly radius?: number }[];
}

interface SetLocationResult {
  readonly location: SceneLocation;
  readonly celestial: Maybe<{ readonly id: number; readonly kind: string }>;
  readonly range?: number;
  readonly loaded?: boolean;
  readonly reloading?: boolean;
  readonly nebula?: string;
  readonly warnings?: string[];
  readonly scene?: { readonly environment: { readonly universe: string } };
}

interface AddedFleetResult extends Omit<SceneResult, 'scene'> {
  readonly added: { readonly fleet: string; readonly commander: string; readonly ships: string[] };
  readonly hulls: { readonly hull?: string; readonly radius: number; readonly dnaFrom: string; readonly radiusFrom: string }[];
  readonly propMods: { readonly module: string | number; readonly typeID?: number; readonly from: string; readonly note?: string }[];
  readonly scene: { readonly name: string; readonly ships: { readonly id: string; readonly type?: string; readonly position: SceneVector }[] };
  readonly arrivals?: ArrivalGroupState[];
}

interface StagedLead {
  readonly id: string;
  readonly position: SceneVector;
  readonly heading: number;
}

interface AddShipsResult extends Omit<SceneResult, 'scene'> {
  readonly added: { readonly ships: string[]; readonly lead: Maybe<StagedLead>; readonly fleet?: Maybe<{ readonly id: string; readonly squad: Maybe<string>; readonly commander: string; readonly created: Maybe<string> }> };
  readonly hull: { readonly dna: string; readonly radius: number; readonly dnaFrom: string; readonly radiusFrom: string };
  readonly scene: { readonly ships: { readonly id: string; readonly position: SceneVector; readonly rotation: SceneVector }[] };
  readonly warnings?: string[];
  readonly arrivals?: ArrivalGroupState[];
}

interface StageEngagementResult extends Omit<SceneResult, 'scene'> {
  readonly engagement: { readonly center: SceneVector; readonly heading: number; readonly sides: { readonly team: string; readonly fleet?: string; readonly commander?: string; readonly ships: string[]; readonly lead: Maybe<StagedLead> }[] };
  readonly scene: { readonly ships: { readonly id: string; readonly position: SceneVector }[]; readonly fleets?: unknown[] };
  readonly loaded?: boolean;
  readonly arrivals?: ArrivalGroupState[];
}

interface LogEntry {
  readonly message: string;
}

/**
 * get_state's `call` on a fleet member (the viewer's fleet-targets.ts ShipCallReport).
 */
interface ShipCallState {
  readonly state: string;
  readonly group?: { readonly fleet: string; readonly kind: string; readonly id: string };
  readonly primary?: string;
  readonly respondsIn?: number;
  readonly free?: string;
  readonly picksIn?: number;
}

/**
 * get_state's `called` on a fleet, wing or squad (the viewer's fleet-targets.ts FleetGroupCalledReport).
 */
interface CalledState {
  readonly primary: Maybe<string>;
  readonly queue: string[];
  readonly skipped?: { readonly id: string; readonly why: string }[];
  readonly following: number;
}

/**
 * get_state's fleet tree with each group's called targets (order_fleet targets).
 */
interface CalledTree {
  readonly targets?: string[];
  readonly called?: CalledState;
  readonly wings: readonly { readonly id: string; readonly called?: CalledState; readonly squads: readonly { readonly id: string; readonly targets?: string[]; readonly called?: CalledState }[] }[];
}

/**
 * An order_fleet targets order's answer (the viewer's director.ts FleetTargetsOrderResult).
 */
interface FleetTargetsOrderResult {
  readonly tick: number;
  readonly targets: string[];
  readonly primary: Maybe<string>;
  readonly queue: string[];
  readonly ships: { readonly id: string; readonly target: Maybe<string>; readonly source?: string; readonly respondsIn?: number }[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
  readonly delays?: Record<string, number>;
  readonly warnings?: string[];
}

/**
 * get_state's fleet tree with each group's command (order_fleet).
 */
interface CommandTree {
  readonly command?: FleetGroupCommandReport;
  readonly wings: readonly { readonly id: string; readonly command?: FleetGroupCommandReport; readonly squads: readonly { readonly id: string; readonly command?: FleetGroupCommandReport }[] }[];
}

/**
 * An order's `resolved`: what a target name became (order_ship, order_fleet).
 */
interface ResolvedOrderTarget {
  readonly name: string;
  readonly kind: string;
  readonly target?: string;
  readonly point?: SceneVector;
  readonly range: number;
}

interface OrderFleetResult {
  readonly by: string;
  readonly resolved?: ResolvedOrderTarget;
  readonly leader: string;
  readonly ships: readonly (string | { readonly id: string; readonly landing: SceneVector })[];
  readonly skipped?: readonly { readonly id: string; readonly reason: string }[];
  readonly landing?: SceneVector;
  readonly warping?: readonly string[];
  readonly operations?: readonly { readonly op: string }[];
  readonly delays?: Readonly<Record<string, number>>;
}

interface SceneFleetsResult {
  readonly fleets?: readonly { readonly id: string; readonly wings: readonly { readonly squads: readonly { readonly id: string; readonly anchor?: unknown; readonly home?: unknown }[] }[] }[];
}

const SCREENSHOT_FILE = '.scratch/verify.png';
const TFI_DNA = 'mb2_t1:minmatarnavy:minmatar';
const GUARDIAN_DNA = 'ac3_t2:carthum:amarr';

/**
 * The value after a command-line flag.
 *
 * @param name - The flag.
 * @param fallback - Returned when the flag is absent.
 * @returns The flag's value or the fallback.
 */
function Option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

/**
 * Throws when a check's condition does not hold.
 *
 * @param condition - What must be true.
 * @param message - The failure to report.
 * @throws {Error} When the condition is false.
 */
function Expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * A check that cannot run here (no prepared SDE): reported as a skip, not a failure.
 */
class Skipped extends Error {}

/**
 * Turns an unavailable SDE into a skip.
 *
 * @param error - Whatever a ship_stats call threw.
 * @throws {Skipped} When tools-core has no SDE; otherwise the error itself.
 */
function SkipWithoutSde(error: unknown): never {
  if (error instanceof ShipDataError && error.failure === 'unavailable') throw new Skipped(error.message);
  // A hull name the hub could not resolve for want of the SDE comes back among the document's problems.
  const missing = /tools-core has no SDE for build \d+/u.exec(ErrorMessage(error));
  if (missing) throw new Skipped(missing[0]);
  throw error;
}

/**
 * Whether two numbers agree to a relative tolerance.
 *
 * @param a - One number.
 * @param b - The other.
 * @returns True when they differ by at most 1e-9 of their size.
 */
function Close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * A ship's live state from get_state.
 *
 * @param state - The viewer state.
 * @param id - The ship id.
 * @returns The ship.
 * @throws {Error} When get_state does not list it.
 */
function ShipIn(state: ViewerState, id: string): ShipState {
  const ship = state.ships.find((entry) => entry.id === id);
  if (!ship) throw new Error(`get_state has no ship "${id}"`);
  return ship;
}

/**
 * The smallest angle between two yaws.
 *
 * @param a - Degrees.
 * @param b - Degrees.
 * @returns Degrees in [0, 180].
 */
function YawGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
}

/**
 * Waits.
 *
 * @param ms - Milliseconds.
 * @returns A promise that resolves after the delay.
 */
function Delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * A tool call given `at`: the cue it became.
 */
interface CueResult {
  readonly cue: SceneCue & { readonly patch_scene?: { readonly operations: { readonly composition?: { readonly commander?: { readonly dna?: string } } }[] } };
  readonly state: Maybe<string>;
  readonly warnings: string[];
}

/**
 * The timeline tool's report.
 */
interface TimelineToolReport extends TimelineSummary {
  readonly list: CueReport[];
  readonly ships: ({ readonly ship: string } & ShipScriptReport)[];
  readonly held: boolean;
}

const toolsCore = new ToolsCore({ url: Option('--tools-core', DEFAULT_TOOLS_CORE) });
/**
 * `--only <text>` runs only the checks whose label contains the text (any case; `a|b` for either), after the tab connects.
 */
const ONLY = Option('--only', '').toLowerCase();
const CONNECT_CHECK = 'the tab connects to the hub';
const status = await toolsCore.Status();
if (!status.reachable) {
  console.error(status.error);
  process.exit(1);
}

// Saved scene and fleet composition files go to throwaway directories, never the user's.
const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-')));
const compositions = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-fleets-')));
const personalities = new FleetPersonalityFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-personalities-')));
// The audio cache is shared with every hub on the machine (a copy of tools-core's banks, not a store).
const hub = await new Hub({ port: 0, toolsCore, viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')), scenes, compositions, personalities, audioCache: new AudioBankCache(), log: () => undefined }).Start();
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => hub.Call(name, args) as Promise<T>;
// Autoplay lets the page turn audio on without a gesture, so the audio check sees the engine stems post.
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const results: string[] = [];
let failed = 0;

/**
 * Polls get_state every 500 ms until a test passes on `streak` polls in a row.
 *
 * @param what - What is awaited, for the failure.
 * @param seconds - The budget.
 * @param test - Returns null when the state passes, else what is wrong.
 * @param streak - Consecutive passing polls needed.
 * @returns The last state polled.
 * @throws {Error} With the last problem when the budget runs out.
 */
async function WaitFor(what: string, seconds: number, test: (state: ViewerState) => Maybe<string>, streak = 1): Promise<ViewerState> {
  const end = Date.now() + seconds * 1000;
  let run = 0;
  let last = 'never polled';
  while (Date.now() < end) {
    const state = await call<ViewerState>('get_state');
    const problem = test(state);
    run = problem == null ? run + 1 : 0;
    if (problem == null && run >= streak) return state;
    if (problem != null) last = problem;
    await Delay(500);
  }
  throw new Error(`${what} within ${seconds} s: ${last}`);
}

/**
 * The first fleet member not in formation.
 *
 * @param state - The viewer state.
 * @param ids - The members.
 * @returns What is wrong with it, or null when every member is in formation.
 */
function NotInFormation(state: ViewerState, ids: readonly string[]): Maybe<string> {
  const off = ids.map((id) => ShipIn(state, id)).find((ship) => ship.following?.state !== 'in-formation');
  return off ? `${off.id} ${JSON.stringify(off.following)}` : null;
}

/**
 * Runs one check and records its outcome.
 *
 * @param label - What is checked.
 * @param action - The check; its string result is reported as detail.
 */
async function Check(label: string, action: () => Promise<string | void>): Promise<void> {
  if (ONLY && label !== CONNECT_CHECK && !ONLY.split('|').some((text) => label.toLowerCase().includes(text))) return;
  try {
    const detail = await action();
    results.push(detail ? `ok    ${label} - ${detail}` : `ok    ${label}`);
  } catch (error) {
    if (error instanceof Skipped) {
      results.push(`skip  ${label} - ${error.message}`);
    } else {
      failed += 1;
      results.push(`FAIL  ${label} - ${ErrorMessage(error)}`);
    }
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(hub.url);
  await Check(CONNECT_CHECK, async () => {
    for (let attempt = 0; attempt < 100 && (await call<ViewerStatus>('viewer_status')).connectedTabs === 0; attempt++) await Delay(200);
    Expect((await call<ViewerStatus>('viewer_status')).connectedTabs === 1, 'no tab after 20 s');
  });

  const state = await call<ViewerState>('get_state');
  const rendering = state.renderer.available;
  const renderer = rendering ? state.renderer.adapter : `unavailable (${state.renderer.reason})`;
  results.push(`info  renderer: ${renderer}; EVE build ${status.build}`);
  /**
   * The TFIs fleet the composition check added, for the follow check after it.
   */
  let tfis: Maybe<AddedFleetResult> = null;

  await Check('get_state reports the environment only with a renderer', async () => {
    const { environment } = state;
    Expect(rendering === (environment !== null), rendering ? 'no environment with a renderer' : 'an environment without a renderer');
    return environment ? `background ${environment.background.ready ? 'ready' : 'loading'}, dressing ${environment.dressing.state}` : 'null without a renderer';
  });

  await Check('search_hulls finds frigates', async () => {
    const found = await call<{ names: string[]; total: number }>('search_hulls', { query: 'f1_t1', limit: 5 });
    Expect(found.names.includes('af1_t1'), `got ${found.names.join(', ')}`);
    return `${found.total} matches`;
  });

  let sdeBuild: Maybe<string> = null;
  await Check('ship_stats reads a hull and a prop mod from the SDE', async () => {
    const answer = await call<ShipStatsAnswer>('ship_stats', { dna: 'mb2_t1:minmatarnavy:minmatar', propMod: 'mwd' }).catch(SkipWithoutSde);
    const { hull, stats, withPropMod } = answer;
    sdeBuild = hull.sdeBuild ?? null;
    Expect(hull.typeID === 17732 && hull.name === 'Tempest Fleet Issue', `resolved ${hull.typeID} ${hull.name}`);
    Expect(answer.propMod?.typeID === 12084, `prop mod ${answer.propMod?.typeID}`);
    Expect(hull.published && Math.abs(stats.maxVelocity - hull.published.maxVelocity * 1.25) < 1e-9, 'Navigation V is not +25 %');
    Expect(withPropMod && withPropMod.maxVelocity > stats.maxVelocity && withPropMod.signatureRadius > stats.signatureRadius, 'the MWD neither speeds up nor blooms');
    // The specs' fixtures (ESI, 2026-10-21); a difference means CCP rebalanced, which is news, not a failure.
    const fixture = { maxVelocity: 162.5, withMwd: 1176.137476, signatureRadius: 2012.5 };
    const live = { maxVelocity: stats.maxVelocity, withMwd: withPropMod?.maxVelocity ?? 0, signatureRadius: withPropMod?.signatureRadius ?? 0 };
    const drift = (Object.keys(fixture) as (keyof typeof fixture)[]).filter((key) => Math.abs(fixture[key] - live[key]) > 1e-3);
    const differences = drift.map((key) => `${key} ${live[key]} (fixture ${fixture[key]})`).join(', ');
    if (drift.length) results.push(`info  SDE ${sdeBuild} differs from the spec fixtures in ${differences}`);
    return `SDE ${sdeBuild}: TFI ${stats.maxVelocity.toFixed(2)} m/s, align ${stats.alignTime.toFixed(2)} s; with ${answer.propMod?.name} ${withPropMod?.maxVelocity.toFixed(2)} m/s, sig ${withPropMod?.signatureRadius} m`;
  });

  await Check('ship_stats names a prop mod by its EVE name', async () => {
    const coldGas = await call<ShipStatsAnswer>('ship_stats', { dna: TFI_DNA, propMod: '500MN Cold-Gas Enduring Microwarpdrive' }).catch(SkipWithoutSde);
    const running = coldGas.withPropMod;
    if (!running) throw new Error('ship_stats gave no Cold-Gas numbers');
    Expect(coldGas.propMod?.typeID === 5945 && running.propModCycleTime === 10, `${JSON.stringify(coldGas.propMod)} cycle ${running?.propModCycleTime}`);
    Expect(running.maxVelocity > coldGas.stats.maxVelocity && running.signatureRadius > coldGas.stats.signatureRadius, JSON.stringify(running));
    // The plan's numbers (SDE 3632936, 2026-10-22); a difference means CCP rebalanced, which is news, not a failure.
    if (Math.abs(running.maxVelocity - 1166.199853) > 1e-3 || running.signatureRadius !== 2100) results.push(`info  the Cold-Gas TFI flies ${running.maxVelocity} m/s, sig ${running.signatureRadius} (fixture 1166.199853, 2100)`);
    const guardian = await call<ShipStatsAnswer>('ship_stats', { type: 11987, propMod: 'ab' });
    Expect(guardian.propMod?.typeID === 12058 && guardian.withPropMod?.propModCycleTime === 7.5, `${JSON.stringify(guardian.propMod)} cycle ${guardian.withPropMod?.propModCycleTime}`);
    return `TFI with ${coldGas.propMod?.name} ${running.maxVelocity.toFixed(2)} m/s, sig ${running.signatureRadius} m, cycle 10 s; Guardian 10MN AB II cycle 7.5 s`;
  });

  await Check("the skill table matches tools-core's dogma evaluation", async () => {
    const ours = await call<ShipStatsAnswer>('ship_stats', { type: 11987 }).catch(SkipWithoutSde);
    const build = sdeBuild ?? ours.hull.sdeBuild;
    const response = await fetch(`${toolsCore.url}/eve/${build}/dogma/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ typeID: 11987, profile: { mode: 'manual', skills: [3449, 3453, 3327].map((typeID) => ({ typeID, level: 5 })) }, sections: ['navigation'] })
    });
    Expect(response.ok, `dogma/evaluate answered ${response.status}`);
    const { effective } = (await response.json()) as { effective: { maxVelocity: number; agility: number } };
    Expect(Close(effective.maxVelocity, ours.stats.maxVelocity), `maxVelocity: tools-core ${effective.maxVelocity}, ours ${ours.stats.maxVelocity}`);
    Expect(Close(effective.agility, ours.stats.agility), `agility: tools-core ${effective.agility}, ours ${ours.stats.agility}`);
    return `Guardian ${effective.maxVelocity} m/s, agility ${effective.agility}`;
  });

  await Check('load_scene builds valid ships and reports the bad one', async () => {
    const result = await call<SceneResult>('load_scene', {
      scene: {
        name: 'verify',
        ships: [
          { id: 'punisher', dna: 'af1_t1:amarrbase:amarr', position: [0, 0, 0] },
          { id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', position: [2500, 0, 0], rotation: [180, 0, 0] },
          { id: 'bogus', dna: 'nosuchhull:amarrbase:amarr', position: [0, 2000, 0] }
        ]
      }
    });
    const byId = Object.fromEntries(result.ships.map((ship) => [ship.id, ship]));
    const good = rendering ? 'ready' : 'validated';
    Expect(byId['punisher'].status === good && byId['rifter'].status === good, JSON.stringify(result.ships));
    Expect(byId['bogus'].status === 'failed' && /hull/iu.test(byId['bogus'].error ?? ''), `bogus: ${JSON.stringify(byId['bogus'])}`);
    return `punisher ${byId['punisher'].status}, rifter ${byId['rifter'].status}, bogus failed: ${byId['bogus'].error}`;
  });

  await Check('Destiny holds ships at their document placement', async () => {
    const state = await call<ViewerState>('get_state');
    const placements: Record<string, number[]> = { punisher: [0, 0, 0], rifter: [2500, 0, 0], bogus: [0, 2000, 0] };
    for (const [id, position] of Object.entries(placements)) {
      const ship = ShipIn(state, id);
      Expect(JSON.stringify(ship.position) === JSON.stringify(position) && ship.speed === 0 && ship.mode === 'stop', `${id}: ${JSON.stringify(ship)}`);
    }
    return `3 balls at rest, tick ${state.simulation.tick}`;
  });

  await Check('ships fly at their Ship-stats numbers', async () => {
    const answer = await call<ShipStatsAnswer>('ship_stats', { dna: 'mf1_t1:minmatarbase:minmatar' }).catch(SkipWithoutSde);
    const physicsOf = async (id: string, done: (physics: ShipPhysicsState) => boolean): Promise<ShipPhysicsState> => {
      let physics = ShipIn(await call<ViewerState>('get_state'), id).physics;
      for (let attempt = 0; attempt < 60 && !(physics && done(physics)); attempt++) {
        await Delay(250);
        physics = ShipIn(await call<ViewerState>('get_state'), id).physics;
      }
      Expect(physics && done(physics), `${id} after 15 s: ${JSON.stringify(physics)}`);
      return physics as ShipPhysicsState;
    };
    const rifter = await physicsOf('rifter', (physics) => physics.source === 'sde');
    const { stats, hull } = answer;
    for (const key of ['mass', 'agility', 'maxVelocity', 'alignTime'] as const) Expect(Close(rifter[key], stats[key]), `${key}: page ${rifter[key]}, ship_stats ${stats[key]}`);
    Expect(rifter.radius === hull.published?.radius && rifter.typeID === hull.typeID, `radius ${rifter.radius} / type ${rifter.typeID} vs ${JSON.stringify(hull)}`);
    const bogus = await physicsOf('bogus', (physics) => physics.source === 'class');
    Expect(/nosuchhull/u.test(bogus.note ?? ''), `bogus note: ${bogus.note}`);
    await call('patch_scene', { operations: [{ op: 'update_ship', id: 'rifter', set: { stats: { maxVelocity: 200 } } }] });
    await physicsOf('rifter', (physics) => physics.maxVelocity === 250);
    await call('patch_scene', { operations: [{ op: 'update_ship', id: 'rifter', set: { stats: null } }] });
    await physicsOf('rifter', (physics) => physics.maxVelocity === stats.maxVelocity);
    return `rifter flies as ${rifter.typeName} (${rifter.typeID}): ${rifter.maxVelocity} m/s, align ${rifter.alignTime.toFixed(2)} s; stats 200 -> 250 m/s; bogus flies class values`;
  });

  await Check('patch_scene moves, removes and renames without rebuilding', async () => {
    const result = await call<SceneResult>('patch_scene', {
      operations: [
        { op: 'update_ship', id: 'rifter', set: { position: [4000, 0, 0] } },
        { op: 'remove_ship', id: 'bogus' },
        { op: 'rename', name: 'verify-2' }
      ]
    });
    const { changes } = result;
    Expect(changes['moved'] === 1 && changes['removed'] === 1 && changes['added'] === 0 && changes['rebuilt'] === 0, JSON.stringify(changes));
    const distance = (await call<ViewerState>('get_state')).distances[0];
    Expect(Math.abs(distance.centreToCentre - 4000) < 300, JSON.stringify(distance));
    return `centre-to-centre ${distance.centreToCentre} m`;
  });

  let stoppingSpeed = 0;
  await Check('order_ship moves a ship through its ball', async () => {
    const ordered = await call<{ id: string; tick: number }>('order_ship', { id: 'rifter', order: { type: 'direction', direction: [0, 0, 1] } });
    Expect(ordered.id === 'rifter', JSON.stringify(ordered));
    let rifter = ShipIn(await call<ViewerState>('get_state'), 'rifter');
    // Orders apply at the next 1 s tick, then the ship accelerates.
    for (let attempt = 0; attempt < 40 && (rifter.position?.[2] ?? 0) <= 100; attempt++) {
      await Delay(250);
      rifter = ShipIn(await call<ViewerState>('get_state'), 'rifter');
    }
    Expect((rifter.position?.[2] ?? 0) > 100, `after 10 s: ${JSON.stringify(rifter)}`);
    Expect(rifter.mode === 'goto' && rifter.position?.[0] === 4000 && (rifter.speed ?? 0) > 0, JSON.stringify(rifter));
    stoppingSpeed = rifter.speed ?? 0;
    return `z ${rifter.position?.[2]} m at ${rifter.speed} m/s`;
  });

  await Check('stop slows it down', async () => {
    await call('order_ship', { id: 'rifter', order: { type: 'stop' } });
    await Delay(3000);
    const rifter = ShipIn(await call<ViewerState>('get_state'), 'rifter');
    Expect(rifter.mode === 'stop' && (rifter.speed ?? Infinity) < stoppingSpeed, `from ${stoppingSpeed} m/s: ${JSON.stringify(rifter)}`);
    return `${stoppingSpeed} m/s down to ${rifter.speed} m/s`;
  });

  await Check('bad orders are refused', async () => {
    const refusal = async (args: Record<string, unknown>): Promise<string> => {
      try {
        await call('order_ship', args);
      } catch (error) {
        return `${ErrorMessage(error)} ${(ErrorProblems(error) ?? []).join(' ')}`;
      }
      throw new Error(`accepted ${JSON.stringify(args)}`);
    };
    const unknown = await refusal({ id: 'nobody', order: { type: 'stop' } });
    Expect(/no ship "nobody"/u.test(unknown), unknown);
    const jump = await refusal({ id: 'rifter', order: { type: 'jump' } });
    Expect(/order\.type must be one of/u.test(jump), jump);
    const nowhere = await refusal({ id: 'rifter', order: { type: 'warp' } });
    Expect(/exactly one of point or target/u.test(nowhere), nowhere);
    const nobody = await refusal({ id: 'rifter', order: { type: 'orbit', target: 'nobody', range: 1000 } });
    Expect(/order\.target "nobody" is not a ship/u.test(nobody), nobody);
    const itself = await refusal({ id: 'rifter', order: { type: 'approach', target: 'rifter' } });
    Expect(/order\.target must be another ship/u.test(itself), itself);
    const rangeless = await refusal({ id: 'rifter', order: { type: 'keep-at-range', target: 'punisher' } });
    Expect(/order\.range must be a number of metres/u.test(rangeless), rangeless);
    return 'unknown ship, an unknown type, a warp with no destination, a missing target, the ship itself and a missing range refused';
  });

  const helpers = new Set(['anchor', 'orbiter', 'keeper', 'chaser', 'goer']);
  try {
    await Check("orbit, keep-at-range, approach and goto fly at the ships' speeds", async () => {
      const frigate = 'mf1_t1:minmatarbase:minmatar';
      const amarr = 'af1_t1:amarrbase:amarr';
      const added = await call<SceneResult>('patch_scene', {
        operations: [
          { op: 'add_ship', ship: { id: 'anchor', dna: amarr, position: [20000, 0, 0] } },
          { op: 'add_ship', ship: { id: 'orbiter', dna: frigate, position: [27000, 0, 0] } },
          { op: 'add_ship', ship: { id: 'keeper', dna: frigate, position: [20000, 0, 6000] } },
          { op: 'add_ship', ship: { id: 'chaser', dna: frigate, position: [14000, 0, 0] } },
          { op: 'add_ship', ship: { id: 'goer', dna: amarr, position: [20000, 0, -3000] } }
        ]
      });
      Expect(added.changes['added'] === 5, JSON.stringify(added.changes));
      const orders: Record<string, ShipOrderState & { mode: string }> = {
        orbiter: { type: 'orbit', target: 'anchor', range: 5000, mode: 'orbit' },
        keeper: { type: 'keep-at-range', target: 'anchor', range: 1500, mode: 'follow' },
        chaser: { type: 'approach', target: 'anchor', mode: 'follow' },
        goer: { type: 'goto', point: [20000, 0, -6000], mode: 'goto' }
      };
      let t0 = 0;
      for (const [id, { mode: _mode, ...order }] of Object.entries(orders)) {
        const { tick } = await call<{ tick: number }>('order_ship', { id, order });
        if (id === 'goer') t0 = tick;
      }
      let orbitHeld = 0;
      let keepHeld = 0;
      let closest = Infinity;
      let chaserTop = 0;
      let alignTicks: Maybe<number> = null;
      let goerArrived = false;
      let last: Record<string, ShipState> = {};
      const done = (): boolean => orbitHeld >= 5 && keepHeld >= 5 && closest < 300 && alignTicks !== null && goerArrived;
      for (let poll = 0; poll < 120 && !done(); poll++) {
        await Delay(500);
        const state = await call<ViewerState>('get_state');
        last = Object.fromEntries(Object.keys(orders).map((id) => [id, ShipIn(state, id)]));
        for (const [id, { mode, ...order }] of Object.entries(orders)) {
          const ship = last[id];
          if (ship.order?.type !== order.type) continue;
          Expect(ship.mode === mode && ship.order.target === order.target && ship.order.range === order.range, `${id}: ${JSON.stringify(ship)}`);
        }
        const { orbiter, keeper, chaser, goer } = last;
        const max = (ship: ShipState): number => ship.physics?.maxVelocity ?? Infinity;
        const orbiting = orbiter.order?.type === 'orbit' && (orbiter.targetDistance ?? 0) >= 5000 && (orbiter.targetDistance ?? Infinity) <= 5600 && (orbiter.speed ?? 0) >= 0.9 * max(orbiter);
        orbitHeld = orbiting ? orbitHeld + 1 : 0;
        keepHeld = keeper.order?.type === 'keep-at-range' && Math.abs((keeper.targetDistance ?? Infinity) - 1500) <= 250 ? keepHeld + 1 : 0;
        if (chaser.order?.type === 'approach') closest = Math.min(closest, chaser.targetDistance ?? Infinity);
        chaserTop = Math.max(chaserTop, chaser.speed ?? 0);
        Expect(chaserTop <= max(chaser) + 0.1, `chaser above its max velocity: ${JSON.stringify(chaser)}`);
        if (alignTicks === null && (goer.speed ?? 0) >= 0.75 * max(goer)) alignTicks = state.simulation.tick - t0;
        const goerPosition = goer.position ?? [0, 0, 0];
        goerArrived = Math.hypot(goerPosition[0] - 20000, goerPosition[1], goerPosition[2] + 6000) < 150 && (goer.speed ?? Infinity) < 10;
      }
      Expect(done(), `after 60 s: orbit held ${orbitHeld}, keep held ${keepHeld}, closest ${closest}, align ${alignTicks}, goer arrived ${goerArrived}: ${JSON.stringify(last)}`);
      const { orbiter, keeper, chaser, goer } = last;
      Expect(chaserTop >= 0.95 * (chaser.physics?.maxVelocity ?? Infinity), `chaser top speed ${chaserTop} of ${chaser.physics?.maxVelocity}`);
      const alignLag = (alignTicks ?? 0) - (goer.physics?.alignTime ?? 0);
      Expect(alignLag >= 0 && alignLag < 1.5, `goer reached 75 % after ${alignTicks} ticks for an align of ${goer.physics?.alignTime} s`);
      return `orbit ${orbiter.targetDistance} m at ${orbiter.speed} m/s, keep ${keeper.targetDistance} m, approach closest ${closest} m (top ${chaserTop} m/s), goto ${goer.speed} m/s at ${JSON.stringify(goer.position)}, align ${alignTicks} ticks for ${goer.physics?.alignTime.toFixed(2)} s`;
    });

    await Check('removing a target stops its followers', async () => {
      const { changes } = await call<SceneResult>('patch_scene', { operations: [{ op: 'remove_ship', id: 'anchor' }] });
      Expect(changes['stopped'] === 3, JSON.stringify(changes));
      const state = await call<ViewerState>('get_state');
      for (const id of ['orbiter', 'keeper', 'chaser']) {
        const ship = ShipIn(state, id);
        Expect(ship.order?.type === 'stop' && ship.mode === 'stop' && /target "anchor" was removed/u.test(ship.orderNote ?? ''), `${id}: ${JSON.stringify(ship)}`);
      }
      const goer = ShipIn(state, 'goer');
      Expect(goer.order?.type === 'goto' && goer.mode === 'goto', `goer: ${JSON.stringify(goer)}`);
      return `orbiter, keeper and chaser stopped: ${ShipIn(state, 'orbiter').orderNote}`;
    });
  } finally {
    const { ships } = await call<{ ships: { id: string }[] }>('get_scene');
    const operations = ships.filter((ship) => helpers.has(ship.id)).map((ship) => ({ op: 'remove_ship', id: ship.id }));
    if (operations.length) await call('patch_scene', { operations });
  }

  try {
    await Check('a ship warps, lands, and refuses orders in warp', async () => {
      const added = await call<SceneResult>('patch_scene', {
        operations: [
          { op: 'add_ship', ship: { id: 'warper', dna: 'mf1_t1:minmatarbase:minmatar', position: [-50000, 0, 0] } },
          { op: 'add_ship', ship: { id: 'beacon', dna: 'af1_t1:amarrbase:amarr', position: [-50000, 0, 700000] } }
        ]
      });
      Expect(added.changes['added'] === 2, JSON.stringify(added.changes));
      await WaitFor('the warper gets its warp speed', 60, (state) => {
        const warper = ShipIn(state, 'warper');
        return warper.physics?.warpSpeed === 5 ? null : JSON.stringify(warper.physics);
      });
      let refused = '';
      try {
        await call('order_ship', { id: 'warper', order: { type: 'warp', point: [-50000, 0, 100000] } });
      } catch (error) {
        refused = ErrorMessage(error);
      }
      Expect(/150 km/u.test(refused), `a 100 km warp: ${refused || 'accepted'}`);

      const point: [number, number, number] = [-50000, 0, 300000];
      // Its MWD runs as it aligns; entering warp switches it off.
      await call('switch_prop_mods', { ships: ['warper'], active: true });
      await WaitFor("the warper's MWD runs", 5, (state) => (ShipIn(state, 'warper').propMod?.state === 'active' ? null : JSON.stringify(ShipIn(state, 'warper').propMod)));
      await call('order_ship', { id: 'warper', order: { type: 'warp', point } });
      let propModInWarp: Maybe<ShipPropModState> = null;
      const phases: string[] = [];
      let topSpeed = 0;
      let progress = 0;
      let refusedInWarp = '';
      let peakGlow = 0;
      let warper = ShipIn(await call<ViewerState>('get_state'), 'warper');
      for (let poll = 0; poll < 120 && warper.warp?.phase !== 'landed'; poll++) {
        await Delay(500);
        warper = ShipIn(await call<ViewerState>('get_state'), 'warper');
        const warp = warper.warp;
        if (!warp) continue;
        if (phases.at(-1) !== warp.phase) phases.push(warp.phase);
        if (warp.phase === 'warping' && !propModInWarp) propModInWarp = warper.propMod;
        topSpeed = Math.max(topSpeed, warper.speed ?? 0);
        peakGlow = Math.max(peakGlow, warper.boosters?.warpIntensity ?? 0);
        if (warp.phase !== 'landed') Expect(warper.mode === 'warp', `mode in ${warp.phase}: ${JSON.stringify(warper)}`);
        Expect(warp.progress >= progress, `progress fell from ${progress}: ${JSON.stringify(warp)}`);
        progress = warp.progress;
        if ((warp.phase === 'warping' || warp.phase === 'exiting') && !refusedInWarp) {
          try {
            await call('order_ship', { id: 'warper', order: { type: 'stop' } });
            refusedInWarp = 'accepted';
          } catch (error) {
            refusedInWarp = ErrorMessage(error);
          }
        }
      }
      Expect(warper.warp?.phase === 'landed' && warper.mode === 'stop', `after 60 s: ${JSON.stringify(warper)}`);
      const order = ['aligning', 'warping', 'exiting', 'landed'];
      Expect(
        phases.every((phase, index) => index === 0 || order.indexOf(phase) > order.indexOf(phases[index - 1])),
        `phases ${phases.join(', ')}`
      );
      Expect(/is in warp/u.test(refusedInWarp), `a stop in warp: ${refusedInWarp || 'never tried'}`);
      Expect(propModInWarp?.state === 'off' && /entered warp/u.test(propModInWarp.note ?? ''), `the MWD in warp: ${JSON.stringify(propModInWarp)}`);
      Expect(warper.propMod?.state === 'off', `the MWD after landing: ${JSON.stringify(warper.propMod)}`);
      Expect(topSpeed > 10_000, `top speed ${topSpeed} m/s`);
      const landing = warper.warp?.landing ?? [Infinity, 0, 0];
      const gap = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      Expect(gap(landing, point) < 1 && gap(warper.position ?? [0, 0, 0], landing) < 2000, JSON.stringify(warper));

      await call('order_ship', { id: 'warper', order: { type: 'warp', target: 'beacon', range: 10000 } });
      const landed = await WaitFor('the warp to the beacon lands', 60, (state) => {
        const ship = ShipIn(state, 'warper');
        return ship.order?.type === 'warp' && ship.order.target === 'beacon' && ship.warp?.phase === 'landed' ? null : JSON.stringify(ship.warp ?? ship.order);
      });
      const beaconShip = ShipIn(landed, 'beacon');
      const onBeacon = ShipIn(landed, 'warper');
      const radii = (onBeacon.physics?.radius ?? 0) + (beaconShip.physics?.radius ?? 0);
      const range = gap(onBeacon.warp?.landing ?? [0, 0, 0], beaconShip.position ?? [0, 0, 0]) - radii;
      Expect(Math.abs(range - 10000) <= 1 && gap(onBeacon.position ?? [0, 0, 0], onBeacon.warp?.landing ?? [0, 0, 0]) < 2000, `range ${range}: ${JSON.stringify(onBeacon)}`);
      let boosters = 'no renderer';
      if (landed.renderer.available) {
        Expect(onBeacon.boosters?.maxVel === onBeacon.physics?.maxVelocity && peakGlow > 0.5, `boosters ${JSON.stringify(onBeacon.boosters)}, peak warp glow ${peakGlow}`);
        boosters = `peak warp glow ${peakGlow}`;
      }
      return `phases ${phases.join(' → ')}, top ${Math.round(topSpeed / 1000)} km/s, landed ${Math.round(gap(warper.position ?? [0, 0, 0], landing))} m from the point; ${Math.round(range)} m off the beacon; refused in warp: ${refusedInWarp}; MWD ${propModInWarp?.note}; ${boosters}`;
    });
  } finally {
    const { ships } = await call<{ ships: { id: string }[] }>('get_scene');
    const operations = ships.filter((ship) => ship.id === 'warper' || ship.id === 'beacon').map((ship) => ({ op: 'remove_ship', id: ship.id }));
    if (operations.length) await call('patch_scene', { operations });
  }

  const propModHelpers = new Set(['mwd-tfi', 'ab-guardian', 'audio-probe-tfi']);
  try {
    await Check("switch_prop_mods runs a ship's MWD at its module's numbers", async () => {
      await call('patch_scene', {
        operations: [
          { op: 'add_ship', ship: { id: 'mwd-tfi', dna: TFI_DNA, position: [0, 0, -60000] } },
          { op: 'add_ship', ship: { id: 'ab-guardian', dna: GUARDIAN_DNA, position: [3000, 0, -60000], propMod: '10MN Afterburner II' } }
        ]
      });
      const answer = await call<ShipStatsAnswer>('ship_stats', { dna: TFI_DNA, propMod: 'mwd' }).catch(SkipWithoutSde);
      const running = answer.withPropMod;
      if (!running) throw new Error('ship_stats gave no MWD numbers');
      await WaitFor('mwd-tfi flies its SDE hull and module', 60, (state) => {
        const ship = ShipIn(state, 'mwd-tfi');
        return ship.physics?.source === 'sde' && ship.propMod?.source === 'sde' ? null : JSON.stringify({ physics: ship.physics?.source, propMod: ship.propMod });
      });
      const on = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['mwd-tfi'], active: true });
      Expect(on.active && on.ships[0]?.id === 'mwd-tfi' && on.ships[0].state === 'activating' && on.ships[0].at !== undefined && !on.skipped.length, JSON.stringify(on));
      const active = await WaitFor('the MWD active', 4, (state) => (ShipIn(state, 'mwd-tfi').propMod?.state === 'active' ? null : JSON.stringify(ShipIn(state, 'mwd-tfi').propMod)));
      const tfi = ShipIn(active, 'mwd-tfi');
      const physics = tfi.physics;
      if (!physics) throw new Error('mwd-tfi reports no physics');
      Expect(tfi.propMod?.typeID === 12084 && tfi.propMod.cycleTime === 10, JSON.stringify(tfi.propMod));
      Expect(Close(physics.maxVelocity, running.maxVelocity) && Close(physics.signatureRadius, running.signatureRadius) && Close(physics.mass, running.mass), `page ${JSON.stringify(physics)}, ship_stats ${JSON.stringify(running)}`);
      await call('order_ship', { id: 'mwd-tfi', order: { type: 'direction', direction: [0, 0, -1] } });
      const fast = await WaitFor('mwd-tfi past twice its base speed', 20, (state) => ((ShipIn(state, 'mwd-tfi').speed ?? 0) > 2 * answer.stats.maxVelocity ? null : `${ShipIn(state, 'mwd-tfi').speed} m/s`));
      const off = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['mwd-tfi'], active: false });
      const stopsIn = off.ships[0]?.stopsIn ?? Infinity;
      Expect(off.ships[0]?.state === 'stopping' && stopsIn <= 10, JSON.stringify(off));
      const stopped = await WaitFor('the MWD off at the end of its cycle', 12, (state) => (ShipIn(state, 'mwd-tfi').propMod?.state === 'off' ? null : JSON.stringify(ShipIn(state, 'mwd-tfi').propMod)));
      const peak = ShipIn(stopped, 'mwd-tfi').speed ?? 0;
      Expect(Close(ShipIn(stopped, 'mwd-tfi').physics?.maxVelocity ?? 0, answer.stats.maxVelocity), `physics after: ${JSON.stringify(ShipIn(stopped, 'mwd-tfi').physics)}`);
      const slowing = await WaitFor('mwd-tfi slowing toward its base speed', 10, (state) => ((ShipIn(state, 'mwd-tfi').speed ?? Infinity) < peak - 50 ? null : `${ShipIn(state, 'mwd-tfi').speed} m/s from ${peak}`));
      await call('order_ship', { id: 'mwd-tfi', order: { type: 'stop' } });
      return `${tfi.propMod?.name}: ${physics.maxVelocity.toFixed(2)} m/s, sig ${physics.signatureRadius} m; ${ShipIn(fast, 'mwd-tfi').speed} m/s; stopping in ${stopsIn} s, then ${peak} -> ${ShipIn(slowing, 'mwd-tfi').speed} m/s`;
    });

    await Check('set_prop_mods sets the start state', async () => {
      const set = await call<SceneResult>('patch_scene', { operations: [{ op: 'set_prop_mods', ships: ['ab-guardian'], active: true }] });
      Expect(set.changes['switched'] === 1, JSON.stringify(set.changes));
      const scene = await call<{ ships: { id: string; propMod?: unknown }[] }>('get_scene');
      const doc = scene.ships.find((ship) => ship.id === 'ab-guardian');
      Expect(JSON.stringify(doc?.propMod) === JSON.stringify({ module: '10MN Afterburner II', active: true }), JSON.stringify(doc));
      Expect(ShipIn(await call<ViewerState>('get_state'), 'ab-guardian').propMod?.state === 'active', 'not active at once');
      await call('load_scene', { scene });
      const loaded = ShipIn(await call<ViewerState>('get_state'), 'ab-guardian').propMod;
      Expect(loaded?.state === 'active' && ShipIn(await call<ViewerState>('get_state'), 'mwd-tfi').propMod?.state === 'off', JSON.stringify(loaded));
      return `ab-guardian's ${loaded?.name ?? '10MN Afterburner II'} active at once and after a load`;
    });

    await Check('prop mod audio posts the engine stems', async () => {
      const ready = await WaitFor('the audio settles', 90, (state) => (state.audio && state.audio.state !== 'loading' ? null : JSON.stringify(state.audio)));
      const audio = ready.audio as AudioState;
      const why = audio.error ? ` (${audio.error})` : '';
      results.push(`info  audio: ${audio.state}${why}`);
      Expect(audio.state !== 'on' || audio.context === 'running', `audio on with its AudioContext ${audio.context}`);
      await call('switch_prop_mods', { ships: ['mwd-tfi'], active: true });
      await WaitFor('the MWD active', 4, (state) => (ShipIn(state, 'mwd-tfi').propMod?.state === 'active' ? null : JSON.stringify(ShipIn(state, 'mwd-tfi').propMod)));
      await call('switch_prop_mods', { ships: ['mwd-tfi'], active: false });
      const after = await WaitFor('the MWD off', 12, (state) => (ShipIn(state, 'mwd-tfi').propMod?.state === 'off' ? null : JSON.stringify(ShipIn(state, 'mwd-tfi').propMod)));
      const posted = (after.audio?.posted ?? []).filter((entry) => entry.ship === 'mwd-tfi').slice(-2);
      const stem = 'ship_engine_L_microwarpdrive_3rd';
      Expect(JSON.stringify(posted.map((entry) => entry.event)) === JSON.stringify([`${stem}_activate`, `${stem}_powerdown`]), JSON.stringify(after.audio));
      const on = audio.state === 'on';
      Expect(
        posted.every((entry) => entry.played === on),
        `played with audio ${audio.state}: ${JSON.stringify(posted)}`
      );
      const played = on ? 'played' : `audio ${audio.state}, recorded unplayed`;
      return `${posted.map((entry) => entry.event).join(', ')} (${played}); ${after.audio?.frameErrors ?? 0} audio frames failed in the runtime, ${after.audio?.rescheduled ?? 0} voices rescheduled, ${after.audio?.backendErrors ?? 0} backend calls contained`;
    });

    await Check("SOF ships' own audio emitters stay inert", async () => {
      const before = await call<ViewerState>('get_state');
      if (before.audio?.state !== 'on') throw new Skipped(`audio ${before.audio?.state ?? 'unreported'}`);
      if (!before.renderer.available) throw new Skipped('no renderer, so no ship hydrates');
      // The listener and the page's own emitters are the only audio game objects the page means to register.
      const beyond = (state: ViewerState) => (state.audio?.gameObjects ?? 0) - (state.audio?.emitters ?? 0);
      const baseline = beyond(before);
      await call('patch_scene', { operations: [{ op: 'add_ship', ship: { id: 'audio-probe-tfi', dna: TFI_DNA, position: [-3000, 0, -60000] } }] });
      const built = await WaitFor('audio-probe-tfi built', 60, (state) => (ShipIn(state, 'audio-probe-tfi').status === 'ready' ? null : `${ShipIn(state, 'audio-probe-tfi').status}`));
      Expect(beyond(built) === baseline && !built.audio?.foreign, `audio game objects beyond the page's emitters went ${baseline} -> ${beyond(built)} with a TFI build: ${JSON.stringify(built.audio)}`);
      return `${built.audio?.gameObjects} audio game objects for ${built.audio?.emitters} page emitter(s), unchanged by a TFI build`;
    });
  } finally {
    const { ships } = await call<{ ships: { id: string }[] }>('get_scene');
    const operations = ships.filter((ship) => propModHelpers.has(ship.id)).map((ship) => ({ op: 'remove_ship', id: ship.id }));
    if (operations.length) await call('patch_scene', { operations });
  }

  await Check('an invalid patch is refused with its problems', async () => {
    let refused: unknown = null;
    try {
      await call('patch_scene', { operations: [{ op: 'update_ship', id: 'nobody', set: {} }] });
    } catch (error) {
      refused = error;
    }
    Expect(refused, 'the patch was accepted');
    Expect(/no ship "nobody"/u.test(`${ErrorMessage(refused)} ${(ErrorProblems(refused) ?? []).join(' ')}`), ErrorMessage(refused));
    return 'refused';
  });

  // The fleet stays in the scene, so the save checks below prove it survives both stores.
  await Check('get_state reports fleet membership and the fleet tree', async () => {
    const fleet = { id: 'verify-fleet', commander: 'punisher', wings: [{ id: 'wing-1', squads: [{ id: 'dps', role: 'dps', members: ['rifter'] }] }] };
    const { changes } = await call<SceneResult>('patch_scene', { operations: [{ op: 'add_fleet', fleet }] });
    Expect(changes['regrouped'] === 2 && changes['moved'] === 0 && changes['rebuilt'] === 0 && changes['added'] === 0, JSON.stringify(changes));
    const state = await call<ViewerState>('get_state');
    const byId = Object.fromEntries(state.ships.map((ship) => [ship.id, ship]));
    const rifter = byId['rifter'];
    const punisher = byId['punisher'];
    const expected = { fleet: 'verify-fleet', wing: 'wing-1', squad: 'dps', role: 'dps', commands: [], anchor: { ship: 'punisher', range: 1000 } };
    const actual = { fleet: rifter.fleet, wing: rifter.wing, squad: rifter.squad, role: rifter.role, commands: rifter.commands, anchor: rifter.anchor };
    Expect(JSON.stringify(actual) === JSON.stringify(expected), `rifter: ${JSON.stringify(rifter)}`);
    Expect(JSON.stringify(punisher.commands) === '["fleet"]' && punisher.squad === null && punisher.anchor === null, `punisher: ${JSON.stringify(punisher)}`);
    const anchor = state.fleets[0]?.wings[0]?.squads[0]?.anchor;
    Expect(JSON.stringify(anchor) === JSON.stringify({ ship: 'punisher', range: 1000 }), `fleets: ${JSON.stringify(state.fleets)}`);
    const reanchored = await call<SceneResult>('patch_scene', { operations: [{ op: 'set_anchor', fleet: 'verify-fleet', squad: 'dps', anchor: { range: 2500 } }] });
    Expect(reanchored.changes['regrouped'] === 1, JSON.stringify(reanchored.changes));
    return 'rifter anchors on punisher at 2500 m';
  });

  await Check('save, list, open and delete round-trip through IndexedDB', async () => {
    await call('save_scene', { name: 'verify-saved', store: 'browser' });
    Expect(
      (await call<SceneListing>('list_scenes')).scenes.some((entry) => entry.name === 'verify-saved' && entry.store === 'browser'),
      'not listed'
    );
    await call('load_scene', { scene: { name: 'empty', ships: [] } });
    const opened = await call<SceneResult & { store: string }>('open_scene', { name: 'verify-saved' });
    Expect(opened.store === 'browser', `opened from ${opened.store}`);
    Expect(opened.scene.ships.length === 2, `opened ${opened.scene.ships.length} ships`);
    Expect(opened.scene.fleets?.length === 1, `opened ${opened.scene.fleets?.length ?? 0} fleets`);
    Expect((await call<{ deleted: boolean }>('delete_scene', { name: 'verify-saved', store: 'browser' })).deleted, 'not deleted');
  });

  await Check('save, list, open and delete round-trip through scene files', async () => {
    const saved = await call<{ file: string; ships: number }>('save_scene', { name: 'verify-saved-disk' });
    Expect(saved.ships === 2, `saved ${saved.ships} ships`);
    Expect(
      (await call<SceneListing>('list_scenes', { store: 'disk' })).scenes.some((entry) => entry.name === 'verify-saved-disk'),
      'not listed'
    );
    await call('load_scene', { scene: { name: 'empty', ships: [] } });
    const opened = await call<SceneResult & { store: string }>('open_scene', { name: 'verify-saved-disk' });
    Expect(opened.store === 'disk' && opened.scene.ships.length === 2, `opened ${opened.scene.ships.length} ships from ${opened.store}`);
    Expect(opened.scene.fleets?.length === 1, `opened ${opened.scene.fleets?.length ?? 0} fleets from disk`);
    Expect((await call<{ deleted: boolean }>('delete_scene', { name: 'verify-saved-disk' })).deleted, 'not deleted');
    // The reload check below expects the IndexedDB check's scene back.
    await call('load_scene', { scene: { ...opened.scene, name: 'verify-saved' } });
    return saved.file;
  });

  await Check('the working scene survives a reload', async () => {
    await page.reload();
    let restored = false;
    for (let attempt = 0; attempt < 100 && !restored; attempt++) {
      const tabs = (await call<ViewerStatus>('viewer_status')).connectedTabs;
      const scene = tabs ? await call<Maybe<{ name: string }>>('get_scene').catch(() => null) : null;
      restored = scene?.name === 'verify-saved';
      if (!restored) await Delay(200);
    }
    Expect(restored, 'the reloaded tab did not restore verify-saved');
    return 'restored';
  });

  await Check("the dogma path matches tools-core's evaluation on a bare hull", async () => {
    await call<ShipStatsAnswer>('ship_stats', { type: 587 }).catch(SkipWithoutSde);
    await call('load_scene', { scene: { name: 'verify-fit', ships: [{ id: 'bare', dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter', fit: '[Rifter, Bare]' }] } });
    const state = await WaitFor("the bare Rifter's fit resolves", 60, (polled) => {
      const fit = ShipIn(polled, 'bare').fit;
      return fit?.math === 'dogma' ? null : JSON.stringify(fit);
    });
    const { defense, capacitor } = ShipIn(state, 'bare');
    if (!defense || !capacitor) throw new Error(`no defense or capacitor: ${JSON.stringify({ defense, capacitor })}`);
    // Shield, Armor and Hull Upgrades, Mechanics, Capacitor Management and Operation at V: the skills these sections use.
    const skills = [3419, 3394, 3392, 3416, 3418, 3417].map((typeID) => ({ typeID, level: 5 }));
    const response = await fetch(`${toolsCore.url}/eve/${status.build}/dogma/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ typeID: 587, profile: { mode: 'manual', skills }, sections: ['defense', 'capacitor'] }) });
    Expect(response.ok, `dogma/evaluate answered ${response.status}`);
    const { effective } = (await response.json()) as { effective: Record<string, number> };
    const pairs: [string, number, number][] = [
      ['shield hp', effective['shieldCapacity'], defense.shield.max],
      ['armor hp', effective['armorHP'], defense.armor.max],
      ['structure hp', effective['hp'], defense.structure.max],
      ['capacitor', effective['capacitorCapacity'], capacitor.capacity],
      ['capacitor recharge', effective['rechargeRate'] / 1000, capacitor.rechargeTime],
      ['shield recharge', effective['shieldRechargeRate'] / 1000, defense.shieldRecharge]
    ];
    const layers = { shield: 'shield', armor: 'armor', structure: '' } as const;
    for (const [layer, prefix] of Object.entries(layers) as [keyof typeof layers, string][]) {
      for (const type of ['em', 'thermal', 'kinetic', 'explosive'] as const) {
        const name = `${prefix}${prefix ? type[0].toUpperCase() + type.slice(1) : type}DamageResonance`;
        pairs.push([`${layer} ${type} resist`, Math.round((1 - effective[name]) * 10_000) / 100, defense[layer].resists[type]]);
      }
    }
    const off = pairs.filter(([, theirs, ours]) => !Close(theirs, ours));
    Expect(!off.length, off.map(([what, theirs, ours]) => `${what}: tools-core ${theirs}, ours ${ours}`).join('; '));
    return `Rifter ${defense.shield.max} / ${defense.armor.max} / ${defense.structure.max} HP, capacitor ${capacitor.capacity} GJ in ${capacitor.rechargeTime} s: ${pairs.length} values match`;
  });

  await Check('an unfitted ship gets default guns sized for its hull and race', async () => {
    const answer = await call<ShipStatsAnswer>('ship_stats', { dna: 'mf1_t1:minmatarbase:minmatar' }).catch(SkipWithoutSde);
    const ships = [
      { id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', position: [0, 0, 0] },
      { id: 'punisher', dna: 'af1_t1:amarrbase:amarr', type: 'Punisher', position: [2500, 0, 0] }
    ];
    await call('load_scene', { scene: { name: 'verify-default-guns', ships } });
    const state = await WaitFor('both default fits resolve', 60, (polled) => {
      const pending = ships.map((ship) => ShipIn(polled, ship.id)).find((ship) => ship.fit?.math !== 'dogma');
      return pending ? `${pending.id}: ${JSON.stringify(pending.fit?.note ?? pending.fitNote ?? pending.fit)}` : null;
    });
    const expected = { rifter: ['200mm AutoCannon II', 'EMP S', 3], punisher: ['Small Focused Pulse Laser II', 'Multifrequency S', 4] } as const;
    for (const [id, [gun, charge, count]] of Object.entries(expected)) {
      const fit = ShipIn(state, id).fit;
      const highs = fit?.modules.filter((module) => module.module.startsWith('high-')) ?? [];
      const keys = Array.from({ length: count }, (_unused, index) => `high-${index}`);
      Expect(fit?.key === 'default' && fit.default === true, `${id} fit: ${JSON.stringify(fit && { key: fit.key, default: fit.default })}`);
      Expect(highs.map((module) => module.module).join() === keys.join() && highs.every((module) => module.name === gun && module.charge === charge), `${id} highs: ${JSON.stringify(highs)}`);
      Expect(
        fit?.modules.some((module) => module.module === 'mid-0' && module.prop),
        `${id} has no mid-0 prop row: ${JSON.stringify(fit?.modules)}`
      );
    }
    const rifter = ShipIn(state, 'rifter').physics;
    for (const key of ['mass', 'agility', 'maxVelocity', 'alignTime', 'signatureRadius'] as const) Expect(rifter && Close(rifter[key], answer.stats[key]), `${key}: page ${rifter?.[key]}, ship_stats ${answer.stats[key]}`);
    return `rifter 3 x 200mm AutoCannon II (EMP S), punisher 4 x Small Focused Pulse Laser II (Multifrequency S), both on dogma with a mid-0 prop row; the rifter flies ship_stats' ${rifter?.maxVelocity} m/s`;
  });

  // Turrets: a default-gunned Rifter with Punishers at 5 km, 6 km and 150 km, a Caracal (default launchers) and,
  // per check, an Astrahus. Each check loads the scene itself, so --only runs any one.
  const TURRET_GUN = '200mm AutoCannon II';
  const TURRET_SCENE = {
    name: 'verify-turrets',
    ships: [
      // The type pins ship_stats' Rifter: a DNA-only ship flies the lowest type id on its hull (mf1_t1 is the Slasher).
      { id: 'rifter', dna: 'mf4_t1:minmatarbase:minmatar', type: 'Rifter', position: [0, 0, 0] },
      { id: 'punisher', dna: 'af1_t1:amarrbase:amarr', type: 'Punisher', position: [5000, 0, 0] },
      { id: 'punisher-2', dna: 'af1_t1:amarrbase:amarr', type: 'Punisher', position: [0, 0, -6000] },
      { id: 'far', dna: 'af1_t1:amarrbase:amarr', type: 'Punisher', position: [150000, 0, 0] }
    ]
  };
  const Guns = (state: ViewerState, id = 'rifter'): ShipModuleRowState[] => ShipIn(state, id).fit?.modules.filter((module) => module.name === TURRET_GUN) ?? [];
  const Shots = (state: ViewerState, id = 'rifter'): number => ShipIn(state, id).shots ?? 0;
  let turretGunTime = Number.NaN;
  const LoadTurretScene = async (caracal = false): Promise<ViewerState> => {
    const fit = ['[Rifter, Guns]', '[Empty Low slot]', '', '[Empty Med slot]', '', ...Array.from({ length: 3 }, () => `${TURRET_GUN}, EMP S`)].join('\n');
    const stats = await call<ShipStatsAnswer>('ship_stats', { type: 'Rifter', fit }).catch(SkipWithoutSde);
    turretGunTime = stats.fit?.modules.find((module) => module.key === 'high-0')?.cycleTime ?? Number.NaN;
    Expect(turretGunTime > 0, `ship_stats has no cycleTime for high-0: ${JSON.stringify(stats.fit?.modules)}`);
    await call('load_scene', { scene: TURRET_SCENE });
    if (caracal) await call<AddShipsResult>('add_ships', { hull: 'Caracal', count: 1, near: { ship: 'rifter', range: 4000 } });
    const ids = [...TURRET_SCENE.ships.map((ship) => ship.id), ...(caracal ? ['caracal-01'] : [])];
    return WaitFor('the turret scene resolves its default fits', 60, (polled) => {
      const pending = ids.map((id) => ShipIn(polled, id)).find((ship) => ship.fit?.math !== 'dogma');
      return pending ? `${pending.id}: ${JSON.stringify(pending.fit?.note ?? pending.fitNote ?? pending.fit)}` : null;
    });
  };
  const GunsRun = (target: string, seconds = 10): Promise<ViewerState> =>
    WaitFor(`the guns run on ${target}`, seconds, (polled) => {
      const guns = Guns(polled);
      return guns.length === 3 && guns.every((gun) => gun.state === 'active' && gun.target === target && !gun.nextTarget) ? null : JSON.stringify(guns);
    });
  const GunsStopped = (why: RegExp, seconds = 10): Promise<ViewerState> =>
    WaitFor(`the guns stop (${why.source})`, seconds, (polled) => {
      const guns = Guns(polled);
      return guns.every((gun) => (gun.state === 'online' || gun.state === 'reactivating') && why.test(gun.note ?? '')) ? null : JSON.stringify(guns);
    });

  await Check('set_target aims and switch_modules fires turrets on their cycle', async () => {
    await LoadTurretScene();
    const set = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'punisher' });
    const [setShip] = set.ships;
    Expect(set.ships.length === 1 && setShip.target === 'punisher' && setShip.turrets === 3 && setShip.retargeted === 0 && setShip.lock?.state === 'waiting' && !set.skipped.length, JSON.stringify(set));
    const target = ShipIn(await call<ViewerState>('get_state'), 'rifter').target;
    Expect(target?.id === 'punisher' && target.kind === 'ship' && (target.distance ?? 0) > 4000 && (target.distance ?? 0) < 5000, JSON.stringify(target));
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active' });
    const switched = on.ships[0]?.modules ?? [];
    Expect(switched.map((module) => module.module).join() === 'high-0,high-1,high-2' && switched.every((module) => module.state === 'activating' && module.target === 'punisher') && !on.skipped.length, JSON.stringify(on));
    const first = await GunsRun('punisher');
    for (const gun of Guns(first)) Expect(Math.abs((gun.cycleTime ?? 0) - turretGunTime) <= 0.01, `cycleTime ${gun.cycleTime}, ship_stats ${turretGunTime}`);
    const [shots0, t0] = [Shots(first), first.simulation.seconds];
    const later = await WaitFor('12 s of fire', 30, (polled) => (polled.simulation.seconds >= t0 + 12 ? null : `${polled.simulation.seconds} s`));
    const [fired, elapsed] = [Shots(later) - shots0, later.simulation.seconds - t0];
    const expected = (3 * elapsed) / turretGunTime;
    Expect(Math.abs(fired - expected) <= 4, `${fired} shots in ${elapsed} s, expected about ${expected.toFixed(1)}`);
    const off = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'online' });
    Expect(
      off.ships[0]?.modules.every((module) => module.state === 'stopping' || module.state === 'online'),
      JSON.stringify(off)
    );
    const stopped = await GunsStopped(/.*/u);
    const after = Shots(stopped);
    const idle = await WaitFor('3 s with the guns stopped', 15, (polled) => (polled.simulation.seconds >= stopped.simulation.seconds + 3 ? null : `${polled.simulation.seconds} s`));
    Expect(Shots(idle) === after, `shots ${after} -> ${Shots(idle)} after the stop`);
    return `3 x ${TURRET_GUN} at ${turretGunTime} s a cycle (ship_stats' number): ${fired} shots in ${elapsed.toFixed(1)} s (expected ${expected.toFixed(1)}), none after the stop`;
  });

  await Check('weapons follow a new target and stop when it is cleared', async () => {
    await LoadTurretScene();
    await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'punisher' });
    await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active' });
    await GunsRun('punisher');
    const moved = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'punisher-2' });
    Expect(moved.ships[0]?.previous === 'punisher' && moved.ships[0].retargeted === 3, JSON.stringify(moved));
    // The retarget lands at the first cycle start once punisher-2 is locked.
    const retargeted = await GunsRun('punisher-2', 10);
    const cleared = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: null });
    Expect(cleared.ships[0]?.target === null && cleared.ships[0].previous === 'punisher-2', JSON.stringify(cleared));
    const stopped = await GunsStopped(/its target was cleared/u);
    Expect(ShipIn(stopped, 'rifter').target === null, JSON.stringify(ShipIn(stopped, 'rifter').target));
    return `retargeted onto punisher-2 at the first cycle once locked (${Shots(retargeted)} shots by then), stopped at the cycle end once cleared`;
  });

  await Check('a removed or warping target clears and stops the guns', async () => {
    await LoadTurretScene();
    await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active', target: 'punisher' });
    await GunsRun('punisher');
    await call('patch_scene', { operations: [{ op: 'remove_ship', id: 'punisher' }] });
    const gone = await GunsStopped(/its target is gone/u);
    Expect(ShipIn(gone, 'rifter').target === null, JSON.stringify(ShipIn(gone, 'rifter').target));
    await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active', target: 'punisher-2' });
    await GunsRun('punisher-2');
    await call('order_ship', { id: 'punisher-2', order: { type: 'warp', point: [0, 0, -3000000] } });
    const warped = await GunsStopped(/its target entered warp/u, 40);
    Expect(ShipIn(warped, 'rifter').target === null, JSON.stringify(ShipIn(warped, 'rifter').target));
    return 'removing the target stopped the guns at once; its warp broke the target and stopped them';
  });

  await Check('turrets fire at an object', async () => {
    await LoadTurretScene();
    await call<AddObjectsResult>('add_objects', { objects: [{ type: 'Astrahus', id: 'astra', near: { ship: 'rifter', range: 20000 } }] });
    const set = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'astra' });
    Expect(set.ships[0]?.target === 'astra', JSON.stringify(set));
    const target = ShipIn(await call<ViewerState>('get_state'), 'rifter').target;
    Expect(target?.kind === 'object' && Math.abs((target.distance ?? 0) - 20000) <= 100, JSON.stringify(target));
    await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active' });
    const firing = await WaitFor('shots at the Astrahus', 10, (polled) => (Shots(polled) >= 3 && Guns(polled).every((gun) => gun.target === 'astra') ? null : JSON.stringify({ shots: Shots(polled), guns: Guns(polled) })));
    const celestial = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'celestial:60003760' }).then(
      () => 'accepted',
      (error: unknown) => ErrorMessage(error)
    );
    Expect(/cannot be targeted yet/u.test(celestial), celestial);
    return `${Shots(firing)} shots at the Astrahus ${target?.distance} m off (surface to surface); a celestial is refused`;
  });

  await Check('turrets are not refused by range: they wait for the lock', async () => {
    await LoadTurretScene();
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active', target: 'far' });
    Expect(on.ships[0]?.modules.length === 3 && !on.skipped.length, JSON.stringify(on));
    const waiting = await WaitFor('the guns wait out of targeting range', 10, (polled) => {
      const guns = Guns(polled);
      return guns.length === 3 && guns.every((gun) => gun.state === 'activating' && /out of targeting range/u.test(gun.note ?? '')) ? null : JSON.stringify(guns);
    });
    const target = ShipIn(waiting, 'rifter').target;
    Expect(target?.id === 'far' && (target.distance ?? 0) > 149000, JSON.stringify(target));
    Expect(
      Guns(waiting).every((gun) => (gun.effectiveness ?? 1) < 0.001),
      JSON.stringify(Guns(waiting))
    );
    Expect(Shots(waiting) === 0, `${Shots(waiting)} shots before a lock`);
    return `not refused at ${target?.distance} m: the guns wait with "${Guns(waiting)[0]?.note}" (effectiveness ${Guns(waiting)[0]?.effectiveness})`;
  });

  await Check('turret sounds post with the shots', async () => {
    await LoadTurretScene();
    const beyond = (state: ViewerState) => (state.audio?.gameObjects ?? 0) - (state.audio?.emitters ?? 0);
    const before = await WaitFor('the audio settles', 90, (state) => (state.audio && state.audio.state !== 'loading' ? null : JSON.stringify(state.audio)));
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active', target: 'punisher' });
    // Firing first: its sounds post once the guns' files have loaded, and every later sound needs them too.
    const Posts = (state: ViewerState, since: number, ship: string, pattern: RegExp) => (state.audio?.posted ?? []).filter((entry) => entry.tick >= since && entry.ship === ship && pattern.test(entry.event));
    const fired = await WaitFor('the firing and impact sounds post', 20, (polled) => (Posts(polled, on.tick, 'rifter', /^ship_turret_/u).length && Posts(polled, on.tick, 'punisher', /^ship_impact_/u).length ? null : JSON.stringify(polled.audio?.posted)));
    const retarget = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'punisher-2' });
    const deployed = await WaitFor('the deploy sound posts', 5, (polled) => (Posts(polled, retarget.tick, 'rifter', /^turret_move_\w+_out_/u).length ? null : JSON.stringify(polled.audio?.posted)));
    const clear = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: null });
    const packed = await WaitFor('the pack sound posts', 5, (polled) => (Posts(polled, clear.tick, 'rifter', /^turret_move_\w+_in_/u).length ? null : JSON.stringify(polled.audio?.posted)));
    const heard = [...Posts(fired, on.tick, 'rifter', /^ship_turret_/u).slice(0, 1), ...Posts(fired, on.tick, 'punisher', /^ship_impact_/u).slice(0, 1), ...Posts(deployed, retarget.tick, 'rifter', /^turret_move_\w+_out_/u).slice(0, 1), ...Posts(packed, clear.tick, 'rifter', /^turret_move_\w+_in_/u).slice(0, 1)];
    const audio = packed.audio;
    const played = audio?.state === 'on';
    // The firing and impact media are Wwise PTADPCM, which the runtime cannot decode yet: once learned, they are recorded
    // undecodable and not sent. The movement sounds decode.
    const [fire, impact, deploy, pack] = heard;
    Expect(
      [fire, impact].every((entry) => entry.played === played || entry.undecodable === true),
      `firing and impact with audio ${audio?.state}: ${JSON.stringify([fire, impact])}`
    );
    Expect(
      [deploy, pack].every((entry) => entry.played === played),
      `deploy and pack with audio ${audio?.state}: ${JSON.stringify([deploy, pack])}`
    );
    // The sets and their effects hydrate with their own audio cut: only the page's emitters register.
    Expect(beyond(packed) === beyond(before), `audio game objects beyond the page's emitters went ${beyond(before)} -> ${beyond(packed)} with the guns firing: ${JSON.stringify(audio)}`);
    const undecodable = (audio?.undecodable ?? []).filter((event) => /^ship_(turret|impact)_/u.test(event));
    const posts = heard.map((entry) => entry.event + ' on ' + entry.ship).join(', ');
    const outcome = played ? 'played' : 'audio ' + String(audio?.state) + ', recorded unplayed';
    const unsent = undecodable.length ? '; undecodable, not sent: ' + undecodable.join(', ') : '';
    return `${posts} (${outcome}${unsent}); ${audio?.gameObjects ?? 0} audio game objects for ${audio?.emitters ?? 0} page emitter(s)`;
  });

  // Combat rules (K2): locks, hits and EVE damage on default-gunned Rifters and Punishers. Each check loads its own scene.
  const Rifter = (id: string, position: SceneVector) => ({ id, dna: 'mf4_t1:minmatarbase:minmatar', type: 'Rifter', position });
  const Punisher = (id: string, position: SceneVector) => ({ id, dna: 'af1_t1:amarrbase:amarr', type: 'Punisher', position });
  const LoadCombatScene = async (ships: { readonly id: string }[], combat?: object, extra: object = {}): Promise<ViewerState> => {
    await call<ShipStatsAnswer>('ship_stats', { type: 'Rifter' }).catch(SkipWithoutSde);
    await call('load_scene', { scene: { name: 'verify-combat', ships, ...(combat ? { combat } : {}), ...extra } });
    return WaitFor('the combat scene resolves its default fits', 60, (polled) => {
      const pending = ships.map((ship) => ShipIn(polled, ship.id)).find((ship) => ship.fit?.math !== 'dogma' || !ship.targeting);
      return pending ? `${pending.id}: ${Show(pending.fit?.note ?? pending.fitNote ?? pending.fit?.math)}` : null;
    });
  };
  const Move = (id: string, position: SceneVector) => call('patch_scene', { operations: [{ op: 'update_ship', id, set: { position } }] });
  const LockOf = (state: ViewerState, id: string, target: string): Maybe<ShipLockState> => ShipIn(state, id).locks?.find((lock) => lock.target === target) ?? null;
  // A WaitFor test's problem must never be undefined (JSON.stringify(undefined) is).
  const Show = (value: unknown): string => JSON.stringify(value) ?? 'undefined';
  const ShipGuns = (state: ViewerState, id: string): ShipModuleRowState[] => ShipIn(state, id).fit?.modules.filter((module) => module.combat) ?? [];

  await Check('get_overview measures the fight from one ship', async () => {
    const ships = [
      { ...Rifter('rifter', [0, 0, 0]), team: 'blue' },
      { ...Punisher('punisher', [8000, 0, 0]), team: 'red' },
      { ...Rifter('wing', [0, 0, 3000]), team: 'blue' }
    ];
    await LoadCombatScene(ships, { death: 'flag' });
    await call<SetTargetResult>('set_target', { ships: ['punisher'], target: 'rifter' });
    await call<SwitchModulesResult>('switch_modules', { ships: ['punisher'], modules: ['turret'], state: 'active' });
    await WaitFor('the punisher fires on the rifter', 20, (polled) => ((ShipIn(polled, 'punisher').combat?.shots ?? 0) > 0 ? null : Show(ShipIn(polled, 'punisher').locks)));
    const overview = await call<ShipOverview>('get_overview', { ship: 'rifter', envelope: true });
    const [wing, punisher] = overview.rows;
    Expect(wing?.id === 'wing' && wing.relation === 'friendly' && punisher?.id === 'punisher' && punisher.relation === 'hostile', Show(overview.rows.map((row) => [row.id, row.relation, row.distance])));
    Expect(punisher.distance > 7000 && punisher.distance < 8000, `punisher at ${punisher.distance} m`);
    Expect(punisher.targeting === 'locked' && punisher.shooting === true && punisher.target === 'rifter', Show(punisher));
    Expect((punisher.incomingDps ?? 0) > 0 && (punisher.outgoingDps ?? 0) > 0 && punisher.hitChance != null && (punisher.reach ?? 0) > 0, Show(punisher));
    const envelope = overview.envelope;
    Expect(envelope?.focus === 'punisher' && envelope.for === 'auto' && envelope.ideal != null && (envelope.points?.length ?? 0) > 5, Show(envelope));
    Expect((overview.ship.lockRange ?? 0) > 0 && (overview.ship.reach ?? 0) > 0 && (overview.ship.ehp ?? 0) > 0 && overview.stance?.type === 'in-line', Show({ ship: overview.ship, stance: overview.stance }));
    const refused = await call('get_overview', { ship: 'nobody' }).then(
      () => 'answered',
      (error: unknown) => String(error)
    );
    Expect(/not in the scene/u.test(refused), refused);
    return `rifter sees punisher at ${punisher.distance} m (in ${punisher.incomingDps} / out ${punisher.outgoingDps} dps, hit ${punisher.hitChance}); ${envelope?.ideal?.type} ideal ${envelope?.ideal?.ideal} m in ${Show(envelope?.ideal?.window)}`;
  });

  await Check('pilots fly their stances: a kiter holds its window and a model takes it over', async () => {
    interface StanceState {
      readonly state?: string;
      readonly focus?: string;
      readonly window?: readonly [number, number];
      readonly decisions?: readonly unknown[];
    }
    const StanceOf = (state: ViewerState, id: string): Maybe<StanceState> => (ShipIn(state, id) as { readonly stance?: StanceState }).stance ?? null;
    const ships = [
      { ...Rifter('rifter', [0, 0, 0]), team: 'blue' },
      { ...Punisher('punisher', [20_000, 0, 0]), team: 'red' }
    ];
    await LoadCombatScene(ships, { death: 'flag' });
    await call('order_ship', { id: 'punisher', order: { type: 'approach', target: 'rifter' } });
    await call('order_ship', { id: 'rifter', order: { type: 'stance', set: { type: 'kite' } } });
    const flying = await WaitFor('the rifter kites in its window', 60, (polled) => {
      const stance = StanceOf(polled, 'rifter');
      return stance?.focus === 'punisher' && stance.window && (stance.decisions?.length ?? 0) > 0 && (stance.state === 'orbiting' || stance.state === 'holding') ? null : Show(stance);
    });
    const window = StanceOf(flying, 'rifter')?.window ?? [0, 0];
    const overview = await call<ShipOverview>('get_overview', { ship: 'rifter', envelope: false });
    const distance = overview.rows.find((row) => row.id === 'punisher')?.distance ?? 0;
    Expect(distance > window[0] * 0.8 && distance < window[1] * 1.3, `punisher at ${distance} m, window ${Show(window)}`);
    Expect((overview.stance as { readonly state?: string } | undefined)?.state != null, Show(overview.stance));
    await call('order_ship', { id: 'rifter', order: { type: 'stop' } });
    const manual = await WaitFor('a model takes the pilot over', 5, (polled) => (StanceOf(polled, 'rifter')?.state === 'manual' ? null : Show(StanceOf(polled, 'rifter'))));
    await call('order_ship', { id: 'rifter', order: { type: 'stance', set: { type: 'kite' } } });
    await WaitFor('a stance order hands it back', 10, (polled) => (StanceOf(polled, 'rifter')?.state !== 'manual' ? null : Show(StanceOf(polled, 'rifter'))));
    return `kites the punisher at ${distance} m in ${Show(window)}; ${StanceOf(manual, 'rifter')?.state} after order_ship, flying again after a stance order`;
  });

  await Check("set_target locks with EVE's lock time and the guns wait for the lock", async () => {
    await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('punisher', [5000, 0, 0])], { death: 'flag' });
    const set = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'punisher' });
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active' });
    Expect(on.ships[0]?.modules.length === 3, Show(on));
    const held = await WaitFor('the guns wait for the lock', 10, (polled) => {
      const guns = ShipGuns(polled, 'rifter');
      return guns.length === 3 && guns.every((gun) => gun.state === 'activating' && /waiting for its lock on "punisher"/u.test(gun.note ?? '')) && LockOf(polled, 'rifter', 'punisher')?.state === 'locking' ? null : Show({ guns, locks: ShipIn(polled, 'rifter').locks });
    });
    const rifter = ShipIn(held, 'rifter');
    const signature = ShipIn(held, 'punisher').physics?.signatureRadius ?? 0;
    const expected = 40000 / ((rifter.targeting?.scanResolution ?? 0) * Math.asinh(signature) ** 2);
    const lock = LockOf(held, 'rifter', 'punisher');
    Expect(Math.abs((lock?.lockTime ?? 0) - expected) <= 0.01, `lockTime ${lock?.lockTime}, expected ${expected.toFixed(3)} (scan ${rifter.targeting?.scanResolution}, sig ${signature})`);
    Expect((ShipIn(held, 'rifter').shots ?? 0) === 0, `shots before the lock: ${ShipIn(held, 'rifter').shots}`);
    const fired = await WaitFor('the first shots', 15, (polled) => ((ShipIn(polled, 'rifter').combat?.shots ?? 0) > 0 ? null : Show(ShipIn(polled, 'rifter').locks)));
    const first = Math.min(...(ShipIn(fired, 'rifter').combat?.lastHits ?? []).map((row) => row.tick));
    const due = set.tick + 1 + Math.ceil(expected);
    Expect(first >= due - 1 && first <= due + 1, `first shot at tick ${first}, the lock completes about tick ${due} (set_target at ${set.tick})`);
    await Move('punisher', [40000, 0, 0]);
    const lost = await WaitFor('the lock waits out of targeting range and the guns stop', 15, (polled) => {
      const waiting = LockOf(polled, 'rifter', 'punisher');
      const guns = ShipGuns(polled, 'rifter');
      return waiting?.state === 'waiting' && /out of targeting range/u.test(waiting.note ?? '') && guns.every((gun) => gun.state === 'online' || gun.state === 'reactivating' || gun.state === 'activating') ? null : Show({ waiting, guns });
    });
    return `lockTime ${lock?.lockTime} s (EVE's ${expected.toFixed(3)} from scan ${rifter.targeting?.scanResolution} mm and sig ${signature} m); first shot at tick ${first} (lock due ${due}); at 40 km: "${LockOf(lost, 'rifter', 'punisher')?.note}"`;
  });

  await Check('hits at rest within optimal always hit and land EVE damage through resists', async () => {
    const loaded = await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('p1', [2000, 0, 0]), Punisher('p2', [-2000, 0, 0])], { death: 'flag' });
    const [gun] = ShipGuns(loaded, 'p1');
    const damage: Record<string, number> = gun?.combat?.damage ?? {};
    const engaged = await call<EngageResult>('engage', { ships: ['p1', 'p2'], target: 'rifter' });
    Expect(engaged.ships.length === 2 && engaged.ships.every((ship) => ship.modules.length === 4), Show(engaged));
    const Expected = (state: ViewerState, row: CombatRowState): number => {
      const resists = ShipIn(state, 'rifter').defense?.[row.layer ?? 'shield'].resists;
      return Object.entries(damage).reduce((sum, [type, amount]) => sum + amount * (1 - (resists?.[type as keyof DamageResists] ?? 0) / 100), 0) * row.quality;
    };
    const hit = await WaitFor('the first hits on the shield', 15, (polled) => ((ShipIn(polled, 'rifter').combat?.lastTaken ?? []).some((row) => row.layer === 'shield') ? null : Show(ShipIn(polled, 'rifter').combat)));
    // A row's layer is the deepest it reached: a shield row's damage stayed in the shield.
    const shieldRows = (ShipIn(hit, 'rifter').combat?.lastTaken ?? []).filter((row) => row.layer === 'shield');
    Expect(shieldRows.length > 0, Show(ShipIn(hit, 'rifter').combat));
    for (const row of shieldRows) Expect(Math.abs(row.damage - Expected(hit, row)) <= 0.1, `row ${Show(row)}: expected ${Expected(hit, row).toFixed(2)} from ${Show(damage)}`);
    const t0 = hit.simulation.seconds;
    const armor = await WaitFor('the hits reach armor', 30, (polled) => ((ShipIn(polled, 'rifter').combat?.lastTaken ?? []).some((row) => row.layer === 'armor' || row.layer === 'structure') ? null : Show(ShipIn(polled, 'rifter').defense)));
    const rifter = ShipIn(armor, 'rifter');
    const shooters = ['p1', 'p2'].map((id) => ShipIn(armor, id).combat);
    Expect(
      shooters.every((combat) => combat && combat.misses === 0 && combat.hits === combat.shots),
      `misses at rest within optimal: ${Show(shooters)}`
    );
    const dealt = shooters.reduce((sum, combat) => sum + (combat?.dealt ?? 0), 0);
    const taken = rifter.combat?.taken ?? 0;
    const defense = rifter.defense;
    const lost = defense ? (['shield', 'armor', 'structure'] as const).reduce((sum, layer) => sum + defense[layer].max - defense[layer].hp, 0) : 0;
    const recharge = (armor.simulation.seconds - t0 + 2) * ((2.5 * (defense?.shield.max ?? 0)) / (defense?.shieldRecharge || 1));
    Expect(Math.abs(dealt - taken) <= 0.5, `dealt ${dealt}, taken ${taken}`);
    Expect(taken - lost >= -0.5 && taken - lost <= recharge + 0.5, `taken ${taken}, HP lost ${lost} (shield recharge up to ${recharge.toFixed(1)})`);
    return `${shooters.reduce((sum, combat) => sum + (combat?.shots ?? 0), 0)} shots, all hits; ${shieldRows.length} shield rows match the volley through resists; dealt ${dealt.toFixed(1)} = taken ${taken} (HP lost ${lost.toFixed(1)}); shield ${defense?.shield.hp}, armor ${defense?.armor.hp}`;
  });

  await Check('shots in falloff mostly miss, and misses post no impact sound', async () => {
    await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('punisher', [20150, 0, 0])], { death: 'flag' });
    const engaged = await call<EngageResult>('engage', { ships: ['rifter'], target: 'punisher', modules: ['high-0'] });
    Expect(engaged.ships[0]?.modules.length === 1, Show(engaged));
    const done = await WaitFor('12 shots in falloff', 45, (polled) => ((ShipIn(polled, 'rifter').combat?.shots ?? 0) >= 12 ? null : Show(ShipIn(polled, 'rifter').combat?.shots)));
    const combat = ShipIn(done, 'rifter').combat;
    const posted = (done.audio?.posted ?? []).filter((entry) => entry.tick >= engaged.tick);
    Expect((done.audio?.posted ?? []).some((entry) => entry.tick < engaged.tick) || (done.audio?.posted.length ?? 0) < 20, 'audio.posted no longer reaches back to the engage');
    const impacts = posted.filter((entry) => entry.ship === 'punisher' && /^ship_impact_/u.test(entry.event)).length;
    Expect(combat && combat.misses >= 0.75 * combat.shots, `misses ${combat?.misses} of ${combat?.shots}`);
    Expect(impacts === combat?.hits, `impact sounds ${impacts}, hits ${combat?.hits}`);
    return `${combat?.misses} of ${combat?.shots} missed at ${ShipIn(done, 'rifter').target?.distance} m (chance ${combat?.lastHits[0]?.chance}); ${impacts} impact sounds for ${combat?.hits} hits`;
  });

  await Check('engage arms the guns; cease_fire stops them; a lost lock re-fires after the re-lock', async () => {
    await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('punisher', [5000, 0, 0])], { death: 'flag' });
    await call<EngageResult>('engage', { ships: ['rifter'], target: 'punisher' });
    const firing = await WaitFor('the engaged guns fire', 15, (polled) => ((ShipIn(polled, 'rifter').combat?.shots ?? 0) >= 3 && ShipIn(polled, 'rifter').engaged ? null : Show(ShipIn(polled, 'rifter').locks)));
    await Move('punisher', [40000, 0, 0]);
    const stopped = await WaitFor('the lost lock stops the guns', 15, (polled) => (ShipGuns(polled, 'rifter').every((gun) => gun.state !== 'active' && gun.state !== 'stopping') && LockOf(polled, 'rifter', 'punisher')?.state === 'waiting' ? null : Show(ShipGuns(polled, 'rifter'))));
    const before = ShipIn(stopped, 'rifter').combat?.shots ?? 0;
    await Move('punisher', [5000, 0, 0]);
    const again = await WaitFor('the guns fire again after the re-lock', 20, (polled) => ((ShipIn(polled, 'rifter').combat?.shots ?? 0) > before ? null : Show({ locks: ShipIn(polled, 'rifter').locks, guns: ShipGuns(polled, 'rifter') })));
    const cease = await call<{ ships: { id: string; modules: string[] }[] }>('cease_fire', { ships: ['rifter'] });
    Expect(cease.ships[0]?.modules.length === 3, Show(cease));
    const quiet = await WaitFor('cease_fire stops the guns at their cycle end', 10, (polled) => (ShipGuns(polled, 'rifter').every((gun) => gun.state === 'online' || gun.state === 'reactivating') && !ShipIn(polled, 'rifter').engaged ? null : Show(ShipGuns(polled, 'rifter'))));
    await call('cease_fire', { ships: ['rifter'], unlock: true });
    const unlocked = await WaitFor('unlock clears the target and the lock', 5, (polled) => (ShipIn(polled, 'rifter').target === null && !ShipIn(polled, 'rifter').locks?.length ? null : Show(ShipIn(polled, 'rifter').locks)));
    return `${ShipIn(firing, 'rifter').combat?.shots} shots engaged; out of range at ${before} shots, firing again at ${ShipIn(again, 'rifter').combat?.shots} after the re-lock with no new command; stopped at ${ShipIn(quiet, 'rifter').combat?.shots}; unlocked at tick ${unlocked.simulation.tick}`;
  });

  await Check('the same seed replays the same fight; another seed differs', async () => {
    const Fight = async (seed?: number): Promise<string> => {
      await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('p1', [2000, 0, 0]), Punisher('p2', [-2000, 0, 0])], { death: 'flag', ...(seed == null ? {} : { seed }) });
      const engaged = await call<EngageResult>('engage', { ships: ['p1', 'p2'], target: 'rifter' });
      const dead = await WaitFor('the kill', 60, (polled) => (ShipIn(polled, 'rifter').destroyed ? null : Show(ShipIn(polled, 'rifter').defense)));
      const settled = await WaitFor('the guns settle', 10, (polled) => (['p1', 'p2'].every((id) => ShipGuns(polled, id).every((gun) => gun.state !== 'active' && gun.state !== 'stopping')) ? null : 'firing'));
      const kill = ShipIn(dead, 'rifter').destroyed;
      return Show({ shots: settled.combat?.shots, after: (kill?.tick ?? 0) - engaged.tick, by: kill?.by, module: kill?.module, dealt: ['p1', 'p2'].map((id) => Math.round((ShipIn(settled, id).combat?.dealt ?? 0) * 10) / 10) });
    };
    const first = await Fight();
    const again = await Fight();
    Expect(first === again, `seed 1 twice: ${first} vs ${again}`);
    const other = await Fight(2);
    Expect(other !== first, `seed 2 replayed seed 1: ${other}`);
    return `seed 1: ${first} (twice); seed 2: ${other}`;
  });

  await Check('a ship at 0 hull explodes and leaves cleanly', async () => {
    const loaded = await LoadCombatScene([Rifter('rifter', [0, 0, 0]), Punisher('p1', [2000, 0, 0]), Punisher('p2', [-2000, 0, 0]), Punisher('orbiter', [0, 0, 3000])]);
    const objects = (loaded.audio?.gameObjects ?? 0) - (loaded.audio?.emitters ?? 0);
    await call('order_ship', { id: 'orbiter', order: { type: 'orbit', target: 'rifter', range: 2500 } });
    const engaged = await call<EngageResult>('engage', { ships: ['p1', 'p2'], target: 'rifter' });
    const dead = await WaitFor('the kill', 60, (polled) => (ShipIn(polled, 'rifter').destroyed ? null : Show(ShipIn(polled, 'rifter').defense)));
    const kill = ShipIn(dead, 'rifter').destroyed;
    Expect(kill?.mode === 'explode' && ['p1', 'p2'].includes(kill.by) && dead.combat?.kills.some((row) => row.ship === 'rifter'), Show({ kill, kills: dead.combat?.kills }));
    const stopped = await WaitFor('the guns on it stop, the orbiter stops', 10, (polled) => {
      const guns = ['p1', 'p2'].flatMap((id) => ShipGuns(polled, id).filter((gun) => gun.state === 'active' || gun.state === 'stopping'));
      const orbiter = ShipIn(polled, 'orbiter');
      const targets = ['p1', 'p2'].map((id) => ShipIn(polled, id).target);
      return !guns.length && targets.every((target) => target === null) && orbiter.order?.type === 'stop' && /target "rifter" was destroyed/u.test(orbiter.orderNote ?? '') ? null : Show({ guns, targets, orbiter: [orbiter.order, orbiter.orderNote] });
    });
    const refused = await call('order_ship', { id: 'rifter', order: { type: 'stop' } }).then(
      () => 'taken',
      (error: unknown) => String(error)
    );
    Expect(/was destroyed/u.test(refused), `order_ship on the dead: ${refused}`);
    const target = await call<SetTargetResult>('set_target', { ships: ['rifter'], target: 'p1' });
    Expect(
      target.skipped.some((skip) => skip.id === 'rifter' && skip.reason === 'it was destroyed'),
      Show(target)
    );
    const heard = await WaitFor('the explosion posts its local and global sounds', 15, (polled) => {
      const events = (polled.audio?.posted ?? []).filter((entry) => entry.ship === 'rifter' && entry.tick >= engaged.tick && /^ecx_generic_explosive_short_/u.test(entry.event)).map((entry) => entry.event);
      return events.some((event) => /individual/u.test(event)) && events.some((event) => /global/u.test(event)) ? null : Show(events);
    });
    const sounds = (heard.audio?.posted ?? []).filter((entry) => entry.ship === 'rifter' && /^ecx_/u.test(entry.event)).map((entry) => entry.event);
    const gone = await WaitFor('the ball leaves after the linger', 40, (polled) => {
      const rifter = ShipIn(polled, 'rifter');
      return rifter.destroyed?.explosion?.gone && rifter.status === 'destroyed' && rifter.position == null ? null : Show({ status: rifter.status, explosion: rifter.destroyed?.explosion, tick: polled.simulation.tick });
    });
    const after = (gone.audio?.gameObjects ?? 0) - (gone.audio?.emitters ?? 0);
    Expect(after === objects && !gone.audio?.foreign, `audio game objects − emitters: ${objects} before, ${after} after (foreign ${Show(gone.audio?.foreign)})`);
    // Headless draws no hull, so no damage controller loads the hull's fires: only the real GPU sees that leak.
    const drawn = gone.renderer.available ? '' : " (no renderer: the hull's damage effects never load)";
    return `killed by ${kill?.by} (${kill?.module}) ${(kill?.tick ?? 0) - engaged.tick} ticks after engage; ${ShipIn(stopped, 'orbiter').orderNote}; order_ship refused (${refused}); sounds ${Show(sounds)}; ${ShipIn(gone, 'rifter').destroyed?.explosion?.file} ball gone at tick ${gone.simulation.tick} (removesAt ${ShipIn(gone, 'rifter').destroyed?.explosion?.removesAt}); gameObjects − emitters ${after}${drawn}`;
  });

  // Missiles (sd-combat → Missiles in the page): a default-fit Caracal's 5 Heavy Missile Launcher II with Scourge.
  const Caracal = (id: string, position: SceneVector) => ({ id, dna: 'cc1_t1:caldaribase:caldari', type: 'Caracal', position });
  const HEAVY_CYCLE = 6.1965;
  const HEAVY_VELOCITY = 9675;
  const Launchers = (state: ViewerState, id: string): ShipModuleRowState[] => ShipIn(state, id).fit?.modules.filter((module) => module.combat?.flightTime != null) ?? [];
  const Flights = (state: ViewerState, ship?: string) => (state.missiles?.flights ?? []).filter((flight) => ship == null || flight.ship === ship);
  // The missiles from `ship` that lost their target (or their ship) with `why`.
  const LostFlights = (state: ViewerState, ship: string, why: RegExp) => Flights(state, ship).filter((flight) => flight.state === 'lost' && why.test(flight.why ?? ''));

  await Check('launchers fire missiles on their cycle', async () => {
    await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Punisher('punisher', [15000, 0, 0])], { death: 'flag' });
    const bare = await call<SwitchModulesResult>('switch_modules', { ships: ['caracal'], modules: ['launcher'], state: 'active' });
    Expect(!bare.ships.length && bare.skipped.length === 5 && bare.skipped.every((skip) => skip.reason === 'it needs a target: set_target or switch_modules target'), Show(bare));
    const set = await call<SetTargetResult>('set_target', { ships: ['caracal'], target: 'punisher' });
    Expect(set.ships[0]?.launchers === 5 && set.ships[0]?.turrets === 0 && set.ships[0]?.lock?.state === 'waiting', Show(set));
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['caracal'], modules: ['launcher'], state: 'active' });
    Expect(on.ships[0]?.modules.length === 5 && !on.skipped.length, Show(on));
    await WaitFor('the launchers wait for the lock', 5, (polled) => (Launchers(polled, 'caracal').every((row) => row.state === 'activating' && /lock/u.test(row.note ?? '') && row.effectiveness == null) ? null : Show(Launchers(polled, 'caracal').map((row) => [row.state, row.note, row.effectiveness]))));
    const first = await WaitFor('the first volley launches after the lock', 30, (polled) => ((polled.missiles?.launched ?? 0) >= 5 ? null : Show({ missiles: polled.missiles, launchers: Launchers(polled, 'caracal').map((row) => [row.state, row.note]) })));
    const flying = Flights(first, 'caracal').filter((flight) => flight.state === 'flying');
    Expect(flying.length > 0 && flying.every((flight) => flight.target === 'punisher' && (flight.expiresIn ?? 0) > 0 && flight.charge === 'Scourge Heavy Missile'), Show(first.missiles));
    const start = first.simulation.seconds;
    const launched = first.missiles?.launched ?? 0;
    const later = await WaitFor('20 s of launches', 40, (polled) => (polled.simulation.seconds - start >= 20 ? null : 'waiting'));
    const rows = Launchers(later, 'caracal');
    Expect(rows.length === 5 && rows.every((row) => row.state === 'active' && Math.abs((row.cycleTime ?? 0) - HEAVY_CYCLE) < 0.05 && row.combat?.velocity === HEAVY_VELOCITY), Show(rows));
    const elapsed = later.simulation.seconds - start;
    const more = (later.missiles?.launched ?? 0) - launched;
    const expected = (5 * elapsed) / HEAVY_CYCLE;
    Expect(Math.abs(more - expected) <= 5 && ShipIn(later, 'caracal').missiles?.launched === later.missiles?.launched, Show({ more, expected, missiles: ShipIn(later, 'caracal').missiles }));
    await call<SwitchModulesResult>('switch_modules', { ships: ['caracal'], modules: ['launcher'], state: 'online' });
    const stopped = await WaitFor('the launchers stop at their cycle end', 15, (polled) => (Launchers(polled, 'caracal').every((row) => row.state === 'online' || row.state === 'reactivating') ? null : Show(Launchers(polled, 'caracal').map((row) => row.state))));
    const quiet = await WaitFor('no launch after the stop', 20, (polled) => (polled.simulation.seconds - stopped.simulation.seconds >= 8 ? null : 'waiting'));
    Expect(quiet.missiles?.launched === stopped.missiles?.launched, Show({ stopped: stopped.missiles?.launched, after: quiet.missiles?.launched }));
    return `5 launchers waited for the lock, then ${more} launches in ${Math.round(elapsed * 10) / 10} s (expected ${Math.round(expected * 10) / 10} at ${rows[0]?.cycleTime} s); none after the stop (${quiet.missiles?.launched} launched)`;
  });

  await Check("missiles hit through EVE's formula", async () => {
    await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Punisher('punisher', [15000, 0, 0])], { death: 'flag' });
    await call<EngageResult>('engage', { ships: ['caracal'], target: 'punisher', modules: ['launcher'] });
    const launched = await WaitFor('the first launch', 30, (polled) => (Flights(polled, 'caracal').length ? null : Show(ShipIn(polled, 'caracal').locks)));
    const launchTick = Math.min(...Flights(launched, 'caracal').map((flight) => flight.launchedAt));
    const distance = ShipIn(launched, 'caracal').target?.distance ?? 0;
    const hit = await WaitFor('missile hits land', 30, (polled) => ((ShipIn(polled, 'caracal').combat?.lastHits ?? []).filter((row) => row.missile).length >= 3 ? null : Show({ missiles: polled.missiles?.flights.slice(0, 5), combat: ShipIn(polled, 'caracal').combat })));
    const rows = (ShipIn(hit, 'caracal').combat?.lastHits ?? []).filter((row) => row.missile);
    const firstHit = Math.min(...rows.map((row) => row.tick));
    const quality = 37 / 105;
    const volley = Launchers(hit, 'caracal')[0]?.combat?.volley ?? 0;
    const kinetic = ShipIn(hit, 'punisher').defense?.shield.resists.kinetic ?? 0;
    const expected = volley * quality * (1 - kinetic / 100);
    Expect(
      rows.every((row) => row.result === 'hits' && Math.abs(row.chance - quality) < 0.001 && Math.abs(row.quality - quality) < 0.001 && row.layer === 'shield' && Math.abs(row.damage - expected) < 0.2),
      Show({ rows, expected })
    );
    // The flight takes about distance / 9,675 m/s from the launch, plus the launch tick and the drain at the next boundary.
    const flight = firstHit - launchTick;
    Expect(flight >= Math.floor(distance / HEAVY_VELOCITY) && flight <= Math.ceil(distance / HEAVY_VELOCITY) + 2, Show({ launchTick, firstHit, distance }));
    const caracal = ShipIn(hit, 'caracal').combat;
    const punisher = ShipIn(hit, 'punisher').combat;
    Expect(caracal != null && punisher != null && Math.abs(caracal.dealt - punisher.taken) < 0.01, Show({ dealt: caracal?.dealt, taken: punisher?.taken }));
    return `launched at tick ${launchTick} at ${distance} m, first hit at ${firstHit}; quality ${rows[0]?.quality} (37 / 105); ${rows[0]?.damage} HP per missile into the shield (volley ${volley}, kinetic resist ${kinetic} %); dealt ${caracal?.dealt} = taken ${punisher?.taken}`;
  });

  await Check('a missile that cannot reach its target expires without damage', async () => {
    // 11,250 m/s with Navigation V: faster than the heavy missile.
    const fast = { ...Punisher('punisher', [15000, 0, 0]), stats: { maxVelocity: 9000 } };
    await LoadCombatScene([Caracal('caracal', [0, 0, 0]), fast], { death: 'flag' });
    await call<EngageResult>('engage', { ships: ['caracal'], target: 'punisher', modules: ['launcher'] });
    await WaitFor('the first volley', 30, (polled) => ((polled.missiles?.launched ?? 0) >= 5 ? null : Show(ShipIn(polled, 'caracal').locks)));
    await call('order_ship', { id: 'punisher', order: { type: 'direction', direction: [1, 0, 0] } });
    const expired = await WaitFor('a volley runs out of flight time', 40, (polled) => (Flights(polled, 'caracal').some((flight) => flight.state === 'expired') ? null : Show({ missiles: polled.missiles && { ...polled.missiles, flights: polled.missiles.flights.slice(0, 5) }, speed: ShipIn(polled, 'punisher').speed })));
    const taken = ShipIn(expired, 'punisher').combat?.taken ?? 0;
    const after = await WaitFor('the rest settle', 15, (polled) => (polled.simulation.seconds - expired.simulation.seconds >= 6 ? null : 'waiting'));
    const misses = ShipIn(after, 'caracal').combat?.misses ?? 0;
    Expect(misses > 0 && (ShipIn(after, 'punisher').combat?.taken ?? 0) === taken && (after.missiles?.expired ?? 0) > 0, Show({ misses, taken, after: ShipIn(after, 'punisher').combat?.taken, missiles: after.missiles?.expired }));
    const noted = (ShipIn(after, 'caracal').combat?.lastHits ?? []).filter((row) => row.note === 'it ran out of flight time');
    Expect(
      noted.every((row) => row.result === 'misses' && row.damage === 0),
      Show(noted)
    );
    return `the fleeing Punisher (${ShipIn(expired, 'punisher').speed} m/s) outran ${after.missiles?.expired} missiles: ${misses} misses, its taken stayed ${taken} HP`;
  });

  await Check('missiles at a dead or warping target are lost', async () => {
    const loaded = await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Rifter('rifter', [50000, 0, 0]), Punisher('p1', [50000, 0, 2000]), Punisher('p2', [50000, 0, -2000]), Punisher('runner', [0, 0, 50000])]);
    // Far enough that a volley is always flying (≈ one cycle of flight), within the Caracal's lock range.
    const range = Math.min((ShipIn(loaded, 'caracal').targeting?.maxTargetRange ?? 50000) - 5000, 60000);
    await Move('rifter', [range, 0, 0]);
    await Move('p1', [range, 0, 2000]);
    await Move('p2', [range, 0, -2000]);
    await Move('runner', [0, 0, range]);
    await call<EngageResult>('engage', { ships: ['caracal'], target: 'rifter' });
    await WaitFor('missiles fly at the Rifter', 30, (polled) => (Flights(polled, 'caracal').some((flight) => flight.state === 'flying') ? null : Show(ShipIn(polled, 'caracal').locks)));
    await call<EngageResult>('engage', { ships: ['p1', 'p2'], target: 'rifter' });
    const dead = await WaitFor('missiles at the dead Rifter are lost', 60, (polled) => (ShipIn(polled, 'rifter').destroyed && LostFlights(polled, 'caracal', /its target was destroyed/u).length ? null : Show({ destroyed: ShipIn(polled, 'rifter').destroyed, flights: Flights(polled, 'caracal').slice(0, 6) })));
    const taken = ShipIn(dead, 'rifter').combat?.taken ?? 0;
    await call<EngageResult>('engage', { ships: ['caracal'], target: 'runner' });
    await WaitFor('missiles fly at the runner', 30, (polled) => (Flights(polled, 'caracal').some((flight) => flight.state === 'flying' && flight.target === 'runner') ? null : Show(ShipIn(polled, 'caracal').locks)));
    await call('order_ship', { id: 'runner', order: { type: 'warp', point: [0, 0, 2_000_000] } });
    const warped = await WaitFor('missiles at the warping runner are lost', 40, (polled) => (LostFlights(polled, 'caracal', /its target entered warp/u).length ? null : Show({ mode: ShipIn(polled, 'runner').mode, flights: Flights(polled, 'caracal').slice(0, 6) })));
    const overkill = (ShipIn(dead, 'caracal').combat?.lastHits ?? []).filter((row) => row.result === 'overkill');
    Expect((ShipIn(warped, 'rifter').combat?.taken ?? 0) === taken, Show({ taken, after: ShipIn(warped, 'rifter').combat?.taken }));
    return `${LostFlights(dead, 'caracal', /destroyed/u).length} lost at the dead Rifter (${overkill.length} overkill rows in the last 3), its taken stayed ${taken} HP; ${LostFlights(warped, 'caracal', /warp/u).length} lost as the runner warped`;
  });

  await Check('a shooter that warps loses its missiles', async () => {
    const loaded = await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Punisher('punisher', [50000, 0, 0])], { death: 'flag' });
    await Move('punisher', [Math.min((ShipIn(loaded, 'caracal').targeting?.maxTargetRange ?? 50000) - 5000, 60000), 0, 0]);
    await call<EngageResult>('engage', { ships: ['caracal'], target: 'punisher' });
    await WaitFor('missiles fly', 30, (polled) => (Flights(polled, 'caracal').some((flight) => flight.state === 'flying') ? null : Show(ShipIn(polled, 'caracal').locks)));
    await call('order_ship', { id: 'caracal', order: { type: 'warp', point: [0, 0, -2_000_000] } });
    const gone = await WaitFor('its missiles vanish as it enters warp', 40, (polled) =>
      LostFlights(polled, 'caracal', /its ship entered warp/u).length && !Flights(polled, 'caracal').some((flight) => flight.state === 'flying') ? null : Show({ mode: ShipIn(polled, 'caracal').mode, flights: Flights(polled, 'caracal').slice(0, 6) })
    );
    return `${LostFlights(gone, 'caracal', /warp/u).length} missiles vanished as the Caracal entered warp; ${gone.missiles?.inFlight} in flight`;
  });

  await Check('missiles kill like turrets, and engage arms launchers by default', async () => {
    const loaded = await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Rifter('rifter', [8000, 0, 0])]);
    const objects = (loaded.audio?.gameObjects ?? 0) - (loaded.audio?.emitters ?? 0);
    const engaged = await call<EngageResult>('engage', { ships: ['caracal'], target: 'rifter' });
    Expect(engaged.ships[0]?.modules.length === 5 && !engaged.skipped.length, Show(engaged));
    const dead = await WaitFor('the missile kill', 90, (polled) => (ShipIn(polled, 'rifter').destroyed ? null : Show(ShipIn(polled, 'rifter').defense?.structure)));
    const kill = ShipIn(dead, 'rifter').destroyed;
    Expect(kill?.by === 'caracal' && /^high-\d$/u.test(kill.module) && kill.weapon === 'Heavy Missile Launcher II' && kill.mode === 'explode', Show(kill));
    const gone = await WaitFor('the ball leaves after the linger', 40, (polled) => (ShipIn(polled, 'rifter').destroyed?.explosion?.gone && ShipIn(polled, 'rifter').position == null ? null : Show(ShipIn(polled, 'rifter').destroyed?.explosion)));
    const after = (gone.audio?.gameObjects ?? 0) - (gone.audio?.emitters ?? 0);
    Expect(after === objects && !gone.audio?.foreign, `audio game objects − emitters: ${objects} before, ${after} after`);
    return `engage armed 5 launchers by default; killed by ${kill?.by} ${kill?.module} (${kill?.weapon}) ${(kill?.tick ?? 0) - engaged.tick} ticks after engage; ${ShipIn(gone, 'rifter').destroyed?.explosion?.file} gone at tick ${gone.simulation.tick}; gameObjects − emitters ${after}`;
  });

  await Check('launcher and missile impact sounds post', async () => {
    await LoadCombatScene([Caracal('caracal', [0, 0, 0]), Punisher('punisher', [15000, 0, 0])], { death: 'flag' });
    const beyond = (state: ViewerState) => (state.audio?.gameObjects ?? 0) - (state.audio?.emitters ?? 0);
    const before = await WaitFor('the audio settles', 90, (state) => (state.audio && state.audio.state !== 'loading' ? null : JSON.stringify(state.audio)));
    const on = await call<EngageResult>('engage', { ships: ['caracal'], target: 'punisher', modules: ['launcher'] });
    const Posts = (state: ViewerState, ship: string, pattern: RegExp) => (state.audio?.posted ?? []).filter((entry) => entry.tick >= on.tick && entry.ship === ship && pattern.test(entry.event));
    // The launcher's outburst posts on the shooter as each launch draws (its firing effect's start curve, through the
    // turret sound path); the charge's impact sound (the impact file's Tr2ActionPlaySound) on the target at each hit.
    const heard = await WaitFor('the outburst and impact sounds post', 45, (polled) => (Posts(polled, 'caracal', /^missile_outburst_/u).length && Posts(polled, 'punisher', /^missile_explosion_/u).length ? null : Show({ posted: polled.audio?.posted, missiles: polled.missiles?.hits })));
    const [outburst] = Posts(heard, 'caracal', /^missile_outburst_/u);
    const [impact] = Posts(heard, 'punisher', /^missile_explosion_/u);
    const audio = heard.audio;
    const played = audio?.state === 'on';
    // Their media may be Wwise PTADPCM: once learned undecodable they are recorded and not sent.
    Expect(
      [outburst, impact].every((entry) => entry.played === played || entry.undecodable === true),
      `outburst and impact with audio ${audio?.state}: ${Show([outburst, impact])}`
    );
    Expect(beyond(heard) === beyond(before), `audio game objects beyond the page's emitters went ${beyond(before)} -> ${beyond(heard)} with the launchers firing: ${Show(audio)}`);
    const undecodable = (audio?.undecodable ?? []).filter((event) => /^missile_/u.test(event));
    const outcome = played ? 'played' : 'audio ' + String(audio?.state) + ', recorded unplayed';
    const unsent = undecodable.length ? '; undecodable, not sent: ' + undecodable.join(', ') : '';
    return `${outburst.event} on caracal, ${impact.event} on punisher (${outcome}${unsent}); ${audio?.gameObjects ?? 0} audio game objects for ${audio?.emitters ?? 0} page emitter(s)`;
  });

  // An FC, a wing commander and a squad of two whose lead the squad anchors on; two Punishers kill the lead, then the FC.
  const fleetFightShips = [Punisher('fc', [0, 0, 0]), Punisher('wc', [0, 0, -1500]), Rifter('lead', [1500, 0, 0]), Rifter('member', [3000, 0, 0]), Punisher('k1', [0, 0, 2500]), Punisher('k2', [1500, 0, 2500])];
  const fleetFight = { fleets: [{ id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'wc', squads: [{ id: 's', role: 'dps', commander: 'lead', members: ['lead', 'member'], anchor: { ship: 'lead', range: 1500 } }] }] }] };

  await Check('a dead squad lead and a dead FC fall back like a removal', async () => {
    await LoadCombatScene(fleetFightShips, undefined, fleetFight);
    await call<EngageResult>('engage', { ships: ['k1', 'k2'], target: 'lead' });
    const leadDead = await WaitFor("the lead's death re-anchors the squad", 60, (polled) => {
      const squad = polled.fleets[0]?.wings[0]?.squads[0];
      return ShipIn(polled, 'lead').destroyed && polled.fleets[0]?.destroyed?.includes('lead') && squad?.anchor?.ship === 'wc' && ShipIn(polled, 'member').anchor?.ship === 'wc' ? null : Show({ squad, member: ShipIn(polled, 'member').anchor, destroyed: polled.fleets[0]?.destroyed });
    });
    await call<EngageResult>('engage', { ships: ['k1', 'k2'], target: 'fc' });
    const fcDead = await WaitFor('the wing commander acts for the dead FC and the member follows it', 60, (polled) => {
      const fleet = polled.fleets[0];
      const member = ShipIn(polled, 'member');
      return ShipIn(polled, 'fc').destroyed && fleet?.commander === 'wc' && fleet.actingFor === 'fc' && ShipIn(polled, 'wc').commands?.includes('fleet') && member.anchor?.ship === 'wc' && member.following
        ? null
        : Show({ fleet: fleet && { commander: fleet.commander, actingFor: fleet.actingFor, destroyed: fleet.destroyed }, member: [member.anchor, member.following?.state] });
    });
    return `lead dead at tick ${ShipIn(leadDead, 'lead').destroyed?.tick}: the squad anchors on wc; FC dead at tick ${ShipIn(fcDead, 'fc').destroyed?.tick}: wc acts for fc (destroyed ${Show(fcDead.fleets[0]?.destroyed)}), member ${ShipIn(fcDead, 'member').following?.state} on ${ShipIn(fcDead, 'member').anchor?.ship}`;
  });

  await Check('a moving FC dies and its fleet flies on: the heir inherits its order', async () => {
    await LoadCombatScene(fleetFightShips, undefined, fleetFight);
    await call('order_fleet', { fleet: 'f', order: { type: 'direction', direction: [1, 0, 0], speed: 0.5 } });
    for (const id of ['k1', 'k2']) await call('order_ship', { id, order: { type: 'keep-at-range', target: 'fc', range: 1000 } });
    await WaitFor('the fleet is under way', 40, (polled) => ((ShipIn(polled, 'wc').speed ?? 0) > 100 ? null : Show(ShipIn(polled, 'wc').speed)));
    await call<EngageResult>('engage', { ships: ['k1', 'k2'], target: 'fc' });
    let before = 0;
    let fcBefore = 0;
    const dead = await WaitFor('the FC dies under way', 90, (polled) => {
      if (!ShipIn(polled, 'fc').destroyed) {
        before = ShipIn(polled, 'wc').speed ?? 0;
        fcBefore = ShipIn(polled, 'fc').speed ?? 0;
      }
      return ShipIn(polled, 'fc').destroyed ? null : Show(ShipIn(polled, 'fc').defense?.structure);
    });
    const deathTick = ShipIn(dead, 'fc').destroyed?.tick ?? dead.simulation.tick;
    let slowest = Infinity;
    const flying = await WaitFor('wc commands and flies on for 5 ticks', 30, (polled) => {
      const wc = ShipIn(polled, 'wc');
      slowest = Math.min(slowest, wc.speed ?? 0);
      const member = ShipIn(polled, 'member');
      return polled.simulation.tick >= deathTick + 5 && polled.fleets[0]?.commander === 'wc' && wc.order?.type === 'direction' && member.following && (member.speed ?? 0) > 50
        ? null
        : Show({ tick: polled.simulation.tick, commander: polled.fleets[0]?.commander, wc: [wc.order, wc.speed], member: [member.following?.state, member.speed] });
    });
    // Halted, a Punisher keeps about a third of its speed after 5 ticks. Inheriting the FC's order, it never drops below
    // the FC's speed: it may slow from its slot's catch-up speed to the fleet's (on tools-core once 295 → 228 m/s, the FC
    // at about 222).
    const floor = Math.min(before, fcBefore);
    Expect(slowest >= 0.9 * floor, `wc slowed from ${before} to ${slowest} m/s across the FC's death (the FC flew at ${fcBefore})`);
    return `FC dead at tick ${deathTick}; wc flies ${Show(ShipIn(flying, 'wc').order)} at ${ShipIn(flying, 'wc').speed} m/s (${before} before, the FC at ${fcBefore}, slowest ${slowest}); member ${ShipIn(flying, 'member').following?.state} on ${ShipIn(flying, 'member').anchor?.ship}`;
  });

  await Check('load_scene revives the dead', async () => {
    const revived = await LoadCombatScene(fleetFightShips, undefined, fleetFight);
    const ships = fleetFightShips.map((ship) => ShipIn(revived, ship.id));
    const hurt = ships.filter((ship) => ship.destroyed || ship.position == null || (['shield', 'armor', 'structure'] as const).some((layer) => (ship.defense?.[layer].hp ?? 0) < (ship.defense?.[layer].max ?? 1)));
    Expect(!hurt.length, Show(hurt.map((ship) => ({ id: ship.id, destroyed: ship.destroyed, position: ship.position, defense: ship.defense }))));
    Expect(!revived.combat?.kills.length, Show(revived.combat));
    Expect(revived.fleets[0]?.commander === 'fc' && !revived.fleets[0].actingFor && !revived.fleets[0].destroyed, Show(revived.fleets[0]));
    const drawn = await WaitFor('every hull builds again', 30, (polled) => {
      const pending = fleetFightShips.map((ship) => ShipIn(polled, ship.id)).filter((ship) => ship.status !== 'ready' && ship.status !== 'validated');
      return pending.length ? Show(pending.map((ship) => [ship.id, ship.status])) : null;
    });
    return `${ships.length} ships alive at full HP, no kills, fleet commanded by fc again; statuses ${Show(fleetFightShips.map((ship) => ShipIn(drawn, ship.id).status))}`;
  });

  // The fleet targeting lever: called primaries and a target queue. Tempest Fleet Issues take the long calls (they
  // outlast the Punishers' guns); Rifters die fast.
  const Tempest = (id: string, position: SceneVector) => ({ id, dna: 'mb2_t1:minmatarnavy:minmatar', type: 'Tempest Fleet Issue', position });
  const CalledOf = (state: ViewerState, fleet = 'b'): Maybe<CalledTree> => state.fleets.find((candidate) => candidate.id === fleet) as Maybe<CalledTree>;
  const Targets = (state: ViewerState, ids: readonly string[]): string => Show(Object.fromEntries(ids.map((id) => [id, ShipIn(state, id).target?.id ?? null])));
  const OnCall = (state: ViewerState, ids: readonly string[], target: Maybe<string>): boolean => ids.every((id) => (target == null ? ShipIn(state, id).target == null : ShipIn(state, id).target?.id === target && ShipIn(state, id).target?.source === 'called'));
  const Refusal = (args: Record<string, unknown>): Promise<string> =>
    call('order_fleet', args).then(
      () => 'taken',
      (error: unknown) => String(error)
    );

  await Check("a called primary focuses a squad's fire and the next called target follows the kill", async () => {
    const ships = [Punisher('bfc', [0, 0, 0]), Punisher('p1', [0, 0, 1200]), Punisher('p2', [0, 0, -1200]), Punisher('g1', [-1500, 0, 0]), Rifter('r1', [5000, 0, 0]), Rifter('r2', [5000, 0, 1500])];
    const fleets = [
      {
        id: 'b',
        commander: 'bfc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'dps', role: 'dps', members: ['p1', 'p2'] },
              { id: 'g', role: 'logi', members: ['g1'] }
            ]
          }
        ]
      }
    ];
    await LoadCombatScene(ships, undefined, { fleets });
    const shooters = ['bfc', 'p1', 'p2'];
    const order = await call<FleetTargetsOrderResult>('order_fleet', { fleet: 'b', order: { type: 'targets', set: ['r1', 'r2'] } });
    Expect(order.primary === 'r1' && Show(order.queue) === '["r2"]' && Show(order.targets) === '["r1","r2"]', Show(order));
    const called = await WaitFor('the fleet locks r1 and pre-locks r2', 20, (polled) => {
      const fleet = CalledOf(polled)?.called;
      const g1 = ShipIn(polled, 'g1');
      const preLocked = LockOf(polled, 'p1', 'r2') != null;
      return OnCall(polled, shooters, 'r1') && g1.target == null && g1.call?.state === 'logi' && fleet?.primary === 'r1' && Show(fleet.queue) === '["r2"]' && preLocked ? null : Show({ targets: Targets(polled, [...shooters, 'g1']), g1: g1.call, fleet, p1: ShipIn(polled, 'p1').locks });
    });
    const firstDead = await WaitFor('r1 dies', 90, (polled) => (ShipIn(polled, 'r1').destroyed ? null : Show(ShipIn(polled, 'r1').defense)));
    const killTick = ShipIn(firstDead, 'r1').destroyed?.tick ?? 0;
    const switched = await WaitFor('every shooter switches to r2, called, and fires', 20, (polled) => {
      const fired = shooters.every((id) => (ShipIn(polled, id).combat?.lastHits ?? []).some((row) => row.target === 'r2'));
      return OnCall(polled, shooters, 'r2') && CalledOf(polled)?.called?.primary === 'r2' && fired ? null : Show({ targets: Targets(polled, shooters), called: CalledOf(polled)?.called });
    });
    const firstOnR2 = Math.min(...shooters.flatMap((id) => (ShipIn(switched, id).combat?.lastHits ?? []).filter((row) => row.target === 'r2').map((row) => row.tick)));
    const slowest = Math.max(...shooters.flatMap((id) => ShipGuns(switched, id).map((gun) => gun.cycleTime ?? 0)));
    Expect(firstOnR2 - killTick <= Math.ceil(slowest) + 2, `the first shot on r2 at tick ${firstOnR2}, ${firstOnR2 - killTick} ticks after the kill (slowest cycle ${slowest} s)`);
    // The call is live: get_state shows the list, kill and all; the document never had one.
    Expect(Show(CalledOf(switched)?.targets) === '["r1","r2"]', `the live list after the kill: ${Show(CalledOf(switched)?.targets)}`);
    const doc = await call<{ fleets?: { targets?: string[] }[] }>('get_scene');
    Expect(doc.fleets?.[0]?.targets === undefined, `the document's list: ${Show(doc.fleets?.[0]?.targets)}`);
    await WaitFor('r2 dies', 90, (polled) => (ShipIn(polled, 'r2').destroyed ? null : Show(ShipIn(polled, 'r2').defense)));
    const settled = await WaitFor('the call ends and the guns settle', 15, (polled) => {
      const firing = shooters.flatMap((id) => ShipGuns(polled, id).filter((gun) => gun.state === 'active' || gun.state === 'stopping'));
      return CalledOf(polled)?.called?.primary === null && OnCall(polled, shooters, null) && !firing.length ? null : Show({ called: CalledOf(polled)?.called, targets: Targets(polled, shooters), firing: firing.length });
    });
    return `bfc, p1, p2 on r1 (called), g1 logi, p1 pre-locked r2 at tick ${called.simulation.tick}; r1 killed at tick ${killTick}, first shot on r2 at ${firstOnR2} (+${firstOnR2 - killTick}, slowest cycle ${slowest} s); the live list keeps ${Show(CalledOf(switched)?.targets)}, the document none; r2 dead, primary null, guns settled at tick ${settled.simulation.tick}`;
  });

  await Check("own targets win over the called targets, and a squad's call beats the fleet's", async () => {
    const ships = [Punisher('bfc', [0, 0, 0]), Punisher('p1', [0, 0, 1200]), Punisher('p2', [0, 0, -1200]), Punisher('p3', [-1200, 0, 0]), Punisher('g1', [-1500, 0, 1500]), Tempest('r1', [6000, 0, 0]), Tempest('r2', [6000, 0, 3000]), Tempest('r3', [6000, 0, -3000])];
    const fleets = [
      {
        id: 'b',
        commander: 'bfc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'a', role: 'dps', members: ['p1', 'p2'] },
              { id: 'c', role: 'dps', members: ['p3'] },
              { id: 'lg', role: 'logi', members: ['g1'] }
            ]
          }
        ]
      }
    ];
    await LoadCombatScene(ships, { death: 'flag' }, { fleets });
    await call('order_fleet', { fleet: 'b', order: { type: 'targets', set: ['r1'] } });
    await call('order_fleet', { fleet: 'b', squad: 'c', order: { type: 'targets', primary: 'r2' } });
    await call('order_fleet', { fleet: 'b', squad: 'lg', order: { type: 'targets', primary: 'r3' } });
    const calls = await WaitFor('each takes its nearest call', 10, (polled) => (OnCall(polled, ['bfc', 'p1', 'p2'], 'r1') && OnCall(polled, ['p3'], 'r2') && ShipIn(polled, 'p3').call?.group?.id === 'c' && OnCall(polled, ['g1'], 'r3') ? null : Targets(polled, ['bfc', 'p1', 'p2', 'p3', 'g1'])));
    const own = await call<SetTargetResult>('set_target', { ships: ['p1'], target: 'r3' });
    const owned = await WaitFor('p1 is on its own target', 5, (polled) => (ShipIn(polled, 'p1').target?.id === 'r3' && ShipIn(polled, 'p1').target?.source === 'own' && ShipIn(polled, 'p1').call?.state === 'own-target' ? null : Show(ShipIn(polled, 'p1').target)));
    const follows = await call<SetTargetResult>('set_target', { ships: ['p2'], target: null });
    Expect(
      follows.skipped.some((skip) => skip.id === 'p2' && /it has no own target: it follows fleet "b"'s call on "r1"/u.test(skip.reason)),
      Show(follows)
    );
    const cleared = await call<SetTargetResult>('set_target', { ships: ['p1'], target: null });
    Expect(
      cleared.ships.some((row) => row.id === 'p1' && row.target === 'r1' && row.source === 'called'),
      Show(cleared)
    );
    await call('order_fleet', { fleet: 'b', squad: 'c', order: { type: 'targets', clear: true } });
    const back = await WaitFor('squad c falls back to the fleet call', 5, (polled) => (OnCall(polled, ['p1', 'p3'], 'r1') ? null : Targets(polled, ['p1', 'p3'])));
    return `calls at tick ${calls.simulation.tick}: bfc, p1, p2 on r1, p3 on r2 (squad c), g1 on r3 (logi squad); set_target made p1 own on r3 (tick ${own.tick}, ${Show(ShipIn(owned, 'p1').call)}); p2's null skipped: "${follows.skipped[0]?.reason}"; p1's null handed it r1 (called); squad c clear: p3 on ${ShipIn(back, 'p3').target?.id}`;
  });

  await Check('cease_fire holds a called fleet until it calls again; a delayed call staggers the pilots', async () => {
    const ships = [Punisher('bfc', [0, 0, 0]), Punisher('p1', [0, 0, 1200]), Punisher('p2', [0, 0, -1200]), Punisher('p3', [-1200, 0, 0]), Tempest('r1', [6000, 0, 0]), Tempest('r2', [6000, 0, 3000])];
    const fleets = [{ id: 'b', commander: 'bfc', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['p1', 'p2', 'p3'] }] }] }];
    const all = ['bfc', 'p1', 'p2', 'p3'];
    await LoadCombatScene(ships, { death: 'flag' }, { fleets });
    await call('order_fleet', { fleet: 'b', order: { type: 'targets', set: ['r1'] } });
    await WaitFor('the fleet fires at r1', 30, (polled) => (all.every((id) => (ShipIn(polled, id).combat?.shots ?? 0) > 0) ? null : Show(all.map((id) => ShipIn(polled, id).combat?.shots ?? 0))));
    const cease = await call<{ ships: { id: string; held?: string }[] }>('cease_fire', { fleet: 'b' });
    Expect(cease.ships.length === 4 && cease.ships.every((row) => row.held === 'hold'), Show(cease));
    const held = await WaitFor('the guns stop at their cycle end and the fleet holds r1', 10, (polled) => {
      const firing = all.flatMap((id) => ShipGuns(polled, id).filter((gun) => gun.state === 'active' || gun.state === 'stopping'));
      return !firing.length && all.every((id) => ShipIn(polled, id).target?.id === 'r1' && ShipIn(polled, id).call?.state === 'holding') ? null : Show({ firing: firing.length, calls: all.map((id) => ShipIn(polled, id).call?.state) });
    });
    const shotsOf = (state: ViewerState): number => all.reduce((sum, id) => sum + (ShipIn(state, id).combat?.shots ?? 0), 0);
    const before = shotsOf(held);
    await Delay(5000);
    const quiet = await WaitFor('a get_state', 5, () => null);
    Expect(shotsOf(quiet) === before, `shots while holding: ${before} → ${shotsOf(quiet)}`);
    const order = await call<FleetTargetsOrderResult>('order_fleet', { fleet: 'b', delay: 1, order: { type: 'targets', primary: 'r2' } });
    const delays = order.delays ?? {};
    Expect(order.delays && order.ships.some((row) => row.respondsIn != null), Show(order));
    const switchedAt = new Map<string, number>();
    const staggered = await WaitFor(
      'each pilot switches to r2 after its delay and fires',
      20,
      (polled) => {
        for (const id of all) if (!switchedAt.has(id) && ShipIn(polled, id).target?.id === 'r2') switchedAt.set(id, polled.simulation.tick);
        const fired = all.every((id) => (ShipIn(polled, id).combat?.lastHits ?? []).some((row) => row.target === 'r2'));
        return switchedAt.size === all.length && fired ? null : Show({ switchedAt: Object.fromEntries(switchedAt), calls: all.map((id) => ShipIn(polled, id).call) });
      },
      1
    );
    const late = all.filter((id) => Math.abs((switchedAt.get(id) ?? 0) - order.tick - (delays[id] ?? 0)) > 1);
    Expect(!late.length && (switchedAt.get('bfc') ?? -1) - order.tick <= 1, `switch ticks ${Show(Object.fromEntries(switchedAt))} vs order tick ${order.tick} + delays ${Show(delays)}`);
    await call('cease_fire', { fleet: 'b', unlock: true });
    await WaitFor('unlock stands the fleet down', 10, (polled) => (all.every((id) => ShipIn(polled, id).target == null && !ShipIn(polled, id).locks?.length && ShipIn(polled, id).call?.state === 'stood-down') ? null : Show(all.map((id) => [ShipIn(polled, id).call?.state, ShipIn(polled, id).locks?.length ?? 0]))));
    const shots = shotsOf(staggered);
    await call('order_fleet', { fleet: 'b', order: { type: 'targets', next: true } });
    const rearmed = await WaitFor('next re-arms them onto r1', 30, (polled) => (OnCall(polled, all, 'r1') && shotsOf(polled) > shots ? null : Targets(polled, all)));
    return `held at ${before} shots for 5 s; delay 1: switch ticks ${Show(Object.fromEntries(switchedAt))} (order at ${order.tick}, delays ${Show(delays)}); stood down, then next re-armed onto r1 (${shotsOf(rearmed)} shots)`;
  });

  await Check("removing a called target advances the document's queue and the live lists; a load keeps the call; bad calls are refused", async () => {
    const ships = [Punisher('bfc', [0, 0, 0]), Punisher('p1', [0, 0, 1200]), Punisher('p2', [0, 0, -1200]), Tempest('r1', [6000, 0, 0]), Tempest('r2', [6000, 0, 3000]), Rifter('r3', [4000, 0, -2000]), Rifter('r4', [5000, 0, 2000])];
    const fleets = [{ id: 'b', commander: 'bfc', targets: ['r1', 'r2'], wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['p1', 'p2'] }] }] }];
    const members = ['bfc', 'p1', 'p2'];
    await LoadCombatScene(ships, { death: 'flag' }, { fleets });
    await WaitFor('the loaded call fires with no order', 30, (polled) => (OnCall(polled, members, 'r1') && members.every((id) => (ShipIn(polled, id).combat?.lastHits ?? []).some((row) => row.target === 'r1')) ? null : Targets(polled, members)));
    const removed = await call<{ warnings: string[] }>('patch_scene', { operations: [{ op: 'remove_ship', id: 'r1' }] });
    Expect(
      removed.warnings.some((warning) => /fleet "b" no longer calls "r1" \(it was removed\)/u.test(warning)),
      Show(removed.warnings)
    );
    const doc = await call<{ fleets?: { targets?: string[] }[] }>('get_scene');
    Expect(Show(doc.fleets?.[0]?.targets) === '["r2"]', Show(doc.fleets?.[0]));
    await WaitFor('the members move to r2', 5, (polled) => (OnCall(polled, members, 'r2') ? null : Targets(polled, members)));
    const refusals = {
      by: await Refusal({ fleet: 'b', by: 'p1', order: { type: 'targets', primary: 'r3' } }),
      own: await Refusal({ fleet: 'b', order: { type: 'targets', primary: 'p1' } }),
      celestial: await Refusal({ fleet: 'b', order: { type: 'targets', primary: 'celestial:40009087' } }),
      drop: await Refusal({ fleet: 'b', order: { type: 'targets', drop: ['r3'] } })
    };
    Expect(/command/u.test(refusals.by) && /cannot call one of its own ships/u.test(refusals.own) && /celestial/u.test(refusals.celestial) && /does not call "r3"/u.test(refusals.drop), Show(refusals));
    await call<EngageResult>('engage', { ships: members, target: 'r3' });
    await WaitFor('r3 dies', 90, (polled) => (ShipIn(polled, 'r3').destroyed ? null : Show(ShipIn(polled, 'r3').defense)));
    const dead = await Refusal({ fleet: 'b', order: { type: 'targets', primary: 'r3' } });
    Expect(/target "r3" was destroyed/u.test(dead), dead);
    await call('order_fleet', { fleet: 'b', order: { type: 'targets', clear: true } });
    const empty = await Refusal({ fleet: 'b', order: { type: 'targets', next: true } });
    Expect(/calls no targets/u.test(empty), empty);
    // A live-only call is pruned on removal, and the emptied live list shadows the document's ["r2"].
    await call('order_fleet', { fleet: 'b', order: { type: 'targets', set: ['r4'] } });
    await WaitFor('the members take the live call on r4', 10, (polled) => (OnCall(polled, members, 'r4') ? null : Targets(polled, members)));
    const pruned = await call<{ warnings: string[] }>('patch_scene', { operations: [{ op: 'remove_ship', id: 'r4' }] });
    Expect(pruned.warnings.filter((warning) => /fleet "b" no longer calls "r4" \(it was removed\)/u.test(warning)).length === 1, Show(pruned.warnings));
    const shadowed = await WaitFor('the emptied live list calls nothing', 5, (polled) => (CalledOf(polled)?.targets === undefined && OnCall(polled, members, null) ? null : Show({ targets: CalledOf(polled)?.targets, ships: Targets(polled, members) })));
    const kept = await call<{ fleets?: { targets?: string[] }[] }>('get_scene');
    Expect(Show(kept.fleets?.[0]?.targets) === '["r2"]', Show(kept.fleets?.[0]));
    return `loaded call fired on r1; remove_ship r1 warned "${removed.warnings.find((warning) => /no longer calls/u.test(warning))}", list ${Show(doc.fleets?.[0]?.targets)}, members on r2; refused: ${Show({ ...refusals, dead, empty })}; a live call on r4 pruned at its removal ("${pruned.warnings.find((warning) => /r4/u.test(warning))}"), nobody called at tick ${shadowed.simulation.tick}, the document still ${Show(kept.fleets?.[0]?.targets)}`;
  });

  await Check('free fire: members with no call pick the nearest hostile in reach after their reaction; a call wins, off ends it', async () => {
    const Team = <T extends object>(ship: T, team: string, extra: object = {}) => ({ ...ship, team, ...extra });
    const ships = [Team(Punisher('bfc', [0, 0, 0]), 'blue'), Team(Punisher('p1', [0, 0, 1200]), 'blue', { pilot: { reaction: 0 } }), Team(Punisher('p2', [0, 0, -1200]), 'blue'), Team(Punisher('g1', [-1500, 0, 0]), 'blue'), Team(Tempest('r1', [3000, 0, 0]), 'red'), Team(Tempest('r2', [3000, 0, 5000]), 'red')];
    const fleets = [
      {
        id: 'b',
        commander: 'bfc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'dps', role: 'dps', members: ['p1', 'p2'] },
              { id: 'g', role: 'logi', members: ['g1'] }
            ]
          }
        ]
      }
    ];
    await LoadCombatScene(ships, { death: 'flag' }, { fleets });
    const order = await call<FleetTargetsOrderResult & { readonly freeFire?: boolean }>('order_fleet', { fleet: 'b', order: { type: 'free-fire', on: true } });
    const reaction = order.delays?.['p1'] ?? 0;
    Expect(order.freeFire === true && reaction >= 5 && reaction <= 10 && !order.delays?.['p2'], `p1 (reaction 0) answers in 5-10 s, p2 (none) at once: ${Show(order)}`);
    const Free = (state: ViewerState, id: string, target: string): boolean => ShipIn(state, id).target?.id === target && ShipIn(state, id).target?.source === 'free' && ShipIn(state, id).call?.state === 'free-fire';
    const picked = await WaitFor('bfc and p2 pick r1 at once and fire; g1 (logi) does not', 10, (polled) => {
      const fired = ['bfc', 'p2'].every((id) => (ShipIn(polled, id).combat?.lastHits ?? []).some((row) => row.target === 'r1'));
      return Free(polled, 'bfc', 'r1') && Free(polled, 'p2', 'r1') && ShipIn(polled, 'g1').target == null && ShipIn(polled, 'p1').call?.state === 'responding' && fired ? null : Show({ targets: Targets(polled, ['bfc', 'p1', 'p2', 'g1']), calls: ['bfc', 'p1', 'p2', 'g1'].map((id) => ShipIn(polled, id).call) });
    });
    const late = await WaitFor('p1 picks r1 after its reaction', 15, (polled) => (Free(polled, 'p1', 'r1') ? null : Show(ShipIn(polled, 'p1').call)), 1);
    const p1At = late.simulation.tick - order.tick;
    Expect(Math.abs(p1At - reaction) <= 1, `p1 picked ${p1At} ticks after the order, its reaction ${reaction}`);
    const kept = await call<{ skipped: { id: string; reason: string }[] }>('set_target', { ships: ['p2'], target: null });
    Expect(/free-fires on "r1"/u.test(kept.skipped[0]?.reason ?? ''), Show(kept));
    await call('order_fleet', { fleet: 'b', delay: 0, order: { type: 'targets', set: ['r2'] } });
    const all = ['bfc', 'p1', 'p2'];
    await WaitFor('a call (delay 0) takes every free-firer onto r2 at once', 5, (polled) => (OnCall(polled, all, 'r2') ? null : Targets(polled, all)));
    await call('order_fleet', { fleet: 'b', delay: 0, order: { type: 'targets', clear: true } });
    const back = await WaitFor('the call cleared: bfc and p2 pick r1 again at once, p1 after its reaction', 20, (polled) => (all.every((id) => Free(polled, id, 'r1')) ? null : Targets(polled, all)), 1);
    await call('order_fleet', { fleet: 'b', order: { type: 'free-fire', on: false } });
    const off = await WaitFor('free fire off clears the picks', 5, (polled) => (all.every((id) => ShipIn(polled, id).target == null) ? null : Targets(polled, all)));
    const tree = CalledOf(off) as Maybe<CalledTree & { readonly freeFire?: boolean }>;
    Expect(!tree?.freeFire, Show(tree));
    return `free fire at tick ${order.tick}: bfc, p2 on r1 by tick ${picked.simulation.tick}, p1 (reaction 0) ${p1At} ticks later (its delay ${reaction}); set_target null skipped p2; a call took all three onto r2, clearing it gave r1 back (tick ${back.simulation.tick}); off cleared them`;
  });

  await Check('personality: the FC brain calls the nearest hostile as its FC; a model call takes the lever, a dead FC hands over, set_fleet_personality hands it back', async () => {
    const Team = <T extends object>(ship: T, team: string) => ({ ...ship, team });
    const ships = [Team(Punisher('bfc', [0, 0, 0]), 'blue'), Team(Punisher('p1', [0, 0, 1200]), 'blue'), Team(Punisher('p2', [0, 0, -1200]), 'blue'), Team(Punisher('k1', [2500, 0, 0]), 'red'), Team(Punisher('k2', [2500, 0, 1500]), 'red')];
    // Ability 1 and reaction 1: every decision at the boundary it is wanted, every pilot at once; a 4 s handover (2 s at
    // ability 1). It holds position and fires on sight, so only the call lever pulls.
    const verify = { schema: 'cjs-fleet-personality/1', command: { ability: 1, backups: 2, handover: 4 }, pilots: { reaction: 1 }, engage: 'on-sight', targeting: { queue: 1, freeFire: false }, movement: { stance: 'hold', propMods: 'never' } };
    const fleets = [{ id: 'b', commander: 'bfc', personality: 'verify', wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', members: ['p1', 'p2'] }] }] }];
    await LoadCombatScene(ships, { death: 'explode' }, { fleets, personalities: { verify } });
    const Fc = (state: ViewerState): Maybe<FleetBrainState> => state.fleets.find((fleet) => fleet.id === 'b')?.fc ?? null;
    const Called = (state: ViewerState, ids: readonly string[], target: string): boolean => ids.every((id) => ShipIn(state, id).target?.id === target && ShipIn(state, id).target?.source === 'called');
    const called = await WaitFor('the brain calls k1 (the nearest) as bfc and the members shoot it', 20, (polled) => {
      const fc = Fc(polled);
      const call = fc?.decisions.find((decision) => decision.tool === 'order_fleet' && decision.args.order?.type === 'targets');
      return fc?.state === 'commanding' && call?.args.by === 'bfc' && call.args.order?.set?.[0] === 'k1' && Called(polled, ['bfc', 'p1', 'p2'], 'k1') ? null : Show({ fc, targets: Targets(polled, ['bfc', 'p1', 'p2']) });
    });
    const pilots = ['bfc', 'p1'].map((id) => ShipIn(called, id) as ShipState & { readonly pilot?: { readonly command?: number; readonly reaction?: number; readonly source?: string } });
    Expect(pilots[0].pilot?.command === 1 && pilots[0].pilot.reaction === 1 && pilots[0].pilot.source === 'personality' && pilots[1].pilot?.reaction === 1, Show(pilots.map((ship) => ship.pilot)));
    const manualAt = (await call<{ readonly tick: number }>('order_fleet', { fleet: 'b', delay: 0, order: { type: 'targets', set: ['k2'] } })).tick;
    await Delay(3000);
    const manual = await call<ViewerState>('get_state');
    Expect(Show(Fc(manual)?.manual) === '["call","free-fire"]' && Called(manual, ['bfc', 'p1', 'p2'], 'k2') && !(Fc(manual)?.decisions ?? []).some((decision) => decision.tick > manualAt), `the model's call stands, the brain silent: ${Show({ fc: Fc(manual), targets: Targets(manual, ['bfc', 'p1', 'p2']) })}`);
    await call('cease_fire', { fleet: 'b' });
    await call<EngageResult>('engage', { ships: ['k1', 'k2'], target: 'bfc' });
    const dead = await WaitFor('bfc dies and the designate flies as the root, taking command after its handover', 90, (polled) => {
      const fleet = polled.fleets.find((candidate) => candidate.id === 'b');
      return ShipIn(polled, 'bfc').destroyed && fleet?.actingFor === 'bfc' && fleet.fc?.state === 'handover' && fleet.fc.successor === fleet.commander && (fleet.fc.takesOverIn ?? 9) <= 2
        ? null
        : Show({ destroyed: ShipIn(polled, 'bfc').destroyed, commander: fleet?.commander, actingFor: fleet?.actingFor, fc: fleet?.fc });
    });
    const heir = dead.fleets.find((fleet) => fleet.id === 'b')?.commander ?? '';
    const commanding = await WaitFor('the designate commands', 10, (polled) => (Fc(polled)?.state === 'commanding' && Fc(polled)?.ship === heir ? null : Show(Fc(polled))));
    Expect(Fc(commanding)?.held === true && Show(Fc(commanding)?.manual) === '["call","free-fire"]', `cease_fire still holds the levers: ${Show(Fc(commanding))}`);
    await call('set_fleet_personality', { fleet: 'b', personality: 'verify' });
    const back = await WaitFor('set_fleet_personality hands the levers back: the survivors shoot the call again', 15, (polled) => {
      const fc = Fc(polled);
      const live = ['p1', 'p2'].filter((id) => !ShipIn(polled, id).destroyed);
      return fc && !fc.manual.length && !fc.held && live.every((id) => ShipIn(polled, id).call?.state === 'following') ? null : Show({ fc, calls: live.map((id) => ShipIn(polled, id).call) });
    });
    return `brain call on k1 by bfc at tick ${called.simulation.tick}; the model's call on k2 at ${manualAt} took call + free fire; bfc died at ${ShipIn(dead, 'bfc').destroyed?.tick}, ${heir} took command at ${commanding.simulation.tick}; handed back at ${back.simulation.tick}, ${Fc(back)?.decisions.length} decisions`;
  });

  // A Guardian with a thermal hardener, an AB and two remote armor reps, 3 km off a fitted TFI it reps.
  const LOGI_FIT = ['[Guardian, Verify Logi]', 'Domination Thermal Armor Hardener', 'Damage Control II', '', '10MN Afterburner II', '', 'Large Remote Armor Repairer II', 'Large Remote Armor Repairer II'].join('\n');
  const modulesScene = {
    name: 'verify-modules',
    ships: [
      { id: 'logi', dna: 'ac3_t2:carthum:amarr', type: 'Guardian', fit: LOGI_FIT, position: [0, 0, 0] },
      { id: 'tfi', dna: 'mb2_t1:minmatarnavy:minmatar', type: 'Tempest Fleet Issue', fit: '[Tempest Fleet Issue, Bare]', position: [3000, 0, 0] }
    ]
  };
  const ModuleRow = (state: ViewerState, id: string, key: string): ShipModuleRowState => {
    const row = ShipIn(state, id).fit?.modules.find((module) => module.module === key);
    if (!row) throw new Error(`${id} has no module ${key}: ${JSON.stringify(ShipIn(state, id).fit)}`);
    return row;
  };
  let modulesLoaded = false;
  // Each module check runs on its own (--only): the first one to run loads the scene.
  const LoadModulesScene = async (): Promise<ViewerState> => {
    await call<ShipStatsAnswer>('ship_stats', { type: 11987 }).catch(SkipWithoutSde);
    if (!modulesLoaded) await call('load_scene', { scene: modulesScene });
    modulesLoaded = true;
    return WaitFor('the Guardian and TFI fits resolve', 60, (polled) => {
      const table = ['logi', 'tfi'].map((id) => ShipIn(polled, id)).find((ship) => ship.fit?.math !== 'dogma' || !ship.defense);
      return table ? `${table.id}: ${JSON.stringify(table.fit?.note ?? table.fit)}` : null;
    });
  };

  await Check('a fit without guns gets no default guns', async () => {
    const state = await LoadModulesScene();
    const fits = ['logi', 'tfi'].map((id) => ShipIn(state, id).fit);
    const guns = fits.flatMap((fit) => fit?.modules.filter((module) => module.module.startsWith('high-') && /cannon|laser|railgun|blaster|launcher/iu.test(module.name)) ?? []);
    Expect(fits.every((fit) => fit && fit.key === 'inline' && !fit.default) && !guns.length, JSON.stringify({ keys: fits.map((fit) => fit?.key), guns }));
    return 'the Guardian logi fit and the bare TFI keep their own fits: no guns';
  });

  await Check("switch_modules runs a Guardian's armor hardener on EVE's timing", async () => {
    const before = await LoadModulesScene();
    const thermal = ShipIn(before, 'logi').defense?.armor.resists.thermal ?? Number.NaN;
    Expect(ModuleRow(before, 'logi', 'low-0').state === 'online', JSON.stringify(ModuleRow(before, 'logi', 'low-0')));
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['hardener'], state: 'active' });
    Expect(on.ships[0]?.modules[0]?.module === 'low-0' && on.ships[0].modules[0].state === 'activating' && !on.skipped.length, JSON.stringify(on));
    const running = await WaitFor('the hardener runs and raises thermal resist', 10, (polled) => {
      const row = ModuleRow(polled, 'logi', 'low-0');
      const now = ShipIn(polled, 'logi').defense?.armor.resists.thermal ?? Number.NaN;
      return row.state === 'active' && row.cycle && now > thermal + 1 ? null : `${JSON.stringify(row)}, thermal ${now} (was ${thermal})`;
    });
    const raised = ShipIn(running, 'logi').defense?.armor.resists.thermal ?? Number.NaN;
    const off = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['low-0'], state: 'online' });
    const stopping = off.ships[0]?.modules[0];
    Expect(stopping?.state === 'stopping' && (stopping.stopsIn ?? 0) > 0, JSON.stringify(off));
    const passive = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['damage-control', 'weapon'], state: 'active' });
    Expect(passive.skipped.some((skip) => skip.module === 'low-1' && /passive/.test(skip.reason)) && passive.skipped.some((skip) => skip.module === 'weapon'), JSON.stringify(passive.skipped));
    // The Domination hardener cycles 24 s in SDE 3632936.
    await WaitFor('the hardener stops at its cycle end and thermal resist falls back', 35, (polled) => {
      const row = ModuleRow(polled, 'logi', 'low-0');
      const now = ShipIn(polled, 'logi').defense?.armor.resists.thermal ?? Number.NaN;
      return (row.state === 'online' || row.state === 'reactivating') && Close(now, thermal) ? null : `${JSON.stringify(row)}, thermal ${now} (was ${thermal})`;
    });
    return `thermal ${thermal} % -> ${raised} % while active, back after a ${stopping?.stopsIn} s stop; passive and unmatched selectors skipped`;
  });

  await Check('switch_modules prop matches switch_prop_mods', async () => {
    await LoadModulesScene();
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['prop'], state: 'active' });
    Expect(on.ships[0]?.modules[0]?.module === 'mid-0' && on.ships[0].modules[0].state === 'activating', JSON.stringify(on));
    const state = await WaitFor('the AB runs as the prop mod', 10, (polled) => {
      const ship = ShipIn(polled, 'logi');
      const row = ModuleRow(polled, 'logi', 'mid-0');
      return ship.propMod?.state === 'active' && row.state === 'active' && ship.physics?.maxVelocity === ship.propMod.maxVelocity ? null : `${JSON.stringify(row)}, propMod ${JSON.stringify(ship.propMod)}, maxVelocity ${ship.physics?.maxVelocity}`;
    });
    const offline = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['mid-0'], state: 'offline' });
    Expect(!offline.ships.length && /never switched offline/.test(offline.skipped[0]?.reason ?? ''), JSON.stringify(offline));
    const off = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['logi'], active: false });
    Expect(off.ships[0]?.state === 'stopping', JSON.stringify(off));
    const after = await call<ViewerState>('get_state');
    Expect(ModuleRow(after, 'logi', 'mid-0').state === 'stopping', JSON.stringify(ModuleRow(after, 'logi', 'mid-0')));
    return `mid-0 ${ModuleRow(state, 'logi', 'mid-0').name} active at ${ShipIn(state, 'logi').physics?.maxVelocity} m/s through Destiny; switch_prop_mods off reads stopping in its row; offline refused`;
  });

  await Check('remote reps take a target and stop when it is removed', async () => {
    await LoadModulesScene();
    const untargeted = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['remote-armor-repairer'], state: 'active' });
    Expect(!untargeted.ships.length && untargeted.skipped.length === 2 && untargeted.skipped.every((skip) => /needs a target/.test(skip.reason)), JSON.stringify(untargeted));
    const on = await call<SwitchModulesResult>('switch_modules', { ships: ['logi'], modules: ['remote-armor-repairer'], state: 'active', target: 'tfi' });
    Expect(on.ships[0]?.modules.length === 2 && on.ships[0].modules.every((module) => module.state === 'activating' && module.target === 'tfi'), JSON.stringify(on));
    // Remote reps wait for the Guardian's lock on the TFI (1.937 s at SDE 3632936, so 2 ticks) in activating.
    const held = await WaitFor('both reps wait in activating for the lock on the TFI', 5, (polled) => {
      const rows = ['high-0', 'high-1'].map((key) => ModuleRow(polled, 'logi', key));
      const lock = (ShipIn(polled, 'logi').locks ?? []).find((entry) => entry.target === 'tfi');
      return rows.every((row) => row.state === 'activating' && /waiting for its lock on "tfi"/u.test(row.note ?? '')) && lock?.state === 'locking' ? null : `${JSON.stringify(rows)}, lock ${JSON.stringify(lock)}`;
    });
    const lock = (ShipIn(held, 'logi').locks ?? []).find((entry) => entry.target === 'tfi');
    Expect(Math.abs((lock?.lockTime ?? 0) - 1.937) < 0.01, `lock time ${JSON.stringify(lock)}`);
    const running = await WaitFor('both reps run on the TFI once locked', 10, (polled) => {
      const rows = ['high-0', 'high-1'].map((key) => ModuleRow(polled, 'logi', key));
      const incoming = ShipIn(polled, 'tfi').defense?.incoming ?? [];
      const locked = (ShipIn(polled, 'logi').locks ?? []).some((entry) => entry.target === 'tfi' && entry.state === 'locked');
      return locked && rows.every((row) => row.state === 'active' && row.target === 'tfi' && row.effectiveness === 1) && incoming.length === 2 ? null : `${JSON.stringify(rows)}, incoming ${JSON.stringify(incoming)}`;
    });
    const activeAt = running.simulation.tick;
    Expect(activeAt - held.simulation.tick <= 3, `active at tick ${activeAt}, held at ${held.simulation.tick}`);
    const incoming = ShipIn(running, 'tfi').defense?.incoming ?? [];
    // The armor reps land at their 6 s cycle end; the TFI is at full armor, so each restores 0 of its nominal 512.
    const landed = await WaitFor('the first rep cycle lands on the TFI', 10, (polled) => {
      const rows = ShipIn(polled, 'tfi').combat?.repairs?.lastReceived ?? [];
      return rows.length >= 2 ? null : `lastReceived ${JSON.stringify(rows)}`;
    });
    const repairs = ShipIn(landed, 'tfi').combat?.repairs;
    const first = repairs?.lastReceived ?? [];
    Expect(first.length >= 2 && first.slice(0, 2).every((row) => row.from === 'logi' && row.layer === 'armor' && row.nominal === 512 && row.amount === 0 && Math.abs(row.tick - (activeAt + 6)) <= 1), `activated by tick ${activeAt}: ${JSON.stringify(repairs)}`);
    Expect(ShipIn(landed, 'logi').combat?.repairs?.given === 0, JSON.stringify(ShipIn(landed, 'logi').combat?.repairs));
    await call('patch_scene', { operations: [{ op: 'remove_ship', id: 'tfi' }] });
    await WaitFor('the reps stop at once when their target is removed', 5, (polled) => {
      const rows = ['high-0', 'high-1'].map((key) => ModuleRow(polled, 'logi', key));
      return rows.every((row) => row.state !== 'active' && row.state !== 'stopping' && !row.target && /target is gone/.test(row.note ?? '')) ? null : JSON.stringify(rows);
    });
    return `2 Large Remote Armor Repairer II on tfi after a ${lock?.lockTime} s lock (held at tick ${held.simulation.tick}, active by ${activeAt}; incoming ${JSON.stringify(incoming.map((repair) => repair.module))}); first landings ${JSON.stringify(first.slice(0, 2).map((row) => ({ tick: row.tick, amount: row.amount, nominal: row.nominal })))}; stopped with "its target is gone" on its removal`;
  });

  // Logi auto-repair (L3): Guardians with two Large Remote Armor Repairer II in a logi squad repair the fleet member a
  // default-fit Rifter shoots, on their own. Each check loads its own scene; death flag (no explosions to wait out).
  const LOGI_AUTO_FIT = ['[Guardian, Verify Auto Logi]', 'Damage Control II', '', '10MN Afterburner II', '', 'Large Remote Armor Repairer II', 'Large Remote Armor Repairer II'].join('\n');
  const Guardian = (id: string, position: SceneVector) => ({ id, dna: GUARDIAN_DNA, type: 'Guardian', fit: LOGI_AUTO_FIT, position });
  const Red = (ship: { readonly id: string }) => ({ ...ship, team: 'red' });
  const LogiFleet = (id: string, commander: string, logi: string[], extra: { readonly dps?: string[]; readonly autoRepair?: object } = {}) => ({
    id,
    commander,
    wings: [{ id: `${id}-w`, squads: [...(extra.dps ? [{ id: `${id}-dps`, role: 'dps', members: extra.dps }] : []), { id: id === 'b' ? 'logi' : `${id}-logi`, role: 'logi', members: logi, ...(extra.autoRepair ? { autoRepair: extra.autoRepair } : {}) }] }]
  });
  const RepRows = (state: ViewerState, id: string): ShipModuleRowState[] => (ShipIn(state, id).fit?.modules ?? []).filter((module) => module.name === 'Large Remote Armor Repairer II');
  const ArmorOf = (state: ViewerState, id: string): { hp: number; max: number } => ShipIn(state, id).defense?.armor ?? { hp: Number.NaN, max: Number.NaN };
  const WaitLogiIdle = (id: string) =>
    WaitFor(`${id} auto-repair is idle before the fight`, 20, (polled) => {
      const autoRepair = ShipIn(polled, id).autoRepair;
      return autoRepair?.state === 'idle' ? null : Show(autoRepair);
    });
  const LoadLogiCheckOne = async (): Promise<ViewerState> => {
    await LoadCombatScene([Punisher('b1', [0, 0, 0]), Guardian('g1', [0, 0, -30000]), Red(Rifter('r1', [0, 0, 3000]))], { death: 'flag' }, { fleets: [LogiFleet('b', 'b1', ['g1'])] });
    return WaitLogiIdle('g1');
  };

  await Check('logi: a logi locks the shot member and lands its reps at cycle end', async () => {
    const before = await LoadLogiCheckOne();
    const idle = ShipIn(before, 'g1').autoRepair;
    Expect(idle?.state === 'idle' && idle.on && idle.source === 'default' && idle.policy === 'urgent', `before the fight: ${Show(idle)}`);
    const engaged = await call<EngageResult>('engage', { ships: ['r1'], target: 'b1' });
    const start = engaged.tick;
    let lockAt: Maybe<number> = null;
    let takenAt: Maybe<number> = null;
    let activeAt: Maybe<number> = null;
    const states: string[] = [];
    const landed = await WaitFor('g1 lands its first reps on b1', 40, (polled) => {
      const tick = polled.simulation.tick;
      const g1 = ShipIn(polled, 'g1');
      const b1 = ShipIn(polled, 'b1');
      if (lockAt == null && (g1.locks ?? []).some((lock) => lock.target === 'b1')) lockAt = tick;
      const firstTaken = (b1.combat?.lastTaken ?? []).map((row) => row.tick).sort((a, b) => a - b)[0];
      if (takenAt == null && firstTaken != null) takenAt = firstTaken;
      const rows = RepRows(polled, 'g1');
      if (activeAt == null && rows.length === 2 && rows.every((row) => row.state === 'active' && row.target === 'b1')) activeAt = tick;
      const state = g1.autoRepair?.state ?? 'none';
      if (states[states.length - 1] !== state) states.push(state);
      return (b1.combat?.repairs?.lastReceived ?? []).some((row) => row.from === 'g1') ? null : `g1 ${Show(g1.autoRepair)}, reps ${Show(rows)}`;
    });
    const g1 = ShipIn(landed, 'g1');
    const b1 = ShipIn(landed, 'b1');
    Expect(lockAt != null && takenAt != null && lockAt <= takenAt + 1, `lock at ${lockAt}, first damage at ${takenAt}`);
    Expect(states.includes('locking') && states.indexOf('locking') < states.indexOf('repairing'), `states ${states.join(' -> ')}`);
    Expect(g1.autoRepair?.target === 'b1' && g1.autoRepair.reason === 'under-fire', Show(g1.autoRepair));
    const rows = RepRows(landed, 'g1');
    Expect(rows.length === 2 && rows.every((row) => row.target === 'b1' && row.effectiveness === 1), `reps ${Show(rows)}`);
    const incoming = (b1.defense?.incoming ?? []).filter((row) => row.from === 'g1');
    Expect(incoming.length === 2, `b1 incoming ${Show(b1.defense?.incoming)}`);
    const first = (b1.combat?.repairs?.lastReceived ?? []).filter((row) => row.from === 'g1');
    Expect(activeAt != null && first.every((row) => Math.abs(row.tick - ((activeAt ?? 0) + 6)) <= 1 && row.nominal === 512), `active at ${activeAt}: ${Show(first)}`);
    Expect(
      first.some((row) => row.amount > 0),
      `b1's armor rises at the landing: ${Show(first)}, armor ${Show(ArmorOf(landed, 'b1'))}`
    );
    return `engaged at ${start}: lock at ${lockAt}, first damage ${takenAt}, reps active ${activeAt}, first landing ${first[0]?.tick} (${first.map((row) => String(row.amount) + '/' + String(row.nominal)).join(', ')}); ${states.join(' -> ')}; why "${g1.autoRepair?.why}"`;
  });

  await Check('logi: reps hold a member up; the same fight without auto-repair kills it', async () => {
    await LoadCombatScene(
      [Punisher('b1', [0, 0, 0]), Guardian('g1', [0, 0, -30000]), Punisher('c1', [20000, 0, 0]), Guardian('h1', [20000, 0, -30000]), Red(Rifter('r1', [0, 0, 3000])), Red(Rifter('r3', [20000, 0, 3000]))],
      { death: 'flag' },
      { fleets: [LogiFleet('b', 'b1', ['g1']), LogiFleet('c', 'c1', ['h1'], { autoRepair: { on: false } })] }
    );
    await WaitLogiIdle('g1');
    await call<EngageResult>('engage', { ships: ['r1'], target: 'b1' });
    const engaged = await call<EngageResult>('engage', { ships: ['r3'], target: 'c1' });
    const dead = await WaitFor('c1 dies without reps', 45, (polled) => (ShipIn(polled, 'c1').destroyed ? null : `c1 armor ${Show(ArmorOf(polled, 'c1'))}, structure ${Show(ShipIn(polled, 'c1').defense?.structure?.hp)}`));
    const b1 = ShipIn(dead, 'b1');
    const c1 = ShipIn(dead, 'c1');
    const armor = ArmorOf(dead, 'b1');
    Expect(!b1.destroyed && armor.hp >= 0.4 * armor.max && (b1.combat?.repairs?.received ?? 0) >= 600, `b1 ${Show({ destroyed: b1.destroyed, armor, repairs: b1.combat?.repairs })}`);
    const h1 = ShipIn(dead, 'h1');
    Expect(h1.autoRepair?.state === 'off' && RepRows(dead, 'h1').every((row) => row.state === 'online'), `h1 ${Show(h1.autoRepair)}, reps ${Show(RepRows(dead, 'h1'))}`);
    const [takenB, takenC] = [b1.combat?.taken ?? 0, c1.combat?.taken ?? 0];
    Expect(Math.abs(takenB - takenC) <= 0.25 * Math.max(takenB, takenC), `taken b1 ${takenB}, c1 ${takenC}`);
    // A Destiny tick is 1 s.
    const seconds = dead.simulation.tick - engaged.tick;
    return `c1 died ${seconds.toFixed(0)} s in (taken ${takenC.toFixed(0)} HP); b1 held at armor ${armor.hp.toFixed(0)}/${armor.max.toFixed(0)} (taken ${takenB.toFixed(0)}, repaired ${b1.combat?.repairs?.received.toFixed(0)}); h1 ${h1.autoRepair?.state}`;
  });

  await Check('logi: two logi split over two shot members', async () => {
    await LoadCombatScene([Punisher('b1', [0, 0, 0]), Punisher('b2', [1500, 0, 0]), Guardian('g1', [0, 0, -30000]), Guardian('g2', [1000, 0, -30000]), Red(Rifter('r1', [0, 0, 3000])), Red(Rifter('r2', [1500, 0, 3000]))], { death: 'flag' }, { fleets: [LogiFleet('b', 'b1', ['g1', 'g2'], { dps: ['b2'] })] });
    await WaitLogiIdle('g2');
    await call<EngageResult>('engage', { ships: ['r1'], target: 'b1' });
    await call<EngageResult>('engage', { ships: ['r2'], target: 'b2' });
    const split = await WaitFor('g1 and g2 repair b1 and b2', 25, (polled) => {
      const reports = ['g1', 'g2'].map((id) => ShipIn(polled, id).autoRepair);
      const targets = new Set(reports.map((report) => report?.target));
      const fleet = polled.fleets.find((row) => row.id === 'b')?.autoRepair;
      return reports.every((report) => report?.state === 'repairing') && targets.has('b1') && targets.has('b2') && fleet?.targets.length === 2 && fleet.targets.every((row) => row.logi.length === 1) ? null : `${Show(reports.map((report) => [report?.state, report?.target, report?.reason]))}, fleet ${Show(fleet)}`;
    });
    const fleet = split.fleets.find((row) => row.id === 'b')?.autoRepair;
    return `targets ${Show(fleet?.targets)}; g1 "${ShipIn(split, 'g1').autoRepair?.why}", g2 "${ShipIn(split, 'g2').autoRepair?.why}"`;
  });

  await Check('logi: auto_repair turns a squad off and on; switch_modules takes a logi over until auto_repair hands it back', async () => {
    await LoadLogiCheckOne();
    await call<EngageResult>('engage', { ships: ['r1'], target: 'b1' });
    await WaitFor('g1 repairs b1', 20, (polled) => (ShipIn(polled, 'g1').autoRepair?.state === 'repairing' ? null : Show(ShipIn(polled, 'g1').autoRepair)));
    const off = await call<{ autoRepair: Maybe<{ on?: boolean; policy?: string }>; operations: { op: string }[] }>('auto_repair', { fleet: 'b', squad: 'logi', on: false });
    Expect(off.autoRepair?.on === false && off.operations.length === 1 && off.operations[0]?.op === 'update_squad', Show(off));
    const document = await call<{ fleets?: { wings: { squads: { id: string; autoRepair?: object }[] }[] }[] }>('get_scene');
    const squad = document.fleets?.[0]?.wings[0]?.squads.find((row) => row.id === 'logi');
    Expect(Show(squad?.autoRepair) === Show({ on: false }), `get_scene squad ${Show(squad)}`);
    const stopped = await WaitFor('g1 turns off and its reps stop at their cycle end', 8, (polled) => {
      const rows = RepRows(polled, 'g1');
      const incoming = (ShipIn(polled, 'b1').defense?.incoming ?? []).filter((row) => row.from === 'g1');
      return ShipIn(polled, 'g1').autoRepair?.state === 'off' && rows.every((row) => row.state === 'online') && !incoming.length ? null : `${Show(ShipIn(polled, 'g1').autoRepair?.state)}, reps ${Show(rows.map((row) => row.state))}, incoming ${incoming.length}`;
    });
    const damaged = await call<{ autoRepair: Maybe<{ on?: boolean; policy?: string }> }>('auto_repair', { fleet: 'b', squad: 'logi', on: null, policy: 'damaged' });
    Expect(Show(damaged.autoRepair) === Show({ policy: 'damaged' }), Show(damaged));
    await WaitFor('g1 repairs again on policy damaged', 15, (polled) => {
      const autoRepair = ShipIn(polled, 'g1').autoRepair;
      return autoRepair?.state === 'repairing' && autoRepair.policy === 'damaged' && autoRepair.policySource === 'squad' ? null : Show(autoRepair);
    });
    const manual = await call<SwitchModulesResult>('switch_modules', { ships: ['g1'], modules: ['remote-armor-repairer'], state: 'online' });
    Expect(
      (manual.notes ?? []).some((note) => note.includes('"g1"')),
      Show(manual)
    );
    const held = Date.now();
    while (Date.now() - held < 10_000) {
      const polled = await call<ViewerState>('get_state');
      const autoRepair = ShipIn(polled, 'g1').autoRepair;
      Expect(autoRepair?.state === 'manual' && RepRows(polled, 'g1').every((row) => row.state !== 'active' && row.state !== 'activating'), `manual: ${Show(autoRepair)}, reps ${Show(RepRows(polled, 'g1'))}`);
      await Delay(1000);
    }
    await call('auto_repair', { fleet: 'b', squad: 'logi', on: true });
    const back = await WaitFor('auto_repair hands g1 back', 15, (polled) => (ShipIn(polled, 'g1').autoRepair?.state === 'repairing' ? null : Show(ShipIn(polled, 'g1').autoRepair)));
    const refusals: string[] = [];
    for (const args of [{ ships: ['g1'], on: true }, { fleet: 'b', policy: 'bogus' }, { fleet: 'b' }, { fleet: 'nope', on: true }]) {
      let refused = 'accepted';
      try {
        await call('auto_repair', args);
      } catch (error) {
        refused = ErrorMessage(error);
      }
      Expect(refused !== 'accepted', `auto_repair ${Show(args)} was accepted`);
      refusals.push(
        refused
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) ?? refused
      );
    }
    return `off at ${stopped.simulation.tick}, back on ${ShipIn(back, 'g1').autoRepair?.target} (${ShipIn(back, 'g1').autoRepair?.policy}); refusals: ${refusals.join(' | ')}`;
  });

  // Tackle: a Rifter with a web, a scram and a point at the origin; 3 km off it a Guardian with two neuts and a cap
  // transmitter, a bare TFI (dogma path, live capacitor) and an unfitted Rifter (its default fit's 5MN MWD); 3 km off
  // the Guardian a Minmatar Shuttle (no weapon hardpoints, so no default fit: the table path, no live capacitor).
  const TACKLE_FIT = ['[Rifter, Verify Tackle]', 'Stasis Webifier II', 'Warp Scrambler II', 'Warp Disruptor II'].join('\n');
  const NEUT_FIT = ['[Guardian, Verify Neut]', 'Heavy Energy Neutralizer II', 'Heavy Energy Neutralizer II', 'Large Remote Capacitor Transmitter II'].join('\n');
  const TFI_HOME: SceneVector = [3000, 0, 0];
  const tackleScene = {
    name: 'verify-tackle',
    ships: [
      { id: 'tackle', dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter', fit: TACKLE_FIT, position: [0, 0, 0] },
      { id: 'neut', dna: GUARDIAN_DNA, type: 'Guardian', fit: NEUT_FIT, position: [0, 0, 3000] },
      { id: 'tfi', dna: TFI_DNA, type: 'Tempest Fleet Issue', fit: '[Tempest Fleet Issue, Bare]', position: TFI_HOME },
      { id: 'free', dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter', position: [-3000, 0, 0] },
      { id: 'shuttle', dna: 'ms1_t1:minmatarbase:minmatar', type: 'Minmatar Shuttle', position: [0, 3000, 3000] }
    ]
  };
  const MaxVelocityOf = (state: ViewerState, id: string): number => ShipIn(state, id).physics?.maxVelocity ?? Number.NaN;
  const KeysNamed = (state: ViewerState, id: string, name: string): string[] => (ShipIn(state, id).fit?.modules ?? []).filter((module) => module.name === name).map((module) => module.module);
  let tackleLoaded = false;
  // Each tackle check runs on its own (--only): the first one to run loads the scene.
  const LoadTackleScene = async (): Promise<ViewerState> => {
    await call<ShipStatsAnswer>('ship_stats', { type: 587 }).catch(SkipWithoutSde);
    if (!tackleLoaded) await call('load_scene', { scene: tackleScene });
    tackleLoaded = true;
    return WaitFor('the tackle scene fits resolve', 60, (polled) => {
      const pending = ['tackle', 'neut', 'tfi', 'free'].map((id) => ShipIn(polled, id)).find((ship) => ship.fit?.math !== 'dogma' || ship.capacitor?.level == null || !ship.physics?.warpSpeed);
      if (pending) return `${pending.id}: ${JSON.stringify(pending.fit?.note ?? pending.fitNote ?? pending.fit)}`;
      const shuttle = ShipIn(polled, 'shuttle');
      return shuttle.fit == null && /no weapon hardpoints/u.test(shuttle.fitNote ?? '') && !shuttle.capacitor ? null : `shuttle: ${JSON.stringify({ fit: shuttle.fit, fitNote: shuttle.fitNote, capacitor: shuttle.capacitor })}`;
    });
  };

  await Check('webs slow their target and points pin it', async () => {
    const before = await LoadTackleScene();
    const base: Record<string, number> = { tfi: MaxVelocityOf(before, 'tfi'), free: MaxVelocityOf(before, 'free') };
    const webbed: string[] = [];
    for (const id of ['tfi', 'free']) {
      const on = await call<SwitchModulesResult>('switch_modules', { ships: ['tackle'], modules: ['web'], state: 'active', target: id });
      Expect(on.ships[0]?.modules[0]?.target === id && !on.skipped.length, JSON.stringify(on));
      const slowed = await WaitFor(`the web slows ${id} to 40 %`, 10, (polled) => {
        const ship = ShipIn(polled, id);
        const wanted = 0.4 * base[id];
        return Math.abs(MaxVelocityOf(polled, id) - wanted) <= 0.01 * wanted && ship.targeted?.speedFactor === 0.4 ? null : `maxVelocity ${ship.physics?.maxVelocity} (was ${base[id]}), targeted ${JSON.stringify(ship.targeted)}`;
      });
      webbed.push(`${id} ${base[id]} -> ${MaxVelocityOf(slowed, id)} m/s (speedFactor ${ShipIn(slowed, id).targeted?.speedFactor})`);
      await call('switch_modules', { ships: ['tackle'], modules: ['web'], state: 'online' });
      await WaitFor(`${id} gets its speed back once the web stops`, 10, (polled) => (Close(MaxVelocityOf(polled, id), base[id]) && ShipIn(polled, id).targeted == null ? null : `maxVelocity ${MaxVelocityOf(polled, id)}, targeted ${JSON.stringify(ShipIn(polled, id).targeted)}`));
    }
    const point = await call<SwitchModulesResult>('switch_modules', { ships: ['tackle'], modules: ['point'], state: 'active', target: 'tfi' });
    Expect(point.ships[0]?.modules[0]?.target === 'tfi' && !point.skipped.length, JSON.stringify(point));
    const pinned = await WaitFor('the point pins the TFI', 10, (polled) => {
      const targeted = ShipIn(polled, 'tfi').targeted;
      return targeted?.canWarp === false && targeted.warpScrambleStatus === 1 && /Warp Disruptor II/u.test(targeted.warpNote ?? '') ? null : JSON.stringify(targeted);
    });
    const far: SceneVector = [TFI_HOME[0], TFI_HOME[1], TFI_HOME[2] + 500000];
    let refused = 'accepted';
    try {
      await call('order_ship', { id: 'tfi', order: { type: 'warp', point: far } });
    } catch (error) {
      refused = ErrorMessage(error);
    }
    Expect(/cannot warp/u.test(refused), `a warp while pointed: ${refused}`);
    await call('switch_modules', { ships: ['tackle'], modules: ['point'], state: 'online' });
    // Warp Disruptor II cycles 5 s: the point holds until its cycle end.
    await WaitFor('the TFI can warp after the point stops', 10, (polled) => {
      const targeted = ShipIn(polled, 'tfi').targeted;
      return targeted == null || targeted.canWarp ? null : JSON.stringify(targeted);
    });
    await call('order_ship', { id: 'tfi', order: { type: 'warp', point: far } });
    const aligning = await WaitFor('the TFI aligns to warp', 5, (polled) => (ShipIn(polled, 'tfi').order?.type === 'warp' ? null : JSON.stringify(ShipIn(polled, 'tfi').order)));
    await call('order_ship', { id: 'tfi', order: { type: 'stop' } });
    await call('patch_scene', { operations: [{ op: 'update_ship', id: 'tfi', set: { position: TFI_HOME } }] });
    return `${webbed.join('; ')}; pointed: ${ShipIn(pinned, 'tfi').targeted?.warpNote}; refused "${refused}"; after the point's cycle end the warp was accepted (${ShipIn(aligning, 'tfi').warp?.phase ?? 'ordered'}), then placed back`;
  });

  await Check("a scram switches its target's MWD off and keeps it off", async () => {
    await LoadTackleScene();
    const on = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['free'], active: true });
    Expect(on.ships[0]?.state === 'activating', JSON.stringify(on));
    await WaitFor("free's MWD runs", 5, (polled) => (ShipIn(polled, 'free').propMod?.state === 'active' ? null : JSON.stringify(ShipIn(polled, 'free').propMod)));
    const scram = await call<SwitchModulesResult>('switch_modules', { ships: ['tackle'], modules: ['scram'], state: 'active', target: 'free' });
    Expect(scram.ships[0]?.modules[0]?.target === 'free' && !scram.skipped.length, JSON.stringify(scram));
    // The scram applies at the next 1 s boundary, and the MWD goes off on that boundary.
    const blocked = await WaitFor('the scram switches the MWD off', 3, (polled) => {
      const ship = ShipIn(polled, 'free');
      return ship.propMod?.state === 'off' && /warp scrambler blocks its microwarpdrive/u.test(ship.propMod.note ?? '') && ship.targeted?.mwdBlocked && ship.targeted.canWarp === false ? null : JSON.stringify({ propMod: ship.propMod, targeted: ship.targeted });
    });
    const refused = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['free'], active: true });
    Expect(!refused.ships.length && /cannot switch its prop mod on: a warp scrambler/u.test(refused.skipped[0]?.reason ?? ''), JSON.stringify(refused));
    const row = await call<SwitchModulesResult>('switch_modules', { ships: ['free'], modules: ['prop'], state: 'active' });
    Expect(!row.ships.length && /cannot switch its prop mod on/u.test(row.skipped[0]?.reason ?? ''), JSON.stringify(row));
    await call('switch_modules', { ships: ['tackle'], modules: ['scram'], state: 'online' });
    const released = await WaitFor('the scram stops at its cycle end', 10, (polled) => (ShipIn(polled, 'free').targeted == null ? null : JSON.stringify(ShipIn(polled, 'free').targeted)));
    Expect(ShipIn(released, 'free').propMod?.state === 'off', `the MWD after the scram: ${JSON.stringify(ShipIn(released, 'free').propMod)}`);
    const again = await call<SwitchPropModsResult>('switch_prop_mods', { ships: ['free'], active: true });
    Expect(again.ships[0]?.state === 'activating', JSON.stringify(again));
    await WaitFor("free's MWD runs again", 5, (polled) => (ShipIn(polled, 'free').propMod?.state === 'active' ? null : JSON.stringify(ShipIn(polled, 'free').propMod)));
    await call('switch_prop_mods', { ships: ['free'], active: false });
    return `${ShipIn(blocked, 'free').propMod?.name} ${ShipIn(blocked, 'free').propMod?.note}; switch-on refused: ${refused.skipped[0]?.reason}; stayed off after the scram, then switched on`;
  });

  await Check("neuts drain and transmitters refill a fitted target's capacitor", async () => {
    const before = await LoadTackleScene();
    const full = ShipIn(before, 'tfi').capacitor;
    if (!full || full.level == null) throw new Error(`tfi capacitor ${JSON.stringify(full)}`);
    const start = full.level;
    Expect(start >= full.capacity - 0.1, `tfi starts at ${start} of ${full.capacity} GJ`);
    const [neutKey, spareNeutKey] = KeysNamed(before, 'neut', 'Heavy Energy Neutralizer II');
    Expect(neutKey && spareNeutKey, JSON.stringify(ShipIn(before, 'neut').fit?.modules));
    const neut = await call<SwitchModulesResult>('switch_modules', { ships: ['neut'], modules: [neutKey], state: 'active', target: 'tfi' });
    Expect(neut.ships[0]?.modules[0]?.target === 'tfi' && !neut.skipped.length, JSON.stringify(neut));
    const drained = await WaitFor('the neut drains the TFI at its first cycle', 5, (polled) => {
      const ship = ShipIn(polled, 'tfi');
      const row = ship.targeted?.by.find((entry) => entry.module === neutKey);
      return row?.moved != null && (ship.capacitor?.level ?? Infinity) < start - 500 ? null : JSON.stringify({ capacitor: ship.capacitor, targeted: ship.targeted });
    });
    const neutRow = ShipIn(drained, 'tfi').targeted?.by.find((entry) => entry.module === neutKey);
    const low = ShipIn(drained, 'tfi').capacitor?.level ?? Number.NaN;
    Expect(neutRow?.moved != null && Math.abs(neutRow.moved - 600) <= 1 && start - low > 550 && start - low <= 600.1, `moved ${neutRow?.moved}, ${start} -> ${low} GJ`);
    // The neut cycles 24 s: stopped now, it lands nothing more.
    await call('switch_modules', { ships: ['neut'], modules: [neutKey], state: 'online' });
    const transmitter = await call<SwitchModulesResult>('switch_modules', { ships: ['neut'], modules: ['remote-capacitor'], state: 'active', target: 'tfi' });
    Expect(transmitter.ships[0]?.modules[0]?.target === 'tfi' && !transmitter.skipped.length, JSON.stringify(transmitter));
    const given: number[] = [];
    const topped = await WaitFor('the transmitter refills the TFI up to its capacity', 20, (polled) => {
      const ship = ShipIn(polled, 'tfi');
      const level = ship.capacitor?.level ?? Number.NaN;
      Expect(level <= (ship.capacitor?.capacity ?? 0) + 0.1, `over capacity: ${JSON.stringify(ship.capacitor)}`);
      const row = ship.targeted?.by.find((entry) => entry.category === 'remote-capacitor');
      if (row?.moved != null && given.at(-1) !== row.moved) given.push(row.moved);
      return row?.amount != null && given.some((moved) => moved < (row.amount ?? 0)) && level >= (ship.capacitor?.capacity ?? Infinity) - 0.1 ? null : JSON.stringify({ capacitor: ship.capacitor, row });
    });
    await call('switch_modules', { ships: ['neut'], modules: ['remote-capacitor'], state: 'online' });
    const spare = await call<SwitchModulesResult>('switch_modules', { ships: ['neut'], modules: [spareNeutKey], state: 'active', target: 'shuttle' });
    Expect(spare.ships[0]?.modules[0]?.target === 'shuttle' && !spare.skipped.length, JSON.stringify(spare));
    const unfitted = await WaitFor('a neut on the shuttle notes it has no live capacitor', 5, (polled) => {
      const row = ShipIn(polled, 'shuttle').targeted?.by.find((entry) => entry.module === spareNeutKey);
      return row?.note === 'no live capacitor (no fit)' && row.moved == null ? null : JSON.stringify(ShipIn(polled, 'shuttle').targeted);
    });
    await call('switch_modules', { ships: ['neut'], modules: [spareNeutKey], state: 'online' });
    const capacity = ShipIn(topped, 'tfi').capacitor?.capacity;
    return `neut moved ${neutRow?.moved} GJ: ${start} -> ${low} of ${capacity} GJ; the transmitter gave ${given.join(', ')} GJ up to ${ShipIn(topped, 'tfi').capacitor?.level}; the shuttle: "${ShipIn(unfitted, 'shuttle').targeted?.by[0]?.note}"`;
  });

  await Check('add_fleet_composition drops the TFIs fleet in formation', async () => {
    await call('load_scene', { scene: { name: 'verify-fleets', ships: [{ id: 'bystander', dna: 'mf1_t1:minmatarbase:minmatar' }] } });
    const result = await call<AddedFleetResult>('add_fleet_composition', { name: 'tfis', position: [0, 0, 80000], heading: 180, team: 'blue' });
    Expect(result.added.fleet === 'tfis' && result.added.ships.length === 44, JSON.stringify(result.added));
    Expect(result.changes['added'] === 44, JSON.stringify(result.changes));
    const good = rendering ? 'ready' : 'validated';
    const bad = result.ships.filter((ship) => ship.id.startsWith('tfis-') && ship.status !== good);
    Expect(!bad.length, `not ${good}: ${JSON.stringify(bad.slice(0, 3))}`);
    Expect(
      result.hulls.every((hull) => hull.dnaFrom === 'composition' && hull.radiusFrom === 'composition'),
      JSON.stringify(result.hulls)
    );

    const hullRadius = new Map(result.hulls.map((hull) => [hull.hull, hull.radius]));
    const radius = new Map(result.scene.ships.filter((ship) => ship.id.startsWith('tfis-')).map((ship) => [ship.id, hullRadius.get(ship.type) ?? 0]));
    const live = (await call<ViewerState>('get_state')).ships.filter((ship) => radius.has(ship.id));
    Expect(live.length === 44, `${live.length} tfis ships in get_state`);
    const at = new Map(live.map((ship) => [ship.id, ship]));
    // Spacing is checked on the document positions: the fleet may already be following (and, without the SDE,
    // re-forming to SOF radii) by the time the tool returns.
    const ships = result.scene.ships.filter((ship) => radius.has(ship.id));
    const placed = new Map(ships.map((ship) => [ship.id, ship.position]));
    const fc = at.get('tfis-fc');
    Expect(fc?.anchor === null && JSON.stringify(fc.commands) === '["fleet"]', `tfis-fc: ${JSON.stringify(fc)}`);
    const anchors: [string, object][] = [
      ['tfis-dps-a-01', { ship: 'tfis-fc', range: 1000 }],
      ['tfis-logi-02', { ship: 'tfis-logi-01', range: 1000 }],
      ['tfis-fax-01', { ship: 'tfis-logi-01', range: 5000 }]
    ];
    for (const [id, anchor] of anchors) Expect(JSON.stringify(at.get(id)?.anchor) === JSON.stringify(anchor), `${id}: ${JSON.stringify(at.get(id)?.anchor)}`);

    const origin = placed.get('tfis-fc') ?? [0, 0, 0];
    let smallestGap = Infinity;
    for (const [index, a] of ships.entries()) {
      Expect(origin[2] - (a.position?.[2] ?? 0) <= 1, `${a.id} is ahead of the FC: ${JSON.stringify(a.position)}`);
      for (const b of ships.slice(index + 1)) {
        const [ra, rb] = [radius.get(a.id) ?? 0, radius.get(b.id) ?? 0];
        const [pa, pb] = [a.position ?? origin, b.position ?? origin];
        const apart = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
        Expect(apart >= formationSpacing(ra, rb) - 1, `${a.id} and ${b.id} are ${apart.toFixed(0)} m apart`);
        smallestGap = Math.min(smallestGap, apart - ra - rb);
      }
    }
    const lead = placed.get('tfis-logi-01') ?? origin;
    tfis = result;
    return `44 ships, smallest surface gap ${smallestGap.toFixed(0)} m, logi lead ${Math.hypot(lead[0] - origin[0], lead[1] - origin[1], lead[2] - origin[2]).toFixed(0)} m off the FC`;
  });

  await Check('a fleet added in formation starts following without a scramble', async () => {
    const added = tfis;
    if (!added) throw new Skipped('the TFIs fleet was not added');
    const hullRadius = new Map(added.hulls.map((hull) => [hull.hull, hull.radius]));
    const members = added.added.ships.filter((id) => id !== added.added.commander);
    const state = await WaitFor('the TFIs formation is ready', 60, (polled) => (polled.fleets.find((fleet) => fleet.id === 'tfis')?.formation?.ready ? null : JSON.stringify(polled.fleets.find((fleet) => fleet.id === 'tfis')?.formation)));
    const typeOf = new Map(added.scene.ships.map((ship) => [ship.id, ship.type]));
    const differs = added.added.ships.find((id) => ShipIn(state, id).physics?.radius !== hullRadius.get(typeOf.get(id)));
    if (differs) throw new Skipped(`the page's radii differ from the composition's (${differs}: ${ShipIn(state, differs).physics?.radius} m): no SDE or another SDE build`);
    const before = new Map(members.map((id) => [id, ShipIn(state, id).position ?? [0, 0, 0]]));
    await Delay(5000);
    const after = await call<ViewerState>('get_state');
    let worst = 0;
    for (const id of members) {
      const ship = ShipIn(after, id);
      const [x, y, z] = before.get(id) ?? [0, 0, 0];
      const [ax, ay, az] = ship.position ?? [0, 0, 0];
      const moved = Math.hypot(ax - x, ay - y, az - z);
      worst = Math.max(worst, moved);
      Expect(ship.following?.state === 'in-formation' && (ship.following.slotError ?? Infinity) <= 5 && moved <= 2 && (ship.speed ?? Infinity) < 0.5, `${id}: moved ${moved.toFixed(1)} m, ${JSON.stringify({ following: ship.following, speed: ship.speed, mode: ship.mode })}`);
    }
    return `${members.length} members in formation, the most moved ${worst.toFixed(2)} m`;
  });

  await Check('a fleet switches its prop mods on and keeps formation', async () => {
    const added = tfis;
    if (!added) throw new Skipped('the TFIs fleet was not added');
    const unresolved = added.propMods.filter((propMod) => propMod.from !== 'sde');
    if (unresolved.some((propMod) => propMod.from === 'unchecked')) throw new Skipped(`prop mods unchecked: ${unresolved.map((propMod) => propMod.note).join('; ')}`);
    Expect(added.propMods.length === 6 && !unresolved.length, JSON.stringify(added.propMods));
    const members = added.added.ships.filter((id) => id !== added.added.commander);
    const before = await call<ViewerState>('get_state');
    const base = new Map(added.added.ships.map((id) => [id, ShipIn(before, id).physics?.maxVelocity ?? Infinity]));
    const on = await call<SwitchPropModsResult>('switch_prop_mods', { fleet: 'tfis', active: true });
    Expect(on.ships.length === 41 && on.skipped.length === 3 && on.skipped.every((skip) => /fits no prop mod/u.test(skip.reason)), JSON.stringify({ ships: on.ships.length, skipped: on.skipped }));
    await WaitFor('41 prop mods active', 6, (state) => {
      const counts = state.fleets.find((fleet) => fleet.id === 'tfis')?.propMods;
      return counts?.['active'] === 41 && counts['none'] === 3 ? null : JSON.stringify(counts);
    });
    await call('order_ship', { id: 'tfis-fc', order: { type: 'direction', direction: [0, 0, -1] } });
    const end = Date.now() + 20_000;
    let state = before;
    while (Date.now() < end) {
      await Delay(1000);
      state = await call<ViewerState>('get_state');
      const astray = members.map((id) => ShipIn(state, id)).find((ship) => ship.following?.state !== 'in-formation' && ship.following?.state !== 'catching-up');
      Expect(!astray, `${astray?.id} ${JSON.stringify(astray?.following)}`);
    }
    const running = members.map((id) => ShipIn(state, id)).filter((ship) => ship.propMod?.state === 'active');
    // Every running module flies faster numbers; the agile ships are already past their base speed. Fitted capitals
    // (plates, rigs, the MWD's mass) take longer than the 20 s to get there.
    const unboosted = running.find((ship) => (ship.physics?.maxVelocity ?? 0) <= (base.get(ship.id) ?? Infinity));
    Expect(!unboosted, `${unboosted?.id} flies ${unboosted?.physics?.maxVelocity} m/s with its prop mod, base ${base.get(unboosted?.id ?? '')}`);
    const slow = running.find((ship) => (ship.speed ?? 0) <= (base.get(ship.id) ?? Infinity) && (ship.physics?.alignTime ?? Infinity) < 20);
    Expect(running.length === 40 && !slow, slow ? `${slow.id} at ${slow.speed} m/s, base ${base.get(slow.id)}` : `${running.length} members running`);
    const logi = await call<SwitchPropModsResult>('switch_prop_mods', { fleet: 'tfis', squad: 'logi', active: false });
    Expect(logi.ships.length === 8 && logi.ships.every((ship) => ship.id.startsWith('tfis-logi-') && ship.state === 'stopping'), JSON.stringify(logi.ships));
    const counts = state.fleets.find((fleet) => fleet.id === 'tfis')?.propMods;
    await call('order_ship', { id: 'tfis-fc', order: { type: 'stop' } });
    await call('switch_prop_mods', { fleet: 'tfis', active: false });
    const fc = ShipIn(state, 'tfis-fc');
    return `41 on (${JSON.stringify(counts)}), FC at ${fc.speed} m/s; every member in formation or catching up above its base speed; the 8 logi stopping`;
  });

  await Check('a fitted TFIs fleet reports fit-driven defense', async () => {
    const added = tfis;
    if (!added) throw new Skipped('the TFIs fleet was not added');
    const started = Date.now();
    const state = await WaitFor('every TFIs fit resolves', 90, (polled) => {
      const table = added.added.ships.map((id) => ShipIn(polled, id)).filter((ship) => ship.fit?.math !== 'dogma');
      return table.length ? `${table.length} on the table path, ${table[0].id}: ${JSON.stringify(table[0].fit?.note)}` : null;
    });
    const seconds = (Date.now() - started) / 1000;
    const fc = ShipIn(state, 'tfis-fc');
    const scene = await call<{ fits?: Record<string, string> }>('get_scene');
    const text = scene.fits?.['tfis/tfi'];
    if (!text || !fc.fit || !fc.defense) throw new Error(`tfis-fc: ${JSON.stringify({ fit: fc.fit, defense: fc.defense, key: Object.keys(scene.fits ?? {}) })}`);
    Expect(fc.fit.key === 'tfis/tfi' && fc.fit.typeID === 17732 && !fc.fit.unknown.length, JSON.stringify({ key: fc.fit.key, typeID: fc.fit.typeID, unknown: fc.fit.unknown }));
    // The prop mod may still be stopping from the check before.
    const offline = fc.fit.modules.filter((module) => !module.prop && module.state !== 'online');
    Expect(fc.fit.modules.length === 23 && !offline.length && fc.fit.modules.some((module) => module.prop), `${fc.fit.modules.length} modules, not online: ${JSON.stringify(offline)}`);
    const answer = await call<ShipStatsAnswer & { stats: { defense?: { armor: { hp: number } } } }>('ship_stats', { type: 'Tempest Fleet Issue', fit: text });
    const armor = answer.stats.defense?.armor.hp ?? Number.NaN;
    Expect(Close(Math.round(armor * 10) / 10, fc.defense.armor.max), `armor: ship_stats ${armor}, get_state ${fc.defense.armor.max}`);
    const counts = state.fleets.find((fleet) => fleet.id === 'tfis')?.modules;
    return `44 fits on dogma in ${seconds.toFixed(1)} s; tfis-fc armor ${fc.defense.armor.max} HP (ship_stats ${armor.toFixed(1)}), EHP ${fc.defense.ehp}, 23 modules online; fleet modules ${JSON.stringify(counts)}`;
  });

  await Check("a fit's guns load their charges from cargo", async () => {
    if (!tfis) throw new Skipped('the TFIs fleet was not added');
    const state = await call<ViewerState>('get_state');
    const guns = ShipIn(state, 'tfis-fc').fit?.modules.filter((module) => /Repeating Cannon/u.test(module.name)) ?? [];
    Expect(guns.length === 6 && guns.every((module) => module.charge === 'Barrage L' && /loaded from cargo/u.test(module.note ?? '')), JSON.stringify(guns));
    return `tfis-fc ${guns.map((module) => module.module).join(', ')} load Barrage L from cargo`;
  });

  await Check('compositions save, list, add by name with a unique id, and delete', async () => {
    const rifter = { hull: 'Rifter', dna: 'mf1_t1:minmatarbase:minmatar', radius: 31 };
    const mini = { id: 'tfis', commander: rifter, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ ...rifter, count: 3 }] }] }] };
    await call('save_fleet_composition', { composition: mini, name: 'verify-mini' });
    const listed = (await call<{ compositions: { name: string; store: string }[] }>('list_fleet_compositions')).compositions.map((entry) => `${entry.store}:${entry.name}`);
    Expect(listed.includes('disk:verify-mini') && listed.includes('example:TFIs'), listed.join(', '));
    const added = await call<AddedFleetResult>('add_fleet_composition', { name: 'verify-mini', position: [0, 0, -20000] });
    Expect(added.added.fleet === 'tfis-2' && added.changes['added'] === 4, JSON.stringify({ added: added.added, changes: added.changes }));
    const removed = await call<SceneResult>('patch_scene', { operations: [{ op: 'remove_fleet', fleet: 'tfis-2', withShips: true }] });
    Expect(removed.changes['removed'] === 4, JSON.stringify(removed.changes));
    Expect((await call<{ deleted: boolean }>('delete_fleet_composition', { name: 'verify-mini' })).deleted, 'not deleted');
    return 'fleet tfis-2 added and removed';
  });

  await Check('add_fleet_composition resolves a hull name through the EVE data', async () => {
    const added = await call<AddedFleetResult>('add_fleet_composition', { composition: { id: 'named', commander: { hull: 'Rifter' }, wings: [] }, position: [0, 0, -40000] }).catch((error: unknown) => {
      if (/cjs-sde-prepare/u.test(`${ErrorMessage(error)} ${(ErrorProblems(error) ?? []).join(' ')}`)) throw new Skipped('the SDE is not prepared');
      throw error;
    });
    const [hull] = added.hulls;
    Expect(hull?.dnaFrom === 'sde' && hull.radiusFrom === 'sde' && added.added.fleet === 'named', JSON.stringify(added.hulls));
    await call('patch_scene', { operations: [{ op: 'remove_fleet', fleet: 'named', withShips: true }] });
    return `Rifter radius ${hull.radius} m`;
  });

  // Follow the FC on a self-contained scene: every ship pins its stats, so these run with or without the SDE.
  const RIFTER_STATS = { mass: 1_067_000, agility: 3.2, maxVelocity: 320, signatureRadius: 35 };
  const FLW_MEMBERS = ['flw-d1', 'flw-d2', 'flw-d3', 'flw-d4', 'flw-l1', 'flw-l2'];
  const followScene = {
    name: 'verify-follow',
    ships: [
      { id: 'flw-fc', dna: 'af1_t1:amarrbase:amarr', stats: { mass: 1.2e6, agility: 3.2, maxVelocity: 160, signatureRadius: 35 } },
      ...FLW_MEMBERS.map((id, index) => ({ id, dna: 'mf1_t1:minmatarbase:minmatar', stats: RIFTER_STATS, position: [2000 + 1400 * index, 300 * (index % 3), 2500 - 1200 * index], rotation: [45 * index, 0, 0] })),
      { id: 'loner', dna: 'mf1_t1:minmatarbase:minmatar', stats: RIFTER_STATS, position: [-5000, 0, 0] }
    ],
    fleets: [
      {
        id: 'flw',
        commander: 'flw-fc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'dps', role: 'dps', members: ['flw-d1', 'flw-d2', 'flw-d3', 'flw-d4'] },
              { id: 'logi', role: 'logi', members: ['flw-l1', 'flw-l2'], anchor: { ship: 'flw-l1', range: 4000 } }
            ]
          }
        ]
      }
    ]
  };
  const fleetFormation = (state: ViewerState): Maybe<FleetFormationState> => state.fleets.find((fleet) => fleet.id === 'flw')?.formation;

  await Check('fleet members form up on their anchors', async () => {
    await call('load_scene', { scene: followScene });
    await WaitFor('the formation is ready', 30, (state) => (fleetFormation(state)?.ready ? null : JSON.stringify(fleetFormation(state))));
    const state = await WaitFor(
      'every member in formation at its slot range',
      90,
      (polled) => {
        const off = NotInFormation(polled, FLW_MEMBERS);
        if (off) return off;
        for (const id of FLW_MEMBERS) {
          const { following } = ShipIn(polled, id);
          const slotRange = following?.slot?.range ?? 0;
          const tolerance = toFollowTolerance({ slotRange, anchorSpeed: ShipIn(polled, following?.anchor ?? '').speed ?? 0 });
          if (Math.abs((following?.distance ?? Infinity) - slotRange) > tolerance) return `${id} ${following?.distance} m from its anchor, slot ${slotRange} m`;
        }
        return null;
      },
      3
    );
    return `${fleetFormation(state)?.inFormation} in formation, flw-l1 ${ShipIn(state, 'flw-l1').following?.distance} m off the FC`;
  });

  await Check('the fleet follows a moving FC', async () => {
    await call('order_ship', { id: 'flw-fc', order: { type: 'direction', direction: [1, 0, 0], speed: 0.5 } });
    const start = ShipIn(await call<ViewerState>('get_state'), 'flw-fc').position ?? [0, 0, 0];
    const state = await WaitFor(
      'the FC 3 km on, its members in formation, facing and flying with it',
      90,
      (polled) => {
        const fc = ShipIn(polled, 'flw-fc');
        const [x, y, z] = fc.position ?? start;
        if (Math.hypot(x - start[0], y - start[1], z - start[2]) < 3000) return `the FC has moved ${Math.hypot(x - start[0], y - start[1], z - start[2]).toFixed(0)} m`;
        const off = NotInFormation(polled, FLW_MEMBERS);
        if (off) return off;
        for (const id of FLW_MEMBERS) {
          const ship = ShipIn(polled, id);
          if (YawGap(ship.heading?.[0] ?? 0, 90) > 5) return `${id} heading ${JSON.stringify(ship.heading)}`;
          if (Math.abs((ship.speed ?? 0) - (fc.speed ?? 0)) > 0.15 * (fc.speed ?? 0)) return `${id} at ${ship.speed} m/s, the FC at ${fc.speed} m/s`;
        }
        return null;
      },
      3
    );
    return `FC at ${ShipIn(state, 'flw-fc').speed} m/s, ${fleetFormation(state)?.inFormation} in formation`;
  });

  await Check('re-anchoring breaks a squad off and brings it back', async () => {
    const out = await call<SceneResult>('patch_scene', { operations: [{ op: 'set_anchor', fleet: 'flw', squad: 'logi', anchor: { range: 12000 } }] });
    Expect(out.changes['regrouped'] === 1, JSON.stringify(out.changes));
    const off = await WaitFor('flw-l1 in formation 12 km off', 60, (state) => {
      const { following } = ShipIn(state, 'flw-l1');
      return following?.range === 12000 && following.state === 'in-formation' ? null : JSON.stringify(following);
    });
    await call('patch_scene', { operations: [{ op: 'set_anchor', fleet: 'flw', squad: 'logi', anchor: { range: 4000 } }] });
    await WaitFor('flw-l1 back in formation 4 km off', 60, (state) => {
      const { following } = ShipIn(state, 'flw-l1');
      return following?.range === 4000 && following.state === 'in-formation' ? null : JSON.stringify(following);
    });
    return `out at ${ShipIn(off, 'flw-l1').following?.distance} m, then back at 4000 m`;
  });

  await Check('an order detaches a member and rejoin brings it back', async () => {
    const stopped = await call<{ following?: unknown }>('order_ship', { id: 'flw-d1', order: { type: 'stop' } });
    Expect(stopped.following === 'detached', JSON.stringify(stopped));
    await WaitFor('flw-d1 detached and stopping', 10, (state) => {
      const ship = ShipIn(state, 'flw-d1');
      return ship.following?.state === 'detached' && ship.order?.type === 'stop' ? null : JSON.stringify({ following: ship.following, order: ship.order });
    });
    const rejoined = await call<{ following?: { anchor?: string } }>('order_ship', { id: 'flw-d1', order: { type: 'rejoin' } });
    Expect(rejoined.following?.anchor === 'flw-fc', JSON.stringify(rejoined));
    await WaitFor('flw-d1 back in formation', 60, (state) => NotInFormation(state, ['flw-d1']));
    for (const [id, pattern] of [
      ['flw-fc', /follows nobody/u],
      ['loner', /in no fleet/u]
    ] as const) {
      const refusal = await call('order_ship', { id, order: { type: 'rejoin' } }).then(
        () => 'accepted',
        (error: unknown) => ErrorMessage(error)
      );
      Expect(pattern.test(refusal), `rejoin ${id}: ${refusal}`);
    }
    return 'detached, rejoined, and rejoin refused for the FC and a loner';
  });

  await Check('removing a squad lead falls its squad back onto the FC', async () => {
    const removed = await call<SceneResult>('patch_scene', { operations: [{ op: 'remove_ship', id: 'flw-l1' }] });
    Expect(removed.changes['stopped'] === 0, JSON.stringify(removed.changes));
    await WaitFor('flw-l2 in formation 4 km off the FC', 60, (state) => {
      const { following } = ShipIn(state, 'flw-l2');
      return following?.anchor === 'flw-fc' && following.range === 4000 && following.state === 'in-formation' ? null : JSON.stringify(following);
    });
    return 'flw-l2 keeps 4000 m on flw-fc';
  });

  await Check("the fleet settles facing the FC's heading when it stops", async () => {
    await call('order_ship', { id: 'flw-fc', order: { type: 'stop' } });
    const members = FLW_MEMBERS.filter((id) => id !== 'flw-l1');
    const state = await WaitFor('every member settled in formation, facing the FC', 120, (polled) => {
      const yaw = ShipIn(polled, 'flw-fc').heading?.[0] ?? 0;
      const off = members.map((id) => ShipIn(polled, id)).find((ship) => ship.mode !== 'stop' || ship.following?.state !== 'in-formation' || YawGap(ship.heading?.[0] ?? 0, yaw) > 5);
      return off ? `${off.id} ${JSON.stringify({ mode: off.mode, heading: off.heading, following: off.following, fc: yaw })}` : null;
    });
    return `settled facing ${ShipIn(state, 'flw-fc').heading?.[0]} degrees`;
  });

  // order_fleet on the Follow-the-FC scene, reloaded whole (the checks above removed its logi lead).
  const commandOf = (state: ViewerState, kind: 'fleet' | 'wing' | 'squad', id: string, fleet = 'flw'): Maybe<FleetGroupCommandReport> => {
    const tree = state.fleets.find((candidate) => candidate.id === fleet) as Maybe<CommandTree>;
    if (kind === 'fleet') return tree?.command;
    if (kind === 'wing') return tree?.wings.find((wing) => wing.id === id)?.command;
    return tree?.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === id)?.command;
  };
  const squadDocument = async (fleet: string, squad: string) =>
    (await call<SceneFleetsResult>('get_scene')).fleets
      ?.find((candidate) => candidate.id === fleet)
      ?.wings.flatMap((wing) => wing.squads)
      .find((candidate) => candidate.id === squad);
  const refusalOf = (args: Record<string, unknown>): Promise<string> =>
    call('order_fleet', args).then(
      () => 'accepted',
      (error: unknown) => ErrorMessage(error)
    );
  const gap = (a: Maybe<ArrayLike<number>>, b: Maybe<ArrayLike<number>>): number => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Number.NaN);
  const DPS = ['flw-d1', 'flw-d2', 'flw-d3', 'flw-d4'];

  await Check('order_fleet moves the fleet through its FC', async () => {
    await call('load_scene', { scene: followScene });
    const formed = await WaitFor('the fleet in formation', 90, (state) => (fleetFormation(state)?.ready ? NotInFormation(state, FLW_MEMBERS) : 'not planned yet'));
    const start = ShipIn(formed, 'flw-fc').position;
    const moved = await call<OrderFleetResult>('order_fleet', { fleet: 'flw', order: { type: 'direction', direction: [0, 0, 1], speed: 0.5 } });
    Expect(moved.leader === 'flw-fc' && moved.by === 'flw-fc', JSON.stringify(moved));
    await WaitFor('the FC 2 km on, the fleet in formation and moving', 90, (state) => {
      const on = gap(ShipIn(state, 'flw-fc').position, start);
      const command = commandOf(state, 'fleet', 'flw');
      if (!(on >= 2000) || command?.state !== 'moving') return `FC ${Math.round(on)} m on, ${JSON.stringify(command)}`;
      return NotInFormation(state, FLW_MEMBERS);
    });
    await call('order_fleet', { fleet: 'flw', order: { type: 'stop' } });
    const idle = await WaitFor('the fleet idle and settled', 120, (state) => {
      const command = commandOf(state, 'fleet', 'flw');
      return command?.state === 'idle' ? NotInFormation(state, FLW_MEMBERS) : JSON.stringify(command);
    });
    return `stopped ${Math.round(gap(ShipIn(idle, 'flw-fc').position, start))} m on, last ${commandOf(idle, 'fleet', 'flw')?.last?.order.type}`;
  });

  await Check('order_fleet moves a squad on its commander, and regroup brings it back', async () => {
    await call('patch_scene', { operations: [{ op: 'update_squad', fleet: 'flw', squad: 'dps', set: { commander: 'flw-d1' } }] });
    const formed = await WaitFor('the fleet in formation', 60, (state) => NotInFormation(state, FLW_MEMBERS));
    const fc = ShipIn(formed, 'flw-fc');
    const yaw = ((fc.heading?.[0] ?? 0) * Math.PI) / 180;
    const at = fc.position ?? [0, 0, 0];
    const point = [at[0] + 8000 * Math.cos(yaw), at[1], at[2] - 8000 * Math.sin(yaw)];
    const moved = await call<OrderFleetResult>('order_fleet', { fleet: 'flw', squad: 'dps', order: { type: 'goto', point } });
    Expect(moved.leader === 'flw-d1' && moved.by === 'flw-d1', JSON.stringify(moved));
    let sawMoving = false;
    await WaitFor('dps apart on flw-d1, stopped at the point', 120, (state) => {
      const command = commandOf(state, 'squad', 'dps');
      sawMoving ||= command?.state === 'moving';
      if (ShipIn(state, 'flw-d1').following?.state !== 'leading') return `flw-d1 ${JSON.stringify(ShipIn(state, 'flw-d1').following)}`;
      const off = DPS.slice(1).find((id) => {
        const following = ShipIn(state, id).following;
        return following?.group?.leader !== 'flw-d1' || following.anchor !== 'flw-d1' || following.state !== 'in-formation';
      });
      if (off) return `${off} ${JSON.stringify(ShipIn(state, off).following)}`;
      if (ShipIn(state, 'flw-l1').following?.anchor !== 'flw-fc') return `flw-l1 ${JSON.stringify(ShipIn(state, 'flw-l1').following)}`;
      return command?.away && command.state === 'broken-off' ? null : JSON.stringify(command);
    });
    Expect(sawMoving, 'the squad never reported moving');
    await call('order_fleet', { fleet: 'flw', squad: 'dps', order: { type: 'regroup' } });
    let sawRegrouping = false;
    await WaitFor('dps back on flw-fc in formation, idle', 120, (state) => {
      const command = commandOf(state, 'squad', 'dps');
      sawRegrouping ||= command?.state === 'regrouping';
      const off = DPS.find((id) => ShipIn(state, id).following?.anchor !== 'flw-fc');
      if (off) return `${off} ${JSON.stringify(ShipIn(state, off).following)}`;
      return command?.state === 'idle' ? NotInFormation(state, DPS) : JSON.stringify(command);
    });
    Expect(sawRegrouping, 'the squad never reported regrouping');
    return 'moved 8 km apart on flw-d1, regrouped onto flw-fc';
  });

  await Check('order_fleet break-off and regroup write the document', async () => {
    const broke = await call<OrderFleetResult>('order_fleet', { fleet: 'flw', squad: 'logi', order: { type: 'break-off', range: 12000 } });
    Expect(broke.operations?.length === 1 && broke.operations[0].op === 'update_squad', JSON.stringify(broke.operations));
    const brokenLogi = await squadDocument('flw', 'logi');
    Expect(JSON.stringify(brokenLogi?.anchor) === JSON.stringify({ ship: 'flw-l1', range: 12000 }) && JSON.stringify(brokenLogi?.home) === JSON.stringify({ ship: 'flw-l1', range: 4000 }), JSON.stringify(brokenLogi));
    await WaitFor('flw-l1 12 km off, logi broken off with its home', 90, (state) => {
      const { following } = ShipIn(state, 'flw-l1');
      const command = commandOf(state, 'squad', 'logi');
      if (following?.range !== 12000 || following.state !== 'in-formation') return JSON.stringify(following);
      return command?.state === 'broken-off' && command.home?.range === 4000 ? null : JSON.stringify(command);
    });
    await call('order_fleet', { fleet: 'flw', squad: 'logi', order: { type: 'regroup' } });
    const back = await squadDocument('flw', 'logi');
    Expect(JSON.stringify(back?.anchor) === JSON.stringify({ ship: 'flw-l1', range: 4000 }) && back?.home === undefined, JSON.stringify(back));
    await WaitFor('flw-l1 back 4 km off', 90, (state) => {
      const { following } = ShipIn(state, 'flw-l1');
      return following?.range === 4000 && following.state === 'in-formation' ? null : JSON.stringify(following);
    });
    const anchored = await call<OrderFleetResult>('order_fleet', { fleet: 'flw', order: { type: 'anchor', range: 6000 } });
    Expect(anchored.operations?.length === 2 && anchored.operations.every((operation) => operation.op === 'set_anchor'), JSON.stringify(anchored.operations));
    await call('order_fleet', { fleet: 'flw', squad: 'dps', order: { type: 'anchor', range: null } });
    await call('order_fleet', { fleet: 'flw', squad: 'logi', order: { type: 'anchor', range: 4000 } });
    await WaitFor('the fleet back in formation', 90, (state) => NotInFormation(state, FLW_MEMBERS));
    return 'logi broke off to 12 km with its home, regrouped to 4 km, fleet anchor set and undone';
  });

  await Check('order_fleet refuses a warp from a ship without command', async () => {
    const WARP = { type: 'warp', point: [0, 0, 600000] };
    for (const [args, pattern] of [
      [{ fleet: 'flw', by: 'flw-d2', order: WARP }, /no command over fleet "flw"/u],
      [{ fleet: 'flw', by: 'flw-d1', order: WARP }, /no command over fleet "flw"/u],
      [{ fleet: 'flw', wing: 'w', by: 'flw-d1', order: WARP }, /no command over wing "w" of fleet "flw"/u],
      [{ fleet: 'flw', squad: 'dps', by: 'flw-l1', order: WARP }, /no command over squad "dps" of fleet "flw"/u],
      [{ fleet: 'flw', squad: 'dps', order: { type: 'approach', target: 'flw-d2' } }, /cannot target one of its own ships/u]
    ] as const) {
      const refusal = await refusalOf(args);
      Expect(pattern.test(refusal), `${JSON.stringify(args)}: ${refusal}`);
    }
    const state = await call<ViewerState>('get_state');
    Expect(ShipIn(state, 'flw-fc').mode !== 'warp', 'the FC warped');
    return 'four authority refusals and a target in the group';
  });

  // Fleet warp on its own scene: stats pinned, warp speeds from the SDE or the class values (5, 3 and 4 AU/s).
  const FW_STATS = {
    frigate: { mass: 1_067_000, agility: 3.2, maxVelocity: 320, signatureRadius: 35 },
    battleship: { mass: 103_300_000, agility: 0.115, maxVelocity: 130, signatureRadius: 350 },
    logistics: { mass: 11_980_000, agility: 0.61, maxVelocity: 209, signatureRadius: 70 }
  };
  const FW_MEMBERS = ['fw-d1', 'fw-d2', 'fw-d3', 'fw-l1', 'fw-l2'];
  const fleetWarpScene = {
    name: 'verify-fwarp',
    ships: [
      { id: 'fw-fc', dna: 'af1_t1:amarrbase:amarr', stats: { mass: 1.2e6, agility: 3.2, maxVelocity: 160, signatureRadius: 35 } },
      { id: 'fw-d1', dna: 'mf1_t1:minmatarbase:minmatar', stats: FW_STATS.frigate, position: [1500, 0, -1500] },
      { id: 'fw-d2', dna: 'mf1_t1:minmatarbase:minmatar', stats: FW_STATS.frigate, position: [-1500, 0, -1500] },
      { id: 'fw-d3', dna: TFI_DNA, stats: FW_STATS.battleship, position: [0, 0, -2500] },
      { id: 'fw-l1', dna: GUARDIAN_DNA, stats: FW_STATS.logistics, position: [0, 0, -5500] },
      { id: 'fw-l2', dna: GUARDIAN_DNA, stats: FW_STATS.logistics, position: [0, 0, -7000] }
    ],
    fleets: [
      {
        id: 'fw',
        commander: 'fw-fc',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'dps', role: 'dps', members: ['fw-d1', 'fw-d2', 'fw-d3'] },
              { id: 'logi', role: 'logi', members: ['fw-l1', 'fw-l2'], anchor: { ship: 'fw-l1', range: 5000 } }
            ]
          }
        ]
      }
    ]
  };

  await Check("the FC warps the fleet and it lands in formation at the members' own warp speeds", async () => {
    await call('load_scene', { scene: fleetWarpScene });
    await WaitFor('the warp fleet in formation', 180, (state) => (state.fleets.find((fleet) => fleet.id === 'fw')?.formation?.ready ? NotInFormation(state, FW_MEMBERS) : 'not planned yet'));
    const warp = await call<OrderFleetResult>('order_fleet', { fleet: 'fw', order: { type: 'warp', point: [0, 0, 400000] } });
    Expect(warp.leader === 'fw-fc' && (warp.skipped ?? []).length === 0 && warp.ships.length === FW_MEMBERS.length, JSON.stringify(warp));
    const speeds = new Set<number>();
    const sawWarping = new Set<string>();
    const landedAt = new Map<string, SceneVector>();
    let counts = '';
    await WaitFor('every member landed', 120, (state) => {
      const command = commandOf(state, 'fleet', 'fw', 'fw');
      if (command?.state === 'warping' && command.warp) counts = JSON.stringify(command.warp);
      for (const id of FW_MEMBERS) {
        const ship = ShipIn(state, id);
        if (ship.following?.state === 'warping' && ship.warp?.phase) sawWarping.add(id);
        if (ship.warp?.warpSpeed) speeds.add(ship.warp.warpSpeed);
        if (ship.warp?.phase === 'landed' && !landedAt.has(id) && ship.position) landedAt.set(id, ship.position);
        if (!landedAt.has(id) && sawWarping.has(id) && ship.following?.state !== 'warping' && ship.position) landedAt.set(id, ship.position);
      }
      return landedAt.size === FW_MEMBERS.length && ShipIn(state, 'fw-fc').warp?.phase === 'landed' ? null : `${landedAt.size} landed`;
    });
    Expect(sawWarping.size === FW_MEMBERS.length, `warping seen for ${[...sawWarping].join(', ')}`);
    Expect(speeds.size >= 3, `warp speeds ${[...speeds].join(', ')}`);
    Expect(counts !== '', 'the fleet never reported warping');
    const settled = await WaitFor('the warp fleet in formation after landing', 60, (state) => NotInFormation(state, FW_MEMBERS));
    for (const [id, at] of landedAt) {
      const moved = gap(ShipIn(settled, id).position, at);
      Expect(moved < 3000, `${id} moved ${Math.round(moved)} m after landing`);
      Expect(gap(ShipIn(settled, id).position, [0, 0, 0]) > 390000, `${id} is back near the start`);
    }
    await WaitFor('the fleet idle', 60, (state) => (commandOf(state, 'fleet', 'fw', 'fw')?.state === 'idle' ? null : JSON.stringify(commandOf(state, 'fleet', 'fw', 'fw'))));
    return `warp speeds ${[...speeds].sort().join('/')} AU/s, counts ${counts}`;
  });

  await Check('a squad warp lands it apart, and a delayed regroup warps it back', async () => {
    const before = await call<ViewerState>('get_state');
    const at = ShipIn(before, 'fw-fc').position ?? [0, 0, 0];
    const warp = await call<OrderFleetResult>('order_fleet', { fleet: 'fw', squad: 'logi', order: { type: 'warp', point: [at[0] + 300000, at[1], at[2]] } });
    Expect(warp.leader === 'fw-l1' && warp.by === 'fw-fc', JSON.stringify(warp));
    await WaitFor('logi landed apart on fw-l1', 90, (state) => {
      const { following } = ShipIn(state, 'fw-l2');
      const squad = commandOf(state, 'squad', 'logi', 'fw');
      if (following?.group?.leader !== 'fw-l1' || following.state !== 'in-formation' || ShipIn(state, 'fw-l1').warp?.phase !== 'landed') return JSON.stringify({ following, l1: ShipIn(state, 'fw-l1').warp?.phase });
      return squad?.away && commandOf(state, 'fleet', 'fw', 'fw')?.state === 'idle' ? null : JSON.stringify(squad);
    });
    const back = await call<OrderFleetResult>('order_fleet', { fleet: 'fw', squad: 'logi', delay: 0.5, order: { type: 'regroup' } });
    Expect(JSON.stringify(back.warping) === JSON.stringify(['fw-l1', 'fw-l2']), JSON.stringify(back));
    Expect(Object.keys(back.delays ?? {}).length === 2 && Object.values(back.delays ?? {}).every((seconds) => seconds >= 0 && seconds <= 5), JSON.stringify(back.delays));
    await WaitFor('logi back in formation on the FC, idle', 90, (state) => {
      const squad = commandOf(state, 'squad', 'logi', 'fw');
      if (ShipIn(state, 'fw-l1').following?.anchor !== 'fw-fc') return JSON.stringify(ShipIn(state, 'fw-l1').following);
      return squad?.state === 'idle' ? NotInFormation(state, ['fw-l1', 'fw-l2']) : JSON.stringify(squad);
    });
    return `logi out 300 km and back, pilot delays ${JSON.stringify(back.delays)}`;
  });

  const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
  const FORGE_NEBULA = 'res:/dx9/scene/universe/c02_cube.black';
  let moonLocation: Maybe<SceneLocation> = null;

  await Check('search_map finds Jita and the Perimeter gate in Jita', async () => {
    const jita = await call<MapSearchResult>('search_map', { query: 'Jita' }).catch(SkipWithoutSde);
    Expect(jita.items[0]?.id === 30000142, JSON.stringify(jita.items[0]));
    const gates = await call<MapSearchResult>('search_map', { query: 'Stargate (Perimeter)', kinds: ['stargate'] });
    const gate = gates.items.find((item) => item.id === 50001249);
    Expect(gate?.system?.name === 'Jita', JSON.stringify(gate));
    return `${gates.items.length} Stargate (Perimeter) hits`;
  });

  await Check("get_system lists Jita's celestials with type radii", async () => {
    const jita = await call<SystemResult>('get_system', { system: 'Jita' }).catch(SkipWithoutSde);
    const radius = (id: number) => jita.celestials.find((celestial) => celestial.id === id)?.radius;
    Expect(jita.celestials.find((celestial) => celestial.id === 60003760)?.kind === 'station' && radius(60003760) === 100000, `CNAP radius ${radius(60003760)}`);
    Expect(radius(50001249) === 3532, `gate radius ${radius(50001249)}`);
    Expect(jita.nebula === FORGE_NEBULA, `nebula ${jita.nebula}`);
    Expect((jita.counts['stargate'] ?? 0) >= 1, JSON.stringify(jita.counts));
    return JSON.stringify(jita.counts);
  });

  await Check('set_location puts the scene 30 km off the CNAP and get_state reports it', async () => {
    await call('load_scene', { scene: { name: 'verify-location', ships: [{ id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar' }] } });
    const set = await call<SetLocationResult>('set_location', { celestial: CNAP, range: 30000 }).catch(SkipWithoutSde);
    const offset = set.location.anchor?.offset ?? [0, 0, 0];
    Expect(set.location.system === 30000142 && set.location.anchor?.celestial === 60003760, JSON.stringify(set.location));
    Expect(Math.abs(Math.sqrt(offset[0] ** 2 + offset[1] ** 2 + offset[2] ** 2) - 130000) <= 0.01, `offset ${JSON.stringify(offset)}`);
    const state = await WaitFor('the location report', 20, (polled) => (polled.location?.status === 'ready' ? null : JSON.stringify(polled.location)));
    const report = state.location as LocationReport;
    const anchor = report.anchor && 'surfaceDistance' in report.anchor ? report.anchor.surfaceDistance : null;
    Expect(anchor != null && Math.abs(anchor - 30000) <= 1, `anchor ${JSON.stringify(report.anchor)}`);
    Expect(report.nearby[0]?.id === 60003760, JSON.stringify(report.nearby[0]));
    Expect(JSON.stringify(ShipIn(state, 'rifter').position) === JSON.stringify([0, 0, 0]), `rifter at ${JSON.stringify(ShipIn(state, 'rifter').position)}`);
    const response = await fetch(`${hub.url}map/system?id=30000142&origin=${set.location.origin.map(String).join(',')}`);
    const answer = (await response.json()) as MapSystemAnswer;
    Expect(Math.abs((answer.celestials[0]?.distance ?? 0) - 130000) <= 0.01, `/map/system nearest ${JSON.stringify(answer.celestials[0]?.distance)}`);
    return report.nearby
      .slice(0, 3)
      .map((celestial) => `${celestial.name} ${(celestial.distance / 1000).toFixed(1)} km`)
      .join(', ');
  });

  await Check('set_location dresses the CNAP (validated without a renderer)', async () => {
    await call('load_scene', { scene: { name: 'verify-dressing', ships: [{ id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar' }] } });
    const set = await call<SetLocationResult>('set_location', { celestial: CNAP, range: 30000 }).catch(SkipWithoutSde);
    Expect(!set.reloading && set.nebula === FORGE_NEBULA, JSON.stringify({ reloading: set.reloading, nebula: set.nebula }));
    const state = await WaitFor('the CNAP dressing', 90, (polled) => (['ready', 'partial'].includes(polled.location?.dressing?.state ?? '') ? null : DressingProgress(polled)));
    const dressing = state.location?.dressing as LocationDressingReport;
    const failures = dressing.objects.filter((object) => object.state === 'failed');
    Expect(failures.length === 0 && dressing.sun?.state !== 'failed', 'failed: ' + JSON.stringify([...failures.map((object) => `${object.name}: ${object.error}`), dressing.sun?.error]));
    Expect(dressing.nebula?.path === FORGE_NEBULA && dressing.nebula.state === 'planned', `nebula ${JSON.stringify(dressing.nebula)}`);
    Expect(dressing.sun?.name === 'Jita - Star' && dressing.sun.template === 'env_sun_blue_sun_01a' && dressing.sun.flare === 'blue_sun' && dressing.sun.state === 'validated', `sun ${JSON.stringify(dressing.sun)}`);
    const validated = (id: number) => dressing.objects.find((object) => object.id === id)?.state === 'validated';
    for (const id of [60003760, 60003466, 40009082, 40009087]) Expect(validated(id), `${id}: ${JSON.stringify(dressing.objects.find((object) => object.id === id))}`);
    return DressingSummary(dressing);
  });

  await Check('re-dressing at the Perimeter gate does not reload', async () => {
    const before = await call<ViewerState>('get_state');
    if (before.location?.dressing?.state !== 'ready') throw new Skipped('the CNAP was not dressed');
    const status = ShipIn(before, 'rifter').status;
    const set = await call<SetLocationResult>('set_location', { celestial: 'the Perimeter gate in Jita' });
    Expect(!set.reloading, 'set_location reloaded the tab');
    const state = await WaitFor('the Perimeter dressing', 90, (polled) => (polled.location?.anchor?.id === 50001249 && ['ready', 'partial'].includes(polled.location.dressing?.state ?? '') ? null : DressingProgress(polled)));
    const dressing = state.location?.dressing as LocationDressingReport;
    const ids = dressing.objects.map((object) => object.id);
    for (const id of [50001249, 50013921, 50001250, 60015262]) Expect(ids.includes(id), `${id} not dressed: ${JSON.stringify(ids)}`);
    Expect(!ids.includes(60003760), 'the CNAP is still dressed');
    Expect(JSON.stringify(dressing.objects.filter((object) => object.kind === 'planet' || object.kind === 'moon').map((object) => object.id)) === JSON.stringify([40009123]), `bodies ${JSON.stringify(ids)}`);
    Expect(state.simulation.seconds > before.simulation.seconds && ShipIn(state, 'rifter').status === status, `seconds ${before.simulation.seconds} -> ${state.simulation.seconds}, rifter ${status} -> ${ShipIn(state, 'rifter').status}`);
    return DressingSummary(dressing);
  });

  await Check('set_location finds the Perimeter gate in Jita and a moon by name', async () => {
    for (const args of [{ celestial: 'Perimeter gate', system: 'Jita' }, { celestial: 'the Perimeter gate in Jita' }]) {
      const set = await call<SetLocationResult>('set_location', args).catch(SkipWithoutSde);
      Expect(set.location.anchor?.celestial === 50001249 && Math.abs((set.range ?? 0) - 2500) <= 0.01, `${JSON.stringify(args)}: ${JSON.stringify(set.location.anchor)} range ${set.range}`);
    }
    const moon = await call<SetLocationResult>('set_location', { celestial: 'Jita IV - Moon 4' });
    Expect(moon.location.anchor?.celestial === 40009087 && moon.location.anchor.kind === 'moon', JSON.stringify(moon.location.anchor));
    moonLocation = moon.location;
  });

  await Check('the location round-trips through scene files and clear_location removes it', async () => {
    if (!moonLocation) throw new Skipped('no location was set');
    await call('save_scene', { name: 'verify-location' });
    await call('load_scene', { scene: { name: 'empty', ships: [] } });
    const opened = await call<{ scene: { location?: SceneLocation } }>('open_scene', { name: 'verify-location' });
    Expect(JSON.stringify(opened.scene.location) === JSON.stringify(moonLocation), JSON.stringify(opened.scene.location));
    await call('patch_scene', { operations: [{ op: 'clear_location' }] });
    Expect((await call<ViewerState>('get_state')).location === null, 'get_state still reports a location');
    Expect((await call<{ deleted: boolean }>('delete_scene', { name: 'verify-location' })).deleted, 'not deleted');
  });

  await Check('set_location on a passed scene leaves environment.universe alone', async () => {
    const set = await call<SetLocationResult>('set_location', { system: 'Jita', celestial: 'star', scene: { name: 'nebula' } }).catch(SkipWithoutSde);
    Expect(set.loaded === false && set.scene?.environment.universe === DEFAULT_UNIVERSE && set.nebula === FORGE_NEBULA, JSON.stringify({ loaded: set.loaded, environment: set.scene?.environment, nebula: set.nebula }));
    Expect(set.location.anchor?.kind === 'star', JSON.stringify(set.location.anchor));
  });

  await Check('add_ships adds Rifters in a wedge off a ship, facing it', async () => {
    await call('load_scene', { scene: { name: 'verify-staging', ships: [{ id: 'anchor', dna: TFI_DNA, type: 'Tempest Fleet Issue' }] } });
    const result = await call<AddShipsResult>('add_ships', { hull: 'Rifter', count: 5, formation: 'wedge', near: { ship: 'anchor', range: 10000 }, facing: 'anchor', team: 'red' }).catch(SkipWithoutSde);
    Expect(JSON.stringify(result.added.ships) === JSON.stringify(['rifter-01', 'rifter-02', 'rifter-03', 'rifter-04', 'rifter-05']), JSON.stringify(result.added));
    Expect(result.hull.dna === 'mf4_t1:minmatarbase:minmatar' && result.hull.radius === 31 && result.hull.radiusFrom === 'sde', JSON.stringify(result.hull));
    const lead = result.added.lead?.position ?? [NaN, NaN, NaN];
    Expect(Math.hypot(lead[0], lead[1], lead[2] - 10281) <= 1, `rifter-01 at ${JSON.stringify(lead)}`);
    const rifters = result.scene.ships.filter((ship) => ship.id.startsWith('rifter-'));
    Expect(
      rifters.every((ship) => Math.abs(Math.abs(ship.rotation[0]) - 180) <= 0.01),
      JSON.stringify(rifters.map((ship) => ship.rotation))
    );
    let least = Infinity;
    for (const a of rifters) for (const b of rifters) if (a !== b) least = Math.min(least, Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]));
    Expect(least >= 191, `closest pair ${least.toFixed(1)} m`);
    const good = rendering ? 'ready' : 'validated';
    const bad = result.ships.filter((ship) => ship.id.startsWith('rifter-') && ship.status !== good);
    Expect(!bad.length, `not ${good}: ${JSON.stringify(bad.slice(0, 3))}`);
    return `closest pair ${least.toFixed(0)} m`;
  });

  await Check('add_ships joins a squad at its formation slots', async () => {
    const composition = {
      id: 'jn',
      commander: { hull: 'Tempest Fleet Issue' },
      wings: [
        {
          id: 'w',
          squads: [
            { id: 'dps', role: 'dps', ships: [{ hull: 'Tempest Fleet Issue', count: 2 }] },
            { id: 'logi', role: 'logi', ships: [{ hull: 'Guardian', count: 2 }] }
          ]
        }
      ]
    };
    await call('add_fleet_composition', { composition, position: [0, 0, -60000] }).catch(SkipWithoutSde);
    const result = await call<AddShipsResult>('add_ships', { hull: 'Tempest Fleet Issue', count: 2, fleet: { id: 'jn', squad: 'dps' } }).catch(SkipWithoutSde);
    Expect(JSON.stringify(result.added.ships) === JSON.stringify(['jn-dps-03', 'jn-dps-04']), JSON.stringify(result.added));
    const state = await WaitFor('the jn formation is ready', 60, (polled) => (polled.fleets.find((fleet) => fleet.id === 'jn')?.formation?.ready ? null : JSON.stringify(polled.fleets.find((fleet) => fleet.id === 'jn')?.formation)));
    const differs = result.added.ships.find((id) => ShipIn(state, id).physics?.radius !== 250);
    if (differs) throw new Skipped(`the page's radius for ${differs} is ${ShipIn(state, differs).physics?.radius} m, not the SDE's 250 m`);
    const before = new Map(result.added.ships.map((id) => [id, ShipIn(state, id).position ?? [0, 0, 0]]));
    await Delay(5000);
    const after = await call<ViewerState>('get_state');
    let worst = 0;
    for (const id of result.added.ships) {
      const ship = ShipIn(after, id);
      const [x, y, z] = before.get(id) ?? [0, 0, 0];
      const [ax, ay, az] = ship.position ?? [0, 0, 0];
      const moved = Math.hypot(ax - x, ay - y, az - z);
      worst = Math.max(worst, moved);
      Expect(ship.following?.state === 'in-formation' && (ship.following.slotError ?? Infinity) <= 5 && moved <= 2, `${id}: moved ${moved.toFixed(1)} m, ${JSON.stringify(ship.following)}`);
    }
    return `the joiners moved at most ${worst.toFixed(2)} m`;
  });

  await Check('add_ships adds a logi squad with its role from the EVE group', async () => {
    const result = await call<AddShipsResult>('add_ships', { hull: 'Scimitar', count: 2, fleet: { id: 'jn', squad: { id: 'logi-2' } } }).catch(SkipWithoutSde);
    Expect(result.added.fleet?.created === 'squad' && result.added.fleet.squad === 'logi-2', JSON.stringify(result.added.fleet));
    Expect(!(result.warnings ?? []).some((warning) => warning.includes('formation slots')), JSON.stringify(result.warnings));
    const state = await call<ViewerState>('get_state');
    const lead = ShipIn(state, 'jn-logi-2-01');
    const second = ShipIn(state, 'jn-logi-2-02');
    Expect(lead.role === 'logi' && lead.anchor?.ship === 'jn-fc' && lead.anchor.range === 30000, JSON.stringify({ role: lead.role, anchor: lead.anchor }));
    Expect(second.anchor?.ship === 'jn-logi-2-01' && second.anchor.range === 1000, JSON.stringify(second.anchor));
  });

  await Check('stage_engagement sets the TFIs and a Ferox fleet 20 km apart off the CNAP', async () => {
    await call('load_scene', { scene: { name: 'verify-engagement' } });
    const set = await call<SetLocationResult>('set_location', { celestial: CNAP, range: 30000 }).catch(SkipWithoutSde);
    const result = await call<StageEngagementResult>('stage_engagement', {
      sides: [
        { composition: 'tfis' },
        {
          ships: [
            { hull: 'Ferox', count: 8 },
            { hull: 'Scimitar', count: 2 }
          ]
        }
      ],
      range: 20000,
      near: { celestial: CNAP, range: 40000 }
    }).catch(SkipWithoutSde);
    const [blue, red] = result.engagement.sides;
    Expect(blue.team === 'blue' && blue.fleet === 'tfis' && blue.ships.length === 44, JSON.stringify({ ...blue, ships: blue.ships.length }));
    Expect(red.team === 'red' && red.fleet === 'red' && red.ships.length === 10, JSON.stringify({ ...red, ships: red.ships.length }));
    const a = blue.lead?.position ?? [0, 0, 0];
    const b = red.lead?.position ?? [0, 0, 0];
    Expect(Math.abs(Math.abs((blue.lead?.heading ?? 0) - (red.lead?.heading ?? 0)) - 180) <= 0.01, `headings ${blue.lead?.heading} / ${red.lead?.heading}`);
    const gap = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    Expect(Math.abs(gap - 20465) <= 2, `FCs ${gap.toFixed(1)} m apart`);
    const offset = set.location.anchor?.offset ?? [0, 0, 0];
    const center = result.engagement.center;
    const fromStation = Math.hypot(center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]);
    Expect(Math.abs(fromStation - 140000) <= 2, `centre ${fromStation.toFixed(1)} m from the CNAP's centre`);
    const state = await WaitFor('both formations ready', 90, (polled) => {
      const pending = ['tfis', 'red'].find((id) => !polled.fleets.find((fleet) => fleet.id === id)?.formation?.ready);
      return pending ? `${pending} ${JSON.stringify(polled.fleets.find((fleet) => fleet.id === pending)?.formation)}` : null;
    });
    const squads = state.fleets.find((fleet) => fleet.id === 'red')?.wings.flatMap((wing) => wing.squads) ?? [];
    Expect(
      JSON.stringify(squads.map((squad) => [squad.id, squad.role, squad.members.length])) ===
        JSON.stringify([
          ['dps', 'dps', 7],
          ['logi', 'logi', 2]
        ]),
      JSON.stringify(squads.map((squad) => [squad.id, squad.role, squad.members.length]))
    );
    const settled = await WaitFor('every member in formation', 30, (polled) =>
      NotInFormation(
        polled,
        [...blue.ships, ...red.ships].filter((id) => id !== blue.commander && id !== red.commander)
      )
    );
    const scrambled = [...blue.ships, ...red.ships].filter((id) => (ShipIn(settled, id).following?.slotError ?? 0) > 5);
    Expect(!scrambled.length, `off their slots: ${scrambled.slice(0, 3).join(', ')}`);
    return `FCs ${gap.toFixed(0)} m apart, centre ${fromStation.toFixed(0)} m from the CNAP`;
  });

  await Check('stage_engagement on a passed scene with free sides', async () => {
    const result = await call<StageEngagementResult>('stage_engagement', {
      scene: { name: 'free' },
      sides: [
        { ships: [{ hull: 'Rifter', count: 6 }], fleet: false, formation: 'line' },
        { ships: [{ hull: 'Rifter', count: 6 }], fleet: false, formation: 'wall', team: 'green' }
      ],
      range: 5000
    }).catch(SkipWithoutSde);
    const ids = result.scene.ships.map((ship) => ship.id);
    const expected = [1, 2, 3, 4, 5, 6].flatMap((n) => [`blue-0${n}`]).concat([1, 2, 3, 4, 5, 6].map((n) => `green-0${n}`));
    Expect(result.loaded === false && JSON.stringify(ids) === JSON.stringify(expected) && !(result.scene.fleets ?? []).length, JSON.stringify({ loaded: result.loaded, ids, fleets: result.scene.fleets }));
    const blue = result.scene.ships.filter((ship) => ship.id.startsWith('blue-'));
    Expect(
      blue.every((ship) => ship.position[1] === 0 && ship.position[2] === blue[0].position[2]),
      `the line is not along x: ${JSON.stringify(blue.map((ship) => ship.position))}`
    );
  });

  await Check('search_objects finds structures, wrecks and LCOs', async () => {
    const astrahus = await call<{ items: { typeID: number; dna?: string }[] }>('search_objects', { query: 'Astrahus' }).catch(SkipWithoutSde);
    Expect(astrahus.items[0]?.typeID === 35832 && astrahus.items[0]?.dna === 'cm1_t1:upwell:generic', JSON.stringify(astrahus.items[0]));
    const wrecks = await call<{ items: { typeID: number; dna?: string; radius?: number; radiusFrom?: string }[] }>('search_objects', { query: 'Frigate Wreck', group: 'wreck' });
    Expect(
      wrecks.items.some((item) => item.typeID === 26550 && item.dna === 'wreck_s:genericbase:generic' && item.radius === 70 && item.radiusFrom === 'sof'),
      JSON.stringify(wrecks.items.slice(0, 5))
    );
    const ruin = await call<{ items: { typeID: number }[] }>('search_objects', { query: 'Ruined Stargate' });
    Expect(
      ruin.items.some((item) => item.typeID === 16737),
      JSON.stringify(ruin.items.slice(0, 5))
    );
    return `${astrahus.items.length} Astrahus, ${wrecks.items.length} frigate wrecks`;
  });

  const OBJECT_SCENE = { name: 'verify-objects', ships: [{ id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter', stats: { maxVelocity: 2000, agility: 1 } }] };
  let objectsPlaced = false;
  await Check('add_objects places an Astrahus off a ship and a wreck field off it, in one patch', async () => {
    await call('load_scene', { scene: OBJECT_SCENE });
    const result = await call<AddObjectsResult>('add_objects', {
      objects: [
        { type: 'Astrahus', id: 'astra', near: { ship: 'rifter', range: 30000 } },
        { type: 'Minmatar Frigate Wreck', count: 5, spacing: 1000, near: { object: 'astra', range: 3000, direction: 'behind' } }
      ]
    }).catch(SkipWithoutSde);
    const ids = result.added.map((added) => added.id);
    Expect(JSON.stringify(ids) === JSON.stringify(['astra', 'minmatar-frigate-wreck-01', 'minmatar-frigate-wreck-02', 'minmatar-frigate-wreck-03', 'minmatar-frigate-wreck-04', 'minmatar-frigate-wreck-05']), JSON.stringify(ids));
    Expect(result.types[0]?.radius === 45000 && result.types[0]?.radiusFrom === 'sde', JSON.stringify(result.types));
    Expect(result.types[1]?.radius === 70 && result.types[1]?.radiusFrom === 'sof' && result.types[1]?.sdeRadius === 14, JSON.stringify(result.types));
    const astra = result.added[0];
    Expect(Math.abs(Math.hypot(...astra.position) - (31 + 30000 + 45000)) <= 1, `astra at ${JSON.stringify(astra.position)}`);
    const state = await WaitFor('the objects to validate', 90, (polled) => ((polled.objects ?? []).length === 6 && (polled.objects ?? []).every((object) => ['validated', 'ready'].includes(object.status)) ? null : JSON.stringify((polled.objects ?? []).map((object) => object.status))));
    const row = (state.objects ?? [])[0];
    Expect(row?.nearestShips[0]?.id === 'rifter' && Math.abs((row?.nearestShips[0]?.distance ?? 0) - 30000) <= 2, JSON.stringify(row?.nearestShips));
    // The hub read the wreck's SOF hull on the resource build: the same number the page's SOF build measures.
    const wrecks = (state.objects ?? []).slice(1);
    Expect(
      wrecks.every((wreck) => wreck.radius === 70 && wreck.radiusFrom === 'document' && wreck.sofRadius === 70),
      JSON.stringify(wrecks.map((wreck) => ({ id: wreck.id, radius: wreck.radius, radiusFrom: wreck.radiusFrom, sofRadius: wreck.sofRadius })))
    );
    objectsPlaced = true;
    return `astra sofRadius ${row?.sofRadius} m, radius ${row?.radius} m`;
  });

  await Check('add_objects refuses a type with no graphic and changes nothing', async () => {
    const before = await call<SceneDocument>('get_scene');
    const error = await call('add_objects', { type: 'Tritanium' }).then(
      () => null,
      (failure: unknown) => failure
    );
    if (error instanceof ShipDataError && error.failure === 'unavailable') SkipWithoutSde(error);
    Expect(error && /has no graphic/u.test((ErrorProblems(error) ?? []).join(' ') + ErrorMessage(error)), `refusal: ${error ? ErrorMessage(error) : 'none'}`);
    const after = await call<SceneDocument>('get_scene');
    Expect(JSON.stringify(after.objects) === JSON.stringify(before.objects), 'the objects changed');
  });

  if (objectsPlaced) {
    await Check("add_objects gives a titan wreck its model's radius, not the SDE's 14 m", async () => {
      const result = await call<AddObjectsResult>('add_objects', { type: 'Minmatar Titan Wreck', id: 'titan-wreck', position: [0, 0, -400000] });
      Expect(result.added[0]?.radius === 10891 && result.types[0]?.radiusFrom === 'sof' && result.types[0]?.sdeRadius === 14, JSON.stringify({ added: result.added, types: result.types }));
      const titan = (polled: ViewerState) => (polled.objects ?? []).find((object) => object.id === 'titan-wreck');
      const state = await WaitFor('the titan wreck to validate', 90, (polled) => (['validated', 'ready'].includes(titan(polled)?.status ?? '') ? null : `status ${titan(polled)?.status}`));
      const row = titan(state);
      Expect(row?.radius === 10891 && row.sofRadius === 10891, JSON.stringify({ radius: row?.radius, radiusFrom: row?.radiusFrom, sofRadius: row?.sofRadius }));
      await call('patch_scene', { operations: [{ op: 'remove_object', id: 'titan-wreck' }] });
      return `radius ${row?.radius} m, sofRadius ${row?.sofRadius} m`;
    });

    await Check('ships orbit, keep at range on and approach an object', async () => {
      const distanceTo = (polled: ViewerState): number => ShipIn(polled, 'rifter').targetDistance ?? Infinity;
      await call('order_ship', { id: 'rifter', order: { type: 'orbit', target: 'astra', range: 5000 } });
      await WaitFor('the orbit to settle', 240, (polled) => (distanceTo(polled) >= 4000 && distanceTo(polled) <= 7000 ? null : `targetDistance ${distanceTo(polled)}`), 3);
      await call('order_ship', { id: 'rifter', order: { type: 'keep-at-range', target: 'astra', range: 10000 } });
      await WaitFor('the range to settle', 240, (polled) => (Math.abs(distanceTo(polled) - 10000) <= 1500 ? null : `targetDistance ${distanceTo(polled)}`), 3);
      await call('order_ship', { id: 'rifter', order: { type: 'approach', target: 'astra' } });
      const state = await WaitFor('the approach', 240, (polled) => (distanceTo(polled) < 1000 ? null : `targetDistance ${distanceTo(polled)}`));
      Expect((state.objects ?? [])[0]?.targetedBy?.includes('rifter'), JSON.stringify((state.objects ?? [])[0]?.targetedBy));
      return `approached to ${Math.round(distanceTo(state))} m`;
    });

    await Check('moving an object makes its followers chase it; removing it stops them', async () => {
      await call('patch_scene', { operations: [{ op: 'move_object', id: 'astra', position: [0, 0, 200000] }] });
      const moved = await WaitFor('the chase', 20, (polled) => ((ShipIn(polled, 'rifter').targetDistance ?? 0) > 50000 ? null : `targetDistance ${ShipIn(polled, 'rifter').targetDistance}`));
      Expect((moved.objects ?? [])[0]?.targetedBy?.includes('rifter'), 'no longer targeted');
      const removed = await call<{ changes: { stopped: number } }>('patch_scene', { operations: [{ op: 'remove_object', id: 'astra' }] });
      Expect(removed.changes.stopped === 1, JSON.stringify(removed.changes));
      const state = await call<ViewerState>('get_state');
      Expect(ShipIn(state, 'rifter').orderNote === 'stopped: target "astra" was removed', ShipIn(state, 'rifter').orderNote ?? 'no note');
    });

    await Check('objects round-trip through scene files and frame_camera frames one', async () => {
      const before = await call<SceneDocument>('get_scene');
      await call('save_scene', { name: 'verify-objects', store: 'disk' });
      await call('open_scene', { name: 'verify-objects', store: 'disk' });
      const after = await call<SceneDocument>('get_scene');
      Expect(JSON.stringify(after.objects) === JSON.stringify(before.objects), 'the objects changed');
      await call('frame_camera', { target: 'minmatar-frigate-wreck-01' });
      const wreck = after.objects?.find((object) => object.id === 'minmatar-frigate-wreck-01');
      Expect(wreck, 'no wreck');
      return `${after.objects?.length} objects`;
    });

    await Check('the scene extent refuses objects and ships past 10,000 km and warns past 2,000 km', async () => {
      const far = await call('add_objects', { type: 'Minmatar Frigate Wreck', position: [0, 0, 12e6] }).then(
        () => null,
        (failure: unknown) => (ErrorProblems(failure) ?? []).join(' ') + ErrorMessage(failure)
      );
      Expect(far && /10,000 km/u.test(far), `far: ${far}`);
      const large = await call<AddObjectsResult>('add_objects', { type: 'Minmatar Frigate Wreck', id: 'far-wreck', position: [0, 0, 3e6] });
      Expect(
        large.warnings.some((warning) => /2,000 km/u.test(warning)),
        JSON.stringify(large.warnings)
      );
      const ship = await call('patch_scene', { operations: [{ op: 'update_ship', id: 'rifter', set: { position: [2e7, 0, 0] } }] }).then(
        () => null,
        (failure: unknown) => (ErrorProblems(failure) ?? []).join(' ')
      );
      Expect(ship && /10,000 km/u.test(ship), `ship: ${ship}`);
      await call('patch_scene', { operations: [{ op: 'remove_object', id: 'far-wreck' }] });
    });

    await Check('add_ships stages Rifters 5 km off an object', async () => {
      await call('add_objects', { type: 'Astrahus', id: 'astra', position: [0, 0, 100000] });
      const result = await call<{ added: { ships: string[]; lead: { position: SceneVector } } }>('add_ships', { hull: 'Rifter', count: 3, near: { object: 'astra' } });
      const lead = result.added.lead.position;
      Expect(result.added.ships.length === 3 && Math.abs(Math.hypot(lead[0], lead[1], lead[2] - 100000) - (45000 + 5000 + 31)) <= 2, JSON.stringify(lead));
    });

    await Check('add_objects places a Ruined Stargate off the CNAP, and the CNAP is an order target', async () => {
      await call('load_scene', { scene: OBJECT_SCENE });
      const set = await call<SetLocationResult>('set_location', { celestial: CNAP, range: 30000 });
      const result = await call<AddObjectsResult>('add_objects', { type: 'Ruined Stargate', id: 'ruin', near: { celestial: CNAP, range: 20000 } });
      const offset = set.location.anchor?.offset ?? [0, 0, 0];
      const ruin = result.added[0].position;
      const fromCnap = Math.hypot(ruin[0] + offset[0], ruin[1] + offset[1], ruin[2] + offset[2]);
      Expect(Math.abs(fromCnap - (100000 + 20000 + 5991)) <= 2, `ruin ${fromCnap} m from the CNAP`);
      const state = await WaitFor('the celestial targets', 30, (polled) => (polled.location?.targets?.some((target) => target.target === 'celestial:60003760') ? null : JSON.stringify(polled.location?.targets ?? null)));
      await call('order_ship', { id: 'rifter', order: { type: 'approach', target: 'celestial:60003760' } });
      const first = await WaitFor('the approach to start', 10, (polled) => (ShipIn(polled, 'rifter').targetDistance != null ? null : 'no targetDistance'));
      const start = ShipIn(first, 'rifter').targetDistance ?? 0;
      const later = await WaitFor('the CNAP approach', 30, (polled) => ((ShipIn(polled, 'rifter').targetDistance ?? Infinity) < start - 2000 ? null : `targetDistance ${ShipIn(polled, 'rifter').targetDistance}`));
      return `${state.location?.targets?.length} targets; CNAP ${Math.round(start)} -> ${Math.round(ShipIn(later, 'rifter').targetDistance ?? 0)} m`;
    });
  }

  const FIELD_SCENE = { name: 'verify-fields', ships: [{ id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter', stats: { maxVelocity: 2000, agility: 1 } }] };
  const fieldRow = (state: ViewerState, id: string): Maybe<SceneAsteroidFieldStateReport> => (state.asteroidFields ?? []).find((field) => field.id === id) ?? null;
  const fieldSettled = (id: string, digest?: string) => (polled: ViewerState) => {
    const row = fieldRow(polled, id);
    return row && ['validated', 'ready'].includes(row.status) && (digest == null || row.digest === digest) ? null : `status ${row?.status ?? 'none'} ${row?.error ?? ''} digest ${row?.digest ?? ''}`;
  };
  let fieldAdded = false;
  await Check('add_asteroid_field resolves Veldspar and Dark Ochre and validates the rocks', async () => {
    await call('load_scene', { scene: FIELD_SCENE });
    const result = await call<AddAsteroidFieldResult>('add_asteroid_field', { id: 'veld', ores: ['Veldspar', 'Dark Ochre'], count: 150, radius: 25000, near: { ship: 'rifter', range: 10000 } }).catch(SkipWithoutSde);
    Expect(result.ores.length === 2 && result.ores.every((ore) => ore.models.small === 4 && ore.models.medium === 4 && ore.models.large === 4), JSON.stringify(result.ores));
    Expect(result.added.placed === 150, `placed ${result.added.placed}`);
    const state = await WaitFor('the field to validate', 180, fieldSettled('veld'));
    const row = fieldRow(state, 'veld');
    Expect(row?.rocks.placed === result.added.placed && row.rocks.requested === 150, JSON.stringify(row?.rocks));
    Expect(row?.digest === result.added.digest, `page digest ${row?.digest}, hub ${result.added.digest}`);
    Expect(row && row.models.total > 0 && row.models.built === row.models.total && row.models.failed === 0, JSON.stringify(row?.models));
    Expect(row && row.distance + row.envelope <= MAX_SCENE_DISTANCE, `distance ${row?.distance} + envelope ${row?.envelope}`);
    Expect(state.scene?.asteroidFields === 1, `scene.asteroidFields ${state.scene?.asteroidFields}`);
    fieldAdded = true;
    return `${row?.status}: ${row?.rocks.placed} rocks, ${row?.models.built} models, digest ${row?.digest}`;
  });

  if (fieldAdded) {
    await Check('add_asteroid_field refuses a non-asteroid and a field past the extent; nothing changes', async () => {
      const before = await call<SceneDocument>('get_scene');
      const refusal = (args: Record<string, unknown>): Promise<string> =>
        call('add_asteroid_field', args).then(
          () => 'none',
          (failure: unknown) => (ErrorProblems(failure) ?? []).join(' ') + ErrorMessage(failure)
        );
      const mineral = await refusal({ ores: ['Tritanium'] });
      Expect(/not an asteroid/u.test(mineral), `Tritanium: ${mineral}`);
      const far = await refusal({ ores: ['Veldspar'], radius: 20000, position: [0, 0, 9990000] });
      Expect(/10,000 km/u.test(far), `far: ${far}`);
      const after = await call<SceneDocument>('get_scene');
      Expect(JSON.stringify(after.asteroidFields) === JSON.stringify(before.asteroidFields), 'the fields changed');
    });

    await Check('update_asteroid_field moves a field without rebuilding it and rebuilds on a seed change', async () => {
      const digest = fieldRow(await call<ViewerState>('get_state'), 'veld')?.digest;
      const moved = await call<FieldChanges>('patch_scene', { operations: [{ op: 'update_asteroid_field', id: 'veld', set: { position: [0, 0, 80000], rotation: [30, 0, 0] } }] });
      Expect(JSON.stringify(moved.changes.asteroidFields) === JSON.stringify({ added: 0, rebuilt: 0, moved: 1, removed: 0 }), JSON.stringify(moved.changes.asteroidFields));
      const still = fieldRow(await call<ViewerState>('get_state'), 'veld');
      Expect(still?.digest === digest && JSON.stringify(still?.position) === '[0,0,80000]' && ['validated', 'ready'].includes(still?.status ?? ''), JSON.stringify({ status: still?.status, digest: still?.digest, position: still?.position }));
      const rebuilt = await call<FieldChanges>('patch_scene', { operations: [{ op: 'update_asteroid_field', id: 'veld', set: { seed: 7 } }] });
      Expect(JSON.stringify(rebuilt.changes.asteroidFields) === JSON.stringify({ added: 0, rebuilt: 1, moved: 0, removed: 0 }), JSON.stringify(rebuilt.changes.asteroidFields));
      const state = await WaitFor('the rebuilt field', 120, (polled) => fieldSettled('veld')(polled) ?? (fieldRow(polled, 'veld')?.digest === digest ? 'the digest did not change' : null));
      return `digest ${digest} -> ${fieldRow(state, 'veld')?.digest}`;
    });

    await Check('a field off an asteroid belt centres on it', async () => {
      const set = await call<SetLocationResult>('set_location', { celestial: 'Perimeter II - Asteroid Belt 1' }).catch(SkipWithoutSde);
      const result = await call<AddAsteroidFieldResult>('add_asteroid_field', { id: 'belt', ores: ['Veldspar'], count: 60, near: { celestial: 'Perimeter II - Asteroid Belt 1' } });
      const offset = set.location.anchor?.offset ?? [0, 0, 0];
      const position = result.added.position;
      const fromBelt = Math.hypot(position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]);
      Expect(fromBelt <= 1 && result.added.radius === 44425, `${fromBelt} m from the belt, radius ${result.added.radius}`);
      await WaitFor('the belt field to validate', 120, fieldSettled('belt', result.added.digest));
      return `radius ${result.added.radius} m, ${result.added.placed} rocks`;
    });

    await Check('fields round-trip through scene files and frame_camera frames one', async () => {
      const before = await call<SceneDocument>('get_scene');
      const digest = fieldRow(await call<ViewerState>('get_state'), 'belt')?.digest;
      await call('save_scene', { name: 'verify-fields', store: 'disk' });
      await call('open_scene', { name: 'verify-fields', store: 'disk' });
      const after = await call<SceneDocument>('get_scene');
      Expect(JSON.stringify(after.asteroidFields) === JSON.stringify(before.asteroidFields), 'the fields changed');
      await WaitFor('the reopened fields', 120, (polled) => fieldSettled('veld')(polled) ?? fieldSettled('belt', digest)(polled));
      await call('frame_camera', { target: 'belt' });
      const unknown = await call('frame_camera', { target: 'no-such-field' }).then(
        () => 'none',
        (failure: unknown) => ErrorMessage(failure)
      );
      Expect(/no ship, object or asteroid field/u.test(unknown), `unknown target: ${unknown}`);
      return `${after.asteroidFields?.length} fields`;
    });

    await Check('remove_asteroid_field clears camera.target and the field entry', async () => {
      await call('frame_camera', { target: 'belt', persist: true });
      Expect((await call<SceneDocument>('get_scene')).camera.target === 'belt', 'camera.target is not the field');
      const removed = await call<FieldChanges>('patch_scene', { operations: [{ op: 'remove_asteroid_field', id: 'belt' }] });
      Expect(removed.changes.asteroidFields?.removed === 1, JSON.stringify(removed.changes.asteroidFields));
      const scene = await call<SceneDocument>('get_scene');
      Expect(scene.camera.target == null, `camera.target ${scene.camera.target}`);
      const state = await call<ViewerState>('get_state');
      Expect(!fieldRow(state, 'belt') && state.scene?.asteroidFields === 1, JSON.stringify((state.asteroidFields ?? []).map((field) => field.id)));
    });
  }

  const playShot = (shot: Record<string, unknown>): Promise<unknown> => call('play_shot', shot);
  const cinemaOf = (state: ViewerState): CinemaStateReport => {
    if (!state.cinema) throw new Error('get_state has no cinema');
    return state.cinema;
  };
  const CINEMA_SCENE = {
    name: 'verify-cinema',
    ships: [
      { id: 'hero', dna: 'af1_t1:amarrbase:amarr', position: [0, 0, 0], team: 'blue' },
      { id: 'wing', dna: 'af1_t1:amarrbase:amarr', position: [800, 0, -600], team: 'blue' },
      { id: 'red', dna: 'mf1_t1:minmatarbase:minmatar', position: [0, 0, 40000], team: 'red' }
    ]
  };

  await Check('a cinema shot plays on the scene clock', async () => {
    await call('load_scene', { scene: CINEMA_SCENE });
    await playShot({ hardpoint: { name: 'chase', ship: 'hero' }, duration: 60 });
    const first = await WaitFor('the shot to play', 10, (polled) => (cinemaOf(polled).state === 'playing' && cinemaOf(polled).pose ? null : JSON.stringify(polled.cinema)));
    await Delay(2000);
    const later = await call<ViewerState>('get_state');
    const shot = (state: ViewerState) => cinemaOf(state).shot;
    const advanced = (shot(later)?.elapsed ?? 0) - (shot(first)?.elapsed ?? 0);
    const scene = later.simulation.seconds - first.simulation.seconds;
    Expect(cinemaOf(later).state === 'playing' && Math.abs(advanced - scene) < 0.3 && (shot(later)?.progress ?? 0) > 0, `elapsed +${advanced} s over ${scene} scene s: ${JSON.stringify(later.cinema)}`);
    const eye = cinemaOf(later).pose?.eye ?? [0, 0, 0];
    Expect(eye[2] < 0, `the chase eye sits behind the hull: ${JSON.stringify(eye)}`);
    return `elapsed +${advanced.toFixed(2)} s over ${scene.toFixed(2)} scene s; near ${cinemaOf(later).near} m`;
  });

  await Check('the cinema flyby eye holds while the ship flies past', async () => {
    await call('order_ship', { id: 'hero', order: { type: 'direction', direction: [0, 0, 1] } });
    await WaitFor('the hero to get going', 15, (polled) => ((ShipIn(polled, 'hero').speed ?? 0) > 50 ? null : `speed ${ShipIn(polled, 'hero').speed}`));
    await playShot({ hardpoint: { name: 'flyby', ship: 'hero' } });
    const first = await WaitFor('the flyby', 10, (polled) => (cinemaOf(polled).shot?.hardpoint?.name === 'flyby' && cinemaOf(polled).pose ? null : JSON.stringify(polled.cinema)), 2);
    await Delay(1500);
    const later = cinemaOf(await call<ViewerState>('get_state'));
    const before = cinemaOf(first).pose;
    Expect(JSON.stringify(later.pose?.eye) === JSON.stringify(before?.eye), `the eye moved: ${JSON.stringify(before?.eye)} -> ${JSON.stringify(later.pose?.eye)}`);
    Expect((later.pose?.look[2] ?? 0) > (before?.look[2] ?? 0), `the look stayed: ${JSON.stringify(before?.look)} -> ${JSON.stringify(later.pose?.look)}`);
    await call('order_ship', { id: 'hero', order: { type: 'stop' } });
    return `eye ${JSON.stringify(later.pose?.eye)}; look z ${before?.look[2]} -> ${later.pose?.look[2]}`;
  });

  await Check('a cinema sequence advances on its durations', async () => {
    await call('play_sequence', { shots: [{ hardpoint: { name: 'chase', ship: 'hero' }, duration: 1 }, { hardpoint: { name: 'behind-fc', ships: ['hero', 'wing'] }, transition: { type: 'blend', duration: 1 }, duration: 1 }, { hardpoint: { name: 'overlook' } }] });
    const state = await WaitFor('the third shot', 10, (polled) => (cinemaOf(polled).sequence?.index === 2 ? null : JSON.stringify(polled.cinema?.sequence ?? polled.cinema?.state)));
    return `shot ${cinemaOf(state).sequence?.index} of ${cinemaOf(state).sequence?.count}`;
  });

  await Check('cinema list_hardpoints resolves a ship, a group, the engagement and an object', async () => {
    const ship = await call<HardpointListingResult>('list_hardpoints', { ship: 'hero' });
    const centre = ship.subject?.centre ?? [0, 0, 0];
    const radius = ship.subject?.radius ?? Infinity;
    const inside = ship.hardpoints.filter((entry) => !entry.eye || Math.hypot(entry.eye[0] - centre[0], entry.eye[1] - centre[1], entry.eye[2] - centre[2]) <= radius);
    Expect(ship.kind === 'ship' && ship.hardpoints.some((entry) => entry.name === 'warp-landing') && !inside.length, `inside the hull or unresolved: ${JSON.stringify(inside)}`);
    const group = await call<HardpointListingResult>('list_hardpoints', { ships: ['hero', 'wing'] });
    Expect(group.kind === 'group' && group.hardpoints.every((entry) => entry.eye), JSON.stringify(group.hardpoints));
    const engagement = await call<HardpointListingResult>('list_hardpoints', {});
    Expect(engagement.kind === 'engagement' && engagement.subject?.teams?.length === 2, JSON.stringify(engagement.subject));
    const placed = await call('add_objects', { type: 'Astrahus', id: 'cinema-astra', position: [0, 0, 100000] }).then(
      () => true,
      (error: unknown) => (error instanceof ShipDataError && error.failure === 'unavailable' ? false : Promise.reject(error))
    );
    let object = 'object skipped (no SDE)';
    if (placed) {
      const listing = await call<HardpointListingResult>('list_hardpoints', { object: 'cinema-astra' });
      Expect(listing.kind === 'landmark' && listing.hardpoints.every((entry) => entry.eye), JSON.stringify(listing.hardpoints));
      object = `object ${listing.hardpoints.map((entry) => entry.name).join(', ')}`;
      await call('patch_scene', { operations: [{ op: 'remove_object', id: 'cinema-astra' }] });
    }
    return `ship ${ship.hardpoints.length}, group ${group.hardpoints.length}, engagement ${engagement.hardpoints.length}; ${object}`;
  });

  await Check('a cinema library shot pauses and resumes on the scene clock', async () => {
    const played = await call<{ driver: string; shots: { library?: string }[] }>('play_shot', { shot: 'overlook-pull-out' });
    Expect(played.driver === 'claude' && played.shots[0]?.library === 'overlook-pull-out', JSON.stringify(played));
    await WaitFor('the pull-out to play', 10, (polled) => (cinemaOf(polled).state === 'playing' && cinemaOf(polled).pose ? null : JSON.stringify(polled.cinema)));
    await Delay(600);
    const paused = await call<CinemaStateReport>('stop_shot', { pause: true });
    Expect(paused.state === 'paused' && paused.driver === 'claude' && paused.shot?.library === 'overlook-pull-out', JSON.stringify(paused));
    await Delay(1000);
    const still = cinemaOf(await call<ViewerState>('get_state'));
    Expect(still.state === 'paused' && Math.abs((still.shot?.elapsed ?? -1) - (paused.shot?.elapsed ?? 0)) < 0.02, `paused ${paused.shot?.elapsed} -> ${still.shot?.elapsed}`);
    await call('resume_shot', {});
    await Delay(1000);
    const resumed = cinemaOf(await call<ViewerState>('get_state'));
    Expect(resumed.state === 'playing' && (resumed.shot?.elapsed ?? 0) > (paused.shot?.elapsed ?? 0) + 0.5, `resumed at ${resumed.shot?.elapsed}: ${JSON.stringify(resumed)}`);
    return `frozen at ${paused.shot?.elapsed} s, resumed to ${resumed.shot?.elapsed} s`;
  });

  await Check('a stopped cinema shot hands back to the user and resumes where it stopped', async () => {
    await playShot({ hardpoint: { name: 'chase', ship: 'hero' }, duration: 60 });
    await WaitFor('the shot to play', 10, (polled) => (cinemaOf(polled).state === 'playing' && cinemaOf(polled).pose ? null : JSON.stringify(polled.cinema)));
    await Delay(1000);
    const stopped = await call<CinemaStateReport>('stop_shot', {});
    Expect(stopped.driver === 'user' && (stopped.resumable?.elapsed ?? 0) > 0.5, JSON.stringify(stopped));
    const resumed = await call<CinemaStateReport>('resume_shot', {});
    Expect(resumed.driver === 'claude' && resumed.state === 'playing' && (resumed.shot?.elapsed ?? 0) >= (stopped.resumable?.elapsed ?? Infinity) - 0.01 && resumed.resumable === null, JSON.stringify(resumed));
    return `stopped at ${stopped.resumable?.elapsed} s; resumed at ${resumed.shot?.elapsed} s`;
  });

  await Check('a held cinema shot stays on its last frame', async () => {
    await playShot({ hardpoint: { name: 'chase', ship: 'hero' }, duration: 1, end: 'hold' });
    await Delay(2500);
    const held = cinemaOf(await call<ViewerState>('get_state'));
    Expect(held.state === 'playing' && held.shot?.progress === 1 && held.shot.holding === true, JSON.stringify(held));
    return `progress ${held.shot?.progress}, holding`;
  });

  await Check('the cinema warp-in waits at the landing', async () => {
    await call('patch_scene', { operations: [{ op: 'add_ship', ship: { id: 'lander', dna: 'mf1_t1:minmatarbase:minmatar', position: [0, 0, -300000] } }] });
    await WaitFor('the lander gets its warp speed', 60, (state) => ((ShipIn(state, 'lander').physics?.warpSpeed ?? 0) > 0 ? null : JSON.stringify(ShipIn(state, 'lander').physics)));
    await call('order_ship', { id: 'lander', order: { type: 'warp', point: [0, 0, -2000] } });
    await playShot({ shot: 'warp-in', ship: 'lander' });
    const anchored = await WaitFor('the warp-in anchor', 20, (polled) => (/lander is (aligning|warping)|landing of lander/u.test(cinemaOf(polled).note ?? '') && cinemaOf(polled).pose ? null : JSON.stringify(polled.cinema)));
    const eye = cinemaOf(anchored).pose?.eye ?? [0, 0, 0];
    let held = true;
    const landed = await WaitFor('the lander to land', 90, (polled) => {
      held &&= JSON.stringify(cinemaOf(polled).pose?.eye) === JSON.stringify(eye);
      return ShipIn(polled, 'lander').warp?.phase === 'landed' ? null : JSON.stringify(ShipIn(polled, 'lander').warp?.phase);
    });
    const cinema = cinemaOf(landed);
    const look = cinema.pose?.look ?? [0, 0, 0];
    const ship = ShipIn(landed, 'lander').position ?? [Infinity, 0, 0];
    const toLook = [0, 1, 2].map((axis) => look[axis] - eye[axis]);
    const toShip = [0, 1, 2].map((axis) => ship[axis] - eye[axis]);
    const ahead = toLook[0] * toShip[0] + toLook[1] * toShip[1] + toLook[2] * toShip[2];
    const range = Math.hypot(toShip[0], toShip[1], toShip[2]);
    Expect(held && ahead > 0 && range < 12000, `held ${held}; eye ${JSON.stringify(eye)}, ship ${JSON.stringify(ship)}, ${Math.round(range)} m: ${JSON.stringify(cinema)}`);
    return `the eye held; the ship landed ${Math.round(range)} m in front of the lens`;
  });

  await Check('removing the subject releases the cinema shot, and a load cuts it', async () => {
    await playShot({ hardpoint: { name: 'hero-port', ship: 'wing' } });
    await WaitFor('the shot to play', 10, (polled) => (cinemaOf(polled).state === 'playing' ? null : JSON.stringify(polled.cinema)));
    await call('patch_scene', { operations: [{ op: 'remove_ship', id: 'wing' }] });
    const released = cinemaOf(await call<ViewerState>('get_state'));
    Expect(released.state !== 'playing' && /subject|no ship/u.test(released.note ?? ''), JSON.stringify(released));
    await playShot({ hardpoint: { name: 'top-down', ship: 'hero' } });
    await WaitFor('the shot to play', 10, (polled) => (cinemaOf(polled).state === 'playing' ? null : JSON.stringify(polled.cinema)));
    await call('load_scene', { scene: CINEMA_SCENE });
    const cut = cinemaOf(await call<ViewerState>('get_state'));
    Expect(cut.state === 'idle' && cut.resumable === null, JSON.stringify(cut));
    return `released: ${released.note}; load: ${cut.note}`;
  });

  // Fleet warp-in (sd-destiny warp doc "Warp-in", sd-fleets "Arriving fleets"): each check loads its own scene, so
  // --only warp-in runs them alone. Headless, so the flashes are the counted commands, not drawn ones.
  const between = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const flashesOf = (state: ViewerState): WarpFlashState => state.simulation.warpFlashes ?? { warpOut: 0, warpIn: 0 };
  const RIFTER_DNA = 'mf4_t1:minmatarbase:minmatar';
  /**
   * Polls get_state until every ship has dropped out of warp (its arrival landed, or over once it seen it), recording
   * what each did; `each` sees every poll first.
   */
  const watchArrivals = async (ids: readonly string[], seconds: number, each?: (state: ViewerState, seen: ReadonlyMap<string, ArrivalSeen>) => void): Promise<{ readonly seen: Map<string, ArrivalSeen>; readonly state: ViewerState }> => {
    const seen = new Map<string, ArrivalSeen>(ids.map((id) => [id, { waitedFrom: Infinity, warpedFrom: 0, from: null, landing: null, landedAt: null }]));
    const state = await WaitFor('every arrival to drop out of warp', seconds, (polled) => {
      each?.(polled, seen);
      for (const id of ids) {
        const ship = ShipIn(polled, id);
        const record = seen.get(id) as ArrivalSeen;
        const { arrival } = ship;
        if (arrival) {
          record.from = arrival.from;
          record.landing = arrival.landing;
          const away = ship.position ? between(ship.position, arrival.landing) : null;
          if (away != null && (arrival.state === 'parked' || arrival.state === 'scheduled')) record.waitedFrom = Math.min(record.waitedFrom, away);
          if (away != null && arrival.state === 'warping') record.warpedFrom = Math.max(record.warpedFrom, away);
          if (arrival.landedAt != null) record.landedAt ??= arrival.landedAt;
        } else if (record.landing && record.landedAt == null) {
          // A follower's arrival ends as it starts to follow: this poll's tick bounds its exit.
          record.landedAt = polled.simulation.tick;
        }
      }
      const pending = ids.find((id) => seen.get(id)?.landedAt == null);
      return pending ? `${pending} ${JSON.stringify(ShipIn(polled, pending).arrival ?? null)}` : null;
    });
    return { seen, state };
  };
  const formationReady = (fleet: string) => (polled: ViewerState) => (polled.fleets.find((group) => group.id === fleet)?.formation?.ready ? null : JSON.stringify(polled.fleets.find((group) => group.id === fleet)?.formation ?? null));
  const rifterFleet = (id: string, count = 2) => ({ id, commander: { hull: 'Rifter' }, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ hull: 'Rifter', count }] }] }] });

  await Check('warp-in: three Rifters land staggered at their placements, a warp-in flash each and no warp-out', async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in' } });
    const before = flashesOf(await call<ViewerState>('get_state'));
    const result = await call<AddShipsResult>('add_ships', { hull: 'Rifter', count: 3, formation: 'line', position: [0, 0, 0], warpIn: true }).catch(SkipWithoutSde);
    const ids = result.added.ships;
    Expect(ids.length === 3 && result.arrivals?.length === 1, JSON.stringify({ ids, arrivals: result.arrivals }));
    const { seen, state } = await watchArrivals(ids, 120);
    const placed = new Map(result.scene.ships.map((ship) => [ship.id, ship.position]));
    let worst = 0;
    for (const id of ids) {
      const record = seen.get(id) as ArrivalSeen;
      const off = between(ShipIn(state, id).position ?? [Infinity, 0, 0], placed.get(id) ?? [0, 0, 0]);
      worst = Math.max(worst, off);
      Expect(record.waitedFrom >= 2_000_000 && record.warpedFrom >= 150_000 && off <= 1000, `${id}: waited ${Math.round(record.waitedFrom)} m out, warped from ${Math.round(record.warpedFrom)} m, landed ${Math.round(off)} m off its placement`);
    }
    const exits = [...new Set(ids.map((id) => seen.get(id)?.landedAt))];
    Expect(exits.length >= 2, `exit ticks ${exits.join(', ')}`);
    const flashed = await WaitFor('a warp-in flash each', 10, (polled) => (flashesOf(polled).warpIn - before.warpIn >= 3 ? null : JSON.stringify(flashesOf(polled))));
    const flashes = flashesOf(flashed);
    Expect(flashes.warpOut === before.warpOut, `warp-outs ${before.warpOut} -> ${flashes.warpOut}`);
    return `exit ticks ${exits.join(', ')}; landed at most ${Math.round(worst)} m off; warp-in flashes +${flashes.warpIn - before.warpIn}, warp-out +0`;
  });

  await Check('warp-in: orders on an arriving ship are refused', async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in-refusals' } });
    const result = await call<AddShipsResult>('add_ships', { hull: 'Rifter', count: 1, position: [0, 0, 0], warpIn: true }).catch(SkipWithoutSde);
    const [id] = result.added.ships;
    const refused = await call('order_ship', { id, order: { type: 'stop' } }).then(() => null, ErrorMessage);
    Expect(refused != null && /arriving by warp/u.test(refused), `order_ship: ${refused}`);
    const prop = await call('switch_prop_mods', { ships: [id], active: true }).then(() => null, ErrorMessage);
    const report = ShipIn(await call<ViewerState>('get_state'), id);
    Expect(prop != null || report.propMod?.state !== 'active', `switch_prop_mods: ${prop}, ${JSON.stringify(report.propMod)}`);
    return refused ?? '';
  });

  await Check('warp-in: an inline TFI fleet holds for its FC, forms up within 90 s, logi at 30 km', async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in-fleet' } });
    const composition = {
      id: 'wi',
      commander: { hull: 'Tempest Fleet Issue' },
      wings: [
        {
          id: 'w',
          squads: [
            { id: 'dps', role: 'dps', ships: [{ hull: 'Tempest Fleet Issue', count: 3 }] },
            { id: 'logi', role: 'logi', ships: [{ hull: 'Guardian', count: 2 }] }
          ]
        }
      ]
    };
    const added = await call<AddedFleetResult>('add_fleet_composition', { composition, position: [0, 0, 0], warpIn: true }).catch(SkipWithoutSde);
    const { commander, ships } = added.added;
    const members = ships.filter((id) => id !== commander);
    // A member whose arrival ended (it follows) while the FC is still arriving did not hold.
    const strays = new Set<string>();
    const { seen } = await watchArrivals(ships, 150, (polled, records) => {
      if (!ShipIn(polled, commander).arrival || ShipIn(polled, commander).arrival?.state === 'landed') return;
      for (const id of members) if (!ShipIn(polled, id).arrival && records.get(id)?.landing) strays.add(id);
    });
    Expect(!strays.size, `followed before the FC landed: ${[...strays].join(', ')}`);
    const fcAt = seen.get(commander)?.landedAt ?? Infinity;
    const early = members.filter((id) => (seen.get(id)?.landedAt ?? Infinity) < fcAt);
    const earlyTicks = early.map((id) => id + ' ' + String(seen.get(id)?.landedAt)).join(', ');
    Expect(!early.length, `landed before the FC (tick ${fcAt}): ${earlyTicks}`);
    const formed = await WaitFor('every member in formation', 90, (polled) => NotInFormation(polled, members), 2);
    const logi = members.filter((id) => ShipIn(formed, id).role === 'logi');
    const lead = logi.map((id) => ShipIn(formed, id)).find((ship) => ship.anchor?.ship === commander);
    const range = lead?.following?.distance ?? NaN;
    Expect(lead?.anchor?.range === 30000 && Math.abs(range - 30000) <= 3000, `logi lead ${JSON.stringify({ anchor: lead?.anchor, following: lead?.following })}`);
    const landed = [...seen.values()].map((record) => record.landedAt ?? 0);
    return `landed ticks ${Math.min(...landed)}-${Math.max(...landed)}, FC first; formed at tick ${formed.simulation.tick}; logi lead ${Math.round(range)} m off the FC`;
  });

  await Check('warp-in: a stage_engagement side lands onto the other', async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in-engagement' } });
    await call<SetLocationResult>('set_location', { celestial: CNAP, range: 30000 }).catch(SkipWithoutSde);
    const result = await call<StageEngagementResult>('stage_engagement', {
      sides: [{ ships: [{ hull: 'Rifter', count: 3 }] }, { ships: [{ hull: 'Slasher', count: 3 }], warpIn: true }],
      range: 20000,
      near: { celestial: CNAP, range: 40000 }
    }).catch(SkipWithoutSde);
    const [blue, red] = result.engagement.sides;
    Expect(result.arrivals?.length === 1 && !blue.ships.some((id) => result.arrivals?.[0]?.ships.some((ship) => ship.id === id)), JSON.stringify(result.arrivals));
    const { seen, state } = await watchArrivals(red.ships, 120);
    const placed = new Map(result.scene.ships.map((ship) => [ship.id, ship.position]));
    const toBlue = (blue.lead?.position ?? [0, 0, 0]).map((value, axis) => value - (red.lead?.position ?? [0, 0, 0])[axis]);
    for (const id of red.ships) {
      const record = seen.get(id) as ArrivalSeen;
      const lane = (record.landing ?? [0, 0, 0]).map((value, axis) => value - (record.from ?? [0, 0, 0])[axis]);
      const onto = lane[0] * toBlue[0] + lane[1] * toBlue[1] + lane[2] * toBlue[2];
      Expect(between(record.landing ?? [Infinity, 0, 0], placed.get(id) ?? [0, 0, 0]) <= 1 && onto > 0, `${id}: landing ${JSON.stringify(record.landing)} vs ${JSON.stringify(placed.get(id))}, lane ${JSON.stringify(lane)}`);
    }
    const gap = between(ShipIn(state, red.lead?.id ?? '').position ?? [Infinity, 0, 0], ShipIn(state, blue.lead?.id ?? '').position ?? [0, 0, 0]);
    Expect(Math.abs(gap - 20000) <= 3000, `leads ${Math.round(gap)} m apart after the landing`);
    return `${red.ships.length} ${red.team} ships landed ${Math.round(gap)} m from the ${blue.team} lead, warping toward it`;
  });

  await Check("warp-in: joiners land at a moved fleet's live slots", async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in-join' } });
    const added = await call<AddedFleetResult>('add_fleet_composition', { composition: rifterFleet('jw'), position: [0, 0, 0] }).catch(SkipWithoutSde);
    const fc = added.added.commander;
    await WaitFor('the jw formation is ready', 60, formationReady('jw'));
    await WaitFor('the FC gets its warp speed', 30, (polled) => ((ShipIn(polled, fc).physics?.warpSpeed ?? 0) > 0 ? null : JSON.stringify(ShipIn(polled, fc).physics)));
    await call<OrderFleetResult>('order_fleet', { fleet: 'jw', order: { type: 'warp', point: [0, 0, 400000] } });
    const moved = await WaitFor('the jw fleet lands 400 km on', 90, (polled) => (ShipIn(polled, fc).warp?.phase === 'landed' && between(ShipIn(polled, fc).position ?? [0, 0, 0], [0, 0, 400000]) < 20000 ? null : JSON.stringify(ShipIn(polled, fc).warp ?? null)));
    const live = ShipIn(moved, fc).position ?? [0, 0, 0];
    const result = await call<AddShipsResult>('add_ships', { hull: 'Rifter', count: 2, fleet: { id: 'jw', squad: 'dps' }, warpIn: true });
    const { seen } = await watchArrivals(result.added.ships, 120);
    for (const id of result.added.ships) {
      const landing = seen.get(id)?.landing ?? [Infinity, 0, 0];
      Expect(between(landing, live) <= 5000, `${id} lands ${Math.round(between(landing, live))} m from the FC's live position (${Math.round(between(landing, [0, 0, 0]))} m from its placement)`);
    }
    await WaitFor('the joiners in formation', 60, (polled) => NotInFormation(polled, result.added.ships), 2);
    return `${result.added.ships.join(', ')} landed within ${Math.round(Math.max(...result.added.ships.map((id) => between(seen.get(id)?.landing ?? [0, 0, 0], live))))} m of the moved FC`;
  });

  await Check('warp-in: order_ship warps to the CNAP and a moon by name; a far planet and approach on a planet are refused', async () => {
    await call('load_scene', {
      scene: {
        name: 'verify-warp-names',
        ships: [
          { id: 'a', dna: RIFTER_DNA, type: 'Rifter', position: [0, 0, 0] },
          { id: 'b', dna: RIFTER_DNA, type: 'Rifter', position: [0, 0, 1000] }
        ]
      }
    });
    const set = await call<SetLocationResult>('set_location', { celestial: CNAP, range: 300000 }).catch(SkipWithoutSde);
    // The CNAP's centre sits at minus the anchor offset (the origin is offset off it); its SDE radius is 100 km.
    const station = (set.location.anchor?.offset ?? [0, 0, 0]).map((value) => -value);
    await WaitFor('the location targets', 20, (polled) => (polled.location?.status === 'ready' && (ShipIn(polled, 'b').physics?.warpSpeed ?? 0) > 0 ? null : JSON.stringify(polled.location?.status)));
    const far = await call('order_ship', { id: 'b', order: { type: 'warp', target: 'Jita I' } }).then(() => null, ErrorMessage);
    Expect(far != null && /set_location there first/u.test(far), `Jita I: ${far}`);
    const approach = await call('order_ship', { id: 'b', order: { type: 'approach', target: 'Jita IV - Moon 4' } }).then(() => null, ErrorMessage);
    Expect(approach != null && /warp/u.test(approach), `approach on a moon: ${approach}`);
    const toStation = await call<{ resolved?: ResolvedOrderTarget }>('order_ship', { id: 'a', order: { type: 'warp', target: CNAP, range: 10000 } });
    Expect(toStation.resolved?.target === 'celestial:60003760', JSON.stringify(toStation));
    const moon = await call<{ resolved?: ResolvedOrderTarget }>('order_ship', { id: 'b', order: { type: 'warp', target: 'Jita IV - Moon 4', range: 20000 } });
    Expect(moon.resolved?.kind === 'moon' && moon.resolved.point != null, JSON.stringify(moon));
    const landed = await WaitFor('both warps land', 120, (polled) => (['a', 'b'].every((id) => ShipIn(polled, id).warp?.phase === 'landed') ? null : JSON.stringify(['a', 'b'].map((id) => ShipIn(polled, id).warp?.phase))));
    const offMoon = between(ShipIn(landed, 'b').position ?? [Infinity, 0, 0], moon.resolved?.point ?? [0, 0, 0]);
    const offStation = between(ShipIn(landed, 'a').position ?? [Infinity, 0, 0], station) - 100000;
    Expect(offMoon <= 5000 && Math.abs(offStation - 10000) <= 5000, `b ${Math.round(offMoon)} m off its moon landing; a ${Math.round(offStation)} m off the CNAP`);
    return `a ${Math.round(offStation)} m off the CNAP; b ${Math.round(offMoon)} m off its Moon 4 landing; refused: ${far?.split(';')[0]} / ${approach}`;
  });

  await Check('warp-in: order_fleet warps to an object by name, every member warping', async () => {
    await call('load_scene', { scene: { name: 'verify-warp-names-fleet' } });
    const added = await call<AddedFleetResult>('add_fleet_composition', { composition: rifterFleet('jo'), position: [0, 0, 0] }).catch(SkipWithoutSde);
    await call('add_objects', { objects: [{ type: 'Astrahus', id: 'keep', name: 'Verify Keep', position: [0, 0, 600000] }] });
    await WaitFor('the jo formation is ready', 60, formationReady('jo'));
    await WaitFor('warp speeds', 30, (polled) => added.added.ships.map((id) => ShipIn(polled, id)).find((ship) => !((ship.physics?.warpSpeed ?? 0) > 0))?.id ?? null);
    const before = flashesOf(await call<ViewerState>('get_state'));
    const ordered = await call<OrderFleetResult>('order_fleet', { fleet: 'jo', order: { type: 'warp', target: 'verify keep', range: 5000 } });
    Expect(ordered.resolved?.kind === 'object' && ordered.resolved.target === 'keep', JSON.stringify(ordered.resolved));
    const warped = new Set<string>();
    const state = await WaitFor('every member warps, a warp-out each', 90, (polled) => {
      for (const id of added.added.ships) if (ShipIn(polled, id).warp?.phase === 'warping') warped.add(id);
      const out = flashesOf(polled).warpOut - before.warpOut;
      return warped.size === added.added.ships.length && out >= added.added.ships.length ? null : `warped ${[...warped].join(', ')}; warp-outs +${out}`;
    });
    return `${warped.size} members warped to "${ordered.resolved?.name}"; warp-outs +${flashesOf(state).warpOut - before.warpOut}`;
  });

  await Check("warp-in: the warp-in shot anchors at an arriving fleet's landing; other hardpoints refuse it", async () => {
    await call('load_scene', { scene: { name: 'verify-warp-in-shot' } });
    const added = await call<AddedFleetResult>('add_fleet_composition', { composition: rifterFleet('ws'), position: [0, 0, 0], warpIn: true }).catch(SkipWithoutSde);
    const landing = added.scene.ships.find((ship) => ship.id === added.added.commander)?.position ?? [0, 0, 0];
    await playShot({ shot: 'warp-in', fleet: 'ws' });
    const anchored = await WaitFor('the warp-in anchor', 20, (polled) => {
      const pose = cinemaOf(polled).pose;
      return pose && between(pose.look, landing) <= 5000 ? null : JSON.stringify(polled.cinema);
    });
    const arriving = added.added.ships.filter((id) => ShipIn(anchored, id).arrival && ShipIn(anchored, id).arrival?.state !== 'landed');
    Expect(arriving.length > 0, 'the fleet landed before the shot anchored');
    const eye = cinemaOf(anchored).pose?.eye ?? [0, 0, 0];
    const refused = await playShot({ hardpoint: { name: 'flank-port', fleet: 'ws' } }).then(() => null, ErrorMessage);
    const note = refused ?? cinemaOf(await call<ViewerState>('get_state')).note ?? '';
    Expect(/still arriving by warp/u.test(note), `flank-port: ${note}`);
    return `anchored ${Math.round(between(eye, landing))} m from the landing with ${arriving.length} still arriving; flank-port: ${note}`;
  });

  // The timeline (T2): each check loads its own scripted scene. The ships carry all four stats, so only the called-targets
  // check needs the SDE; --only timeline: runs them alone.
  const TIMELINE_STATS = { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35 };
  const Scripted = (id: string, position: SceneVector, extra: object = {}) => ({ id, dna: 'mf4_t1:minmatarbase:minmatar', type: 'Rifter', position, stats: TIMELINE_STATS, ...extra });
  const TimelineOf = (state: ViewerState): Maybe<TimelineSummary> => (state as unknown as { readonly timeline?: Maybe<TimelineSummary> }).timeline ?? null;
  const HeldOf = (state: ViewerState): boolean => (state.simulation as { readonly held?: boolean }).held === true;
  const ScriptOf = (state: ViewerState, id: string): Maybe<ShipScriptReport> => (ShipIn(state, id) as { readonly script?: ShipScriptReport }).script ?? null;
  const TimelineTool = (args: Record<string, unknown> = {}) => call<TimelineToolReport>('timeline', args);
  const LoadTimeline = (scene: object, args: Record<string, unknown> = {}) => call<{ readonly warnings: string[] }>('load_scene', { scene: { name: 'verify-timeline', ...scene }, ...args });
  const WaitTimeline = (what: string, seconds: number, test: (timeline: Maybe<TimelineSummary>, state: ViewerState) => Maybe<string>) => WaitFor(what, seconds, (polled) => test(TimelineOf(polled), polled));
  const Played = (what: string, seconds: number, time: number) => WaitTimeline(what, seconds, (timeline) => ((timeline?.time ?? -1) >= time ? null : Show(timeline)));
  const Done = (seconds: number) => WaitTimeline('the timeline is done', seconds, (timeline) => (timeline?.state === 'done' ? null : Show(timeline)));
  const FiredAt = (report: TimelineToolReport): Record<string, number> => Object.fromEntries(report.list.filter((cue) => cue.tick != null).map((cue) => [cue.id, (cue.tick ?? 0) - (report.startedAt ?? 0)]));
  const Direction = (ship: string, direction: SceneVector) => ({ order_ship: { id: ship, order: { type: 'direction', direction } } });

  await Check('timeline: a scripted scene prepares with the clock held, then fires each cue on its tick', async () => {
    const before = (await call<ViewerState>('get_state')).simulation.tick;
    await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0]), Scripted('b', [0, 0, 5000])],
      timeline: [
        { id: 'go', at: 0, ...Direction('a', [0, 0, 1]) },
        { id: 'mwd', at: 2.5, switch_prop_mods: { ships: ['a'], active: true } },
        { id: 'lock', at: 3, set_target: { ships: ['a'], target: 'b' } },
        { id: 'halt', at: 5, order_ship: { id: 'a', order: { type: 'stop' } } }
      ]
    });
    const first = await call<ViewerState>('get_state');
    const opening = `${TimelineOf(first)?.state}${HeldOf(first) ? ' (held)' : ''}`;
    Expect(['preparing', 'playing', 'ready'].includes(TimelineOf(first)?.state ?? '') && (TimelineOf(first)?.state !== 'preparing' || HeldOf(first)), `after the load: ${opening}`);
    const done = await Done(30);
    const report = await TimelineTool();
    const fired = FiredAt(report);
    Expect((report.startedAt ?? 0) >= before, `t = 0 at ${report.startedAt}, before the load ${before}`);
    Expect(fired['go'] === 0 && fired['mwd'] === 3 && fired['lock'] === 3 && fired['halt'] === 5, Show(fired));
    const since = (ShipIn(done, 'a').propMod as Maybe<{ readonly since?: number }>)?.since;
    Expect(since === (report.startedAt ?? 0) + 3, `prop mod since ${since}, t = 0 at ${report.startedAt}`);
    Expect(report.cues.fired === 4 && report.cues.total === 4 && !HeldOf(done), Show(report.cues));
    return `${opening} after the load; t = 0 at tick ${report.startedAt}; fired at +${Object.values(fired).join(', +')}`;
  });

  await Check('timeline: ship orders chain on completion, after and duration', async () => {
    await LoadTimeline({ ships: [Scripted('a', [0, 0, 0], { orders: [{ type: 'goto', point: [0, 0, 3000] }, { type: 'stop' }, { after: 2, type: 'direction', direction: [1, 0, 0], duration: 5 }, { type: 'stop' }] })] });
    const states: string[] = [];
    const steps = new Map<number, number>();
    let applied: Maybe<number> = null;
    await WaitFor('the script is done', 60, (polled) => {
      const script = ScriptOf(polled, 'a');
      const label = `${script?.step}:${script?.state}`;
      if (script && states[states.length - 1] !== label) states.push(label);
      if (script && !steps.has(script.step)) steps.set(script.step, polled.simulation.tick);
      if (applied == null && ShipIn(polled, 'a').order?.type === 'direction') applied = polled.simulation.tick;
      return script?.state === 'done' ? null : Show(script);
    });
    const waitStart = steps.get(2) ?? 0;
    Expect(applied != null && Math.abs(applied - waitStart - 2) <= 1, `step 2 waited from ${waitStart}, its order applied at ${applied}`);
    Expect(steps.get(3) != null && Math.abs((steps.get(3) ?? 0) - (applied ?? 0) - 5) <= 1, `step 2 applied at ${applied}, step 3 from ${steps.get(3)}`);
    return states.join(' -> ');
  });

  await Check('timeline: a patch cue adds a ship to the live scene; get_scene and save_scene keep the authored document', async () => {
    await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0])],
      timeline: [
        { id: 'add', at: 2, patch_scene: { operations: [{ op: 'add_ship', ship: Scripted('late', [2000, 0, 0]) }] } },
        { id: 'fly', at: 4, order_ship: { id: 'late', order: { type: 'goto', point: [2000, 0, 3000] } } }
      ]
    });
    const done = await Done(30);
    const authored = await call<SceneDocument>('get_scene');
    const live = await call<SceneDocument>('get_scene', { live: true });
    const cue = authored.timeline?.cues.find((candidate) => candidate.id === 'add');
    Expect(done.ships.some((ship) => ship.id === 'late') && live.ships.some((ship) => ship.id === 'late'), 'late is live');
    Expect(!authored.ships.some((ship) => ship.id === 'late') && Show(cue?.adds?.ships) === '["late"]', `authored: ${authored.ships.map((ship) => ship.id).join(', ')}; adds ${Show(cue?.adds)}`);
    Expect(TimelineOf(done)?.liveEdits?.count === 1, Show(TimelineOf(done)?.liveEdits));
    await call('save_scene', { name: 'verify-timeline-saved' });
    const saved = await scenes.Get('verify-timeline-saved');
    Expect(saved != null && !saved.document.ships.some((ship) => ship.id === 'late') && saved.document.timeline?.cues.length === 2, `saved: ${Show(saved?.document.ships.map((ship) => ship.id))}`);
    await TimelineTool({ action: 'restart' });
    const restarted = await call<ViewerState>('get_state');
    Expect(!restarted.ships.some((ship) => ship.id === 'late'), 'late is still there after the restart');
    const back = await WaitFor('late comes back at 2 s', 20, (polled) => (polled.ships.some((ship) => ship.id === 'late') ? null : Show(TimelineOf(polled))));
    return `late live, not authored; saved ${saved?.document.ships.length} ship(s) with ${saved?.document.timeline?.cues.length} cues; back at ${TimelineOf(back)?.time} s after the restart`;
  });

  await Check('timeline: a targets cue calls a primary for the fleet', async () => {
    await LoadCombatScene(
      [Punisher('b1', [0, 0, 0]), Punisher('b2', [0, 0, 800]), Rifter('r1', [0, 0, 20000])],
      { death: 'flag' },
      {
        fleets: [{ id: 'b', commander: 'b1', wings: [{ id: 'b-w', squads: [{ id: 'b-s', role: 'dps', members: ['b2'] }] }] }],
        timeline: [{ id: 'call', at: 1, order_fleet: { fleet: 'b', order: { type: 'targets', primary: 'r1' } } }]
      }
    );
    const called = await WaitFor('the members take the call', 30, (polled) => (['b1', 'b2'].every((id) => ShipIn(polled, id).target?.id === 'r1') ? null : Show(['b1', 'b2'].map((id) => ShipIn(polled, id).target))));
    const report = await TimelineTool();
    Expect(FiredAt(report)['call'] === 1, Show(FiredAt(report)));
    Expect(ShipIn(called, 'b2').target?.source === 'called', Show(ShipIn(called, 'b2').target));
    return `fired at +1; b1 ${Show(ShipIn(called, 'b1').target?.source)}, b2 ${Show(ShipIn(called, 'b2').target?.source)}`;
  });

  await Check('timeline: edits while playing: missed, retimed, pruned, refused, live only', async () => {
    await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0]), Scripted('b', [0, 0, 4000])],
      timeline: [
        { id: 'go', at: 1, ...Direction('a', [0, 0, 1]) },
        { id: 'add', at: 2, patch_scene: { operations: [{ op: 'add_ship', ship: Scripted('late', [3000, 0, 0]) }] } },
        { id: 'later', at: 60, order_ship: { id: 'a', order: { type: 'stop' } } },
        { id: 'b-go', at: 70, ...Direction('b', [1, 0, 0]) },
        { id: 'move-a', at: 80, patch_scene: { operations: [{ op: 'update_ship', id: 'a', set: { position: [0, 0, 100] } }] } }
      ]
    });
    const at = (await Played('the timeline reaches 4 s', 30, 4).then(TimelineOf))?.time ?? 4;
    await call('patch_scene', { operations: [{ op: 'add_cue', cue: { id: 'past', at: 1, ...Direction('a', [1, 0, 0]) } }] });
    await call('patch_scene', { operations: [{ op: 'update_cue', id: 'later', set: { at: at + 3, ...Direction('a', [0, 1, 0]) } }] });
    const pruned = await call<{ readonly warnings: string[] }>('patch_scene', { operations: [{ op: 'remove_ship', id: 'b' }] });
    const refused = await call('patch_scene', { operations: [{ op: 'remove_ship', id: 'a' }] }).then(() => null, ErrorMessage);
    const liveOnly = await call<{ readonly warnings: string[] }>('patch_scene', { operations: [{ op: 'update_ship', id: 'late', set: { name: 'Late Rifter' } }] });
    await WaitTimeline('the retimed cue fires', 20, (timeline) => (timeline?.last?.some((cue) => cue.id === 'later' && cue.state === 'fired') ? null : Show({ last: timeline?.last, failed: timeline?.failed })));
    const report = await TimelineTool();
    const state = (id: string) => report.list.find((cue) => cue.id === id)?.state;
    Expect(state('past') === 'missed', `past: ${state('past')}`);
    Expect(state('later') === 'fired' && !report.list.some((cue) => cue.id === 'b-go'), `later ${state('later')}; ${report.list.map((cue) => cue.id).join(', ')}`);
    Expect(
      pruned.warnings.some((warning) => warning.includes('b-go')),
      Show(pruned.warnings)
    );
    Expect(refused != null && refused.includes('move-a'), `remove a: ${refused}`);
    Expect(
      liveOnly.warnings.some((warning) => warning.startsWith('applies live only')),
      Show(liveOnly.warnings)
    );
    return `missed, retimed to ${at + 3} s and fired; pruned "${pruned.warnings[0]}"; refused "${refused?.slice(0, 80)}"`;
  });

  await Check('timeline: pause holds the cues and scripts; play resumes them later', async () => {
    await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])], timeline: [{ id: 'late', at: 4, ...Direction('a', [0, 0, 1]) }] });
    const started = await Played('the timeline plays', 30, 1);
    const paused = await TimelineTool({ action: 'pause' });
    const pausedTick = (await call<ViewerState>('get_state')).simulation.tick;
    await Delay(5000);
    const still = await TimelineTool();
    Expect(still.state === 'paused' && still.cues.fired === 0 && still.time === paused.time, Show({ state: still.state, time: still.time, cues: still.cues }));
    const playTick = (await call<ViewerState>('get_state')).simulation.tick;
    await TimelineTool({ action: 'play' });
    await Done(20);
    const report = await TimelineTool();
    const firedAt = FiredAt(report)['late'];
    const shift = playTick - pausedTick;
    Expect(Math.abs(firedAt - (4 + shift)) <= 1, `fired at +${firedAt}, paused ${shift} ticks`);
    return `paused at ${paused.time} s (t ${TimelineOf(started)?.time}) for ${shift} ticks; fired at +${firedAt}`;
  });

  await Check('timeline: camera cues drive the cinema as the timeline; camera off skips them', async () => {
    const pose = (eye: SceneVector) => ({ play_shot: { pose: { eye, look: { ship: 'a' } } } });
    await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0])],
      timeline: [
        { id: 'shot', at: 1, ...pose([0, 2000, -8000]) },
        { id: 'stop', at: 3, stop_shot: {} },
        { id: 'again', at: 6, ...pose([0, 4000, -8000]) }
      ]
    });
    const driven = await WaitFor('the timeline drives the camera', 20, (polled) => ((polled.cinema as { readonly driver?: string }).driver === 'timeline' ? null : Show(polled.cinema)));
    const stopped = await WaitFor('the stop cue hands it back', 20, (polled) => ((polled.cinema as { readonly state?: string }).state === 'idle' ? null : Show(polled.cinema)));
    await TimelineTool({ camera: false });
    await Done(20);
    const report = await TimelineTool({ camera: true });
    const again = report.list.find((cue) => cue.id === 'again');
    Expect(again?.state === 'skipped' && again.note === "the timeline's camera is off", Show(again));
    return `driver ${(driven.cinema as { readonly driver?: string }).driver}, then ${(stopped.cinema as { readonly state?: string }).state}; again ${again?.state}`;
  });

  await Check('timeline: bad timelines are refused with every problem; a name target only warns', async () => {
    // A cue that fails to read skips the projection, so unknown ids are refused in a second load.
    const error = await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0], { orders: [{ type: 'orbit', target: 'a2', range: 500 }, { type: 'stop' }] }), Scripted('a2', [0, 0, 3000])],
      timeline: [
        { at: -1, ...Direction('a', [0, 0, 1]) },
        { at: 2, when: 'later', ...Direction('a', [0, 0, 1]) },
        { at: 2, ...Direction('a', [0, 0, 1]), cease_fire: { ships: ['a'] } },
        { at: 2, patch_scene: { operations: [{ op: 'set_environment', environment: { universe: 'res:/x' } }] } }
      ]
    }).then(() => null, ErrorMessage);
    const unknown = await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0])],
      timeline: [
        { at: 1, order_ship: { id: 'ghost', order: { type: 'stop' } } },
        { at: 1, order_fleet: { fleet: 'nofleet', order: { type: 'stop' } } }
      ]
    }).then(() => null, ErrorMessage);
    const missing = ['at must be', 'when is reserved', 'exactly one action', 'set_environment', 'never ends'].filter((text) => !(error ?? '').includes(text));
    Expect(error != null && !missing.length, `missing ${missing.join(', ')} in: ${error}`);
    Expect(unknown != null && ['ghost', 'nofleet'].every((text) => unknown.includes(text)), `unknown ids: ${unknown}`);
    const named = await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])], timeline: [{ at: 1, order_ship: { id: 'a', order: { type: 'approach', target: 'Some Station' } } }] });
    Expect(
      named.warnings.some((warning) => warning.includes('Some Station')),
      Show(named.warnings)
    );
    return `${(error ?? '').split(';').length} problems in one error; name: "${named.warnings.find((warning) => warning.includes('Some Station'))}"`;
  });

  await Check('timeline: a paused load holds at t = 0 until play', async () => {
    await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])], timeline: [{ id: 'go', at: 0, ...Direction('a', [0, 0, 1]) }] }, { timeline: 'pause' });
    const ready = await WaitTimeline('the timeline is ready', 30, (timeline) => (timeline?.state === 'ready' ? null : Show(timeline)));
    Expect(HeldOf(ready), 'the clock is not held');
    await Delay(3000);
    const still = await call<ViewerState>('get_state');
    Expect(TimelineOf(still)?.cues.fired === 0 && still.simulation.tick === ready.simulation.tick, `fired ${TimelineOf(still)?.cues.fired}, tick ${ready.simulation.tick} -> ${still.simulation.tick}`);
    await TimelineTool({ action: 'play' });
    const done = await Done(20);
    return `ready and held at tick ${ready.simulation.tick} for 3 s; played: ${TimelineOf(done)?.cues.fired} fired from tick ${TimelineOf(done)?.startedAt}`;
  });

  // T3: a replay is the same run. (j) records it twice; (k) reads the two runs' delays and staggers.
  interface ReplayRun {
    readonly startedAt: number;
    readonly fired: Record<string, number>;
    readonly delays: unknown;
    readonly landings: Record<string, number>;
    readonly kills: Record<string, number>;
    readonly positions: Record<string, number[]>;
  }
  const replays: ReplayRun[] = [];
  const REPLAY_SECONDS = 55;
  const ReplayRunOf = async (): Promise<ReplayRun> => {
    const landings: Record<string, number> = {};
    const end = await WaitFor(`timeline time ${REPLAY_SECONDS}`, REPLAY_SECONDS + 90, (polled) => {
      const timeline = TimelineOf(polled);
      const startedAt = timeline?.startedAt;
      for (const group of (polled.arrivals ?? []) as unknown as { readonly ships: { readonly id: string; readonly landsIn?: number }[] }[]) {
        for (const ship of group.ships) if (startedAt != null && ship.landsIn != null && landings[ship.id] == null) landings[ship.id] = polled.simulation.tick + ship.landsIn - startedAt;
      }
      return (timeline?.time ?? -1) >= REPLAY_SECONDS ? null : Show(timeline);
    });
    const report = await TimelineTool();
    const startedAt = report.startedAt ?? 0;
    const kills = Object.fromEntries((end.combat?.kills ?? []).filter((kill) => kill.tick - startedAt <= REPLAY_SECONDS).map((kill) => [kill.ship, kill.tick - startedAt]));
    // Everyone is stopped by now (blue at 25 s, red never moves, the warp-ins formed): their positions are final.
    const positions = Object.fromEntries(end.ships.filter((ship) => ship.position && !kills[ship.id]).map((ship) => [ship.id, (ship.position ?? [0, 0, 0]).map((value) => Math.round(value))]));
    const delays = (report.list.find((cue) => cue.id === 'approach') as Maybe<{ readonly result?: { readonly delays?: unknown } }>)?.result?.delays ?? null;
    return { startedAt, fired: FiredAt(report), delays, landings, kills, positions };
  };

  await Check('timeline: the same script replays the same: cue, landing and kill ticks, final positions', async () => {
    const red = (id: string, position: SceneVector) => ({ ...Rifter(id, position), team: 'red' });
    const blue = (id: string, position: SceneVector) => ({ ...Punisher(id, position), team: 'blue' });
    const rifter = { hull: 'Rifter', dna: 'mf4_t1:minmatarbase:minmatar', radius: 31 };
    await LoadCombatScene(
      [blue('b1', [0, 0, 0]), blue('b2', [800, 0, 0]), blue('b3', [-800, 0, 0]), red('r1', [0, 0, 14000]), red('r2', [900, 0, 14500]), red('r3', [-900, 0, 14500])],
      { seed: 7, death: 'explode' },
      {
        fleets: [{ id: 'b', commander: 'b1', wings: [{ id: 'b-w', squads: [{ id: 'b-s', role: 'dps', members: ['b2', 'b3'] }] }] }],
        timeline: [
          { id: 'engage', at: 1, engage: { ships: ['r1', 'r2', 'r3'], target: 'b1' } },
          { id: 'approach', at: 2, order_fleet: { fleet: 'b', delay: 0.5, order: { type: 'approach', target: 'r1' } } },
          { id: 'reinforce', at: 3, patch_scene: { operations: [{ op: 'add_fleet_composition', composition: { id: 'rw', commander: rifter, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ ...rifter, count: 1 }] }] }] }, position: [0, 0, 9000], heading: 180, team: 'red', warpIn: true }] } },
          { id: 'call', at: 6, order_fleet: { fleet: 'b', order: { type: 'targets', set: ['r1', 'r2', 'r3'] } } },
          { id: 'halt', at: 25, order_fleet: { fleet: 'b', order: { type: 'stop' } } }
        ]
      }
    );
    replays.length = 0;
    replays.push(await ReplayRunOf());
    await TimelineTool({ action: 'restart' });
    replays.push(await ReplayRunOf());
    const [first, second] = replays;
    Expect(Object.keys(first.fired).length === 5 && Object.keys(first.landings).length === 2, `fired ${Show(first.fired)}, landings ${Show(first.landings)}`);
    for (const key of ['fired', 'landings', 'kills', 'positions'] as const) Expect(Show(first[key]) === Show(second[key]), `${key}: ${Show(first[key])} then ${Show(second[key])}`);
    return `t = 0 at ticks ${first.startedAt} and ${second.startedAt}; cues at ${Show(first.fired)}; landed at ${Show(first.landings)}; kills ${Show(first.kills)}; ${Object.keys(first.positions).length} final positions equal`;
  });

  await Check('timeline: pilot delays and warp-in staggers are keyed on scene ticks across restarts', async () => {
    Expect(replays.length === 2, 'the replay check did not record two runs');
    const [first, second] = replays;
    Expect(first.startedAt !== second.startedAt, `both runs started at tick ${first.startedAt}`);
    Expect(first.delays != null && Show(first.delays) === Show(second.delays), `delays ${Show(first.delays)} then ${Show(second.delays)}`);
    const offsets = (run: ReplayRun) => Object.values(run.landings).map((tick) => tick - Math.min(...Object.values(run.landings)));
    Expect(Show(offsets(first)) === Show(offsets(second)), `landing offsets ${Show(offsets(first))} then ${Show(offsets(second))}`);
    return `started at ticks ${first.startedAt} and ${second.startedAt}: delays ${Show(first.delays)} both times, landing offsets ${Show(offsets(first))}`;
  });

  // T4: a lever tool given at becomes a cue instead of running now; hub tools resolve against get_scene { at }.
  await Check('timeline: at on order_fleet, switch_prop_mods and play_shot makes cues that change nothing now and fire later', async () => {
    await LoadTimeline({ ships: [Scripted('b1', [0, 0, 0]), Scripted('b2', [1000, 0, 0])], fleets: [{ id: 'b', commander: 'b1', wings: [{ id: 'b-w', squads: [{ id: 'b-s', role: 'dps', members: ['b2'] }] }] }] });
    const go = await call<CueResult>('order_fleet', { fleet: 'b', order: { type: 'direction', direction: [0, 0, 1] }, at: 3, cue: 'go' });
    const mwd = await call<CueResult>('switch_prop_mods', { fleet: 'b', active: true, at: 4 });
    const shot = await call<CueResult>('play_shot', { pose: { eye: [0, 2000, -8000], look: { ship: 'b1' } }, at: 2, cue: 'shot' });
    Expect(go.cue.id === 'go' && go.state === 'pending' && 'order_fleet' in go.cue && mwd.cue.id === 'cue-1' && shot.cue.id === 'shot', Show([go.cue, mwd.cue, shot.cue]));
    Expect(
      go.warnings.some((warning) => warning.startsWith('the timeline is stopped')),
      Show(go.warnings)
    );
    await Delay(2500);
    const now = await call<ViewerState>('get_state');
    const propMod = (ShipIn(now, 'b1').propMod as Maybe<{ readonly state?: string }>)?.state;
    Expect(ShipIn(now, 'b1').order?.type !== 'direction' && propMod !== 'active' && propMod !== 'activating' && (now.cinema as { readonly state?: string }).state === 'idle', `b1 ${Show(ShipIn(now, 'b1').order)} ${Show(ShipIn(now, 'b1').propMod)}; cinema ${Show(now.cinema)}`);
    Expect(TimelineOf(now)?.state === 'stopped' && TimelineOf(now)?.cues.pending === 3, Show(TimelineOf(now)));
    await TimelineTool({ action: 'play' });
    await Done(30);
    const report = await TimelineTool();
    const fired = FiredAt(report);
    Expect(fired['go'] === 3 && fired['cue-1'] === 4 && fired['shot'] === 2, Show(fired));
    const late = await call<CueResult>('order_ship', { id: 'b2', order: { type: 'stop' }, at: 1 });
    Expect(late.state === 'missed' && late.warnings.some((warning) => warning.includes('behind the timeline')), Show(late));
    return `cues ${[go, mwd, shot].map((result) => result.cue.id).join(', ')} pending while stopped; fired at ${Show(fired)}; a cue at 1 s added at ${report.time} s: ${late.state}`;
  });

  await Check('timeline: add_fleet_composition with at stores the resolved warp-in as a cue that lands at its time', async () => {
    await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])] });
    const composition = { id: 'wr', commander: { hull: 'Rifter' }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ hull: 'Rifter', count: 2 }] }] }] };
    const added = await call<CueResult>('add_fleet_composition', { composition, position: [0, 0, 20000], heading: 180, team: 'red', warpIn: true, at: 5, cue: 'land' }).catch(SkipWithoutSde);
    const operation = added.cue.patch_scene?.operations[0];
    Expect(operation?.composition?.commander?.dna === 'mf4_t1:minmatarbase:minmatar' && added.cue.adds?.ships?.length === 3 && Show(added.cue.adds?.fleets) === '["wr"]', Show(added.cue));
    Expect(!(await call<ViewerState>('get_state')).ships.some((ship) => ship.id.startsWith('wr-')), 'the fleet was added now');
    await TimelineTool({ action: 'play' });
    const arriving = await WaitFor('the cue lands the group', 30, (polled) => (((polled.arrivals ?? []) as unknown as { readonly group: string }[]).some((group) => group.group === 'wr') ? null : Show(TimelineOf(polled))));
    const report = await TimelineTool();
    Expect(FiredAt(report)['land'] === 5, Show(FiredAt(report)));
    return `cue adds ${Show(added.cue.adds)}; fired at +5 with the group arriving (${((arriving.arrivals ?? []) as unknown as { readonly state: string }[]).map((group) => group.state).join(', ')})`;
  });

  await Check('timeline: get_scene { at } holds the ships a cue adds from its time on, and add_ships with at stages off them', async () => {
    const rifter = { hull: 'Rifter', dna: 'mf4_t1:minmatarbase:minmatar', radius: 31 };
    await LoadTimeline(
      {
        ships: [Scripted('a', [0, 0, 0])],
        timeline: [{ id: 'reinforce', at: 5, patch_scene: { operations: [{ op: 'add_fleet_composition', composition: { id: 'rw', commander: rifter, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ ...rifter, count: 1 }] }] }] }, position: [0, 0, 9000], heading: 180, team: 'red' }] } }]
      },
      { timeline: 'pause' }
    );
    const before = await call<SceneDocument>('get_scene', { at: 4 });
    const after = await call<SceneDocument>('get_scene', { at: 5 });
    Expect(!before.ships.some((ship) => ship.id === 'rw-fc') && after.ships.some((ship) => ship.id === 'rw-fc') && after.timeline == null, `at 4: ${before.ships.map((ship) => ship.id).join(', ')}; at 5: ${after.ships.map((ship) => ship.id).join(', ')}`);
    const escort = { dna: rifter.dna, radius: rifter.radius, stats: TIMELINE_STATS, count: 2, near: { ship: 'rw-fc', range: 3000 } };
    const early = await call('add_ships', { ...escort, at: 4 }).then(() => null, ErrorMessage);
    Expect(early != null && early.includes('no ship "rw-fc"'), `at 4: ${early}`);
    const staged = await call<CueResult>('add_ships', { ...escort, at: 8, cue: 'escort' });
    Expect(staged.state === 'pending' && staged.cue.adds?.ships?.length === 2, Show(staged));
    await WaitTimeline('the timeline is ready', 60, (timeline) => (timeline?.state === 'ready' ? null : Show(timeline)));
    await TimelineTool({ action: 'play' });
    const landed = await WaitFor('the escort is added at 8 s', 30, (polled) => (polled.ships.length === 5 ? null : Show(TimelineOf(polled))));
    const report = await TimelineTool();
    Expect(FiredAt(report)['escort'] === 8, Show(FiredAt(report)));
    return `rw-fc at 5 s, not 4 s; add_ships near it at 4 s refused, at 8 s cued and fired at +8 (${landed.ships.map((ship) => ship.id).join(', ')})`;
  });

  // Time control (T1): pause, slow motion and fast-forward. The ships carry all four stats; --only time: runs them alone.
  // Rate and pause last across loads, so every check puts them back to 1× playing.
  const TimeOf = (state: ViewerState): Maybe<TimeReport> => (state as unknown as { readonly time?: Maybe<TimeReport> }).time ?? null;
  const TimeControl = (args: Record<string, unknown>) => call<TimeReport & { readonly warnings: string[] }>('time_control', args);
  const LoadTime = (scene: object) => call('load_scene', { scene: { name: 'verify-time', ...scene } });
  const Playing = () => TimeControl({ rate: 1, pause: false });
  const Flying = (ids: string[]) => WaitFor('the ships fly', 30, (polled) => (ids.every((id) => (ShipIn(polled, id).speed ?? 0) > 50) ? null : Show(ids.map((id) => ShipIn(polled, id).speed))));

  await Check('time: pause holds every ship and play resumes', async () => {
    try {
      await LoadTime({ ships: [Scripted('a', [0, 0, 0]), Scripted('b', [3000, 0, 0])] });
      for (const id of ['a', 'b']) await call('order_ship', { id, order: { type: 'direction', direction: [0, 0, 1] } });
      await Flying(['a', 'b']);
      const paused = await TimeControl({ pause: true });
      Expect(paused.paused && paused.state === 'paused' && paused.audio === 'suspended', Show(paused));
      const first = await call<ViewerState>('get_state');
      await Delay(2000);
      const second = await call<ViewerState>('get_state');
      Expect(first.simulation.tick === second.simulation.tick && TimeOf(second)?.paused === true, `ticks ${first.simulation.tick} -> ${second.simulation.tick}`);
      for (const id of ['a', 'b']) Expect(Show(ShipIn(first, id).position) === Show(ShipIn(second, id).position), `${id}: ${Show(ShipIn(first, id).position)} -> ${Show(ShipIn(second, id).position)}`);
      await TimeControl({ pause: false });
      const resumed = await WaitFor('the tick advances after play', 10, (polled) => (polled.simulation.tick > second.simulation.tick ? null : `tick ${polled.simulation.tick}`));
      return `held at tick ${second.simulation.tick} for 2 s; playing again at ${resumed.simulation.tick}`;
    } finally {
      await Playing();
    }
  });

  await Check('time: fast-forward 4× steps every tick, the orbit and the formation hold', async () => {
    try {
      await LoadTime({
        ships: [Scripted('hub', [0, 0, 0]), Scripted('orbiter', [2062, 0, 0]), Scripted('fc', [0, 0, 20_000]), Scripted('m1', [-1500, 0, 18_500]), Scripted('m2', [1500, 0, 18_500])],
        fleets: [{ id: 'f', commander: 'fc', wings: [{ id: 'f-w', squads: [{ id: 'f-s', role: 'dps', members: ['m1', 'm2'] }] }] }]
      });
      await call('order_ship', { id: 'orbiter', order: { type: 'orbit', target: 'hub', range: 2000 } });
      await call('order_ship', { id: 'fc', order: { type: 'direction', direction: [1, 0, 0], speed: 0.5 } });
      await Flying(['orbiter', 'fc']);
      const fast = await TimeControl({ rate: 4 });
      Expect(fast.rate === 4 && fast.audio === 'muted', Show(fast));
      const before = await call<ViewerState>('get_state');
      const bands: number[] = [];
      const states = new Set<string>();
      for (let poll = 0; poll < 10; poll++) {
        await Delay(500);
        const polled = await call<ViewerState>('get_state');
        bands.push(ShipIn(polled, 'orbiter').targetDistance ?? Number.NaN);
        for (const id of ['m1', 'm2']) states.add(ShipIn(polled, id).following?.state ?? 'none');
      }
      const after = await call<ViewerState>('get_state');
      const advanced = after.simulation.tick - before.simulation.tick;
      Expect(advanced >= 17 && advanced <= 24, `the tick advanced ${advanced} in 5 s at 4×; ${Show(TimeOf(after))}`);
      Expect(
        bands.every((band) => band >= 1200 && band <= 2800),
        `orbit band ${Show(bands.map(Math.round))}`
      );
      Expect(
        [...states].every((state) => state === 'in-formation' || state === 'catching-up'),
        `members ${[...states].join(', ')}`
      );
      Expect(TimeOf(after)?.rate === 4, Show(TimeOf(after)));
      const effective = TimeOf(after)?.effectiveRate ? '; effective ' + String(TimeOf(after)?.effectiveRate) + '×' : '';
      return `+${advanced} ticks in ~5 s; orbit ${Math.round(Math.min(...bands))}-${Math.round(Math.max(...bands))} m; members ${[...states].join(', ')}${effective}`;
    } finally {
      await Playing();
    }
  });

  await Check('time: slow motion 0.25× runs one tick in 4 s', async () => {
    try {
      await LoadTime({ ships: [Scripted('a', [0, 0, 0])] });
      await call('order_ship', { id: 'a', order: { type: 'direction', direction: [0, 0, 1] } });
      await Flying(['a']);
      const slow = await TimeControl({ rate: 0.25 });
      Expect(slow.rate === 0.25 && slow.audio === undefined, Show(slow));
      const before = await call<ViewerState>('get_state');
      await Delay(4000);
      const after = await call<ViewerState>('get_state');
      const advanced = after.simulation.tick - before.simulation.tick;
      Expect(advanced >= 0 && advanced <= 2, `the tick advanced ${advanced} in 4 s at 0.25×`);
      const seconds = (TimeOf(after)?.seconds ?? 0) - (TimeOf(before)?.seconds ?? 0);
      Expect(seconds >= 0.7 && seconds <= 1.3, `scene seconds +${seconds} in 4 s`);
      return `+${advanced} tick(s), +${seconds.toFixed(2)} scene s in 4 s`;
    } finally {
      await Playing();
    }
  });

  await Check('time: rate and pause survive a load; get_state time is complete', async () => {
    try {
      await TimeControl({ rate: 0.5, pause: true });
      await LoadTime({ ships: [Scripted('a', [0, 0, 0])] });
      const state = await call<ViewerState>('get_state');
      const time = TimeOf(state);
      Expect(time?.rate === 0.5 && time.paused && time.state === 'paused' && time.tick === state.simulation.tick && time.seconds === state.simulation.seconds, Show(time));
      const refused = await TimeControl({ back: 10 }).then(() => null, ErrorMessage);
      Expect(refused != null && refused.includes('nothing is recorded yet'), `back while paused at the load: ${refused}`);
      const bad = await TimeControl({ rate: 64 }).then(() => null, ErrorMessage);
      Expect(bad != null && bad.includes('time_control.rate'), `rate 64: ${bad}`);
      return `after the load: ${Show(time)}`;
    } finally {
      await Playing();
    }
  });

  // Time control (T2b): jumps back and forward, the tape and what cuts the window. A moment is read paused: the tick,
  // every ship's master position, HP layers and death, the kills, the shot and missile counters.
  const Moment = (state: ViewerState) => ({
    tick: state.simulation.tick,
    ships: Object.fromEntries(state.ships.map((ship) => [ship.id, { position: ship.position ?? null, hp: (['shield', 'armor', 'structure'] as const).map((layer) => ship.defense?.[layer].hp ?? null), destroyed: ship.destroyed?.tick ?? null, warp: ship.warp?.phase ?? null, order: ship.order?.type ?? null }])),
    kills: (state.combat?.kills ?? []).map((kill) => `${kill.ship}<-${kill.by}/${kill.module}@${kill.tick}`),
    shots: state.combat?.shots ?? 0,
    hits: state.combat?.hits ?? 0,
    missiles: state.missiles ? { launched: state.missiles.launched, inFlight: state.missiles.inFlight, hits: state.missiles.hits, flights: state.missiles.flights.map((flight) => `${flight.id}:${flight.state}`) } : null
  });
  const MomentDiff = (a: ReturnType<typeof Moment>, b: ReturnType<typeof Moment>): Maybe<string> => {
    for (const key of ['tick', 'kills', 'shots', 'hits', 'missiles'] as const) if (Show(a[key]) !== Show(b[key])) return `${key}: ${Show(a[key])} then ${Show(b[key])}`;
    for (const id of new Set([...Object.keys(a.ships), ...Object.keys(b.ships)])) if (Show(a.ships[id]) !== Show(b.ships[id])) return `${id}: ${Show(a.ships[id])} then ${Show(b.ships[id])}`;
    return null;
  };
  const Recorded = () => WaitFor('time control records', 90, (polled) => (TimeOf(polled)?.recording.on ? null : Show(TimeOf(polled)?.recording)));
  const PausedState = async () => {
    await TimeControl({ pause: true });
    return call<ViewerState>('get_state');
  };
  const SeekPaused = async (seconds: number) => {
    const result = await TimeControl({ seek: seconds, pause: true });
    return { result, state: await call<ViewerState>('get_state') };
  };
  const fight: { first?: ReturnType<typeof Moment>; seconds?: number; kill?: { readonly ship: string; readonly by: string; readonly module: string; readonly tick: number }; killSeconds?: number } = {};

  await Check('time: a jump back replays the same fight, kills included, without drift', async () => {
    try {
      const red = (id: string, position: SceneVector) => ({ ...Rifter(id, position), team: 'red' });
      const blue = (id: string, position: SceneVector) => ({ ...Punisher(id, position), team: 'blue' });
      await LoadCombatScene([blue('p1', [0, 0, 0]), blue('p2', [800, 0, 0]), blue('p3', [-800, 0, 0]), red('r1', [0, 0, 6000]), red('r2', [900, 0, 6500]), red('r3', [-900, 0, 6500])], { seed: 7, death: 'explode' });
      await Recorded();
      await call('engage', { ships: ['p1', 'p2', 'p3'], target: 'r1' });
      await call('engage', { ships: ['r1', 'r2', 'r3'], target: 'p1' });
      const killed = await WaitFor('the first kill', 120, (polled) => (polled.combat?.kills.length ? null : `shots ${polled.combat?.shots ?? 0}`));
      const kill = killed.combat?.kills[0];
      if (!kill) throw new Error('no kill');
      await WaitFor('5 s past the first kill', 30, (polled) => (polled.simulation.tick >= kill.tick + 5 ? null : `tick ${polled.simulation.tick}`));
      const first = Moment(await PausedState());
      const seconds = TimeOf(await call<ViewerState>('get_state'))?.seconds ?? 0;
      Object.assign(fight, { first, seconds, kill, killSeconds: seconds - (first.tick - kill.tick) });
      const back = await TimeControl({ back: 15 });
      Expect(back.jump && back.tick < first.tick && back.paused, Show({ tick: back.tick, jump: back.jump }));
      const { result, state } = await SeekPaused(seconds);
      const difference = MomentDiff(first, Moment(state));
      Expect(!difference, `after back 15 and seek: ${difference}`);
      Expect((result.jump?.resimulated ?? 99) <= 8, Show(result.jump));
      await TimeControl({ pause: false });
      await WaitFor('3 s past the first run', 20, (polled) => (polled.simulation.tick >= first.tick + 3 ? null : `tick ${polled.simulation.tick}`));
      const again = await SeekPaused(seconds);
      const replayed = MomentDiff(first, Moment(again.state));
      Expect(!replayed, `after playing on and seeking back: ${replayed}`);
      Expect(!TimeOf(again.state)?.drift, Show(TimeOf(again.state)?.drift));
      return `kill ${kill.ship} by ${kill.by} at tick ${kill.tick}; back 15 s in ${back.jump?.ms} ms (${back.jump?.resimulated} ticks from ${back.jump?.snapshot}); seek ${result.jump?.ms} ms; equal at tick ${first.tick} twice, no drift; window ${Show(TimeOf(again.state)?.window)}`;
    } finally {
      await Playing();
    }
  });

  await Check('time: a ship destroyed after the target comes back, then dies again at the same tick by the same module', async () => {
    try {
      const { kill, killSeconds, first } = fight;
      if (!kill || killSeconds == null || !first) throw new Error('the fight check did not run');
      const { state } = await SeekPaused(killSeconds - 2);
      const victim = ShipIn(state, kill.ship);
      Expect(!victim.destroyed && ['ready', 'validated'].includes(victim.status ?? '') && (victim.defense?.structure.hp ?? 0) > 0, Show({ status: victim.status, destroyed: victim.destroyed, defense: victim.defense?.structure }));
      await TimeControl({ pause: false });
      const dead = await WaitFor('the kill again', 20, (polled) => (ShipIn(polled, kill.ship).destroyed ? null : `tick ${polled.simulation.tick}`));
      const again = ShipIn(dead, kill.ship).destroyed;
      Expect(again?.tick === kill.tick && again.by === kill.by && again.module === kill.module, `${Show(again)} vs ${Show(kill)}`);
      return `${kill.ship} alive at ${killSeconds - 2} s (${victim.status}, structure ${victim.defense?.structure.hp}); died again at tick ${again?.tick} by ${again?.by} ${again?.module}`;
    } finally {
      await Playing();
    }
  });

  await Check('time: the tape replays live commands at their ticks, and a new command drops the recorded future', async () => {
    try {
      await LoadTime({ ships: [Scripted('a', [0, 0, 0]), Scripted('b', [3000, 0, 0])] });
      await Recorded();
      await Delay(1500);
      const t1 = TimeOf(await call<ViewerState>('get_state'))?.seconds ?? 0;
      await call('order_ship', { id: 'a', order: { type: 'goto', point: [0, 0, 30000] } });
      await Delay(2500);
      await call('order_ship', { id: 'b', order: { type: 'direction', direction: [1, 0, 0] } });
      await Delay(2500);
      await PausedState();
      const { state } = await SeekPaused(t1 - 1);
      const tape = TimeOf(state)?.replay;
      Expect(tape?.pending === 2 && tape.next?.tool === 'order_ship' && ShipIn(state, 'a').order?.type !== 'goto', Show({ tape, a: ShipIn(state, 'a').order }));
      await TimeControl({ seek: TimeOf(state)?.latest ?? 0, pause: true });
      const replayed = await call<ViewerState>('get_state');
      Expect(!TimeOf(replayed)?.replay && ShipIn(replayed, 'a').order?.type === 'goto' && ShipIn(replayed, 'b').order?.type === 'direction', Show({ replay: TimeOf(replayed)?.replay, a: ShipIn(replayed, 'a').order, b: ShipIn(replayed, 'b').order }));
      const back = await SeekPaused(t1 - 1);
      await call('order_ship', { id: 'b', order: { type: 'stop' } });
      const dropped = TimeOf(await call<ViewerState>('get_state'));
      Expect(!dropped?.replay && dropped?.latest === dropped?.seconds, Show({ replay: dropped?.replay, latest: dropped?.latest, seconds: dropped?.seconds }));
      await TimeControl({ pause: false });
      await Delay(4000);
      const after = await call<ViewerState>('get_state');
      Expect(ShipIn(after, 'a').order?.type !== 'goto' && ShipIn(after, 'b').order?.type !== 'direction', Show({ a: ShipIn(after, 'a').order, b: ShipIn(after, 'b').order }));
      return `2 commands pending after a seek to ${(t1 - 1).toFixed(1)} s, both replayed by the recorded end; a new order at ${TimeOf(back.state)?.seconds} s dropped them`;
    } finally {
      await Playing();
    }
  });

  await Check('time: a simulation edit cuts the window, a camera-only edit does not; recording waits for the scene to settle', async () => {
    try {
      await LoadTime({ ships: [Scripted('a', [0, 0, 0])] });
      const loaded = TimeOf(await call<ViewerState>('get_state'));
      Expect(loaded?.recording.why === 'a scene was loaded', Show(loaded?.recording));
      const on = TimeOf(await Recorded());
      Expect(on?.recording.since != null && on.recording.since >= (loaded?.recording.cutAt ?? 0), Show(on?.recording));
      await Delay(3000);
      await call('patch_scene', { operations: [{ op: 'set_camera', camera: { distance: 4000 } }] });
      const camera = TimeOf(await call<ViewerState>('get_state'));
      Expect(camera?.recording.on && camera.back >= 2, Show({ back: camera?.back, recording: camera?.recording }));
      await call('patch_scene', { operations: [{ op: 'add_ship', ship: Scripted('b', [2000, 0, 0]) }] });
      const cut = TimeOf(await call<ViewerState>('get_state'));
      Expect(cut?.back === 0 && cut.recording.why?.includes('an edit changed the simulation'), Show({ back: cut?.back, recording: cut?.recording }));
      const again = TimeOf(await Recorded());
      return `after the load: ${Show(loaded?.recording)}; on since ${on?.recording.since} s; camera edit kept back ${camera?.back} s; add_ship cut (${cut?.recording.why}); on again since ${again?.recording.since} s`;
    } finally {
      await Playing();
    }
  });

  await Check('time: seek forward lands equal inside the recorded range, and simulates on past it', async () => {
    try {
      await LoadTime({ ships: [Scripted('hub', [0, 0, 0]), Scripted('orbiter', [2062, 0, 0]), Scripted('runner', [0, 0, 5000])] });
      await Recorded();
      await call('order_ship', { id: 'orbiter', order: { type: 'orbit', target: 'hub', range: 2000 } });
      await call('order_ship', { id: 'runner', order: { type: 'direction', direction: [0, 0.2, 1] } });
      await Delay(9000);
      const end = await PausedState();
      const first = Moment(end);
      const latest = TimeOf(end)?.seconds ?? 0;
      await TimeControl({ back: 7 });
      const { state } = await SeekPaused(latest);
      const difference = MomentDiff(first, Moment(state));
      Expect(!difference, `seek to the recorded end: ${difference}`);
      const ahead = await SeekPaused(latest + 20);
      const tick = ahead.state.simulation.tick;
      Expect(tick === first.tick + 20 && TimeOf(ahead.state)?.recording.on && (TimeOf(ahead.state)?.latest ?? 0) >= latest + 20, Show({ tick, first: first.tick, time: TimeOf(ahead.state) }));
      return `equal at the recorded end (tick ${first.tick}); +20 s past it in ${ahead.result.jump?.ms} ms (${ahead.result.jump?.resimulated} ticks), recording on`;
    } finally {
      await Playing();
    }
  });

  await Check('time: missiles in flight and a ship in warp come back the same across a jump', async () => {
    try {
      const teamed = (ship: { readonly id: string }, team: string) => ({ ...ship, team });
      const ships = [teamed(Caracal('caracal', [0, 0, 0]), 'red'), teamed(Rifter('rifter', [0, 0, 20000]), 'blue'), teamed(Rifter('warper', [5000, 0, 0]), 'blue')];
      await LoadCombatScene(ships, { seed: 7, death: 'flag' });
      await Recorded();
      await call('engage', { ships: ['caracal'], target: 'rifter' });
      await WaitFor('the first missiles in flight', 90, (polled) => ((polled.missiles?.inFlight ?? 0) > 0 ? null : Show(polled.missiles ?? null)));
      await call('order_ship', { id: 'warper', order: { type: 'warp', point: [5000, 0, 1_000_000_000] } });
      const warping = new Set(['aligning', 'warping', 'exiting']);
      await WaitFor('missiles in flight and the warper in warp', 60, (polled) => ((polled.missiles?.inFlight ?? 0) > 0 && warping.has(ShipIn(polled, 'warper').warp?.phase ?? '') ? null : Show({ missiles: polled.missiles?.inFlight, warp: ShipIn(polled, 'warper').warp?.phase })));
      const a = await PausedState();
      const atA = Moment(a);
      const secondsA = TimeOf(a)?.seconds ?? 0;
      await TimeControl({ pause: false });
      await Delay(8000);
      const b = await PausedState();
      const atB = Moment(b);
      const secondsB = TimeOf(b)?.seconds ?? 0;
      await TimeControl({ back: 12 });
      const backA = await SeekPaused(secondsA);
      const differenceA = MomentDiff(atA, Moment(backA.state));
      Expect(!differenceA, `at the volley: ${differenceA}`);
      const backB = await SeekPaused(secondsB);
      const differenceB = MomentDiff(atB, Moment(backB.state));
      Expect(!differenceB, `8 s later: ${differenceB}`);
      return `${atA.missiles?.inFlight} missiles in flight and the warper ${atA.ships['warper']?.warp} at tick ${atA.tick}; equal there and at tick ${atB.tick} (missile hits ${atB.missiles?.hits}, warper ${atB.ships['warper']?.warp}) after jumping back`;
    } finally {
      await Playing();
    }
  });

  const Teamed = (ship: { readonly id: string }, team: string) => ({ ...ship, team });

  await Check("time: fast-forward 4× fires a default Rifter's guns on every cycle", async () => {
    try {
      await LoadCombatScene([Teamed(Rifter('rifter', [0, 0, 0]), 'red'), Teamed(Punisher('punisher', [0, 0, 20_000]), 'blue')], { seed: 7, death: 'flag' });
      await call('engage', { ships: ['rifter'], target: 'punisher' });
      const firing = await WaitFor('the guns fire', 60, (polled) => ((ShipIn(polled, 'rifter').shots ?? 0) > 0 ? null : Show(ShipIn(polled, 'rifter').locks)));
      const guns = ShipGuns(firing, 'rifter').filter((gun) => gun.cycleTime != null);
      const cycleTime = guns[0]?.cycleTime ?? 0;
      Expect(guns.length > 0 && cycleTime > 0, Show(ShipGuns(firing, 'rifter')));
      await TimeControl({ rate: 4 });
      const before = await call<ViewerState>('get_state');
      await Delay(5000);
      const after = await call<ViewerState>('get_state');
      const seconds = (TimeOf(after)?.seconds ?? 0) - (TimeOf(before)?.seconds ?? 0);
      const fired = (ShipIn(after, 'rifter').shots ?? 0) - (ShipIn(before, 'rifter').shots ?? 0);
      const expected = (guns.length * seconds) / cycleTime;
      Expect(seconds >= 14 && Math.abs(fired - expected) <= guns.length * 1.5, `${fired} shots in ${seconds} scene s at 4×, expected ${expected.toFixed(1)} (${guns.length} guns, ${cycleTime} s cycle)`);
      return `${guns.length} guns on a ${cycleTime} s cycle fired ${fired} shots in ${seconds.toFixed(1)} scene s at 4× (expected ${expected.toFixed(1)})`;
    } finally {
      await Playing();
    }
  });

  await Check('time: get_state time.timeline counts timeline seconds, and seek { timeline } lands on them', async () => {
    try {
      await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])], timeline: [{ id: 'go', at: 2, ...Direction('a', [0, 0, 1]) }] });
      await Recorded();
      const played = await Played('6 s of timeline time', 30, 6);
      const time = TimeOf(played);
      Expect(time?.timeline != null && Math.abs(time.timeline - (TimelineOf(played)?.time ?? -9)) < 1.05, Show({ time: time?.timeline, played: TimelineOf(played)?.time }));
      const at3 = await TimeControl({ seek: { timeline: 3 }, pause: true });
      const three = await call<ViewerState>('get_state');
      Expect(at3.timeline === 3 && TimelineOf(three)?.time === 3 && ShipIn(three, 'a').order?.type === 'direction', Show({ timeline: at3.timeline, played: TimelineOf(three)?.time, order: ShipIn(three, 'a').order }));
      const at1 = await TimeControl({ seek: { timeline: 1 }, pause: true });
      const one = await call<ViewerState>('get_state');
      Expect(at1.timeline === 1 && TimelineOf(one)?.time === 1 && ShipIn(one, 'a').order?.type !== 'direction', Show({ timeline: at1.timeline, played: TimelineOf(one)?.time, order: ShipIn(one, 'a').order }));
      const refused = await TimeControl({ seek: { timeline: -1 } }).then(() => null, ErrorMessage);
      Expect(refused?.includes('{ timeline:') === true, `seek { timeline: -1 }: ${refused}`);
      return `time.timeline ${time?.timeline} at ${TimelineOf(played)?.time} s played; seek { timeline: 3 } in ${at3.jump?.ms} ms (cue fired), { timeline: 1 } before it`;
    } finally {
      await Playing();
    }
  });

  // A cue's warp-in, as the group report gives it: landing ticks from t = 0, and the timeline time it was seen warping.
  const CueLandings = async (ids: readonly string[], what: string) => {
    const landings: Record<string, number> = {};
    let warping: Maybe<number> = null;
    const end = await WaitFor(what, 90, (polled) => {
      const startedAt = TimelineOf(polled)?.startedAt;
      for (const group of (polled.arrivals ?? []) as unknown as { readonly ships: { readonly id: string; readonly landsIn?: number }[] }[]) {
        for (const ship of group.ships) if (startedAt != null && ship.landsIn != null && landings[ship.id] == null) landings[ship.id] = polled.simulation.tick + ship.landsIn - startedAt;
      }
      if (warping == null && ids.some((id) => polled.ships.find((ship) => ship.id === id)?.arrival?.state === 'warping')) warping = TimeOf(polled)?.timeline ?? null;
      // A landed ship keeps its arrival report until it follows or takes an order (the FC never does here).
      const arriving = ids.some((id) => {
        const state = polled.ships.find((ship) => ship.id === id)?.arrival?.state;
        return state != null && state !== 'landed';
      });
      return ids.every((id) => landings[id] != null) && !arriving && ids.every((id) => polled.ships.some((ship) => ship.id === id)) ? null : Show({ landings, timeline: TimelineOf(polled)?.time });
    });
    return { landings, warping: warping as Maybe<number>, end };
  };

  await Check('time: a jump back across a timeline warp-in cue lands the group again on the same ticks, without a cut', async () => {
    try {
      await LoadTimeline({ ships: [Scripted('a', [0, 0, 0])] });
      const composition = { id: 'wr', commander: { hull: 'Rifter' }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ hull: 'Rifter', count: 2 }] }] }] };
      const added = await call<CueResult>('add_fleet_composition', { composition, position: [0, 0, 20000], heading: 180, team: 'red', warpIn: true, at: 5, cue: 'land' }).catch(SkipWithoutSde);
      const ids = (added.cue.adds?.ships ?? []) as readonly string[];
      Expect(ids.length === 3, Show(added.cue.adds));
      await TimelineTool({ action: 'restart' });
      const since = TimeOf(await Recorded())?.recording.since;
      const first = await CueLandings(ids, 'the cue lands the group');
      const kept = TimeOf(first.end);
      Expect(kept?.recording.on && kept.recording.since === since && first.warping != null, Show({ recording: kept?.recording, since, warping: first.warping }));
      await TimeControl({ seek: { timeline: 3 }, pause: true });
      const before = await call<ViewerState>('get_state');
      const pending = (await TimelineTool()).list.find((cue) => cue.id === 'land');
      Expect(!before.ships.some((ship) => ids.includes(ship.id)) && pending?.state === 'pending', Show({ ships: before.ships.map((ship) => ship.id), cue: pending }));
      await TimeControl({ pause: false });
      const second = await CueLandings(ids, 'the cue lands the group again');
      Expect(Show(first.landings) === Show(second.landings), `landings ${Show(first.landings)} then ${Show(second.landings)}`);
      await TimeControl({ seek: { timeline: first.warping ?? 0 }, pause: true });
      const mid = await call<ViewerState>('get_state');
      Expect(
        ids.some((id) => ShipIn(mid, id).arrival?.state === 'warping'),
        Show(ids.map((id) => ShipIn(mid, id).arrival ?? null))
      );
      await TimeControl({ pause: false });
      const third = await CueLandings(ids, 'the group lands after a jump into its warp');
      Expect(Show(first.landings) === Show(third.landings), `landings ${Show(first.landings)} then ${Show(third.landings)} after a jump into the warp`);
      const after = TimeOf(third.end);
      Expect(!after?.drift && after?.recording.since === since, Show({ drift: after?.drift, recording: after?.recording }));
      return `landed at ${Show(first.landings)} (t = 0 ticks) three times: live, after seek { timeline: 3 } before the cue, and after a jump to ${first.warping} s mid-warp; recording since ${since} s, no cut, no drift`;
    } finally {
      await Playing();
    }
  });

  await Check('time: effects across a jump: an explosion still showing replays from the target, a missile in flight hits once', async () => {
    try {
      const blue = (id: string, position: SceneVector) => Teamed(Punisher(id, position), 'blue');
      await LoadCombatScene([blue('p1', [0, 0, 0]), blue('p2', [800, 0, 0]), blue('p3', [-800, 0, 0]), Teamed(Rifter('r1', [0, 0, 4000]), 'red')], { seed: 7, death: 'explode' });
      await Recorded();
      await call('engage', { ships: ['p1', 'p2', 'p3'], target: 'r1' });
      await call('engage', { ships: ['r1'], target: 'p1' });
      const killed = await WaitFor('the kill', 120, (polled) => (ShipIn(polled, 'r1').destroyed ? null : `shots ${polled.combat?.shots ?? 0}`));
      const kill = ShipIn(killed, 'r1').destroyed;
      if (!kill) throw new Error('no kill');
      const Explosion = (state: ViewerState) => ShipIn(state, 'r1').destroyed?.explosion?.state ?? 'none';
      await WaitFor('the hull hidden', 30, (polled) => (Explosion(polled) === 'done' ? null : Explosion(polled)));
      const now = await PausedState();
      const killSeconds = (TimeOf(now)?.seconds ?? 0) - (now.simulation.tick - kill.tick);
      // Where the re-simulation hides the hull: the first landing past its wreck switch.
      let shown = 0;
      let hidden: Maybe<number> = null;
      for (let x = 0.5; x <= 6 && hidden == null; x += 0.25) {
        await TimeControl({ seek: killSeconds - 3 });
        await TimeControl({ seek: killSeconds + x, pause: true });
        if (Explosion(await call<ViewerState>('get_state')) === 'done') hidden = killSeconds + x;
        else shown = killSeconds + x;
      }
      Expect(hidden != null && shown - killSeconds >= 1, Show({ killSeconds, shown, hidden }));
      await TimeControl({ seek: killSeconds - 3 });
      await TimeControl({ seek: shown, pause: true });
      const Posts = (state: ViewerState) => (state.audio?.posted ?? []).filter((entry) => entry.ship === 'r1' && /ecx_|explo/iu.test(entry.event));
      const replayed = await WaitFor('the explosion replays and posts its sound again', 10, (polled) => {
        const posts = Posts(polled);
        const muted = posts.findIndex((entry) => entry.muted);
        return Explosion(polled) === 'playing' && muted >= 0 && posts.slice(muted + 1).some((entry) => !entry.muted) ? null : Show({ explosion: Explosion(polled), posts });
      });
      await TimeControl({ pause: false });
      const done = await WaitFor('the replayed explosion hides the hull', 15, (polled) => (Explosion(polled) === 'done' ? null : Explosion(polled)));
      const hideSeconds = TimeOf(done)?.seconds ?? 0;
      Expect(hideSeconds > (hidden ?? 0) && hideSeconds <= shown + 5, Show({ shown, hidden, hideSeconds }));
      const explosion = `kill at ${killSeconds.toFixed(2)} s; the re-simulation hides the hull from ${hidden?.toFixed(2)} s; landing at ${shown.toFixed(2)} s replayed it (sound ${Posts(replayed).at(-1)?.event}) and the hull hid at ${hideSeconds.toFixed(2)} s`;

      await LoadCombatScene([Teamed(Caracal('caracal', [0, 0, 0]), 'red'), Teamed(Rifter('rifter', [0, 0, 20000]), 'blue')], { seed: 7, death: 'flag' });
      await Recorded();
      await call('engage', { ships: ['caracal'], target: 'rifter' });
      const volley = await WaitFor('missiles in flight', 90, (polled) => ((polled.missiles?.inFlight ?? 0) > 0 ? null : Show(polled.missiles ?? null)));
      const volleySeconds = TimeOf(volley)?.seconds ?? 0;
      await call('cease_fire', { ships: ['caracal'] });
      const settled = await WaitFor('every missile ended', 40, (polled) => ((polled.missiles?.inFlight ?? 1) === 0 ? null : Show(polled.missiles?.inFlight)), 6);
      const totals = { launched: settled.missiles?.launched, hits: settled.missiles?.hits };
      await TimeControl({ seek: volleySeconds, pause: true });
      const back = await call<ViewerState>('get_state');
      Expect((back.missiles?.inFlight ?? 0) > 0, Show(back.missiles));
      await TimeControl({ pause: false });
      const again = await WaitFor('every missile ended again', 40, (polled) => ((polled.missiles?.inFlight ?? 1) === 0 ? null : Show(polled.missiles?.inFlight)), 6);
      Expect(Show({ launched: again.missiles?.launched, hits: again.missiles?.hits }) === Show(totals) && !TimeOf(again)?.drift, `${Show(totals)} then ${Show({ launched: again.missiles?.launched, hits: again.missiles?.hits })}; drift ${Show(TimeOf(again)?.drift)}`);
      const drawn = rendering ? `; drawn: ${Show((again as unknown as { readonly renderer?: { readonly missiles?: unknown } }).renderer?.missiles ?? null)}` : '; drawn missiles and module beams are renderer-only: not checked headless';
      return `${explosion}. ${back.missiles?.inFlight} missiles in flight at ${volleySeconds.toFixed(2)} s hit after resuming: ${Show(totals)} both runs${drawn}`;
    } finally {
      await Playing();
    }
  });

  if (rendering) {
    await Check('screenshot returns a PNG', async () => {
      const shot = await call<{ image: { data: string }; width: number; height: number }>('screenshot', { maxWidth: 960 });
      await mkdir(path.dirname(SCREENSHOT_FILE), { recursive: true });
      await writeFile(SCREENSHOT_FILE, Buffer.from(shot.image.data, 'base64'));
      return `${shot.width}x${shot.height} -> ${SCREENSHOT_FILE}`;
    });
  }

  // The camera director (auto_camera): each check loads its own scene; --only director: runs them alone. The whole cut
  // log is read off the page (auto_camera's result holds it, but any call picks again).
  const DirectorOf = (state: ViewerState): Maybe<DirectorStateReport> => cinemaOf(state).director ?? null;
  // The log's ticks count from the load (the director's seed tick): back to world ticks here.
  const DirectorLog = (): Promise<DirectorCutReport[]> =>
    page.evaluate(() => {
      const { director } = (globalThis as unknown as { readonly sceneDirector: { readonly director: { readonly loadTick: number; readonly cameraDirector: { Log(): DirectorCutReport[] } } } }).sceneDirector;
      return director.cameraDirector.Log().map((cut) => ({ ...cut, tick: cut.tick + director.loadTick }));
    });
  const DirectorShips = (fleet: string, team: Maybe<string>, z: number, count: number, extra: object = {}) => Array.from({ length: count }, (_, i) => Scripted(`${fleet}-${i}`, [(i - (count - 1) / 2) * 600, 0, z], { ...(team ? { team } : {}), ...extra }));
  const DirectorFleet = (id: string, count: number) => ({ id, commander: `${id}-0`, wings: [{ id: `${id}-w`, squads: [{ id: `${id}-s`, role: 'dps', members: Array.from({ length: count - 1 }, (_, i) => `${id}-${i + 1}`) }] }] });
  const SideValue = (side: string): number => (side === 'starboard' ? 1 : side === 'port' ? -1 : 0);
  // The 180-degree rule over a log: a cut to the far side needs a crossing (the fly-through, or after a neutral shot) or
  // a free side (no axis, or the axis turned past 60 degrees). A crossing framing flips the kept side.
  const AxisBreaks = (log: readonly DirectorCutReport[]): string[] => {
    const breaks: string[] = [];
    let kept = 0;
    for (const cut of log) {
      const view = SideValue(cut.side);
      if (cut.free) kept = 0;
      if (kept && view === -kept && !cut.crossing) breaks.push(`${cut.tick} ${cut.framing} ${cut.side} (kept ${kept})`);
      if (cut.framing === 'battle-fly-through') kept = view === 1 ? -1 : 1;
      else if (view) kept = view;
    }
    return breaks;
  };
  const CutText = (log: readonly DirectorCutReport[]): string => log.map((cut) => `${cut.tick} ${cut.framing}/${cut.subject}/${cut.scale}/${cut.side}`).join(', ');
  const DirectorScene = (name: string, fly = true) => ({
    name,
    ships: [...DirectorShips('blue', 'blue', 0, 5, fly ? { orders: [{ type: 'direction', direction: [0.2, 0, 1] }] } : {}), ...DirectorShips('red', 'red', 25000, 5, fly ? { orders: [{ type: 'direction', direction: [-0.2, 0, -1] }] } : {})],
    fleets: [DirectorFleet('blue', 5), DirectorFleet('red', 5)]
  });
  const directorLogs: DirectorCutReport[][] = [];

  await Check('director: auto_camera fast drives two fleets, cuts 3-7 s apart with no repeat and mixed scales', async () => {
    await call('load_scene', { scene: DirectorScene('verify-director') });
    await Delay(1500);
    const before = (await call<ViewerState>('get_state')).simulation.tick;
    await call('auto_camera', { pace: 'fast' });
    const driving = await WaitFor('the director drives', 5, (polled) => (cinemaOf(polled).driver === 'director' && DirectorOf(polled)?.state === 'driving' ? null : Show(DirectorOf(polled))));
    Expect(driving.simulation.tick <= before + 2, `driving at tick ${driving.simulation.tick}, asked at ${before}`);
    const pick = DirectorOf(driving)?.pick;
    Expect(pick != null && pick.why.length > 0 && typeof pick.score === 'number', Show(pick));
    await Delay(30000);
    const cuts = await DirectorLog();
    directorLogs.push(cuts);
    const gaps = cuts.slice(1).map((cut, index) => cut.tick - cuts[index].tick);
    Expect(cuts.length >= 4, `${cuts.length} cuts in 30 s: ${CutText(cuts)}`);
    Expect(
      gaps.every((gap) => gap >= 2 && gap <= 7),
      `gaps ${gaps.join(', ')}: ${CutText(cuts)}`
    );
    const repeats = cuts.slice(1).filter((cut, index) => cut.framing === cuts[index].framing && cut.subject === cuts[index].subject);
    Expect(!repeats.length, `repeats ${CutText(repeats)}`);
    const scales = new Set(cuts.slice(0, 6).map((cut) => cut.scale));
    Expect(scales.size >= 2, `scales ${[...scales].join(', ')} in ${CutText(cuts.slice(0, 6))}`);
    const state = DirectorOf(await call<ViewerState>('get_state'));
    return `${cuts.length} cuts, gaps ${gaps.join('/')} s, scales ${[...scales].join('/')}; cost ${state?.cost.lastMs} ms (max ${state?.cost.maxMs}); first: ${pick?.framing} on ${pick?.shot.subject} (${pick?.why})`;
  });

  await Check("director: Claude's shot takes the camera and hands it back at its end; stop_shot yields to the user", async () => {
    await call('load_scene', { scene: DirectorScene('verify-director-handoff') });
    await call('auto_camera', { pace: 'fast' });
    await WaitFor('the director drives', 5, (polled) => (DirectorOf(polled)?.state === 'driving' ? null : Show(DirectorOf(polled))));
    await playShot({ hardpoint: { name: 'chase', ship: 'blue-0' }, duration: 2, end: 'release' });
    const yielded = DirectorOf(await call<ViewerState>('get_state'));
    Expect(yielded?.state === 'yielded' && yielded.yieldedTo === 'claude', Show(yielded));
    const drivers: string[] = [];
    const back = await WaitFor(
      'the director takes back',
      8,
      (polled) => {
        const driver = cinemaOf(polled).driver;
        if (drivers[drivers.length - 1] !== driver) drivers.push(driver);
        return driver === 'director' ? null : `${driver} ${Show(DirectorOf(polled)?.state)}`;
      },
      1
    );
    Expect(!drivers.includes('user'), `drivers ${drivers.join(' -> ')}`);
    await call('stop_shot', {});
    const stopped = await call<ViewerState>('get_state');
    Expect(DirectorOf(stopped)?.state === 'yielded' && DirectorOf(stopped)?.yieldedTo === 'user' && cinemaOf(stopped).driver === 'user', Show({ driver: cinemaOf(stopped).driver, director: DirectorOf(stopped) }));
    const resumed = await call<{ readonly director: DirectorStateReport }>('auto_camera', {});
    Expect(resumed.director.state === 'driving', Show(resumed.director));
    return `drivers ${drivers.join(' -> ')} (back at tick ${back.simulation.tick}); stop_shot: yielded to user; auto_camera {}: ${resumed.director.state}`;
  });

  await Check('director: (SDE) a doomed ship is framed into its kill, held through the blast, cut away before removal', async () => {
    const red = (id: string, position: SceneVector) => ({ ...Rifter(id, position), team: 'red' });
    const blue = (id: string, position: SceneVector) => ({ ...Punisher(id, position), team: 'blue' });
    await LoadCombatScene([blue('p1', [0, 0, 0]), blue('p2', [800, 0, 0]), blue('p3', [-800, 0, 0]), red('r1', [0, 0, 6000]), red('r2', [900, 0, 6500]), red('r3', [-900, 0, 6500])], { seed: 7, death: 'explode' });
    await call('auto_camera', {});
    await call('engage', { ships: ['p1', 'p2', 'p3'], target: 'r1' });
    await call('engage', { ships: ['r1', 'r2', 'r3'], target: 'p1' });
    const samples: { tick: number; subject: string; framing: string }[] = [];
    const done = await WaitFor('two kills and 12 s past the first', 150, (polled) => {
      const pick = DirectorOf(polled)?.pick;
      if (pick) samples.push({ tick: polled.simulation.tick, subject: pick.shot.subject, framing: pick.framing });
      const kills = polled.combat?.kills ?? [];
      return kills.length >= 2 || (kills.length === 1 && polled.simulation.tick >= kills[0].tick + 12) ? null : `kills ${kills.length}, shots ${polled.combat?.shots ?? 0}`;
    });
    const kills = (done.combat?.kills ?? []).slice(0, 2);
    const removal = Math.max(...kills.map((kill) => ShipIn(done, kill.ship).destroyed?.explosion?.removesAt ?? kill.tick + 10));
    const removed = await WaitFor('the wrecks are removed', 45, (polled) => (polled.simulation.tick >= removal + 1 ? null : `tick ${polled.simulation.tick} of ${removal}`));
    const log = await DirectorLog();
    directorLogs.push(log);
    const onVictim = (subject: string, victim: string): boolean => subject === victim || subject.endsWith(`→ ${victim}`);
    const lines: string[] = [];
    let framedKills = 0;
    for (const kill of kills) {
      const removesAt = ShipIn(removed, kill.ship).destroyed?.explosion?.removesAt ?? ShipIn(done, kill.ship).destroyed?.explosion?.removesAt ?? kill.tick + 10;
      // The pick standing at the kill (a doom shot), or the cut the kill event makes at the next boundaries.
      const standing = [...log].reverse().find((cut) => cut.tick <= kill.tick);
      const framed = log.find((cut) => onVictim(cut.subject, kill.ship) && cut.tick <= kill.tick + 2 && cut.tick >= (standing?.tick ?? kill.tick));
      // A kill inside another kill framing's hold is not cut to: that blast stays on screen.
      if (!framed && standing?.framing === 'kill' && !onVictim(standing.subject, kill.ship) && kill.tick - standing.tick < 8) {
        lines.push(`${kill.ship} at ${kill.tick}: inside the kill hold on ${standing.subject} from ${standing.tick}`);
        continue;
      }
      Expect(framed != null, `${kill.ship} died at ${kill.tick}: ${CutText(log.filter((cut) => cut.tick >= kill.tick - 8 && cut.tick <= kill.tick + 4))}`);
      const away = log.find((cut) => cut.tick > (framed?.tick ?? kill.tick) && !onVictim(cut.subject, kill.ship));
      Expect(away != null && away.tick >= kill.tick + 3 && away.tick < removesAt, `${kill.ship} died at ${kill.tick}, removed at ${removesAt}; cut away at ${away?.tick}: ${CutText(log.filter((cut) => cut.tick >= kill.tick - 8))}`);
      lines.push(`${kill.ship} at ${kill.tick}: ${framed?.framing} from ${framed?.tick}, away at ${away?.tick} (removed ${removesAt})`);
      framedKills += 1;
    }
    Expect(framedKills >= 1, lines.join('; '));
    return lines.join('; ');
  });

  await Check('director: the 180-degree rule holds over the fight logs', async () => {
    if (!directorLogs.length) throw new Error('no director log from the checks before');
    const breaks = directorLogs.flatMap((log) => AxisBreaks(log));
    Expect(!breaks.length, `breaks ${breaks.join('; ')}`);
    const sided = directorLogs.flat().filter((cut) => cut.side !== 'neutral').length;
    return `${directorLogs.flat().length} cuts over ${directorLogs.length} logs, ${sided} sided, no break`;
  });

  await Check('director: (SDE) a warpIn group gets the warp-in shot before its first landing', async () => {
    await call('load_scene', { scene: DirectorScene('verify-director-warp-in', false) });
    await call('auto_camera', {});
    await WaitFor('the director drives', 5, (polled) => (DirectorOf(polled)?.state === 'driving' ? null : Show(DirectorOf(polled))));
    await call('add_ships', { hull: 'Rifter', count: 3, position: [8000, 0, 12000], team: 'green', fleet: { new: true, id: 'late' }, warpIn: true }).catch(SkipWithoutSde);
    const landed = new Set<string>();
    let warpIn: Maybe<{ tick: number; note: Maybe<string> }> = null;
    let first: Maybe<number> = null;
    await WaitFor('the group lands', 90, (polled) => {
      const pick = DirectorOf(polled)?.pick;
      if (!warpIn && pick?.framing === 'warp-in' && first == null) warpIn = { tick: polled.simulation.tick, note: cinemaOf(polled).note };
      for (const ship of polled.ships) if (ship.id.startsWith('late') && ship.arrival?.state === 'landed') landed.add(ship.id);
      if (landed.size && first == null) first = polled.simulation.tick;
      return landed.size >= 3 ? null : `landed ${landed.size}; pick ${pick?.framing} ${pick?.shot.subject}`;
    });
    const log = await DirectorLog();
    const cut = log.find((entry) => entry.framing === 'warp-in');
    Expect(cut != null && first != null && cut.tick <= first, `first landing ${first}: ${CutText(log)}`);
    return `warp-in at tick ${cut?.tick} on ${cut?.subject}, first landing ${first}; ${cut?.why}`;
  });

  await Check('director: a scripted scene cuts the same after a timeline restart', async () => {
    const scripted = DirectorScene('verify-director-replay');
    // Off first: a Claude-sourced director survives the load and would keep the cue's settings across the restart.
    await call('auto_camera', { on: false });
    await LoadTimeline({
      ...scripted,
      timeline: [
        { id: 'camera', at: 1, auto_camera: { pace: 'fast' } },
        { id: 'fight', at: 2, engage: { ships: ['blue-0', 'blue-1'], target: 'red-0' } }
      ]
    });
    const Run = async (): Promise<string[]> => {
      await Played('the timeline reaches 31 s', 60, 31);
      const report = await TimelineTool();
      const start = report.startedAt ?? 0;
      return (await DirectorLog()).filter((cut) => cut.tick >= start && cut.tick < start + 31).map((cut) => `${cut.tick - start} ${cut.framing} ${cut.subject}`);
    };
    const first = await Run();
    await TimelineTool({ action: 'restart' });
    const second = await Run();
    Expect(first.length >= 4, `${first.length} cuts: ${first.join(', ')}`);
    Expect(Show(first) === Show(second), `first: ${first.join(', ')}\nsecond: ${second.join(', ')}`);
    return `${first.length} equal cuts: ${first.slice(0, 4).join(', ')}, ...`;
  });

  await Check('director: a movement-only fleet cuts across scales on one side of its motion', async () => {
    await call('load_scene', { scene: { name: 'verify-director-motion', ships: DirectorShips('solo', null, 0, 5, { orders: [{ type: 'direction', direction: [1, 0, 0.3] }] }), fleets: [DirectorFleet('solo', 5)] } });
    await Delay(1500);
    await call('auto_camera', { pace: 'fast' });
    await Delay(30000);
    const state = DirectorOf(await call<ViewerState>('get_state'));
    const log = await DirectorLog();
    const scales = new Set(log.map((cut) => cut.scale));
    const sides = new Set(log.filter((cut) => cut.side !== 'neutral' && !cut.crossing).map((cut) => cut.side));
    Expect(state?.axis?.kind === 'motion', Show(state?.axis));
    Expect(scales.size >= 2 && sides.size <= 1 && !AxisBreaks(log).length, `scales ${[...scales].join(', ')}, sides ${[...sides].join(', ')}: ${CutText(log)}`);
    return `${log.length} cuts, scales ${[...scales].join('/')}, side ${[...sides].join('') || 'neutral'}; axis ${state?.axis?.kind}`;
  });

  await Check('director: camera off skips an auto_camera cue; auto_camera { on: false } gives the user the camera', async () => {
    // A Claude-sourced director survives a load: off first, so only the cue could turn it on.
    await call('auto_camera', { on: false });
    await LoadTimeline({ ...DirectorScene('verify-director-off'), timeline: [{ id: 'camera', at: 3, auto_camera: {} }] });
    await TimelineTool({ camera: false });
    await Played('the timeline reaches 4 s', 30, 4);
    const report = await TimelineTool({ camera: true });
    const cue = report.list.find((entry) => entry.id === 'camera');
    Expect(cue?.state === 'skipped' && DirectorOf(await call<ViewerState>('get_state'))?.on !== true, Show(cue));
    await call('auto_camera', {});
    await WaitFor('the director drives', 5, (polled) => (DirectorOf(polled)?.state === 'driving' ? null : Show(DirectorOf(polled))));
    const off = await call<{ readonly director: DirectorStateReport; readonly cinema: CinemaStateReport }>('auto_camera', { on: false });
    const state = await call<ViewerState>('get_state');
    Expect(!off.director.on && cinemaOf(state).driver === 'user', Show({ director: off.director, driver: cinemaOf(state).driver }));
    return `cue ${cue?.state} (${cue?.note}); on: false -> driver ${cinemaOf(state).driver}`;
  });

  // Movie mode (M2): the page plays event cues on their events. Each check loads its own scene; --only movie: runs them
  // alone. (a) and (b) need the SDE (combat and the warp-ins' flight numbers).
  const EventCue = (id: string, when: object, action: object, extra: object = {}) => ({ id, when, ...extra, ...action });
  const EventSeconds = (report: TimelineToolReport, ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, report.list.find((cue) => cue.id === id)?.event?.second ?? null]));
  const MOVIE_RIFTER = { hull: 'Rifter', dna: 'mf4_t1:minmatarbase:minmatar', radius: 31 };
  const WarpInCue = (id: string, at: number, fleet: string, count: number, position: SceneVector) => ({
    id,
    at,
    patch_scene: { operations: [{ op: 'add_fleet_composition', composition: { id: fleet, commander: MOVIE_RIFTER, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ ...MOVIE_RIFTER, count }] }] }] }, position, heading: 180, team: 'red', warpIn: true }] }
  });
  const MOVIE_SECONDS = 45;
  const MOVIE_EVENT_CUES = ['first-blood', 'primary-dies', 'landed', 'chain', 'fallback'];
  interface MovieRun {
    readonly startedAt: number;
    readonly fired: Record<string, number>;
    readonly events: Record<string, Maybe<number>>;
    readonly waiting: Maybe<TimelineSummary>;
    readonly end: Maybe<TimelineSummary>;
  }
  const movieRuns: MovieRun[] = [];
  const MovieRunOf = async (): Promise<MovieRun> => {
    let waiting: Maybe<TimelineSummary> = null;
    const end = await WaitFor(`timeline time ${MOVIE_SECONDS}`, MOVIE_SECONDS + 90, (polled) => {
      const timeline = TimelineOf(polled);
      if (!waiting && timeline?.state === 'playing' && timeline.cues.waiting === MOVIE_EVENT_CUES.length) waiting = timeline;
      return (timeline?.time ?? -1) >= MOVIE_SECONDS ? null : Show(timeline);
    });
    const report = await TimelineTool();
    const fired = Object.fromEntries(Object.entries(FiredAt(report)).filter(([id]) => MOVIE_EVENT_CUES.includes(id)));
    return { startedAt: report.startedAt ?? 0, fired, events: EventSeconds(report, MOVIE_EVENT_CUES), waiting, end: TimelineOf(end) };
  };

  await Check('movie: (SDE) event cues fire on their events, the same across a restart and a jump back', async () => {
    const red = (id: string, position: SceneVector) => ({ ...Rifter(id, position), team: 'red' });
    const blue = (id: string, position: SceneVector) => ({ ...Punisher(id, position), team: 'blue' });
    try {
      await LoadCombatScene(
        [blue('b1', [0, 0, 0]), blue('b2', [800, 0, 0]), blue('b3', [-800, 0, 0]), blue('b9', [0, 0, -60000]), red('r1', [0, 0, 2500]), red('r2', [900, 0, 3000]), red('r3', [-900, 0, 3000])],
        { seed: 7, death: 'explode' },
        {
          fleets: [{ id: 'b', commander: 'b1', wings: [{ id: 'b-w', squads: [{ id: 'b-s', role: 'dps', members: ['b2', 'b3'] }] }] }],
          timeline: [
            { id: 'engage', at: 1, engage: { ships: ['r1', 'r2', 'r3'], target: 'b1' } },
            { id: 'call', at: 1, order_fleet: { fleet: 'b', order: { type: 'targets', set: ['r1', 'r2', 'r3'] } } },
            WarpInCue('reinforce', 3, 'wr', 1, [0, 0, 9000]),
            EventCue('first-blood', { kill: {}, after: 2 }, { switch_prop_mods: { fleet: 'b', active: true } }),
            EventCue('primary-dies', { kill: { primary: 'b' } }, { order_fleet: { fleet: 'b', order: { type: 'targets', next: true } } }),
            EventCue('landed', { arrival: { fleet: 'wr' } }, { order_fleet: { fleet: 'wr', order: { type: 'approach', target: 'b2' } } }),
            EventCue('chain', { cue: 'landed', after: 3 }, { order_fleet: { fleet: 'wr', order: { type: 'stop' } } }),
            EventCue('fallback', { kill: { ship: 'b9' }, latest: 30 }, { order_ship: { id: 'b9', order: { type: 'stop' } } })
          ]
        }
      );
      movieRuns.length = 0;
      movieRuns.push(await MovieRunOf());
      await TimelineTool({ action: 'restart' });
      movieRuns.push(await MovieRunOf());
      await Recorded();
      const jump = await TimeControl({ seek: { timeline: 10 } });
      await Playing();
      movieRuns.push(await MovieRunOf());
      const [first, second, third] = movieRuns;
      Expect(Object.keys(first.fired).length === MOVIE_EVENT_CUES.length && first.fired['fallback'] === 30, `fired ${Show(first.fired)}`);
      for (const id of MOVIE_EVENT_CUES.filter((cue) => cue !== 'fallback')) Expect(first.events[id] != null && first.fired[id] > (first.events[id] ?? Infinity), `${id}: event ${first.events[id]}, fired ${first.fired[id]}`);
      Expect(Show(first.fired) === Show(second.fired) && Show(first.events) === Show(second.events), `restart: ${Show(first)} then ${Show(second)}`);
      Expect(Show(second.fired) === Show(third.fired) && Show(second.events) === Show(third.events), `jump back: ${Show(second)} then ${Show(third)}`);
      return `fired at ${Show(first.fired)} on events at ${Show(first.events)}; equal after a restart and after seek { timeline: 10 } (${jump.jump?.ms} ms)`;
    } finally {
      await Playing();
    }
  });

  await Check('movie: get_state shows the waiting event cues with their texts, then the beats and the event log', async () => {
    Expect(movieRuns.length > 0, 'the event-cue check did not record a run');
    const { waiting, end } = movieRuns[0];
    const texts = Object.fromEntries((waiting?.waiting ?? []).map((cue) => [cue.id, cue.when]));
    Expect(texts['first-blood'] === 'the 1st kill + 2 s' && texts['fallback']?.endsWith('at 30 s at the latest') === true && texts['chain'] === 'cue landed fired + 3 s', Show(waiting?.waiting));
    Expect(end?.beat?.fleet != null && (end.events?.count ?? 0) > 0 && (end.events?.last.length ?? 0) > 0, Show({ beat: end?.beat, events: end?.events }));
    return `waiting ${Show(texts)}; then beat ${Show(end?.beat)}, ${end?.events?.count} events, the last ${Show(end?.events?.last[0])}`;
  });

  await Check('movie: (SDE) a warp-in fires its first, landed and formed cues in order, each the tick after its phase, the same after a restart', async () => {
    await call<ShipStatsAnswer>('ship_stats', { type: 'Rifter' }).catch(SkipWithoutSde);
    const phases = ['ph-first', 'ph-landed', 'ph-formed'];
    await LoadTimeline({
      ships: [Scripted('a', [0, 0, 0])],
      timeline: [WarpInCue('reinforce', 2, 'wr', 2, [0, 0, 9000]), ...(['first', 'landed', 'formed'] as const).map((phase) => EventCue(`ph-${phase}`, { arrival: { fleet: 'wr', phase } }, { order_ship: { id: 'a', order: { type: 'stop' } } }))]
    });
    const Run = async () => {
      await Done(120);
      const report = await TimelineTool();
      return { fired: FiredAt(report), events: EventSeconds(report, phases) };
    };
    const first = await Run();
    await TimelineTool({ action: 'restart' });
    const second = await Run();
    const [at1, at2, at3] = phases.map((id) => first.fired[id]);
    Expect(at1 < at2 && at2 <= at3, `fired ${Show(first.fired)}`);
    for (const id of phases) Expect(first.fired[id] === (first.events[id] ?? -9) + 1, `${id}: event ${first.events[id]}, fired ${first.fired[id]}`);
    Expect(Show(first) === Show(second), `${Show(first)} then ${Show(second)}`);
    return `first +${at1}, landed +${at2}, formed +${at3} (events ${Show(first.events)}); equal after a restart`;
  });

  await Check('movie: bad event cues are refused with every problem', async () => {
    const ships = [Scripted('a', [0, 0, 0])];
    const stop = { order_ship: { id: 'a', order: { type: 'stop' } } };
    const read = await LoadTimeline({ ships, timeline: [EventCue('odd', { explode: {} }, stop), EventCue('both', { kill: {}, warp: {} }, stop)] }).then(() => null, ErrorMessage);
    Expect(read != null && /"odd".*exactly one event kind/su.test(read) && /exactly one event kind[^;]*got kill, warp/su.test(read), `read: ${read}`);
    const cycle = await LoadTimeline({ ships, timeline: [EventCue('c1', { cue: 'c2' }, stop), EventCue('c2', { cue: 'c1' }, stop)] }).then(() => null, ErrorMessage);
    Expect(cycle?.includes('wait for each other') === true, `cycle: ${cycle}`);
    const rw = { id: 'adds', at: 5, patch_scene: { operations: [{ op: 'add_fleet_composition', composition: { id: 'rw', commander: MOVIE_RIFTER, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', ships: [{ ...MOVIE_RIFTER, count: 1 }] }] }] }, position: [0, 0, 9000], heading: 180, team: 'red' }] } };
    const walk = await LoadTimeline({ ships, timeline: [rw, EventCue('early', { kill: {} }, { order_fleet: { fleet: 'rw', order: { type: 'stop' } } }, { at: 0 }), EventCue('ghost', { kill: { ship: 'ghost' } }, stop), EventCue('late', { kill: {}, latest: 5 }, stop, { at: 10 })] }).then(() => null, ErrorMessage);
    Expect(walk?.includes('give at 5 or later (cue "adds" adds it)') === true && walk.includes('no ship "ghost"') && walk.includes('is before the cue arms'), `walk: ${walk}`);
    await LoadTimeline({ ships, timeline: [{ id: 'first', at: 1, ...stop }, EventCue('then', { cue: 'first' }, stop)] }, { timeline: 'pause' });
    const removed = await call('patch_scene', { operations: [{ op: 'remove_cue', id: 'first' }] }).then(() => null, ErrorMessage);
    Expect(removed?.includes('waits for cue "first"') === true, `remove_cue: ${removed}`);
    return 'unknown and two kinds, a cycle, at too early (with its hint), a ghost filter, latest before arms and remove_cue of a waited-for cue: each refused';
  });

  await Check('movie: (SDE) when on engage and add_ships makes event cues with arms that fire on their events', async () => {
    await call<ShipStatsAnswer>('ship_stats', { type: 'Rifter' }).catch(SkipWithoutSde);
    const blue = (id: string, position: SceneVector) => ({ ...Punisher(id, position), team: 'blue' });
    await LoadTimeline(
      {
        combat: { seed: 7, death: 'explode' },
        ships: [blue('b1', [0, 0, 0]), blue('b2', [800, 0, 0]), blue('b3', [-800, 0, 0]), { ...Rifter('r1', [0, 0, 2500]), team: 'red' }],
        timeline: [{ id: 'kill-r1', at: 1, engage: { ships: ['b1', 'b2', 'b3'], target: 'r1' } }, WarpInCue('reinforce', 2, 'wr', 1, [0, 0, 12000])]
      },
      { timeline: 'pause' }
    );
    await WaitTimeline('the timeline is ready', 90, (timeline) => (timeline?.state === 'ready' ? null : Show(timeline)));
    const engage = await call<CueResult>('engage', { ships: ['wr-fc'], target: 'b1', when: { arrival: { fleet: 'wr' } }, cue: 'wr-engage' });
    const avenge = await call<CueResult>('add_ships', { dna: MOVIE_RIFTER.dna, radius: MOVIE_RIFTER.radius, stats: TIMELINE_STATS, count: 1, team: 'red', position: [0, 0, 6000], when: { kill: { ship: 'r1' } }, cue: 'avenge' });
    Expect(engage.state === 'waiting' && engage.cue.arms === 2 && avenge.state === 'waiting' && avenge.cue.arms === 0, Show({ engage: [engage.state, engage.cue], avenge: [avenge.state, avenge.cue] }));
    await TimelineTool({ action: 'play' });
    await WaitTimeline('both event cues fire', 120, (timeline) => (timeline?.cues.waiting === 0 && timeline.cues.pending === 0 ? null : Show(timeline?.waiting ?? timeline)));
    const report = await TimelineTool();
    const fired = FiredAt(report);
    const events = EventSeconds(report, ['wr-engage', 'avenge']);
    Expect(fired['wr-engage'] === (events['wr-engage'] ?? -9) + 1 && fired['avenge'] === (events['avenge'] ?? -9) + 1, Show({ fired, events }));
    return `engage arms ${engage.cue.arms} and add_ships arms ${avenge.cue.arms}, both waiting; fired at +${fired['wr-engage']} (landed at ${events['wr-engage']}) and +${fired['avenge']} (r1 killed at ${events['avenge']})`;
  });

  const errors = await call<LogEntry[]>('page_log', { level: 'error', limit: 20 });
  const unexpected = errors.filter((entry) => !/bogus|nosuchhull|renderer unavailable/u.test(entry.message));
  results.push(`info  page errors: ${errors.length} (${unexpected.length} unexpected)`);
  for (const entry of unexpected.slice(0, 8)) results.push(`        ${entry.message.split('\n')[0].slice(0, 200)}`);
} finally {
  await browser.close();
  await hub.Stop();
}

console.log(results.join('\n'));
process.exit(failed ? 1 : 0);

function DressingProgress(state: ViewerState): string {
  const dressing = state.location?.dressing;
  const objects = dressing?.objects.map((object) => `${object.id} ${object.state}`).join(', ');
  return dressing ? `${dressing.state}: ${objects}` : JSON.stringify(state.location?.status ?? null);
}

function DressingSummary(dressing: LocationDressingReport): string {
  const count = (kind: keyof LocationDressingReport['counts']) => dressing.counts[kind].validated + dressing.counts[kind].drawn;
  return `${dressing.state}: sun ${dressing.sun?.template}/${dressing.sun?.flare}, ${count('planet')} planets, ${count('moon')} moons, ${count('station')} stations, ${count('stargate')} gates`;
}
