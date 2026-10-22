import { SceneError, type SceneVector } from './scene';

/**
 * Live movement orders for a ship's Destiny ball (the `order_ship` tool): fly a direction, fly to a world point
 * (`goto`), approach a target ship, keep at range on it, orbit it, or stop. Ranges are metres surface to surface
 * between the two ships' Destiny balls (EVE's radii), exactly what Destiny takes. `order_ship` also takes the fleet
 * order `rejoin` (a fleet member that left its formation anchors up again): {@link normalizeShipOrderRequest}. The
 * orders are not part of the document yet; the reserved ship `orders` field will reuse normalizeShipOrderRequest
 * (so a script can rejoin), passing a {@link ShipOrderContext} with the scene's ship ids, the ordered ship and its own
 * message prefix.
 */

export const SHIP_ORDER_TYPES = ['direction', 'goto', 'approach', 'keep-at-range', 'orbit', 'stop'] as const;

export type ShipOrderType = (typeof SHIP_ORDER_TYPES)[number];

/**
 * Fleet orders order_ship takes beside the movement orders.
 */
export const FLEET_SHIP_ORDER_TYPES = ['rejoin'] as const;

/**
 * Every order type order_ship takes.
 */
export const SHIP_ORDER_REQUEST_TYPES = [...SHIP_ORDER_TYPES, ...FLEET_SHIP_ORDER_TYPES] as const;

export type ShipOrderRequestType = (typeof SHIP_ORDER_REQUEST_TYPES)[number];

/**
 * The orders that fly relative to another ship.
 */
export const TARGET_SHIP_ORDER_TYPES = ['approach', 'keep-at-range', 'orbit'] as const;

export type TargetShipOrderType = (typeof TARGET_SHIP_ORDER_TYPES)[number];

/**
 * Metres, surface to surface: EVE's client approaches with FollowBall at 50 m.
 */
export const APPROACH_RANGE = 50;

/**
 * Metres: the longest keep-at-range or orbit range an order may ask for.
 */
export const MAX_ORDER_RANGE = 1_000_000;

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
 * Fly to a world point and slow to a halt near it (Destiny's GotoPoint).
 */
export interface GotoShipOrder {
  readonly type: 'goto';
  /**
   * World position, metres.
   */
  readonly point: SceneVector;
  /**
   * Fraction of max velocity, in (0, 1].
   */
  readonly speed: number;
}

/**
 * Close on a target ship (Destiny's FollowBall at {@link APPROACH_RANGE}).
 */
export interface ApproachShipOrder {
  readonly type: 'approach';
  /**
   * The target ship's id.
   */
  readonly target: string;
  /**
   * Fraction of max velocity, in (0, 1].
   */
  readonly speed: number;
}

/**
 * Hold a range on a target ship, following it (Destiny's FollowBall at the range). A fleet member following its fleet
 * reports itself as this order on its anchor at the anchor's range, flown by formation steering (a goto on its slot
 * each tick) rather than FollowBall.
 */
export interface KeepAtRangeShipOrder {
  readonly type: 'keep-at-range';
  /**
   * The target ship's id.
   */
  readonly target: string;
  /**
   * Metres, surface to surface, in [0, {@link MAX_ORDER_RANGE}].
   */
  readonly range: number;
  /**
   * Fraction of max velocity, in (0, 1].
   */
  readonly speed: number;
}

/**
 * Circle a target ship at a range (Destiny's Orbit). Fast ships settle a little wider than the range, as in EVE.
 */
export interface OrbitShipOrder {
  readonly type: 'orbit';
  /**
   * The target ship's id.
   */
  readonly target: string;
  /**
   * Metres, surface to surface, in [0, {@link MAX_ORDER_RANGE}].
   */
  readonly range: number;
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

export type TargetShipOrder = ApproachShipOrder | KeepAtRangeShipOrder | OrbitShipOrder;

export type ShipOrder = DirectionShipOrder | GotoShipOrder | TargetShipOrder | StopShipOrder;

/**
 * A fleet member that left its formation (an explicit order) anchors up on its fleet again.
 */
export interface RejoinShipOrder {
  readonly type: 'rejoin';
}

/**
 * What order_ship takes: a movement order for the ship's ball, or a fleet order.
 */
export type ShipOrderRequest = ShipOrder | RejoinShipOrder;

/**
 * What the normalizer checks an order against.
 */
export interface ShipOrderContext {
  /**
   * The scene's ship ids: a target must be one of them. Unchecked when absent.
   */
  readonly ships?: ReadonlySet<string>;
  /**
   * The ordered ship: a ship cannot target itself.
   */
  readonly self?: string;
  /**
   * Message prefix, default `order` (scripted orders pass e.g. `ships[2].orders[0]`).
   */
  readonly where?: string;
}

const ORDER_KEYS: Readonly<Record<ShipOrderType, ReadonlySet<string>>> = {
  direction: new Set(['type', 'direction', 'speed']),
  goto: new Set(['type', 'point', 'speed']),
  approach: new Set(['type', 'target', 'speed']),
  'keep-at-range': new Set(['type', 'target', 'range', 'speed']),
  orbit: new Set(['type', 'target', 'range', 'speed']),
  stop: new Set(['type'])
};

const TARGET_TYPES: ReadonlySet<ShipOrderType> = new Set(TARGET_SHIP_ORDER_TYPES);

/**
 * Whether an order flies relative to another ship.
 *
 * @param order - A normalized order.
 * @returns True for approach, keep-at-range and orbit.
 */
export function isTargetShipOrder(order: ShipOrder): order is TargetShipOrder {
  return TARGET_TYPES.has(order.type);
}

interface OrderReader {
  readonly record: Record<string, unknown>;
  readonly where: string;
  readonly problems: string[];
}

function readVector(reader: OrderReader, key: 'direction' | 'point'): SceneVector {
  const value = reader.record[key];
  let vector: SceneVector = [0, 0, 1];
  if (Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component))) {
    vector = [value[0], value[1], value[2]];
    if (key === 'direction' && vector.every((component) => component === 0)) reader.problems.push(`${reader.where}.direction must not be zero`);
  } else {
    reader.problems.push(`${reader.where}.${key} must be an array of three finite numbers`);
  }
  return vector;
}

function readTarget(reader: OrderReader, context: ShipOrderContext): string {
  const value = reader.record['target'];
  const target = typeof value === 'string' ? value.trim() : '';
  if (!target) reader.problems.push(`${reader.where}.target must be a ship id`);
  else if (target === context.self) reader.problems.push(`${reader.where}.target must be another ship, not "${target}" itself`);
  else if (context.ships && !context.ships.has(target)) reader.problems.push(`${reader.where}.target "${target}" is not a ship in the scene`);
  return target;
}

function readRange(reader: OrderReader): number {
  const value = reader.record['range'];
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_ORDER_RANGE;
  if (!valid) reader.problems.push(`${reader.where}.range must be a number of metres in [0, ${MAX_ORDER_RANGE}]`);
  return valid ? value : 0;
}

function readSpeed(reader: OrderReader): number {
  const value = reader.record['speed'] ?? 1;
  const valid = typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
  if (!valid) reader.problems.push(`${reader.where}.speed must be a number in (0, 1]`);
  return valid ? value : 1;
}

function readOrder(reader: OrderReader, type: ShipOrderType, context: ShipOrderContext): ShipOrder {
  let order: ShipOrder;
  switch (type) {
    case 'direction':
      order = { type, direction: readVector(reader, 'direction'), speed: readSpeed(reader) };
      break;
    case 'goto':
      order = { type, point: readVector(reader, 'point'), speed: readSpeed(reader) };
      break;
    case 'approach':
      order = { type, target: readTarget(reader, context), speed: readSpeed(reader) };
      break;
    case 'keep-at-range':
    case 'orbit':
      order = { type, target: readTarget(reader, context), range: readRange(reader), speed: readSpeed(reader) };
      break;
    case 'stop':
      order = { type };
      break;
  }
  return order;
}

/**
 * Validates a movement order.
 *
 * @param input - The order as JSON.
 * @param context - The scene's ship ids, the ordered ship and the message prefix.
 * @returns The order with its defaults filled in and its strings trimmed.
 * @throws {SceneError} With every problem found.
 */
export function normalizeShipOrder(input: unknown, context: ShipOrderContext = {}): ShipOrder {
  const where = context.where ?? 'order';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new SceneError([`${where} must be an object`]);
  const record = input as Record<string, unknown>;
  const type = record['type'];
  if (!SHIP_ORDER_TYPES.includes(type as ShipOrderType)) throw new SceneError([`${where}.type must be one of ${SHIP_ORDER_TYPES.join(', ')}`]);

  const orderType = type as ShipOrderType;
  const reader: OrderReader = { record, where, problems: [] };
  const article = /^[aeiou]/.test(orderType) ? 'an' : 'a';
  for (const key of Object.keys(record)) if (!ORDER_KEYS[orderType].has(key)) reader.problems.push(`${where}.${key} is not ${article} ${orderType} order field`);

  const order = readOrder(reader, orderType, context);
  if (reader.problems.length) throw new SceneError(reader.problems);
  return order;
}

/**
 * Validates what order_ship takes: a movement order (normalizeShipOrder) or the fleet order `rejoin`, which has no
 * fields.
 *
 * @param input - The order as JSON.
 * @param context - The scene's ship ids, the ordered ship and the message prefix.
 * @returns The order with its defaults filled in and its strings trimmed.
 * @throws {SceneError} With every problem found; an unknown type lists SHIP_ORDER_REQUEST_TYPES.
 */
export function normalizeShipOrderRequest(input: unknown, context: ShipOrderContext = {}): ShipOrderRequest {
  const where = context.where ?? 'order';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new SceneError([`${where} must be an object`]);
  const record = input as Record<string, unknown>;
  const type = record['type'];
  if (!SHIP_ORDER_REQUEST_TYPES.includes(type as ShipOrderRequestType)) throw new SceneError([`${where}.type must be one of ${SHIP_ORDER_REQUEST_TYPES.join(', ')}`]);
  if (type !== 'rejoin') return normalizeShipOrder(input, context);

  const problems = Object.keys(record)
    .filter((key) => key !== 'type')
    .map((key) => `${where}.${key} is not a rejoin order field`);
  if (problems.length) throw new SceneError(problems);
  return { type: 'rejoin' };
}
