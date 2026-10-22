/**
 * The objects tools, answered by the hub: `add_objects` places static EVE objects (stations, gates, Upwell structures,
 * large collidable objects, wrecks) by type name or id, and `search_objects` finds types to place. The hub resolves
 * every name first (types to SOF DNA and SDE radius through ObjectData, celestials of the scene's location to scene
 * points and ship radii through ScenePlaces), then sends one pure `add_objects` op per line in one patch_scene.
 */

import type { Maybe } from '@dereekb/util';
import { type SceneDocument, SceneError } from '@scene-director/scene';
import type { MapDataApi } from './map-data';
import type { ObjectDataApi, ResolvedObjectType } from './object-data';
import type { SavedScenesPage } from './saved-scenes';
import { IsRecord, ScenePlaces, Without } from './scene-places';
import type { ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

export interface ObjectToolsOptions {
  readonly objectData: ObjectDataApi;
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  readonly page: SavedScenesPage;
}

/**
 * One resolved type, as add_objects reports it.
 */
export interface ObjectTypeReport {
  readonly type: number | string;
  readonly typeID: Maybe<number>;
  readonly name: Maybe<string>;
  readonly group: Maybe<string>;
  readonly category: Maybe<string>;
  readonly dna: string;
  readonly radius: Maybe<number>;
  readonly dnaFrom: 'given' | 'sde';
  readonly radiusFrom: 'given' | 'sde' | 'none';
}

/**
 * The fields of one add_objects line, which the tool also takes at the top level for a single line.
 */
const LINE_KEYS = ['type', 'dna', 'radius', 'id', 'name', 'prefix', 'count', 'formation', 'spacing', 'position', 'near', 'heading', 'facing', 'rotation'] as const;

export class ObjectTools {
  private readonly objectData: ObjectDataApi;
  private readonly places: ScenePlaces;

  constructor({ objectData, shipData, mapData, page }: ObjectToolsOptions) {
    this.objectData = objectData;
    this.places = new ScenePlaces({ shipData, mapData, page });
  }

  /**
   * Runs one objects tool, or returns null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'add_objects') result = this.AddObjects(args);
    else if (name === 'search_objects') result = this.SearchObjects(args);
    return result;
  }

  async AddObjects(args: ToolArgs): Promise<object> {
    const before = await this.places.Before(args);
    const lines = ReadLines(args);
    const types = await this.ResolveTypes(lines);
    const reports = new Map<string, ObjectTypeReport>();
    const problems: string[] = [];
    const warnings: string[] = [];
    const operations: Record<string, unknown>[] = [];
    for (const [index, line] of lines.entries()) {
      const at = `objects[${index}]` + (line['type'] == null ? '' : ` (${JSON.stringify(line['type'])})`);
      try {
        operations.push(await this.LineOperation(line, { before: before.scene, types, reports, warnings, at }));
      } catch (error) {
        problems.push(`${at}: ${error instanceof SceneError ? error.problems.join('; ') : ErrorMessage(error)}`);
      }
    }
    if (problems.length) throw new SceneError(problems);

    const applied = await this.places.Apply(before, operations);
    const old = new Set((before.scene.objects ?? []).map((object) => object.id));
    const added = (applied.scene?.objects ?? []).filter((object) => !old.has(object.id));
    return {
      added: added.map((object) => ({ id: object.id, type: object.type, name: object.name, position: object.position, rotation: object.rotation, radius: object.radius })),
      types: [...reports.values()],
      ...applied.rest,
      warnings: [...warnings, ...applied.warnings]
    };
  }

  async SearchObjects(args: ToolArgs): Promise<object> {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (!query) throw new ToolError('query is required: part of an EVE type name');
    const limit = typeof args['limit'] === 'number' ? args['limit'] : null;
    const group = typeof args['group'] === 'string' ? args['group'] : null;
    const placeable = typeof args['placeable'] === 'boolean' ? args['placeable'] : null;
    return this.objectData.Search({ query, group, limit, placeable });
  }

  /**
   * Resolves each distinct `type` once, in parallel.
   *
   * @param lines - The lines.
   * @returns Each type key's resolved type, or the error.
   */
  private async ResolveTypes(lines: readonly Record<string, unknown>[]): Promise<Map<string, { readonly resolved: ResolvedObjectType } | { readonly error: string }>> {
    const keys = new Map<string, number | string>();
    for (const line of lines) {
      const type = line['type'];
      if (typeof type === 'number' || (typeof type === 'string' && type.trim())) keys.set(TypeKey(type), typeof type === 'string' ? type.trim() : type);
    }
    const types = new Map<string, { readonly resolved: ResolvedObjectType } | { readonly error: string }>();
    await Promise.all(
      [...keys].map(async ([key, type]) => {
        types.set(
          key,
          await this.objectData.Type({ type }).then(
            (resolved) => ({ resolved }),
            (error: unknown) => ({ error: ErrorMessage(error) })
          )
        );
      })
    );
    return types;
  }

  /**
   * One line's pure add_objects op: dna and radius filled from its type, a celestial place and facing resolved, and
   * the radius of a near ship filled.
   */
  private async LineOperation(
    line: Record<string, unknown>,
    context: { readonly before: SceneDocument; readonly types: Map<string, { readonly resolved: ResolvedObjectType } | { readonly error: string }>; readonly reports: Map<string, ObjectTypeReport>; readonly warnings: string[]; readonly at: string }
  ): Promise<Record<string, unknown>> {
    const { before, types, reports, warnings, at } = context;
    const operation: Record<string, unknown> = { op: 'add_objects', ...Without(line, ['scene']) };
    const type = line['type'];
    if (type == null && line['dna'] == null) throw new ToolError('a line needs type (an EVE type name or id) or dna');
    if (type != null && typeof type !== 'number' && typeof type !== 'string') throw new ToolError('type must be an EVE type id or name');
    const entry = type == null ? null : types.get(TypeKey(type));
    if (entry && 'error' in entry) throw new ToolError(entry.error);
    const resolved = entry && 'resolved' in entry ? entry.resolved : null;
    if (resolved) {
      if (line['dna'] == null) operation['dna'] = resolved.dna;
      else if (SofHull(String(line['dna'])) !== SofHull(resolved.dna)) warnings.push(`${at}: dna "${String(line['dna'])}" is not ${resolved.name}'s SOF hull (${resolved.dna}); kept as given`);
      if (line['radius'] == null && resolved.radius != null) operation['radius'] = resolved.radius;
      if (typeof type === 'string') operation['type'] = resolved.name;
      else if (line['name'] == null && line['id'] == null && line['prefix'] == null) operation['name'] = resolved.name;
      const key = TypeKey(type as number | string);
      if (!reports.has(key)) reports.set(key, TypeReport({ type: type as number | string, resolved, line }));
    }

    const leadRadius = Number(operation['radius'] ?? 0);
    const near = line['near'];
    if (IsRecord(near) && near['celestial'] != null) {
      if (line['position'] != null) throw new ToolError('give position or near, not both');
      const place = await this.places.ResolvePlace(near, { before, leadRadius });
      delete operation['near'];
      operation['position'] = place.position;
    } else if (IsRecord(near) && typeof near['ship'] === 'string' && near['object'] == null) {
      const { radii, warnings: missing } = await this.places.ResolveRadii([near['ship']], before);
      if (Object.keys(radii).length) operation['radii'] = { ...(IsRecord(line['radii']) ? line['radii'] : {}), ...radii };
      warnings.push(...missing.map((warning) => `${at}: ${warning}`));
    }
    if (IsRecord(line['facing'])) operation['facing'] = await this.places.ResolveFacing(line['facing'], before);
    return operation;
  }
}

/**
 * The lines: `objects`, or one line from the top-level fields.
 *
 * @param args - The tool's arguments.
 * @returns The lines.
 */
function ReadLines(args: ToolArgs): Record<string, unknown>[] {
  let lines: Record<string, unknown>[];
  if (args['objects'] != null) {
    if (!Array.isArray(args['objects']) || !args['objects'].length) throw new ToolError('objects must be a non-empty array of lines { type | dna, count?, position? | near?, ... }');
    lines = args['objects'].map((line, index) => {
      if (!IsRecord(line)) throw new ToolError(`objects[${index}] must be an object { type | dna, ... }`);
      return line;
    });
    const stray = LINE_KEYS.filter((key) => args[key] != null);
    if (stray.length) throw new ToolError(`give the lines in objects, or one line's fields at the top level, not both (top level: ${stray.join(', ')})`);
  } else {
    lines = [Object.fromEntries(LINE_KEYS.filter((key) => args[key] != null).map((key) => [key, args[key]]))];
  }
  return lines;
}

/**
 * A type's report; the first line naming the type decides dnaFrom and radiusFrom.
 *
 * @param input - The type as given, what it resolved to, and the line.
 * @returns The report.
 */
function TypeReport(input: { readonly type: number | string; readonly resolved: ResolvedObjectType; readonly line: Record<string, unknown> }): ObjectTypeReport {
  const { type, resolved, line } = input;
  return {
    type,
    typeID: resolved.typeID,
    name: resolved.name,
    group: resolved.group,
    category: resolved.category,
    dna: line['dna'] == null ? resolved.dna : String(line['dna']),
    radius: typeof line['radius'] === 'number' ? line['radius'] : resolved.radius,
    dnaFrom: line['dna'] == null ? 'sde' : 'given',
    radiusFrom: RadiusFrom(line['radius'], resolved.radius)
  };
}

function RadiusFrom(given: unknown, sde: Maybe<number>): ObjectTypeReport['radiusFrom'] {
  let from: ObjectTypeReport['radiusFrom'] = 'sde';
  if (given != null) from = 'given';
  else if (sde == null) from = 'none';
  return from;
}

function TypeKey(type: number | string): string {
  return typeof type === 'number' ? `id:${type}` : `name:${type.trim().toLowerCase()}`;
}

function SofHull(dna: string): string {
  return dna.split(':')[0].toLowerCase();
}
