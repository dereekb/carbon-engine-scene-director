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
import { formationSpacing, toFollowTolerance, type FleetReport, type SceneVector, type ShipFleetMembership } from '@scene-director/scene';
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
  readonly source: string;
  readonly typeID?: number;
  readonly typeName?: string;
  readonly note?: string;
}

interface ShipState extends Partial<ShipFleetMembership> {
  readonly id: string;
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
}

interface ShipFollowingState {
  readonly state: string;
  readonly anchor: string;
  readonly range: number;
  readonly slot?: { readonly range: number; readonly direction: SceneVector };
  readonly distance?: number;
  readonly slotError?: number;
}

interface FleetFormationState {
  readonly ready: boolean;
  readonly heading: [number, number];
  readonly following: number;
  readonly inFormation: number;
  readonly catchingUp: number;
  readonly detached: number;
  readonly waiting: number;
}

interface ViewerState {
  readonly renderer: { readonly available: boolean; readonly adapter?: string; readonly reason?: string };
  readonly environment: Maybe<{ readonly background: { readonly ready: boolean }; readonly dressing: { readonly state: string } }>;
  readonly simulation: { readonly tick: number; readonly seconds: number };
  readonly ships: ShipState[];
  readonly distances: { readonly centreToCentre: number }[];
  readonly fleets: (FleetReport & { readonly formation?: FleetFormationState })[];
}

interface AddedFleetResult extends Omit<SceneResult, 'scene'> {
  readonly added: { readonly fleet: string; readonly commander: string; readonly ships: string[] };
  readonly hulls: { readonly hull?: string; readonly radius: number; readonly dnaFrom: string; readonly radiusFrom: string }[];
  readonly scene: { readonly name: string; readonly ships: { readonly id: string; readonly type?: string; readonly position: SceneVector }[] };
}

interface LogEntry {
  readonly message: string;
}

const SCREENSHOT_FILE = '.scratch/verify.png';

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
const status = await toolsCore.Status();
if (!status.reachable) {
  console.error(status.error);
  process.exit(1);
}

// Saved scene and fleet composition files go to throwaway directories, never the user's.
const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-')));
const compositions = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-fleets-')));
const hub = await new Hub({ port: 0, toolsCore, viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')), scenes, compositions, log: () => undefined }).Start();
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => hub.Call(name, args) as Promise<T>;
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
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
  await Check('the tab connects to the hub', async () => {
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
    const warp = await refusal({ id: 'rifter', order: { type: 'warp' } });
    Expect(/order\.type must be one of/u.test(warp), warp);
    const nobody = await refusal({ id: 'rifter', order: { type: 'orbit', target: 'nobody', range: 1000 } });
    Expect(/order\.target "nobody" is not a ship in the scene/u.test(nobody), nobody);
    const itself = await refusal({ id: 'rifter', order: { type: 'approach', target: 'rifter' } });
    Expect(/order\.target must be another ship/u.test(itself), itself);
    const rangeless = await refusal({ id: 'rifter', order: { type: 'keep-at-range', target: 'punisher' } });
    Expect(/order\.range must be a number of metres/u.test(rangeless), rangeless);
    return 'unknown ship, warp, a missing target, the ship itself and a missing range refused';
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
