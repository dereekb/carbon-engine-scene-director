# carbon-engine-scene-director

Drives CarbonEngineJS (the open-source JS port of EVE Online's engine) space scenes from JSON scene documents
over MCP tools, rendered live in a browser tab. README.md documents the architecture, the tools and the scene format.

## Layout (nx workspace)

- `packages/scene` (`@scene-director/scene`, `@nx/js:tsc`): the `cjs-scene/1` document schema (validation, patch
  operations, diff) and the shared tool list. No runtime imports; the hub, the page and the tests all use it.
- `apps/scene-director` (`@nx/esbuild`, node): the hub (HTTP + WebSocket on 127.0.0.1:5520), the stdio MCP server
  and the CLI (`serve`, `mcp`, `call`), plus `verify-page.ts`. Building it builds the viewer too (implicit dependency).
- `apps/viewer` (`@nx/esbuild`, browser): the page. `src/lib/runtime.ts` is the single runtime import point and
  `src/lib/carbonenginejs-runtime.d.ts` types those imports (the runtime ships no `.d.ts`). Add a member to the
  declarations file when the page starts using it; do not reach for `any`.
- `bin/scene-director.js` launches `dist/apps/scene-director/main.js`; `.mcp.json` points at it.

## Commands

- Build: `npx nx build scene-director` (scene, viewer and the CLI). Serve the hub by hand: `npx nx run scene-director:serve`.
- Tests: the `dbx-claude-test` tool (`project: scene` / `scene-director`). The MCP spec spawns the built CLI, so
  `test` depends on `build`.
- Real-page check: `npx nx run scene-director:verify-page` against a running tools-core. It checks everything but
  drawing (see below).
- Commit through `dbx-claude-commit`: it gates lint, build, typecheck and the affected projects' tests.
- Format: `npx oxfmt --write .`. Lint config is the dbx library config (`eslint.config.library.mjs`); warnings are
  allowed, errors block.

## Must-keep gotchas (each one cost real debugging)

- The viewer bundle MUST ignore the runtime's package.json `sideEffects` list (`ignoreAnnotations: true` in
  `apps/viewer/esbuild.config.mjs`). Many listed files register classes on import; without them Black reading fails
  with "No source shape registered for Black type ...".
- `runtime-dist/<file>` must resolve to `node_modules/@carbonenginejs/runtime/dist/<file>` (the esbuild plugin in
  `apps/viewer/esbuild.config.mjs`). It reaches the WebGPU internals (`trinityal/webgpu/internal.js`), which the
  package does not export by design, and `global/blue/children.js`. It must resolve to the same files the public
  subpaths load, so classes are never duplicated.
- Runtime HEAD removed `Traverse`; `ships.ts` walks a graph with `blue.FindAllReferences(root).keys()` plus the root.
- Runtime ca8b32652 renamed `Destroy()` to `Destruct()`; `ships.ts` `Teardown` calls whichever exists.
- `ITriVectorFunction`'s base `Update__Ticks` passes arguments in the opposite order from its own docs, so the
  `StaticPosition` / `StaticRotation` curves override every `*__Ticks` method directly.
- `runtime.ts` imports `@carbonenginejs/runtime/audio` for its side effects: SOF hull values carry audio classes.
  `resources.ts` registers `CjsPngFormat` with `ImageIO`: the post process reads PNGs.
- The MCP process must never write to stdout except MCP protocol messages; the hub logs to stderr.
- The saved-scene tools are `where: 'hub'` (`apps/scene-director/src/lib/hub/saved-scenes.ts`): disk files by default,
  forwarded to the page's IndexedDB handlers for `store: "browser"`. Tests and verify-page pass a temp
  `SceneFileStore`; never let a test write to the default per-user scenes directory.
- tools-core needs Node 22 (its better-sqlite3 binding; Node 24 is the default here). Start it with:
  `cd /mnt/a/github/carbonenginejs/tools-core && /root/.nvm/versions/node/v22.23.4/bin/node bin/cjs-tools-service.js --cache "$PWD/.cache/tool-core" --data "$PWD/data.local" --no-audio-auto-prepare --no-sde-auto-prepare`
- Headless Chromium in this WSL has no WebGPU adapter (Dawn finds SwiftShader but cannot create its context
  provider), so verify-page checks everything except drawing. Do not sink time into headless GPU. Ask the user to
  open http://127.0.0.1:5520/ in Windows Chrome or Edge, then use the `screenshot` and `page_log` tools.
- This is WSL on a 9p-mounted Windows drive: don't rename directories a running process uses as its working directory.
- The hub on 5520 is often owned by a Claude Code session's MCP server (`bin/scene-director.js mcp`). After a
  rebuild, that session must reconnect its MCP server (`/mcp`) for the hub to serve the new page and code.

## Boundaries

- Upstream clones in `/mnt/a/github/carbonenginejs/` (runtime, tools-core, server, tools-blender, format-gr2) are
  read-only references. DO NOT EDIT THEM.
- The runtime dependency is a copy of `../carbonenginejs/runtime/npm` (install-links, pinned at runtime commit
  f77ed790c; see `runtimePin` in package.json). Rebuild that checkout at the pinned commit before reinstalling.
- The viewer UI is a plain DOM overlay. dbx-web / dbx-components and Angular are acceptable when a feature
  genuinely needs them, but keep the viewer simple.
- EVE content is CCP's (see README); the code is MIT.
