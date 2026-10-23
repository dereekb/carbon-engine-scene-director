/**
 * Staged ship lines (a hull, its dna and radius, a count), the ids staged ships take, and the inline composition a
 * ship list becomes when it makes a fleet.
 */

import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, isPlainObject, type JsonObject, readNumber, readOptionalString, readShipType, reportUnknownKeys } from '../json';
import { normalizeShipPilot, type SceneShipPilot } from '../personalities/pilots';
import { readSquadRole, type SquadRole } from '../fleets';
import { FLEET_COMPOSITION_SCHEMA, MAX_FLEET_SHIPS } from '../compositions/composition';
import { readPropModModule, type PropModModule } from '../stats/prop-mods';
import { readEftHeader } from '../fitting/eft';
import { readFitText } from '../fitting/fit';

/**
 * The longest ship id prefix staging accepts (ids are `<prefix>-<nn>`, at most 64 characters).
 */
export const MAX_SHIP_ID_PREFIX_LENGTH = 60;

/**
 * The longest slug a name or hull becomes as an id prefix.
 */
const MAX_SLUG_LENGTH = 56;

/**
 * The longest ship id a scene accepts.
 */
const MAX_SHIP_ID_LENGTH = 64;

/**
 * The wing a ship-list fleet's squads go in.
 */
export const STAGING_WING_ID = 'wing-1';

/**
 * One line of staged ships: `count` ships of one hull.
 */
export interface StagingShipLine {
  /**
   * The EVE type the ships fly as: a type name or id. Becomes each ship's `type`.
   */
  readonly hull?: string | number;
  /**
   * SOF DNA (hull:faction:race). Required: the add_ships and stage_engagement tools fill it from the EVE data.
   */
  readonly dna: string;
  /**
   * The hull's EVE radius in metres, for spacing. The tools fill it.
   */
  readonly radius?: number;
  /**
   * Default 1.
   */
  readonly count?: number;
  /**
   * The ship name base (each ship's name is it plus the ship's number).
   */
  readonly name?: string;
  /**
   * The squad role when the line makes a squad. Default dps.
   */
  readonly role?: SquadRole;
  /**
   * The prop mod the line's ships fit: a module name, a type id, "mwd", "ab" or "none".
   */
  readonly propMod?: PropModModule;
  /**
   * The EFT fit the line's ships carry. Its header's hull is the line's hull when it names none; the scene keeps the
   * text in its `fits` (`<prefix>/<fit name slug>`).
   */
  readonly fit?: string;
  /**
   * The pilot's traits (personalities/pilots.ts) each of the line's ships carries.
   */
  readonly pilot?: SceneShipPilot;
}

const LINE_KEYS = new Set<string>(['hull', 'dna', 'radius', 'count', 'name', 'role', 'propMod', 'fit', 'pilot']);

export interface ReadStagingShipLineInput {
  readonly record: JsonObject;
  readonly where: string;
  /**
   * The tool that resolves hull names, for the missing-dna message.
   */
  readonly tool: string;
  readonly problems: string[];
}

/**
 * Reads a line's hull (else its fit's hull), dna, radius, count, name, propMod, fit and pilot from a record (unknown
 * keys are the caller's; the scene's check warns on a pilot's reserved keys).
 *
 * @param input - The record, where it sits, the resolving tool and where problems go.
 * @returns The line (fields with problems are dropped).
 */
export function readStagingShipLine(input: ReadStagingShipLineInput): StagingShipLine {
  const { record, where, tool, problems } = input;
  const fit = record['fit'] == null ? null : readFitText(record['fit'], `${where}.fit`, problems);
  const hull = record['hull'] == null ? (fit ? (readEftHeader(fit)?.hull ?? null) : null) : readShipType(record['hull'], `${where}.hull`, problems);
  const label = hull ?? 'ship';
  let dna = '';
  if (record['dna'] == null) problems.push(`${where}: hull "${label}" has no dna. The ${tool} tool resolves hull names to DNA through tools-core; patch_scene needs every ship line's dna.`);
  else if (typeof record['dna'] !== 'string' || !DNA_PATTERN.test(record['dna'])) problems.push(`${where}.dna must be SOF DNA (hull:faction:race)`);
  else dna = record['dna'];
  const radius = record['radius'] == null ? null : readPositiveMetres(record['radius'], `${where}.radius`, problems);
  const count = record['count'] == null ? null : readNumber(record['count'], `${where}.count`, problems, { min: 1, max: MAX_FLEET_SHIPS });
  if (count != null && !Number.isInteger(count)) problems.push(`${where}.count must be a whole number`);
  const name = record['name'] == null ? null : readOptionalString(record['name'], `${where}.name`, problems);
  const propMod = record['propMod'] == null ? null : readPropModModule(record['propMod'], `${where}.propMod`, problems);
  const pilot = normalizeShipPilot({ input: record['pilot'], where: `${where}.pilot` });
  problems.push(...pilot.problems);
  return {
    ...(hull === '' || hull == null ? {} : { hull }),
    dna,
    ...(radius == null ? {} : { radius }),
    ...(count == null ? {} : { count }),
    ...(name ? { name } : {}),
    ...(propMod == null ? {} : { propMod }),
    ...(fit ? { fit } : {}),
    ...(pilot.pilot == null ? {} : { pilot: pilot.pilot })
  };
}

/**
 * Reads a length in metres above 0.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is not a finite number above 0.
 * @returns The metres, or null on a problem.
 */
export function readPositiveMetres(value: unknown, where: string, problems: string[]): Maybe<number> {
  let metres: Maybe<number> = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) metres = value;
  else problems.push(`${where} must be a finite number of metres above 0`);
  return metres;
}

export interface NormalizedStagingShipLines {
  readonly lines: StagingShipLine[];
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a ship list: a non-empty array of lines (hull?, dna, radius?, count?, name?, role?, propMod?, fit?, pilot?), at most
 * MAX_FLEET_SHIPS ships in all.
 *
 * @param config - The candidate, where it sits and the resolving tool.
 * @param config.input - The candidate list.
 * @param config.where - Where it sits, for messages.
 * @param config.tool - The tool that resolves hull names.
 * @returns The lines, problems and warnings.
 */
export function normalizeStagingShipLines(config: { readonly input: unknown; readonly where: string; readonly tool: string }): NormalizedStagingShipLines {
  const { input, where, tool } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: StagingShipLine[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    problems.push(`${where} must be a non-empty array of ship lines { hull, count?, role?, name?, dna?, radius? }`);
  } else {
    for (const [index, candidate] of input.entries()) {
      const at = `${where}[${index}]`;
      if (!isPlainObject(candidate)) {
        problems.push(`${at} must be an object`);
        continue;
      }
      reportUnknownKeys(candidate, LINE_KEYS, at, warnings);
      const line = readStagingShipLine({ record: candidate, where: at, tool, problems });
      const role = candidate['role'] == null ? null : readSquadRole(candidate['role'], `${at}.role`, problems);
      lines.push(role ? { ...line, role } : line);
    }
    const total = countStagingShips(lines);
    if (total > MAX_FLEET_SHIPS) problems.push(`${where} adds ${total} ships; at most ${MAX_FLEET_SHIPS} (EVE's fleet size)`);
  }
  return { lines, problems, warnings };
}

/**
 * How many ships lines add.
 *
 * @param lines - The lines.
 * @returns The total count.
 */
export function countStagingShips(lines: readonly Pick<StagingShipLine, 'count'>[]): number {
  return lines.reduce((total, line) => total + (line.count ?? 1), 0);
}

/**
 * An id prefix from a name: lower-case ASCII (accents dropped), runs of anything outside `[a-z0-9_.-]` become `-`,
 * the ends trimmed, cut to 56 characters.
 *
 * @param text - The name.
 * @param fallback - What an empty slug becomes. Default "ship".
 * @returns The slug.
 */
export function toIdSlug(text: string, fallback = 'ship'): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^[-_.]+|[-_.]+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-_.]+$/u, '');
  return slug || fallback;
}

/**
 * A line's label: its name, else its hull name, else the SOF hull of its dna.
 *
 * @param line - The line.
 * @returns The label.
 */
export function shipLabel(line: Pick<StagingShipLine, 'hull' | 'dna' | 'name'>): string {
  let label = line.name ?? (typeof line.hull === 'string' ? line.hull : null);
  if (label == null && typeof line.hull === 'number') label = `type ${line.hull}`;
  return label ?? (line.dna.split(':')[0] || 'ship');
}

export interface NumberShipIdsInput {
  readonly prefix: string;
  readonly count: number;
  /**
   * The ids in use.
   */
  readonly ids: Iterable<string>;
  readonly where: string;
  readonly problems: string[];
}

export interface NumberedShipIds {
  readonly ids: string[];
  readonly numbers: number[];
}

/**
 * `<prefix>-<nn>` ids continuing after the highest number already used with the prefix, at least two digits.
 *
 * @param input - The prefix, how many, the ids in use, and where problems go.
 * @returns The ids and their numbers; empty when an id would be longer than 64 characters.
 */
export function numberShipIds(input: NumberShipIdsInput): NumberedShipIds {
  const { prefix, count, ids, where, problems } = input;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-(\\d+)$`, 'u');
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const numbers = Array.from({ length: count }, (_, index) => highest + 1 + index);
  const digits = Math.max(2, String(highest + count).length);
  const numbered = numbers.map((number) => `${prefix}-${String(number).padStart(digits, '0')}`);
  const long = numbered.find((id) => id.length > MAX_SHIP_ID_LENGTH);
  let result: NumberedShipIds = { ids: numbered, numbers };
  if (long) {
    problems.push(`${where}: ship id "${long}" is longer than ${MAX_SHIP_ID_LENGTH} characters; pass a shorter prefix`);
    result = { ids: [], numbers: [] };
  }
  return result;
}

export interface ShipListCompositionInput {
  /**
   * The composition id: the default fleet id and ship id prefix.
   */
  readonly id: string;
  readonly name?: Maybe<string>;
  readonly lines: readonly StagingShipLine[];
}

/**
 * The cjs-fleet/1 candidate a ship list makes (normalize it with normalizeFleetComposition): the first line's first
 * ship is the FC; each line is a squad in wing STAGING_WING_ID, its id its role (dps by default; repeated roles are
 * numbered `dps`, `dps-2`, ...), with the first line taking `count − 1` ships (no squad at 0).
 *
 * @param input - The id, the name and the lines.
 * @returns The candidate.
 */
export function toShipListComposition(input: ShipListCompositionInput): JsonObject {
  const { id, name, lines } = input;
  const [first] = lines;
  const used = new Map<string, number>();
  const squads: JsonObject[] = [];
  const fits = toLineFitKeys(lines);
  for (const [index, line] of lines.entries()) {
    const count = (line.count ?? 1) - (index === 0 ? 1 : 0);
    if (count < 1) continue;
    const role = line.role ?? 'dps';
    const seen = (used.get(role) ?? 0) + 1;
    used.set(role, seen);
    squads.push({ id: seen === 1 ? role : `${role}-${seen}`, role, ships: [{ ...compositionShip(line, { fits }), count }] });
  }
  return {
    schema: FLEET_COMPOSITION_SCHEMA,
    id,
    ...(name ? { name } : {}),
    commander: first ? compositionShip(first, { fits, named: false }) : {},
    ...(squads.length ? { wings: [{ id: STAGING_WING_ID, squads }] } : {}),
    ...(fits.size ? { fits: Object.fromEntries([...fits].map(([text, key]) => [key, text])) } : {})
  };
}

/**
 * The key a staged fit takes: a slug of its fit name, numbered when two texts share one.
 *
 * @param text - The EFT text.
 * @param taken - The keys already given.
 * @returns The key.
 */
export function stagedFitKey(text: string, taken: ReadonlySet<string>): string {
  const base = toIdSlug(readEftHeader(text)?.name ?? '', 'fit');
  let key = base;
  for (let number = 2; taken.has(key); number += 1) key = `${base}-${number}`;
  return key;
}

function toLineFitKeys(lines: readonly StagingShipLine[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of lines) if (line.fit && !keys.has(line.fit)) keys.set(line.fit, stagedFitKey(line.fit, new Set(keys.values())));
  return keys;
}

function compositionShip(line: StagingShipLine, options: { readonly fits: ReadonlyMap<string, string>; readonly named?: boolean }): JsonObject {
  const { fits, named = true } = options;
  return {
    ...(line.hull == null ? {} : { hull: line.hull }),
    dna: line.dna,
    ...(line.radius == null ? {} : { radius: line.radius }),
    ...(named && line.name ? { name: line.name } : {}),
    ...(line.propMod == null ? {} : { propMod: line.propMod }),
    ...(line.fit && fits.has(line.fit) ? { fit: fits.get(line.fit) } : {}),
    ...(line.pilot == null ? {} : { pilot: structuredClone(line.pilot) })
  };
}
