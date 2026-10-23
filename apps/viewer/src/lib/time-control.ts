/**
 * Time control on the scene clock (sd-time): pause, slow motion, fast-forward, and jumps back. Each animation frame asks the clock
 * for its target (SceneClock.Next: the real frame time at the rate), then steps the Destiny parks to it one tick
 * boundary at a time, setting the clock at each boundary first. So every pending order, Follow the FC steering, module
 * cycle, lock and combat roll runs at exactly the time it does at 1×, however fast the scene runs: fast-forward never
 * jumps the clock. A frame that runs out of its step budget leaves the clock at the last boundary it stepped and the
 * next frame steps on from there; Report gives the rate actually kept.
 *
 * The frame drivers (main.ts) still run once per frame, at the frame's final time: at 4× the shots and moments of the
 * frame's ticks draw together.
 *
 * Jumps (T2b): once the scene is settled (every lookup answered, every build done: the deterministic start) a snapshot of
 * the whole simulation (the sim port's Capture) is kept every few seconds in a ring bounded by a window and a byte
 * budget, and the live commands (the tape) are journaled with their tick. A jump restores the latest snapshot at least
 * WARMUP_TICKS before the target, re-simulates silently tick by tick to it (the tape replaying at its boundaries,
 * before the timeline's cues), warms the ClientBalls over the last ticks and lands. The recorded future replays as play
 * goes on, checked against the snapshots it passes (drift); a new live command drops it. Anything that would make a
 * replay differ (an edit, a load, an async lookup landing) cuts the window (Cut).
 *
 * Node-tested (time-control.spec.ts): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  AUDIBLE_MAX_RATE,
  DEFAULT_SNAPSHOT_EVERY_SECONDS,
  DEFAULT_TIME_BUDGET_MB,
  DEFAULT_TIME_WINDOW_SECONDS,
  MAX_SEEK_AHEAD_SECONDS,
  MAX_SNAPSHOT_EVERY_SECONDS,
  MAX_TIME_RATE,
  MIN_TIME_RATE,
  isTimeRate,
  type TimeAudioState,
  type TimeControlCommand,
  type TimeDriftReport,
  type TimeJumpReport,
  type TimeRecordingReport,
  type TimeReplayReport,
  type TimeReport,
  type TimeSeek,
  type TimeWaitingReport,
  type TimeWindowReport
} from '@scene-director/scene';
import { CLOCK_EPOCH_TICKS, MAX_FRAME_STEP_MS, TICKS_PER_MS, TICKS_PER_SECOND, type SceneClock } from './clock';
import type { DestinyWorld } from './destiny';
import { WARMUP_SAMPLES_PER_TICK, WARMUP_TICKS } from './destiny-snapshot';
import { CloneState } from './state-capture';

/**
 * The most real time one frame spends stepping ticks. Past it the clock waits at the last boundary stepped.
 */
export const FRAME_STEP_BUDGET_MS = 40;
/**
 * How much real time the effective rate is measured over.
 */
export const EFFECTIVE_RATE_WINDOW_MS = 1000;
/**
 * Below this share of the asked rate, Report gives the effective rate.
 */
export const BEHIND_SHARE = 0.95;
/**
 * A snapshot capture slower than this doubles the spacing (reported in window.every).
 */
export const CAPTURE_SLOW_MS = 15;

/**
 * What the page's presentation does with the clock's state: the AudioContext suspends while paused, and the sounds
 * mute above AUDIBLE_MAX_RATE.
 */
export interface TimePresentation {
  readonly paused: boolean;
  readonly muted: boolean;
}

/**
 * The page side of time control (the Director attaches it once it exists).
 */
export interface TimeControlPort {
  /**
   * Called on attach and whenever pause or the muting changes.
   */
  Presentation(presentation: TimePresentation): void;
}

/**
 * A live command on the tape: a journaled tool call, with the world tick and clock it was made at.
 */
export interface TapeEntry {
  readonly seq: number;
  /**
   * The world tick when it was made: it replays at that tick's boundary, before the timeline's cues.
   */
  readonly tick: number;
  /**
   * The scene clock when it was made (100 ns ticks): a jump landing after it inside its tick runs it at once.
   */
  readonly clock: number;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * Whether it has run in the current timeline of events (false for the recorded future after a jump back).
   */
  done: boolean;
}

/**
 * Where a journaled call starts (TimeControl.Mark): Record drops the entry when a cut happened in between.
 */
export interface TapeMark {
  readonly tick: number;
  readonly clock: number;
  readonly epoch: number;
}

/**
 * The simulation state the sim port captured, and its estimated size.
 */
export interface CapturedSim {
  readonly state: unknown;
  readonly bytes: number;
}

/**
 * One snapshot in the ring, taken right after the evolve that made `tick` (the clock on that boundary).
 */
export interface TimeSnapshot extends CapturedSim {
  readonly tick: number;
  readonly clock: number;
}

/**
 * Whether the scene is settled (the deterministic start), and what it waits for.
 */
export interface SimSettled {
  readonly settled: boolean;
  readonly waiting: TimeWaitingReport;
}

/**
 * What a jump hands the page when it lands (EndJump).
 */
export interface JumpLanding {
  /**
   * The clock before and after, 100 ns ticks; delta = to − from (0 when a failed jump put the scene back).
   */
  readonly from: number;
  readonly to: number;
  readonly delta: number;
  readonly failed?: true;
}

/**
 * The simulation side of time control (the Director): capture, restore, the tape's replay and the jump's
 * presentation. Every method runs synchronously.
 */
export interface TimeSimPort {
  /**
   * The whole simulation between ticks (Director.CaptureSim), plain data the page never mutates afterwards.
   */
  Capture(): CapturedSim;
  /**
   * Puts a captured state back (Director.RestoreSim). Throws when it cannot; the jump then restores its undo point.
   */
  Restore(state: unknown): void;
  /**
   * Whether the scene is settled: recording starts at the first settled boundary.
   */
  Settled(): SimSettled;
  /**
   * Compares a recorded snapshot's state with a fresh capture at the same tick.
   *
   * @returns Null when equal, else a short summary of the first difference.
   */
  Drift(recorded: unknown, fresh: unknown): Maybe<string>;
  /**
   * Runs a tape entry's tool now (the unwrapped handler; synchronous).
   */
  Replay(entry: TapeEntry): void;
  /**
   * Before a jump restores: tears down transient effects, enters silent mode and mutes.
   */
  BeginJump(): void;
  /**
   * After each re-simulated tick: runs the headless frame drivers at the boundary time.
   */
  SilentFrame(now: number): void;
  /**
   * Samples every ship's curves at a time (the ClientBall warm-up).
   */
  WarmCurves(time: number): void;
  /**
   * After a jump lands (or a failed one put the scene back): re-attaches the presentation and leaves silent mode.
   */
  EndJump(landing: JumpLanding): void;
  /**
   * The scene clock of the scripted timeline's t = 0 (100 ns ticks), once it started; null without one (get_state
   * time.timeline, seek { timeline }).
   */
  TimelineOrigin?(): Maybe<number>;
}

/**
 * The window settings: snapshot spacing and how far back, scene seconds; the byte budget.
 */
export interface TimeWindowConfig {
  readonly every?: number;
  readonly window?: number;
  readonly budgetBytes?: number;
}

export interface TimeControlConfig {
  readonly clock: SceneClock;
  readonly world: Pick<DestinyWorld, 'Tick' | 'NextBoundaryTime' | 'tick' | 'OnBeforeBoundary' | 'master'>;
  /**
   * Real time in milliseconds, for the step budget (default performance.now).
   */
  readonly realNow?: () => number;
  /**
   * The step budget, ms (default FRAME_STEP_BUDGET_MS).
   */
  readonly budgetMs?: number;
  readonly windowConfig?: TimeWindowConfig;
}

interface RecordingState {
  readonly on: boolean;
  /**
   * The tick and clock recording started at; snapshots fall every `every` ticks from it.
   */
  readonly startTick?: number;
  readonly since?: number;
}

export class TimeControl {
  private readonly clock: SceneClock;
  private readonly world: TimeControlConfig['world'];
  private readonly realNow: () => number;
  private readonly budgetMs: number;
  private port: Maybe<TimeControlPort> = null;
  private presented = '';
  private tickError: Maybe<string> = null;
  private lastFrameMs: Maybe<number> = null;
  private windowReal = 0;
  private windowScene = 0;
  private measured: Maybe<number> = null;
  private sim: Maybe<TimeSimPort> = null;
  private snapshots: TimeSnapshot[] = [];
  private tape: TapeEntry[] = [];
  private seq = 0;
  /**
   * Bumped by every Cut: a journaled call that saw a cut is not recorded.
   */
  private epoch = 0;
  private recording: RecordingState = { on: false };
  private cut: Maybe<{ readonly why: string; readonly at: number }> = null;
  /**
   * The furthest clock reached in this recording (the recorded end); null while nothing is recorded.
   */
  private end: Maybe<number> = null;
  private everySeconds: number;
  /**
   * Doubles while captures run slow (CAPTURE_SLOW_MS); reset when every is set.
   */
  private everyScale = 1;
  private windowSeconds: number;
  private budgetBytes: number;
  private captureMs: Maybe<number> = null;
  private drift: { count: number; tick?: number; summary?: string } = { count: 0 };
  private lastJump: Maybe<TimeJumpReport> = null;
  private jumping = false;

  constructor({ clock, world, realNow = () => performance.now(), budgetMs = FRAME_STEP_BUDGET_MS, windowConfig = {} }: TimeControlConfig) {
    this.clock = clock;
    this.world = world;
    this.realNow = realNow;
    this.budgetMs = budgetMs;
    this.everySeconds = windowConfig.every ?? DEFAULT_SNAPSHOT_EVERY_SECONDS;
    this.windowSeconds = windowConfig.window ?? DEFAULT_TIME_WINDOW_SECONDS;
    this.budgetBytes = windowConfig.budgetBytes ?? DEFAULT_TIME_BUDGET_MB * 1024 * 1024;
    // The tape replays first at a boundary: registered before the timeline's cues (the Director comes later).
    world.OnBeforeBoundary((boundary) => this.ReplayAt(boundary));
  }

  get rate(): number {
    return this.clock.rate;
  }

  get paused(): boolean {
    return this.clock.paused;
  }

  /**
   * Whether the page's sounds are muted for the rate.
   */
  get muted(): boolean {
    return this.clock.rate > AUDIBLE_MAX_RATE;
  }

  /**
   * The rate kept over the last measured second, or null before one was measured, while paused or held.
   */
  get effectiveRate(): Maybe<number> {
    return this.measured;
  }

  /**
   * Attaches the page side and hands it the current presentation.
   *
   * @param port - The Director.
   */
  AttachPort(port: TimeControlPort): void {
    this.port = port;
    this.presented = '';
    this.Present();
  }

  /**
   * Attaches the simulation side: recording starts at the next settled boundary.
   *
   * @param sim - The Director.
   */
  AttachSim(sim: TimeSimPort): void {
    this.sim = sim;
  }

  /**
   * Whether a jump is re-simulating right now (the Director's silent mode follows its BeginJump / EndJump).
   */
  get isJumping(): boolean {
    return this.jumping;
  }

  /**
   * Whether snapshots are being taken.
   */
  get recordingOn(): boolean {
    return this.recording.on;
  }

  /**
   * Runs a time_control command in its order: the window settings, the jump, the rate, the pause.
   *
   * @param command - Validated (normalizeTimeControlCommand).
   * @returns Warnings (a clamped jump, a jump to now).
   * @throws {Error} When a jump is refused or fails (the scene is as it was), or the rate is out of bounds.
   */
  Command(command: TimeControlCommand): string[] {
    const warnings: string[] = [];
    if (command.every !== undefined || command.window !== undefined) this.Configure({ every: command.every, window: command.window });
    if (command.back !== undefined) warnings.push(...(this.Jump(this.clock.now - Math.round(command.back * TICKS_PER_SECOND)).warnings ?? []));
    else if (command.seek !== undefined) warnings.push(...(this.Jump(this.SeekTicks(command.seek)).warnings ?? []));
    if (command.rate !== undefined) this.SetRate(command.rate);
    if (command.pause !== undefined) this.Pause(command.pause);
    return warnings;
  }

  /**
   * A seek's scene clock: scene seconds, or timeline seconds from the timeline's t = 0.
   *
   * @throws {Error} For timeline seconds when no scripted timeline has started.
   */
  private SeekTicks(seek: TimeSeek): number {
    if (typeof seek === 'number') return SceneTicks(seek);
    const origin = this.sim?.TimelineOrigin?.() ?? null;
    if (origin == null) throw new Error('seek { timeline } needs a scripted timeline that has started (get_state time.timeline); give seek scene seconds instead');
    return origin + Math.round(seek.timeline * TICKS_PER_SECOND);
  }

  /**
   * Sets the snapshot spacing and the window (scene seconds), then trims the ring.
   */
  Configure({ every, window, budgetBytes }: TimeWindowConfig): void {
    if (every !== undefined) {
      this.everySeconds = every;
      this.everyScale = 1;
    }
    if (window !== undefined) this.windowSeconds = window;
    if (budgetBytes !== undefined) this.budgetBytes = budgetBytes;
    this.Trim();
  }

  /**
   * Drops the window (every snapshot and the tape): recording waits until the scene settles again. Called on a load,
   * a simulation-changing edit and an async lookup or build landing.
   *
   * @param why - Named in get_state time.recording.why.
   */
  Cut(why: string): void {
    this.snapshots = [];
    this.tape = [];
    this.recording = { on: false };
    this.cut = { why, at: this.clock.now };
    this.end = null;
    this.drift = { count: 0 };
    this.epoch += 1;
  }

  /**
   * Where a journaled live call starts: pass it to Record once the call succeeded.
   */
  Mark(): TapeMark {
    return { tick: this.world.tick, clock: this.clock.now, epoch: this.epoch };
  }

  /**
   * Journals a live command that succeeded. A new command abandons the recorded future: the tape entries not run yet
   * and the snapshots after now go. Nothing is recorded while recording is off, during a jump, or when the window was
   * cut during the call (an order_fleet document order).
   *
   * @param mark - From Mark, taken before the call.
   * @param tool - The tool name.
   * @param args - Its arguments (copied).
   */
  Record(mark: TapeMark, tool: string, args: Readonly<Record<string, unknown>>): void {
    if (!this.recording.on || this.jumping || mark.epoch !== this.epoch) return;
    this.tape = this.tape.filter((entry) => entry.done);
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.tick <= this.world.tick);
    this.end = this.clock.now;
    this.seq += 1;
    this.tape.push({ seq: this.seq, tick: mark.tick, clock: mark.clock, tool, args: CloneState(args), done: true });
  }

  /**
   * Jumps the simulation to a scene time inside the recorded window, or forward past it: restores the latest snapshot
   * at least WARMUP_TICKS before the target, re-simulates silently to it (the tape replaying), warms the curves over the
   * last ticks and lands. One synchronous task. A failure puts the scene back as it was and throws.
   *
   * @param target - The scene clock to land at, 100 ns ticks.
   * @returns The jump's report (also get_state time.jump).
   * @throws {Error} When refused (another jump, the timeline holding the clock, nothing recorded) or failed.
   */
  Jump(target: number): TimeJumpReport {
    const sim = this.sim;
    if (!sim) throw new Error('time control is not attached yet: the page is still starting');
    if (this.jumping) throw new Error('a jump is already running');
    if (this.clock.held) throw new Error('the timeline holds the clock while its scene prepares: jump once it plays');
    const first = this.snapshots[0];
    if (!first) throw new Error(`nothing is recorded yet: ${this.NotRecordingText()}`);
    const warnings: string[] = [];
    const before = this.clock.now;
    const interval = this.IntervalTicks();
    let goal = Math.round(target);
    if (goal < first.clock) {
      warnings.push(`only ${SecondsText(before - first.clock)} s is recorded: jumped back to ${SecondsText(first.clock - CLOCK_EPOCH_TICKS)} s`);
      goal = first.clock;
    }
    const ahead = this.RecordedEnd() + MAX_SEEK_AHEAD_SECONDS * TICKS_PER_SECOND;
    if (goal > ahead) {
      warnings.push(`a seek goes at most ${MAX_SEEK_AHEAD_SECONDS} s past the recorded end: landed at ${SecondsText(ahead - CLOCK_EPOCH_TICKS)} s`);
      goal = ahead;
    }
    if (goal === before) {
      this.lastJump = { from: SceneSeconds(before), to: SceneSeconds(goal), snapshot: this.world.tick, resimulated: 0, ms: 0, warnings: [...warnings, 'already there: nothing to do'] };
      return this.lastJump;
    }
    // The tick the world is at when the clock reads goal: snapshots sit on the tick grid.
    const landingTick = first.tick + Math.floor((goal - first.clock) / interval);
    const restore = [...this.snapshots].reverse().find((snapshot) => snapshot.tick <= landingTick - WARMUP_TICKS) ?? first;
    // Forward from now needs no restore when no snapshot is closer to the target.
    const fromNow = before <= goal && this.world.tick >= restore.tick;
    const undo = sim.Capture();
    const ring = [...this.snapshots];
    const done = this.tape.map((entry) => entry.done);
    const recording = this.recording;
    const end = this.end;
    const start = this.realNow();
    this.jumping = true;
    this.ResetMeasure();
    let startTick = this.world.tick;
    let floor = before;
    try {
      sim.BeginJump();
      if (!fromNow) {
        sim.Restore(restore.state);
        this.clock.Set(restore.clock);
        startTick = restore.tick;
        floor = restore.clock;
        for (const entry of this.tape) if (entry.tick >= restore.tick) entry.done = false;
      }
      while (this.world.tick < landingTick) {
        const boundary = this.world.NextBoundaryTime();
        if (boundary == null) throw new Error('the world has not ticked yet');
        if (this.world.tick >= landingTick - WARMUP_TICKS) this.Warm(sim, Math.max(boundary - interval, floor), boundary);
        this.clock.Set(boundary);
        this.world.Tick(boundary);
        this.AfterTick(true);
        sim.SilentFrame(boundary);
      }
      const last = Number(this.world.master.time);
      if (goal > last) this.Warm(sim, Math.max(last, floor), goal);
      this.clock.Set(goal);
      this.world.Tick(goal);
      // Commands made in the landing tick before the target were in the past at it.
      for (const entry of this.tape) if (entry.tick === landingTick && !entry.done && entry.clock <= goal) this.RunEntry(entry);
    } catch (error) {
      try {
        sim.Restore(undo.state);
      } catch (undoError) {
        console.error('time control: the undo point did not restore', undoError);
      }
      this.clock.Set(before);
      this.snapshots = ring;
      for (const [i, entry] of this.tape.entries()) entry.done = done[i] ?? entry.done;
      this.recording = recording;
      this.end = end;
      this.jumping = false;
      sim.EndJump({ from: before, to: before, delta: 0, failed: true });
      throw new Error(`the jump failed and the scene is as it was: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    this.jumping = false;
    if (this.recording.on) this.end = Math.max(this.end ?? goal, goal);
    sim.EndJump({ from: before, to: goal, delta: goal - before });
    this.lastJump = {
      from: SceneSeconds(before),
      to: SceneSeconds(goal),
      snapshot: fromNow ? startTick : restore.tick,
      resimulated: landingTick - startTick,
      ms: Math.round((this.realNow() - start) * 10) / 10,
      ...(warnings.length ? { warnings } : {})
    };
    return this.lastJump;
  }

  /**
   * One animation frame: steps every tick boundary up to the frame's target, setting the clock at each, then sets the
   * clock to the target. A world.Tick failure is logged once per distinct message and ends the frame's stepping.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The clock's time after the frame, in 100 ns ticks: what the frame draws at.
   */
  Frame(frameMs: number): number {
    if (this.jumping) return this.clock.now;
    const before = this.clock.now;
    const target = this.clock.Next(frameMs);
    const start = this.realNow();
    try {
      for (;;) {
        const boundary = this.world.NextBoundaryTime();
        if (boundary == null || boundary > target) {
          // Before the first evolve this Tick anchors the tick grid at the clock (the page's first frame).
          this.clock.Set(target);
          this.world.Tick(target);
          break;
        }
        this.clock.Set(boundary);
        this.world.Tick(boundary);
        this.Recorded();
        // Behind: the clock waits at this boundary and the next frame steps on from it.
        if (this.realNow() - start > this.budgetMs) break;
      }
      this.tickError = null;
    } catch (error) {
      // A failed tick must not end the loop; log each distinct failure once.
      const message = error instanceof Error ? error.message : String(error);
      if (this.tickError !== message) console.error(`destiny tick failed: ${message}\n${(error as Maybe<Error>)?.stack ?? ''}`);
      this.tickError = message;
    }
    if (this.recording.on) this.end = Math.max(this.end ?? this.clock.now, this.clock.now);
    this.Measure(frameMs, this.clock.now - before);
    return this.clock.now;
  }

  /**
   * Pauses or plays. Paused, no tick runs; the frames go on drawing at the frozen time.
   *
   * @param paused - True pauses.
   */
  Pause(paused: boolean): void {
    this.clock.paused = paused;
    this.ResetMeasure();
    this.Present();
  }

  /**
   * Sets the clock's rate.
   *
   * @param rate - Scene time per real time, MIN_TIME_RATE to MAX_TIME_RATE.
   * @throws {RangeError} When the rate is out of bounds.
   */
  SetRate(rate: number): void {
    if (!isTimeRate(rate)) throw new RangeError(`the rate must be from ${MIN_TIME_RATE} to ${MAX_TIME_RATE}, not ${rate}`);
    this.clock.rate = rate;
    this.ResetMeasure();
    this.Present();
  }

  /**
   * get_state's `time`.
   */
  Report(): TimeReport {
    const rate = this.clock.rate;
    const paused = this.clock.paused;
    const effective = this.measured;
    const behind = !paused && !this.clock.held && effective != null && effective < BEHIND_SHARE * rate;
    let audio: Maybe<TimeAudioState> = null;
    if (paused) audio = 'suspended';
    else if (this.muted) audio = 'muted';
    const first = this.snapshots[0];
    const now = this.clock.now;
    const replay = this.ReplayReport();
    const origin = this.sim?.TimelineOrigin?.() ?? null;
    return {
      seconds: Math.round(this.clock.seconds * 100) / 100,
      tick: this.world.tick,
      rate,
      paused,
      state: this.jumping ? 'jumping' : paused ? 'paused' : 'playing',
      ...(origin == null ? {} : { timeline: Round2((now - origin) / TICKS_PER_SECOND) }),
      ...(behind ? { effectiveRate: Math.round(effective * 100) / 100 } : {}),
      ...(this.clock.held ? { held: true as const } : {}),
      ...(audio ? { audio } : {}),
      back: first ? Math.max(0, Round2((now - first.clock) / TICKS_PER_SECOND)) : 0,
      ...(first ? { earliest: SceneSeconds(first.clock), latest: SceneSeconds(this.RecordedEnd()) } : {}),
      window: this.WindowReport(),
      recording: this.RecordingReport(),
      ...(replay ? { replay } : {}),
      ...(this.drift.count ? { drift: { ...this.drift } as TimeDriftReport } : {}),
      ...(this.lastJump ? { jump: this.lastJump } : {})
    };
  }

  /**
   * The snapshots kept, oldest first (the specs and verify-page evidence).
   */
  get ring(): readonly TimeSnapshot[] {
    return this.snapshots;
  }

  /**
   * The tape, in order.
   */
  get journal(): readonly TapeEntry[] {
    return this.tape;
  }

  private WindowReport(): TimeWindowReport {
    const first = this.snapshots[0];
    const last = this.snapshots.at(-1);
    return {
      seconds: first && last ? Round2((last.clock - first.clock) / TICKS_PER_SECOND) : 0,
      every: this.SpacingSeconds(),
      window: this.windowSeconds,
      snapshots: this.snapshots.length,
      bytes: this.Bytes(),
      budget: this.budgetBytes,
      ...(this.captureMs != null ? { capture: Round2(this.captureMs) } : {})
    };
  }

  private RecordingReport(): TimeRecordingReport {
    const cut = this.cut ? { why: this.cut.why, cutAt: SceneSeconds(this.cut.at) } : {};
    if (this.recording.on) return { on: true, since: SceneSeconds(this.recording.since ?? this.clock.now), ...cut };
    const settled = this.sim?.Settled();
    const waiting = settled ? Object.fromEntries(Object.entries(settled.waiting).filter(([, count]) => count > 0)) : null;
    return { on: false, ...cut, ...(waiting && Object.keys(waiting).length ? { waiting } : {}) };
  }

  private ReplayReport(): Maybe<TimeReplayReport> {
    const ahead = this.tape.filter((entry) => !entry.done);
    if (!ahead.length) return null;
    const next = ahead[0];
    return { pending: ahead.length, next: { tool: next.tool, seconds: SceneSeconds(next.clock) } };
  }

  private NotRecordingText(): string {
    if (!this.sim) return 'the page is still starting';
    const report = this.RecordingReport();
    const waiting = report.waiting ? Object.entries(report.waiting).map(([kind, count]) => `${count} ${kind}`) : [];
    const parts = [report.why ? `the window was cut (${report.why})` : null, waiting.length ? `the scene is settling (waiting for ${waiting.join(', ')})` : 'recording starts at the next tick'];
    return parts.filter(Boolean).join('; ');
  }

  /**
   * AfterTick for the frame loop: a snapshot that fails (a runtime object in an owner, say) cuts the window and is
   * logged once; it never stops the simulation.
   */
  private Recorded(): void {
    try {
      this.AfterTick(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`time control: a snapshot failed, recording stops until the scene settles again: ${message}`);
      this.Cut(`a snapshot failed: ${message}`);
    }
  }

  /**
   * After every evolved tick: starts recording at the first settled boundary, takes a snapshot every `every` ticks, and
   * while a replay passes a recorded snapshot compares itself with it (drift).
   *
   * @param resimulating - True inside a jump: no settle check, no drift check (recorded snapshots are kept).
   */
  private AfterTick(resimulating: boolean): void {
    const sim = this.sim;
    if (!sim) return;
    const tick = this.world.tick;
    if (!this.recording.on) {
      if (resimulating || !sim.Settled().settled) return;
      this.recording = { on: true, startTick: tick, since: this.clock.now };
      this.end = this.clock.now;
      this.Take(sim, tick);
      return;
    }
    const recorded = this.snapshots.find((snapshot) => snapshot.tick === tick);
    if (recorded) {
      if (!resimulating) this.CheckDrift(sim, recorded);
      return;
    }
    if ((tick - (this.recording.startTick ?? tick)) % this.EveryTicks() !== 0) return;
    if (!resimulating) {
      const settled = sim.Settled();
      if (!settled.settled) {
        const waiting = Object.entries(settled.waiting)
          .filter(([, count]) => count > 0)
          .map(([kind, count]) => `${count} ${kind}`);
        this.Cut(`the scene stopped being settled (waiting for ${waiting.join(', ') || 'something'})`);
        return;
      }
    }
    this.Take(sim, tick);
  }

  private Take(sim: TimeSimPort, tick: number): void {
    const start = this.realNow();
    const captured = sim.Capture();
    this.captureMs = this.realNow() - start;
    if (this.captureMs > CAPTURE_SLOW_MS && this.SpacingSeconds() * 2 <= MAX_SNAPSHOT_EVERY_SECONDS) this.everyScale *= 2;
    const snapshot: TimeSnapshot = { tick, clock: this.clock.now, state: captured.state, bytes: captured.bytes };
    const at = this.snapshots.findIndex((candidate) => candidate.tick > tick);
    if (at < 0) this.snapshots.push(snapshot);
    else this.snapshots.splice(at, 0, snapshot);
    this.Trim();
  }

  private CheckDrift(sim: TimeSimPort, recorded: TimeSnapshot): void {
    const fresh = sim.Capture();
    const summary = sim.Drift(recorded.state, fresh.state);
    if (summary == null) return;
    this.Drifted(recorded.tick, summary);
    // The replay is the truth now: its snapshot replaces the recorded one, and the later ones belong to the abandoned run.
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.tick < recorded.tick);
    this.snapshots.push({ tick: recorded.tick, clock: recorded.clock, state: fresh.state, bytes: fresh.bytes });
  }

  private Drifted(tick: number, summary: string): void {
    if (!this.drift.count) this.drift = { count: 0, tick, summary };
    this.drift.count += 1;
    console.warn(`time control: the replay drifted at tick ${tick}: ${summary}`);
  }

  /**
   * Drops snapshots older than the window before the latest, then the oldest past the byte budget (one always stays),
   * then the tape before the earliest snapshot.
   */
  private Trim(): void {
    const last = this.snapshots.at(-1);
    if (!last) return;
    const oldest = last.clock - this.windowSeconds * TICKS_PER_SECOND;
    let drop = 0;
    while (drop < this.snapshots.length - 1 && this.snapshots[drop].clock < oldest) drop += 1;
    let bytes = this.Bytes();
    for (let i = 0; i < drop; i++) bytes -= this.snapshots[i].bytes;
    while (drop < this.snapshots.length - 1 && bytes > this.budgetBytes) {
      bytes -= this.snapshots[drop].bytes;
      drop += 1;
    }
    if (drop) this.snapshots = this.snapshots.slice(drop);
    const earliest = this.snapshots[0].tick;
    this.tape = this.tape.filter((entry) => entry.tick >= earliest);
  }

  /**
   * The tape's replay at a boundary (OnBeforeBoundary, before the timeline's cues): every entry of this tick not run
   * yet runs and is marked run. During live play every entry is already run; after a jump back the recorded future is
   * not.
   */
  private ReplayAt(boundary: number): void {
    if (!this.sim || !this.tape.length) return;
    for (const entry of this.tape) if (entry.tick === boundary && !entry.done) this.RunEntry(entry);
  }

  private RunEntry(entry: TapeEntry): void {
    entry.done = true;
    try {
      this.sim?.Replay(entry);
    } catch (error) {
      this.Drifted(this.world.tick, `${entry.tool} failed on replay: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private Warm(sim: TimeSimPort, from: number, to: number): void {
    const step = this.IntervalTicks() / WARMUP_SAMPLES_PER_TICK;
    for (let time = from + step; time <= to + 0.5; time += step) sim.WarmCurves(Math.round(time));
  }

  private RecordedEnd(): number {
    return Math.max(this.end ?? this.clock.now, this.snapshots.at(-1)?.clock ?? 0);
  }

  private Bytes(): number {
    return this.snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  }

  private IntervalTicks(): number {
    return this.world.master.tickInterval * TICKS_PER_MS;
  }

  private SpacingSeconds(): number {
    return Math.min(this.everySeconds * this.everyScale, MAX_SNAPSHOT_EVERY_SECONDS);
  }

  private EveryTicks(): number {
    return Math.max(1, Math.round((this.SpacingSeconds() * 1000) / this.world.master.tickInterval));
  }

  private Present(): void {
    const presentation: TimePresentation = { paused: this.clock.paused, muted: this.muted };
    const key = `${presentation.paused}:${presentation.muted}`;
    if (!this.port || key === this.presented) return;
    this.presented = key;
    this.port.Presentation(presentation);
  }

  private Measure(frameMs: number, sceneTicks: number): void {
    const last = this.lastFrameMs;
    if (Number.isFinite(frameMs)) this.lastFrameMs = frameMs;
    if (typeof last !== 'number' || !Number.isFinite(frameMs) || this.clock.paused || this.clock.held) {
      if (this.clock.paused || this.clock.held) this.ResetMeasure();
      return;
    }
    this.windowReal += Math.min(Math.max(frameMs - last, 0), MAX_FRAME_STEP_MS);
    this.windowScene += sceneTicks;
    if (this.windowReal >= EFFECTIVE_RATE_WINDOW_MS) {
      this.measured = this.windowScene / (this.windowReal * TICKS_PER_MS);
      this.windowReal = 0;
      this.windowScene = 0;
    }
  }

  private ResetMeasure(): void {
    this.windowReal = 0;
    this.windowScene = 0;
    this.measured = null;
  }
}

/**
 * A rate as the HUD and messages write it.
 *
 * @param rate - Scene time per real time.
 * @returns Such as "4×", "0.25×" or "0.0625×".
 */
export function RateText(rate: number): string {
  return `${Number(rate.toFixed(4))}×`;
}

/**
 * The overlay's time row.
 *
 * @param report - TimeControl.Report.
 * @returns Such as "1×", "paused at 0.25×" or "4× (2.7× actual) · muted".
 */
export function TimeText(report: TimeReport): string {
  let text = report.paused ? `paused at ${RateText(report.rate)}` : RateText(report.rate);
  if (report.effectiveRate != null) text += ` (${RateText(report.effectiveRate)} actual)`;
  if (report.held) text += ' · held for the timeline';
  if (report.audio === 'muted') text += ' · muted';
  if (report.back > 0) text += ` · back ${Math.floor(report.back)} s`;
  if (report.latest != null && report.latest - report.seconds >= 1) text += ` · ${Math.floor(report.latest - report.seconds)} s recorded ahead`;
  else if (!report.recording.on && report.recording.waiting)
    text += ` · recording waits: ${Object.entries(report.recording.waiting)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')}`;
  return text;
}

/**
 * Scene seconds (get_state time.seconds) at a clock time.
 *
 * @param ticks - The clock, 100 ns ticks.
 */
export function SceneSeconds(ticks: number): number {
  return Round2((ticks - CLOCK_EPOCH_TICKS) / TICKS_PER_SECOND);
}

/**
 * The clock time at scene seconds.
 *
 * @param seconds - get_state time.seconds.
 * @returns 100 ns ticks.
 */
export function SceneTicks(seconds: number): number {
  return CLOCK_EPOCH_TICKS + Math.round(seconds * TICKS_PER_SECOND);
}

function Round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function SecondsText(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(1);
}
