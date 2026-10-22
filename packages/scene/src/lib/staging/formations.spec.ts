import { describe, expect, it } from 'vitest';
import { defaultShipSpacing, layoutShipFormation, readShipFormation, SHIP_FORMATIONS, toFormationWorld } from './formations';
import { minPairDistance } from './staging.spec-helper';

describe('layoutShipFormation', () => {
  for (const formation of SHIP_FORMATIONS) {
    for (const spacing of [193, 850]) {
      it(`${formation} keeps its spacing (${spacing} m) at any count`, () => {
        for (const count of [1, 2, 5, 44, 256]) {
          const offsets = layoutShipFormation({ formation, count, spacing });
          expect(offsets).toHaveLength(count);
          expect(offsets[0]).toEqual([0, 0, 0]);
          const world = toFormationWorld({ offsets, position: [1000.4, -20, 5e6], heading: 37.3 });
          if (count > 1) expect(minPairDistance(world)).toBeGreaterThanOrEqual(spacing - 2);
        }
      });
    }
  }

  it('lays out lines centre-out, columns astern, wedges at 45 degrees, grids and walls', () => {
    const s = 100;
    expect(layoutShipFormation({ formation: 'line', count: 5, spacing: s })).toEqual([
      [0, 0, 0],
      [100, 0, 0],
      [-100, 0, 0],
      [200, 0, 0],
      [-200, 0, 0]
    ]);
    expect(layoutShipFormation({ formation: 'column', count: 3, spacing: s })).toEqual([
      [0, 0, 0],
      [0, 0, -100],
      [0, 0, -200]
    ]);
    const wedge = layoutShipFormation({ formation: 'wedge', count: 5, spacing: s });
    expect(wedge[1][0]).toBeCloseTo(100 * Math.SQRT1_2);
    expect(wedge[1][2]).toBeCloseTo(-100 * Math.SQRT1_2);
    expect(wedge[2][0]).toBeCloseTo(-100 * Math.SQRT1_2);
    expect(wedge[4][2]).toBeCloseTo(-200 * Math.SQRT1_2);
    const grid = layoutShipFormation({ formation: 'grid', count: 5, spacing: s });
    expect(grid.map((offset) => offset[2])).toEqual([0, 0, 0, -100, -100]);
    expect(grid[3][0]).toBe(0);
    const wall = layoutShipFormation({ formation: 'wall', count: 9, spacing: s });
    expect(wall.map((offset) => offset[1])).toEqual([0, 0, 0, 100, 100, 100, -100, -100, -100]);
    expect(wall.every((offset) => offset[2] === 0)).toBe(true);
  });

  it('packs 256 ships in a sphere of at most 4 shells, trailing pole first', () => {
    const offsets = layoutShipFormation({ formation: 'sphere', count: 256, spacing: 100 });
    expect(Math.max(...offsets.map((offset) => Math.hypot(...offset)))).toBeLessThanOrEqual(400 + 1e-6);
    expect(offsets[1][2]).toBeLessThan(-90);
    expect(layoutShipFormation({ formation: 'sphere', count: 44, spacing: 193 })).toEqual(layoutShipFormation({ formation: 'sphere', count: 44, spacing: 193 }));
  });

  it('turns the heading frame: heading 90 maps forward to +X', () => {
    expect(
      toFormationWorld({
        offsets: [
          [0, 0, 100],
          [100, 0, 0]
        ],
        position: [0, 0, 0],
        heading: 90
      })
    ).toEqual([
      [100, 0, 0],
      [0, 0, -100]
    ]);
  });
});

describe('readShipFormation', () => {
  it('reads names case-insensitively, with aliases', () => {
    expect(readShipFormation('Blob', 'formation', [])).toBe('sphere');
    expect(readShipFormation(' WEDGE ', 'formation', [])).toBe('wedge');
    const problems: string[] = [];
    readShipFormation('cube', 'formation', problems);
    expect(problems[0]).toMatch(/sphere, line, column, wedge, grid, wall, blob/u);
  });
});

describe('defaultShipSpacing', () => {
  it('is fleets formationSpacing for two of the hull, rounded up', () => {
    expect(defaultShipSpacing(31)).toBe(193);
    expect(defaultShipSpacing(250)).toBe(850);
  });
});
