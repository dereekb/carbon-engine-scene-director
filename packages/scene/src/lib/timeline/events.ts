/**
 * Event cues (Movie mode): a cue may wait for an event instead of a time, `when: { <one kind>: <filter>, count?,
 * after?, latest? }`. The page feeds the simulation's events (kills, warp-in arrivals, warps, cues firing, called
 * primaries, ships opening fire) to its player as plain facts (`TimelineEvent`), each on a timeline second; a waiting
 * cue counts the events its trigger matches after it arms and is due `max(1, ceil(after))` seconds after the nth.
 *
 * Pure: the normalizer, the matcher, the resolver over an event log and the texts. Imports nothing from the rest of
 * the folder at run time (timeline.ts imports describeCueTrigger from here).
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';
import type { CueReference } from './actions';
import type { CueState } from './report';

/**
 * The events a cue can wait for.
 *
 * - `kill`: a ship destroyed.
 * - `arrival`: a warp-in group reaching a phase (its first ship out of warp, every ship landed, every ship formed up).
 * - `warp`: a Destiny warp entry or exit.
 * - `cue`: another cue fired (not skipped, not failed).
 * - `primary`: a fleet group's live called primary changed.
 * - `fire`: a ship opened fire (its first shot after FIRE_QUIET_SECONDS without shooting).
 */
export const CUE_EVENT_KINDS = ['kill', 'arrival', 'warp', 'cue', 'primary', 'fire'] as const;

export type CueEventKind = (typeof CUE_EVENT_KINDS)[number];

/**
 * An arrival's phases, in the order a group reaches them; `landed` is the default.
 */
export const ARRIVAL_EVENT_PHASES = ['first', 'landed', 'formed'] as const;

export type ArrivalEventPhase = (typeof ARRIVAL_EVENT_PHASES)[number];

/**
 * A warp's phases; `exit` is the default.
 */
export const WARP_EVENT_PHASES = ['exit', 'enter'] as const;

export type WarpEventPhase = (typeof WARP_EVENT_PHASES)[number];

/**
 * Seconds without a shot after which a ship's next shot is it opening fire.
 */
export const FIRE_QUIET_SECONDS = 10;

/**
 * The most events one timeline run logs.
 */
export const MAX_TIMELINE_EVENTS = 5000;

/**
 * The largest `count` a trigger may wait for.
 */
export const MAX_EVENT_COUNT = 1000;

/**
 * Who an event is about: a ship, by id, team or fleet.
 */
export interface CueEventPartyFilter {
  readonly ship?: string;
  readonly team?: string;
  readonly fleet?: string;
}

export interface KillEventFilter extends CueEventPartyFilter {
  /**
   * Within `fleet`: the victim's wing or squad.
   */
  readonly wing?: string;
  readonly squad?: string;
  /**
   * A fleet id: the victim was a live called primary of that fleet, at any level.
   */
  readonly primary?: string;
  /**
   * The killer.
   */
  readonly by?: CueEventPartyFilter;
}

export interface ArrivalEventFilter {
  readonly fleet?: string;
  /**
   * The group holding this ship.
   */
  readonly ship?: string;
  /**
   * Default `landed`.
   */
  readonly phase?: ArrivalEventPhase;
}

export interface WarpEventFilter extends CueEventPartyFilter {
  /**
   * Default `exit`.
   */
  readonly phase?: WarpEventPhase;
  /**
   * Only a warp-in's landing (true), or only other warps (false).
   */
  readonly arrival?: boolean;
}

export interface PrimaryEventFilter {
  readonly fleet: string;
  /**
   * A wing's or squad's call; without either, the fleet's own.
   */
  readonly wing?: string;
  readonly squad?: string;
  /**
   * The new primary.
   */
  readonly ship?: string;
}

export interface FireEventFilter extends CueEventPartyFilter {
  readonly target?: CueEventPartyFilter;
}

/**
 * An event cue's `when`: exactly one kind with its filter, and the options.
 */
export interface CueTrigger {
  readonly kill?: KillEventFilter;
  readonly arrival?: ArrivalEventFilter;
  readonly warp?: WarpEventFilter;
  /**
   * A cue id: when that cue fires.
   */
  readonly cue?: string;
  readonly primary?: PrimaryEventFilter;
  readonly fire?: FireEventFilter;
  /**
   * The nth matching event after the cue arms (default 1).
   */
  readonly count?: number;
  /**
   * Seconds after the event (default 0); the cue fires on the first tick at or after it, never in the event's own.
   */
  readonly after?: number;
  /**
   * Timeline seconds: the cue fires then if its event has not come.
   */
  readonly latest?: number;
}

/**
 * A ship in an event's facts.
 */
export interface TimelineEventParty {
  readonly ship: string;
  readonly team?: string;
  readonly fleet?: string;
  readonly wing?: string;
  readonly squad?: string;
}

export interface KillTimelineEvent {
  readonly kind: 'kill';
  readonly victim: TimelineEventParty;
  readonly killer?: TimelineEventParty;
  /**
   * The fleets with a group whose called primary the victim was.
   */
  readonly primaryOf?: readonly string[];
}

export interface ArrivalTimelineEvent {
  readonly kind: 'arrival';
  readonly group: string;
  readonly fleet?: string;
  readonly phase: ArrivalEventPhase;
  readonly ships: readonly string[];
}

export interface WarpTimelineEvent {
  readonly kind: 'warp';
  readonly ship: TimelineEventParty;
  readonly phase: WarpEventPhase;
  readonly arrival: boolean;
}

export interface CueTimelineEvent {
  readonly kind: 'cue';
  readonly cue: string;
  readonly state: CueState;
}

export interface PrimaryTimelineEvent {
  readonly kind: 'primary';
  readonly fleet: string;
  /**
   * Set for a wing's or a squad's call.
   */
  readonly wing?: string;
  readonly squad?: string;
  readonly primary?: Maybe<string>;
  readonly previous?: Maybe<string>;
}

export interface FireTimelineEvent {
  readonly kind: 'fire';
  readonly shooter: TimelineEventParty;
  readonly target?: TimelineEventParty;
}

/**
 * One event's facts, as the page hands them to the player.
 */
export type TimelineEvent = KillTimelineEvent | ArrivalTimelineEvent | WarpTimelineEvent | CueTimelineEvent | PrimaryTimelineEvent | FireTimelineEvent;

/**
 * One entry of a timeline run's event log.
 */
export interface TimelineEventEntry {
  /**
   * The timeline second it belongs to.
   */
  readonly second: number;
  readonly event: TimelineEvent;
  readonly text: string;
}

export interface NormalizedCueTrigger {
  readonly trigger: Maybe<CueTrigger>;
  readonly problems: string[];
  readonly warnings: string[];
}

const OPTION_KEYS: ReadonlySet<string> = new Set(['count', 'after', 'latest']);
const PARTY_KEYS = ['ship', 'team', 'fleet'] as const;
const FILTER_KEYS: Readonly<Record<Exclude<CueEventKind, 'cue'>, readonly string[]>> = {
  kill: [...PARTY_KEYS, 'wing', 'squad', 'primary', 'by'],
  arrival: ['fleet', 'ship', 'phase'],
  warp: [...PARTY_KEYS, 'phase', 'arrival'],
  primary: ['fleet', 'wing', 'squad', 'ship'],
  fire: [...PARTY_KEYS, 'target']
};

interface FilterReader {
  readonly value: JsonObject;
  readonly where: string;
  readonly problems: string[];
}

function readId(reader: FilterReader, key: string, out: Record<string, unknown>): void {
  const id = reader.value[key];
  if (id === undefined) return;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) reader.problems.push(`${reader.where}.${key} must be an id (1-64 letters, digits, "_", "-" or ".")`);
  else out[key] = id;
}

function readParty(value: unknown, where: string, problems: string[]): Maybe<CueEventPartyFilter> {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object { ship?, team?, fleet? }`);
    return null;
  }
  for (const key of Object.keys(value)) if (!(PARTY_KEYS as readonly string[]).includes(key)) problems.push(`${where}.${key} is not a filter key (ship, team, fleet)`);
  const out: Record<string, unknown> = {};
  for (const key of PARTY_KEYS) readId({ value, where, problems }, key, out);
  return out;
}

function readPhase<T extends string>(reader: FilterReader, phases: readonly T[], out: Record<string, unknown>): void {
  const phase = reader.value['phase'];
  if (phase === undefined) return;
  if (typeof phase !== 'string' || !phases.includes(phase as T)) reader.problems.push(`${reader.where}.phase must be one of ${phases.join(', ')}`);
  else out['phase'] = phase;
}

function readFilter(kind: Exclude<CueEventKind, 'cue'>, value: unknown, where: string, problems: string[]): Maybe<JsonObject> {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object of filter keys (${FILTER_KEYS[kind].join(', ')}); {} matches any`);
    return null;
  }
  for (const key of Object.keys(value)) if (!FILTER_KEYS[kind].includes(key)) problems.push(`${where}.${key} is not a ${kind} filter key (${FILTER_KEYS[kind].join(', ')})`);
  const reader: FilterReader = { value, where, problems };
  const out: Record<string, unknown> = {};
  for (const key of FILTER_KEYS[kind]) if (key !== 'phase' && key !== 'by' && key !== 'target' && key !== 'arrival') readId(reader, key, out);
  if (kind === 'kill' || kind === 'primary') {
    if (out['wing'] && out['squad']) problems.push(`${where}: give wing or squad, not both`);
    if ((out['wing'] || out['squad']) && !out['fleet']) problems.push(`${where}: a wing or squad needs its fleet`);
  }
  if (kind === 'kill' && value['by'] !== undefined) out['by'] = readParty(value['by'], `${where}.by`, problems);
  if (kind === 'fire' && value['target'] !== undefined) out['target'] = readParty(value['target'], `${where}.target`, problems);
  if (kind === 'arrival') readPhase(reader, ARRIVAL_EVENT_PHASES, out);
  if (kind === 'warp') {
    readPhase(reader, WARP_EVENT_PHASES, out);
    const arrival = value['arrival'];
    if (arrival !== undefined && typeof arrival !== 'boolean') problems.push(`${where}.arrival must be true or false`);
    else if (arrival !== undefined) out['arrival'] = arrival;
  }
  if (kind === 'primary' && !out['fleet'] && value['fleet'] === undefined) problems.push(`${where}.fleet is required: the fleet whose call it waits for`);
  return out as JsonObject;
}

function readNumber(value: unknown, test: (value: number) => boolean): Maybe<number> {
  return typeof value === 'number' && Number.isFinite(value) && test(value) ? value : null;
}

/**
 * Reads a cue's `when`.
 *
 * - Exactly one kind (CUE_EVENT_KINDS) with its filter object (`{}` matches any), or `cue: "<cue id>"`.
 * - Unknown kinds and filter keys, a bad phase, `wing` and `squad` together or without `fleet`, and `primary` without a
 *   fleet are problems.
 * - `count` an integer in [1, MAX_EVENT_COUNT] (1 is omitted), `after` seconds in [0, 86,400] (0 is omitted), `latest`
 *   timeline seconds in [0, 86,400] (checked against the cue's arm time by normalizeSceneTimeline).
 *
 * @param input - The cue's `when`.
 * @param where - Its message prefix: `timeline.cues[2] ("go").when`.
 * @returns The trigger (null with problems), its problems and warnings.
 */
export function normalizeCueTrigger(input: unknown, where: string): NormalizedCueTrigger {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { <${CUE_EVENT_KINDS.join(' | ')}>: <filter>, count?, after?, latest? }`);
    return { trigger: null, problems, warnings };
  }
  const kinds = CUE_EVENT_KINDS.filter((kind) => input[kind] !== undefined);
  for (const key of Object.keys(input)) if (!OPTION_KEYS.has(key) && !(CUE_EVENT_KINDS as readonly string[]).includes(key)) problems.push(`${where}.${key} is not an event kind (${CUE_EVENT_KINDS.join(', ')}) or option (count, after, latest)`);
  if (kinds.length !== 1) problems.push(`${where} needs exactly one event kind (${CUE_EVENT_KINDS.join(', ')})${kinds.length ? ', got ' + kinds.join(', ') : ''}`);
  const trigger: Record<string, unknown> = {};
  const kind = kinds.length === 1 ? kinds[0] : null;
  if (kind === 'cue') {
    const cue = input['cue'];
    if (typeof cue !== 'string' || !ID_PATTERN.test(cue)) problems.push(`${where}.cue must be a cue id`);
    else trigger['cue'] = cue;
  } else if (kind) {
    trigger[kind] = readFilter(kind, input[kind], `${where}.${kind}`, problems);
  }
  const { count, after, latest } = input;
  if (count !== undefined) {
    const value = readNumber(count, (n) => Number.isInteger(n) && n >= 1 && n <= MAX_EVENT_COUNT);
    if (value == null) problems.push(`${where}.count must be a whole number in [1, ${MAX_EVENT_COUNT}]`);
    else if (value > 1) trigger['count'] = value;
  }
  if (after !== undefined) {
    const value = readNumber(after, (n) => n >= 0 && n <= 86_400);
    if (value == null) problems.push(`${where}.after must be seconds in [0, 86400]`);
    else if (value > 0) trigger['after'] = value;
  }
  if (latest !== undefined) {
    const value = readNumber(latest, (n) => n >= 0 && n <= 86_400);
    if (value == null) problems.push(`${where}.latest must be timeline seconds in [0, 86400]`);
    else trigger['latest'] = value;
  }
  return { trigger: problems.length ? null : (trigger as CueTrigger), problems, warnings };
}

/**
 * A trigger's kind.
 *
 * @param trigger - A normalized trigger.
 * @returns Its one event kind.
 */
export function cueTriggerKind(trigger: CueTrigger): CueEventKind {
  return CUE_EVENT_KINDS.find((kind) => trigger[kind] !== undefined) ?? 'kill';
}

export interface CueTriggerReferences {
  /**
   * The ids the filter names (checked against everything the scene ever holds, and pruned with what they name).
   */
  readonly references: CueReference[];
  /**
   * The cue a `cue` trigger waits for.
   */
  readonly cue?: string;
}

function partyReferences(party: Maybe<CueEventPartyFilter>, prefix: string): CueReference[] {
  const references: CueReference[] = [];
  if (party?.ship) references.push({ kind: 'ship', id: party.ship, path: `${prefix}ship` });
  if (party?.team) references.push({ kind: 'team', id: party.team, path: `${prefix}team` });
  if (party?.fleet) references.push({ kind: 'fleet', id: party.fleet, path: `${prefix}fleet` });
  return references;
}

function groupReferences(filter: { readonly fleet?: string; readonly wing?: string; readonly squad?: string }, prefix: string): CueReference[] {
  const references: CueReference[] = [];
  if (filter.fleet && filter.wing) references.push({ kind: 'wing', id: filter.wing, fleet: filter.fleet, path: `${prefix}wing` });
  if (filter.fleet && filter.squad) references.push({ kind: 'squad', id: filter.squad, fleet: filter.fleet, path: `${prefix}squad` });
  return references;
}

/**
 * The ids a trigger's filter names, and the cue a chain waits for.
 *
 * @param trigger - A normalized trigger.
 * @returns Its references (paths under `when.`) and chained cue.
 */
export function cueTriggerReferences(trigger: CueTrigger): CueTriggerReferences {
  const references: CueReference[] = [];
  const { kill, arrival, warp, primary, fire } = trigger;
  if (kill) {
    references.push(...partyReferences(kill, 'kill.'), ...groupReferences(kill, 'kill.'), ...partyReferences(kill.by, 'kill.by.'));
    if (kill.primary) references.push({ kind: 'fleet', id: kill.primary, path: 'kill.primary' });
  }
  if (arrival?.fleet) references.push({ kind: 'fleet', id: arrival.fleet, path: 'arrival.fleet' });
  if (arrival?.ship) references.push({ kind: 'ship', id: arrival.ship, path: 'arrival.ship' });
  if (warp) references.push(...partyReferences(warp, 'warp.'));
  if (primary) {
    references.push({ kind: 'fleet', id: primary.fleet, path: 'primary.fleet' }, ...groupReferences(primary, 'primary.'));
    if (primary.ship) references.push({ kind: 'target', id: primary.ship, path: 'primary.ship' });
  }
  if (fire) references.push(...partyReferences(fire, 'fire.'), ...partyReferences(fire.target, 'fire.target.'));
  return { references, ...(trigger.cue ? { cue: trigger.cue } : {}) };
}

function partyMatches(filter: Maybe<CueEventPartyFilter & { readonly wing?: string; readonly squad?: string }>, party: Maybe<TimelineEventParty>): boolean {
  if (!filter) return true;
  if (!party) return !filter.ship && !filter.team && !filter.fleet;
  return (!filter.ship || filter.ship === party.ship) && (!filter.team || filter.team === party.team) && (!filter.fleet || filter.fleet === party.fleet) && (!filter.wing || filter.wing === party.wing) && (!filter.squad || filter.squad === party.squad);
}

/**
 * Whether an event matches a trigger's kind and filter (not its count, arm time or latest).
 *
 * @param trigger - A normalized trigger.
 * @param event - The event's facts.
 * @returns Whether it counts.
 */
export function cueTriggerMatches(trigger: CueTrigger, event: TimelineEvent): boolean {
  let matches = false;
  if (event.kind === 'kill' && trigger.kill) {
    const { primary, by } = trigger.kill;
    matches = partyMatches(trigger.kill, event.victim) && (!primary || (event.primaryOf ?? []).includes(primary)) && (!by || partyMatches(by, event.killer));
  } else if (event.kind === 'arrival' && trigger.arrival) {
    const { fleet, ship, phase } = trigger.arrival;
    matches = event.phase === (phase ?? 'landed') && (!fleet || fleet === event.fleet) && (!ship || event.ships.includes(ship));
  } else if (event.kind === 'warp' && trigger.warp) {
    const { phase, arrival } = trigger.warp;
    matches = event.phase === (phase ?? 'exit') && (arrival == null || arrival === event.arrival) && partyMatches(trigger.warp, event.ship);
  } else if (event.kind === 'cue' && trigger.cue) {
    matches = event.cue === trigger.cue && event.state === 'fired';
  } else if (event.kind === 'primary' && trigger.primary) {
    const { fleet, wing, squad, ship } = trigger.primary;
    const group = squad ? event.squad === squad : wing ? event.wing === wing && !event.squad : !event.wing && !event.squad;
    matches = event.fleet === fleet && group && (!ship || event.primary === ship);
  } else if (event.kind === 'fire' && trigger.fire) {
    matches = partyMatches(trigger.fire, event.shooter) && (!trigger.fire.target || partyMatches(trigger.fire.target, event.target));
  }
  return matches;
}

/**
 * The timeline second an event cue is due at: the first tick at or after the event plus `after`, never the event's own.
 *
 * @param second - The event's timeline second.
 * @param after - The trigger's after (seconds).
 * @returns second + max(1, ceil(after)).
 */
export function cueEventDueSecond(second: number, after: Maybe<number>): number {
  return second + Math.max(1, Math.ceil(after ?? 0));
}

export interface ResolveCueTriggerInput {
  readonly trigger: CueTrigger;
  /**
   * Timeline seconds: events before it do not count.
   */
  readonly arms: number;
}

export interface ResolvedCueTrigger {
  /**
   * The matching events counted.
   */
  readonly matched: number;
  /**
   * The timeline second the cue is due at: after its nth event, or at its latest; absent while it waits.
   */
  readonly due?: number;
  /**
   * The event that resolved it.
   */
  readonly event?: { readonly second: number; readonly text: string };
  /**
   * Due at its latest: the event had not come.
   */
  readonly late?: true;
}

/**
 * Resolves an event cue against an event log: the nth matching event at or after `arms` (and before the `latest`
 * second, which wins over a later event) makes it due; else `latest`, if any; else it waits.
 *
 * @param input - The trigger and arm time.
 * @param log - The run's event log.
 * @param upTo - The log entries to read (a snapshot's cursor); default all.
 * @returns What it matched and when it is due.
 */
export function resolveCueTrigger(input: ResolveCueTriggerInput, log: readonly TimelineEventEntry[], upTo = log.length): ResolvedCueTrigger {
  const { trigger, arms } = input;
  const latest = trigger.latest == null ? null : Math.ceil(trigger.latest);
  const count = trigger.count ?? 1;
  let matched = 0;
  let resolved: Maybe<ResolvedCueTrigger> = null;
  for (let index = 0; index < Math.min(upTo, log.length) && !resolved; index += 1) {
    const entry = log[index];
    if (entry.second < arms || (latest != null && entry.second >= latest) || !cueTriggerMatches(trigger, entry.event)) continue;
    matched += 1;
    if (matched === count) resolved = { matched, due: cueEventDueSecond(entry.second, trigger.after), event: { second: entry.second, text: entry.text } };
  }
  return resolved ?? (latest == null ? { matched } : { matched, due: latest, late: true });
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

function partyText(party: Maybe<CueEventPartyFilter & { readonly wing?: string; readonly squad?: string }>): Maybe<string> {
  let text: Maybe<string> = null;
  if (party?.ship) text = party.ship;
  else if (party?.squad) text = `a ship of ${party.fleet}'s squad ${party.squad}`;
  else if (party?.wing) text = `a ship of ${party.fleet}'s wing ${party.wing}`;
  else if (party?.fleet) text = `a ship of fleet ${party.fleet}`;
  else if (party?.team) text = `a ship on team ${party.team}`;
  return text;
}

function ownerText(party: Maybe<CueEventPartyFilter>): Maybe<string> {
  let text: Maybe<string> = null;
  if (party?.ship) text = party.ship;
  else if (party?.fleet) text = `fleet ${party.fleet}`;
  else if (party?.team) text = `team ${party.team}`;
  return text;
}

function eventText(trigger: CueTrigger, count: number): string {
  const nth = count > 1 ? ` (the ${ordinal(count)} time)` : '';
  let text = '';
  if (trigger.kill) {
    const { primary, by } = trigger.kill;
    const subject = primary ? `${primary}'s called primary` : partyText(trigger.kill);
    const killer = ownerText(by);
    const of = subject ? ' of ' + subject : '';
    text = subject && count === 1 ? `the kill of ${subject}` : `the ${ordinal(count)} kill${of}`;
    if (killer) text += ` by ${killer}`;
  } else if (trigger.arrival) {
    const { fleet, ship, phase } = trigger.arrival;
    const group = fleet ? `fleet ${fleet}` : ship ? `${ship}'s warp-in group` : 'a warp-in group';
    text = (phase === 'first' ? `${group}'s first landing` : phase === 'formed' ? `${group} formed up` : `${group} landed`) + nth;
  } else if (trigger.warp) {
    const owner = ownerText(trigger.warp);
    const what = `warp ${trigger.warp.phase === 'enter' ? 'entry' : 'exit'}`;
    text = (owner ? `${owner}'s ${what}` : `a ${what}`) + (trigger.warp.arrival === true ? ' (a warp-in landing)' : trigger.warp.arrival === false ? ' (not a warp-in)' : '') + nth;
  } else if (trigger.cue) {
    text = `cue ${trigger.cue} fired`;
  } else if (trigger.primary) {
    const { fleet, wing, squad, ship } = trigger.primary;
    const group = groupText(fleet, wing, squad);
    text = `${group} calling ${ship ?? 'a new primary'}${nth}`;
  } else if (trigger.fire) {
    const owner = ownerText(trigger.fire) ?? 'a ship';
    const target = ownerText(trigger.fire.target);
    const on = target ? ' on ' + target : '';
    text = `${owner} opening fire${on}${nth}`;
  }
  return text;
}

/**
 * A trigger for messages and reports: `the 1st kill`, `the kill of blue's called primary + 2 s`, `fleet red landed`,
 * `red-fc's warp exit`, `cue go fired`, `blue calling red-fc`, `team red opening fire, at 70 s at the latest`.
 *
 * @param trigger - A normalized trigger.
 * @returns The text.
 */
export function describeCueTrigger(trigger: CueTrigger): string {
  const after = trigger.after ? ` + ${trigger.after} s` : '';
  const latest = trigger.latest != null ? `, at ${trigger.latest} s at the latest` : '';
  return `${eventText(trigger, trigger.count ?? 1)}${after}${latest}`;
}

/**
 * An event for the log and reports: `blue-fc destroyed by red-dps-03`, `fleet red landed`, `cue go fired`.
 *
 * @param event - The event's facts.
 * @returns The text.
 */
export function describeTimelineEvent(event: TimelineEvent): string {
  const arrivalTexts: Readonly<Record<ArrivalEventPhase, string>> = { first: 'first landing', landed: 'landed', formed: 'formed up' };
  let text = '';
  if (event.kind === 'kill') text = event.victim.ship + ' destroyed' + (event.killer ? ' by ' + event.killer.ship : '');
  else if (event.kind === 'arrival') text = `${event.fleet ? 'fleet ' + event.fleet : 'group ' + event.group} ${arrivalTexts[event.phase]}`;
  else if (event.kind === 'warp') text = `${event.ship.ship} warp ${event.phase === 'enter' ? 'entry' : 'exit'}${event.arrival ? ' (warp-in)' : ''}`;
  else if (event.kind === 'cue') text = `cue ${event.cue} ${event.state}`;
  else if (event.kind === 'primary') text = `${groupText(event.fleet, event.wing, event.squad)} calling ${event.primary ?? 'nothing'}`;
  else text = event.shooter.ship + ' opened fire' + (event.target ? ' on ' + event.target.ship : '');
  return text;
}

function groupText(fleet: string, wing: Maybe<string>, squad: Maybe<string>): string {
  let text = fleet;
  if (squad) text = `${fleet}'s squad ${squad}`;
  else if (wing) text = `${fleet}'s wing ${wing}`;
  return text;
}
