# carbon-engine-scene-director

Build EVE Online space scenes as JSON documents and watch them render live in
the browser, driven by Claude through MCP tools. Rendering is
[CarbonEngineJS](https://github.com/carbonenginejs/runtime)'s WebGPU renderer;
ship and environment data come from a local
[tools-core](https://github.com/carbonenginejs/tools-core) service.

**Phase 1**: scene documents, ships placed from SOF DNA, camera, screenshots,
saved scenes. **Movement** (in progress): every ship flies as a Destiny ball
from [`@carbonenginejs/server`](https://github.com/dereekb/carbon-engine-server),
and `order_ship` gives live direction, goto, approach, keep-at-range, orbit,
warp and stop orders at each ship's in-game speed, agility and warp speed, with
boosters that follow the ball speed. Every ship fits a prop mod (MWD or AB) that
`switch_prop_mods` switches on or off for a ship, a squad, a wing or a whole
fleet, on EVE's cycle timing, with the engine sound. Fleet commands, fleet warp,
combat and timelines come in later phases; the document's `orders`
and `timeline` fields stay reserved until then. **Fleets**: the document holds EVE
fleet structure (fleet commander, wings, squads with a role and an anchor), and
fleets fly: every member keeps range on its anchor in formation behind the FC
(Follow the FC). **Locations**: a scene can sit at a real EVE place (a solar
system and a point near one of its celestials, from CCP's static data); it is
recorded and reported, not drawn yet. **Scene building**: `add_ships` and
`stage_engagement` add N ships, or two opposing fleets, in one call.

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
| `scene` | `packages/scene` | `@nx/js:tsc` | the scene document schema, fleets and their formation, fleet compositions (`cjs-fleet/1`) with the TFIs example, the scene-building ops (`add_ships`, `stage_engagement`), the tool list, and the ship stats math and its pilot context, shared by the hub and the page |
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
| `ship_stats` | hub | a hull's in-game mass, max velocity, agility, signature, align time and warp speed, as published and as flown with every skill at V, optionally with a prop mod by name, type id or kind, and its cycle time (see below) |
| `search_map` | hub | searches CCP's static map by name: regions, constellations, systems, stars, planets, NPC stations and stargates (see Locations) |
| `get_system` | hub | one solar system with its star, the region's nebula and its celestials (see Locations) |
| `set_location` | hub | puts the scene at a real EVE place: resolves a celestial by name or id and sets the document's location, off it at a range; the page draws it (see Locations) |
| `load_scene` | page | replaces the scene with a document |
| `get_scene` | page | the current document |
| `patch_scene` | page | edits by operation (ships, camera, environment, rename, fleets, location) |
| `save_scene` / `list_scenes` / `open_scene` / `delete_scene` | hub | saved scenes: files on disk, or the page's IndexedDB (see below) |
| `add_fleet_composition` | hub | adds a fleet composition (inline, saved, or the built-in `tfis`) to the live scene at a position and heading, resolving hull names through tools-core (see Fleet compositions) |
| `save_fleet_composition` / `list_fleet_compositions` / `get_fleet_composition` / `delete_fleet_composition` | hub | saved fleet compositions on disk, plus the read-only built-in examples |
| `add_ships` | hub | adds N ships of an EVE type in a formation at a place (a position, or off a ship or celestial), facing a heading or a target, on a team; free, as a new fleet, or into a fleet's squad (see Building scenes) |
| `stage_engagement` | hub | two sides (compositions or ship lists) facing each other at a range around a point or a celestial, each on its own team; returns the ids per side (see Building scenes) |
| `get_state` | page | renderer status, per-ship build status, Destiny motion (position, velocity, speed, mode, heading, physics), orders, warp progress, booster values, each ship's `propMod`, distances, the simulation tick, fleet membership, each member's `following`, the fleet tree with each fleet's `formation` and `propMods` counts, the page's `audio`, and the scene's `location` with the nearest celestials and what the location dressed |
| `order_ship` | page | a live movement order at the ship's in-game speed: fly a direction or to a point, approach / keep range on / orbit a ship, warp to a point or a ship, or stop; `rejoin` puts a fleet member back in formation (see Movement and Follow the FC) |
| `switch_prop_mods` | page | switches prop mods (MWDs and ABs) on or off, live, for ships, a fleet, a wing or a squad, on EVE's cycle timing (see Prop mods) |
| `screenshot` | page | the next frame as a PNG |
| `frame_camera` | page | points the camera at a ship and follows it, or fits all ships |

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
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 45, "mode": "orbit" },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
```

Metres and degrees, Y up. `rotation` is `[yaw, pitch, roll]`. A `null` camera
target frames every ship; a `null` distance fits the target. A ship target is
followed: the camera moves with the drawn ship every frame, keeping any orbit,
pan or zoom made meanwhile. A camera following a ship, framed by `frame_camera` or
by the document, keeps following through scene edits (a placement, a fleet edit,
added ships); a load, a camera change or removing that ship frames the document's
camera again, and with no ship followed every edit re-fits the view. `mode` is how it follows: `orbit` (the default)
keeps the angles you set; `chase` sits behind the ship, 12° above its heading,
and turns with it (a drag looks around and eases back once released). In the
page, alt-click a ship to follow it (the view glides over, keeping its angles
and zoom) and press C to switch between orbit and chase; both are written into
the document's camera. Unknown fields are
reported as warnings and dropped. `orders` on a ship and a top-level `timeline`
are stored but not played yet. A top-level `fleets` list groups ships into EVE
fleets (see Fleets below), and an optional `location` puts the scene at a real
EVE place (see Locations below).

A ship's flight numbers come from its EVE type (see Ship stats below). `type`
names it explicitly, as a type id or an exact English name; without it, the
DNA's `hull:faction:race` picks it. `stats` (`{ "mass": kg, "maxVelocity": m/s,
"agility", "signatureRadius": m }`, each optional) replaces the hull's published
values before the pilot's skills and a prop mod apply, so `{ "maxVelocity": 200 }`
flies at 250 m/s with the max-skills pilot; all four together pin the numbers
with no EVE data. `update_ship` replaces `stats` as a whole, and `null` clears
`type`, `stats`, `propMod` or `pilot`. `pilot` is reserved for the character system: stored,
not used yet.

`propMod` is the ship's propulsion module and its state at load:
`"50MN Microwarpdrive II"` (shorthand) or `{ "module": "10MN Afterburner II", "active": true }`.
A module is an EVE type name, a type id, `"mwd"` / `"ab"` (the Tech II module of
that kind sized for the hull) or `"none"` (fits no prop mod). Omitted, the ship
fits the hull-sized Tech II microwarpdrive, off. See Prop mods below.

Edits are diffed against the current document: a DNA change rebuilds that
ship, a placement change moves it in place, a `type`, `stats` or `pilot` change
retunes it (the diff's `retuned` list: new flight numbers, no rebuild), as does
a `propMod.module` change, a `propMod.active` change switches the prop mod at
once (the diff's `switched` list, `changes.switched`), a fleet
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
  faces its velocity, keeping the document's roll. A placement holds still from the
  next frame even mid-tick: the ball's tick interval starts over at rest, so the
  ship neither slides on along its old thrust nor swings back toward its old
  heading. After a teleport, any banking from the previous turn levels out over a
  few seconds, as Destiny's client does.
- **Orders are live only.** They are not written to the document, so a save or a
  reload starts from the document's placements.
- **Physics are Ship stats** (`apps/viewer/src/lib/flight.ts`): the hull's
  published values from the hub's `GET /ship-stats`, then the document's
  `stats`, then the max-skills pilot, through the shared `computeShipStats`, so
  a ship flies at the numbers `ship_stats` reports. `get_state`'s
  `physics.source` says which applied: `sde` (the hull's EVE values), `stats`
  (the document gives all four) or `class` (class values by SOF hull category or
  bounding radius when the EVE data cannot name the hull, such as no SDE or an
  unknown DNA; `physics.note` says why). Class values go through the same pilot,
  so `stats` means the same with or without the SDE.
- **The ball radius is the hull's EVE radius** (SDE `radius`) when the hub
  knows it, else the SOF bounding radius, else 100 m. Order ranges and
  `targetDistance` are measured on it, surface to surface, as EVE's overview
  does; the SOF bounding sphere stays for framing, `get_state`'s `radius` and
  `distances`.
- **Lookups** are cached per page session, one per EVE type or DNA
  `hull:faction:race`. A ship flies class values until its lookup lands (a
  fraction of a second; the first DNA search may build tools-core's index), then
  retunes mid-flight. A failed lookup is logged once and retried on the next
  `load_scene` / `open_scene` or a tab reload, so preparing the SDE and reloading
  picks it up.

### Orders

| Order | Destiny call | What you see (max-skills frigate, about) |
|---|---|---|
| `direction` | `GotoDirection` | flies along the direction; reaches 75 % of max velocity after `ceil(alignTime)` whole ticks |
| `goto` | `GotoPoint` | flies to the point and creeps to a halt tens of metres short of it (mode stays `goto`) |
| `approach` | `FollowBall` at 50 m | closes on the target's hull; the balls may overlap slightly, as there are no collisions |
| `keep-at-range` | `FollowBall` at the range | holds the range within about ±3 % on a stationary target; trails a moving one (about +33 % at 1 km behind a 130 m/s ship), matching its speed |
| `orbit` | `Orbit` | settles about 5 % wide at 5 km; tight orbits on fast ships run much wider (500 m gives about 890 m), as in EVE |
| `warp` | `WarpTo` | aligns, then warps at the hull's warp speed and lands on the point (or `range` short of it), or `range` from a ship; a 162 m/s battleship at 3 AU/s goes 300 km in 12 ticks of align and 12 in warp; a frigate at 5 AU/s spends 20 ticks in warp over 10 AU (see Warp) |
| `stop` | `Stop` | decelerates to a halt |
| `rejoin` | (formation steering) | a fleet member that left its formation flies back to its slot (see Follow the FC); refused for the FC and a ship in no fleet |

Every movement order takes `speed`, a fraction of max velocity in (0, 1]
(default 1). Ranges are metres, surface to surface on the balls' radii. A target
must be another ship in the scene. Removing a ship stops every ship approaching,
keeping range on or orbiting it (`patch_scene`'s `changes.stopped` counts them);
Destiny alone would send an orbiter straight on along its velocity, which carries
it out of a directed scene. When Destiny refuses an order silently, the ship
stops and `orderNote` says so. A new position or rotation, `load_scene` and
`open_scene` end a ship's order; a re-placed target keeps its followers, which
chase it. `get_state` reports each ship's `order` (what its ball is flying),
`pendingOrder` (applying at the next tick), `orderNote` and `targetDistance`.
Destiny's default (legacy) orbit algorithm is used.

**On a real GPU** (2026-10-22, Windows Chrome, NVIDIA): turns draw smoothly. No
frame stepped more than 3° and none reversed its turn. Hulls bank into a turn
(Carbon's legacy roll, up to about 80° in a 22°/s frigate turn) and level after.
Two orders whip at one tick edge, then ease off: a 180° approach from rest
(about 150°/s) and a reversal at speed (about 120°/s). Measured ranges: orbit 5 km
held 5245–5253 m at 98 % of max velocity, orbit 1 km 1340–1390 m,
keep-at-range 2500 m behind a 157 m/s target 2810–2915 m, and approach parked
160–166 m surface to surface. An orbit ordered from rest picks a steeply
inclined plane (a 5 km orbit around a level battleship rode 3–4 km below it).

### Warp

`{ "type": "warp", "point": [x, y, z], "range"? }` or `{ "type": "warp",
"target": "<ship id>", "range"? }` (`range` default 0; no `speed`: a warp
always aligns at full speed).

- **Phases.** `aligning`: the ship flies at full speed toward the destination
  until it is within about 8° of it at 75 % of max velocity, as in EVE (Destiny
  warps anyway after 180 ticks). `warping`: Destiny's accelerate and cruise
  phases at the hull's warp speed (`warpSpeedMultiplier` AU/s from the SDE,
  through Ship stats; class values without it: frigate 5, destroyer 4.5,
  cruiser 4, battlecruiser 3.5, battleship 3, capitals 1.5). `exiting`: the
  deceleration. Destiny drops the ship out of warp on the first tick its speed
  is under min(max velocity / 2, 100 m/s); it then coasts to a halt a few
  hundred metres past the landing point (`landed`, mode `stop`).
- **Landing.** For a point, `range` metres short of it, back toward where warp
  begins; for a ship, `range` surface to surface from where the target was when
  the order applied (it is not tracked during the warp).
- **Refusals.** A landing under 150 km away (EVE's minimum; use `goto`), a ship
  with a max velocity of 0, and a warp to a ship in warp are refused. While
  aligning any order cancels the warp (a new warp replaces it). In warp a ship
  refuses every order until it lands (`is in warp; it takes orders again once
  it lands, in about N s`): Destiny cannot stop a ball in warp.
- **Edits.** Removing the target of an applied warp leaves the warp flying; a
  pending warp to it stops the ship. A new position or rotation ends a warp at
  once, at rest at the placement.
- **Fleets.** While the FC (or a member's anchor) is in warp its members hold,
  stopped (`following.state` `holding`); after it lands they fly to their slots
  at their own speed, however far it went. There is no fleet warp yet.
- **`get_state`.** A ship with a warp order reports `warp`: `phase`,
  `landing`, `warpSpeed` (AU/s), `alignTicks` (aligning), `distance` (from warp
  start), `remaining` (metres to the landing), `progress` (0 to 1) and `landsIn`
  (seconds, in warp). `order` stays the warp order through landing; `mode` is
  `warp` until it lands.
- **Far away.** Destiny simulates any distance in float64, but the page draws
  relative to the scene origin in float32: a ship farther than about 100,000 km
  jitters on screen if the camera goes there.
- **Hook.** `DestinyWorld.OnWarp(listener)` reports `enter` and `exit` events
  after the tick they happen in (where warp began or the exit point, the
  direction, the landing and the warp speed), for the warp-in effects to come.
  The client's effects are `res:/fisfx/jump/warp/warp_out_start.black` and
  `warp_out.black` (leaving) and `warp_in_glow.black` / `warp_in_noglow.black`
  (arriving); playing them needs a real-GPU check.

### Boosters

The runtime's `EveShip2` derives its `speed` from the ClientBall every frame;
a booster set's intensity is speed / `boosters.maxVel` (capped at 2), and the
runtime defaults `maxVel` to 250 m/s for every hull. So every frame, before
drawing, the page sets each built ship's `boosters.maxVel` and `maxSpeed` to its
Ship-stats max velocity (full speed reads the same on every hull) and ramps
`boosters.warpIntensity` (the warp colours) in from 10× to 14× its max
velocity, so only a warp shows them. Trails fade out in warp by the runtime's
own rules. `get_state` reports each built ship's `boosters` (`maxVel`,
`intensity`, `warpIntensity`) when there is a renderer. `maxVel` stays the
prop-mod-off max velocity, so a running AB pushes the flames past full and an
MWD drives them to the runtime's cap of 2.

On a real GPU (Windows Chrome on NVIDIA, 2026-10-22, a Slasher and a Tempest
Fleet Issue):

- **At rest** the boosters are dark: no flame, flare, light or trail (the
  runtime culls the flame at intensity 0).
- **At full speed** the Minmatar flames are orange with warm flares, and trails
  run behind the ship (about 2.1 km for the frigate, a faint 0.6 km for the
  battleship). The intensity eases from about 0.95 to 0.8 over a few seconds as
  the ship's acceleration fades, in steps at the 1 s ticks, and then holds.
- **In warp** the flames run full length in the shared pale blue-white warp
  colours with a blue stern light, and the trails go out above about 12 km/s.
  They come back as long streaks at the end of the exit.
- **The ramp** is short because `BoosterVolumetric` reads the warp half of its
  colour gradient for any `warpIntensity` above 0 while its tints still blend.
  With 10× to 100× a Minmatar flame drew violet for about half a second at the
  end of a warp. The warp colours follow the speed, so they leave about 3 s
  before the ship drops out of warp.
- **An AU/s warp** leaves the ships near the origin untouched: no booster shader
  reads `shipSpeed`.

### Prop mods

Every ship fits one propulsion module: the one its `propMod` names, or the
Tech II microwarpdrive sized for its hull. `switch_prop_mods` switches modules
on or off, live; the document's `propMod.active` is the state at load.

- **The module.** A name (matched to CCP's type names case-insensitively, with
  `MWD` / `AB` read as Microwarpdrive / Afterburner), a type id, `"mwd"` /
  `"ab"` or `"none"`. The hull size is the SDE's `rigSize` when the hub names
  the hull, else the SOF class's: frigates and destroyers 5MN / 1MN, cruisers
  and battlecruisers 50MN / 10MN, battleships 500MN / 100MN, capitals 50000MN /
  10000MN (the SDE's largest). The page asks the hub's `GET /prop-mod?module=`
  for the module's speed factor, thrust, mass addition, signature bloom and
  cycle time (tools-core's SDE); without it, it uses 13 built-in modules (the 8
  hull-sized Tech II and the 5 the TFIs example names, SDE 3632936), else the
  hull-sized Tech II module of the name's kind stands in, with a `note`.
- **Switching** (`switch_prop_mods { active, ships | fleet [, wing | squad] }`)
  follows EVE's module rules. On applies at the next 1 s tick. Off lets the
  running cycle finish and stops at its end, rounded up to a tick: 10 s for an
  MWD, 7.5 s for an AB with Afterburner V, 20 / 15 s on capitals (`stopsIn`
  counts down). On while stopping keeps it running; off while activating cancels
  it. A `fleet` selects every ship holding a position in it (FC, wing
  commanders, squad members), a `wing` its commander and its squads' members, a
  `squad` its members. Ships fitting `"none"` are skipped; so are ships in warp
  when switching on. The switch is live only, like an order: it is not saved.
- **Flying.** A running module swaps the ball's mass and max velocity for the
  module's on both Destiny parks (`SetBallMass`, `SetMaxSpeed`, as EVE's server
  does); Destiny then accelerates or slows the ship at its agility (a TFI goes
  from 159 to 994 m/s in 20 ticks on a 500MN MWD II). Switching on while
  aligning for a warp slows the align, as in EVE. Fleet members keep following
  in formation at their own, now boosted, speeds: the switch never takes a ship
  out of formation, so switch the whole fleet to move it faster.
- **Warp.** Entering warp switches a running module off at once (`note`
  `off: entered warp`); it stays off after landing.
- **`get_state`.** `physics` is what the ship flies now: while its module runs,
  the module's mass, max velocity, signature radius (the MWD bloom) and align
  time. `propMod` gives the module (`module` as written, `name`, `typeID`,
  `kind`, `size` S/M/L/XL, `source` `sde` / `baked` / `default` and a `note`),
  `state` (`off`, `activating`, `active`, `stopping`), `cycleTime`, `since`,
  `at`, `stopsIn` and the running numbers; it is null for a ship fitting
  `"none"`. Each fleet reports `propMods` counts (`activating`, `active`,
  `stopping`, `off`, `none`).
- **The document form.** `ships[].propMod.active: true` runs the module from the
  moment the scene loads. The patch op `{ "op": "set_prop_mods", <selection>,
  "active"?, "module"? }` edits it for a selection (`module: null` removes the
  module); the page applies a change at once, like a placement, with no cycle
  wait. A timeline beat will embed the live command, validated by the pure
  `normalizePropModSwitch`.
- **Audio.** Switching on posts `ship_engine_<S|M|L|XL>_<microwarpdrive|afterburner>_3rd_on`
  on the ship's own emitter, and switching off (by a switch, the document or
  warp) posts `..._powerdown`, sized by the hull. The page runs the runtime's
  `CjsAudioMan` on tools-core's audio library (about 20 MB, fetched when audio
  turns on) through the hub's `/audio/library` and `/audio/path/<resPath>`
  routes (HTTP ranges into the sound banks), with the listener at the camera.
  Browsers allow audio only after a user gesture: it turns on with the first
  click or keypress in the tab (or at once when the tab may autoplay), and
  `?audio=off` keeps it off. `get_state.audio` reports the state, the last
  20 events posted, each with `played`, and `frameErrors` / `lastFrameError`
  when the runtime's audio frame threw (headless Chromium, 2026-10-22: a short
  burst of `setValueCurveAtTime ... overlaps` from its Web Audio backend while
  fades overlap, alternating with `setValueAtTime ... overlaps`; the page logs
  at most one line every 10 s and goes on). The trail look and the sound itself need
  a real browser to judge.
- **Not modelled:** capacitor, heat and overload, fitting restrictions (a
  freighter still gets a 500MN MWD), stacking with other modules, hull trait
  bonuses.

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
  +5 %/level prop mod speed factor; Afterburner −5 %/level afterburner cycle
  time (every AB requires it, no MWD does). High Speed Maneuvering, Fuel
  Conservation, Warp Drive Operation and Afterburner's capacitor bonus touch
  only capacitor.
- **A prop mod** (MWD or AB, as the game applies it): mass += massAddition, then
  `maxVelocity × (1 + speedFactor × thrust / mass / 100)`, and an MWD's signature
  bloom; `propModCycleTime` is its cycle in seconds. `HULL_SIZED_PROP_MODS` names
  the Tech II module for each hull size, and `BAKED_PROP_MODS` holds 13 modules'
  numbers for when the SDE is missing.
- **Not modelled:** hull trait bonuses, rigs, implants, boosters, fleet command
  bursts, heat, other modules, server tick rounding.

Base values come from tools-core's SDE at run time, through the hub: a ship
resolves to an EVE type by its `type` (a name goes through `dna/resolve`), or by
its DNA base in tools-core's DNA index (bare-hull matches, lowest type id; the
others are reported as `candidates`). `ship_stats` answers with the published
values, the max-skills stats and, with `propMod` (`"mwd"`, `"ab"`, a module
type id or a module name such as `"500MN Cold-Gas Enduring Microwarpdrive"`;
not `"none"`), the stats with it running. Module names resolve against
tools-core's propulsion module list (group 46): its `dna/resolve` cannot resolve
modules. With no SDE, a built-in module still answers, with `propModNote`.
`GET /ship-stats?dna=&type=&propMod=` gives the page the same JSON (404 unknown
hull, 409 ambiguous name, 503 no SDE), and `GET /prop-mod?module=<name or id>`
one module's numbers (404 unknown, 400 for `mwd` / `ab` / `none`, which the
caller sizes itself, 503 no SDE).
tools-core runs with `--no-sde-auto-prepare`, so the SDE build it reports
(`builds.sde` in `/eve/latest/build`) must be prepared once:
`node bin/cjs-sde-prepare.js --build <n>` in the tools-core checkout (Node 22).
A ship with all four `stats` needs no SDE.

## Fleets

A scene's `fleets` are EVE fleets: a fleet commander (FC) commands the fleet, the
fleet splits into wings, and each wing into squads. It is validated, edited by
`patch_scene`, saved and reported by `get_state`, and the page flies it: every
member keeps range on its anchor in formation behind the FC (see Follow the FC
below).

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
it (on the Destiny balls' radii, as `get_state`'s `targetDistance` reports) (default by role: logi 30,000 m, every other role 1,000 m, EVE's "anchor
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
| `add_fleet` / `update_fleet` / `remove_fleet` | `{ fleet }` / `{ fleet, set: { name?, commander? } }` / `{ fleet, withShips? }` | an old FC left holding no position leaves the fleet; `withShips: true` also removes every ship holding a position in the fleet |
| `add_wing` / `update_wing` / `remove_wing` | `{ fleet, wing }` / `{ fleet, wing, set: { name?, commander? } }` / `{ fleet, wing }` | removing a wing removes its squads |
| `add_squad` / `update_squad` / `remove_squad` | `{ fleet, wing, squad }` / `{ fleet, squad, set: { name?, role?, commander?, anchor? } }` / `{ fleet, squad }` | `add_squad` never moves ships; `update_squad` replaces `anchor` whole |
| `move_to_squad` | `{ ships, fleet, squad }` | leaves the old squad (and its command), a wing command for another wing, and another fleet |
| `remove_from_fleet` | `{ ships }` | takes ships out of every position |
| `set_anchor` | `{ fleet, squad, anchor: { ship?, range? } }` | merged; `null` resets `ship` to the FC and `range` to the role default |

`null` in a `set` clears that field. Ids and child lists cannot be set: use the
remove/add and the child ops. Removing a fleet, wing or squad keeps its ships in
the scene, unless `remove_fleet` has `withShips: true`. `add_fleet_composition`
adds a whole fleet with its ships (see Fleet compositions).

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
`changes.regrouped` counts the ships whose membership changed. Each member but
the FC also reports `following` and each fleet `formation` (see Follow the FC).

### Follow the FC

Fleets fly in formation on their FC under Destiny, in the page
(`fleets/following.ts` plans; the viewer's `following.ts`, `steering.ts` and
`destiny.ts` fly them).

- **Who follows.** Every ship whose resolved anchor is set: squad members and
  wing commanders outside squads, never the FC. It keeps range on exactly the
  anchor and range the rules above resolve; nothing is re-derived.
- **Slots.** Each member flies the slot the at-rest formation gives it
  (`toFleetFormationSlots`, the same placement as `layoutFleetFormation`): a
  direction from its anchor in the fleet's heading frame and a range, the
  anchor's range on the first shell, one spacing further per outer shell. Slots
  are laid out at the FC's document placement with the ships' ball radii, so a
  fleet added in formation gets its own positions back and nothing moves. A
  chained member (a logi on its lead) slots on its own anchor, in the FC's frame.
- **The frame** is the FC's heading: Destiny's legacy heading, without its
  banking roll. The fleet's heading is the FC's heading.
- **Steering.** At every 1 s tick each member's goto point is re-aimed at its
  slot on both parks, led along its anchor's velocity by Destiny's goto lag, at
  the member's own max velocity: faster ships close up and hold their slots,
  ships as fast as the FC sit about two ticks back at full speed, slower ones
  trail at their own speed. There is never a shared scripted speed.
- **Settling.** A member whose anchor is at rest, within tolerance of its slot
  and slower than 1 m/s settles: it stops (mode `stop`) and turns smoothly to the
  fleet heading. It moves again when its anchor does, or when its slot drifts
  past 1.5 × the tolerance.
- **States.** `in-formation` while the slot error is within 200 m + 5 % of the
  slot range + 2.5 s of the anchor's speed, else `catching-up`; `holding`
  (stopped, with `warping` naming the ship) while its anchor or the FC is in
  warp; `detached` after an explicit order; `waiting` until the fleet's radii
  settle.
- **Explicit orders.** Any `order_ship` movement order on a member takes it out
  of formation: it flies that order and reports `detached`. It rejoins on
  `{ "type": "rejoin" }`, on a fleet edit that regroups it, or on `load_scene` /
  `open_scene`; a placement edit leaves it detached. The FC is never detached:
  ordering it moves its fleet.
- **Edits re-plan at once.** `set_anchor`, `update_squad`, `move_to_squad`,
  `update_fleet` (a new FC), squad and wing edits, `remove_ship` and the anchor
  fallback re-plan the members on the same edit: a logi squad set to its own
  anchor and range breaks off, and rejoins when set back. A removed anchor's
  followers re-anchor through the fallback and keep flying. Ships whose following
  ends (they left the fleet, it was removed, or they became its FC) stop with an
  `orderNote`, and `changes.stopped` counts them.
- **Readiness.** A fleet is planned once every ship holding a position in it has
  a settled radius: its `/ship-stats` answer gave the hull's EVE radius, or its
  SOF build finished. With the SDE that takes a fraction of a second; without it
  the fleet waits for its builds, then re-forms to the SOF radii.
- **Placement.** A following member moved by `patch_scene` is put at rest there
  and flies back to its slot; moving the FC makes the fleet chase it.
- **`get_state`.** Each member reports `following`: `state`, `anchor`, `range`,
  `slot` (`range` and `direction`), `distance` (metres, surface to surface, to
  the anchor) and `slotError` (metres from its slot). Its `order` is
  `keep-at-range` on the anchor, and its mode is `goto` while it steers and
  `stop` once settled. Every ship reports `heading` (`[yaw, pitch]` degrees, the
  authoritative heading). Each fleet reports `formation`: `ready`, `heading`
  (the FC's), and how many members are `following`, `inFormation`,
  `catchingUp`, `holding`, `detached` and `waiting`.
- **Limits.** No collisions: ships may pass through each other while re-forming.
  Slots are rigid, so on an FC turn a far squad (logi at 30 km) swings across
  the fleet and takes minutes to get back. Fleet-level orders, fleet warp and
  prop-mod toggling are later entries.
- **On a real GPU** (the TFIs fleet, 2026-10-22). At full speed straight ahead,
  the 34 members as fast as the FC hold formation within 0.2° of its heading,
  boosters lit. The nine slower hulls (Bhaalgorns, dreads, the Apostle,
  carriers) trail at their own top speed, and the logi lead holds 30 km ± 60 m.
  A 90° turn at full speed leaves 36 of 43 catching up: the same-hull Tempest
  Fleet Issues plateau 1–2 km off their swung slots, because no member is faster
  than the FC, and the logi swings about 25 km. After a stop, 42 of 43 are back
  in formation within about 3 minutes (the Apostle last). A few members visibly
  snap round at the tick they settle (up to about 100°). Detach and rejoin fly
  smoothly.

## Fleet compositions

A fleet composition (`cjs-fleet/1`) is a doctrine fleet written once and dropped
into a scene as often as wanted: an FC, wings, and squads of hull lines with
counts, roles and anchors. Adding one to the scene already loaded is the main
use; the code is in `packages/scene/src/lib/compositions/`.

```json
{
  "schema": "cjs-fleet/1",
  "id": "tfis",
  "name": "TFIs",
  "source": "https://my.minmatar.org/ships/doctrines/13-tfis/",
  "commander": { "hull": "Tempest Fleet Issue", "dna": "mb2_t1:minmatarnavy:minmatar", "radius": 250, "name": "FC", "fit": "tfi" },
  "wings": [
    { "id": "mainline", "name": "Mainline", "squads": [
      { "id": "dps-a", "name": "DPS A", "role": "dps", "ships": [{ "hull": "Tempest Fleet Issue", "count": 10, "propMod": "500MN Cold-Gas Enduring Microwarpdrive", "fit": "tfi" }] },
      { "id": "ewar", "name": "Bhaalgorns", "role": "ewar", "anchor": { "range": 2500 }, "ships": [{ "hull": "Bhaalgorn", "count": 3 }, { "hull": "Vindicator", "count": 2 }] }
    ] },
    { "id": "logistics", "squads": [{ "id": "logi", "role": "logi", "ships": [{ "hull": "Guardian", "count": 5 }, { "hull": "Zarmazd", "count": 3 }] }] },
    { "id": "capitals", "squads": [{ "id": "fax", "role": "logi", "anchor": { "on": "logi", "range": 5000 }, "ships": [{ "hull": "Apostle" }] }] }
  ],
  "fits": { "tfi": "[Tempest Fleet Issue, [FL33T] Tempest Fleet Issue]\n..." }
}
```

| Where | Field | Rule |
| --- | --- | --- |
| top | `schema` | optional; when present `cjs-fleet/1` (a scene document passed by mistake is refused) |
| top | `id` | required: the default fleet id and ship id prefix |
| top | `name`, `description`, `source` | optional; `name` names the fleet in the scene and the saved composition |
| top | `commander` | required: the FC's ship (a line without `count`), in EVE's FC slot (in no squad) |
| top | `wings` | default `[]`; an FC-only composition is valid |
| top | `fits` | optional EFT fit text by key; each must start with a `[Hull, Fit name]` header |
| wing | `id`, `name?`, `squads` | ids unique in the composition |
| squad | `id`, `name?`, `role`, `anchor?`, `ships` | ids unique across wings; `fc` and `lead` are reserved; `role` is `dps`, `logi`, `tackle`, `ewar`, `boost` or `support` |
| line | `hull` | an exact English EVE type name or type id; becomes each ship's `type`. Omitted: the hull its fit's header names |
| line | `dna`, `radius` | the SOF DNA and the hull's EVE radius (metres); filled by `add_fleet_composition` from the EVE data when missing |
| line | `count` | 1 to 256, default 1 |
| line | `name`, `propMod`, `fit` | the ship name base; a prop mod name (or `mwd` / `ab` / `none`, or a type id), which becomes each ship's `propMod`; a key of `fits` |

A line needs a `hull`, a `dna` or a `fit`; a string `hull` must match its fit's
header. Everything is validated together, unknown keys warn and are dropped,
and values are kept as written (a saved composition reads back as written). A
composition holds at most 256 ships with the FC, EVE's fleet size.

**Anchors.** A squad's `anchor` is `{ on?, range? }` (metres, surface to surface):

| `on` | Means | Scene anchor written |
| --- | --- | --- |
| `fc` (default except logi) | every ship keeps `range` (default 1,000 m) on the FC | `{ range }`, or none |
| `lead` (logi default) | the squad's first ship keeps `range` (default 30,000 m) on the FC; the rest anchor up on it at 1,000 m | `{ ship: <first ship>, range? }` |
| a squad id | every ship keeps `range` (default the role's) on that squad's first ship | `{ ship: <its first ship>, range? }` |

These are exactly the anchors the Fleets rules resolve; nothing is re-derived.

**Formation.** Ships are placed at rest (`fleets/formation.ts`): each one on a
shell at exactly its anchor range, trailing the FC's heading (the trailing pole
first, then a Fibonacci sphere's trailing hemisphere), on an outer shell when
the inner one is full. No two ships sit closer than `1.5 x (r1 + r2) + 100 m` on
their EVE radii (500 m for a hull whose radius is unknown, with a warning).
Positions are whole metres, every ship faces the heading, and the same input
gives the same layout. Follow the FC flies these slots. Existing scene ships are
not avoided: a warning names any new ship landing within 500 m of one.

**Ids and names.** The fleet is the composition's `id` (`tfis`), or `tfis-2`,
`tfis-3`, ... when that fleet or any of its ship ids is taken; pass `fleet` to
pick one. Ships are `<fleet>-fc` and `<fleet>-<squad>-<nn>` (`tfis-dps-a-01`,
`tfis-logi-08`). The FC is named `FC` (or the commander's `name`); the others
take the line's `name` or hull, numbered within their line when it adds more
than one (`Tempest Fleet Issue 7`, `Zarmazd 3`).

**Hull names and DNA.** A line's own `dna` and `radius` always win. The
`add_fleet_composition` tool looks up each distinct hull missing either through
tools-core's SDE (`dna/resolve`, the SDE `radius`), so `"hull": "Zarmazd"` is
enough when the SDE is prepared; it reports `hulls` with where each value came
from (`composition`, `sde` or `default`). A hull it cannot resolve is refused
when its line has no `dna`, and a line whose `dna` names another SOF hull than
the EVE data warns. The `add_fleet_composition` patch operation is pure: it
needs `dna` on every line and says to use the tool otherwise. The TFIs example
carries both on every line, so it needs no tools-core.

**Prop mods.** A line's `propMod` becomes each of its ships' `propMod` module.
A line with a `fit` and no `propMod` takes the first fitted microwarpdrive or
afterburner of its EFT text (cargo and drone `xN` lines skipped, `/OFFLINE` and a
charge dropped), or `"none"` when the fit has neither (the TFIs Revelations and
Apostle); a line with neither flies the hull-sized MWD. `add_fleet_composition`
checks each distinct module name against the EVE data and reports `propMods`
(`module`, `typeID`, `from`: `sde`, `unknown` or `unchecked`); an unknown name
warns, and those ships fly the hull-sized default.

**Adding to the live scene.**

```sh
node bin/scene-director.js call add_fleet_composition '{"name":"tfis","position":[0,0,80000],"heading":180,"team":"blue"}'
```

`position` is the FC's; `heading` is yaw degrees (0 faces +Z, 90 faces +X), or
pass `facing` (a point) instead; `fleet` and `team` are optional. The result is
the `patch_scene` result plus `added` (`fleet`, `commander`, `ships`),
`hulls` and `propMods`. Pass `scene` (e.g. `{ "name": "tfis-battle" }`) to add to that document
instead, with no tab: the result is returned, not shown (`load_scene` or
`save_scene` it). The raw operation is
`{ "op": "add_fleet_composition", "composition", "position", "heading"? | "facing"?, "fleet"?, "team"? }`
and composes with other ops in one patch. Take the fleet out again with
`{ "op": "remove_fleet", "fleet": "tfis", "withShips": true }`, and look at it
with `frame_camera { "target": "tfis-fc" }`.

**Saved compositions.** `save_fleet_composition` writes one JSON file per
composition (named like saved scenes) to `--fleets <dir>` or
`SCENE_DIRECTOR_FLEETS`, by default `scene-director/fleets` in the per-user data
directory; `viewer_status` reports it as `fleetsDirectory`. A composition saves
under its `name`, else its `id`. The built-in examples are listed too
(`store: "example"`) and are read-only; a saved composition of the same name
shadows one. `call` imports and exports them: `--in` fills `composition` for
`save_fleet_composition` and `add_fleet_composition`, and `--out` writes the
composition `get_fleet_composition` returns.

**The TFIs example** (`compositions/examples/tfis.json`, name `tfis`) is the
close-range armor doctrine of
[my.minmatar.org](https://my.minmatar.org/ships/doctrines/13-tfis/), with its 13
`[FL33T]` EFT fits. The page gives no counts; this example chooses 44 ships:

| Wing | Squad | Role | Ships | Anchor |
| --- | --- | --- | --- | --- |
| (FC slot) | | | 1 Tempest Fleet Issue "FC" | |
| Mainline | `dps-a`, `dps-b` | dps | 10 Tempest Fleet Issue each | FC, 1,000 m |
| | `ewar` (Bhaalgorns) | ewar | 3 Bhaalgorn, 2 Vindicator | FC, 2,500 m |
| | `tackle` (HICs) | tackle | 2 Devoter | FC, 1,000 m |
| | `boost` (Boosts) | boost | 1 Damnation, 1 Eos | FC, 1,000 m |
| Logistics | `logi` | logi | 5 Guardian, 3 Zarmazd | own lead, 30,000 m off the FC |
| Capitals | `dreads` | dps | 2 Revelation | FC, 10,000 m |
| | `fax` | logi | 1 Apostle (active fit) | the logi lead, 5,000 m |
| | `carriers` | support | 1 Thanatos, 1 Nidhoggur, 1 Archon | FC, 15,000 m |

DNA and radius were checked against tools-core's SDE build 3632936. The Buffer
Apostle and the secondary (L3ARN) fits are left out.

**Not applied yet.** The fits beyond their prop mod (Turrets) and arriving from
warp (Fleet warp-in) are stored or planned, not played: added fleets start at
rest in formation, prop mods off, and follow their FC from there
(`switch_prop_mods { "fleet": "tfis", "active": true }` runs every module).

**On a real GPU** (2026-10-22, Windows Chrome, NVIDIA): adding `tfis` to a live
scene built all 44 hulls in 4–5.5 s, at 38–49 fps during the build. Every hull
draws intact and lit, and the capitals clearly dwarf the battleships. At rest
the page draws 45 ships at about 46 fps and 25–50 fps in flight, with no GPU
errors. No meshes intersect in formation, although 14 Tempest Fleet Issue pairs
(850–870 m apart) overlap as drawn bounding spheres.

## Locations

A scene can sit at a real EVE place. `location` names the solar system and the
point in it that the scene's `[0, 0, 0]` sits on:

```json
"location": {
  "system": 30000142,
  "name": "Jita",
  "region": "The Forge",
  "origin": [-107303331552.681, -18744969943.288, 436488926028.301],
  "anchor": {
    "celestial": 60003760,
    "name": "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    "kind": "station",
    "offset": [31007.319, 5416.712, -126131.699]
  }
}
```

That is 30 km off the Caldari Navy Assembly Plant at Jita IV - Moon 4, toward
the sun. `origin` is in system metres: float64, the system's star at
`[0, 0, 0]`, Y up, +Z forward, right-handed (tools-core's map frame). Scene axes
are the system's axes, so a location only translates. `origin` is authoritative;
`anchor` is provenance (the celestial the origin was placed from and the offset
from its centre, as set), and editing `origin` by hand does not update it.
`system` and `celestial` are EVE ids; names are for people. Every coordinate is
bounded at 1e15 m, which refuses a galactic position (1e16-1e17 m) passed by
mistake. Ships stay in scene metres around the origin.

Two patch operations edit it: `{ "op": "set_location", "location": { ... } }`
replaces it whole (a new origin never keeps a stale anchor), and
`{ "op": "clear_location" }` removes it (a no-op without one). A location
change moves the scene in its system, not the ships in the scene.

The hub's tools fill it from names, over tools-core's map routes:

```sh
node bin/scene-director.js call search_map '{"query":"Perimeter","kinds":["stargate"]}'
node bin/scene-director.js call get_system '{"system":"Jita","kinds":["stargate"]}'
node bin/scene-director.js call set_location '{"celestial":"Jita IV - Moon 4 - Caldari Navy Assembly Plant","range":30000}'
node bin/scene-director.js call set_location '{"celestial":"Perimeter gate","system":"Jita"}'
```

`set_location` resolves the celestial, computes the origin and forwards one
`patch_scene` to the tab; with `scene` it edits that document instead, with no
tab (`loaded: false`). With `origin` and `system` it places the scene with no
celestial. `range` is metres off the celestial's surface, on its EVE radius
(the map row's radius for bodies, the type's SDE radius for stations and
stargates); `direction` is from the celestial toward the origin; `offset`
(metres from its centre) replaces both. These defaults frame a scene; they are
not EVE's warp-in points:

| Kind | Default range | Default direction |
|---|---|---|
| star, planet, moon | one radius (the body spans 60°) | `"sun"` (toward the star; the star itself: +Z) |
| station | 5,000 m | `"sun"` |
| stargate | 2,500 m | `"sun"` |
| asteroid belt | 0 m from the belt's centre (it is not solid) | `"sun"` |

`direction` is also `"away"` or `[x, y, z]`.

**Names.** In order: the exact name; a name inside `system` (`"IV - Moon 4"`,
`"Star"`, a unique part such as `"Business Tribunal"`); `"star"` or `"the sun"`;
a gate shorthand (`"Perimeter gate"`, `"the gate to Perimeter"`); and
`"<celestial> in <system>"` (`"the Perimeter gate in Jita"`). Without `system`,
a name is tried as an exact name across the map, then as that phrase, then by
taking the longest leading words that name a system (`"Jita IV - Moon 4"`,
`"New Caldari V - Moon 1"`): tools-core's map search does not index moons or
asteroid belts. Stargates are named after their destination, so
`"Stargate (Perimeter)"` without `system` is ambiguous (five systems have one).
An ambiguous name lists the candidates; there is no player slang (`"Jita 4-4"`).

**Nebula.** A located scene draws its region's nebula (The Forge's is
`res:/dx9/scene/universe/c02_cube.black`), swapped in live without a reload;
`environment.universe` stays the nebula for a scene with no location, and
clearing the location brings it back. `set_location` only sets the location
(its result names the region nebula; a passed `nebula` argument is ignored with
a warning). A change of `environment.universe` itself still reloads the tab.

**The page.** It fetches its location's system from the hub's
`GET /map/system?id=<system>&origin=<x>,<y>,<z>`: the system, its star (light
and model), the region's nebula and every celestial with graphics and stargate
rotations, positions relative to the origin, nearest first. The hub does the
float64 subtraction, so the page only sees origin-relative metres and float32
holds. `get_state.location` reports the system, the origin, the fetch status,
the anchor's actual distance and surface distance, the star's distance and
direction, and the ten celestials nearest the origin; the overlay shows one
`location` row.

**Dressing.** The page dresses the scene from the location the way the client
dresses a system (`packages/scene/src/lib/location/dressing.ts` plans it,
`apps/viewer/src/lib/location-dressing.ts` draws it):

- The star: the light direction from the origin toward it (a sun ball), its sun
  disc in the planet pass, its environment template as the post process
  (`env_<sun graphic>`, else the `_01a` variant, else `env_sun_yellow_01a`) and
  its lens flare (the graphic minus `sun_` and the variant; the Triglavian suns
  have their own), the flare on a curve at the star's true distance.
- Planets and moons whose radius / distance is at least 5e-4 (about 3 px across
  a 1920 px, 45° view), biggest first, at most 12, from their shader presets at
  their real directions and angular sizes. The planet pass clips at 1e11 m, so a
  body beyond 5e9 m is pulled in on a log curve with its radius scaled to keep
  its angular size. An origin inside a body skips it. A template's
  `res:/texture/global/black.dds` HeightMap (the client's bake target) gets the
  celestial's heightMap1.
- NPC stations and stargates whose SDE radius / distance is at least 3e-4, at
  most 8, as static SOF objects at their true origin-relative positions: gates
  turned by tools-core's quaternion to face their destination, stations
  unrotated (tools-core serves no station rotation). They are not Destiny balls
  and not order targets. The camera's back clip grows to cover the farthest.
- Everything is placed from `/map/system`'s origin-relative metres. Changing the
  location re-dresses the live scene (same celestials move, new ones build, gone
  ones retire); clearing it undresses. A body's surface under 10 km from the
  camera is cut by the planet pass's near plane.

`get_state.location.dressing` reports the state (loading, ready, partial,
failed, off), the nebula, the sun (graphic, template, flare, true and drawn
distance), counts per kind (drawn, validated without a renderer, loading,
failed, skipped) and every dressed planet, moon, station and gate with its
state and error; `get_state.environment.nebula` says which nebula is drawn and
whether it comes from the location or `environment.universe`. The overlay shows
a `dressing` row. `?dress=off|all|<nebula,sun,planets,objects>` switches the
parts for A/B checks.

**Not drawn.** Asteroid belts and authored objects (their own entries),
player-built structures, and celestials too small to see. The data is CCP's
static data (tools-core's map routes over the public SDE; no ESI, no API key).

## Building scenes: add_ships and stage_engagement

Two hub tools build a battle in a few calls. The hub resolves every name first: hull names to SOF DNA and the
hull's EVE radius (tools-core's SDE, as `add_fleet_composition` does), compositions by name, celestials of the
scene's location to scene points, and the EVE radii of a fleet the ships join. Then it sends **one pure patch
operation** of the same name to the tab (`patch_scene`), or applies it to a passed `scene` with no tab. The ops live
in `packages/scene/src/lib/staging/` and take every ship line with its `dna`.

```bash
node bin/scene-director.js call add_ships '{"hull":"Rifter","count":10,"formation":"wedge","near":{"ship":"tfis-fc","range":20000},"facing":"tfis-fc","team":"red"}'
node bin/scene-director.js call stage_engagement '{"sides":[{"composition":"tfis"},{"ships":[{"hull":"Ferox","count":20},{"hull":"Scimitar","count":4}]}],"range":20000,"near":{"celestial":"Jita IV - Moon 4 - Caldari Navy Assembly Plant","range":40000}}'
```

**Templates.** `add_ships` is a shortcut for a one-line fleet template: its result's `template` is the `cjs-fleet/1`
composition of what it added (the first ship the FC, the rest one squad). `save_fleet_composition` stores it under a
name, and `add_fleet_composition` and `stage_engagement` sides spawn it by that name.

### Formations

Ships outside fleets stand in a shape laid out in the heading frame (x right, y up, z forward), the **lead** (the first
ship, number 01) at the place. `s` is the spacing; `centreOut` is 0, +1, −1, +2, −2, ...

| Formation | Ship k | The place is |
|---|---|---|
| `sphere` (default; `blob`) | shells at `i·s` around the lead, `ceil(40·i²)` Fibonacci candidates each, trailing pole first; a candidate is kept when it is at least `s` from every kept ship (256 ships fit in 4 shells) | the centre |
| `line` (abreast) | `(s·centreOut(k), 0, 0)` | the line's centre |
| `column` (astern) | `(0, 0, −k·s)` | the head |
| `wedge` (a V) | arm `a = ceil(k/2)`, right for odd k: `(±a·s·sin45°, 0, −a·s·cos45°)` | the tip |
| `grid` (block) | `w = ceil(√N)` abreast per rank, ranks behind: `(s·centreOut(k mod w), 0, −floor(k/w)·s)` | the front rank's centre |
| `wall` (upright) | `w = ceil(√N)` per row, rows up and down: `(s·centreOut(k mod w), s·centreOut(floor(k/w)), 0)` | the centre |

Positions are rounded to the metre; every ship faces the heading (yaw only). The default spacing is fleets' rule for
two of the hull, `ceil(1.5 × 2r + 100)` (Rifter 193 m, TFI 850 m); an unknown radius counts as 500 m with a warning, and
a `spacing` under `2r` warns that the ships overlap. A mixed ship list uses the largest radius.

### Places and headings

- `position` [x, y, z] is the lead's place, or `near { ship | celestial, range?, direction? }`:
  - off a **ship**, `range` (default 5,000 m) is surface to surface on both EVE radii. `direction` is `ahead` (the
    default), `behind`, `left`, `right` (the ship's own heading), `above`, `below`, `sun`, `away` (need a location),
    `origin` or `[x, y, z]`. A ship is used at its **document placement**, not where it has flown since.
  - off a **celestial** of the scene location's system (named as `set_location` names them inside a system, or by id),
    `range` is off its surface with `set_location`'s defaults by kind, and `direction` is `sun` (the default), `away`,
    `origin` or `[x, y, z]`. A scene with no location is refused.
- `heading` is yaw degrees (0 faces +Z, 90 faces +X), or `facing`: a point, a ship id or `{ celestial }` (a target
  straight above or below is refused). Default: the near ship's heading, else 0.

### Fleets

| `fleet` | Does | Placement |
|---|---|---|
| `{ "new": true, "id"?, "name"?, "squad"? }` | a new fleet from an inline composition: the first ship is the FC ("FC"), the rest one squad (id its role) in `wing-1`; fleet id `id` (refused when taken), else the prefix, numbered when taken | the FC at the place, facing the heading; the rest at their slots |
| `{ "id": "<fleet>", "squad": "<squad id>" }` | joins a squad (`move_to_squad`) | at their Follow-the-FC slots around the FC's document placement |
| `{ "id": "<fleet>", "squad": { "id"?, "role"?, "anchor"?, "name"? }, "wing"? }` | a new squad (id its role, numbered `logi-2` when taken) in the fleet's **last** wing (`wing-1` is made for a wingless fleet) | at their slots |

- The squad role defaults from the hull's EVE group: Logistics, Logistics Frigate and Force Auxiliary are logi;
  Interdictor, Heavy Interdiction Cruiser and Interceptor tackle; Electronic Attack Ship and the Recons ewar; Command
  Ship and Command Destroyer boost; Carrier and Supercarrier support; the rest dps (raw ops default to dps). Anchors
  take the composition form `{ on?: "fc" | "lead" | "<squad id>", range? }` with the composition defaults.
- Fleet members never stand in a shape: Follow the FC would fly them straight to their slots. So joins refuse
  `formation`, `spacing`, `position`, `near`, `heading` and `facing`, and a new fleet refuses `formation` and `spacing`.
- **Joining a squad re-plans the fleet**: slots go in wing, squad and member order, so later squads on the same shell
  move (TFIs `dps-a` + 2 moves 14 members by up to 3.5 km). The op warns with the count; a new squad in the last wing
  moves nobody. A fleet holds at most 256 ships.

### Ids and names

Free ships and joins take `<prefix>-<nn>` ids after the highest number already used with the prefix (at least two
digits). The prefix is `prefix`, else the slug of the name or hull (`tempest-fleet-issue`), or `<fleet>-<squad>` when
joining. Names are `<name or hull> <n>`. `type` is the canonical SDE name; `team`, `stats` and `propMod` go on every
ship. New fleets take the composition ids (`<fleet>-fc`, `<fleet>-<squad>-<nn>`).

### Engagements

- Exactly two sides; side A faces `heading`, side B faces back. Each side's **front** is how far its ships reach ahead
  of its reference (FC or lead), laid out at the origin. Side A's reference sits at `C − f·(range/2 + front_A)` and side
  B's at `C + f·(range/2 + front_B)` (`f` forward along the heading), so the fronts are exactly `range` apart around
  `C` (TFIs against 8 Ferox + 2 Scimitar at 20 km: FCs 20,465 m apart).
- A side is a `composition` (inline, saved or built-in; always a fleet) or `ships: [{ hull, count?, role?, name?,
  propMod?, dna?, radius? }]`: a fleet whose FC is the first ship and whose lines are squads in `wing-1` (ids their
  roles, `dps`, `dps-2`), or with `fleet: false` free ships in `formation` (`spacing` and `prefix` too; ids
  `<team>-01`, ...). Fleet ids: the side's `fleet`, else the composition's id, else the team.
- The result's `engagement` lists per side its team, fleet, commander, ships and lead.

### Defaults

| Argument | Default |
|---|---|
| `count` | 1 (at most 256 per call or side) |
| `formation` | `sphere` (ships outside fleets) |
| `spacing` | `ceil(1.5 × 2r + 100)` m (r the hull's EVE radius; 500 m when unknown) |
| place | `[0, 0, 0]` |
| `near.range` | 5,000 m off a ship; off a celestial as `set_location` (station 5 km, gate 2.5 km, star/planet/moon one radius, belt 0) |
| `near.direction` | `ahead` off a ship, `sun` off a celestial |
| heading | the near ship's yaw, else 0 |
| team | none (`add_ships`); `blue` / `red` (`stage_engagement`) |
| role | from the hull's EVE group, else `dps` |
| engagement `range` / centre / heading | 20,000 m between fronts / `[0, 0, 0]` / across the line from `near`, else 0 |
| prefix | the hull name's slug; `<fleet>-<squad>` when joining; the team for free engagement sides |

The raw ops (`patch_scene`): `{ "op": "add_ships", "dna", ..., "radii"?: { "<ship id>": metres } }` and `{ "op":
"stage_engagement", "sides": [...], ... }` take the same fields with every line's `dna` filled; they accept
`near.ship` and a ship id for `facing` against the draft (so one patch can stage off a ship it just added), and refuse
celestials and hull names without dna. **Limits**: placements read document positions, not live ones; 256 ships per
call or side; yaw only.

## Development

```sh
npx nx run-many -t lint typecheck build test       # what the commit gate runs; tests are offline
npx nx run scene-director:verify-page              # the real page in headless Chromium against a running tools-core
npx oxfmt --write .                                # formatting
```

Headless Chromium usually has no WebGPU adapter, so `verify:page` checks
everything but drawing: SOF builds from real data, edits, storage and reload.
It launches Chromium with `--autoplay-policy=no-user-gesture-required`, so the
page turns audio on by itself and the prop mod check sees the engine events
posted (it cannot hear them).

Drawing is checked in a real Chrome or Edge tab through `get_state`,
`screenshot` and `page_log`:

- `get_state.environment` reports the background: the nebula effect and each of
  its textures (state, format, cube), the scene dressing (below), and
  `backgroundQuad.drawn`, which grows each frame the nebula is drawn.
- `get_state.renderer.gpuErrors` counts WebGPU's uncaptured errors (validation,
  out-of-memory, internal), and each distinct message also goes to `page_log`.
- Page URL switches for A/B checks: `?post=off|<template>` (the sun environment
  template under `res:/dx9/postprocess/environmenttemplate/`; default the
  location star's, else `env_sun_yellow_01a`), `?flare=off|<name>` (under
  `res:/fisfx/lensflare/`; default the star's, else `yellow`), a named one
  overriding the star's; `?dress=off|all|<nebula,sun,planets,objects>` (the
  location dressing's parts, all by default), `?aa=off` (no TAA),
  `?fog=on` (keeps the template's distance fog, dropped by default: on the GPU
  it fogs planets as background so they read translucent, washes the frame in
  its colour and draws a flat haze around the origin that a far camera sees as
  a glowing disc; `environment.dressing.fog` reports it) and `?tier=lo|hi` (the
  shader tier, default `depth`).

## Runtime notes

- `apps/viewer/src/lib/runtime.ts` is the single import point for the runtime,
  and `carbonenginejs-runtime.d.ts` beside it types those imports (the runtime
  ships no declarations). The WebGPU render context is internal to the runtime
  package and is reached through the `runtime-dist/` alias that
  `apps/viewer/esbuild.config.mjs` resolves.
- The bundle ignores the runtime's `sideEffects` list: many listed files
  register classes on import, and dropping them breaks Black reading.
- Celestials draw in the scene's planet pass (`scene.planets`, at 1 / 1e6 scale,
  clipped to 1e4 .. 1e11 m) before the main pass. The sun disc is the planet
  whose translation curve is the very object in `scene.sunBall`, which also
  sets the light direction each frame.
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
  (`clock.ts`, `destiny.ts`, `warp.ts`, `boosters.ts` and the others) import only `runtime-sim.ts`, so their specs never
  load the renderer. The server's types are in `carbonenginejs-server.d.ts`.
- Speed chain: the ClientBall's velocity is `EveSpaceObject2.worldVelocity`
  (`UpdateWorldTransform`), `EveShip2.UpdateSyncronous` sets `speed.value` from
  it, and `EveBoosterSet2Renderable.CalculateIntensity` divides it by
  `boosters.maxVel`; `Director.DriveBoosters` sets that per ship each frame.
- The esbuild plugin fails the build if any `@carbonenginejs/runtime` import,
  the server's included, resolves outside the page's runtime copy: a nested
  second copy would duplicate every class.
- Audio (`apps/viewer/src/lib/audio.ts`) is the runtime's `CjsAudioMan` with a
  media provider over the hub's `/audio/path` route (the runtime's own provider
  lives in its demo, not the package). It enables every sound bank, as the demo
  does: PostEvent is gated on bank status, and media is read per event, with
  HTTP ranges into the banks. Emitters start culled, so a fresh emitter's first
  event plays when the next audio frame wakes it in range. The SOF ships' own
  audio emitters (the engine hum) stay inert: nothing adopts their graphs yet.

## EVE content

The code is MIT. EVE's content is not: using it means accepting CCP Games'
[EVE Online Content Creation Terms of Use](https://support.eveonline.com/hc/en-us/articles/8563917741084-EVE-Online-Content-Creation-Terms-of-Use).
Work made from EVE content must be non-commercial and carry CCP's disclaimer.
EVE Online and all related assets are the property of CCP hf. This project is
not affiliated with or endorsed by CCP Games or Fenris Creations.
