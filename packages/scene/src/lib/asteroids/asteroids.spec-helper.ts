import type { SceneAsteroidRocks } from './field';

/**
 * A SOF faction's 12 rocks (four shapes in three sizes), as tools-core's SDE `graphics` table lists them.
 *
 * @param family - The rock family and colour, e.g. `rock_01_%_whiteyellow`, `%` standing for the size and shape.
 * @param faction - The SOF faction.
 * @returns The rock set.
 */
export function rockSet(family: string, faction: string): SceneAsteroidRocks {
  const of = (letter: string): string[] => [1, 2, 3, 4].map((shape) => family.replace('%', letter + '_v' + shape + 'a') + ':' + faction + ':asteroid');
  return { small: of('s'), medium: of('m'), large: of('l') };
}

export const VELDSPAR_ROCKS = rockSet('rock_01_%_whiteyellow', 'ore_veldspar');
export const DARK_OCHRE_ROCKS = rockSet('crystal_02_%_yellowred', 'crystal_darkochre');
export const BLUE_ICE_ROCKS = rockSet('ice_01_%_whiteblue', 'ice_blue');
