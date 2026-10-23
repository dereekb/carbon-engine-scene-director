/**
 * The fleet personality tools (`list_` / `get_` / `save_` / `delete_fleet_personality`, `set_fleet_personality`),
 * answered by the hub. Saved templates are files on disk; the built-ins (FLEET_PERSONALITY_EXAMPLES) are read-only,
 * and a built-in's name cannot be saved over.
 *
 * A scene knows only the built-ins and its own `personalities`, so a saved or inline template a fleet picks is
 * embedded first (Embed): the saved templates its `extends` chain runs through are merged into it, so the scene's copy
 * needs nothing from disk, and it goes in with a `set_personalities` operation in the same patch that gives the fleet
 * its name (set_fleet_personality's update_fleet, or `personality` on add_fleet_composition, stage_engagement sides
 * and add_ships' new fleet). Embedding a saved template refreshes the scene's copy under that key.
 */

import type { Maybe } from '@dereekb/util';
import { BUILT_IN_FLEET_PERSONALITY_NAMES, builtInFleetPersonalities, FLEET_PERSONALITY_SCHEMA, type FleetPersonality, isFleetPersonalityKey, MAX_FLEET_PERSONALITY_CHAIN, normalizeFleetPersonality, resolveFleetPersonality, type ResolvedFleetPersonality, type SceneDocument } from '@scene-director/scene';
import { FleetPersonalityError, type FleetPersonalityFileStore } from '../store/personality-files';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import { IsRecord, ScenePlaces } from './scene-places';
import type { ShipDataApi } from './ship-data';
import { ToolError, type ToolArgs } from './tool-call';

export interface FleetPersonalitiesOptions {
  readonly files: FleetPersonalityFileStore;
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  readonly page: SavedScenesPage;
}

/**
 * Where a fleet's personality came from: a built-in, a saved template, a key the scene already holds, or a template
 * given inline.
 */
export type FleetPersonalitySource = 'built-in' | 'disk' | 'scene' | 'inline';

/**
 * A personality ready for a scene: the name its fleet takes and the templates to embed first.
 */
export interface EmbeddedFleetPersonality {
  /**
   * The name the fleet's `personality` takes: the built-in's, or the key the template sits under in the scene.
   */
  readonly key: string;
  readonly from: FleetPersonalitySource;
  /**
   * The flattened templates by key, for set_personalities; empty for a built-in or a key the scene holds.
   */
  readonly templates: Readonly<Record<string, FleetPersonality>>;
  readonly personality: ResolvedFleetPersonality;
  readonly warnings: string[];
}

export interface EmbedFleetPersonalityContext {
  /**
   * The document the fleet is in, for keys it already holds.
   */
  readonly scene: SceneDocument;
  /**
   * Where the personality was given, for messages.
   */
  readonly where: string;
}

/**
 * A template merged over its base: the head's fields win field by field, section by section, and it extends what its
 * base extended. The head keeps its own id, name and description.
 *
 * @param head - The template.
 * @param base - The template it extends.
 * @returns The merged template.
 */
export function MergeFleetPersonalityOver(head: FleetPersonality, base: FleetPersonality): FleetPersonality {
  const merged: FleetPersonality = { schema: FLEET_PERSONALITY_SCHEMA, id: head.id };
  if (base.extends) merged.extends = base.extends;
  if (head.name) merged.name = head.name;
  if (head.description) merged.description = head.description;
  const command = { ...base.command, ...head.command };
  if (Object.keys(command).length) merged.command = command;
  const pilots = { ...base.pilots, ...head.pilots };
  if (Object.keys(pilots).length) merged.pilots = pilots;
  const engage = head.engage ?? base.engage;
  if (engage) merged.engage = engage;
  const targeting = { ...base.targeting, ...head.targeting };
  if (Object.keys(targeting).length) merged.targeting = targeting;
  const movement = { ...base.movement, ...head.movement };
  if (Object.keys(movement).length) merged.movement = movement;
  return merged;
}

/**
 * The set_personalities operation that embeds personalities' templates, merged into one; none when every one is a
 * built-in or already in the scene.
 *
 * @param embedded - The personalities.
 * @returns Zero or one operation.
 */
export function PersonalityOperations(embedded: readonly Maybe<EmbeddedFleetPersonality>[]): Record<string, unknown>[] {
  const personalities: Record<string, FleetPersonality> = {};
  for (const entry of embedded) Object.assign(personalities, entry?.templates ?? {});
  return Object.keys(personalities).length ? [{ op: 'set_personalities', personalities }] : [];
}

/**
 * How a tool reports the personality it gave a fleet.
 *
 * @param embedded - The personality.
 * @returns Its name, source and chain, and the keys it embedded.
 */
export function EmbeddedReport(embedded: EmbeddedFleetPersonality): object {
  const keys = Object.keys(embedded.templates);
  return { name: embedded.key, from: embedded.from, chain: embedded.personality.chain, ...(keys.length ? { embedded: keys } : {}) };
}

/**
 * The built-in a name means, ignoring case.
 *
 * @param name - A candidate name.
 * @returns The built-in's name, or null.
 */
export function BuiltInPersonalityName(name: unknown): Maybe<string> {
  return typeof name === 'string' ? (BUILT_IN_FLEET_PERSONALITY_NAMES.find((builtIn) => sameName(builtIn, name)) ?? null) : null;
}

function sameName(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

function byId(templates: readonly FleetPersonality[]): Record<string, FleetPersonality> {
  return Object.fromEntries(templates.map((template) => [template.id, template]));
}

/**
 * A personality's listing fields.
 *
 * @param personality - The template as written.
 * @returns Its title, base and description.
 */
function summary(personality: FleetPersonality): object {
  const base = personality.extends ?? (personality.id === BUILT_IN_FLEET_PERSONALITY_NAMES[0] ? null : BUILT_IN_FLEET_PERSONALITY_NAMES[0]);
  return { ...(personality.name ? { title: personality.name } : {}), ...(base ? { extends: base } : {}), ...(personality.description ? { description: personality.description } : {}) };
}

export class FleetPersonalities {
  readonly files: FleetPersonalityFileStore;
  private readonly places: ScenePlaces;

  constructor({ files, shipData, mapData, page }: FleetPersonalitiesOptions) {
    this.files = files;
    this.places = new ScenePlaces({ shipData, mapData, page });
  }

  /**
   * Runs one fleet personality tool, or returns null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'list_fleet_personalities') result = this.List();
    else if (name === 'get_fleet_personality') result = this.Get(args);
    else if (name === 'save_fleet_personality') result = this.Save(args);
    else if (name === 'delete_fleet_personality') result = this.Delete(args);
    else if (name === 'set_fleet_personality') result = this.SetFleetPersonality(args);
    return result;
  }

  async List(): Promise<object> {
    const listing = await this.files.List();
    const personalities: object[] = [];
    const unreadable: { file: string; error: string }[] = [...listing.unreadable];
    for (const entry of listing.personalities) {
      const builtIn = BuiltInPersonalityName(entry.name);
      if (builtIn) {
        unreadable.push({ file: entry.file, error: `"${entry.name}" is the built-in personality "${builtIn}"'s name; built-ins are read-only, so this file is ignored` });
        continue;
      }
      const saved = await this.files.Get(entry.name).catch(() => null);
      personalities.push({ name: entry.name, store: 'disk', ...(saved ? summary(saved.document) : {}), file: entry.file, savedAt: entry.savedAt });
    }
    for (const [name, personality] of builtInFleetPersonalities()) personalities.push({ name, store: 'built-in', ...summary(personality) });
    return { personalities, directory: this.files.directory, ...(unreadable.length ? { unreadable } : {}) };
  }

  async Get(args: ToolArgs): Promise<object> {
    const name = args['name'];
    if (typeof name !== 'string' || !name.trim()) throw new ToolError('name is required: a built-in or saved fleet personality');
    const builtIn = BuiltInPersonalityName(name);
    let result: object;
    if (builtIn) {
      result = { name: builtIn, store: 'built-in', personality: builtInFleetPersonalities().get(builtIn), resolved: resolveFleetPersonality({ name: builtIn }).personality };
    } else {
      const saved = await this.files.Get(name);
      if (!saved) throw this.NotFound(name);
      const bases = await this.SavedBases(saved.document, null);
      const { personality: resolved, problems } = resolveFleetPersonality({ name: saved.document.id, personalities: byId([saved.document, ...bases]) });
      result = { name: saved.name, store: 'disk', file: saved.file, personality: saved.document, resolved, ...(problems.length ? { problems } : {}), ...(saved.warnings.length ? { warnings: saved.warnings } : {}) };
    }
    return result;
  }

  async Save(args: ToolArgs): Promise<object> {
    const input = args['personality'];
    if (!IsRecord(input)) throw new ToolError(`personality is required: a ${FLEET_PERSONALITY_SCHEMA} template`);
    const name = args['name'] ?? input['id'];
    const builtIn = BuiltInPersonalityName(name);
    if (builtIn) throw new ToolError(`"${String(name)}" is the built-in personality "${builtIn}"; built-ins are read-only. Save under another name and extend it ("extends": "${builtIn}")`);
    if (!isFleetPersonalityKey(name)) throw new ToolError(`name (default the template's id) must be 1-64 letters, digits, "_", "-" or ".": a scene embeds the template under it and a fleet picks it by it`);
    const { personality, problems, warnings } = normalizeFleetPersonality({ input: { ...input, id: name }, where: 'personality' });
    if (!personality) throw new FleetPersonalityError(problems);
    const bases = await this.SavedBases(personality, null);
    const resolved = resolveFleetPersonality({ name, personalities: byId([personality, ...bases]) });
    if (!resolved.personality) throw new FleetPersonalityError(resolved.problems);
    const saved = await this.files.Put(name, personality);
    return { saved: saved.name, store: 'disk', file: saved.file, resolved: resolved.personality, ...(warnings.length || saved.warnings.length ? { warnings: [...new Set([...warnings, ...saved.warnings])] } : {}) };
  }

  async Delete(args: ToolArgs): Promise<object> {
    const name = args['name'];
    const builtIn = BuiltInPersonalityName(name);
    let result: object;
    if (builtIn) {
      result = { deleted: false, name, note: `"${builtIn}" is a built-in personality; built-ins are read-only` };
    } else {
      const deleted = await this.files.Delete(name);
      const dependents = deleted ? await this.Dependents(String(name)) : [];
      let note: Maybe<string> = null;
      if (!deleted) note = `no fleet personality "${String(name)}" is saved in ${this.files.directory}`;
      else if (dependents.length) note = `saved personalities extending it no longer resolve until it is saved again: ${dependents.join(', ')}`;
      result = { deleted, name, ...(note ? { note } : {}) };
    }
    return result;
  }

  /**
   * Answers set_fleet_personality: embeds the personality when it is saved or inline, then sets the fleet's
   * (update_fleet), in one patch; null clears it.
   *
   * @param args - The fleet, the personality and the scene.
   * @returns The fleet, the personality it took and the patch result.
   */
  async SetFleetPersonality(args: ToolArgs): Promise<object> {
    const fleet = args['fleet'];
    if (typeof fleet !== 'string' || !fleet) throw new ToolError('fleet is required: the id of a fleet in the scene');
    if (args['personality'] === undefined) throw new ToolError(`personality is required: a built-in or saved name, an inline ${FLEET_PERSONALITY_SCHEMA} template, or null to clear it`);
    const before = await this.places.Before(args);
    if (!(before.scene.fleets ?? []).some((candidate) => candidate.id === fleet)) throw new ToolError(`the scene has no fleet "${fleet}"; get_state fleets lists them`);
    const embedded = args['personality'] === null ? null : await this.Embed(args['personality'], { scene: before.scene, where: 'personality' });
    const operations = [...PersonalityOperations([embedded]), { op: 'update_fleet', fleet, set: { personality: embedded?.key ?? null } }];
    const applied = await this.places.Apply(before, operations);
    return { fleet, personality: embedded ? EmbeddedReport(embedded) : null, ...applied.rest, warnings: [...(embedded?.warnings ?? []), ...applied.warnings] };
  }

  /**
   * Readies a personality for a fleet in a scene: a built-in as is; a saved template (by name, ignoring case) or an
   * inline one flattened over the saved templates its chain runs through; else a key the scene already holds.
   *
   * @param input - A name or an inline template.
   * @param context - The scene and where the personality was given.
   * @returns The name the fleet takes and the templates to embed.
   * @throws {ToolError} When the name is unknown or the input is neither a name nor a template.
   * @throws {FleetPersonalityError} When the template or its chain is invalid.
   */
  async Embed(input: unknown, context: EmbedFleetPersonalityContext): Promise<EmbeddedFleetPersonality> {
    const { scene, where } = context;
    const builtIn = BuiltInPersonalityName(input);
    let head: Maybe<FleetPersonality> = null;
    let from: FleetPersonalitySource;
    let warnings: string[] = [];
    if (builtIn) {
      from = 'built-in';
    } else if (typeof input === 'string' && input.trim()) {
      const saved = await this.files.Get(input).catch((error: unknown) => {
        if (scene.personalities?.[input]) return null;
        throw error;
      });
      if (saved) {
        head = saved.document;
        from = 'disk';
      } else if (scene.personalities?.[input]) {
        from = 'scene';
      } else {
        throw this.NotFound(input, where);
      }
    } else if (IsRecord(input)) {
      const normalized = normalizeFleetPersonality({ input, where });
      if (!normalized.personality) throw new FleetPersonalityError(normalized.problems);
      const named = BuiltInPersonalityName(normalized.personality.id);
      if (named) throw new ToolError(`${where}.id "${normalized.personality.id}" is the built-in personality "${named}"; give the template another id and extend it`);
      head = normalized.personality;
      from = 'inline';
      warnings = normalized.warnings;
    } else {
      throw new ToolError(`${where} must be a personality name (a built-in such as "${BUILT_IN_FLEET_PERSONALITY_NAMES[1]}", or a saved one) or an inline ${FLEET_PERSONALITY_SCHEMA} template`);
    }

    let template: Maybe<FleetPersonality> = null;
    if (head) {
      template = head;
      for (const base of await this.SavedBases(head, scene)) template = MergeFleetPersonalityOver(template, base);
    }
    const key = builtIn ?? template?.id ?? String(input);
    const templates: Record<string, FleetPersonality> = template ? { [key]: template } : {};
    const { personality, problems } = resolveFleetPersonality({ name: key, personalities: { ...scene.personalities, ...templates }, where });
    if (!personality) throw new FleetPersonalityError(problems);
    return { key, from, templates, personality, warnings };
  }

  /**
   * The saved templates a template's `extends` chain runs through, nearest first, up to a built-in or a key the scene
   * holds.
   *
   * @param head - The template.
   * @param scene - The scene whose keys end a chain; null when there is none.
   * @returns The saved bases.
   * @throws {FleetPersonalityError} When the chain loops, runs too long or names an unknown template.
   */
  private async SavedBases(head: FleetPersonality, scene: Maybe<SceneDocument>): Promise<FleetPersonality[]> {
    const bases: FleetPersonality[] = [];
    const seen = [head.id];
    let next: Maybe<string> = head.extends ?? null;
    while (next != null && !BuiltInPersonalityName(next)) {
      const name: string = next;
      if (seen.some((id) => sameName(id, name))) throw new FleetPersonalityError([`"${head.id}": its extends chain loops (${[...seen, name].join(' -> ')})`]);
      if (seen.length >= MAX_FLEET_PERSONALITY_CHAIN) throw new FleetPersonalityError([`"${head.id}": its extends chain is longer than ${MAX_FLEET_PERSONALITY_CHAIN}`]);
      const saved = await this.files.Get(name);
      if (saved) {
        bases.push(saved.document);
        seen.push(saved.document.id);
        next = saved.document.extends ?? null;
      } else if (scene?.personalities?.[name]) {
        next = null;
      } else {
        throw new FleetPersonalityError([`"${seen[seen.length - 1]}" extends "${name}", which is not a built-in personality, a saved one${scene ? " or a key of the scene's personalities" : ''}; save it first`]);
      }
    }
    return bases;
  }

  /**
   * The saved personalities that extend a name.
   *
   * @param name - The name.
   * @returns Their names.
   */
  private async Dependents(name: string): Promise<string[]> {
    const listing = await this.files.List();
    const dependents: string[] = [];
    for (const entry of listing.personalities) {
      const saved = await this.files.Get(entry.name).catch(() => null);
      if (saved?.document.extends && sameName(saved.document.extends, name)) dependents.push(entry.name);
    }
    return dependents;
  }

  private NotFound(name: string, where?: string): ToolError {
    const prefix = where ? where + ': ' : '';
    const scene = where ? " or a key of the scene's personalities" : '';
    return new ToolError(`${prefix}no fleet personality "${name}" is built in, saved in ${this.files.directory}${scene}; list_fleet_personalities shows them`);
  }
}
