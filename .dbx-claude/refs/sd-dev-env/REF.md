# scene-director dev environment: tools-core, the hub, checking the page

> How to run the stack and how to check a change: tools-core, the SDE, the hub on 5520, verify-page, and the real-GPU
> check. **The tools-core paths below are the WSL dev box's** (where the game data and tools-core live). A machine
> with only the two forks (see "A second machine" below) can install, build and run the offline tests, but nothing
> that needs tools-core or a GPU.

## A second machine (forks only, no game data)

Set up and verified on a Mac on 2026-10-22: install, `nx build scene-director` and every project's tests pass
(scene 252, viewer 136, scene-director 97) with no tracked file changed.

- Clone the forks as `carbon-engine-runtime` (github.com/dereekb/carbon-engine-runtime) and `carbon-engine-server`
  (github.com/dereekb/carbon-engine-server) beside this repo, then link them where package.json looks:
  `carbonenginejs/runtime -> ../carbon-engine-runtime` and `carbonenginejs/server -> ../carbon-engine-server`
  (relative symlinks). **Don't edit package.json or the lockfile to point at the fork names**: the
  `"resolved": "file:../carbonenginejs/..."` entries must stay (`sd-workspace`).
- Runtime: check out the `runtimePin` commit, `npm install`, `npm run build:npm` (makes `npm/`).
- Server: check out branch `scene-director` at the `serverPin` commit, then
  **`npm install --install-links --prefix <parent>/carbonenginejs/server`**, then `npm run build`. A plain
  `npm install` inside the fork resolves its own `file:../runtime/npm` from the real dir name (`carbon-engine-server`),
  links a missing dir and rewrites the server's lockfile.
- `npm install` in either fork may rewrite its lockfile cosmetically: `git checkout` it back.
- Then `npm install` here, and check `npm ls @carbonenginejs/runtime` (deduped under the server) and the `CjsSchema.js`
  md5 (`sd-workspace`).
- Node 24 works for install, build and tests (only tools-core needs Node 22).
- Without tools-core, run in **no-EVE-data mode** (below). Mac Chrome has WebGPU, so tools-core on the Mac would draw
  everything; it downloads EVE's files itself and never reads an installed client (not tried here yet).

## No-EVE-data mode

For a machine without tools-core (UI, camera and cinema work): the hub and the page ask for no EVE file or lookup, and
the simulation, orders, the camera, cinema, screenshots and exports run on a green screen with a cube per ship and
object (team colours, the nose face pale; `sd-runtime` → Stand-ins). Missing: hull models, real stats and fits (so no
default guns and no combat), locations, audio.

- **Turning it on**: `--eve-data off` or `SCENE_DIRECTOR_EVE_DATA=off` (default `tools-core`; another value exits 2 on
  stderr). The stdio MCP server inherits Claude Code's environment, so on a no-EVE machine **export the variable in the
  shell profile Claude Code starts from** instead of editing `.mcp.json`, and check once with `viewer_status`
  (`eveData.mode`). By hand: `npx nx run scene-director:serve --eve-data off` (`serve` forwards its args; `Option` also
  takes `--eve-data=off`). The hub then never touches tools-core and ignores `--tools-core` (`sd-workspace` → Who
  answers what).
- **What the page learns, and when**: it reads `GET /config` (`{ eveData }`) before it configures resources or creates
  the engine (a failure or timeout means EVE data on, with one warning). `?eve=off` turns the mode on for one tab; it is
  one way (`from: url`) and never turns EVE data on against an `off` hub. The hello reply carries the hub's mode too: a
  tab whose mode came from the hub reloads once when it reconnects to a hub in the other mode.
- **Statuses**: ships and objects `stand-in` (cubes, class flight numbers); asteroid fields, the location, the dressing,
  the nebula and audio `off`, each with the mode's note.
- **Reports**: `viewer_status.eveData { mode, note? }` (`toolsCore` null), a HUD "EVE data" row, and
  `get_state.eveData { mode, from, note, refused, expected }`. `refused` counts EVE files `ResourceBytes` turned away
  for a page path (**0 expected**; more means a path still asks); `expected` counts the runtime's own construction cost
  (9: a new `EveSpaceScene` asks for its volumetric fog effects, refused as expected through `ExpectRefusals`).
- **Refuses, naming the mode**: `search_hulls`, `search_map`, `get_system`, `set_location`, `search_objects`,
  `ship_stats` without all four stats, and `add_ships` / `add_objects` / `add_asteroid_field` by EVE name. The hub's
  `/resource`, `/audio`, `/build`, `/ship-stats`, `/prop-mod` and fit routes answer 503.
- **Still works**: `dna` lines, the built-in `tfis`, objects by `dna`, `ship_stats` with all four stats, orders, the
  timeline, cinema, screenshots and `export_movie`.
- **verify-page `--eve-data off`** starts its own hub in the mode, needs no tools-core and runs only the "no EVE data:"
  checks (statuses, refusals, zero EVE requests in Playwright's request log, a quiet `page_log`). On this Mac the
  Playwright headless shell is `chromium_headless_shell-1234`: it has a WebGPU adapter but loses its device on the first
  stand-in pass, so the run reports those errors as info and skips the screenshot. Check drawing in a real Chrome tab.
- **Mac Chrome findings (2026-10-24, Apple Metal)**: 60 fps; a green screen with team cubes; an orbit drag and the hero
  shot track without the runtime frame; a 2 s 640×360 `export_movie` holds the cubes; the tab requests only `/`,
  `/app/main.js` and `/config`; `refused` 0. Exactly one reload per hub mode change, once `Hub.Stop` closed keep-alive
  connections: before that a restarted hub's old connection kept answering `/config` and the reload looped.

## What needs what

| Want | Needs |
|---|---|
| offline tests (`dbx-claude-test`) | `node_modules` (runtime + server install-links copies built at their pins, see `sd-workspace` and "A second machine") |
| build | the same |
| page draws ships | tools-core on `127.0.0.1:5510` (every resource goes through the hub's `/resource` proxy to it); without it, a green screen and a stand-in cube per ship and object (below) |
| UI, camera and cinema work with no tools-core | no-EVE-data mode: `--eve-data off` / `SCENE_DIRECTOR_EVE_DATA=off` ("No-EVE-data mode" above) |
| `ship_stats`, `/ship-stats`, SDE radii, hull names, `add_fleet_composition` without inline dna | a **prepared** SDE in tools-core |
| locations (`search_map`, `get_system`, `set_location`, dressing) | tools-core's map routes over the SDE (a healthy map index) |
| sounds (prop mods, modules, turrets) | tools-core's audio library, a user gesture in the tab (or autoplay allowed) |
| drawing (anything visual) | a real GPU: Windows Chrome / Edge |

A ship with all four `stats` and every composition line with `dna` + `radius` (the TFIs example does) needs no SDE.

## tools-core

- **Node 22** (its better-sqlite3 binding; Node 24 is the box's default). Startup takes ~20 s:
  `cd /mnt/a/github/carbonenginejs/tools-core && /root/.nvm/versions/node/v22.23.4/bin/node bin/cjs-tools-service.js --cache "$PWD/.cache/tool-core" --data "$PWD/data.local" --no-audio-auto-prepare --no-sde-auto-prepare`
- The clones moved to `/root/github/carbonenginejs` on 2026-10-21 (the old path is a symlink) **without their
  `node_modules`**, so that fails with "Cannot find package '@carbonenginejs/runtime'" until reinstalled. Until then run
  the same command from `/mnt/a/github/_pre-wsl-move/carbonenginejs/tools-core` (same commit, deps intact) with
  `--cache` / `--data` pointing at `/root/github/carbonenginejs/tools-core/...`.
- **SDE.** tools-core runs with `--no-sde-auto-prepare` and answers only for the exact `builds.sde` it reports
  (`/eve/latest/build`). Prepare it once: `node bin/cjs-sde-prepare.js --build <n> --cache <its cache>` (Node 22, about
  a minute). The specs' fixtures are SDE build 3632936.
- **Audio library.** tools-core also runs with `--no-audio-auto-prepare`, so when EVE's build moves (a TQ update) the
  page's audio fails with "the hub's /audio/library answered 404: … not prepared for eve build <n>" until it is
  prepared: `node bin/cjs-tools-prefetch.js audio --build <n> --cache <its cache>` (Node 22; ~4 min and ~3.5 GB for
  3646012 on 2026-10-23). A hub reads the build once at its start, so one started before the move keeps asking for the
  old build's library (and keeps working) until restarted.
- **Degraded map index** (`GET map` → `index.degraded`, no `mapIndex` derivation): systems are found but stations on
  moons are named after their planet. Fix: `node bin/cjs-sde-prepare.js --build <n> --refresh` in tools-core.
- tools-core quirks the hub works around are in `sd-locations` (map) and `sd-ship-stats` (`dna/resolve`).

## The hub on 5520

- Often owned by **a Claude Code session's MCP server** (`bin/scene-director.js mcp`); another `mcp` joins it
  (`RemoteHub`). Hand-run: `npx nx run scene-director:serve`, then open http://127.0.0.1:5520/.
- **`--eve-data tools-core|off`** (`SCENE_DIRECTOR_EVE_DATA`): `off` is no-EVE-data mode (above); the page reads it from
  `/config`.
- It streams the built viewer from disk on every request: **a page-only change needs a rebuild plus a tab reload**
  (changing `environment.universe` makes a connected tab reload itself).
- **A hub code change needs the owning session to reconnect its MCP server** (`/mcp`).
- Page tools go to the newest tab connected to that hub. verify-page starts its own hub on a free port
  (`new Hub({ port: 0 })`), so running it never takes page tools from a tab on 5520.
- **The battle console** (`sd-console`) is served at `/console/` from `--console <dir>` / `SCENE_DIRECTOR_CONSOLE`, by
  default `dist/apps/battle-console/browser` beside the CLI bundle when it exists. Build it with `dbx-claude-build`
  `project: battle-console` (it builds the engine bundle first; building `scene-director` does not build the console),
  then reload `http://127.0.0.1:5520/console/`. A console tab is a page like the viewer: page tools go to the newest
  tab of either. To try it without disturbing a session's hub, serve one on a spare port with temp stores:
  `node dist/apps/scene-director/main.js serve --port 5531 --eve-data off --console dist/apps/battle-console/browser
  --scenes <tmp> --fleets <tmp> --personalities <tmp> --movies <tmp>`.
- **Audio cache**: ranged `/audio/path` reads come from local copies of tools-core's banks, downloaded whole on first
  use (`--audio-cache <dir>` / `SCENE_DIRECTOR_AUDIO_CACHE`, default `scene-director-audio-cache` in the OS temp dir,
  ~372 MB for `turrets.bnk`; shared by every hub, verify-page included; build-keyed, safe to delete). Without it each
  range costs tools-core a whole-file read (`sd-runtime` → Audio). The proxy uses `pipeline`: an upstream body cut
  short (a tab reloading mid-read) once crashed the hub on an unhandled stream error.
- **Movies directory** (`export_movie`, `sd-export`): `--movies <dir>` / `SCENE_DIRECTOR_MOVIES`, default
  `scene-director/movies` in the per-user data directory (`~/.local/share/scene-director/movies` here); tests,
  verify-page and GPU checks use temp ones. Open an export in Chrome at `http://127.0.0.1:<port>/movies/<file>` (the
  status's `url`; Range-served, so seeking works), or from Windows Explorer at the status's `windowsPath`
  (`\\wsl.localhost\<distro>\…`). There is **no ffmpeg or ffprobe** on dbxpc: read a file with
  `hub/mp4-reader.testing.ts` (`ReadMp4`), as the specs and verify-page do.
- WSL on a 9p-mounted Windows drive: don't rename directories a running process uses as its working directory.

## verify-page (everything but drawing)

`npx nx run scene-director:verify-page` (`apps/scene-director/src/verify-page.ts`) drives the real page in headless
Chromium through the hub's tools, against a running tools-core: boot, the hub link, SOF builds from real EVE data,
edits, storage and reload, prop mod audio events (launched with `--autoplay-policy=no-user-gesture-required`; it sees
events posted, it cannot hear them). It uses temp file stores. `--only <text>` runs the checks whose label contains the
text (`a|b` for either), each loading its own scene.

The full suite is ~180 checks and ~40 min (2026-10-24), and prints its results only at its end: run it as `--only`
batches of contiguous labels, never alongside the test suites, with a runner limit generous enough that a slow batch
(weapons and combat: ~400 s for a dozen) is not killed with its results. A few checks build on the one before (the
compositions check expects the TFIs check's `tfis`), so cut batches at group starts. The M6 runner and its label list
are `.scratch/movie-gpu/batch.mjs` / `chain.sh` on dbxpc (`sd-timeline` doc `movie`, the M6 evidence).

**Headless Chromium in this WSL has no WebGPU adapter** (Dawn finds SwiftShader but cannot create its context
provider). Do not sink time into headless GPU.

## Checking drawing (real GPU)

- Drive Windows Chrome yourself through the `chrome-devtools` MCP: the project skill `windows-chrome` (it runs on the
  Windows side through interop since WSL is in NAT mode; `setup.sh --check` diagnoses it). Claude in Chrome does not
  work in WSL. Or ask the user to open http://127.0.0.1:5520/ in Windows Chrome or Edge.
- Then: `screenshot` (next frame as PNG), `page_log` (console + errors), `get_state`.
- `get_state.renderer.gpuErrors` counts WebGPU uncaptured errors; each distinct message also reaches `page_log`, but
  **only through `engine.ts`'s `uncapturederror` listener** (Chrome otherwise prints them to DevTools alone).
- `get_state.environment`: the nebula effect and its textures, the dressing, `backgroundQuad.drawn` (grows each frame
  the nebula draws), `dressing.fog`.
- Booster LOD goes by the booster sphere's pixel size: a Slasher's flames vanish beyond ~600 m on a 900 px canvas.
  Dark boosters in a far shot are LOD, not the drive (distances in the windows-chrome skill).

### Page URL switches (A/B)

| Switch | Does |
|---|---|
| `?post=off\|<template>` | the sun environment post process (`res:/dx9/postprocess/environmenttemplate/`); default the location star's, else `env_sun_yellow_01a` |
| `?flare=off\|<name>` | lens flare under `res:/fisfx/lensflare/`; default the star's, else `yellow` |
| `?dress=off\|all\|<nebula,sun,planets,objects>` | the location dressing's parts |
| `?aa=off` | no TAA |
| `?anim=real` | keeps the runtime's real-time frame clock: its shaders' `Time`, controllers, booster flicker and blinking lights then animate on real time, including while paused (the A/B for the animation clock, `sd-time`) |
| `?fog=on` | keep the template's distance fog (dropped by default: it fogs planets as background, washes the frame, and a far camera sees a glowing disc) |
| `?tier=lo\|hi` | shader tier (default `depth`) |
| `?audio=off` | no audio |
| `?turretlod=on` | the runtime's own turret LOD (default: every turret set frozen at high detail, `sd-weapons`) |
| `?eve=off` | no-EVE-data mode for this tab only (`get_state.eveData.from: url`); one way: never turns EVE data on against an `off` hub |
| `?fields=off\|shadow` | asteroid fields: `off` draws none (status `off`), `shadow` lets rocks cast shadows (default off, `sd-asteroid-fields`) |

## Real-GPU findings are dated evidence

The refs' "Real-GPU evidence" sections (Windows Chrome, NVIDIA, 2026-10-21/22) are measurements, not specs: turn
smoothness and orbit/keep-at-range ranges (`sd-destiny`), booster looks (`boosters`), formation holding (`sd-fleets`),
TFIs build time and fps (`compositions`), audio on/off fps (`sd-ship-stats`). Re-measure before relying on one after a change in that area, and update the
section with the new date. New findings go in the area's ref, never the README.
