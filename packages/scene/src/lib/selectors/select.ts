/**
 * Resolving a ship selector against a document and, when the page supplies them, live facts: the scope, then role,
 * team, hull and state, then the sample, each step counting what it removed. Pure and tolerant of a draft mid-patch,
 * like selectFleetShips. Without facts (a patch op) hull and state are refused, naming the tool that resolves them.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_COMBAT_SEED, MAX_COMBAT_SEED } from '../combat/document';
import { combatUnit } from '../combat/random';
import { selectFleetShips } from '../fleets/selection';
import { DEFENSE_LAYERS, type DefenseLayerName } from '../fitting/defense';
import { isPlainObject, type JsonObject } from '../json';
import { DAMAGED_FRACTION, type ShipSelector, type ShipSelectorSample, type ShipSelectorState } from './selector';

/**
 * A ship's EVE type, as its `/ship-stats` answer names it.
 */
export interface ShipHullFact {
  readonly typeID: number;
  readonly name: string;
  /**
   * The type's ship group ("Frigate", "Logistics Cruiser").
   */
  readonly group?: Maybe<string>;
}

/**
 * A ship's live state.
 */
export interface ShipLiveFact {
  /**
   * Destroyed in either death mode.
   */
  readonly destroyed: boolean;
  /**
   * In warp, or still arriving by warp.
   */
  readonly inWarp: boolean;
  /**
   * Each layer's HP over its max; absent when the damage model does not track the ship.
   */
  readonly fractions?: Maybe<Readonly<Record<DefenseLayerName, number>>>;
}

/**
 * What the page knows that the document does not.
 */
export interface ShipSelectionFacts {
  /**
   * The ship's EVE type; null when it has none, undefined while its answer is pending.
   */
  readonly hullOf: (id: string) => Maybe<ShipHullFact>;
  readonly stateOf: (id: string) => ShipLiveFact;
}

export interface SelectShipsOptions {
  /**
   * Where the selector sits, for messages; default "selection".
   */
  readonly where?: string;
  /**
   * The sample's seed when the selector gives none; default the document's combat seed.
   */
  readonly seed?: number;
  readonly facts?: ShipSelectionFacts;
  /**
   * Without facts: what the caller should use instead, ending the hull and state refusal.
   */
  readonly liveHint?: string;
}

/**
 * The filter steps, in the order they run.
 */
export type ShipSelectionStep = 'role' | 'team' | 'hull' | 'state' | 'sample';

export interface ShipSelectionResult {
  /**
   * The selected ship ids, in the document's ships[] order (empty when there are problems).
   */
  readonly ships: string[];
  /**
   * Malformed or unknown ids: the caller applies nothing.
   */
  readonly problems: string[];
  /**
   * Filter entries that match nothing in the scope, and ships left out while their EVE type loads.
   */
  readonly warnings: string[];
  /**
   * The scope, as a label: `ships`, `fleet "b"`, `fleet "b" squad "logi"`, `all`.
   */
  readonly scope: string;
  /**
   * How many ships the scope held.
   */
  readonly scoped: number;
  /**
   * How many each filter step that ran removed.
   */
  readonly excluded: Partial<Record<ShipSelectionStep, number>>;
  /**
   * Ships the hull filter left out because their EVE type was still loading.
   */
  readonly unresolved: readonly { readonly id: string; readonly why: string }[];
  readonly sample?: { readonly from: number; readonly kept: number; readonly seed: number };
}

/**
 * The selection's report in a lever's result.
 */
export interface ShipSelectionReport {
  readonly scope: string;
  readonly scoped: number;
  readonly matched: number;
  readonly excluded?: Partial<Record<ShipSelectionStep, number>>;
  readonly unresolved?: readonly { readonly id: string; readonly why: string }[];
  readonly sample?: { readonly from: number; readonly kept: number; readonly seed: number };
  readonly warnings?: readonly string[];
}

const PENDING_HULL = 'its EVE type is still loading';

/**
 * The ships a selector picks, in order: the scope (`ships` and `fleet` as selectFleetShips; `all` every ship), then
 * `role`, `team`, `hull`, `state` and `sample`. A ship a filter removed is never looked up by a later one.
 *
 * @param scene - The document (or a draft of it).
 * @param selector - A normalized selector (readShipSelector).
 * @param options - Messages, the sample's default seed and the page's facts.
 * @returns The ships, problems, warnings and what each step did.
 */
export function selectShips(scene: { readonly ships?: unknown; readonly fleets?: unknown; readonly combat?: unknown }, selector: ShipSelector, options: SelectShipsOptions = {}): ShipSelectionResult {
  const where = options.where ?? 'selection';
  const { facts } = options;
  const problems: string[] = [];
  const warnings: string[] = [];
  const excluded: Partial<Record<ShipSelectionStep, number>> = {};
  const unresolved: { id: string; why: string }[] = [];
  const shipObjects = objectsOf(scene.ships).filter((ship) => typeof ship['id'] === 'string');
  const byId = new Map(shipObjects.map((ship) => [ship['id'] as string, ship]));

  const live = (['hull', 'state'] as const).filter((key) => selector[key] != null);
  if (live.length && !facts) problems.push(liveRefusal(where, live, options.liveHint));

  let scoped: string[] = [];
  if (selector.all) scoped = [...byId.keys()];
  else {
    const picked = selectFleetShips(scene, selector, where);
    problems.push(...picked.problems);
    scoped = picked.ships;
  }
  const scope = scopeLabel(selector);
  const scopeText = scopeTextOf(selector, scope);

  const run: SelectionRun = { kept: scoped, excluded };
  const context: FilterContext = { scene, byId, scoped, where, scopeText, warnings };
  if (selector.role) filterRole(run, context, selector.role);
  if (selector.team) filterTeam(run, context, selector.team);
  if (selector.hull && facts) unresolved.push(...filterHull(run, context, { entries: selector.hull, facts }));
  if (selector.state && facts) {
    const states = selector.state;
    filterStep(run, 'state', (id) => {
      const fact = facts.stateOf(id);
      return states.some((state) => stateMatches(fact, state));
    });
  }
  let kept = run.kept;
  let sample: ShipSelectionResult['sample'];
  if (selector.sample) {
    const seed = selector.sample.seed ?? options.seed ?? combatSeedOf(scene.combat);
    const from = kept.length;
    kept = sampleShips(kept, selector.sample, seed);
    excluded.sample = from - kept.length;
    sample = { from, kept: kept.length, seed };
  }

  return { ships: problems.length ? [] : kept, problems, warnings, scope, scoped: scoped.length, excluded, unresolved, ...(sample ? { sample } : {}) };
}

/**
 * A seeded sample of ids: each is ranked by `combatUnit(seed, "select|<id>")` and the lowest k are kept, in the given
 * order. Keyed per ship, so the order the scene lists them in does not matter, a ship added later does not reshuffle
 * the rest, and a smaller sample with the same seed sits inside a larger one.
 *
 * @param ids - The ids to sample.
 * @param sample - A count, or a percent (`round(n × p / 100)`, at least 1 of a non-empty set).
 * @param seed - The seed.
 * @returns The kept ids, in the given order.
 */
export function sampleShips(ids: readonly string[], sample: ShipSelectorSample, seed: number): string[] {
  const n = ids.length;
  let k = n;
  if (sample.count != null) k = Math.min(n, sample.count);
  else if (sample.percent != null && n > 0) k = Math.min(n, Math.max(1, Math.round((n * sample.percent) / 100)));
  const ranked = [...ids].sort((a, b) => combatUnit(seed, `select|${a}`) - combatUnit(seed, `select|${b}`) || (a < b ? -1 : 1));
  const keep = new Set(ranked.slice(0, k));
  return ids.filter((id) => keep.has(id));
}

/**
 * A selection result as a lever reports it: the counts, and only the parts that say something.
 *
 * @param result - The resolved selection.
 * @returns The report.
 */
export function shipSelectionReport(result: ShipSelectionResult): ShipSelectionReport {
  return {
    scope: result.scope,
    scoped: result.scoped,
    matched: result.ships.length,
    ...(Object.keys(result.excluded).length ? { excluded: result.excluded } : {}),
    ...(result.unresolved.length ? { unresolved: result.unresolved } : {}),
    ...(result.sample ? { sample: result.sample } : {}),
    ...(result.warnings.length ? { warnings: result.warnings } : {})
  };
}

/**
 * Whether a ship's live state is one of a selector's states.
 *
 * @param fact - The ship's live state.
 * @param state - The state.
 * @returns True when it matches.
 */
export function stateMatches(fact: ShipLiveFact, state: ShipSelectorState): boolean {
  const alive = !fact.destroyed;
  const fractions = fact.fractions;
  const damaged = fractions != null && DEFENSE_LAYERS.some((layer) => fractions[layer] < DAMAGED_FRACTION);
  let result: boolean;
  switch (state) {
    case 'alive':
      result = alive;
      break;
    case 'destroyed':
      result = !alive;
      break;
    case 'damaged':
      result = alive && damaged;
      break;
    case 'undamaged':
      result = alive && !damaged;
      break;
    case 'in-warp':
      result = alive && fact.inWarp;
      break;
    case 'on-grid':
      result = alive && !fact.inWarp;
      break;
  }
  return result;
}

interface SelectionRun {
  kept: string[];
  readonly excluded: Partial<Record<ShipSelectionStep, number>>;
}

interface FilterContext {
  readonly scene: { readonly fleets?: unknown };
  readonly byId: ReadonlyMap<string, JsonObject>;
  readonly scoped: readonly string[];
  readonly where: string;
  readonly scopeText: string;
  readonly warnings: string[];
}

interface HullFilter {
  readonly entries: readonly (string | number)[];
  readonly facts: ShipSelectionFacts;
}

/**
 * Keeps the ships `keep` passes and counts the rest against the step.
 *
 * @param run - The ships kept so far and the counts.
 * @param step - The step.
 * @param keep - Whether a ship stays.
 */
function filterStep(run: SelectionRun, step: ShipSelectionStep, keep: (id: string) => boolean): void {
  const next = run.kept.filter(keep);
  run.excluded[step] = run.kept.length - next.length;
  run.kept = next;
}

function filterRole(run: SelectionRun, context: FilterContext, roles: readonly string[]): void {
  const roleOf = rolesOf(context.scene.fleets);
  const wanted = new Set<string>(roles);
  filterStep(run, 'role', (id) => wanted.has(roleOf.get(id) ?? ''));
  const held = distinct(context.scoped.map((id) => roleOf.get(id)));
  for (const role of roles) if (!held.includes(role)) context.warnings.push(`${context.where}.role "${role}" matches no ship in ${context.scopeText} (${listThere('roles', held)})`);
}

function filterTeam(run: SelectionRun, context: FilterContext, teams: readonly string[]): void {
  const teamOf = (id: string): Maybe<string> => {
    const team = context.byId.get(id)?.['team'];
    return typeof team === 'string' ? team : undefined;
  };
  const wanted = new Set(teams.map((team) => team.toLowerCase()));
  filterStep(run, 'team', (id) => wanted.has(teamOf(id)?.toLowerCase() ?? '\0'));
  const held = distinct(context.scoped.map(teamOf));
  const heldLower = held.map((team) => team.toLowerCase());
  for (const team of teams) if (!heldLower.includes(team.toLowerCase())) context.warnings.push(`${context.where}.team "${team}" matches no ship in ${context.scopeText} (${listThere('teams', held)})`);
}

/**
 * The hull step: keeps ships of the entries' types or groups, leaves out (and returns) the ones still loading, and
 * warns about entries no ship in the scope matches.
 *
 * @param run - The ships kept so far and the counts.
 * @param context - The scope and where warnings go.
 * @param filter - The entries and the page's facts.
 * @returns The ships left out while their EVE type loads.
 */
function filterHull(run: SelectionRun, context: FilterContext, filter: HullFilter): { id: string; why: string }[] {
  const { entries, facts } = filter;
  const unresolved: { id: string; why: string }[] = [];
  filterStep(run, 'hull', (id) => {
    const hull = facts.hullOf(id);
    if (hull === undefined) unresolved.push({ id, why: PENDING_HULL });
    return hull != null && entries.some((entry) => hullMatches(hull, entry));
  });
  const hulls = context.scoped.map((id) => facts.hullOf(id)).filter((hull): hull is ShipHullFact => hull != null);
  const names = distinct(hulls.map((hull) => hull.name));
  const groups = distinct(hulls.map((hull) => hull.group));
  const groupText = groups.length ? '; groups: ' + groups.join(', ') : '';
  const there = names.length ? `hulls there: ${names.join(', ')}${groupText}` : 'no EVE hulls there';
  for (const entry of entries) if (!hulls.some((hull) => hullMatches(hull, entry))) context.warnings.push(`${context.where}.hull ${JSON.stringify(entry)} matches no ship in ${context.scopeText} (${there})`);
  if (unresolved.length) {
    const ids = unresolved.map((entry) => `"${entry.id}"`).join(', ');
    context.warnings.push(unresolved.length === 1 ? `1 ship was left out: its EVE type is still loading (${ids}); call again once it has loaded` : `${unresolved.length} ships were left out: their EVE types are still loading (${ids}); call again once they have loaded`);
  }
  return unresolved;
}

function hullMatches(hull: ShipHullFact, entry: string | number): boolean {
  let result: boolean;
  if (typeof entry === 'number') result = hull.typeID === entry;
  else if (/^\d+$/u.test(entry)) result = hull.typeID === Number(entry);
  else {
    const text = entry.toLowerCase();
    result = hull.name.toLowerCase() === text || (hull.group ?? '').toLowerCase() === text;
  }
  return result;
}

function liveRefusal(where: string, keys: readonly ('hull' | 'state')[], hint = 'only a live tool resolves them'): string {
  let subject = `${where}.hull and .state read`;
  let what = "each ship's EVE type and state";
  if (keys.length === 1) {
    subject = `${where}.${keys[0]} reads`;
    what = keys[0] === 'hull' ? "each ship's EVE type" : "each ship's state";
  }
  return `${subject} the live scene (${what}): ${hint}`;
}

/**
 * Each squad member's role, from a draft-tolerant walk of the fleets (a ship in two squads keeps its first).
 *
 * @param fleets - The document's fleets (or a draft's).
 * @returns Ship id → role, lower case.
 */
function rolesOf(fleets: unknown): Map<string, string> {
  const roles = new Map<string, string>();
  for (const fleet of objectsOf(fleets)) {
    for (const wing of objectsOf(fleet['wings'])) {
      for (const squad of objectsOf(wing['squads'])) {
        const role = typeof squad['role'] === 'string' ? squad['role'].toLowerCase() : null;
        const members = squad['members'];
        if (role && Array.isArray(members)) for (const member of members) if (typeof member === 'string' && !roles.has(member)) roles.set(member, role);
      }
    }
  }
  return roles;
}

function scopeLabel(selector: ShipSelector): string {
  let label = 'ships';
  if (selector.all) label = 'all';
  else if (selector.fleet != null) {
    const wing = selector.wing == null ? '' : ` wing "${selector.wing}"`;
    const squad = selector.squad == null ? '' : ` squad "${selector.squad}"`;
    label = `fleet "${selector.fleet}"` + wing + squad;
  }
  return label;
}

function scopeTextOf(selector: ShipSelector, label: string): string {
  let text = label;
  if (selector.all) text = 'the scene';
  else if (selector.ships) text = 'the listed ships';
  return text;
}

function listThere(what: string, values: readonly string[]): string {
  return values.length ? `${what} there: ${values.join(', ')}` : `no ${what} there`;
}

function distinct(values: readonly Maybe<string>[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null))];
}

function combatSeedOf(combat: unknown): number {
  const seed = isPlainObject(combat) ? combat['seed'] : undefined;
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_COMBAT_SEED ? seed : DEFAULT_COMBAT_SEED;
}

function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}
