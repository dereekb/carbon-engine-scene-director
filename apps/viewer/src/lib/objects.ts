/**
 * The scene objects' pure half (node-tested; no runtime): the ball radius an object flies with, how far the camera's
 * back clip must reach, its get_state row, the overlay line, and the celestial-target sync plan. SceneObjects
 * (scene-objects.ts) draws them; DestinyWorld holds their balls.
 */

import type { Maybe } from '@dereekb/util';
import { type CelestialTarget, DEFAULT_OBJECT_RADIUS, OBJECT_NEAREST_SHIPS, type SceneObject, type SceneObjectRadiusSource, type SceneObjectStateReport, type SceneObjectStatus, type SceneVector, type ShipOrder, shipOrderTarget } from '@scene-director/scene';

/**
 * What the page knows about an object's build.
 */
export interface ObjectEntryState {
  readonly status: SceneObjectStatus;
  readonly error?: Maybe<string>;
  readonly diagnostics?: unknown[];
  readonly sofRadius?: Maybe<number>;
}

/**
 * A ship's ball, for distances.
 */
export interface ShipSphere {
  readonly id: string;
  readonly position: SceneVector;
  readonly radius: number;
}

/**
 * A ship's orders, for targetedBy.
 */
export interface ShipOrders {
  readonly order?: Maybe<ShipOrder>;
  readonly pendingOrder?: Maybe<ShipOrder>;
}

/**
 * The radius an object's ball takes: the document's (the SDE radius), else the SOF bounding radius once built, else
 * DEFAULT_OBJECT_RADIUS.
 *
 * @param input - The document radius and the SOF radius.
 * @returns The radius and where it came from.
 */
export function ObjectBallRadius(input: { readonly radius?: Maybe<number>; readonly sofRadius?: Maybe<number> }): { readonly radius: number; readonly from: SceneObjectRadiusSource } {
  const { radius, sofRadius } = input;
  let result: { readonly radius: number; readonly from: SceneObjectRadiusSource } = { radius: DEFAULT_OBJECT_RADIUS, from: 'default' };
  if (radius != null && radius > 0) result = { radius, from: 'document' };
  else if (sofRadius != null && sofRadius > 0) result = { radius: sofRadius, from: 'sof' };
  return result;
}

/**
 * How far from the origin the camera's back clip must reach to draw every object: the largest
 * `|position| + 2 × max(radius, sofRadius)`.
 *
 * @param objects - The objects with their SOF radii.
 * @returns Metres; 0 without objects.
 */
export function ObjectReach(objects: readonly { readonly position: SceneVector; readonly radius?: Maybe<number>; readonly sofRadius?: Maybe<number> }[]): number {
  return objects.reduce((reach, object) => Math.max(reach, Math.hypot(...object.position) + 2 * Math.max(object.radius ?? 0, object.sofRadius ?? 0, 0)), 0);
}

/**
 * The ships nearest an object, surface to surface on the balls (negative inside), nearest first, then by id.
 *
 * @param input - The object's position and radius, the ships, and how many.
 * @returns Up to `limit` entries.
 */
export function NearestShips(input: { readonly position: SceneVector; readonly radius: number; readonly ships: readonly ShipSphere[]; readonly limit?: number }): { readonly id: string; readonly distance: number }[] {
  const { position, radius, ships, limit = OBJECT_NEAREST_SHIPS } = input;
  return ships
    .map((ship) => ({ id: ship.id, distance: Math.round(Math.hypot(ship.position[0] - position[0], ship.position[1] - position[1], ship.position[2] - position[2]) - radius - ship.radius) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * The ships whose applied or pending order targets an id.
 *
 * @param id - The object id.
 * @param orders - Each ship's orders.
 * @returns The ship ids, in the map's order.
 */
export function TargetedBy(id: string, orders: ReadonlyMap<string, ShipOrders>): string[] {
  return [...orders].filter(([, ship]) => [ship.order, ship.pendingOrder].some((order) => order != null && shipOrderTarget(order) === id)).map(([ship]) => ship);
}

export interface ObjectStateRowInput {
  readonly object: SceneObject;
  readonly entry: Maybe<ObjectEntryState>;
  /**
   * The master ball, when it has one.
   */
  readonly ball: Maybe<{ readonly position: SceneVector; readonly radius: number }>;
  readonly ships: readonly ShipSphere[];
  readonly orders: ReadonlyMap<string, ShipOrders>;
}

/**
 * One get_state.objects row.
 *
 * @param input - The document object, its build entry, its ball, the ships and their orders.
 * @returns The row.
 */
export function ObjectStateRow(input: ObjectStateRowInput): SceneObjectStateReport {
  const { object, entry, ball, ships, orders } = input;
  const radius = ObjectBallRadius({ radius: object.radius, sofRadius: entry?.sofRadius });
  const position = ball?.position ?? object.position;
  const targetedBy = TargetedBy(object.id, orders);
  return {
    id: object.id,
    ...(object.type == null ? {} : { type: object.type }),
    ...(object.name == null ? {} : { name: object.name }),
    dna: object.dna,
    status: entry?.status ?? 'queued',
    ...(entry?.error ? { error: entry.error } : {}),
    ...(entry?.diagnostics?.length ? { diagnostics: entry.diagnostics } : {}),
    position: [Math.round(position[0]), Math.round(position[1]), Math.round(position[2])],
    rotation: object.rotation,
    radius: ball?.radius ?? radius.radius,
    radiusFrom: radius.from,
    ...(entry?.sofRadius != null ? { sofRadius: Math.round(entry.sofRadius) } : {}),
    distance: Math.round(Math.hypot(...position)),
    nearestShips: NearestShips({ position, radius: ball?.radius ?? radius.radius, ships }),
    ...(targetedBy.length ? { targetedBy } : {})
  };
}

/**
 * The overlay's objects line: the count and how many are in each status.
 *
 * @param rows - The objects' statuses.
 * @returns E.g. "3 · 2 ready · 1 building", or null without objects.
 */
export function ObjectsText(rows: readonly Pick<SceneObjectStateReport, 'status'>[]): Maybe<string> {
  const counts = new Map<SceneObjectStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const order: SceneObjectStatus[] = ['ready', 'validated', 'building', 'queued', 'failed'];
  return rows.length ? [String(rows.length), ...order.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${status}`)].join(' · ') : null;
}

/**
 * Which celestial target balls to remove and add when the location changes: all of them when its key changes (or it
 * is cleared), none when it is the same.
 *
 * @param input - The current key and target ids, the next key, and the next targets.
 * @returns The ids to remove and the targets to add.
 */
export function PlanCelestialTargetSync(input: { readonly currentKey: Maybe<string>; readonly current: readonly string[]; readonly nextKey: Maybe<string>; readonly targets: readonly CelestialTarget[] }): { readonly remove: string[]; readonly add: CelestialTarget[] } {
  const { currentKey, current, nextKey, targets } = input;
  const same = currentKey === nextKey && currentKey != null;
  return same ? { remove: [], add: [] } : { remove: [...current], add: nextKey == null ? [] : [...targets] };
}
