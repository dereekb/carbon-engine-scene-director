/**
 * The fleet composition tools (`add_fleet_composition`, `save_` / `list_` / `get_` / `delete_fleet_composition`),
 * answered by the hub. Compositions are saved as files on disk; the built-in examples (FLEET_COMPOSITION_EXAMPLES)
 * are read-only, and a saved composition of the same name shadows one.
 *
 * add_fleet_composition fills each ship line's missing `dna` and `radius` from tools-core's EVE data, resolves `near`
 * (off a ship, object or celestial, on the commander's radius) and `warpIn.from: { celestial }` through ScenePlaces,
 * and the fleet's `personality` (the tool's, else the composition's: a saved or inline template is embedded through
 * FleetPersonalities), then forwards one `add_fleet_composition` patch operation to the viewer (or applies it to a
 * passed `scene` with no tab): the operation itself is pure and looks nothing up. With `at` it resolves against the
 * scene as it will be then and the operation becomes a patch_scene timeline cue (ScenePlaces).
 */

import type { Maybe } from '@dereekb/util';
import {
  countFleetCompositionShips,
  type CompositionShip,
  DEFAULT_FORMATION_RADIUS,
  FLEET_COMPOSITION_EXAMPLES,
  type FleetComposition,
  isPropModModuleKeyword,
  normalizeFleetComposition,
  normalizePropModName,
  type PropModModule,
  readEftHeader,
  readEftPropMod,
  readPropModModule,
  type SceneDocument,
  type SceneFleet,
  toFleetAnchors
} from '@scene-director/scene';
import { FleetCompositionError, type FleetCompositionFileStore } from '../store/composition-files';
import { BuiltInPersonalityName, EmbeddedReport, type FleetPersonalities, PersonalityOperations } from './fleet-personalities';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import { HasWarpInFrom, IsRecord, ScenePlaces } from './scene-places';
import { type ResolvedHull, ShipDataError, type ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

export interface FleetCompositionsOptions {
  readonly files: FleetCompositionFileStore;
  readonly shipData: ShipDataApi;
  /**
   * The map data, for `near` and `warpIn.from` off a celestial of the scene's location.
   */
  readonly mapData: MapDataApi;
  /**
   * Embeds the saved or inline personality a fleet takes.
   */
  readonly personalities: Pick<FleetPersonalities, 'Embed'>;
  readonly page: SavedScenesPage;
}

/**
 * Where one hull's dna and radius came from.
 */
export interface CompositionHullReport {
  readonly hull?: string | number;
  readonly typeID?: number;
  readonly dna: string;
  readonly radius: number;
  readonly dnaFrom: 'composition' | 'sde';
  readonly radiusFrom: 'composition' | 'sde' | 'default';
}

export interface ResolvedCompositionHulls {
  /**
   * A copy of the composition with the dna and radius filled where the EVE data had them.
   */
  readonly composition: FleetComposition;
  readonly hulls: CompositionHullReport[];
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * What add_fleet_composition added.
 */
export interface AddedFleet {
  readonly fleet: string;
  readonly name?: string;
  readonly commander: string;
  readonly ships: string[];
}

interface Example {
  readonly composition: Maybe<FleetComposition>;
  readonly problems: string[];
  readonly index: number;
}

/**
 * Validates a composition.
 *
 * @param input - The candidate.
 * @returns The normalized composition.
 * @throws {FleetCompositionError} With every problem when it cannot be used.
 */
export function requireFleetComposition(input: unknown): FleetComposition {
  const { composition, problems } = normalizeFleetComposition({ input });
  if (!composition) throw new FleetCompositionError(problems);
  return composition;
}

/**
 * How one prop mod a composition names resolved: through the SDE, not at all (an unknown name or id), or unchecked
 * (tools-core could not answer).
 */
export interface CompositionPropModReport {
  readonly module: PropModModule;
  readonly typeID?: number;
  readonly name?: string;
  readonly from: 'sde' | 'unknown' | 'unchecked';
  readonly note?: string;
}

export interface ResolvedCompositionPropMods {
  readonly propMods: CompositionPropModReport[];
  readonly warnings: string[];
}

/**
 * Checks each distinct prop mod a composition's ships will fit (a line's `propMod`, else its fit's module) against
 * the EVE data, in parallel. Keywords ("mwd", "ab", "none") are sized by the page and not checked. An unknown module
 * warns, since those ships fly the hull-sized default; nothing is refused.
 *
 * @param input - The composition and the EVE data.
 * @param input.composition - A normalized composition.
 * @param input.shipData - The EVE data.
 * @returns A report per module and the warnings.
 */
export async function resolveCompositionPropMods(input: { readonly composition: FleetComposition; readonly shipData: ShipDataApi }): Promise<ResolvedCompositionPropMods> {
  const { composition, shipData } = input;
  const modules = new Map<string, PropModModule>();
  for (const ship of [composition.commander, ...composition.wings.flatMap((wing) => wing.squads.flatMap((squad) => squad.ships))]) {
    const fit = ship.fit ? composition.fits?.[ship.fit] : undefined;
    const module = ship.propMod == null ? (fit == null ? null : readEftPropMod(fit)) : readPropModModule(ship.propMod, 'propMod', []);
    const key = module == null || isPropModModuleKeyword(module) ? null : typeof module === 'number' ? `id:${module}` : `name:${normalizePropModName(module)}`;
    if (key && module != null && !modules.has(key)) modules.set(key, module);
  }
  const propMods = await Promise.all(
    [...modules.values()].map(async (module): Promise<CompositionPropModReport> => {
      const lookup = typeof module === 'number' ? shipData.PropMod(module) : shipData.PropModByName(module);
      return lookup.then(
        (propMod) => ({ module, typeID: propMod.typeID, name: propMod.name, from: 'sde' }),
        (error: unknown) => ({ module, from: error instanceof ShipDataError && (error.failure === 'not-found' || error.failure === 'invalid') ? 'unknown' : 'unchecked', note: ErrorMessage(error) })
      );
    })
  );
  const warnings = propMods.filter((report) => report.from === 'unknown').map((report) => `prop mod "${report.module}" is not a propulsion module in the EVE data (${report.note}); those ships fly the hull-sized default`);
  return { propMods, warnings };
}

/**
 * Fills each ship line's missing `dna` and `radius` from the EVE data, one lookup per distinct hull (its `hull`, else
 * its fit's hull, else its `dna`), in parallel. A complete line is not looked up. A failed lookup is a problem for a
 * line without dna and a warning for one missing only its radius (the default radius spaces it).
 *
 * @param input - The composition and the EVE data.
 * @param input.composition - A normalized composition; it is not changed.
 * @param input.shipData - The EVE data.
 * @returns The filled copy, a report per hull, and the problems and warnings.
 */
export async function resolveCompositionHulls(input: { readonly composition: FleetComposition; readonly shipData: ShipDataApi }): Promise<ResolvedCompositionHulls> {
  const composition = structuredClone(input.composition);
  const groups = new Map<string, CompositionShip[]>();
  for (const ship of [composition.commander, ...composition.wings.flatMap((wing) => wing.squads.flatMap((squad) => squad.ships))]) {
    const key = hullKey(ship, composition);
    groups.set(key, [...(groups.get(key) ?? []), ship]);
  }

  const lookups = await Promise.all(
    [...groups].map(async ([key, ships]): Promise<HullGroup> => {
      const first = ships[0];
      const needed = ships.some((ship) => ship.dna == null || ship.radius == null);
      const type = first.hull ?? fitHull(first, composition);
      let lookup: HullGroup['lookup'] = null;
      if (needed)
        lookup = await input.shipData.Hull({ type, dna: first.dna ?? null }).then(
          (hull) => ({ hull }),
          (error: unknown) => ({ failure: ErrorMessage(error) })
        );
      return { key, ships, label: hullLabel(first, composition), lookup };
    })
  );

  const resolved: ResolvedCompositionHulls = { composition, hulls: [], problems: [], warnings: [] };
  for (const group of lookups) fillHullGroup(group, resolved);
  return { ...resolved, warnings: [...new Set(resolved.warnings)] };
}

/**
 * The ship lines of one distinct hull and what looking it up gave.
 */
interface HullGroup {
  readonly key: string;
  readonly ships: CompositionShip[];
  readonly label: string;
  /**
   * Null when every line was complete, so nothing was looked up.
   */
  readonly lookup: Maybe<{ readonly hull: ResolvedHull } | { readonly failure: string }>;
}

function fillHullGroup(group: HullGroup, resolved: ResolvedCompositionHulls): void {
  const { key, ships, label, lookup } = group;
  const hull = lookup && 'hull' in lookup ? lookup.hull : null;
  const dnaMissing = ships.some((ship) => ship.dna == null);
  let failure = lookup && 'failure' in lookup ? lookup.failure : null;
  if (hull && !hull.dna && dnaMissing) failure = `the EVE data has no DNA for type ${hull.typeID}`;

  if (failure && dnaMissing) {
    resolved.problems.push(`hull "${label}" has no dna and could not be resolved from the EVE data: ${failure}`);
    return;
  }
  if (failure) resolved.warnings.push(`hull "${label}" could not be looked up (${failure}); its radius defaults to ${DEFAULT_FORMATION_RADIUS} m`);
  const sdeRadius = hull?.published.radius ?? null;
  let radiusFrom: CompositionHullReport['radiusFrom'] = 'composition';
  if (ships.some((ship) => ship.radius == null)) radiusFrom = sdeRadius == null ? 'default' : 'sde';
  for (const ship of ships) {
    if (hull?.dna && ship.dna && sofHull(ship.dna) !== sofHull(hull.dna)) {
      resolved.warnings.push(`hull "${label}" is ${sofHull(hull.dna)} in the EVE data, but its line's dna is ${ship.dna}; the ship looks like ${sofHull(ship.dna)} and flies as ${label}`);
    }
    ship.dna ??= hull?.dna ?? undefined;
    if (ship.radius == null && sdeRadius != null) ship.radius = sdeRadius;
  }

  let reportedHull: Maybe<string | number> = ships[0].hull ?? null;
  if (reportedHull == null && key.startsWith('fit:')) reportedHull = key.slice('fit:'.length);
  resolved.hulls.push({
    ...(reportedHull == null ? {} : { hull: reportedHull }),
    ...(hull ? { typeID: hull.typeID } : {}),
    dna: ships[0].dna ?? '',
    radius: ships[0].radius ?? DEFAULT_FORMATION_RADIUS,
    dnaFrom: dnaMissing ? 'sde' : 'composition',
    radiusFrom
  });
}

function fitHull(ship: CompositionShip, composition: FleetComposition): Maybe<string> {
  const fit = ship.fit ? composition.fits?.[ship.fit] : undefined;
  return fit ? (readEftHeader(fit)?.hull ?? null) : null;
}

function hullKey(ship: CompositionShip, composition: FleetComposition): string {
  let key: string;
  if (ship.hull != null) key = `hull:${String(ship.hull).toLowerCase()}`;
  else if (fitHull(ship, composition)) key = `fit:${fitHull(ship, composition)}`;
  else key = `dna:${(ship.dna ?? '').toLowerCase()}`;
  return key;
}

function hullLabel(ship: CompositionShip, composition: FleetComposition): string {
  return String(ship.hull ?? fitHull(ship, composition) ?? ship.dna);
}

function sofHull(dna: string): string {
  return dna.split(':')[0].toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

/**
 * The fleet a patch result added: its last fleet.
 *
 * @param scene - The scene after the patch.
 * @returns The fleet, its commander and its ships, or null when the result holds no scene.
 */
function addedFleet(scene: Maybe<Pick<SceneDocument, 'fleets'>>): Maybe<AddedFleet> {
  const fleet: Maybe<SceneFleet> = scene?.fleets?.at(-1) ?? null;
  return fleet ? { fleet: fleet.id, ...(fleet.name ? { name: fleet.name } : {}), commander: fleet.commander, ships: [...toFleetAnchors(fleet).keys()] } : null;
}

export class FleetCompositions {
  readonly files: FleetCompositionFileStore;
  private readonly shipData: ShipDataApi;
  private readonly personalities: Pick<FleetPersonalities, 'Embed'>;
  private readonly places: ScenePlaces;
  private examples: Maybe<Example[]> = null;

  constructor({ files, shipData, mapData, personalities, page }: FleetCompositionsOptions) {
    this.files = files;
    this.shipData = shipData;
    this.personalities = personalities;
    this.places = new ScenePlaces({ shipData, mapData, page });
  }

  /**
   * Runs one fleet composition tool, or returns null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'add_fleet_composition') result = this.add(args);
    else if (name === 'save_fleet_composition') result = this.save(args);
    else if (name === 'list_fleet_compositions') result = this.list();
    else if (name === 'get_fleet_composition') result = this.get(args);
    else if (name === 'delete_fleet_composition') result = this.delete(args);
    return result;
  }

  async add(args: ToolArgs): Promise<object> {
    const composition = await this.load(args);
    if (args['position'] != null && args['near'] != null) throw new ToolError("give position or near, not both: the FC's place");
    if (args['position'] == null && args['near'] == null) throw new ToolError("position or near is required: the FC's [x, y, z] in metres, or near { ship | object | celestial, range?, direction? }");
    const [resolved, propMods] = await Promise.all([resolveCompositionHulls({ composition, shipData: this.shipData }), resolveCompositionPropMods({ composition, shipData: this.shipData })]);
    if (resolved.problems.length) throw new FleetCompositionError(resolved.problems);
    const from = IsRecord(args['warpIn']) ? args['warpIn']['from'] : null;
    const personality = args['personality'] ?? composition.personality ?? null;
    const before = await this.places.Before(args, { read: args['near'] != null || IsRecord(args['facing']) || IsRecord(from) || (personality != null && !BuiltInPersonalityName(personality)) });
    const embedded = personality == null ? null : await this.personalities.Embed(personality, { scene: before.scene, where: 'personality' });
    const operation: Record<string, unknown> = { op: 'add_fleet_composition', composition: resolved.composition };
    for (const key of ['position', 'heading', 'fleet', 'team']) if (args[key] != null) operation[key] = args[key];
    if (embedded) operation['personality'] = embedded.key;
    if (args['facing'] != null) operation['facing'] = await this.places.ResolveFacing(args['facing'], before.scene);
    if (args['near'] != null) {
      const place = await this.places.ResolvePlace(args['near'], { before: before.scene, leadRadius: resolved.composition.commander.radius ?? 0 });
      operation['position'] = place.position;
      if (place.heading != null && args['heading'] == null && args['facing'] == null && !HasWarpInFrom(args['warpIn'])) operation['heading'] = place.heading;
    }
    if (args['warpIn'] != null) operation['warpIn'] = await this.places.ResolveWarpIn(args['warpIn'], before.scene);

    const applied = await this.places.Apply(before, [...PersonalityOperations([embedded]), operation], { name: `add_fleet_composition ${String(args['fleet'] ?? resolved.composition.id)}` });
    return {
      // A cue adds nothing now: its ids are the cue's adds.
      ...(before.cue ? {} : { added: addedFleet(applied.scene) }),
      ...(embedded ? { personality: EmbeddedReport(embedded) } : {}),
      hulls: resolved.hulls,
      propMods: propMods.propMods,
      ...applied.rest,
      warnings: [...resolved.warnings, ...propMods.warnings, ...(embedded?.warnings ?? []), ...applied.warnings]
    };
  }

  async save(args: ToolArgs): Promise<object> {
    if (args['composition'] == null) throw new ToolError('composition is required: a cjs-fleet/1 fleet composition');
    const saved = await this.files.Put((args['name'] as Maybe<unknown>) ?? null, args['composition']);
    const shadowed = this.findExample(saved.name);
    return {
      saved: saved.name,
      store: 'disk',
      file: saved.file,
      ships: saved.ships,
      ...(saved.warnings.length ? { warnings: saved.warnings } : {}),
      ...(shadowed ? { note: `"${saved.name}" shadows the built-in example "${shadowed.name ?? shadowed.id}"; delete it to use the example again` } : {})
    };
  }

  async list(): Promise<object> {
    const listing = await this.files.List();
    const compositions: object[] = [];
    const unreadable: { file: string; error: string }[] = [...listing.unreadable];
    const shadows: string[] = [];
    for (const entry of listing.compositions) {
      const saved = await this.files.Get(entry.name).catch(() => null);
      const composition = saved?.document;
      if (composition) shadows.push(entry.name);
      compositions.push({ name: entry.name, ...(composition ? { id: composition.id, squads: countSquads(composition) } : {}), store: 'disk', ships: entry.ships, file: entry.file, savedAt: entry.savedAt });
    }
    for (const example of this.loadExamples()) {
      const composition = example.composition;
      if (!composition) {
        unreadable.push({ file: `example ${example.index}`, error: example.problems.join('; ') });
        continue;
      }
      const name = composition.name ?? composition.id;
      if (shadows.some((shadow) => sameName(shadow, name) || sameName(shadow, composition.id))) continue;
      compositions.push({ name, id: composition.id, store: 'example', ships: countFleetCompositionShips(composition), squads: countSquads(composition) });
    }
    return { compositions, directory: this.files.directory, ...(unreadable.length ? { unreadable } : {}) };
  }

  async get(args: ToolArgs): Promise<object> {
    const name = args['name'];
    const saved = await this.files.Get(name);
    let result: object;
    if (saved) {
      result = { name: saved.name, store: 'disk', file: saved.file, ships: saved.ships, composition: saved.document, ...(saved.warnings.length ? { warnings: saved.warnings } : {}) };
    } else {
      const example = this.findExample(String(name));
      if (!example) throw this.notFound(String(name));
      result = { name: example.name ?? example.id, store: 'example', ships: countFleetCompositionShips(example), composition: example };
    }
    return result;
  }

  async delete(args: ToolArgs): Promise<object> {
    const name = args['name'];
    const deleted = await this.files.Delete(name);
    const example = this.findExample(String(name));
    let note: Maybe<string> = null;
    if (deleted && example) note = `the built-in example "${example.name ?? example.id}" is listed again`;
    else if (example) note = `"${example.name ?? example.id}" is a built-in example; examples are read-only`;
    else if (!deleted) note = `no fleet composition "${String(name)}" is saved in ${this.files.directory}`;
    return { deleted, name, ...(note ? { note } : {}) };
  }

  /**
   * The composition add_fleet_composition was given: inline, or saved or built in by name.
   *
   * @param args - The tool's arguments.
   * @returns The normalized composition.
   */
  private async load(args: ToolArgs): Promise<FleetComposition> {
    const inline = args['composition'];
    const name = args['name'];
    let composition: FleetComposition;
    if (inline != null && name != null) {
      throw new ToolError('give composition or name, not both');
    } else if (inline != null) {
      composition = requireFleetComposition(inline);
    } else if (name != null) {
      const saved = await this.files.Get(name);
      const found = saved?.document ?? this.findExample(String(name));
      if (!found) throw this.notFound(String(name));
      composition = found;
    } else {
      throw new ToolError('give composition (a cjs-fleet/1 fleet composition) or name (a saved composition or a built-in example such as "tfis"); list_fleet_compositions shows them');
    }
    return composition;
  }

  private notFound(name: string): ToolError {
    return new ToolError(`no fleet composition "${name}" is saved in ${this.files.directory} or built in; list_fleet_compositions shows them`);
  }

  /**
   * A built-in example by name, or by id.
   *
   * @param name - The name.
   * @returns The example, or null.
   */
  private findExample(name: string): Maybe<FleetComposition> {
    const examples = this.loadExamples().flatMap((example) => (example.composition ? [example.composition] : []));
    return examples.find((example) => sameName(example.name ?? example.id, name)) ?? examples.find((example) => sameName(example.id, name)) ?? null;
  }

  private loadExamples(): Example[] {
    this.examples ??= FLEET_COMPOSITION_EXAMPLES.map((input, index) => {
      const { composition, problems } = normalizeFleetComposition({ input });
      return { composition, problems, index };
    });
    return this.examples;
  }
}

function countSquads(composition: FleetComposition): number {
  return composition.wings.reduce((total, wing) => total + wing.squads.length, 0);
}
