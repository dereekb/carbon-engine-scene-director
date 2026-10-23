# Warp (sd-destiny sub-doc)

`{ "type": "warp", "point": [x, y, z], "range"? }` or `{ "type": "warp", "target": "<ship id>", "range"? }` (`range`
default 0; no `speed`: a warp always aligns at full speed). Code: `DestinyWorld` (`ApplyOrder`, `TrackWarps`,
`MarkAligning`, `InProperWarp`, `WarpReport`, `OnWarp`) in `apps/viewer/src/lib/destiny.ts`; math in `warp.ts`.

## How it runs

- Destiny's `WarpTo` on both parks at the ship's warp speed, **factor = round(AU/s × 1000)** (`WarpFactor`), and
  **speed fraction 1**: Destiny enters proper warp only at 75 % of max velocity on its heading; below it, it can only
  time out after 180 ticks.
- **`WarpTo` throws a RangeError for a non-int32 warp factor**, which inside `Both` would leave the replica unchanged
  (parks diverge). So `WarpFactor` runs first, and `RequireValidPhysics` refuses a warp speed it cannot convert.
- Phases are read from the master after each evolved tick:
  - `aligning`: warp mode, `effectStamp < 0`. Flies at full speed toward the destination until within ~8° at 75 % max
    velocity (Destiny warps anyway after 180 ticks).
  - `warping`: Destiny's accelerate and cruise phases (`SetupWarpConstants`).
  - `exiting`: deceleration. Destiny drops the ball out of warp on the first tick its speed is under
    min(max velocity / 2, 100 m/s); it coasts to a halt a few hundred metres past the landing (`landed`, mode `stop`).
- Warp speed (`warpSpeedMultiplier` AU/s from the SDE through Ship stats); class values without it: frigate 5,
  destroyer 4.5, cruiser 4, battlecruiser 3.5, battleship 3, capitals 1.5.
- Example timings: a 162 m/s battleship at 3 AU/s goes 300 km in 12 ticks of align + 12 in warp; a frigate at 5 AU/s
  spends 20 ticks in warp over 10 AU.

## Landing

- Point: `range` metres short of it, back toward where warp begins.
- Ship: `range` surface to surface from **where the target was when the order applied** (not tracked during warp).
- Object or celestial target (`celestial:<id>`): the same, on its static ball (both radii, as for a ship).
- A planet, moon, star or asteroid belt **by name** (`sd-locations` "Order targets by name"): no ball; the name becomes
  a warp to the point `range` off its surface (a belt: off its centre) on the line from its centre toward the ship (a
  fleet: its FC), range 0. A landing beyond the scene extent (10,000 km) is refused.

## Rules that cost debugging

- **Nothing may stop a ball in proper warp but a placement.** `Stop` / `GotoPoint` / `FollowBall` / `Orbit` / `WarpTo`
  only switch its mode, and it coasts on at warp speed (km/s, measured). So: `OrderRefusal` refuses every order in
  warp (`is in warp; it takes orders again once it lands, in about N s`), `Halt` leaves a warping ship alone (note
  only), `Steer` skips it, and `ApplyOrder` drops a pending order that finds it there.
- **Destiny's warp exit makes the ball massive** (and its sensor active) whatever it was before.
  `DestinyWorld.TrackWarps` sets every landed ship non-massive again on both parks.
- In warp the drawn ship runs up to a tick ahead of the master; both reach the exit point at the tick `OnWarp` reports.

## Refusals and edits

- Refused: a warp-scrambled ship (`ship "x" cannot warp: warp scramble status 1 (...): above 0 it cannot warp`, checked
  first: `sd-destiny` "Tackle"), a landing under 150 km away (EVE's minimum; use `goto`), a ship with max velocity 0, a
  warp to a ship in warp. A pending or delayed warp found tackled at its boundary is dropped (`dropped: the warp order
  (...)`).
- While aligning, any order cancels the warp (a new warp replaces it), and so does a point or scram landing: the ship
  flies on along its warp heading as a `direction` order (`warp cancelled: ...`); a formation-warp member drops its
  formation warp and follows again. In proper warp nothing can tackle it.
- Removing the target of an applied warp leaves the warp flying; a pending warp to it stops the ship.
- A new position or rotation ends a warp at once, at rest at the placement.
- Entering warp switches a running prop mod off (`note` `off: entered warp`); it stays off after landing.

## Fleets

While the FC (or a member's anchor) is in proper warp, members hold, stopped (`following.state` `holding`, with
`warping` naming the ship), as Destiny's `StopAllFollowers` does. After it lands they fly to their slots at their own
speed (`order_ship` warp on the FC).

**Fleet warp** is `order_fleet` warp (sd-fleets sub-doc `orders`): `DestinyWorld.WarpInFormation` gives each member an
ordinary `ApplyOrder` warp to a point (so every rule above holds: `WarpFactor` first, speed fraction 1, both parks, the
non-massive reset) to its slot around the leader's landing in `WarpFrame`, resolved at the boundary after the plain
orders. The member keeps its follow, and `Steer` skips it until it, its leader, its anchor and its frame ship have all
finished their warps. Members under 150 km from their slot, unable to move, or in warp are skipped: **Destiny's
`WarpTo` turns a destination within 100 km of the ball into a `GotoPoint`**, which the mode check would halt.

## Warp-in (arrivals)

A ship can **arrive** from warp instead of aligning: `DestinyWorld.Arrive(id, { from, landing, at, factor?, leader?,
roll? })` (`ArrivalRefusal`, `ArrivalOf`, `Arriving`, `WarpProfile`; math in `warp.ts`: `WarpRemainingAt`,
`WarpDropOutTime`, `WarpInBackdate`, `WarpInExitTicks`). Spec: `destiny-warp-in.spec.ts`. The page's planner
(`arrivals.ts`: hidden lanes, staggered timing, formation landings) and the ops' `warpIn` are in `sd-staging`
"Warp-in".

- **Destiny's own NPC warp-in**: `CjsBallparkController.EntityWarpIn(id, x, y, z, factor)` (server fork `eadbdd1`,
  typed in `carbonenginejs-server.d.ts`): `WarpTo` at range 0, then `RealWarp` at once (no align), the effect stamp
  **backdated min(5, tick) ticks** (`WARP_IN_BACKDATE_TICKS`), the warp distance from where the ball is. It sets the
  velocity to the *absolute* destination normalized × 1 AU/s (a native quirk; `WarpDistance` re-aims it every tick).
  A point within 100 km becomes a goto. Deterministic, so both parks stay identical (checked every tick in the spec).
- **Parking**: `Arrive` places the ship at rest at `from` at once (a placement: order, pending order, warp and
  formation warp end; follow, prop mod and tackle stay), its legacy heading facing the landing (drawn rotation
  [lane yaw, lane pitch, `roll`]). `at: null` waits **parked**; a tick waits **scheduled**; calling `Arrive` again
  before the warp-in re-parks and re-schedules. Refused: no ship, destroyed, in proper warp (its own warp-in too),
  non-finite points, max velocity 0 (it would never drop out), a lane under 150 km, a factor that is not a positive
  int32.
- **Start** (`ApplyArrivals`, at a due boundary after the formation warps, before `Steer`): for `at <= boundary`,
  `WarpFactor` first (outside `Both`), then `SetSpeedFraction(1)` and `EntityWarpIn` on both parks. Both balls must be
  in proper warp, else the ship is **placed at its landing** with `orderNote` `placed at its landing: …`. Then
  `order` = `{ warp, point: landing, range: 0 }` and a warp entry with `arrival: true` and no align, so `TrackWarps`
  handles it like any warp: the first evolve records the start (stamp = the backdated one), switches a running prop
  mod off (`off: entered warp`) and emits `enter`; the exit resets the ball non-massive and emits `exit`. Both events
  and `get_state`'s `warp` carry `arrival: true`.
- **Timing** (measured, spec-pinned): the first evolve puts the ball at `WarpRemainingAt(profile, backdate)` from the
  landing (a Rifter over 3,000 km: 260 km out after a 4-tick backdate, so a short lane shows the ship; the planner
  must pick a lane long enough to keep it ≥ 2,000 km out then). The exit event comes at master tick
  **at + WarpExitTime + 1 − backdate** (`WarpInExitTicks`), exactly. A Rifter over 1,000,000 km: ~114,000 km out on
  its first tick, lands ~15 ticks after the start.
- **While arriving** (parked, scheduled or warping): `OrderRefusal` refuses it (`ship "x" is arriving by warp; it
  takes orders once it lands, in about N s`) and any order at it (`target "x" is arriving by warp`);
  `PropModRefusal(on)` refuses (`switch its prop mod on once it lands`); `SetPropModActive(on)` and a due activation
  leave it off (`not switched on: arriving by warp`); `WarpInFormation` refuses an arriving ship or leader;
  `Steer` leaves it alone. `WarpUnfinished` counts an arrival not landed, so formation warps wait for it too.
- **Landing and the wait rule**: the exit sets the arrival `landed` (`landedAt`). A follower then **holds, stopped**
  (`FollowHold` names the ship) until its group's `leader`, its anchor and its frame ship have no unfinished warp or
  arrival, then its arrival clears and it follows (a chained logi waits for its lead). A ship without a follow keeps
  its `landed` arrival until its next order (`Order` clears it), a placement or a new `Arrive`. A follower whose
  anchor or FC is still arriving (even one present on grid) holds as it does for a warping one, so nobody flies
  off-grid after a parked FC.
- **Endings**: `PlaceShip` ends an arrival at once; `RemoveShip` drops it; `Destroy` drops one not yet warping.
- **Reporting**: `ShipMotion.arrival` / `ArrivalOf` = `{ state: parked | scheduled | warping | landed, from, landing,
  startsIn? (ticks to its boundary, 0 = the next), landsIn? (s to the exit event: from the profile while scheduled,
  from the warp while warping), landedAt?, leader? }`.

## Flashes

The client's warp effects play on every warp, arrivals included. Which and when: `warp-fx.ts` (`WarpFx`, pure,
`warp-fx.spec.ts` on real parks); drawing: `warp-effects.ts` (`WarpEffects`, runtime, only with a renderer).
`Director.DriveWarpEffects(now)` runs in `main.ts` after `DriveModuleEffects`.

- **Warp-out** on `enter`, never for an arrival (it waited off-grid): `res:/fisfx/jump/warp/warp_out_start.black`
  (EveTransform: `glow_core` 2,000 m + `streak` billboards on a `vfxRoot` child, named curve sets to 0.375 s) and
  `warp_out.black` (`warpOutTrace`: a beam along +Z, 1 s), both at where warp began, +Z turned along the warp.
- **Warp-in** once per warp, when the **drawn** ClientBall first comes within max(2,000 m, 4 × radius) of its landing
  (`WarpInTriggerDistance`), at the landing: the exit event lags the visible arrival by seconds. The exit plays it
  when no frame did. `warp_in_glow.black` for a SOF radius ≥ 150 m, else `warp_in_noglow.black` (EveTransform
  `warp_in_flash`: `disc` 500 m, `glow_core` 500 m, `glow_core2` 3,500 m, `streak` 750 m billboards; `_glow` adds
  `glow_core_big`; one unnamed curve set to 4.125 s).
- **Scale** radius / 250, clamped [0.5, 8] (`WarpFlashScale`; the floor was 0.25 until the GPU check: a Rifter's flash
  read as a faint dot from 5 km). Radius: the built hull's `boundingSphereRadius`, else the flight's radius.
- **A warp-in flash follows its ship**: it fires 2 km out while the hull still coasts in, so `WarpEffects.Frame` moves
  its root onto the ship's drawn position every frame (`DrawnPosition`, the director's `world.Curves` lookup, as
  `WarpFx` uses) until the ship is gone; left at the landing it glowed beside the hull. Warp-outs stay where warp
  began.
- A placement or a removal ends a warp with no exit: the next frame drops it (`InWarp` false), no flash. A load
  clears every tracked warp and drawn flash.
- **Drawing**: each file loads once (`ResourceValues`); every play hydrates a new `EveTransform` inside
  `PageAudio.Detached` (the files carry no audio), curve LOD off (`NoCurveLod`), wrapped in an `EveRootTransform` on
  fixed curves (`CreateStaticCurves` / `PlaceStatic`: position, the +Z-to-warp rotation) with the scale on the root,
  `Engine.AddObject`, then `PlayCurveSets()` on every transform in the tree (`warp_out_start`'s curve sets are on a
  child). Removed `WARP_EFFECT_LINGER` (0.5 s) after its longest curve set; at most `WARP_EFFECTS_LIVE_MAX` (64) at
  once, the rest skipped. Teardown: `RemoveObject` at once, then **one batch `RetireShips`** for every removed flash
  when none is left drawn or `WARP_EFFECT_RETIRE_WAIT` (5 s) after the oldest (and at a load). Each retire walks every
  retained graph, ~150 ms beside the 44-ship TFIs, so one per removal held the page at ~5 fps for 10 s after a fleet
  landed. `Roots()` (drawn and waiting) joins every retained set in `director.ts`.
- **get_state**: `renderer.warpEffects { live, loading, failed, skipped, errors }`; `simulation.warpFlashes
  { warpOut, warpIn }` counts the commands, with or without a renderer.
- **Checks**: `verify-page --only warp-in` (headless: arrivals, counts, by-name warps, the shot); the drawn look below.

### Real-GPU evidence (2026-10-23, Windows Chrome, NVIDIA, 1600 × 900, `?audio=off`)

Private hub on 5521 with temp stores, Jita IV - Moon 4 - Caldari Navy Assembly Plant (30 km off), driver and screens in
`.scratch/warp-in-gpu/` on dbxpc (not committed).

- **TFIs warp-in** (44 ships, `warpIn: true`): 44 warp-in flashes, 0 failed, 0 `gpuErrors`, empty `page_log`; up to
  38 drawn at once. Ships streak in with their warp trails and land in formation. fps ~20 (5–7 at the flash peak);
  before the batch retire a 5–6 s stall followed the burst (26–44 retires at ~150 ms), after it two retires (144 ms,
  142 ms) and no stall.
- **The flashes**: the glow (`glow_core2`) is soft and blue-white, small at a warp-in shot's 5–9 km and partly lost
  against a bright nebula; the 0.17 s core flash rarely lands in a 5 Hz capture. Brightness is the authored curves';
  no client reference to tune against yet.
- **Warp-out** (`order_fleet` warp 3,000 km along +X): 44 warp-outs as members entered warp, a horizontal blue-white
  streak along the warp in a side view (the +Z-to-warp rotation is right), 38 warp-ins counted at the far landing,
  0 failed.

## Reporting and hooks

- `get_state` per warping ship: `warp` = `phase`, `landing`, `warpSpeed` (AU/s), `alignTicks` (aligning), `distance`
  (from warp start), `remaining`, `progress` (0..1), `landsIn` (s, in warp). `order` stays the warp order through
  landing; `mode` is `warp` until it lands.
- `DestinyWorld.OnWarp(listener)` reports `enter` / `exit` after the tick they happen in (where warp began or the exit
  point, the direction, the landing, the warp speed, `arrival: true` for a warp-in): the flashes below play from it.
- **Far away**: Destiny simulates any distance in float64, but the page draws relative to the scene origin in float32:
  beyond ~100,000 km a ship jitters on screen if the camera goes there.
