# Movie mode: event cues on the page, edit-resimulate, the movie tool

> The page side of Movie mode (plan `~/.claude/plans/movie-mode-one-authored-movie-of-fleet-and-camera-beats-on-the-scene-timeline-cu.md`).
> The document side (event cue syntax, `arms`, the check-second walk, chains, pruning, the `movie` block, `set_movie`)
> is the main `sd-timeline` REF ("Event cues", "The movie block"). **M2 has landed** (the page plays event cues on their
> events); M3 edit-resimulate, M4 the movie camera across jumps, M5 the `movie` tool and the movie's look and end, M6
> the real-GPU movie are next.

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
  the cursor): its nth event already logged makes it due, and it is `missed` when that is past (`its event came before
  it was added: it plays from the next restart`); a latest already passed likewise. M3 replaces `missed` with
  re-simulation.

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

## Limits

- An event's facts are the document membership at the time (a ship moved to another fleet by a live edit reports its
  new fleet).
- Live input during play changes the run (as for timed cues); a waiting cue whose event never comes and has no
  `latest` waits for the rest of the run and keeps the timeline from `done`.

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
