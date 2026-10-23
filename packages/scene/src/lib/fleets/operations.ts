import type { Maybe } from '@dereekb/util';
import type { SceneArrivalCollector } from '../arrivals/arrival';
import { isPlainObject, type JsonObject } from '../json';
import { removeCalledTarget } from './targets';
import { removeTimelineReferences } from '../timeline/prune';
import { removeStanceReferences } from '../piloting/stances';

/**
 * The patch operations that edit fleets. Each runs on an unvalidated draft (an earlier operation in the same
 * patch may have written anything), so the accessors tolerate malformed values and never throw; normalizeScene
 * reports what is wrong with the result.
 */
export const FLEET_OPERATIONS: ReadonlySet<string> = new Set(['add_fleet', 'update_fleet', 'remove_fleet', 'add_wing', 'update_wing', 'remove_wing', 'add_squad', 'update_squad', 'remove_squad', 'move_to_squad', 'remove_from_fleet', 'set_anchor']);

export interface FleetOperationContext {
  /**
   * The document mid-edit.
   */
  readonly draft: JsonObject;
  /**
   * The operation's place in the patch, for messages, e.g. "operations[2]".
   */
  readonly where: string;
  readonly problems: string[];
  /**
   * Receives the commands lost and anchors re-pointed by the fleet repairs.
   */
  readonly warnings: string[];
  /**
   * Receives the groups an operation adds arriving by warp (`warpIn`); absent where arrivals are not collected.
   */
  readonly arrivals?: SceneArrivalCollector;
}

/**
 * The ships holding a position in a fleet before an edit, and each squad's members, so the repair can tell who left.
 */
interface FleetSnapshot {
  readonly ships: ReadonlySet<string>;
  readonly squadMembers: ReadonlyMap<JsonObject, ReadonlySet<string>>;
}

interface SquadLocation {
  readonly wing: JsonObject;
  readonly squad: JsonObject;
}

interface FleetEdit {
  readonly fleet: JsonObject;
  readonly context: FleetOperationContext;
}

/**
 * Applies one fleet operation (see FLEET_OPERATIONS) to a draft, recording problems and warnings in the context.
 *
 * @param operation - The operation, with its "op".
 * @param context - The draft and where problems and warnings go.
 */
export function applyFleetOperation(operation: JsonObject, context: FleetOperationContext): void {
  switch (operation['op']) {
    case 'add_fleet':
      addFleet(operation, context);
      break;
    case 'update_fleet':
    case 'remove_fleet': {
      const fleet = requireFleet(operation['fleet'], context);
      if (fleet && operation['op'] === 'update_fleet') updateFleet(operation, { fleet, context });
      else if (fleet) removeFleet(operation, { fleet, context });
      break;
    }
    case 'add_wing':
      addWing(operation, context);
      break;
    case 'update_wing':
    case 'remove_wing':
      editWing(operation, context);
      break;
    case 'add_squad':
      addSquad(operation, context);
      break;
    case 'update_squad':
    case 'remove_squad':
    case 'set_anchor':
      editSquad(operation, context);
      break;
    case 'move_to_squad':
      moveToSquad(operation, context);
      break;
    case 'remove_from_fleet':
      removeFromFleet(operation, context);
      break;
    default:
      context.problems.push(`${context.where}: unknown op "${String(operation['op'])}"`);
  }
}

/**
 * Takes a ship that is being removed from the scene out of its fleet: remove_ship's cascade. A fleet commander is
 * refused; it must be replaced (update_fleet) or its fleet removed first.
 *
 * @param id - The ship's id.
 * @param context - The draft and where problems and warnings go.
 */
export function removeShipFromFleets(id: string, context: FleetOperationContext): void {
  for (const fleet of draftFleets(context.draft)) {
    if (fleetShips(fleet).has(id)) leaveFleetOrRefuse(id, { fleet, context });
  }
}

function addFleet(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems } = context;
  const fleet = operation['fleet'];
  if (!isPlainObject(fleet)) problems.push(`${where}.fleet must be an object`);
  else if (findFleet(draft, fleet['id'])) problems.push(`${where}: fleet "${String(fleet['id'])}" already exists`);
  else listOf(draft, 'fleets')?.push(structuredClone(fleet));
}

/**
 * Removes a fleet; with `withShips: true` also every ship holding a position in it (clearing a camera target on one,
 * and taking each off every other group's called targets).
 *
 * @param operation - The remove_fleet operation.
 * @param edit - The fleet and the context.
 */
function removeFleet(operation: JsonObject, edit: FleetEdit): void {
  const { fleet, context } = edit;
  const withShips = operation['withShips'];
  if (withShips != null && withShips !== true) {
    context.problems.push(`${context.where}.withShips must be true or omitted`);
    return;
  }
  removeFrom(context.draft, 'fleets', fleet);
  const removal = { fleets: [String(fleet['id'])], ...(withShips ? { ships: [...fleetShips(fleet)] } : {}) };
  removeTimelineReferences(removal, context);
  removeStanceReferences(removal, context);
  if (withShips) {
    const ships = fleetShips(fleet);
    const list = context.draft['ships'];
    if (Array.isArray(list)) context.draft['ships'] = list.filter((ship) => !(isPlainObject(ship) && ships.has(ship['id'] as string)));
    const camera = context.draft['camera'];
    if (isPlainObject(camera) && ships.has(camera['target'] as string)) camera['target'] = null;
    for (const ship of ships) removeCalledTarget(ship, context);
  }
}

function updateFleet(operation: JsonObject, edit: FleetEdit): void {
  const { fleet, context } = edit;
  const set = readSet(operation, context, { noun: 'fleet', list: 'wings', listMessage: 'wings are edited with add_wing, update_wing and remove_wing' });
  if (set) repairAfter(edit, () => assignSet(fleet, set));
}

function addWing(operation: JsonObject, context: FleetOperationContext): void {
  const { where, problems } = context;
  const fleet = requireFleet(operation['fleet'], context);
  const candidate = operation['wing'];
  const wing = isPlainObject(candidate) ? candidate : null;
  if (fleet && !wing) problems.push(`${where}.wing must be an object`);
  else if (fleet && wing && findWing(fleet, wing['id'])) problems.push(`${where}: wing "${String(wing['id'])}" already exists in fleet "${String(fleet['id'])}"`);
  else if (fleet && wing) listOf(fleet, 'wings')?.push(structuredClone(wing));
}

function editWing(operation: JsonObject, context: FleetOperationContext): void {
  const fleet = requireFleet(operation['fleet'], context);
  const wing = fleet ? findWing(fleet, operation['wing']) : null;
  if (fleet && !wing) context.problems.push(`${context.where}: no wing "${String(operation['wing'])}" in fleet "${String(fleet['id'])}"`);
  if (fleet && wing && operation['op'] === 'remove_wing') {
    repairAfter({ fleet, context }, () => removeFrom(fleet, 'wings', wing));
    const squads = Array.isArray(wing['squads']) ? wing['squads'].filter(isPlainObject).map((squad) => `${String(fleet['id'])}/${String(squad['id'])}`) : [];
    const removal = { wings: [`${String(fleet['id'])}/${String(wing['id'])}`], squads };
    removeTimelineReferences(removal, context);
    removeStanceReferences(removal, context);
  } else if (fleet && wing) {
    const set = readSet(operation, context, { noun: 'wing', list: 'squads', listMessage: 'squads are edited with add_squad, update_squad and remove_squad' });
    if (set) repairAfter({ fleet, context }, () => assignSet(wing, set));
  }
}

function addSquad(operation: JsonObject, context: FleetOperationContext): void {
  const { where, problems } = context;
  const fleet = requireFleet(operation['fleet'], context);
  const wing = fleet ? findWing(fleet, operation['wing']) : null;
  const candidate = operation['squad'];
  const squad = isPlainObject(candidate) ? candidate : null;
  if (fleet && !wing) problems.push(`${where}: no wing "${String(operation['wing'])}" in fleet "${String(fleet['id'])}"`);
  else if (wing && !squad) problems.push(`${where}.squad must be an object`);
  else if (fleet && wing && squad && findSquad(fleet, squad['id'])) problems.push(`${where}: squad "${String(squad['id'])}" already exists in fleet "${String(fleet['id'])}"`);
  else if (wing && squad) listOf(wing, 'squads')?.push(structuredClone(squad));
}

function editSquad(operation: JsonObject, context: FleetOperationContext): void {
  const fleet = requireFleet(operation['fleet'], context);
  const location = fleet ? requireSquad(fleet, operation['squad'], context) : null;
  const op = fleet && location ? operation['op'] : null;
  if (op === 'remove_squad' && fleet && location) {
    repairAfter({ fleet, context }, () => removeFrom(location.wing, 'squads', location.squad));
    const removal = { squads: [`${String(fleet['id'])}/${String(location.squad['id'])}`] };
    removeTimelineReferences(removal, context);
    removeStanceReferences(removal, context);
  } else if (op === 'set_anchor' && location) {
    setAnchor(location.squad, operation['anchor'], context);
  } else if (op === 'update_squad' && location) {
    const set = readSet(operation, context, { noun: 'squad', list: 'members', listMessage: 'members are edited with move_to_squad and remove_from_fleet' });
    if (set) assignSet(location.squad, set);
  }
}

/**
 * Merges an anchor into the squad's anchor; null resets ship to the FC and range to the role default.
 *
 * @param squad - The squad.
 * @param anchor - The candidate anchor.
 * @param context - Where problems go.
 */
function setAnchor(squad: JsonObject, anchor: unknown, context: FleetOperationContext): void {
  if (isPlainObject(anchor)) {
    const merged: JsonObject = isPlainObject(squad['anchor']) ? squad['anchor'] : {};
    assignSet(merged, anchor);
    if (Object.keys(merged).length) squad['anchor'] = merged;
    else delete squad['anchor'];
  } else {
    context.problems.push(`${context.where}.anchor must be an object`);
  }
}

function moveToSquad(operation: JsonObject, context: FleetOperationContext): void {
  const ships = readShips(operation, context);
  const fleet = requireFleet(operation['fleet'], context);
  const location = fleet ? requireSquad(fleet, operation['squad'], context) : null;
  if (ships && fleet && location) repairAfter({ fleet, context }, () => ships.forEach((id) => joinSquad(id, { fleet, context, location })));
}

/**
 * Seats a ship in a squad: it leaves another fleet (unless it commands it), gives up its other squad seat and that
 * squad's command, and a wing command for another wing. A ship already in the squad stays as it is.
 *
 * @param id - The ship.
 * @param edit - The target fleet and squad, and the context.
 */
function joinSquad(id: string, edit: FleetEdit & { readonly location: SquadLocation }): void {
  const { fleet, context, location } = edit;
  const other = draftFleets(context.draft).find((candidate) => candidate !== fleet && fleetShips(candidate).has(id));
  const joins = !membersOf(location.squad).includes(id) && (!other || leaveFleetOrRefuse(id, { fleet: other, context }));
  if (joins) {
    for (const seat of squadLocationsOf(fleet, id)) leaveSquad(seat, { fleet, context, id });
    for (const wing of wingsOf(fleet)) {
      if (wing !== location.wing && wing['commander'] === id) dropCommand(wing, { fleet, context, id, noun: 'wing' });
    }
    listOf(location.squad, 'members')?.push(id);
  }
}

function removeFromFleet(operation: JsonObject, context: FleetOperationContext): void {
  const ships = readShips(operation, context);
  for (const id of ships ?? []) {
    const fleet = draftFleets(context.draft).find((candidate) => fleetShips(candidate).has(id));
    if (fleet) leaveFleetOrRefuse(id, { fleet, context });
    else context.problems.push(`${context.where}: ship "${id}" is not in a fleet`);
  }
}

/**
 * Takes a ship out of every position in a fleet, then falls anchors on it back; a fleet commander is refused.
 *
 * @param id - The ship.
 * @param edit - Its fleet and the context.
 * @returns Whether the ship left the fleet.
 */
function leaveFleetOrRefuse(id: string, edit: FleetEdit): boolean {
  const { fleet, context } = edit;
  const commands = fleet['commander'] === id;
  if (commands) {
    context.problems.push(`${context.where}: ship "${id}" commands fleet "${String(fleet['id'])}"; give the fleet another commander (update_fleet) or remove the fleet (remove_fleet) first`);
  } else {
    repairAfter(edit, () => {
      for (const seat of squadLocationsOf(fleet, id)) leaveSquad(seat, { fleet, context, id });
      for (const wing of wingsOf(fleet)) if (wing['commander'] === id) dropCommand(wing, { fleet, context, id, noun: 'wing' });
    });
  }
  return !commands;
}

interface ShipEdit extends FleetEdit {
  readonly id: string;
}

function leaveSquad(seat: SquadLocation, edit: ShipEdit): void {
  const members = membersOf(seat.squad);
  for (let index = members.indexOf(edit.id); index >= 0; index = members.indexOf(edit.id)) members.splice(index, 1);
  if (seat.squad['commander'] === edit.id) dropCommand(seat.squad, { ...edit, noun: 'squad' });
}

function dropCommand(group: JsonObject, edit: ShipEdit & { readonly noun: 'wing' | 'squad' }): void {
  delete group['commander'];
  edit.context.warnings.push(`fleet "${String(edit.fleet['id'])}": ${edit.noun} "${String(group['id'])}" lost its commander "${edit.id}"`);
}

/**
 * Runs an edit that may take ships out of the fleet or out of squads, then falls each squad whose anchor left back
 * down the chain: its squad commander, then its wing commander (whichever is set, still in the fleet and not the
 * ship that left), otherwise the fleet commander. The range is kept. A broken-off squad's home is repaired the same
 * way. Each change is reported as a warning.
 *
 * @param edit - The fleet and the context.
 * @param change - The edit.
 */
function repairAfter(edit: FleetEdit, change: () => void): void {
  const { fleet } = edit;
  const before = snapshotFleet(fleet);
  change();
  const now = fleetShips(fleet);
  for (const wing of wingsOf(fleet)) {
    for (const squad of squadsOf(wing)) {
      repairSquadAnchor({ edit, before, now, wing, squad, key: 'anchor', verb: 'anchors on' });
      repairSquadAnchor({ edit, before, now, wing, squad, key: 'home', verb: 'regroups onto' });
    }
  }
}

interface RepairSquadAnchorInput {
  readonly edit: FleetEdit;
  readonly before: FleetSnapshot;
  readonly now: ReadonlySet<string>;
  readonly wing: JsonObject;
  readonly squad: JsonObject;
  /**
   * The squad's anchor, or its home (break-off's undo record, where `{}` means the defaults and is kept).
   */
  readonly key: 'anchor' | 'home';
  readonly verb: string;
}

function repairSquadAnchor(input: RepairSquadAnchorInput): void {
  const { edit, before, now, wing, squad, key, verb } = input;
  const { fleet, context } = edit;
  const anchor = squad[key];
  const ship = isPlainObject(anchor) ? anchor['ship'] : undefined;
  if (!isPlainObject(anchor) || typeof ship !== 'string') return;
  const leftFleet = before.ships.has(ship) && !now.has(ship);
  const leftSquad = !leftFleet && before.squadMembers.get(squad)?.has(ship) === true && !membersOf(squad).includes(ship);
  if (!leftFleet && !leftSquad) return;
  const reason = `(its ${key === 'home' ? 'home anchor' : 'anchor'} "${ship}" left the ${leftFleet ? 'fleet' : 'squad'})`;
  const next = [squad['commander'], wing['commander']].find((candidate): candidate is string => typeof candidate === 'string' && candidate !== ship && now.has(candidate));
  const prefix = `fleet "${String(fleet['id'])}": squad "${String(squad['id'])}" now ${verb}`;
  if (next) {
    anchor['ship'] = next;
    context.warnings.push(`${prefix} "${next}" ${reason}`);
  } else {
    delete anchor['ship'];
    if (key === 'anchor' && !Object.keys(anchor).length) delete squad[key];
    context.warnings.push(`${prefix} the fleet commander ${reason}`);
  }
}

function snapshotFleet(fleet: JsonObject): FleetSnapshot {
  const squadMembers = new Map<JsonObject, ReadonlySet<string>>();
  for (const wing of wingsOf(fleet)) for (const squad of squadsOf(wing)) squadMembers.set(squad, new Set(membersOf(squad)));
  return { ships: fleetShips(fleet), squadMembers };
}

/**
 * The ships holding a position in a fleet: the FC, the wing commanders and the squad members.
 *
 * @param fleet - A draft fleet.
 * @returns Their ids.
 */
function fleetShips(fleet: JsonObject): Set<string> {
  const ships = new Set<string>();
  if (typeof fleet['commander'] === 'string') ships.add(fleet['commander']);
  for (const wing of wingsOf(fleet)) {
    if (typeof wing['commander'] === 'string') ships.add(wing['commander']);
    for (const squad of squadsOf(wing)) for (const member of membersOf(squad)) ships.add(member);
  }
  return ships;
}

function squadLocationsOf(fleet: JsonObject, id: string): SquadLocation[] {
  const locations: SquadLocation[] = [];
  for (const wing of wingsOf(fleet)) for (const squad of squadsOf(wing)) if (membersOf(squad).includes(id)) locations.push({ wing, squad });
  return locations;
}

interface ReadSetConfig {
  readonly noun: 'fleet' | 'wing' | 'squad';
  /**
   * The child list the update may not touch.
   */
  readonly list: string;
  readonly listMessage: string;
}

function readSet(operation: JsonObject, context: FleetOperationContext, config: ReadSetConfig): Maybe<JsonObject> {
  const { where, problems } = context;
  const set = operation['set'];
  let valid: Maybe<JsonObject> = null;
  if (!isPlainObject(set)) problems.push(`${where}.set must be an object`);
  else if ('id' in set) problems.push(`${where}: a ${config.noun}'s id cannot be changed; remove and add it instead`);
  else if (config.list in set) problems.push(`${where}: ${config.listMessage}`);
  else valid = set;
  return valid;
}

/**
 * Copies each key onto the target; a null value deletes the key.
 *
 * @param target - The object to edit.
 * @param set - The keys to write.
 */
function assignSet(target: JsonObject, set: JsonObject): void {
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete target[key];
    else target[key] = structuredClone(value);
  }
}

function readShips(operation: JsonObject, context: FleetOperationContext): Maybe<string[]> {
  const ships = operation['ships'];
  const scene = new Set(objectsOf(context.draft['ships']).map((ship) => ship['id']));
  let valid: Maybe<string[]> = null;
  if (!Array.isArray(ships) || ships.length === 0 || !ships.every((id) => typeof id === 'string')) {
    context.problems.push(`${context.where}.ships must be a non-empty array of ship ids`);
  } else {
    const missing = (ships as string[]).filter((id) => !scene.has(id));
    for (const id of missing) context.problems.push(`${context.where}: no ship "${id}"`);
    valid = (ships as string[]).filter((id) => scene.has(id));
  }
  return valid;
}

function requireFleet(id: unknown, context: FleetOperationContext): Maybe<JsonObject> {
  const fleet = findFleet(context.draft, id);
  if (!fleet) context.problems.push(`${context.where}: no fleet "${String(id)}"`);
  return fleet;
}

function requireSquad(fleet: JsonObject, id: unknown, context: FleetOperationContext): Maybe<SquadLocation> {
  const location = findSquad(fleet, id);
  if (!location) context.problems.push(`${context.where}: no squad "${String(id)}" in fleet "${String(fleet['id'])}"`);
  return location;
}

function findFleet(draft: JsonObject, id: unknown): Maybe<JsonObject> {
  return draftFleets(draft).find((fleet) => fleet['id'] === id) ?? null;
}

function findWing(fleet: JsonObject, id: unknown): Maybe<JsonObject> {
  return wingsOf(fleet).find((wing) => wing['id'] === id) ?? null;
}

function findSquad(fleet: JsonObject, id: unknown): Maybe<SquadLocation> {
  let location: Maybe<SquadLocation> = null;
  for (const wing of wingsOf(fleet)) {
    const squad = squadsOf(wing).find((candidate) => candidate['id'] === id);
    if (squad && !location) location = { wing, squad };
  }
  return location;
}

/**
 * The draft's fleets that are objects.
 *
 * @param draft - The document mid-edit.
 * @returns A copy of the list; edit the list itself through listOf and removeFrom.
 */
function draftFleets(draft: JsonObject): JsonObject[] {
  return objectsOf(draft['fleets']);
}

function wingsOf(fleet: JsonObject): JsonObject[] {
  return objectsOf(fleet['wings']);
}

function squadsOf(wing: JsonObject): JsonObject[] {
  return objectsOf(wing['squads']);
}

/**
 * The squad's member list. Live when it is an array (non-string entries are left for normalizeScene to report).
 *
 * @param squad - A draft squad.
 * @returns The members, or a throwaway empty list when they are not an array.
 */
function membersOf(squad: JsonObject): string[] {
  const members = squad['members'];
  return Array.isArray(members) ? (members as string[]) : [];
}

/**
 * The live list under a key, created when absent; null when the key holds something else (left for normalizeScene).
 *
 * @param object - A draft fleet, wing or squad.
 * @param key - The list's key.
 * @returns The list, or null.
 */
function listOf(object: JsonObject, key: string): Maybe<unknown[]> {
  if (object[key] == null) object[key] = [];
  const list = object[key];
  return Array.isArray(list) ? list : null;
}

function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function removeFrom(owner: JsonObject, key: string, item: unknown): void {
  const list = owner[key];
  const index = Array.isArray(list) ? list.indexOf(item) : -1;
  if (Array.isArray(list) && index >= 0) list.splice(index, 1);
}
