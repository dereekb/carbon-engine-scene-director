# The timeline and ship orders: the scene's script

> A scene document carries a script: a top-level `timeline` of cues that each run one existing lever at a scene time,
> and per-ship `orders` a ship flies in turn. Fetch before touching `packages/scene/src/lib/timeline/`, the document's
> `timeline` or ship `orders`, the timeline patch ops, or the page's `TimelinePlayer` / `ShipScripts`. The plan this follows: `~/.claude/plans/scene-timeline-and-per-ship-orders-validated-played-on-the-scene-clock-reported.md`
> (slices T1 document → T2 page player → T3 determinism → T4 `at` on the tools → T5 real-GPU look).

**Status: all five slices have landed** (T1 the document, T2 the page player, T3 determinism, T4 `at` on the tools, T5
the real-GPU scripted fight). The page plays the script on Destiny ticks, reports it, and replays it the same, and every
lever tool authors a cue with `at`.

**Movie mode** (plan `~/.claude/plans/movie-mode-one-authored-movie-of-fleet-and-camera-beats-on-the-scene-timeline-cu.md`,
slices M1 the document → M2 the page plays event cues → M3 edit-resimulate → M4 the movie camera across jumps → M5 the
`movie` tool → M6 verify-page and the real-GPU movie): the movie *is* this timeline, plus event cues, a `movie` block
and script edits that re-simulate. **M1 has landed** (event cues and the movie block in the document, below); until M2
the page keeps an event cue `waiting` and never fires it.

## Files (`packages/scene/src/lib/timeline/`, runtime-free, node-tested in `timeline.spec.ts`)

| File | Holds |
|---|---|
| `timeline.ts` | types, limits, `TIMELINE_ACTION_NAMES`, `cueActionOf`, `cueDueSecond` (ceil), `isEventCue`, `cueCheckSecond`, `describeCue` / `describeCueTiming`, `SceneMovie`, `DEFAULT_MOVIE_LETTERBOX`, the script thresholds the page uses. **No run-time imports but `events.ts`**: the folder and `../scene` import each other |
| `events.ts` | event cues (Movie mode): `CUE_EVENT_KINDS`, the phases, `FIRE_QUIET_SECONDS`, `MAX_TIMELINE_EVENTS`, `MAX_EVENT_COUNT`, `CueTrigger`, the `TimelineEvent` facts, `normalizeCueTrigger`, `cueTriggerReferences`, `cueTriggerMatches`, `cueEventDueSecond`, `resolveCueTrigger` (over an event log), `describeCueTrigger`, `describeTimelineEvent`; `events.spec.ts`. Imports only `../json` at run time |
| `actions.ts` | `TIMELINE_ACTIONS`, one registry entry per lever (`kind`, `read`, `references`, `advise`), `toTimelineScope`, `checkCueReferences` |
| `steps.ts` | ship `orders`: `SceneShipStep`, `shipStepCompletion`, `normalizeShipOrderSteps` |
| `projection.ts` | `sceneAtTimelineTime`, `timelinePatchScenes` (the scene after each patch cue: the page's prefetch), `sceneAddsBetween`, the `ApplySceneOperations` type |
| `normalize.ts` | `normalizeSceneTimeline`: read, ids, chains, the movie block, the check-second walk (derived `arms`, the projection, `adds` pinning), the deferred event-cue checks, the stored order |
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

- **A cue** is timed, `{ id, at, name?, <one action>, adds? }`, or an event cue, `{ id, when, at?, arms, name?, <one
  action>, adds? }` ("Event cues" below). `at` is seconds from play start in [0, 86,400]; a timed cue fires on the
  first 1 s tick at or after it (`cueDueSecond`). A cue needs `at` or `when` ("needs at (seconds from play start) or
  when (an event)"). A missing id gets the lowest free `cue-<n>`, in input order. A bare array is shorthand for
  `{ cues }`; a timeline without cues or a `movie` block is omitted. **The stored order**: by check second
  (`cueCheckSecond`: a timed cue's due second, an event cue's `arms`), stably, timed cues before event cues at the same
  second, then document order, which is the order they fire in on a shared tick. Messages index the **input** position.
- **Actions** are the lever tools' names with the tool's arguments as the value: `order_ship` (`{ id, order }`),
  `order_fleet`, `switch_prop_mods`, `switch_modules`, `set_target`, `engage`, `cease_fire`, `auto_repair`,
  `play_shot`, `play_sequence`, `stop_shot`, `auto_camera` (kind camera: `sd-cinema`'s director; removing the followed
  fleet or ship drops `follow` and keeps the cue), `patch_scene` (`{ operations }`). Each is read by its tool's normalizer and
  stored normalized, except camera shots (stored as written: a library shot expands when it plays) and patches (as
  written: ops apply when the cue fires). A patch cue may not carry the timeline ops or `set_environment` (a reload).
- **Kinds** (`entry.kind(args)`): `live` (orders, switches, locks, called targets: `order_fleet` targets is live since
  fb0f033), `camera`, `document` (`patch_scene`, `auto_repair`, and `order_fleet`'s anchor / break-off / regroup). T2
  applies document cues to the **live scene only**, so saving mid-play saves the script, not its effects.
- **Cues are a model's calls to the FC brain** (`sd-personalities`): an `order_fleet`, `order_ship`, `engage`,
  `cease_fire` or `switch_prop_mods` cue on a personality fleet takes its lever manual as the tool does
  (`Director.Manual`), and so do a ship script's steps on its acting FC. `order_fleet` cues run through
  `Director.FleetOrderNow(args, { cue })`, free-fire and stance orders included (both `live`; a stance's `on` is a
  reference, so removing that ship, squad or wing prunes the cue). A ship step may be a stance order (`given`).
- **Limits**: 1,000 cues, 50 patch cues (each costs a projection step), 32 ops per patch cue, 64 steps per ship.
- **Event cues and the `movie` block** are Movie mode's (below). Ship `orders` keep their own completion chaining: a
  ship step waiting for an event is an `order_ship` event cue.

## Event cues (Movie mode M1)

```json
{ "id": "go", "when": { "arrival": { "fleet": "red" }, "after": 1 }, "arms": 5, "order_fleet": { "fleet": "blue", "order": { "type": "approach", "target": "red-fc" } } },
{ "id": "next", "when": { "kill": { "primary": "blue" } }, "arms": 0, "order_fleet": { "fleet": "blue", "order": { "type": "targets", "next": true } } },
{ "id": "logi-out", "when": { "kill": { "ship": "blue-fc" }, "latest": 70 }, "arms": 0, "order_fleet": { "fleet": "blue", "squad": "logi", "order": { "type": "break-off" } } }
```

- **`when`** holds exactly one kind with its filter (`{}` matches any), plus `count` (the nth match, 1–1,000, default
  1, omitted when 1), `after` (seconds in [0, 86,400], omitted when 0) and `latest` (timeline seconds: the cue fires then
  if its event has not come; refused before `arms`). Kinds and filters (`normalizeCueTrigger`; unknown kinds and keys,
  bad phases, `wing` with `squad` or without `fleet`, `primary` without a fleet are problems):
  - `kill { ship?, team?, fleet?, wing? | squad?, primary?: "<fleet>" (the victim was a live called primary of that
    fleet, any level), by?: { ship?, team?, fleet? } }`;
  - `arrival { fleet?, ship? (its group), phase?: first | landed (default) | formed }`;
  - `warp { ship?, team?, fleet?, phase?: exit (default) | enter, arrival?: bool }`;
  - `cue: "<id>"` (that cue fired: not skipped, not failed);
  - `primary { fleet, wing? | squad?, ship? }` (that group's own call changes; without wing or squad, the fleet's);
  - `fire { ship?, team?, fleet?, target? }` (a ship's first shot after `FIRE_QUIET_SECONDS` 10 without shooting).
- **When it fires**: an event in timeline second `p` makes the cue due at `p + max(1, ceil(after))`
  (`cueEventDueSecond`): the first tick at or after event + after, never the event's own tick. `resolveCueTrigger` reads
  an event log (`TimelineEventEntry { second, event, text }`): the nth match with `second ≥ arms` and before
  `ceil(latest)` resolves it; else `latest` makes it due then (`late`). Texts: `describeCueTrigger` (`the 1st kill`,
  `the kill of blue's called primary`, `fleet red landed + 2 s`, `red-fc's warp exit`, `cue go fired`, `blue calling
  red-fc`, `team red opening fire, at 70 s at the latest`); `describeCue` gives `"next" (order_fleet when …)`.
- **`arms`** (derived and stored, like `adds`; a written one is re-derived; `update_cue` refuses it): `at` when given,
  else the first second everything the cue names exists: each id in its action and its filter (the check second of the
  patch cue adding it; 0 for the base scene; a place name needs nothing) and, for a `cue` chain, the chained cue's check
  second.
- **The walk** (`projectCues`) visits cues in check-second order and derives each waiting event cue's `arms` as soon as
  what it names exists, so an event cue armed at 5 sees a patch cue at 5 whatever their document order. Its action is
  checked against the scene at `arms`. An event cue with an `at` too early is refused with the fix: `timeline.cues[1]
  ("go").order_fleet.fleet: no fleet "red" at 0 s, when the cue arms: give at 5 or later (cue "adds" adds it), or leave
  at out`. Filter ids are checked after the walk against everything the scene ever holds (base + every patch cue's
  adds): "not yet" is fine, never is `… no ship "ghost", now or added by any cue (…)`.
- **Event patch cues** (a warp-in "when blue's FC dies") apply in the walk at their check second (the earliest they can
  fire) and pin `adds` as usual; a timed cue (or event cue with an `at`) naming what one adds warns `… ship "late" is
  added by event cue "reinforce" (when the kill of blue-1): it may not exist yet at 40 s`. An `arms` that cannot be
  derived because cues wait on each other's adds is a problem ("give at").
- **Chains**: a `cue` filter must name another cue (`cue "c" waits for cue "gone", which is not in the timeline: remove
  or re-cue "c" first`; this is also how `remove_cue` of a waited-for cue is refused); a cycle is a problem naming the
  cues (`cues "a" → "b" → "a" wait for each other: none of them can fire`).
- **Cost (measured 2026-10-23)**: 250 ships with 20 patch cues normalize in ~19 ms, and with 20 event cues added ~15
  ms (noise): the event checks are one more pass over the cues, nothing per ship.

## The movie block

- `timeline.movie: { letterbox?: number in [0.5, 4] | false, hud?: boolean, end?: timeline seconds in (0, 86,400] }`.
  `{}` is a movie with the defaults: letterbox `DEFAULT_MOVIE_LETTERBOX` 2.39, HUD off, no end. Unknown keys warn and
  are dropped; a timeline with a movie block and no cues is kept (a movie being started).
- `set_movie { movie }` merges into it (a `null` key resets that key; `movie: null` removes the block; it creates `{
  cues: [] }` when there is no timeline). Like the other timeline ops a patch cue may not carry it.
- It lives in the authored document only (the live scene has no timeline). What the page does with it (the look while
  the timeline plays, the end through `TimeControl.StopAt`) lands in M5.

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
  `cueCheckSecond ≤ seconds` (an event patch cue from its `arms`), in the stored order (`timelinePatchScenes` alike). The hub tools given `at` resolve against it (`get_scene { at }`, "Authoring").

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
| `update_cue { id, set }` | merged: `at`, `when`, `name` (`null` clears), or one action key, which replaces the cue's action and clears `adds`; `at: null` on an event cue leaves it to derive `arms`, `when: null` makes it timed (each refused when the cue would have neither); `id`, `adds`, `arms` and a `null` action are problems |
| `remove_cue { id }` | an unknown id is a problem |
| `set_timeline { timeline }` | replaces it whole; `null` removes it |
| `clear_timeline` | removes it; a no-op without one |
| `set_movie { movie }` | merged into `timeline.movie`; a `null` key resets it; `null` removes the block |

## Removal pruning (as called targets prune)

`removeTimelineReferences(removal, context)` runs on the draft, tolerant of malformed cues (left for normalize):

- A cue whose subject or target was removed goes, with `timeline: cue "go" (order_fleet at 15 s) was removed with fleet
  "blue"`: an `order_ship` on or at it, a selection's fleet / wing / squad (a removed fleet takes its wings and squads;
  `remove_wing` passes its squads), a target, a targets `primary`, `by`, an anchor or break-off ship, a camera subject.
- A `ships` selection and a targets `queue` / `set` / `drop` lose the id (`… no longer names "x" (it was removed)`); the
  cue goes when the selection, queue or drop empties (an emptied `set` stays: it clears the list).
- An event cue whose **filter** names what was removed goes too: `timeline: cue "dies" (stop_shot when the kill of
  blue-1) was removed with ship "blue-1"`. Cues chained on a dropped cue go with it, transitively: `timeline: cue
  "after" (stop_shot when cue dies fired + 2 s) was removed with cue "dies", which it waited for`. An explicit
  `remove_cue` of a waited-for cue is refused instead (an explicit edit gets an explicit fix). Team references are never
  pruned (a removal that empties a team is refused).
- Ship steps aimed at a removed ship or object are dropped: `ships[2].orders[1] (orbit "red-fc") was dropped`.
- **`patch_scene` cues are never pruned** (nor cascaded): a patch that no longer applies, or that waits on a removed
  subject or a dropped cue, refuses the removal (above), the same rule as "a fleet commander is never removed
  implicitly".

## Playing it (the page)

- **When cues fire.** `DestinyWorld.OnBeforeBoundary` runs at the top of a due boundary, **before `ApplyPropMods`**
  (`sd-destiny`), so a cue is exactly the MCP call made just before that tick: an order applies at this boundary, a prop
  mod switch-on is active since this boundary, a module activation lands in this boundary's cycle, a lock starts at the
  next. Within one tick the ship scripts step first (`ships[]` order), then the due cues fire in the stored order (by
  check second). An event cue is `waiting` (`CUE_STATES`), with no due second, until its event resolves it (M2; until
  then it never fires and the timeline never reads `done`). Fast-forward (`sd-time`) steps `Tick` once per boundary, so it fires every cue on its tick; pause runs no boundary, so the cursor waits.
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
  building; every fleet planned (`FleetFollowing.Ready`); every object built; the location not loading; every prefetch
  for the ships the patch cues add settled (counted as lookups, "Determinism"). Then the clock
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
- **A step's target destroyed** (since T5) is not a failure: in a scripted fight the target dying is the end of an
  attack run. A running step the world stopped because its target died (`Alive(target)` false) ends there, note `step 0
  (orbit red-fc) ended: its target was destroyed`, and the next step follows its `after`; a step whose turn comes with
  its target already dead is skipped (`… was skipped: its target was destroyed`). Any other dropped order still fails.
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
  and per state, `waiting` included), `next` (≤ 5 pending with a due second, with `in`), `waiting` (≤ 5 event cues: `id`,
  `when` text, `armsIn`; M2 adds `latestIn`, `beat`, `events`), `last` (≤ 5 processed), `failed` (≤ 10 with `error`), `scripts`
  (counts per state), `liveEdits { count, last }`, `preparing { seconds, waiting: lookups, fits, builds, fleets,
  objects, location }`, `note`. Each scripted ship: `script { state, step, steps, order, startsIn, endsIn, note }`.
  `simulation.held: true` while the clock is held. The HUD row: `playing · 42 s · 7/12 cues (1 failed) · 2 waiting` or
  `preparing · 3 builds and 1 lookup`.
- **The `timeline` tool** (page, in the hub's `SLOW_TOOLS`): `{ action?: status | play | pause | restart, paused?
  (restart only), camera? }` → the summary plus `list` (every cue: id, at, `whenText` and `arms` (event cues), `due`,
  name, action, kind, state, tick, note, error, result), `ships` (every script), `liveEdits` (source, cue, tick, operation count, adds) and `held`; `restart` adds the
  load's `warnings` and `changes`. `play` on an idle scene throws "the scene has no timeline or ship orders".

## Authoring with `at` (T4)

Every cueable tool takes `at` (seconds, `AT_ARGUMENT`) and `cue` (its id, `CUE_ARGUMENT`): with `at` nothing runs now and
the call becomes a cue. `packages/scene/src/lib/tools.ts` adds both, and the shared sentence (`CUE_TEXT`; the hub tools'
`HUB_CUE_TEXT`), to every tool in `CUEABLE_TOOL_NAMES` = `TIMELINE_ACTION_NAMES` + `CUEABLE_HUB_TOOL_NAMES`
(`cueable()` over `TOOL_LIST`); `patch_scene` also takes `name` (the cue's).

- **Page levers** (`order_ship`, `order_fleet`, `switch_prop_mods`, `switch_modules`, `set_target`, `engage`,
  `cease_fire`, `auto_repair`, `play_shot`, `play_sequence`, `stop_shot`, `patch_scene`): `Director.Handlers()` wraps
  each `TIMELINE_ACTION_NAMES` handler; `at` or `cue` routes to `AddCue(action, args)`, which builds `{ id?: cue, at,
  name? (patch_scene's), [action]: the rest }` (`patch_scene: { operations }`) and runs `EditNow([{ op: 'add_cue', cue }])`
  in the edit queue. So it validates exactly as a document edit (against the scene as projected to the cue's time) and
  the player takes it as any timeline edit. No lever is taken now (`Manual`): the cue takes it when it fires.
- **The result**: `{ cue (as stored, `adds` derived), state (its record: pending, or missed), timeline (get_state's
  summary), warnings }`. The warnings are the document's that name the cue (`"<id>"`: a name target, "may fail when it
  fires", a re-pin), plus `cue "x" at 1 s is behind the timeline (4 s played): it is missed, and plays from the next
  restart` while it plays, and `the timeline is stopped: timeline play starts it …; timeline restart replays it from
  the placements` on a stopped one (a live scene's first cue).
- **Hub tools** (`add_fleet_composition`, `add_ships`, `stage_engagement`, `add_objects`): resolve as without `at`, on
  `get_scene { at: ceil(at) }`, then dry-run the ops and wrap them in one `add_cue` with `patch_scene` (`ScenePlaces`,
  `sd-staging`), named `add_ships 2 Guardian`, `add_fleet_composition red`, `stage_engagement red vs blue`,
  `add_objects Astrahus`. Same result plus their resolution reports; with a passed `scene` the cue goes into its
  timeline (`loaded: false`).
- **Not cueable**: `frame_camera` (follow-up), `set_location` (a patch cue can carry the raw op), `set_fleet_personality`
  (a patch cue's `update_fleet set { personality }`), the saved-scene tools.
- Claude computes `at` from get_state's `timeline.time`; there is no "in 30 s from now".

## Determinism (T3)

One script on one tools-core replays the same: cue and step ticks relative to t = 0, landings, kills and final positions
(verify-page (j)). What makes it so:

- **Ticks, not frames.** Cues and steps fire in the world's pre-boundary hook in a fixed order; t = 0 is the first
  boundary after a prepared, held load; combat rolls are keyed on the document's seed and module activation counts.
- **Scene ticks.** `Director.SeedTick(tick)` = `tick − loadTick` (the world tick at the last load, set in `ApplyNow` on
  a restart; t = 0 for a scripted load). Pilot delays (`FleetOrders` `seedTick`, the director's `PilotDelays`, free
  fire, `switch_prop_mods`, `switch_modules`) and warp-in staggers (`Arrivals` `seedTick`) hash it. Reports keep
  absolute ticks (`startedAt` is the world tick of t = 0).
- **The scene epoch** (`DestinyWorld.SetSceneEpoch(loadTick)`, every load; `sd-destiny`). Destiny is time-invariant for
  every order but the legacy orbit, whose plane turns by the park's absolute tick (`currentTime × 0.001` rad) and is
  seeded by the ball id's low 16 bits: the parks (`ScenePark`) count orbit time from the epoch, and after it a ship's new
  ball id takes its document id's hash as its low 16 bits, so a cue-added or revived ship orbits the same in every run.
  `destiny-timeline.spec.ts` checks two worlds 37 ticks apart (with different ball histories) fly direction, approach,
  orbit, keep-at-range, MWD and goto to identical ball states.
- **Prefetch.** On a scripted load `Director.PrefetchCues` walks `timelinePatchScenes` (the scene after each patch cue)
  and `Prefetch`es every ship it adds or changes (keyed on hull, fit text and prop mod; live ships skipped): its
  `/ship-stats` answer, prop mod, fit names and types (or default weapons' hull dogma and fit), with no live entry.
  `SceneSettled` waits for them, so a cue-added ship's flight numbers are cached when the cue fires and `Retune` flies
  it at once.
- **Scripted warp-ins plan on flight numbers** (`CueEdit` → `ApplyNow(…, { waitForBuild: false })` →
  `Arrivals.Add(arrival, { waitForBuild: false })`): at the cue's own boundary, not after the SOF builds (`sd-staging`
  "Warp-in").
- **A fleet order cue's result keeps its `delays`** (the timeline tool's `list[].result`).

**Limits.** A cue-added hull is drawn once built: on a slow machine a big fleet's hulls may appear after they land (the
SOF build is not prefetched). Ships without the SDE take their class values' radius from the build, so a cue-added
fleet's formation waits on builds and is not tick-exact. Live input during play (a user's command) changes the run, as it
should. A prepare that hits the 60 s cap says the run may differ.

## Seams for Time control and Movie mode

`TimelinePlayer.Snapshot()` / `Restore()` (cursor, played, cue records, camera, the scripts' plain state) round-trip
through `structuredClone` (spec'd). **Joined with time control (T2b, `sd-time`)**: every time-control snapshot holds the
player, the live scene and `liveEdits`, so a jump puts the cursor back and the cues after the target fire again as play
resumes. The tape replays before the cues (TimeControl's `OnBeforeBoundary` listener is registered before the
director's). Lever cues need no journal and patch cues do not cut the window (they go through `ApplyNow`, not `Apply`);
`RestoreSim` retires the live entries of ships absent from the restored live scene and the re-fired cue re-adds them.
A cue's warp-in plans on flight numbers (`waitForBuild: false`), so its builds landing do not cut and a jump crosses it:
the group lands again on the same ticks (T3, verify-page `time:`). Limit: a cue-added ship's build landing still cuts the
window when the hub has no SDE radius for it (the build gives its formation radius). `SceneClock.Hold` and Time
control's pause (`clock.paused`, `sd-time`) both stop the clock; they are independent. A record's due second is where event cues plug in (null while `waiting`; M2
resolves it from the page's events); Movie mode replaces `missed` with re-simulation (M3).

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

T4 (2026-10-23, dbxpc): (l) `order_fleet` (`cue: "go"`, at 3), `switch_prop_mods` (at 4, id `cue-1`) and a pose
`play_shot` (at 2) on an unscripted fleet scene returned pending cues and the stopped warning, changed nothing for
2.5 s (no order, prop mod off, cinema idle; timeline `stopped`, 3 pending), then `timeline play` fired them at +2, +3,
+4, and an `order_ship` at 1 s added at 4 s came back `missed`. (m) (SDE) `add_fleet_composition` of an inline Rifter
composition by hull name with `warpIn`, at 5: the cue's op had dna filled and adds `wr-fc`, `wr-s-01`, `wr-s-02`, fleet
`wr`; nothing was added; it fired at +5 and `arrivals` reported group `wr`. (n) A paused load with a patch cue at 5:
`get_scene { at: 4 }` lacked `rw-fc`, `{ at: 5 }` held it (no timeline); `add_ships` near `rw-fc` at 4 was refused (`no
ship "rw-fc"`), at 8 cued two ships and fired at +8. (a)–(i) passed in the same run.

T3 (2026-10-23, dbxpc, SDE): (j) 3 Punishers (fleet b) vs 3 Rifters, seed 7, death `explode`; cues engage at 1, a fleet
approach with `delay: 0.5` at 2, a patch warp-in of 2 Rifters (inline composition) at 3, a targets call at 6, a fleet
stop at 25; run to 55 s, `timeline restart`, run again: t = 0 at world ticks 2 and 58, cues at +1/+2/+3/+6/+25, landings
`rw-fc` +12 and `rw-dps-01` +15, kills b1 +22 and r1 +46, and the 6 surviving ships' final positions equal in both runs.
(k) the approach cue's delays `{ b1: 0, b2: 4, b3: 4 }` and the landing offsets `[0, 3]` were equal across both runs.

## Real-GPU evidence (T5, 2026-10-23, dbxpc, Windows Chrome, NVIDIA Lovelace, `?audio=off`)

The plan's scripted fight, authored with the tools on a private hub (temp stores). `set_location` 30 km off Jita IV -
Moon 4 - Caldari Navy Assembly Plant (the station ~100 km beyond, along +Z); `add_ships` 6 Punishers (fleet `blue`, team
blue, at the origin, heading 0). Then, all with `at`:

- an inline 6-Rifter composition (`red`, team red, `near` blue-fc 25 km ahead, heading 180, `warpIn`) at 5;
- `play_shot warp-in` on red at 5;
- blue `switch_prop_mods` on and `order_fleet` approach red-fc at 15;
- blue `targets set [red-fc, red-dps-01, red-dps-02]` and red `engage` blue-fc at 25;
- `overlook-pull-out` at 26; blue prop mods off at 30; `hero` on blue-fc at 45;
- and blue-dps-05's `orders` `[{ after: 20, orbit red-fc 2500, duration: 30 }, { stop }]` by `patch_scene update_ship`.

Every call returned a pending cue with the stopped warning; then `timeline restart`.

- **Every cue fired on its tick, none failed**: +5, +5, +15, +15, +25, +25, +26, +30, +45. The patch cue's live edit
  added red's 6 ships, fleet, wing and squad. Red landed at +14, +14, +16, +17, +18 and +18.
- **Kills**: blue-fc +32 (by red-dps-03), red-fc +40, red-dps-01 +47, red-dps-02 +51. Then blue's called list was
  spent and red's target was dead, so the fight stopped there, as scripted.
- **Replay**: three runs from `timeline restart` (one before the fix below) gave the same fire, landing and kill ticks,
  and the same killers.
- **The bug it found** (the "A step's target destroyed" rule above; `ship-scripts.spec.ts`):
  - Blue's focus fire killed red-fc at +40, inside blue-dps-05's 30 s orbit.
  - Destiny stopped the orbit (`stopped: target "red-fc" was destroyed`), so the script went `failed` and its `stop`
    never ran.
  - With the fix: the orbit ran +20 to +41, `stop` was given at +41, and the script was `done` at +55, once the Punisher
    slowed under 1 m/s.
- **fps** (a 1754 × 1248 device-pixel canvas): mean 39.4, min 22, over a 75 s run without screenshots; the min is at +6 and +7, while
  red's hulls build. With 1–3 screenshots a second the mean was 35.8 and the min 1 (the first second after the restart
  rebuilt the scene). `gpuErrors` 0, and no `page_log` errors in any run.
- **Save mid-play**: `save_scene` at t 20 wrote 6 ships (blue only) and the 9 cues, blue-dps-05's orders intact: the
  authored script, not its effects.
- **Look** (the screenshots are in `.scratch/timeline-gpu/` on dbxpc):
  - t 4: the user camera.
  - From +5: the warp-in shot cut to 5 km short of red's landing, looking up the lane at the station's face. The
    Rifters streak in with warp trails and land in formation, but at that range they are ~6 px in the 877 px wide
    screenshot: the shot frames the group's 2 km spread.
  - t 16: the shot still holds on red, so blue's MWD trails (on since +15, 6 ships, none skipped) are behind the camera.
  - t 27: the overlook pull-out over the fight, with turret fire.
  - t 46: the hero cue on blue-fc, destroyed at +32. It played on the wreck until the cinema released it ("its subject
    was destroyed").
