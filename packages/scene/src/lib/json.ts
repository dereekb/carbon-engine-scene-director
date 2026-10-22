/**
 * The JSON readers the document normalizers share. Internal to the package: the scene and fleet
 * normalizers both import them, so neither has to import the other at run time.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from './scene';

export type JsonObject = Record<string, unknown>;

export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * SOF DNA: hull:faction:race, then optional `:command?args` segments.
 */
export const DNA_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+(:\S+)*$/u;

/**
 * The longest EVE type name a ship's `type` may give.
 */
export const MAX_TYPE_NAME_LENGTH = 100;

/**
 * Warns about each key the object has that is not allowed; normalizers drop them by copying only known keys.
 *
 * @param object - The candidate object.
 * @param allowed - Its known keys.
 * @param where - Where it sits, for messages.
 * @param warnings - Receives one warning per unknown key.
 */
export function reportUnknownKeys(object: JsonObject, allowed: Set<string>, where: string, warnings: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) warnings.push(`${where}.${key} is not a known field and was dropped`);
  }
}

/**
 * Reads a non-empty string.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is not a non-empty string.
 * @returns The trimmed string, or an empty string.
 */
export function readString(value: unknown, where: string, problems: string[]): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  problems.push(`${where} must be a non-empty string`);
  return '';
}

/**
 * Reads an id: a non-empty string matching ID_PATTERN.
 *
 * @param value - The candidate id.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when the id is invalid.
 * @returns The trimmed id, or an empty string when it is not a string.
 */
export function readId(value: unknown, where: string, problems: string[]): string {
  const id = readString(value, where, problems);
  if (id && !ID_PATTERN.test(id)) problems.push(`${where} must be 1-64 letters, digits, "_", "-" or "."`);
  return id;
}

/**
 * Reads a finite number, optionally within bounds.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is out of bounds or not a finite number.
 * @param bounds - The inclusive bounds.
 * @returns The number, or 0.
 */
export function readNumber(value: unknown, where: string, problems: string[], { min = -Infinity, max = Infinity }: { readonly min?: number; readonly max?: number } = {}): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
  const range = min > -Infinity || max < Infinity ? ` in [${min}, ${max}]` : '';
  problems.push(`${where} must be a finite number${range}`);
  return 0;
}

/**
 * Whether a value is a JSON object (not null, not an array).
 *
 * @param value - The candidate.
 * @returns Whether it is an object.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether two values serialize to the same JSON.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns Whether their JSON is equal.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reads an optional non-empty string: null or undefined is absent.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is present but not a non-empty string.
 * @returns The trimmed string, or null when absent.
 */
export function readOptionalString(value: unknown, where: string, problems: string[]): Maybe<string> {
  return value == null ? null : readString(value, where, problems);
}

/**
 * Reads an optional list: null or undefined is an empty list.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is present but not an array.
 * @returns The list, or an empty list.
 */
export function readList(value: unknown, where: string, problems: string[]): unknown[] {
  let list: unknown[] = [];
  if (Array.isArray(value)) list = value;
  else if (value != null) problems.push(`${where} must be an array`);
  return list;
}

/**
 * Reads the EVE type a ship flies as: a positive type id, or an EVE type name of at most MAX_TYPE_NAME_LENGTH.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is neither.
 * @returns The type id or trimmed name, or an empty string.
 */
export function readShipType(value: unknown, where: string, problems: string[]): number | string {
  let type: number | string = '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) type = value;
  else if (typeof value === 'string' && value.trim() && value.trim().length <= MAX_TYPE_NAME_LENGTH) type = value.trim();
  else problems.push(`${where} must be a positive integer type id or an EVE type name`);
  return type;
}

/**
 * Reads a position or rotation: three finite numbers.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is not three finite numbers.
 * @returns The vector, or the origin.
 */
export function readVector(value: unknown, where: string, problems: string[]): SceneVector {
  if (Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component))) {
    return [value[0], value[1], value[2]];
  }
  problems.push(`${where} must be an array of three finite numbers`);
  return [0, 0, 0];
}
