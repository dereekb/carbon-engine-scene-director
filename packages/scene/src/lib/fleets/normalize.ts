import type { Maybe } from '@dereekb/util';
import { isPlainObject, readId, readList, readOptionalString, readString, reportUnknownKeys } from '../json';
import { type SceneFleet, type SceneSquad, type SceneSquadAnchor, type SceneWing, SQUAD_ROLES, type SquadRole } from './fleet';
import { toFleetAnchors } from './membership';
import { readSceneAutoRepair } from '../logi/auto-repair';
import { readCalledTargets } from './targets';

const FLEET_KEYS = new Set<string>(['id', 'name', 'commander', 'targets', 'autoRepair', 'wings']);
const WING_KEYS = new Set<string>(['id', 'name', 'commander', 'targets', 'autoRepair', 'squads']);
const SQUAD_KEYS = new Set<string>(['id', 'name', 'role', 'commander', 'members', 'anchor', 'home', 'targets', 'autoRepair']);
const ANCHOR_KEYS = new Set<string>(['ship', 'range']);

export interface NormalizeFleetsInput {
  readonly input: unknown;
  /**
   * The scene's ship ids, which every fleet reference must name.
   */
  readonly shipIds: ReadonlySet<string>;
  /**
   * The scene's ship and object ids, which every called target must name. Unchecked when absent: add_ships normalizes
   * one fleet against ship ids only.
   */
  readonly targetIds?: ReadonlySet<string>;
}

export interface NormalizedFleets {
  /**
   * The valid fleets, or null when none were given (absent, null or empty).
   */
  readonly fleets: Maybe<SceneFleet[]>;
  readonly problems: string[];
  readonly warnings: string[];
}

interface Report {
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * NormalizeFleetsInput.targetIds.
   */
  readonly targetIds?: ReadonlySet<string>;
}

/**
 * A squad seat: which squad of which wing and fleet a ship sits in.
 */
interface Seat {
  readonly fleet: string;
  readonly wing: string;
  readonly squad: string;
}

/**
 * What the reference pass has claimed so far, across fleets in document order.
 */
interface Claims {
  readonly shipIds: ReadonlySet<string>;
  /**
   * The fleet each ship holds a position in.
   */
  readonly owners: Map<string, string>;
  readonly seats: Map<string, Seat>;
}

/**
 * Validates a document's fleets against its ships. Every problem is reported together; unknown keys warn and are
 * dropped. A valid document keeps these rules:.
 *
 * - fleet ids are unique in the scene, and wing and squad ids are unique within their fleet;
 * - a ship holds positions (FC, wing commander, squad member) in at most one fleet, and sits in at most one squad;
 * - a wing commander sits in one of its own wing's squads or in none, and commands one wing; a squad commander is
 *   one of its squad's members;
 * - anchors are ships of the same fleet, and every anchor chain ends at the fleet commander;
 * - called targets (`targets`, fleets/targets.ts) name ships or objects (against targetIds when given), none twice.
 *
 * @param config - The candidate fleets and the scene's ship ids.
 * @returns The normalized fleets with every problem and warning found.
 */
export function normalizeFleets(config: NormalizeFleetsInput): NormalizedFleets {
  const { input, shipIds, targetIds } = config;
  const report: Report = { problems: [], warnings: [], targetIds };
  const fleets: SceneFleet[] = [];

  if (input != null && !Array.isArray(input)) report.problems.push('fleets must be an array');
  const claims: Claims = { shipIds, owners: new Map(), seats: new Map() };
  const fleetIds = new Set<string>();
  for (const [index, candidate] of (Array.isArray(input) ? input : []).entries()) {
    const where = `fleets[${index}]`;
    const before = report.problems.length;
    const fleet = normalizeFleet(candidate, where, report);
    if (!fleet) continue;
    if (fleet.id && fleetIds.has(fleet.id)) report.problems.push(`${where}.id "${fleet.id}" is used more than once`);
    fleetIds.add(fleet.id);
    checkFleetReferences({ fleet, where, claims, problems: report.problems });
    if (report.problems.length === before) checkAnchorLoops(fleet, where, report.problems);
    fleets.push(fleet);
  }

  return { fleets: fleets.length ? fleets : null, ...report };
}

function normalizeFleet(input: unknown, where: string, report: Report): Maybe<SceneFleet> {
  if (!isPlainObject(input)) {
    report.problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, FLEET_KEYS, where, report.warnings);
  const id = readId(input['id'], `${where}.id`, report.problems);
  const name = readOptionalString(input['name'], `${where}.name`, report.problems);
  const commander = readString(input['commander'], `${where}.commander`, report.problems);
  const targets = readCalledTargets(input['targets'], { where: `${where}.targets`, problems: report.problems, targetIds: report.targetIds });
  const autoRepair = readSceneAutoRepair(input['autoRepair'], { where: `${where}.autoRepair`, ...report });
  const fleet: SceneFleet = { id, ...(name ? { name } : {}), commander, ...(targets ? { targets } : {}), ...(autoRepair ? { autoRepair } : {}), wings: [] };

  const wingIds = new Set<string>();
  const squadIds = new Set<string>();
  for (const [index, candidate] of readList(input['wings'], `${where}.wings`, report.problems).entries()) {
    const wingWhere = `${where}.wings[${index}]`;
    const wing = normalizeWing(candidate, wingWhere, report);
    if (!wing) continue;
    if (wing.id && wingIds.has(wing.id)) report.problems.push(`${wingWhere}.id "${wing.id}" is used more than once in fleet "${id}"`);
    wingIds.add(wing.id);
    for (const [squadIndex, squad] of wing.squads.entries()) {
      if (squad.id && squadIds.has(squad.id)) report.problems.push(`${wingWhere}.squads[${squadIndex}].id "${squad.id}" is used more than once in fleet "${id}"`);
      squadIds.add(squad.id);
    }
    fleet.wings.push(wing);
  }
  return fleet;
}

function normalizeWing(input: unknown, where: string, report: Report): Maybe<SceneWing> {
  if (!isPlainObject(input)) {
    report.problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, WING_KEYS, where, report.warnings);
  const id = readId(input['id'], `${where}.id`, report.problems);
  const name = readOptionalString(input['name'], `${where}.name`, report.problems);
  const commander = readOptionalString(input['commander'], `${where}.commander`, report.problems);
  const targets = readCalledTargets(input['targets'], { where: `${where}.targets`, problems: report.problems, targetIds: report.targetIds });
  const autoRepair = readSceneAutoRepair(input['autoRepair'], { where: `${where}.autoRepair`, ...report });
  const wing: SceneWing = { id, ...(name ? { name } : {}), ...(commander ? { commander } : {}), ...(targets ? { targets } : {}), ...(autoRepair ? { autoRepair } : {}), squads: [] };
  for (const [index, candidate] of readList(input['squads'], `${where}.squads`, report.problems).entries()) {
    const squad = normalizeSquad(candidate, `${where}.squads[${index}]`, report);
    if (squad) wing.squads.push(squad);
  }
  return wing;
}

function normalizeSquad(input: unknown, where: string, report: Report): Maybe<SceneSquad> {
  if (!isPlainObject(input)) {
    report.problems.push(`${where} must be an object`);
    return null;
  }
  reportUnknownKeys(input, SQUAD_KEYS, where, report.warnings);
  const id = readId(input['id'], `${where}.id`, report.problems);
  const name = readOptionalString(input['name'], `${where}.name`, report.problems);
  const role = readSquadRole(input['role'], `${where}.role`, report.problems);
  const commander = readOptionalString(input['commander'], `${where}.commander`, report.problems);
  const members = readList(input['members'], `${where}.members`, report.problems).map((member, index) => readString(member, `${where}.members[${index}]`, report.problems));
  const anchor = normalizeAnchor(input['anchor'], `${where}.anchor`, report);
  const home = normalizeAnchor(input['home'], `${where}.home`, report, { keepEmpty: true });
  const targets = readCalledTargets(input['targets'], { where: `${where}.targets`, problems: report.problems, targetIds: report.targetIds });
  const autoRepair = readSceneAutoRepair(input['autoRepair'], { where: `${where}.autoRepair`, ...report });
  return { id, ...(name ? { name } : {}), role, ...(commander ? { commander } : {}), members, ...(anchor ? { anchor } : {}), ...(home ? { home } : {}), ...(targets ? { targets } : {}), ...(autoRepair ? { autoRepair } : {}) };
}

interface NormalizeAnchorOptions {
  /**
   * Keep `{}` (a squad's home: "the defaults") instead of dropping it.
   */
  readonly keepEmpty?: boolean;
}

function normalizeAnchor(input: unknown, where: string, report: Report, options: NormalizeAnchorOptions = {}): Maybe<SceneSquadAnchor> {
  let anchor: Maybe<SceneSquadAnchor> = null;
  if (input != null && !isPlainObject(input)) {
    report.problems.push(`${where} must be an object of ship and range`);
  } else if (input != null) {
    reportUnknownKeys(input, ANCHOR_KEYS, where, report.warnings);
    const ship = readOptionalString(input['ship'], `${where}.ship`, report.problems);
    const range = input['range'];
    const value: SceneSquadAnchor = ship ? { ship } : {};
    if (range != null && (typeof range !== 'number' || !Number.isFinite(range) || range < 0)) report.problems.push(`${where}.range must be a number of 0 or more (metres)`);
    else if (range != null) value.range = range;
    if (Object.keys(value).length || options.keepEmpty) anchor = value;
  }
  return anchor;
}

interface FleetReferencesInput {
  readonly fleet: SceneFleet;
  readonly where: string;
  readonly claims: Claims;
  readonly problems: string[];
}

/**
 * Checks that the fleet's ships exist and hold only the positions they may: one fleet per ship, one squad per ship,
 * commanders where they may be, and anchors inside the fleet.
 *
 * @param config - The fleet, where it sits, the claims of the fleets before it and where problems go.
 */
function checkFleetReferences(config: FleetReferencesInput): void {
  const { fleet, where, claims, problems } = config;
  // An empty id already has its problem from the shape pass.
  const claim = (ship: string, at: string, seat?: Seat): void => {
    const owner = claims.owners.get(ship);
    const seated = claims.seats.get(ship);
    if (ship && !claims.shipIds.has(ship)) problems.push(`${at} "${ship}" is not a ship id`);
    else if (ship && seat && seated) problems.push(`${at} "${ship}" already sits in squad "${seated.squad}" of fleet "${seated.fleet}"`);
    else if (ship && owner !== undefined && owner !== fleet.id) problems.push(`${at} "${ship}" is already in fleet "${owner}"`);
    else if (ship) {
      claims.owners.set(ship, fleet.id);
      if (seat) claims.seats.set(ship, seat);
    }
  };

  // Every ship the fleet lists, claimed or not, so an anchor problem is not a side effect of a claim problem.
  const listed = new Set<string>([fleet.commander]);
  claim(fleet.commander, `${where}.commander`);
  for (const [wingIndex, wing] of fleet.wings.entries()) {
    const wingWhere = `${where}.wings[${wingIndex}]`;
    if (wing.commander) {
      listed.add(wing.commander);
      claim(wing.commander, `${wingWhere}.commander`);
    }
    for (const [squadIndex, squad] of wing.squads.entries()) {
      for (const [memberIndex, member] of squad.members.entries()) {
        listed.add(member);
        claim(member, `${wingWhere}.squads[${squadIndex}].members[${memberIndex}]`, { fleet: fleet.id, wing: wing.id, squad: squad.id });
      }
    }
  }
  checkCommanders(config);
  checkAnchors({ ...config, listed });
}

function checkCommanders(config: FleetReferencesInput): void {
  const { fleet, where, claims, problems } = config;
  const commandedWings = new Map<string, string>();
  for (const [wingIndex, wing] of fleet.wings.entries()) {
    const wingWhere = `${where}.wings[${wingIndex}]`;
    for (const [squadIndex, squad] of wing.squads.entries()) {
      if (squad.commander && !squad.members.includes(squad.commander)) {
        problems.push(`${wingWhere}.squads[${squadIndex}].commander "${squad.commander}" is not one of the squad's members`);
      }
    }
    const commander = wing.commander;
    if (!commander) continue;
    const seat = claims.seats.get(commander);
    const commanded = commandedWings.get(commander);
    if (commanded === undefined) {
      commandedWings.set(commander, wing.id);
    } else {
      problems.push(`${wingWhere}.commander "${commander}" already commands wing "${commanded}"`);
    }
    if (seat?.fleet === fleet.id && seat.wing !== wing.id) {
      problems.push(`${wingWhere}.commander "${commander}" sits in squad "${seat.squad}" of wing "${seat.wing}"; a wing commander sits in one of its own wing's squads or in none`);
    }
  }
}

function checkAnchors(config: FleetReferencesInput & { readonly listed: ReadonlySet<string> }): void {
  const { fleet, where, claims, problems, listed } = config;
  for (const [wingIndex, wing] of fleet.wings.entries()) {
    for (const [squadIndex, squad] of wing.squads.entries()) {
      for (const key of ['anchor', 'home'] as const) {
        const ship = squad[key]?.ship;
        const at = `${where}.wings[${wingIndex}].squads[${squadIndex}].${key}.ship`;
        if (!ship) continue;
        if (!claims.shipIds.has(ship)) problems.push(`${at} "${ship}" is not a ship id`);
        else if (!listed.has(ship)) problems.push(`${at} "${ship}" is not in fleet "${fleet.id}"`);
      }
    }
  }
}

/**
 * Walks each ship's anchor chain; every chain must end at the fleet commander. Each loop is reported once.
 *
 * @param fleet - A fleet with no other problem.
 * @param where - Where the fleet sits, for messages.
 * @param problems - Receives one problem per loop.
 */
function checkAnchorLoops(fleet: SceneFleet, where: string, problems: string[]): void {
  const anchors = toFleetAnchors(fleet);
  const settled = new Set<string>();
  for (const start of anchors.keys()) {
    const path: string[] = [];
    let ship: Maybe<string> = start;
    while (ship != null && !settled.has(ship) && !path.includes(ship)) {
      path.push(ship);
      ship = anchors.get(ship)?.anchor?.ship;
    }
    if (ship != null && path.includes(ship)) {
      const loop = [...path.slice(path.indexOf(ship)), ship];
      problems.push(`${where}: anchors form a loop (${loop.join(' → ')}); every anchor chain must end at the fleet commander "${fleet.commander}"`);
    }
    for (const visited of path) settled.add(visited);
  }
}

/**
 * Reads a squad role, case-insensitively.
 *
 * @param value - The candidate role.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is not one of SQUAD_ROLES.
 * @returns The lower-cased role (unchecked when there is a problem).
 */
export function readSquadRole(value: unknown, where: string, problems: string[]): SquadRole {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const known = (SQUAD_ROLES as readonly string[]).includes(role);
  if (!known) problems.push(`${where} must be one of ${SQUAD_ROLES.join(', ')}`);
  return role as SquadRole;
}
