import { describe, expect, it } from 'vitest';
import { normalizeCameraShot } from '../shot';
import { resolveHardpoint } from '../hardpoints';
import { distanceVec, dotVec, subVec } from '../vectors';
import { DIRECTOR_FRAMINGS, toFramingShot } from './framings';
import { directorPicture, twoFleets } from './director.spec-helper';
import type { DirectorSubject } from './interest';
import { toDirectorScene } from './picture';

const SUBJECTS: Record<string, DirectorSubject> = {
  ship: { kind: 'ship', key: 'ship:blue-1', ship: 'blue-1' },
  pair: { kind: 'pair', key: 'pair:blue-1>red-1', ship: 'blue-1', target: 'red-1', relation: 'shooter' },
  group: { kind: 'group', key: 'fleet:blue', fleet: 'blue', members: ['blue-fc', 'blue-1'], leader: 'blue-fc', whole: true, warping: true },
  engagement: { kind: 'engagement', key: 'engagement' },
  landmark: { kind: 'landmark', key: 'object:gate', object: 'gate', name: 'gate', position: [0, 0, 60000] }
};

describe('camera director framings', () => {
  it('builds a play_shot every framing and variant normalizes with no problems', () => {
    for (const row of DIRECTOR_FRAMINGS) {
      for (const variant of row.variants ?? [undefined]) {
        const built = toFramingShot(row, SUBJECTS[row.subject], variant, { duration: 8, transition: { type: 'blend', duration: 1.5 }, coreFactor: 1.5, teams: ['blue', 'red'], radius: 400, landmark: { object: 'gate' }, letterbox: 2.39, hud: false });
        expect(built, `${row.name} ${variant ?? ''}`).toBeTruthy();
        const normalized = normalizeCameraShot(built?.shot);
        expect(normalized.problems, `${row.name} ${variant ?? ''}`).toEqual([]);
        expect(normalized.warnings, `${row.name} ${variant ?? ''}`).toEqual([]);
        expect(normalized.shot?.end).toBe('hold');
        expect(normalized.shot?.letterbox).toBe(2.39);
        if (row.library) expect(normalized.shot?.library).toBe(row.library);
      }
    }
  });

  it('puts over-the-shoulder on the asked shoulder', () => {
    const picture = directorPicture(0, twoFleets().ships, twoFleets().fleets);
    const scene = toDirectorScene(picture);
    const port = resolveHardpoint({ name: 'over-the-shoulder', ship: 'blue-1', target: 'red-1', side: 'port' }, scene).pose;
    const starboard = resolveHardpoint({ name: 'over-the-shoulder', ship: 'blue-1', target: 'red-1' }, scene).pose;
    const shipStarboard = [-1, 0, 0] as [number, number, number];
    expect(port && dotVec(subVec(port.eye, [-600, 0, 0]), shipStarboard)).toBeLessThan(0);
    expect(starboard && dotVec(subVec(starboard.eye, [-600, 0, 0]), shipStarboard)).toBeGreaterThan(0);
    expect(port && starboard && distanceVec(port.look, starboard.look)).toBeCloseTo(0);
  });

  it('mirrors the fly-through to start on starboard', () => {
    const port = normalizeCameraShot({ shot: 'battle-fly-through' }).shot?.moves[0];
    const starboard = normalizeCameraShot({ shot: 'battle-fly-through', side: 'starboard' }).shot?.moves[0];
    const first = (move: unknown): number[] => ((move as { points: number[][] }).points[0] ?? []) as number[];
    expect(first(port)[1]).toBeLessThan(0);
    expect(first(starboard)[1]).toBeCloseTo(-first(port)[1]);
  });
});
