/**
 * The scene extent: how far from the scene origin a document may place things. A leaf module (it imports only the
 * JSON readers), so the scene, staging and objects normalizers all share it without an import cycle.
 */

import type { Maybe } from '@dereekb/util';
import { readVector } from './json';
import type { SceneVector } from './scene';

/**
 * The farthest a ship or object's document position may sit from the scene origin, in metres (10,000 km). The user's
 * rule (2026-10-22): "a scene should probably be limited to 10,000km or so, just like the game"; an EVE grid is a few
 * thousand km at most. Destiny's top partition cell is 7,864 km wide, so a scene this size can still span two bubbles.
 */
export const MAX_SCENE_DISTANCE = 10_000_000;

/**
 * Placements farther than this from the scene origin warn (2,000 km): "beyond 2000km is usually a very large space
 * that is unused" (the user, 2026-10-22).
 */
export const LARGE_SCENE_DISTANCE = 2_000_000;

/**
 * One astronomical unit, in metres.
 */
const AU = 1.496e11;

/**
 * Reads a document position and refuses one farther than MAX_SCENE_DISTANCE from the scene origin.
 *
 * @param value - The candidate vector.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problems.
 * @returns The vector, or the origin when it is not three finite numbers.
 */
export function readScenePosition(value: unknown, where: string, problems: string[]): SceneVector {
  const before = problems.length;
  const position = readVector(value, where, problems);
  const distance = Math.hypot(...position);
  if (problems.length === before && distance > MAX_SCENE_DISTANCE) {
    problems.push(`${where} is ${formatSceneDistance(distance)} from the scene origin; a scene spans at most ${formatSceneDistance(MAX_SCENE_DISTANCE)} around its origin, as an EVE grid does; place it closer, or move the origin there with set_location`);
  }
  return position;
}

/**
 * A distance for messages: metres below 1 km, km (rounded to 1 km, or to 100 km above 1,000 km), or AU at 0.1 AU and
 * more.
 *
 * @param metres - The distance.
 * @returns The text, e.g. "900 m", "12,400 km" or "1.2 AU".
 */
export function formatSceneDistance(metres: number): string {
  let text: string;
  if (metres >= AU / 10) text = `${(metres / AU).toFixed(1)} AU`;
  else if (metres >= 1_000_000) text = `${(Math.round(metres / 100_000) * 100).toLocaleString('en-US')} km`;
  else if (metres >= 1000) text = `${Math.round(metres / 1000).toLocaleString('en-US')} km`;
  else text = `${Math.round(metres).toLocaleString('en-US')} m`;
  return text;
}

export interface LargeSceneWarningInput {
  readonly positions: readonly SceneVector[];
  readonly noun: 'ship' | 'object';
  /**
   * Where the operation sits.
   */
  readonly where: string;
}

/**
 * The warning for placements past LARGE_SCENE_DISTANCE.
 *
 * @param input - The new positions, what they are, and where the operation sits.
 * @returns The warning, or null when none is that far.
 */
export function largeSceneWarning(input: LargeSceneWarningInput): Maybe<string> {
  const { positions, noun, where } = input;
  const far = positions.filter((position) => Math.hypot(...position) > LARGE_SCENE_DISTANCE).length;
  const count = far === 1 ? `1 ${noun} is` : `${far} ${noun}s are`;
  return far ? `${where}: ${count} more than ${formatSceneDistance(LARGE_SCENE_DISTANCE)} from the scene origin; scenes rarely use more than ${formatSceneDistance(LARGE_SCENE_DISTANCE)} (the limit is ${formatSceneDistance(MAX_SCENE_DISTANCE)})` : null;
}
