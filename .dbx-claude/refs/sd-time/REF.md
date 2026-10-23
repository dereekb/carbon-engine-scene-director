# Time control: pause, slow motion, fast-forward (and, later, jump back)

> The scene clock runs at a rate and can pause, and the page steps every Destiny tick however fast it runs. Fetch
> before touching `apps/viewer/src/lib/time-control.ts`, `clock.ts`'s rate and pause, `main.ts`'s frame loop,
> `packages/scene/src/lib/time/`, the `time_control` tool or get_state's `time`. The plan this follows:
> `~/.claude/plans/time-control-pause-slow-motion-fast-forward-and-jump-back-on-the-scene-clock-wit.md` (slices T1 rate,
> pause and fast-forward → T2a the snapshot layer → T2b jump back, the tape and the window → T3 effects across a jump
> and the real-GPU check). The clock and loop basics are `sd-destiny` ("One clock, one loop").

**Status: T1 and T2a have landed.** T1: rate, pause, fast-forward, the tool, get_state `time`, the HUD row and keys.
T2a: the snapshot layer (node-tested only; nothing in the page calls it yet): `state-capture.ts`, `destiny-snapshot.ts`,
`DestinyWorld.Snapshot()` / `Restore()` and `Snapshot()` / `Restore()` on every per-tick owner. Jumping back and seeking
(`back`, `seek`, `every`, `window`) are refused until T2b (the journal of live commands, the ring, re-simulation from the
nearest snapshot); T3 re-triggers effects after a jump. No smooth reverse playback (user, 2026-10-22).

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
| `apps/viewer/src/lib/state-capture.ts` | `CaptureFields` / `RestoreFields` / `CloneState` / `EstimateBytes`: the generic per-tick state capture every owner's `Snapshot()` / `Restore()` is a one-liner over. Node-tested |
| `apps/viewer/src/lib/destiny-snapshot.ts` | `CapturePark` / `RestorePark` (stream + scalar overlay), `CaptureScalars` / `OverlayScalars`, `STRUCTURAL_BALL_FIELDS` / `STRUCTURAL_PARK_FIELDS`, `ParkSnapshotBytes`, `WARMUP_TICKS` 3, `WARMUP_SAMPLES_PER_TICK` 30. `runtime-sim` only |
| `apps/viewer/src/lib/destiny.ts` | `Snapshot()` / `Restore()` (`DestinySnapshot`), getter-backed `master` / `replica`, `SampleCurves(time)` |
| owners | `Snapshot(memo?)` / `Restore(state, memo?)` on `ShipModules`, `DamageModel`, `CapacitorModel`, `ShipLocks`, `CombatRules`, `ShipTargets`, `FleetTargets`, `FleetCommanders`, `AutoRepair`, `MissileFlights`, `ShotQueue`, `TurretSoundQueue`, `WarpFx`, `FleetFollowing`, `FleetOrders`, `Arrivals` (each with a `*_CAPTURE` options constant naming its wiring) |
| specs | `time/command.spec.ts`, `clock.spec.ts`, `time-control.spec.ts`, `state-capture.spec.ts`, `destiny-snapshot.spec.ts` (the audit, determinism, warm-up, the `SD_BENCH` bench), a `<Owner> snapshots (sd-time)` round trip in each owner's spec over `state-capture.spec-helper.ts` `RoundTrip`; verify-page `time:` |

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

## Measurements (T2a bench, `SD_BENCH=1`, node on dbxpc, 2026-10-23)

Ships in rings behind a turning TFI, a quarter orbiting, a quarter on goto orders, the rest following, all sampled
every frame. World only (both parks and the world's entries; the director's owners come in T2b's
`time.window.capture`).

| ships | capture | stream (master) | both parks | snapshot | restore | tick | warm-up / tick | 64 MB at 5 s |
|---|---|---|---|---|---|---|---|---|
| 50 | 1.6 ms | 6.1 KB | 109 KB | 142 KB | 4.0 ms | 1.3 ms | 0.7 ms | 2307 s |
| 200 | 2.8 ms | 24 KB | 427 KB | 561 KB | 8.2 ms | 4.3 ms | 0.9 ms | 585 s |
| 500 | 6.2 ms | 61 KB | 1.0 MB | 1.4 MB | 23.7 ms | 11.2 ms | 3.1 ms | 234 s |

The scalar overlay is about two thirds of a snapshot (mostly each ball's typed arrays; the streams under a tenth, the
entries the rest). The default 120 s window fits the budget even at 500 ships, so the smaller-snapshot optimizations
stay unneeded.

## Rules

- Nothing but `TimeControl` advances the clock or calls `world.Tick` in the page.
- Never call `world.Tick` with a time more than one interval past `master.time` in page code: step boundaries with
  `NextBoundaryTime`, or the master's backlog drop and the one-evolve assumption break.
- **New per-tick state in an owner joins its snapshot by itself; a new collaborator or constant field joins its
  `*_CAPTURE` wiring** (or the round-trip spec throws on its function). A new owner gets `Snapshot()` / `Restore()` and
  a round trip. Coming with T2b: new per-tick state in the director joins `CaptureSim`; a new live lever joins the
  journaled tools; journaled handlers do their work synchronously.
- Never keep a park or a ship's curves across frames outside `DestinyWorld`: a Restore replaces them.

## Evidence

- verify-page `--only time:` (headless, 2026-10-23, dbxpc): pause held tick 8 for 2 s with identical positions and
  play resumed; 4× gave +20 ticks in ~5 s with an orbit at 2065–2382 m on a 2000 m range and fleet members
  `in-formation` / `catching-up`; 0.25× gave +1 tick and +1.00 scene s in 4 s; rate 0.5 and pause survived a load.
- Not yet checked on the real GPU (T3 does: fps and `gpuErrors` at 4× and 0.25×, turret firing effects on Blue's
  real-time clock in slow motion and pause).
