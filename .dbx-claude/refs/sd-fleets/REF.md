# Fleets: structure, anchors, formation, Follow the FC

> EVE fleet structure in the document (FC, wings, squads with a role and an anchor) and how the page flies it. Fetch
> before touching `packages/scene/src/lib/fleets/`, the viewer's `following.ts` / `steering.ts`, `DestinyWorld.Steer`,
> or `Director.FormationRadius`. Sub-docs (`{ ref: "sd-fleets", doc: "<key>" }`): **`orders`** (`order_fleet`: fleet,
> wing and squad orders, groups apart, fleet warp in formation, break-off / regroup, pilot delay) and
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
| `apps/viewer/src/lib/following.ts` | `FleetFollowing`: document fleets reconciled into `DestinyWorld.Follow`, detach / rejoin, groups apart (`BreakAway` / `Regroup`) |
| `apps/viewer/src/lib/fleet-orders.ts` | `FleetOrders`: `order_fleet`'s live half (moves, warps, regroups) and each group's command report (node-tested) |
| `apps/viewer/src/lib/steering.ts` | heading frame, goto-lag lead, each member's goto point (runtime-free) |
| `apps/viewer/src/lib/destiny.ts` | `Steer`, `Slot`, `Settle`, `AimAlong`, `Follow` / `Unfollow` / `FollowHold` |
| spec helpers | `fleets/fleets.spec-helper.ts` (`TFI`, `GUARDIAN` DNA, `TFI_FLEET_SCENE`) |

## The model

`fleets: [{ id, name?, commander, wings: [{ id, name?, commander?, squads: [{ id, name?, role, commander?, members, anchor?: { ship?, range? }, home?: { ship?, range? } }] }] }]`

- `role` is required: `dps`, `logi`, `tackle`, `ewar`, `boost`, `support` (case-insensitive). `wings` / `squads` /
  `members` default `[]`; empty is valid. `fleets: []` = no fleets.
- Fleet ids unique in the scene; wing and squad ids unique within their fleet (a squad is addressed by fleet + squad).
- A ship holds positions (FC, wing commander, squad member) in **at most one fleet** and sits in at most one squad.
  The FC sits in one of its fleet's squads or none; a wing commander in one of its own wing's squads or none and
  commands one wing; a squad commander is one of its members. One ship may combine commands.
- **`team` is independent of fleets** (team = side/hostility; fleet = who commands it and where it flies).
- `home` is written only by `order_fleet` break-off: the anchor `regroup` restores. **It is not an anchor**:
  `toFleetAnchors` ignores it; it is validated and repaired like one (sub-doc `orders`).

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
`holding` / `warping` / `leading` / `detached` / `waiting`), `propMods` counts, and `command` on the fleet and every
wing and squad (sub-doc `orders`). `changes.regrouped` counts membership changes.

## Limits

No collisions (ships pass through while re-forming). Slots are rigid: on an FC turn a far squad (logi at 30 km) swings
across the fleet and takes minutes to return. No fleet speed: an FC move does not throttle to its slowest member.

## Real-GPU evidence (TFIs fleet, 2026-10-22)

Full speed straight: 34 members as fast as the FC hold within 0.2° of its heading; 9 slower hulls trail at their own
speed; logi lead holds 30 km ± 60 m. A 90° turn at full speed leaves 36/43 catching up (same-hull TFIs plateau 1–2 km
off their swung slots: nobody is faster than the FC); logi swings ~25 km. After a stop, 42/43 back in formation in ~3
min (the Apostle last). A few members snap round (up to ~100°) at the tick they settle. Detach/rejoin fly smoothly.
