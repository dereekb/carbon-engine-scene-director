import { describe, expect, it } from 'vitest';
import { SceneError } from '../../scene';
import { findTool } from '../../tools';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, DEFAULT_MIN_SHIP_SIZE, directorHold, directorRulesProblem, mergeAutoCameraBias, normalizeAutoCameraCommand, resolveCameraDirectorSettings } from './command';

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

  it('merges key by key into a layer: a value sets, null drops, an omitted key stays', () => {
    const first = mergeAutoCameraBias({}, normalizeAutoCameraCommand({ on: true, follow: { ship: 'a' }, favour: 'close', pace: 'slow' }));
    expect(first).toEqual({ follow: { ship: 'a' }, favour: 'close', pace: 'slow' });
    const second = mergeAutoCameraBias(first, normalizeAutoCameraCommand({ favour: null, sun: true }));
    expect(second).toEqual({ follow: { ship: 'a' }, pace: 'slow', sun: true });
    expect(resolveCameraDirectorSettings(second)).toMatchObject({ follow: { ship: 'a' }, favour: null, pace: 'slow', sun: true, exclude: [], minShipSize: DEFAULT_MIN_SHIP_SIZE });
    expect(resolveCameraDirectorSettings(mergeAutoCameraBias(second, normalizeAutoCameraCommand({ follow: null, pace: null })))).toMatchObject({ follow: null, pace: DEFAULT_CAMERA_DIRECTOR_SETTINGS.pace });
  });

  it('layers the scene under the live overrides: a live null falls back to the scene, the open value lifts it', () => {
    const scene = { scales: ['medium', 'close'] as const, exclude: ['flyby'] as const, favour: 'close' as const };
    let live = mergeAutoCameraBias({}, normalizeAutoCameraCommand({ scales: ['close'] }));
    expect(resolveCameraDirectorSettings(scene, live)).toMatchObject({ scales: ['close'], exclude: ['flyby'], favour: 'close' });
    live = mergeAutoCameraBias(live, normalizeAutoCameraCommand({ scales: null, exclude: [] }));
    expect(resolveCameraDirectorSettings(scene, live)).toMatchObject({ scales: ['medium', 'close'], exclude: [] });
  });

  it('reads the shot rules, and refuses bad ones', () => {
    expect(normalizeAutoCameraCommand({ scales: ['close', 'wide'], framings: ['chase', 'hero'], exclude: ['overlook-pull-out'], minShipSize: 0.01 })).toEqual({ scales: ['wide', 'close'], framings: ['hero', 'chase'], exclude: ['overlook-pull-out'], minShipSize: 0.01 });
    expect(normalizeAutoCameraCommand({ exclude: [], minShipSize: 0, scales: null })).toEqual({ exclude: [], minShipSize: 0, scales: null });
    expect(() => normalizeAutoCameraCommand({ scales: [] })).toThrow(/scales must be a non-empty list of wide, medium, close \(no repeats\), or null/);
    expect(() => normalizeAutoCameraCommand({ scales: ['close', 'close'] })).toThrow(/scales must be/);
    expect(() => normalizeAutoCameraCommand({ scales: ['huge'] })).toThrow(/scales must be/);
    expect(() => normalizeAutoCameraCommand({ framings: [] })).toThrow(/framings must be a non-empty list of director framings \(hero, /);
    expect(() => normalizeAutoCameraCommand({ exclude: ['zoom'] })).toThrow(/exclude\.0 "zoom" is not a director framing \(hero, rear-quarter, /);
    expect(() => normalizeAutoCameraCommand({ framings: ['hero', 'chase'], exclude: ['hero'] })).toThrow(/"hero" is in both framings and exclude/);
    expect(() => normalizeAutoCameraCommand({ minShipSize: 0.3 })).toThrow(/minShipSize must be a share of the frame height in \[0, 0\.25\] \(0 turns it off\), or null/);
  });

  it('finds rules that leave no framing to pick', () => {
    expect(directorRulesProblem(resolveCameraDirectorSettings({ framings: ['overlook'], scales: ['close'] }))).toBe('auto_camera: the rules leave no framing to pick (framings overlook; scales close)');
    expect(directorRulesProblem(resolveCameraDirectorSettings({ framings: ['hero'], exclude: ['flyby'] }))).toBeNull();
    // A group row can be medium (a wing, squad or handful).
    expect(directorRulesProblem(resolveCameraDirectorSettings({ framings: ['behind-fc'], scales: ['medium'] }))).toBeNull();
    expect(directorRulesProblem(resolveCameraDirectorSettings({ scales: ['medium', 'close'] }))).toBeNull();
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
