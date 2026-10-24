# Movie export and live recording: the movie rendered offline on a fixed 1/fps scene clock, or recorded live on it

> `export_movie` renders the authored movie (or a time range, or N seconds of an unscripted scene) to an MP4 at a chosen
> size and fps. Every frame sits at exactly T0 + i / fps on the scene clock, however long the GPU takes to draw it, so a
> battle the tab draws at 4 fps still exports as a smooth 30 fps file, just more slowly than real time. `record_movie`
> records the live scene while the tools stay open: the clock runs under the record lock (the frame lock at the file's
> fps, `sd-time`) and every grid frame is encoded, so video time is scene time. Fetch before touching `TimeControl`'s
> export mode or record lock, `export-frames.ts`, a frame-timed camera path, the export or recording pipeline
> (`movie-sink.ts`, `movie-export.ts`, `movie-record.ts`), the hub's MP4 writer and `/movies`. The plans:
> `~/.claude/plans/movie-export-render-an-authored-movie-offline-to-a-video-file-on-a-fixed-1-fps-s.md` (E1 the
> fixed-step clock and the camera-timing specs → E2 the pipeline, the hub writer and `export_movie` → E3 the real-GPU
> export) and `~/.claude/plans/i-want-to-think-expressive-volcano.md` (live recording: R1 the frame lock and beats →
> R2 `record_movie` → R3 the real GPU).

**Status: E3 landed** (2026-10-24): the fixed-step export clock, the frame grid and stepper, the camera-timing specs
(E1); `export_movie`, the page's exporter with WebCodecs, the slate source, the wire, the hub's `Mp4Writer`, sessions
and `/movies`, the locks, and verify-page `export:` headless (E2); the real-GPU export in Windows Chrome on the
animation clock (`sd-time`): the M6 movie, a 60 fps range, a slow 300-ship fight, HEVC 4K and cancel, two camera fixes
(E3, Evidence below).

**Live recording: R2 landed** (2026-10-24): `record_movie`, the record lock, the shared `MovieSink`, the quality preset
and the HEVC High tier, the hub's sessions of either kind, verify-page `record:` headless (Live recording below). R3 (the
real GPU) is open.

**No-EVE-data mode** (`sd-dev-env`): exports work, holding the green screen and stand-in cubes (a 2 s 640×360 export on
Mac Chrome, 2026-10-24).

## Files

| File | Holds |
|---|---|
| `apps/viewer/src/lib/time-control.ts` | the export mode: `BeginExport({ fps? })`, `FrameTo(target)`, `EndExport({ pause })`, `exporting`, `EXPORT_LOCKED_TEXT`; `Frame` returns early while exporting; `Report().state` `exporting` with `exportFps`; `TimeText` `exporting · 1/30 s a frame` |
| `apps/viewer/src/lib/clock.ts` | `SceneClock.Resync()`: the next `Next` targets now |
| `packages/scene/src/lib/time/report.ts` | `TIME_STATES` gains `exporting`; `TimeReport.exportFps` |
| `apps/viewer/src/lib/export-frames.ts` | the grid (`ExportFrameTicks`, `ExportFrameMicros`, `ExportFrameCount`, `ExportPrerollFrames`), `ExportGrid`, `ExportStep`, `ExportStepper` (`Next`, `Again`, `index`, `done`, `Log`, `Summary`). Node-tested, no runtime |
| `apps/viewer/src/lib/timeline.spec-helper.ts` | `TimelineRig` (moved out of `movie.spec.ts`; `ExportTo` drives it as an export), `Cue`, `Direction`, `CUES_A`, `SHIPS_A` |
| `apps/viewer/src/lib/cinema.ts` / `cinema-moves.ts` | `FrameRun` (a shot framed at its exact end before what follows), `SmoothTrack` (the lag, exact for a moving target) |
| `packages/scene/src/lib/export/` | `command.ts` (`MovieExportCommand`, `normalizeMovieExportCommand`: every problem at once), `output.ts` (the output fields both tools share and their constants: `readMovieOutput`, `MovieOutputPlan`, `movieOutputPlan`), `codec.ts` (`exportCodecString` and the H.264 / HEVC level tables with the HEVC High tier, `MOVIE_QUALITIES` and `defaultExportBitrate`, `exportPictureRect`, the bitrate bounds), `record.ts` (`MOVIE_RECORD_ACTIONS`, `normalizeMovieRecordCommand`, the record plan, report, status and states), `wire.ts` (the SDX1 packet, the JSON messages, base64), `report.ts` (`MOVIE_EXPORT_STATES`, the plan, report, status and result) |
| `packages/scene/src/lib/tools.ts` | `export_movie` (hub, after `movie`); get_state's `export` sentence |
| `apps/viewer/src/lib/movie-sink.ts` | `MovieSink`, the half both drivers share: the encoder (configure, encode, flush, close), the config message and SDX1 packets with their counts, `Progress`, the end → saved handshake and its timeout, `OnHub`, `Waiting` (backpressure), the draw rate and failure count; `ExportEncoderPort` + `WebCodecsEncoder` (with `Support`), the backpressure / retry / save constants. Node-tested, no runtime |
| `apps/viewer/src/lib/movie-export.ts` | `MovieExport` over a `MovieExportPort` and the sink (states, `Start`, `Step`, `AfterFrame`, `Cancel`, `OnHub`, `LinkClosed`, `Report`, `Log`), `PlanMovieExport` (the page's checks), `ExportAllows` / `EXPORT_ALLOWED_TOOLS`, `ExportRefusal`, `ExportText`; re-exports the sink's encoder types. Node-tested, no runtime |
| `apps/viewer/src/lib/movie-record.ts` | `MovieRecording` over a `MovieRecordPort` and the sink (`Start`, `Step(timestamp, drawAnyway)`, `AfterFrame`, `Stop`, `Cancel`, `OnHub`, `LinkClosed`, `Report`, `Log`), `RECORD_WARMUP_FRAMES`, `PlanMovieRecord`, `RecordRefusal`, `RecordText`. Node-tested, no runtime |
| `apps/viewer/src/lib/export-slate.ts` | `SlateLines` (pure) and `DrawSlate` (Canvas 2D): the slate source |
| `apps/viewer/src/lib/engine.ts` | `SetFixedSize`, `ExportSource` with the private `ExportCompositor`, `lastFrameDrawn` |
| `apps/viewer/src/lib/director.ts` | `exporter`, `exporting`, `ExportMovie` (the page's `export_movie`), `MovieGuard` (the export's allow-list, the recording's refusals), `ExportPort`, `ExportRestart`, `ExportCapture` / `ExportLook` (on the output plan, shared), `CancelExport`; `recorder`, `recordingMovie`, `RecordMovie` (the page's `record_movie`), `RecordPort`, `StopRecording`; `AttachLink` / `LinkStatus`, get_state `export` and `record`, `Presentation().export` (export or recording) |
| `apps/viewer/src/main.ts` | the loop's export branch (`Step` for `timeControl.Frame`, `SetFixedSize`, `AfterFrame` right after `engine.Frame`, no `DriveAudio`) and recorder branch (`Step(timestamp, capturePending)`, `AfterFrame`), `InputLock` (Esc also stops a recording), the overlay's `export` and `record` rows, `Presentation.Apply` for both |
| `apps/viewer/src/lib/link.ts` / `movie.ts` | `SendBinary`, `SendMessage`, `buffered`, `onExport`; `FramePresentation.export` |
| `apps/scene-director/src/lib/hub/` | `movie-exports.ts` (`MovieExports`: one session of either kind, `record_movie` stop and `RECORD_STOP_TIMEOUT_MS`), `mp4-writer.ts` (`Mp4Writer`), `mp4-reader.testing.ts` (`ReadMp4`, for the specs and verify-page); `hub.ts` (binary messages, `CallPage(name, args, page?)`, `/movies/<file>`, `ByteRange`, `viewer_status.moviesDirectory`) |
| `apps/scene-director/src/lib/store/movie-files.ts` | `MovieFileStore` (`Reserve`, `Resolve`), `DefaultMoviesDirectory`, `DefaultMovieName`, `MovieFileStem`; the CLI's `--movies` / `SCENE_DIRECTOR_MOVIES` |
| specs | `export-frames.spec.ts` (grid, `FrameTo`, the determinism oracle, the preroll, `StopAt`, drawn attitudes), `time-control.spec.ts` "export mode", the `… at any frame rate (sd-export)` cases of `cinema.spec.ts`, `camera.spec.ts`, `camera-director.spec.ts`; `export.spec.ts` and `record.spec.ts` (scene), `movie-export.spec.ts` and `movie-record.spec.ts` (viewer), `time-control.spec.ts` "record lock", `mp4-writer.spec.ts`, `movie-files.spec.ts`, `hub.spec.ts` "movie export" and "live recording", `server.spec.ts`; verify-page `export:` and `record:` |

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
- **A blended `play_shot` over a running shot starts from that shot at the play's clock** (`CinemaRig` `handoff`: the
  next frame frames the replaced run at the play's clock with the lag's share up to it, its lag trail kept till then),
  never from the last frame drawn: E3 found a cue's hero shot starting 258 m apart at 30 and 60 fps.
- **A restart's jump owns the movie camera before t = 0's tick**: `Director.MovieOwnsCamera()` counts a timeline
  `playing` before its first tick as started, so an export's (or `movie retake`'s) restart-then-seek steps the camera
  cues through the re-simulation (E3: a range export's camera stayed frozen until the next camera cue).
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
- One export at a time per hub. A hidden or minimized tab stops rAF, so the export waits (`waiting`): keep the window
  visible. A big silent seek blocks the tab while it re-simulates.
- Video only. H.264 and HEVC only (AV1 / VP9 need av1C / vpcC built by the hub). Integer fps only.
- A shot's own letterbox mid-export resizes the canvas; the first frame after it may show TAA history.
- The runtime's drawn randomness (explosion sub-blasts, burst delays) is unseeded: two exports differ there, never in
  the simulation. The camera can differ for a few frames near a death (E3: 610 m for 6 frames at red-fc's death, 2–6
  frames in other runs; unexplained, likely clearance against a dying hull whose hide time is drawn).
- A range's first frames after its silent seek settle the camera lag (44 m → 8 m within 0.3–0.6 s): inside the 2 s
  preroll, never encoded.
- The H.264 encoder rings into the one 8-pixel block row that straddles each letterbox edge (rows 137 and 942 at
  1080p 2.39: up to 22/255); the compositor's bars are exact.

## One export, end to end

```text
export_movie start (MCP) ── hub: normalize, the page's start (checks, plan, encoder support), reserve <movies>/<name>.mp4
                            and its .part, open the Mp4Writer, answer { id, state, file, plan, warnings }
page MovieExport:
  preparing   Lock(true): tools refused, input locked, audio muted, the canvas held at the picture size;
              restart: timeline restart { paused: true } → wait for ready → Pause → timeline Play → origin pinned
              → zero = NextBoundaryTime()   (restart: false: the run's t = 0; no timeline: now)
  seeking     S = T0 − preroll / fps; Jump(s) to S when it is behind now or more than 1 s ahead (silent re-simulation);
              nothing recorded and S ahead: one FrameTo(S) after BeginExport, with a warning
  BeginExport time control locked; the clock moves only through FrameTo
  prerolling  frames −P…−1: Step() → FrameTo, drivers, engine.Frame, AfterFrame() draws only
  rendering   frames 0…N−1: … AfterFrame() → VideoFrame (canvas, compositor or slate) → VideoEncoder → chunk → SDX1
              packet to the hub (config message before the first)
  finishing   EndExport (clock paused at the last frame), Lock(false); encoder.flush → "end" → the hub writes the moov,
              renames .part → .mp4 → "saved" → done
hub: status from the session (no page call), /movies/<file> with Range, cancel to the export's own tab, the tab
closing → failed + the part deleted
```

`start` returns once the export is armed (before its prepare); progress is the hub's `status` (or get_state `export`).

## The tool, get_state and the HUD

- **`export_movie`** (hub, `where: 'hub'`; the page implements it for the hub's calls): `action` status (default) |
  start | cancel; start takes `from` (timeline s, default 0), `to` (default the movie's end) or `duration` (instead of
  `to`; without a timeline: seconds from now), `fps` (integer 1–120, 30), `width` / `height` (even, 64–4096 ×
  64–2304, 1920 × 1080), `letterbox` (0.5–4 or false, default the movie's look), `codec` (h264 | hevc), `bitrate`
  (1e5–2e8 bits/s, default 0.2 bits a pixel a frame), `restart` (default true with a timeline), `preroll` (0–10 s,
  default 2), `name` (the file stem) and `source` (scene | slate).
- **`normalizeMovieExportCommand`** reports every problem at once (start fields on status / cancel, unknown keys, `to`
  with `duration`, `to ≤ from`, odd or out-of-range sizes, a non-integer fps, `vp9` / `av1` "not yet", the bitrate,
  preroll, letterbox and name bounds, more than `MAX_EXPORT_SECONDS` (3,600), a size and fps beyond the codec's top
  level). The page's `id` passes through.
- **`PlanMovieExport`** (the page) adds what needs the scene: no timeline with `from`, `to`, `restart: true` or without
  `duration`; no movie end without `to` / `duration`; `restart: false` before the timeline started or while it holds the
  clock; a running jump or export; `source: "scene"` without a renderer (`no renderer (…): export_movie needs WebGPU;
  source: "slate" exports the timing only`); `to` past the end is a warning. Then `WebCodecsEncoder.Support` tries
  `prefer-hardware`, then `no-preference` (`plan.hardware`), and refuses with the codec string, size, fps and bitrate.
- **The plan** `{ source, from, to, seconds, frames, fps, width, height, picture, letterbox, codec, codecString,
  bitrate, hardware, restart, timeline, preroll: { seconds, frames }, keyframeEvery }`.
- **The status** (hub) is the page's last report plus `file { path, url, windowsPath?, bytes }` and, once saved,
  `result { path, url, bytes, frames, seconds, fps, width, height, codec, wallSeconds, meanFps }`; `{ state: 'idle' }`
  before any export since the hub started. The last session stays until the next start.
- **The report** `{ id, state, plan, frame, frames, progress, time (timeline s of the last frame drawn), rate { fps,
  realtime }, eta, waiting?, encoder { queue, chunks, keyFrames, bytes }, frameMs { mean, max, retries }, startedAt,
  wallSeconds, gpuErrors, warnings, error?, note?, file? }`; get_state `export` is it (null before an export this page
  session); `time.state` reads `exporting`.
- **The HUD**: an `export` row (`ExportText`: `rendering · frame 412/2850 (14 %) · 5.2 fps · 7 min 48 s left · Esc
  cancels`). The overlay shows during an export whatever the looks say; H toggles it. It is never in the file.

## The picture and the compositor

- **The look**: the `letterbox` option, else the movie block's (`movieLookOf`), else none. The page's `?letterbox=`,
  L, H and a run's overrides are ignored (viewing preferences). A playing shot's own `letterbox` still wins while it
  plays (`Director.ExportLook`: `MoviePresentation` with the page layer empty), so the file shows what the preview does.
- **`exportPictureRect(width, height, aspect)`**: even sides, centred; 1920 × 1080 at 2.39 is `{ 0, 138, 1920, 804 }`,
  320 × 180 is `{ 0, 23, 320, 134 }`, a narrower aspect pillarboxes, 1920 × 804 at 2.39 fills.
- **The canvas** backing store is held at the picture size (`Engine.SetFixedSize`, which `Frame` uses instead of
  fitting the CSS box; null fits again). main.ts sets it every frame from `Presentation().export`, before
  `engine.Frame`, so the prepare frames already draw at the export size. The window shows the canvas centred at the
  picture's aspect, downscaled (`Presentation.Apply`). The cinema and the director frame for `engine.Aspect()`, the
  canvas's.
- **`Engine.ExportSource(output, picture)`**, right after `Frame` in the same task: null when the frame did not draw
  (`lastFrameDrawn` false: an error, a lost device, no swap-chain image); the canvas itself when the picture fills the
  output; else the private `ExportCompositor`: an output-sized `OffscreenCanvas` with a `webgpu` context on the engine's
  device in the canvas format (`RENDER_ATTACHMENT | COPY_DST`, opaque) that clears to black, `copyTextureToTexture`s the
  presented texture to `(picture.x, picture.y)` and submits. A shot's own letterbox mid-export moves the bars and
  resizes the canvas (TAA history may show for a frame: a limit). E3 checks it on the GPU.
- **The slate** (`source: "slate"`): `DrawSlate` on an output-sized 2D `OffscreenCanvas`: black, the scene's name,
  `timeline 12.033 s`, `frame 361 / 900` (`preroll -3` before 0), `tick 15`, `fps 30`, and a bar sweeping once a second.
  It needs no renderer: verify-page's way through the pipeline.

## Capture and encoding

- **Capture**: `AfterFrame()` asks the port for the frame's source and builds `new VideoFrame(source, { timestamp,
  duration })` in `WebCodecsEncoder.Encode`, encodes it and closes it. A `VideoFrame` reads the WebGPU canvas only in
  the frame's own task (§ sd-runtime); main.ts calls `AfterFrame()` right after `engine.Frame`.
- **The config** `{ codec: codecString, width, height, displayWidth, displayHeight, bitrate, bitrateMode: 'variable',
  framerate, latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } | hevc: { format: 'hevc' } }`.
- **Codec strings** (`exportCodecString`, the lowest level whose frame size and rate fit; the file carries the
  encoder's own `decoderConfig.codec` and `description`, Chrome's hardware encoder writing level 4.0 into a 1080p avcC
  whatever was asked):

  | Output | H.264 High | HEVC Main |
  |---|---|---|
  | 320 × 180 at 10 | `avc1.64001F` (3.1) | `hvc1.1.6.L120.B0` (4) |
  | 1080p30 | `avc1.640028` (4.0) | `hvc1.1.6.L120.B0` (4) |
  | 1080p60 | `avc1.64002A` (4.2) | `hvc1.1.6.L123.B0` (4.1) |
  | 2160p30 | `avc1.640033` (5.1) | `hvc1.1.6.L150.B0` (5) |
  | 2160p60 | `avc1.640034` (5.2) | `hvc1.1.6.L153.B0` (5.1) |
  | 4096 × 2304 at 30 / 60 | `avc1.640034` / beyond 5.2 (refused) | beyond 5.2 (its luma picture size) |

- **Bitrate** (when `bitrate` is not given) from the **quality** preset (both tools): `draft` 0.08, `standard` (the
  default) 0.2, `high` 0.35 and `max` 0.6 bits a pixel a frame, at least 0.5 Mbps; draft and standard clamp at 100 Mbps,
  high and max at `MAX_EXPORT_BITRATE` (200 Mbps). Standard: 12.4 Mbps at 1080p30, 24.9 at 1080p60, 49.8 at 2160p30;
  max: 149 Mbps at 2160p30. The plan carries `quality`.
- **The HEVC High tier**: above `HEVC_HIGH_TIER_BITRATE` (25 Mbps, the Main tier's top at level 5) the codec string takes
  the High tier (`hvc1.1.6.H150.B0`) at the lowest level whose size, rate and High-tier bitrate fit (4 30, 4.1 50, 5 100,
  5.1 160, 5.2 240 Mbps): 2160p30 standard (49.8 Mbps) `H150`, max (149 Mbps) `H153`. This changed 2160p30 HEVC's
  default from E3's `L150` to `H150`; R3 checks the GPU encoder takes it. H.264 levels are not raised for the bitrate
  (Chrome's encoder writes its own level). **Keyframes** every `round(2 × fps)` frames (`keyframeEvery`).
- **Backpressure**: `Step()` returns null (main.ts draws nothing, the clock does not move) while the tab is hidden
  (`the tab is hidden: drawing stops until it shows`), the encoder is configuring, its `encodeQueueSize` > 8, or the
  link buffers > 8 MiB; the report names it in `waiting`.
- **Measured support** (2026-10-24, dbxpc). Windows Chrome 155, NVIDIA Lovelace, `isConfigSupported` at 20 Mbps 30 fps:

  | Codec | 1080p hardware | 1080p software | 2160p hardware | 2160p software |
  |---|---|---|---|---|
  | H.264 High 5.1 `avc1.640033` | yes | yes | yes | yes |
  | H.264 High 4.2 `avc1.64002A` | yes | yes | no (level) | no |
  | VP9 `vp09.00.51.08` | no | yes | no | yes |
  | AV1 `av01.0.12M.08` | yes | yes | yes | yes |
  | HEVC `hvc1.1.6.L153.B0` | yes | no | yes | no |

  A `VideoFrame` of the WebGPU canvas right after the submit: 0.30 ms; in a later task, once presented: `Failed to read
  VideoFrame data`. The compositor's composite: 0.6 ms, bars exact. 90 canvas frames through the hardware H.264 encoder
  at the rAF pace: 1.56 s at 1080p (queue max 11), 1.58 s at 2160p: encoding never bounds an export. H.264 chunks come
  in order (no B-frames); the colour space is BT.709 with the sRGB transfer, limited range; AV1 and VP9 give no
  `description` (a follow-up). Headless Chromium 151 (Playwright): H.264 (OpenH264, `avc1.640033` included), VP8, VP9
  and AV1 encode, HEVC does not; `VideoDecoder`, `MediaSource` and `<video>` play H.264.

## The wire

- **Binary packets** (`wire.ts`): `"SDX1"`, a u32 LE header length, the UTF-8 JSON header `{ id, seq, key, timestamp
  (µs), duration (µs) }`, the chunk's bytes; `decodeExportPacket` returns null for a bad magic, length or header.
- **JSON** `{ type: "export", id, kind, … }`: page → hub `config { track: { codec, codecString, width, height, fps,
  description (base64), colorSpace? } }`, `progress { report }` every `EXPORT_PROGRESS_MS` (1 s), `end { report }`,
  `failed { error, report }`, `cancelled { report }`; hub → page `saved { file }`, `failed { error }` (a disk error).
- WebSocket keeps text and binary in order, so the config precedes the first chunk; the hub fails a gap in `seq`
  (`chunk 412 never arrived (chunk 413 came instead)`).

## The hub

- **`MovieFileStore`**: `DefaultMoviesDirectory()` is `scene-director/movies` in the per-user data directory
  (`~/.local/share/scene-director/movies` here), `--movies <dir>` / `SCENE_DIRECTOR_MOVIES` override it; `Reserve(name)`
  takes document-files' stem rules made ASCII (`duel-at-jita`), unique with `-2`, `-3`, … past files and parts, and
  creates the directory; `Resolve` serves only `^[a-z0-9][a-z0-9_-]*\.mp4$` inside it. The default name is `<scene
  name>-<yyyymmdd-hhmmss UTC>` (the page's start answers with the scene's name).
- **`Mp4Writer`**: `Open` writes `ftyp` (`isom`, minor 512, `isom iso2 avc1|hvc1 mp41`) and a 64-bit `mdat` header;
  `Configure(track)` once; `AddSample` positional writes in order; `Finish` writes `moov` (`mvhd` timescale 1000 and
  next track 2, `tkhd` flags 3 with 16.16 size, `mdhd` timescale fps × 1000 and `und`, `hdlr vide`, `vmhd`, `dref url`,
  `stsd` `avc1`+`avcC` / `hvc1`+`hvcC` with `colr nclx` (bt709 1, iec61966-2-1 13, the range bit) and `pasp 1:1`, `stts`
  one `(N, 1000)`, `ctts` v1 only for out-of-order timestamps, `stss`, `stsc (1, 1, 1)`, `stsz`, `co64`), patches the
  mdat size, closes and renames; `Abort` closes and deletes. No faststart: Chrome plays a moov-at-end file over Range.
- **`MovieExports`**: one session (`export-<ms>-<n>`); start is refused while one runs; the page's messages for its id
  from its own tab only; writes on one promise chain (a disk error fails it and tells the page); `cancel` calls the
  export's own tab (`Hub.CallPage(name, args, page)`), then aborts; the tab closing fails it (`the viewer tab closed or
  reloaded during the export`) and deletes the part; `Hub.Stop` aborts. Under WSL the file also gets `windowsPath`
  (`\\wsl.localhost\<distro>\…`).
- **`/movies/<file>`**: GET and HEAD, `video/mp4`, `accept-ranges: bytes`, `no-store`; one `bytes=a-b`, `a-` or `-n`
  range gives 206 (416 past the end); anything `Resolve` refuses is 404.

## Locks

- **Tools** (`Director.ExportGuard`, the outermost handler wrapper): from preparing to finishing every page tool is
  refused (`a movie export is running (rendering, frame 412 of 2850): export_movie { action: "cancel" } stops it`)
  but `EXPORT_ALLOWED_TOOLS` (`get_state`, `get_scene`, `get_overview`, `list_hardpoints`, `screenshot`, `list_scenes`,
  `save_scene`, `export_movie`) and the status forms (`timeline` / `movie` with nothing but `action: "status"`,
  `time_control {}`). Hub tools that edit reach the page as `patch_scene`, so they are refused too; a new tool is
  refused by default.
- **Input** (main.ts `InputLock`, registered first): capture-phase window listeners for pointerdown / move / up, wheel
  (not passive), contextmenu and keydown stop and prevent everything while `director.exporting`, before the canvas's
  camera handlers, the overlay buttons and the key handlers. Esc cancels (`cancelled: Esc in the tab`); H passes (the
  overlay).
- **Time control** throws `EXPORT_LOCKED_TEXT` between `BeginExport` and `EndExport`; the exporter's own seek runs before.

## Audio

Muted: `Lock(true)` mutes the page audio; the time port's unmute and a jump's `EndJump` keep it muted while
`exportLocked`; `DriveAudio` is skipped while exporting; `Lock(false)` restores `Mute(time.muted)` and the pause's
`Suspend`. The page's audio plays in real time while an export runs at any speed; an offline sound track (an
`OfflineAudioContext` mix of the scene-timed post log, muxed as a second track) is a follow-up, and needs a PTADPCM
decoder for turret and impact sounds.

## Failure handling

- A frame that does not draw (no source: `lastFrameDrawn` false, `engine.lastError`) or whose `FrameTo` threw is
  redrawn at the same clock (`Again()`, or `Next()` again); the third failure in a row fails the export (`frame 412
  (timeline 13.73 s) failed to draw 3 times: …`). A lost device fails it at once.
- The encoder's `error` callback or a throwing `encode` fails it (`the encoder failed: …`); a first chunk without a
  description fails it.
- The hub link closing (`HubLink` onStatus false → `LinkStatus`) fails it quietly (the hub sees the tab close and
  deletes the part); a hub `failed` (a disk error) stops it.
- The `saved` wait times out after `EXPORT_SAVE_TIMEOUT_MS` (30 s): `the hub did not confirm the file within 30 s`.
- A restart that is not `ready` within `TIMELINE_PREPARE_LIMIT_SECONDS + 10`: `the restarted movie did not prepare: …`.
- Cancel and failure both close the encoder, `EndExport({ pause: true })` when it began, `Lock(false)` and keep the
  report.

## Live recording (`record_movie`, R2)

**The record lock.** A recording is the frame lock (`sd-time`) at the file's fps plus the export's capture/encode/write
on every grid frame, with the tools left open. File frame k is scene time T0 + k / F at `ExportFrameMicros(k, F)`:
video time is scene time. Rate and pause only change how fast it goes live; hold frames (paused, a timeline prepare,
an off-grid stop) are drawn and never encoded, so a pause leaves no gap and no freeze frame. Beats (`time_control
{ play }`) work during a recording; an agent directs in exact beats: pause, set up, play 5, repeat.

**The page** (`MovieRecording`, `movie-record.ts`):
- `Start()` configures the sink's encoder. **preparing**: `Step` draws `RECORD_WARMUP_FRAMES` (3) at the frozen clock
  (the canvas takes the picture size, TAA settles), then `TimeControl.BeginRecording({ fps })` (anchored at now) and
  **recording** (a forced progress message, so the hub's status follows).
- **`Step(timestamp, drawAnyway)`**: null while the sink waits (hidden tab, encoder configuring or queue > 8, socket
  > 8 MiB: the clock does not move) or on a `wait` frame of `LockedFrame`; a `hold` frame draws at the clock; a `grid`
  frame is pending for `AfterFrame`. `drawAnyway` (main.ts passes `engine.capturePending`) draws a frame that would draw
  nothing at the clock, never encoded. A progress message goes at most once a second while driving.
- **`AfterFrame()`** captures the pending grid frame (`Director.ExportCapture`, shared with the export: the slate, the
  canvas or the compositor) and encodes it; a failed capture redraws the same grid frame (no clock step) and the third
  failure fails the recording; a lost device fails it at once. At `plan.maxFrames` (`duration` × F, else
  `MAX_EXPORT_SECONDS` × F) it stops by itself (`stopped: its duration (1.5 s of video)` / `the cap`).
- **`Stop(why)`**: `EndRecording` (the user's lock comes back), finishing, the sink's flush, `end`, the hub's `saved`
  (30 s timeout), done. With no frame encoded it ends **cancelled** (`…, before any frame was recorded: no file`).
  `Cancel(why)` closes, releases and tells the hub. The link closing fails it quietly.
- `Log()` keeps the last 2,000 encoded frames `{ index, clock, tick }` (verify-page reads the steps from it).

**`PlanMovieRecord`** refuses, all at once: a running export, a running recording, a running jump, and `source: "scene"`
without a renderer (`record_movie needs WebGPU; source: "slate" records the timing only`); a paused scene is a warning
(nothing is recorded until it plays). Then `WebCodecsEncoder.Support`. The plan is the output plan plus `duration` and
`maxFrames`; the look is the command's letterbox, else the movie block's, else none.

**The guard** (`Director.MovieGuard`, outermost, `RecordRefusal`): during a recording only what would cut the video is
refused: `time_control` back / seek / fps, `movie` seek / retake, `export_movie` start (the hub refuses it first:
`a live recording is running (recording, 1 s recorded): record_movie { action: "stop" } ends it`). Everything else
runs, input is not locked. Behind it, `TimeControl` throws `RECORD_LOCKED_TEXT` for a jump, re-simulation or lock change.
- **Script edits** take the fallback path (`ScriptEditable()` false while `time.recordingMovie`): future cues pend,
  past cues are missed, nothing re-simulates the present.
- **Loads** (`load_scene`, `open_scene`, `timeline restart`, `movie restart`) are allowed: the file cuts to the new scene;
  its prepare holds the clock, so nothing is recorded meanwhile. Loads never move the clock back, so the grid goes on.
- **`Apply` refuses a change of `environment.universe`** while recording (with a renderer it reloads the tab, which
  would fail the recording).
- **Esc** in the tab stops and saves (`InputLock`: `StopRecording('Esc in the tab')`).
- `Presentation().export` is set while recording too: the canvas is held at the picture size and shown scaled. Audio
  stays live (not muted, unlike an export).

**The hub** (`MovieExports`): one session of either kind (`export-…` / `record-…` ids); a start of either kind is
refused while one runs, naming the running kind. Each tool's `status` reports its own kind's last session (`idle`
before one). `record_movie stop` calls the page's `record_movie { action: "stop", id }`, then waits for the session to
end, at most `RECORD_STOP_TIMEOUT_MS` (120 s): saved returns the status with `result`, cancelled the status, failed
throws, and a timeout returns the status (finishing) with `note: the file is still being written…`. `cancel` is the
export's. The wire, the packets, the tab closing and `Mp4Writer` are unchanged: every recorded frame is one 1/F step,
so the one `stts` entry holds. `record_movie` is in `SLOW_TOOLS` (600 s).

**The tool**: `record_movie` (hub, `where: 'hub'`) `action` status (default) | start | stop | cancel; start takes the
output fields (`fps`, `width`, `height`, `letterbox`, `codec`, `bitrate` or `quality`, `name`, `source`) and `duration`
(seconds of video, up to `MAX_EXPORT_SECONDS`). get_state `record` is the page's report `{ id, state, plan, frame,
seconds, sceneSeconds, rate { fps, realtime }, left, waiting?, encoder, frameMs, startedAt, wallSeconds, gpuErrors,
warnings, error?, note?, file? }`; the overlay's `record` row: `recording · 1:23.4 · 2,502 frames · 30 fps · 0.42× real
time · Esc stops`.

**verify-page `record:`** (`RecordChecks`, both runs: it needs no EVE data). 2026-10-24, this Mac, headless Chromium,
`--eve-data off --only record:`, stand-in ships by dna with stats, `source: "slate"`, 320 × 180 at 10 fps:
- (a) start → an `order_ship` mid-recording applies → stop: 42 frames (4.2 s) in 4.24 s wall, `ReadMp4` samples =
  frames, every encoded step exactly 1,000,000 ticks, the lock off again after.
- (b) a 2 s pause mid-recording: 0 frames encoded while paused (the page's own count), steps all 1e6: no gap.
- (c) refused: `time_control` back / seek / fps, `movie seek` (`would cut the video`), `export_movie start` (the hub);
  `time_control {}`, rate and pause work, `time.lock.by` `record_movie`.
- (d) cancel at frame 12: no file left. (e) `duration: 1.5`: 15 frames, `stopped: its duration (1.5 s of video)`.
- (f) the lock alone, `time_control { fps: 10 }`: every clock change on the page's rAF is 1,000,000 ticks; off again.
- (g) beats: `time_control { play: 2 }` returns paused 2.00 scene s later, free and under a 10 fps lock; during a
  recording two 1 s beats with an order between: 21 frames, steps all 1e6.

Two fixes the run found: the hub's status read `preparing` for a recording paused after its warm-up (no frame encoded,
so no progress message): the move to recording sends one, and `Step` sends one a second while driving; and (b) first
read the hub's lagging status instead of the page's report.

**R3 (open)**: the real-GPU runs in the plan (the 150 vs 150 fight at 4K HEVC in beats, a 10-ship 1080p60 recording, a
10 s pause, Esc, `/movies` playback, `fps: 10` live on the big fight, `quality: max` 4K HEVC and the High tier) on
dbxpc, and the cube run on this Mac's Chrome.

## verify-page evidence (E2, 2026-10-24, dbxpc, tools-core SDE build 3646012, headless Chromium: `--only export:`)

Headless has no WebGPU adapter, so every case exports `source: "slate"` through the real clock, WebCodecs (OpenH264),
the wire, the hub's writer and the file, with its own hub and a temp movies store:

- **(a) a slate export of a scripted movie** (Rifters a and b; `b-go` at 0, `go` at 1, `stop-b` on `{ cue: go } + 1`;
  movie `{ letterbox: 2.39, end: 4 }`; `{ fps: 10, width: 320, height: 180 }`): plan 40 frames, picture `{ y: 23,
  height: 134 }`; done in 7.4 s wall (5.4 frames a second: the slate's pace is the headless rAF); 33,335 bytes;
  `ReadMp4` 40 samples, 4.0 s, sample 1 sync; cues `b-go 0, go 1, stop-b 2` ticks after t = 0, the same as a live
  `timeline restart` run; a at 4 s within 0.0000 m of the live run; the clock paused at 3.9 s with recording on.
- **(b) the file plays**: a `<video>` on the hub's origin: duration 4 s, 320 × 180, seeks to 2 s, 15 frames presented
  in 1.5 s of play.
- **(c) the grid**: 40 steps of exactly 1,000,000 ticks, the world tick +1 every 10 frames; the same movie at 20 fps
  (80 frames): the same cue ticks and a at 4 s within 0 m.
- **(d) cancel**: a 900-frame export cancelled after 1 s (frame 134): no `.part` or `.mp4` left, `patch_scene` works,
  `time.state` paused, get_state `export.state` cancelled.
- **(e) refusals**: while rendering `patch_scene` (`a movie export is running (rendering, frame 29 of 900): …`),
  `time_control { pause: false }` and a second start are refused, `time_control {}` answers; Space leaves `time.state`
  `exporting` and a canvas drag reaches no canvas listener; Esc cancels (`cancelled: Esc in the tab`). Before: `{ from:
  5, to: 3, width: 321 }` reports both problems, `source: "scene"` headless is refused (`no renderer (…)`), `restart:
  false` on a held-at-t = 0 timeline (`needs a started timeline (it is ready)`), `to` on a scene without a timeline.
- **(f) a range from the time window**: played to 6 s, then `{ restart: false, from: 2, to: 3, fps: 10 }`: 20 preroll
  frames, a jump back to t = 0 (`from 10.1 to 4`, snapshot 4), 10 frames from 2 s, cues `b-go 0, go 1, stop-b 2` as the
  straight run, paused at 2.9 s.
- **(g) a scene without a timeline**: `{ duration: 2, fps: 10 }` from now: 20 frames, the clock paused at +1.9 s, a moved
  656 m.

Two fixes the run found (2026-10-24): `time_control {}` threw `EXPORT_LOCKED_TEXT` (it ran `Command({})`; now the
director only reads for an empty command), and a held, ready timeline got the "prepares" refusal for `restart: false`
instead of "needs a started timeline". A third, in E1's stepper: a grid without preroll started at index −0, so the
first frame's timestamp was −0 (`0 - preroll` now).

The regression batch after E2 (2026-10-24, dbxpc, the E2 commit's build, headless:
`--only 'export:|movie:|time:|timeline:'`, ~25 min): 46 ok, 0 failed (timeline 14, time 14, movie 10, export 7 and the
hub link); page errors 1, unexpected 0 (the renderer's missing adapter). Nothing needed fixing.

## Real-GPU evidence (E3, 2026-10-24, dbxpc, Windows Chrome, NVIDIA Lovelace, tools-core SDE build 3646012)

A private hub on 5533 (temp stores), the tab at 1600 × 900 (`?audio=off`), the animation clock on (`renderer.animation`
`clock: scene`). A probe wrapped `engine.Frame` and logged per frame the scene clock, the animation clock's ticks,
`shaderTime`, wall ms, the drawn eye, `gpuErrors`, the exporter's state and frame, and the canvas size. Drivers in
`.scratch/movie-export-gpu/` (`export.mjs`, `stats.py`, M6's `drive.mjs setup`).

| Run | Command | Frames | Wall | Export fps | Bytes (mean bitrate) | Notes |
|---|---|---|---|---|---|---|
| 1 M6 full | `{}` (1080p30 H.264 `avc1.640028`, letterbox 2.39) | 2,850 | 75.3 s (75.8 first pass) | 37.8 | 144,484,289 (12.17 Mbps vs 12.44 asked) | 48 keyframes; frame ms mean 26.1, max 175 |
| 2 range | `{ from: 30, to: 45, fps: 60 }` | 120 preroll + 900 | 26.4 s | 38.6 | 47,044,778 (25.1 Mbps vs 24.9) | `avc1.64002A`; first encoded frame at timeline 30.000, preroll 28.000–29.983 |
| 3 big fight | 150 Punishers vs 150 Rifters (brawler), CNAP, `auto_camera` at 1, `{ to: 20 }` | 600 | 180 s (prepare 4 s) | 3.5 (0.11× real time) | 34,900,262 (14.0 Mbps) | frame ms mean 288, max 1,480; live 1–6 fps |
| 4 HEVC 4K | `{ codec: "hevc", width: 3840, height: 2160, to: 2 }` (the big fight) | 60 | 28 s | 3.45 | 7,760,760 | `hvc1.1.6.L150.B0`, 49.8 Mbps asked |
| 5 cancel | `{}`, cancelled at frame 300 | 321 | 10.5 s | | | no `.part` left |

- **Determinism**: both full M6 exports and every range fired the cues at 0, 5, 5, 19, 19, 20, 25, 25, 33, 33, 36, 41 and
  killed blue-fc at 32, red-fc at 35 and red-dps-02 at 42 (timeline seconds), as M6's straight run.
- **The clock**: every encoded frame stepped the scene by exactly 333,333 / 333,334 ticks at 30 fps (166,666 / 166,667 at
  60), the animation clock by the same, and shader time by 1/fps (at 0.01 s rounding 0.03 / 0.04 in a 2 : 1 mix; 94.96 s
  of shader time over 94.967 s of scene). So the runtime's own animations follow the export clock.
- **The picture**: the canvas held 1920 × 804 on every frame (the compositor adds the bars); no frame undrawn, `gpuErrors`
  0 and page errors 0 in every run. Decoded bars: rows 0–136 and 943–1079 at most 5/255; rows 137 and 942 up to 22/255
  (codec ringing, Limits).
- **Playback** at `/movies/<file>` in a second tab: M6 95 s 1920 × 1080, 3 s of play → 3.30 s, 89 frames presented, 4
  dropped; the range 15 s, 179 frames, 9 dropped; the big fight 20 s, 91 frames, 5 dropped; HEVC 4K 2 s 3840 × 2160,
  45 frames in 1.8 s, 2 dropped. Seeks land; the frames show the shots the live run shows (the overlook at 31 s, the
  fight at 40 s, the big fight's station, laser fight and a close explosion).
- **Slow and smooth** (run 3, timeline 2–20 s, cuts excluded): the export took 539 steps of exactly 1/30 s with 4 cuts;
  the camera's speed changed 1.4 % a frame (median; p95 21.5 % at moves and eases). The same window live: 61 frames,
  scene steps 0.03–1.0 s (sd 0.19 s), speed change 11.9 % a frame (p95 71 %).
- **Cancel and back to live**: cancelled at frame 321, no part file, the canvas back at 1600 × 669, the clock paused at the
  last frame with the animation clock frozen; play resumed at 40–41 fps with `renderer.animation.frozen` false.
- **Watch list**: the compositor's edges exact (above); no picture resize mid-export in these movies (no shot letterbox);
  the first frames after a seek settle inside the preroll; no effect on wall time (shader time on the clock); exposure
  showed no per-frame jump in the files viewed (not measured); backpressure: the encoder queue peaked at 6 at 34 export
  fps, never `waiting`.

Two camera fixes the runs found (2026-10-24):

1. **A range export's camera stayed frozen** at the establishing shot's eye from 28 s until the next camera cue (33 s):
   the export's restart plays the timeline with the clock paused and jumps at once, before t = 0's tick, so
   `MovieOwnsCamera()` read `startTick` null, the jump went silent for the cinema and the overlook cue was swallowed.
   `movie retake` has the same shape. Fixed (Rules); after it the range's eye matches the full export's to 0.0 m from
   29 s on.
2. **A blended shot over a running one started from the last frame drawn**: the hero cue at 33 s began 258 m apart at 30
   and 60 fps (the overlook moving ~15 km/s, one 1/60 s frame of travel), converging by 34.3 s. Fixed (Rules;
   `cinema.spec.ts` "blends a shot played over a running one…", 1.8 % of the eye distance at 24 vs 60 fps before, under
   1e-3 after); on the GPU the two exports now agree within 0.6 m across the cut.
