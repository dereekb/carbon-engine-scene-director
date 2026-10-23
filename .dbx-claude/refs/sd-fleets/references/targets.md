# Called targets: a fleet's primary and target queue (sd-fleets sub-doc)

What a fleet, wing or squad shoots at, called the way an EVE FC calls it. Code: `packages/scene/src/lib/fleets/targets.ts`
(the document field, the order, the call rules), `fleets/group.ts` (`FleetGroup`, `toFleetGroupKey`,
`describeFleetGroup`, shared by `orders.ts` and `targets.ts`), `fleets/orders.ts` (the `targets` order type), the
page lever `apps/viewer/src/lib/fleet-targets.ts` (`FleetTargets`, node-tested) and its Director wiring. Plan: `~/.claude/plans/fleet-targeting-lever-called-primaries-and-a-target-queue-per-fleet-wing-or-squa.md`.

**Status: T2 in** (the document, the order, the call rules; the page lever: members lock, pre-lock and shoot the call,
own targets win, cease_fire holds, get_state `call` / `called`, `OnPrimary`). The real-GPU look is slice T3.

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
  death modes), `missing` (`targets.KindOf` null: no ball), `warping` (a ship `InWarp`, or `Arriving`: parked
  off-grid to warp in), else `live`. Objects are live once built.
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

## The page lever: `FleetTargets` (`apps/viewer/src/lib/fleet-targets.ts`)

Node-tested, plain-data state: `own` (marked ships), `called` (ship → `{ target, group }` the lever gave),
`holds` (ship → `hold` | `stand-down`), `responds` (ship → response tick), `lastCalls` (group key → its list's JSON),
`primaries` (group key → live primary), and the last plans and group calls (for the reports). Port:
`FleetTargetsPort { Status, CanTarget, TargetOf, tickSeconds }`.

- **`Sync(scene, tick)`** → `{ changes: [{ ship, target, group }], primaries: CalledPrimaryChange[] }`, over the live
  fleet view:
  1. Early out (empty plans) when no group calls targets and `called`, `holds`, `responds`, `primaries`, `lastCalls`
     are all empty.
  2. Group calls (`toFleetGroupCalls` with `Status`) and plans. A group whose list JSON changed since `lastCalls` lifts
     the holds of the ships whose **chain** includes it (not a ship still responding: its response lifts it).
  3. Per plan, in fleet order: an own mark drops once `TargetOf` is null; an own-target ship is left alone; a ship that
     cannot target (dead, no ball, in warp, arriving) forgets its call (warp already cleared its target); a stood-down
     ship's called target clears; a responding ship keeps what it has until `responds <= tick` (then its response and
     hold go); else it takes the plan's primary (null when none: a change to null if it still holds the called one).
  4. Leavers (a `called` ship no longer in any plan) clear; holds and responses of ships outside every plan go.
  5. `primaries`: each group whose live primary moved, and a dropped group's last primary → null.
- **Own vs called.** `Own(ship)` marks a target from `set_target`, `engage` or `switch_modules` (an own target that
  equals the primary must stay own when the primary moves on). `Source(ship)`: `called` when the lever gave the ship's
  current target, `own` for any other target (a ship outside fleets reports `own`), null without one.
- **`Hold(ship, mode)`** records only for ships with a plan (fleet members; none when nothing calls: a call re-arms
  anyway). **`Rearm`** lifts holds and responses (engage). **`Respond(ships, delays, tick)`**: a delayed ship keeps what
  it shoots, and any hold, until `tick + delay`; one with no delay is re-armed at once.
- **`Armed()`**: following a call (its target is the called one) and not held. **`PreLocks(ship)`**: the plan's queue
  head (`CALLED_PRE_LOCKS` = 2) for a following or holding ship (its target is its plan's primary; not stood down).
- **`Report(ship, tick)`** (get_state `call`), **`GroupReport(group)`** (get_state `called`), **`SkipReason`** (the
  order's `skipped`), **`CallOf`** (set_target's skip text), **`Forget`** (removed or destroyed), **`Clear`** (a load).

## Director wiring (`director.ts`)

- **Construction**: `FleetTargets({ Status: CalledTargetStatus, CanTarget: live && !InWarp && !Arriving, TargetOf:
  targets.Of, tickSeconds })`.
- **`SyncFleetTargets(boundary?)`**: `Sync(LiveFleets()?.scene ?? scene, world.tick)`, each change through
  `SetShipTarget(ship, target, { requestedAt })` (the boundary sync passes `boundary − 1`, so a new lock starts at that
  boundary like the sweep's; `RequestLock` takes the tick), then each `OnPrimary` listener per change (a throwing one is
  logged).
- **Boundary listener**: `RemoveDead` → `SyncRecharged` → **`SyncFleetTargets(boundary)`** →
  `LockEvents(locks.Boundary(boundary, WantedLocks()))` → `Engagements(boundary)` → `ModuleEvents(modules.Boundary)` →
  `arrivals.Boundary`. A kill clears every target on the dead (today); the next boundary's sync gives members the next
  live called target, usually already pre-locked, so the sweep keeps the lock and `Engagements` re-arms at once. No
  `OnKill` listener: OnKill runs inside `Shots` mid-boundary, and retargeting there re-enters ShipModules for no earlier
  first shot.
- **`WantedLocks()`** adds each following or holding member's `PreLocks` while its wanted set is under `maxLocks`
  (the target and turret aims always fit, so the sweep never has to choose). Not `ShipLocks.Keep`: a Keep is sticky,
  and at the limit it can block the primary's own lock.
- **`Engagements(boundary)`**: the engaged ships, then `fleetTargets.Armed()` not engaged on their own, with
  `DEFAULT_ENGAGE_MODULES` (`ArmTurrets`): turrets back online switch active at the called target.
- **`Apply`**: `Clear()` in the restart branch, `Forget` for removed ships, `SyncFleetTargets()` after
  `following.Reconcile` and before the store write (tool results see it; ball-less ships are skipped by `CanTarget`).
  **`Destroy`** → `Forget`.
- **`OrderFleet`** (targets): resolve → `CallWarnings` (a destroyed `primary` refused: `order_fleet.order.primary:
  target "r3" was destroyed`; a destroyed `queue` / `set` id warned `"…" was destroyed: it is skipped until a load`; a
  target on the giver's team warned) → compile (refusals before any side effect) → `Respond(resolved.ships,
  toPilotDelays(...), tick)` → `Apply` when there are ops → `SyncFleetTargets()` (a no-op call still re-arms and
  reports) → `Fly(resolved, { tick })` → result: order_fleet's fields plus `targets` (the list after), `primary`,
  `queue`, `ships: [{ id, target, source?, respondsIn?, lock? }]`, `skipped: [{ id, reason }]` (own target, logi, in
  warp, holding, stood down, responding, following a nearer group's call; nothing when the group has no live primary),
  `warnings?` (the live checks plus the patch's).
- **`SetTarget`**: a non-null target → `Own`. Null on a ship whose target is called → skipped: `it has no own target: it
  follows fleet "b"'s call on "r1" (cease_fire holds its fire; order_fleet targets drop or clear ends the call)`. Null
  on an own target clears it, then `SyncFleetTargets()`; the row becomes `{ target: <the call>, source: "called" }`.
  set_target does not lift a hold: it aims, it does not open fire.
- **`Engage`**: `Own` + `Rearm`. **`SwitchModules`** with a turret `target`: `Own`.
- **`CeaseFire`**: an armed called member counts as engaged (no "not engaged" skip). Each member `Hold`s (`hold`, or
  `stand-down` with `unlock`; row `held`); unlock clears the target as before, then `SyncFleetTargets()`.
  `switch_modules { modules: ["turret"], state: "online" }` on an armed member is undone at the next boundary, as on an
  engaged ship: cease_fire is the hold.
- **`OnPrimary(listener)`** returns its unsubscribe: the automatic camera's "a called primary switching".
- **No auto-approach**: a member out of lock range keeps following its anchor while its lock waits; the FC brings the
  fleet in (`order_fleet` approach / keep-at-range on the primary).

## get_state

- **Per ship**: `target.source` (`own` | `called`); `call` for fleet members whose chain has a called group, or that
  hold, stand down or respond: `{ state, group?, primary?, respondsIn? (s) }`. `state`, the first that applies:
  `own-target`, `stood-down`, `responding`, `in-warp` (cannot target: warp, arriving, no ball), `logi` (a logi member
  with no call of its own squad), `no-primary`, `holding`, `following`.
- **Per fleet, wing and squad** with called targets: `targets` (as written; the tree spreads the document) and
  `called: { primary, queue, skipped?: [{ id, why }], following }` (`following`: members on this group's primary).

## verify-page evidence (2026-10-23, tools-core SDE 3646012, headless: everything but drawing)

The four checks (`--only called`) pass:

- **A called primary focuses a squad's fire** (bfc + squad dps p1, p2 + logi squad g1, Punishers; Rifters r1, r2 at
  5 km; death explode): bfc, p1, p2 on r1 (called), g1 `call.state: "logi"`, p1 pre-locked r2 at tick 6; r1 killed at
  tick 17, **first shot on r2 at tick 18 (+1 tick**, slowest cycle 2.52 s); `get_scene` still reads `["r1","r2"]`; after
  r2 dies the primary is null, the targets clear and the guns settle.
- **Own targets win, a squad's call beats the fleet's** (TFIs as targets, death flag): bfc, p1, p2 on r1, p3 on r2
  (squad c), g1 on r3 (logi squad's own call); set_target made p1 own on r3; p2's null skipped with the follows-the-call
  reason; p1's null handed it r1 (called); squad c `clear` sent p3 to r1.
- **cease_fire holds; a delayed call staggers**: held 5 s with no new shots; `delay: 1` `primary: r2` switched bfc at
  the order tick and p2, p3, p1 at order tick + their delays (3, 7, 8 s, within a tick); `unlock` stood the fleet down
  (no targets, no locks); `next` re-armed it onto r1.
- **Removal advances the document's queue; a loaded call fires; bad calls are refused**: a loaded `targets: ["r1",
  "r2"]` fired with no order; `remove_ship r1` warned `fleet "b" no longer calls "r1" (it was removed)` and the members
  moved to r2; refused: `by` without command, an own ship, `celestial:<id>`, `drop` of an uncalled id, a destroyed
  `primary`, `next` on an empty list.

The earlier combat and fleet checks run unchanged (spot-checked: engage / cease_fire, set_target's lock time, a dead
squad lead and FC). tools-core moved to SDE build 3646012 on 2026-10-23: it answers only for its reported build, so it
was prepared once (`cjs-sde-prepare --build 3646012`, `sd-dev-env`).

## Specs

`apps/viewer/src/lib/fleet-targets.spec.ts` (precedence, the FC and logi rules, the fall-back, own wins and rejoins, hold /
stand-down / re-arm, a delayed response, a warping and a dead target with pre-locks, primary changes, Forget, Clear,
determinism), `fleets/targets.spec.ts` (normalize, edits, diff, pruning, group calls, ship plans on the TWO_WINGS shape),
`fleets/orders.spec.ts` "targets orders" (reading, authority and own-ship refusal, each action's op, `next` with and
without a status, the refusals), the viewer's `fleet-orders.spec.ts` (a targets order records `last` at its given tick
and leaves following alone), `server.spec.ts` (the order_fleet text names `"targets"` and the focus fire; the MCP instructions name the target queue).
