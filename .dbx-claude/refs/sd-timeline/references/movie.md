# Movie mode: event cues on the page, edit-resimulate, the movie tool

> The page side of Movie mode (plan `~/.claude/plans/movie-mode-one-authored-movie-of-fleet-and-camera-beats-on-the-scene-timeline-cu.md`).
> The document side (event cue syntax, `arms`, the check-second walk, chains, pruning, the `movie` block, `set_movie`)
> is the main `sd-timeline` REF ("Event cues", "The movie block"). **M2 to M5 have landed** (the page plays event
> cues on their events; script edits re-simulate, "Edit-resimulate" below; the movie camera comes back the same after a
> jump, "The movie camera" below; the `movie` tool, the movie's look and its end, "The movie tool" below); M6 the full
> verify-page and the real-GPU movie are next.

## Files

| File | Holds |
|---|---|
| `packages/scene/src/lib/timeline/events.ts` | the triggers, `TimelineEvent` facts, `cueTriggerMatches`, `cueEventDueSecond`, `resolveCueTrigger`, the texts (pure; `events.spec.ts`) |
| `apps/viewer/src/lib/timeline.ts` | `TimelinePlayer.Event`, the event second rule, the log and its cursor, `latest`, the reports (`timeline.spec.ts`) |
| `apps/viewer/src/lib/arrivals.ts` | `Arrivals.Transitions(boundary)`: the arrival phases (`arrivals.spec.ts`) |
| `apps/viewer/src/lib/fleet-targets.ts` | `FleetTargets.PrimaryGroupsOf(ship)`: a kill's `primaryOf` (`fleet-targets.spec.ts`) |
| `apps/viewer/src/lib/director.ts` | the five sources (`TimelineEvent`, `KillEvent`, `EventParty`), `AddCue` with `when` |
| `packages/scene/src/lib/tools.ts` | `WHEN_ARGUMENT` on every cueable tool, the `CUE_TEXT` clause, `SCENE_FORMAT`'s event cue text |
| `apps/scene-director/src/lib/hub/scene-places.ts` | `ReadCueTarget` with `when`, `CueTargetSecond`, `CueApply` passing it (`staging.spec.ts`) |
| `packages/scene/src/lib/timeline/script-edit.ts` | M3: `scriptEditOf`, `scriptEditIsEmpty`, `scriptChanged`, `firstChangedStep`, `withScriptOrders` (pure; `script-edit.spec.ts`) |
| `apps/viewer/src/lib/timeline.ts` / `ship-scripts.ts` | M3: `TimelinePlayer.Accepts` / `Rescript` / `AbandonFuture`; `ShipScripts.Swap` / `Record` (`timeline.spec.ts`, `ship-scripts.spec.ts`) |
| `apps/viewer/src/lib/time-control.ts` | M3: `MarkOrigin`, `AbandonFuture`, `Resimulate` over `Run`, the port's `AfterRestore` (`time-control.spec.ts`; `sd-time`) |
| `apps/viewer/src/lib/director.ts` | M3: `ScriptEdit` in `EditNow`, `PrefetchFor`, `MarkTimelineOrigin`, `ScriptAfterRestore`, `SimState.authored`, `AddCue`'s `resimulated` |
| `apps/viewer/src/lib/movie.spec.ts` | M3: the determinism oracle (`TimelineRig`) |
| `apps/viewer/src/lib/cinema.ts` / `camera-director.ts` | M4: `CinemaRig.Snapshot` / `Restore`, `CameraDirector.Snapshot` / `Restore` (`cinema.spec.ts`, `camera-director.spec.ts`) |
| `apps/viewer/src/lib/director.ts` / `timeline.ts` | M4: `MovieOwnsCamera`, `movieCamera`, `SimState.camera`, the camera director port's `Silent()` / `Settled()`; `TimelinePlayer.cameraCues` |
| `packages/scene/src/lib/timeline/movie.ts` | M5: `MOVIE_ACTIONS`, `BEAT_LANES`, `CAMERA_BEAT_ACTIONS`, `beatLaneOf`, `movieLookOf`, `DEFAULT_MOVIE_LEAD_SECONDS`, `normalizeMovieCommand` (every problem at once), `MovieReport` / `MovieBeatReport` / `MovieEditResult` (pure; `movie.spec.ts`) |
| `packages/scene/src/lib/tools.ts` | M5: the `movie` entry after `time_control` (hub `SLOW_TOOLS`); `play_shot`'s live-preview sentence |
| `apps/viewer/src/lib/movie.ts` | M5: `MovieReportOf`, `BeatReportOf`, `BeatTime`, `SeekChunks`, `MovieLookApplies`, `MoviePresentation`, `FramePresentation` (no runtime; `movie.spec.ts` "the movie report") |
| `apps/viewer/src/lib/time-control.ts` | M5: `StopAt(clock, onStop)`, `stopsAt`, `recordedEnd` (`time-control.spec.ts` "StopAt"; `sd-time`) |
| `apps/viewer/src/lib/director.ts` / `main.ts` | M5: `Movie` (the handler) and its `MovieEdit`, `MoviePlay`, `MovieSeek`, `MovieRetake`, `MovieJump` / `MovieJumpTo`, `MovieReport`, `ArmMovieEnd`, `NextFrames`, `Presentation()`; `TimelinePlayer.Records()`; main.ts's `Presentation.Apply(director.Presentation())` with the L / H run override |

## The record

`TimelinePlayer`'s record of an event cue holds `when` (the normalized trigger), `whenText`, `arms`, `latest`, `matched`
(events counted), `due` (null while it waits) and `event` (`{ second, text }`, what resolved it). Its state is `waiting`
until then, `pending` with a due second after; it then fires like a timed cue due that second, in record (stored)
order. A record also keeps `second`, the timeline second it was processed at (the beats).

## The event second rule

`Event(event)` works only while `playing` (paused, stopped, ready: ignored; the cursor waits) and gives the event a
timeline second:

- delivered inside the player's own `Boundary` (a cue firing, a targets cue moving a primary): `played`;
- anywhere else: `played − 1`, the boundary that last ran. That covers the `OnBoundary` listeners (kills, arrival
  phases, shots), a warp in `TrackWarps` after the evolve, a live hub call between ticks, and its tape replay at the next
  boundary's `OnBeforeBoundary` (which runs before the player's). So a live call and its replay land on one second.

A waiting record armed by then (`arms ≤ second`, and the second before `ceil(latest)`) whose trigger matches counts
it; the nth (`count`) makes it due `second + max(1, ceil(after))` (`cueEventDueSecond`): never on the event's own tick.
In `Boundary(p)`, before the scripts step, a waiting record whose `cueDueSecond(latest) ≤ p` becomes due `p` with the
note `its event (the kill of ghost) had not happened by 4.5 s`. Each fired, skipped or failed cue is then an event
`{ kind: 'cue', cue, state }` (a `cue` trigger matches only `fired`).

## The sources (`director.ts`)

Each goes through `TimelineEvent(() => facts)`, which builds the facts only while the timeline plays.

- **kill**: an `OnKill` listener. `victim` and `killer` are `EventParty(id)`: the ship's team and its document fleet,
  wing and squad (`toFleetMemberships(this.scene)`, memoized per scene object: the dead ship is still in its fleet).
  `primaryOf`: the fleets with a group whose last synced primary was the victim (`FleetTargets.PrimaryGroupsOf`; this
  boundary's `SyncFleetTargets` ran before the shots resolved).
- **arrival**: `Arrivals.Transitions(boundary)` right after `arrivals.Boundary` in the `OnBoundary` listener, only
  while playing, never from `FinishApply`'s asynchronous `arrivals.Boundary`. Per planned group, once each: `first` (a
  ship out of warp), `landed` (every ship), `formed` (every ship formed), in that order; `firstAt`, `landedAt` and
  `formedSeenAt` are group fields, so they ride the arrivals snapshot. Facts: `group`, `fleet`, `phase`, `ships`.
- **warp**: `world.OnWarp`: `ship` (a party), `phase` (`enter` / `exit`), `arrival` (a warp-in landing).
- **primary**: an `OnPrimary` listener: `fleet`, `wing` or `squad` (the group), `primary`, `previous`.
- **fire**: turret shots from an `OnShot` listener (a shot with `missile` set is a missile's hit, skipped) and missile
  launches in `Launches` (after `LaunchMissile` accepts): `shooter` and `target` parties. The player applies the quiet
  rule: `lastShot[ship]` (snapshotted) is updated by every shot, and a shot counts as `fire` only when the ship had not
  shot for `FIRE_QUIET_SECONDS` (10) or never had.

## The event log

- Outside the snapshotted data: an array, with `logCursor` inside it (`TimelineSnapshot`). Appending writes at the
  cursor: an equal entry (JSON) already there (a replay) is kept and the cursor moves on; a different one (drift, a
  diverged run) truncates the array after the cursor first. `Restore` moves only the cursor, so a jump forward into the
  recorded future keeps the log that recorded it, and a jump back re-writes the same entries.
- `Events()` is the history up to the cursor. A load, a scene that loses its script, and `timeline play` from
  `stopped` start a new log.
- **The cap**: `MAX_TIMELINE_EVENTS` (5,000) entries per run; past it nothing more is logged (`events.full`), but
  event cues still resolve on intake.
- **Edits while playing**: an event cue added or edited is resolved against the log so far (`resolveCueTrigger` up to
  the cursor): its nth event already logged makes it due. When that is past the scene re-simulates from before it (M3,
  below); only the fallback (`Edit`) still marks it `missed` (`its event came before it was added: it plays from the
  next restart`), a latest already passed likewise. `AbandonFuture` truncates the log at the cursor (a script edit's
  recorded future).

## Reports

- get_state `timeline`: `cues.waiting`, `waiting` (≤ 5: `id`, `when` text, `armsIn`, `latestIn`), `beat` (`{ fleet?,
  camera? }`: the last fired cue per lane, `{ id, name?, at }`, camera = `play_shot`, `play_sequence`, `stop_shot`,
  `auto_camera`), `events { count, last (≤ 5, newest first), full? }`. `next` keeps pending cues with a due second
  (timed or resolved). The HUD row: `playing · 42 s · 7/12 cues · 2 waiting`.
- The `timeline` tool's `list` adds `when`, `whenText`, `arms`, `latest`, `due` and `event`.

## `when` on the tools

- Every cueable tool (`CUEABLE_TOOL_NAMES`) takes `when` (`WHEN_ARGUMENT`) beside `at` and `cue`. On the page,
  `Handlers()` routes `at`, `when` or `cue` to `AddCue`, which builds `{ id?, at?, when?, name?, [action] }`; the edit
  normalizes it, derives `arms` and checks it against the projection. The result's `state` is `waiting`; a missed one
  warns `cue "x" (when …) is behind the timeline (…): its event came at 12 s, so it is missed …`.
- On the hub, `ReadCueTarget` reads `when` (an object, else `when must be an event: …`); `CueTargetSecond` resolves
  names on `get_scene { at }` at the cue's arm time, or with no `at` at `MAX_TIMELINE_SECONDS` (every patch cue
  applied: the event may come at any time); `CueApply` passes `when` on. `asteroid-fields` (not cueable) strips it.

## Edit-resimulate (M3)

An edit of the script that reaches into the past makes the run the edited script's, as a fresh run would play it,
instead of `missed`. This applies to every scripted timeline, not only movies.

- **What counts** (`scriptEditOf(before, after)`): the two documents equal once the timeline and every ship's `orders`
  are taken out. It returns `{ cues: { added, removed, changed }, ships: [{ id, step }], movie }` (`step` the first
  changed one, `firstChangedStep`: 0 when orders were added or removed), else null. Anything else mixed in takes the
  usual path (a cut when the simulation changes), warned `this edit changed the scene too, so the time window was cut:
  movie retake replays the movie with it` when it changed the script too (`scriptChanged`) and cut a recording
  window.
- **When** (`Director.ScriptEditable`): time control records, no jump runs, the clock is not held, and the timeline
  started (`startTick` set, playing or paused). Otherwise the usual path (`Edit`: pending or `missed`).
- **The divergence test** (`TimelinePlayer.Accepts(cues, ships, { state?, previous? })`) on a player state (the
  current one, or a snapshot's), against the edited script itself rather than the edit's lists (a snapshot can predate
  earlier edits): the state is playing or paused (a snapshot from before the timeline started has none to swap into);
  every processed record (fired, failed, skipped) has its cue unchanged in the new script; every new or changed cue is
  not due before the state's `played` (timed: `cueDueSecond(at)`; an event cue: `resolveCueTrigger` over the log up
  to the state's cursor, its `latest` included: `due ≥ played`); every live ship whose orders differ from its script
  record's has not reached the first changed step (`step < k`; orders removed: `k = 0`, so only with no record), and a
  ship with no record but new orders passes only before the first boundary (`played = 0`) or with unchanged orders. A
  `missed` record of an unchanged cue stays as it is. Downward-closed: when a state passes, every earlier one does.
- **The path** (`Director.ScriptEdit`, inside the edit queue, from `EditNow`):
  1. `applySceneOperations(authored, ops)`: a refusal takes the usual path (which throws it, or applies it live only).
  2. `PrefetchFor(authored, added + changed cues)`: the lookups of every ship those patch cues add or change
     (`PrefetchTargets`, the keys `PrefetchCues` uses), awaited with a `SCRIPT_EDIT_PREFETCH_SECONDS` (20) cap (past it
     the warning `… did not answer in 20 s: the re-simulated run may differ`). Not counted by the settle check, so
     recording goes on meanwhile. Frames run during the await: the conditions are checked again after it.
  3. `time.AbandonFuture()` and `timeline.AbandonFuture()`.
  4. The live scene's orders for the new script: `withScriptOrders(live, before, after)` (an authored ship takes its
     edited orders unless a live edit gave it others, which stay; timeline-added ships keep theirs). Only the ship
     scripts read orders, so the live scene is swapped directly (`SwapLiveScene`), with no apply and no cut.
  5. `Accepts` on the current state → `Rescript(cues, ships)`: kept cues keep their records, new and changed ones get
     fresh records (an event cue resolved against the log), and running scripts swap their steps in place
     (`ShipScripts.Swap`: step, state and `startAt` kept; the next step's `after` from the new steps). `resimulated:
     null`.
  6. Else `time.Resimulate({ accept, restored, edit })` (`sd-time`): `accept` runs `Accepts` on each snapshot's player
     with its live scene swapped by `withScriptOrders(snapshot scene, snapshot authored, edited)`; `restored` swaps the
     restored live scene and `Rescript`s the restored player. `resimulated: { from, to (timeline s; the origin reads 0),
     ticks, ms, cues, ships }`; get_state `time.jump.cause` `edit`.
  7. No snapshot passes (the window was cut since, a capped log) → the usual path, warned `the time window does not
     reach back to before this edit's first change (it holds 3–42 s of timeline time): timeline restart replays the
     script with it`.
  8. The authored document, the store write and `onChange` after a successful landing; a failed re-simulation leaves
     the scene and the document as they were and throws.
- **The pinned origin**: a timeline starting pins a snapshot before t = 0's boundary (`sd-time` "The window"), so
  every script edit can re-simulate, from t = 0 at worst, and edits at t = 0 (the first cue, a ship's first step) work.
- **A jump back after a script edit** keeps the edit (`AfterRestore` → `ScriptAfterRestore`, `sd-time`).
- **The oracle** (`movie.spec.ts`): a `TimelineRig` (a real world, TimeControl, TimelinePlayer and ShipScripts; cues
  order ships; the sim port captures the world, the player and the ships' orders; the director's path as `Edit`). Script
  A runs to tick 30, is edited, and equals a fresh rig of the edited script at tick 30 (master balls, cue and script
  states and ticks): a cue added at 8, a fired cue retimed, a fired cue removed, a `cue` event cue whose event already
  happened, a ship's step 1 changed while it flies step 0 (taken at once), a ship's step 0 changed (from the origin), and
  a future-only edit surviving `back: 12` (to tick 45).
- **Cost**: one synchronous task, as a jump (`sd-time` "Script edits re-simulate").

## The movie camera (M4)

A jump or a re-simulation inside a movie lands on the movie's camera, the one the straight run had there, instead of
rebasing the viewing camera. The rule, the capture and the limits are `sd-cinema` "Across a time-control jump"; in
short: `Director.MovieOwnsCamera()` (the timeline's camera on, started, a camera cue or a `movie` block), decided at
`BeginJump`; `SimState.camera` holds the rig and the camera director in every snapshot, restored only then; the
director steps through the re-simulation; `EndJump` skips `Rebase` and `Clear`. The director's settle gate reads the
simulation's check, so a re-simulation gates its first pick as the straight run did.

## The movie tool (M5)

`movie` is a page tool (`where: 'page'`, hub `SLOW_TOOLS`), the authoring view over the timeline; the `timeline` tool
stays the low-level cue list. `normalizeMovieCommand` refuses with every problem (a field of another action, an unknown
field, a bad value); `action` defaults to `status`.

- **Beats** are the player's records (`TimelinePlayer.Records()`, removed ones dropped), in two lanes (`beatLaneOf`):
  `camera` (`play_shot`, `play_sequence`, `stop_shot`, `auto_camera`) and `fleet` (the rest, warp-in patch cues
  included). A beat's **time** (`BeatTime`) is its record's `second` (fired, failed or skipped), else its `due` (timed,
  a resolved event cue, a missed one), else null (waiting). Rows are sorted by time, waiting last, then stored order;
  `trigger` is `{ at }` or `{ when (the text), arms, after, latest }`; `in` only on a pending beat with a time.
- **Edits** (`MovieEdit`, in the edit queue through `EditNow`, so a past edit re-simulates): `add { beat }` → `add_cue`,
  `move { id, at?, when? }` and `edit { id, set }` → `update_cue`, `remove { id }` → `remove_cue`, `set { movie }` →
  `set_movie`. The result: `{ beat (its row; null after a remove or for set), resimulated (null: only the future), movie
  (the report), warnings }`, the warnings those naming the beat or about the window, a re-simulation, the movie block or
  a late prefetch. Two frames are awaited after a re-simulation.
- **play** `{ from?, lead? (DEFAULT_MOVIE_LEAD_SECONDS 2), rate? }`: with `from` (a beat id or timeline seconds) it
  jumps to `max(0, time − lead)` and unpauses the clock; without, it plays from now (a `stopped`, `ready`, `paused` or
  `preparing` timeline gets `Play()` and its origin). A waiting beat throws `beat "x" waits for <text>, so it has no time
  yet: give timeline seconds instead`; before t = 0 a jump throws `the movie has not started …: movie play starts it`.
- **seek** `{ to, offset? 0, play? false }`: pauses first (unless `play`), jumps to the beat's second + offset (a landing
  on t = s has fired the cues due at s: a shot is on its first frame), then pauses or plays.
- **Jumps** (`MovieJumpTo`): one `TimeControl.Jump` per chunk (`SeekChunks`: at most `MAX_SEEK_AHEAD_SECONDS` past the
  recorded end each), recomputed from `recordedEnd` after a frame between them. A target before the window with no
  pinned origin warns `the time window was cut since t = 0: movie retake replays the movie from t = 0 …` and clamps as
  any jump does.
- **pause** pauses the clock (`TimeControl.Pause(true)`), not the timeline's cursor; **restart** `{ paused? }` is
  `timeline restart` (the report plus the load's warnings and changes).
- **retake** (after a cut: a placement edit, a fleet toggle, a lookup landing): remembers the timeline time and the pause,
  `timeline restart { paused: true }`, waits frames while `preparing` (the prepare cap + 10 s), pauses the clock, plays
  the timeline (the origin is pinned, recording starts from the settled scene), then jumps from now to the t = 0 boundary
  (`NextBoundaryTime()`) + the remembered time, so t = 0's boundary runs inside the jump; the pause comes back. When the
  scene did not settle (nothing recorded) it plays from t = 0 with a warning.
- **Two frames**: `play`, `seek`, `retake` and re-simulating edits await `NextFrames(2)` before returning (requestAnimationFrame,
  with a 1 s fallback for a tab the browser stopped drawing), so a `screenshot` right after shows the landing.
- **The report** (`MovieReportOf`): `state`, `time` (fractional timeline seconds), `end`, `ended`, `look { letterbox, hud,
  applied }` (only with a movie block), `camera { driver, beat? }`, `beat { fleet?, camera? }` (the summary's last fired
  per lane), `next` (the first pending beat with a time, with `in`), `beats`, `waiting`, `events { count, last (≤ 10,
  newest first), full? }`, `window { earliest, latest, origin }` (timeline seconds; `origin`: the pinned t = 0 snapshot
  is in the ring), `scripts`, `note`.
- **get_state** `timeline.movie`: the block with its look filled (`movieLookOf`), `ended?` and `applied`.

### The look

`Director.Presentation()` returns `{ shot (CinemaRig.Presentation), movie: { letterbox, hud, run } | null }`: the
movie's look while the authored timeline has a movie block and the player is not `idle` or `stopped`
(`MovieLookApplies`), its `run` the timeline's `startTick` (−1 before t = 0). main.ts's `Presentation.Apply` merges with
`MoviePresentation`, lowest first: the page's settings (`?letterbox=`, `?hud=`, L and H), the movie's look, a playing
shot's `letterbox` / `hud`. While a movie's look applies, L and H switch that key for the run (the opposite of what is
shown) instead of the page setting; a new run (a load, a restart: a new `startTick`) drops them.

### The end

`ArmMovieEnd` (first in `DriveTimeline`, every frame) keys the stop by `<startTick>:<end>`: a new key (the timeline
started, `end` changed, a load) calls `TimeControl.StopAt(origin + end s)` when that clock is still ahead, else clears it
(`sd-time` "The movie's end"). The frame that reaches it pauses the clock exactly there with the cues due at `end`
fired; the stop then clears itself, so `movie play` goes on past it. `movie play`, `seek` and `retake` reset the key: a
landing before the end stops there again. A `time_control` jump back before the end does not re-arm it.

## Limits

- An event's facts are the document membership at the time (a ship moved to another fleet by a live edit reports its
  new fleet).
- Live input during play changes the run (as for timed cues); a waiting cue whose event never comes and has no
  `latest` waits for the rest of the run and keeps the timeline from `done`.
- The movie tool's jumps are synchronous like every jump (a long chunked seek blocks the tab per chunk); `retake`
  re-simulates the whole movie to now in one jump, so it costs what a seek from t = 0 costs.
- The run override for L and H is per page (main.ts), not reported in get_state; `look.applied` says only that the
  movie's look is in force.

## verify-page evidence (M5, 2026-10-24, dbxpc, headless)

- **(e)** `movie: the movie tool lists beats in two lanes …`: Rifters `a`, `b`; `go` at 1, a `hero` shot at 3, `later`
  (`when: { cue: 'go', after: 5 }`) and `never` (the kill of b). At 8 s: `go fleet 1, hero camera 3, later fleet 6,
  never fleet waiting` (never last, `beat.fleet` later, `beat.camera` hero). `add` at 40 → pending, `resimulated: null`;
  `move` 42, `edit` name, `remove` round-tripped. `play { from: 'go', lead: 1 }` landed at 0.03 s and played; `seek {
  to: 'go' }` landed paused at 1 s with go fired. A placement edit cut the window (`an edit changed the simulation (1
  ship moved)`); `retake` came back to 6.02 s (was 6.02 s), paused, recording on, `window.origin`. `set { end: 8 }` +
  `restart`: the clock stopped at timeline 8 exactly, `ended`, and `play` went on past it.
- **(j)** `movie: the movie block letterboxes the frame …`: `{ letterbox: 2.39, hud: false }`: the canvas 2.39:1 and the
  overlay hidden while it plays; a `hud: true` shot showed it; after its cut, H showed it for the run; `timeline restart`
  hid it again.
- In an `--only` batch behind the warm-up (which timed out its prepare on the first load's default-weapons fits, as
  known).

## verify-page evidence (M4, 2026-10-24, dbxpc, headless)

- **(f)** `movie: the camera after a seek is the movie camera …`: a library `hero` cue at 2 (6 s, release) and an
  `auto_camera { pace: fast }` cue at 10, two flying Rifters, played to 25 s. `seek { timeline: 5 }` (paused): driver
  `timeline`, the hero at 3.00 s, progress 0.50. `seek { timeline: 18 }`: the director driving, its cut log to 18 the
  straight run's (overlook the engagement at 10, flyby b at 16). A scene with no camera cue: Claude's chase at 3.02 s
  before and after `back: 4` (the rebase). In an `--only` batch with the warm-up and M3's (c) and (d), all ok.
- The full headless verify-page (M3's, M4's and M5's) runs in M6.

## verify-page evidence (M3, 2026-10-24, dbxpc, headless)

- **(c)** Rifters `a`, `b`, and `c` scripted `[direction 60 s, stop]`; cue `go` at 1; played to 12 s and paused.
  `order_ship { id: 'b', at: 4 }` re-simulated from 0 s (the origin: the snapshot at t = 4 has played 5) in 13 ticks
  and 7.8 ms, the cue `fired`, recording on with the same `why`, `time.jump.cause` `edit`; after `timeline restart` and
  a seek to the same timeline time b was 0.000 m from the edited run. Retiming `go` to 6 and removing it re-simulated
  (a at rest at its placement); `update_ship c set { orders }` changing step 1 gave `resimulated: null` with step 0
  still flying and no restart note.
- **(d)** after `back: 5`, an `order_ship` cue at 40 s came back `pending`, `resimulated: null`, and `time.latest` was
  now (44.23 s).
- The changed checks: "timeline: edits while playing" (`past` re-simulated from 0 s and fired) and T4 (l) (the cue at
  1 s added at 4 s: `fired`, re-simulated from 0 s).
- Under `--only`, a check that is the first to load a scene on the fresh page can wait > 30 s for the default weapons'
  fit lookups (`fits: 2`) and fail its prepare: put a warm-up check in front.

## verify-page evidence (M2, 2026-10-23, dbxpc, tools-core SDE 3646012, headless: `--only movie:`)

- **(a)** 3 Punishers (fleet `b`) and a far `b9` vs 3 Rifters, seed 7, death `explode`; a 2-Rifter warp-in (`wr`) at 3.
  Fired `first-blood` +14 (the first kill at 12, after 2), `primary-dies` +14 (b's primary killed at 13), `landed` +16
  (landed at 15), `chain` +19 (cue landed fired at 16, after 3), `fallback` +30 (its latest). Equal after `timeline
  restart` and after `time_control { seek: { timeline: 10 } }` (11.9 ms) played back to 45 s.
- **(g)** get_state before the events: five `waiting` with `the 1st kill + 2 s`, `the kill of b's called primary`, `the
  kill of b9, at 30 s at the latest`, `fleet wr landed`, `cue landed fired + 3 s`; after: `beat.fleet` `fallback` at 30,
  27 events, the last `fleet wr formed up` at 33.
- **(b)** a 3-Rifter warp-in at 2: `first` +12, `landed` +14, `formed` +19 (events 11, 13, 18), equal after a restart.
  Once, with the three node suites running alongside, the first load's group landed a tick later (events 12, 14, 19 vs
  11, 13, 18 after the restart): the warp-in's plan tick, not the event path (the cues followed their events exactly).
  Filed as a follow-up ("a cue warp-in's first load can plan a tick late under load").
- **(h)** refused with every problem: an unknown kind and two kinds (one load: read problems skip the projection), a
  cycle, an `at` too early with `give at 5 or later (cue "adds" adds it)`, a filter naming `ghost`, `latest` before
  `arms`, and `remove_cue` of a waited-for cue.
- **(i)** `engage { when: { arrival: { fleet: 'wr' } } }` returned arms 2 and `add_ships { when: { kill: { ship: 'r1' } } }`
  arms 0, both `waiting`; they fired at +14 on the landing and on r1's kill, both at 13.
