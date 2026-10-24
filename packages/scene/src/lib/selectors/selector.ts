/**
 * The ship selector every lever that takes ships reads: one scope (`ships`, a `fleet` narrowed by `wing` or `squad`,
 * or `all` the scene) and filters that narrow it (`role`, `team`, `hull`, `state`, then a seeded `sample`). The
 * grammar is written once, in the sd-selectors ref; select.ts resolves it.
 */

import { MAX_COMBAT_SEED } from '../combat/document';
import { SQUAD_ROLES, type SquadRole } from '../fleets/fleet';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelectionParts } from '../fleets/selection';
import { isPlainObject, type JsonObject } from '../json';

/**
 * The live states a selector filters by. Each one but `destroyed` implies the ship is alive.
 */
export const SHIP_SELECTOR_STATES = ['alive', 'destroyed', 'damaged', 'undamaged', 'in-warp', 'on-grid'] as const;

export type ShipSelectorState = (typeof SHIP_SELECTOR_STATES)[number];

/**
 * A layer under this fraction of its max is damaged. Not 1: shields regenerate asymptotically, so a shield back from
 * 91 % reads damaged for minutes (as in EVE), not for ever.
 */
export const DAMAGED_FRACTION = 0.999;

/**
 * A seeded random sample of what the filters kept: exactly one of `count` and `percent`.
 */
export interface ShipSelectorSample {
  /**
   * How many to keep (all of them when fewer matched).
   */
  readonly count?: number;
  /**
   * The percent to keep, in (0, 100]: `round(n × percent / 100)`, at least 1 of a non-empty set.
   */
  readonly percent?: number;
  /**
   * The roll's seed; default the document's combat seed, so the same call keeps the same ships.
   */
  readonly seed?: number;
}

/**
 * A normalized selector: exactly one of `ships`, `fleet` (with `wing` or `squad`) and `all`; each filter as a list
 * (any entry matches; every filter given must pass), the sample last.
 */
export interface ShipSelector extends FleetSelection {
  /**
   * Every ship in the scene.
   */
  readonly all?: true;
  /**
   * Squad roles, lower case: ships outside squads have none.
   */
  readonly role?: readonly SquadRole[];
  /**
   * `ships[].team` values, matched case-insensitively.
   */
  readonly team?: readonly string[];
  /**
   * EVE ship type names or type ids, or ship group names ("Frigate", "Logistics Cruiser").
   */
  readonly hull?: readonly (string | number)[];
  readonly state?: readonly ShipSelectorState[];
  readonly sample?: ShipSelectorSample;
}

/**
 * The keys a selector takes.
 */
export const SHIP_SELECTOR_KEYS: readonly (keyof ShipSelector)[] = [...FLEET_SELECTION_KEYS, 'all', 'role', 'team', 'hull', 'state', 'sample'];

/**
 * The selector's shape, for a command's "must be an object" message.
 */
export const SHIP_SELECTOR_SHAPE = 'ships | fleet [, wing | squad] | all, role?, team?, hull?, state?, sample?';

const SAMPLE_KEYS = new Set<string>(['count', 'percent', 'seed']);
const PERCENT_TEXT = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/u;

/**
 * Reads a selector off a command or an operation: exactly one of `ships`, `fleet` and `all: true` (a filter alone never
 * means the whole scene); `wing` and `squad` need `fleet` and exclude each other; `role`, `team`, `hull` and `state`
 * take one value or a list; `sample` is a count, `"p%"` or `{ count | percent, seed? }`.
 *
 * @param record - The command or operation.
 * @param where - Where it sits, for messages.
 * @param problems - Receives every problem found.
 * @returns The normalized selector (empty when invalid).
 */
export function readShipSelector(record: JsonObject, where: string, problems: string[]): ShipSelector {
  const before = problems.length;
  const scopes = (['ships', 'fleet', 'all'] as const).filter((key) => record[key] != null);
  if (scopes.length !== 1) problems.push(`${where} needs exactly one of ships (ship ids), fleet (a fleet id, optionally with wing or squad) and all (every ship in the scene)`);
  const selector: { -readonly [K in keyof ShipSelector]: ShipSelector[K] } = { ...readFleetSelectionParts(record, where, problems) };
  if (record['all'] != null) {
    if (record['all'] === true) selector.all = true;
    else problems.push(`${where}.all must be true (every ship in the scene); give ships or fleet to select fewer`);
  }

  const role = readList({ value: record['role'], where: `${where}.role`, problems, expected: `a squad role or a list of them (${SQUAD_ROLES.join(', ')})`, read: (entry) => readEnum(entry, SQUAD_ROLES) });
  if (role) {
    const bad = role.filter((entry) => entry.value == null);
    for (const entry of bad) problems.push(`${where}.role ${JSON.stringify(entry.given)} is not a squad role (${SQUAD_ROLES.join(', ')})`);
    if (!bad.length) selector.role = dedupe(role.map((entry) => entry.value as SquadRole));
  }
  const team = readList({ value: record['team'], where: `${where}.team`, problems, expected: 'a team name or a non-empty list of them', read: (entry) => (typeof entry === 'string' && entry.trim() ? entry.trim() : null) });
  if (team) {
    if (team.some((entry) => entry.value == null)) problems.push(`${where}.team must be a team name or a non-empty list of them`);
    else selector.team = dedupe(team.map((entry) => entry.value as string));
  }
  const hull = readList({ value: record['hull'], where: `${where}.hull`, problems, expected: 'an EVE type name, a type id or a ship group name, or a non-empty list of them', read: readHullEntry });
  if (hull) {
    if (hull.some((entry) => entry.value == null)) problems.push(`${where}.hull must be an EVE type name, a type id or a ship group name, or a non-empty list of them`);
    else selector.hull = dedupe(hull.map((entry) => entry.value as string | number));
  }
  const state = readList({ value: record['state'], where: `${where}.state`, problems, expected: `a ship state or a list of them (${SHIP_SELECTOR_STATES.join(', ')})`, read: (entry) => readEnum(entry, SHIP_SELECTOR_STATES) });
  if (state) {
    const bad = state.filter((entry) => entry.value == null);
    for (const entry of bad) problems.push(`${where}.state ${JSON.stringify(entry.given)} is not a ship state (${SHIP_SELECTOR_STATES.join(', ')})`);
    if (!bad.length) selector.state = dedupe(state.map((entry) => entry.value as ShipSelectorState));
  }
  if (record['sample'] != null) {
    const sample = readSample(record['sample'], `${where}.sample`, problems);
    if (sample) selector.sample = sample;
  }
  return problems.length > before ? {} : selector;
}

/**
 * Whether a selector reaches past the old ship-and-fleet selection (`all`, or any filter): the levers add their
 * `selection` report only then, so an old call's result is unchanged.
 *
 * @param selector - The selector.
 * @returns True for `all` or a filter.
 */
export function isFilteredSelector(selector: ShipSelector): boolean {
  return selector.all === true || selector.role != null || selector.team != null || selector.hull != null || selector.state != null || selector.sample != null;
}

interface ListEntry<T> {
  readonly given: unknown;
  readonly value: T | null;
}

interface ReadListInput<T> {
  readonly value: unknown;
  readonly where: string;
  readonly problems: string[];
  readonly expected: string;
  readonly read: (entry: unknown) => T | null;
}

/**
 * One value or a non-empty list, each entry read; null when absent, or when malformed (with its problem).
 */
function readList<T>(input: ReadListInput<T>): ListEntry<T>[] | null {
  const { value, where, problems, expected, read } = input;
  let result: ListEntry<T>[] | null = null;
  if (value != null) {
    const entries = Array.isArray(value) ? value : [value];
    if (!entries.length) problems.push(`${where} must be ${expected}`);
    else result = entries.map((given) => ({ given, value: read(given) }));
  }
  return result;
}

function readEnum<T extends string>(entry: unknown, values: readonly T[]): T | null {
  const text = typeof entry === 'string' ? entry.trim().toLowerCase() : null;
  return text != null && (values as readonly string[]).includes(text) ? (text as T) : null;
}

function readHullEntry(entry: unknown): string | number | null {
  let result: string | number | null = null;
  if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) result = entry;
  else if (typeof entry === 'string' && entry.trim()) result = entry.trim();
  return result;
}

/**
 * Keeps the first of each value, strings compared case-insensitively.
 */
function dedupe<T extends string | number>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = typeof value === 'string' ? `s:${value.toLowerCase()}` : `n:${value}`;
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
}

function readSample(value: unknown, where: string, problems: string[]): ShipSelectorSample | null {
  let result: ShipSelectorSample | null = null;
  const percentProblem = `${where}.percent must be above 0 and at most 100`;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1) result = { count: value };
    else problems.push(`${where} must be a count (an integer from 1), a percent ("30%") or { count | percent, seed? }`);
  } else if (typeof value === 'string') {
    const match = PERCENT_TEXT.exec(value);
    const percent = match ? Number(match[1]) : NaN;
    if (!match) problems.push(`${where} must be a count (an integer from 1), a percent ("30%") or { count | percent, seed? }`);
    else if (percent <= 0 || percent > 100) problems.push(percentProblem);
    else result = { percent };
  } else if (isPlainObject(value)) {
    const before = problems.length;
    for (const key of Object.keys(value)) if (!SAMPLE_KEYS.has(key)) problems.push(`${where}.${key} is not a sample field (count, percent, seed)`);
    const { count, percent, seed } = value;
    if ((count == null) === (percent == null)) problems.push(`${where} needs exactly one of count and percent`);
    if (count != null && !(typeof count === 'number' && Number.isInteger(count) && count >= 1)) problems.push(`${where}.count must be an integer from 1`);
    if (percent != null && !(typeof percent === 'number' && percent > 0 && percent <= 100)) problems.push(percentProblem);
    if (seed != null && !(typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_COMBAT_SEED)) problems.push(`${where}.seed must be an integer from 0 to ${MAX_COMBAT_SEED}`);
    if (problems.length === before) result = { ...(count != null ? { count: count as number } : { percent: percent as number }), ...(seed != null ? { seed: seed as number } : {}) };
  } else {
    problems.push(`${where} must be a count (an integer from 1), a percent ("30%") or { count | percent, seed? }`);
  }
  return result;
}
