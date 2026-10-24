/**
 * The timeline's patch ops. Like every op family they write a draft tolerantly and leave the checks to
 * normalizeScene (normalize.ts):
 *
 *   { op: "add_cue", cue }                     appends a cue; a missing id is assigned at normalize
 *   { op: "update_cue", id, set: { at?, when?, name?, <one action>? } }
 *                                              merged; an action key replaces the cue's action and clears its adds;
 *                                              name, at (on an event cue) and when (on a cue with at) null clear;
 *                                              the id, adds and arms cannot be set
 *   { op: "remove_cue", id }
 *   { op: "set_timeline", timeline }           replaces it whole; null removes it
 *   { op: "clear_timeline" }                   removes it; a no-op without one
 *   { op: "set_movie", movie }                 merged into the movie block; a null key resets it; null removes it
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
  } else if (op === 'set_movie') {
    setMovie(operation, context);
  } else {
    const cues = draftTimelineCues(draft);
    const index = cues ? cues.findIndex((cue) => isPlainObject(cue) && cue['id'] === operation['id']) : -1;
    if (!cues || index < 0) problems.push(`${where}: no timeline cue "${String(operation['id'])}"`);
    else if (op === 'remove_cue') cues.splice(index, 1);
    else updateCue(cues[index], operation, context);
  }
}

function setMovie(operation: JsonObject, context: Pick<FleetOperationContext, 'draft' | 'where' | 'problems'>): void {
  const { draft, where, problems } = context;
  const movie = operation['movie'];
  if (movie !== null && !isPlainObject(movie)) {
    problems.push(`${where}.movie must be an object { letterbox?, hud?, end? }, or null to remove the movie block`);
    return;
  }
  if (movie === null) {
    const timeline = draft['timeline'];
    if (isPlainObject(timeline)) delete timeline['movie'];
    return;
  }
  if (!draftTimelineCues(draft, true)) {
    problems.push(`${where}: the timeline is malformed; set_timeline replaces it`);
    return;
  }
  const timeline = draft['timeline'] as JsonObject;
  const next: JsonObject = isPlainObject(timeline['movie']) ? { ...timeline['movie'] } : {};
  for (const [key, value] of Object.entries(movie)) {
    if (value === null) delete next[key];
    else next[key] = structuredClone(value);
  }
  timeline['movie'] = next;
}

function addCue(operation: JsonObject, context: Pick<FleetOperationContext, 'draft' | 'where' | 'problems'>): void {
  const { draft, where, problems } = context;
  const cue = operation['cue'];
  if (!isPlainObject(cue)) {
    problems.push(`${where}.cue must be an object { id?, at | when, name?, <action> }`);
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
    problems.push(`${where}.set must be an object { at?, when?, name?, <action>? }`);
    return;
  }
  if ('id' in set) problems.push(`${where}: a cue's id cannot be changed; remove and add it instead`);
  if ('adds' in set) problems.push(`${where}.set.adds is derived from the cue's patch_scene and cannot be set`);
  if ('arms' in set) problems.push(`${where}.set.arms is derived (at, or when what the event cue names exists) and cannot be set`);
  if (set['at'] === null && set['when'] === undefined && cue['when'] == null) problems.push(`${where}.set.at cannot be null on a timed cue: give when to make it an event cue`);
  if (set['when'] === null && set['at'] === undefined && cue['at'] == null) problems.push(`${where}.set.when cannot be null on a cue without at: give at to make it a timed cue`);
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
  if (cue['when'] == null) delete cue['arms'];
}
