# carbon-engine-scene-director

Build EVE Online space scenes as JSON documents and watch them render live in
the browser, driven by Claude through MCP tools. Rendering is
[CarbonEngineJS](https://github.com/carbonenginejs/runtime)'s WebGPU renderer;
ship and environment data come from a local
[tools-core](https://github.com/carbonenginejs/tools-core) service.

**Phase 1**: scene documents, ships placed from SOF DNA, camera, screenshots,
saved scenes. **Movement** (in progress): every ship flies as a Destiny ball
from [`@carbonenginejs/server`](https://github.com/dereekb/carbon-engine-server),
and `order_ship` gives live direction and stop orders. Orbit, approach, warp,
combat and timelines come in later phases; the document's `orders` and
`timeline` fields stay reserved until then. **Fleets**: the document holds EVE
fleet structure (fleet commander, wings, squads with a role and an anchor),
stored and reported but not flown yet.

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
- The Destiny server in `../carbonenginejs/server` (the user's fork, branch
  `scene-director`; run `npm run build` there after a checkout, since `dist/` is
  not committed). It is copied into `node_modules` on install and must dedupe
  onto the runtime above (`npm ls @carbonenginejs/runtime` shows `deduped`
  under it); see `serverPin` in package.json.
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
| `viewer` | `apps/viewer` | `@nx/esbuild` (browser) | the page: renderer, director, ships, the Destiny world and its clock, storage, hub link; node specs for the clock and the Destiny wiring |

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
| `patch_scene` | page | edits by operation (ships, camera, environment, rename, fleets) |
| `save_scene` / `list_scenes` / `open_scene` / `delete_scene` | hub | saved scenes: files on disk, or the page's IndexedDB (see below) |
| `get_state` | page | renderer status, per-ship build status, Destiny motion (position, velocity, speed, mode, physics), distances, the simulation tick, fleet membership and the fleet tree |
| `order_ship` | page | a live movement order for a ship: fly along a direction at a speed fraction, or stop (see Movement) |
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
are stored but not played yet. A top-level `fleets` list groups ships into EVE
fleets (see Fleets below).

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
retunes it (the diff's `retuned` list: new flight numbers, no rebuild), a fleet
change regroups the ships whose membership changed (the diff's `regrouped`
list: no rebuild), and an environment change reloads the page (the scene's
environment is initialized with the device).

## Movement

Each document ship has a Destiny ball (`apps/viewer/src/lib/destiny.ts`), built
or not, and the ball drives the drawn ship's translation and rotation curves.

- **Two parks in lockstep.** A master park holds the authoritative state that
  `get_state`, distances and camera framing read. A replica park creates the
  `CjsDestinyClientBall` renderer curves the server documents
  (`docs/destiny-client-curves.md` there): they interpolate, sample two ticks
  back and damp rotation like EVE's client. Replication is not ported, so
  `DestinyWorld` applies every change to both parks in the same call and they
  stay bit-identical.
- **One clock.** The page's animation loop advances a scene clock (100 ns ticks)
  by the real frame time, evolves both parks to it, then draws at it. A frame
  advances it by at most one second, so a hidden tab pauses the scene instead of
  fast-forwarding it. The loop runs without WebGPU too, so headless checks see
  ships move.
- **Absolute coordinates.** The replica's ego is a fixed ball at the origin, so
  the curves give world positions.
- **Orders apply at the next 1 s tick**, as EVE applies commands before a tick.
  The drawn ship trails the reported state by up to a tick, as in the client.
- **Placement.** `load_scene` and `open_scene` put every ship back at rest at its
  document placement. `patch_scene` touches only what it changes: a new position
  or rotation puts that ship there at rest; a new DNA rebuilds the ship and it
  keeps flying. A ship at rest faces its document rotation exactly; under way it
  faces its velocity, keeping the document's roll. After a teleport, any banking
  from the previous turn levels out over a few seconds, as Destiny's client does.
- **Orders are live only.** They are not written to the document, so a save or a
  reload starts from the document's placements.
- **Physics are class defaults**, not dogma: mass, agility and max velocity by
  the SOF hull category (frigate, cruiser, battleship, ...), or by its bounding
  radius when the category is unknown, with the radius from the hull. The
  document's `stats` (mass, agility, maxVelocity) override them. Until a ship's
  build reads its hull, it flies with cruiser defaults.

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

## Fleets

A scene's `fleets` are EVE fleets: a fleet commander (FC) commands the fleet, the
fleet splits into wings, and each wing into squads. This is structure only: it
is validated, edited by `patch_scene`, saved and reported by `get_state`, but
ships do not follow it yet (Follow the FC builds on it).

```json
{
  "schema": "cjs-scene/1",
  "name": "tfi-fleet",
  "ships": [
    { "id": "fc", "dna": "mb2_t1:minmatarnavy:minmatar", "name": "FC" },
    { "id": "tfi-1", "dna": "mb2_t1:minmatarnavy:minmatar", "position": [1500, 0, 0] },
    { "id": "tfi-2", "dna": "mb2_t1:minmatarnavy:minmatar", "position": [-1500, 0, 0] },
    { "id": "tfi-3", "dna": "mb2_t1:minmatarnavy:minmatar", "position": [0, 0, 1500] },
    { "id": "guardian-1", "dna": "ac3_t2:carthum:amarr", "position": [30000, 0, 0] },
    { "id": "guardian-2", "dna": "ac3_t2:carthum:amarr", "position": [31000, 0, 0] }
  ],
  "fleets": [
    {
      "id": "tfi",
      "name": "TFI fleet",
      "commander": "fc",
      "wings": [
        {
          "id": "wing-1",
          "squads": [
            { "id": "dps", "role": "dps", "members": ["tfi-1", "tfi-2", "tfi-3"], "anchor": { "range": 1000 } },
            { "id": "logi", "role": "logi", "commander": "guardian-1", "members": ["guardian-1", "guardian-2"], "anchor": { "ship": "guardian-1", "range": 30000 } }
          ]
        }
      ]
    }
  ]
}
```

The FC holds the fleet commander's slot (in no squad); it may also sit in one of
its fleet's squads. The three TFIs keep 1 km on the FC. The logi squad anchors
on its own logi anchor, guardian-1: guardian-1 holds 30 km off the FC and
guardian-2 anchors up on it at 1 km.

**Fields.** A fleet is `{ id, name?, commander, wings }`, a wing
`{ id, name?, commander?, squads }`, a squad
`{ id, name?, role, commander?, members, anchor? }` and an anchor
`{ ship?, range? }`. `wings`, `squads` and `members` default to `[]`; an empty
fleet, wing or squad is valid. `role` is required: `dps`, `logi`, `tackle`,
`ewar`, `boost` or `support` (read case-insensitively). `null` on an optional
field means absent, and `fleets: []` is the same as no `fleets`.

**Anchors.** A squad anchors on `anchor.ship` (default: the FC, whoever that is)
and keeps `anchor.range` metres, surface to surface as EVE's overview measures
it (default by role: logi 30,000 m, every other role 1,000 m, EVE's "anchor
up"). Both are stored as written, so an omitted value follows a new FC or role.

- An anchor on the FC or on a ship outside the squad: every member except the FC
  keeps the range on it.
- An anchor on one of the squad's own members (not the FC): that ship is the
  squad's lead, as a logi anchor is. It keeps the range on the FC, and the other
  members anchor up on it at 1,000 m.
- The FC follows nobody: the fleet takes its heading from it. A wing commander in
  no squad anchors up on the FC.
- Anchors are ships of the same fleet (the FC, a wing commander or a squad
  member), and every anchor chain must end at the FC: loops are refused.

**Rules a valid document keeps.**

- Ids use the ship-id pattern. Fleet ids are unique in the scene; wing and squad
  ids are unique within their fleet (a squad is addressed by fleet + squad, so
  two fleets can both have a `dps` squad).
- A ship holds positions (FC, wing commander, squad member) in at most one
  fleet, and sits in at most one squad.
- The FC sits in one of its fleet's squads or in none. A wing commander sits in
  one of its own wing's squads or in none, and commands one wing. A squad
  commander is one of its squad's members. One ship may combine these commands.
- `team` is independent of fleets: a team is the side a ship is on (hostility,
  for combat), a fleet is who commands it and where it flies. Fleets neither set
  nor check teams, and a fleet may mix them.

**Edits.** The object an `add_*` op adds sits under its noun; every other
`fleet`, `wing` or `squad` key is an id.

| Op | Shape | Notes |
| --- | --- | --- |
| `add_fleet` / `update_fleet` / `remove_fleet` | `{ fleet }` / `{ fleet, set: { name?, commander? } }` / `{ fleet }` | an old FC left holding no position leaves the fleet |
| `add_wing` / `update_wing` / `remove_wing` | `{ fleet, wing }` / `{ fleet, wing, set: { name?, commander? } }` / `{ fleet, wing }` | removing a wing removes its squads |
| `add_squad` / `update_squad` / `remove_squad` | `{ fleet, wing, squad }` / `{ fleet, squad, set: { name?, role?, commander?, anchor? } }` / `{ fleet, squad }` | `add_squad` never moves ships; `update_squad` replaces `anchor` whole |
| `move_to_squad` | `{ ships, fleet, squad }` | leaves the old squad (and its command), a wing command for another wing, and another fleet |
| `remove_from_fleet` | `{ ships }` | takes ships out of every position |
| `set_anchor` | `{ fleet, squad, anchor: { ship?, range? } }` | merged; `null` resets `ship` to the FC and `range` to the role default |

`null` in a `set` clears that field. Ids and child lists cannot be set: use the
remove/add and the child ops. Removing a fleet, wing or squad keeps its ships in
the scene.

**Removal and fallback.** Removing a ship (`remove_ship`) takes it out of its
fleet automatically, as it clears `camera.target`. Whenever an edit takes a ship
out of a fleet or a squad, the ship gives up the commands it can no longer hold,
and a squad anchored on it falls back down the chain: its squad commander, then
its wing commander (whichever is set and still in the fleet), otherwise the FC.
The range is kept. Lost commands and re-pointed anchors come back as warnings.
A fleet commander is never removed implicitly: give the fleet another commander
(`update_fleet`) or remove the fleet first. Operations run in order, so
`update_fleet` then `remove_ship` in one patch works.

**`get_state`.** Each ship in a fleet reports `fleet`, `wing`, `squad`, `role`,
`commands` (`fleet`, `wing`, `squad`) and `anchor` (`{ ship, range }`: what it
keeps range on under the rules above; `null` for the FC). Ships in no fleet have
none of these keys. `fleets` is the fleet tree with `ships` (every ship holding a
position) and each squad's anchor resolved; `scene.fleets` counts them. An edit's
`changes.regrouped` counts the ships whose membership changed.

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
- Destiny balls drive the ships (see Movement). The ClientBall is the
  translation curve; `BallRotation` wraps it for rotation and overrides the
  `*__Ticks` methods it serves, because the runtime's curve bases pass their
  arguments in the opposite order from their docs.
- `runtime-sim.ts` is the light half of the import point (math, the Blue curve
  bases, the Destiny server); `runtime.ts` re-exports it. The node-tested modules
  (`clock.ts`, `destiny.ts`) import only `runtime-sim.ts`, so their specs never
  load the renderer. The server's types are in `carbonenginejs-server.d.ts`.
- The esbuild plugin fails the build if any `@carbonenginejs/runtime` import,
  the server's included, resolves outside the page's runtime copy: a nested
  second copy would duplicate every class.

## EVE content

The code is MIT. EVE's content is not: using it means accepting CCP Games'
[EVE Online Content Creation Terms of Use](https://support.eveonline.com/hc/en-us/articles/8563917741084-EVE-Online-Content-Creation-Terms-of-Use).
Work made from EVE content must be non-commercial and carry CCP's disclaimer.
EVE Online and all related assets are the property of CCP hf. This project is
not affiliated with or endorsed by CCP Games or Fenris Creations.
