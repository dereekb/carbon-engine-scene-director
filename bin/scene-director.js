#!/usr/bin/env node
/**
 * Launches the built CLI (dist/apps/scene-director/main.js) with this process's arguments,
 * so .mcp.json and shell use keep one stable path. Build it with `npx nx build scene-director`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const main = fileURLToPath(new URL('../dist/apps/scene-director/main.js', import.meta.url));
if (!existsSync(main)) {
  process.stderr.write(`[scene-director] ${main} is missing; run "npx nx build scene-director" in ${fileURLToPath(new URL('..', import.meta.url))}\n`);
  process.exit(1);
}
await import(pathToFileURL(main).href);
