# carbon-engine-scene-director

Build EVE Online space scenes as JSON documents and watch them render live in
the browser, driven by Claude through MCP tools. Rendering is
[CarbonEngineJS](https://github.com/carbonenginejs/runtime)'s WebGPU renderer;
ship and environment data come from a local
[tools-core](https://github.com/carbonenginejs/tools-core) service.

What works today:

- **Scenes**: `cjs-scene/1` documents of ships placed from SOF DNA, a camera that
  orbits or chases a ship, screenshots, and saved scenes on disk or in the browser.
- **Movement**: every ship flies as a Destiny ball from
  [`@carbonenginejs/server`](https://github.com/dereekb/carbon-engine-server) at its
  in-game speed, agility and warp speed: direction, goto, approach, keep-at-range,
  orbit, warp and stop orders, with boosters that follow the ball speed.
- **Prop mods**: every ship fits an MWD or AB that switches on or off for a ship,
  squad, wing or fleet on EVE's cycle timing, with the engine sound.
- **Fits**: ships carry EVE fits (EFT); their modules set HP, resists, capacitor,
  signature and speed through the max-skills pilot, with stacking penalties and hull
  traits: fitted ships fly by them, `get_state` reports them, `ship_stats` evaluates
  any fit, and activation plays the client's module effects and sounds; webs, scrams,
  points, painters, neuts and nos act on their targets.
- **Weapons**: every ship mounts its fit's turrets on its hull's hardpoints, or default
  guns for its hull and race (with a charge) when it has no fit; `set_target` points
  them at a ship or object, and they fire once per weapon cycle with the game's
  firing effects and impacts, and the turrets' deploy and pack sounds (firing and
  impact sounds wait on a PTADPCM decoder). Launchers fire a missile each cycle that
  flies as a Destiny ball to its target, drawn as the client's missile with its trail,
  and detonates on the hull with the charge's impact effect.
- **Combat**: `set_target` and `engage` lock on EVE's lock time; each turret shot rolls
  EVE's hit chance through Destiny's `GetAccuracy` and does EVE damage through shield,
  armor and hull, and each missile hits through EVE's missile damage formula (or runs
  out of flight time); a ship at 0 hull plays the client's death explosion and leaves the
  scene, its fleet falling back as on a removal (a load revives it).
- **Battle damage**: `set_hp` sets the shield, armor and hull HP of ships, a fleet, a wing
  or a squad, live (HP, a percent of max or a seeded random draw, per layer or in total),
  to look battle damaged on camera without dying, or to start a low-HP fight.
- **Logi**: a fleet's logi squads repair members under fire on their own: each logi
  locks the member in reach that needs it most, runs its remote repairers on EVE's cycle
  timing with the client's beams, and the reps hold ships up in the damage model
  (`auto_repair` sets it per fleet, wing or squad).
- **Fleets**: EVE fleet structure (FC, wings, squads with a role and an anchor), and
  fleets fly in formation behind their FC (Follow the FC). Doctrine fleets are
  written once as fleet compositions and dropped in whole.
- **Fleet commands**: `order_fleet` moves or warps a fleet, wing or squad on its
  leader (the FC warps the fleet in formation, each hull at its own warp speed),
  breaks a squad off and regroups it, with an optional pilot response delay.
- **Fleet personalities**: pick an FC playstyle per fleet (`brawler`, `sniper`, ...) and
  its FC brain runs the fight: target calls, free fire, the FC's moves and prop mods,
  as the same tool calls a model makes, with FC ability, pilot reactions and a
  succession with a handover when the FC dies; pulling a lever yourself takes it manual.
- **Pilots and stances**: a ship, squad, wing or fleet gets a stance (kite, brawl,
  snipe, tackle, support, orbit, ...) and its pilots fly it every tick from both sides'
  numbers (the ideal range, kiting, spiralling in, burning out); a program outside the
  page picks stances from `get_overview` (`pilot-loop.js --ship <id>` is the example).
- **Locations**: a scene can sit at a real EVE place, dressed with its region's
  nebula, its star, and the planets, moons, stations and stargates near it.
- **Scene building**: `add_ships` and `stage_engagement` add N ships, or two
  opposing fleets, in one call.
- **Fleet warp-in**: `warpIn` lands added fleets and ships from warp, staggered,
  with the client's warp flashes, then forms them up.
- **Objects**: stations, stargates, Upwell structures, large collidable objects and
  wrecks placed by EVE type name, static in the scene and order targets for ships,
  as are the location's own stations and gates. A scene spans 10,000 km at most.
- **Asteroid fields**: seeded belts of EVE ore rocks (by ore name, as a sphere,
  disc or ring, off a belt, a celestial, a ship or a point), drawn instanced so
  hundreds of rocks cost a few draws.
- **Cinematic camera**: shots on hardpoints generated from the drawn ships, fleets
  and engagements, timed moves and waypoint fly-throughs over moving hulls, a
  letterbox and a clean HUD, directed by Claude over MCP: hardpoint listing,
  shots, sequences and a named shot library.
- **Director camera**: `auto_camera` hands the camera to an automatic director
  that cuts between hardpoints and library shots by what is happening
  (engagements, called primaries, ships about to die and exploding, warp-ins,
  reps, MWD bursts, close passes), keeps one side of the action and varies wide,
  medium and close; biased by Claude, taken over and handed back at any time,
  and cueable on the timeline.
- **Timeline**: a scene carries a script: cues at set times run any lever (ship
  and fleet orders, called targets, prop mods, modules, engagements, camera shots,
  warp-in adds) and ships fly their own order lists, played on Destiny ticks once
  the scene is ready, reported in `get_state`, and replayed the same on a restart.
- **Time control**: pause, slow motion and fast-forward on the scene clock (every
  Destiny tick stepped, orders, steering, modules and combat included), and jumping
  back N seconds or to any time in the recorded window: the page snapshots both
  Destiny parks and its own per-tick state every few seconds, re-simulates from the
  nearest snapshot and replays the live commands given since, so the same fight
  plays again (`time_control`, `get_state.time`, Space, `[` `]` and `←` on the page).
- **Movie mode**: the timeline is the movie: fleet and camera beats at times or on
  events (a kill, a landing, a called primary), a letterboxed look and an end, and
  script edits that re-simulate, so a seek lands on the same frame every time
  (`movie`: beats, seek to a beat, play from a beat, retake).

Movie export comes in a later phase.

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
- A runtime build in `../carbonenginejs/runtime` (`npm run build:npm` there),
  copied into `node_modules` on install; see `runtimePin` in package.json.
- The Destiny server in `../carbonenginejs/server` (the user's fork, branch
  `scene-director`; `npm run build` there after a checkout), copied in on install
  and deduped onto the runtime above; see `serverPin` in package.json.
- tools-core serving on 127.0.0.1:5510, with its SDE prepared for ship stats,
  hull names and locations.
- Chrome or Edge with WebGPU, on a machine with a GPU. Under WSL2, open the
  viewer from Windows; localhost forwarding reaches the hub.

Setting up the dependencies, tools-core and the SDE step by step:
[`sd-dev-env`](.dbx-claude/refs/sd-dev-env/REF.md).

## Layout

An nx workspace:

| Project | Path | Builds | Holds |
|---|---|---|---|
| `scene` | `packages/scene` | `@nx/js:tsc` | the scene document and its patch ops, the tool list, ship stats, prop mods, fleets, fleet compositions, locations and scene building, shared by the hub and the page (no runtime imports) |
| `scene-director` | `apps/scene-director` | `@nx/esbuild` (node) | the hub, the MCP server, the CLI, `verify-page` and `pilot-loop` |
| `viewer` | `apps/viewer` | `@nx/esbuild` (browser) | the page: renderer, director, ships, the Destiny world and its clock, camera, fleet following, location dressing, audio |

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
claude mcp add scene-director -- node <this checkout>/bin/scene-director.js mcp
```

The MCP server starts the hub itself, or joins one already running on the port.
From a shell, any tool can be called against a running hub:

```sh
node bin/scene-director.js call get_state
node bin/scene-director.js call load_scene '{"scene":{"ships":[{"id":"a","dna":"af1_t1:amarrbase:amarr"}]}}'
node bin/scene-director.js call screenshot '{"maxWidth":960}' --out shot.png
```

`--in` reads a file into the `scene` (or `composition`) argument, and `--out`
writes the scene, composition or image a result carries to a file.

## Tools

"Hub" tools work with no viewer tab open; "page" tools go to the newest
connected tab.

| Tool | Answered by | Does |
|---|---|---|
| `viewer_status` | hub | connected tabs, the URL to open, tools-core reachability, the saved scenes and fleets directories |
| `page_log` | hub | the viewer's recent console output and errors |
| `search_hulls` | hub | SOF hull, faction or race names |
| `ship_stats` | hub | a hull's in-game flight numbers, published and with every skill at V, optionally with a prop mod; with an EFT fit, its HP, resists, capacitor and speed by dogma |
| `search_map` / `get_system` | hub | CCP's static map: regions, systems, stars, planets, stations, stargates; one system with its celestials |
| `set_location` | hub | puts the scene at a real EVE place, off a celestial named or by id |
| `load_scene` / `get_scene` / `patch_scene` | page | replace, read or edit the scene by operation |
| `save_scene` / `list_scenes` / `open_scene` / `delete_scene` | hub | saved scenes: files on disk, or the page's IndexedDB |
| `add_fleet_composition` | hub | adds a fleet composition (inline, saved, or the built-in `tfis`) at a position and heading |
| `save_fleet_composition` / `list_fleet_compositions` / `get_fleet_composition` / `delete_fleet_composition` | hub | saved fleet compositions on disk, plus the read-only built-in examples |
| `list_fleet_personalities` / `get_fleet_personality` / `save_fleet_personality` / `delete_fleet_personality` | hub | fleet personalities (FC playstyles): the built-ins and saved ones on disk |
| `set_fleet_personality` | hub | gives a fleet a personality (built-in, saved or inline), or clears it |
| `add_ships` | hub | N ships of an EVE type in a formation at a place, free, as a new fleet, or into a fleet's squad |
| `stage_engagement` | hub | two sides facing each other at a range around a point or a celestial |
| `search_objects` | hub | EVE types to place: stations, gates, structures, LCOs, wrecks, with their SOF DNA and radius |
| `add_objects` | hub | static objects by type name or id at a place off a ship, object or celestial, singly or in a formation |
| `add_asteroid_field` | hub | a seeded field of EVE ore rocks (sphere, disc or ring) at a place off a ship, object or celestial; an asteroid belt centres it, drawn instanced |
| `get_state` | page | everything live: renderer, ships' motion, orders, warps, boosters, prop mods, fleets and their formation, audio, location and its targets, objects |
| `get_overview` | page | EVE's overview from one ship: every ship near it with distance, radial and transversal velocity, angular, bearing, aspect, reach, tackle, the DPS each side applies now, locks and fire; its stance and the ideal range against its focus |
| `order_ship` | page | a live movement order on a point, ship, object or `celestial:<id>`, or `rejoin` for a fleet member |
| `switch_prop_mods` | page | prop mods on or off, live, for ships, a fleet, a wing or a squad |
| `switch_modules` | page | fitted modules active, online or offline on EVE's timing (hardeners, reps, remote reps on a target, siege, guns firing at the ship's target, ...) |
| `set_target` | page | gives ships, a fleet, a wing or a squad a ship or object to lock, aim and fire their turrets and launchers at (null clears it) |
| `engage` | page | arms ships' turrets and launchers on a target: they lock it and keep firing until `cease_fire` |
| `cease_fire` | page | ends ships' engagements (their turrets and launchers stop at their cycle end); `unlock` drops the targets |
| `set_hp` | page | sets ships' shield, armor and structure HP live: per layer or the total, as HP, a percent of max or a seeded random draw; cinematic never kills, gameplay can |
| `order_fleet` | page | a fleet, wing or squad order: move, warp in formation, anchor, break-off, regroup, and called targets (a primary and a queue the group focuses fire on) |
| `auto_repair` | page | a fleet's, wing's or squad's logi auto-repair on or off, and how they pick: most urgent, most damaged or most shot-at |
| `screenshot` | page | the next frame as a PNG |
| `frame_camera` | page | points the camera at a ship or object and follows it, or fits all ships (all objects when there are none) |
| `list_hardpoints` / `play_shot` / `play_sequence` / `stop_shot` / `resume_shot` / `list_shots` | page (list_shots: hub) | the cinematic camera: a subject's hardpoints; shots, sequences, free poses and named library shots on the scene clock; pause, resume, hand back to the user |
| `auto_camera` | page | the director camera on or off, and its bias |
| `time_control` | page | pause or play, slow motion or fast-forward the scene, and jump back or seek within the recorded window |
| `timeline` | page | the scene's script: status (every cue and ship script), play, pause, restart; the lever tools and `add_ships`, `add_fleet_composition`, `stage_engagement`, `add_objects` take `at` to add a cue instead of acting now |
| `movie` | page | the timeline as a movie: beats in a fleet and a camera lane, add / move / edit / remove them, seek to a beat (paused, for a screenshot), play from one, retake after a cut, and the movie's look and end |

Each tool's arguments are described in its MCP schema (`packages/scene/src/lib/tools.ts`).

## Scene document

```json
{
  "schema": "cjs-scene/1",
  "name": "duel",
  "environment": { "universe": "res:/dx9/scene/universe/a01_cube.black" },
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 90, "mode": "orbit" },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
```

Metres and degrees, Y up; `rotation` is `[yaw, pitch, roll]`. A ship may also
name its EVE `type`, override `stats`, and fit a `propMod`; the document may hold
`fleets`, static `objects`, seeded `asteroidFields` and a `location`. Unknown fields are reported as warnings and dropped.
Edits are diffed against the current document, so the page rebuilds, moves or
retunes only the ships an edit changes. Orders and prop mod switches are live
only: a save or reload starts from the document's placements.

## Documentation

The detail lives in project references under `.dbx-claude/refs/`, written for the
agents working on this repo and readable as plain markdown. Each one covers the
behavior, the rules, the files and the gotchas of one area:

| Area | Reference |
|---|---|
| Processes, layout, naming, dependency pins | [`sd-workspace`](.dbx-claude/refs/sd-workspace/REF.md) |
| tools-core, the SDE, the hub, checking the page on a real GPU | [`sd-dev-env`](.dbx-claude/refs/sd-dev-env/REF.md) |
| The scene document, patch ops, the camera, saved scenes | [`sd-scene-document`](.dbx-claude/refs/sd-scene-document/REF.md) |
| Movement: Destiny, orders, placement | [`sd-destiny`](.dbx-claude/refs/sd-destiny/REF.md), with [warp](.dbx-claude/refs/sd-destiny/references/warp.md) and [boosters](.dbx-claude/refs/sd-destiny/references/boosters.md) |
| Fleets, anchors, Follow the FC, fleet orders | [`sd-fleets`](.dbx-claude/refs/sd-fleets/REF.md), with [fleet orders and fleet warp](.dbx-claude/refs/sd-fleets/references/orders.md), [fleet compositions](.dbx-claude/refs/sd-fleets/references/compositions.md) and the TFIs example |
| Building scenes: `add_ships`, `stage_engagement` | [`sd-staging`](.dbx-claude/refs/sd-staging/REF.md) |
| Objects: stations, gates, structures, wrecks; `add_objects`, `search_objects` | [`sd-objects`](.dbx-claude/refs/sd-objects/REF.md) |
| Asteroid fields: seeded ore belts, `add_asteroid_field`, instanced rocks | [`sd-asteroid-fields`](.dbx-claude/refs/sd-asteroid-fields/REF.md) |
| The cinematic camera: hardpoints, shots, moves, waypoints, letterbox | [`sd-cinema`](.dbx-claude/refs/sd-cinema/REF.md) |
| Ship stats, the pilot, prop mods, engine sound | [`sd-ship-stats`](.dbx-claude/refs/sd-ship-stats/REF.md) |
| Fittings: EFT fits on ships, the parser, fit keys | [`sd-fittings`](.dbx-claude/refs/sd-fittings/REF.md) |
| Weapons: default guns, turret slots, charges, the weapon route, targets, firing, shots, impacts | [`sd-weapons`](.dbx-claude/refs/sd-weapons/REF.md) |
| Combat: locks, hit chance, damage, kills, explosions | [`sd-combat`](.dbx-claude/refs/sd-combat/REF.md) |
| Logi auto-repair: the `autoRepair` field, repair-target selection, `auto_repair` | [`sd-logi`](.dbx-claude/refs/sd-logi/REF.md) |
| Fleet personalities: templates, the library, pilot traits, the FC brain | [`sd-personalities`](.dbx-claude/refs/sd-personalities/REF.md) |
| The timeline and ship orders: cues, steps, validation, the timeline ops | [`sd-timeline`](.dbx-claude/refs/sd-timeline/REF.md), with [Movie mode](.dbx-claude/refs/sd-timeline/references/movie.md) |
| Time control: rate, pause and fast-forward stepping, snapshots of the parks and per-tick state, the tape, jumps and what cuts the window | [`sd-time`](.dbx-claude/refs/sd-time/REF.md) |
| Piloting: stances, the ideal range, the orbit model, maneuvers and the pilot step | [`sd-piloting`](.dbx-claude/refs/sd-piloting/REF.md) |
| Locations, map data, name resolution | [`sd-locations`](.dbx-claude/refs/sd-locations/REF.md), with [dressing](.dbx-claude/refs/sd-locations/references/dressing.md) |
| The CarbonEngineJS runtime: imports, bundling, renderer | [`sd-runtime`](.dbx-claude/refs/sd-runtime/REF.md) |

**This README stays an overview.** A new feature gets a line in "What works today"
and the tools table here; its behavior, rules and measurements go in the area's
reference (or a new one), updated in the same commit as the code.

## Development

```sh
npx nx run-many -t lint typecheck build test       # what the commit gate runs; tests are offline
npx nx run scene-director:verify-page              # the real page in headless Chromium against a running tools-core
npx oxfmt --write .                                # formatting
```

Headless Chromium usually has no WebGPU adapter, so `verify-page` checks
everything but drawing; drawing is checked in a real Chrome or Edge tab through
`get_state`, `screenshot` and `page_log` (see `sd-dev-env`).

## EVE content

The code is MIT. EVE's content is not: using it means accepting CCP Games'
[EVE Online Content Creation Terms of Use](https://support.eveonline.com/hc/en-us/articles/8563917741084-EVE-Online-Content-Creation-Terms-of-Use).
Work made from EVE content must be non-commercial and carry CCP's disclaimer.
EVE Online and all related assets are the property of CCP hf. This project is
not affiliated with or endorsed by CCP Games or Fenris Creations.
