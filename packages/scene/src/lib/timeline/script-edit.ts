/**
 * Script edits (Movie mode, sd-timeline doc `movie`): an edit that changes only the timeline (its cues and the movie
 * block) and ships' `orders`. The page re-simulates such an edit from the last snapshot before it makes a difference
 * instead of cutting the time-control window; anything else mixed in takes the usual path. Pure: the page and the
 * specs call these.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneDocument, SceneShip } from '../scene';
import type { SceneShipStep } from './steps';

/**
 * What a script edit changes.
 */
export interface SceneScriptEdit {
  /**
   * Cue ids, each in its document's stored order: new, gone, and kept with a different JSON (derived `arms` and `adds`
   * included).
   */
  readonly cues: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  /**
   * Ships whose `orders` changed, with the first changed step (firstChangedStep): 0 when orders were added or removed.
   */
  readonly ships: readonly { readonly id: string; readonly step: number }[];
  /**
   * Whether the movie block changed.
   */
  readonly movie: boolean;
}

/**
 * Classifies an edit of a normalized document.
 *
 * @param before - The document before.
 * @param after - The document after.
 * @returns What the script edit changes (empty lists when nothing in the script changed), or null when anything
 *   besides the timeline and ships' orders changed.
 */
export function scriptEditOf(before: SceneDocument, after: SceneDocument): Maybe<SceneScriptEdit> {
  if (JSON.stringify(withoutScript(before)) !== JSON.stringify(withoutScript(after))) return null;
  const oldCues = new Map((before.timeline?.cues ?? []).map((cue) => [cue.id, JSON.stringify(cue)]));
  const newCues = after.timeline?.cues ?? [];
  const newIds = new Set(newCues.map((cue) => cue.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const cue of newCues) {
    const old = oldCues.get(cue.id);
    if (old == null) added.push(cue.id);
    else if (old !== JSON.stringify(cue)) changed.push(cue.id);
  }
  const removed = (before.timeline?.cues ?? []).filter((cue) => !newIds.has(cue.id)).map((cue) => cue.id);
  const oldShips = new Map(before.ships.map((ship) => [ship.id, ship]));
  const ships: { readonly id: string; readonly step: number }[] = [];
  for (const ship of after.ships) {
    const step = firstChangedStep(oldShips.get(ship.id)?.orders, ship.orders);
    if (step != null) ships.push({ id: ship.id, step });
  }
  const movie = JSON.stringify(before.timeline?.movie ?? null) !== JSON.stringify(after.timeline?.movie ?? null);
  return { cues: { added, removed, changed }, ships, movie };
}

/**
 * Whether a script edit changes nothing.
 *
 * @param edit - From scriptEditOf.
 * @returns True when no cue, no ship's orders and not the movie block changed.
 */
export function scriptEditIsEmpty(edit: SceneScriptEdit): boolean {
  return !edit.cues.added.length && !edit.cues.removed.length && !edit.cues.changed.length && !edit.ships.length && !edit.movie;
}

/**
 * Whether an edit changed the script at all (the timeline or any ship's orders), mixed with other changes or not.
 *
 * @param before - The document before.
 * @param after - The document after.
 * @returns True when the timeline or some ship's orders differ.
 */
export function scriptChanged(before: SceneDocument, after: SceneDocument): boolean {
  const script = (scene: SceneDocument): string => JSON.stringify([scene.timeline ?? null, scene.ships.map((ship) => [ship.id, ship.orders ?? null])]);
  return script(before) !== script(after);
}

/**
 * The first step two scripts differ at.
 *
 * @param before - A ship's orders before (absent: none).
 * @param after - Its orders after.
 * @returns Null when equal; else the first index whose step differs, or the shorter length when one extends the other
 *   (0 when orders were added or removed).
 */
export function firstChangedStep(before: Maybe<readonly SceneShipStep[]>, after: Maybe<readonly SceneShipStep[]>): Maybe<number> {
  const a = before ?? [];
  const b = after ?? [];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) return index;
  return a.length === b.length ? null : shared;
}

/**
 * The live scene with a script edit's ship orders: each live ship that the authored document holds takes the edited
 * document's orders, unless a live edit gave it other orders than the authored document had (a patch cue's
 * `update_ship`), which stay. Ships the timeline added keep theirs.
 *
 * @param live - The live scene (the authored document without its timeline, plus the live edits).
 * @param before - The authored document the live scene follows.
 * @param after - The edited authored document.
 * @returns The live scene with the new orders (the same object when nothing changes).
 */
export function withScriptOrders(live: SceneDocument, before: SceneDocument, after: SceneDocument): SceneDocument {
  const old = new Map(before.ships.map((ship) => [ship.id, ship]));
  const edited = new Map(after.ships.map((ship) => [ship.id, ship]));
  let changed = false;
  const ships = live.ships.map((ship) => {
    const was = old.get(ship.id);
    const next = edited.get(ship.id);
    if (!was || !next || JSON.stringify(ship.orders ?? null) !== JSON.stringify(was.orders ?? null) || JSON.stringify(ship.orders ?? null) === JSON.stringify(next.orders ?? null)) return ship;
    changed = true;
    const { orders: _orders, ...rest } = ship;
    return next.orders?.length ? { ...rest, orders: next.orders } : rest;
  });
  return changed ? { ...live, ships } : live;
}

function withoutScript(scene: SceneDocument): object {
  const { timeline: _timeline, ships, ...rest } = scene;
  return { ...rest, ships: ships.map(({ orders: _orders, ...ship }: SceneShip) => ship) };
}
