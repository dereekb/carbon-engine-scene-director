# The timeline and ship orders: the scene's script

> A scene document carries a script: a top-level `timeline` of cues that each run one existing lever at a scene time,
> and per-ship `orders` a ship flies in turn. Fetch before touching `packages/scene/src/lib/timeline/`, the document's
> `timeline` or ship `orders`, the timeline patch ops, or (once they land) the page's `TimelinePlayer` /
> `ShipScripts`. The plan this follows: `~/.claude/plans/scene-timeline-and-per-ship-orders-validated-played-on-the-scene-clock-reported.md`
> (slices T1 document → T2 page player → T3 determinism → T4 `at` on the tools → T5 real-GPU look).

**Status: T1 (the document) has landed.** The schema, validation, patch ops, diff and pruning are real; the page does
not play the script yet. Every document with a script warns `TIMELINE_NOT_PLAYED_WARNING` ("validated and stored; the
page plays them from the next release"); T2 deletes it.

## Files (`packages/scene/src/lib/timeline/`, runtime-free, node-tested in `timeline.spec.ts`)

| File | Holds |
|---|---|
| `timeline.ts` | types, limits, `TIMELINE_ACTION_NAMES`, `cueActionOf`, `cueDueSecond` (ceil), the script thresholds the page uses. **No run-time imports**: the folder and `../scene` import each other |
| `actions.ts` | `TIMELINE_ACTIONS`, one registry entry per lever (`kind`, `read`, `references`, `advise`), `toTimelineScope`, `checkCueReferences` |
| `steps.ts` | ship `orders`: `SceneShipStep`, `shipStepCompletion`, `normalizeShipOrderSteps` |
| `projection.ts` | `sceneAtTimelineTime`, `sceneAddsBetween`, the `ApplySceneOperations` type |
| `normalize.ts` | `normalizeSceneTimeline`: read, ids, sort, the projection walk, `adds` pinning |
| `operations.ts` | `TIMELINE_OPERATIONS` + `applyTimelineOperation` (wired into `applyOperation`'s `default:`) |
| `prune.ts` | `removeTimelineReferences`, called by `remove_ship`, `remove_object`, `remove_fleet`, `remove_wing`, `remove_squad` |
| `report.ts` | `TIMELINE_STATES`, `CUE_STATES`, `SHIP_SCRIPT_STATES` and the report shapes (get_state, the `timeline` tool) for T2 |

## The document

```json
"timeline": { "cues": [
  { "id": "red-lands", "at": 5, "name": "red warps in", "patch_scene": { "operations": [{ "op": "add_ships", "dna": "…", "count": 6, "fleet": { "new": true, "id": "red" }, "warpIn": true }] }, "adds": { "ships": ["…"], "fleets": ["red"] } },
  { "id": "go", "at": 15, "order_fleet": { "fleet": "blue", "order": { "type": "approach", "target": "red-fc" } } },
  { "id": "focus", "at": 25, "order_fleet": { "fleet": "blue", "order": { "type": "targets", "set": ["red-fc"] } } }
] }
```

- **A cue** is `{ id, at, name?, <one action>, adds? }`. `at` is seconds from play start in [0, 86,400]; it fires on
  the first 1 s tick at or after it (`cueDueSecond`). A missing id gets the lowest free `cue-<n>`, in input order. A bare
  array is shorthand for `{ cues }`; a timeline without cues is omitted. Cues are sorted by `at`, stably: same-time cues
  keep their document order, which is the order they fire in. Messages index the **input** position.
- **Actions** are the lever tools' names with the tool's arguments as the value: `order_ship` (`{ id, order }`),
  `order_fleet`, `switch_prop_mods`, `switch_modules`, `set_target`, `engage`, `cease_fire`, `auto_repair`,
  `play_shot`, `play_sequence`, `stop_shot`, `patch_scene` (`{ operations }`). Each is read by its tool's normalizer and
  stored normalized, except camera shots (stored as written: a library shot expands when it plays) and patches (as
  written: ops apply when the cue fires). A patch cue may not carry the timeline ops or `set_environment` (a reload).
- **Kinds** (`entry.kind(args)`): `live` (orders, switches, locks, called targets: `order_fleet` targets is live since
  fb0f033), `camera`, `document` (`patch_scene`, `auto_repair`, and `order_fleet`'s anchor / break-off / regroup). T2
  applies document cues to the **live scene only**, so saving mid-play saves the script, not its effects.
- **Limits**: 1,000 cues, 50 patch cues (each costs a projection step), 32 ops per patch cue, 64 steps per ship.
- **Event cues are reserved for Movie mode** (decision): `when` is refused with "reserved for Movie mode's event cues;
  give at". Movie mode owns "cued by time or events" together with re-simulating from snapshots, which is what makes
  editing an event-dependent script sensible. Room left: the `when` slot, and T2's player keeps a due tick per cue that
  event sources (`OnKill`, warp exits, arrivals) can feed. Ship `orders` already chain one ship's steps on completion.

## Validation at cue time: the projection and `adds`

`normalizeScene` reads the ships' `orders`, then calls `normalizeSceneTimeline` **last**, passing `applySceneOperations`
(injected: no module cycle, and specs can inject):

- Starting from the normalized document **without its timeline**, walk the sorted cues. Before each cue the known ids
  are the projected scene's ships, objects, fleets (wings, squads) and teams (`toTimelineScope`). A patch cue is applied
  with the pure `applySceneOperations`; the projected document has no timeline, so it never recurses.
- **References** (`entry.references` → `checkCueReferences`): an unknown ship, object, fleet, wing, squad, a ship
  selection id, a set_target / engage / switch_modules target, a targets `primary` / `queue` / `set` / `drop` id, a
  camera subject (hardpoint ship / object / target / ships / fleet / teams, pose and path hulls), or a team no ship is on
  is a **problem**. A movement or warp target that is no id and not `celestial:<digits>` is a **name**, resolved when the
  cue fires (warning). `resolveFleetOrderRequest`'s refusals (authority, an own-ship target) become warnings "may fail
  when it fires": a death can hand a fleet to an acting FC. A camera `celestial` is unchecked.
- **A patch cue that no longer applies** is a problem naming it: `timeline.cues[0] ("later") (40 s): operations[0]: no
  ship "red-1": edit or remove the cue first`. That is how removing what a patch cue edits is refused.
- **`adds`** is derived per patch cue (`sceneAddsBetween`: ships, objects, fleets, `fleet/wing`, `fleet/squad`) and
  pinned on the cue. On the next normalize: a recorded id the scene already holds before the cue (an edit took it) is a
  problem, `ship "late" is added by timeline cue "adds" at 4.5 s: give the new ship another id, or edit the cue`, checked
  before the patch is applied; any other difference (an allocation drifted) re-pins with a warning, and later cues on
  the old ids then fail their checks. `update_cue` setting an action clears `adds`, so a rewritten patch re-pins silently.
- Projection is skipped when the document already has problems (every step would repeat them), and when a cue fails to
  read or a limit is exceeded.
- **Cost (measured 2026-10-23)**: a 250-ship document (two `add_ships` fleets of 50 and 200) with 20 patch cues of 5
  ships each normalizes in **21 ms** (1 ms without the timeline), so the projection is not memoized.
- `sceneAtTimelineTime(scene, seconds, apply)`: the document without its timeline plus every patch cue with
  `cueDueSecond(at) ≤ seconds`. T4's hub tools resolve against it (`get_scene { at }`).

## Ship `orders`

```json
{ "id": "blue-dps-05", "dna": "…", "orders": [
  { "after": 20, "type": "orbit", "target": "red-fc", "range": 2500, "duration": 30 },
  { "type": "stop" }, { "type": "warp", "point": [0, 0, 400000] }, { "type": "rejoin" }
] }
```

- A step is an `order_ship` order read by `normalizeShipOrderRequest(rest, { self, where: 'ships[2].orders[0]' })`
  (the context `orders.ts` kept for it), plus `after` (seconds in [0, 86,400] to wait once the previous step is done,
  default 0, omitted when 0) and `duration` (seconds in (0, 86,400]).
- **Completion without a duration** (`shipStepCompletion`): `warp` → `landed` (its own warp, begun after the order
  applied), `goto` → `arrived` (within `SCRIPT_GOTO_ARRIVAL_RANGE` 1,000 m and under `SCRIPT_STOPPED_SPEED` 1 m/s, or
  within `SCRIPT_GOTO_CLOSE_RANGE` 100 m), `stop` → `stopped`, `rejoin` → `given`; `direction`, `approach`,
  `keep-at-range`, `orbit` → `never`: a problem unless it has a duration or is the last step.
- Targets are not refused: an id the document holds or a cue adds, or `celestial:<digits>`, is quiet; anything else
  warns "resolved as a name when the step runs" (`names`, warned after the timeline's `addedTargets` are known). A
  `rejoin` on a ship in no fleet warns (a cue may put it in one). Empty lists are omitted.
- Edited with `update_ship set { orders }` (replaced whole; `null` clears). `SceneDiff.orders` lists kept ships whose
  orders changed: T2 restarts their scripts.

## Patch ops

| Op | Does |
|---|---|
| `add_cue { cue }` | appends; an existing id is a problem; a missing id is assigned at normalize |
| `update_cue { id, set }` | merged: `at`, `name` (`null` clears), or one action key, which replaces the cue's action and clears `adds`; `id`, `adds` and a `null` action are problems |
| `remove_cue { id }` | an unknown id is a problem |
| `set_timeline { timeline }` | replaces it whole; `null` removes it |
| `clear_timeline` | removes it; a no-op without one |

## Removal pruning (as called targets prune)

`removeTimelineReferences(removal, context)` runs on the draft, tolerant of malformed cues (left for normalize):

- A cue whose subject or target was removed goes, with `timeline: cue "go" (order_fleet at 15 s) was removed with fleet
  "blue"`: an `order_ship` on or at it, a selection's fleet / wing / squad (a removed fleet takes its wings and squads;
  `remove_wing` passes its squads), a target, a targets `primary`, `by`, an anchor or break-off ship, a camera subject.
- A `ships` selection and a targets `queue` / `set` / `drop` lose the id (`… no longer names "x" (it was removed)`); the
  cue goes when the selection, queue or drop empties (an emptied `set` stays: it clears the list).
- Ship steps aimed at a removed ship or object are dropped: `ships[2].orders[1] (orbit "red-fc") was dropped`.
- **`patch_scene` cues are never pruned**: a patch that no longer applies refuses the removal (above), the same rule as
  "a fleet commander is never removed implicitly".

## Decisions for the later slices (plan §2.8–§2.18)

- Cues fire in `DestinyWorld.OnBeforeBoundary`, before `ApplyPropMods`, so a cue is exactly "that MCP call made just
  before that tick"; scripts step first, then cues in (due, document order). A scripted load holds the scene clock while
  the scene prepares; t = 0 is the next tick. The page keeps the authored document (what `get_scene` / `save_scene` /
  the working copy hold) apart from the live scene (authored minus `timeline`, plus live edits).
- Time control snapshots `TimelinePlayer.Snapshot()` beside Destiny's state; fast-forward loops `Tick`, so it fires
  cues for free. Movie mode replaces `missed` (a cue added into the past) with re-simulation.
