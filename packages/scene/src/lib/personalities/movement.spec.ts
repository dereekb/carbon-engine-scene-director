import { describe, expect, it } from 'vitest';
import { isFleetMoveChange, toFleetMove, toFleetPropMods } from './movement';
import { hostile } from './personalities.spec-helper';

describe('toFleetMove', () => {
  const keep = (target: string, range: number) => ({ type: 'keep-at-range', target, range, speed: 1 });

  it('brawls and snipes at range on the focus, holds without an order', () => {
    expect(toFleetMove({ stance: 'brawl', range: 20_000, focus: hostile('h', 50_000), order: null })?.order).toEqual(keep('h', 20_000));
    expect(toFleetMove({ stance: 'snipe', range: 60_000, focus: hostile('h', 50_000), order: null })?.order).toEqual(keep('h', 60_000));
    expect(toFleetMove({ stance: 'hold', range: 20_000, focus: hostile('h', 50_000), order: null })).toBeNull();
    expect(toFleetMove({ stance: 'brawl', range: 20_000, focus: null, order: null })).toBeNull();
  });

  it('kites: keeps range beyond 1.1x, backs off inside 0.9x, and keeps what it flies in between', () => {
    const range = 30_000;
    expect(toFleetMove({ stance: 'kite', range, focus: hostile('h', 40_000), order: null })?.order).toEqual(keep('h', range));
    const away = toFleetMove({ stance: 'kite', range, focus: hostile('h', 20_000), order: null });
    expect(away?.order).toEqual({ type: 'direction', direction: [-1, 0, 0], speed: 1 });
    expect(away?.why).toContain('back off');
    const backing = { type: 'direction' as const, direction: [-1, 0, 0] as [number, number, number], speed: 1 };
    expect(toFleetMove({ stance: 'kite', range, focus: hostile('h', 31_000), order: backing })?.order.type).toBe('direction');
    expect(toFleetMove({ stance: 'kite', range, focus: hostile('h', 31_000), order: keep('h', range) as never })?.order.type).toBe('keep-at-range');
    expect(toFleetMove({ stance: 'kite', range, focus: hostile('h', 34_000), order: backing })?.order.type).toBe('keep-at-range');
  });
});

describe('isFleetMoveChange', () => {
  const keep = { type: 'keep-at-range' as const, target: 'h', range: 20_000, speed: 1 };

  it('changes on a new type or target, or a range moving by more than 10%', () => {
    expect(isFleetMoveChange(keep, null)).toBe(true);
    expect(isFleetMoveChange(keep, { ...keep, range: 21_000 })).toBe(false);
    expect(isFleetMoveChange(keep, { ...keep, range: 23_000 })).toBe(true);
    expect(isFleetMoveChange(keep, { ...keep, target: 'g' })).toBe(true);
    expect(isFleetMoveChange(keep, { type: 'stop' })).toBe(true);
  });

  it('changes a direction once it turns past about 25 degrees', () => {
    const direction = { type: 'direction' as const, direction: [1, 0, 0] as [number, number, number], speed: 1 };
    expect(isFleetMoveChange(direction, { ...direction, direction: [1, 0.2, 0] })).toBe(false);
    expect(isFleetMoveChange(direction, { ...direction, direction: [1, 1, 0] })).toBe(true);
  });
});

describe('toFleetPropMods', () => {
  const base = { stance: 'brawl' as const, range: 10_000, engaged: false };

  it('closing: on beyond 1.25x, off inside 1.1x, unchanged between', () => {
    expect(toFleetPropMods({ ...base, rule: 'closing', focus: hostile('h', 13_000), current: 'off' })?.active).toBe(true);
    expect(toFleetPropMods({ ...base, rule: 'closing', focus: hostile('h', 12_000), current: 'off' })?.active).toBe(false);
    expect(toFleetPropMods({ ...base, rule: 'closing', focus: hostile('h', 12_000), current: 'on' })?.active).toBe(true);
    expect(toFleetPropMods({ ...base, rule: 'closing', focus: hostile('h', 10_500), current: 'on' })?.active).toBe(false);
    expect(toFleetPropMods({ ...base, rule: 'closing', focus: null, current: 'on' })?.active).toBe(false);
  });

  it('always runs them while engaged; never never does; a hold never closes', () => {
    expect(toFleetPropMods({ ...base, rule: 'always', engaged: true, focus: hostile('h', 5000), current: 'off' })?.active).toBe(true);
    expect(toFleetPropMods({ ...base, rule: 'always', focus: hostile('h', 5000), current: 'on' })?.active).toBe(false);
    expect(toFleetPropMods({ ...base, rule: 'never', focus: hostile('h', 90_000), current: 'on' })?.active).toBe(false);
    expect(toFleetPropMods({ ...base, stance: 'hold', rule: 'closing', focus: hostile('h', 90_000), current: 'off' })?.active).toBe(false);
  });

  it('has nothing to switch when no member has a prop mod', () => {
    expect(toFleetPropMods({ ...base, rule: 'always', engaged: true, focus: hostile('h', 5000), current: 'none' })).toBeNull();
  });
});
