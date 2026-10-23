/**
 * The page's fleet command state: the live call book and free fire. order_fleet's targets order edits a group's live
 * list here at once, as moves and warps fly at once, and never writes the document: the document's `targets` are the
 * opening calls a load starts with, so a reload replays the same fight. Its free-fire order turns a group's free fire on
 * or off here (FleetTargets picks the targets); the document has no free fire, so a load ends it.
 *
 * - The book overlays the document (Overlay → toLiveFleetScene), so FleetTargets, FleetFollowing, FleetOrders and
 *   get_state read the live calls with no change of their own. `[]` shadows the document's list: the group calls
 *   nothing.
 * - A load clears it (Clear). A patch (AfterEdit) drops a group's live call when the group is gone or the patch edited
 *   its document list (beyond pruning a removed id), and prunes removed ships and objects from the live lists, with
 *   remove_ship's warning; a group gone also ends its free fire.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import { calledTargetsOf, type FleetGroup, type LiveFleetOverlay, type SceneDocument, toFleetGroupKey } from '@scene-director/scene';

/**
 * One group's live call.
 */
interface LiveCall {
  readonly group: FleetGroup;
  readonly targets: readonly string[];
}

/**
 * Whether the document holds the group.
 *
 * @param scene - The document.
 * @param group - The fleet, wing or squad.
 * @returns True when its fleet, wing or squad is there.
 */
function hasGroup(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): boolean {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let found = fleet != null;
  if (fleet && group.kind === 'wing') found = fleet.wings.some((wing) => wing.id === group.id);
  else if (fleet && group.kind === 'squad') found = fleet.wings.some((wing) => wing.squads.some((squad) => squad.id === group.id));
  return found;
}

/**
 * The group as remove_ship's pruning warning names it.
 *
 * @param group - The group.
 * @returns E.g. `fleet "blue": squad "dps"`.
 */
function pruneLabel(group: FleetGroup): string {
  return group.kind === 'fleet' ? `fleet "${group.fleet}"` : `fleet "${group.fleet}": ${group.kind} "${group.id}"`;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export class FleetCommanders {
  /**
   * The live calls by group key (toFleetGroupKey).
   */
  private readonly calls = new Map<string, LiveCall>();
  /**
   * The groups with free fire on, by group key.
   */
  private readonly freeFire = new Map<string, FleetGroup>();
  private overlay: LiveFleetOverlay = {};
  private changes = 0;

  /**
   * Bumped on every change to the calls, so a memo of the live view keys on it (free fire is not in the view).
   */
  get version(): number {
    return this.changes;
  }

  /**
   * Sets a group's live call: its list in kill order, `[]` to call nothing over the document's list.
   *
   * @param group - The fleet, wing or squad.
   * @param targets - Its called targets.
   */
  SetCall(group: FleetGroup, targets: readonly string[]): void {
    const key = toFleetGroupKey(group);
    const before = this.calls.get(key);
    if (before && sameList(before.targets, targets)) return;
    this.calls.set(key, { group, targets: [...targets] });
    this.Changed();
  }

  /**
   * A group's live call; null when the document's list stands.
   *
   * @param group - The fleet, wing or squad.
   * @returns Its live list.
   */
  CallOf(group: FleetGroup): readonly string[] | null {
    return this.calls.get(toFleetGroupKey(group))?.targets ?? null;
  }

  /**
   * Turns a group's free fire on or off.
   *
   * @param group - The fleet, wing or squad.
   * @param on - Whether its members without a call pick their own targets.
   */
  SetFreeFire(group: FleetGroup, on: boolean): void {
    const key = toFleetGroupKey(group);
    if (on) this.freeFire.set(key, group);
    else this.freeFire.delete(key);
  }

  /**
   * Whether a group has free fire on.
   *
   * @param group - The fleet, wing or squad.
   * @returns True when it is on.
   */
  FreeFireOf(group: FleetGroup): boolean {
    return this.freeFire.has(toFleetGroupKey(group));
  }

  /**
   * The groups with free fire on, for FleetTargets.Sync.
   *
   * @returns Their group keys.
   */
  FreeFireKeys(): ReadonlySet<string> {
    return new Set(this.freeFire.keys());
  }

  /**
   * Brings the book in line with a patched document: a group gone or whose document list the patch edited drops its
   * live call (the document's new list stands), and ids no longer in the scene leave the live lists.
   *
   * @param before - The document before the patch.
   * @param after - The patched document.
   * @returns A warning per live list a removed id left, in remove_ship's words.
   */
  AfterEdit(before: Pick<SceneDocument, 'fleets'>, after: Pick<SceneDocument, 'ships' | 'objects' | 'fleets'>): string[] {
    const warnings: string[] = [];
    for (const [key, group] of [...this.freeFire]) if (!hasGroup(after, group)) this.freeFire.delete(key);
    if (!this.calls.size) return warnings;
    const ids = new Set([...after.ships.map((doc) => doc.id), ...(after.objects ?? []).map((doc) => doc.id)]);
    let changed = false;
    for (const [key, call] of [...this.calls]) {
      const { group } = call;
      const written = calledTargetsOf(after, group);
      const edited = !sameList(
        calledTargetsOf(before, group).filter((id) => ids.has(id)),
        written
      );
      if (!hasGroup(after, group) || edited) {
        this.calls.delete(key);
        changed = true;
        continue;
      }
      const removed = call.targets.filter((id) => !ids.has(id));
      if (removed.length) {
        this.calls.set(key, { group, targets: call.targets.filter((id) => ids.has(id)) });
        for (const id of removed) warnings.push(`${pruneLabel(group)} no longer calls "${id}" (it was removed)`);
        changed = true;
      }
    }
    if (changed) this.Changed();
    return warnings;
  }

  /**
   * The live state toLiveFleetScene splices over the document; the same object until the next change.
   *
   * @returns The overlay.
   */
  Overlay(): LiveFleetOverlay {
    return this.overlay;
  }

  /**
   * Forgets every live call and free fire (a load: the document's calls open the fight again).
   */
  Clear(): void {
    this.freeFire.clear();
    if (!this.calls.size) return;
    this.calls.clear();
    this.Changed();
  }

  private Changed(): void {
    this.changes++;
    this.overlay = this.calls.size ? { calls: new Map([...this.calls].map(([key, call]) => [key, call.targets])) } : {};
  }
}
