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
 * Script edits (Movie mode M3): a timeline starting pins its origin (MarkOrigin), a snapshot before t = 0 that trimming
 * never drops, and an edit of the cues or ships' orders that changes the past re-simulates from the latest snapshot it
 * does not affect (Resimulate, over the same Run as a jump) instead of cutting the window.
 *
 * Export (sd-export): a movie export moves the clock only through FrameTo, one drawn frame at a time to an exact target
 * (T0 + i / fps), stepping every boundary on the way with no step budget and no StopAt, so the file's frames sit on a
 * fixed grid however slowly the page draws. Between BeginExport and EndExport the user's time controls (Command, Jump,
 * Resimulate, Pause, SetRate) are refused and Frame steps nothing; recording goes on, so the exported run stays
 * scrubbable.
 *
 * The frame lock (time_control { fps }): the clock moves on a 1/fps grid instead (LockedFrame over a FrameLock): a drawn
 * frame steps exactly one grid frame once real time × rate has reached it, never two, and a slow spell is never paid
 * back, so a heavy scene slows down smoothly instead of skipping ahead. Stops are keyed (StopAt's slot: the movie's end,
 * a beat), and a beat (PlayFor, time_control { play }) plays N scene seconds then pauses, telling its caller how it ended.
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
  MAX_EXPORT_FPS,
  MIN_EXPORT_FPS,
  isTimeRate,
  type TimeAudioState,
  type TimeControlCommand,
  type TimeDriftReport,
  type TimeJumpReport,
  type TimeLockSource,
  type TimePlayEnd,
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
import { FrameLock } from './frame-lock';
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
 * The refusal of the user's time controls while a movie export drives the clock (sd-export).
 */
export const EXPORT_LOCKED_TEXT = 'a movie export is running: export_movie { action: "cancel" } stops it';
/**
 * How long the page's time_control { play } waits for its beat to end before it answers with the beat still armed:
 * well under the hub's 600 s timeout for slow tools.
 */
export const PLAY_WAIT_LIMIT_MS = 240_000;
/**
 * The refusal of a time jump or a lock change while a live recording holds the clock (sd-export → Live recording).
 */
export const RECORD_LOCKED_TEXT = 'a live recording is running and this would cut the video (time jumps and the frame lock are refused): record_movie { action: "stop" } ends it';
/**
 * StopAt's slots: the movie's end (the default), and a beat's (PlayFor).
 */
export const MOVIE_STOP_SLOT = 'movie';
export const PLAY_STOP_SLOT = 'play';

/**
 * A frame under the frame lock (LockedFrame): wait (no grid frame is due: draw nothing), hold (paused, held, a tick
 * failed or an off-grid stop: draw at the clock) or grid (the next grid frame, `index` from the lock's anchor).
 */
export type LockedFrameResult = { readonly kind: 'wait' | 'hold'; readonly clock: number } | { readonly kind: 'grid'; readonly clock: number; readonly index: number };

/**
 * How a beat (PlayFor) ended: why, the scene seconds it played, and the real seconds it took.
 */
export interface TimeBeatEnd {
  readonly endedBy: TimePlayEnd;
  readonly played: number;
  readonly wallSeconds: number;
}

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
  /**
   * The timeline's origin (MarkOrigin): the state before t = 0's boundary, never trimmed (a cut drops it).
   */
  readonly pinned?: true;
  /**
   * The origin's: the tape entries of its tick up to this seq were made before it was taken (its state holds them), so a
   * restore does not run them again.
   */
  readonly doneThrough?: number;
}

/**
 * What a script edit's re-simulation needs (Resimulate).
 */
export interface TimeResimulateOptions {
  /**
   * Whether a snapshot's state is still before the edit makes a difference (TimelinePlayer.Accepts).
   */
  readonly accept: (state: unknown) => boolean;
  /**
   * Called right after the snapshot is restored, before the re-simulation: the edited script goes in.
   */
  readonly restored: (state: unknown) => void;
  /**
   * How many cues and ships' orders the edit changed, for the report.
   */
  readonly edit?: { readonly cues: number; readonly ships: number };
}

/**
 * A script edit's re-simulation: the report (get_state time.jump, cause edit) and the snapshot it started from.
 */
export interface TimeResimulation {
  readonly report: TimeJumpReport;
  readonly snapshot: { readonly tick: number; readonly clock: number };
}

/**
 * One run of the jump machinery (TimeControl.Run).
 */
interface RunPlan {
  /**
   * The scene clock to land at, and the world tick there.
   */
  readonly goal: number;
  readonly landingTick: number;
  /**
   * The snapshot to restore, or null to simulate on from now.
   */
  readonly restore: Maybe<TimeSnapshot>;
  /**
   * After the restore, before the re-simulation.
   */
  readonly restored?: (state: unknown) => void;
  /**
   * Drop the snapshots after the restored one (a script edit: they hold the old script).
   */
  readonly dropAfter?: boolean;
  /**
   * The error's start: "the jump failed".
   */
  readonly failure: string;
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
   * After a jump or a re-simulation restored a snapshot (never the undo point): the restored state takes the script
   * edited since it was taken (Movie mode M3), so a jump back never undoes an edit of the cues or orders.
   */
  AfterRestore?(state: unknown): void;
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
  /**
   * Where the frame loop stops, by slot (Movie mode M5: a movie's end; a beat), and who to tell.
   */
  private readonly stops = new Map<string, { readonly clock: number; readonly onStop?: () => void }>();
  /**
   * The frame lock (time_control { fps }) and who set it.
   */
  private lock: Maybe<{ readonly pacer: FrameLock; readonly by: TimeLockSource }> = null;
  /**
   * The beat playing (PlayFor): its start clock, its stop, its caller and its real start.
   */
  private beat: Maybe<{ readonly from: number; readonly stop: number; readonly onEnd: (end: TimeBeatEnd) => void; readonly startMs: number }> = null;
  /**
   * Whether a movie export drives the clock (BeginExport to EndExport), and at how many frames a second.
   */
  private exportMode = false;
  private exportFps: Maybe<number> = null;
  /**
   * A live recording's hold on the clock (BeginRecording to EndRecording): the user's lock it replaced.
   */
  private recordHold: Maybe<{ readonly saved: TimeControl['lock'] }> = null;

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
   * Whether a movie export drives the clock (sd-export): only FrameTo moves it.
   */
  get exporting(): boolean {
    return this.exportMode;
  }

  /**
   * Whether a live recording holds the clock (BeginRecording to EndRecording): the record lock runs, jumps and lock
   * changes are refused.
   */
  get recordingMovie(): boolean {
    return this.recordHold != null;
  }

  /**
   * Whether snapshots are being taken.
   */
  get recordingOn(): boolean {
    return this.recording.on;
  }

  /**
   * Runs a time_control command in its order: the window settings, the jump, the rate, the frame lock, the pause. A beat
   * (`play`) needs its caller's callback: the director runs it after (PlayFor).
   *
   * @param command - Validated (normalizeTimeControlCommand).
   * @returns Warnings (a clamped jump, a jump to now).
   * @throws {Error} When a jump is refused or fails (the scene is as it was), or the rate is out of bounds.
   */
  Command(command: TimeControlCommand): string[] {
    this.Unlocked();
    if (this.recordHold && (command.back !== undefined || command.seek !== undefined || command.fps !== undefined)) throw new Error(RECORD_LOCKED_TEXT);
    const warnings: string[] = [];
    if (command.every !== undefined || command.window !== undefined) this.Configure({ every: command.every, window: command.window });
    if (command.back !== undefined) warnings.push(...(this.Jump(this.clock.now - Math.round(command.back * TICKS_PER_SECOND)).warnings ?? []));
    else if (command.seek !== undefined) warnings.push(...(this.Jump(this.SeekTicks(command.seek)).warnings ?? []));
    if (command.rate !== undefined) this.SetRate(command.rate);
    if (command.fps !== undefined) this.SetFrameLock(command.fps === false ? null : command.fps);
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
   * Pins the timeline's origin (Movie mode M3): a snapshot of the state before t = 0's boundary, taken when a timeline
   * starts playing (the director calls it), on the tick grid at the last evolve's clock like every snapshot. Recording
   * starts there when it is off and the scene is settled; when it is on, the recorded future goes (the timeline starting
   * changes it). Trim never drops the origin (its bytes count), a cut does, and a newer origin replaces it. So a script
   * edit can always re-simulate, from t = 0 at worst.
   *
   * @returns Whether the origin was taken (not before the first evolve, during a jump, or while the scene settles).
   */
  MarkOrigin(): boolean {
    const sim = this.sim;
    if (!sim || this.jumping || this.world.NextBoundaryTime() == null) return false;
    if (!this.recording.on && !sim.Settled().settled) return false;
    const tick = this.world.tick;
    if (this.recording.on) this.AbandonFuture();
    else {
      this.recording = { on: true, startTick: tick, since: this.clock.now };
      this.end = this.clock.now;
    }
    const captured = sim.Capture();
    const origin: TimeSnapshot = { tick, clock: Number(this.world.master.time), state: captured.state, bytes: captured.bytes, pinned: true, doneThrough: this.seq };
    this.snapshots = [origin, ...this.snapshots.filter((snapshot) => !snapshot.pinned && snapshot.tick !== tick)].sort((a, b) => a.tick - b.tick);
    this.Trim();
    return true;
  }

  /**
   * Drops the recorded future: the snapshots after now and the tape entries not run yet; the recorded end becomes now.
   * A new live command does it (Record), and so does a script edit (the future belongs to the old script).
   */
  AbandonFuture(): void {
    if (!this.recording.on) return;
    this.tape = this.tape.filter((entry) => entry.done);
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.tick <= this.world.tick);
    this.end = this.clock.now;
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
    this.AbandonFuture();
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
    const first = this.Ready();
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
      this.lastJump = { from: SceneSeconds(before), to: SceneSeconds(goal), snapshot: this.world.tick, resimulated: 0, ms: 0, cause: 'jump', warnings: [...warnings, 'already there: nothing to do'] };
      return this.lastJump;
    }
    // The tick the world is at when the clock reads goal: snapshots sit on the tick grid.
    const landingTick = first.tick + Math.floor((goal - first.clock) / interval);
    const restore = [...this.snapshots].reverse().find((snapshot) => snapshot.tick <= landingTick - WARMUP_TICKS) ?? first;
    // Forward from now needs no restore when no snapshot is closer to the target.
    const fromNow = before <= goal && this.world.tick >= restore.tick;
    const { startTick, ms } = this.Run({ goal, landingTick, restore: fromNow ? null : restore, failure: 'the jump failed' });
    this.lastJump = { from: SceneSeconds(before), to: SceneSeconds(goal), snapshot: startTick, resimulated: landingTick - startTick, ms, cause: 'jump', ...(warnings.length ? { warnings } : {}) };
    return this.lastJump;
  }

  /**
   * Re-simulates a script edit that changes the past (Movie mode M3): restores the latest snapshot whose state still
   * passes `accept` (at least WARMUP_TICKS before now when one is, the pinned origin included), drops the snapshots after
   * it, puts the edited script in (`restored`), and re-simulates silently back to now, the tape after it replaying at its
   * ticks and new snapshots taken on the way. One synchronous task, as a jump is; a failure puts the scene back and
   * throws.
   *
   * @param options - The divergence test, the script swap and the edit's counts.
   * @returns The report (get_state time.jump, cause edit) and the snapshot, or null when no snapshot passes.
   * @throws {Error} When refused (another jump, the timeline holding the clock, nothing recorded) or failed.
   */
  Resimulate({ accept, restored, edit }: TimeResimulateOptions): Maybe<TimeResimulation> {
    this.Ready();
    const tick = this.world.tick;
    let latest: Maybe<TimeSnapshot> = null;
    let chosen: Maybe<TimeSnapshot> = null;
    // The test is downward-closed: the first passing snapshot from the latest down is the latest that passes.
    for (const snapshot of [...this.snapshots].reverse()) {
      if (snapshot.tick >= tick || !accept(snapshot.state)) continue;
      latest ??= snapshot;
      if (snapshot.tick <= tick - WARMUP_TICKS) {
        chosen = snapshot;
        break;
      }
    }
    chosen ??= latest;
    if (!chosen) return null;
    const now = this.clock.now;
    const { startTick, ms } = this.Run({ goal: now, landingTick: tick, restore: chosen, restored, dropAfter: true, failure: 'the re-simulation failed' });
    this.lastJump = { from: SceneSeconds(now), to: SceneSeconds(now), snapshot: startTick, resimulated: tick - startTick, ms, cause: 'edit', ...(edit ? { edit } : {}) };
    return { report: this.lastJump, snapshot: { tick: chosen.tick, clock: chosen.clock } };
  }

  /**
   * The refusals a jump and a re-simulation share.
   *
   * @returns The earliest snapshot.
   * @throws {Error} Before the sim port is attached, during another jump, while the timeline holds the clock, and with
   *   nothing recorded.
   */
  private Ready(): TimeSnapshot {
    if (!this.sim) throw new Error('time control is not attached yet: the page is still starting');
    if (this.jumping) throw new Error('a jump is already running');
    this.Unlocked();
    if (this.recordHold) throw new Error(RECORD_LOCKED_TEXT);
    if (this.clock.held) throw new Error('the timeline holds the clock while its scene prepares: jump once it plays');
    const first = this.snapshots[0];
    if (!first) throw new Error(`nothing is recorded yet: ${this.NotRecordingText()}`);
    return first;
  }

  /**
   * The jump machinery (Jump, Resimulate): the undo point, BeginJump, the restore (or none: simulate on from now), the
   * silent re-simulation tick by tick to the landing tick with the warm-up over its last ticks, the landing and
   * EndJump. Any throw restores the undo point, the clock, the ring, the tape's done flags and the recording state.
   *
   * @returns The tick the re-simulation started from, and its real time.
   */
  private Run({ goal, landingTick, restore, restored, dropAfter = false, failure }: RunPlan): { startTick: number; ms: number } {
    const sim = this.sim;
    if (!sim) throw new Error('time control is not attached yet: the page is still starting');
    const before = this.clock.now;
    const interval = this.IntervalTicks();
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
      if (restore) {
        sim.Restore(restore.state);
        this.clock.Set(restore.clock);
        startTick = restore.tick;
        floor = restore.clock;
        for (const entry of this.tape) if (ReplaysAfter(entry, restore)) entry.done = false;
        if (dropAfter) this.snapshots = this.snapshots.filter((snapshot) => snapshot.tick <= restore.tick);
        sim.AfterRestore?.(restore.state);
        restored?.(restore.state);
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
      throw new Error(`${failure} and the scene is as it was: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    this.jumping = false;
    if (this.recording.on) this.end = Math.max(this.end ?? goal, goal);
    // The landing is the frame lock's new frame 0, drawn at once; a beat ends here.
    this.lock?.pacer.Anchor(goal);
    this.EndBeat('jump', before);
    sim.EndJump({ from: before, to: goal, delta: goal - before });
    return { startTick, ms: Math.round((this.realNow() - start) * 10) / 10 };
  }

  /**
   * One animation frame: steps every tick boundary up to the frame's target, setting the clock at each, then sets the
   * clock to the target. A world.Tick failure is logged once per distinct message and ends the frame's stepping.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The clock's time after the frame, in 100 ns ticks: what the frame draws at.
   */
  Frame(frameMs: number): number {
    if (this.jumping || this.exportMode) return this.clock.now;
    const before = this.clock.now;
    const stop = this.NextStop(before);
    let target = this.clock.Next(frameMs);
    const stopping = stop != null && target >= stop;
    if (stopping) target = stop;
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
      this.TickFailed(error);
    }
    if (this.recording.on) this.end = Math.max(this.end ?? this.clock.now, this.clock.now);
    this.Measure(frameMs, this.clock.now - before);
    // The stop's boundaries all ran (a frame behind its budget waits at an earlier one and goes on next frame).
    if (stopping && this.clock.now === stop) this.ReachStops();
    return this.clock.now;
  }

  /**
   * One animation frame under the frame lock (SetFrameLock): the frame's real time at the rate is added to what is due,
   * and once the next grid frame is due the clock steps every boundary to it (no step budget, as FrameTo). Never two
   * grid frames in one call, and a slow spell is never paid back. A stop inside the step stops there (an off-grid hold);
   * the next frame goes on from it to the grid clock, so a stop never shifts the grid. A failed tick is logged once (as
   * Frame does) and the clock waits at its boundary.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns wait (nothing due: draw nothing), hold (paused, held, a failed tick or a stop: draw at the clock) or grid.
   */
  LockedFrame(frameMs: number): LockedFrameResult {
    const before = this.clock.now;
    const lock = this.lock?.pacer;
    if (!lock || this.jumping || this.exportMode) return { kind: 'hold', clock: before };
    const stop = this.NextStop(before);
    const advance = this.clock.Next(frameMs) - before;
    if (this.clock.paused || this.clock.held) {
      this.Measure(frameMs, 0);
      return { kind: 'hold', clock: before };
    }
    // The grid never sits behind the clock (the anchor follows every jump); should it, it starts again from now.
    if (lock.NextClock() < before) lock.Anchor(before);
    lock.Advance(advance);
    if (!lock.IsDue()) {
      this.Measure(frameMs, 0, false);
      return { kind: 'wait', clock: before };
    }
    const goal = lock.NextClock();
    const target = stop != null && stop < goal ? stop : goal;
    try {
      this.StepTo(target);
      this.tickError = null;
    } catch (error) {
      this.TickFailed(error);
      this.Measure(frameMs, this.clock.now - before, false);
      return { kind: 'hold', clock: this.clock.now };
    }
    const reached = target === goal;
    if (reached) lock.Reached();
    // A window closes on a grid frame only, so it spans whole grid steps.
    this.Measure(frameMs, target - before, reached);
    if (stop != null && target >= stop) this.ReachStops();
    return reached ? { kind: 'grid', clock: goal, index: lock.frame } : { kind: 'hold', clock: target };
  }

  /**
   * Sets the frame lock (time_control { fps }), anchored at now, or takes it off. A viewing preference like the rate: it
   * lasts across loads.
   *
   * @param fps - Grid frames a scene second, an integer from MIN_EXPORT_FPS to MAX_EXPORT_FPS, or null to unlock.
   * @throws {RangeError} For an fps out of bounds.
   */
  SetFrameLock(fps: Maybe<number>): void {
    this.Unlocked();
    if (this.recordHold) throw new Error(RECORD_LOCKED_TEXT);
    if (fps != null && !(Number.isInteger(fps) && fps >= MIN_EXPORT_FPS && fps <= MAX_EXPORT_FPS)) throw new RangeError(`the frame lock must be an integer from ${MIN_EXPORT_FPS} to ${MAX_EXPORT_FPS} frames a second, not ${fps}`);
    this.lock = fps == null ? null : { pacer: new FrameLock(fps, this.clock.now), by: 'time_control' };
    this.ResetMeasure();
  }

  /**
   * The frame lock's frames a second, or null while the clock runs free (main.ts calls LockedFrame while it is set).
   */
  get frameLock(): Maybe<number> {
    return this.lock?.pacer.fps ?? null;
  }

  /**
   * Plays a beat (time_control { play }): unpauses, and pauses again exactly `seconds` of scene time from now (the play
   * stop slot). `onEnd` is called once, when the beat ends: at its stop (played), at any pause before it (the movie's
   * end, Space, time_control pause), at a jump or re-simulation landing, when a movie export begins, or when a new beat
   * replaces it. Every way out but its own stop clears that stop.
   *
   * @param seconds - Scene seconds, above 0.
   * @param onEnd - Told how the beat ended.
   * @throws {Error} During a jump or an export.
   */
  PlayFor(seconds: number, onEnd: (end: TimeBeatEnd) => void): void {
    this.Unlocked();
    if (this.jumping) throw new Error('a jump is running: play once it lands');
    if (!(seconds > 0)) throw new RangeError(`a beat plays above 0 scene seconds, not ${seconds}`);
    this.EndBeat('replaced');
    const from = this.clock.now;
    const stop = from + Math.round(seconds * TICKS_PER_SECOND);
    this.beat = { from, stop, onEnd, startMs: this.realNow() };
    this.StopAt(stop, undefined, PLAY_STOP_SLOT);
    this.Pause(false);
  }

  /**
   * Ends the beat, if one plays: its stop goes and its caller is told.
   *
   * @param why - How it ended.
   * @param at - The clock it ended at (a jump's: before it).
   */
  private EndBeat(why: TimePlayEnd, at = this.clock.now): void {
    const beat = this.beat;
    if (!beat) return;
    this.beat = null;
    this.stops.delete(PLAY_STOP_SLOT);
    beat.onEnd({ endedBy: why, played: Round2(Math.max(0, at - beat.from) / TICKS_PER_SECOND), wallSeconds: Round2((this.realNow() - beat.startMs) / 1000) });
  }

  /**
   * The earliest armed stop after now. A stop the clock already reached or passed (a jump past it, say) is dropped.
   *
   * @param now - The clock as the frame starts.
   */
  private NextStop(now: number): Maybe<number> {
    let next: Maybe<number> = null;
    for (const [slot, stop] of this.stops) {
      if (stop.clock <= now) {
        this.stops.delete(slot);
        if (slot === PLAY_STOP_SLOT) this.EndBeat('jump', now);
      } else if (next == null || stop.clock < next) next = stop.clock;
    }
    return next;
  }

  /**
   * The loop reached its earliest stop: every stop due now clears, the clock pauses (a beat whose stop it was ends
   * played, any other beat paused), then each stop's onStop runs.
   */
  private ReachStops(): void {
    const now = this.clock.now;
    const reached = [...this.stops].filter(([, stop]) => stop.clock <= now);
    for (const [slot] of reached) this.stops.delete(slot);
    this.clock.paused = true;
    this.ResetMeasure();
    this.Present();
    this.EndBeat(reached.some(([slot]) => slot === PLAY_STOP_SLOT) ? 'played' : 'paused');
    for (const [, stop] of reached) stop.onStop?.();
  }

  /**
   * Logs a failed tick once per distinct message: a failed tick must not end the loop.
   */
  private TickFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.tickError !== message) console.error(`destiny tick failed: ${message}\n${(error as Maybe<Error>)?.stack ?? ''}`);
    this.tickError = message;
  }

  /**
   * Hands the clock to a movie export (sd-export): from now until EndExport only FrameTo moves it, and the user's time
   * controls are refused (EXPORT_LOCKED_TEXT). The clock is unpaused (FrameTo ignores the pause, but the reports, the
   * audio port and the HUD read it).
   *
   * @param options - `fps`: the export's frames a second, for the report.
   * @throws {Error} During a jump, while the timeline holds the clock, and during another export.
   */
  BeginExport({ fps }: { readonly fps?: number } = {}): void {
    if (this.jumping) throw new Error('a jump is running: export once it lands');
    if (this.clock.held) throw new Error('the timeline holds the clock while its scene prepares: export once it plays');
    if (this.exportMode) throw new Error('a movie export is already running');
    if (this.recordHold) throw new Error('a live recording is running: record_movie { action: "stop" } ends it');
    this.EndBeat('export');
    this.exportMode = true;
    this.exportFps = fps ?? null;
    this.clock.paused = false;
    this.ResetMeasure();
    this.Present();
  }

  /**
   * One export frame (sd-export): steps every tick boundary up to the target, one evolve per world.Tick, setting the clock
   * at each, then sets the clock to the target. Unlike Frame there is no step budget (the frame lands on its target
   * however long the ticks take) and no StopAt. A throwing tick propagates: the clock waits at its boundary and the
   * exporter retries the frame at the same target.
   *
   * @param target - The frame's clock, 100 ns ticks (rounded): T0 + i / fps.
   * @returns The clock after the frame: the target.
   * @throws {Error} Outside an export, for a target before now, and when a tick throws.
   */
  FrameTo(target: number): number {
    if (!this.exportMode) throw new Error('FrameTo steps a movie export: BeginExport first');
    const goal = Math.round(target);
    if (goal < this.clock.now) throw new Error(`an export frame never goes back (to ${SecondsText(goal - CLOCK_EPOCH_TICKS)} s from ${SecondsText(this.clock.now - CLOCK_EPOCH_TICKS)} s)`);
    this.StepTo(goal);
    return this.clock.now;
  }

  /**
   * Steps every tick boundary up to a goal, one evolve per world.Tick, setting the clock at each, then sets the clock to
   * the goal: no step budget and no StopAt (FrameTo, LockedFrame). A throwing tick propagates, the clock waiting at its
   * boundary.
   *
   * @param goal - 100 ns ticks, at or after now.
   */
  private StepTo(goal: number): void {
    for (;;) {
      const boundary = this.world.NextBoundaryTime();
      if (boundary == null || boundary > goal) break;
      this.clock.Set(boundary);
      this.world.Tick(boundary);
      this.Recorded();
    }
    this.clock.Set(goal);
    this.world.Tick(goal);
    if (this.recording.on) this.end = Math.max(this.end ?? goal, goal);
  }

  /**
   * Gives the clock back after a movie export (sd-export): the user's time controls work again, the next live frame
   * targets now (SceneClock.Resync: the export's real time is not one long frame), and the clock pauses (by default)
   * at the last exported frame. Nothing outside an export.
   *
   * @param options - `pause`: pause at the end (default true).
   */
  EndExport({ pause = true }: { readonly pause?: boolean } = {}): void {
    if (!this.exportMode) return;
    this.exportMode = false;
    this.exportFps = null;
    this.clock.Resync();
    this.lastFrameMs = null;
    this.lock?.pacer.Anchor(this.clock.now);
    this.Pause(pause);
  }

  /**
   * Hands the clock to a live recording (sd-export → Live recording): the record lock at the file's fps, anchored at now
   * (the next frame targets now, so the time before is not one long frame). Until EndRecording, Jump, Resimulate,
   * Command back / seek / fps and SetFrameLock throw RECORD_LOCKED_TEXT; Pause, SetRate, StopAt and PlayFor still work.
   *
   * @param options - `fps`: the file's frames a second, the lock's grid.
   * @throws {Error} During a jump, an export or another recording.
   * @throws {RangeError} For an fps out of bounds.
   */
  BeginRecording({ fps }: { readonly fps: number }): void {
    if (this.jumping) throw new Error('a jump is running: record once it lands');
    this.Unlocked();
    if (this.recordHold) throw new Error('a live recording is already running');
    if (!(Number.isInteger(fps) && fps >= MIN_EXPORT_FPS && fps <= MAX_EXPORT_FPS)) throw new RangeError(`a recording's fps must be an integer from ${MIN_EXPORT_FPS} to ${MAX_EXPORT_FPS}, not ${fps}`);
    this.recordHold = { saved: this.lock };
    this.clock.Resync();
    this.lastFrameMs = null;
    this.lock = { pacer: new FrameLock(fps, this.clock.now), by: 'record_movie' };
    this.ResetMeasure();
    this.Present();
  }

  /**
   * Gives the clock back after a live recording: the user's lock (or none) comes back, re-anchored at now, and the next
   * frame targets now. Nothing outside a recording.
   */
  EndRecording(): void {
    const hold = this.recordHold;
    if (!hold) return;
    this.recordHold = null;
    this.lock = hold.saved;
    this.clock.Resync();
    this.lastFrameMs = null;
    this.lock?.pacer.Anchor(this.clock.now);
    this.ResetMeasure();
    this.Present();
  }

  /**
   * @throws {Error} EXPORT_LOCKED_TEXT while a movie export drives the clock.
   */
  private Unlocked(): void {
    if (this.exportMode) throw new Error(EXPORT_LOCKED_TEXT);
  }

  /**
   * Stops the frame loop exactly at a clock (Movie mode M5: a movie's end; a beat): the frame that reaches it steps the
   * boundaries up to it, sets the clock there and pauses, at any rate or under the frame lock; then the stop clears
   * itself. Each slot holds one stop, and the loop stops at the earliest. Jumps and re-simulations ignore it (they have
   * their own target), and a clock the loop is already at or past drops it.
   *
   * @param clock - 100 ns ticks, or null to clear the slot's stop.
   * @param onStop - Called once the loop stopped there.
   * @param slot - Whose stop (MOVIE_STOP_SLOT by default): setting one slot never clears another's.
   */
  StopAt(clock: Maybe<number>, onStop?: () => void, slot: string = MOVIE_STOP_SLOT): void {
    if (clock == null) this.stops.delete(slot);
    else this.stops.set(slot, { clock, ...(onStop ? { onStop } : {}) });
  }

  /**
   * The earliest clock the frame loop stops at (StopAt), or null.
   */
  get stopsAt(): Maybe<number> {
    let next: Maybe<number> = null;
    for (const stop of this.stops.values()) if (next == null || stop.clock < next) next = stop.clock;
    return next;
  }

  /**
   * The furthest clock recorded (the recorded end), or now while nothing is: a seek goes at most MAX_SEEK_AHEAD_SECONDS
   * past it.
   */
  get recordedEnd(): number {
    return this.RecordedEnd();
  }

  /**
   * Pauses or plays. Paused, no tick runs; the frames go on drawing at the frozen time.
   *
   * @param paused - True pauses.
   */
  Pause(paused: boolean): void {
    this.Unlocked();
    this.clock.paused = paused;
    this.ResetMeasure();
    this.Present();
    if (paused) this.EndBeat('paused');
  }

  /**
   * Sets the clock's rate.
   *
   * @param rate - Scene time per real time, MIN_TIME_RATE to MAX_TIME_RATE.
   * @throws {RangeError} When the rate is out of bounds.
   */
  SetRate(rate: number): void {
    this.Unlocked();
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
      state: this.State(),
      ...(this.exportMode && this.exportFps != null ? { exportFps: this.exportFps } : {}),
      ...(this.lock ? { lock: { fps: this.lock.pacer.fps, by: this.lock.by } } : {}),
      ...(this.beat ? { play: { stopsAt: SceneSeconds(this.beat.stop), stopsIn: Round2(Math.max(0, this.beat.stop - now) / TICKS_PER_SECOND) } } : {}),
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

  private State(): TimeReport['state'] {
    if (this.jumping) return 'jumping';
    if (this.exportMode) return 'exporting';
    return this.clock.paused ? 'paused' : 'playing';
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
   * Drops snapshots older than the window before the latest, then the oldest past the byte budget (the latest always
   * stays), then the tape before the earliest snapshot. The pinned origin is never dropped, though its bytes count.
   */
  private Trim(): void {
    const last = this.snapshots.at(-1);
    if (!last) return;
    const oldest = last.clock - this.windowSeconds * TICKS_PER_SECOND;
    const dropped = new Set<TimeSnapshot>();
    let bytes = this.Bytes();
    for (const snapshot of this.snapshots) {
      if (snapshot === last || snapshot.clock >= oldest) break;
      if (snapshot.pinned) continue;
      dropped.add(snapshot);
      bytes -= snapshot.bytes;
    }
    for (const snapshot of this.snapshots) {
      if (snapshot === last || bytes <= this.budgetBytes) break;
      if (snapshot.pinned || dropped.has(snapshot)) continue;
      dropped.add(snapshot);
      bytes -= snapshot.bytes;
    }
    if (dropped.size) this.snapshots = this.snapshots.filter((snapshot) => !dropped.has(snapshot));
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

  /**
   * @param closable - Whether the window may close on this frame (under the frame lock, only on a grid frame).
   */
  private Measure(frameMs: number, sceneTicks: number, closable = true): void {
    const last = this.lastFrameMs;
    if (Number.isFinite(frameMs)) this.lastFrameMs = frameMs;
    if (typeof last !== 'number' || !Number.isFinite(frameMs) || this.clock.paused || this.clock.held) {
      if (this.clock.paused || this.clock.held) this.ResetMeasure();
      return;
    }
    this.windowReal += Math.min(Math.max(frameMs - last, 0), MAX_FRAME_STEP_MS);
    this.windowScene += sceneTicks;
    if (closable && this.windowReal >= EFFECTIVE_RATE_WINDOW_MS) {
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
 * @returns Such as "1×", "paused at 0.25×", "4× (2.7× actual) · muted" or "1× · 30 fps lock (0.12× actual)".
 */
export function TimeText(report: TimeReport): string {
  if (report.state === 'exporting') return report.exportFps ? `exporting · 1/${report.exportFps} s a frame` : 'exporting';
  let text = report.paused ? `paused at ${RateText(report.rate)}` : RateText(report.rate);
  if (report.lock) text += ` · ${report.lock.fps} fps ${report.lock.by === 'record_movie' ? 'record lock' : 'lock'}`;
  if (report.effectiveRate != null) text += ` (${RateText(report.effectiveRate)} actual)`;
  if (report.play) text += ` · beat ends in ${report.play.stopsIn.toFixed(1)} s`;
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

/**
 * Whether a restore of a snapshot runs a tape entry again: every entry from its tick on, but the origin's state already
 * holds the entries of its tick made before it was taken.
 */
function ReplaysAfter(entry: TapeEntry, snapshot: TimeSnapshot): boolean {
  return entry.tick > snapshot.tick || (entry.tick === snapshot.tick && entry.seq > (snapshot.doneThrough ?? -Infinity));
}

function Round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function SecondsText(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(1);
}
