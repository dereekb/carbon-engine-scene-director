/**
 * Removal pruning, as called targets prune (fleets/targets.ts removeCalledTarget): when an edit removes a ship, object,
 * fleet, wing or squad, every cue whose subject or target it was goes, a `ships` selection or a targets order's list
 * loses the id (the cue goes once it empties), and ship steps aimed at it are dropped, each with a warning. patch_scene
 * cues are not pruned (their ops are arbitrary): a patch that no longer applies refuses the removal at normalize, with
 * the cue named. Tolerant of a draft: a cue that does not read is left for normalize to report.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';
import { type CueReference, TIMELINE_ACTIONS } from './actions';
import { draftTimelineCues } from './operations';
import { TIMELINE_ACTION_NAMES, type TimelineActionName } from './timeline';

/**
 * What an edit removed. Wings and squads are `<fleet>/<id>` keys; a removed fleet takes its wings and squads with it.
 */
export interface TimelineRemoval {
  readonly ships?: readonly string[];
  readonly objects?: readonly string[];
  readonly fleets?: readonly string[];
  readonly wings?: readonly string[];
  readonly squads?: readonly string[];
}

/**
 * The label a removal gives in messages: `ship "a"`.
 */
function removedLabel(reference: CueReference): string {
  const noun = { ship: 'ship', object: 'object', target: 'ship', place: 'ship', fleet: 'fleet', wing: 'wing', squad: 'squad', team: 'team' }[reference.kind];
  return `${noun} "${reference.id}"`;
}

function removes(removal: TimelineRemoval, reference: CueReference): boolean {
  const { kind, id, fleet } = reference;
  const gone = (list: Maybe<readonly string[]>, key: string): boolean => list?.includes(key) === true;
  let removed = false;
  if (kind === 'ship' || kind === 'object' || kind === 'target' || kind === 'place') removed = gone(removal.ships, id) || gone(removal.objects, id);
  else if (kind === 'fleet') removed = gone(removal.fleets, id);
  else if (kind === 'wing') removed = gone(removal.fleets, fleet ?? '') || gone(removal.wings, `${fleet}/${id}`);
  else if (kind === 'squad') removed = gone(removal.fleets, fleet ?? '') || gone(removal.squads, `${fleet}/${id}`);
  return removed;
}

/**
 * Prunes a draft's cues and ship steps of what an edit removed.
 *
 * @param removal - What was removed.
 * @param context - The draft and where warnings go.
 */
export function removeTimelineReferences(removal: TimelineRemoval, context: Pick<FleetOperationContext, 'draft' | 'warnings'>): void {
  const { draft, warnings } = context;
  const cues = draftTimelineCues(draft);
  if (cues) {
    const kept = cues.filter((cue) => {
      const pruned = isPlainObject(cue) ? pruneCue(cue, removal) : null;
      warnings.push(...(pruned?.messages ?? []));
      return !pruned?.removed;
    });
    cues.splice(0, cues.length, ...kept);
  }
  pruneShipSteps(removal, context);
}

interface PruneResult {
  readonly removed: boolean;
  readonly messages: string[];
}

function pruneCue(cue: JsonObject, removal: TimelineRemoval): Maybe<PruneResult> {
  const actions = TIMELINE_ACTION_NAMES.filter((key) => cue[key] != null);
  if (actions.length !== 1 || actions[0] === 'patch_scene') return null;
  const name: TimelineActionName = actions[0];
  const entry = TIMELINE_ACTIONS[name];
  const read = entry.read(cue[name], name);
  if (!read.args) return null;
  const label = `timeline: cue "${String(cue['id'] ?? '?')}" (${name} at ${String(cue['at'])} s)`;
  const references = entry.references(read.args);
  const fatal = references.find((reference) => !reference.entry && removes(removal, reference));
  if (fatal) return { removed: true, messages: [`${label} was removed with ${removedLabel(fatal)}`] };
  const entries = references.filter((reference) => reference.entry && removes(removal, reference));
  if (!entries.length) return null;
  const ids = new Set(entries.map((reference) => reference.id));
  const args = shrinkLists(read.args, ids);
  const emptied = isEmptied(args);
  const named = [...ids].map((id) => JSON.stringify(id)).join(', ');
  if (emptied) return { removed: true, messages: [`${label} was removed: its ${emptied} named only removed ${named}`] };
  cue[name] = args;
  return { removed: false, messages: [...ids].map((id) => `${label} no longer names "${id}" (it was removed)`) };
}

/**
 * Drops removed ids from the list entries a cue's arguments carry: a `ships` selection, a targets order's queue, set
 * and drop, and auto_camera's `follow`.
 */
function shrinkLists(args: JsonObject, ids: ReadonlySet<string>): JsonObject {
  const keep = (list: unknown): unknown => (Array.isArray(list) ? list.filter((id) => !ids.has(id as string)) : list);
  const shrunk: JsonObject = { ...args };
  if (Array.isArray(args['ships'])) shrunk['ships'] = keep(args['ships']);
  const follow = args['follow'];
  if (isPlainObject(follow) && ids.has((follow['fleet'] ?? follow['ship']) as string)) delete shrunk['follow'];
  const order = args['order'];
  if (isPlainObject(order) && order['type'] === 'targets') {
    const next: JsonObject = { ...order };
    for (const key of ['queue', 'set', 'drop']) if (Array.isArray(order[key])) next[key] = keep(order[key]);
    shrunk['order'] = next;
  }
  return shrunk;
}

/**
 * Which list a shrunk cue emptied: its ships selection, or a targets queue or drop (a set may empty: it then clears).
 */
function isEmptied(args: JsonObject): Maybe<string> {
  const order = args['order'];
  let emptied: Maybe<string> = null;
  if (Array.isArray(args['ships']) && !args['ships'].length) emptied = 'ships selection';
  else if (isPlainObject(order) && Array.isArray(order['queue']) && !order['queue'].length) emptied = 'targets queue';
  else if (isPlainObject(order) && Array.isArray(order['drop']) && !order['drop'].length) emptied = 'targets drop';
  return emptied;
}

function pruneShipSteps(removal: TimelineRemoval, context: Pick<FleetOperationContext, 'draft' | 'warnings'>): void {
  const targets = new Set([...(removal.ships ?? []), ...(removal.objects ?? [])]);
  const ships = context.draft['ships'];
  if (!targets.size || !Array.isArray(ships)) return;
  for (const [shipIndex, ship] of ships.entries()) {
    const steps = isPlainObject(ship) ? ship['orders'] : null;
    if (!isPlainObject(ship) || !Array.isArray(steps)) continue;
    const kept = steps.filter((step, index) => {
      const target = isPlainObject(step) ? step['target'] : null;
      const dropped = typeof target === 'string' && targets.has(target);
      if (dropped) context.warnings.push(`ships[${shipIndex}].orders[${index}] (${String((step as JsonObject)['type'])} "${target}") was dropped: "${target}" was removed`);
      return !dropped;
    });
    if (kept.length === steps.length) continue;
    if (kept.length) ship['orders'] = kept;
    else delete ship['orders'];
  }
}
