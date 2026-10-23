/**
 * The timeline's patch ops. Like every op family they write a draft tolerantly and leave the checks to
 * normalizeScene (normalize.ts):
 *
 *   { op: "add_cue", cue }                     appends a cue; a missing id is assigned at normalize
 *   { op: "update_cue", id, set: { at?, name?, <one action>? } }
 *                                              merged; an action key replaces the cue's action and clears its adds;
 *                                              name null clears; the id and adds cannot be set
 *   { op: "remove_cue", id }
 *   { op: "set_timeline", timeline }           replaces it whole; null removes it
 *   { op: "clear_timeline" }                   removes it; a no-op without one
 *
 * A ship's `orders` are edited with update_ship set { orders } (null clears them).
 */

import { isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';
import { TIMELINE_ACTION_NAMES, TIMELINE_OPERATION_NAMES } from './timeline';

export const TIMELINE_OPERATIONS: ReadonlySet<string> = new Set(TIMELINE_OPERATION_NAMES);

const ACTION_KEYS: ReadonlySet<string> = new Set(TIMELINE_ACTION_NAMES);

/**
 * The draft's cue list, turning a bare-array timeline into `{ cues }`, creating it when asked.
 *
 * @param draft - The document mid-edit.
 * @param create - Create an empty timeline when there is none.
 * @returns The list, or null when there is none (or it is malformed: normalize reports it).
 */
export function draftTimelineCues(draft: JsonObject, create = false): JsonObject[] | null {
  let timeline = draft['timeline'];
  if (Array.isArray(timeline)) {
    timeline = { cues: timeline };
    draft['timeline'] = timeline;
  }
  if (timeline == null && create) {
    timeline = { cues: [] };
    draft['timeline'] = timeline;
  }
  if (!isPlainObject(timeline)) return null;
  if (timeline['cues'] == null && create) timeline['cues'] = [];
  const cues = timeline['cues'];
  return Array.isArray(cues) ? (cues as JsonObject[]) : null;
}

/**
 * Applies one timeline operation (see TIMELINE_OPERATIONS) to a draft.
 *
 * @param operation - The operation, with its "op".
 * @param context - The draft and where problems go.
 */
export function applyTimelineOperation(operation: JsonObject, context: Pick<FleetOperationContext, 'draft' | 'where' | 'problems'>): void {
  const { draft, where, problems } = context;
  const op = operation['op'];
  if (op === 'set_timeline') {
    if (!('timeline' in operation)) problems.push(`${where}.timeline is required: { cues: [...] }, or null to remove the timeline`);
    else if (operation['timeline'] === null) delete draft['timeline'];
    else draft['timeline'] = structuredClone(operation['timeline']);
  } else if (op === 'clear_timeline') {
    delete draft['timeline'];
  } else if (op === 'add_cue') {
    addCue(operation, context);
  } else {
    const cues = draftTimelineCues(draft);
    const index = cues ? cues.findIndex((cue) => isPlainObject(cue) && cue['id'] === operation['id']) : -1;
    if (!cues || index < 0) problems.push(`${where}: no timeline cue "${String(operation['id'])}"`);
    else if (op === 'remove_cue') cues.splice(index, 1);
    else updateCue(cues[index], operation, context);
  }
}

function addCue(operation: JsonObject, context: Pick<FleetOperationContext, 'draft' | 'where' | 'problems'>): void {
  const { draft, where, problems } = context;
  const cue = operation['cue'];
  if (!isPlainObject(cue)) {
    problems.push(`${where}.cue must be an object { id?, at, name?, <action> }`);
    return;
  }
  const cues = draftTimelineCues(draft, true);
  if (!cues) problems.push(`${where}: the timeline is malformed; set_timeline replaces it`);
  else if (cue['id'] != null && cues.some((candidate) => isPlainObject(candidate) && candidate['id'] === cue['id'])) problems.push(`${where}: timeline cue "${String(cue['id'])}" already exists`);
  else cues.push(structuredClone(cue));
}

function updateCue(cue: JsonObject, operation: JsonObject, context: Pick<FleetOperationContext, 'where' | 'problems'>): void {
  const { where, problems } = context;
  const set = operation['set'];
  if (!isPlainObject(set)) {
    problems.push(`${where}.set must be an object { at?, name?, <action>? }`);
    return;
  }
  if ('id' in set) problems.push(`${where}: a cue's id cannot be changed; remove and add it instead`);
  if ('adds' in set) problems.push(`${where}.set.adds is derived from the cue's patch_scene and cannot be set`);
  const actions = Object.keys(set).filter((key) => ACTION_KEYS.has(key));
  for (const key of actions) if (set[key] === null) problems.push(`${where}.set.${key} cannot be null: remove_cue removes a cue`);
  if (problems.length) return;
  if (actions.length) {
    for (const key of ACTION_KEYS) delete cue[key];
    delete cue['adds'];
  }
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete cue[key];
    else cue[key] = structuredClone(value);
  }
}
