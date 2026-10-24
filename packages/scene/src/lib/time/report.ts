/**
 * get_state's `time`: the scene clock as time control runs it, the recorded window, the tape and the last jump.
 * Shared by the page (TimeControl.Report) and verify-page.
 */

/**
 * playing: the clock runs at its rate; paused: it stands still (the drawing goes on); jumping: a jump back
 * re-simulates (sd-time); exporting: a movie export moves the clock 1/fps a drawn frame, whatever the real frame time
 * (sd-export).
 */
export const TIME_STATES = ['playing', 'paused', 'jumping', 'exporting'] as const;
export type TimeState = (typeof TIME_STATES)[number];

/**
 * muted: the page's sounds are off above AUDIBLE_MAX_RATE; suspended: the AudioContext is held while paused.
 */
export type TimeAudioState = 'muted' | 'suspended';

/**
 * Who set the frame lock: time_control { fps }, or a live recording (record_movie) for its length.
 */
export const TIME_LOCK_SOURCES = ['time_control', 'record_movie'] as const;
export type TimeLockSource = (typeof TIME_LOCK_SOURCES)[number];

/**
 * How a beat (time_control { play }) ended: played (it reached its stop), paused (a pause before it: the movie's end,
 * Space, time_control pause), jump (a jump or a script edit's re-simulation landed), export (a movie export began) or
 * replaced (a new beat).
 */
export const TIME_PLAY_ENDS = ['played', 'paused', 'jump', 'export', 'replaced'] as const;
export type TimePlayEnd = (typeof TIME_PLAY_ENDS)[number];

/**
 * The frame lock (time_control { fps }): the scene clock moves on a 1/fps grid, one grid frame a drawn frame at most,
 * so a page that cannot draw fps frames a second slows the scene instead of skipping it ahead.
 */
export interface TimeLockReport {
  readonly fps: number;
  readonly by: TimeLockSource;
}

/**
 * A beat armed (time_control { play }): where it pauses, scene seconds, and how far that is.
 */
export interface TimePlayReport {
  readonly stopsAt: number;
  readonly stopsIn: number;
}

export interface TimeReport {
  /**
   * Scene seconds since the page booted (get_state.simulation.seconds).
   */
  readonly seconds: number;
  /**
   * The Destiny tick (get_state.simulation.tick).
   */
  readonly tick: number;
  readonly rate: number;
  readonly paused: boolean;
  readonly state: TimeState;
  /**
   * While a movie export runs (`state: exporting`): its frames a scene second, each frame advancing the clock 1/fps.
   */
  readonly exportFps?: number;
  /**
   * The frame lock, while one is set (time_control { fps }).
   */
  readonly lock?: TimeLockReport;
  /**
   * The beat playing (time_control { play }), until it pauses.
   */
  readonly play?: TimePlayReport;
  /**
   * Seconds of timeline time at now (`seconds` less the scene time of the timeline's t = 0), once a scripted timeline
   * started: what `seek { timeline }` takes.
   */
  readonly timeline?: number;
  /**
   * The rate the page actually kept over the last second, when it fell behind the asked rate (below 95 %): a frame
   * steps ticks for at most its step budget, and the clock waits at the last tick it stepped; under a frame lock, the
   * page draws fewer grid frames a second than the lock's fps.
   */
  readonly effectiveRate?: number;
  /**
   * True while a scripted load holds the clock for its prepare.
   */
  readonly held?: true;
  readonly audio?: TimeAudioState;
  /**
   * Scene seconds a jump can go back from now (0 when nothing is recorded).
   */
  readonly back: number;
  /**
   * The earliest scene time a jump reaches, while something is recorded.
   */
  readonly earliest?: number;
  /**
   * The recorded end, scene seconds: later than `seconds` after a jump back (the recorded future replays).
   */
  readonly latest?: number;
  readonly window: TimeWindowReport;
  readonly recording: TimeRecordingReport;
  /**
   * The tape ahead: recorded live commands a replay still runs.
   */
  readonly replay?: TimeReplayReport;
  /**
   * Replays that came out different from the recorded run (expected 0).
   */
  readonly drift?: TimeDriftReport;
  /**
   * The last jump.
   */
  readonly jump?: TimeJumpReport;
}

export interface TimeWindowReport {
  /**
   * Scene seconds the snapshots kept span (earliest to the recorded end).
   */
  readonly seconds: number;
  /**
   * The snapshot spacing, scene seconds (doubled automatically when a capture is slow).
   */
  readonly every: number;
  /**
   * The asked window, scene seconds.
   */
  readonly window: number;
  readonly snapshots: number;
  /**
   * Estimated bytes the snapshots hold, and the budget, bytes.
   */
  readonly bytes: number;
  readonly budget: number;
  /**
   * The last snapshot's capture time, ms.
   */
  readonly capture?: number;
}

export interface TimeRecordingReport {
  readonly on: boolean;
  /**
   * The scene time recording started at.
   */
  readonly since?: number;
  /**
   * Why the window was last cut (an edit, a load, a lookup landing), and when.
   */
  readonly why?: string;
  readonly cutAt?: number;
  /**
   * While off: what the scene still waits for before it is settled.
   */
  readonly waiting?: TimeWaitingReport;
}

/**
 * What the scene still waits for, by kind (lookups, fits, builds, fleets, objects, location), as counts.
 */
export type TimeWaitingReport = Readonly<Record<string, number>>;

export interface TimeReplayReport {
  readonly pending: number;
  readonly next?: { readonly tool: string; readonly seconds: number };
}

export interface TimeDriftReport {
  readonly count: number;
  readonly tick?: number;
  readonly summary?: string;
}

export interface TimeJumpReport {
  /**
   * Scene seconds before and after.
   */
  readonly from: number;
  readonly to: number;
  /**
   * The snapshot's tick, and the ticks re-simulated from it.
   */
  readonly snapshot: number;
  readonly resimulated: number;
  readonly ms: number;
  /**
   * What made it: a time_control jump, or a script edit re-simulating from before it (Movie mode M3; from = to = now).
   */
  readonly cause?: 'jump' | 'edit';
  /**
   * A script edit's: how many cues and ships' orders it changed.
   */
  readonly edit?: { readonly cues: number; readonly ships: number };
  readonly warnings?: readonly string[];
}
