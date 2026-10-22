import { describe, expect, it } from 'vitest';
import { formatSceneDistance, largeSceneWarning, MAX_SCENE_DISTANCE, readScenePosition } from './extent';

describe('readScenePosition', () => {
  it('accepts a position up to MAX_SCENE_DISTANCE and refuses one past it', () => {
    const problems: string[] = [];
    expect(readScenePosition([0, 0, MAX_SCENE_DISTANCE], 'p', problems)).toEqual([0, 0, MAX_SCENE_DISTANCE]);
    expect(problems).toEqual([]);
    readScenePosition([0, MAX_SCENE_DISTANCE + 1, 0], 'ships[3].position', problems);
    expect(problems).toEqual(['ships[3].position is 10,000 km from the scene origin; a scene spans at most 10,000 km around its origin, as an EVE grid does; place it closer, or move the origin there with set_location']);
  });

  it('reports a non-vector once, without the extent', () => {
    const problems: string[] = [];
    expect(readScenePosition('far', 'p', problems)).toEqual([0, 0, 0]);
    expect(problems).toEqual(['p must be an array of three finite numbers']);
  });
});

describe('formatSceneDistance', () => {
  it('writes metres, km and AU', () => {
    expect(formatSceneDistance(900)).toBe('900 m');
    expect(formatSceneDistance(45_400)).toBe('45 km');
    expect(formatSceneDistance(12_412_000)).toBe('12,400 km');
    expect(formatSceneDistance(1.2 * 1.496e11)).toBe('1.2 AU');
  });
});

describe('largeSceneWarning', () => {
  it('counts the placements past 2,000 km with the noun', () => {
    expect(largeSceneWarning({ positions: [[0, 0, 1e6]], noun: 'ship', where: 'w' })).toBeNull();
    expect(largeSceneWarning({ positions: [[0, 0, 3e6]], noun: 'ship', where: 'w' })).toBe('w: 1 ship is more than 2,000 km from the scene origin; scenes rarely use more than 2,000 km (the limit is 10,000 km)');
    expect(
      largeSceneWarning({
        positions: [
          [0, 0, 3e6],
          [3e6, 0, 0],
          [0, 0, 0]
        ],
        noun: 'object',
        where: 'w'
      })
    ).toMatch(/^w: 2 objects are more than 2,000 km/u);
  });
});
