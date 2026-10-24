import { describe, expect, it } from 'vitest';
import { AnimationClock, MAX_ANIMATION_STEP_TICKS } from './animation-clock';
import { SceneClock, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { Ship } from './destiny.spec-helper';
import { ResolveFlight, type PublishedHull } from './flight';
import { TimeControl } from './time-control';

const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null });
const SEED = 123_456_789;
const FRAME_MS = 1000 / 60;

/**
 * A page stand-in: the scene clock under time control, and the engine's frame feeding the animation clock the frame's
 * `now` (main.ts → engine.Frame).
 */
function Rig() {
  const clock = new SceneClock();
  const world = new DestinyWorld();
  world.AddShip(Ship('a', [0, 0, 0]), rifter);
  world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
  const control = new TimeControl({ clock, world });
  const animation = new AnimationClock(SEED);
  let ms = 0;
  let now = 0;
  /** Plays `seconds` of real time at 60 fps; returns the animation clock's advance, seconds. */
  const Play = (seconds: number): number => {
    const before = animation.ticks;
    const end = ms + seconds * 1000;
    for (; ms < end - 1e-6; ms += FRAME_MS) {
      now = control.Frame(ms);
      animation.Frame(now);
    }
    return (animation.ticks - before) / TICKS_PER_SECOND;
  };
  return { clock, control, animation, Play, Now: () => now };
}

describe('AnimationClock', () => {
  it('starts at its seed, anchors on the first frame and keeps integer ticks', () => {
    const animation = new AnimationClock(SEED + 0.4);
    expect(animation.ticks).toBe(SEED);
    expect(animation.Frame(5_000_000)).toBe(SEED);
    expect(animation.Report()).toEqual({ seconds: 0, frozen: true });
    animation.Frame(5_000_000 + 166_666.7);
    expect(Number.isInteger(animation.ticks)).toBe(true);
    expect(animation.ticks).toBe(SEED + 166_667);
  });

  it('advances by the frame time at 1×', () => {
    const { Play } = Rig();
    Play(0.5);
    expect(Play(3)).toBeCloseTo(3, 1);
  });

  it('holds while paused or held, and resumes with one frame step and no catch-up', () => {
    const { clock, control, animation, Play } = Rig();
    Play(1);
    control.Pause(true);
    expect(Play(5)).toBe(0);
    expect(animation.Report().frozen).toBe(true);
    control.Pause(false);
    const resumed = Play(FRAME_MS / 1000);
    expect(resumed).toBeGreaterThan(0);
    expect(resumed).toBeLessThan(0.05);
    expect(animation.Report().frozen).toBe(false);
    clock.Hold();
    expect(Play(2)).toBe(0);
    clock.Release();
    Play(0.1);
    expect(Play(1)).toBeCloseTo(1, 1);
  });

  it('follows the rate: a quarter second a second at 0.25×, four at 4×', () => {
    const { control, Play } = Rig();
    Play(0.5);
    control.SetRate(0.25);
    Play(0.1);
    expect(Play(4)).toBeCloseTo(1, 1);
    control.SetRate(4);
    Play(0.1);
    expect(Play(2)).toBeCloseTo(8, 1);
  });

  it('never runs backwards and never steps across a jump', () => {
    const t = 50 * TICKS_PER_SECOND;
    const animation = new AnimationClock(SEED);
    animation.Frame(t);
    const at = animation.ticks;
    animation.Frame(t - 10 * TICKS_PER_SECOND);
    expect(animation.ticks).toBe(at);
    animation.Frame(t);
    animation.Rebase(t + 300 * TICKS_PER_SECOND);
    const before = animation.ticks;
    animation.Frame(t + 300 * TICKS_PER_SECOND + 166_667);
    expect(animation.ticks - before).toBe(166_667);
    // A failed jump puts the clock back: the same rebase.
    animation.Rebase(t);
    const back = animation.ticks;
    animation.Frame(t + 166_667);
    expect(animation.ticks - back).toBe(166_667);
  });

  it('clamps a stalled frame to MAX_ANIMATION_STEP_TICKS', () => {
    const t = 50 * TICKS_PER_SECOND;
    const animation = new AnimationClock(SEED);
    animation.Frame(t);
    animation.Frame(t + 5 * TICKS_PER_SECOND);
    expect(animation.ticks - SEED).toBe(MAX_ANIMATION_STEP_TICKS);
  });

  it('samples its ticks for PumpOS and reports seconds to 0.01', () => {
    const { animation, Play } = Rig();
    for (let i = 0; i < 5; i++) {
      Play(0.3);
      expect(animation.Sample()[0]).toBe(animation.ticks);
    }
    const { seconds } = animation.Report();
    expect(Math.round(seconds * 100) / 100).toBe(seconds);
    expect(seconds).toBeCloseTo(1.5, 1);
  });
});
