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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { Hub } from './lib/hub/hub';
import { ErrorMessage, ErrorProblems } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';

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

interface ViewerState {
  readonly renderer: { readonly available: boolean; readonly adapter?: string; readonly reason?: string };
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

const hub = await new Hub({ port: 0, toolsCore, viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')), log: () => undefined }).Start();
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
    failed += 1;
    results.push(`FAIL  ${label} - ${ErrorMessage(error)}`);
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

  await Check('search_hulls finds frigates', async () => {
    const found = await call<{ names: string[]; total: number }>('search_hulls', { query: 'f1_t1', limit: 5 });
    Expect(found.names.includes('af1_t1'), `got ${found.names.join(', ')}`);
    return `${found.total} matches`;
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
    await call('save_scene', { name: 'verify-saved' });
    Expect(
      (await call<{ name: string }[]>('list_scenes')).some((entry) => entry.name === 'verify-saved'),
      'not listed'
    );
    await call('load_scene', { scene: { name: 'empty', ships: [] } });
    const opened = await call<SceneResult>('open_scene', { name: 'verify-saved' });
    Expect(opened.scene.ships.length === 2, `opened ${opened.scene.ships.length} ships`);
    Expect((await call<{ deleted: boolean }>('delete_scene', { name: 'verify-saved' })).deleted, 'not deleted');
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
