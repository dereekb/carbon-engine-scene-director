# Fleet orders and fleet warp (sd-fleets sub-doc)

`order_fleet` (page tool) commands a fleet, one wing or one squad. Code: `packages/scene/src/lib/fleets/orders.ts`
(request, authority, leader, document ops, pilot delays), the viewer's `fleet-orders.ts` (`FleetOrders`: the live half
and each group's command report), `following.ts` (`BreakAway` / `Regroup`: groups apart), `DestinyWorld.WarpInFormation`
and `Director.OrderFleet`.

## The request (timeline-cueable)

```json
{ "fleet": "tfis", "squad": "logi", "by": "tfis-logi-01", "delay": 0.3, "order": { "type": "warp", "point": [0, 0, 600000] } }
```

One plain object (`FleetOrderRequest`, validated by `normalizeFleetOrderRequest`). A future timeline beat embeds it
unchanged and runs it through `Director.OrderFleet`.

- **Selection**: `fleet`, narrowed by `wing` xor `squad` (`switch_prop_mods`' `fleets/selection.ts`). `ships` is
  refused with a pointer to `order_ship`. **The FC is never part of a wing or squad order** (it heads the whole fleet);
  a squad whose only member is the FC is refused.
- **Orders**: `order_ship`'s movement orders (`direction`, `goto`, `approach`, `keep-at-range`, `orbit`, `stop`) and
  `warp`; the document orders `anchor`, `break-off`, `regroup`. `rejoin` is refused ("use regroup").
- **Targets** must be outside the group (the FC is a fine target for a squad). A target that is no id is tried as a
  name first (`Director.NamedTarget`, `sd-locations` "Order targets by name"), measured from the fleet's FC; the result
  adds `resolved`.

## Authority and the leader (`resolveFleetOrderRequest`)

- **Commanders**, nearest first: the squad's commander, its wing's commander, the FC (set ones only). `by` must be one
  of them, else the order is refused with the list. Omitted, the nearest gives it. One rule for every order type: the
  FC warps the fleet, a wing commander only their wing, a squad commander only their squad (EVE's rule).
- **Leader** (the ship a move goes to and a warp is led by): fleet → the FC. Squad → its commander, else the issuer when
  in the squad, else its lead (its own-member `anchor.ship`), else its first non-FC member. Wing → its commander, else
  the issuer when in the wing, else its first squad's leader. **Compositions set no wing or squad commanders**, so the
  fallbacks are the usual path.

## Moves and groups apart

- **Fleet move**: `world.Order(fc, order)`, exactly what `order_ship` on the FC does; members keep following. Groups
  apart and detached members stay where they are (as in EVE): a fleet warp or a fleet `regroup` brings them back.
- **Wing or squad move** (needs `formation.ready`): `OrderRefusal(leader)`, `world.Order(leader)`, then
  `FleetFollowing.BreakAway`. The group **flies apart** on its leader with `toFleetGroupFollowPlans`: a ship whose
  anchor is inside the group keeps it and its fleet slot (logi keep their lead); a ship anchored outside the group
  (usually the FC) re-roots on the leader at its at-rest offset (`toFleetGroupOffsets`), framed by the leader's heading.
  **This is the one live override of the anchor rules**; the document's anchors never change.
- A group apart ends on: a `regroup` of it or a group containing it, a fleet warp, an edit that regroups any of its
  ships (`diff.regrouped`, which includes its document orders), its leader leaving the group, the fleet's removal, a
  load/open. A ship flies on the most specific group apart containing it; a wing breaking away absorbs groups apart
  inside it. A new move re-orders the leader (a new leader rule winner replaces the record).
- `order_ship` on the leader keeps it leading (`following: "leading"`); on another group ship it detaches as usual and
  `rejoin` puts it back into the group apart. `rejoin` on a leader is refused with the regroup hint.

## Warp in formation

`FleetOrders.Warp`:

1. Refusals: `OrderRefusal(leader, warp)` (so a tackled leader refuses the warp: `ship "fc" cannot warp: <warp>`,
   `sd-destiny` "Tackle"), and the fleet must be planned (`formation.ready`).
2. Predict the leader's landing (`LandingPoint`, both EVE radii for a target ball) and the frame
   `WarpFrame(leaderPos, landing)`; each ship's predicted slot is `FramePoint(landing, frame, offset)`. The target ball
   is `world.Motion(id)` for a ship, else `world.ObjectBall(id)` (an object or a celestial target). **Reading `Motion`
   alone (the old bug) put an object target's landing at the leader itself**: every slot read under 150 km and only
   the leader warped (`fleet-orders.spec` "warps the fleet to an object or a celestial target").
3. Skip (reported in `skipped`): a ship in proper warp (it keeps its own warp, untouched), a tackled one (`cannot
   warp: <warp>`, from `world.Tackle(id)`), max velocity 0, or a slot under 150 km away (it flies there: **Destiny's
   `WarpTo` turns anything within 100 km into a `GotoPoint`**, and EVE refuses warps under 150 km). A tackled member
   is still regrouped (step 4), so it holds while the leader warps and then flies to its slot. The regroup warps
   (`regroup` of a group apart beyond 150 km) skip tackled members the same way.
4. Every ship not in warp is regrouped (`FleetFollowing.Regroup`), then the leader is ordered. A wing or squad then
   breaks away on its leader. Each warper gets `world.WarpInFormation(id, { leader, offset, delay })`.

`DestinyWorld` resolves each formation warp **at the tick boundary, after the plain pending orders** (so the leader's
`WarpEntry` exists; a leader whose own delayed order has not applied yet makes it wait):

- Leader warp in force → origin = Destiny's landing once in warp, else the `LandingPoint` estimate; frame =
  `WarpFrame(where its warp began, landing)`. **The leader faces its landing in warp and after it** (legacy heading:
  zero direction term in warp, velocity plus a collinear goto bias after; `EvolveStop` never reaches exactly zero
  velocity), so that frame is the landed fleet's frame and nothing swings round on landing.
- No leader warp (a regroup) → origin = the leader's position, frame = its heading frame.
- `OrderRefusal` again; a refused one is dropped (`orderNote` `dropped: …`) and the ship keeps following. Otherwise an
  ordinary `ApplyOrder` warp to a point (range 0): `WarpFactor` first, speed fraction 1, both parks, the mode check;
  `TrackWarps` resets every landed ship non-massive.
- **The wait rule**: `Steer` leaves a formation-warp ship alone until it, its leader, its anchor and its frame ship have
  all finished their warps (`FormationWarpWaits`). Without it a fast Rifter landing while a TFI FC still aligns (not in
  proper warp, so not `held`) would fly straight back. Then it re-applies its follow and steers the few hundred metres
  of exit coast into its slot. A re-plan (`Follow`) keeps the formation warp; an explicit order, a placement or
  `Unfollow` ends it. Bounded: a warp in force ends within 180 align ticks plus the warp.
- Every ship aligns from the same boundary and warps at **its own** hull warp speed.

A warped wing or squad lands in formation around its leader and stays apart until `regroup` (EVE has no
follow-the-FC). An FC giving a wing or squad warp does not warp itself.

## Document orders and `squad.home`

| Order | Group | Ops (`toFleetOrderOperations`) |
|---|---|---|
| `anchor { ship?, range? }` | fleet / wing / squad | one `set_anchor` per squad of the group, keys given only (`null` resets) |
| `break-off { ship?, range = 30000 }` | one squad | `update_squad set { anchor: { ship: lead, range }, home? }`; lead = `ship` (a member, not the FC), else commander, else current lead, else first member; `home` = the old anchor (`{}` for defaults) only when the squad has none yet |
| `regroup` | fleet / wing / squad | per squad with a `home`: `update_squad set { anchor: home (null for {}), home: null }` |

- **`squad.home` is break-off's undo record, not an anchor**: `toFleetAnchors` ignores it (so following and
  `diffScenes.regrouped` do too), `normalizeFleets` validates it like an anchor (keeping `{}`), and `repairAfter`
  repairs it like an anchor ("…now regroups onto …"). Break-off then regroup restores the fleets exactly.
- Why a record: the TFIs logi squad sits on its own lead at 30 km **by design**, so "broken off" cannot be read from the
  anchor.
- Document orders run through the director's edit queue (`Serialize` + `Apply`, like `patch_scene`; the hub gives
  `order_fleet` the 600 s `SLOW_TOOLS` deadline), then their live half. The result carries `operations` and the patch
  result with its per-ship build reports under `builds`, so `ships` always means the ordered ships.
- **`regroup`'s live half**: every ship of the group apart or detached rejoins its fleet formation, and those 150 km or
  more from their slot warp to it in formation with the FC (against the FC's landing if it is warping).

## Pilot delay

`delay` (0–1) on `order_fleet` and `switch_prop_mods`: every ship but the giver responds after its own time,
`toPilotDelays`: uniform in [0, delay × `MAX_FLEET_ORDER_DELAY` (10 s)] in whole ticks, from an FNV-1a hash of the
group key, the tick and the ship id, so the same order at the same tick (a timeline replay) responds the same way.

- `DestinyWorld.Order(id, order, { delay })` keeps the pending order until its boundary (`pendingAt`);
  `WarpInFormation` and `SwitchPropMod` take the same delay (a queued switch is re-checked when made; the document's
  prop mod state overrides it).
- `get_state`: `respondsIn` on a ship's motion (and on `formationWarp`), `propMod.queued`; the tool results give
  `delays` / `respondsIn`.

## get_state

- Members' `following.state` gains `warping` (in a formation warp, from the order until its group has landed;
  `warping` names the leader) and `leading` (leads a wing or squad apart), plus `group: { kind, id, leader }` while it
  flies in or leads a group apart. `formation` counts gain `warping` and `leading` (all counts mutually exclusive).
- Every fleet, wing and squad gets `command`: `state` is the first of `warping` (a group warp with a ship pending,
  aligning or in warp), `regrouping` (a regroup's ships not yet in formation), `moving` (the leader's order is not
  `stop`, it is under way, or a delayed order is pending), `broken-off` (apart, or a squad with a `home`), `idle`; plus
  `leader`, `away`, `home`, `order` (while moving), `last` (`{ order, by, tick }`), `warp` (counts `aligning`,
  `warping`, `landed`, `dropped`, `skipped`) and `regrouping`. Records clear lazily once done.

## Limits

No collisions. Landings are off by the exit coast (a few hundred metres) and, for a ship target, the align drift.
Slots are rigid. A fleet move does not drag groups apart along. In a short warp turned off the fleet heading a far
squad's slot can fall under 150 km and it flies (TFIs logi in a 160 km warp turned 90°). Beyond ~100,000 km from the
origin drawn ships jitter (float32), as for any warp.

## Hooks for fleet warp-in (not built)

`toFleetGroupOffsets` (FC as leader) gives every landing offset; `WarpFrame` / `FramePoint` turn an arrival point and
heading into each ship's landing. A warp-in would add a `DestinyWorld` method calling `EntityWarpIn` on both parks
(`WarpFactor` first, the same `WarpEntry` / `TrackWarps` tracking) and set `formationWarp` so arrivals hold until the
FC lands: the same wait rule. `OnWarp` `enter` / `exit` already fire per member for the effects.
The camera's `warp-in` shot (`sd-cinema`, the `warp-landing` hardpoint) frames any ship with a `WarpEntry` through
`world.Motion(id).warp`; check it against warp-in arrivals.
