/**
 * The combat RNG: a roll keyed per shot, not a stream. Module events reach the page in an order that depends on when
 * each ship's fit resolved, so a sequential stream would give two runs of one scene different rolls; a keyed roll is
 * the same whatever the order, however many unrelated ships exist and however much time passes. The time-control
 * entry snapshots only the seed.
 */

/**
 * What a shot's roll is keyed by.
 */
export interface CombatRollKey {
  readonly ship: string;
  readonly module: string;
  /**
   * The module's activation count since the load: a second engagement does not replay the first one's rolls.
   */
  readonly activation: number;
  /**
   * The cycle within that activation (1 for the first shot).
   */
  readonly cycle: number;
  readonly target: string;
}

const TWO_POW_53 = 2 ** 53;

/**
 * cyrb53: a well-mixed 53-bit string hash.
 *
 * @param text - The text.
 * @returns An integer in [0, 2⁵³).
 */
export function combatHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A uniform number in [0, 1) for a text.
 *
 * @param text - The key text.
 * @returns The number.
 */
function unitOf(text: string): number {
  return combatHash(text) / TWO_POW_53;
}

/**
 * A shot's roll: the hash of `seed|ship|module|activation|cycle|target` over 2⁵³.
 *
 * @param seed - The document's combat seed.
 * @param key - The shot.
 * @returns A uniform roll in [0, 1).
 */
export function combatRoll(seed: number, key: CombatRollKey): number {
  return unitOf(`${seed}|${key.ship}|${key.module}|${key.activation}|${key.cycle}|${key.target}`);
}

/**
 * A keyed uniform number: the hash of `seed|key` over 2⁵³. The picks, the shuffles and set_hp's draws (`hp|<ship>|<target>`)
 * roll on it.
 *
 * @param seed - The combat seed.
 * @param key - What the roll is for.
 * @returns A uniform number in [0, 1).
 */
export function combatUnit(seed: number, key: string): number {
  return unitOf(`${seed}|${key}`);
}

/**
 * A keyed pick among `count` choices (an explosion variant).
 *
 * @param seed - The combat seed.
 * @param key - What the pick is for (`explosion|<ship>`).
 * @param count - How many choices.
 * @returns An index in [0, count); 0 when count is under 1.
 */
export function combatPick(seed: number, key: string, count: number): number {
  return count >= 1 ? Math.min(count - 1, Math.floor(combatUnit(seed, key) * Math.floor(count))) : 0;
}

/**
 * A keyed shuffle (which damage locators an explosion's local blasts use): Fisher-Yates with one keyed roll per place.
 *
 * @param seed - The combat seed.
 * @param key - What the shuffle is for.
 * @param items - The items.
 * @returns A shuffled copy.
 */
export function combatShuffle<T>(seed: number, key: string, items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(combatUnit(seed, `${key}|${index}`) * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}
