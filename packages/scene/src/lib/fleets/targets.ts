/**
 * Called targets: what a fleet, wing or squad shoots at, the way an EVE FC calls it. Each group's `targets` list holds
 * ship or authored-object ids in kill order: its first live entry is the group's primary, and the live entries after it
 * are its queue. The document's lists are the opening calls a load starts with; the page keeps the live calls.
 *
 * - order_fleet's targets order edits the page's live list (toFleetTargetList), at once and never saved, so a reload
 *   replays the same fight. toFleetTargetOperations compiles the same order to update_fleet, update_wing or
 *   update_squad, for a timeline beat that cues it as a patch.
 * - Removing a called ship or object prunes it from every list (removeCalledTarget). A kill never touches the list:
 *   kills are live state, so the live view skips a destroyed target, the next becomes primary, and a load revives the
 *   call.
 * - Every fleet member takes the primary of the nearest group in its chain with a live primary (toShipCallPlans): its
 *   squad's, else its wing's, else its fleet's. The FC takes only its fleet's call, and a logi squad only its own
 *   squad's. The page (the viewer's FleetTargets) locks and shoots it for every member without its own target.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';
import { CELESTIAL_TARGET_PREFIX } from '../location/targets';
import { type SceneDocument, SceneError } from '../scene';
import { CELESTIAL_TARGET_REFUSAL } from '../weapons/target';
import { describeFleetGroup, type FleetGroup, toFleetGroupKey } from './group';
import { toFleetMemberships } from './membership';
import type { FleetOperationContext } from './operations';
import { type FleetSelection, selectFleetShips } from './selection';

/**
 * The most targets a group may call: EVE's fleet size, so a whole enemy fleet can be queued.
 */
export const MAX_CALLED_TARGETS = 256;

/**
 * How many queued targets after the primary a member pre-locks (EVE's secondary and tertiary), so the fleet switches
 * without a lock wait when the primary dies.
 */
export const CALLED_PRE_LOCKS = 2;

/**
 * What a targets order does to its group's list; an order carries exactly one.
 */
export const FLEET_TARGETS_ACTIONS = ['primary', 'queue', 'set', 'drop', 'next', 'clear'] as const;

export type FleetTargetsAction = (typeof FLEET_TARGETS_ACTIONS)[number];

/**
 * A called target's live status: `destroyed` (killed, or flagged dead), `warping` (in proper warp: EVE broke every lock
 * on it), `missing` (no ball: not built yet, or gone), `live` otherwise.
 */
export const CALLED_TARGET_STATUSES = ['live', 'destroyed', 'warping', 'missing'] as const;

export type CalledTargetStatus = (typeof CALLED_TARGET_STATUSES)[number];

/**
 * Why the live view skips a called target: its status, or `own-ship` (one of the calling group's own ships).
 */
export const CALLED_TARGET_SKIP_REASONS = ['destroyed', 'warping', 'missing', 'own-ship'] as const;

export type CalledTargetSkipReason = (typeof CALLED_TARGET_SKIP_REASONS)[number];

/**
 * The page's live status of a target id.
 */
export type CalledTargetStatusOf = (id: string) => CalledTargetStatus;

/**
 * Calls a target first (moved up when already called), the rest keeping their order behind it; queues ids not yet
 * called after the list; sets the list (`[]` clears); drops ids it calls; moves past the live primary (`next`); or
 * clears the list.
 */
export interface FleetTargetsOrder {
  readonly type: 'targets';
  readonly primary?: string;
  readonly queue?: readonly string[];
  readonly set?: readonly string[];
  readonly drop?: readonly string[];
  readonly next?: true;
  readonly clear?: true;
}

const ID_MESSAGE = 'must be an id (1-64 letters, digits, "_", "-" or ".")';
const TARGETS_ORDER_KEYS = new Set<string>(['type', ...FLEET_TARGETS_ACTIONS]);

/**
 * Why an id cannot be called, as a message suffix.
 *
 * @param value - The candidate id.
 * @param known - The scene's ship and object ids; unchecked when absent.
 * @returns The suffix, or null when it can be called.
 */
function calledIdProblem(value: unknown, known: Maybe<ReadonlySet<string>>): Maybe<string> {
  let problem: Maybe<string> = null;
  if (typeof value === 'string' && value.startsWith(CELESTIAL_TARGET_PREFIX)) problem = ` "${value}": ${CELESTIAL_TARGET_REFUSAL}`;
  else if (typeof value !== 'string' || !ID_PATTERN.test(value)) problem = ` ${ID_MESSAGE}`;
  else if (known && !known.has(value)) problem = ` "${value}" is not a ship or object in the scene`;
  return problem;
}

export interface ReadCalledTargetsContext {
  /**
   * Where the list sits, for messages.
   */
  readonly where: string;
  readonly problems: string[];
  /**
   * The scene's ship and object ids, which every entry must name. Unchecked when absent (add_ships normalizes one fleet
   * against ship ids only, and a fleet calling an object must not break it).
   */
  readonly targetIds?: ReadonlySet<string>;
}

/**
 * Reads a fleet's, wing's or squad's `targets`: ship or authored-object ids, none twice, at most MAX_CALLED_TARGETS. A
 * location celestial (`celestial:<id>`) is refused, as set_target refuses it. One of the group's own ships is valid
 * here (a later move_to_squad can make it so); the live view skips it.
 *
 * @param value - The candidate list.
 * @param context - Where it sits, where problems go and the ids it may name.
 * @returns The list, or null when absent, null or empty (normalize omits it).
 */
export function readCalledTargets(value: unknown, context: ReadCalledTargetsContext): Maybe<string[]> {
  const { where, problems, targetIds } = context;
  let targets: Maybe<string[]> = null;
  if (value != null && !Array.isArray(value)) {
    problems.push(`${where} must be an array of ship or object ids: the group's called targets, in kill order`);
  } else if (Array.isArray(value)) {
    const seen = new Set<string>();
    for (const [index, entry] of value.entries()) {
      const problem = calledIdProblem(entry, targetIds);
      if (problem) problems.push(`${where}[${index}]${problem}`);
      else if (seen.has(entry as string)) problems.push(`${where}[${index}] "${String(entry)}" is called more than once`);
      else seen.add(entry as string);
    }
    if (value.length > MAX_CALLED_TARGETS) problems.push(`${where} calls ${value.length} targets; at most ${MAX_CALLED_TARGETS} (EVE's fleet size)`);
    if (seen.size) targets = [...seen];
  }
  return targets;
}

/**
 * Takes a removed ship or object off every fleet's, wing's and squad's called targets, deleting an emptied list, with a
 * warning per list: remove_ship, remove_object and remove_fleet withShips call it. Tolerant of a draft. A destroyed
 * ship is never pruned: the live view skips it instead.
 *
 * @param id - The removed ship's or object's id.
 * @param context - The draft and where warnings go.
 */
export function removeCalledTarget(id: string, context: Pick<FleetOperationContext, 'draft' | 'warnings'>): void {
  const { draft, warnings } = context;
  for (const fleet of objectsOf(draft['fleets'])) {
    const fleetId = String(fleet['id']);
    pruneCalled({ group: fleet, id, label: `fleet "${fleetId}"`, warnings });
    for (const wing of objectsOf(fleet['wings'])) {
      pruneCalled({ group: wing, id, label: `fleet "${fleetId}": wing "${String(wing['id'])}"`, warnings });
      for (const squad of objectsOf(wing['squads'])) pruneCalled({ group: squad, id, label: `fleet "${fleetId}": squad "${String(squad['id'])}"`, warnings });
    }
  }
}

interface PruneCalledInput {
  readonly group: JsonObject;
  readonly id: string;
  readonly label: string;
  readonly warnings: string[];
}

function pruneCalled(input: PruneCalledInput): void {
  const { group, id, label, warnings } = input;
  const targets = group['targets'];
  if (Array.isArray(targets) && targets.includes(id)) {
    const kept = targets.filter((entry) => entry !== id);
    if (kept.length) group['targets'] = kept;
    else delete group['targets'];
    warnings.push(`${label} no longer calls "${id}" (it was removed)`);
  }
}

function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/**
 * The selection that picks a group's ships.
 *
 * @param group - The group.
 * @returns The fleet, narrowed to the wing or squad.
 */
function groupSelection(group: FleetGroup): FleetSelection {
  let selection: FleetSelection = { fleet: group.fleet };
  if (group.kind === 'wing') selection = { fleet: group.fleet, wing: group.id };
  else if (group.kind === 'squad') selection = { fleet: group.fleet, squad: group.id };
  return selection;
}

/**
 * A group's own ships: selectFleetShips of it (a fleet's FC included, and the FC in a wing or squad it sits in).
 *
 * @param scene - The document.
 * @param group - The group.
 * @returns Its ship ids.
 */
export function fleetGroupShips(scene: Pick<SceneDocument, 'ships' | 'fleets'>, group: FleetGroup): Set<string> {
  return new Set(selectFleetShips(scene, groupSelection(group)).ships);
}

/**
 * A group's called targets as the document writes them.
 *
 * @param scene - The document.
 * @param group - The fleet, wing or squad.
 * @returns A copy of its list; empty when it calls none or does not exist.
 */
export function calledTargetsOf(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): string[] {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let targets: Maybe<readonly string[]> = fleet?.targets;
  if (group.kind === 'wing') targets = fleet?.wings.find((wing) => wing.id === group.id)?.targets;
  else if (group.kind === 'squad') targets = fleet?.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === group.id)?.targets;
  return [...(targets ?? [])];
}

export interface CalledTargetSkip {
  readonly id: string;
  readonly why: CalledTargetSkipReason;
}

/**
 * A called list split by live status.
 */
export interface CalledTargets {
  /**
   * The first live entry; null when none is live.
   */
  readonly primary: Maybe<string>;
  /**
   * The live entries after the primary, in order.
   */
  readonly queue: string[];
  /**
   * The entries skipped, in order, with why.
   */
  readonly skipped: CalledTargetSkip[];
}

export interface ToCalledTargetsOptions {
  /**
   * Each target's live status; without it every entry counts as live.
   */
  readonly statusOf?: CalledTargetStatusOf;
  /**
   * The calling group's own ships, skipped as `own-ship`.
   */
  readonly own?: ReadonlySet<string>;
}

/**
 * Splits a called list into its live primary, its live queue and the entries skipped.
 *
 * @param targets - The list, in kill order.
 * @param options - The live status and the group's own ships.
 * @returns The primary, the queue and the skipped entries.
 */
export function toCalledTargets(targets: readonly string[], options: ToCalledTargetsOptions = {}): CalledTargets {
  const { statusOf, own } = options;
  const live: string[] = [];
  const skipped: CalledTargetSkip[] = [];
  for (const id of targets) {
    const status = own?.has(id) ? 'own-ship' : (statusOf?.(id) ?? 'live');
    if (status === 'live') live.push(id);
    else skipped.push({ id, why: status });
  }
  return { primary: live[0] ?? null, queue: live.slice(1), skipped };
}

/**
 * One group's call: its list as written, split by live status.
 */
export interface FleetGroupCall extends CalledTargets {
  readonly group: FleetGroup;
  /**
   * The group's list as the document writes it.
   */
  readonly targets: string[];
}

/**
 * Every group that calls targets, with its live primary and queue.
 *
 * @param scene - The document, or the page's live fleet view (the destroyed out of their fleets).
 * @param statusOf - Each target's live status; without it every entry counts as live.
 * @returns By group key (toFleetGroupKey), in fleet order: each fleet, then each wing followed by its squads.
 */
export function toFleetGroupCalls(scene: Pick<SceneDocument, 'ships' | 'fleets'>, statusOf?: CalledTargetStatusOf): Map<string, FleetGroupCall> {
  const calls = new Map<string, FleetGroupCall>();
  const add = (group: FleetGroup, targets: Maybe<readonly string[]>): void => {
    if (targets?.length) calls.set(toFleetGroupKey(group), { group, targets: [...targets], ...toCalledTargets(targets, { statusOf, own: fleetGroupShips(scene, group) }) });
  };
  for (const fleet of scene.fleets ?? []) {
    add({ fleet: fleet.id, kind: 'fleet', id: fleet.id }, fleet.targets);
    for (const wing of fleet.wings) {
      add({ fleet: fleet.id, kind: 'wing', id: wing.id }, wing.targets);
      for (const squad of wing.squads) add({ fleet: fleet.id, kind: 'squad', id: squad.id }, squad.targets);
    }
  }
  return calls;
}

/**
 * Which call one fleet member takes.
 */
export interface ShipCallPlan {
  readonly ship: string;
  readonly fleet: string;
  /**
   * The groups whose calls it takes, nearest first: its squad (when it sits in one), its wing (its squad's, or the one
   * it commands), its fleet. The FC: its fleet only. A logi squad member: its own squad only.
   */
  readonly chain: FleetGroup[];
  /**
   * A logi squad member other than the FC: wing and fleet calls never reach it.
   */
  readonly logi: boolean;
  /**
   * Whether any group of its squad, wing and fleet calls targets, whether or not the FC and logi rules let it take
   * them.
   */
  readonly called: boolean;
  /**
   * The group whose call it takes: the nearest in its chain with a live primary; null with none.
   */
  readonly group: Maybe<FleetGroup>;
  readonly primary: Maybe<string>;
  /**
   * That group's live queue after its primary: what it pre-locks.
   */
  readonly queue: string[];
}

/**
 * The call each fleet member takes: the primary of the nearest group in its chain with a live primary. A squad whose
 * targets are all dead or gone falls back to its wing's call, then its fleet's.
 *
 * - The FC takes only its fleet's call, whatever squad it sits in (order_fleet keeps it out of wing and squad orders
 *   too). An acting FC (the live view's) counts as the FC.
 * - A logi squad (role `logi`) takes only its own squad's call: wing and fleet calls never reach it. The FC rule wins
 *   over the logi rule.
 * - Every other role shoots the call with its guns.
 *
 * @param scene - The live fleet view (or the document).
 * @param calls - toFleetGroupCalls of the same scene.
 * @returns Each ship holding a position, keyed by id, in fleet order; ships in no fleet are absent.
 */
export function toShipCallPlans(scene: Pick<SceneDocument, 'fleets'>, calls: ReadonlyMap<string, FleetGroupCall>): Map<string, ShipCallPlan> {
  const plans = new Map<string, ShipCallPlan>();
  for (const [ship, membership] of toFleetMemberships(scene)) {
    const fleetGroup: FleetGroup = { fleet: membership.fleet, kind: 'fleet', id: membership.fleet };
    const squadGroup: Maybe<FleetGroup> = membership.squad ? { fleet: membership.fleet, kind: 'squad', id: membership.squad } : null;
    const wingGroup: Maybe<FleetGroup> = membership.wing ? { fleet: membership.fleet, kind: 'wing', id: membership.wing } : null;
    const full = [squadGroup, wingGroup, fleetGroup].filter((group): group is FleetGroup => group != null);
    const commandsFleet = membership.commands.includes('fleet');
    const logi = !commandsFleet && membership.role === 'logi';
    let chain = full;
    if (commandsFleet) chain = [fleetGroup];
    else if (logi) chain = squadGroup ? [squadGroup] : [];
    const taken = chain.map((group) => calls.get(toFleetGroupKey(group))).find((call) => call?.primary != null);
    plans.set(ship, {
      ship,
      fleet: membership.fleet,
      chain,
      logi,
      called: full.some((group) => calls.has(toFleetGroupKey(group))),
      group: taken?.group ?? null,
      primary: taken?.primary ?? null,
      queue: taken?.queue ?? []
    });
  }
  return plans;
}

export interface ReadFleetTargetsOrderContext {
  /**
   * The scene's ship ids. With `objects`, what the order may name; unchecked when both are absent.
   */
  readonly ships?: ReadonlySet<string>;
  /**
   * The scene's objects (and the location's celestial targets, refused by their prefix first).
   */
  readonly objects?: ReadonlySet<string>;
  readonly where: string;
}

/**
 * Reads a targets order: `type: "targets"` and exactly one action. `primary` is an id; `queue` and `drop` non-empty id
 * lists; `set` an id list without repeats (`[]` clears); `next` and `clear` are `true`. Ids name a ship or authored
 * object; a location celestial is refused. Unknown keys are problems.
 *
 * @param input - The candidate order.
 * @param context - The ids it may name and the message prefix.
 * @param problems - Receives every problem found.
 * @returns The order, or null with problems.
 */
export function readFleetTargetsOrder(input: JsonObject, context: ReadFleetTargetsOrderContext, problems: string[]): Maybe<FleetTargetsOrder> {
  const { where } = context;
  const before = problems.length;
  for (const key of Object.keys(input)) if (!TARGETS_ORDER_KEYS.has(key)) problems.push(`${where}.${key} is not a targets order field`);
  const known = context.ships || context.objects ? new Set([...(context.ships ?? []), ...(context.objects ?? [])]) : null;
  const actions = FLEET_TARGETS_ACTIONS.filter((action) => input[action] !== undefined);
  let order: Maybe<FleetTargetsOrder> = null;
  if (actions.length !== 1) {
    const got = actions.length ? [`(got ${actions.join(', ')})`] : [];
    problems.push([`${where} needs exactly one of ${FLEET_TARGETS_ACTIONS.join(', ')}`, ...got].join(' '));
  } else {
    const action = actions[0];
    const value = input[action];
    if (action === 'next' || action === 'clear') {
      if (value === true) order = { type: 'targets', [action]: true };
      else problems.push(`${where}.${action} must be true`);
    } else if (action === 'primary') {
      const problem = calledIdProblem(value, known);
      if (problem) problems.push(`${where}.primary${problem}`);
      else order = { type: 'targets', primary: value as string };
    } else {
      const ids = readOrderIds({ value, where: `${where}.${action}`, known, emptyClears: action === 'set', unique: action === 'set' }, problems);
      if (ids) order = { type: 'targets', [action]: ids };
    }
  }
  return problems.length > before ? null : order;
}

interface ReadOrderIdsInput {
  readonly value: unknown;
  readonly where: string;
  readonly known: Maybe<ReadonlySet<string>>;
  /**
   * `[]` is allowed (set: it clears the list).
   */
  readonly emptyClears: boolean;
  /**
   * A repeated id is a problem (set); otherwise repeats are dropped.
   */
  readonly unique: boolean;
}

function readOrderIds(input: ReadOrderIdsInput, problems: string[]): Maybe<string[]> {
  const { value, where, known, emptyClears, unique } = input;
  const before = problems.length;
  const ids = new Set<string>();
  if (!Array.isArray(value) || (!emptyClears && !value.length)) {
    problems.push(`${where} must be a${emptyClears ? 'n' : ' non-empty'} array of ship or object ids`);
  } else {
    for (const [index, entry] of value.entries()) {
      const problem = calledIdProblem(entry, known);
      if (problem) problems.push(`${where}[${index}]${problem}`);
      else if (unique && ids.has(entry as string)) problems.push(`${where}[${index}] "${String(entry)}" is named more than once`);
      else ids.add(entry as string);
    }
    if (value.length > MAX_CALLED_TARGETS) problems.push(`${where} names ${value.length} targets; at most ${MAX_CALLED_TARGETS} (EVE's fleet size)`);
  }
  return problems.length > before ? null : [...ids];
}

/**
 * The ids a targets order calls (its primary, queue or set), which may not be the group's own ships; drop may name
 * them, to take them off.
 *
 * @param order - The order.
 * @returns The ids it calls.
 */
export function fleetTargetsOrderCalls(order: FleetTargetsOrder): readonly string[] {
  let ids: readonly string[] = order.queue ?? order.set ?? [];
  if (order.primary != null) ids = [order.primary];
  return ids;
}

export interface FleetTargetOperationsOptions {
  /**
   * The page's live status of each target, so `next` moves past the live primary. Without it every entry counts as
   * live.
   */
  readonly statusOf?: CalledTargetStatusOf;
}

export interface FleetTargetListOptions extends FleetTargetOperationsOptions {
  /**
   * The group's own ships, which `next` never takes for the live primary (fleetGroupShips).
   */
  readonly own?: ReadonlySet<string>;
}

/**
 * A group's called list after a targets order: the page's live call book and toFleetTargetOperations both run it.
 *
 * - `primary`: that id first (moved up when already called), the rest in their order behind it.
 * - `queue`: the list, then the given ids it does not call yet, in order.
 * - `set`: exactly the given list.
 * - `drop`: the list without the given ids; an id it does not call is a problem.
 * - `next`: the list without its live primary (with none live, without its first entry); an empty list is a problem.
 * - `clear`: empty.
 *
 * @param current - The group's list before the order.
 * @param group - The order's group, for messages.
 * @param order - The targets order.
 * @param options - The page's live status and the group's own ships, for `next`.
 * @returns The list after the order.
 * @throws {SceneError} For a drop of an uncalled id, next on an empty list, or a list past MAX_CALLED_TARGETS.
 */
export function toFleetTargetList(current: readonly string[], group: FleetGroup, order: FleetTargetsOrder, options: FleetTargetListOptions = {}): string[] {
  const where = 'order_fleet.order';
  let next: string[] = [];
  if (order.primary != null) {
    next = [order.primary, ...current.filter((id) => id !== order.primary)];
  } else if (order.queue) {
    next = [...current, ...order.queue.filter((id) => !current.includes(id))];
  } else if (order.set) {
    next = [...order.set];
  } else if (order.drop) {
    const dropped = new Set(order.drop);
    const uncalled = order.drop.filter((id) => !current.includes(id));
    if (uncalled.length) throw new SceneError(uncalled.map((id) => `${where}.drop: ${describeFleetGroup(group)} does not call "${id}"`));
    next = current.filter((id) => !dropped.has(id));
  } else if (order.next) {
    if (!current.length) throw new SceneError([`${where}.next: ${describeFleetGroup(group)} calls no targets`]);
    const passed = toCalledTargets(current, { statusOf: options.statusOf, own: options.own }).primary ?? current[0];
    next = current.filter((id) => id !== passed);
  }
  if (next.length > MAX_CALLED_TARGETS) throw new SceneError([`${where}: ${describeFleetGroup(group)} would call ${next.length} targets; at most ${MAX_CALLED_TARGETS} (EVE's fleet size)`]);
  return next;
}

/**
 * The patch op a targets order compiles to: one update_fleet, update_wing or update_squad with `set: { targets }`
 * (null when the list empties), or none when the list is unchanged. The list is toFleetTargetList's. A timeline beat may
 * cue it as a patch; order_fleet edits the page's live calls instead.
 *
 * @param scene - The document the order was resolved against.
 * @param group - The order's group.
 * @param order - The targets order.
 * @param options - The page's live status, for `next`.
 * @returns The ops, for applySceneOperations.
 * @throws {SceneError} For a drop of an uncalled id, next on an empty list, or a list past MAX_CALLED_TARGETS.
 */
export function toFleetTargetOperations(scene: Pick<SceneDocument, 'ships' | 'fleets'>, group: FleetGroup, order: FleetTargetsOrder, options: FleetTargetOperationsOptions = {}): JsonObject[] {
  const current = calledTargetsOf(scene, group);
  const next = toFleetTargetList(current, group, order, { statusOf: options.statusOf, own: fleetGroupShips(scene, group) });
  const unchanged = next.length === current.length && next.every((id, index) => id === current[index]);
  return unchanged ? [] : [toTargetsOperation(group, next)];
}

function toTargetsOperation(group: FleetGroup, targets: readonly string[]): JsonObject {
  const set: JsonObject = { targets: targets.length ? [...targets] : null };
  let operation: JsonObject = { op: 'update_fleet', fleet: group.fleet, set };
  if (group.kind === 'wing') operation = { op: 'update_wing', fleet: group.fleet, wing: group.id, set };
  else if (group.kind === 'squad') operation = { op: 'update_squad', fleet: group.fleet, squad: group.id, set };
  return operation;
}
