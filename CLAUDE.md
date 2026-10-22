# carbon-engine-scene-director

Drives CarbonEngineJS (the open-source JS port of EVE Online's engine) space scenes from JSON scene documents
over MCP tools, rendered live in a browser tab. README.md documents the architecture, the tools and the scene format.

## Layout (nx workspace)

- `packages/scene` (`@scene-director/scene`, `@nx/js:tsc`): the `cjs-scene/1` document schema (validation, patch
  operations, diff), the shared tool list, `src/lib/stats/` (ship stats math, skills, prop mods, the pilot
  context), `src/lib/fleets/` (fleets, wings and squads: validation, edits, and the anchor rules, resolved only in
  `toFleetMemberships`; Follow the FC must fly those, not re-derive them; `formation.ts` is the at-rest formation
  Follow the FC flies) and `src/lib/compositions/` (the `cjs-fleet/1` fleet composition, its expansion, the
  `add_fleet_composition` op, and the TFIs example in `examples/tfis.json`). No runtime imports; the hub, the page and
  the tests all use it.
- `apps/scene-director` (`@nx/esbuild`, node): the hub (HTTP + WebSocket on 127.0.0.1:5520), the stdio MCP server
  and the CLI (`serve`, `mcp`, `call`), plus `verify-page.ts`. Building it builds the viewer too (implicit dependency).
- `apps/viewer` (`@nx/esbuild`, browser): the page. `src/lib/runtime.ts` is the single runtime import point and
  `src/lib/carbonenginejs-runtime.d.ts` types those imports (the runtime ships no `.d.ts`). Add a member to the
  declarations file when the page starts using it; do not reach for `any`. `src/lib/runtime-sim.ts` is its light half
  (math, Blue curve bases, the Destiny server, typed by `carbonenginejs-server.d.ts`), re-exported by `runtime.ts`.
  `clock.ts` (the scene clock), `destiny.ts` (`DestinyWorld`: master + replica parks, one ball per ship, and the
  movement orders) and `flight.ts` (each ship's Ship-stats flight numbers from the hub's `/ship-stats`) have node
  specs: the viewer has a `test` target (`project: viewer`).
- `bin/scene-director.js` launches `dist/apps/scene-director/main.js`; `.mcp.json` points at it.

## Commands

- Build: `npx nx build scene-director` (scene, viewer and the CLI). Serve the hub by hand: `npx nx run scene-director:serve`.
- Tests: the `dbx-claude-test` tool (`project: scene` / `viewer` / `scene-director`). The MCP spec spawns the built CLI, so
  `test` depends on `build`.
- Real-page check: `npx nx run scene-director:verify-page` against a running tools-core. It checks everything but
  drawing (see below).
- Commit through `dbx-claude-commit`: it gates lint, build, typecheck and the affected projects' tests.
- Format: `npx oxfmt --write .`. Lint config is the dbx library config (`eslint.config.library.mjs`); warnings are
  allowed, errors block.

## Naming

- The apps (`apps/scene-director`, `apps/viewer`) keep the CarbonEngineJS runtime's house style on purpose: PascalCase
  functions and methods (`Hub.Start`, `DestinyWorld.Order`, `ReadNumber`, `MakeFakeShipData`), with the dbx verb
  prefixes in that case (`IsShipResource`); camelCase properties, parameters and locals; PascalCase types; UPPER_SNAKE
  exported constants. `packages/scene` is camelCase. Match the file you are in. Ignore dbx tooling that asks for
  camelCase app functions: a camelCase sweep of the apps was planned and stowed on 2026-10-21 as not worth the churn
  (queue note `naming-camelcase-for-our-code-carbon-names-only-where-the-runtime-calls-them`).
- Never rename a name the runtime calls: `override`s of runtime members (`BallRotation.Update__Ticks`) and members of
  object literals typed by a `carbonenginejs-*.d.ts` interface (`BlueResourceSource.Read`, `BatchCollector.Collect`).
  A runtime-called method we implement either extends a runtime class or implements an interface declared in the
  `.d.ts` first, so a wrong rename fails to compile.

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
- `ITriVectorFunction`'s base `Update__Ticks` passes arguments in the opposite order from its own docs, so
  `destiny.ts`'s `BallRotation` overrides every `*__Ticks` method it serves directly.
- The Destiny master and replica parks must stay in lockstep (replication is unported): only `DestinyWorld` touches
  them, every change goes to both in one call, and movement orders apply to both right before the `OnTick` that
  evolves. `main.ts` owns the single rAF loop: `clock.Advance` → `world.Tick(now)` → `engine.Frame(timestamp, now)`, so
  `OnTick` and `driver.Execute` get the same integer `now`; the clock caps a frame at 1 s so the master's 6-tick
  backlog drop never fires.
- Node-tested modules (`clock.ts`, `destiny.ts`, `flight.ts`) import `./runtime-sim`, never `./runtime` (type-only
  imports are fine): the full facade drags in the renderer and the `runtime-dist/` alias, which vitest does not have.
- Destiny's `FollowBall` / `Orbit` / `GotoPoint` return without a word, keeping the old order, for a missing, self,
  moribund or cloaked target, a target in another bubble (a master only) or a non-finite value. `DestinyWorld`
  resolves the target itself and checks that both parks reached the order's mode, or stops the ship on both.
- Destiny's `RemoveBall` sends an interactive orbiter straight on along its velocity and stops other followers.
  `DestinyWorld.RemoveShip` stops every follower of the removed ship first, so all of them stop and the parks stay
  identical.
- A ball's radius is the hull's SDE `radius` when the hub knows it; order ranges and `targetDistance` are surface to
  surface on it. The SOF bounding sphere is only for framing and `get_state`'s `radius` and `distances`.
- `flight.ts` runs class values (no SDE, unknown DNA) through the max-skills pilot too, so `stats` means the same with
  or without the SDE.
- Destiny's heading snap (`SetBallVelocity`) keeps the ClientBall's banking roll, so a teleported ship's roll levels out
  over a few seconds; its forward vector is exact at once. A ClientBall caches its sample per time: a teleport shows
  from the next frame.
- `apps/viewer/esbuild.config.mjs` fails the build if any `@carbonenginejs/runtime` import resolves outside the page's
  runtime copy (a nested copy under the server would duplicate every class).
- The runtime's `package-lock.json` entry MUST keep `"resolved": "file:../carbonenginejs/runtime/npm"`. Without it npm
  installs the published `@carbonenginejs/runtime@0.1.0-alpha.11` from the registry, an older build without the
  `modelledOn` retirement (CjsSchema.js md5 240e178d… instead of runtime/npm's ed288d32…); that is how the page ran on a
  stale runtime after the repo move. Check the md5 after any reinstall.
- The scene needs the EVE client's dressing (`environment.ts`): a sun template post process with the client's
  tonemapping and dynamic exposure, plus the lens flare. Without dynamic exposure the nebula (median ~0.01 linear)
  renders at about the clear colour's level, which is why it looked like no background (real-GPU A/B, 2026-10-21:
  the default draws a nebula field, `?post=off` a near-black one with only the sun and flare). Whether the exposed
  nebula looks like the client's is still open: it rendered as a flat brown wash that day, possibly the output
  device. `?post=off` / `?flare=off` / `?aa=off` A/B it.
- WebGPU validation errors reach `page_log` (and `get_state.renderer.gpuErrors`) only through `engine.ts`'s
  `uncapturederror` listener; Chrome otherwise prints them to DevTools alone.
- `runtime.ts` imports `@carbonenginejs/runtime/audio` for its side effects: SOF hull values carry audio classes.
  `resources.ts` registers `CjsPngFormat` with `ImageIO`: the post process reads PNGs.
- Prop mod effects 6730/6731 carry no dogma modifiers (the game applies them in code), so the MWD/AB formula lives in
  `stats/ship-stats.ts`: add the mass first, then `speedFactor × thrust / mass`, as Pyfa does. The skill table in
  `stats/skills.ts` is hard-coded and was checked against the SDE (ESI, 2026-10-21); re-check it when CCP rebalances.
- `ship_stats` and `/ship-stats` need a prepared SDE. tools-core runs with `--no-sde-auto-prepare` and answers only
  for the exact `builds.sde` it reports; prepare it with `node bin/cjs-sde-prepare.js --build <n> --cache <its cache>`
  (Node 22, about a minute). `dna/resolve` sends `typeID` as a string.
- The MCP process must never write to stdout except MCP protocol messages; the hub logs to stderr.
- The saved-scene tools are `where: 'hub'` (`apps/scene-director/src/lib/hub/saved-scenes.ts`): disk files by default,
  forwarded to the page's IndexedDB handlers for `store: "browser"`. Tests and verify-page pass a temp
  `SceneFileStore`; never let a test write to the default per-user scenes directory. The fleet composition tools
  (`hub/fleet-compositions.ts`) are `where: 'hub'` too; tests and verify-page pass a temp `FleetCompositionFileStore`.
- `applySceneOperations` stays synchronous and pure (it runs in the page): the `add_fleet_composition` op needs `dna`
  on every ship line, and the hub tool of the same name fills `dna` and `radius` from tools-core before forwarding.
- tools-core needs Node 22 (its better-sqlite3 binding; Node 24 is the default here). Start it with:
  `cd /mnt/a/github/carbonenginejs/tools-core && /root/.nvm/versions/node/v22.23.4/bin/node bin/cjs-tools-service.js --cache "$PWD/.cache/tool-core" --data "$PWD/data.local" --no-audio-auto-prepare --no-sde-auto-prepare`
  The clones moved to `/root/github/carbonenginejs` on 2026-10-21 (the old path is a symlink) without their
  `node_modules`, so that fails with "Cannot find package '@carbonenginejs/runtime'" until they are reinstalled. Until
  then, run the same command from `/mnt/a/github/_pre-wsl-move/carbonenginejs/tools-core` (same commit, deps intact)
  with `--cache`/`--data` pointing at `/root/github/carbonenginejs/tools-core/...`. Startup takes ~20 s.
- Headless Chromium in this WSL has no WebGPU adapter (Dawn finds SwiftShader but cannot create its context
  provider), so verify-page checks everything except drawing. Do not sink time into headless GPU. To see drawing,
  open the viewer in Windows Chrome yourself with the `chrome-devtools` MCP (the `windows-chrome` skill: it runs on
  the Windows side through interop, since WSL is in NAT mode; `setup.sh --check` diagnoses it), or ask the user to
  open http://127.0.0.1:5520/ in Windows Chrome or Edge; then use the `screenshot` and `page_log` tools.
- This is WSL on a 9p-mounted Windows drive: don't rename directories a running process uses as its working directory.
- The hub on 5520 is often owned by a Claude Code session's MCP server (`bin/scene-director.js mcp`). It streams the
  built viewer from disk on every request, so a page-only change needs a rebuild plus a tab reload (changing
  `environment.universe` makes a connected tab reload itself). Hub code changes need the owning session to reconnect
  its MCP server (`/mcp`). Page tools go to the newest connected tab, so a running verify-page takes them from the
  user's tab.

## Boundaries

- Upstream clones in `/mnt/a/github/carbonenginejs/` (runtime, tools-core, tools-blender, format-gr2) are read-only
  references. DO NOT EDIT THEM.
- `server` is the exception: it tracks the user's fork (`origin` = github.com/dereekb/carbon-engine-server, over SSH;
  `upstream` = carbonenginejs/server). Server changes this project needs go on its `scene-director` branch, pass its
  `npm test`, and are pushed to `origin`, never `upstream`. `dist/` is gitignored, so run `npm run build` there after
  a checkout, then `npm install` here (it is an install-links copy; see `serverPin` in package.json, pinned at
  `eadbdd1`). Fork `eadbdd1` moved the 29 `modelledOn` defines to `Modelled on:` JSDoc lines; upstream main still
  throws "Class donors and modelledOn are retired" against runtime f77ed790c.
- The runtime dependency is a copy of `../carbonenginejs/runtime/npm` (install-links, pinned at runtime commit
  f77ed790c; see `runtimePin` in package.json). Rebuild that checkout at the pinned commit before reinstalling.
- The viewer UI is a plain DOM overlay. dbx-web / dbx-components and Angular are acceptable when a feature
  genuinely needs them, but keep the viewer simple.
- EVE content is CCP's (see README); the code is MIT.
