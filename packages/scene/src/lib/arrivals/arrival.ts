import type { Maybe } from '@dereekb/util';
import { unitHash } from '../fleets/orders';
import { isPlainObject, type JsonObject, readNumber, readVector, reportUnknownKeys } from '../json';
import type { SceneVector } from '../scene';

/**
 * Seconds: the default window an arriving group's landings spread over.
 */
export const DEFAULT_WARP_IN_STAGGER = 4;

/**
 * Seconds: the widest stagger a warp-in takes.
 */
export const MAX_WARP_IN_STAGGER = 30;

const WARP_IN_KEYS = new Set<string>(['stagger', 'together', 'from']);

/**
 * A `warpIn` request, read: the new ships wait off-grid and land from warp at their landings.
 */
export interface WarpInRequest {
  /**
   * Seconds the group's landings spread over, the leader first.
   */
  readonly stagger: number;
  /**
   * True: the group lands within `stagger` of its slowest hull's landing; false: each hull at its own pace.
   */
  readonly together: boolean;
  /**
   * Where they come from (a point, or a ship or object read off the draft): sets the heading, landing to the
   * landing along it.
   */
  readonly from?: SceneVector;
}

/**
 * Where an arriving group lands: its document placements, or its live formation slots around the FC (ships joining a
 * fleet already in the scene).
 */
export type SceneArrivalLanding = 'document' | 'formation';

/**
 * One group of ships an operation adds arriving by warp (applySceneOperations' `arrivals`). Live state: the document
 * never records it.
 */
export interface SceneArrival {
  /**
   * The operation's place in the patch, for messages.
   */
  readonly where: string;
  /**
   * The group's key: its fleet id, or its first ship's id.
   */
  readonly group: string;
  readonly fleet?: string;
  /**
   * The ship that lands first: the FC of a new fleet, the lead of free ships; a joining group's fleet FC (already in
   * the scene) is not in `ships`.
   */
  readonly leader?: string;
  readonly ships: readonly string[];
  /**
   * The unit direction they warp in along: level, forward of the heading.
   */
  readonly lane: SceneVector;
  readonly landing: SceneArrivalLanding;
  readonly stagger: number;
  readonly together: boolean;
}

/**
 * Where the operations of one patch record their arrivals (FleetOperationContext.arrivals).
 */
export type SceneArrivalCollector = SceneArrival[];

export interface ReadWarpInContext {
  readonly where: string;
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * The document mid-edit, for a `from` naming a ship or object.
   */
  readonly draft: JsonObject;
  /**
   * Why `from` is refused here (a join, an engagement side, add_ship), or null when it is taken.
   */
  readonly fromRefused?: Maybe<string>;
}

/**
 * Reads `warpIn`: `true` for the defaults, or `{ stagger?, together?, from? }`.
 *
 * @param value - The candidate; null, undefined or false for no warp-in.
 * @param context - Where it sits and where problems go.
 * @returns The request, or null for none or a problem.
 */
export function readWarpIn(value: unknown, context: ReadWarpInContext): Maybe<WarpInRequest> {
  const { where, problems, warnings, draft, fromRefused } = context;
  const before = problems.length;
  let request: Maybe<WarpInRequest> = null;
  if (value === true) {
    request = { stagger: DEFAULT_WARP_IN_STAGGER, together: true };
  } else if (value != null && value !== false && !isPlainObject(value)) {
    problems.push(`${where} must be true or { stagger?, together?, from? }`);
  } else if (isPlainObject(value)) {
    reportUnknownKeys(value, WARP_IN_KEYS, where, warnings);
    const stagger = value['stagger'] == null ? DEFAULT_WARP_IN_STAGGER : readNumber(value['stagger'], `${where}.stagger`, problems, { min: 0, max: MAX_WARP_IN_STAGGER });
    const together = value['together'] == null ? true : value['together'];
    if (typeof together !== 'boolean') problems.push(`${where}.together must be true or false`);
    let from: Maybe<SceneVector> = null;
    if (value['from'] != null && fromRefused) problems.push(`${where}.from: ${fromRefused}`);
    else if (value['from'] != null) from = readWarpInFrom(value['from'], { where: `${where}.from`, problems, draft });
    if (problems.length === before) request = { stagger, together: together === true, ...(from ? { from } : {}) };
  }
  return request;
}

/**
 * Reads `warpIn.from`: a point, or the id of a ship or object in the draft (its position).
 *
 * @param value - The candidate.
 * @param context - Where it sits, where problems go and the draft.
 * @param context.where - Its place in the patch.
 * @param context.problems - Receives the problems.
 * @param context.draft - The document mid-edit.
 * @returns The point, or null on a problem.
 */
function readWarpInFrom(value: unknown, context: { readonly where: string; readonly problems: string[]; readonly draft: JsonObject }): Maybe<SceneVector> {
  const { where, problems, draft } = context;
  let from: Maybe<SceneVector> = null;
  if (typeof value === 'string') {
    const found = [...(Array.isArray(draft['ships']) ? draft['ships'] : []), ...(Array.isArray(draft['objects']) ? draft['objects'] : [])].find((item): item is JsonObject => isPlainObject(item) && item['id'] === value);
    if (!found) problems.push(`${where}: no ship or object "${value}" in the scene; give a point [x, y, z], or { celestial } to the tool`);
    else from = found['position'] === undefined ? [0, 0, 0] : readVector(found['position'], `${where} ("${value}".position)`, problems);
  } else {
    from = readVector(value, where, problems);
  }
  return from;
}

/**
 * The heading a `warpIn.from` sets: yaw degrees from it to the landing, so the ships face the way they flew in.
 *
 * @param input - The request's from, the landing and where problems go.
 * @param input.from - Where they come from.
 * @param input.landing - The lead's landing.
 * @param input.where - The operation's place in the patch.
 * @param input.problems - Receives the problems.
 * @returns Yaw degrees; null when `from` is straight above or below the landing (a problem).
 */
export function toWarpInHeading(input: { readonly from: SceneVector; readonly landing: SceneVector; readonly where: string; readonly problems: string[] }): Maybe<number> {
  const { from, landing, where, problems } = input;
  const dx = landing[0] - from[0];
  const dz = landing[2] - from[2];
  let heading: Maybe<number> = null;
  if (dx === 0 && dz === 0) problems.push(`${where}.warpIn.from is straight above or below the landing; give a point off to the side`);
  else heading = (Math.atan2(dx, dz) * 180) / Math.PI;
  return heading;
}

/**
 * The lane a heading gives: level, forward of it.
 *
 * @param heading - Yaw degrees.
 * @returns The unit direction.
 */
export function toArrivalLane(heading: number): SceneVector {
  const yaw = (heading * Math.PI) / 180;
  return [Math.sin(yaw), 0, Math.cos(yaw)];
}

/**
 * The `heading` / `facing` refusal of a `warpIn.from` (it sets the heading itself).
 *
 * @param operation - The operation.
 * @param where - Its place in the patch, for messages.
 * @param problems - Receives the problem.
 * @returns True when the operation gives both.
 */
export function refuseWarpInFromWithHeading(operation: JsonObject, where: string, problems: string[]): boolean {
  const warpIn = operation['warpIn'];
  const clash = isPlainObject(warpIn) && warpIn['from'] != null && (operation['heading'] != null || operation['facing'] != null);
  if (clash) problems.push(`${where}: warpIn.from sets the heading (they fly in from it); drop heading and facing`);
  return clash;
}

export interface ArrivalOffsetsInput {
  /**
   * The seed: the group's key.
   */
  readonly key: string;
  /**
   * The master tick the group is planned at.
   */
  readonly tick: number;
  readonly ships: readonly string[];
  /**
   * The ship that lands first (offset 0), when in `ships`.
   */
  readonly leader?: Maybe<string>;
  /**
   * Seconds: the widest offset.
   */
  readonly stagger: number;
}

/**
 * Each ship's landing offset in an arriving group: uniform in [0, stagger] seconds, continuous, drawn from a hash of
 * the key, the tick and the ship id (the same plan replays the same way); the leader's is 0.
 *
 * @param input - The seed, the ships, the leader and the stagger.
 * @returns Seconds per ship, in `ships` order.
 */
export function toArrivalOffsets(input: ArrivalOffsetsInput): Map<string, number> {
  const { key, tick, ships, leader, stagger } = input;
  const most = Math.max(0, Math.min(MAX_WARP_IN_STAGGER, stagger));
  return new Map(ships.map((ship) => [ship, ship === leader || most === 0 ? 0 : most * unitHash(`${key}|${tick}|${ship}`)]));
}

/**
 * The arrivals whose ships are still in the result, each keeping only those ships (a later operation may have removed
 * some); a group left with none is dropped.
 *
 * @param arrivals - What the operations recorded.
 * @param shipIds - The result's ship ids.
 * @returns The arrivals to hand the page.
 */
export function keepSceneArrivals(arrivals: readonly SceneArrival[], shipIds: ReadonlySet<string>): SceneArrival[] {
  return arrivals.flatMap((arrival) => {
    const ships = arrival.ships.filter((id) => shipIds.has(id));
    const leader = arrival.leader && (shipIds.has(arrival.leader) || arrival.landing === 'formation') ? arrival.leader : ships[0];
    return ships.length ? [{ ...arrival, ships, ...(leader ? { leader } : {}) }] : [];
  });
}
