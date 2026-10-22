import { describe, expect, it } from 'vitest';
import { isTargetShipOrder, MAX_ORDER_RANGE, normalizeShipOrder, normalizeShipOrderRequest, SHIP_ORDER_REQUEST_TYPES, SHIP_ORDER_TYPES, type ShipOrderContext } from './orders';
import { SceneError } from './scene';
import { findTool } from './tools';

function Problems(input: unknown, context?: ShipOrderContext): string[] {
  try {
    normalizeShipOrder(input, context);
  } catch (error) {
    if (error instanceof SceneError) return error.problems;
    throw error;
  }
  throw new Error('the order was accepted');
}

describe('normalizeShipOrder', () => {
  it('accepts a direction order and defaults its speed to full', () => {
    expect(normalizeShipOrder({ type: 'direction', direction: [1, 0, 0] })).toEqual({ type: 'direction', direction: [1, 0, 0], speed: 1 });
    expect(normalizeShipOrder({ type: 'direction', direction: [0, -2, 3], speed: 0.25 })).toEqual({ type: 'direction', direction: [0, -2, 3], speed: 0.25 });
  });

  it('accepts a stop order', () => {
    expect(normalizeShipOrder({ type: 'stop' })).toEqual({ type: 'stop' });
  });

  it('refuses unknown types and non-objects', () => {
    expect(Problems({ type: 'warp' })).toEqual([`order.type must be one of ${SHIP_ORDER_TYPES.join(', ')}`]);
    expect(Problems(null)).toEqual(['order must be an object']);
    expect(Problems([1, 0, 0])).toEqual(['order must be an object']);
  });

  it('reports every problem in a direction order', () => {
    expect(Problems({ type: 'direction', direction: [0, 0, 0], speed: 2, target: 'x' })).toEqual(['order.target is not a direction order field', 'order.direction must not be zero', 'order.speed must be a number in (0, 1]']);
    expect(Problems({ type: 'direction', direction: [1, Number.NaN, 0], speed: 0 })).toEqual(['order.direction must be an array of three finite numbers', 'order.speed must be a number in (0, 1]']);
    expect(Problems({ type: 'stop', speed: 1 })).toEqual(['order.speed is not a stop order field']);
  });

  it('is a page tool whose schema lists the order request types', () => {
    const tool = findTool('order_ship');
    expect(tool?.where).toBe('page');
    expect(tool?.inputSchema.required).toEqual(['id', 'order']);
    expect(JSON.stringify(tool?.inputSchema)).toContain(JSON.stringify([...SHIP_ORDER_REQUEST_TYPES]));
  });

  it('refuses the fleet order rejoin: it is no ball order', () => {
    expect(Problems({ type: 'rejoin' })).toEqual([`order.type must be one of ${SHIP_ORDER_TYPES.join(', ')}`]);
  });
  it('accepts goto, approach, keep-at-range and orbit orders with their defaults', () => {
    expect(normalizeShipOrder({ type: 'goto', point: [3000, 400, -4000] })).toEqual({ type: 'goto', point: [3000, 400, -4000], speed: 1 });
    expect(normalizeShipOrder({ type: 'approach', target: ' anchor ' })).toEqual({ type: 'approach', target: 'anchor', speed: 1 });
    expect(normalizeShipOrder({ type: 'keep-at-range', target: 'a', range: 0 })).toEqual({ type: 'keep-at-range', target: 'a', range: 0, speed: 1 });
    expect(normalizeShipOrder({ type: 'orbit', target: 'a', range: 1_000_000, speed: 0.25 })).toEqual({ type: 'orbit', target: 'a', range: 1_000_000, speed: 0.25 });
    expect(normalizeShipOrder({ speed: 0.5, range: 2500, target: 'a', type: 'keep-at-range' })).toEqual({ type: 'keep-at-range', target: 'a', range: 2500, speed: 0.5 });
  });

  it("requires each order's point, target and range", () => {
    expect(Problems({ type: 'goto' })).toEqual(['order.point must be an array of three finite numbers']);
    expect(normalizeShipOrder({ type: 'goto', point: [0, 0, 0] })).toEqual({ type: 'goto', point: [0, 0, 0], speed: 1 });
    expect(Problems({ type: 'orbit', target: 'a' })).toEqual(['order.range must be a number of metres in [0, 1000000]']);
    expect(Problems({ type: 'keep-at-range', target: 'a' })).toEqual(['order.range must be a number of metres in [0, 1000000]']);
    expect(Problems({ type: 'approach' })).toEqual(['order.target must be a ship id']);
    expect(Problems({ type: 'approach', target: '' })).toEqual(['order.target must be a ship id']);
    expect(Problems({ type: 'orbit', target: 3, range: 100 })).toEqual(['order.target must be a ship id']);
  });

  it('bounds the range', () => {
    for (const range of [-1, 1_000_001, Number.NaN, '5000']) expect(Problems({ type: 'orbit', target: 'a', range })).toEqual(['order.range must be a number of metres in [0, 1000000]']);
  });

  it('refuses fields another order type takes', () => {
    expect(Problems({ type: 'approach', target: 'b', range: 100 })).toEqual(['order.range is not an approach order field']);
    expect(Problems({ type: 'goto', point: [1, 2, 3], target: 'b' })).toEqual(['order.target is not a goto order field']);
    expect(Problems({ type: 'orbit', target: 'b', range: 1, point: [1, 2, 3] })).toEqual(['order.point is not an orbit order field']);
  });

  it('checks targets against the context', () => {
    const ships = new Set(['a', 'b']);
    expect(Problems({ type: 'orbit', target: 'z', range: 100 }, { ships })).toEqual(['order.target "z" is not a ship in the scene']);
    expect(Problems({ type: 'approach', target: 'a' }, { ships, self: 'a' })).toEqual(['order.target must be another ship, not "a" itself']);
    expect(normalizeShipOrder({ type: 'approach', target: 'b' }, { ships, self: 'a' })).toEqual({ type: 'approach', target: 'b', speed: 1 });
    expect(normalizeShipOrder({ type: 'approach', target: 'anything' })).toEqual({ type: 'approach', target: 'anything', speed: 1 });
  });

  it("prefixes every problem with the context's where", () => {
    const problems = Problems({ type: 'orbit' }, { where: 'ships[0].orders[1]' });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(problem.startsWith('ships[0].orders[1].')).toBe(true);
    expect(Problems(7, { where: 'ships[0].orders[1]' })).toEqual(['ships[0].orders[1] must be an object']);
  });

  it('reports every problem together', () => {
    const problems = Problems({ type: 'orbit', target: 'a', range: -5, speed: 2, extra: 1 }, { self: 'a' });
    expect(problems).toHaveLength(4);
    expect(problems).toEqual(expect.arrayContaining(['order.extra is not an orbit order field', 'order.target must be another ship, not "a" itself', 'order.range must be a number of metres in [0, 1000000]', 'order.speed must be a number in (0, 1]']));
  });

  it('tells the target orders apart', () => {
    expect(isTargetShipOrder({ type: 'approach', target: 'a', speed: 1 })).toBe(true);
    expect(isTargetShipOrder({ type: 'keep-at-range', target: 'a', range: 1, speed: 1 })).toBe(true);
    expect(isTargetShipOrder({ type: 'orbit', target: 'a', range: 1, speed: 1 })).toBe(true);
    expect(isTargetShipOrder({ type: 'direction', direction: [1, 0, 0], speed: 1 })).toBe(false);
    expect(isTargetShipOrder({ type: 'goto', point: [1, 0, 0], speed: 1 })).toBe(false);
    expect(isTargetShipOrder({ type: 'stop' })).toBe(false);
  });

  it('describes point, target and range in the tool schema', () => {
    const order = (findTool('order_ship')?.inputSchema.properties as Record<string, { properties: Record<string, { maximum?: number }> }>)['order'];
    expect(Object.keys(order.properties)).toEqual(expect.arrayContaining(['point', 'target', 'range']));
    expect(order.properties['range'].maximum).toBe(MAX_ORDER_RANGE);
  });
});

describe('normalizeShipOrderRequest', () => {
  function RequestProblems(input: unknown): string[] {
    try {
      normalizeShipOrderRequest(input);
    } catch (error) {
      if (error instanceof SceneError) return error.problems;
      throw error;
    }
    throw new Error('the order was accepted');
  }

  it('accepts rejoin with no fields and passes movement orders to normalizeShipOrder', () => {
    expect(normalizeShipOrderRequest({ type: 'rejoin' })).toEqual({ type: 'rejoin' });
    expect(normalizeShipOrderRequest({ type: 'keep-at-range', target: ' a ', range: 500 }, { self: 'b' })).toEqual({ type: 'keep-at-range', target: 'a', range: 500, speed: 1 });
  });

  it('refuses rejoin fields, unknown types and non-objects', () => {
    expect(RequestProblems({ type: 'rejoin', target: 'x' })).toEqual(['order.target is not a rejoin order field']);
    expect(RequestProblems({ type: 'warp' })).toEqual([`order.type must be one of ${SHIP_ORDER_REQUEST_TYPES.join(', ')}`]);
    expect(RequestProblems('rejoin')).toEqual(['order must be an object']);
    expect(RequestProblems({ type: 'stop', speed: 1 })).toEqual(['order.speed is not a stop order field']);
  });
});
