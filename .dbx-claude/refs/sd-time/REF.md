# Time control: pause, slow motion, fast-forward and jump back

> The scene clock runs at a rate and can pause, and the page steps every Destiny tick however fast it runs. Fetch
> before touching `apps/viewer/src/lib/time-control.ts`, `clock.ts`'s rate and pause, `main.ts`'s frame loop,
> `packages/scene/src/lib/time/`, the `time_control` tool or get_state's `time`. The plan this follows:
> `~/.claude/plans/time-control-pause-slow-motion-fast-forward-and-jump-back-on-the-scene-clock-wit.md` (slices T1 rate,
> pause and fast-forward → T2a the snapshot layer → T2b jump back, the tape and the window → T3 effects across a jump
> and the real-GPU check). The clock and loop basics are `sd-destiny` ("One clock, one loop").

**Status: T1, T2a, T2b and T3 have landed.** T1: rate, pause, fast-forward, the tool, get_state `time`, the HUD row and keys.
T2a: the snapshot layer (`state-capture.ts`, `destiny-snapshot.ts`, `DestinyWorld.Snapshot()` / `Restore()`, an owner
`Snapshot()` / `Restore()` each). T2b: the ring of snapshots, recording from the settled scene and the cuts, the tape of
live commands, `Jump` (restore + silent re-simulation + warm-up + landing, with an undo point), drift detection, the
director's sim port, `back` / `seek` / `every` / `window`, the `←` key. T3: the effects playing at a landing are drawn
again (explosions, missiles in flight, module beams and overlays, warp flashes), timeline time (`time.timeline`,
`seek { timeline }`), a jump across a timeline warp-in cue, and the real-GPU check. No smooth reverse playback (user,
2026-10-22). **Movie mode M3** (`sd-timeline` doc `movie`): the timeline's pinned origin, `AbandonFuture`, script
edits re-simulating through `Resimulate` (over `Run`, the jump's core) instead of cutting, and `AfterRestore` (below,
"Script edits re-simulate"). **Movie mode M4**: the snapshot holds the camera (`SimState.camera`), restored while the
movie owns the camera (below, "Presentation across a jump"; `sd-cinema`).

## Files

| File | Holds |
|---|---|
| `packages/scene/src/lib/time/command.ts` | `TimeControlCommand` (`pause`, `rate`, `back`, `seek` (scene seconds, or `TimeSeek` `{ timeline }`), `every`, `window`), `normalizeTimeControlCommand` (every problem at once; `back` with `seek` refused), `MIN_TIME_RATE` 1/16, `MAX_TIME_RATE` 32, `DEFAULT_TIME_RATE`, `AUDIBLE_MAX_RATE` 2, `isTimeRate`, the window bounds (`every` 1–60 s, default 5; `window` 10–3600 s, default 120; `DEFAULT_TIME_BUDGET_MB` 64; `MAX_SEEK_AHEAD_SECONDS` 300) |
| `packages/scene/src/lib/time/report.ts` | `TimeReport` (get_state `time`, `timeline` included) with `TimeWindowReport`, `TimeRecordingReport`, `TimeReplayReport`, `TimeDriftReport`, `TimeJumpReport`; `TIME_STATES`, `TimeAudioState` |
| `apps/viewer/src/lib/clock.ts` | `SceneClock.rate` / `paused`, `Next(frameMs)` (the frame's target, records the frame), `Set(ticks)`; `Advance` = `Set(Next())` for the specs |
| `apps/viewer/src/lib/time-control.ts` | `TimeControl` (`Frame`, `Pause`, `SetRate`, `Report`, `AttachPort`, `effectiveRate`; T2b: `AttachSim`, `Command`, `Configure`, `Cut`, `Mark` / `Record`, `Jump`, the ring, the tape and its replay hook, drift; M3: `MarkOrigin`, `AbandonFuture`, `Resimulate`, the private `Run`), `TimeSimPort` (M3: `AfterRestore`) / `TapeEntry` / `JumpLanding` / `TimeResimulateOptions` / `TimeResimulation`, `SceneSeconds` / `SceneTicks`, `TimeText` / `RateText` for the HUD. Node-tested, no runtime |
| `apps/viewer/src/lib/destiny.ts` | `NextBoundaryTime()` (shares its formula with `DeliverBeforeBoundary`), `BoundaryTime(boundary)` (any boundary on the grid: the timeline's t = 0) |
| `apps/viewer/src/lib/audio.ts` | `PageAudio.Suspend(on)` and `Mute(on)` |
| `apps/viewer/src/lib/director.ts` | `AttachTime` (the presentation port and the sim port), the `time_control` handler, get_state `time`; T2b: `CaptureSim` / `RestoreSim` (`SimState`), `SimDrift`, `Replay`, `Journaled` + `JOURNALED_TOOLS`, `BeginJump` / `SilentFrame` / `EndJump`, `RebuildHull`, silent mode (the drawn-owner getters over `*Drawn` fields), `SimInput`, `BuildIsSimInput`, `SimulationChange` (the cut rule in `Apply`); T3: `TimelineOrigin` on the sim port, `ReplayExplosions`, `ReplayEffects`, `swallowedFlashes` |
| T3 planners (node-tested) | `damage.ts` `ImpactsHealed`; `explosion-plan.ts` `ExplosionReplays`; `module-fx.ts` `RunningModuleFxCommands` over `ShipModules.RunningEffects`; `warp-fx.ts` `WarpFlashReplays`, `WARP_IN_FLASH_SECONDS` / `WARP_OUT_FLASH_SECONDS`; `missile-flights.ts` `InFlightAt`; `missile-effects.ts` `Launch(…, { midFlight })`; `arrivals.ts` `AwaitsBuild` |
| `apps/viewer/src/main.ts` | builds `TimeControl` with the clock and world before the engine; the HUD `time` row; the keys (Space, `[` `]`, `←`) |
| `engine.ts` / `cinema.ts` / `audio.ts` | `Engine.ResetSceneTime(now)` (the update context, `sd-runtime`), `CinemaRig.Rebase(delta)` and (M4) `Snapshot()` / `Restore()` (`sd-cinema`), `PageAudio.ReleaseAll()` |
| `camera-director.ts` | M4: `CameraDirector.Snapshot()` / `Restore()` (wiring `port`, `cost` reset) |
| `apps/viewer/src/lib/state-capture.ts` | `CaptureFields` / `RestoreFields` / `CloneState` / `EstimateBytes`: the generic per-tick state capture every owner's `Snapshot()` / `Restore()` is a one-liner over. Node-tested |
| `apps/viewer/src/lib/destiny-snapshot.ts` | `CapturePark` / `RestorePark` (stream + scalar overlay), `CaptureScalars` / `OverlayScalars`, `STRUCTURAL_BALL_FIELDS` / `STRUCTURAL_PARK_FIELDS`, `ParkSnapshotBytes`, `WARMUP_TICKS` 3, `WARMUP_SAMPLES_PER_TICK` 30. `runtime-sim` only |
| `apps/viewer/src/lib/destiny.ts` | `Snapshot()` / `Restore()` (`DestinySnapshot`), getter-backed `master` / `replica`, `SampleCurves(time)` |
| owners | `Snapshot(memo?)` / `Restore(state, memo?)` on `ShipModules`, `DamageModel`, `CapacitorModel`, `ShipLocks`, `CombatRules`, `ShipTargets`, `FleetTargets`, `FleetCommanders`, `AutoRepair`, `MissileFlights`, `ShotQueue`, `TurretSoundQueue`, `WarpFx`, `FleetFollowing`, `FleetOrders`, `Arrivals` (each with a `*_CAPTURE` options constant naming its wiring) |
| specs | `time/command.spec.ts`, `clock.spec.ts`, `time-control.spec.ts` (T2b: `Rig`, a fake sim port over a real world; M3: `Resimulate`, the origin, `AbandonFuture`), `movie.spec.ts` (M3: the edit-resimulate determinism oracle, `sd-timeline` doc `movie`), `state-capture.spec.ts` (also `FirstDifference`), `cinema.spec.ts` (`Rebase`), `destiny-snapshot.spec.ts` (the audit, determinism, warm-up, the `SD_BENCH` bench), a `<Owner> snapshots (sd-time)` round trip in each owner's spec over `state-capture.spec-helper.ts` `RoundTrip`; verify-page `time:` |

## The stepping loop

- `TimeControl.Frame(frameMs)` replaces `clock.Advance` + `world.Tick` in `main.ts` (after `DriveTimeline`):
  1. `target = clock.Next(frameMs)`: now + min(real delta, 1 s) × rate; now while paused, held or on the first frame.
  2. While `world.NextBoundaryTime()` ≤ target: `clock.Set(boundary)`, `world.Tick(boundary)` (exactly one evolve).
     After each, if the frame has spent more than `FRAME_STEP_BUDGET_MS` (40) of real time, stop: the clock waits at
     that boundary and the next frame steps on from it. **The clock never jumps.**
  3. `clock.Set(target)`, `world.Tick(target)` (no evolve; before the first evolve this one anchors the grid).
  4. A throwing `Tick` is logged once per distinct message and ends the frame's stepping; the loop goes on.
- So every pending order, Follow the FC steering, module cycle, lock and combat roll runs at the same tick, in the same
  order, at any rate. `time-control.spec.ts` proves it: a 1× harness world and `TimeControl` worlds at 8× (two
  boundaries a frame) and at 32× behind its budget (one a frame) give identical master `BallStates` and boundary
  sequences tick for tick, with a turning FC and a follower, an MWD on and off, a delayed order and a warp.
- **The frame drivers run once per frame** at its final `now`, however many ticks it stepped: at 4× the shots,
  explosions and module moments of the frame's ticks draw together. That compression is the intended look.
- **Effective rate**: scene ticks advanced over real frame time, measured every 1 s of frames (reset on pause, hold or
  a rate change). `Report().effectiveRate` appears only when it is below 0.95 × rate.
- Rate 1 behaves as before T1, except a boundary's listeners now see `clock.now` exactly on the boundary (it used to be
  up to a frame past it).

## Pause and rate

- `clock.paused`: `Next` adds nothing, so no tick runs; the drivers still run at the frozen `now` (a cinema shot holds:
  its stamps are scene ticks; the orbit camera moves on real time; ClientBalls return their cached samples).
- `clock.rate` ∈ [1/16, 32] (a `RangeError` outside). Both are viewing preferences: they persist across loads and reset
  on a tab reload. The scripted load's `Hold` is separate (`sd-timeline`); held and paused together add nothing either.
- **Audio** (the port's `Presentation({ paused, muted })`, sent on attach and on change only):
  - paused → `PageAudio.Suspend(true)` suspends the AudioContext; a gesture does not resume it while suspended, and
    `Frame` re-suspends it after `Enable`.
  - rate > `AUDIBLE_MAX_RATE` (2) → `Mute(true)` releases every emitter and drops posts (recorded in
    `audio.posted` with `muted: true`); an emitter comes back on its ship's next post. Slow motion stays audible at
    normal pitch (sounds play on slowed scene times).
- **Keys** (`main.ts` `TimeKeys`; ignored with Ctrl / Meta / Alt, on key repeat, and while a button or text field has
  focus): Space pauses or plays; `[` / `]` halve or double the rate within the bounds. The HUD row reads `1×`,
  `paused at 0.25×`, `32× (2.7× actual) · muted`.

## The tool and get_state

- `time_control { pause?, rate?, back?, seek?, every?, window? }` (page tool; hub `SLOW_TOOLS`, a long jump can take a
  while): applied in the order `every` / `window` (trimming the ring), the jump (`back` seconds from now, or `seek` to a
  scene time), `rate`, `pause`, so `{ back: 10, rate: 0.25 }` re-watches in slow motion and `{ seek: 42, pause: true }`
  lands paused. `{}` reports. Returns the `time` report plus `warnings` (a clamped jump, "already there").
- **Timeline time** (T3): `time.timeline` is `seconds` less the scene time of the timeline's t = 0
  (`TimeSimPort.TimelineOrigin` = `world.BoundaryTime(timeline.startTick)`), once a scripted timeline started;
  `seek: { timeline: s }` jumps to that origin + s (refused without a started timeline). A landing on t = s exactly has
  fired the cues due at s.
- get_state `time`: `{ seconds, tick, rate, paused, state: playing | paused | jumping, timeline?, effectiveRate?, held?, audio?:
  muted | suspended, back, earliest?, latest?, window: { seconds, every, window, snapshots, bytes, budget, capture? },
  recording: { on, since?, why?, cutAt?, waiting? }, replay?: { pending, next?: { tool, seconds } }, drift?: { count,
  tick?, summary? }, jump?: { from, to, snapshot, resimulated, ms, cause: jump | edit, edit?: { cues, ships }, warnings? } }` (`seconds` and `tick` equal
  `simulation`'s; scene seconds throughout). The HUD row adds `back 63 s`, `N s recorded ahead` or `recording waits: 3
  builds`.

## The window: recording, snapshots and cuts (T2b)

- **Recording starts at the first settled boundary** (`TimeSimPort.Settled` = `Director.SceneSettled({ simulation:
  true })`, the timeline's prepare check: every live ship's lookups answered, fit or default weapons resolved, build
  settled; fleets planned; objects built; the location answered; prefetches done; except that a build counts only when
  its landing is a simulation input, `BuildIsSimInput`, the same rule as the cut). That is the deterministic start: no
  async input lands unrecorded after it. While off, get_state `recording.waiting` counts what it waits for.
- **A snapshot** (`Director.CaptureSim`) is taken right after an evolved tick at that first boundary, then every `every`
  scene seconds on the grid from it (`(tick − start) % every == 0`), into a ring sorted by tick. Each holds the world
  (both parks + entries), every owner, the director's per-tick fields, the timeline player, the live scene and its live
  edits, the camera (the rig and the camera director, M4: restored only while the movie owns the camera), and its
  estimated bytes (`ParkSnapshotBytes` × 2 + `EstimateBytes` of the rest). A capture slower than
  `CAPTURE_SLOW_MS` (15) doubles the spacing (reported in `window.every`).
- **The ring trims** after each snapshot and on `Configure`: snapshots older than `window` seconds before the latest
  go, then the oldest past the byte budget (the latest always stays), then the tape before the earliest snapshot. The
  pinned origin is never trimmed (its bytes count toward the budget).
- **The timeline's origin** (Movie mode M3, `TimeControl.MarkOrigin`): when a timeline starts playing before its t = 0
  boundary (`Director.MarkTimelineOrigin`: a prepare ending in `playing`, `timeline play` from `ready` or `stopped`),
  the director pins a snapshot of that state on the grid (tick = `world.tick`, the boundary t = 0 will see; clock = the
  last evolve's `master.time`). Recording starts there when it is off and the scene is settled (`Settled`); when it is
  on, the recorded future goes first (`AbandonFuture`) and a snapshot at the same tick is replaced. It carries
  `doneThrough` (the tape's seq then): restoring it does not run again the tape entries of its tick made before it (its
  state holds them). A newer origin replaces it, a `Cut` drops it, and a prepare that hit its 60 s cap unsettled has
  none. So the window always reaches t = 0: `back` and `seek { timeline: 0 }` can go there whatever `window` is, and
  every script edit can re-simulate. A paused load (`ready`) takes it at `timeline play`, so the restored player plays.
- **Cuts** (`TimeControl.Cut(why)`: the ring, the tape and the drift count go; recording waits to settle again;
  `recording.why` / `cutAt` name it). A **script edit** (only cues, the movie block and ships' orders, while a started
  timeline records) never cuts: it re-simulates ("Script edits re-simulate"); mixed with anything else it takes the cut
  below, warned `this edit changed the scene too, so the time window was cut: timeline restart replays the script with
  it`:
  - `Director.Apply` on a load (`a scene was loaded`) and on any edit whose diff `SimulationChange` names (ships added,
    removed, rebuilt, moved, retuned, switched, regrouped, re-teamed or re-scripted, objects, fleets, location,
    environment, combat). Camera-only and name-only edits keep the window. This covers `patch_scene`, every hub scene
    tool, `order_fleet` document orders, `auto_repair`. Patch cues (`ApplyNow`) do not cut (`sd-timeline`).
  - `Director.SimInput(why)` while recording: the `/ship-stats`, fit, hull-dogma and prop mod lookups landing, the
    location answer, an object build without a document radius, and a ship build when the hub has no SDE radius for it
    or its arrival waits for its builds (`BuildIsSimInput`: `Arrivals.AwaitsBuild`, a group not planned yet that was
    added with `waitForBuild`). A timeline cue's warp-in plans on flight numbers alone (prefetched in prepare), so its
    builds landing never cut: a jump crosses a scripted warp-in (below).
  - A settle check failing at a snapshot tick (`the scene stopped being settled (waiting for …)`).

## The tape (T2b)

- **Journaled tools** (`JOURNALED_TOOLS` in director.ts): `order_ship`, `order_fleet` (its live orders), `switch_prop_mods`,
  `switch_modules`, `set_target`, `engage`, `cease_fire`. `Handlers()` wraps each (inside the timeline's `at` wrapper,
  so a cued call is not journaled): `Mark()` before, `Record(mark, tool, args)` after success (a promise's success for
  `order_fleet`). Record does nothing while recording is off, during a jump, or when a cut happened during the call (a
  document order's `Apply`).
- **A new live command abandons the recorded future** (`AbandonFuture`, also a script edit's first step): the entries
  not run yet and the snapshots after the current tick go, and the recorded end becomes now.
- **Replay**: `TimeControl` registers `world.OnBeforeBoundary` in its constructor (before the director's timeline
  listener), and at boundary k runs every entry of tick k not yet run (`done` false), marking it run, through
  `Director.Replay` (the unwrapped lever, synchronously; `Manual` as the hub call). During live play every entry is
  run already; a restore marks the entries from its snapshot's tick on not run. A replay that throws counts as drift.
- **The landing rule**: landing at T inside tick m, the entries of tick m made at a clock ≤ T run at once; the later
  ones at boundary m.
- Only hub calls are journaled: page code (the FC brains, cues) is deterministic and re-derives itself.

## The jump (T2b)

`TimeControl.Jump(target)` (one synchronous task; `Command` turns `back` / `seek` into it):

1. Refused while another jump runs, while the timeline holds the clock, and with nothing recorded (the error says why).
   A target before the earliest snapshot clamps to it with a warning; past the recorded end it goes at most
   `MAX_SEEK_AHEAD_SECONDS`; the target equal to now is a no-op ("already there").
2. The landing tick m = earliest.tick + ⌊(target − earliest.clock) / interval⌋ (snapshots sit on the tick grid). The
   start: the latest snapshot with tick ≤ m − `WARMUP_TICKS` (else the earliest), or the current state when the target
   is ahead and no snapshot is closer (a forward seek simulates on from now, recording as it goes).
3. `undo = Capture()`, `BeginJump()`, `Restore(snapshot)` + `clock.Set(snapshot.clock)`.
4. Re-simulate k → m: `clock.Set(boundary)`, `world.Tick(boundary)` (the tape replays), `AfterTick` (new snapshots only
   past the recorded ones; no settle or drift check), `SilentFrame(boundary)`. Over the last `WARMUP_TICKS` intervals,
   and from the last boundary to the target, `world.SampleCurves` every 1/`WARMUP_SAMPLES_PER_TICK` tick.
5. Land: `clock.Set(target)`, `world.Tick(target)` (no evolve), the landing rule, `EndJump`. Report `time.jump`.
6. Any throw: `Restore(undo)`, the clock, the ring, the tape's done flags and the recording state put back,
   `EndJump({ delta: 0, failed })`, and the error re-thrown as "the jump failed and the scene is as it was: …".

The window is untouched by a jump: the snapshots after the target are the recorded future. Steps 3–6 are the private
`Run(plan)`, shared with `Resimulate`: after the restore it calls the sim port's `AfterRestore(state)` (never for the
undo point), then the plan's `restored`; a re-simulation's plan also drops the snapshots after the restored one. A
restore runs again the tape entries from the snapshot's tick on (`ReplaysAfter`; the origin's `doneThrough` excepted).
`time.jump.cause` is `jump`.

## Presentation across a jump (T2b)

- **Silent mode** (`Director.silent`, between `BeginJump` and `EndJump`): `turrets`, `moduleEffects`, `explosions`,
  `missileDrawing` and `warpEffects` are getters over `*Drawn` fields that read null, so the headless branches run;
  `onChange` is a no-op; audio is muted; `Hide` only marks (status `destroyed`, `death.hidden`, the shots forgotten) and
  the hull comes off at the landing (`DropHull`). `Retire` always takes the drawn turrets off first.
- **`BeginJump`**: module effects, explosions, drawn missiles and warp flashes cleared (module effects and explosions
  in one `RetireShips` each: a retire walks every drawn object, and one per effect cost 2.4 s with 20 effects in a
  54-ship fight); turret aims and bursts reset; `audio.ReleaseAll()` + `Mute(true)`; each ship's and object's HP
  fractions kept (`departedFractions`).
- **`SilentFrame(now)`**: `DriveTurrets`, `DriveMissiles`, `DriveExplosions`, `DriveWarpEffects` at the boundary time, so
  the presentation queues advance as a headless page's do (not `DriveBoosters`, `TrackCamera`, `DriveAudio`).
- **`RestoreSim`** never retires a scene ship (the hull the simulation reads must survive); it marks each live entry
  settled (`ready` with a hull and a renderer, `validated` otherwise, `destroyed` when hidden at the snapshot, `failed`
  kept), creates one for a scene ship without (a later patch cue removed it), retires the entries of ships absent from
  the restored live scene, resets the `liveFleets` memo and `rechargeSynced`.
- **`EndJump`**: a ship hidden at the target loses its drawn hull; every drawn hull re-attaches to its new curves
  (`AttachShipCurves`); a ship that needs a hull and has none (destroyed after the target) gets `RebuildHull`
  (presentation only: `BuildShipValues` → `HydrateShip` → curves → `AddShip` → `SyncTurrets` → aim → impacts; no
  retune, no re-plan, no cut; dropped if another jump lands first); every turret re-aims at `targets.Of`; impacts sync
  for every ship and object, cleared first on a hull whose armor or structure fraction rose across the jump
  (`ImpactsHealed`: the runtime's `SetImpactDamageState` only ever adds armor impacts, so a jump back to full HP kept
  the dying hull's holes and fires, drawn as big fireballs on the GPU; `ClearImpactDamage()` then the re-arm); `Engine.ResetSceneTime(target)`; `cinema.Rebase(delta)` and the camera director's `Clear`, unless the movie owns the camera (below); `Mute(rate > 2)`; `onChange`.
- **The camera director** (`auto_camera`, `sd-cinema`) steps every boundary (fast-forward included, holds in scene
  time) and is not journaled. A viewing camera (the movie does not own it): it steps nothing during a jump's silent
  re-simulation (`Silent()`), and `EndJump` clears its memory with `Clear({ keep: 'settings' })` so its first picks
  after a jump never chase the abandoned future.
- **The movie camera** (M4, `sd-cinema` "Across a time-control jump"): when `Director.MovieOwnsCamera()` at
  `BeginJump` (the timeline's camera on, started, a camera cue or a `movie` block), `RestoreSim` restores the rig and
  the camera director from `SimState.camera`, the director steps through the re-simulation (`Silent()` false) and plays
  its picks on the rig as camera cues do, and `EndJump` neither rebases nor clears: the landing shows the straight run's
  camera. `SimDrift` ignores the camera.

## Effects across a jump (T3)

The re-simulation draws nothing, so `EndJump` draws again what plays at the target, from the state the silent frames
left (`ReplayExplosions` before the hulls re-attach, `ReplayEffects` after the turrets re-aim):

- **Shots**: nothing to do. The queue's entries due after the target draw as usual; those due before were consumed
  silently (a gap of at most a burst).
- **Explosions** (`ExplosionReplays(deaths, target)`, in clock ticks; the hide time is the schedule's, or computed from
  the file's facts for a death begun with a renderer, which has none): started before the target and not hidden →
  **replay from its start at the target** (`begun` / `schedule` / `posted` reset, `start = target`: drawn, or the
  headless schedule posts its sounds again); past its wreck switch but never hidden (a drawn death restored mid-play)
  → `Hide` now; starting after the target and begun → reset to begin at its own start; pending (no start) or hidden →
  the normal path. The ball's removal tick is the simulation's and does not move.
- **Missiles** (`MissileFlights.InFlightAt(target)`: the launch moment taken, the hit or vanish still to draw, or no
  end yet): `ShipMissiles.Launch(flight, graphic, target, { midFlight: true })`: the warheads start on the ball (no
  launcher offset, no inherited ship velocity, no burst, no sound), timed on the ball's distance to the target's
  surface. A launch still queued draws normally with its burst.
- **Module effects**: `moduleEffects.Apply(RunningModuleFxCommands(modules.RunningEffects(tick)), target)`: a `start`
  for every running module with an overlay, or a beam with a target; no sound posts. A trigger (the web's one-shot)
  waits for its next cycle.
- **Warp flashes**: `PlayWarpFlashes` logs the commands a silent frame swallows (`{ command, at }`, only with a
  renderer); at the landing `WarpFlashReplays` plays those within their own length before the target
  (`WARP_IN_FLASH_SECONDS` 4.125, `WARP_OUT_FLASH_SECONDS` 1). A ship still streaking in flashes as usual. A failed jump
  drops the log.
- **Silent frames run at boundaries only**: a shot due inside a tick draws at the next boundary there, so a kill's
  explosion starts up to a tick later in the re-simulation than it did live (presentation only: the hide time and
  sounds, never the kill).

## A jump across a timeline warp-in (T3)

`RestoreSim` puts back the live scene and retires the entries of ships a later cue added; the re-fired cue's `ApplyNow`
adds them again (balls, arrival, retune from cached lookups) and `FinishApply` rebuilds their hulls after the landing
(drawn once built; they wait off-grid anyway). The cue's group plans on flight numbers (`waitForBuild: false`), so the
landing ticks repeat, and the builds landing are no simulation input (`BuildIsSimInput`): they neither cut nor hold the
recording's settle check at a snapshot tick. A cue-added ship without an
SDE radius still cuts when its build lands (its formation radius comes from the build).

## Script edits re-simulate (Movie mode M3)

The divergence test, the edit path and the oracle are `sd-timeline` doc `movie`; time control's part:

- **`AbandonFuture()`**: the edit's recorded future belongs to the old script. The director then truncates the event
  log at its cursor (`TimelinePlayer.AbandonFuture`).
- **`Resimulate({ accept, restored, edit })`**: refused as a jump is (another jump, the clock held, nothing recorded:
  `Ready()`). The snapshot is the latest one before now whose state `accept`s, at least `WARMUP_TICKS` back when one is
  (the test is downward-closed: walking down, the first passing one is the latest), else the latest passing one (the
  origin a tick or two back). Null when none passes. Then `Run` to now (`goal = clock.now`, landing tick = `world.tick`):
  undo point, `BeginJump`, restore, `AfterRestore`, `restored` (the player's `Rescript`, the live orders swapped), the
  snapshots after it dropped, the tape after it replaying at its ticks (they are the user's live commands in this
  history), new snapshots on the grid, warm-up, landing. `time.jump` is `{ from = to = now, snapshot, resimulated (ticks),
  ms, cause: 'edit', edit: { cues, ships } }`. A failure restores the undo point and throws `the re-simulation failed and
  the scene is as it was: …`; the director then commits nothing.
- **`AfterRestore(state)`** (`Director.ScriptAfterRestore`): a jump back to a snapshot taken before a later script
  edit (a future-only one taken at once, or the snapshots before a re-simulation's restore point) restores the old
  script's player records and live orders. The snapshot holds the authored document it was taken under
  (`SimState.authored`, by reference, never restored), so the restored player and live scene take the current script:
  `Rescript` when the state `Accepts` it (it always does for those), else the player's `Edit` (a fallback edit's cue
  behind it is `missed` again). Without it a jump back after a cue edit dropped the cue.
- **Cost**: one synchronous task, as a jump. Headless (dbxpc, 2026-10-24) 3 Rifters, a cue added at 4 s from 12 s: 13
  ticks from the origin in 7.8 ms. The plan's real-GPU estimate: ~3 ms a tick at 54 ships, so 5 minutes from the
  origin ~0.9 s, ~3.3 s at 500 ships (chunking it is a follow-up).

## Drift (T2b)

While playing after a jump, an evolved tick that already holds a recorded snapshot captures a fresh one and compares
(`SimDrift`: `FirstDifference` over the master park's stream and scalars, then `damage`, `combat` and `modules`). Equal
keeps it; different counts `drift` (first tick and summary kept, `console.warn`), replaces that snapshot and drops the
later ones. The tape keeps playing.

## Snapshots of our per-tick state (T2a)

- **`CaptureFields(owner, options, memo?)`** deep-copies every own enumerable field except `options.wiring` (the
  constructor's collaborators, callbacks and constants) and `options.reset` (memos). So **a field an owner gains joins
  its snapshot by itself** (the damage items' `hpSet` / `absorbed` need nothing). `RestoreFields` copies the record back
  (it stays pristine), refilling Map, Set, array and same-length typed-array fields in place, assigning the rest, and
  setting each reset field from its factory. Every option name must be an own field (a rename fails loudly).
- **`CloneState(value, prototypes, memo)`**: primitives (bigint, NaN, ±Infinity), plain and null-prototype objects,
  arrays, Map, Set (orders kept), typed arrays, and instances of the allowed prototypes (`ModuleCycle.prototype` for
  `ShipModules`), recreated with `Object.create`. A value reached twice is copied once (shared references and cycles
  survive; one memo across owners keeps cross-owner sharing). It **throws on a function, a symbol or any other
  prototype, naming the path** (`.ships.a.cb`): a runtime object sneaking into an owner fails its round-trip spec.
- `options.shared` copies a field one level (a new container, the same values) for immutable values.
- `EstimateBytes`: 16 B per object or container, 8 B per slot, 2 B per string character, a typed array's bytes; each
  object once. For the window's budget.
- **Each owner**: `Snapshot(memo?)` / `Restore(state, memo?)` over a `*_CAPTURE` constant. Wiring by owner: `port`
  (modules, locks, targets, fleet targets, commanders, auto-repair), `port` / `damage` / `onKill` / `onDamaged`
  (combat; `DamageModel` is its own owner), `tickSeconds` / `tickTicks` (capacitor, missile flights, shots), `ships`
  (warp fx), `config` (arrivals), `world` / `scene` / `radiusOf` + `memberships` reset (following), `world` /
  `following` / `scene` / `reactionOf` / `seedTick` (fleet orders). `DamageModel` and `TurretSoundQueue` have none.
- **The round trips** (`state-capture.spec-helper.ts` `RoundTrip(owner, report, mutate, undo?)`): reports first (a
  report may fill a memo), snapshot, mutate, restore, `undo` puts fakes back; the spec requires the mutation to show,
  the reports after to equal those before, and the owner snapshotted again to equal the snapshot. Where it matters the
  restored owner then runs on like an uncaptured twin built the same way: `ShipModules` boundary events, `CombatRules`
  rolls and kills, `FleetTargets` syncs, the FC brain's decisions, auto-repair switches, following and fleet orders
  with their world, arrival landing ticks.

## The Destiny park snapshot (T2a)

- **The stream's gaps** (measured: a fresh park read from `WriteFullStateToStream` alone, then compared field by
  field). Master balls: `mFollowRange` (the stream writes it as f32), `mGoto` and `mLastG` outside the goto modes, the
  whole legacy heading and roll state (`mNewYaw` / `mOldYaw` / `mNewPitch` / `mOldPitch` / `mNewRoll` / `mOldRoll` /
  `mNewRollSpeed` / `mOldRollSpeed` / `mYawDelta`, mass-damped, so stateful; `AddOldStyleOrientedBall` snaps it),
  `mOldPos` / `mOldVel`, `mNewTime` / `mOldTime`. Replica ClientBalls also every sampling cache (`mLastPos` / `mLastVel`
  / `mLastRot`, `mLastYaw` / `mLastPitch` / `mLastRoll`, `mYawSpeed` / `mPitchSpeed`, `mPosUpdateTime` /
  `mRotUpdateTime`, `mDeltaPos`, `mIntAcc`, `mElapsed`, `mLastTick`). The park: `mTime`, `mFirstTime`, `mEgo` /
  `mLastEgo`, `mLastReferenceTime`, and `ScenePark.orbitEpoch`.
- **So `CapturePark`** = the stream + `CaptureScalars` of the park and of every live ball: every own number, bigint,
  boolean, string, typed array (copied) or array of primitives, minus the structural lists. **`RestorePark(snapshot,
  isMaster, create)`** builds a fresh park (`ScenePark` via `create`), sets `isMaster`, reads the stream
  (`ReadFullStateFromStream(…, 0)`), checks the ball count, overlays the park's and each ball's scalars (typed arrays
  and arrays refilled in place) and checks `currentTime`. Moribund balls are skipped on both sides (none exist between
  ticks: the world removes balls outside evolves). A ball holding collisions throws (ships are non-massive).
- **The structural deny lists**, left to the stream's re-insertion: per ball `mPark`, `mFollowPtr` / `mFollowers`
  (re-linked by the read), the mini shapes, `mSensor`, `mCollisions`, `mTrackingPtr`, the partition's `mBoxes` /
  `mMyBox` / `mActiveBoxes` / `mMod` / `mBoxList` (recomputed from the position) and the bubble ids `mNewBubble` /
  `mOldBubble`; per park the ball map, every registry (free balls and ids, partition, formations, globals, statics,
  capsules, boxes, collision and proximity maps, moribund sets, bubbles and subscriptions), the host links, the ego
  ball cache and `mBubbleId` (re-insertion allocates bubble ids afresh).
- **The audit** (`destiny-snapshot.spec.ts`; the oracle): each scenario runs, snapshots at k, dumps 30 ticks (every
  scalar of the park and of every ball, the partition fields included, ball order, follow links, followers, bubble
  equality classes, the free registry order, every registry's size, the world's fields and entries, each ship's drawn
  position and rotation), restores into the same world, re-runs and requires every tick equal. **Exact in all of them**:
  (a) a fleet behind a turning FC and followers settled at rest, (b) orbit, keep-at-range, approach, a goto creeping
  in, (c) a warp aligning / in proper warp / exiting / landed (k found by a dry run), (d) arrivals parked, scheduled
  and warping, (e) missiles flying, lost, done and lingering, (f) prop mods activating, active, stopping and queued,
  (g) a destroyed ship lingering and a ship removed after k (the restore brings it back), (h) objects with an orbit on
  one. Lockstep holds after the restore and after 30 ticks. With the ball overlay off every scenario fails, so the audit
  sees the gaps. The fallback (a prototype-preserving graph clone of the park) was not needed.
- **Determinism**: a world with steering, orders, warps and missiles (commands at boundaries, the tape's stand-in)
  replays from a snapshot with identical `Motion` and missile reports for 40 ticks.
- **The ClientBall warm-up.** The overlay restores each ClientBall's history *as of the snapshot*; a jump to a later
  target re-simulates without drawing, so the cached rotation is stale. Its damping is **implicit Euler per sample**
  (`yaw = (yaw + 0.9·dT·target) / (1 + 0.9·dT)`), so the drawn history depends on how often it was sampled. Measured
  (a turning Rifter, snapshot 8 ticks before the target, frames at 60 fps): no warm-up 48.6° off; 3 ticks at 4
  samples a tick 3.6°; 3 at 15 0.91°; **3 at 30 0.38°** (`WARMUP_SAMPLES_PER_TICK`); 3 at 60 0.12°; the whole span at
  60 exact. The spec asserts < 0.5° at 3 × 30. T2b samples with `world.SampleCurves` over the last `WARMUP_TICKS`.
- A failed restore (truncated bytes) throws before the swap: the parks, the curves and every field stay as they were.

## Measurements

**The T2a bench** (`SD_BENCH=1`, node on dbxpc, 2026-10-23). Ships in rings behind a turning TFI, a quarter orbiting, a quarter on goto orders, the rest following, all sampled
every frame. World only (both parks and the world's entries; the director's owners come in T2b's
`time.window.capture`).

| ships | capture | stream (master) | both parks | snapshot | restore | tick | warm-up / tick | 64 MB at 5 s |
|---|---|---|---|---|---|---|---|---|
| 50 | 1.6 ms | 6.1 KB | 109 KB | 142 KB | 4.0 ms | 1.3 ms | 0.7 ms | 2307 s |
| 200 | 2.8 ms | 24 KB | 427 KB | 561 KB | 8.2 ms | 4.3 ms | 0.9 ms | 585 s |
| 500 | 6.2 ms | 61 KB | 1.0 MB | 1.4 MB | 23.7 ms | 11.2 ms | 3.1 ms | 234 s |

**On the real GPU** (the page's full snapshot: both parks and every owner; NVIDIA Lovelace, 2026-10-23): 10 ships
(the fight above) capture 0.9 ms, 7 snapshots 1.2 MB (~175 KB each), a jump 70–78 ms. The TFIs vs 10 Feroxes (54 ships):
capture 4.6–7.2 ms (one spike doubled `every` to 10 s in the first run), ~2.1 MB a snapshot (9 kept 18.6 MB), a `back
10` / `back 20` 155–189 ms (3–5 ticks), fps 28 right after. Of a jump, the re-simulated ticks cost ~12 ms; the rest is
`BeginJump`'s teardown and the landing's effects (module effects 29.5 ms). Before the batched clears a `back 10` took
2.7 s there (2.4 s in `ModuleEffects.Clear`).

The scalar overlay is about two thirds of a snapshot (mostly each ball's typed arrays; the streams under a tenth, the
entries the rest). The default 120 s window fits the budget even at 500 ships, so the smaller-snapshot optimizations
stay unneeded.

## Rules

- Nothing but `TimeControl` advances the clock or calls `world.Tick` in the page.
- **New per-tick state in the director joins `CaptureSim` / `RestoreSim` (`DirectorSimFields`); a new owner joins
  `SimOwners`; a new live lever joins `JOURNALED_TOOLS` and `Replay`; journaled handlers do their work synchronously.**
- **A new async input that changes the simulation calls `SimInput(why)`; a new diff field the simulation reads joins
  `SimulationChange`.**
- Nothing in a jump may `Retire` a scene ship or `Retune` / `Reconcile` (the hull and the radius are simulation reads).
- **A restore never reverts the user's script**: what a snapshot copies from the authored document (the player's cues,
  the live scene's orders) is brought up to the current one in `AfterRestore`; a new copy of document data in a
  snapshot needs the same.
- Never call `world.Tick` with a time more than one interval past `master.time` in page code: step boundaries with
  `NextBoundaryTime`, or the master's backlog drop and the one-evolve assumption break.
- **A report never changes captured state**: get_state runs at no fixed tick, so a report-time prune or memo makes a
  snapshot depend on polling (`CombatRules.Report` pruned its DPS windows: a false drift, `dealtWindow: 15 ≠ 20
  entries`, after a replay nobody polled). Prune on the simulation's own path; memos go in `reset`.
- **New per-tick state in an owner joins its snapshot by itself; a new collaborator or constant field joins its
  `*_CAPTURE` wiring** (or the round-trip spec throws on its function). A new owner gets `Snapshot()` / `Restore()` and
  a round trip.
- Never keep a park or a ship's curves across frames outside `DestinyWorld`: a Restore replaces them.

## Evidence

- verify-page `--only time:` T2b (headless, 2026-10-23, dbxpc, EVE build 3646012): a 3 Punishers vs 3 Rifters fight
  (seed 7, explode) replayed exactly after `back: 15` and a seek to the paused moment (tick 26, kills, HP, positions,
  shots), and again after playing on; `back: 15` took 6.5 ms (3 ticks from the snapshot at tick 8), the seek 2.9 ms; the
  window held 5 snapshots, 452 KB, capture 0.6 ms; no drift. The kill victim (p1) was alive 2 s before its kill
  (`validated`, structure 562.5) and died again at tick 21 by the same ship and module. The tape: two `order_ship`
  calls pending after a seek before them, both replayed by the recorded end; a new order dropped them. A `set_camera`
  patch kept the window, `add_ship` cut it ("an edit changed the simulation (1 ship added)") and recording came back on
  settling. Seek to the recorded end equal; +20 s past it in 5.9 ms (20 ticks), recording on. A Caracal's 5 missiles in
  flight and a warping Rifter equal at the volley and 8 s later (5 hits, the warp exiting) after jumping back.
- verify-page `--only time:` (headless, 2026-10-23, dbxpc): pause held tick 8 for 2 s with identical positions and
  play resumed; 4× gave +20 ticks in ~5 s with an orbit at 2065–2382 m on a 2000 m range and fleet members
  `in-formation` / `catching-up`; 0.25× gave +1 tick and +1.00 scene s in 4 s; rate 0.5 and pause survived a load.
- verify-page `--only time:` T3 (headless, 2026-10-23, dbxpc): all 14 pass. 4× fires a default Rifter's 3 guns on
  every 1.69 s cycle (33 shots in 20.1 scene s, 35.6 expected); `time.timeline` 6.03 at 6 s played, `seek { timeline:
  3 }` in 1.7 ms with the cue fired, `{ timeline: 1 }` before it; a cue warp-in (`add_fleet_composition` at 5) landed at
  ticks `{ wr-fc: 14, wr-s-01: 18, wr-s-02: 15 }` from t = 0 three times (live, after a seek before the cue, after a jump
  to 5.03 s mid-warp), recording kept, no drift; a kill's explosion replayed from a landing 0.25 s before the
  re-simulation's hide (its sound posted again) and hid 2 s later; 5 missiles in flight at a landing hit once (5 / 5
  both runs). The check fixes: the Rifter's target sat 1.8 km outside its lock range, and a landed FC keeps its
  `arrival` report. The first run cut the window at the cue's builds (the settle check counted them): fixed above.
- The full verify-page on the T2b tree (headless, 2026-10-23): 146 ok, 1 skip (SOF audio without a renderer), 2 FAIL,
  both pre-existing and filed (`sd-timeline`): "a moving FC dies …" (a race) and "the warp-in shot anchors …".
- **Real GPU** (Windows Chrome, NVIDIA Lovelace, 2026-10-23, a private hub on 5521; `.scratch/time-control-gpu/` on
  dbxpc): red 3 Rifters + a Caracal vs blue 3 Punishers at 15 km off the Jita 4-4 CNAP, seed 7, explode, 3 Rifters
  warping in. A jump 29 s back to 1.5 s before the reinforcements' landing (from 3 s after the first kill): 77.7 ms
  (3 ticks); the replay matched the first run tick for tick (shots, missile launches and hits, the kill at the same
  tick, by the same gun), no drift; a plain `back 10` 70 ms. The orbiting Punisher's drawn forward vector after the
  jump stayed within **0.006°** of the first run's at the same scene time over 3 s (112 frames; frame-to-frame steps
  0.03°). The killed FC was drawn again before its kill and exploded again at it; a landing inside an explosion
  replayed it from the start; the 3 warp-in flashes played at the landing; missiles redrawn mid-flight start on their
  balls (no launcher burst or streak). **Found and fixed**: the dying hull's armor impacts survived the jump (fireballs
  on a full-HP ship, absent in the live frames at the same time; `ClearImpactDamage` fixed it, the frames then
  matched). Audio: `backendErrors` 0 throughout; emitters drop to 0 at a jump and come back with the next decodable
  post (turret and impact sounds here are undecodable PTADPCM, so the explosion brings them back). 4× for 20 s: 86
  ticks, fps mean 41 / min 37, `gpuErrors` 0, no shortfall; 0.25× for 20 s: 6 ticks, fps 44.6 / min 39, `gpuErrors` 0;
  a paused frame held for 2 s. Module effects: the TFI fight's 20 running effects were drawn again at a landing (20
  live before and after `back 6`, none failed, 29.5 ms to apply).

## Limits

- A replayed explosion starts over at the target (it does not resume mid-blast), and in a re-simulation a kill's
  explosion starts on the boundary after its killing shot was due (above).
- A timeline cue that adds a ship without an SDE radius cuts the window when its build lands (`sd-timeline`).
- Fleet toggles (`auto_repair`, anchors, personalities) as live calls are document edits and cut; journaling them is a
  follow-up (it can re-apply their ops through `Resimulate`). As timeline cues they are script edits and re-simulate.
- A re-simulation from far back (the origin minutes ago, hundreds of ships) freezes the tab for its length (one task).
- `timeline pause` / `play` of the cursor is not on the tape: a jump or re-simulation does not re-apply it.
- Missiles relaunched at a landing whose target's hull is being rebuilt (it died after the target) fly undrawn: the
  rebuild is async (84 ms for a Punisher) and `ShipMissiles.Start` skips a flight with no drawn target (a follow-up).
- A missile drawn mid-flight starts with an identity launch transform: on its ball (no launcher streak), but its
  warheads' eject axis is world +Z, which a volley flying another way may show as a hook (unverified; a follow-up).
