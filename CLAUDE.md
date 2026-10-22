# carbon-engine-scene-director

Drives CarbonEngineJS (the open-source JS port of EVE Online's engine) space scenes from JSON scene documents
over MCP tools, rendered live in a browser tab. README.md is the overview: what works, the architecture, how to run
it, the tools at a glance.

**Do not grow this file or the README.** This file is loaded into every session, so subsystem detail belongs in a
project reference (below); a rule goes here only when it spans every subsystem or must be known before any ref would
fire. The README is for people landing on the repo: a new feature gets a line in its "What works today" list and its
tools table, and nothing more. Behavior, rules, gotchas, measurements and real-GPU findings go in the area's ref.

## Layout (nx workspace)

- `packages/scene` (`@scene-director/scene`, `@nx/js:tsc`, camelCase): the `cjs-scene/1` document (validation, patch
  ops, diff), the shared tool list, stats, prop mods, fleets, compositions, location, staging, orders. **No runtime
  imports**: the hub, the page and the tests all use it.
- `apps/scene-director` (`@nx/esbuild`, node): the hub (HTTP + WebSocket on 127.0.0.1:5520), the stdio MCP server, the
  CLI (`serve`, `mcp`, `call`) and `verify-page.ts`. Building it builds the viewer too.
- `apps/viewer` (`@nx/esbuild`, browser): the page. `src/lib/runtime.ts` is the single runtime import point.
- `bin/scene-director.js` launches `dist/apps/scene-director/main.js`; `.mcp.json` points at it.

## Project references

Subsystem rules, gotchas and file maps live in project refs under `.dbx-claude/refs/<name>/REF.md`. Fetch one by name
with the `dbx-claude-ref` tool (sub-docs with `doc`); `reference-hint` suggests the right one from your prompt, the
files you touch and the scene-director tools you call. Fetch before designing or changing anything in that area:

- `sd-workspace`: hub vs page (`where`), layout, naming house style, dependency pins and boundaries
- `sd-dev-env`: tools-core and the SDE, the hub on 5520, verify-page, real-GPU checks, setting up a second machine
- `sd-runtime`: the runtime import point, `.d.ts` typing, esbuild guards, runtime API drift, the client's dressing
- `sd-scene-document`: `cjs-scene/1`, patch ops, the diff and what the page does with it, camera, saved scenes
- `sd-destiny`: the two Destiny parks, the clock and loop, orders, placement, physics (docs: `warp`, `boosters`)
- `sd-fleets`: fleets, anchors, the formation, Follow the FC (docs: `orders`, `order_fleet` and fleet warp;
  `compositions`, the `cjs-fleet/1` format and TFIs)
- `sd-staging`: `add_ships` and `stage_engagement`
- `sd-ship-stats`: stats math, skills, the pilot, prop mods, engine audio
- `sd-locations`: the document's location, tools-core map quirks, name resolution (doc: `dressing`)

When a change alters behavior a ref describes, update the ref in the same commit (a new area gets a new `sd-*` ref,
declared with its triggers in `.dbx-claude/dbx-claude.json` `references.project`, and a row in the README's
Documentation table). `refImpact` is on: a
`feat` or `fix` commit waits until the session declares its ref impact (`dbx-claude-log` `refImpact`, `[]` if none).

## Commands

- Build: `dbx-claude-build` `project: scene-director` (scene, viewer and the CLI). Serve the hub by hand:
  `npx nx run scene-director:serve`.
- Tests: `dbx-claude-test` (`project: scene` / `viewer` / `scene-director`). Offline; the MCP spec spawns the built CLI.
- Real-page check: `npx nx run scene-director:verify-page` against a running tools-core (everything but drawing).
- Commit through `dbx-claude-commit`. Format: `npx oxfmt --write .`. Lint errors block, warnings don't.

## Naming

The apps keep the CarbonEngineJS runtime's house style on purpose: PascalCase functions and methods (`Hub.Start`,
`DestinyWorld.Order`), camelCase properties and locals, PascalCase types, UPPER_SNAKE exported constants.
`packages/scene` is camelCase. Match the file you are in, and ignore dbx tooling that asks for camelCase app functions.
Never rename a name the runtime calls (overrides of runtime members, members of objects typed by a
`carbonenginejs-*.d.ts` interface). Details: `sd-workspace`.

## Rules that span everything

- The MCP process writes nothing to stdout but MCP protocol messages; the hub logs to stderr.
- Node-tested viewer modules import `./runtime-sim`, never `./runtime` (type-only imports are fine).
- Only `DestinyWorld` touches the Destiny parks, and every change goes to both in one call (`sd-destiny`).
- `applySceneOperations` stays synchronous and pure (it runs in the page); hub tools resolve tools-core data first.
- Never hand system or galactic coordinates to the renderer: the page sees only origin-relative metres.
- Tests and verify-page use temp file stores; never write to the default per-user scenes or fleets directories.
- The runtime's `package-lock.json` entry keeps `"resolved": "file:../carbonenginejs/runtime/npm"` (`sd-workspace`).
- Headless Chromium here has no WebGPU adapter: verify-page checks everything but drawing. Do not sink time into
  headless GPU; check drawing in a real Chrome tab (`sd-dev-env`, the `windows-chrome` skill).

## Boundaries

- Upstream clones in `../carbonenginejs/` (runtime, tools-core, tools-blender, format-gr2) are read-only references.
  DO NOT EDIT THEM.
- `server` is the exception: the user's fork (`origin` = github.com/dereekb/carbon-engine-server; `upstream` =
  carbonenginejs/server). Changes go on its `scene-director` branch, pass its `npm test`, and are pushed to `origin`,
  never `upstream`. Pins and reinstall steps: `sd-workspace`, `sd-dev-env`.
- The viewer UI is a plain DOM overlay; dbx-web / Angular only when a feature genuinely needs them.
- EVE content is CCP's (see README); the code is MIT.
