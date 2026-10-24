import { describe, expect, it } from 'vitest';
import { resolveHardpoint } from '../hardpoints';
import { axisResets, directorAxis, flybyViewSide, viewSideOf, type DirectorAxis } from './axis';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS } from './command';
import { directorFleet, directorPicture, directorShip, twoFleets } from './director.spec-helper';
import { EMPTY_DIRECTOR_INTEREST, stepDirectorInterest } from './interest';
import { toDirectorScene, type CameraDirectorPicture } from './picture';

function axisOf(picture: CameraDirectorPicture, follow: { ship: string } | null = null): DirectorAxis {
  const { facts } = stepDirectorInterest({ picture, events: [], settings: { ...DEFAULT_CAMERA_DIRECTOR_SETTINGS, follow }, memory: EMPTY_DIRECTOR_INTEREST, first: false, lastLandmark: 0 });
  const axis = directorAxis(picture, facts);
  if (!axis) throw new Error('no axis');
  return axis;
}

describe('camera director axis', () => {
  it('runs from team a to team b, else along the followed ship or the biggest moving fleet', () => {
    const { ships, fleets } = twoFleets();
    const teams = axisOf(directorPicture(0, ships, fleets));
    expect(teams).toMatchObject({ kind: 'teams', teams: ['blue', 'red'] });
    expect(teams.forward[2]).toBeCloseTo(1);
    // Starboard is axis × up: −X for an axis along +Z.
    expect(teams.starboard[0]).toBeCloseTo(-1);
    const flying = [0, 1, 2, 3, 4].map((i) => directorShip(i ? `m-${i}` : 'm-fc', [i * 500, 0, 0], { velocity: [300, 0, 0] }));
    const motion = axisOf(directorPicture(0, flying, [directorFleet('m', 'm-fc', ['m-1', 'm-2', 'm-3', 'm-4'])]));
    expect(motion).toMatchObject({ kind: 'motion', ship: 'm-fc' });
    expect(motion.forward[0]).toBeCloseTo(1);
    expect(axisOf(directorPicture(0, flying, []), { ship: 'm-2' })).toMatchObject({ kind: 'motion', ship: 'm-2' });
  });

  it('judges a shot by the side it looks across from: overlook starboard +1, top-down neutral, both broadsides that face the line', () => {
    const picture = directorPicture(0, twoFleets().ships, twoFleets().fleets);
    const axis = axisOf(picture);
    const scene = toDirectorScene(picture);
    const pose = (name: string, extra: Record<string, unknown> = {}) => {
      const resolved = resolveHardpoint({ name, ...extra }, scene).pose;
      if (!resolved) throw new Error(`no pose for ${name}`);
      return resolved;
    };
    expect(viewSideOf(pose('overlook', { side: 'starboard' }), axis)).toBe(1);
    expect(viewSideOf(pose('overlook', { side: 'port' }), axis)).toBe(-1);
    expect(viewSideOf(pose('top-down', { ship: 'blue-1' }), axis)).toBe(0);
    // Blue faces red and red faces blue: blue's starboard broadside and red's port broadside look the same way.
    expect(viewSideOf(pose('broadside-starboard', { ship: 'blue-1' }), axis)).toBe(1);
    expect(viewSideOf(pose('broadside-port', { ship: 'red-1' }), axis)).toBe(1);
    expect(viewSideOf(pose('broadside-port', { ship: 'blue-1' }), axis)).toBe(-1);
  });

  it('judges a flyby at its pass', () => {
    const picture = directorPicture(0, twoFleets({ blue: { velocity: [0, 0, 300] } }).ships, twoFleets().fleets);
    const axis = axisOf(picture);
    const flyby = resolveHardpoint({ name: 'flyby', ship: 'blue-1' }, toDirectorScene(picture)).pose;
    const ship = picture.ships.find((candidate) => candidate.id === 'blue-1');
    // The eye waits off the starboard bow, so the pass looks across from starboard.
    expect(flyby && ship && flybyViewSide(flyby.eye, ship, axis)).toBe(1);
  });

  it('resets the kept side when the axis turns more than 60°, or another axis takes over', () => {
    const axis = axisOf(directorPicture(0, twoFleets().ships, twoFleets().fleets));
    const side = { value: 1 as const, forward: axis.forward, key: axis.key };
    expect(axisResets(side, axis)).toBe(false);
    expect(axisResets(side, { ...axis, forward: [Math.sin(1.2), 0, Math.cos(1.2)] })).toBe(true);
    expect(axisResets(side, { ...axis, forward: [Math.sin(0.5), 0, Math.cos(0.5)] })).toBe(false);
    expect(axisResets(side, { ...axis, key: 'teams:blue|green' })).toBe(true);
    expect(axisResets(side, null)).toBe(true);
  });
});
