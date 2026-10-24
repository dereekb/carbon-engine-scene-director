/**
 * Validates the document's `timeline`: each cue's id, time or event (`when`, events.ts) and one action (read by its
 * lever's normalizer), the movie block, the limits, then every cue's references against the scene as projected to its
 * check second (projection.ts; an event cue's derived `arms`), each patch cue's `adds` pinned, and event cues' filters,
 * chains and `latest`.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject, sameJson } from '../json';
import { type SceneDocument, SceneError } from '../scene';
import { checkCueReferences, type CueReference, TIMELINE_ACTIONS, type TimelineScope, toTimelineScope } from './actions';
import { type CueTrigger, cueTriggerReferences, describeCueTrigger, normalizeCueTrigger } from './events';
import { type ApplySceneOperations, describeCueAdds, sceneAddsBetween, sceneIdsOf } from './projection';
import { cueDueSecond, describeCueTiming, MAX_PATCH_CUES, MAX_TIMELINE_CUES, MAX_TIMELINE_SECONDS, SCENE_CUE_ADDS_KEYS, SCENE_MOVIE_KEYS, type SceneCue, type SceneCueAdds, type SceneMovie, type SceneTimeline, TIMELINE_ACTION_NAMES, type TimelineActionName } from './timeline';

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
   * The timeline; null when absent, or without cues and a movie block (normalize omits it).
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
   * Its position in the input, for messages and the stable order.
   */
  readonly index: number;
  id: Maybe<string>;
  /**
   * A timed cue's time; an event cue's optional arm time.
   */
  readonly at: Maybe<number>;
  readonly when: Maybe<CueTrigger>;
  /**
   * An event cue's arm time: `at`, or derived by the projection walk.
   */
  arms: Maybe<number>;
  readonly name: Maybe<string>;
  readonly action: TimelineActionName;
  readonly args: JsonObject;
  readonly adds: Maybe<SceneCueAdds>;
}

const TIMELINE_KEYS = new Set(['cues', 'movie']);
const CUE_KEYS = new Set<string>(['id', 'at', 'when', 'arms', 'name', 'adds', ...TIMELINE_ACTION_NAMES]);

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
 * The second a read cue is checked at (cueCheckSecond).
 */
function checkSecond(cue: ReadCue): number {
  return cueDueSecond((cue.when ? (cue.arms ?? cue.at) : cue.at) ?? 0);
}

/**
 * The stored order: check second, timed before event cues at the same second, then input order.
 */
function compareCues(a: ReadCue, b: ReadCue): number {
  return checkSecond(a) - checkSecond(b) || Number(a.when != null) - Number(b.when != null) || a.index - b.index;
}

/**
 * Validates a timeline against its document.
 *
 * - A bare array is shorthand for `{ cues }`; unknown timeline and cue keys warn and are dropped.
 * - A cue: `id` (unique; missing ids get the lowest free `cue-<n>` in input order), `at` (seconds in [0, 86,400]) or
 *   `when` (an event, events.ts; `at` is then its optional arm time), `name?` and exactly one action. A written `arms`
 *   is re-derived.
 * - `movie` (`{ letterbox?, hud?, end? }`) is kept even without cues.
 * - Cues are sorted by check second (a timed cue's due second, an event cue's arms), stably, timed before event cues
 *   at the same second. At most MAX_TIMELINE_CUES cues and MAX_PATCH_CUES patch cues.
 * - Each cue's references are checked against the scene as it will be at its check second; an event cue without `at`
 *   arms at the first second everything it names exists (and after a chained cue's check second); a patch cue that no
 *   longer applies is a problem; each patch cue's `adds` is derived, an edit taking a recorded id is a problem, and a
 *   drifted allocation re-pins with a warning. An event cue's filter ids must exist at some point; a `cue` chain must
 *   name another cue, without cycles; `latest` may not come before `arms`.
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
  let movie: Maybe<SceneMovie> = null;
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) if (!TIMELINE_KEYS.has(key)) warnings.push(`timeline.${key} is not a known field and was dropped`);
    list = value['cues'] ?? [];
    movie = readMovie(value['movie'], { problems, warnings });
  }
  if (!Array.isArray(list)) {
    problems.push('timeline must be { cues: [...], movie? } or an array of cues');
    return empty;
  }
  if (list.length > MAX_TIMELINE_CUES) problems.push(`timeline holds ${list.length} cues; at most ${MAX_TIMELINE_CUES}`);

  const cues = list.flatMap((entry, index) => readCue(entry, index, { problems, warnings }) ?? []);
  assignCueIds(cues, problems);
  checkChains(cues, problems);
  const patches = cues.filter((cue) => cue.action === 'patch_scene').length;
  if (patches > MAX_PATCH_CUES) problems.push(`timeline holds ${patches} patch_scene cues; at most ${MAX_PATCH_CUES}`);

  let derived = new Map<ReadCue, SceneCueAdds>();
  if (problems.length || input.project === false) {
    for (const cue of cues) if (cue.when) cue.arms = cue.at ?? 0;
  } else {
    derived = projectCues(cues, input, { problems, warnings });
  }
  const sorted = [...cues].sort(compareCues);
  const addedTargets = new Set([...derived.values()].flatMap((adds) => [...(adds.ships ?? []), ...(adds.objects ?? [])]));
  const timeline = sorted.length || movie ? { cues: sorted.map((cue) => toSceneCue(cue, derived.get(cue))), ...(movie ? { movie } : {}) } : null;
  return { timeline, problems, warnings, addedTargets };
}

interface Report {
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Reads the movie block: unknown keys warn and are dropped; a bad value is a problem.
 */
function readMovie(value: unknown, report: Report): Maybe<SceneMovie> {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    report.problems.push('timeline.movie must be an object { letterbox?, hud?, end? }');
    return null;
  }
  for (const key of Object.keys(value)) if (!(SCENE_MOVIE_KEYS as readonly string[]).includes(key)) report.warnings.push(`timeline.movie.${key} is not a known field and was dropped`);
  const { letterbox, hud, end } = value;
  const movie: { -readonly [K in keyof SceneMovie]: SceneMovie[K] } = {};
  if (letterbox === false || (typeof letterbox === 'number' && Number.isFinite(letterbox) && letterbox >= 0.5 && letterbox <= 4)) movie.letterbox = letterbox;
  else if (letterbox != null) report.problems.push('timeline.movie.letterbox must be an aspect ratio in [0.5, 4] (2.39 by default), or false for none');
  if (typeof hud === 'boolean') movie.hud = hud;
  else if (hud != null) report.problems.push('timeline.movie.hud must be true or false');
  if (typeof end === 'number' && Number.isFinite(end) && end > 0 && end <= MAX_TIMELINE_SECONDS) movie.end = end;
  else if (end != null) report.problems.push(`timeline.movie.end must be timeline seconds in (0, ${MAX_TIMELINE_SECONDS}]`);
  return movie;
}

function readCue(entry: unknown, index: number, report: Report): Maybe<ReadCue> {
  const { problems, warnings } = report;
  const where = `timeline.cues[${index}]`;
  if (!isPlainObject(entry)) {
    problems.push(`${where} must be an object { id?, at | when, name?, <action> }`);
    return null;
  }
  for (const key of Object.keys(entry)) if (!CUE_KEYS.has(key)) warnings.push(`${where}.${key} is not a known field and was dropped`);
  const before = problems.length;
  const { id, at, name, when, adds } = entry;
  if (id != null && (typeof id !== 'string' || !ID_PATTERN.test(id))) problems.push(`${where}.id must be 1-64 letters, digits, "_", "-" or "."`);
  const label = typeof id === 'string' ? `${where} ("${id}")` : where;
  let trigger: Maybe<CueTrigger> = null;
  if (when != null) {
    const read = normalizeCueTrigger(when, `${label}.when`);
    problems.push(...read.problems);
    warnings.push(...read.warnings);
    trigger = read.trigger;
  }
  if (at == null && when == null) problems.push(`${label} needs at (seconds from play start) or when (an event)`);
  else if (at != null && (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > MAX_TIMELINE_SECONDS)) problems.push(`${label}.at must be a number of seconds from play start in [0, ${MAX_TIMELINE_SECONDS}]`);
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
  return { index, id: typeof id === 'string' ? id : null, at: typeof at === 'number' ? at : null, when: trigger, arms: null, name: typeof name === 'string' ? name.trim() : null, action, args, adds: recorded };
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
 * A `cue` trigger must name another cue in the timeline, and chains may not loop. A chain on a missing cue is how an
 * explicit remove_cue of a waited-for cue is refused (removals prune chains instead, prune.ts).
 */
function checkChains(cues: readonly ReadCue[], problems: string[]): void {
  const byId = new Map(cues.map((cue) => [cue.id, cue]));
  const reported = new Set<ReadCue>();
  for (const cue of cues) {
    const target = cue.when?.cue;
    if (target == null) continue;
    if (target === cue.id) problems.push(`${cueWhere(cue)}.when.cue: cue "${cue.id}" waits for itself`);
    else if (!byId.has(target)) problems.push(`${cueWhere(cue)}.when.cue: cue "${cue.id}" waits for cue "${target}", which is not in the timeline: remove or re-cue "${cue.id}" first`);
  }
  for (const cue of cues) {
    const path: ReadCue[] = [];
    let current: Maybe<ReadCue> = cue;
    while (current && !path.includes(current) && !reported.has(current)) {
      path.push(current);
      const next: Maybe<string> = current.when?.cue;
      current = next != null && next !== current.id ? byId.get(next) : null;
    }
    if (!current || reported.has(current) || current === path.at(-1)) continue;
    const loop = path.slice(path.indexOf(current));
    for (const member of loop) reported.add(member);
    const names = [...loop, current].map((member) => '"' + member.id + '"').join(' → ');
    problems.push(`${cueWhere(current)}.when.cue: cues ${names} wait for each other: none of them can fire`);
  }
}

/**
 * An id's key in the walk's map of what the scene has held: `ship:a`, `wing:blue/w1`, `team:red`.
 */
function referenceKeys(reference: CueReference): string[] {
  const { kind, id, fleet } = reference;
  if (kind === 'target' || kind === 'place') return [`ship:${id}`, `object:${id}`];
  if (kind === 'wing' || kind === 'squad') return [`${kind}:${fleet}/${id}`];
  return [`${kind}:${id}`];
}

/**
 * The keys of every id a scene holds.
 */
function heldKeys(scene: SceneDocument): string[] {
  const ids = sceneIdsOf(scene);
  const keys = [...ids.ships].map((id) => `ship:${id}`);
  keys.push(...[...ids.objects].map((id) => `object:${id}`), ...[...ids.fleets].map((id) => `fleet:${id}`));
  keys.push(...[...ids.wings].map((id) => `wing:${id}`), ...[...ids.squads].map((id) => `squad:${id}`));
  keys.push(...scene.ships.flatMap((ship) => (ship.team ? [`team:${ship.team}`] : [])));
  return keys;
}

/**
 * What the walk knows of when each id first exists: the second, and the patch cue adding it.
 */
class HeldIds {
  private readonly seconds = new Map<string, number>();
  private readonly adders = new Map<string, ReadCue>();

  Note(scene: SceneDocument, second: number, cue?: ReadCue): void {
    for (const key of heldKeys(scene)) {
      if (this.seconds.has(key)) continue;
      this.seconds.set(key, second);
      if (cue) this.adders.set(key, cue);
    }
  }

  /**
   * The second a reference first exists; a place that is no id (a name) exists from 0; null when not (yet).
   */
  Second(reference: CueReference): Maybe<number> {
    const seconds = referenceKeys(reference).flatMap((key) => (this.seconds.has(key) ? [this.seconds.get(key) as number] : []));
    if (!seconds.length) return reference.kind === 'place' ? 0 : null;
    return Math.min(...seconds);
  }

  Adder(reference: CueReference): Maybe<ReadCue> {
    return (
      referenceKeys(reference)
        .map((key) => this.adders.get(key))
        .find((cue) => cue != null) ?? null
    );
  }
}

const REFERENCE_NOUNS: Readonly<Record<CueReference['kind'], string>> = { ship: 'ship', object: 'object', target: 'ship', place: 'ship', fleet: 'fleet', wing: 'wing', squad: 'squad', team: 'team' };

interface Walk {
  readonly input: NormalizeSceneTimelineInput;
  readonly report: Report;
  readonly held: HeldIds;
  readonly byId: ReadonlyMap<Maybe<string>, ReadCue>;
  readonly adds: Map<ReadCue, SceneCueAdds>;
  /**
   * Event cues with an `at` whose action names an id not held when they arm: refused after the walk, with a hint when
   * a later cue adds it.
   */
  readonly early: { readonly cue: ReadCue; readonly reference: CueReference; readonly scope: TimelineScope }[];
  current: SceneDocument;
}

function actionReferences(cue: ReadCue): CueReference[] {
  return cue.action === 'patch_scene' ? [] : TIMELINE_ACTIONS[cue.action].references(cue.args);
}

/**
 * An event cue's derived arm time, once everything it names exists and its chained cue's check second is known; null
 * while it still waits.
 */
function deriveArms(cue: ReadCue, walk: Walk, known: ReadonlySet<ReadCue>): Maybe<number> {
  const trigger = cue.when as CueTrigger;
  const { references, cue: chained } = cueTriggerReferences(trigger);
  let arms = 0;
  for (const reference of [...actionReferences(cue), ...references]) {
    const second = walk.held.Second(reference);
    if (second == null) return null;
    arms = Math.max(arms, second);
  }
  if (chained != null) {
    const target = walk.byId.get(chained);
    if (!target || !known.has(target)) return null;
    arms = Math.max(arms, checkSecond(target));
  }
  return arms;
}

/**
 * Walks the cues in check-second order over the projected scene: checks each cue's references against the scene at its
 * check second, applies each patch cue and derives its adds, and derives the arm time of each event cue without `at`
 * as soon as what it names exists. Then the deferred event-cue checks: filters against everything the scene ever
 * holds, early arm times, underivable arm times, `latest`.
 */
function projectCues(cues: readonly ReadCue[], input: NormalizeSceneTimelineInput, report: Report): Map<ReadCue, SceneCueAdds> {
  const walk: Walk = { input, report, held: new HeldIds(), byId: new Map(cues.map((cue) => [cue.id, cue])), adds: new Map(), early: [], current: input.scene };
  walk.held.Note(input.scene, 0);
  const pending = cues.filter((cue) => !cue.when || cue.at != null);
  for (const cue of pending) if (cue.when) cue.arms = cue.at;
  let waiting = cues.filter((cue) => cue.when && cue.at == null);
  const known = new Set(pending);
  while (pending.length || waiting.length) {
    waiting = waiting.filter((cue) => {
      const arms = deriveArms(cue, walk, known);
      if (arms == null) return true;
      cue.arms = arms;
      pending.push(cue);
      known.add(cue);
      return false;
    });
    if (!pending.length) break;
    const next = pending.reduce((best, cue) => (compareCues(cue, best) < 0 ? cue : best));
    pending.splice(pending.indexOf(next), 1);
    walkCue(next, walk);
  }
  for (const cue of waiting) underivedArms(cue, waiting, walk);
  for (const { cue, reference, scope } of walk.early) earlyArms(cue, reference, scope, walk);
  for (const cue of cues) if (cue.when) checkTrigger(cue, walk);
  return walk.adds;
}

function walkCue(cue: ReadCue, walk: Walk): void {
  const { report } = walk;
  const where = cueWhere(cue);
  const second = checkSecond(cue);
  if (cue.action === 'patch_scene') {
    if (stolenAdds(cue, walk.current, report)) return;
    try {
      const next = walk.input.apply(walk.current, cue.args['operations']).scene;
      const adds = sceneAddsBetween(walk.current, next);
      pinAdds({ cue, adds, report });
      walk.adds.set(cue, adds);
      walk.current = next;
      walk.held.Note(next, second, cue);
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
      const timing = cue.when ? describeCueTiming(cue) : String(cue.at) + ' s';
      report.problems.push(...error.problems.map((problem) => `${where} (${timing}): ${problem}: edit or remove the cue first`));
    }
    return;
  }
  const entry = TIMELINE_ACTIONS[cue.action];
  const scope = toTimelineScope(walk.current);
  let references = entry.references(cue.args);
  if (cue.when && cue.at != null) {
    const missing = references.filter((reference) => checkCueReferences([reference], scope, '').problems.length);
    walk.early.push(...missing.map((reference) => ({ cue, reference, scope })));
    references = references.filter((reference) => !missing.includes(reference));
  }
  const checked = checkCueReferences(references, scope, `${where}.${cue.action}`);
  report.problems.push(...checked.problems);
  report.warnings.push(...checked.warnings);
  if (!checked.problems.length && entry.advise) report.warnings.push(...entry.advise(cue.args, walk.current).map((warning) => `${where}.${cue.action} ${warning}`));
  if (cue.when && cue.at == null) return;
  for (const reference of references) {
    const adder = walk.held.Adder(reference);
    if (adder?.when && adder !== cue) report.warnings.push(`${where}.${cue.action}.${reference.path}: ${REFERENCE_NOUNS[reference.kind]} "${reference.id}" is added by event cue "${adder.id}" (${describeCueTiming(adder)}): it may not exist yet at ${second} s`);
  }
}

/**
 * An event cue with an `at` whose action names an id not held when it arms: a problem, with the arm time that works
 * when a cue adds the id later.
 */
function earlyArms(cue: ReadCue, reference: CueReference, scope: TimelineScope, walk: Walk): void {
  const where = `${cueWhere(cue)}.${cue.action}`;
  const [problem] = checkCueReferences([reference], scope, where).problems;
  const second = walk.held.Second(reference);
  const adder = walk.held.Adder(reference);
  const hint = second != null && adder ? `: give at ${second} or later (cue "${adder.id}" adds it), or leave at out` : '';
  walk.report.problems.push(`${problem} at ${cue.at} s, when the cue arms${hint}`);
}

/**
 * An event cue whose arm time could not be derived: what it names never exists, or it waits on ids an event patch cue
 * that also waits would add.
 */
function underivedArms(cue: ReadCue, waiting: readonly ReadCue[], walk: Walk): void {
  const where = cueWhere(cue);
  cue.arms = 0;
  const missing = actionReferences(cue).filter((reference) => walk.held.Second(reference) == null);
  const patches = waiting.filter((other) => other !== cue && other.action === 'patch_scene');
  if (patches.length && (missing.length || cue.action === 'patch_scene')) {
    const plural = patches.length > 1;
    const names = patches.map((other) => '"' + other.id + '"').join(', ');
    walk.report.problems.push(`${where}: its arm time cannot be derived: it waits on what event patch cue${plural ? 's' : ''} ${names} would add, which wait${plural ? '' : 's'} too: give at`);
    return;
  }
  const checked = checkCueReferences(missing, toTimelineScope(walk.current), `${where}.${cue.action}`);
  walk.report.problems.push(...checked.problems.map((problem) => `${problem} (no cue adds it)`));
}

/**
 * An event cue's filter names ids the scene holds at some point (the event cannot come before its subject exists, so
 * "not yet" is fine), and its `latest` is not before it arms.
 */
function checkTrigger(cue: ReadCue, walk: Walk): void {
  const trigger = cue.when as CueTrigger;
  const where = `${cueWhere(cue)}.when`;
  for (const reference of cueTriggerReferences(trigger).references) {
    if (walk.held.Second(reference) != null) continue;
    const [problem] = checkCueReferences([reference], toTimelineScope(walk.current), where).problems;
    if (problem) walk.report.problems.push(`${problem}, now or added by any cue (${describeCueTrigger(trigger)})`);
  }
  if (trigger.latest != null && cue.arms != null && trigger.latest < cue.arms) walk.report.problems.push(`${where}.latest (${trigger.latest} s) is before the cue arms (${cue.arms} s)`);
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
      report.problems.push(`${nouns[key]} "${id}" is added by timeline cue "${cue.id}" ${describeCueTiming(cue)}: give the new ${nouns[key]} another id, or edit the cue`);
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
    ...(cue.at != null ? { at: cue.at } : {}),
    ...(cue.when ? { when: cue.when, arms: cue.arms ?? cue.at ?? 0 } : {}),
    ...(cue.name ? { name: cue.name } : {}),
    [cue.action]: cue.args,
    ...(pinned && Object.keys(pinned).length ? { adds: pinned } : {})
  } as unknown as SceneCue;
}
