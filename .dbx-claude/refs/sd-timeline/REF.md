# The timeline and ship orders: the scene's script

> A scene document carries a script: a top-level `timeline` of cues that each run one existing lever at a scene time,
> and per-ship `orders` a ship flies in turn. Fetch before touching `packages/scene/src/lib/timeline/`, the document's
> `timeline` or ship `orders`, the timeline patch ops, or (once they land) the page's `TimelinePlayer` /
> `ShipScripts`. The plan this follows: `~/.claude/plans/scene-timeline-and-per-ship-orders-validated-played-on-the-scene-clock-reported.md`
> (slices T1 document → T2 page player → T3 determinism → T4 `at` on the tools → T5 real-GPU look).

**Status: T1 (the document) and T2 (the page player) have landed.** The page plays the script on Destiny ticks and
reports it. T3 (pilot delays and warp-in staggers keyed on scene ticks, prefetched lookups for cue-added ships), T4 (`at`
on the lever tools) and T5 (the real-GPU scripted fight) follow.

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
| `report.ts` | `TIMELINE_STATES`, `CUE_STATES`, `SHIP_SCRIPT_STATES` and the report shapes (get_state, the `timeline` tool) |

The page (`apps/viewer/src/lib/`, node-tested, no runtime): `timeline.ts` (`TimelinePlayer` over a `TimelinePort`,
`TimelineText` for the HUD; `timeline.spec.ts`), `ship-scripts.ts` (`ShipScripts` over a `ShipScriptsPort`;
`ship-scripts.spec.ts`), `clock.ts` (`Hold` / `Release`), `destiny.ts` (`OnBeforeBoundary`; `destiny-timeline.spec.ts`).
The director is both ports.

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
- **Cues are a model's calls to the FC brain** (`sd-personalities`): an `order_fleet`, `order_ship`, `engage`,
  `cease_fire` or `switch_prop_mods` cue on a personality fleet takes its lever manual as the tool does
  (`Director.Manual`), and so do a ship script's steps on its acting FC. `order_fleet` cues run through
  `Director.FleetOrderNow(args, { cue })`, free-fire included.
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

## Playing it (the page)

- **When cues fire.** `DestinyWorld.OnBeforeBoundary` runs at the top of a due boundary, **before `ApplyPropMods`**
  (`sd-destiny`), so a cue is exactly the MCP call made just before that tick: an order applies at this boundary, a prop
  mod switch-on is active since this boundary, a module activation lands in this boundary's cycle, a lock starts at the
  next. Within one tick the ship scripts step first (`ships[]` order), then the due cues fire in document order (sorted
  by `at`). Fast-forward (Time control) loops `Tick`, so it fires cues for free.
- **Timeline time** is whole seconds played (`played` boundaries since t = 0; get_state `time` = played − 1). A cue fires
  at played tick `cueDueSecond(at)`. Pause stops `played`: later cues and step waits shift by the pause while the ships
  fly on.
- **States** (`TimelinePlayer`): `idle` (unscripted: no cues, no ship `orders`; never holds the clock, get_state
  `timeline: null`), `stopped`, `preparing`, `ready`, `playing`, `paused`; get_state reads `done` while playing with no
  pending cue and every script settled (a `holding` script counts as settled). A cue added later in the future plays on.
- **Prepare.** A load of a scripted document (`load_scene`, `open_scene`, the startup restore of the working copy,
  `timeline restart`) holds the scene clock (`SceneClock.Hold`) and checks `Director.SceneSettled()` every frame
  (`DriveTimeline`, first in `main.ts`'s loop): every live ship's `/ship-stats` answered (a failure counts), its prop
  mod looked up, its fit not pending (or without a fit its hull type not `TypePending`), its build not queued /
  building; every fleet planned (`FleetFollowing.Ready`); every object built; the location not loading. Then the clock
  releases and the next boundary is t = 0, so every run starts from the same state. Cap
  `TIMELINE_PREPARE_LIMIT_SECONDS` 60 s of wall time, then it starts anyway with `note: "started after 60 s with 3
  builds and 1 lookup pending: this run may differ"`. `load_scene` / `open_scene { timeline: "pause" }` and `timeline
  restart { paused: true }` end the prepare in `ready`, held at t = 0 until `timeline play`.
- **A live scene that gains its first cue or steps** is `stopped` (never auto-starts while Claude authors); `timeline
  play` starts it live with t = 0 at the next tick, `restart` replays it from the placements.
- **Errors.** A cue is marked processed before its lever runs and caught per cue: a throw is `failed` with the
  message, never re-fired. `FireCue` maps each action to its lever (`OrderShip`, `FleetOrderNow`, `SwitchPropMods`,
  `SwitchModules`, `SetTarget`, `Engage`, `CeaseFire`, `AutoRepairNow`, `PlayShot(…, 'timeline', time)`, `StopShot`,
  `CueEdit`) and keeps a compact result (scalars kept, lists counted, the first 10 skips and warnings).
- **Ship scripts** (`ShipScripts`): a live ship with `orders` starts its script at the next played tick; an `orders`
  change (JSON) restarts it from step 0 ("its orders changed"); a removed ship's script goes. A step's order is given
  in the hook (through `OrderShip`, so names resolve and a fleet member detaches) once `after` ticks passed, waiting
  while the ship is `arriving` (a warp-in) or in warp. It ends `ceil(duration)` ticks after it was given, or on
  completion (`shipStepCompletion`; a warp completes on a landing of its own warp, not one it began with). States
  `waiting`, `arriving`, `flying`, `holding` (the last, never-ending order), `done`, `failed` (a refusal, or the world
  dropped the order: `orderNote`), `interrupted` (the ship flies another order), `destroyed`.
- **Camera cues** play with the `timeline` cinema driver from the boundary's scene time (`sd-cinema`); `stop_shot`
  cues stop only a timeline shot (else `skipped`); `timeline { camera: false }` releases a timeline shot and skips
  later camera cues (until the tab reloads).

## The authored document and the live scene

Document cues (`patch_scene`, `auto_repair`, `order_fleet` anchor / break-off / regroup) change **the live scene only**
(`CueEdit`: `applySceneOperations(live)` → `ApplyNow` → a live edit → `FinishApply` outside the edit queue, no store
write). `get_scene`, `save_scene` and the working copy keep the authored document, so saving mid-play saves the script,
not its effects, and a restart replays it. Details, user edits while live edits exist (live-only, authored-only) and the
Apply split: `sd-scene-document` "The authored document and the live scene". The live scene normalizes ship steps that
target cue-added ships as names; the user sees the authored document's warnings, never the live normalize's.

- **Timeline edits while it plays** (`TimelinePlayer.Edit`): a new or retimed cue whose due second is still ahead is
  pending; one in the past is `missed` ("added after its time: it plays from the next restart"); a fired cue keeps its
  record (an edit notes "edited after it fired: the edit plays on a restart"; a removal keeps it in the log, "removed
  after it fired"). A scene that loses every cue and step goes `idle`.

## Reporting

- **get_state** `timeline` (null when idle): `state`, `time`, `startedAt` (world tick of t = 0), `camera`, `cues` (total
  and per state), `next` (≤ 5 pending, with `in`), `last` (≤ 5 processed), `failed` (≤ 10 with `error`), `scripts`
  (counts per state), `liveEdits { count, last }`, `preparing { seconds, waiting: lookups, fits, builds, fleets,
  objects, location }`, `note`. Each scripted ship: `script { state, step, steps, order, startsIn, endsIn, note }`.
  `simulation.held: true` while the clock is held. The HUD row: `playing · 42 s · 7/12 cues (1 failed)` or
  `preparing · 3 builds and 1 lookup`.
- **The `timeline` tool** (page, in the hub's `SLOW_TOOLS`): `{ action?: status | play | pause | restart, paused?
  (restart only), camera? }` → the summary plus `list` (every cue: id, at, name, action, kind, state, tick, note, error,
  result), `ships` (every script), `liveEdits` (source, cue, tick, operation count, adds) and `held`; `restart` adds the
  load's `warnings` and `changes`. `play` on an idle scene throws "the scene has no timeline or ship orders".

## Seams for Time control and Movie mode

`TimelinePlayer.Snapshot()` / `Restore()` (cursor, played, cue records, camera, the scripts' plain state) round-trip
through `structuredClone` (spec'd); `liveEdits` lets a jump back re-derive the live scene. `SceneClock.Hold` is the
primitive Time control's pause generalizes. Due ticks per cue are where event cues (`when`, reserved) plug in; Movie
mode replaces `missed` with re-simulation.

## verify-page (`--only timeline:`, headless, real tools-core)

Checks (a)–(i) of the plan, each loading its own scene of stats-carrying Rifters (only the targets check needs the
SDE). Run 2026-10-23 on dbxpc: a load showed `preparing (held)`, t = 0 after the load, cues fired at +0, +3, +3, +5 with
the MWD active since t + 3; a script ran `0:flying → 1:flying → 2:waiting → 2:flying → 3:flying → 4:done` with its after
and duration on the tick; a patch cue's `late` was live but not authored, saved files had 1 ship and 2 cues, and a
restart removed it until 2 s; a targets cue fired at +1 and both members took `called` targets; edits while playing gave
`missed`, a retimed cue fired, `remove_ship b` pruned its cue, `remove_ship a` was refused naming the patch cue that
moves it, and an edit of the cue-added ship applied live only; a 5-tick pause shifted a 4 s cue to +9; camera cues
drove the cinema as `timeline`, the stop cue made it idle and camera off skipped the next; bad timelines were refused
with every problem (reading problems in one load, unknown ids in another: a cue that fails to read skips the
projection); a paused load held at t = 0 for 3 s, then played.

The full verify-page after the Apply split (T2): 129 ok, 1 skip (headless audio), 2 FAIL that both reproduce on the
pre-T2 commit (d272abf), built in a temp worktree: "a moving FC dies …" (a race: when the FC dies while the wing
commander still catches up, it slows by design; 1 run in 5 on HEAD, the same numbers) and "the warp-in shot anchors …"
(flank-port is not refused for an arriving fleet). Both filed as follow-ups.
