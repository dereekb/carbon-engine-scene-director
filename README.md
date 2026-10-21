# carbon-engine-scene-director

Build EVE Online space scenes as JSON documents and watch them render live in
the browser, driven by Claude through MCP tools. Rendering is
[CarbonEngineJS](https://github.com/carbonenginejs/runtime)'s WebGPU renderer;
ship and environment data come from a local
[tools-core](https://github.com/carbonenginejs/tools-core) service.

**Phase 1** (this): scene documents, ships placed from SOF DNA, camera,
screenshots, saved scenes. Movement orders, combat and timelines are reserved
fields in the document and come in later phases.

```text
Claude Code ──stdio──▶ scene-director mcp (Node)
                          hub: http://127.0.0.1:5520  page + /resource proxy + /ws
                          scenes directory: saved cjs-scene/1 files
                            │ WebSocket
                            ▼
                       viewer tab (Chrome/Edge, WebGPU)
                         scene document ─▶ SOF ships ─▶ EveSpaceScene ─▶ canvas
                         IndexedDB: saved scenes and the working copy
                       tools-core :5510 ◀── every resource request
```

The page owns the scene. The hub serves it, proxies resources, routes tool
calls and keeps saved scene files on disk, so a page reload restores the
working scene from IndexedDB and Claude can reconnect at any time.

## Requirements

- Node 22+ for this project; tools-core needs Node 22 for its SQLite binding.
- A runtime build in `../carbonenginejs/runtime` (`npm run build:npm` there).
  It is copied into `node_modules` on install; see `runtimePin` in package.json.
- tools-core serving on 127.0.0.1:5510. In its checkout:
  `node bin/cjs-tools-service.js --no-audio-auto-prepare --no-sde-auto-prepare`
- Chrome or Edge with WebGPU, on a machine with a GPU. Under WSL2, open the
  viewer from Windows; localhost forwarding reaches the hub.

## Layout

An nx workspace:

| Project | Path | Builds | Holds |
|---|---|---|---|
| `scene` | `packages/scene` | `@nx/js:tsc` | the scene document schema, the tool list, and the ship stats math and its pilot context, shared by the hub and the page |
| `scene-director` | `apps/scene-director` | `@nx/esbuild` (node) | the hub, the MCP server, the CLI and `verify-page` |
| `viewer` | `apps/viewer` | `@nx/esbuild` (browser) | the page: renderer, director, ships, storage, hub link |

`bin/scene-director.js` launches the built CLI (`dist/apps/scene-director/main.js`).

## Run

```sh
npm install
npx nx build scene-director              # the scene library, the viewer page and the CLI
npx nx run scene-director:serve          # hub only, for using the page by hand
```

Open http://127.0.0.1:5520/. With nothing saved, it shows a welcome scene.

For Claude Code, `.mcp.json` registers the server for this directory (start
Claude Code here and approve it), or add it everywhere with:

```sh
claude mcp add scene-director -- node /mnt/a/github/carbon-engine-scene-director/bin/scene-director.js mcp
```

The MCP server starts the hub itself, or joins one already running on the port.

From a shell, any tool can be called against a running hub:

```sh
node bin/scene-director.js call get_state
node bin/scene-director.js call load_scene '{"scene":{"ships":[{"id":"a","dna":"af1_t1:amarrbase:amarr"}]}}'
node bin/scene-director.js call screenshot '{"maxWidth":960}' --out shot.png
```

## Tools

| Tool | Answered by | Does |
|---|---|---|
| `viewer_status` | hub | connected tabs, the URL to open, tools-core reachability |
| `page_log` | hub | the viewer's recent console output and errors |
| `search_hulls` | hub | SOF hull, faction or race names |
| `ship_stats` | hub | a hull's in-game mass, max velocity, agility, signature and align time, as published and as flown with every skill at V, optionally with a prop mod (see below) |
| `load_scene` | page | replaces the scene with a document |
| `get_scene` | page | the current document |
| `patch_scene` | page | edits by operation (add, update, remove, camera, environment, rename) |
| `save_scene` / `list_scenes` / `open_scene` / `delete_scene` | hub | saved scenes: files on disk, or the page's IndexedDB (see below) |
| `get_state` | page | renderer status, per-ship build status and placement, distances |
| `screenshot` | page | the next frame as a PNG |
| `frame_camera` | page | points the camera at a ship or fits all ships |

## Saved scenes

Saved scenes live in two stores, picked by each tool's `store` argument:

- `disk` (the default for saving): one `cjs-scene/1` JSON file per scene in
  the hub's scenes directory, validated on write and on read. Works with no
  viewer tab open.
- `browser`: the viewer tab's IndexedDB, as in phase 1. Needs a connected tab.

The stores are independent: nothing is written through from one to the
other. With `store` omitted:

| Tool | Does |
|---|---|
| `save_scene` | writes the viewer's current scene to disk; pass `scene` to save a document directly (no tab needed) |
| `list_scenes` | lists both stores, each entry marked `store: "disk"` or `"browser"` (the browser only when a tab is connected) |
| `open_scene` | looks on disk first, then in the browser; with no tab, a disk scene is returned (`loaded: false`) instead of shown |
| `delete_scene` | deletes the disk file when there is one, otherwise the browser's save |

The scenes directory is `--scenes <dir>` or `SCENE_DIRECTOR_SCENES`, by
default `scene-director/scenes` in the per-user data directory
(`$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support`
on macOS, `%LOCALAPPDATA%` on Windows). `viewer_status` reports it. It belongs
to the process that owns the hub: an MCP server that joins a running hub uses
that hub's directory. A `scenes/` folder in this checkout is gitignored, for
`--scenes ./scenes`.

A file is named from the scene's name, lowercased, with every run of
characters other than letters, digits, `_` and `-` turned into `-`
(`Duel at Jita` is `duel-at-jita.json`), so no name can reach outside the
directory. Names that differ only in case are the same scene. Saving a
different name that maps to a file holding another scene is refused rather
than overwriting it. A file placed in the directory by hand is listed and
opened by its file name.

Import and export go through `call`: `--in` reads a file into the `scene`
argument, and `--out` writes the scene a result carries to a file.

```sh
node bin/scene-director.js call save_scene '{"name":"duel"}' --in duel.json    # import a file to disk
node bin/scene-director.js call open_scene '{"name":"duel"}' --out duel.json   # export (also shows it, when a tab is open)
node bin/scene-director.js call get_scene --out current.json                   # the viewer's current scene
```

## Scene document

```json
{
  "schema": "cjs-scene/1",
  "name": "duel",
  "environment": { "universe": "res:/dx9/scene/universe/a01_cube.black" },
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 45 },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
```

Metres and degrees, Y up. `rotation` is `[yaw, pitch, roll]`. A `null` camera
target frames every ship; a `null` distance fits the target. Unknown fields are
reported as warnings and dropped. `orders` on a ship and a top-level `timeline`
are stored but not played yet.

A ship's flight numbers come from its EVE type (see Ship stats below). `type`
names it explicitly, as a type id or an exact English name; without it, the
DNA's `hull:faction:race` picks it. `stats` (`{ "mass": kg, "maxVelocity": m/s,
"agility", "signatureRadius": m }`, each optional) replaces the hull's published
values before the pilot's skills and a prop mod apply, so `{ "maxVelocity": 200 }`
flies at 250 m/s with the max-skills pilot; all four together pin the numbers
with no EVE data. `update_ship` replaces `stats` as a whole, and `null` clears
`type`, `stats` or `pilot`. `pilot` is reserved for the character system: stored,
not used yet.

Edits are diffed against the current document: a DNA change rebuilds that
ship, a placement change moves it in place, a `type`, `stats` or `pilot` change
retunes it (the diff's `retuned` list: new flight numbers, no rebuild), and an
environment change reloads the page (the scene's environment is initialized
with the device).

## Ship stats and the pilot

`packages/scene/src/lib/stats/` computes the numbers a ship flies by, with no
runtime imports: `computeShipStats({ hull, overrides, pilot, propMod })` returns
`mass`, `maxVelocity`, `agility`, `signatureRadius`, `radius` and `alignTime`
(`-ln(0.25) × mass × agility / 1e6` s). `mass`, `maxVelocity`, `agility` and
`radius` are exactly what a Destiny ball takes (`AddBall`, `SetBallMass`,
`SetMaxSpeed`, `SetBallAgility`); throttle is an order's concern.

- **The pilot** is a `PilotContext` (`{ name, skillLevel(skill) }`). Every ship
  flies with `MAX_SKILLS_PILOT` (every skill at V). `createPilotContext({ skills,
  defaultLevel })` takes `{ typeID, level }[]` or a Record by skill name or id, so
  a later character system plugs in without changing callers. There is no
  character system yet.
- **The skills** (checked against the SDE): Navigation +5 %/level max velocity;
  Evasive Maneuvering −5 % and Spaceship Command −2 %/level agility; Advanced
  Spaceship Command and Capital Ships −5 %/level agility on capital hulls (through
  their `advancedAgility` / `advancedCapitalAgility` hooks); Acceleration Control
  +5 %/level prop mod speed factor. Afterburner, High Speed Maneuvering, Fuel
  Conservation and Warp Drive Operation touch only capacitor and duration.
- **A prop mod** (MWD or AB, as the game applies it): mass += massAddition, then
  `maxVelocity × (1 + speedFactor × thrust / mass / 100)`, and an MWD's signature
  bloom. `HULL_SIZED_PROP_MODS` names the Tech II module for each hull size.
- **Not modelled:** hull trait bonuses, rigs, implants, boosters, fleet command
  bursts, heat, other modules, server tick rounding.

Base values come from tools-core's SDE at run time, through the hub: a ship
resolves to an EVE type by its `type` (a name goes through `dna/resolve`), or by
its DNA base in tools-core's DNA index (bare-hull matches, lowest type id; the
others are reported as `candidates`). `ship_stats` answers with the published
values, the max-skills stats and, with `propMod` (`"mwd"`, `"ab"` or a module
type id), the stats with it running. `GET /ship-stats?dna=&type=&propMod=` gives
the page the same JSON (404 unknown hull, 409 ambiguous name, 503 no SDE).
tools-core runs with `--no-sde-auto-prepare`, so the SDE build it reports
(`builds.sde` in `/eve/latest/build`) must be prepared once:
`node bin/cjs-sde-prepare.js --build <n>` in the tools-core checkout (Node 22).
A ship with all four `stats` needs no SDE.

## Development

```sh
npx nx run-many -t lint typecheck build test       # what the commit gate runs; tests are offline
npx nx run scene-director:verify-page              # the real page in headless Chromium against a running tools-core
npx oxfmt --write .                                # formatting
```

Headless Chromium usually has no WebGPU adapter, so `verify:page` checks
everything but drawing: SOF builds from real data, edits, storage and reload.

Drawing is checked in a real Chrome or Edge tab through `get_state`,
`screenshot` and `page_log`:

- `get_state.environment` reports the background: the nebula effect and each of
  its textures (state, format, cube), the scene dressing (below), and
  `backgroundQuad.drawn`, which grows each frame the nebula is drawn.
- `get_state.renderer.gpuErrors` counts WebGPU's uncaptured errors (validation,
  out-of-memory, internal), and each distinct message also goes to `page_log`.
- Page URL switches for A/B checks: `?post=off|<template>` (the sun environment
  template under `res:/dx9/postprocess/environmenttemplate/`, default
  `env_sun_yellow_01a`), `?flare=off|<name>` (under `res:/fisfx/lensflare/`,
  default `yellow`), `?aa=off` (no TAA) and `?tier=lo|hi` (the shader tier,
  default `depth`).

## Runtime notes

- `apps/viewer/src/lib/runtime.ts` is the single import point for the runtime,
  and `carbonenginejs-runtime.d.ts` beside it types those imports (the runtime
  ships no declarations). The WebGPU render context is internal to the runtime
  package and is reached through the `runtime-dist/` alias that
  `apps/viewer/esbuild.config.mjs` resolves.
- The bundle ignores the runtime's `sideEffects` list: many listed files
  register classes on import, and dropping them breaks Black reading.
- The scene is dressed the way the EVE client dresses every space scene
  (`apps/viewer/src/lib/environment.ts`): a sun environment template as the
  post process, with the client's tonemapping and dynamic exposure added when
  the template lacks them, plus the sun's lens flare. A universe file carries
  none of these, and without dynamic exposure the nebula (median texel about
  0.01 linear) renders at the level of the clear colour.
- Ships hold still through `StaticPosition`/`StaticRotation` curves
  (`apps/viewer/src/lib/ships.ts`); Destiny-driven balls replace them in the
  movement phase.

## EVE content

The code is MIT. EVE's content is not: using it means accepting CCP Games'
[EVE Online Content Creation Terms of Use](https://support.eveonline.com/hc/en-us/articles/8563917741084-EVE-Online-Content-Creation-Terms-of-Use).
Work made from EVE content must be non-commercial and carry CCP's disclaimer.
EVE Online and all related assets are the property of CCP hf. This project is
not affiliated with or endorsed by CCP Games or Fenris Creations.
