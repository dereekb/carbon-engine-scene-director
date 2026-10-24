import { describe, expect, it } from 'vitest';
import { SceneError } from '../../scene';
import { findTool } from '../../tools';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, directorHold, normalizeAutoCameraCommand, resolveCameraDirectorSettings } from './command';

function problemsOf(input: unknown): string[] {
  try {
    normalizeAutoCameraCommand(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SceneError);
    return (error as SceneError).problems;
  }
  throw new Error('expected a SceneError');
}

describe('auto_camera command', () => {
  it('reads an empty call (on by default) and every bias key', () => {
    expect(normalizeAutoCameraCommand({})).toEqual({});
    expect(normalizeAutoCameraCommand(undefined)).toEqual({});
    expect(normalizeAutoCameraCommand({ on: false, follow: { fleet: 'tfis' }, favour: 'wide', sun: true, teams: ['blue', 'red'], pace: 'fast', hold: { min: 3 }, letterbox: 2.39, hud: false, seed: 42 })).toEqual({
      on: false,
      follow: { fleet: 'tfis' },
      favour: 'wide',
      sun: true,
      teams: ['blue', 'red'],
      pace: 'fast',
      hold: { min: 3 },
      letterbox: 2.39,
      hud: false,
      seed: 42
    });
  });

  it('merges key by key: a value sets, null resets, an omitted key stays', () => {
    const first = resolveCameraDirectorSettings(normalizeAutoCameraCommand({ follow: { ship: 'a' }, favour: 'close', pace: 'slow' }));
    expect(first).toMatchObject({ follow: { ship: 'a' }, favour: 'close', pace: 'slow', sun: false });
    const second = resolveCameraDirectorSettings(normalizeAutoCameraCommand({ favour: null, sun: true }), first);
    expect(second).toMatchObject({ follow: { ship: 'a' }, favour: null, pace: 'slow', sun: true });
    expect(resolveCameraDirectorSettings(normalizeAutoCameraCommand({ follow: null, pace: null }), second)).toMatchObject({ follow: null, pace: DEFAULT_CAMERA_DIRECTOR_SETTINGS.pace });
  });

  it('turns the pace into holds, and hold wins over it key by key', () => {
    expect(directorHold({ pace: 'normal', hold: null })).toEqual({ min: 4, max: 12 });
    expect(directorHold({ pace: 'fast', hold: null })).toEqual({ min: 3, max: 7 });
    expect(directorHold({ pace: 'slow', hold: null })).toEqual({ min: 6, max: 20 });
    expect(directorHold({ pace: 'fast', hold: { max: 30 } })).toEqual({ min: 3, max: 30 });
    expect(directorHold({ pace: 'fast', hold: { min: 10 } })).toEqual({ min: 10, max: 11 });
  });

  it('refuses unknown keys and bad values, every problem together', () => {
    const problems = problemsOf({ zoom: 2, favour: 'huge', follow: { fleet: 'a', ship: 'b' }, seed: 1.5, hold: { min: 1, max: 400 }, teams: ['a', 'a'], pace: 'brisk', on: 'yes' }).join('\n');
    expect(problems).toMatch(/auto_camera\.zoom is not an auto_camera field/);
    expect(problems).toMatch(/favour must be one of wide, medium, close/);
    expect(problems).toMatch(/follow must be exactly one of/);
    expect(problems).toMatch(/seed must be an integer/);
    expect(problems).toMatch(/hold\.min must be seconds in \[2, 60\]/);
    expect(problems).toMatch(/hold\.max must be seconds/);
    expect(problems).toMatch(/teams must be two different team ids/);
    expect(problems).toMatch(/pace must be one of slow/);
    expect(problems).toMatch(/on must be true or false/);
    expect(problemsOf({ hold: { min: 10, max: 10 } }).join('\n')).toMatch(/at least min \+ 1/);
    expect(problemsOf({ hold: {} }).join('\n')).toMatch(/needs min or max/);
  });
});

describe('auto_camera tool', () => {
  it('is a cueable page tool', () => {
    const tool = findTool('auto_camera');
    expect(tool?.where).toBe('page');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['on', 'follow', 'favour', 'sun', 'teams', 'pace', 'hold', 'at', 'cue']));
  });
});
