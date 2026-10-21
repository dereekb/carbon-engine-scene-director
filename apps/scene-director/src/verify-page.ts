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
import { Hub } from './lib/hub/hub';
import { ShipDataError } from './lib/hub/ship-data';
import type { ShipStatsAnswer } from './lib/hub/ship-stats-tool';
import { ErrorMessage, ErrorProblems } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
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
  readonly scene: { readonly name: string; readonly ships: unknown[] };
  readonly ships: ShipReport[];
  readonly changes: Record<string, number>;
}

interface SceneListing {
  readonly scenes: { readonly name: string; readonly store: string }[];
}

interface ShipState {
  readonly id: string;
  readonly position?: [number, number, number];
  readonly velocity?: [number, number, number];
  readonly speed?: number;
  readonly mode?: string;
}

interface ViewerState {
  readonly renderer: { readonly available: boolean; readonly adapter?: string; readonly reason?: string };
  readonly environment: Maybe<{ readonly background: { readonly ready: boolean }; readonly dressing: { readonly state: string } }>;
  readonly simulation: { readonly tick: number; readonly seconds: number };
  readonly ships: ShipState[];
  readonly distances: { readonly centreToCentre: number }[];
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

// Saved scene files go to a throwaway directory, never the user's.
const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-verify-')));
const hub = await new Hub({ port: 0, toolsCore, viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')), scenes, log: () => undefined }).Start();
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => hub.Call(name, args) as Promise<T>;
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const results: string[] = [];
let failed = 0;

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
    return 'unknown ship and warp refused';
  });

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
