/**
 * The battle console's end-to-end check (sd-console): starts its own hub in no-EVE-data mode on temp stores with the
 * built console, opens /console/ in headless Chromium, gives the Load input a dna-only zip of two fleets that warp in,
 * then drives the console's buttons and checks the battle through get_state on the hub: both fleets land and both
 * brains engage; Pull range and Hold change the FC's stance while the calls go on; Retreat reports aligned and Warp
 * out lands off grid; a settings drop changes the doctrine without a reload; two Resets give the same landing ticks
 * and decision logs (the duel runs `death: "flag"`: its stand-in guns deal damage, but every ship keeps flying); then a
 * second zip, a brawl, replaces it and fights to a winner with the same kills across two Resets. Needs no tools-core. Build first (dbx-claude-build scene-director and battle-console), then:
 *
 *   node dist/apps/scene-director/verify-console.js [--only <text>] [--headed] [--console <dir>]
 *   npx nx run scene-director:verify-console
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '@scene-director/scene';
import { Hub } from './lib/hub/hub';
import { ErrorMessage } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
import { FleetCompositionFileStore } from './lib/store/composition-files';
import { MovieFileStore } from './lib/store/movie-files';
import { FleetPersonalityFileStore } from './lib/store/personality-files';
import { SceneFileStore } from './lib/store/scene-files';

const DNA = 'wreck_s:genericbase:generic';
const SCENARIO_ID = 'verify-console-duel';
const BRAWL_ID = 'verify-console-brawl';

interface FcState {
  readonly state?: string;
  readonly engaged?: boolean;
  readonly manual?: readonly string[];
  /**
   * The levers a stance flown by the acting FC holds (move, prop-mods).
   */
  readonly piloted?: readonly string[];
  readonly held?: boolean;
  readonly decisions?: readonly { readonly tick: number; readonly lever: string; readonly why: string }[];
}

interface ConsoleState {
  readonly simulation: { readonly tick: number };
  readonly ships: readonly { readonly id: string; readonly team?: string; readonly position?: SceneVector; readonly stance?: Readonly<Record<string, unknown>> & { readonly state?: string }; readonly arrival?: { readonly state: string; readonly landedAt?: number }; readonly destroyed?: { readonly tick: number } }[];
  readonly fleets: readonly { readonly id: string; readonly commander: string; readonly personality?: string; readonly ships: readonly string[]; readonly fc?: FcState }[];
  readonly combat?: { readonly kills: readonly { readonly ship: string; readonly by?: string; readonly module?: string; readonly tick: number }[] };
}

function Option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const joined = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (index >= 0) return process.argv[index + 1];
  return joined ? joined.slice(name.length + 1) : fallback;
}

function Expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Between(a: SceneVector, b: SceneVector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * A fleet of the scenario: an FC, two dps and a logi, all stand-ins.
 *
 * @param id - The composition's id.
 * @returns The cjs-fleet/1 composition.
 */
function Composition(id: string): Record<string, unknown> {
  return {
    schema: 'cjs-fleet/1',
    id,
    commander: { dna: DNA },
    wings: [
      {
        id: 'wing-1',
        squads: [
          { id: 'dps', role: 'dps', ships: [{ dna: DNA, count: 2 }] },
          { id: 'logi', role: 'logi', ships: [{ dna: DNA }] }
        ]
      }
    ]
  };
}

/**
 * The zip the console loads: the scenario, its two compositions and blue's doctrine as separate parts (offline: dna
 * lines, no location, reach in metres, retreat away or a point). They engage `in-range` (`on-sight` works offline too:
 * stand-ins carry stand-in guns and a lock range); death `flag` keeps every ship flying for the lever checks.
 *
 * @param directory - Where to write it.
 * @returns The zip's path.
 */
async function WriteScenarioZip(directory: string): Promise<string> {
  const parts: Record<string, unknown> = {
    'duel/scenario.json': {
      schema: 'cjs-scenario/1',
      id: SCENARIO_ID,
      name: 'Verify console duel',
      description: 'Two stand-in fleets warp in and fight.',
      combat: { seed: 11, death: 'flag' },
      range: 30_000,
      heading: 90,
      sides: [
        { fleet: 'blue', team: 'blue', composition: 'blue-comp', warpIn: true, settings: { personality: 'blue-doctrine', retreat: 'away' } },
        { fleet: 'red', team: 'red', composition: 'red-comp', warpIn: true, settings: { personality: { extends: 'line', command: { ability: 1 }, engage: 'in-range', targeting: { reach: 60_000 } }, retreat: [0, 0, -3_000_000] } }
      ]
    },
    'duel/fleets/blue-comp.json': Composition('blue-comp'),
    'duel/fleets/red-comp.json': Composition('red-comp'),
    'duel/personalities/blue-doctrine.json': { schema: 'cjs-fleet-personality/1', id: 'blue-doctrine', extends: 'line', command: { ability: 1 }, engage: 'in-range', targeting: { reach: 60_000 } }
  };
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });

  for (const [name, json] of Object.entries(parts)) {
    await writer.add(name, new TextReader(JSON.stringify(json, null, 2)));
  }

  const file = path.join(directory, 'duel.zip');
  await writeFile(file, Buffer.from(await (await writer.close()).arrayBuffer()));
  return file;
}

/**
 * The brawl zip: blue 4 against red 2 stand-in cruisers, 8 km apart, warping in to an explode fight; both doctrines
 * engage `on-sight` with a named reach (falloff).
 *
 * @param directory - Where to write it.
 * @returns The zip's path.
 */
async function WriteBrawlZip(directory: string): Promise<string> {
  const composition = (id: string, dps: number) => ({ schema: 'cjs-fleet/1', id, commander: { dna: DNA }, wings: [{ id: 'wing-1', squads: [{ id: 'dps', role: 'dps', ships: [{ dna: DNA, count: dps }] }] }] });
  const doctrine = { extends: 'line', command: { ability: 1 }, engage: 'on-sight', targeting: { reach: 'falloff' }, movement: { stance: 'hold' } };
  const parts: Record<string, unknown> = {
    'brawl/scenario.json': {
      schema: 'cjs-scenario/1',
      id: BRAWL_ID,
      name: 'Verify console brawl',
      description: 'Four stand-ins against two, to the last ship.',
      combat: { seed: 5, death: 'explode' },
      range: 8000,
      heading: 90,
      sides: [
        { fleet: 'blue', team: 'blue', composition: 'brawl-blue', warpIn: true, settings: { personality: doctrine } },
        { fleet: 'red', team: 'red', composition: 'brawl-red', warpIn: true, settings: { personality: doctrine } }
      ]
    },
    'brawl/fleets/brawl-blue.json': composition('brawl-blue', 3),
    'brawl/fleets/brawl-red.json': composition('brawl-red', 1)
  };
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });

  for (const [name, json] of Object.entries(parts)) {
    await writer.add(name, new TextReader(JSON.stringify(json, null, 2)));
  }

  const file = path.join(directory, 'brawl.zip');
  await writeFile(file, Buffer.from(await (await writer.close()).arrayBuffer()));
  return file;
}

const ONLY = Option('--only', '').toLowerCase();
const temp = (name: string) => mkdtemp(path.join(os.tmpdir(), `scene-director-verify-console-${name}-`));
const files = await temp('files');
const hub = await new Hub({
  port: 0,
  eveData: 'off',
  toolsCore: new ToolsCore({ url: DEFAULT_TOOLS_CORE }),
  viewerDirectory: Option('--viewer', path.resolve(import.meta.dirname, '../viewer')),
  consoleDirectory: Option('--console', path.resolve(import.meta.dirname, '../battle-console/browser')),
  scenes: new SceneFileStore(await temp('scenes')),
  compositions: new FleetCompositionFileStore(await temp('fleets')),
  personalities: new FleetPersonalityFileStore(await temp('personalities')),
  movies: new MovieFileStore(await temp('movies')),
  audioCache: null,
  log: () => undefined
}).Start();
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => hub.Call(name, args) as Promise<T>;
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), args: ['--enable-unsafe-webgpu'] });
const results: string[] = [];
let failed = 0;
let stopAfterFailure = false;
const pageErrors: string[] = [];

async function Check(label: string, action: () => Promise<string | void>): Promise<void> {
  if (stopAfterFailure || (ONLY && !ONLY.split('|').some((text) => label.toLowerCase().includes(text)))) return;
  try {
    const detail = await action();
    results.push(detail ? `ok    ${label} - ${detail}` : `ok    ${label}`);
  } catch (error) {
    failed += 1;
    results.push(`FAIL  ${label} - ${ErrorMessage(error)}`);
  }
}

/**
 * Polls get_state every 250 ms until the test passes.
 *
 * @param what - What is awaited, for the failure.
 * @param seconds - The budget.
 * @param test - Null when the state passes, else what is wrong.
 * @returns The passing state.
 */
async function WaitFor(what: string, seconds: number, test: (state: ConsoleState) => Maybe<string>): Promise<ConsoleState> {
  const end = Date.now() + seconds * 1000;
  let last = 'never polled';
  while (Date.now() < end) {
    const state = await call<ConsoleState>('get_state');
    const problem = test(state);
    if (problem == null) return state;
    last = problem;
    await Delay(250);
  }
  throw new Error(`${what} within ${seconds} s: ${last}`);
}

const FleetOf = (state: ConsoleState, id: string) => state.fleets.find((fleet) => fleet.id === id);
const ShipOf = (state: ConsoleState, id: string) => state.ships.find((ship) => ship.id === id);
const Card = (page: Page, fleet: string) => page.locator(`console-fleet-card[data-console-fleet="${fleet}"]`);

/**
 * Clicks a fleet card's command button.
 *
 * @param page - The console.
 * @param fleet - The fleet.
 * @param command - The command (its button's class suffix).
 */
async function Command(page: Page, fleet: string, command: string): Promise<void> {
  const button = Card(page, fleet).locator(`.console-fleet-${command} button`);
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  for (let attempt = 0; attempt < 40 && (await button.isDisabled()); attempt++) await Delay(250);
  await button.click();
}

/**
 * Waits until both fleets landed and both brains engaged; returns each ship's landing tick and each brain's decisions
 * up to a cutoff tick (the Reset comparison).
 *
 * @param seconds - The budget.
 * @returns The landing ticks and the decision logs.
 */
async function LandAndEngage(seconds: number): Promise<{ landings: Record<string, number>; decisions: string; state: ConsoleState }> {
  // a ship's arrival reports landedAt only until it starts to follow: record it while polling
  const landings: Record<string, number> = {};
  const state = await WaitFor('both fleets land and both brains engage', seconds, (polled) => {
    for (const ship of polled.ships) if (ship.arrival?.landedAt != null) landings[ship.id] ??= ship.arrival.landedAt;
    const fleets = ['blue', 'red'].map((id) => FleetOf(polled, id));
    if (fleets.some((fleet) => !fleet)) return `fleets ${polled.fleets.map((fleet) => fleet.id).join(', ') || 'none'}`;
    const flying = polled.ships.filter((ship) => ship.arrival && ship.arrival.state !== 'landed');
    if (flying.length) return `${flying.length} ships still arriving`;
    const idle = fleets.filter((fleet) => !fleet?.fc?.engaged).map((fleet) => (fleet?.id ?? '?') + ' ' + (fleet?.fc?.state ?? 'no brain'));
    return idle.length ? `not engaged: ${idle.join(', ')}` : null;
  });
  // Destiny's tick runs on across loads (seconds): compare ticks from the run's first landing, to 20 after its last
  const first = Math.min(...Object.values(landings), state.simulation.tick);
  const cutoff = Math.max(...Object.values(landings), first) + 20;
  const later = await WaitFor(`the clock passes tick ${cutoff}`, 40, (polled) => (polled.simulation.tick > cutoff ? null : `tick ${polled.simulation.tick}`));
  const decisions = JSON.stringify(['blue', 'red'].map((id) => (FleetOf(later, id)?.fc?.decisions ?? []).filter((decision) => decision.tick >= first && decision.tick <= cutoff).map((decision) => [decision.tick - first, decision.lever, decision.why])));
  return { landings: Object.fromEntries(Object.entries(landings).map(([ship, tick]) => [ship, tick - first])), decisions, state: later };
}

/**
 * Waits until one team has no ship left: returns each kill relative to the run's first landing and the winner.
 *
 * @param seconds - The budget.
 * @returns The kills and the winner.
 */
async function FightToWinner(seconds: number): Promise<{ readonly kills: string; readonly winner: string }> {
  const landings: number[] = [];
  const TeamAlive = (state: ConsoleState, team: string) => state.ships.filter((ship) => ship.team === team && !ship.destroyed).length;
  const state = await WaitFor('one side has no ship left', seconds, (polled) => {
    for (const ship of polled.ships) if (ship.arrival?.landedAt != null) landings.push(ship.arrival.landedAt);
    const alive = ['blue', 'red'].map((team) => TeamAlive(polled, team));
    return polled.ships.length && alive.includes(0) ? null : `alive blue ${alive[0]}, red ${alive[1]}`;
  });
  const first = Math.min(...landings);
  const kills = JSON.stringify((state.combat?.kills ?? []).map((kill) => [kill.ship, kill.by, kill.module, kill.tick - first]));
  const winner = ['blue', 'red'].filter((team) => TeamAlive(state, team) > 0).join() || 'none';
  return { kills, winner };
}

/**
 * Resets through the scenario card and its confirmation.
 *
 * @param page - The console.
 */
async function Reset(page: Page): Promise<void> {
  await page.locator('.console-scenario-reset button').click();
  await page.locator('mat-dialog-container').getByRole('button', { name: 'Reset' }).click();
  // the old run answers until the re-staged one loads: wait for its warp-in to start
  await WaitFor('the reset run loads', 30, (state) => (state.ships.some((ship) => ship.arrival && ship.arrival.state !== 'landed') ? null : 'no ship arriving yet'));
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // the console's own errors (headless WebGPU's are expected): reported after the checks
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebGPU|is invalid due to a previous error|valid external Instance/u.test(message.text())) pageErrors.push(message.text());
  });
  await page.goto(new URL('/console/', hub.url).href);

  await Check('the console connects to the hub', async () => {
    for (let attempt = 0; attempt < 100 && (await call<{ connectedTabs: number }>('viewer_status')).connectedTabs === 0; attempt++) await Delay(200);
    Expect((await call<{ connectedTabs: number }>('viewer_status')).connectedTabs === 1, 'no tab after 20 s');
    await page.locator('.console-scenario-load input[type=file]').waitFor({ state: 'attached', timeout: 20_000 });
  });
  stopAfterFailure = failed > 0;

  let first: Maybe<Awaited<ReturnType<typeof LandAndEngage>>>;

  await Check('a dropped zip stages two warp-in fleets that land and engage', async () => {
    await page.locator('.console-scenario-load input[type=file]').setInputFiles(await WriteScenarioZip(files));
    first = await LandAndEngage(90);
    // each fleet flies its own doctrine template, <fleet>-fc (the warp-in cue's patch embeds them)
    const doctrines = first.state.fleets.map((fleet) => `${fleet.id}:${fleet.personality ?? 'none'}`).join(', ');
    Expect(doctrines === 'blue:blue-fc, red:red-fc', `doctrines ${doctrines}`);
    Expect((await page.locator('console-fleet-card').count()) === 2, 'two fleet cards');
    return `${Object.keys(first.landings).length} landing ticks, both brains engaged, ${doctrines}`;
  });

  await Check('Pull range and Hold change the FC’s stance while the calls go on', async () => {
    const stanceOf = (state: ConsoleState) => JSON.stringify(ShipOf(state, FleetOf(state, 'blue')?.commander ?? '')?.stance ?? null);
    await Command(page, 'blue', 'pull-range');
    const pulled = await WaitFor('blue pulls range', 10, (state) => {
      const fc = FleetOf(state, 'blue')?.fc;
      return fc?.piloted?.includes('move') && !fc.manual?.includes('call') && stanceOf(state) !== 'null' ? null : `piloted ${fc?.piloted?.join() ?? 'none'}, manual ${fc?.manual?.join() ?? 'none'}`;
    });
    await Command(page, 'blue', 'hold-position');
    const held = await WaitFor('blue holds', 10, (state) => (stanceOf(state) !== stanceOf(pulled) && !FleetOf(state, 'blue')?.fc?.manual?.includes('call') ? null : `stance ${stanceOf(state)}`));
    const calls = (state: ConsoleState) => (FleetOf(state, 'blue')?.fc?.decisions ?? []).filter((decision) => decision.lever === 'call').length;
    Expect(calls(held) > 0, 'blue made no call');
    return `pulled ${stanceOf(pulled).slice(0, 60)}, held ${stanceOf(held).slice(0, 60)}; ${calls(held)} calls`;
  });

  await Check('a settings drop changes the doctrine without a reload', async () => {
    const before = await call<ConsoleState>('get_state');
    const settings = path.join(files, 'settings.json');
    await writeFile(settings, JSON.stringify({ schema: 'cjs-scenario/1', id: SCENARIO_ID, sides: [{ fleet: 'red', settings: { personality: { extends: 'kiter', command: { ability: 1 }, engage: 'in-range', targeting: { reach: 60_000 } } } }] }));
    await page.locator('.console-scenario-load input[type=file]').setInputFiles(settings);
    const end = Date.now() + 10_000;
    let doctrine: unknown;
    while (Date.now() < end) {
      doctrine = (await call<{ readonly personalities?: Record<string, { readonly extends?: string }> }>('get_scene')).personalities?.['red-fc']?.extends;
      if (doctrine === 'kiter') break;
      await Delay(250);
    }
    const after = await call<ConsoleState>('get_state');
    Expect(doctrine === 'kiter', `red-fc extends ${String(doctrine)}`);
    Expect(after.simulation.tick >= before.simulation.tick, `the clock went back: ${before.simulation.tick} → ${after.simulation.tick}`);
    return `red-fc extends kiter at tick ${after.simulation.tick} (was ${before.simulation.tick})`;
  });

  const resets: Awaited<ReturnType<typeof LandAndEngage>>[] = [];

  await Check('two Resets give the same landing ticks and decision logs', async () => {
    await Reset(page);
    resets.push(await LandAndEngage(90));
    await Reset(page);
    resets.push(await LandAndEngage(90));
    const [a, b] = resets;
    Expect(JSON.stringify(a.landings) === JSON.stringify(b.landings), `landings ${JSON.stringify(a.landings)} vs ${JSON.stringify(b.landings)}`);
    Expect(a.decisions === b.decisions, `decisions ${a.decisions.slice(0, 200)} vs ${b.decisions.slice(0, 200)}`);
    return `${Object.keys(a.landings).length} landings and ${a.decisions.length} chars of decisions match`;
  });

  await Check('Retreat reports aligned and Warp out lands off grid', async () => {
    await Command(page, 'blue', 'retreat');
    await WaitFor('the blue FC aligned', 40, (state) => {
      const stance = ShipOf(state, FleetOf(state, 'blue')?.commander ?? '')?.stance;
      return stance?.state === 'aligned' ? null : `FC ${stance?.state ?? 'no stance'}`;
    });
    await Command(page, 'blue', 'warp-out');
    await Delay(1000);
    const refused = await Card(page, 'blue')
      .locator('.console-fleet-error')
      .textContent({ timeout: 500 })
      .catch(() => null);
    Expect(!refused, `Warp out: ${refused}`);
    const landed = await WaitFor('blue lands off grid', 60, (state) => {
      const blue = ShipOf(state, FleetOf(state, 'blue')?.commander ?? '')?.position;
      const red = ShipOf(state, FleetOf(state, 'red')?.commander ?? '')?.position;
      const apart = blue && red ? Between(blue, red) : 0;
      const order = JSON.stringify((ShipOf(state, FleetOf(state, 'blue')?.commander ?? '') as { readonly order?: unknown } | undefined)?.order ?? null).slice(0, 160);
      return apart > 1_000_000 ? null : `${Math.round(apart / 1000)} km apart, FC order ${order}`;
    });
    const blue = ShipOf(landed, FleetOf(landed, 'blue')?.commander ?? '')?.position;
    const red = ShipOf(landed, FleetOf(landed, 'red')?.commander ?? '')?.position;
    return `aligned, then ${blue && red ? Math.round(Between(blue, red) / 1000) : '?'} km from red`;
  });

  await Check('a scenario fight ends with a winner, with equal kill ticks across two Resets', async () => {
    try {
      await call('time_control', { rate: 4 });
      await page.locator('.console-scenario-load input[type=file]').setInputFiles(await WriteBrawlZip(files));
      await page.locator('mat-dialog-container').getByRole('button', { name: 'Load' }).click();
      await WaitFor('the brawl loads', 30, (state) => (state.ships.some((ship) => ship.arrival && ship.arrival.state !== 'landed') && state.ships.length === 6 ? null : `${state.ships.length} ships`));
      const loaded = await FightToWinner(120);
      Expect(loaded.winner === 'blue', `winner ${loaded.winner}: ${loaded.kills}`);
      const bar = Card(page, 'red').locator('.console-fleet-command button').first();
      for (let attempt = 0; attempt < 40 && !(await bar.isDisabled()); attempt++) await Delay(250);
      Expect(await bar.isDisabled(), 'the red command bar is not blocked');
      const runs: Awaited<ReturnType<typeof FightToWinner>>[] = [];
      for (let run = 0; run < 2; run++) {
        await Reset(page);
        runs.push(await FightToWinner(120));
      }
      Expect(runs[0].kills === runs[1].kills && runs[0].winner === runs[1].winner, `${runs[0].winner} ${runs[0].kills} vs ${runs[1].winner} ${runs[1].kills}`);
      return `blue won; kills ${runs[0].kills} (two Resets)`;
    } finally {
      await call('time_control', { rate: 1, pause: false });
    }
  });
} finally {
  await browser.close();
  await hub.Stop();
}

if (pageErrors.length) results.push(`info  ${pageErrors.length} page error(s), first: ${pageErrors[0].split('\n')[0].slice(0, 200)}`);
console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
