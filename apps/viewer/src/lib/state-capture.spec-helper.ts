/**
 * The owners' time-control round trip (sd-time), shared by their specs: snapshot, mutate further, restore. It imports
 * no vitest, so the app's tsconfig may include it; each spec asserts with ExpectRoundTrip's three lines:
 *
 * ```ts
 * expect(trip.mutated).not.toEqual(trip.before);
 * expect(trip.after).toEqual(trip.before);
 * expect(trip.again).toEqual(trip.snapshot);
 * ```
 */

export interface SnapshotOwner {
  Snapshot(): unknown;
  Restore(state: unknown): void;
}

export interface RoundTripResult {
  /**
   * The owner's report at the snapshot.
   */
  readonly before: unknown;
  /**
   * After the mutation (it must differ, or the trip proves nothing).
   */
  readonly mutated: unknown;
  /**
   * After the restore (it must equal `before`).
   */
  readonly after: unknown;
  /**
   * The snapshot, and the owner snapshotted again after the restore: every non-wiring field, which must be equal.
   */
  readonly snapshot: unknown;
  readonly again: unknown;
}

/**
 * Snapshots an owner, mutates it, restores it, and reports at each step.
 *
 * @param owner - An owner already driven to a non-trivial state.
 * @param report - Its observable reports (copied with structuredClone at each step).
 * @param mutate - Drives it further.
 * @param undo - Puts the owner's fakes back as they were at the snapshot, right after the restore (a fake port's
 *   state the mutation changed).
 * @returns The reports and the two snapshots.
 */
export function RoundTrip<T extends SnapshotOwner>(owner: T, report: (owner: T) => unknown, mutate: (owner: T) => void, undo?: () => void): RoundTripResult {
  // Reports first: a report may fill a memo, which the snapshot then holds too.
  const before = structuredClone(report(owner));
  const snapshot = owner.Snapshot();
  mutate(owner);
  const mutated = structuredClone(report(owner));
  owner.Restore(snapshot);
  undo?.();
  return { before, mutated, after: structuredClone(report(owner)), snapshot, again: owner.Snapshot() };
}
