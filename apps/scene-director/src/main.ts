/**
 * scene-director serve   runs the hub: the viewer page, the resource proxy and the tool router
 * scene-director mcp     runs an MCP server on stdio, starting the hub or joining a running one
 * scene-director call <tool> [json-args] [--in scene.json] [--out file]
 *                        calls one tool on a running hub and prints the result; a screenshot
 *                        is written to --out (default screenshot.png) instead of printed.
 *                        --in reads a scene file into the "scene" argument (import:
 *                        `call save_scene --in duel.json`); --out writes the scene a result
 *                        carries to a file (export: `call open_scene '{"name":"duel"}' --out duel.json`).
 *                        For save_fleet_composition and add_fleet_composition --in fills "composition"
 *                        instead (`call save_fleet_composition --in tfis.json`), and --out writes the
 *                        composition get_fleet_composition returns
 *
 * Options: --port <n> (5520), --host <addr> (127.0.0.1), --tools-core <url> (http://127.0.0.1:5510),
 *          --eve-data tools-core|off (SCENE_DIRECTOR_EVE_DATA; tools-core by default; off is no-EVE-data mode: the hub
 *          never touches tools-core and the page asks for no EVE data, sd-dev-env),
 *          --build <exact EVE build> (resolved from tools-core "latest" when omitted),
 *          --viewer <dir> (the built viewer; dist/apps/viewer beside this bundle by default),
 *          --console <dir> (the built battle console, served at /console/; dist/apps/battle-console/browser beside
 *          this bundle when it exists, else not served),
 *          --scenes <dir> (saved scene files; a scene-director/scenes folder in the per-user data directory by default),
 *          --fleets <dir> (saved fleet compositions; a scene-director/fleets folder in the per-user data directory by default),
 *          --personalities <dir> (saved fleet personalities; a scene-director/personalities folder in the per-user data
 *          directory by default),
 *          --movies <dir> (export_movie's MP4 files, served at /movies/<file>; a scene-director/movies folder in the
 *          per-user data directory by default),
 *          --audio-cache <dir> (local copies of tools-core's sound banks the page reads ranges from; a
 *          scene-director-audio-cache folder in the OS temp directory by default)
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_EVE_DATA_MODE, type EveDataMode, readEveDataMode } from '@scene-director/scene';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AudioBankCache, DEFAULT_AUDIO_CACHE_DIRECTORY } from './lib/hub/audio-cache';
import { DEFAULT_PORT, Hub, type HubOptions, LogToStderr } from './lib/hub/hub';
import { RemoteHub } from './lib/hub/remote-hub';
import { SceneOf } from './lib/hub/saved-scenes';
import { ErrorMessage, ErrorProblems, type ToolCaller } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
import { ImageOf, ServeMcp } from './lib/mcp/server';
import { defaultFleetCompositionsDirectory, FleetCompositionFileStore } from './lib/store/composition-files';
import { DefaultMoviesDirectory, MovieFileStore } from './lib/store/movie-files';
import { defaultFleetPersonalitiesDirectory, FleetPersonalityFileStore } from './lib/store/personality-files';
import { DefaultScenesDirectory, SceneFileStore } from './lib/store/scene-files';

const USAGE =
  'usage: scene-director serve|mcp|call <tool> [json] [--port 5520] [--host 127.0.0.1] [--tools-core http://127.0.0.1:5510] [--eve-data tools-core|off] [--build <n>] [--viewer <dir>] [--console <dir>] [--scenes <dir>] [--fleets <dir>] [--personalities <dir>] [--movies <dir>] [--audio-cache <dir>] [--in scene.json] [--out file]\n';

/**
 * The tools whose --in file is a fleet composition rather than a scene.
 */
const COMPOSITION_INPUT_TOOLS = new Set(['save_fleet_composition', 'add_fleet_composition']);

/**
 * The value after a command-line flag, `--name value` or `--name=value` (nx forwards the second form).
 *
 * @param name - The flag, e.g. "--port".
 * @param fallback - Returned when the flag is absent.
 * @returns The flag's value or the fallback.
 */
function Option<T extends Maybe<string>>(name: string, fallback: T): string | T {
  const index = process.argv.indexOf(name);
  const joined = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (index >= 0) return process.argv[index + 1];
  return joined ? joined.slice(name.length + 1) : fallback;
}

const command = process.argv[2];
const host = Option('--host', process.env['SCENE_DIRECTOR_HOST'] ?? '127.0.0.1');
const port = Number(Option('--port', process.env['SCENE_DIRECTOR_PORT'] ?? String(DEFAULT_PORT)));
const viewerDirectory = Option('--viewer', process.env['SCENE_DIRECTOR_VIEWER'] ?? path.resolve(import.meta.dirname, '../viewer'));
const defaultConsoleDirectory = path.resolve(import.meta.dirname, '../battle-console/browser');
const consoleDirectory = Option('--console', process.env['SCENE_DIRECTOR_CONSOLE'] || (existsSync(defaultConsoleDirectory) ? defaultConsoleDirectory : null));
const scenes = new SceneFileStore(Option('--scenes', process.env['SCENE_DIRECTOR_SCENES'] || DefaultScenesDirectory()));
const compositions = new FleetCompositionFileStore(Option('--fleets', process.env['SCENE_DIRECTOR_FLEETS'] || defaultFleetCompositionsDirectory()));
const personalities = new FleetPersonalityFileStore(Option('--personalities', process.env['SCENE_DIRECTOR_PERSONALITIES'] || defaultFleetPersonalitiesDirectory()));
const movies = new MovieFileStore(Option('--movies', process.env['SCENE_DIRECTOR_MOVIES'] || DefaultMoviesDirectory()));
const audioCache = new AudioBankCache({ directory: Option('--audio-cache', process.env['SCENE_DIRECTOR_AUDIO_CACHE'] || DEFAULT_AUDIO_CACHE_DIRECTORY), log: LogToStderr });

/**
 * The options a hub is made with. The EVE data mode is read here, where a hub is made, so `call` ignores it; an
 * invalid one exits 2. tools-core is configured only with EVE data on.
 *
 * @returns The hub's options.
 */
function HubOptionsFromCommandLine(): HubOptions {
  const eveData: Maybe<EveDataMode> = readEveDataMode(Option('--eve-data', process.env['SCENE_DIRECTOR_EVE_DATA'] || DEFAULT_EVE_DATA_MODE));
  if (!eveData) {
    process.stderr.write(`--eve-data (or SCENE_DIRECTOR_EVE_DATA) must be tools-core or off\n${USAGE}`);
    process.exit(2);
  }
  const toolsCore =
    eveData === 'off'
      ? undefined
      : new ToolsCore({
          url: Option('--tools-core', process.env['CJS_TOOLS_CORE'] ?? DEFAULT_TOOLS_CORE),
          build: Option('--build', process.env['SCENE_DIRECTOR_BUILD'] ?? null)
        });
  return { host, port, eveData, toolsCore, viewerDirectory, consoleDirectory, scenes, compositions, personalities, movies, audioCache, log: LogToStderr };
}

/**
 * Starts a hub on the port, or joins the one already there as a controller.
 *
 * @returns The hub to send calls to.
 */
async function StartHubOrJoin(): Promise<ToolCaller> {
  const hub = new Hub(HubOptionsFromCommandLine());
  try {
    return await hub.Start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    LogToStderr(`port ${port} is in use; joining the hub there as a controller (its EVE data mode and its scenes, fleets, personalities and movies directories apply, not ${scenes.directory}, ${compositions.directory}, ${personalities.directory} and ${movies.directory})`);
    return new RemoteHub({ host, port, log: LogToStderr });
  }
}

/**
 * Runs the hub until SIGINT or SIGTERM.
 */
async function Serve(): Promise<void> {
  const hub = await new Hub(HubOptionsFromCommandLine()).Start();
  const stop = async (): Promise<void> => {
    await hub.Stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

/**
 * Serves MCP on stdio until stdin closes. Nothing but MCP messages may reach stdout.
 */
async function Mcp(): Promise<void> {
  const hub = await StartHubOrJoin();
  await ServeMcp(hub);
  process.stdin.on('close', () => {
    void hub.Stop().then(() => process.exit(0));
  });
}

/**
 * Calls one tool on a running hub and prints the result.
 *
 * @param name - The tool name.
 */
async function CallOnce(name: string): Promise<void> {
  const remote = new RemoteHub({ host, port });
  try {
    const argsText = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : '{}';
    const args = JSON.parse(argsText) as Record<string, unknown>;
    const input = Option('--in', null);
    if (input) args[COMPOSITION_INPUT_TOOLS.has(name) ? 'composition' : 'scene'] = JSON.parse(await readFile(input, 'utf8')) as unknown;
    const value = await remote.Call(name, args);
    const image = ImageOf(value);
    const out = Option('--out', null);
    const scene = out ? (name === 'get_fleet_composition' ? ((value as { composition?: object }).composition ?? null) : SceneOf(value)) : null;
    if (image) {
      const file = out ?? 'screenshot.png';
      await writeFile(file, Buffer.from(image.data, 'base64'));
      const { image: _image, ...rest } = value as { image: unknown };
      process.stdout.write(`${JSON.stringify({ ...rest, written: file }, null, 2)}\n`);
    } else if (out && scene) {
      await writeFile(out, `${JSON.stringify(scene, null, 2)}\n`);
      const summary = scene === value ? { name: (scene as { name?: unknown }).name } : { ...(value as object), scene: undefined, composition: undefined };
      process.stdout.write(`${JSON.stringify({ ...summary, written: out }, null, 2)}\n`);
    } else {
      if (out) process.stderr.write(`${name} returned no scene or image, so nothing was written to ${out}\n`);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
  } catch (error) {
    const problems = ErrorProblems(error) ?? [];
    const detail = problems.length ? '\n- ' + problems.join('\n- ') : '';
    process.stderr.write(`${ErrorMessage(error)}${detail}\n`);
    process.exitCode = 1;
  } finally {
    await remote.Stop();
  }
}

if (command === 'serve') {
  await Serve();
} else if (command === 'mcp') {
  await Mcp();
} else if (command === 'call' && process.argv[3]) {
  await CallOnce(process.argv[3]);
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}
