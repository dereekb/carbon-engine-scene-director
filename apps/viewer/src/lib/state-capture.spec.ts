import { describe, expect, it } from 'vitest';
import { CaptureFields, CloneState, EstimateBytes, RestoreFields } from './state-capture';

class Cycle {
  state = 'off';
  cycles = 0;
}

class Owner {
  readonly port = { Now: (): number => 0 };
  readonly tickSeconds = 1;
  readonly ships = new Map<string, { hp: number; tags: Set<string> }>();
  readonly order: string[] = [];
  readonly samples = new Float64Array(3);
  cycle = new Cycle();
  total = 0;
  memo: Maybe<Map<string, number>> = null;
  frozen: Record<string, number> = { a: 1 };
}

type Maybe<T> = T | null;

const OPTIONS = { wiring: ['port', 'tickSeconds'], reset: { memo: (): null => null }, shared: ['frozen'], prototypes: [Cycle.prototype] };

describe('CloneState', () => {
  it('copies plain data, Map and Set order, typed arrays, bigint, NaN and ±Infinity', () => {
    const value = {
      n: NaN,
      inf: Infinity,
      ninf: -Infinity,
      big: 2n ** 70n,
      s: 'x',
      u: undefined,
      list: [1, [2]],
      map: new Map([
        ['b', 1],
        ['a', 2]
      ]),
      set: new Set([3, 1, 2]),
      f32: new Float32Array([1.5, 2]),
      nul: Object.assign(Object.create(null), { k: 1 })
    };
    const copy = CloneState(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect([...copy.map.keys()]).toEqual(['b', 'a']);
    expect([...copy.set]).toEqual([3, 1, 2]);
    expect(copy.f32).toBeInstanceOf(Float32Array);
    expect(copy.f32).not.toBe(value.f32);
    expect(copy.list[1]).not.toBe(value.list[1]);
    expect(Object.getPrototypeOf(copy.nul)).toBeNull();
    expect(Object.is(copy.n, NaN)).toBe(true);
  });

  it('keeps shared references and cycles shared within one capture, and across captures given one memo', () => {
    const shared = { hp: 1 };
    const value: { a: object; b: object; self?: unknown } = { a: shared, b: shared };
    value.self = value;
    const copy = CloneState(value);
    expect(copy.a).toBe(copy.b);
    expect(copy.self).toBe(copy);
    const memo = new Map<object, unknown>();
    const one = CloneState({ x: shared }, [], memo);
    const two = CloneState({ y: shared }, [], memo);
    expect(one.x).toBe(two.y);
  });

  it('recreates allowed prototypes and throws on functions and foreign prototypes, naming where', () => {
    const cycle = new Cycle();
    cycle.cycles = 3;
    const copy = CloneState({ cycle }, [Cycle.prototype]);
    expect(copy.cycle).toBeInstanceOf(Cycle);
    expect(copy.cycle).not.toBe(cycle);
    expect(copy.cycle.cycles).toBe(3);
    expect(() => CloneState({ cycle })).toThrow(/a Cycle at \.cycle is not plain state/);
    expect(() => CloneState({ ships: new Map([['a', { cb: () => 1 }]]) })).toThrow(/a function at \.ships\.a\.cb/);
    expect(() => CloneState({ list: [new Date()] })).toThrow(/a Date at \.list\[0\]/);
  });
});

describe('CaptureFields / RestoreFields', () => {
  function Drive(owner: Owner): void {
    owner.ships.set('a', { hp: 10, tags: new Set(['x']) });
    owner.order.push('a');
    owner.samples.set([1, 2, 3]);
    owner.cycle.cycles = 2;
    owner.total = 5;
    owner.memo = new Map([['a', 1]]);
  }

  it('captures every field but the wiring and the reset ones', () => {
    const owner = new Owner();
    Drive(owner);
    const record = CaptureFields(owner, OPTIONS);
    expect(Object.keys(record).sort()).toEqual(['cycle', 'frozen', 'order', 'samples', 'ships', 'total']);
  });

  it('restores in place, keeps container identity and resets memos', () => {
    const owner = new Owner();
    Drive(owner);
    const record = CaptureFields(owner, OPTIONS);
    const ships = owner.ships;
    const order = owner.order;
    const samples = owner.samples;
    owner.ships.get('a')!.hp = 1;
    owner.ships.set('b', { hp: 2, tags: new Set() });
    owner.order.push('b');
    owner.samples[0] = 9;
    owner.cycle.cycles = 7;
    owner.total = 9;
    RestoreFields(owner, record, OPTIONS);
    expect(owner.ships).toBe(ships);
    expect(owner.order).toBe(order);
    expect(owner.samples).toBe(samples);
    expect([...owner.ships.keys()]).toEqual(['a']);
    expect(owner.ships.get('a')!.hp).toBe(10);
    expect(owner.order).toEqual(['a']);
    expect([...owner.samples]).toEqual([1, 2, 3]);
    expect(owner.cycle).toBeInstanceOf(Cycle);
    expect(owner.cycle.cycles).toBe(2);
    expect(owner.total).toBe(5);
    expect(owner.memo).toBeNull();
  });

  it('never lets the owner change the record, before or after a restore', () => {
    const owner = new Owner();
    Drive(owner);
    const record = CaptureFields(owner, OPTIONS);
    const dump = structuredClone(record);
    owner.ships.get('a')!.tags.add('y');
    RestoreFields(owner, record, OPTIONS);
    owner.ships.get('a')!.hp = 0;
    owner.ships.get('a')!.tags.add('z');
    owner.cycle.cycles = 99;
    expect(record).toEqual(dump);
  });

  it('copies shared keys one level: a new container, the same values', () => {
    const owner = new Owner();
    const value = { deep: 1 };
    const frozen: Record<string, unknown> = { a: value };
    (owner as unknown as { frozen: unknown }).frozen = frozen;
    const record = CaptureFields(owner, OPTIONS);
    expect(record['frozen']).not.toBe(frozen);
    expect((record['frozen'] as Record<string, unknown>)['a']).toBe(value);
  });

  it('refuses options naming a field the owner lacks, a non-record, and wired-in functions it was not told about', () => {
    const owner = new Owner();
    expect(() => CaptureFields(owner, { wiring: ['port', 'tickSeconds', 'nope'] })).toThrow(/Owner has no field "nope"/);
    expect(() => RestoreFields(owner, null, OPTIONS)).toThrow(/not a captured record/);
    expect(() => CaptureFields(owner, { wiring: ['tickSeconds'], prototypes: [Cycle.prototype] })).toThrow(/a function at \.port\.Now/);
  });
});

describe('EstimateBytes', () => {
  it('counts slots, headers, string characters and typed array bytes, each object once', () => {
    expect(EstimateBytes(1)).toBe(8);
    expect(EstimateBytes({ a: 1, b: 'xy' })).toBe(8 + 16 + 16 + 4);
    expect(EstimateBytes(new Float64Array(4))).toBe(8 + 16 + 32);
    expect(EstimateBytes(new Map([['k', 1]]))).toBe(8 + 16 + 16 + 2);
    const shared = { n: 1 };
    expect(EstimateBytes([shared, shared])).toBe(8 + 16 + 16 + 16 + 8);
  });
});
