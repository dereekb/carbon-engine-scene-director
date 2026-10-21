/**
 * scene-director serve   runs the hub: the viewer page, the resource proxy and the tool router
 * scene-director mcp     runs an MCP server on stdio, starting the hub or joining a running one
 * scene-director call <tool> [json-args] [--in scene.json] [--out file]
 *                        calls one tool on a running hub and prints the result; a screenshot
 *                        is written to --out (default screenshot.png) instead of printed.
 *                        --in reads a scene file into the "scene" argument (import:
 *                        `call save_scene --in duel.json`); --out writes the scene a result
 *                        carries to a file (export: `call open_scene '{"name":"duel"}' --out duel.json`)
 *
 * Options: --port <n> (5520), --host <addr> (127.0.0.1), --tools-core <url> (http://127.0.0.1:5510),
 *          --build <exact EVE build> (resolved from tools-core "latest" when omitted),
 *          --viewer <dir> (the built viewer; dist/apps/viewer beside this bundle by default),
 *          --scenes <dir> (saved scene files; a scene-director/scenes folder in the per-user data directory by default)
 */

import type { Maybe } from '@dereekb/util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PORT, Hub, LogToStderr } from './lib/hub/hub';
import { RemoteHub } from './lib/hub/remote-hub';
import { SceneOf } from './lib/hub/saved-scenes';
import { ErrorMessage, ErrorProblems, type ToolCaller } from './lib/hub/tool-call';
import { DEFAULT_TOOLS_CORE, ToolsCore } from './lib/hub/tools-core';
import { ImageOf, ServeMcp } from './lib/mcp/server';
import { DefaultScenesDirectory, SceneFileStore } from './lib/store/scene-files';

const USAGE = 'usage: scene-director serve|mcp|call <tool> [json] [--port 5520] [--host 127.0.0.1] [--tools-core http://127.0.0.1:5510] [--build <n>] [--viewer <dir>] [--scenes <dir>] [--in scene.json] [--out file]\n';

/**
 * The value after a command-line flag.
 *
 * @param name - The flag, e.g. "--port".
 * @param fallback - Returned when the flag is absent.
 * @returns The flag's value or the fallback.
 */
function Option<T extends Maybe<string>>(name: string, fallback: T): string | T {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
const host = Option('--host', process.env['SCENE_DIRECTOR_HOST'] ?? '127.0.0.1');
const port = Number(Option('--port', process.env['SCENE_DIRECTOR_PORT'] ?? String(DEFAULT_PORT)));
const viewerDirectory = Option('--viewer', process.env['SCENE_DIRECTOR_VIEWER'] ?? path.resolve(import.meta.dirname, '../viewer'));
const scenes = new SceneFileStore(Option('--scenes', process.env['SCENE_DIRECTOR_SCENES'] || DefaultScenesDirectory()));
const toolsCore = new ToolsCore({
  url: Option('--tools-core', process.env['CJS_TOOLS_CORE'] ?? DEFAULT_TOOLS_CORE),
  build: Option('--build', process.env['SCENE_DIRECTOR_BUILD'] ?? null)
});

/**
 * Starts a hub on the port, or joins the one already there as a controller.
 *
 * @returns The hub to send calls to.
 */
async function StartHubOrJoin(): Promise<ToolCaller> {
  const hub = new Hub({ host, port, toolsCore, viewerDirectory, scenes, log: LogToStderr });
  try {
    return await hub.Start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    LogToStderr(`port ${port} is in use; joining the hub there as a controller (its scenes directory applies, not ${scenes.directory})`);
    return new RemoteHub({ host, port, log: LogToStderr });
  }
}

/**
 * Runs the hub until SIGINT or SIGTERM.
 */
async function Serve(): Promise<void> {
  const hub = await new Hub({ host, port, toolsCore, viewerDirectory, scenes, log: LogToStderr }).Start();
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
    if (input) args['scene'] = JSON.parse(await readFile(input, 'utf8')) as unknown;
    const value = await remote.Call(name, args);
    const image = ImageOf(value);
    const out = Option('--out', null);
    const scene = out ? SceneOf(value) : null;
    if (image) {
      const file = out ?? 'screenshot.png';
      await writeFile(file, Buffer.from(image.data, 'base64'));
      const { image: _image, ...rest } = value as { image: unknown };
      process.stdout.write(`${JSON.stringify({ ...rest, written: file }, null, 2)}\n`);
    } else if (out && scene) {
      await writeFile(out, `${JSON.stringify(scene, null, 2)}\n`);
      const summary = scene === value ? { name: (scene as { name?: unknown }).name } : { ...(value as object), scene: undefined };
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
