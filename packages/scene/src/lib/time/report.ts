/**
 * get_state's `time`: the scene clock as time control runs it. Shared by the page (TimeControl.Report) and
 * verify-page.
 */

/**
 * playing: the clock runs at its rate; paused: it stands still (the drawing goes on); jumping: a jump back
 * re-simulates (sd-time).
 */
export const TIME_STATES = ['playing', 'paused', 'jumping'] as const;
export type TimeState = (typeof TIME_STATES)[number];

/**
 * muted: the page's sounds are off above AUDIBLE_MAX_RATE; suspended: the AudioContext is held while paused.
 */
export type TimeAudioState = 'muted' | 'suspended';

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
   * The rate the page actually kept over the last second, when it fell behind the asked rate (below 95 %): a frame
   * steps ticks for at most its step budget, and the clock waits at the last tick it stepped.
   */
  readonly effectiveRate?: number;
  /**
   * True while a scripted load holds the clock for its prepare.
   */
  readonly held?: true;
  readonly audio?: TimeAudioState;
}
