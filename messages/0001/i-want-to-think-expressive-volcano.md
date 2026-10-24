# Live recording and the frame-locked clock

## Context

**What exists** (`sd-export`, E1–E3 landed 2026-10-24): `export_movie` renders a known span offline (the authored movie,
a timeline range, or N s of an unscripted scene). Every frame sits at exactly T0 + i/fps on the scene clock
(`TimeControl.FrameTo`) however slowly the page draws. Each frame is captured in its own task, encoded with WebCodecs
(H.264 or HEVC, up to 4K) and streamed as SDX1 packets to the hub's `Mp4Writer`. On the real GPU a 300-ship fight
drawn at 3.5 fps came out a smooth 30 fps file. The capture/encode/write half, which you expected to be the hardest
part, is built and measured. But an export locks every page tool and the tab's input, and its span must be known before
it starts.

**What you want**: an agent begins recording, directs the scene live, and ends the recording. The file is the best
picture the engine draws (rendered at the output size, not a screen grab). A heavy scene never jerks: the scene clock is
tied to the frame rate, so when the page can't draw fast enough the scene waits for it instead of skipping ahead.

**The gap**:
1. Nothing records an open-ended live session with the tools left open.
2. Live play runs the clock on wall time. At 2 fps each drawn frame jumps 0.5 s of scene, because the 40 ms step budget
   bounds the cost of ticks, not the step a frame takes.

**The approach: one mechanism, the frame lock.** In this time-control mode the scene clock moves on a 1/fps grid:
- a drawn frame advances the scene by exactly one grid frame, and only once real time × rate has reached it;
- never two grid frames in one drawn frame, and a slow spell is never paid back.

The frame lock is a live lever on its own (`time_control { fps }`: smooth slow motion instead of jerky real time in a big
fight). A live recording (`record_movie`) is the frame lock plus the export's capture/encode/write on every grid frame,
with the tools left open.

**Why live capture and not "record now, render later"**:
- What you see is what is recorded. Nothing has to replay deterministically. Today's time-control tape journals only
  the fleet and ship levers; the orbit camera, live `play_shot` / `frame_camera` / `auto_camera`, and hub edits such
  as `add_ships` are not on it, and those edits cut the window.
- When the lock slows a heavy scene, an agent's seconds of tool latency cost only a sliver of scene time.

Re-rendering a recorded span offline at other settings is a follow-up. `export_movie { restart: false }` already does
it for a started timeline.

## The rules (user-facing)

- **Frame lock at F**:
  - **GPU faster than F**: the scene runs at the rate, F grid frames a scene second, and the rAFs between grid frames
    draw nothing.
  - **GPU slower than F**: one grid frame per drawn frame. The scene slows to (draw fps / F) × the rate, and every
    frame is still exactly 1/F apart.
  - **Paused, or held by a timeline prepare**: the page keeps drawing at the frozen clock, so the camera and
    `screenshot` still work, but no grid frame is reached.
- **A recording**: the file holds the grid frames. File frame k is scene time T0 + k/F, so video time equals scene time.
  - Rate and pause change only how fast the recording proceeds live. Slow the scene to give an agent time; pause to set
    up a beat.
  - Nothing is recorded while paused, so the file has no gap and no freeze frame.
- **The tools stay open during a recording**. Refused, because each would cut the video:
  - time jumps: `time_control` back / seek, and `movie` seek / retake;
  - changing the lock;
  - starting `export_movie`.
- **Script edits during a recording** take the fallback path: future cues pend and past cues are missed. A script edit
  never re-simulates the present mid-recording.
- **Loads during a recording**: `load_scene`, `open_scene` and `timeline restart` are allowed. The file cuts to the new
  scene; its prepare holds the clock, so nothing is recorded meanwhile. An edit that changes `environment.universe` is
  refused, because it reloads the tab, which would fail the recording.
- **Esc** in the tab stops the recording and saves it. `record_movie cancel` discards it.
- **Beats**: `time_control { play: N }` plays N scene seconds, then pauses, and the call returns at the pause. An agent
  directs in exact beats whatever the frame rate: pause, set up, play 5, screenshot, repeat. It works with or without a
  lock or a recording.

(The three design choices above, live capture, video time = scene time, and the beat lever, were confirmed with you on
2026-10-24.)

## Slices

R1 the frame lock and beats (time control) → R2 `record_movie` (page, hub, headless checks) → R3 the real GPU.

### R1: the frame lock and beats

- **`apps/viewer/src/lib/frame-lock.ts`** (new, node-tested, no runtime): `FrameLock` is the grid pacer.
  - `Anchor(now)` sets the origin to now, index −1 and `due` to now.
  - `NextClock()` is `origin + ExportFrameTicks(index + 1, fps)`, reusing `export-frames.ts`.
  - `Advance(ticks)` adds the frame's real delta × rate.
  - `IsDue()` is `due ≥ NextClock()`.
  - `Reached()` moves the index on, then sets `due = min(due, NextClock())`: at most one frame is ever owed.
  - Frame 0 is due at the anchor itself.
- **`time-control.ts`**:
  - **`SetFrameLock(fps | null)`** and the `frameLock` getter. It re-anchors on a change, after `Jump` / `Resimulate`
    landings, and after `EndExport`.
  - **`LockedFrame(frameMs)`** returns one of three results:
    - **wait**: not due, so nothing is drawn;
    - **hold**: paused, held, or a tick threw (logged once, as `Frame` does), so the page draws at the clock;
    - **grid**: `{ clock, index }`, reached by stepping every boundary to `NextClock()`.
  - A grid step uses no step budget, the same as `FrameTo`. Factor their shared loop into a private `StepTo(goal)`.
  - **A `StopAt` inside the step** stops there (pause, `onStop`) as an off-grid hold. On resume, `FrameTo`-style
    stepping goes on from it to the grid clock, so a stop never shifts the grid.
  - `Frame` (the free clock) is unchanged, apart from reading the keyed stops (below). `Measure` runs on locked frames
    too, so `effectiveRate` shows the slowdown.
- **The tool and the report**:
  - **`packages/scene/src/lib/time/command.ts`**: `fps` is an integer from `MIN_EXPORT_FPS` to `MAX_EXPORT_FPS`, or
    `false` to unlock. Command order: window, jump, rate, fps, then pause or play (the beat lever, below).
  - **`report.ts`**: `time.lock { fps, by: time_control | record_movie }`.
  - **`TimeText`**: `1× · 30 fps lock (0.12× actual)`.
  - The lock is a viewing preference like the rate: it survives loads and resets on a tab reload.
- **`main.ts`**: when `timeControl.frameLock` is set, the loop calls `LockedFrame`. A wait frame does
  `requestAnimationFrame` and returns, as the export's waiting frames already do. This is safe:
  - every driver runs again at the next drawn frame's `now`, and `DriveTimeline` runs before the branch;
  - `NextFrames` counts browser rAFs, and a jump's landing re-anchors, so its grid frame 0 draws at once.

  One exception: while a `screenshot` waits (`engine.Capture()` pending), a wait frame draws as a hold. Otherwise a
  slow-rate lock could keep a screenshot waiting for seconds.
- **`director.ts`**: the `time_control` handler, get_state `time.lock`, and the `tools.ts` text.
- **Specs** (`frame-lock.spec.ts`; `time-control.spec.ts` "frame lock"):
  - pacing: 60 Hz frames at F = 30 make every other frame a grid frame, with wall time ≈ scene time;
  - 300 ms frames step one grid frame each;
  - never two grid frames in one call, and no catch-up after a slow spell;
  - hold while paused or held;
  - an off-grid `StopAt`, then the resume onto the grid;
  - a re-anchor after a jump;
  - **the determinism oracle**: a locked run equals a free run tick for tick (master `BallStates` and boundary sequence),
    on the `export-frames.spec.ts` rig.

**The beat lever** (`time_control { play: N }`):
- **Keyed stops in `time-control.ts`**: `StopAt(clock, onStop?, slot = 'movie')`. `Frame` and `LockedFrame` stop at the
  earliest armed stop; reaching it pauses, clears that slot and calls its `onStop`.
  - Today one slot serves the movie's end, and `ArmMovieEnd` would clear a beat's stop whenever its key changes.
  - `PlayFor(seconds, onEnd(why))` arms the `play` slot at now + N and unpauses.
  - It calls `onEnd` once, when the beat ends: at its stop, at any pause (the movie's end, Space, a `time_control
    pause`), at a jump or re-simulation landing, or at `BeginExport`. Every way out but its own stop clears that stop.
  - Report `time.play { stopsAt, stopsIn }` while a beat is armed. The HUD adds `· beat ends in 3.2 s`.
- **`command.ts`**: `play` is scene seconds, from above 0 to 3,600. `play` with `pause` is a problem.
- **`director.ts` `TimeControl`**: with `play` it returns a promise that resolves at `onEnd`, with the time report plus
  `{ played, wallSeconds, endedBy }`. `time_control` is already in the hub's `SLOW_TOOLS` (600 s).
  - The page also stops waiting at `PLAY_WAIT_LIMIT_MS` (about 240 s, well under the hub's timeout). It then answers
    `{ playing: true, stopsIn, note }` with the stop still armed; the note says to call `play` again with `stopsIn` to
    wait it out.
- **Specs**:
  - a beat and the movie's end both armed: the earlier wins, each fires its own callback;
  - `ArmMovieEnd` re-arming does not clear a beat;
  - a beat under a lock lands exactly on its clock;
  - a pause or a jump ends the beat with its `why`.

### R2: `record_movie`

**The scene package** (runtime-free):
- **`export/output.ts`** (new): the output fields that `export_movie` and `record_movie` share (fps, width, height,
  letterbox, codec, bitrate, name, source), moved out of `command.ts`'s `readStart`.
- **`quality` preset** (for both tools): `draft`, `standard` (the default, today's 0.2 bits a pixel a frame), `high`,
  `max`. It sets the bitrate when `bitrate` is not given. `high` and `max` may go past the 100 Mbps default clamp, up
  to `MAX_EXPORT_BITRATE`.
  - HEVC Main tier tops out at 25 Mbps at level 5, so a higher bitrate needs the High tier.
  - R3 checks that the GPU encoder accepts the High-tier codec string.
- **`export/record.ts`** (new):
  - `MOVIE_RECORD_ACTIONS`: status (the default), start, stop, cancel.
  - `normalizeMovieRecordCommand`, which reports every problem at once. Start takes the output fields plus an optional
    `duration`: stop by itself after that many seconds of video, capped at `MAX_EXPORT_SECONDS`.
  - The plan, report and status types. The states are preparing, recording, finishing, done, cancelled and failed.
- **`tools.ts`**: the `record_movie` entry (hub, after `export_movie`) and the get_state `record` sentence. The
  `time_control` fps / play texts and the `time.lock` / `time.play` sentences go in R1.

**The page** (`apps/viewer`):
- **`movie-sink.ts`** (new): the half of `MovieExport` that both drivers share, extracted unchanged:
  - the encoder (configure, encode, flush, close);
  - `OnChunk` (the config message, SDX1 packets, the counts);
  - `Progress`, and the end → saved handshake with its timeout;
  - `OnHub`, `LinkClosed`;
  - `Waiting` (the encoder queue, the socket buffer, a hidden tab, configuring);
  - `Measure` / `Rate`, and draw-failure counting.

  `MovieExport` keeps its driver. **`movie-export.spec.ts` passing unchanged is the check on this refactor.**
- **`movie-record.ts`** (new): `MovieRecording` over a `MovieRecordPort` and the sink.
  - **`Step(timestamp)`**:
    - while waiting (backpressure, the encoder configuring), it returns null and the clock does not move;
    - in preparing, it draws a few warm-up frames at the frozen clock (the canvas resize, TAA), then begins;
    - after that it follows `LockedFrame`: a wait frame returns null, and a hold or grid frame is drawn.
  - **`AfterFrame()`** encodes grid frames only, as file frame k at `ExportFrameMicros(k, F)`. A failed capture redraws
    the same grid frame; a third failure fails the recording, as the export does. It stops by itself at `duration` or
    the cap.
  - **`Stop(why)`** calls `EndRecording`, then the sink's finish. Also `Cancel`, `Report` and `Log`.
- **`time-control.ts`**: `BeginRecording({ fps })` / `EndRecording()`.
  - It is refused during a jump or an export.
  - It saves your lock, sets F anchored at now (with `clock.Resync()`), and restores yours, re-anchored, at the end.
  - While it runs, `Jump`, `Resimulate`, `Command` back / seek and `SetFrameLock` throw `RECORD_LOCKED_TEXT`.
    `Pause`, `SetRate` and `StopAt` still work.
- **`director.ts`**:
  - **`record_movie` handler**: start reaches the page through the hub only, as `ExportMovie` does. `PlanMovieRecord`
    refuses a running export, recording or jump, and `source: "scene"` with no renderer. Then
    `WebCodecsEncoder.Support`.
  - **`ExportGuard` becomes the movie guard**: during a recording it refuses `time_control` back / seek / fps, `movie`
    seek / retake, and an `export_movie` start; everything else runs.
  - **`ScriptEditable()`** is false while a recording runs. **`Apply`** refuses a change of `environment.universe`
    while one runs.
  - **`Presentation().export`** is also set while recording, so the canvas is held at the picture size and shown scaled
    in the window.
  - **Shared with the export**: `ExportCapture` / `ExportLook` (taking the plan's output fields), `Engine.SetFixedSize`,
    `ExportSource` and its compositor.
  - Also: get_state `record`, `StopRecording(why)`, and the link closing fails the recording.
- **`main.ts`**: a recorder branch in the loop, shaped like the exporter's (`Step`, then draw, then `AfterFrame`). Esc
  stops the recording and saves it. The overlay gets a `record` row: `recording · 1:23.4 · 2,502 frames · 30 fps ·
  0.42× real time · Esc stops`.

**The hub** (`apps/scene-director`):
- **`movie-exports.ts`**:
  - `record_movie` goes to the same `MovieExports`: one running session of either kind, and each tool's status reports
    its own kind's last session.
  - `stop` calls the page's `record_movie { action: "stop", id }`, then awaits the session's end (saved returns the
    status with `result`; failed throws), with a timeout. `cancel` works as the export's does.
  - The messages, packets, the tab closing, and `Mp4Writer` are unchanged: every recorded frame is one 1/F step, so the
    single constant `stts` entry still holds.
- **`hub.ts`**: add `record_movie` to `SLOW_TOOLS`.

**verify-page `record:`** (headless, `source: "slate"`):
- **(a)** start → 3 s, with an `order_ship` mid-recording that applies → stop. `ReadMp4` gives samples = frames, CFR
  timestamps, and the recorder's log steps exactly 1e7/F ticks.
- **(b)** a 2 s wall pause mid-recording: the log's clocks stay contiguous, so no gap and no repeated frame.
- **(c)** refused: `time_control` back / seek / fps, `movie` seek, an `export_movie` start. Still working:
  `time_control {}` / rate / pause.
- **(d)** cancel leaves no file.
- **(e)** `duration` stops it by itself.
- **(f)** the lock alone: `time_control { fps: 10 }` steps 1e6 ticks a frame and `time.lock` reports it; then off
  again.
- **(g)** beats: `time_control { play: 2 }` returns paused exactly 2 scene s later, with and without a lock; during a
  recording, two beats with a set-up between them give a file with no gap.

**Specs**:
- `record.spec.ts` (scene);
- `movie-record.spec.ts` (fake ports): only grid frames encoded, k/F timestamps, hold and warm-up never encoded,
  backpressure holds the clock, stop → flush → end → saved, cancel, `duration`, the link closing, draw retries;
- `time-control.spec.ts` "record lock";
- `hub.spec.ts` "live recording": stop waits for saved, one session across both kinds, status per kind.

### R3: the real GPU

Windows Chrome on dbxpc (the `windows-chrome` skill), on a private hub with temp stores and `?audio=off`. A probe logs,
per frame: the scene clock, the animation clock, wall ms and the drawn camera, as in E3.

- **The E3 run-3 fight** (150 vs 150): recorded live at 3840 × 2160 HEVC 30 fps, directed in `play` beats with
  orders, a `play_shot` and `auto_camera` set up between them.
  - Expect every encoded step to be 333,333 / 333,334 ticks, a live effective rate ≈ draw fps / 30, and no undrawn
    frame.
  - Compare the camera's frame-to-frame speed change against a free-running live window, as in E3.
- **A 10-ship scene at 1080p60** (the GPU faster than the grid): wall ≈ scene time, frames = seconds × 60, and no
  duplicate frames.
- **The rest**:
  - a 10 s wall pause mid-recording;
  - Esc stops the recording and saves it;
  - playback at `/movies`;
  - `time_control { fps: 10 }` live on the big fight;
  - `quality: max` with 4K HEVC (is the bitrate accepted? the High tier?).
- **This Mac**: the same pipeline through Claude in Chrome, on the green screen and stand-in cubes (Metal,
  VideoToolbox): a cross-GPU check without EVE data.

## Docs (in each slice's commit)

- **`sd-time`**: the frame lock, keyed stops, and the beat lever.
- **`sd-export`**: its scope becomes "movie export and live recording". Add a "Live recording" section: the record
  lock, the guard, the rules, the evidence.
- **`.dbx-claude/dbx-claude.json`**:
  - `sd-time` triggers gain the words `frame lock` and `beat`, and the path `apps/viewer/src/lib/frame-lock`;
  - `sd-export` triggers gain the words `record_movie` and `live recording`, the paths `movie-record` and `movie-sink`,
    and the tool `mcp__scene-director__record_movie`.
- **CLAUDE.md**: the `sd-export` line gains "live recording (`record_movie`)".
- **README**: a "What works today" line, and the `record_movie` row in the tools table (the `time_control` row mentions
  `fps`).

## Verification

- `dbx-claude-test` for scene, viewer and scene-director: the new specs, plus `movie-export.spec.ts` unchanged.
- `dbx-claude-build` for scene-director.
- verify-page `--only 'record:|export:|time:'` against tools-core, on dbxpc. The export and time batches are the
  regression check.
  - Try `record:` on this Mac too: the slate source needs no renderer and these checks need no SDE.
- R3: the EVE-look runs need dbxpc (Windows Chrome, tools-core), so they run in a session there; the cube check runs
  here. The evidence goes into `sd-export` / `sd-time`.
- **Commits**: one per slice through `dbx-claude-commit`, each declaring its ref impact. The second and third need your
  go-ahead under the commit policy.

## Follow-ups (filed with `dbx-claude-followup`, not built here)

- **Re-render a recorded span offline** at other settings: `export_movie` from / to in scene seconds for unscripted
  scenes. It needs the window pinned over the span, and the camera and hub edits journaled.
- **An offline sound track**, shared with `export_movie`.
- **A fragmented MP4**, so a long recording survives a hub crash.
- **Supersampling** for the `max` look.
