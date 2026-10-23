/**
 * Validates the document's `timeline`: each cue's id, time and one action (read by its lever's normalizer), the
 * limits, then every cue's references against the scene as projected to its time (projection.ts), and each patch cue's
 * `adds` pinned. Event cues (`when`) are reserved for Movie mode and refused.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject, sameJson } from '../json';
import { type SceneDocument, SceneError } from '../scene';
import { checkCueReferences, TIMELINE_ACTIONS, toTimelineScope } from './actions';
import { type ApplySceneOperations, describeCueAdds, sceneAddsBetween, sceneIdsOf } from './projection';
import { MAX_PATCH_CUES, MAX_TIMELINE_CUES, MAX_TIMELINE_SECONDS, SCENE_CUE_ADDS_KEYS, type SceneCue, type SceneCueAdds, type SceneTimeline, TIMELINE_ACTION_NAMES, type TimelineActionName } from './timeline';

export interface NormalizeSceneTimelineInput {
  readonly input: unknown;
  /**
   * The normalized document without its timeline: the projection's start.
   */
  readonly scene: SceneDocument;
  readonly apply: ApplySceneOperations;
  /**
   * Whether to project and check references (default true); off when the document already has problems, which every
   * projection step would repeat.
   */
  readonly project?: boolean;
}

export interface NormalizedSceneTimeline {
  /**
   * The timeline; null when absent or without cues (normalize omits it).
   */
  readonly timeline: Maybe<SceneTimeline>;
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * Every ship and object id a patch cue adds: ship steps may target them.
   */
  readonly addedTargets: ReadonlySet<string>;
}

interface ReadCue {
  /**
   * Its position in the input, for messages.
   */
  readonly index: number;
  id: Maybe<string>;
  readonly at: number;
  readonly name: Maybe<string>;
  readonly action: TimelineActionName;
  readonly args: JsonObject;
  readonly adds: Maybe<SceneCueAdds>;
}

const TIMELINE_KEYS = new Set(['cues']);
const CUE_KEYS = new Set<string>(['id', 'at', 'name', 'adds', 'when', ...TIMELINE_ACTION_NAMES]);

/**
 * The message prefix of a cue: `timeline.cues[3] ("focus")`.
 *
 * @param cue - Its input position and id.
 * @returns The prefix.
 */
function cueWhere(cue: Pick<ReadCue, 'index' | 'id'>): string {
  const id = cue.id ? ' ("' + cue.id + '")' : '';
  return `timeline.cues[${cue.index}]${id}`;
}

/**
 * Validates a timeline against its document.
 *
 * - A bare array is shorthand for `{ cues }`; unknown timeline and cue keys warn and are dropped.
 * - A cue: `id` (unique; missing ids get the lowest free `cue-<n>` in input order), `at` (seconds in [0, 86,400]),
 *   `name?` and exactly one action. `when` is refused: event cues are reserved for Movie mode.
 * - Cues are sorted by `at`, stably. At most MAX_TIMELINE_CUES cues and MAX_PATCH_CUES patch cues.
 * - Each cue's references are checked against the scene as it will be when the cue fires; a patch cue that no longer
 *   applies is a problem; each patch cue's `adds` is derived, an edit taking a recorded id is a problem, and a drifted
 *   allocation re-pins with a warning.
 *
 * @param input - The candidate timeline, the document without it, and applySceneOperations.
 * @returns The timeline, its problems and warnings, and every target id a cue adds.
 */
export function normalizeSceneTimeline(input: NormalizeSceneTimelineInput): NormalizedSceneTimeline {
  const problems: string[] = [];
  const warnings: string[] = [];
  const empty = { timeline: null, problems, warnings, addedTargets: new Set<string>() };
  const value = input.input;
  if (value == null) return empty;

  let list: unknown = value;
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) if (!TIMELINE_KEYS.has(key)) warnings.push(`timeline.${key} is not a known field and was dropped`);
    list = value['cues'] ?? [];
  }
  if (!Array.isArray(list)) {
    problems.push('timeline must be { cues: [...] } or an array of cues');
    return empty;
  }
  if (list.length > MAX_TIMELINE_CUES) problems.push(`timeline holds ${list.length} cues; at most ${MAX_TIMELINE_CUES}`);

  const cues = list.flatMap((entry, index) => readCue(entry, index, { problems, warnings }) ?? []);
  assignCueIds(cues, problems);
  const sorted = cues
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.at - b.cue.at || a.order - b.order)
    .map(({ cue }) => cue);
  const patches = sorted.filter((cue) => cue.action === 'patch_scene').length;
  if (patches > MAX_PATCH_CUES) problems.push(`timeline holds ${patches} patch_scene cues; at most ${MAX_PATCH_CUES}`);

  const derived = problems.length || input.project === false ? new Map<ReadCue, SceneCueAdds>() : projectCues(sorted, input, { problems, warnings });
  const addedTargets = new Set([...derived.values()].flatMap((adds) => [...(adds.ships ?? []), ...(adds.objects ?? [])]));
  const timeline = sorted.length ? { cues: sorted.map((cue) => toSceneCue(cue, derived.get(cue))) } : null;
  return { timeline, problems, warnings, addedTargets };
}

interface Report {
  readonly problems: string[];
  readonly warnings: string[];
}

function readCue(entry: unknown, index: number, report: Report): Maybe<ReadCue> {
  const { problems, warnings } = report;
  const where = `timeline.cues[${index}]`;
  if (!isPlainObject(entry)) {
    problems.push(`${where} must be an object { id?, at, name?, <action> }`);
    return null;
  }
  for (const key of Object.keys(entry)) if (!CUE_KEYS.has(key)) warnings.push(`${where}.${key} is not a known field and was dropped`);
  const before = problems.length;
  const { id, at, name, when, adds } = entry;
  if (id != null && (typeof id !== 'string' || !ID_PATTERN.test(id))) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  const label = typeof id === 'string' ? `${where} ("${id}")` : where;
  if (when !== undefined) problems.push(`${label}.when is reserved for Movie mode's event cues; give at (seconds from play start)`);
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > MAX_TIMELINE_SECONDS) problems.push(`${label}.at must be a number of seconds from play start in [0, ${MAX_TIMELINE_SECONDS}]`);
  if (name != null && (typeof name !== 'string' || !name.trim())) problems.push(`${label}.name must be a non-empty string`);

  const actions = TIMELINE_ACTION_NAMES.filter((key) => entry[key] != null);
  let action: Maybe<TimelineActionName> = null;
  let args: Maybe<JsonObject> = null;
  if (actions.length !== 1) {
    const got = actions.length ? ', got ' + actions.join(', ') : '';
    problems.push(`${label} needs exactly one action (${TIMELINE_ACTION_NAMES.join(', ')})${got}`);
  } else {
    action = actions[0];
    const read = TIMELINE_ACTIONS[action].read(entry[action], `${label}.${action}`);
    problems.push(...read.problems);
    warnings.push(...read.warnings);
    args = read.args;
  }
  if (adds != null && action !== 'patch_scene') warnings.push(`${label}.adds belongs to patch_scene cues and was dropped`);
  const recorded = action === 'patch_scene' ? readAdds(adds) : null;
  if (problems.length > before || !action || !args) return null;
  return { index, id: typeof id === 'string' ? id : null, at: at as number, name: typeof name === 'string' ? name.trim() : null, action, args, adds: recorded };
}

function readAdds(value: unknown): Maybe<SceneCueAdds> {
  if (!isPlainObject(value)) return null;
  const adds: { -readonly [K in keyof SceneCueAdds]: string[] } = {};
  for (const key of SCENE_CUE_ADDS_KEYS) {
    const ids = value[key];
    if (Array.isArray(ids)) adds[key] = ids.filter((id): id is string => typeof id === 'string');
  }
  return adds;
}

function assignCueIds(cues: ReadCue[], problems: string[]): void {
  const used = new Set<string>();
  for (const cue of cues) {
    if (cue.id == null) continue;
    if (used.has(cue.id)) problems.push(`${cueWhere(cue)}: cue id "${cue.id}" is used more than once`);
    used.add(cue.id);
  }
  let next = 1;
  for (const cue of cues) {
    if (cue.id != null) continue;
    while (used.has(`cue-${next}`)) next += 1;
    cue.id = `cue-${next}`;
    used.add(cue.id);
  }
}

/**
 * Walks the sorted cues over the projected scene: checks each cue's references against the scene when it fires,
 * applies each patch cue and derives its adds.
 */
function projectCues(sorted: readonly ReadCue[], input: NormalizeSceneTimelineInput, report: Report): Map<ReadCue, SceneCueAdds> {
  const { problems, warnings } = report;
  const derived = new Map<ReadCue, SceneCueAdds>();
  let current = input.scene;
  for (const cue of sorted) {
    const where = cueWhere(cue);
    if (cue.action !== 'patch_scene') {
      const entry = TIMELINE_ACTIONS[cue.action];
      const checked = checkCueReferences(entry.references(cue.args), toTimelineScope(current), `${where}.${cue.action}`);
      problems.push(...checked.problems);
      warnings.push(...checked.warnings);
      if (!checked.problems.length && entry.advise) warnings.push(...entry.advise(cue.args, current).map((warning) => `${where}.${cue.action} ${warning}`));
      continue;
    }
    if (stolenAdds(cue, current, report)) continue;
    try {
      const next = input.apply(current, cue.args['operations']).scene;
      const adds = sceneAddsBetween(current, next);
      pinAdds({ cue, adds, report });
      derived.set(cue, adds);
      current = next;
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
      problems.push(...error.problems.map((problem) => `${cueWhere(cue)} (${cue.at} s): ${problem}: edit or remove the cue first`));
    }
  }
  return derived;
}

/**
 * Whether an edit took an id a patch cue recorded adding: the scene before the cue already holds it. Each is a problem
 * naming the cue (this is what stops an edit from silently re-binding later cues to another ship).
 */
function stolenAdds(cue: ReadCue, before: SceneDocument, report: Report): boolean {
  const held = sceneIdsOf(before);
  const nouns = { ships: 'ship', objects: 'object', fleets: 'fleet', wings: 'wing', squads: 'squad' } as const;
  let stolen = false;
  for (const key of SCENE_CUE_ADDS_KEYS) {
    for (const id of cue.adds?.[key] ?? []) {
      if (!held[key].has(id)) continue;
      stolen = true;
      report.problems.push(`${nouns[key]} "${id}" is added by timeline cue "${cue.id}" at ${cue.at} s: give the new ${nouns[key]} another id, or edit the cue`);
    }
  }
  return stolen;
}

interface PinAddsInput {
  readonly cue: ReadCue;
  readonly adds: SceneCueAdds;
  readonly report: Report;
}

/**
 * Compares a patch cue's recorded adds with what it adds now: a difference (the allocation drifted) re-pins with a
 * warning, and later cues naming the old ids then fail their reference checks.
 */
function pinAdds(input: PinAddsInput): void {
  const { cue, adds, report } = input;
  const recorded = cue.adds;
  if (!recorded || sameJson(normalizedAdds(recorded), normalizedAdds(adds))) return;
  const now = describeCueAdds(adds).join(', ') || 'nothing';
  const was = describeCueAdds(recorded).join(', ') || 'nothing';
  report.warnings.push(`timeline cue "${cue.id}" now adds ${now} (it added ${was})`);
}

function normalizedAdds(adds: SceneCueAdds): SceneCueAdds {
  const result: { -readonly [K in keyof SceneCueAdds]: string[] } = {};
  for (const key of SCENE_CUE_ADDS_KEYS) if (adds[key]?.length) result[key] = [...(adds[key] ?? [])].sort();
  return result;
}

function toSceneCue(cue: ReadCue, adds: Maybe<SceneCueAdds>): SceneCue {
  const pinned = adds ?? (cue.adds ? normalizedAdds(cue.adds) : null);
  return {
    id: cue.id ?? '',
    at: cue.at,
    ...(cue.name ? { name: cue.name } : {}),
    [cue.action]: cue.args,
    ...(pinned && Object.keys(pinned).length ? { adds: pinned } : {})
  } as unknown as SceneCue;
}
