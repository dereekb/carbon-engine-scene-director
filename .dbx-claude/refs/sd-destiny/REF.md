# Destiny in the page: parks, clock, orders, placement

> Every document ship flies as a Destiny ball (`@carbonenginejs/server`), and the ball drives the drawn ship's
> translation and rotation curves. Fetch before touching `apps/viewer/src/lib/destiny.ts`, `clock.ts`, `main.ts`'s
> loop, `flight.ts`, `packages/scene/src/lib/orders.ts`, or anything that moves a ship. Sub-docs (`dbx-claude-ref`
> `{ ref: "sd-destiny", doc: "<key>" }`): **`warp`** (warp orders, phases, refusals) and **`boosters`** (the per-frame
> booster drive). Formation steering is `sd-fleets`; prop mod physics is `sd-ship-stats`.

## Files

| File | Role |
|---|---|
| `apps/viewer/src/lib/destiny.ts` | `DestinyWorld`: the **only** code that touches the parks. Ships, orders, warp, following, prop mod state |
| `apps/viewer/src/lib/clock.ts` | the scene clock: one integer 100 ns tick count both parks and the renderer sample |
| `apps/viewer/src/main.ts` | the single rAF loop |
| `apps/viewer/src/lib/flight.ts` | each ship's flight numbers (Ship stats from the hub's `/ship-stats`) |
| `apps/viewer/src/lib/warp.ts` | warp factor, landing, Destiny's warp-profile math |
| `apps/viewer/src/lib/boosters.ts` | the booster drive |
| `apps/viewer/src/lib/steering.ts` | Follow the FC's steering math (`sd-fleets`) |
| `packages/scene/src/lib/orders.ts` | `order_ship` request normalization (`normalizeShipOrderRequest`) |
| `apps/viewer/src/lib/carbonenginejs-server.d.ts` | the server's types |
| specs | `destiny.spec.ts` (1.4k lines), `destiny-ship.spec.ts`, `clock.spec.ts`, `warp.spec.ts`, `boosters.spec.ts`, `flight.spec.ts` (node, `runtime-sim` only) |

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
- At a due boundary the order is: prop mod numbers (`ApplyPropModNumbers`) → pending orders (`ApplyOrder`) → `Steer`
  (following) → evolve.

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
  radii**. A target must be another ship.
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
- `PlaceShip` keeps prop mod state; it ends an order and ends a warp at once, at rest.

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
- The world accepts a max velocity of 0. `RequireValidPhysics` refuses a warp speed it cannot convert.

## Real-GPU evidence (2026-10-22, Windows Chrome, NVIDIA)

Turns draw smoothly (no frame stepped > 3°, none reversed). Hulls bank into turns (Carbon's legacy roll, up to ~80° in
a 22°/s frigate turn). Two orders whip at one tick edge then ease: a 180° approach from rest (~150°/s), a reversal at
speed (~120°/s). Orbit 5 km held 5245–5253 m at 98 % max velocity; orbit 1 km 1340–1390 m; keep-at-range 2500 m behind
157 m/s target 2810–2915 m; approach parked 160–166 m surface to surface. An orbit ordered from rest picks a steeply
inclined plane.
