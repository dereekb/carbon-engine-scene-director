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
object (team colours, the nose face pale; `sd-runtime` → Stand-ins). Missing: hull models, real stats and fits,
locations, audio. Every ship carries stand-in guns, HP and targeting by class instead, so fights lock, shoot and kill
(`sd-combat` → Stand-in combat; `ships[].standIn.class`, a cruiser otherwise).

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
  checks (statuses, refusals, zero EVE requests in Playwright's request log, a quiet `page_log`; stand-in combat: guns,
  lock and kill, the same kill for a seed and another for another seed, a lent call that comes back after a kill, two
  loads with equal kills at rate 4 with the call moving on and a red FC handover, a jump back that replays the kill,
  tracers headed only). The brain checks run every ship `immune`: the guns fire now. On this Mac the
  Playwright headless shell is `chromium_headless_shell-1234`: it has a WebGPU adapter but loses its device on the first
  stand-in pass, so the run reports those errors as info and skips the screenshot. Check drawing in a real Chrome tab.
- **Mac Chrome findings (2026-10-24, Apple Metal)**: 60 fps; a green screen with team cubes; an orbit drag and the hero
  shot track without the runtime frame; a 2 s 640×360 `export_movie` holds the cubes; the tab requests only `/`,
  `/app/main.js` and `/config`; `refused` 0. Exactly one reload per hub mode change, once `Hub.Stop` closed keep-alive
  connections: before that a restarted hub's old connection kept answering `/config` and the reload looped.
- **Mac Chrome stand-in combat (2026-10-24, Apple Metal-3, a spare `--eve-data off` hub on 5531 with temp stores)**: a
  3v3 frigate fight at 60 fps with `gpuErrors` 0; `renderer.standIns.tracers` 18 then 6 in sampled frames (each
  volley's guns cycle together, so tracers come in 0.25 s bursts); dead cubes pop and leave `cubes`; `refused` 0. A
  background or unfocused Chrome window throttles the tab to 0 fps, so the scene clock (and tracers) stall until it is
  in front; drive it with the window visible.

## What needs what

| Want | Needs |
|---|---|
| offline tests (`dbx-claude-test`) | `node_modules` (runtime + server install-links copies built at their pins, see `sd-workspace` and "A second machine") |
| build | the same |
| page draws ships | tools-core on `127.0.0.1:5510` (every resource goes through the hub's `/resource` proxy to it), or another machine's through its hub ("Another machine's EVE data" below); without it, a green screen and a stand-in cube per ship and object (below) |
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

## Other devices on the LAN over HTTPS (an iPad)

WebGPU and WebCodecs exist only in a secure context. A page from `http://<lan address>:5520` is not one, so
`Engine.Create` fails there, and iOS Safari can't be told to treat it as secure. The hub can serve a second, HTTPS
listener for other devices (`hub/https.ts`). The loopback HTTP listener, MCP sessions, `RemoteHub`, `call` and
verify-page are unchanged. No Tailscale, proxy or Docker is involved. The assessment behind this is
`~/.claude/plans/would-it-be-possible-majestic-bear.md`.

- **Files**: `scene-director https-cert` (`hub/https-cert.ts`, the `openssl` command; LibreSSL on macOS works) writes
  them to `--https-dir <dir>` / `SCENE_DIRECTOR_HTTPS_DIR`, by default `scene-director/https` in the per-user data
  directory (`~/Library/Application Support/scene-director/https` on the Mac):
  - `ca.crt` / `ca.key`: the CA a device trusts once. It is name-constrained to `.local`, localhost and the private
    IPv4 ranges: its key can sign nothing else a device would trust.
    - **The shared CA is committed**, at `apps/scene-director/https/ca.crt`. The build copies it beside the CLI. It
      is "scene-director dev CA (Michelles-MacBook-Air.local)", made on the Mac on 2026-10-24 and trusted on the
      iPad, and every machine signs with it.
    - **Its `ca.key` is never committed**: the repo is public, and the key would let anyone mint certificates the
      iPad trusts on any LAN. Copy it by hand into a machine's HTTPS directory, chmod 600. The Mac has it.
    - `https-cert` refuses when the key is missing or belongs to another CA, and never quietly makes a CA beside the
      shared one.
    - `--https-ca <file>|none` / `SCENE_DIRECTOR_HTTPS_CA` picks another CA file. `none` makes a local CA once and
      keeps it.
  - `cert.pem` / `key.pem`: made again each run, for `localhost`, `<host>.local`, 127.0.0.1 and the private LAN
    addresses. It follows Apple's rules (RSA 2048, SHA-256, names in the SAN, serverAuth, 800 days, under 825).
    Run it again when the LAN address changes. `<host>.local` keeps working without that, since the iPad resolves it
    over mDNS.
  - `token`: the access token, made once and kept.

  Keys and token are 0600. Never copy them into the repo; dbx-components' nginx certs are committed, these are not.
- **Serve**: `--https-port <n>` / `SCENE_DIRECTOR_HTTPS_PORT` (5521 by convention; no listener by default) on
  `--https-host` / `SCENE_DIRECTOR_HTTPS_HOST` (default `0.0.0.0`). If the files are missing, the hub exits 2 and
  names `https-cert`. If the port is taken, the hub stops and throws without an EADDRINUSE code, so an `mcp` start
  never mistakes it for the HTTP port and joins. For the hub an MCP session starts, export the variable in the shell
  profile Claude Code starts from, as with `SCENE_DIRECTOR_EVE_DATA`. To try it beside a session's hub, use a spare
  HTTP port with temp stores: `node dist/apps/scene-director/main.js serve --port 5532 --https-port 5521 --eve-data
  off --scenes <tmp> ...`, then drive it with `call <tool> --port 5532`.
- **Access**: every request needs the token. Open `/?token=…` once; the hub answers with a cookie
  (`scene_director_token`: Secure, HttpOnly, SameSite=Lax, 400 days) and a 302 to the same URL without the token.
  After that the cookie carries every route and the `/ws` upgrade. An upgrade also needs the listener's own Origin
  when the client sends one. Anything else gets a 401. `/ca.crt` (the CA, DER) is the one path served without the
  token. The hub prints the links on stderr; `viewer_status.https` gives `urls`, `links` (with the token) and `ca`.
  A cookie belongs to the host it was set on: the `.local` name and the IP each need the link once.
- **Trust on an iPad**: in Safari open `https://<host>.local:5521/ca.crt` (accept the warning this once) and allow
  the profile, or AirDrop `ca.crt`. Then Settings → General → VPN & Device Management → install it. Then Settings →
  General → About → Certificate Trust Settings → full trust for "scene-director dev CA (<host>.local)". Then open the
  link with the token.
- **dbxpc** (where the EVE data is; serving on 5521 at Windows' 10.0.0.58 since 2026-10-24). WSL2 is in NAT mode, so the LAN can't reach a hub inside WSL,
  and WSL can't see Windows' LAN address.
  1. Copy `ca.key`, and `token` to keep the same access token, from the Mac to `~/.local/share/scene-director/https/`
     and `chmod 600` them. `https-cert` keeps a token it finds. The Mac's HTTPS folder has a `DBXPC-SETUP.txt` with
     these steps written for a session on dbxpc.
  2. Run `node dist/apps/scene-director/main.js https-cert --san <Windows LAN IPv4>`. Add `,dbxpc.local` only if
     the iPad resolves that name. Check `ipconfig` on Windows for the IP, and re-run when it changes.
  3. Serve with `--https-port 5521` (or `SCENE_DIRECTOR_HTTPS_PORT=5521` in the profile Claude Code starts from).
  4. In an elevated PowerShell, forward and open the port:
     `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5521 connectaddress=<wsl ip>
     connectport=5521`, where `<wsl ip>` is `hostname -I` in WSL (it changes when WSL restarts), and
     `New-NetFirewallRule -DisplayName "scene-director https" -Direction Inbound -Protocol TCP -LocalPort 5521
     -Action Allow -Profile Private`.

  Mirrored networking would avoid the portproxy, but it changes how the `windows-chrome` interop reaches WSL, so it
  isn't the default. The iPad trusts the same CA, so it only needs dbxpc's token link once (cookies are per host).
- **Checked (Mac, 2026-10-24)**: curl with `--cacert` over `Michelles-MacBook-Air.local` and 10.0.0.187 (the name
  constraints pass); no CA fails TLS. Playwright Chromium over the token link: a 302, then `isSecureContext` true,
  `navigator.gpu` present, the cookie set, and the page's `wss://` link connected (the hub counted the tab). The
  headless shell then loses its GPU device as usual.
- **iPad findings (2026-10-24, Stage A, no EVE data)**: Safari over `https://Michelles-MacBook-Air.local:5521/`
  (the warning was clicked through before full trust was on, and WebGPU still came up).
  - Renderer: adapter `apple apple apple`, with `texture-compression-bc` (+ `-sliced-3d`), `float32-filterable` and
    `depth-clip-control`. A 2752×1800 canvas (iPad Pro 13" landscape).
  - Drawing: 60 fps, `gpuErrors` 0. `screenshot` (the GPU readback) works.
  - Recording: `record_movie` H.264 1280×720 at 30 fps for 5 s gave 150 frames in real time (30.02 fps, frame ms
    mean 33 / max 53, 0 GPU errors). `new VideoFrame(canvas)` and WebCodecs H.264 work in WebKit, and the MP4 landed
    on the Mac.
  - A fight: `stage_engagement` TFIs vs TFIs (88 stand-ins, brawler vs kiter) with `auto_camera` ran at 57–60 fps,
    tracers and kills included.
  - Still open: Stage B (real EVE content: WebKit on the runtime's WGSL and CORTAO's storage-texture limits),
    per-tab memory on a long or big scene, and HEVC.
  - Close the desktop tabs first: page tools go to the newest tab.

## Another machine's EVE data (tools-core through its hub)

A machine without tools-core (the Mac) can use dbxpc's. dbxpc's hub shares its tools-core at `/tools-core/eve/<rest>`
over its HTTPS listener and token, and the Mac's hub points `--tools-core` at that. The hub, the MCP server, the page,
the simulation and drawing all stay on the Mac; only EVE files, SDE, map and audio lookups cross the LAN.

- **The passthrough** (`hub.ts` `ServeToolsCore`): tools-core's `/eve/<rest>` with the path and query as they came
  (an audio path stays encoded). It takes GET, HEAD and POST (a body up to 4 MB), forwards Range, the validators and
  the content type, and streams the answer back. Any other path is a 404 and any other method a 405. With EVE data
  off it answers 503; when tools-core is down, 502. It is on the loopback listener too, which is harmless: tools-core
  is already reachable there. dbxpc's `viewer_status.https.toolsCore` lists its URLs.
- **The Mac's hub**: `CJS_TOOLS_CORE=https://10.0.0.58:5521/tools-core` (or `--tools-core`), with
  `SCENE_DIRECTOR_EVE_DATA` unset. For an https URL it does two things:
  - It sends the token as `authorization: Bearer` on every tools-core request (`ToolsCoreApi.fetch`, which the
    proxies, the data clients and the audio cache all use). The token comes from `--tools-core-token` /
    `SCENE_DIRECTOR_TOOLS_CORE_TOKEN`, else the Mac's own HTTPS `token`, which is the same one dbxpc uses since it was
    copied over.
  - It adds the shared CA beside the bundle to Node's default TLS trust (`TrustHttpsCa`). `--https-ca <file>|none`
    picks another; with `none`, set `NODE_EXTRA_CA_CERTS` instead.

  For the hub an MCP session starts, export these in the shell profile Claude Code starts from, then restart Claude
  Code. `viewer_status.toolsCore` shows the URL, `reachable` and the build.
- **When it fails**:
  - A 401 is the token.
  - "not reachable … It is another machine's" means one of three things: dbxpc's hub isn't running, it is a build
    from before the passthrough (it answers 401, since it doesn't read Bearer, or 404), or the WSL IP moved and
    broke the portproxy (dbxpc step 4 above).
  - dbxpc's hub has to be up (a session's MCP server or `serve --https-port 5521`) whenever the Mac wants EVE data.
- **Costs**: the audio cache downloads each bank whole over the LAN, once per build (about 372 MB for
  `turrets.bnk`). Resources are buffered by both hubs.
- **Checked (Mac, 2026-10-24)**: specs cover the passthrough, the Bearer admission and a hub drawing resources, ranges
  and the build through another hub. A spare Mac hub reached dbxpc's hub over TLS with the shared CA and got a 401:
  that hub predates the passthrough. The end-to-end run waits on dbxpc's hub being rebuilt.

## verify-page (everything but drawing)

verify-page (`apps/scene-director/src/verify-page.ts`, the `scene-director:verify-page` target) drives the real page in
headless Chromium through the hub's tools, against a running tools-core: boot, the hub link, SOF builds from real EVE
data, edits, storage and reload, prop mod audio events (launched with `--autoplay-policy=no-user-gesture-required`; it
sees events posted, it cannot hear them). It uses temp file stores. `--only <text>` runs the checks whose label contains
the text (any case; `a|b` for either) after the always-run connect check.

**Run it through `dbx-claude-test`, not Bash.** The marker declares two suites (`tests.suites`):

- `verify-page`: needs tools-core (`requires`), so only dbxpc runs it. Elsewhere the call is refused, naming dbxpc and
  `dbx-claude-handoff`. It is `exclusive`: other lint / test / build / commit runs on the machine wait for it.
- `verify-page-no-eve`: the `--eve-data off` run. It needs no tools-core, so it runs on any machine.

`testName` is the `--only` filter: `dbx-claude-test { suite: "verify-page", testName: "combat:|logi:" }`. The run is a
background job with a parsed per-check verdict and live progress. A long run in a loop pane parks the item at
`awaiting-tests` and settles it back with a per-check note. Batch several filters into one wait with
`suites: [{ suite: "verify-page", testName: "fleets:" }, { suite: "verify-page", testName: "time:" }]`. A raw Bash run
of the target or the built script gets a one-time hint with the translated call. That hint (2026-10-24) translates a
raw `--eve-data off` run to `verify-page` and drops the flag: use `verify-page-no-eve` instead.

**Close-out checks** (`tests.closeOut`, dbx-claude's `dbxc-queue` ref):

- **Default list**: an item whose changes touch `packages/viewer-engine/src/`, `apps/viewer/src/`,
  `apps/scene-director/src/lib/hub/` or `packages/scene/src/` gets two entries before it closes:
  - all of `verify-page-no-eve`: 26 checks in ~3 min on the Mac (2026-10-24). It runs on any machine.
  - `verify-page` with the smoke filter
    `load_scene builds|patch_scene moves|fleet membership|round-trip through|survives a reload`: the connect check, an
    SOF build, a patch, the fleet tree, the IndexedDB and file saves, and a reload. That is the least of the
    first-scene chain that runs, since each check builds on the one before.

  A machine without tools-core runs the no-EVE entry, closes the item, and leaves the smoke entry on the standing
  `owed-tests-dbxpc` item.
- **Area map**: one `areas` entry per row of the table below, with the row's prefixes as its `testName`. Two rows
  have no entry: `dev-env:` (the screenshot) and `no EVE data:`, which the default list already runs. An area's
  `paths` are the ref's `pathContains` triggers plus a few page files those miss: `camera-director`, `movie.`,
  `missile-`, `capacitor`, `pilot-facts`, `arrivals`, `fleet-view`. Writing a file in an area while holding a claimed
  item fires the `test-area` hint once, with the exact `dbx-claude-queue-add { id, requiredTests }` call. Do not add
  an area whose `add` is exactly `{ suite: "verify-page-no-eve" }`. The proof rule would take that area's paths as the
  default entry's covered paths, and an old pass would then skip the default.
- **Adding checks to an item**: put entries in `requiredTests`, e.g.
  `{ suite: "verify-page", testName: "export:|record:" }`. Do this when enqueuing the item or later through
  `dbx-claude-queue-add { id, requiredTests }`. Removing an entry, a default one included, takes
  `waiveTests: [{ entry, reason }]`. A passing run keeps proving an entry until a file in its area (or the suite's
  `paths`) changes.

- **Output**: each result prints as its check ends (`ok    ` / `FAIL  ` / `skip  `, `info  ` notes, then a tally
  `N ok, M FAIL, K skip`), so a run that is killed keeps every result it reached.
- **`--tap`**: stdout is only a TAP version 13 stream, the contract dbx-claude's test suites parse: `TAP version 13`
  once the hub and Chromium are up; `ok N - <label>` / `not ok N - <label>` / `ok N - <label> # SKIP <reason>`; the
  detail or failure message as one `# ` line after its point (`info` notes too, as `# info …`); `1..N` when the run
  completes. Labels are one line with `#` escaped `\#`. The formatter is `src/lib/verify/tap.ts` (`VerifyReport`).
- **Exit codes**: 0 every check passed (skips included), 1 a check failed, 2 the run could not proceed: `Bail out!
  <reason>` (a `verify-page cannot run:` stderr line without `--tap`) for tools-core unreachable, a temp store, hub
  start or Chromium launch failure, an error outside a check, and an `--only` that matched no check. A bail has no plan
  line.
- **Areas**: every label starts with `<area>: `, so `--only "<area>:"` runs one area (`--only "export:|record:"` two).
  `src/lib/verify/labels.spec.ts` fails on a label without a listed prefix, or with one inside another label: **a new
  check takes its group's prefix; a new area goes in that spec's list and this table.** One prefix covers a group of
  checks that share a scene, so selecting an area never runs a check without the one it builds on (the
  compositions check expects the TFIs check's `tfis`; the first-scene chain's saves expect its fleet).

| Prefix | Ref | Checks |
|---|---|---|
| `scene-document:` | `sd-scene-document` | the first-scene chain: load, Destiny placement and flight, patch, orders, warp, prop mods and their audio, the fleet tree, saves to IndexedDB and files, reload (Destiny and prop mod changes ride here) |
| `ship-stats:` | `sd-ship-stats` | `search_hulls`, `ship_stats`, the skill table |
| `fittings:` | `sd-fittings` | the dogma path, module activation (hardener, prop, remote reps), tackle (webs, scrams, neuts) |
| `weapons:` | `sd-weapons` | default guns, turrets on their cycle, targets, turret sounds |
| `piloting:` | `sd-piloting` | `get_overview`, stances |
| `combat:` | `sd-combat` | locks, hits, engage / cease_fire, seeds, kills, `set_hp`, missiles, fleet deaths, revival |
| `fleets:` | `sd-fleets` | called targets, TFIs compositions, Follow the FC, `order_fleet`, fleet warp |
| `personality:`, `free fire:` | `sd-personalities` | the FC brain, free fire |
| `logi:` | `sd-logi` | auto-repair |
| `locations:` | `sd-locations` | the environment report, `search_map`, `get_system`, `set_location`, dressing |
| `staging:` | `sd-staging` | `add_ships`, `stage_engagement` |
| `warp-in:` | `sd-staging` | arriving fleets |
| `objects:` | `sd-objects` | `search_objects`, `add_objects`, orders on objects, the scene extent |
| `asteroid-fields:` | `sd-asteroid-fields` | fields: add, refuse, update, belts, round-trip, remove |
| `cinema:` | `sd-cinema` | shots, sequences, hardpoints, the warp-in shot |
| `director:` | `sd-cinema` | `auto_camera` |
| `timeline:` | `sd-timeline` | cues, ship orders, live edits, replay, `at` |
| `movie:` | `sd-timeline` | event cues, the movie tool, letterbox |
| `time:` | `sd-time` | rate, pause, jumps, the tape, seek |
| `export:`, `record:` | `sd-export` | `export_movie`, `record_movie` |
| `dev-env:` | `sd-dev-env` | the screenshot (with a renderer) |
| `no EVE data:` | `sd-dev-env` | the `--eve-data off` run (`record:` runs there too) |

The full suite is ~210 checks and ~40 min (2026-10-24): run it as area batches (`testName` per area), never the whole
suite for one item. `exclusive` keeps it from running alongside the other test suites. The M6 runner
`.scratch/movie-gpu/batch.mjs` / `chain.sh` on dbxpc (`sd-timeline` doc `movie`) is superseded by the
`verify-page` suite: its labels predate the area prefixes and it runs outside the job queue.

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
