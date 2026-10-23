# Called targets: a fleet's primary and target queue (sd-fleets sub-doc)

What a fleet, wing or squad shoots at, called the way an EVE FC calls it. Code: `packages/scene/src/lib/fleets/targets.ts`
(the document field, the order, the call rules), `fleets/group.ts` (`FleetGroup`, `toFleetGroupKey`,
`describeFleetGroup`, shared by `orders.ts` and `targets.ts`), `fleets/orders.ts` (the `targets` order type) and
`Director.OrderFleet`. Plan: `~/.claude/plans/fleet-targeting-lever-called-primaries-and-a-target-queue-per-fleet-wing-or-squa.md`.

**Status: T1 in** (the document, the order, the call rules, the page writing the document). Members do **not** lock or
shoot a call yet: the page lever (`apps/viewer/src/lib/fleet-targets.ts`, `FleetTargets`, own vs called targets,
cease_fire holds, pre-locks, get_state `call` / `called`, `OnPrimary`) is slice T2; the real-GPU look is T3.

## The document: `targets` on fleets, wings and squads

```json
"fleets": [{
  "id": "blue", "commander": "blue-fc", "targets": ["red-fc", "red-dps-01", "red-dps-02"],
  "wings": [{ "id": "wing-1", "squads": [
    { "id": "dps", "role": "dps", "members": ["blue-dps-01", "blue-dps-02"], "targets": ["red-logi-01"] },
    { "id": "logi", "role": "logi", "members": ["blue-logi-01"] }
  ] }]
}]
```

- `targets?: string[]` on `SceneFleet`, `SceneWing` and `SceneSquad`: ship or authored-object ids in kill order. The
  first **live** entry is the group's **primary**, the live entries after it its **queue**. `[]` is omitted.
- **Validation** (`readCalledTargets`, from `normalizeFleets`): ids (`ID_PATTERN`) of a ship or object, against
  `NormalizeFleetsInput.targetIds` (ships ∪ objects, passed by `normalizeScene`). Without `targetIds` existence is
  unchecked (add_ships normalizes one fleet against ship ids only, and a fleet calling an object must not break it).
  `celestial:<id>` is refused with `CELESTIAL_TARGET_REFUSAL`; no id twice; at most `MAX_CALLED_TARGETS` (256, EVE's
  fleet size).
- **One of the group's own ships is valid in the document** (a later `move_to_squad` can make it so; refusing it would
  break unrelated edits). The live view skips it (`own-ship`); the order refuses it up front.
- **Edits**: `update_fleet` / `update_wing` / `update_squad` `set: { targets: [...] | null }` (`readSet` allows the key);
  `add_fleet` / `add_wing` / `add_squad` objects may carry it. No op family of its own: the order compiles to these.
- **Removal prunes** (`removeCalledTarget`, tolerant of drafts): `remove_ship`, `remove_object` and `remove_fleet
  withShips` (each removed ship) take the id off every fleet's, wing's and squad's list, deleting an emptied list, with
  a warning per list: `fleet "blue": squad "dps" no longer calls "red-fc" (it was removed)` (`fleet "blue" no longer
  calls …` for a fleet's own list). `removeShipFromFleets` stays membership-only: the live view must not prune on death.
- **Kills never touch the list** (kills are live state, `sd-combat`): the live view skips a destroyed target, so the
  next becomes primary, and a load revives the call from its first entry.
- **`diffScenes`**: a `targets` edit flags `fleets` (it is part of the fleet JSON), never `regrouped` (memberships
  ignore it). `FleetFollowing`'s layout memo keys on the fleet JSON, so it re-runs `toFleetFollowPlans` once: pure, the
  same plans, no re-follow.

## The order: `order_fleet { order: { type: "targets", … } }`

Exactly one action per order (`readFleetTargetsOrder`, from `readFleetOrder`):

| Action | The group's list becomes (`toFleetTargetOperations`) |
|---|---|
| `primary: "<id>"` | that id first (moved up if already called), the rest in their order behind it |
| `queue: ["<id>", …]` | the list, then the given ids not yet called, in order (repeats dropped) |
| `set: ["<id>", …]` | exactly that (no repeats); `[]` clears |
| `drop: ["<id>", …]` | the list without them; an id it does not call is a problem |
| `next: true` | the list without its live primary (none live: without its first entry); an empty list is a problem |
| `clear: true` | empty |

- **Reading**: unknown keys are problems ("is not a targets order field"); ids are checked for the `celestial:` prefix
  **before** existence against `context.ships ∪ context.objects` (`objects` includes the location's celestial targets);
  `queue` and `drop` must be non-empty; `next` / `clear` must be `true`.
- **Authority** is order_fleet's (`resolveFleetOrderRequest`): the FC calls for the fleet, a wing commander for their
  wing, a squad commander for their squad. A `primary`, `queue` or `set` id among the group's ships (`selectFleetShips`,
  the FC included where it sits) is refused: `order_fleet.order: squad "dps" of fleet "blue" cannot call one of its own
  ships ("blue-dps-01")`. `drop` may name one (to take it off after a membership change).
- **Compile**: one `update_fleet` / `update_wing` / `update_squad` with `set: { targets: list | null }`, or none when the
  list is unchanged. `next` uses `statusOf` (the page's live status) to find the live primary; without it every entry
  counts as live. A result past 256 is a problem.
- **Types**: `FLEET_ORDER_TYPES` ends with `targets`; `FleetOrder = ShipOrder | FleetDocumentOrder`
  (`FleetStructureOrder | FleetTargetsOrder`). `isFleetDocumentOrder` (structure or targets) is what
  `Director.OrderFleet` routes on; `isFleetStructureOrder` stays anchors-only. Imports run one way: `orders.ts` →
  `targets.ts`; both take `FleetGroup` from `group.ts` (orders.ts re-exports it).
- **The page** (`Director.OrderFleet`): resolves, captures `tick`, compiles with `statusOf:
  Director.CalledTargetStatus`, applies through the edit queue, then `FleetOrders.Fly(resolved, { tick })` records
  `command.last` (and `delays` with a `delay`) at the captured tick. `command.state` stays movement-based.
- **`Director.CalledTargetStatus(id)`**, the first that applies: `destroyed` (`combat.IsDestroyed` or `IsDead`: both
  death modes), `missing` (`targets.KindOf` null: no ball), `warping` (a ship `InWarp`), else `live`. Objects are live
  once built.
- Why `order_fleet` and not a new tool: a target call is a commander's fleet command in EVE, and order_fleet already has
  the group selection, `by` authority, pilot `delay`, the edit queue, `command.last` and the one-plain-object request a
  timeline beat embeds unchanged.

## Who takes which call (`toFleetGroupCalls`, `toShipCallPlans`)

- **Group calls** (`toFleetGroupCalls(scene, statusOf?)`): every group with a list, keyed by `toFleetGroupKey`, in fleet
  order (fleet, then each wing followed by its squads). `toCalledTargets` splits the list: `primary` (first live entry
  not among the group's own ships), `queue` (the live rest), `skipped` with why (`destroyed`, `warping`, `missing`,
  `own-ship`).
- **Ship plans** (`toShipCallPlans(scene, calls)`, over the live fleet view): for every ship holding a position, its
  chain nearest first: its squad (if it sits in one), its wing (its squad's, or the wing it commands), its fleet. It
  takes the primary of the **nearest group in its chain with a live primary**: a squad whose targets are all dead or
  gone falls back to its wing's call, then its fleet's.
  - **The FC** takes only the fleet's call, whatever squad it sits in (order_fleet keeps it out of wing and squad orders
    too). An acting FC (`toLiveFleetScene`) is the fleet's commander, so it counts.
  - **Logi squads** (`role: "logi"`) take only their own squad's call: wing and fleet calls never reach them (they hold
    the fleet up; Logi auto-repair is its own entry). A call on the logi squad itself makes its members shoot. The FC
    rule wins over the logi rule.
  - Other roles (tackle, ewar, boost, support) shoot the call with their guns; their points, webs and neuts stay with
    `switch_modules`.
  - The plan carries `chain`, `logi`, `called` (any group of its squad, wing or fleet calls, rules aside: get_state's
    `call` report keys on it), `group`, `primary` and `queue` (what T2 pre-locks: `CALLED_PRE_LOCKS` = 2).
- Ships in no fleet take no calls. Members flying apart or detached still take calls: targeting is independent of
  formation.

## Specs

`fleets/targets.spec.ts` (normalize, edits, diff, pruning, group calls, ship plans on the TWO_WINGS shape),
`fleets/orders.spec.ts` "targets orders" (reading, authority and own-ship refusal, each action's op, `next` with and
without a status, the refusals), the viewer's `fleet-orders.spec.ts` (a targets order records `last` at its given tick
and leaves following alone), `server.spec.ts` (the order_fleet text names `"targets"`).
