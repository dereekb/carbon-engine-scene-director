/**
 * Stances in the document and as live orders (sd-piloting): the `stance` a fleet, wing, squad or ship carries, how each
 * ship's resolves down its chain (resolveShipStances), the stance order order_fleet and order_ship take, and the
 * removal pruning. The page's pilots fly what this resolves.
 *
 * - Precedence: the ship's own > its squad > its wing > its fleet (the FC: its own > the fleet's). `type`, `on` and
 *   `range` come together from the nearest level that sets `type`; `propMods`, `formation` and `disengage` key by key.
 * - Who flies it (`flownBy`): the ship itself for its own type or a loose formation; else the leader of the group whose
 *   level set the type (fleetGroupLeaderOf: the FC for a fleet), the members holding formation on it. No type and not
 *   loose: `in-line`, today's Follow the FC. Loose with no type: the role's default (STANCE_ROLE_DEFAULTS).
 * - Live: order_fleet's and order_ship's stance orders fill the page's stance book (by group key and by ship id), which
 *   splices over the document (LiveFleetOverlay.stances, resolveShipStances' `ships`), never written; a load resets it.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject, reportUnknownKeys } from '../json';
import { MAX_ORDER_RANGE } from '../orders';
import type { SceneDocument } from '../scene';
import type { SceneFleet, SquadRole } from '../fleets/fleet';
import { type FleetGroup, toFleetGroupKey } from '../fleets/group';
import type { FleetOperationContext } from '../fleets/operations';
import { type ShipFleetMembership, toFleetMemberships } from '../fleets/membership';
import { fleetGroupLeaderOf } from '../fleets/orders';
import type { TimelineRemoval } from '../timeline/prune';
import {
  DEFAULT_DISENGAGE,
  type PilotStance,
  SHIP_STANCE_FORMATIONS,
  SHIP_STANCE_PROP_MODS,
  SHIP_STANCE_RANGE_KEYWORDS,
  SHIP_STANCE_TYPES,
  type ShipStance,
  type ShipStanceFormation,
  type ShipStanceOn,
  type ShipStancePropMods,
  type ShipStanceRange,
  type ShipStanceType
} from './stance';

/**
 * What a loose member with no stance type flies: its squad's role picks (logi support, tackle tackle, the rest auto).
 */
export const STANCE_ROLE_DEFAULTS: Readonly<Record<SquadRole, Exclude<ShipStanceType, 'in-line'>>> = {
  dps: 'auto',
  logi: 'support',
  tackle: 'tackle',
  ewar: 'auto',
  boost: 'auto',
  support: 'auto'
};

const STANCE_KEYS = new Set<string>(['type', 'on', 'range', 'propMods', 'formation', 'disengage']);
const STANCE_ORDER_KEYS = new Set<string>(['type', 'set', 'clear']);
const ON_GROUP_KINDS = ['squad', 'wing'] as const;

const STANCE_SHAPE = '{ type?, on?, range?, propMods?, formation?, disengage? }';

/**
 * Where a stance sits: on a fleet, wing or squad (`group`), or on one ship, which flies it alone (no `formation`).
 */
export type StanceLevel = 'group' | 'ship';

export interface ReadSceneStanceContext {
  /**
   * Where the field sits, for messages.
   */
  readonly where: string;
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * Default `group`.
   */
  readonly level?: StanceLevel;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function readStanceOn(value: unknown, where: string, problems: string[]): Maybe<ShipStanceOn> {
  let on: Maybe<ShipStanceOn> = null;
  const message = `${where} must be "focus", a ship id, { "squad": "<id>" } or { "wing": "<id>" } (its leader)`;
  if (typeof value === 'string') {
    if (value === 'focus' || ID_PATTERN.test(value)) on = value;
    else problems.push(message);
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const kind = keys.length === 1 ? ON_GROUP_KINDS.find((candidate) => candidate === keys[0]) : undefined;
    const id = kind ? value[kind] : undefined;
    if (kind && typeof id === 'string' && ID_PATTERN.test(id)) on = kind === 'squad' ? { squad: id } : { wing: id };
    else problems.push(message);
  } else {
    problems.push(message);
  }
  return on;
}

function isRangeMetres(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_ORDER_RANGE;
}

function readStanceRange(value: unknown, where: string, problems: string[]): Maybe<ShipStanceRange> {
  let range: Maybe<ShipStanceRange> = null;
  if (isRangeMetres(value) || isOneOf(SHIP_STANCE_RANGE_KEYWORDS, value)) range = value;
  else if (Array.isArray(value) && value.length === 2 && isRangeMetres(value[0]) && isRangeMetres(value[1]) && value[0] <= value[1]) range = [value[0], value[1]];
  else problems.push(`${where} must be metres (0 to ${MAX_ORDER_RANGE}), a band [min, max] with min <= max, or one of ${SHIP_STANCE_RANGE_KEYWORDS.join(', ')}`);
  return range;
}

/**
 * Reads a fleet's, wing's, squad's or ship's `stance`. Unknown keys warn and are dropped; so does `formation` on a
 * ship, which flies its own stance alone.
 *
 * @param value - The candidate field.
 * @param context - Where it sits, its level, and where problems and warnings go.
 * @returns The field, or null when absent, null or empty (normalize omits it).
 */
export function readSceneStance(value: unknown, context: ReadSceneStanceContext): Maybe<ShipStance> {
  const { where, problems, warnings } = context;
  let field: Maybe<ShipStance> = null;
  if (value != null && !isPlainObject(value)) {
    problems.push(`${where} must be an object ${STANCE_SHAPE}: how its pilots fly`);
  } else if (value != null) {
    reportUnknownKeys(value, STANCE_KEYS, where, warnings);
    const read = { ...readStanceChoices(value, context), ...readStanceTerms(value, context) };
    for (const key of Object.keys(read) as (keyof ShipStance)[]) if (read[key] === undefined) delete read[key];
    if (Object.keys(read).length) field = read;
  }
  return field;
}

type MutableStance = { -readonly [K in keyof ShipStance]: ShipStance[K] };

/**
 * A stance's enumerated keys: type, propMods, formation.
 *
 * @param value - The stance object.
 * @param context - Where it sits, its level, and where problems and warnings go.
 * @returns The keys read.
 */
function readStanceChoices(value: JsonObject, context: ReadSceneStanceContext): MutableStance {
  const { where, problems, warnings } = context;
  const { type, propMods, formation } = value;
  const read: MutableStance = {};
  if (type != null && !isOneOf(SHIP_STANCE_TYPES, type)) problems.push(`${where}.type must be one of ${SHIP_STANCE_TYPES.join(', ')}`);
  else if (type != null) read.type = type;
  if (propMods != null && !isOneOf(SHIP_STANCE_PROP_MODS, propMods)) problems.push(`${where}.propMods must be one of ${SHIP_STANCE_PROP_MODS.join(', ')}`);
  else if (propMods != null) read.propMods = propMods;
  if (formation != null && context.level === 'ship') warnings.push(`${where}.formation is dropped: a ship's own stance flies that ship alone (formation is a fleet's, wing's or squad's)`);
  else if (formation != null && !isOneOf(SHIP_STANCE_FORMATIONS, formation)) problems.push(`${where}.formation must be one of ${SHIP_STANCE_FORMATIONS.join(', ')} (in-line: the group's leader flies it, the rest hold formation; loose: every member flies it alone)`);
  else if (formation != null) read.formation = formation;
  return read;
}

/**
 * A stance's measured keys: on, range, disengage.
 *
 * @param value - The stance object.
 * @param context - Where it sits and where problems go.
 * @returns The keys read.
 */
function readStanceTerms(value: JsonObject, context: ReadSceneStanceContext): MutableStance {
  const { where, problems } = context;
  const { on, range, disengage } = value;
  const read: MutableStance = {};
  if (on != null) read.on = readStanceOn(on, `${where}.on`, problems) ?? undefined;
  if (range != null) read.range = readStanceRange(range, `${where}.range`, problems) ?? undefined;
  if (disengage != null && (typeof disengage !== 'number' || !Number.isFinite(disengage) || disengage < 0 || disengage >= 1)) problems.push(`${where}.disengage must be a number in [0, 1): the HP fraction its pilots burn out at`);
  else if (disengage != null) read.disengage = disengage;
  return read;
}

export interface CheckStanceReferencesInput {
  readonly stance: Maybe<ShipStance>;
  readonly where: string;
  /**
   * The scene's ship ids: an `on` ship must be one of them.
   */
  readonly shipIds: ReadonlySet<string>;
  /**
   * The fleet an `on` squad or wing must be in: the stance's fleet, or the ship's. Null: a ship in no fleet.
   */
  readonly fleet: Maybe<Pick<SceneFleet, 'id' | 'wings'>>;
  /**
   * The ship whose own stance it is: it cannot fly on itself.
   */
  readonly self?: string;
  readonly problems: string[];
  /**
   * Where a ship's own `{ squad }` or `{ wing }` that its fleet does not hold warns (it flies on its focus instead).
   * Absent: a problem, as on a group.
   */
  readonly warnings?: string[];
}

/**
 * Checks what a stance's `on` names: a ship of the scene (not the ship itself), or a squad or wing of its fleet.
 *
 * @param input - The stance, its fleet and the scene's ship ids.
 */
export function checkStanceReferences(input: CheckStanceReferencesInput): void {
  const { stance, where, shipIds, fleet, self, problems, warnings } = input;
  const on = stance?.on;
  if (typeof on === 'string' && on !== 'focus') {
    if (!shipIds.has(on)) problems.push(`${where}.on "${on}" is not a ship id`);
    else if (on === self) problems.push(`${where}.on: a ship cannot fly a stance on itself`);
  } else if (on != null && typeof on === 'object') {
    const kind = 'squad' in on ? 'squad' : 'wing';
    const id = 'squad' in on ? on.squad : on.wing;
    if (!fleet || !stanceGroupExists(fleet, kind, id)) {
      const holder = fleet ? 'fleet "' + fleet.id + '"' : 'the ship is in no fleet, so it';
      const message = `${where}.on: ${holder} has no ${kind} "${id}"`;
      if (warnings) warnings.push(`${message}; it flies on its focus`);
      else problems.push(message);
    }
  }
}

function stanceGroupExists(fleet: Pick<SceneFleet, 'wings'>, kind: 'squad' | 'wing', id: string): boolean {
  return kind === 'wing' ? fleet.wings.some((wing) => wing.id === id) : fleet.wings.some((wing) => wing.squads.some((squad) => squad.id === id));
}

/**
 * Checks every ship's own stance against the scene: its `on` ship, or a squad or wing of the ship's fleet (a group its
 * fleet does not hold warns; the ship flies on its focus).
 *
 * @param scene - The normalized ships and fleets.
 * @param problems - Where problems go.
 * @param warnings - Where warnings go.
 */
export function checkShipStances(scene: Pick<SceneDocument, 'ships' | 'fleets'>, problems: string[], warnings: string[]): void {
  const shipIds = new Set(scene.ships.map((ship) => ship.id));
  const memberships = toFleetMemberships(scene);
  for (const [index, ship] of scene.ships.entries()) {
    if (!ship.stance) continue;
    const fleetId = memberships.get(ship.id)?.fleet;
    const fleet = fleetId == null ? null : scene.fleets?.find((candidate) => candidate.id === fleetId);
    checkStanceReferences({ stance: ship.stance, where: `ships[${index}].stance`, shipIds, fleet, self: ship.id, problems, warnings });
  }
}

/**
 * The level a resolved key came from: one in the ship's chain, its squad's `role` (a loose member's type), or the
 * `default`.
 */
export type StanceSource = 'ship' | 'squad' | 'wing' | 'fleet' | 'role' | 'default';

export interface ResolvedStanceSources {
  /**
   * Where `type`, `on` and `range` came from.
   */
  readonly type: StanceSource;
  readonly propMods: StanceSource;
  readonly formation: StanceSource;
  readonly disengage: StanceSource;
}

/**
 * A ship's stance, resolved down its chain.
 */
export interface ResolvedShipStance {
  /**
   * `in-line`: no stance flies the ship (it holds its formation slot, or does what it is told).
   */
  readonly type: ShipStanceType;
  readonly on: ShipStanceOn;
  readonly range: ShipStanceRange;
  readonly propMods: ShipStancePropMods;
  readonly formation: ShipStanceFormation;
  readonly disengage: number;
  readonly sources: ResolvedStanceSources;
  /**
   * The group whose level set the type; absent for the ship's own, a role default or in-line.
   */
  readonly group?: FleetGroup;
  /**
   * Who flies it: the ship itself (its own type, or a loose formation), the leader of `group` (an in-line group stance:
   * the ship holds formation on it), or null (in-line).
   */
  readonly flownBy: Maybe<string>;
  /**
   * What the ship's pilot flies when the ship flies the stance itself: `on` as a ship id (a squad or wing: its leader;
   * null: the focus).
   */
  readonly pilot?: PilotStance;
}

export interface ResolveShipStancesOptions {
  /**
   * The stance book's per-ship stances (order_ship): each replaces its ship's document stance, null clearing it.
   */
  readonly ships?: ReadonlyMap<string, Maybe<ShipStance>>;
}

type StanceLink = readonly [StanceSource, Maybe<ShipStance>, Maybe<FleetGroup>];

/**
 * Every ship's stance, resolved down its chain (the module comment's rules). Pass the live fleet view
 * (toLiveFleetScene with the stance book's group stances) and the book's ship stances to resolve the live stances.
 *
 * @param scene - The document, or the live fleet view.
 * @param options - The stance book's per-ship stances.
 * @returns Each ship's, keyed by id, in ships[] order.
 */
export function resolveShipStances(scene: Pick<SceneDocument, 'ships' | 'fleets'>, options: ResolveShipStancesOptions = {}): Map<string, ResolvedShipStance> {
  const memberships = toFleetMemberships(scene);
  const fleets = new Map((scene.fleets ?? []).map((fleet) => [fleet.id, fleet]));
  const leaders = new Map<string, Maybe<string>>();
  const leaderOf = (group: FleetGroup): Maybe<string> => {
    const key = toFleetGroupKey(group);
    if (!leaders.has(key)) leaders.set(key, fleetGroupLeaderOf(scene, group));
    return leaders.get(key) ?? null;
  };
  const resolved = new Map<string, ResolvedShipStance>();
  for (const ship of scene.ships) {
    const id = ship.id;
    const own = options.ships?.has(id) ? options.ships.get(id) : ship.stance;
    const membership = memberships.get(id);
    const fleet = membership ? fleets.get(membership.fleet) : undefined;
    const stance = resolveStanceChain({ id, chain: stanceChainOf(own, fleet, membership), role: membership?.role, leaderOf });
    const flies = stance.type !== 'in-line' && stance.flownBy === id;
    resolved.set(id, flies ? { ...stance, pilot: toPilotStance(stance, { self: id, fleet: fleet?.id, leaderOf }) } : stance);
  }
  return resolved;
}

interface ResolveStanceChainInput {
  readonly id: string;
  readonly chain: readonly StanceLink[];
  /**
   * The ship's squad role, for a loose member's default type.
   */
  readonly role: Maybe<SquadRole>;
  readonly leaderOf: (group: FleetGroup) => Maybe<string>;
}

/**
 * One ship's stance from its chain (resolveShipStances' rules), without its pilot stance.
 *
 * @param input - The ship, its chain, its role and the group leaders.
 * @returns Its resolved stance.
 */
function resolveStanceChain(input: ResolveStanceChainInput): Omit<ResolvedShipStance, 'pilot'> {
  const { id, chain, role, leaderOf } = input;
  const from = (key: keyof ShipStance): Maybe<StanceLink> => chain.find(([, stance]) => stance?.[key] != null);
  const typeFrom = from('type');
  const propModsFrom = from('propMods');
  const formationFrom = from('formation');
  const disengageFrom = from('disengage');
  const formation = formationFrom?.[1]?.formation ?? 'in-line';
  const loose = formation === 'loose';
  let type: ShipStanceType = typeFrom?.[1]?.type ?? 'in-line';
  let typeSource: StanceSource = typeFrom?.[0] ?? 'default';
  if (!typeFrom && loose) {
    type = role ? STANCE_ROLE_DEFAULTS[role] : 'auto';
    typeSource = 'role';
  }
  const group = typeFrom?.[2] ?? null;
  let flownBy: Maybe<string> = null;
  if (type !== 'in-line') flownBy = typeSource === 'ship' || typeSource === 'role' || loose || !group ? id : leaderOf(group);
  return {
    type,
    on: typeFrom?.[1]?.on ?? 'focus',
    range: typeFrom?.[1]?.range ?? 'ideal',
    propMods: propModsFrom?.[1]?.propMods ?? 'auto',
    formation,
    disengage: disengageFrom?.[1]?.disengage ?? DEFAULT_DISENGAGE,
    sources: { type: typeSource, propMods: propModsFrom?.[0] ?? 'default', formation: formationFrom?.[0] ?? 'default', disengage: disengageFrom?.[0] ?? 'default' },
    ...(group && typeSource !== 'ship' ? { group } : {}),
    flownBy
  };
}

/**
 * A ship's stance chain, nearest first: its own, its squad's and wing's (not for the FC), its fleet's.
 *
 * @param own - The ship's own stance (the book's, else the document's).
 * @param fleet - Its fleet.
 * @param membership - Its place in the fleet.
 * @returns The levels with their stances and groups.
 */
function stanceChainOf(own: Maybe<ShipStance>, fleet: Maybe<SceneFleet>, membership: Maybe<ShipFleetMembership>): StanceLink[] {
  const chain: StanceLink[] = [['ship', own, null]];
  if (fleet && membership) {
    if (!membership.commands.includes('fleet')) {
      const wing = membership.wing == null ? null : fleet.wings.find((candidate) => candidate.id === membership.wing);
      const squad = membership.squad == null ? null : wing?.squads.find((candidate) => candidate.id === membership.squad);
      if (squad) chain.push(['squad', squad.stance, { fleet: fleet.id, kind: 'squad', id: squad.id }]);
      if (wing) chain.push(['wing', wing.stance, { fleet: fleet.id, kind: 'wing', id: wing.id }]);
    }
    chain.push(['fleet', fleet.stance, { fleet: fleet.id, kind: 'fleet', id: fleet.id }]);
  }
  return chain;
}

interface PilotStanceContext {
  readonly self: string;
  readonly fleet: Maybe<string>;
  readonly leaderOf: (group: FleetGroup) => Maybe<string>;
}

function toPilotStance(stance: Omit<ResolvedShipStance, 'pilot'>, context: PilotStanceContext): PilotStance {
  const { on } = stance;
  let ship: Maybe<string> = null;
  if (typeof on === 'string' && on !== 'focus') ship = on;
  else if (on != null && typeof on === 'object' && context.fleet != null) ship = context.leaderOf('squad' in on ? { fleet: context.fleet, kind: 'squad', id: on.squad } : { fleet: context.fleet, kind: 'wing', id: on.wing });
  return {
    type: stance.type as PilotStance['type'],
    on: ship === context.self ? null : ship,
    range: stance.range,
    propMods: stance.propMods,
    disengage: stance.disengage
  };
}

/**
 * order_fleet's and order_ship's stance order: `set` replaces the group's (or the ship's own) stance live, `clear`
 * takes it away (the levels above then apply, else in-line). Live, never saved: a load resets it.
 */
export interface StanceOrder {
  readonly type: 'stance';
  readonly set?: ShipStance;
  readonly clear?: true;
}

export interface ReadStanceOrderContext {
  readonly where: string;
  /**
   * The scene's ship ids: an `on` ship must be one of them. Unchecked when absent.
   */
  readonly ships?: ReadonlySet<string>;
  /**
   * The ordered ship (order_ship): it cannot fly on itself, and its stance takes no formation.
   */
  readonly self?: string;
}

/**
 * Reads a stance order: `{ type: "stance", set: { … } }` or `{ type: "stance", clear: true }`. Unknown keys, here and
 * in `set`, are problems (as every order field is).
 *
 * @param input - The order.
 * @param context - Where it sits, the scene's ship ids and the ordered ship.
 * @param problems - Where problems go.
 * @returns The order, or null with problems.
 */
export function readStanceOrder(input: JsonObject, context: ReadStanceOrderContext, problems: string[]): Maybe<StanceOrder> {
  const { where, ships, self } = context;
  const before = problems.length;
  for (const key of Object.keys(input)) if (!STANCE_ORDER_KEYS.has(key)) problems.push(`${where}.${key} is not a stance order field`);
  const { set, clear } = input;
  let order: Maybe<StanceOrder> = null;
  if ((set == null) === (clear == null)) problems.push(`${where} needs exactly one of set (${STANCE_SHAPE}) and clear (true)`);
  else if (clear != null && clear !== true) problems.push(`${where}.clear must be true: the stance at this level ends`);
  else if (clear === true) order = { type: 'stance', clear: true };
  else {
    const strict: string[] = [];
    const stance = readSceneStance(set, { where: `${where}.set`, problems, warnings: strict, level: self == null ? 'group' : 'ship' });
    problems.push(...strict);
    const on = stance?.on;
    if (typeof on === 'string' && on !== 'focus' && ships && !ships.has(on)) problems.push(`${where}.set.on: no ship "${on}"`);
    else if (on === self && self != null) problems.push(`${where}.set.on: a ship cannot fly a stance on itself`);
    if (stance) order = { type: 'stance', set: stance };
    else if (problems.length === before) problems.push(`${where}.set needs at least one of ${[...STANCE_KEYS].join(', ')}`);
  }
  return problems.length > before ? null : order;
}

/**
 * The stance an order leaves at its level: `set`'s, or null for `clear`.
 *
 * @param order - The stance order.
 * @returns The stance.
 */
export function stanceOfOrder(order: StanceOrder): Maybe<ShipStance> {
  return order.set ?? null;
}

/**
 * Removal pruning for stances (remove_ship, remove_fleet, remove_wing, remove_squad): a stance `on` a removed ship, or
 * on a squad or wing that is gone, falls back to its focus (the key is deleted), with a warning, as anchors fall back.
 * Tolerant of a draft.
 *
 * @param removal - What the edit removed: ship ids; wings and squads as `fleet/id`; fleets.
 * @param context - The draft and where warnings go.
 */
export function removeStanceReferences(removal: TimelineRemoval, context: Pick<FleetOperationContext, 'draft' | 'warnings'>): void {
  const { draft, warnings } = context;
  const ships = new Set(removal.ships ?? []);
  const groupsTouched = Boolean(removal.fleets?.length || removal.wings?.length || removal.squads?.length);
  const fleets = objectsOf(draft['fleets']);
  const held = (kind: 'squad' | 'wing', id: string, fleet?: JsonObject): boolean => {
    const wings = (fleet ? [fleet] : fleets).flatMap((candidate) => objectsOf(candidate['wings']));
    return kind === 'wing' ? wings.some((wing) => wing['id'] === id) : wings.some((wing) => objectsOf(wing['squads']).some((squad) => squad['id'] === id));
  };
  const prune = (holder: JsonObject, label: string, fleet?: JsonObject): void => {
    const stance = holder['stance'];
    const on = isPlainObject(stance) ? stance['on'] : undefined;
    let gone: Maybe<string> = null;
    if (typeof on === 'string' && ships.has(on)) gone = `ship "${on}"`;
    else if (isPlainObject(on) && groupsTouched) {
      const kind = 'squad' in on ? 'squad' : 'wing';
      const id = on[kind];
      if (typeof id === 'string' && !held(kind, id, fleet)) gone = `${kind} "${id}"`;
    }
    if (gone && isPlainObject(stance)) {
      delete stance['on'];
      if (!Object.keys(stance).length) delete holder['stance'];
      warnings.push(`${label}'s stance now flies on its focus (its on ${gone} was removed)`);
    }
  };
  for (const ship of objectsOf(draft['ships'])) prune(ship, `ship "${String(ship['id'])}"`);
  for (const fleet of fleets) {
    const fleetId = String(fleet['id']);
    prune(fleet, `fleet "${fleetId}"`, fleet);
    for (const wing of objectsOf(fleet['wings'])) {
      prune(wing, `fleet "${fleetId}": wing "${String(wing['id'])}"`, fleet);
      for (const squad of objectsOf(wing['squads'])) prune(squad, `fleet "${fleetId}": squad "${String(squad['id'])}"`, fleet);
    }
  }
}

/**
 * A group's stance as the document (or the live fleet view) writes it.
 *
 * @param scene - The document.
 * @param group - The fleet, wing or squad.
 * @returns Its stance; null when it sets none or does not exist.
 */
export function groupStanceOf(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): Maybe<ShipStance> {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let stance: Maybe<ShipStance> = fleet?.stance;
  if (group.kind === 'wing') stance = fleet?.wings.find((wing) => wing.id === group.id)?.stance;
  else if (group.kind === 'squad') stance = fleet?.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === group.id)?.stance;
  return stance ?? null;
}

/**
 * Whether an edit changed a stance beyond a removal falling its `on` back to the focus (removeStanceReferences), so the
 * page's live stance for that level gives way to the edited document's.
 *
 * @param before - The stance before the edit.
 * @param after - The stance after it.
 * @returns True when a key other than a dropped `on` changed.
 */
export function stanceEdited(before: Maybe<ShipStance>, after: Maybe<ShipStance>): boolean {
  const { on: beforeOn, ...beforeRest } = before ?? {};
  const { on: afterOn, ...afterRest } = after ?? {};
  return JSON.stringify(beforeRest) !== JSON.stringify(afterRest) || (afterOn !== undefined && JSON.stringify(beforeOn) !== JSON.stringify(afterOn));
}

export interface PruneStanceOnScope {
  /**
   * The ships still in the scene.
   */
  readonly ships: ReadonlySet<string>;
  /**
   * The fleet an `on` squad or wing must be in; null: none (a ship in no fleet).
   */
  readonly fleet: Maybe<Pick<SceneFleet, 'wings'>>;
}

/**
 * A stance whose `on` names a ship that is gone, or a squad or wing its fleet no longer holds, falls back to the focus
 * (the live stance book's half of removeStanceReferences).
 *
 * @param stance - The stance.
 * @param scope - The ships still in the scene and its fleet.
 * @returns The stance without `on` (null when nothing is left) and what was gone; null when it stands.
 */
export function pruneStanceOn(stance: Maybe<ShipStance>, scope: PruneStanceOnScope): Maybe<{ readonly stance: Maybe<ShipStance>; readonly gone: string }> {
  const on = stance?.on;
  let gone: Maybe<string> = null;
  if (typeof on === 'string' && on !== 'focus' && !scope.ships.has(on)) gone = `ship "${on}"`;
  else if (on != null && typeof on === 'object') {
    const kind = 'squad' in on ? 'squad' : 'wing';
    const id = 'squad' in on ? on.squad : on.wing;
    if (!scope.fleet || !stanceGroupExists(scope.fleet, kind, id)) gone = `${kind} "${id}"`;
  }
  let pruned: Maybe<{ readonly stance: Maybe<ShipStance>; readonly gone: string }> = null;
  if (gone && stance) {
    const rest: MutableStance = { ...stance };
    delete rest.on;
    pruned = { stance: Object.keys(rest).length ? rest : null, gone };
  }
  return pruned;
}

function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}
