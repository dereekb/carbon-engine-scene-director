import { describe, expect, it } from 'vitest';
import { normalizeShipOrder, SHIP_ORDER_TYPES } from './orders';
import { SceneError } from './scene';
import { findTool } from './tools';

function Problems(input: unknown): string[] {
  try {
    normalizeShipOrder(input);
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

  it('is a page tool whose schema lists the order types', () => {
    const tool = findTool('order_ship');
    expect(tool?.where).toBe('page');
    expect(tool?.inputSchema.required).toEqual(['id', 'order']);
    expect(JSON.stringify(tool?.inputSchema)).toContain(JSON.stringify([...SHIP_ORDER_TYPES]));
  });
});
