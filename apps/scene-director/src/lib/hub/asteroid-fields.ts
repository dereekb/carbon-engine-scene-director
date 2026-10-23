/**
 * The asteroid field tool, answered by the hub: `add_asteroid_field` adds a seeded field of EVE ore rocks. The hub
 * resolves every ore name first (AsteroidData: the asteroid type, its SOF rock faction and that faction's rock models),
 * a celestial place (an asteroid belt centres the field and lends it its radius), a `{ celestial }` facing and a near
 * ship's radius, then sends one pure `add_asteroid_field` op (after a `remove_asteroid_field` with `replace`) in one
 * patch_scene.
 */

import type { Maybe } from '@dereekb/util';
import { ASTEROID_ROCK_SIZES, type AsteroidRockSize, DEFAULT_FIELD_RADIUS, expandAsteroidField, MAX_FIELD_ORES, type SceneAsteroidField, SceneError } from '@scene-director/scene';
import type { AsteroidDataApi } from './asteroid-data';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import { IsRecord, ScenePlaces, Without } from './scene-places';
import type { ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

export interface AsteroidFieldToolsOptions {
  readonly asteroidData: AsteroidDataApi;
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  readonly page: SavedScenesPage;
}

/**
 * One resolved ore, as add_asteroid_field reports it.
 */
export interface AsteroidOreReport {
  readonly ore?: string;
  readonly type?: number;
  readonly group?: string;
  readonly faction?: string;
  /**
   * How many models each size draws from.
   */
  readonly models: Readonly<Record<AsteroidRockSize, number>>;
  /**
   * `sde`: resolved from an ore name; `faction`: a given SOF faction's rocks; `given`: the rocks as given.
   */
  readonly from: 'sde' | 'faction' | 'given';
  /**
   * The faction's hulls that are not field rocks.
   */
  readonly skipped?: readonly string[];
  readonly notes?: readonly string[];
}

/**
 * One `ores` entry, read.
 */
type OreEntry = { readonly kind: 'name'; readonly name: string; readonly weight: unknown } | { readonly kind: 'faction'; readonly faction: string; readonly name: Maybe<string>; readonly weight: unknown } | { readonly kind: 'given'; readonly rocks: unknown; readonly name: Maybe<string>; readonly weight: unknown };

/**
 * The tool's keys that are not the op's.
 */
const TOOL_ONLY_KEYS = ['scene', 'replace', 'ores', 'at', 'cue'];

export class AsteroidFieldTools {
  private readonly asteroidData: AsteroidDataApi;
  private readonly places: ScenePlaces;

  constructor({ asteroidData, shipData, mapData, page }: AsteroidFieldToolsOptions) {
    this.asteroidData = asteroidData;
    this.places = new ScenePlaces({ shipData, mapData, page });
  }

  /**
   * Runs the asteroid field tool, or returns null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    return name === 'add_asteroid_field' ? this.AddAsteroidField(args) : null;
  }

  async AddAsteroidField(args: ToolArgs): Promise<object> {
    const entries = ReadOreEntries(args['ores']);
    const before = await this.places.Before(Without(args, ['at', 'cue']));
    const resolved = await Promise.all(
      entries.map((entry, index) =>
        this.ResolveOre(entry).then(
          (value) => ({ value }),
          (error: unknown) => ({ error: `ores[${index}]${EntryLabel(entry)}: ${ErrorMessage(error)}` })
        )
      )
    );
    const problems = resolved.flatMap((result) => ('error' in result ? [result.error] : []));
    if (problems.length) throw new SceneError(problems);
    const ores = resolved.flatMap((result) => ('value' in result ? [result.value] : []));

    const operation: Record<string, unknown> = { op: 'add_asteroid_field', ...Without(args, TOOL_ONLY_KEYS), ores: ores.map((ore) => ore.ore) };
    const near = args['near'];
    if (IsRecord(near) && near['celestial'] != null) {
      if (args['position'] != null) throw new ToolError('give position or near, not both');
      const radius = typeof args['radius'] === 'number' ? args['radius'] : null;
      const place = await this.places.ResolvePlace(near, { before: before.scene, leadRadius: radius ?? DEFAULT_FIELD_RADIUS, beltCentred: true });
      const belt = place.celestial?.kind === 'asteroidBelt' ? place.celestial : null;
      delete operation['near'];
      operation['position'] = place.position;
      if (belt && radius == null && belt.radius != null) operation['radius'] = Math.round(belt.radius);
    } else if (IsRecord(near) && typeof near['ship'] === 'string' && near['object'] == null) {
      const { radii } = await this.places.ResolveRadii([near['ship']], before.scene);
      if (Object.keys(radii).length) operation['radii'] = { ...(IsRecord(args['radii']) ? args['radii'] : {}), ...radii };
    }
    if (IsRecord(args['facing'])) operation['facing'] = await this.places.ResolveFacing(args['facing'], before.scene);

    const id = typeof args['id'] === 'string' ? args['id'] : null;
    const replaced = args['replace'] === true && id != null && (before.scene.asteroidFields ?? []).some((field) => field.id === id);
    const operations = replaced ? [{ op: 'remove_asteroid_field', id }, operation] : [operation];
    const names = ores.map((ore) => ore.report.ore ?? ore.report.faction ?? 'rocks');
    const applied = await this.places.Apply(before, operations, { name: `add_asteroid_field ${[...new Set(names)].join(', ')}` });
    const old = new Set((before.scene.asteroidFields ?? []).filter((field) => !(replaced && field.id === id)).map((field) => field.id));
    const added = (applied.scene?.asteroidFields ?? []).find((field) => (id ? field.id === id : !old.has(field.id)));
    return {
      ...(added ? { added: AddedReport(added) } : {}),
      ...(replaced ? { replaced: id } : {}),
      ores: ores.map((ore) => ore.report),
      ...applied.rest,
      warnings: [...ores.flatMap((ore) => (ore.report.notes ?? []).map((note) => `ores: ${note}`)), ...applied.warnings]
    };
  }

  /**
   * One entry's op ore and its report.
   */
  private async ResolveOre(entry: OreEntry): Promise<{ readonly ore: Record<string, unknown>; readonly report: AsteroidOreReport }> {
    const weight = entry.weight == null ? {} : { weight: entry.weight };
    let result: { readonly ore: Record<string, unknown>; readonly report: AsteroidOreReport };
    if (entry.kind === 'name') {
      const ore = await this.asteroidData.Ore(entry.name);
      const set = await this.asteroidData.RockSet(ore.faction);
      result = {
        ore: { ore: ore.name, ...(ore.typeID == null ? {} : { type: ore.typeID }), faction: set.faction, ...weight, rocks: set.rocks },
        report: { ore: ore.name, ...(ore.typeID == null ? {} : { type: ore.typeID }), group: ore.group, faction: set.faction, models: ModelCounts(set.rocks), from: 'sde', ...(set.skipped.length ? { skipped: set.skipped } : {}), ...(set.notes.length ? { notes: set.notes } : {}) }
      };
    } else if (entry.kind === 'faction') {
      const set = await this.asteroidData.RockSet(entry.faction);
      result = {
        ore: { ...(entry.name ? { ore: entry.name } : {}), faction: set.faction, ...weight, rocks: set.rocks },
        report: { ...(entry.name ? { ore: entry.name } : {}), faction: set.faction, models: ModelCounts(set.rocks), from: 'faction', ...(set.skipped.length ? { skipped: set.skipped } : {}), ...(set.notes.length ? { notes: set.notes } : {}) }
      };
    } else {
      result = { ore: { ...(entry.name ? { ore: entry.name } : {}), ...weight, rocks: entry.rocks }, report: { ...(entry.name ? { ore: entry.name } : {}), models: ModelCounts(entry.rocks), from: 'given' } };
    }
    return result;
  }
}

/**
 * Reads `ores`: names, `{ ore, weight? }`, `{ faction, weight?, name? }` or `{ rocks, weight?, name? }`.
 *
 * @param value - The candidate.
 * @returns The entries.
 * @throws {SceneError} Naming each bad entry.
 */
function ReadOreEntries(value: unknown): OreEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIELD_ORES) throw new ToolError(`ores must be a list of 1 to ${MAX_FIELD_ORES} ores: names ("Veldspar"), { ore, weight? }, { faction, weight?, name? } or { rocks, weight?, name? }`);
  const problems: string[] = [];
  const entries = value.flatMap((entry, index): OreEntry[] => {
    let read: Maybe<OreEntry> = null;
    if (typeof entry === 'string' && entry.trim()) read = { kind: 'name', name: entry.trim(), weight: null };
    else if (IsRecord(entry)) {
      const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : null;
      if (entry['rocks'] != null) read = { kind: 'given', rocks: entry['rocks'], name: name ?? (typeof entry['ore'] === 'string' ? entry['ore'] : null), weight: entry['weight'] };
      else if (typeof entry['faction'] === 'string' && entry['faction'].trim()) read = { kind: 'faction', faction: entry['faction'].trim(), name: name ?? (typeof entry['ore'] === 'string' ? entry['ore'] : null), weight: entry['weight'] };
      else if (typeof entry['ore'] === 'string' && entry['ore'].trim()) read = { kind: 'name', name: entry['ore'].trim(), weight: entry['weight'] };
    }
    if (!read) problems.push(`ores[${index}] must be an ore name, { ore, weight? }, { faction, weight?, name? } or { rocks, weight?, name? }`);
    return read ? [read] : [];
  });
  if (problems.length) throw new SceneError(problems);
  return entries;
}

function EntryLabel(entry: OreEntry): string {
  let label = '';
  if (entry.kind === 'name') label = ` ("${entry.name}")`;
  else if (entry.kind === 'faction') label = ` (faction "${entry.faction}")`;
  return label;
}

/**
 * How many models each size of a rock set (or a flat list) draws from.
 */
function ModelCounts(rocks: unknown): Record<AsteroidRockSize, number> {
  const counts: Record<AsteroidRockSize, number> = { small: 0, medium: 0, large: 0 };
  for (const size of ASTEROID_ROCK_SIZES) {
    const list = Array.isArray(rocks) ? rocks : IsRecord(rocks) ? rocks[size] : null;
    counts[size] = Array.isArray(list) ? list.length : 0;
  }
  return counts;
}

/**
 * The tool's `added`: the stored field and its expansion's summary.
 *
 * @param field - The field as stored.
 * @returns The report.
 */
export function AddedReport(field: SceneAsteroidField): object {
  const expansion = expandAsteroidField(field);
  return {
    id: field.id,
    name: field.name,
    position: field.position,
    rotation: field.rotation,
    shape: field.shape,
    radius: field.radius,
    count: field.count,
    placed: expansion.placed,
    envelope: expansion.envelope,
    digest: expansion.digest
  };
}
