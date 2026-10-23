import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readId, readNumber, readString, readVector, reportUnknownKeys } from '../json';
import { DEFAULT_FORMATION_RADIUS, type FleetOperationContext } from '../fleets';
import type { FleetComposition } from '../compositions/composition';
import { expandFleetComposition } from '../compositions/expand';
import { mergeDraftFits } from '../compositions/operation';
import { normalizeFleetComposition } from '../compositions/normalize';
import type { SceneVector } from '../scene';
import { freeShipsFront, placeFreeShips, planFreeShips, pushStagedFleet, pushStagedShips, readStagingNear, readStagingPrefix, readStagingRadii, resolveStagingNear, stagingNearReference, warnFar } from './add-ships';
import { readStagingDraft, toExpandExisting } from './draft';
import { DEFAULT_SHIP_FORMATION, readShipFormation, type ShipFormation } from './formations';
import { headingVectors, normalizeHeading, roundVector, tangentHeading } from './placement';
import { readWarpIn, toArrivalLane, type WarpInRequest } from '../arrivals/arrival';
import { normalizeStagingShipLines, readPositiveMetres, type StagingShipLine, toIdSlug, toShipListComposition } from './ships';

/**
 * Metres between the two sides' front lines by default.
 */
export const DEFAULT_ENGAGEMENT_RANGE = 20_000;

/**
 * The teams of side A and side B by default.
 */
export const ENGAGEMENT_TEAMS = ['blue', 'red'] as const;

const ENGAGEMENT_KEYS = new Set<string>(['op', 'sides', 'range', 'center', 'near', 'heading', 'radii']);
const SIDE_KEYS = new Set<string>(['composition', 'ships', 'team', 'fleet', 'name', 'personality', 'formation', 'spacing', 'prefix', 'warpIn']);

/**
 * A side that makes free ships in a formation.
 */
interface FreeSide {
  readonly lines: StagingShipLine[];
  readonly formation: ShipFormation;
  readonly spacing: Maybe<number>;
  readonly prefix: string;
}

interface EngagementSide {
  readonly where: string;
  readonly team: string;
  /**
   * The fleet a fleet side makes: a composition, or a ship list as one.
   */
  readonly composition: Maybe<FleetComposition>;
  /**
   * The explicit fleet id of a fleet side.
   */
  readonly fleet: Maybe<string>;
  /**
   * A fleet side's personality, over its composition's.
   */
  readonly personality: Maybe<string>;
  readonly free: Maybe<FreeSide>;
  /**
   * The side lands from warp at its placements, flying in along its heading.
   */
  readonly warpIn: Maybe<WarpInRequest>;
}

/**
 * Applies `{ op: "stage_engagement", sides: [A, B], range?, center? | near?, heading?, radii? }`: two sides facing each
 * other with their front lines `range` metres apart, centred on the point (the sd-staging ref). Side A
 * faces `heading`, side B faces back. Each side is a composition or a ship list (a fleet), or free ships in a
 * formation (`fleet: false`), on its own team. A side with `warpIn` (true, or `{ stagger?, together? }`) is recorded
 * in the context's arrivals: the page lands it from warp at its placements, along its heading. Pure and synchronous:
 * the stage_engagement tool resolves composition names, hull names and celestials first.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyStageEngagement(operation: JsonObject, context: FleetOperationContext): void {
  const { draft: document, where, problems, warnings } = context;
  const before = problems.length;
  const draft = readStagingDraft(document);
  reportUnknownKeys(operation, ENGAGEMENT_KEYS, where, warnings);

  const candidates = operation['sides'];
  const sides: EngagementSide[] = [];
  if (!Array.isArray(candidates) || candidates.length !== 2) problems.push(`${where}.sides must be two sides [A, B], each { composition | ships, team?, fleet?, name? }`);
  else for (const [index, side] of candidates.entries()) sides.push(readSide(side, { index, where: `${where}.sides[${index}]`, problems, warnings }));
  if (sides.length === 2 && sides[0].team === sides[1].team) problems.push(`${where}: both sides are on team "${sides[0].team}"; give each side its own team`);

  const range = operation['range'] == null ? DEFAULT_ENGAGEMENT_RANGE : readNumber(operation['range'], `${where}.range`, problems, { min: 0 });
  const radii = readStagingRadii(operation['radii'], `${where}.radii`, problems);
  let center: SceneVector = [0, 0, 0];
  let reference: Maybe<SceneVector> = null;
  if (operation['center'] != null && operation['near'] != null) problems.push(`${where}: give center or near, not both`);
  else if (operation['center'] != null) center = readVector(operation['center'], `${where}.center`, problems);
  else if (operation['near'] != null) {
    const near = readStagingNear(operation['near'], { where: `${where}.near`, tool: 'stage_engagement', draft, problems, warnings });
    const resolved = near ? resolveStagingNear(near, { draft, radii, leadRadius: 0, where: `${where}.near`, problems }) : null;
    if (near && resolved) {
      center = resolved.point;
      reference = stagingNearReference(near, draft)?.position ?? null;
    }
  }
  let heading = 0;
  if (operation['heading'] != null) heading = normalizeHeading(readNumber(operation['heading'], `${where}.heading`, problems));
  else if (reference) heading = tangentHeading(reference, center);
  if (problems.length > before) return;

  const { forward } = headingVectors(heading);
  const fronts = sides.map(sideFront);
  const references = [-1, 1].map((sign, index) => roundVector(center.map((component, axis) => component + sign * forward[axis] * (range / 2 + fronts[index])) as SceneVector));
  for (const [index, side] of sides.entries()) {
    placeSide(side, { position: references[index], heading: normalizeHeading(heading + index * 180), context });
    if (problems.length > before) return;
  }
}

interface ReadSideContext {
  readonly index: number;
  readonly where: string;
  readonly problems: string[];
  readonly warnings: string[];
}

function readSide(value: unknown, context: ReadSideContext): EngagementSide {
  const { index, where, problems, warnings } = context;
  const fallback: EngagementSide = { where, team: ENGAGEMENT_TEAMS[index], composition: null, fleet: null, personality: null, free: null, warpIn: null };
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object { composition | ships, team?, fleet?, name? }`);
    return fallback;
  }
  reportUnknownKeys(value, SIDE_KEYS, where, warnings);
  const team = value['team'] == null ? ENGAGEMENT_TEAMS[index] : readString(value['team'], `${where}.team`, problems);
  const name = value['name'] == null ? null : readString(value['name'], `${where}.name`, problems);
  const fleetValue = value['fleet'];
  const free = fleetValue === false;
  let fleet: Maybe<string> = null;
  if (typeof fleetValue === 'string') fleet = fleetValue;
  else if (fleetValue != null && fleetValue !== false) problems.push(`${where}.fleet must be a fleet id, or false for free ships in a formation`);
  const personality = value['personality'] == null ? null : readId(value['personality'], `${where}.personality`, problems);
  if (free && personality) problems.push(`${where}.personality needs a fleet: free ships (fleet: false) have no FC to run one`);
  for (const key of ['formation', 'spacing', 'prefix']) if (!free && value[key] != null) problems.push(`${where}.${key} needs fleet: false (free ships in a formation); a fleet side flies its formation around its FC`);
  const warpIn = readWarpIn(value['warpIn'], { where: `${where}.warpIn`, problems, warnings, draft: {}, fromRefused: 'an engagement side flies in along its heading, facing the other side' });

  const hasComposition = value['composition'] != null;
  const hasShips = value['ships'] != null;
  let composition: Maybe<FleetComposition> = null;
  let freeSide: Maybe<FreeSide> = null;
  if (hasComposition === hasShips) {
    problems.push(`${where}: give composition or ships${hasComposition ? ', not both' : ''}`);
  } else if (hasComposition && free) {
    problems.push(`${where}.fleet: a composition always makes a fleet; give ships for free ships`);
  } else if (hasComposition && typeof value['composition'] === 'string') {
    problems.push(`${where}.composition: the stage_engagement tool resolves composition names; patch_scene takes an inline cjs-fleet/1 composition`);
  } else if (hasComposition) {
    composition = readComposition({ ...(value['composition'] as JsonObject), ...(name ? { name } : {}) }, { where: `${where}.composition`, problems, warnings });
  } else {
    const lines = normalizeStagingShipLines({ input: value['ships'], where: `${where}.ships`, tool: 'stage_engagement' });
    problems.push(...lines.problems);
    warnings.push(...lines.warnings);
    if (free) {
      const formation = value['formation'] == null ? DEFAULT_SHIP_FORMATION : readShipFormation(value['formation'], `${where}.formation`, problems);
      const spacing = value['spacing'] == null ? null : readPositiveMetres(value['spacing'], `${where}.spacing`, problems);
      const prefix = readStagingPrefix(value['prefix'], `${where}.prefix`, problems) ?? toIdSlug(team, 'side');
      freeSide = { lines: lines.lines, formation, spacing, prefix };
    } else if (!lines.problems.length) {
      composition = readComposition(toShipListComposition({ id: fleet ?? toIdSlug(team, 'side'), name, lines: lines.lines }), { where: `${where}.ships`, problems, warnings });
    }
  }
  return { where, team, composition, fleet, personality, free: freeSide, warpIn };
}

function readComposition(input: unknown, context: Pick<ReadSideContext, 'where' | 'problems' | 'warnings'>): Maybe<FleetComposition> {
  const normalized = normalizeFleetComposition({ input, where: context.where });
  context.problems.push(...normalized.problems);
  context.warnings.push(...normalized.warnings);
  return normalized.composition;
}

/**
 * How far a side's front reaches ahead of its reference (FC or lead): the largest `z + radius`, laid out at the
 * origin facing +Z.
 *
 * @param side - The side.
 * @returns Metres.
 */
function sideFront(side: EngagementSide): number {
  let front = 0;
  if (side.free) {
    front = freeShipsFront(planFreeShips(side.free));
  } else if (side.composition) {
    const dry = expandFleetComposition({ composition: side.composition, position: [0, 0, 0], heading: 0, existing: { ships: new Map(), fleets: new Set() } });
    const radii = compositionRadii(side.composition);
    front = Math.max(...dry.ships.map((ship, index) => ship.position[2] + (radii[index] ?? DEFAULT_FORMATION_RADIUS)));
  }
  return front;
}

/**
 * Each ship's radius in expandFleetComposition's order: the FC, then wings, squads, lines and count.
 *
 * @param composition - The composition.
 * @returns The radii (DEFAULT_FORMATION_RADIUS where a line has none).
 */
function compositionRadii(composition: FleetComposition): number[] {
  const radii = [composition.commander.radius ?? DEFAULT_FORMATION_RADIUS];
  for (const wing of composition.wings) {
    for (const squad of wing.squads) for (const line of squad.ships) for (let count = 0; count < (line.count ?? 1); count += 1) radii.push(line.radius ?? DEFAULT_FORMATION_RADIUS);
  }
  return radii;
}

interface PlaceSideInput {
  readonly position: SceneVector;
  readonly heading: number;
  readonly context: FleetOperationContext;
}

function placeSide(side: EngagementSide, input: PlaceSideInput): void {
  const { position, heading, context } = input;
  const { draft: document, problems, warnings } = context;
  const draft = readStagingDraft(document);
  const lane = toArrivalLane(heading);
  if (side.free) {
    const ships = placeFreeShips({ ...side.free, position, heading, template: { team: side.team, stats: null, propMod: null }, draft, where: side.where, problems, warnings });
    pushStagedShips(document, ships);
    if (side.warpIn && ships.length) context.arrivals?.push({ where: side.where, group: ships[0].id, leader: ships[0].id, ships: ships.map((ship) => ship.id), lane, landing: 'document', stagger: side.warpIn.stagger, together: side.warpIn.together });
  } else if (side.composition) {
    const expanded = expandFleetComposition({ composition: side.composition, position, heading, fleet: side.fleet, team: side.team, personality: side.personality, existing: toExpandExisting(draft), where: side.where });
    problems.push(...expanded.problems);
    warnings.push(...expanded.warnings);
    if (expanded.fleet) {
      warnFar({ ships: expanded.ships, where: side.where, warnings });
      pushStagedShips(document, expanded.ships);
      pushStagedFleet(document, expanded.fleet, context);
      mergeDraftFits(document, expanded.fits);
      const { id, commander } = expanded.fleet;
      if (side.warpIn) context.arrivals?.push({ where: side.where, group: id, fleet: id, leader: commander, ships: expanded.ships.map((ship) => ship.id), lane, landing: 'document', stagger: side.warpIn.stagger, together: side.warpIn.together });
    }
  }
}
