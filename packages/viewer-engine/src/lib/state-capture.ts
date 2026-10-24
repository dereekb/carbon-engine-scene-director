/**
 * Snapshots of our per-tick state (sd-time): one generic field capture that every owner's Snapshot() / Restore() is a
 * one-liner over. CaptureFields deep-copies every own enumerable field of an owner except its wiring (the constructor's
 * collaborators and constants), so a field an owner gains later joins its snapshot by itself; RestoreFields copies a
 * record back, refilling Map, Set, array and typed-array containers in place. CloneState is the copy: plain data only,
 * plus the class instances an owner names. It throws on a function or any other prototype, which is how a runtime
 * object sneaking into an owner is caught in the specs. EstimateBytes sizes a record for the time window's budget.
 *
 * Node-tested (state-capture.spec.ts): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';

/**
 * What one owner's capture leaves out or treats specially. Every name must be an own field of the owner.
 */
export interface CaptureOptions {
  /**
   * Constructor-injected collaborators (ports, the world, callbacks) and constants: never captured or restored.
   */
  readonly wiring?: readonly string[];
  /**
   * Fields whose values are immutable (replaced, never mutated): the container is copied, its values shared.
   */
  readonly shared?: readonly string[];
  /**
   * Memo fields: not captured; Restore sets each to its factory's value.
   */
  readonly reset?: Readonly<Record<string, () => unknown>>;
  /**
   * The prototypes of the class instances the owner holds as state (e.g. ModuleCycle.prototype): recreated with
   * Object.create and their own fields copied.
   */
  readonly prototypes?: readonly object[];
}

/**
 * One capture's copies by original object. Passing the same memo to several captures (the director capturing every
 * owner in one pass) keeps an object shared between owners shared in the copy.
 */
export type CloneMemo = Map<object, unknown>;

/**
 * An owner's captured fields, by name.
 */
export type CapturedFields = Readonly<Record<string, unknown>>;

/**
 * Deep-copies plain state: primitives (bigint, NaN and ±Infinity included), plain and null-prototype objects, arrays,
 * Map, Set, typed arrays, and instances of the allowed prototypes. A value reached twice is copied once, so shared
 * references and cycles survive.
 *
 * @param value - The state.
 * @param prototypes - The class prototypes allowed besides plain data.
 * @param memo - The copies made so far in this capture.
 * @returns The copy.
 * @throws {TypeError} For a function, a symbol, or an object of any other prototype, naming where it was found.
 */
export function CloneState<T>(value: T, prototypes: readonly object[] = [], memo: CloneMemo = new Map()): T {
  const path: (string | number)[] = [];
  return Clone(value, new Set(prototypes), memo, path) as T;
}

function Clone(value: unknown, prototypes: ReadonlySet<object>, memo: CloneMemo, path: (string | number)[]): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`CloneState: a ${typeof value} at ${PathText(path)} is not plain state`);
  if (value === null || typeof value !== 'object') return value;
  const known = memo.get(value);
  if (known !== undefined) return known;
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) throw new TypeError(`CloneState: a DataView at ${PathText(path)} is not plain state`);
    const copy = (value as unknown as Float64Array).slice();
    memo.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    memo.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = Step(value[i], i, prototypes, memo, path);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    memo.set(value, copy);
    let i = 0;
    for (const [key, item] of value) {
      copy.set(Step(key, `<key ${i}>`, prototypes, memo, path), Step(item, typeof key === 'string' || typeof key === 'number' ? key : `<value ${i}>`, prototypes, memo, path));
      i++;
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    memo.set(value, copy);
    let i = 0;
    for (const item of value) copy.add(Step(item, `<item ${i++}>`, prototypes, memo, path));
    return copy;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !prototypes.has(proto as object)) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    throw new TypeError(`CloneState: a ${name} at ${PathText(path)} is not plain state (wire it, or allow its prototype)`);
  }
  const copy = Object.create(proto as object | null) as Record<string, unknown>;
  memo.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = Step((value as Record<string, unknown>)[key], key, prototypes, memo, path);
  return copy;
}

function Step(value: unknown, key: string | number, prototypes: ReadonlySet<object>, memo: CloneMemo, path: (string | number)[]): unknown {
  path.push(key);
  const copy = Clone(value, prototypes, memo, path);
  path.pop();
  return copy;
}

function PathText(path: readonly (string | number)[]): string {
  return path.length === 0 ? 'the top' : path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${key}`)).join('');
}

/**
 * Captures an owner's state: a deep copy of every own enumerable field except its wiring and reset fields.
 *
 * @param owner - The owner.
 * @param options - Its wiring, shared, reset and prototypes.
 * @param memo - A memo shared with other captures of the same snapshot.
 * @returns The record.
 * @throws {TypeError} When a field holds a function or a foreign object, or an option names a field the owner lacks.
 */
export function CaptureFields(owner: object, options: CaptureOptions = {}, memo: CloneMemo = new Map()): CapturedFields {
  const fields = owner as Record<string, unknown>;
  RequireOwnFields(owner, options);
  const skip = new Set([...(options.wiring ?? []), ...Object.keys(options.reset ?? {})]);
  const shared = new Set(options.shared ?? []);
  const prototypes = new Set(options.prototypes ?? []);
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (skip.has(key)) continue;
    record[key] = shared.has(key) ? ShallowCopy(fields[key]) : Step(fields[key], key, prototypes, memo, []);
  }
  return record;
}

/**
 * Restores an owner from a record CaptureFields made, copying it again so the record stays pristine. Map, Set, array and
 * same-length typed-array fields are refilled in place (their identity kept); other fields are assigned; reset fields
 * take their factories' values.
 *
 * @param owner - The owner.
 * @param record - Its record.
 * @param options - The options it was captured with.
 * @param memo - A memo shared with other restores of the same snapshot.
 * @throws {TypeError} When the record is not one, or an option names a field the owner lacks.
 */
export function RestoreFields(owner: object, record: unknown, options: CaptureOptions = {}, memo: CloneMemo = new Map()): void {
  if (record === null || typeof record !== 'object' || Object.getPrototypeOf(record) !== Object.prototype) throw new TypeError('RestoreFields: the snapshot is not a captured record');
  RequireOwnFields(owner, options);
  const fields = owner as Record<string, unknown>;
  const skip = new Set([...(options.wiring ?? []), ...Object.keys(options.reset ?? {})]);
  const shared = new Set(options.shared ?? []);
  const prototypes = new Set(options.prototypes ?? []);
  for (const key of Object.keys(record)) {
    if (skip.has(key)) continue;
    const saved = (record as Record<string, unknown>)[key];
    Refill(fields, key, shared.has(key) ? ShallowCopy(saved) : Step(saved, key, prototypes, memo, []));
  }
  for (const [key, initial] of Object.entries(options.reset ?? {})) fields[key] = initial();
}

function RequireOwnFields(owner: object, options: CaptureOptions): void {
  for (const key of [...(options.wiring ?? []), ...(options.shared ?? []), ...Object.keys(options.reset ?? {})]) {
    if (!Object.prototype.hasOwnProperty.call(owner, key)) throw new TypeError(`state capture: ${owner.constructor.name} has no field "${key}"`);
  }
}

/**
 * Puts a restored value into a field, keeping the field's container when both are the same kind.
 */
function Refill(fields: Record<string, unknown>, key: string, value: unknown): void {
  const current = fields[key];
  if (current instanceof Map && value instanceof Map) {
    current.clear();
    for (const [k, v] of value) current.set(k, v);
  } else if (current instanceof Set && value instanceof Set) {
    current.clear();
    for (const v of value) current.add(v);
  } else if (Array.isArray(current) && Array.isArray(value) && !Object.isFrozen(current)) {
    current.length = 0;
    for (const v of value) current.push(v);
  } else if (ArrayBuffer.isView(current) && ArrayBuffer.isView(value) && current.constructor === value.constructor && (current as Float64Array).length === (value as Float64Array).length) {
    (current as Float64Array).set(value as Float64Array);
  } else {
    fields[key] = value;
  }
}

/**
 * A new container holding the same values (one level), or the value itself when it is no container.
 */
function ShallowCopy(value: unknown): unknown {
  if (value instanceof Map) return new Map(value);
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return { ...value };
  return value;
}

/**
 * Bytes per slot (an object property, an array element, a Map key or value, a Set item) in EstimateBytes.
 */
const SLOT_BYTES = 8;
/**
 * Bytes per object, array, Map or Set header.
 */
const OBJECT_BYTES = 16;

/**
 * A structural size estimate for the time window's byte budget: 16 B per object or container plus 8 B per slot (a Map
 * entry is two), 2 B more per string character, a typed array's byte length. A value reached twice counts once.
 *
 * @param value - The state.
 * @returns Bytes.
 */
export function EstimateBytes(value: unknown): number {
  const seen = new Set<object>();
  let bytes = SLOT_BYTES;
  const stack: unknown[] = [value];
  const visit = (item: unknown): void => {
    if (typeof item === 'string') bytes += 2 * item.length;
    else if (item !== null && typeof item === 'object' && !seen.has(item)) stack.push(item);
  };
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') bytes += 2 * item.length;
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (ArrayBuffer.isView(item)) bytes += OBJECT_BYTES + item.byteLength;
    else if (item instanceof Map) {
      bytes += OBJECT_BYTES + 2 * SLOT_BYTES * item.size;
      for (const [k, v] of item) {
        visit(k);
        visit(v);
      }
    } else if (item instanceof Set) {
      bytes += OBJECT_BYTES + SLOT_BYTES * item.size;
      for (const v of item) visit(v);
    } else {
      const values: unknown[] = Array.isArray(item) ? item : Object.values(item);
      bytes += OBJECT_BYTES + SLOT_BYTES * values.length;
      for (const v of values) visit(v);
    }
  }
  return bytes;
}

/**
 * The first place two captured states differ (time control's drift check, sd-time): numbers compare exactly (NaN
 * equals NaN, 0 equals -0), arrays and typed arrays element by element, Maps and Sets in order, objects by their keys.
 *
 * @param a - One captured state (plain data, as CloneState makes it).
 * @param b - The other.
 * @param path - The path so far, for the message.
 * @returns Null when equal, else "path: a ≠ b".
 */
export function FirstDifference(a: unknown, b: unknown, path = ''): Maybe<string> {
  if (a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))) return null;
  const here = path || 'the state';
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${here}: ${Brief(a)} ≠ ${Brief(b)}`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${here}: different kinds`;
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    const left = a as ArrayLike<unknown>;
    const right = b as ArrayLike<unknown>;
    if (left.length !== right.length) return `${here}: ${left.length} ≠ ${right.length} entries`;
    for (let i = 0; i < left.length; i++) {
      const difference = FirstDifference(left[i], right[i], `${path}[${i}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (a instanceof Map || a instanceof Set) {
    const left = [...(a as Map<unknown, unknown>).entries()];
    const right = [...(b as Map<unknown, unknown>).entries()];
    if (left.length !== right.length) return `${here}: ${left.length} ≠ ${right.length} entries`;
    for (let i = 0; i < left.length; i++) {
      const key = String(left[i][0]);
      if (left[i][0] !== right[i][0]) return `${here}: key ${key} ≠ ${String(right[i][0])}`;
      const difference = FirstDifference(left[i][1], right[i][1], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const difference = FirstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    if (difference) return difference;
  }
  return null;
}

function Brief(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}
