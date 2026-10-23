# Time control: pause, slow motion, fast-forward (and, later, jump back)

> The scene clock runs at a rate and can pause, and the page steps every Destiny tick however fast it runs. Fetch
> before touching `apps/viewer/src/lib/time-control.ts`, `clock.ts`'s rate and pause, `main.ts`'s frame loop,
> `packages/scene/src/lib/time/`, the `time_control` tool or get_state's `time`. The plan this follows:
> `~/.claude/plans/time-control-pause-slow-motion-fast-forward-and-jump-back-on-the-scene-clock-wit.md` (slices T1 rate,
> pause and fast-forward → T2a the snapshot layer → T2b jump back, the tape and the window → T3 effects across a jump
> and the real-GPU check). The clock and loop basics are `sd-destiny` ("One clock, one loop").

**Status: T1 has landed** (rate, pause, fast-forward, the tool, get_state `time`, the HUD row and keys). Jumping back
and seeking (`back`, `seek`, `every`, `window`) are refused until T2b: snapshots of both parks and of our per-tick
state, the journal of live commands, re-simulation from the nearest snapshot, and effects re-triggered after a jump.
No smooth reverse playback (user, 2026-10-22).

## Files

| File | Holds |
|---|---|
| `packages/scene/src/lib/time/command.ts` | `TimeControlCommand`, `normalizeTimeControlCommand` (every problem at once; the jump keys refused), `MIN_TIME_RATE` 1/16, `MAX_TIME_RATE` 32, `DEFAULT_TIME_RATE`, `AUDIBLE_MAX_RATE` 2, `isTimeRate` |
| `packages/scene/src/lib/time/report.ts` | `TimeReport` (get_state `time`), `TIME_STATES`, `TimeAudioState` |
| `apps/viewer/src/lib/clock.ts` | `SceneClock.rate` / `paused`, `Next(frameMs)` (the frame's target, records the frame), `Set(ticks)`; `Advance` = `Set(Next())` for the specs |
| `apps/viewer/src/lib/time-control.ts` | `TimeControl` (`Frame`, `Pause`, `SetRate`, `Report`, `AttachPort`, `effectiveRate`), `TimeText` / `RateText` for the HUD. Node-tested, no runtime |
| `apps/viewer/src/lib/destiny.ts` | `NextBoundaryTime()` (shares its formula with `DeliverBeforeBoundary`) |
| `apps/viewer/src/lib/audio.ts` | `PageAudio.Suspend(on)` and `Mute(on)` |
| `apps/viewer/src/lib/director.ts` | `AttachTime` (the port: presentation → audio), the `time_control` handler, get_state `time` |
| `apps/viewer/src/main.ts` | builds `TimeControl` with the clock and world before the engine; the HUD `time` row; the keys |
| specs | `time/command.spec.ts`, `clock.spec.ts`, `time-control.spec.ts`; verify-page `time:` |

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

- `time_control { pause?, rate? }` (page tool, not slow): `rate` applies before `pause`; `{}` reports. Returns the
  `time` report plus `warnings`. `back` / `seek` / `every` / `window` are refused ("arrive with the snapshots") until
  T2b.
- get_state `time`: `{ seconds, tick, rate, paused, state: playing | paused, effectiveRate?, held?, audio?: muted |
  suspended }` (`seconds` and `tick` equal `simulation`'s).

## Rules

- Nothing but `TimeControl` advances the clock or calls `world.Tick` in the page.
- Never call `world.Tick` with a time more than one interval past `master.time` in page code: step boundaries with
  `NextBoundaryTime`, or the master's backlog drop and the one-evolve assumption break.
- Coming with T2b: new per-tick state in the director, or a new owner, joins the snapshot (`CaptureSim`); a new live
  lever joins the journaled tools; journaled handlers do their work synchronously.

## Evidence

- verify-page `--only time:` (headless, 2026-10-23, dbxpc): pause held tick 8 for 2 s with identical positions and
  play resumed; 4× gave +20 ticks in ~5 s with an orbit at 2065–2382 m on a 2000 m range and fleet members
  `in-formation` / `catching-up`; 0.25× gave +1 tick and +1.00 scene s in 4 s; rate 0.5 and pause survived a load.
- Not yet checked on the real GPU (T3 does: fps and `gpuErrors` at 4× and 0.25×, turret firing effects on Blue's
  real-time clock in slow motion and pause).
