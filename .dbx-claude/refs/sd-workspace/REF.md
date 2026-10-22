# scene-director workspace: processes, layout, naming, pins

> The shape of the repo and the rules that span every subsystem. For a subsystem's own rules fetch its ref:
> `sd-scene-document`, `sd-destiny`, `sd-fleets`, `sd-staging`, `sd-ship-stats`, `sd-locations`, `sd-runtime`; for
> running and checking the thing, `sd-dev-env`.

## Who answers what

```text
Claude Code ──stdio──▶ scene-director mcp (Node)      apps/scene-director/src/lib/mcp/server.ts
                          hub: http://127.0.0.1:5520    apps/scene-director/src/lib/hub/hub.ts
                            │ WebSocket /ws
                            ▼
                       viewer tab (Chrome/Edge, WebGPU) apps/viewer/src/main.ts
                       tools-core :5510 ◀── every resource, SDE and map request (through the hub)
```

- **The page owns the scene.** The hub serves the page, proxies resources (`/resource/<path>`), routes tool calls and
  keeps saved files on disk. A reload restores the working scene from IndexedDB (`apps/viewer/src/lib/store.ts`).
- **`where: 'hub' | 'page'`** on each entry of `packages/scene/src/lib/tools.ts` (the one tool list, advertised by the
  MCP server and implemented by the page) says who answers. Hub tools work with no tab open; page tools are forwarded
  to the **newest** connected tab (so a running verify-page takes them from the user's tab).
- **Hub tools that edit the scene** (`set_location`, `add_fleet_composition`, `add_ships`, `stage_engagement`) resolve
  names against tools-core first, then forward **one pure patch op** to the tab, or apply it to a passed `scene`
  (no tab; result returned with `loaded: false`).
- **One hub per port.** `scene-director mcp` starts the hub or, when 5520 is taken, joins it through `RemoteHub`
  (`hub/remote-hub.ts`, same `Call` surface as `Hub`; `hub/tool-call.ts`). A joined hub keeps the owner's scenes and
  fleets directories.
- **HTTP routes** (`hub.ts`): `/build`, `/resfileindex.txt`, `/resource/<path>`, `/ship-stats`, `/prop-mod`,
  `/audio/library`, `/audio/path/<encoded res:/ path>` (streams, forwards `Range`), `/map/system`, `/ws`.

## Layout

| Project | Path | Build | Holds |
|---|---|---|---|
| `scene` (`@scene-director/scene`) | `packages/scene` | `@nx/js:tsc` | the `cjs-scene/1` schema, patch ops, diff, tool list, stats, fleets, compositions, location, staging, orders, prop mods. **No runtime imports**: hub, page and tests share it |
| `scene-director` | `apps/scene-director` | `@nx/esbuild` (node) | hub, MCP server, CLI (`serve`, `mcp`, `call`), `verify-page.ts`. Building it builds the viewer (implicit dependency) |
| `viewer` | `apps/viewer` | `@nx/esbuild` (browser) | the page: engine, director, ships, Destiny world, clock, camera, following, location dressing, audio. Has a node `test` target |

`bin/scene-director.js` launches `dist/apps/scene-director/main.js`; `.mcp.json` points at it.

`packages/scene/src/lib/` by folder: `scene.ts` (document + `applySceneOperations` + diff), `tools.ts`, `orders.ts`
(`order_ship` requests), `json.ts` (shared readers), `stats/`, `prop-mods/`, `fleets/`, `compositions/`, `location/`,
`staging/`.

## Naming (house style is split on purpose)

- **Apps** (`apps/scene-director`, `apps/viewer`) follow the CarbonEngineJS runtime's style: PascalCase functions and
  methods (`Hub.Start`, `DestinyWorld.Order`, `ReadNumber`, `MakeFakeShipData`), dbx verb prefixes in that case
  (`IsShipResource`); camelCase properties, parameters, locals; PascalCase types; UPPER_SNAKE exported constants.
- **`packages/scene`** is camelCase (`toFleetMemberships`, `computeShipStats`).
- **Match the file you are in.** Ignore dbx tooling that asks for camelCase app functions: the sweep was stowed on
  2026-10-21 (queue note `naming-camelcase-for-our-code-carbon-names-only-where-the-runtime-calls-them`).
- **Never rename a name the runtime calls**: `override`s of runtime members (`BallRotation.Update__Ticks`) and members
  of object literals typed by a `carbonenginejs-*.d.ts` interface (`BlueResourceSource.Read`, `BatchCollector.Collect`).
  Such a method extends a runtime class or implements a `.d.ts` interface first, so a wrong rename fails to compile.

## Commands

| Do | With |
|---|---|
| build (scene + viewer + CLI) | `dbx-claude-build` `project: scene-director` (or `npx nx build scene-director`) |
| tests | `dbx-claude-test` `project: scene` / `viewer` / `scene-director`. The MCP spec spawns the built CLI, so `test` depends on `build` |
| lint | `dbx-claude-lint-run`. Config is the dbx library config (`eslint.config.library.mjs`); warnings allowed, errors block |
| format | `npx oxfmt --write .` |
| commit | `dbx-claude-commit` (gates lint, build, typecheck, affected tests) |
| a tool from a shell | `node bin/scene-director.js call <tool> '<json>' [--in f.json] [--out f.json]` against a running hub |

## Rules every change keeps

- **The MCP process writes nothing to stdout but MCP protocol messages**; the hub logs to stderr.
- **Tests never touch per-user data dirs.** Specs and verify-page pass a temp `SceneFileStore` /
  `FleetCompositionFileStore`. tools-core is faked with `hub/ship-data.testing.ts` and `hub/map-data.testing.ts`
  (shapes captured live against SDE build 3632936); tests run offline.
- **Node-tested viewer modules import `./runtime-sim`, never `./runtime`** (type-only imports are fine). See
  `sd-runtime`.
- **The viewer UI is a plain DOM overlay.** dbx-web / Angular only when a feature genuinely needs them.
- **EVE content is CCP's** (README, "EVE content"); the code is MIT.

## Where docs go

| Kind of content | Goes in |
|---|---|
| what the project is, what works, how to run it, the tools at a glance | `README.md`: a line in "What works today" and a row in the tools table, nothing more |
| a subsystem's behavior, rules, gotchas, file map, examples, real-GPU findings | the area's `sd-*` ref (`.dbx-claude/refs/<name>/REF.md`, or a `references/<doc>.md` sub-doc when it grows) |
| a new area | a new `sd-*` ref, declared with triggers in `.dbx-claude/dbx-claude.json` `references.project`, plus a row in the README's Documentation table and the CLAUDE.md index |
| a rule every subsystem must know before any ref fires | `CLAUDE.md` (rarely; it loads into every session) |
| a tool's arguments | its MCP schema in `packages/scene/src/lib/tools.ts` |

Update the ref in the same commit as the behavior change. `refImpact` holds a `feat` / `fix` commit until the session
declares which refs it made stale (`dbx-claude-log` `refImpact`, `[]` when none).

## Dependency pins and boundaries

- `@carbonenginejs/runtime` is an install-links copy of `../carbonenginejs/runtime/npm`, pinned at runtime commit
  `f77ed790c` (`runtimePin` in package.json). Rebuild that checkout at the pin before reinstalling.
- **The runtime's `package-lock.json` entry MUST keep `"resolved": "file:../carbonenginejs/runtime/npm"`.** Without it
  npm installs the published `0.1.0-alpha.11`, an older build without the `modelledOn` retirement (`CjsSchema.js` md5
  `240e178d…` instead of runtime/npm's `ed288d32…`). Check the md5 after any reinstall.
- `@carbonenginejs/server` (Destiny) is an install-links copy of `../carbonenginejs/server`, the user's fork
  (`origin` = github.com/dereekb/carbon-engine-server; `upstream` = carbonenginejs/server), branch `scene-director`,
  pinned at `eadbdd1` (`serverPin`). Fork `eadbdd1` moved the 29 `modelledOn` defines to `Modelled on:` JSDoc lines;
  upstream main still throws "Class donors and modelledOn are retired" against runtime f77ed790c. Server changes go
  on its `scene-director` branch, pass its `npm test`, and push to `origin`, never `upstream`. `dist/` is gitignored:
  `npm run build` there after a checkout, then `npm install` here. `npm ls @carbonenginejs/runtime` must show
  `deduped` under the server.
- **The other upstream clones** (`runtime`, `tools-core`, `tools-blender`, `format-gr2`) are read-only references.
  Do not edit them.
