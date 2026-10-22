import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readId, readNumber, readOptionalString, readString, readVector, reportUnknownKeys } from '../json';
import { applyFleetOperation, DEFAULT_FORMATION_RADIUS, type FleetOperationContext, layoutFleetFormation, normalizeFleets, readSquadRole, type SceneFleet, type SquadRole, toFleetAnchors } from '../fleets';
import { COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD, type CompositionAnchor, MAX_FLEET_SHIPS } from '../compositions/composition';
import { expandFleetComposition, toSceneAnchor } from '../compositions/expand';
import { normalizeFleetComposition } from '../compositions/normalize';
import { type HullStatOverrides, normalizeHullStatOverrides } from '../stats';
import { normalizeShipPropMod, type SceneShipPropMod } from '../prop-mods/prop-mod';
import type { SceneShip, SceneVector } from '../scene';
import { readStagingDraft, type StagingDraft, toExpandExisting } from './draft';
import { DEFAULT_SHIP_FORMATION, defaultShipSpacing, layoutShipFormation, readShipFormation, type ShipFormation, toFormationWorld } from './formations';
import { headingToward, type NearDirection, normalizeHeading, readNearDirection, toNearShipPoint } from './placement';
import { MAX_SHIP_ID_PREFIX_LENGTH, numberShipIds, readPositiveMetres, readStagingShipLine, shipLabel, type StagingShipLine, STAGING_WING_ID, toIdSlug, toShipListComposition } from './ships';

/**
 * Beyond this distance (metres) from the scene origin the page draws ships with float32 jitter.
 */
export const STAGING_FAR_DISTANCE = 1e8;

/**
 * How many examples an overlap warning names.
 */
const OVERLAP_EXAMPLES = 3;

/**
 * Members a join may move by less than this (metres) without counting as moved: rounding.
 */
const SLOT_MOVE_TOLERANCE = 1;

const ADD_SHIPS_KEYS = new Set<string>(['op', 'dna', 'hull', 'radius', 'count', 'formation', 'spacing', 'position', 'near', 'heading', 'facing', 'team', 'name', 'prefix', 'stats', 'propMod', 'fleet', 'radii']);
const NEAR_KEYS = new Set<string>(['ship', 'celestial', 'range', 'direction']);
const NEW_FLEET_KEYS = new Set<string>(['new', 'id', 'name', 'squad']);
const JOIN_KEYS = new Set<string>(['id', 'squad', 'wing']);
const SQUAD_SPEC_KEYS = new Set<string>(['id', 'name', 'role', 'anchor']);

/**
 * What every staged ship carries besides its hull.
 */
export interface StagingShipTemplate {
  readonly team: Maybe<string>;
  readonly stats: Maybe<HullStatOverrides>;
  readonly propMod: Maybe<SceneShipPropMod>;
}

/**
 * A `near` reference to a ship of the draft.
 */
export interface StagingNear {
  readonly ship: string;
  readonly range: Maybe<number>;
  readonly direction: Maybe<NearDirection>;
}

export interface StagingReadContext {
  readonly where: string;
  /**
   * The tool that resolves names, for messages.
   */
  readonly tool: string;
  readonly draft: StagingDraft;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Reads `near: { ship, range?, direction? }`. A celestial is refused: the tool resolves it to a position first.
 *
 * @param value - The candidate.
 * @param context - Where it sits, the tool, the draft and where problems go.
 * @returns The reference, or null on a problem.
 */
export function readStagingNear(value: unknown, context: StagingReadContext): Maybe<StagingNear> {
  const { where, tool, draft, problems, warnings } = context;
  let near: Maybe<StagingNear> = null;
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object { ship, range?, direction? }`);
  } else if (value['celestial'] != null) {
    problems.push(`${where}.celestial: the ${tool} tool resolves a celestial of the scene's location to a position; patch_scene takes near.ship or a position`);
  } else {
    reportUnknownKeys(value, NEAR_KEYS, where, warnings);
    const before = problems.length;
    const ship = readId(value['ship'], `${where}.ship`, problems);
    if (ship && !draft.ships.has(ship)) problems.push(`${where}.ship: no ship "${ship}" in the scene`);
    const range = value['range'] == null ? null : readNumber(value['range'], `${where}.range`, problems, { min: 0 });
    const direction = value['direction'] == null ? null : readNearDirection(value['direction'], `${where}.direction`, problems);
    if (problems.length === before) near = { ship, range, direction };
  }
  return near;
}

/**
 * Reads `radii: { "<ship id>": metres }`, the EVE radii the tool filled for ships already in the scene.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problems.
 * @returns The radii by ship id.
 */
export function readStagingRadii(value: unknown, where: string, problems: string[]): Map<string, number> {
  const radii = new Map<string, number>();
  if (value != null && !isPlainObject(value)) problems.push(`${where} must be an object of ship id to radius in metres`);
  else if (value != null) {
    for (const [id, radius] of Object.entries(value)) {
      const metres = readPositiveMetres(radius, `${where}.${id}`, problems);
      if (metres != null) radii.set(id, metres);
    }
  }
  return radii;
}

/**
 * The lead's centre off a near ship.
 *
 * @param near - The reference.
 * @param context - The draft, the radii, the lead's radius and where problems go.
 * @returns The point and the ship's heading, or null on a problem.
 */
export function resolveStagingNear(near: StagingNear, context: { readonly draft: StagingDraft; readonly radii: ReadonlyMap<string, number>; readonly leadRadius: number; readonly where: string; readonly problems: string[] }): Maybe<{ readonly point: SceneVector; readonly heading: number }> {
  const { draft, radii, leadRadius, where, problems } = context;
  const ship = draft.ships.get(near.ship);
  let resolved: Maybe<{ readonly point: SceneVector; readonly heading: number }> = null;
  if (ship) {
    const placed = toNearShipPoint({ ship, shipRadius: radii.get(near.ship) ?? 0, leadRadius, range: near.range, direction: near.direction, locationOrigin: draft.locationOrigin, where });
    problems.push(...placed.problems);
    if (placed.point) resolved = { point: placed.point, heading: placed.heading };
  }
  return resolved;
}

export interface PlaceFreeShipsInput {
  readonly lines: readonly StagingShipLine[];
  readonly formation: ShipFormation;
  /**
   * Default: defaultShipSpacing of the largest radius.
   */
  readonly spacing: Maybe<number>;
  /**
   * The lead's place.
   */
  readonly position: SceneVector;
  readonly heading: number;
  readonly prefix: string;
  readonly template: StagingShipTemplate;
  readonly draft: StagingDraft;
  readonly where: string;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Free ships laid out in a formation, before they are placed.
 */
export interface FreeShipsPlan {
  /**
   * Each ship's offset in the heading frame, the lead first.
   */
  readonly offsets: SceneVector[];
  /**
   * Each ship's line.
   */
  readonly lines: StagingShipLine[];
  /**
   * The largest radius (DEFAULT_FORMATION_RADIUS for a line without one).
   */
  readonly radius: number;
  readonly spacing: number;
  /**
   * Labels of the lines with no radius.
   */
  readonly unsized: string[];
}

/**
 * Lays out the ships of a list of lines in one formation, spaced for the largest radius.
 *
 * @param input - The lines, the formation and the spacing.
 * @returns The plan.
 */
export function planFreeShips(input: Pick<PlaceFreeShipsInput, 'lines' | 'formation' | 'spacing'>): FreeShipsPlan {
  const lines = input.lines.flatMap((line) => Array.from({ length: line.count ?? 1 }, () => line));
  const unsized = [...new Set(input.lines.filter((line) => line.radius == null).map((line) => shipLabel(line)))];
  const radius = Math.max(...input.lines.map((line) => line.radius ?? DEFAULT_FORMATION_RADIUS));
  const spacing = input.spacing ?? defaultShipSpacing(radius);
  return { offsets: layoutShipFormation({ formation: input.formation, count: lines.length, spacing }), lines, radius, spacing, unsized };
}

/**
 * How far a plan's front reaches ahead of its lead: the largest `z + radius`.
 *
 * @param plan - The plan.
 * @returns Metres.
 */
export function freeShipsFront(plan: FreeShipsPlan): number {
  return Math.max(...plan.offsets.map((offset, index) => offset[2] + (plan.lines[index].radius ?? DEFAULT_FORMATION_RADIUS)));
}

/**
 * Places free ships (in no fleet) in a formation at the lead's place, ids `<prefix>-<nn>` after the highest in use,
 * names `<label> <n>`. Warns about missing radii, tight spacing, ships landing on existing ones and far placements.
 *
 * @param input - The lines, the shape, the place, the ids and the draft.
 * @returns The ships, or none on a problem.
 */
export function placeFreeShips(input: PlaceFreeShipsInput): SceneShip[] {
  const { position, heading, prefix, template, draft, where, problems, warnings } = input;
  const plan = planFreeShips(input);
  const numbered = numberShipIds({ prefix, count: plan.lines.length, ids: draft.ships.keys(), where, problems });
  if (!numbered.ids.length) return [];
  const world = toFormationWorld({ offsets: plan.offsets, position, heading });
  const yaw = normalizeHeading(heading);
  const ships = plan.lines.map((line, index): SceneShip => {
    const propMod = template.propMod ?? (line.propMod == null ? null : { module: line.propMod });
    return {
      id: numbered.ids[index],
      dna: line.dna,
      name: `${shipLabel(line)} ${numbered.numbers[index]}`,
      ...(template.team ? { team: template.team } : {}),
      position: world[index],
      rotation: [yaw, 0, 0],
      ...(line.hull == null ? {} : { type: line.hull }),
      ...(template.stats ? { stats: structuredClone(template.stats) } : {}),
      ...(propMod ? { propMod: structuredClone(propMod) } : {})
    };
  });

  if (plan.unsized.length) warnings.push(`${where}: no radius for ${plan.unsized.join(', ')}; the spacing assumes ${DEFAULT_FORMATION_RADIUS} m. Give radius, or use the add_ships tool, which reads it from the EVE data.`);
  if (input.spacing != null && input.spacing < 2 * plan.radius) warnings.push(`${where}: spacing ${input.spacing} m is under two radii (${2 * plan.radius} m), so the ships overlap`);
  const radii = new Map(ships.map((ship, index) => [ship.id, plan.lines[index].radius ?? DEFAULT_FORMATION_RADIUS]));
  warnLanding({ ships, radii, draft, where, warnings });
  return ships;
}

/**
 * Warns about new ships landing within DEFAULT_FORMATION_RADIUS of ships already in the scene, and about ships
 * placed beyond STAGING_FAR_DISTANCE.
 *
 * @param input - The new ships, their radii, the draft and where warnings go.
 * @param input.ships - The new ships.
 * @param input.radii - Their radii.
 * @param input.draft - What the scene held before.
 * @param input.where - Where the operation sits.
 * @param input.warnings - Receives the warnings.
 */
export function warnLanding(input: { readonly ships: readonly SceneShip[]; readonly radii: ReadonlyMap<string, number>; readonly draft: StagingDraft; readonly where: string; readonly warnings: string[] }): void {
  const { ships, radii, draft, where, warnings } = input;
  const overlaps: string[] = [];
  for (const ship of ships) {
    const reach = (radii.get(ship.id) ?? DEFAULT_FORMATION_RADIUS) + DEFAULT_FORMATION_RADIUS;
    for (const [other, at] of draft.ships) {
      if (Math.hypot(ship.position[0] - at.position[0], ship.position[1] - at.position[1], ship.position[2] - at.position[2]) < reach) {
        overlaps.push(`${ship.id} near "${other}"`);
        break;
      }
    }
  }
  if (overlaps.length) {
    const examples = overlaps.slice(0, OVERLAP_EXAMPLES).join(', ') + (overlaps.length > OVERLAP_EXAMPLES ? ', ...' : '');
    const count = overlaps.length === 1 ? '1 ship lands' : `${overlaps.length} ships land`;
    warnings.push(`${where}: ${count} within ${DEFAULT_FORMATION_RADIUS} m of ships already in the scene (${examples}); add them at another position`);
  }
  warnFar({ ships, where, warnings });
}

/**
 * Warns about ships placed beyond STAGING_FAR_DISTANCE from the scene origin.
 *
 * @param input - The new ships and where warnings go.
 * @param input.ships - The new ships.
 * @param input.where - Where the operation sits.
 * @param input.warnings - Receives the warning.
 */
export function warnFar(input: { readonly ships: readonly Pick<SceneShip, 'position'>[]; readonly where: string; readonly warnings: string[] }): void {
  const { ships, where, warnings } = input;
  const far = ships.filter((ship) => Math.hypot(...ship.position) > STAGING_FAR_DISTANCE).length;
  const count = far === 1 ? '1 ship is' : String(far) + ' ships are';
  if (far) warnings.push(`${where}: ${count} more than 100,000 km from the scene origin; beyond about 100,000 km the page draws them with float32 jitter`);
}

/**
 * Pushes ships onto the draft.
 *
 * @param draft - The document mid-edit.
 * @param ships - The ships.
 */
export function pushStagedShips(draft: JsonObject, ships: readonly SceneShip[]): void {
  if (!Array.isArray(draft['ships'])) draft['ships'] = [];
  (draft['ships'] as unknown[]).push(...structuredClone(ships));
}

/**
 * Pushes a fleet onto the draft.
 *
 * @param draft - The document mid-edit.
 * @param fleet - The fleet.
 * @param context - Where problems go.
 */
export function pushStagedFleet(draft: JsonObject, fleet: SceneFleet, context: Pick<FleetOperationContext, 'where' | 'problems'>): void {
  if (draft['fleets'] == null) draft['fleets'] = [];
  if (Array.isArray(draft['fleets'])) draft['fleets'].push(structuredClone(fleet));
  else context.problems.push(`${context.where}: the scene's fleets are not an array`);
}

/**
 * Reads `stats` and `propMod` (validated once, copied onto every ship) and `team`.
 *
 * @param operation - The operation or side.
 * @param context - Where it sits and where problems go.
 * @returns The template.
 */
export function readStagingTemplate(operation: JsonObject, context: Pick<StagingReadContext, 'where' | 'problems' | 'warnings'>): StagingShipTemplate {
  const { where, problems, warnings } = context;
  const stats = normalizeHullStatOverrides({ input: operation['stats'], where: `${where}.stats` });
  problems.push(...stats.problems);
  warnings.push(...stats.warnings);
  const propMod = normalizeShipPropMod({ input: operation['propMod'], where: `${where}.propMod` });
  problems.push(...propMod.problems);
  warnings.push(...propMod.warnings);
  const team = operation['team'] == null ? null : readString(operation['team'], `${where}.team`, problems);
  return { team: team || null, stats: stats.overrides, propMod: propMod.propMod };
}

/**
 * Reads an explicit id prefix.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem.
 * @returns The prefix, or null when absent or invalid.
 */
export function readStagingPrefix(value: unknown, where: string, problems: string[]): Maybe<string> {
  let prefix: Maybe<string> = null;
  if (value != null) {
    const id = readId(value, where, problems);
    if (id.length > MAX_SHIP_ID_PREFIX_LENGTH) problems.push(`${where} must be at most ${MAX_SHIP_ID_PREFIX_LENGTH} characters`);
    else prefix = id || null;
  }
  return prefix;
}

type FleetMode = { readonly mode: 'free' } | { readonly mode: 'new'; readonly spec: JsonObject } | { readonly mode: 'join'; readonly spec: JsonObject } | { readonly mode: 'squad'; readonly spec: JsonObject };

/**
 * Applies `{ op: "add_ships", dna, hull?, radius?, count?, formation?, spacing?, position? | near?, heading? | facing?,
 * team?, name?, prefix?, stats?, propMod?, fleet?, radii? }`: `count` ships of one hull, free in a formation, as a new
 * fleet, into a fleet's squad, or as a new squad of a fleet (the sd-staging ref). Pure and synchronous: the
 * add_ships tool resolves hull names, celestials and radii first.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyAddShips(operation: JsonObject, context: FleetOperationContext): void {
  const { draft: document, where, problems, warnings } = context;
  const before = problems.length;
  const draft = readStagingDraft(document);
  const read: StagingReadContext = { where, tool: 'add_ships', draft, problems, warnings };
  reportUnknownKeys(operation, ADD_SHIPS_KEYS, where, warnings);

  // The operation's propMod is the ships' whole prop mod ({ module?, active? }), read with the template, not a line module.
  const line = readStagingShipLine({ record: { ...operation, propMod: null }, where, tool: 'add_ships', problems });
  const count = line.count ?? 1;
  const template = readStagingTemplate(operation, read);
  const prefix = readStagingPrefix(operation['prefix'], `${where}.prefix`, problems);
  const radii = readStagingRadii(operation['radii'], `${where}.radii`, problems);
  const mode = readFleetMode(operation, read);
  if (problems.length > before) return;

  if (mode.mode === 'join' || mode.mode === 'squad') {
    joinFleet({ operation, line, count, template, prefix, radii, spec: mode.spec, newSquad: mode.mode === 'squad', context, draft });
    return;
  }

  const formation = mode.mode === 'free' && operation['formation'] != null ? readShipFormation(operation['formation'], `${where}.formation`, problems) : DEFAULT_SHIP_FORMATION;
  const spacing = mode.mode === 'free' && operation['spacing'] != null ? readPositiveMetres(operation['spacing'], `${where}.spacing`, problems) : null;
  const place = readPlace(operation, { read, radii, leadRadius: line.radius ?? 0 });
  if (!place || problems.length > before) return;

  if (mode.mode === 'new') {
    addNewFleet({ line, count, template, prefix, spec: mode.spec, position: place.position, heading: place.heading, context, draft });
  } else {
    const ships = placeFreeShips({ lines: [{ ...line, count }], formation, spacing, position: place.position, heading: place.heading, prefix: prefix ?? toIdSlug(shipLabel(line)), template, draft, where, problems, warnings });
    if (problems.length === before) pushStagedShips(document, ships);
  }
}

/**
 * Reads `fleet` into a mode, and refuses the placement keys a mode does not take.
 *
 * @param operation - The operation.
 * @param context - Where problems go.
 * @returns The mode.
 */
function readFleetMode(operation: JsonObject, context: StagingReadContext): FleetMode {
  const { where, problems, warnings } = context;
  const fleet = operation['fleet'];
  let mode: FleetMode = { mode: 'free' };
  if (fleet == null) return mode;
  if (!isPlainObject(fleet)) {
    problems.push(`${where}.fleet must be { new: true, id?, name?, squad? }, { id, squad: "<squad id>" } or { id, squad: { id?, role?, anchor? }, wing? }`);
  } else if (fleet['new'] === true) {
    reportUnknownKeys(fleet, NEW_FLEET_KEYS, `${where}.fleet`, warnings);
    mode = { mode: 'new', spec: fleet };
  } else if (fleet['new'] != null) {
    problems.push(`${where}.fleet.new must be true; give { id, squad } to join a fleet`);
  } else if (fleet['id'] == null || fleet['squad'] == null) {
    problems.push(`${where}.fleet needs id and squad to join a fleet (squad: a squad id, or { id?, role?, anchor? } for a new squad), or new: true for a new fleet`);
  } else {
    reportUnknownKeys(fleet, JOIN_KEYS, `${where}.fleet`, warnings);
    mode = { mode: isPlainObject(fleet['squad']) ? 'squad' : 'join', spec: fleet };
  }

  const refused = mode.mode === 'free' ? [] : mode.mode === 'new' ? ['formation', 'spacing'] : ['formation', 'spacing', 'position', 'near', 'heading', 'facing'];
  for (const key of refused) {
    if (operation[key] == null) continue;
    const why = mode.mode === 'new' ? `a new fleet flies Follow the FC's formation around its FC (the first ship, at the place)` : `ships joining fleet "${String(isPlainObject(fleet) ? fleet['id'] : '')}" are placed at their formation slots around its FC`;
    problems.push(`${where}.${key}: ${why}; drop ${key}`);
  }
  return mode;
}

interface ReadPlaceInput {
  readonly read: StagingReadContext;
  readonly radii: ReadonlyMap<string, number>;
  readonly leadRadius: number;
}

/**
 * The lead's place and heading: `position` or `near`, then `heading` or `facing`, else the near ship's heading, else 0.
 *
 * @param operation - The operation.
 * @param input - The read context, the radii and the lead's radius.
 * @returns The place, or null on a problem.
 */
function readPlace(operation: JsonObject, input: ReadPlaceInput): Maybe<{ readonly position: SceneVector; readonly heading: number }> {
  const { read, radii, leadRadius } = input;
  const { where, draft, problems } = read;
  const before = problems.length;
  let position: SceneVector = [0, 0, 0];
  let heading = 0;
  if (operation['position'] != null && operation['near'] != null) problems.push(`${where}: give position or near, not both`);
  else if (operation['position'] != null) position = readVector(operation['position'], `${where}.position`, problems);
  else if (operation['near'] != null) {
    const near = readStagingNear(operation['near'], { ...read, where: `${where}.near` });
    const resolved = near ? resolveStagingNear(near, { draft, radii, leadRadius, where: `${where}.near`, problems }) : null;
    if (resolved) {
      position = resolved.point;
      heading = resolved.heading;
    }
  }

  if (operation['heading'] != null && operation['facing'] != null) problems.push(`${where}: give heading or facing, not both`);
  else if (operation['heading'] != null) heading = normalizeHeading(readNumber(operation['heading'], `${where}.heading`, problems));
  else if (operation['facing'] != null && problems.length === before) {
    const target = readFacing(operation['facing'], { where: `${where}.facing`, draft, problems, tool: read.tool });
    const toward = target ? headingToward(position, target) : null;
    if (target && toward == null) problems.push(`${where}.facing is straight above or below the lead; give a point off to the side, or a heading`);
    else if (toward != null) heading = toward;
  }
  return problems.length > before ? null : { position, heading };
}

/**
 * Reads `facing`: a point, or a ship id (its document position).
 *
 * @param value - The candidate.
 * @param context - Where it sits, the draft, where problems go and the tool.
 * @returns The point, or null on a problem.
 */
export function readFacing(value: unknown, context: Pick<StagingReadContext, 'where' | 'draft' | 'problems' | 'tool'>): Maybe<SceneVector> {
  const { where, draft, problems, tool } = context;
  let target: Maybe<SceneVector> = null;
  if (typeof value === 'string') {
    target = draft.ships.get(value)?.position ?? null;
    if (!target) problems.push(`${where}: no ship "${value}" in the scene`);
  } else if (isPlainObject(value)) {
    problems.push(`${where}: the ${tool} tool resolves { celestial } to a point; patch_scene takes a point or a ship id`);
  } else {
    target = readVector(value, where, problems);
  }
  return target;
}

interface NewFleetInput {
  readonly line: StagingShipLine;
  readonly count: number;
  readonly template: StagingShipTemplate;
  readonly prefix: Maybe<string>;
  readonly spec: JsonObject;
  readonly position: SceneVector;
  readonly heading: number;
  readonly context: FleetOperationContext;
  readonly draft: StagingDraft;
}

/**
 * A new fleet from one line: the first ship is the FC and the rest one squad, expanded as an inline composition.
 *
 * @param input - The line, the fleet spec, the place and the draft.
 */
function addNewFleet(input: NewFleetInput): void {
  const { line, count, template, prefix, spec, position, heading, context, draft } = input;
  const { draft: document, where, problems, warnings } = context;
  const at = `${where}.fleet`;
  const before = problems.length;
  const fleetId = spec['id'] == null ? null : readId(spec['id'], `${at}.id`, problems);
  const name = spec['name'] == null ? null : readOptionalString(spec['name'], `${at}.name`, problems);
  const squad = readSquadSpec(spec['squad'], `${at}.squad`, context);
  if (problems.length > before) return;

  const candidate = toShipListComposition({ id: fleetId || prefix || toIdSlug(shipLabel(line)), name, lines: [{ ...line, count, role: squad.role }] });
  const first = (candidate['wings'] as JsonObject[] | undefined)?.[0]?.['squads'] as JsonObject[] | undefined;
  if (first?.[0]) Object.assign(first[0], { ...(squad.id ? { id: squad.id } : {}), ...(squad.name ? { name: squad.name } : {}), ...(squad.anchor ? { anchor: squad.anchor } : {}) });
  const normalized = normalizeFleetComposition({ input: candidate, where: at });
  problems.push(...normalized.problems);
  warnings.push(...normalized.warnings);
  if (!normalized.composition) return;

  const expanded = expandFleetComposition({ composition: normalized.composition, position, heading: normalizeHeading(heading), fleet: fleetId || null, team: template.team, existing: toExpandExisting(draft), where: at });
  problems.push(...expanded.problems);
  warnings.push(...expanded.warnings);
  if (!expanded.fleet) return;
  const ships = expanded.ships.map((ship) => ({ ...ship, ...(template.stats ? { stats: structuredClone(template.stats) } : {}), ...(template.propMod ? { propMod: structuredClone(template.propMod) } : {}) }));
  warnFar({ ships, where, warnings });
  pushStagedShips(document, ships);
  pushStagedFleet(document, expanded.fleet, context);
}

interface SquadSpec {
  readonly id: Maybe<string>;
  readonly name: Maybe<string>;
  readonly role: SquadRole;
  readonly anchor: Maybe<CompositionAnchor>;
}

/**
 * Reads a squad spec in composition form: `{ id?, name?, role?, anchor?: { on?, range? } }`.
 *
 * @param value - The candidate (absent: all defaults).
 * @param where - Where it sits, for messages.
 * @param context - Where problems go.
 * @returns The spec.
 */
function readSquadSpec(value: unknown, where: string, context: Pick<FleetOperationContext, 'problems' | 'warnings'>): SquadSpec {
  const { problems, warnings } = context;
  let spec: SquadSpec = { id: null, name: null, role: 'dps', anchor: null };
  if (value != null && !isPlainObject(value)) {
    problems.push(`${where} must be an object { id?, name?, role?, anchor? }`);
  } else if (value != null) {
    reportUnknownKeys(value, SQUAD_SPEC_KEYS, where, warnings);
    const id = value['id'] == null ? null : readId(value['id'], `${where}.id`, problems);
    if (id === COMPOSITION_ANCHOR_FC || id === COMPOSITION_ANCHOR_LEAD) problems.push(`${where}.id "${id}" is reserved`);
    const name = value['name'] == null ? null : readOptionalString(value['name'], `${where}.name`, problems);
    const role = value['role'] == null ? 'dps' : readSquadRole(value['role'], `${where}.role`, problems);
    let anchor: Maybe<CompositionAnchor> = null;
    const candidate = value['anchor'];
    if (candidate != null && !isPlainObject(candidate)) problems.push(`${where}.anchor must be an object { on?, range? }`);
    else if (candidate != null) {
      const on = candidate['on'] == null ? null : readId(candidate['on'], `${where}.anchor.on`, problems);
      const range = candidate['range'] == null ? null : readNumber(candidate['range'], `${where}.anchor.range`, problems, { min: 0 });
      anchor = { ...(on ? { on } : {}), ...(range == null ? {} : { range }) };
    }
    spec = { id: id || null, name, role, anchor };
  }
  return spec;
}

interface JoinFleetInput {
  readonly operation: JsonObject;
  readonly line: StagingShipLine;
  readonly count: number;
  readonly template: StagingShipTemplate;
  readonly prefix: Maybe<string>;
  readonly radii: ReadonlyMap<string, number>;
  readonly spec: JsonObject;
  readonly newSquad: boolean;
  readonly context: FleetOperationContext;
  readonly draft: StagingDraft;
}

/**
 * Seats the ships in an existing squad, or in a new squad of the fleet, at their Follow-the-FC formation slots.
 *
 * @param input - The line, the fleet spec, the radii and the draft.
 */
function joinFleet(input: JoinFleetInput): void {
  const { line, count, template, prefix, radii, spec, newSquad, context, draft } = input;
  const { draft: document, where, problems, warnings } = context;
  const at = `${where}.fleet`;
  const fleetId = readId(spec['id'], `${at}.id`, problems);
  const fleetObject = (Array.isArray(document['fleets']) ? document['fleets'] : []).find((fleet): fleet is JsonObject => isPlainObject(fleet) && fleet['id'] === fleetId);
  if (!fleetObject) {
    const listed = draft.fleets.size ? ' (fleets: ' + [...draft.fleets].join(', ') + ')' : '';
    problems.push(`${at}.id: no fleet "${fleetId}" in the scene${listed}`);
    return;
  }
  const shipIds = new Set(draft.ships.keys());
  const original = normalizeFleets({ input: [fleetObject], shipIds });
  const fleet = original.fleets?.[0];
  if (!fleet) {
    problems.push(...original.problems.map((problem) => `${at}: ${problem}`));
    return;
  }
  const size = toFleetAnchors(fleet).size;
  if (size + count > MAX_FLEET_SHIPS) problems.push(`${at}: fleet "${fleetId}" holds ${size} ships; ${count} more would pass ${MAX_FLEET_SHIPS} (EVE's fleet size)`);
  const commander = draft.ships.get(fleet.commander);
  const squads = fleet.wings.flatMap((wing) => wing.squads);

  const before = problems.length;
  let squadId = '';
  let squadOp: Maybe<JsonObject> = null;
  let wingOp: Maybe<JsonObject> = null;
  let numbered = { ids: [] as string[], numbers: [] as number[] };
  if (!newSquad) {
    squadId = readId(spec['squad'], `${at}.squad`, problems);
    if (squadId && !squads.some((squad) => squad.id === squadId)) problems.push(`${at}.squad: no squad "${squadId}" in fleet "${fleetId}" (squads: ${squads.map((squad) => squad.id).join(', ') || 'none'})`);
    if (spec['wing'] != null) problems.push(`${at}.wing: a join goes into the squad's own wing; drop wing`);
  } else {
    const squad = readSquadSpec(spec['squad'], `${at}.squad`, context);
    const wingId = spec['wing'] == null ? (fleet.wings.at(-1)?.id ?? STAGING_WING_ID) : readId(spec['wing'], `${at}.wing`, problems);
    if (spec['wing'] != null && fleet.wings.length && !fleet.wings.some((wing) => wing.id === wingId)) problems.push(`${at}.wing: no wing "${wingId}" in fleet "${fleetId}" (wings: ${fleet.wings.map((wing) => wing.id).join(', ')})`);
    if (!fleet.wings.length) wingOp = { op: 'add_wing', fleet: fleetId, wing: { id: wingId, squads: [] } };
    squadId = chooseSquadId(squad, { squads: squads.map((candidate) => candidate.id), at, problems, fleetId });
    const prefixed = prefix ?? `${fleetId}-${squadId}`;
    numbered = numberShipIds({ prefix: prefixed, count, ids: shipIds, where, problems });
    const leads = new Map(squads.flatMap((candidate) => (candidate.members.length ? [[candidate.id, candidate.members[0]] as const] : [])));
    if (numbered.ids.length) leads.set(squadId, numbered.ids[0]);
    const on = squad.anchor?.on;
    if (on && on !== COMPOSITION_ANCHOR_FC && on !== COMPOSITION_ANCHOR_LEAD && !(on !== squadId && leads.has(on))) problems.push(`${at}.squad.anchor.on must be "fc", "lead" or another squad of fleet "${fleetId}" with ships (squads: ${[...leads.keys()].filter((id) => id !== squadId).join(', ') || 'none'})`);
    const anchor = toSceneAnchor({ id: squadId, role: squad.role, ...(squad.anchor ? { anchor: squad.anchor } : {}), ships: [] }, leads);
    squadOp = { op: 'add_squad', fleet: fleetId, wing: wingId, squad: { id: squadId, ...(squad.name ? { name: squad.name } : {}), role: squad.role, members: [], ...(anchor ? { anchor } : {}) } };
  }
  if (!newSquad) numbered = numberShipIds({ prefix: prefix ?? `${fleetId}-${squadId}`, count, ids: shipIds, where, problems });
  if (problems.length > before || !commander || !numbered.ids.length) return;

  const fcYaw = normalizeHeading(commander.rotation[0]);
  const ships = numbered.ids.map((id, index): SceneShip => ({
    id,
    dna: line.dna,
    name: `${shipLabel(line)} ${numbered.numbers[index]}`,
    ...(template.team ? { team: template.team } : {}),
    position: [...commander.position],
    rotation: [fcYaw, 0, 0],
    ...(line.hull == null ? {} : { type: line.hull }),
    ...(template.stats ? { stats: structuredClone(template.stats) } : {}),
    ...(template.propMod ? { propMod: structuredClone(template.propMod) } : {})
  }));
  pushStagedShips(document, ships);
  if (wingOp) applyFleetOperation(wingOp, context);
  if (squadOp) applyFleetOperation(squadOp, context);
  applyFleetOperation({ op: 'move_to_squad', ships: numbered.ids, fleet: fleetId, squad: squadId }, context);
  if (problems.length > before) return;

  const added = new Set(numbered.ids);
  const radiusOf = (id: string): number => (added.has(id) ? (line.radius ?? DEFAULT_FORMATION_RADIUS) : (radii.get(id) ?? DEFAULT_FORMATION_RADIUS));
  const edited = normalizeFleets({ input: [fleetObject], shipIds: new Set([...shipIds, ...added]) }).fleets?.[0];
  let slots: Maybe<Map<string, SceneVector>> = null;
  try {
    slots = edited ? layoutFleetFormation({ fleet: edited, origin: commander.position, heading: fcYaw, radiusOf }) : null;
  } catch (error) {
    problems.push(`${at}: no formation slot for the new ships (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!slots) return;
  for (const ship of document['ships'] as JsonObject[]) {
    const slot = typeof ship['id'] === 'string' && added.has(ship['id']) ? slots.get(ship['id']) : null;
    if (slot) ship['position'] = [...slot];
  }

  const unsized = [...toFleetAnchors(fleet).keys()].filter((id) => !radii.has(id));
  if (unsized.length)
    warnings.push(`${at}: no radius for ${unsized.length === 1 ? 'member' : 'members'} ${unsized.slice(0, OVERLAP_EXAMPLES).join(', ')}${unsized.length > OVERLAP_EXAMPLES ? ', ...' : ''} of fleet "${fleetId}"; the slots assume ${DEFAULT_FORMATION_RADIUS} m. The add_ships tool fills radii from the EVE data.`);
  warnSlotShift({ fleet, origin: commander.position, heading: fcYaw, radiusOf, slots, squadId, newSquad, at, warnings });
  warnFar({ ships: numbered.ids.map((id) => ({ position: slots.get(id) ?? commander.position })), where, warnings });
}

/**
 * A new squad's id: the given one (refused when taken), else its role, numbered `<role>-2`, ... when taken.
 *
 * @param squad - The spec.
 * @param context - The fleet's squad ids and where problems go.
 * @param context.squads - The fleet's squad ids.
 * @param context.at - Where the fleet spec sits.
 * @param context.problems - Receives the problem.
 * @param context.fleetId - The fleet.
 * @returns The squad id.
 */
function chooseSquadId(squad: SquadSpec, context: { readonly squads: readonly string[]; readonly at: string; readonly problems: string[]; readonly fleetId: string }): string {
  const { squads, at, problems, fleetId } = context;
  let id = squad.id ?? '';
  if (squad.id && squads.includes(squad.id)) problems.push(`${at}.squad.id: squad "${squad.id}" already exists in fleet "${fleetId}"; give another id or omit it`);
  else if (!squad.id) {
    for (let suffix = 1; !id; suffix += 1) {
      const candidate = suffix === 1 ? squad.role : `${squad.role}-${suffix}`;
      if (!squads.includes(candidate)) id = candidate;
    }
  }
  return id;
}

interface SlotShiftInput {
  readonly fleet: SceneFleet;
  readonly origin: SceneVector;
  readonly heading: number;
  readonly radiusOf: (id: string) => number;
  readonly slots: ReadonlyMap<string, SceneVector>;
  readonly squadId: string;
  readonly newSquad: boolean;
  readonly at: string;
  readonly warnings: string[];
}

/**
 * Warns when seating the new ships moves existing members to new formation slots (Follow the FC re-plans the fleet).
 *
 * @param input - The fleet before the edit, its layout input, the new slots and where warnings go.
 */
function warnSlotShift(input: SlotShiftInput): void {
  const { fleet, origin, heading, radiusOf, slots, squadId, newSquad, at, warnings } = input;
  let previous: Maybe<Map<string, SceneVector>> = null;
  try {
    previous = layoutFleetFormation({ fleet, origin, heading, radiusOf });
  } catch {
    previous = null;
  }
  let moved = 0;
  let farthest = 0;
  for (const [id, was] of previous ?? []) {
    const now = slots.get(id);
    const shift = now ? Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]) : 0;
    if (shift > SLOT_MOVE_TOLERANCE) {
      moved += 1;
      farthest = Math.max(farthest, shift);
    }
  }
  if (moved) {
    const advice = newSquad ? 'put the squad in the last wing to move nobody' : 'add a new squad instead (fleet: { id, squad: { role } }), which moves nobody';
    warnings.push(`${at}: seating the ships in squad "${squadId}" moves ${moved} existing ${moved === 1 ? 'member' : 'members'} of fleet "${fleet.id}" to new formation slots (up to ${Math.round(farthest)} m), since Follow the FC re-plans the fleet; ${advice}`);
  }
}
