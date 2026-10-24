# Movie export: the movie rendered offline on a fixed 1/fps scene clock

> `export_movie` renders the authored movie (or a time range, or N seconds of an unscripted scene) to an MP4 at a chosen
> size and fps. Every frame sits at exactly T0 + i / fps on the scene clock, however long the GPU takes to draw it, so a
> battle the tab draws at 4 fps still exports as a smooth 30 fps file, just more slowly than real time. Fetch before
> touching `TimeControl`'s export mode, `export-frames.ts`, a frame-timed camera path, or (from E2) the export pipeline,
> the hub's MP4 writer and `/movies`. The plan:
> `~/.claude/plans/movie-export-render-an-authored-movie-offline-to-a-video-file-on-a-fixed-1-fps-s.md` (slices E1 the
> fixed-step clock and the camera-timing specs → E2 the pipeline, the hub writer and `export_movie`, headless-verified →
> E3 the real-GPU export).

**Status: E1 has landed** (the fixed-step export clock, the frame grid and stepper, the camera-timing specs and the
two camera fixes they found). E2 (`export_movie`, WebCodecs in the page, the wire, the hub's `Mp4Writer` and
`/movies`, the locks, verify-page `export:`) and E3 (the real-GPU export; needs the runtime's animation clock from the
pause-fx item) are pending.

## Files

| File | Holds |
|---|---|
| `apps/viewer/src/lib/time-control.ts` | the export mode: `BeginExport({ fps? })`, `FrameTo(target)`, `EndExport({ pause })`, `exporting`, `EXPORT_LOCKED_TEXT`; `Frame` returns early while exporting; `Report().state` `exporting` with `exportFps`; `TimeText` `exporting · 1/30 s a frame` |
| `apps/viewer/src/lib/clock.ts` | `SceneClock.Resync()`: the next `Next` targets now |
| `packages/scene/src/lib/time/report.ts` | `TIME_STATES` gains `exporting`; `TimeReport.exportFps` |
| `apps/viewer/src/lib/export-frames.ts` | the grid (`ExportFrameTicks`, `ExportFrameMicros`, `ExportFrameCount`, `ExportPrerollFrames`), `ExportGrid`, `ExportStep`, `ExportStepper` (`Next`, `Again`, `index`, `done`, `Log`, `Summary`). Node-tested, no runtime |
| `apps/viewer/src/lib/timeline.spec-helper.ts` | `TimelineRig` (moved out of `movie.spec.ts`; `ExportTo` drives it as an export), `Cue`, `Direction`, `CUES_A`, `SHIPS_A` |
| `apps/viewer/src/lib/cinema.ts` / `cinema-moves.ts` | `FrameRun` (a shot framed at its exact end before what follows), `SmoothTrack` (the lag, exact for a moving target) |
| specs | `export-frames.spec.ts` (grid, `FrameTo`, the determinism oracle, the preroll, `StopAt`, drawn attitudes), `time-control.spec.ts` "export mode", the `… at any frame rate (sd-export)` cases of `cinema.spec.ts`, `camera.spec.ts`, `camera-director.spec.ts` |

## The fixed-step clock

- **`BeginExport({ fps })`** refuses during a jump (`a jump is running`), while the timeline holds the clock (`the
  timeline holds the clock while its scene prepares`) and during another export. It sets the mode, unpauses the clock
  (`FrameTo` ignores the pause, but the reports, the audio port and the HUD read it), resets the rate measure and
  presents.
- **`FrameTo(target)`** throws outside an export and for a target before now (`an export frame never goes back`). The
  loop is `Frame`'s without the budget and without `StopAt`: while `world.NextBoundaryTime() ≤ target`, `clock.Set`
  the boundary, `world.Tick(boundary)` (exactly one evolve) and `Recorded()` (snapshots on the grid, the settle and
  drift checks); then `clock.Set(target)` and `world.Tick(target)` (no evolve). A throwing tick propagates (the clock
  waits at its boundary) and the exporter retries the frame at the same target. A frame at 1/fps ≤ 1 s crosses at most
  one boundary; a bigger leap (the export's fast-forward when nothing is recorded to seek with) steps every boundary.
- **`EndExport({ pause = true })`** clears the mode, `clock.Resync()` and the measure's last frame time (so the first
  live frame targets now instead of counting the whole export as one capped 1 s frame), then `Pause(pause)`.
- **While exporting** `Command`, `Jump`, `Resimulate` (through `Ready`), `Pause` and `SetRate` throw `EXPORT_LOCKED_TEXT`
  (`a movie export is running: export_movie { action: "cancel" } stops it`); `Frame` returns `clock.now` without
  stepping, as during a jump. Not refused: `Cut`, `MarkOrigin`, `AbandonFuture`, `Mark` / `Record`, `StopAt`.
  Recording goes on through an export, so the exported run stays scrubbable afterwards.
- **Outside export mode nothing changes**: `Frame` and its specs are untouched.

**The grid** (`export-frames.ts`): frame i's clock is `T0 + round(i × 1e7 / fps)` and its file timestamp `round(i ×
1e6 / fps)` µs, each computed from the index (no accumulation, so no drift: frame k × fps is exactly k seconds; a step
is the floor or ceil of 1/fps). A frame lasts until the next one's timestamp. `ExportPrerollFrames(preroll, from, fps)`
= `min(round(preroll × fps), floor(from × fps))`: the preroll never reaches before t = 0. `ExportStepper` walks
indices −preroll … frames − 1 (`encode` from 0), calling `FrameTo` once per `Next`; a `Next` whose `FrameTo` threw
leaves the index, so the next call retries; `Again()` returns the last step without stepping (a redrawn frame);
`Log()` keeps the last 2,000 `{ index, clock, tick }`; `Summary()` gives `{ frames, minStepTicks, maxStepTicks }`.

**Why `FrameTo` and not synthetic timestamps into `Frame`**: `clock.Next` rounds each frame's ticks (1000/30 ms is
333,333 ticks, a third of a tick lost a frame), the 40 ms budget would leave a slow frame at a boundary instead of its
target, and `StopAt` would pause mid-export.

## What samples scene time

| What | Clock | In an export |
|---|---|---|
| Destiny boundaries, cues, event cues, ship scripts, module cycles, combat rolls, FC brains, the camera director's decisions | world ticks | unchanged: `FrameTo` steps every boundary |
| Page drivers (`DriveTurrets`, `DriveMissiles`, `DriveExplosions`, `DriveWarpEffects`, `DriveModuleEffects`, `DriveBoosters`) | the frame's scene `now` | unchanged |
| The runtime's update context (curve sets, particles, turret animation, firing FX, explosions, missiles, lens flare, post process) | `driver.Execute(…, frameNow, frameNow)`: scene | unchanged |
| Blue's frame clock (controllers, bindings, lights, booster flicker, the shaders' `Time`) | wall clock today | the pause-fx item's `AnimationClock` (`blue.os.frameClock`) advances by the scene step, exactly 1/fps a frame: **E3 depends on it** |
| `GetActualTime` (update throttles, turret shot stamps, curve seeds) | wall | left on wall time: throttles and stamps only (a limit below) |
| The cinema rig, `CameraFollow`, the camera director | scene ticks | unchanged; pinned by the specs below |
| `EveCamera.Update` (the orbit) | rAF, but inert (zoom curve cleared, `SetOrbit` every frame) | unchanged |
| ClientBall drawn rotation | implicit Euler per sample | sampled once per export frame (bounded below) |
| Page audio | a live AudioContext | muted (E2) |

## The camera at any frame rate

Every camera path steps on scene ticks; E1 proves it holds at 24, 30 and 60 fps and fixed what did not:

- **Shots** (`cinema.spec.ts`): a lagged (eye 0.3, look 0.4), orbiting, pushing, shaken `hero-port` shot on a ship
  flying 300 m/s, the library `hero`, and a three-shot sequence (chase, blend to hero, blend to flyby) ending
  `release`. The state changes (sequence index, release, idle) fall on the same clocks at every rate; unlagged poses
  are exactly equal; the lagged ones agree within **4.4e-5** of the eye–subject distance at 24 vs 60 fps (2.7e-5 at 30),
  the fov exactly.
- **Two fixes the specs found** (2026-10-24):
  - *A shot's end started from the last frame drawn before it.* The release (and a sequence's next-shot blend) took
    `this.last.pose`, the previous frame's, and the release started at the frame's `now`: 24 vs 60 fps differed by one
    frame of the subject's motion (7.5 m at 300 m/s). Now `PlayFrame` frames the ending shot at its exact end
    (`FrameRun(run, end, toEnd, …)`, its moves at their end values, the lag stepped to the end, the rest of the frame's
    step left to the next shot) and the release starts at `end`.
  - *The lag trailed a moving subject by less at a lower frame rate.* `Smooth` held the target still over the step
    (steady lag `v·h·keep / (1 − keep)`, 0.379 s at 24 fps vs 0.392 s at 60 for τ 0.4), 1.4e-2 of the eye distance
    apart. `SmoothTrack(current, from, target, h, τ)` is the closed form for a target moving linearly from `from` to
    `target` over the step (`target + (current − from)·e^(−h/τ) − (target − from)·(τ/h)(1 − e^(−h/τ))`; steady lag
    `v·τ` at any h). The rig keeps last frame's targets in `smoothed.target` (null at a shot's start, so a blend's new
    targets are held still to its first frame). `Smooth` is `SmoothTrack` with a still target.
- **The chase camera** (`camera.spec.ts`): `CameraFollow` in chase on a ship turning 20°/s while pitching: 30 vs 60 fps
  within **0.162°** (bound 0.2°). `EaseAngle` holds the aim still over the step like the old `Smooth`; left as is (in
  bound).
- **The director** (`camera-director.spec.ts`): fed from a world an `ExportStepper` steps at 24 and at 60 fps (two
  closing fleets, 40 s, `pace: fast`), its cut log and plays are equal: it decides at boundaries. The frame-timed
  `Lost()` re-pick lands up to 1/fps later at a lower rate (documented, not spec'd).
- **Drawn attitudes** (`export-frames.spec.ts`): a Rifter turning through four headings (646° in all over 20 s),
  sampled at 30 and at 60 Hz: within **0.346°** at the shared times (bound 0.5°). The ClientBall's implicit-Euler
  damping depends on how often it is sampled; the plan's estimate was ~0.1°, the measured worst case (right after an
  order) is higher but in bound, so no sub-sampling.

## The determinism oracle

`export-frames.spec.ts` plays a `TimelineRig` script (cues at 0.5, 1, 3 and 8 s: a direction, an orbit, a goto and a
warp, plus ship c's direction-then-stop script) live at 60 fps to tick 30, and fresh rigs exported by `ExportStepper`
at 24, 30 and 60 fps from the same state. The master `BallStates` at every tick, the boundary sequence, every cue's
state and tick, and the scripts' states are equal; the steps are the floor and ceil of 1/fps.

## Rules

- **An export moves the clock only through `FrameTo`**; nothing else steps the world while `exporting` (`Frame`
  returns early, the time controls throw).
- **A new frame-timed camera path needs an fps-independence case** in the `… at any frame rate (sd-export)` describes:
  drive it at 24 / 30 / 60 fps fixed steps and compare at the shared clocks. A lag or ease toward a moving target uses
  `SmoothTrack` (or its closed form), never a step that holds the target still; a transition starts from the pose at
  its exact clock, not the last frame drawn.
- **Nothing in an export reads real time but the throttles** (`GetActualTime`, below): a new effect timer goes on the
  scene clock (the frame's `now`) or Blue's frame clock.

## Limits

- `GetActualTime` stays on wall time: when an export draws faster than real time (a small scene), a throttled
  controller may skip a frame's update; its actions read Blue's frame time when they run, so values are right and only
  the sampling is coarser.
- The camera director's `Lost()` re-pick (a shot whose subject vanished between boundaries) lands on the next frame, so
  up to 1/fps later at a lower fps.
- `EaseAngle` (the chase swing) holds the aim still over a step: 0.16° between 30 and 60 fps on a 20°/s turn.
- Drawn ClientBall attitudes depend on the sampling rate (implicit Euler): 0.35° between 30 and 60 Hz in a hard turn.
