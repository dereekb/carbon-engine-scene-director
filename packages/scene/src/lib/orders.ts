import { SceneError, type SceneVector } from './scene';

/**
 * Live movement orders for a ship's Destiny ball (the `order_ship` tool). They are not part of the document yet; the
 * reserved ship `orders` field will reuse this normalizer when scripted orders arrive. The next movement phase adds
 * orbit, approach, keep-at-range and goto.
 */

export const SHIP_ORDER_TYPES = ['direction', 'stop'] as const;

export type ShipOrderType = (typeof SHIP_ORDER_TYPES)[number];

/**
 * Fly along a direction at a fraction of max velocity.
 */
export interface DirectionShipOrder {
  readonly type: 'direction';
  /**
   * World direction; any non-zero length.
   */
  readonly direction: SceneVector;
  /**
   * Fraction of max velocity, in (0, 1].
   */
  readonly speed: number;
}

/**
 * Decelerate to a halt.
 */
export interface StopShipOrder {
  readonly type: 'stop';
}

export type ShipOrder = DirectionShipOrder | StopShipOrder;

const ORDER_KEYS: Record<ShipOrderType, ReadonlySet<string>> = {
  direction: new Set(['type', 'direction', 'speed']),
  stop: new Set(['type'])
};

/**
 * Validates a movement order.
 *
 * @param input - The order as JSON.
 * @returns The order with its defaults filled in.
 * @throws {SceneError} With every problem found.
 */
export function normalizeShipOrder(input: unknown): ShipOrder {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new SceneError(['order must be an object']);
  const record = input as Record<string, unknown>;
  const type = record['type'];
  if (!SHIP_ORDER_TYPES.includes(type as ShipOrderType)) throw new SceneError([`order.type must be one of ${SHIP_ORDER_TYPES.join(', ')}`]);

  const problems: string[] = [];
  const orderType = type as ShipOrderType;
  for (const key of Object.keys(record)) if (!ORDER_KEYS[orderType].has(key)) problems.push(`order.${key} is not a ${orderType} order field`);

  let order: ShipOrder;
  if (orderType === 'direction') {
    const direction = record['direction'];
    let vector: SceneVector = [0, 0, 1];
    if (Array.isArray(direction) && direction.length === 3 && direction.every((component) => typeof component === 'number' && Number.isFinite(component))) {
      vector = [direction[0], direction[1], direction[2]];
      if (vector.every((component) => component === 0)) problems.push('order.direction must not be zero');
    } else {
      problems.push('order.direction must be an array of three finite numbers');
    }
    const speed = record['speed'] ?? 1;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 1) problems.push('order.speed must be a number in (0, 1]');
    order = { type: 'direction', direction: vector, speed: typeof speed === 'number' ? speed : 1 };
  } else {
    order = { type: 'stop' };
  }

  if (problems.length) throw new SceneError(problems);
  return order;
}
