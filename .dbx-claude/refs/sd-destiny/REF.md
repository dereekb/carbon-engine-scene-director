# Destiny in the page: parks, clock, orders, placement

> Every document ship flies as a Destiny ball (`@carbonenginejs/server`), and the ball drives the drawn ship's
> translation and rotation curves. Fetch before touching `apps/viewer/src/lib/destiny.ts`, `clock.ts`, `main.ts`'s
> loop, `flight.ts`, `packages/scene/src/lib/orders.ts`, or anything that moves a ship. Sub-docs (`dbx-claude-ref`
> `{ ref: "sd-destiny", doc: "<key>" }`): **`warp`** (warp orders, phases, refusals) and **`boosters`** (the per-frame
> booster drive). Formation steering is `sd-fleets`; prop mod physics is `sd-ship-stats`.

## Files

| File | Role |
|---|---|
| `apps/viewer/src/lib/destiny.ts` | `DestinyWorld`: the **only** code that touches the parks. Ships, static object balls, orders, warp, following, prop mod state |
| `apps/viewer/src/lib/clock.ts` | the scene clock: one integer 100 ns tick count both parks and the renderer sample |
| `apps/viewer/src/main.ts` | the single rAF loop |
| `apps/viewer/src/lib/flight.ts` | each ship's flight numbers (Ship stats from the hub's `/ship-stats`) |
| `apps/viewer/src/lib/warp.ts` | warp factor, landing, Destiny's warp-profile math |
| `apps/viewer/src/lib/boosters.ts` | the booster drive |
| `apps/viewer/src/lib/steering.ts` | Follow the FC's steering math (`sd-fleets`) |
| `packages/scene/src/lib/orders.ts` | `order_ship` request normalization (`normalizeShipOrderRequest`) |
| `apps/viewer/src/lib/carbonenginejs-server.d.ts` | the server's types |
| specs | `destiny.spec.ts` (1.4k lines), `destiny-ship.spec.ts`, `destiny-tackle.spec.ts`, `clock.spec.ts`, `warp.spec.ts`, `boosters.spec.ts`, `flight.spec.ts` (node, `runtime-sim` only) |

## The two parks (must stay in lockstep)

- The **master** park holds the authoritative `CjsDestinyBall` state that `get_state`, distances and framing read. The
  **replica** park creates `CjsDestinyClientBall`, the renderer curve (server `docs/destiny-client-curves.md`): it
  interpolates, samples two ticks back and damps rotation like EVE's client.
- **Replication (the server ticker) is unported.** So only `DestinyWorld` touches the parks, every state change goes to
  both in **one call** (`Both`), movement orders apply to both right before the `OnTick` that evolves, and both get
  `OnTick` with the same clock value. They stay bit-identical. Never reach into one park alone.
- Absolute coordinates: the replica's ego is a fixed ball at the origin, so ClientBall samples are world positions.
  Ship balls take ids from `FIRST_SHIP_BALL_ID` up and never reuse one.

## One clock, one loop

`main.ts` owns the single rAF loop, in this order:

`clock.Advance` → `world.Tick(now)` → `director.DriveBoosters(now)` → `director.TrackCamera(now)` →
`director.DriveAudio(now)` → `engine.Frame(timestamp, now)`

- `OnTick` and `driver.Execute` get the **same integer `now`**.
- The clock caps a frame at **1 s**, so the master's 6-tick backlog drop never fires and a hidden tab pauses rather
  than fast-forwards. Follow the FC relies on this: one evolve per `Tick` call.
- The loop runs without WebGPU too, so headless checks see ships move.

## When things apply

- **Add, remove, place and physics apply at once** (they teleport).
- **Movement orders wait for the next 1 s tick boundary**, as EVE applies commands before a tick, so the interval a
  ClientBall is interpolating is never disturbed. The drawn ship trails the reported state by up to a tick.
- At a due boundary the order is: prop mods (`ApplyPropMods`: delayed switches due now, then the numbers) →
  `OnBoundary` listeners (the fitted modules' cycles, `sd-fittings`; a siege or triage module's, a web's or a painter's
  `SetPhysics` and a point's or scram's `SetTackle` land here with the re-fly, so a point landing on the boundary a
  warp would begin wins) → pending orders (`ApplyOrder`; a delayed one waits for its boundary) → formation warps (`ApplyFormationWarps`, sd-fleets
  sub-doc `orders`) → `Steer` (following) → evolve.
- **Pilot delay**: `Order(id, order, { delay })`, `WarpInFormation(…, { delay })` and `SwitchPropMod(id, on, { delay })`
  take whole ticks (a fleet order's per-pilot response, `toPilotDelays`). A delayed order stays `pendingOrder` with
  `respondsIn` until its boundary; a new order replaces it. A formation warp also waits for its leader's own pending
  order to apply.

## Orders (`order_ship`)

| Order | Destiny call | Behavior (max-skills frigate, about) |
|---|---|---|
| `direction` | `GotoDirection` | 75 % of max velocity after `ceil(alignTime)` ticks |
| `goto` | `GotoPoint` | creeps to a halt tens of metres short (mode stays `goto`) |
| `approach` | `FollowBall` at 50 m | balls may overlap slightly (no collisions) |
| `keep-at-range` | `FollowBall` at range | ±3 % on a stationary target; trails a moving one (+33 % at 1 km behind 130 m/s) |
| `orbit` | `Orbit` | ~5 % wide at 5 km; tight orbits on fast ships run much wider (500 m → ~890 m), as in EVE. Legacy orbit algorithm |
| `warp` | `WarpTo` | see sub-doc `warp` |
| `stop` | `Stop` | decelerates to a halt |
| `rejoin` | (formation steering) | a detached fleet member flies back to its slot; refused for the FC and non-members |

- `speed` is a fraction of max velocity in (0, 1], default 1. Ranges are metres **surface to surface on the balls'
  radii**. A target is another ship, an object id, or `celestial:<id>` (the location's stations and gates):
  `TargetEntry` looks among ships, then object balls. Fleet anchors stay ships.
- **Another bubble is refused up front.** Destiny's bubbles are connected 7,864 km top cells, and `FollowBall` / `Orbit`
  refuse a target in another bubble **on the master only** (a replica has no bubbles), so the parks would diverge until
  the mode check halts the ship. `OrderRefusal` compares the master balls' `mNewBubble` for approach, keep-at-range and
  orbit (ships too) and refuses with "… in another Destiny bubble; warp to it first". Warp is never refused for it.
- **Destiny's `FollowBall` / `Orbit` / `GotoPoint` return silently, keeping the old order**, for a missing, self,
  moribund or cloaked target, a target in another bubble (master only) or a non-finite value. `DestinyWorld` resolves
  the target itself and checks that **both** parks reached the order's mode, or stops the ship on both (`orderNote`
  says so).
- `get_state` per ship: `order` (what the ball flies), `pendingOrder`, `orderNote`, `targetDistance`, `heading`
  (`[yaw, pitch]`), `physics`, `mode`.
- **Orders are live only**: never written to the document. A new position/rotation, `load_scene`, `open_scene` end a
  ship's order; a re-placed target keeps its followers, which chase it.

## Removing a ship

Destiny's `RemoveBall` sends an interactive orbiter straight on along its velocity and stops other followers.
`DestinyWorld.RemoveShip` **stops every follower of the removed ship first**, so all stop and the parks stay identical
(`patch_scene`'s `changes.stopped` counts them). Formation followers are the exception: `FleetFollowing.Reconcile`
re-anchors them in the same edit, and `Steer` halts any whose anchor or FC ball is gone.

## Static object balls (`sd-objects`)

`AddObject(doc, radius)` adds one ball per document object (and per celestial target) on **both** parks, from the ship
ball counter: mass `OBJECT_BALL_MASS`, **not free, not massive, not interactive**, at rest. Nothing collides: ships are
non-massive too (a level-3 follow-up covers collisions). Calling it again for a known id re-places (`PlaceObject`) and
resizes (`SetObjectRadius`) the ball; an id a ship holds throws. The radius is `ObjectBallRadius` (`objects.ts`): the
document's radius (add_objects fills the SDE's, or a wreck's model radius: `sd-objects`), else the SOF bounding radius
once built, else 1,000 m. `Director.Apply` adds missing balls and
re-adds moved, resized and rebuilt ones before the store write, so an order arriving meanwhile always finds the ball.

`RemoveObject(id)` mirrors `RemoveShip`: a pending order on the object is dropped and its ship halted, an applied
approach, keep-at-range or orbit halts (`orderNote` "stopped: target … was removed", counted in `changes.stopped`),
and an applied warp flies on. A moved object keeps its followers, which chase it. `ObjectBall` reports the master's
ball for `get_state.objects`.

## Placement (teleports)

- A ship at rest faces its document rotation exactly (seeded along the document forward vector; `BallRotation`
  multiplies in the remaining attitude, its roll); under way it faces its velocity, keeping the document's roll.
- **A placement must restart the ball's tick interval** (`RestartInterval`). Between ticks a ClientBall integrates from
  the interval's start with the ball's last forces (`mLastG` + `mLastC`) and turns from the interval's old heading,
  which the heading snap keeps (`mOldYaw`). Without it a ship placed mid-tick at full speed slid on along its old
  thrust, popped back at the next tick and swung back toward its old heading. (The old spec placed right after a tick
  boundary and missed it: test mid-tick.)
- Destiny's heading snap (`SetBallVelocity`) keeps the ClientBall's banking roll, so a teleported ship's roll levels
  out over a few seconds (as the client does).
- A ClientBall caches its sample per time: a teleport shows from the next frame.
- A fresh park's first ~3 ticks freeze a ClientBall's drawn rotation (no two-tick history yet), then jump: specs that
  measure drawn smoothness skip them.
- `PlaceShip` keeps prop mod state and tackle; it ends an order and ends a warp at once, at rest.

## Tackle (`SetTackle`, points and scrams)

`SetTackle(id, { warp, propMod })` / `Tackle(id)`: the director's reasons (`sd-fittings` "Target effects": `warp` when
the ship's warp scramble status is above 0, `propMod` when a running scram blocks the MWD it flies), set in `FlyFlight`
right after `SetPhysics`, so every re-fly and retune refreshes it. DestinyWorld only enforces them, on both parks:

- **Refusals**: `OrderRefusal`'s warp branch checks tackle first: `ship "x" cannot warp: <warp>` (`order_ship` throws
  it; an `order_fleet` warp led by a tackled leader is refused; the max-velocity-0 refusal stays below it, so a sieged
  ship's refusal now names its own siege module's +100). `PropModRefusal(id, true)`: `ship "x" cannot switch its prop
  mod on: <propMod>`, which `switch_prop_mods` and `switch_modules`' prop row skip with.
  `SetPropModActive(id, true)` stays off with note `not switched on: <propMod>`, and `ApplyPropMods` drops a delayed
  switch-on due at its boundary with note `not switched on: <the refusal>`.
- **Pending warps**: `ApplyOrder` drops a pending or delayed warp found tackled at its boundary (`orderNote` `dropped:
  the warp order (<warp>)`); the ship keeps its current order. `SetTackle` with `warp` drops one at once the same way.
- **Aligning warps**: `SetTackle` with `warp` cancels a warp still aligning (no proper-warp start yet): a plain ship
  gets a `direction` order along (landing − position) at speed 1 through `ApplyOrder` (both parks), so it flies on,
  `orderNote` `warp cancelled: <warp>`. A formation-warp member drops its formation warp (`dropped: its formation warp
  (<warp>)`) and follows again; `ApplyFormationWarps` re-checks `OrderRefusal`, so a member tackled between the order
  and its boundary is dropped too. A ship already in proper warp is out of reach (entering warp stops every module on
  it: `sd-fittings`).
- **The MWD**: `SetTackle` with `propMod` while the prop mod is activating, active or stopping switches it off at once
  (`PropModOffNow(entry, note, cause)`, generalized from the warp's: note `off: <propMod>`, `ApplyPropModNumbers`, an
  `off` event with `PropModCause` `'tackle'` if it was running, so the powerdown sound plays; events delivered before
  returning). It stays off when the scram ends: EVE does not restart it.
- **State**: `ShipEntry.tackle` starts `{ warp: null, propMod: null }`; `PlaceShip` keeps it (module state, not
  motion), `RemoveShip` drops it, and a load clears it through the retune of every ship. Specs:
  `destiny-tackle.spec.ts` (node, `runtime-sim` only; master and replica balls compared after a cancel).

## Physics (`flight.ts`)

- One pipeline everywhere: the hull's published values (hub `GET /ship-stats`), then the document's `stats`, then the
  max-skills pilot, through the shared `computeShipStats` (`sd-ship-stats`). `physics.source`: `sde`, `stats` (all
  four given) or `class` (class values by SOF hull category or bounding radius when EVE data can't name the hull;
  `physics.note` says why). **Class values go through the same pilot**, so `stats` means the same with or without SDE.
- **Ball radius** = the hull's SDE `radius` when the hub knows it, else the SOF bounding radius, else 100 m. Order
  ranges and `targetDistance` use it. The SOF bounding sphere is only for framing and `get_state`'s `radius` and
  `distances`.
- Lookups are cached per page session (one per EVE type or DNA `hull:faction:race`). A ship flies class values until
  its lookup lands, then retunes mid-flight. A failed lookup is logged once and retried on the next load/open or reload.
- **A fitted ship flies by its fit** once the hub has resolved its fit (`fittings.ts`, `sd-fittings`): `ResolveFlight`
  takes `dogma` and runs the dogma path of `computeShipStats` (modules online; the prop mod's running numbers with its
  module active), so plates, rigs and the rest set mass, speed, agility and signature. `physics.math` is `dogma` or
  `table`; `ShipFlight` also carries `defense` and `capacitor` (get_state reports them beside `physics`, not in it).
  The ship flies the table path until the fit's lookups land, then retunes like a hull lookup.
- **An unfitted ship flies its default weapons fit** once the EVE data knows its hull (`sd-weapons`): the same dogma
  path, so `physics.math` is `dogma` for every ship with an SDE hull. Turrets and charges touch no flight attribute, so
  a bare hull flies its table numbers (the parity spec, `fittings.spec.ts`); hulls with speed traits now get them. A
  ship whose hull has no EVE type (class values) or no weapon hardpoints keeps the table path (`fit: null`, `fitNote`).
- **Running modules change the flight** (`switch_modules`, `sd-fittings`): the director flies a fitted ship with its
  modules' live states, so siege and triage (maxVelocity −100 %, mass ×) and a suppressor's signature apply through
  `SetPhysics` inside the `OnBoundary` hook, before orders: the prop mod's timing.
- **Webs and painters come through the flight** (`sd-fittings` "Target effects"): the director flies every ship, fitted
  or not, with the incoming modifiers of the modules running on it, so `SetPhysics` → `SetMaxSpeed` on both parks at
  the boundary, and the ball slows at its agility (`SetMaxSpeed` never clamps velocity: server
  `CjsBallparkController.SetMaxSpeed`). Webs never reach 0; align time is unchanged (mass and agility only), as in EVE.
  The booster drive reads the webbed prop-mod-off `maxVelocity`, as the client reads its ball's.
- **Module-layer helpers**: `OnBoundary(listener)` (called with the boundary's master tick; a throwing listener is
  logged and the rest run), `SurfaceDistance(a, b)` (ball to ball on the EVE radii, negative when overlapping; null
  when either is gone; either id may be an object, through `TargetEntry`, for a turret's target) and `InWarp(id)` (proper warp). `CycleEnd` lives in `module-cycle.ts`; destiny.ts re-exports it.
- The world accepts a max velocity of 0. `RequireValidPhysics` refuses a warp speed it cannot convert.

## Real-GPU evidence (2026-10-22, Windows Chrome, NVIDIA)

Turns draw smoothly (no frame stepped > 3°, none reversed). Hulls bank into turns (Carbon's legacy roll, up to ~80° in
a 22°/s frigate turn). Two orders whip at one tick edge then ease: a 180° approach from rest (~150°/s), a reversal at
speed (~120°/s). Orbit 5 km held 5245–5253 m at 98 % max velocity; orbit 1 km 1340–1390 m; keep-at-range 2500 m behind
157 m/s target 2810–2915 m; approach parked 160–166 m surface to surface. An orbit ordered from rest picks a steeply
inclined plane.
