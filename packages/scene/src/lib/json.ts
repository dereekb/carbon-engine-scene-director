/**
 * The JSON readers the document normalizers share. Internal to the package: the scene and fleet
 * normalizers both import them, so neither has to import the other at run time.
 */

export type JsonObject = Record<string, unknown>;

export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

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
