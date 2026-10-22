import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, ID_PATTERN, isPlainObject, type JsonObject, MAX_TYPE_NAME_LENGTH, readId, readList, readOptionalString, readShipType, readString, reportUnknownKeys } from '../json';
import { readSquadRole } from '../fleets';
import { COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD, type CompositionAnchor, type CompositionShip, type CompositionShipLine, type CompositionSquad, type CompositionWing, FLEET_COMPOSITION_SCHEMA, type FleetComposition, MAX_FIT_LENGTH, MAX_FLEET_SHIPS } from './composition';
import { readEftHeader } from './eft';

const COMPOSITION_KEYS = new Set<string>(['schema', 'id', 'name', 'description', 'source', 'commander', 'wings', 'fits']);
const SHIP_KEYS = new Set<string>(['hull', 'dna', 'radius', 'name', 'propMod', 'fit']);
const LINE_KEYS = new Set<string>([...SHIP_KEYS, 'count']);
const WING_KEYS = new Set<string>(['id', 'name', 'squads']);
const SQUAD_KEYS = new Set<string>(['id', 'name', 'role', 'anchor', 'ships']);
const ANCHOR_KEYS = new Set<string>(['on', 'range']);
const RESERVED_SQUAD_IDS = new Set<string>([COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD]);

export interface NormalizeFleetCompositionInput {
  readonly input: unknown;
  /**
   * The message prefix. Default "composition".
   */
  readonly where?: string;
}

export interface NormalizedFleetComposition {
  /**
   * The normalized composition, or null when it has a problem.
   */
  readonly composition: Maybe<FleetComposition>;
  readonly problems: string[];
  readonly warnings: string[];
}

interface Report {
  readonly problems: string[];
  readonly warnings: string[];
}

interface ShipContext {
  readonly report: Report;
  readonly fits: Readonly<Record<string, string>>;
  /**
   * Whether the ship is a squad line (which may carry a count).
   */
  readonly line: boolean;
}

/**
 * Validates a fleet composition (`cjs-fleet/1`) with every problem reported together; unknown keys warn and are
 * dropped. Values are kept as written (trimmed; roles and the `fc` / `lead` anchor targets lower-cased), and derived
 * values (a hull from its fit, anchor defaults) are not filled, so a saved composition reads back as written.
 *
 * @param config - The candidate and the message prefix.
 * @returns The normalized composition (null on a problem), the problems and the warnings. Never throws.
 */
export function normalizeFleetComposition(config: NormalizeFleetCompositionInput): NormalizedFleetComposition {
  const { input, where = 'composition' } = config;
  const report: Report = { problems: [], warnings: [] };
  let composition: Maybe<FleetComposition> = null;

  if (isPlainObject(input)) {
    composition = normalizeComposition(input, where, report);
  } else {
    report.problems.push(`${where} must be a JSON object (a ${FLEET_COMPOSITION_SCHEMA} fleet composition)`);
  }

  return { composition: report.problems.length ? null : composition, ...report };
}

/**
 * The ships a composition adds: the FC plus every line's count.
 *
 * @param composition - A normalized composition.
 * @returns The ship count.
 */
export function countFleetCompositionShips(composition: Pick<FleetComposition, 'wings'>): number {
  let ships = 1;
  for (const wing of composition.wings) for (const squad of wing.squads) for (const line of squad.ships) ships += line.count ?? 1;
  return ships;
}

function normalizeComposition(input: JsonObject, where: string, report: Report): FleetComposition {
  const { problems, warnings } = report;
  if (input['schema'] !== undefined && input['schema'] !== FLEET_COMPOSITION_SCHEMA) {
    problems.push(`${where}.schema must be "${FLEET_COMPOSITION_SCHEMA}", got ${JSON.stringify(input['schema'])}`);
  }
  reportUnknownKeys(input, COMPOSITION_KEYS, where, warnings);

  const fits = normalizeFits(input['fits'], `${where}.fits`, report);
  const composition: FleetComposition = { schema: FLEET_COMPOSITION_SCHEMA, id: readId(input['id'], `${where}.id`, problems), commander: {}, wings: [] };
  for (const key of ['name', 'description', 'source'] as const) {
    const value = readOptionalString(input[key], `${where}.${key}`, problems);
    if (value) composition[key] = value;
  }

  const commander = input['commander'];
  if (isPlainObject(commander)) composition.commander = normalizeShip(commander, `${where}.commander`, { report, fits: fits ?? {}, line: false });
  else problems.push(`${where}.commander must be an object: the fleet commander's ship`);

  const wingIds = new Set<string>();
  const squadIds = new Set<string>();
  for (const [index, candidate] of readList(input['wings'], `${where}.wings`, problems).entries()) {
    const wingWhere = `${where}.wings[${index}]`;
    const wing = normalizeWing(candidate, wingWhere, { report, fits: fits ?? {}, line: true });
    if (!wing) continue;
    if (wing.id && wingIds.has(wing.id)) problems.push(`${wingWhere}.id "${wing.id}" is used more than once`);
    wingIds.add(wing.id);
    for (const [squadIndex, squad] of wing.squads.entries()) {
      const squadWhere = `${wingWhere}.squads[${squadIndex}]`;
      if (RESERVED_SQUAD_IDS.has(squad.id.toLowerCase())) problems.push(`${squadWhere}.id "${squad.id}" is reserved: "fc" and "lead" name anchor targets`);
      else if (squad.id && squadIds.has(squad.id)) problems.push(`${squadWhere}.id "${squad.id}" is used more than once`);
      squadIds.add(squad.id);
    }
    composition.wings.push(wing);
  }
  if (fits) composition.fits = fits;

  checkSquadAnchors(composition, where, problems);
  const ships = countFleetCompositionShips(composition);
  if (ships > MAX_FLEET_SHIPS) problems.push(`${where} has ${ships} ships counting the FC; a fleet holds at most ${MAX_FLEET_SHIPS}`);
  return composition;
}

function normalizeFits(input: unknown, where: string, report: Report): Maybe<Record<string, string>> {
  let fits: Maybe<Record<string, string>> = null;
  if (input != null && !isPlainObject(input)) {
    report.problems.push(`${where} must be an object of EFT fit text by key`);
  } else if (input != null) {
    fits = {};
    for (const [key, value] of Object.entries(input)) {
      const text = readString(value, `${where}.${key}`, report.problems);
      if (!ID_PATTERN.test(key)) report.problems.push(`${where} key "${key}" must be 1-64 letters, digits, "_", "-" or "."`);
      else if (text.length > MAX_FIT_LENGTH) report.problems.push(`${where}.${key} is longer than ${MAX_FIT_LENGTH} characters`);
      else if (text && !readEftHeader(text)) report.problems.push(`${where}.${key} must be EFT text starting with a [Hull, Fit name] header`);
      else if (text) fits[key] = text;
    }
  }
  return fits;
}

function normalizeWing(input: unknown, where: string, context: ShipContext): Maybe<CompositionWing> {
  const { problems, warnings } = context.report;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, WING_KEYS, where, warnings);
  const name = readOptionalString(input['name'], `${where}.name`, problems);
  const wing: CompositionWing = { id: readId(input['id'], `${where}.id`, problems), ...(name ? { name } : {}), squads: [] };
  for (const [index, candidate] of readList(input['squads'], `${where}.squads`, problems).entries()) {
    const squad = normalizeSquad(candidate, `${where}.squads[${index}]`, context);
    if (squad) wing.squads.push(squad);
  }
  return wing;
}

function normalizeSquad(input: unknown, where: string, context: ShipContext): Maybe<CompositionSquad> {
  const { problems, warnings } = context.report;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, SQUAD_KEYS, where, warnings);
  const id = readId(input['id'], `${where}.id`, problems);
  const name = readOptionalString(input['name'], `${where}.name`, problems);
  const role = readSquadRole(input['role'], `${where}.role`, problems);
  const anchor = normalizeAnchor(input['anchor'], `${where}.anchor`, context.report);
  const ships: CompositionShipLine[] = [];
  for (const [index, candidate] of readList(input['ships'], `${where}.ships`, problems).entries()) {
    const lineWhere = `${where}.ships[${index}]`;
    if (isPlainObject(candidate)) ships.push(normalizeShip(candidate, lineWhere, context));
    else problems.push(`${lineWhere} must be an object`);
  }
  return { id, ...(name ? { name } : {}), role, ...(anchor ? { anchor } : {}), ships };
}

function normalizeAnchor(input: unknown, where: string, report: Report): Maybe<CompositionAnchor> {
  let anchor: Maybe<CompositionAnchor> = null;
  if (input != null && !isPlainObject(input)) {
    report.problems.push(`${where} must be an object of on and range`);
  } else if (input != null) {
    reportUnknownKeys(input, ANCHOR_KEYS, where, report.warnings);
    const on = readOptionalString(input['on'], `${where}.on`, report.problems);
    const range = input['range'];
    const value: CompositionAnchor = {};
    if (on) value.on = RESERVED_SQUAD_IDS.has(on.toLowerCase()) ? on.toLowerCase() : on;
    if (range != null && (typeof range !== 'number' || !Number.isFinite(range) || range < 0)) report.problems.push(`${where}.range must be a number of 0 or more (metres)`);
    else if (range != null) value.range = range;
    if (Object.keys(value).length) anchor = value;
  }
  return anchor;
}

function normalizeShip(input: JsonObject, where: string, context: ShipContext): CompositionShipLine {
  const { report, line } = context;
  const { problems } = report;
  reportUnknownKeys(input, line ? LINE_KEYS : SHIP_KEYS, where, report.warnings);
  const ship: CompositionShipLine = {};
  if (input['hull'] != null) ship.hull = readShipType(input['hull'], `${where}.hull`, problems);
  if (input['dna'] != null) {
    ship.dna = readString(input['dna'], `${where}.dna`, problems);
    if (ship.dna && !DNA_PATTERN.test(ship.dna)) problems.push(`${where}.dna "${ship.dna}" is not hull:faction:race[:commands]`);
  }
  if (input['radius'] != null) {
    const radius = input['radius'];
    if (typeof radius === 'number' && Number.isFinite(radius) && radius > 0) ship.radius = radius;
    else problems.push(`${where}.radius must be a number above 0 (metres, the hull's EVE radius)`);
  }
  const name = readOptionalString(input['name'], `${where}.name`, problems);
  if (name) ship.name = name;
  if (input['propMod'] != null) ship.propMod = readPropMod(input['propMod'], `${where}.propMod`, problems);
  if (line && input['count'] != null) {
    const count = input['count'];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= MAX_FLEET_SHIPS) ship.count = count;
    else problems.push(`${where}.count must be an integer in [1, ${MAX_FLEET_SHIPS}]`);
  }
  if (input['fit'] != null) ship.fit = readString(input['fit'], `${where}.fit`, problems);
  checkShipHull(ship, where, context);
  return ship;
}

function readPropMod(value: unknown, where: string, problems: string[]): string | number {
  let propMod: string | number = '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) propMod = value;
  else if (typeof value === 'string' && value.trim() && value.trim().length <= MAX_TYPE_NAME_LENGTH) propMod = value.trim();
  else problems.push(`${where} must be a module type name (or "mwd" / "ab") or a positive module type id`);
  return propMod;
}

/**
 * Checks that a ship names its hull, and that a string hull agrees with its fit's EFT header.
 *
 * @param ship - The normalized ship.
 * @param where - Where it sits, for messages.
 * @param context - The fits and where problems go.
 */
function checkShipHull(ship: CompositionShip, where: string, context: ShipContext): void {
  const { fits, report } = context;
  const fit = ship.fit ? fits[ship.fit] : undefined;
  const header = fit ? readEftHeader(fit) : null;
  if (ship.fit && fit === undefined) {
    report.problems.push(`${where}.fit "${ship.fit}" is not a key of fits`);
  } else if (header && typeof ship.hull === 'string' && ship.hull.toLowerCase() !== header.hull.toLowerCase()) {
    report.problems.push(`${where}.hull "${ship.hull}" does not match fit "${ship.fit}" ([${header.hull}, ${header.name}])`);
  }
  if (ship.hull == null && ship.dna == null && ship.fit == null) report.problems.push(`${where} names no hull: give hull (an EVE type name or id), dna, or a fit`);
}

/**
 * Checks each squad's `anchor.on`: a known target, never the squad itself, never an empty squad, and no loops.
 *
 * @param composition - The composition so far.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problems.
 */
function checkSquadAnchors(composition: FleetComposition, where: string, problems: string[]): void {
  const squads = new Map<string, CompositionSquad>();
  for (const wing of composition.wings) for (const squad of wing.squads) if (!squads.has(squad.id)) squads.set(squad.id, squad);
  const targets = new Map<string, string>();
  for (const [wingIndex, wing] of composition.wings.entries()) {
    for (const [squadIndex, squad] of wing.squads.entries()) {
      const on = squad.anchor?.on;
      const at = `${where}.wings[${wingIndex}].squads[${squadIndex}].anchor.on`;
      if (on == null || RESERVED_SQUAD_IDS.has(on)) continue;
      const target = squads.get(on);
      if (target === undefined) problems.push(`${at} "${on}" is not "fc", "lead" or a squad id`);
      else if (target === squad) problems.push(`${at} names the squad itself; use "lead" to anchor the squad on its first ship`);
      else if (target.ships.length === 0) problems.push(`${at} "${on}" is a squad with no ships`);
      else targets.set(squad.id, on);
    }
  }

  const settled = new Set<string>();
  for (const start of targets.keys()) {
    const path: string[] = [];
    let squad: Maybe<string> = start;
    while (squad != null && !settled.has(squad) && !path.includes(squad)) {
      path.push(squad);
      squad = targets.get(squad);
    }
    if (squad != null && path.includes(squad)) {
      const loop = [...path.slice(path.indexOf(squad)), squad];
      problems.push(`${where}: squads anchor on each other in a loop (${loop.join(' -> ')})`);
    }
    for (const visited of path) settled.add(visited);
  }
}
