# Fleets: structure, anchors, formation, Follow the FC

> EVE fleet structure in the document (FC, wings, squads with a role and an anchor) and how the page flies it. Fetch
> before touching `packages/scene/src/lib/fleets/`, the viewer's `following.ts` / `steering.ts`, `DestinyWorld.Steer`,
> or `Director.FormationRadius`. Sub-docs (`{ ref: "sd-fleets", doc: "<key>" }`): **`orders`** (`order_fleet`: fleet,
> wing and squad orders, groups apart, fleet warp in formation, break-off / regroup, pilot delay),
> **`targets`** (called targets: each group's primary and target queue, the `targets` order, who takes which call, the
> page's `FleetTargets` focus fire, own vs called targets, cease_fire holds, pre-locks, `OnPrimary`) and
> **`compositions`** (the `cjs-fleet/1` fleet composition, its expansion, saved compositions and the TFIs example).
> Adding ships into fleets from the staging tools is `sd-staging`.

## Files

| File | Role |
|---|---|
| `packages/scene/src/lib/fleets/fleet.ts` | types, `SQUAD_ROLES`, `DEFAULT_ANCHOR_UP_RANGE` (1000), `FLEET_COMMANDS` |
| `fleets/normalize.ts` | validation (`normalizeFleets`) |
| `fleets/operations.ts` | the fleet patch ops (`FLEET_OPERATIONS`, `applyFleetOperation`, `removeShipFromFleets`) |
| `fleets/membership.ts` | **`toFleetMemberships`: the one place anchors are resolved** |
| `fleets/selection.ts` | selecting ships by ids or fleet / wing / squad (prop mod switches, fleet orders) |
| `fleets/formation.ts` | the at-rest formation: `layoutFleetFormation`, `toFleetFormationSlots`, `toFleetGroupOffsets`, `FORMATION_SPACING` 1.5, `FORMATION_GAP` 100, `DEFAULT_FORMATION_RADIUS` 500 |
| `fleets/following.ts` | follow plans (`toFleetFollowPlans`; `toFleetGroupFollowPlans` for a group apart), `FOLLOW_TOLERANCE*` |
| `fleets/orders.ts` | the `order_fleet` request, who may give it, the group's leader, the document ops, `toPilotDelays` (sub-doc `orders`) |
| `fleets/targets.ts` | called targets: the `targets` field (the opening calls), the `targets` order (`toFleetTargetList`), removal pruning, `toFleetGroupCalls` / `toShipCallPlans` (sub-doc `targets`) |
| `fleets/group.ts` | `FleetGroup`, `toFleetGroupKey`, `describeFleetGroup` (shared by `orders.ts` and `targets.ts`; `orders.ts` re-exports them) |
| `apps/viewer/src/lib/following.ts` | `FleetFollowing`: document fleets reconciled into `DestinyWorld.Follow`, detach / rejoin, groups apart (`BreakAway` / `Regroup`) |
| `apps/viewer/src/lib/fleet-succession.ts` | the heir of a dead FC flies on with its order (`CaptureFleetHeirs`, `HeirOrderOf`, `InheritFleetOrders`; node-tested) |
| `apps/viewer/src/lib/fleet-commanders.ts` | `FleetCommanders`: the live call book order_fleet's targets order edits, spliced over the document by `toLiveFleetScene`, and each group's free fire (node-tested; sub-doc `targets`) |
| `apps/viewer/src/lib/fleet-targets.ts` | `FleetTargets`: the targeting lever: members lock, pre-lock and shoot their groups' called primaries (node-tested; sub-doc `targets`) |
| `apps/viewer/src/lib/fleet-orders.ts` | `FleetOrders`: `order_fleet`'s live half (moves, warps, regroups) and each group's command report (node-tested) |
| `apps/viewer/src/lib/steering.ts` | heading frame, goto-lag lead, each member's goto point (runtime-free) |
| `apps/viewer/src/lib/destiny.ts` | `Steer`, `Slot`, `Settle`, `AimAlong`, `Follow` / `Unfollow` / `FollowHold` |
| spec helpers | `fleets/fleets.spec-helper.ts` (`TFI`, `GUARDIAN` DNA, `TFI_FLEET_SCENE`) |

## The model

`fleets: [{ id, name?, commander, targets?, autoRepair?, stance?, wings: [{ id, name?, commander?, targets?, autoRepair?, stance?, squads: [{ id, name?, role, commander?, members, anchor?: { ship?, range? }, home?: { ship?, range? }, targets?, autoRepair?, stance? }] }] }]`

- `role` is required: `dps`, `logi`, `tackle`, `ewar`, `boost`, `support` (case-insensitive). `wings` / `squads` /
  `members` default `[]`; empty is valid. `fleets: []` = no fleets.
- Fleet ids unique in the scene; wing and squad ids unique within their fleet (a squad is addressed by fleet + squad).
- A ship holds positions (FC, wing commander, squad member) in **at most one fleet** and sits in at most one squad.
  The FC sits in one of its fleet's squads or none; a wing commander in one of its own wing's squads or none and
  commands one wing; a squad commander is one of its members. One ship may combine commands.
- **`team` is independent of fleets** (team = side/hostility; fleet = who commands it and where it flies).
- `home` is written only by `order_fleet` break-off: the anchor `regroup` restores. **It is not an anchor**:
  `toFleetAnchors` ignores it; it is validated and repaired like one (sub-doc `orders`).
- `targets` is the group's **opening** called targets (ship or object ids in kill order; sub-doc `targets`): a load
  starts with them, order_fleet then calls live and never writes them. Memberships ignore it.
- `autoRepair` (`{ on?, policy? }`) is the group's logi auto-repair, resolved key by key from the nearest group (squad,
  wing, fleet; default on for logi squads): `sd-logi`. Memberships ignore it.
- `stance` is the group's opening stance (how its pilots fly; `order_fleet { type: "stance" }` sets it live, never
  written): `sd-piloting`. Memberships ignore it; with no stance anywhere the fleet flies exactly as described here.

Example: three TFIs keep 1 km on the FC; the logi squad anchors on its own lead, guardian-1, which holds 30 km off the
FC while guardian-2 anchors up on it at 1 km.

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
      "id": "tfi", "name": "TFI fleet", "commander": "fc",
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

## Anchors (resolved only in `toFleetMemberships`)

A squad anchors on `anchor.ship` (default: the FC, whoever that is) and keeps `anchor.range` metres **surface to
surface on the Destiny balls' radii** (default by role: logi 30,000 m, every other role 1,000 m). Both stored as
written, so an omitted value follows a new FC or role.

- Anchor on the FC or a ship outside the squad: every member except the FC keeps the range on it.
- Anchor on one of the squad's own members (not the FC): that ship is the squad's **lead** (as a logi anchor is). It
  keeps the range on the FC; the others anchor up on it at 1,000 m.
- The FC follows nobody: the fleet takes its heading from it. A wing commander in no squad anchors up on the FC.
- Anchors are ships of the same fleet; every chain must end at the FC (loops refused).
- **Follow the FC must fly the anchors `toFleetMemberships` resolves, never re-derive them.**

## Edits and fallback

Ops: `add_/update_/remove_fleet` (`withShips: true` removes the ships too), `add_/update_/remove_wing`,
`add_/update_/remove_squad` (`add_squad` never moves ships; `update_squad` replaces `anchor` whole), `move_to_squad`,
`remove_from_fleet`, `set_anchor` (merged; `null` resets ship to FC / range to role default). `null` in a `set` clears
the field; ids and child lists can't be set. `add_*` objects sit under their noun; other `fleet`/`wing`/`squad` keys are
ids.

- Removing a ship takes it out of its fleet automatically. Whenever an edit takes a ship out, it gives up the commands
  it can no longer hold, and a squad anchored on it **falls back down the chain**: its squad commander, then its wing
  commander (whichever is set and still in the fleet), else the FC. The range is kept. Lost commands and re-pointed
  anchors come back as warnings.
- A fleet commander is never removed implicitly: `update_fleet` a new commander or remove the fleet first. Ops run in
  order, so `update_fleet` then `remove_ship` in one patch works.
- **A destroyed ship leaves its fleet live, never in the document** (`fleets/live.ts` `toLiveFleetScene`, `sd-combat`):
  the same ops a removal runs, after a dead FC hands the fleet (`update_fleet`) to its successor
  (`toDefaultFleetSuccessor`: the first live wing commander in wing order, else the first live squad commander, else
  the first live member; a personality fleet's designate instead, the overlay's `commanders`, `sd-personalities`); a
  fleet with nobody alive drops. The page's `FleetFollowing`, `FleetOrders`, memberships and
  fleets report read that view, so the members re-form on the acting FC (the same re-plan an `update_fleet` causes); a
  load revives everyone and the document's fleets come back.
- **The FC dies, the fleet flies on** (`apps/viewer/src/lib/fleet-succession.ts`, node-tested, wired in
  `Director.Destroy`). `DestinyWorld.Destroy` halts every ship anchored or framed on the dead FC, the heir included, and
  the re-plan leaves the heir following nobody, so the heir **inherits** the FC's order (`HeirOrderOf`): its pending
  order, else its applied one, the pending order's `respondsIn` carried as the delay; a `stop` inherits nothing; an
  order aimed at the heir or one `OrderRefusal` refuses becomes `direction` along the dead FC's velocity at speed ÷ max
  velocity (only at `SETTLE_SPEED` or more); a warp still aligning becomes `direction` toward its landing (the
  tackle-cancel precedent). Only an heir that flew in the formation (its follow framed on the FC) inherits: a detached
  heir or a group-apart leader keeps its own order. Kills resolve inside the boundary listeners and pending orders apply
  after them in the same `Tick`, so the heir never flies a stopped tick (`fleet-succession.spec.ts`: a TFI heir's speed
  never drops across the death boundary). A pending order with a delay leaves the heir halted until it applies.

## The formation (`fleets/formation.ts`)

Each ship on a shell at exactly its anchor range, trailing the FC's heading (trailing pole first, then a Fibonacci
sphere's trailing hemisphere), on an outer shell when the inner one is full. No two ships closer than
`1.5 × (r1 + r2) + 100 m` on their EVE radii (500 m for an unknown radius, with a warning). Whole metres, every ship
faces the heading, deterministic. Existing scene ships aren't avoided (a warning names any new ship within 500 m of
one). Slots go in wing, squad and member order.

## Follow the FC (how the page flies it)

- **Who follows**: every ship whose resolved anchor is set (squad members, wing commanders outside squads), never the FC.
- **Slots**: each member flies the slot `toFleetFormationSlots` gives it (the same placement as `layoutFleetFormation`):
  a direction from its anchor in the fleet's heading frame and a range. **Slots are laid out at the FC's *document*
  placement with the ships' ball radii**, so a fleet added in formation gets its own positions back and nothing moves.
  A chained member (logi on its lead) slots on its own anchor, in the FC's frame.
- **The frame** is the FC's heading: Destiny's legacy heading, without its banking roll. A wing or squad flying apart
  (`order_fleet`) is framed by its leader instead.
- **Steering is per-tick `GotoPoint`** in `DestinyWorld.Tick`, after the pending orders and the formation warps on a
  due tick (so it
  relies on one evolve per `Tick` call: the clock's 1 s cap). Each member's goto point is re-aimed at its slot on both
  parks, led along its anchor's velocity by Destiny's goto lag, at the member's own max velocity. No shared scripted
  speed: faster ships close up, equal ones sit ~two ticks back, slower ones trail.
- **Why not Destiny's own tools**: `FollowBall` aims at the nearest point of the range sphere and cannot hold a
  bearing (followers stack at the trailing pole); Destiny's native formations reserve 16 slots per leader, bank with
  the leader and keep park-held tables.
- **Settling**: a member whose anchor is at rest, within tolerance and slower than 1 m/s stops (mode `stop`) and turns
  smoothly to the fleet heading; it moves again when its anchor does or its slot drifts past 1.5× tolerance.
  **Aim its goto point along its *current* heading before `SetBallVelocity(0, 0, 0)`** (zero velocity snaps the legacy
  heading to the goto point), then along the fleet heading. Legacy heading faces the goto point only at exactly zero
  velocity.
- **States**: `in-formation` while slot error ≤ 200 m + 5 % of slot range + 2.5 s of the anchor's speed
  (`FOLLOW_TOLERANCE`, `_FRACTION`, `_SECONDS`), else `catching-up`; `holding` while its anchor or the FC is in proper
  warp; `warping` in a formation warp until its group has landed; `leading` for the leader of a wing or squad apart;
  `detached` after an explicit order; `waiting` until the fleet's radii settle.
- **Detach / rejoin**: any `order_ship` movement order on a member detaches it. It rejoins on `{ "type": "rejoin" }`,
  a fleet edit that regroups it, `order_fleet` regroup or fleet warp, or a load/open; a placement edit leaves it
  detached. **The FC is never detached: ordering it moves its fleet.** Nor is a group-apart leader: an order keeps it
  leading, and `rejoin` on it is refused (regroup the group).
- **Edits re-plan at once** (`set_anchor`, `update_squad`, `move_to_squad`, `update_fleet`, squad/wing edits,
  `remove_ship`, fallback). Ships whose following ends stop with an `orderNote`; `changes.stopped` counts them.
  `FleetFollowing.Reconcile` re-anchors formation followers of a removed ship in the same edit.
- **Readiness (`Director.FormationRadius`)**: a fleet is planned only once every ship holding a position has a settled
  radius: an SDE radius from `/ship-stats`, or a finished SOF build. Until then members already following keep their
  slots, new members wait. **With the 100 m interim radius a composition-added fleet would be pulled ~300 m inward and
  scramble.**
- Placement: a member moved by `patch_scene` is put at rest there and flies back; moving the FC makes the fleet chase.
- Prop mods: a switch never takes a ship out of formation; members follow at their own (boosted) speeds.

## `get_state`

Per member: `fleet`, `wing`, `squad`, `role`, `commands`, `anchor` (`{ ship, range }`; `null` for the FC), and
`following` (`state`, `anchor`, `range`, `slot` `{ range, direction }`, `distance`, `slotError`, `warping`, `group`);
its `order` is `keep-at-range` on the anchor, mode `goto` while steering, `stop` once settled. Per fleet: the tree with
`ships` and resolved anchors, `formation` (`ready`, `heading`, counts `following` / `inFormation` / `catchingUp` /
`holding` / `warping` / `leading` / `detached` / `waiting` / `arriving`: still arriving by warp, `sd-staging`
"Warp-in"), `propMods` counts, `modules` (every member's fitted module
rows by live state: offline, online, activating, active, stopping, reactivating; `switch_modules` with `fleet` / `wing` /
`squad` switches them, `sd-fittings`), and `command` on the fleet and every wing and squad (sub-doc `orders`). `changes.regrouped` counts membership changes.
Called targets (sub-doc `targets`): a fleet, wing or squad that calls reports `targets` (its live list) and `called` (`primary`,
`queue`, `skipped` with why, `following`); a member reports `target.source` (`own` | `called` | `free`) and `call` (`state`:
following, holding, stood-down, own-target, responding, in-warp, free-fire, no-primary or logi; `group`, `primary`,
`respondsIn`, `free`, `picksIn`); a group with free fire on reports `freeFire: true`.
Logi auto-repair (`sd-logi`): a member with remote repairers or with auto-repair on reports `autoRepair` (`state`,
`on`, `policy` and their `source`s, `target`, `reason`, `why`, `hps`, `preLocks`, `unreachable`); a fleet with remote
repairers reports `autoRepair` (`logi`, `repairing`, `locking`, `idle`, `outOfRange`, `manual`, `off`, and `targets`:
whom its logi hold up). Wings and squads show their written `autoRepair` in the tree.
A fleet that lost ships (`sd-combat`) lists only its live members and adds `destroyed` (their ids) and `actingFor` (the
dead FC its commander stands in for); a fleet with nobody alive is not listed.

## Called targets (sub-doc `targets`)

Each fleet, wing and squad may call targets: a list in kill order whose first live entry is its primary. The document's
`targets` are the opening calls a load starts with; `order_fleet { order: { type: "targets", primary | queue | set |
drop | next | clear } }` edits the group's **live** list at once, never the document (the page's call book,
`FleetCommanders`; the order's authority: the FC for the fleet, a wing commander their wing, a squad commander their
squad); removing a called ship or object prunes it from both; a kill never edits either. Each member takes the nearest call in its chain (squad, wing, fleet; the FC the
fleet's only, logi their own squad's only): every member without its own target locks it, pre-locks the next two and
fires, moving on at the boundary after the primary dies, warps off or is removed. Own targets (set_target, engage,
switch_modules) win; cease_fire holds (unlock stands down) until the group calls again. `order_fleet { type:
"free-fire", on }` lets members with no call pick the nearest hostile in their own reach (sub-doc `targets`). Orders
without `delay` reach each pilot after its reaction (sub-doc `orders`). Status: delivered (real-GPU
evidence 2026-10-23: the guns re-converge on the next primary 1 tick after the kill).

## Arriving fleets (`warpIn`)

A fleet added with `warpIn` (`add_fleet_composition`, `add_ships` `fleet: { new }` or a join, a `stage_engagement` side)
waits parked off-grid and lands staggered, the FC first (`sd-staging` "Warp-in"; Destiny side: `sd-destiny` doc
`warp`, "Warp-in"). Its members keep their follows: a landed member holds (`holding`, `warping` naming the ship) until
the FC, its anchor and its frame ship have landed, then forms up at its own speed; a member whose FC or anchor is
still arriving holds too, so nobody flies off-grid. A join lands at its live slots around the FC.

Checked headless by `verify-page --only warp-in` (2026-10-23, real tools-core): an inline TFI FC + 3 TFIs + 2 Guardians
lands FC first (ticks 60–63), every member in formation by tick 64, the logi lead 30,007 m off the FC; joiners added to a
Rifter fleet after it warped 400 km land within ~1 km of the moved FC (not at its document placement); a
`stage_engagement` side warps in along its heading toward the other side and lands 20 km off it.

On the GPU (2026-10-23, Windows Chrome, NVIDIA, the CNAP, `.scratch/warp-in-gpu/`): the 44-ship TFIs (`warpIn: true`)
lands over ~10 s after its first flash and reports `formed` ~33 s after the first landing. The group stays `landed`
until then because the FC, which has no follow, counts as formed only once it coasts below the settled speed (a TFI
coasts ~30 s after the exit). Members were in formation (43/43) within ~6 s of the last landing.

## Time control

`FleetFollowing` (its `memberships` memo reset), `FleetOrders`, `Arrivals`, `FleetTargets` and `FleetCommanders` (the FC
brains) are time-control owners (`sd-time`): a jump back restores the formation, the orders, the calls and the brains'
memory, and the live `order_fleet` orders are journaled and replayed. Fleet edits (`order_fleet`'s document orders,
anchors, personalities) cut the window.

## Limits

No collisions (ships pass through while re-forming). Slots are rigid: on an FC turn a far squad (logi at 30 km) swings
across the fleet and takes minutes to return. No fleet speed: an FC move does not throttle to its slowest member.

## Real-GPU evidence (TFIs fleet, 2026-10-22)

Full speed straight: 34 members as fast as the FC hold within 0.2° of its heading; 9 slower hulls trail at their own
speed; logi lead holds 30 km ± 60 m. A 90° turn at full speed leaves 36/43 catching up (same-hull TFIs plateau 1–2 km
off their swung slots: nobody is faster than the FC); logi swings ~25 km. After a stop, 42/43 back in formation in ~3
min (the Apostle last). A few members snap round (up to ~100°) at the tick they settle. Detach/rejoin fly smoothly.
