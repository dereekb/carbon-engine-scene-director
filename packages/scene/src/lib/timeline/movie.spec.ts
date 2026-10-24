import { describe, expect, it } from 'vitest';
import { SceneError } from '../scene';
import { beatLaneOf, DEFAULT_MOVIE_LEAD_SECONDS, movieLookOf, normalizeMovieCommand } from './movie';

function problemsOf(input: unknown): string[] {
  try {
    normalizeMovieCommand(input);
  } catch (error) {
    if (error instanceof SceneError) return error.problems;
    throw error;
  }
  return [];
}

describe('normalizeMovieCommand', () => {
  it('defaults to status', () => {
    expect(normalizeMovieCommand({})).toEqual({ action: 'status' });
    expect(normalizeMovieCommand(undefined)).toEqual({ action: 'status' });
  });

  it('fills play, seek and restart defaults', () => {
    expect(normalizeMovieCommand({ action: 'play', from: 'go' })).toEqual({ action: 'play', from: 'go', lead: DEFAULT_MOVIE_LEAD_SECONDS });
    expect(normalizeMovieCommand({ action: 'play' })).toEqual({ action: 'play', lead: DEFAULT_MOVIE_LEAD_SECONDS });
    expect(normalizeMovieCommand({ action: 'play', from: 12, lead: 0, rate: 0.25 })).toEqual({ action: 'play', from: 12, lead: 0, rate: 0.25 });
    expect(normalizeMovieCommand({ action: 'seek', to: 'go' })).toEqual({ action: 'seek', to: 'go', offset: 0, play: false });
    expect(normalizeMovieCommand({ action: 'seek', to: 4, offset: -1, play: true })).toEqual({ action: 'seek', to: 4, offset: -1, play: true });
    expect(normalizeMovieCommand({ action: 'restart' })).toEqual({ action: 'restart', paused: false });
  });

  it('reads the edit actions', () => {
    expect(normalizeMovieCommand({ action: 'add', beat: { at: 3, engage: { ships: ['a'], target: 'b' } } })).toEqual({ action: 'add', beat: { at: 3, engage: { ships: ['a'], target: 'b' } } });
    expect(normalizeMovieCommand({ action: 'move', id: 'go', at: 6 })).toEqual({ action: 'move', id: 'go', at: 6 });
    expect(normalizeMovieCommand({ action: 'move', id: 'go', at: 6, when: null })).toEqual({ action: 'move', id: 'go', at: 6, when: null });
    expect(normalizeMovieCommand({ action: 'move', id: 'go', when: { cue: 'a' }, at: null })).toEqual({ action: 'move', id: 'go', at: null, when: { cue: 'a' } });
    expect(normalizeMovieCommand({ action: 'edit', id: 'go', set: { name: 'Go' } })).toEqual({ action: 'edit', id: 'go', set: { name: 'Go' } });
    expect(normalizeMovieCommand({ action: 'remove', id: 'go' })).toEqual({ action: 'remove', id: 'go' });
    expect(normalizeMovieCommand({ action: 'set', movie: { end: 8 } })).toEqual({ action: 'set', movie: { end: 8 } });
    expect(normalizeMovieCommand({ action: 'set', movie: null })).toEqual({ action: 'set', movie: null });
  });

  it('reports every problem at once', () => {
    expect(problemsOf({ action: 'dance' })).toEqual(['movie.action must be one of status, add, move, edit, remove, play, seek, pause, restart, retake, set']);
    const problems = problemsOf({ action: 'play', from: -1, lead: -2, rate: 64, to: 'x', bogus: 1 });
    expect(problems).toEqual([
      'movie.to does not go with action "play" (it takes from, lead, rate)',
      expect.stringContaining('movie.bogus is not a movie field'),
      'movie.from must be a beat id or seconds of timeline time (0 or more)',
      'movie.lead must be seconds, 0 or more',
      expect.stringContaining('movie.rate must be a number from')
    ]);
    expect(problemsOf({ action: 'play', lead: 1 })).toEqual(['movie.lead goes with from']);
    expect(problemsOf({ action: 'move', id: '' })).toEqual([expect.stringContaining('movie.id must be'), expect.stringContaining('move needs at')]);
    expect(problemsOf({ action: 'edit', id: 'go', set: {} })).toEqual([expect.stringContaining('movie.set must be')]);
    expect(problemsOf({ action: 'seek' })).toEqual([expect.stringContaining('movie.to must be')]);
    expect(problemsOf({ action: 'set' })).toEqual([expect.stringContaining('movie.movie must be')]);
    expect(problemsOf({ action: 'pause', paused: true })).toEqual(['movie.paused does not go with action "pause" (it takes no other field)']);
  });
});

describe('beat lanes and the look', () => {
  it('puts the camera levers in the camera lane', () => {
    expect(['play_shot', 'play_sequence', 'stop_shot', 'auto_camera'].map((action) => beatLaneOf(action as never))).toEqual(['camera', 'camera', 'camera', 'camera']);
    expect(beatLaneOf('order_fleet')).toBe('fleet');
    expect(beatLaneOf('patch_scene')).toBe('fleet');
  });

  it("fills the movie block's look", () => {
    expect(movieLookOf({})).toEqual({ letterbox: 2.39, hud: false });
    expect(movieLookOf({ letterbox: false, hud: true, end: 9 })).toEqual({ letterbox: false, hud: true });
  });
});
