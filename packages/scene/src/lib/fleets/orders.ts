/**
 * Fleet orders: what the order_fleet tool takes (one plain object, which a timeline beat will embed unchanged), who
 * may give it (EVE's rule: the FC orders the fleet, a wing commander only their wing, a squad commander only their
 * squad), which ship the group flies on (its leader), the document ops its anchor, break-off, regroup and targets
 * orders compile to, and each pilot's response time. The page flies the rest (the viewer's FleetOrders and
 * FleetTargets) and keeps free fire live (FleetCommanders).
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';
import { MAX_ORDER_RANGE, normalizeShipOrder, SHIP_ORDER_TYPES, type ShipOrder, shipOrderTarget } from '../orders';
import { type SceneDocument, SceneError } from '../scene';
import { DEFAULT_ANCHOR_RANGES, type SceneFleet, type SceneSquad, type SceneSquadAnchor, type SceneWing } from './fleet';
import { describeFleetGroup, type FleetGroup } from './group';
import { readFleetSelection, selectFleetShips } from './selection';
import { readStanceOrder, type StanceOrder } from '../piloting/stances';
import { type FleetTargetOperationsOptions, type FleetTargetsOrder, fleetTargetsOrderCalls, readFleetTargetsOrder, toFleetTargetOperations } from './targets';

export { describeFleetGroup, toFleetGroupKey } from './group';
export type { FleetGroup, FleetGroupKind } from './group';

/**
 * The orders that edit the document's anchors rather than fly a ship.
 */
export const FLEET_STRUCTURE_ORDER_TYPES = ['anchor', 'break-off', 'regroup'] as const;

export type FleetStructureOrderType = (typeof FLEET_STRUCTURE_ORDER_TYPES)[number];

/**
 * What a fleet, wing or squad can be ordered: order_ship's movement orders and warp, then the document orders (the
 * anchor orders, then the called targets), then free fire, the group's stance and engage (a fleet's, back to its FC
 * brain). Written out rather than spread from SHIP_ORDER_TYPES: `../orders` and this module import each other through
 * `../scene`.
 */
export const FLEET_ORDER_TYPES = ['direction', 'goto', 'approach', 'keep-at-range', 'orbit', 'warp', 'stop', 'anchor', 'break-off', 'regroup', 'targets', 'free-fire', 'stance', 'engage'] as const;

export type FleetOrderType = (typeof FLEET_ORDER_TYPES)[number];

/**
 * Metres: a break-off without a range flies apart at the logi range ("logi fly separately, about 30 km off").
 */
export const DEFAULT_BREAK_OFF_RANGE = DEFAULT_ANCHOR_RANGES.logi;

/**
 * Seconds the slowest pilot takes to respond to a fleet order given with `delay` 1, or to any order with reaction 0.
 */
export const MAX_FLEET_ORDER_DELAY = 10;

/**
 * Re-anchors every squad of the group, as set_anchor does: `ship` null is the FC, `range` null the role default. A key
 * left out is left as it is.
 */
export interface FleetAnchorOrder {
  readonly type: 'anchor';
  readonly ship?: Maybe<string>;
  readonly range?: Maybe<number>;
}

/**
 * Anchors one squad on its own lead at a range off the FC; the squad's home keeps the anchor it had.
 */
export interface FleetBreakOffOrder {
  readonly type: 'break-off';
  /**
   * The lead: one of the squad's members, not the FC. Default: its commander, else its current lead, else its first
   * member.
   */
  readonly ship?: string;
  /**
   * Metres off the FC, surface to surface; default DEFAULT_BREAK_OFF_RANGE.
   */
  readonly range: number;
}

/**
 * Brings the group back into its fleet's formation: home anchors restored, ships apart or detached rejoined, far ships
 * warped back in formation.
 */
export interface FleetRegroupOrder {
  readonly type: 'regroup';
}

export type FleetStructureOrder = FleetAnchorOrder | FleetBreakOffOrder | FleetRegroupOrder;

/**
 * A fleet document order: an anchor order, or the group's called targets (fleets/targets.ts).
 */
export type FleetDocumentOrder = FleetStructureOrder | FleetTargetsOrder;

/**
 * Free fire for a fleet, wing or squad (`on`), or its end: each member with no call to take (not logi, no own target,
 * not stood down) picks the nearest hostile within its own reach after its reaction, and picks again the same way when
 * that target is gone; a call wins once there is one. Live, like a targets order: the page keeps it (FleetCommanders),
 * never the document.
 */
export interface FleetFreeFireOrder {
  readonly type: 'free-fire';
  readonly on: boolean;
}

/**
 * Hands a personality fleet back to its FC brain and engages it now: the fleet's live stance is dropped (the
 * document's applies again), every lever a model or a command took and a cease_fire hold are let go, and the brain is
 * engaged (`engagedBy: "ordered"`). Fleet level only, and only for a fleet with a personality. Live: the page runs it
 * (FleetCommanders.Engage), never the document.
 */
export interface FleetEngageOrder {
  readonly type: 'engage';
}

/**
 * What a fleet, wing or squad can be ordered: a movement order (order_ship's), a warp, a document order, free fire,
 * the group's stance (piloting/stances.ts: live, like free fire; the page keeps it in its stance book), or engage.
 */
export type FleetOrder = ShipOrder | FleetDocumentOrder | FleetFreeFireOrder | StanceOrder | FleetEngageOrder;

/**
 * What order_fleet takes: one plain object, which a timeline beat will embed unchanged.
 */
export interface FleetOrderRequest {
  readonly fleet: string;
  readonly wing?: string;
  readonly squad?: string;
  /**
   * The ship giving the order; it must command the group. Default: the group's commander, else the one above it.
   */
  readonly by?: string;
  /**
   * How slowly the pilots respond, 0 (at once) to 1 (very delayed): each ship but the giver takes its own pseudo-random
   * time, up to `delay` × MAX_FLEET_ORDER_DELAY seconds (toPilotDelays). Unset, each pilot answers after its reaction
   * (ships[].pilot, or its personality fleet's draw), else at once.
   */
  readonly delay?: number;
  readonly order: FleetOrder;
}

export interface FleetOrderRequestContext {
  /**
   * The scene's ship ids: targets and anchor ships must be among them. Unchecked when absent.
   */
  readonly ships?: ReadonlySet<string>;
  /**
   * Targets that are not ships (the scene's objects and the location's celestial targets), for a leader's movement
   * order. Unchecked against when absent.
   */
  readonly objects?: ReadonlySet<string>;
  /**
   * Message prefix, default `order_fleet`.
   */
  readonly where?: string;
}

const REQUEST_KEYS = new Set<string>(['fleet', 'wing', 'squad', 'by', 'delay', 'order']);
const STRUCTURE_TYPES: ReadonlySet<string> = new Set(FLEET_STRUCTURE_ORDER_TYPES);
const ID_MESSAGE = 'must be an id (1-64 letters, digits, "_", "-" or ".")';

/**
 * Whether a fleet order edits the document (anchor, break-off, regroup) rather than flying a ship.
 *
 * @param order - A normalized fleet order.
 * @returns True for anchor, break-off and regroup.
 */
export function isFleetStructureOrder(order: FleetOrder): order is FleetStructureOrder {
  return STRUCTURE_TYPES.has(order.type);
}

/**
 * Whether a fleet order is a targets order (the group's called targets).
 *
 * @param order - A normalized fleet order.
 * @returns True for targets.
 */
export function isFleetTargetsOrder(order: FleetOrder): order is FleetTargetsOrder {
  return order.type === 'targets';
}

/**
 * Whether a fleet order edits the document (anchor, break-off, regroup, targets) rather than flying a ship: the page
 * runs it through the edit queue.
 *
 * @param order - A normalized fleet order.
 * @returns True for the structure and targets orders.
 */
export function isFleetDocumentOrder(order: FleetOrder): order is FleetDocumentOrder {
  return isFleetStructureOrder(order) || isFleetTargetsOrder(order);
}

/**
 * Whether a fleet order turns free fire on or off.
 *
 * @param order - A normalized fleet order.
 * @returns True for free-fire.
 */
export function isFleetFreeFireOrder(order: FleetOrder): order is FleetFreeFireOrder {
  return order.type === 'free-fire';
}

/**
 * Whether a fleet order sets or clears the group's stance.
 *
 * @param order - A normalized fleet order.
 * @returns True for stance.
 */
export function isFleetStanceOrder(order: FleetOrder): order is StanceOrder {
  return order.type === 'stance';
}

/**
 * Whether a fleet order hands the fleet back to its FC brain (engage).
 *
 * @param order - A normalized fleet order.
 * @returns True for engage.
 */
export function isFleetEngageOrder(order: FleetOrder): order is FleetEngageOrder {
  return order.type === 'engage';
}

/**
 * Whether a fleet order flies the group: order_ship's movement orders and warp.
 *
 * @param order - A normalized fleet order.
 * @returns False for the document orders, free fire, stances and engage.
 */
export function isFleetShipOrder(order: FleetOrder): order is ShipOrder {
  return !isFleetDocumentOrder(order) && !isFleetFreeFireOrder(order) && !isFleetStanceOrder(order) && !isFleetEngageOrder(order);
}

/**
 * Validates what order_fleet takes: `fleet` (required), `wing` or `squad` narrowing it, `by`, and `order`, a movement
 * or warp order (normalizeShipOrder's rules) or a document order. Unknown keys are problems.
 *
 * @param input - The candidate request.
 * @param context - The scene's ship ids and the message prefix.
 * @returns The request with the order's defaults filled in.
 * @throws {SceneError} With every problem found.
 */
export function normalizeFleetOrderRequest(input: unknown, context: FleetOrderRequestContext = {}): FleetOrderRequest {
  const where = context.where ?? 'order_fleet';
  const problems: string[] = [];
  let request: Maybe<FleetOrderRequest> = null;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { fleet, wing? | squad?, by?, order }`);
  } else {
    for (const key of Object.keys(input)) {
      if (key === 'ships') problems.push(`${where}.ships: order_fleet orders a fleet, wing or squad; order_ship orders single ships`);
      else if (!REQUEST_KEYS.has(key)) problems.push(`${where}.${key} is not an order_fleet field`);
    }
    const { fleet, wing, squad, by, delay } = input;
    const selection = fleet == null ? null : readFleetSelection({ fleet, wing, squad }, where, problems);
    if (fleet == null) problems.push(`${where}.fleet is required: the fleet to order (narrow it with wing or squad)`);
    if (by != null && (typeof by !== 'string' || !ID_PATTERN.test(by))) problems.push(`${where}.by ${ID_MESSAGE}`);
    if (delay != null && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 1)) problems.push(`${where}.delay must be a number in [0, 1]: 0 the pilots respond at once, 1 very delayed (up to ${MAX_FLEET_ORDER_DELAY} s)`);
    const order = readFleetOrder(input['order'], { ships: context.ships, objects: context.objects, where: `${where}.order` }, problems);
    if (order?.type === 'engage' && (wing != null || squad != null)) problems.push(`${where}.order: engage hands a whole fleet back to its FC brain; drop wing and squad`);
    if (selection?.fleet && order) {
      request = {
        fleet: selection.fleet,
        ...(selection.wing ? { wing: selection.wing } : {}),
        ...(selection.squad ? { squad: selection.squad } : {}),
        ...(typeof by === 'string' ? { by } : {}),
        ...(typeof delay === 'number' ? { delay } : {}),
        order
      };
    }
  }
  if (problems.length || !request) throw new SceneError(problems);
  return request;
}

interface ReadOrderContext {
  readonly ships?: ReadonlySet<string>;
  readonly objects?: ReadonlySet<string>;
  readonly where: string;
}

function readFleetOrder(input: unknown, context: ReadOrderContext, problems: string[]): Maybe<FleetOrder> {
  const { where } = context;
  let order: Maybe<FleetOrder> = null;
  const type = isPlainObject(input) ? input['type'] : undefined;
  if (!isPlainObject(input)) problems.push(`${where} is required: an object with a type (${FLEET_ORDER_TYPES.join(', ')})`);
  else if (type === 'rejoin') problems.push(`${where}.type: rejoin is order_ship's, for one ship; use regroup`);
  else if (typeof type !== 'string' || !(FLEET_ORDER_TYPES as readonly string[]).includes(type)) problems.push(`${where}.type must be one of ${FLEET_ORDER_TYPES.join(', ')}`);
  // Read at call time, not at load: see FLEET_ORDER_TYPES.
  else if ((SHIP_ORDER_TYPES as readonly string[]).includes(type)) order = readShipOrder(input, context, problems);
  else if (type === 'targets') order = readFleetTargetsOrder(input, context, problems);
  else if (type === 'free-fire') order = readFreeFireOrder(input, where, problems);
  else if (type === 'stance') order = readStanceOrder(input, { where, ships: context.ships }, problems);
  else if (type === 'engage') order = readEngageOrder(input, where, problems);
  else order = readStructureOrder(input, type as FleetStructureOrderType, context, problems);
  return order;
}

function readShipOrder(input: JsonObject, context: ReadOrderContext, problems: string[]): Maybe<ShipOrder> {
  let order: Maybe<ShipOrder> = null;
  try {
    order = normalizeShipOrder(input, { ships: context.ships, objects: context.objects, where: context.where });
  } catch (error) {
    if (!(error instanceof SceneError)) throw error;
    problems.push(...error.problems);
  }
  return order;
}

function readFreeFireOrder(input: JsonObject, where: string, problems: string[]): Maybe<FleetFreeFireOrder> {
  const before = problems.length;
  for (const key of Object.keys(input)) if (key !== 'type' && key !== 'on') problems.push(`${where}.${key} is not a free-fire order field`);
  const on = input['on'];
  if (typeof on !== 'boolean') problems.push(`${where}.on must be true (each member without a call picks its own target) or false (free fire ends)`);
  return problems.length > before ? null : { type: 'free-fire', on: on === true };
}

function readEngageOrder(input: JsonObject, where: string, problems: string[]): Maybe<FleetEngageOrder> {
  const before = problems.length;
  for (const key of Object.keys(input)) if (key !== 'type') problems.push(`${where}.${key} is not an engage order field (engage takes only its type)`);
  return problems.length > before ? null : { type: 'engage' };
}

const STRUCTURE_KEYS: Readonly<Record<FleetStructureOrderType, ReadonlySet<string>>> = {
  anchor: new Set(['type', 'ship', 'range']),
  'break-off': new Set(['type', 'ship', 'range']),
  regroup: new Set(['type'])
};

function readStructureOrder(input: JsonObject, type: FleetStructureOrderType, context: ReadOrderContext, problems: string[]): Maybe<FleetStructureOrder> {
  const { where } = context;
  const before = problems.length;
  const article = type === 'anchor' ? 'an' : 'a';
  for (const key of Object.keys(input)) if (!STRUCTURE_KEYS[type].has(key)) problems.push(`${where}.${key} is not ${article} ${type} order field`);
  const { ship, range } = input;
  const readShip = (): void => {
    if (ship == null) return;
    if (typeof ship !== 'string' || !ID_PATTERN.test(ship)) problems.push(`${where}.ship ${ID_MESSAGE}`);
    else if (context.ships && !context.ships.has(ship)) problems.push(`${where}.ship: no ship "${ship}"`);
  };
  const readRange = (): void => {
    if (range != null && (typeof range !== 'number' || !Number.isFinite(range) || range < 0 || range > MAX_ORDER_RANGE)) problems.push(`${where}.range must be a number in [0, ${MAX_ORDER_RANGE}] (metres)`);
  };

  let order: Maybe<FleetStructureOrder> = null;
  if (type === 'anchor') {
    if (!('ship' in input) && !('range' in input)) problems.push(`${where} needs ship or range (null resets ship to the FC, range to the role default)`);
    readShip();
    readRange();
    order = { type, ...('ship' in input ? { ship: (ship as Maybe<string>) ?? null } : {}), ...('range' in input ? { range: (range as Maybe<number>) ?? null } : {}) };
  } else if (type === 'break-off') {
    readShip();
    readRange();
    order = { type, ...(typeof ship === 'string' ? { ship } : {}), range: typeof range === 'number' ? range : DEFAULT_BREAK_OFF_RANGE };
  } else {
    order = { type };
  }
  return problems.length > before ? null : order;
}

/**
 * The group a request selects.
 *
 * @param request - The request's selection.
 * @returns Its squad, else its wing, else the fleet.
 */
export function toFleetGroup(request: Pick<FleetOrderRequest, 'fleet' | 'wing' | 'squad'>): FleetGroup {
  let group: FleetGroup = { fleet: request.fleet, kind: 'fleet', id: request.fleet };
  if (request.squad) group = { fleet: request.fleet, kind: 'squad', id: request.squad };
  else if (request.wing) group = { fleet: request.fleet, kind: 'wing', id: request.wing };
  return group;
}

/**
 * An order_fleet request resolved against the document.
 */
export interface ResolvedFleetOrder {
  readonly request: FleetOrderRequest;
  readonly group: FleetGroup;
  /**
   * The ships the order moves, in ships[] order: selectFleetShips of the group, without the FC for a wing or squad.
   */
  readonly ships: string[];
  /**
   * The ship the group flies on: it takes a movement order and leads a warp.
   */
  readonly leader: string;
  /**
   * Who gives the order: `by`, or the first of `commanders`.
   */
  readonly issuer: string;
  /**
   * The ships commanding the group, nearest first: its squad commander, its wing's commander, the FC (set ones only).
   */
  readonly commanders: string[];
}

interface GroupPlace {
  readonly fleet: SceneFleet;
  readonly wing: Maybe<SceneWing>;
  readonly squad: Maybe<SceneSquad>;
}

function placeOf(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): Maybe<GroupPlace> {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let place: Maybe<GroupPlace> = null;
  if (fleet && group.kind === 'fleet') place = { fleet, wing: null, squad: null };
  else if (fleet && group.kind === 'wing') {
    const wing = fleet.wings.find((candidate) => candidate.id === group.id);
    if (wing) place = { fleet, wing, squad: null };
  } else if (fleet) {
    const wing = fleet.wings.find((candidate) => candidate.squads.some((squad) => squad.id === group.id));
    const squad = wing?.squads.find((candidate) => candidate.id === group.id);
    if (wing && squad) place = { fleet, wing, squad };
  }
  return place;
}

/**
 * Resolves a request against the document: the group's ships, who commands it, who gives the order and which ship
 * leads it.
 *
 * - The FC is never part of a wing or squad order: it heads the whole fleet, so ordering it moves everyone.
 * - Commanders, nearest first: the squad's commander, its wing's commander, the FC (set ones only). `by` must be one
 *   of them; omitted, the nearest gives the order. One rule for every order type, warps included.
 * - The leader: the FC for a fleet. For a squad, its commander, else the issuer when it is in the squad, else its lead
 *   (the member it anchors on), else its first member. For a wing, its commander, else the issuer when it is in the
 *   wing, else the leader of its first squad with ships. Never the FC.
 * - A movement or warp order may not target one of the group's own ships, nor may a targets order call one (it may
 *   drop one: membership can change after a call).
 *
 * @param scene - The normalized document.
 * @param request - A normalized request.
 * @returns The resolved order.
 * @throws {SceneError} For an unknown or empty group, a giver without command of it, or a target in the group.
 */
export function resolveFleetOrderRequest(scene: Pick<SceneDocument, 'ships' | 'fleets'>, request: FleetOrderRequest): ResolvedFleetOrder {
  const where = 'order_fleet';
  const group = toFleetGroup(request);
  const selected = selectFleetShips(scene, request, where);
  const place = placeOf(scene, group);
  if (selected.problems.length || !place) throw new SceneError(selected.problems.length ? selected.problems : [`${where}: no ${describeFleetGroup(group)}`]);

  const { fleet, wing, squad } = place;
  const fc = fleet.commander;
  const ships = group.kind === 'fleet' ? selected.ships : selected.ships.filter((id) => id !== fc);
  if (!ships.length) throw new SceneError([`${where}: ${group.kind} "${group.id}" has no ships to order (the FC never joins a wing or squad order)`]);

  const chain: { readonly ship: string; readonly label: string }[] = [];
  if (squad?.commander) chain.push({ ship: squad.commander, label: 'squad' });
  if (wing?.commander) chain.push({ ship: wing.commander, label: `wing "${wing.id}"` });
  chain.push({ ship: fc, label: 'fleet' });
  const commanders = [...new Set(chain.map((link) => link.ship))];
  const by = request.by;
  if (by != null && !commanders.includes(by)) {
    const listed = chain.filter((link, index) => chain.findIndex((other) => other.ship === link.ship) === index).map((link) => `"${link.ship}" (${link.label})`);
    const named = listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}` : listed[0];
    throw new SceneError([`${where}: ship "${by}" has no command over ${describeFleetGroup(group)}: its commanders are ${named}; a warp, like any fleet order, is given by one of them (the FC warps the fleet, a wing commander their wing, a squad commander their squad)`]);
  }
  const issuer = by ?? commanders[0];

  const inGroup = new Set(ships);
  let leader = fc;
  if (group.kind === 'squad' && squad) leader = squadLeader({ squad, fc, issuer: inGroup.has(issuer) ? issuer : null });
  else if (group.kind === 'wing' && wing) leader = wingLeader({ wing, fc, issuer: inGroup.has(issuer) ? issuer : null, inGroup });

  const order = request.order;
  const target = isFleetShipOrder(order) ? shipOrderTarget(order) : null;
  if (target && inGroup.has(target)) throw new SceneError([`${where}.order.target: ${describeFleetGroup(group)} cannot target one of its own ships ("${target}")`]);
  const on = isFleetStanceOrder(order) ? order.set?.on : null;
  if (on != null && typeof on === 'object') {
    const kind = 'squad' in on ? 'squad' : 'wing';
    const id = 'squad' in on ? on.squad : on.wing;
    const held = kind === 'wing' ? fleet.wings.some((candidate) => candidate.id === id) : fleet.wings.some((candidate) => candidate.squads.some((other) => other.id === id));
    if (!held) throw new SceneError([`${where}.order.set.on: fleet "${fleet.id}" has no ${kind} "${id}"`]);
  }
  if (isFleetTargetsOrder(order)) {
    const own = new Set(selected.ships);
    const called = fleetTargetsOrderCalls(order).filter((id) => own.has(id));
    if (called.length) throw new SceneError(called.map((id) => `${where}.order: ${describeFleetGroup(group)} cannot call one of its own ships ("${id}")`));
  }

  return { request, group, ships, leader, issuer, commanders };
}

/**
 * The ship a group flies on when it is ordered without `by` (resolveFleetOrderRequest's leader rule, its nearest
 * commander giving the order): the FC for a fleet, a wing's or squad's leader otherwise. A group stance flown in line
 * is flown by it (piloting/stances.ts).
 *
 * @param scene - The document, or the live fleet view.
 * @param group - The fleet, wing or squad.
 * @returns Its leader; null for an unknown group.
 */
export function fleetGroupLeaderOf(scene: Pick<SceneDocument, 'ships' | 'fleets'>, group: FleetGroup): Maybe<string> {
  const place = placeOf(scene, group);
  let leader: Maybe<string> = place?.fleet.commander ?? null;
  if (place && group.kind !== 'fleet') {
    const { fleet, wing, squad } = place;
    const fc = fleet.commander;
    const issuer = squad?.commander ?? wing?.commander ?? fc;
    const selection = group.kind === 'wing' ? { fleet: fleet.id, wing: group.id } : { fleet: fleet.id, squad: group.id };
    const inGroup = new Set(selectFleetShips(scene, selection, 'stance').ships.filter((id) => id !== fc));
    if (squad) leader = squadLeader({ squad, fc, issuer: inGroup.has(issuer) ? issuer : null });
    else if (wing) leader = wingLeader({ wing, fc, issuer: inGroup.has(issuer) ? issuer : null, inGroup });
  }
  return leader;
}

interface SquadLeaderInput {
  readonly squad: SceneSquad;
  readonly fc: string;
  readonly issuer: Maybe<string>;
}

function squadLeader(input: SquadLeaderInput): string {
  const { squad, fc, issuer } = input;
  const lead = squad.anchor?.ship && squad.anchor.ship !== fc && squad.members.includes(squad.anchor.ship) ? squad.anchor.ship : null;
  const candidates = [squad.commander, issuer, lead, ...squad.members];
  return candidates.find((ship): ship is string => typeof ship === 'string' && ship !== fc && squad.members.includes(ship)) ?? fc;
}

interface WingLeaderInput {
  readonly wing: SceneWing;
  readonly fc: string;
  readonly issuer: Maybe<string>;
  readonly inGroup: ReadonlySet<string>;
}

function wingLeader(input: WingLeaderInput): string {
  const { wing, fc, issuer, inGroup } = input;
  let leader: Maybe<string> = wing.commander && wing.commander !== fc ? wing.commander : issuer;
  if (!leader) {
    const squad = wing.squads.find((candidate) => candidate.members.some((member) => member !== fc && inGroup.has(member)));
    leader = squad ? squadLeader({ squad, fc, issuer: null }) : null;
  }
  return leader ?? fc;
}

/**
 * The squads a group spans.
 *
 * @param fleet - The group's fleet.
 * @param group - The group.
 * @returns The fleet's squads, the wing's, or the one squad.
 */
function squadsOfGroup(fleet: SceneFleet, group: FleetGroup): SceneSquad[] {
  let squads: SceneSquad[] = fleet.wings.flatMap((wing) => wing.squads);
  if (group.kind === 'wing') squads = fleet.wings.find((wing) => wing.id === group.id)?.squads ?? [];
  else if (group.kind === 'squad') squads = squads.filter((squad) => squad.id === group.id);
  return squads;
}

/**
 * The fleet patch ops a document order compiles to; none for a movement or warp order.
 *
 * - `anchor { ship?, range? }`: one `set_anchor` per squad of the group, with the keys given (null resets).
 * - `break-off { ship?, range }` (one squad only): `update_squad` anchoring it on its lead (`ship`, else its commander,
 *   else its current lead, else its first member; never the FC) at `range`, with `home` = its anchor before (`{}` for
 *   the defaults) unless it already has a home, so a second break-off keeps the first.
 * - `regroup`: for every squad of the group with a home, `update_squad` restoring the home (`null` for `{}`) and
 *   clearing it.
 *
 * - `targets`: one update_fleet, update_wing or update_squad setting the group's called targets, or none when the list
 *   is unchanged (toFleetTargetOperations; `options.statusOf` gives `next` the live primary).
 *
 * Break-off then regroup gives the document's fleets back exactly.
 *
 * @param scene - The normalized document the request was resolved against.
 * @param resolved - The resolved order.
 * @param options - The page's live target status, for a targets order's `next`.
 * @returns The ops, for applySceneOperations.
 * @throws {SceneError} For an anchor on a group with no squads, a break-off of a wing or fleet, or a break-off ship
 *   that is not a member of the squad; for a targets order, see toFleetTargetOperations.
 */
export function toFleetOrderOperations(scene: Pick<SceneDocument, 'ships' | 'fleets'>, resolved: ResolvedFleetOrder, options: FleetTargetOperationsOptions = {}): JsonObject[] {
  const { group, request } = resolved;
  const order = request.order;
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  const where = 'order_fleet';
  let operations: JsonObject[] = [];
  if (fleet && isFleetTargetsOrder(order)) return toFleetTargetOperations(scene, group, order, options);
  if (!fleet || !isFleetStructureOrder(order)) return operations;

  const squads = squadsOfGroup(fleet, group);
  if (order.type === 'anchor') {
    if (!squads.length) throw new SceneError([`${where}: ${describeFleetGroup(group)} has no squads to anchor`]);
    const anchor: JsonObject = { ...(order.ship !== undefined ? { ship: order.ship } : {}), ...(order.range !== undefined ? { range: order.range } : {}) };
    operations = squads.map((squad) => ({ op: 'set_anchor', fleet: fleet.id, squad: squad.id, anchor: { ...anchor } }));
  } else if (order.type === 'break-off') {
    const squad = group.kind === 'squad' ? squads[0] : null;
    if (!squad) throw new SceneError([`${where}: break-off takes one squad; give squad`]);
    const fc = fleet.commander;
    if (order.ship && (order.ship === fc || !squad.members.includes(order.ship))) {
      throw new SceneError([`${where}.order.ship: "${order.ship}" is not a member of squad "${squad.id}" it can break off on (the FC never breaks off)`]);
    }
    const lead = order.ship ?? squadLeader({ squad, fc, issuer: null });
    const set: JsonObject = { anchor: { ship: lead, range: order.range }, ...(squad.home ? {} : { home: toAnchorJson(squad.anchor ?? {}) }) };
    operations = [{ op: 'update_squad', fleet: fleet.id, squad: squad.id, set }];
  } else {
    operations = squads
      .filter((squad) => squad.home)
      .map((squad) => {
        const home = squad.home ?? {};
        return { op: 'update_squad', fleet: fleet.id, squad: squad.id, set: { anchor: Object.keys(home).length ? toAnchorJson(home) : null, home: null } };
      });
  }
  return operations;
}

function toAnchorJson(anchor: SceneSquadAnchor): JsonObject {
  return { ...(anchor.ship ? { ship: anchor.ship } : {}), ...(anchor.range != null ? { range: anchor.range } : {}) };
}

/**
 * What a fleet, wing or squad is doing, the first that applies: `warping` (a group warp still under way), `regrouping`
 * (a regroup's ships not yet back in formation), `moving` (its leader flies an order other than stop, or still moves),
 * `broken-off` (a wing or squad flying apart, or a squad with a home), `idle`.
 */
export const FLEET_GROUP_STATES = ['idle', 'moving', 'warping', 'broken-off', 'regrouping'] as const;

export type FleetGroupState = (typeof FLEET_GROUP_STATES)[number];

/**
 * A group warp's ships by progress.
 */
export interface FleetGroupWarpReport {
  readonly leader: string;
  /**
   * Warp ordered, not yet at the boundary that applies it, or aligning.
   */
  readonly aligning: number;
  /**
   * In proper warp.
   */
  readonly warping: number;
  readonly landed: number;
  /**
   * Formation warps dropped at the boundary (refused), which fly instead.
   */
  readonly dropped: number;
  /**
   * Ships the order skipped (in warp, unable to move, or too close to their slot).
   */
  readonly skipped: number;
}

/**
 * A fleet's, wing's or squad's command, as get_state reports it.
 */
export interface FleetGroupCommandReport {
  readonly state: FleetGroupState;
  /**
   * The ship the group flies on: the FC for a fleet; for a wing or squad apart from its fleet, its leader.
   */
  readonly leader?: string;
  /**
   * A wing or squad flying apart from its fleet's formation (after its move or warp).
   */
  readonly away?: boolean;
  /**
   * A broken-off squad: the anchor regroup restores (the document's home).
   */
  readonly home?: SceneSquadAnchor;
  /**
   * What the leader's ball flies now, while it moves.
   */
  readonly order?: ShipOrder;
  /**
   * The last order_fleet on this group: the order as normalized, who gave it, and its tick.
   */
  readonly last?: { readonly order: FleetOrder; readonly by: string; readonly tick: number };
  /**
   * During a group warp: its ships by progress.
   */
  readonly warp?: FleetGroupWarpReport;
  /**
   * While regrouping: how many of its ships are not yet in formation.
   */
  readonly regrouping?: number;
}

export interface PilotDelaysInput {
  /**
   * The order's group key (toFleetGroupKey), part of the seed.
   */
  readonly key: string;
  /**
   * The tick the order was given at, part of the seed.
   */
  readonly tick: number;
  /**
   * The request's delay, 0 to 1. Given, it wins over every reaction (0: all at once).
   */
  readonly delay?: Maybe<number>;
  /**
   * The ships that respond.
   */
  readonly ships: readonly string[];
  /**
   * The ship giving the order: it responds at once.
   */
  readonly issuer: string;
  /**
   * A ship's reaction, 0..1 (higher is faster: ships[].pilot, or its personality fleet's draw), for an order given with
   * no delay; null answers at once. Warps and regroups pass none: a fleet warp is simultaneous.
   */
  readonly reactionOf?: (ship: string) => Maybe<number>;
}

/**
 * Each pilot's response time to a fleet order, in whole seconds (Destiny ticks), from a hash of the group key, the tick
 * and the ship id (`u`, in [0, 1)), so the same order at the same tick (a timeline replay) responds the same way. The
 * giver responds at once.
 *
 * - With a delay: uniform, `round(delay × MAX_FLEET_ORDER_DELAY × u)`.
 * - Without one, from the ship's reaction `r`: `round((1 − r) × MAX_FLEET_ORDER_DELAY × (0.5 + 0.5u))`, so reaction 1
 *   answers at once and 0 within 5 to 10 s. A ship with no reaction answers at once.
 *
 * @param input - The seed, the delay or the reactions, the ships and the giver.
 * @returns Seconds per ship, in `ships` order; all 0 for a delay of 0.
 */
export function toPilotDelays(input: PilotDelaysInput): Map<string, number> {
  const { key, tick, delay, ships, issuer, reactionOf } = input;
  const most = delay == null ? 0 : Math.max(0, Math.min(1, delay)) * MAX_FLEET_ORDER_DELAY;
  const delayOf = (ship: string): number => {
    const reaction = delay == null && ship !== issuer ? reactionOf?.(ship) : null;
    let seconds = 0;
    if (ship !== issuer && most > 0) seconds = Math.round(most * unitHash(`${key}|${tick}|${ship}`));
    else if (reaction != null) seconds = Math.round((1 - Math.max(0, Math.min(1, reaction))) * MAX_FLEET_ORDER_DELAY * (0.5 + 0.5 * unitHash(`${key}|${tick}|${ship}`)));
    return seconds;
  };
  return new Map(ships.map((ship) => [ship, delayOf(ship)]));
}

/**
 * FNV-1a of a string, mixed with murmur3's finalizer, as a number in [0, 1). FNV-1a alone barely moves its high bits
 * for a change in the last character, so ids such as `tfis-logi-01` … `-08` would all draw about the same delay.
 *
 * @param text - The seed.
 * @returns The hash over 2^32.
 */
export function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}
