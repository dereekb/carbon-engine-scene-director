/**
 * A fleet, or one wing or squad of it, as fleet orders and called targets address it. Its own module so that orders.ts
 * and targets.ts, which orders.ts imports, share it without importing each other.
 */

export type FleetGroupKind = 'fleet' | 'wing' | 'squad';

/**
 * A fleet, or one wing or squad of it.
 */
export interface FleetGroup {
  readonly fleet: string;
  readonly kind: FleetGroupKind;
  /**
   * The fleet's, wing's or squad's id.
   */
  readonly id: string;
}

/**
 * A group's key in the page's records.
 *
 * @param group - The group.
 * @returns `"tfis"`, `"tfis/wing/mainline"` or `"tfis/squad/logi"`.
 */
export function toFleetGroupKey(group: FleetGroup): string {
  return group.kind === 'fleet' ? group.fleet : `${group.fleet}/${group.kind}/${group.id}`;
}

/**
 * The group as messages name it.
 *
 * @param group - The group.
 * @returns E.g. `squad "logi" of fleet "tfis"`.
 */
export function describeFleetGroup(group: FleetGroup): string {
  return group.kind === 'fleet' ? `fleet "${group.fleet}"` : `${group.kind} "${group.id}" of fleet "${group.fleet}"`;
}
