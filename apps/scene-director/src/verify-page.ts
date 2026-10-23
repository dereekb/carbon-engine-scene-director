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
  type SceneObjectStateReport,
  type SceneVector,
  type ShipFleetMembership
} from '@scene-director/scene';
import { AudioBankCache } from './lib/hub/audio-cache';
import { Hub } from './lib/hub/hub';
import { ShipDataError } from './lib/hub/ship-data';
import type { ShipStatsAnswer } from './lib/hub/ship-stats-tool';
import { ErrorMessage, ErrorProblems } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
import { FleetCompositionFileStore } from './lib/store/composition-files';
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
  readonly boosters?: { readonly maxVel: number; readonly intensity: number; readonly warpIntensity: number };
  readonly propMod?: Maybe<ShipPropModState>;
  readonly fit?: Maybe<ShipFitState>;
  readonly fitNote?: string;
  readonly target?: Maybe<{ readonly id: string; readonly kind: 'ship' | 'object'; readonly distance: Maybe<number> }>;
  readonly shots?: number;
  readonly defense?: Maybe<ShipDefenseState>;
  readonly capacitor?: Maybe<ShipCapacitorState>;
  readonly targeted?: Maybe<ShipTargetedState>;
  readonly targeting?: { readonly scanResolution: number; readonly maxTargetRange: number; readonly maxLocks: number };
  readonly locks?: ShipLockState[];
  readonly engaged?: { readonly modules: string[] };
  readonly combat?: ShipCombatState;
  readonly destroyed?: { readonly tick: number; readonly by: string; readonly module: string; readonly weapon: string; readonly mode: string };
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
  readonly combat?: { readonly damage: Record<string, number>; readonly volley: number; readonly dps: number };
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
}

/**
 * set_target's answer (the viewer's director.ts SetTargetResult).
 */
interface SetTargetResult {
  readonly tick: number;
  readonly target: Maybe<string>;
  readonly ships: { readonly id: string; readonly target: Maybe<string>; readonly previous?: string; readonly turrets: number; readonly retargeted: number; readonly lock?: Maybe<ShipLockState> }[];
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
  readonly posted: { readonly tick: number; readonly ship: string; readonly event: string; readonly played: boolean; readonly undecodable?: boolean }[];
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

interface ViewerState {
  readonly renderer: { readonly available: boolean; readonly adapter?: string; readonly reason?: string };
  readonly environment: Maybe<{ readonly background: { readonly ready: boolean }; readonly dressing: { readonly state: string } }>;
  readonly simulation: { readonly tick: number; readonly seconds: number };
  readonly ships: ShipState[];
  readonly distances: { readonly centreToCentre: number }[];
  readonly fleets: (FleetReport & { readonly formation?: FleetFormationState; readonly propMods?: Record<string, number>; readonly modules?: Record<string, number>; readonly command?: FleetGroupCommandReport })[];
  readonly location?: Maybe<LocationReport & { readonly dressing?: Maybe<LocationDressingReport>; readonly targets?: LocationTargetReport[] }>;
  readonly audio?: AudioState;
  readonly objects?: SceneObjectStateReport[];
  readonly cinema?: CinemaStateReport;
  readonly combat?: { readonly seed: number; readonly death: string; readonly shots: number; readonly hits: number; readonly kills: { readonly ship: string; readonly by: string; readonly module: string; readonly weapon: string; readonly tick: number }[] };
}

/**
 * get_state's `cinema` (the viewer's cinema.ts CinemaRig.Report).
 */
interface CinemaStateReport {
  readonly state: 'idle' | 'playing' | 'paused' | 'releasing';
  readonly driver: 'claude' | 'director' | 'user';
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
}

interface StageEngagementResult extends Omit<SceneResult, 'scene'> {
  readonly engagement: { readonly center: SceneVector; readonly heading: number; readonly sides: { readonly team: string; readonly fleet?: string; readonly commander?: string; readonly ships: string[]; readonly lead: Maybe<StagedLead> }[] };
  readonly scene: { readonly ships: { readonly id: string; readonly position: SceneVector }[]; readonly fleets?: unknown[] };
  readonly loaded?: boolean;
}

interface LogEntry {
  readonly message: string;
}

/**
 * get_state's fleet tree with each group's command (order_fleet).
 */
interface CommandTree {
  readonly command?: FleetGroupCommandReport;
  readonly wings: readonly { readonly id: string; readonly command?: FleetGroupCommandReport; readonly squads: readonly { readonly id: string; readonly command?: FleetGroupCommandReport }[] }[];
}

interface OrderFleetResult {
  readonly by: string;
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

const toolsCore = new ToolsCore({ url: Option('--tools-core', DEFAULT_TOOLS_CORE) });
/**
 * `--only <text>` runs only the checks whose label contains the text (any case), after the tab connects.
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
// The audio cache is shared with every hub on the machine (a copy of tools-core's banks, not a store).
const hub = await new Hub({ port: 0, toolsCore, viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')), scenes, compositions, audioCache: new AudioBankCache(), log: () => undefined }).Start();
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
  if (ONLY && label !== CONNECT_CHECK && !label.toLowerCase().includes(ONLY)) return;
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
      Expect(beyond(built) === baseline, `audio game objects beyond the page's emitters went ${baseline} -> ${beyond(built)} with a TFI build: ${JSON.stringify(built.audio)}`);
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

  await Check('launchers are refused', async () => {
    await LoadTurretScene(true);
    const bare = await call<SwitchModulesResult>('switch_modules', { ships: ['rifter'], modules: ['turret'], state: 'active' });
    Expect(bare.skipped.length === 3 && bare.skipped.every((skip) => skip.reason === 'it needs a target: set_target or switch_modules target'), JSON.stringify(bare.skipped));
    const launchers = await call<SwitchModulesResult>('switch_modules', { ships: ['caracal-01'], modules: ['launcher'], state: 'active', target: 'punisher' });
    Expect(!launchers.ships.length && launchers.skipped.length === 5 && launchers.skipped.every((skip) => skip.reason === 'missile launchers fire in the Missiles entry'), JSON.stringify(launchers));
    return "the Caracal's 5 default launchers refused with the Missiles note; turrets without a target refused";
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
  const LoadCombatScene = async (ships: { readonly id: string }[], combat?: object): Promise<ViewerState> => {
    await call<ShipStatsAnswer>('ship_stats', { type: 'Rifter' }).catch(SkipWithoutSde);
    await call('load_scene', { scene: { name: 'verify-combat', ships, ...(combat ? { combat } : {}) } });
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
    const running = await WaitFor('both reps run on the TFI', 10, (polled) => {
      const rows = ['high-0', 'high-1'].map((key) => ModuleRow(polled, 'logi', key));
      const incoming = ShipIn(polled, 'tfi').defense?.incoming ?? [];
      return rows.every((row) => row.state === 'active' && row.target === 'tfi' && row.effectiveness === 1) && incoming.length === 2 ? null : `${JSON.stringify(rows)}, incoming ${JSON.stringify(incoming)}`;
    });
    const incoming = ShipIn(running, 'tfi').defense?.incoming ?? [];
    await call('patch_scene', { operations: [{ op: 'remove_ship', id: 'tfi' }] });
    await WaitFor('the reps stop at once when their target is removed', 5, (polled) => {
      const rows = ['high-0', 'high-1'].map((key) => ModuleRow(polled, 'logi', key));
      return rows.every((row) => row.state !== 'active' && row.state !== 'stopping' && !row.target && /target is gone/.test(row.note ?? '')) ? null : JSON.stringify(rows);
    });
    return `2 Large Remote Armor Repairer II on tfi (incoming ${JSON.stringify(incoming.map((repair) => repair.module))}); stopped with "its target is gone" on its removal`;
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

  if (rendering) {
    await Check('screenshot returns a PNG', async () => {
      const shot = await call<{ image: { data: string }; width: number; height: number }>('screenshot', { maxWidth: 960 });
      await mkdir(path.dirname(SCREENSHOT_FILE), { recursive: true });
      await writeFile(SCREENSHOT_FILE, Buffer.from(shot.image.data, 'base64'));
      return `${shot.width}x${shot.height} -> ${SCREENSHOT_FILE}`;
    });
  }

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
