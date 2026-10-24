import { describe, expect, it } from 'vitest';
import { resolveHardpoint } from '../hardpoints';
import { directorPicture, twoFleets } from './director.spec-helper';
import { toDirectorScene } from './picture';
import { DIRECTOR_FRAMING_REACH, framedShipSize, subjectShipRadius } from './visibility';

describe('the director visibility floor', () => {
  const { ships, fleets } = twoFleets();
  const scene = toDirectorScene(directorPicture(0, ships, fleets));

  it('measures a fitted ship framing at about its fill', () => {
    const subject = { kind: 'ship', key: 'ship:blue-fc', ship: 'blue-fc' } as const;
    const resolved = resolveHardpoint({ name: 'hero-port', ship: 'blue-fc' }, scene);
    const size = framedShipSize({ scene, framing: 'hero', subject, resolved, pose: resolved.pose!, teams: null });
    expect(size).toBeGreaterThan(0.5);
    expect(size).toBeLessThan(0.65);
  });

  it('judges a moving shot at its farthest frame: the pull-out ×2.2, the fly-through at its path', () => {
    expect(DIRECTOR_FRAMING_REACH['overlook-pull-out']).toEqual({ factor: 2.2 });
    const flyThrough = DIRECTOR_FRAMING_REACH['battle-fly-through'];
    expect(flyThrough && 'radii' in flyThrough ? flyThrough.radii : 0).toBeCloseTo(1.51, 2);
    expect(DIRECTOR_FRAMING_REACH['hero']).toBeUndefined();
    const subject = { kind: 'engagement', key: 'engagement' } as const;
    const resolved = resolveHardpoint({ name: 'overlook', teams: ['blue', 'red'] }, scene);
    const overlook = framedShipSize({ scene, framing: 'overlook', subject, resolved, pose: resolved.pose!, teams: ['blue', 'red'] });
    const pullOut = framedShipSize({ scene, framing: 'overlook-pull-out', subject, resolved, pose: resolved.pose!, teams: ['blue', 'red'] });
    expect(pullOut).toBeCloseTo(overlook / 2.2, 6);
  });

  it('takes the lower median radius of the subject ships', () => {
    const mixed = toDirectorScene(
      directorPicture(
        0,
        ships.map((ship, index) => ({ ...ship, radius: 100 * (index + 1) })),
        fleets
      )
    );
    expect(subjectShipRadius(mixed, { kind: 'engagement', key: 'engagement' } as never, 'overlook', ['blue', 'red'])).toBe(500);
  });
});
