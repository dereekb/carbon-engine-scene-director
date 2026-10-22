/**
 * The location tools (`search_map`, `get_system`, `set_location`) and the `/map/system` answer, over tools-core's map
 * routes (MapData). set_location resolves a celestial by name or id, places the scene origin off it
 * (toLocationPlacement) and forwards one `patch_scene` to the viewer (or edits a passed `scene` with no tab): the
 * `set_location` operation itself is pure and looks nothing up.
 *
 * Names: tools-core's map search does not index moons or asteroid belts, and stargates are named after their
 * destination (`Stargate (Perimeter)` sits in five systems), so a name without a system is tried as an exact global
 * name, then as "<celestial> in <system>", then by taking the longest word prefix that is a system name (system names
 * contain spaces: `New Caldari`) and matching the full name in that system's celestial list.
 */

import type { Maybe } from '@dereekb/util';
import { applySceneOperations, CELESTIAL_KINDS, type LocationDirection, MAP_SEARCH_KINDS, type MapCelestial, type MapSystem, type MapSystemAnswer, normalizeScene, normalizeSceneLocation, type SceneDocument, type SceneLocation, type SceneVector, toLocationPlacement, toMapSystemAnswer } from '@scene-director/scene';
import type { MapDataApi, MapSearchItem } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import { ShipDataError } from './ship-data';
import { ToolError, type ToolArgs } from './tool-call';

const SYSTEM_SEARCH_LIMIT = 50;
const DEFAULT_MAP_SEARCH_LIMIT = 20;
const MAX_MAP_SEARCH_LIMIT = 50;
const SUGGESTION_LIMIT = 5;
const CANDIDATE_LIMIT = 10;
const CELESTIAL_SEARCH_KINDS = ['star', 'planet', 'station', 'stargate'];
const STAR_WORDS = new Set(['star', 'sun', 'the star', 'the sun']);
const GATE_TO_PATTERN = /^(?:the )?(?:star)?gate\s*(?:to )?\(?(.+?)\)?$/u;
const GATE_NAMED_PATTERN = /^(?:the )?(.+?) (?:star)?gate$/u;
const IN_SYSTEM_PATTERN = /^(.*\S)\s+in\s+(\S.*)$/iu;
const UNSEARCHABLE_HINT = 'moons and asteroid belts are found through their system: give the full name ("Jita IV - Moon 4") or pass system';

export const MAP_SEARCH_NOTE = 'Moons and asteroid belts are not searchable by name: get_system lists them, and set_location takes their full names.';

export interface LocationsOptions {
  readonly mapData: MapDataApi;
  readonly page: SavedScenesPage;
}

/**
 * Which rule of MatchCelestialName matched.
 */
export type CelestialMatchRule = 'exact' | 'prefixed' | 'star' | 'gate' | 'substring';

export type CelestialMatch = Maybe<{ readonly celestial: MapCelestial; readonly rule: CelestialMatchRule } | { readonly candidates: MapCelestial[] }>;

export interface MatchCelestialNameInput {
  readonly celestials: readonly MapCelestial[];
  readonly text: string;
  readonly systemName: string;
}

interface ResolvedTarget {
  readonly system: MapSystem;
  readonly celestial: MapCelestial;
}

/**
 * A name as the resolver compares it: NFKC, trimmed, single spaces, lower case.
 *
 * @param text - The name.
 * @returns Its comparable form.
 */
export function NormalizeMapName(text: string): string {
  return text.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

/**
 * Which of a system's celestials a name means. The first rule that matches wins: the exact name; the system-prefixed
 * name ("IV - Moon 4" in Jita is "Jita IV - Moon 4", "Star" is "Jita - Star"); a star word ("star", "the sun"); a
 * gate shorthand ("Perimeter gate", "the gate to Perimeter"); a unique substring (after a leading "at" or "the").
 *
 * @param input - The system's celestials and name, and the text.
 * @returns The celestial and the rule, the candidates when a substring matches several, or null.
 */
export function MatchCelestialName(input: MatchCelestialNameInput): CelestialMatch {
  const { celestials } = input;
  const text = NormalizeMapName(input.text);
  const bare = text.replace(/^at /u, '').replace(/^the /u, '');
  const system = NormalizeMapName(input.systemName);
  const named = (name: string) => celestials.find((celestial) => NormalizeMapName(celestial.name) === name);

  let match: CelestialMatch = null;
  const exact = named(text) ?? named(bare);
  const prefixed = [text, bare]
    .flatMap((part) => [`${system} ${part}`, `${system} - ${part}`])
    .map(named)
    .find((celestial) => celestial != null);
  const gate = (GATE_TO_PATTERN.exec(text) ?? GATE_NAMED_PATTERN.exec(text))?.[1];
  const gateName = gate ? `stargate (${gate.trim()})` : null;
  if (exact) match = { celestial: exact, rule: 'exact' };
  else if (prefixed) match = { celestial: prefixed, rule: 'prefixed' };
  else if (STAR_WORDS.has(text) && celestials.some((celestial) => celestial.kind === 'star')) match = { celestial: celestials.find((celestial) => celestial.kind === 'star') as MapCelestial, rule: 'star' };
  else if (gateName && celestials.some((celestial) => celestial.kind === 'stargate' && NormalizeMapName(celestial.name) === gateName)) {
    match = { celestial: celestials.find((celestial) => celestial.kind === 'stargate' && NormalizeMapName(celestial.name) === gateName) as MapCelestial, rule: 'gate' };
  } else if (bare) {
    const found = celestials.filter((celestial) => NormalizeMapName(celestial.name).includes(bare));
    if (found.length === 1) match = { celestial: found[0], rule: 'substring' };
    else if (found.length > 1) match = { candidates: found };
  }
  return match;
}

export class Locations {
  readonly mapData: MapDataApi;
  private readonly page: SavedScenesPage;
  private readonly systemSearches = new Map<string, Promise<MapSearchItem[]>>();

  constructor({ mapData, page }: LocationsOptions) {
    this.mapData = mapData;
    this.page = page;
  }

  /**
   * Runs search_map, get_system or set_location; null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'search_map') result = this.SearchMap(args);
    else if (name === 'get_system') result = this.GetSystem(args);
    else if (name === 'set_location') result = this.SetLocation(args);
    return result;
  }

  async SearchMap(args: ToolArgs): Promise<object> {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (!query) throw new ToolError('query is required: the name, or part of it, to search for');
    const kinds = ReadKinds({ value: args['kinds'], allowed: MAP_SEARCH_KINDS, hint: '; moons and asteroid belts are not searchable: get_system lists them' });
    const limit = Math.min(MAX_MAP_SEARCH_LIMIT, Math.max(1, Math.floor(Number(args['limit'])) || DEFAULT_MAP_SEARCH_LIMIT));
    const [answer, index] = await Promise.all([this.mapData.Search({ query, kinds, limit }), this.mapData.Index()]);
    const items = await Promise.all(
      answer.items.map(async (item) => {
        let described: object = item;
        if (item.kind === 'system') {
          const system = await this.SystemOrNull(item.id);
          described = { kind: item.kind, id: item.id, name: item.name, ...(system?.region ? { region: system.region.name } : {}), ...(system?.securityStatus == null ? {} : { securityStatus: system.securityStatus }) };
        } else if (item.solarSystemID != null) {
          const system = await this.SystemOrNull(item.solarSystemID);
          described = { kind: item.kind, id: item.id, name: item.name, system: { id: item.solarSystemID, ...(system ? { name: system.name } : {}) } };
        }
        return described;
      })
    );
    const note = index.degraded ? `${MAP_SEARCH_NOTE} ${await this.DegradedHint()}` : MAP_SEARCH_NOTE;
    return { query: answer.query, total: answer.total, items, searchable: answer.searchable, note };
  }

  async GetSystem(args: ToolArgs): Promise<object> {
    if (args['system'] == null) throw new ToolError('system is required: a solar system id or exact name');
    const kinds = ReadKinds({ value: args['kinds'], allowed: CELESTIAL_KINDS, hint: '' });
    const system = await this.ResolveSystem(args['system']);
    const [celestials, sdeBuild] = await Promise.all([this.mapData.SystemCelestials(system.id), this.mapData.SdeBuild()]);
    const names = new Map(celestials.map((celestial) => [celestial.id, celestial.name]));
    const counts = Object.fromEntries(CELESTIAL_KINDS.map((kind) => [kind, celestials.filter((celestial) => celestial.kind === kind).length]));
    const star = system.star;
    return {
      system: DescribeSystem(system),
      ...(star ? { star: { id: star.id, name: star.name, spectralClass: star.spectralClass, temperature: star.temperature, radius: star.radius, light: star.light } } : {}),
      nebula: system.nebula,
      counts,
      celestials: celestials
        .filter((celestial) => !kinds || kinds.includes(celestial.kind))
        .map((celestial) => {
          const orbit = celestial.orbit ? names.get(celestial.orbit.id) : null;
          return {
            id: celestial.id,
            kind: celestial.kind,
            name: celestial.name,
            ...(celestial.radius == null ? {} : { radius: celestial.radius }),
            position: celestial.position.map(Math.round),
            ...(orbit ? { orbit } : {}),
            ...(celestial.destination ? { destination: celestial.destination.system } : {})
          };
        }),
      sdeBuild
    };
  }

  async SetLocation(args: ToolArgs): Promise<object> {
    const placed = args['origin'] == null ? await this.LocationFromCelestial(args) : await this.LocationFromOrigin(args);
    const { location, system } = placed;
    const warnings = [...placed.warnings];
    const operations: object[] = [{ op: 'set_location', location }];
    const nebula = args['nebula'] === false ? null : system.nebula;
    if (nebula) operations.push({ op: 'set_environment', environment: { universe: nebula } });
    else if (args['nebula'] !== false) warnings.push(`${system.region?.name ?? system.name} has no nebula in the EVE data; environment.universe is unchanged`);

    const described = {
      location,
      celestial: placed.celestial ? { id: placed.celestial.id, kind: placed.celestial.kind, name: placed.celestial.name, radius: placed.celestial.radius, radiusFrom: placed.celestial.radiusFrom } : null,
      ...(placed.celestial ? { range: placed.range, distance: placed.distance } : {}),
      system: { id: system.id, name: system.name, securityStatus: system.securityStatus, ...(system.region ? { region: system.region.name } : {}) },
      ...(nebula ? { nebula } : {})
    };
    let result: object;
    if (args['scene'] != null) {
      const edited = applySceneOperations(normalizeScene(args['scene']).scene, operations);
      result = { ...described, scene: edited.scene, warnings: [...warnings, ...edited.warnings], loaded: false };
    } else if (this.page.Connected()) {
      const patched = (await this.page.Call('patch_scene', { operations })) as { readonly scene?: SceneDocument; readonly warnings?: string[] };
      result = { ...described, ...patched, warnings: [...warnings, ...(patched.warnings ?? [])] };
    } else {
      throw new ToolError(`${this.page.NotConnected().message} Or pass "scene" to set the location on a document without a tab.`);
    }
    return result;
  }

  /**
   * GET /map/system's answer: the system with its celestials relative to the origin, nearest first.
   *
   * @param input - The system id and the scene origin in system metres.
   * @returns The answer.
   * @throws {ShipDataError} `not-found` for an unknown system, `unavailable` without a prepared SDE.
   */
  async SystemAnswer(input: { readonly system: number; readonly origin: SceneVector }): Promise<MapSystemAnswer> {
    const [system, celestials, sdeBuild] = await Promise.all([this.mapData.System(input.system), this.mapData.SystemCelestials(input.system), this.mapData.SdeBuild()]);
    return toMapSystemAnswer({ system, celestials, origin: input.origin, sdeBuild });
  }

  private async LocationFromOrigin(args: ToolArgs): Promise<{ readonly location: SceneLocation; readonly system: MapSystem; readonly celestial: null; readonly warnings: string[] }> {
    if (['celestial', 'range', 'direction', 'offset'].some((key) => args[key] != null)) throw new ToolError('give origin, or a celestial with range, direction or offset, not both');
    if (args['system'] == null) throw new ToolError('origin needs system: the solar system the origin is in');
    const system = await this.ResolveSystem(args['system']);
    const location = RequireLocation({ system: system.id, name: system.name, region: system.region?.name, origin: args['origin'] });
    return { location, system, celestial: null, warnings: [] };
  }

  private async LocationFromCelestial(args: ToolArgs): Promise<{ readonly location: SceneLocation; readonly system: MapSystem; readonly celestial: MapCelestial; readonly range: number; readonly distance: number; readonly warnings: string[] }> {
    const { system, celestial } = await this.ResolveTarget(args);
    const placement = toLocationPlacement({
      kind: celestial.kind,
      position: celestial.position,
      radius: celestial.radius,
      range: args['range'] as Maybe<number>,
      direction: args['direction'] as Maybe<LocationDirection>,
      offset: args['offset'] as Maybe<SceneVector>,
      name: celestial.name
    });
    if (!placement.origin || !placement.offset) {
      const message = `cannot place the scene origin off ${celestial.name}: ${placement.problems.join('; ')}`;
      throw new ToolError(message, { message, problems: placement.problems });
    }
    const location = RequireLocation({ system: system.id, name: system.name, region: system.region?.name, origin: placement.origin, anchor: { celestial: celestial.id, name: celestial.name, kind: celestial.kind, offset: placement.offset } });
    return { location, system, celestial, range: placement.range, distance: placement.distance, warnings: placement.warnings };
  }

  /**
   * The system and celestial set_location's arguments name.
   */
  private async ResolveTarget(args: ToolArgs): Promise<ResolvedTarget> {
    const celestialArg = args['celestial'];
    const systemArg = args['system'];
    const celestialId = ReadIdArg(celestialArg);
    let target: ResolvedTarget;
    if (celestialId != null) {
      target = await this.TargetById(celestialId, systemArg);
    } else if (typeof celestialArg === 'string' && celestialArg.trim() && systemArg != null) {
      target = await this.TargetInSystem(celestialArg, await this.ResolveSystem(systemArg));
    } else if (typeof celestialArg === 'string' && celestialArg.trim()) {
      target = await this.TargetByName(celestialArg.trim());
    } else if (celestialArg != null) {
      throw new ToolError('celestial must be a celestial id or name');
    } else if (systemArg == null) {
      throw new ToolError('give celestial (a name or id) and/or system, or origin with system');
    } else {
      const system = await this.ResolveSystem(systemArg);
      const celestials = await this.mapData.SystemCelestials(system.id);
      const examples = [...celestials.filter((celestial) => celestial.kind === 'station').slice(0, 3), ...celestials.filter((celestial) => celestial.kind === 'stargate').slice(0, 2)].map((celestial) => `"${celestial.name}"`);
      throw new ToolError(`name a celestial in ${system.name} (a station, stargate, planet, moon, asteroid belt or "star"), or give origin; for example: ${examples.join(', ') || '"star"'}; get_system lists them all`);
    }
    return target;
  }

  private async TargetById(id: number, systemArg: unknown): Promise<ResolvedTarget> {
    const found = await this.mapData.Celestial(id).catch((error: unknown) => {
      throw IsNotFound(error) ? new ToolError(`no celestial ${id}`) : error;
    });
    const [system, celestials] = await Promise.all([this.mapData.System(found.solarSystemID), this.mapData.SystemCelestials(found.solarSystemID)]);
    if (systemArg != null) {
      const named = await this.ResolveSystem(systemArg);
      if (named.id !== system.id) throw new ToolError(`${found.name} (${id}) is in ${system.name}, not ${named.name}`);
    }
    // The system list's copy, so the name and radius come from the same path the page fetches.
    return { system, celestial: celestials.find((celestial) => celestial.id === id) ?? found };
  }

  private async TargetInSystem(text: string, system: MapSystem): Promise<ResolvedTarget> {
    const celestials = await this.mapData.SystemCelestials(system.id);
    const match = MatchCelestialName({ celestials, text, systemName: system.name });
    if (match && 'candidates' in match) {
      const names = match.candidates.slice(0, CANDIDATE_LIMIT).map((celestial) => celestial.name);
      throw new ToolError(`"${text}" matches ${match.candidates.length} celestials in ${system.name}: ${names.join(', ')}; use the full name or the id`);
    }
    if (!match) throw new ToolError(`no celestial in ${system.name} matches "${text}"; get_system lists them`);
    return { system, celestial: match.celestial };
  }

  /**
   * A celestial named without a system: an exact global name, "<celestial> in <system>", or a name whose leading
   * words are a system name (moons and belts, which the map search does not index).
   */
  private async TargetByName(text: string): Promise<ResolvedTarget> {
    const wanted = NormalizeMapName(text);
    const search = await this.mapData.Search({ query: text, kinds: CELESTIAL_SEARCH_KINDS, limit: SYSTEM_SEARCH_LIMIT });
    const exact = search.items.filter((item) => item.solarSystemID != null && NormalizeMapName(item.name) === wanted);
    const systems = [...new Set(exact.map((item) => item.solarSystemID as number))];
    if (systems.length === 1) {
      const system = await this.mapData.System(systems[0]);
      const celestials = await this.mapData.SystemCelestials(system.id);
      const celestial = celestials.find((candidate) => candidate.id === exact[0].id);
      if (celestial) return { system, celestial };
    } else if (systems.length > 1) {
      const names = await Promise.all(systems.slice(0, CANDIDATE_LIMIT).map(async (id) => (await this.SystemOrNull(id))?.name ?? String(id)));
      throw new ToolError(`"${text}" is in ${systems.length} systems (${names.join(', ')}); pass system`);
    }

    const phrase = IN_SYSTEM_PATTERN.exec(text.replaceAll(/\s+/gu, ' '));
    const phraseSystem = phrase ? await this.ResolveSystemExact(phrase[2]) : null;
    if (phrase && phraseSystem) return this.TargetInSystem(phrase[1], phraseSystem);

    const words = text.replaceAll(/\s+/gu, ' ').split(' ');
    for (let count = words.length - 1; count >= 1; count -= 1) {
      if (words[count - 1] === '-') continue;
      const system = await this.ResolveSystemExact(words.slice(0, count).join(' '));
      if (!system) continue;
      const match = MatchCelestialName({ celestials: await this.mapData.SystemCelestials(system.id), text, systemName: system.name });
      if (match && 'rule' in match && (match.rule === 'exact' || match.rule === 'prefixed')) return { system, celestial: match.celestial };
      break;
    }

    const [suggested, index] = await Promise.all([this.mapData.Search({ query: text, limit: SUGGESTION_LIMIT }).catch(() => null), this.mapData.Index()]);
    const suggestions = await Promise.all(
      (suggested?.items ?? []).map(async (item) => {
        const system = item.solarSystemID == null ? null : await this.SystemOrNull(item.solarSystemID);
        return system ? `${item.name} (${system.name})` : item.name;
      })
    );
    const parts = [`no celestial named "${text}"`, ...(suggestions.length ? [`did you mean ${suggestions.join(', ')}?`] : []), UNSEARCHABLE_HINT, ...(index.degraded ? [await this.DegradedHint()] : [])];
    throw new ToolError(parts.join('; '));
  }

  /**
   * A system by id or exact name.
   */
  private async ResolveSystem(value: unknown): Promise<MapSystem> {
    const id = ReadIdArg(value);
    let system: MapSystem;
    if (id != null) {
      system = await this.mapData.System(id).catch((error: unknown) => {
        throw IsNotFound(error) ? new ToolError(`no solar system ${id}`) : error;
      });
    } else if (typeof value === 'string' && value.trim()) {
      const found = await this.ResolveSystemExact(value);
      if (!found) {
        const hits = (await this.SystemSearch(value)).slice(0, SUGGESTION_LIMIT).map((item) => item.name);
        const suggestion = hits.length ? `; did you mean ${hits.join(', ')}?` : '';
        throw new ToolError(`no solar system named "${value.trim()}"${suggestion}`);
      }
      system = found;
    } else {
      throw new ToolError('system must be a solar system id or name');
    }
    return system;
  }

  /**
   * The system with exactly this name (normalized), or null.
   */
  private async ResolveSystemExact(text: string): Promise<Maybe<MapSystem>> {
    const wanted = NormalizeMapName(text);
    const item = (await this.SystemSearch(text)).find((candidate) => NormalizeMapName(candidate.name) === wanted);
    return item ? this.mapData.System(item.id) : null;
  }

  /**
   * The map's system search for a text, cached by its normalized form (a failed search is retried).
   */
  private async SystemSearch(text: string): Promise<MapSearchItem[]> {
    const key = NormalizeMapName(text);
    let entry = this.systemSearches.get(key);
    if (!entry) {
      entry = this.mapData.Search({ query: text.trim(), kinds: ['system'], limit: SYSTEM_SEARCH_LIMIT }).then((answer) => answer.items.filter((item) => item.kind === 'system'));
      this.systemSearches.set(key, entry);
      entry.catch(() => this.systemSearches.delete(key));
    }
    return entry;
  }

  private async SystemOrNull(id: number): Promise<Maybe<MapSystem>> {
    return this.mapData.System(id).catch(() => null);
  }

  private async DegradedHint(): Promise<string> {
    const build = await this.mapData.SdeBuild().catch(() => '<build>');
    return `tools-core's map index is degraded (no mapIndex derivation), so moons, planets and stations may be missing or misnamed; in the tools-core checkout run: node bin/cjs-sde-prepare.js --build ${build} --refresh (Node 22)`;
  }
}

function DescribeSystem(system: MapSystem): object {
  return {
    id: system.id,
    name: system.name,
    securityStatus: system.securityStatus,
    securityClass: system.securityClass,
    ...(system.constellation ? { constellation: system.constellation.name } : {}),
    ...(system.region ? { region: system.region.name } : {})
  };
}

/**
 * A location through the document validator, so the hub writes exactly what a document holds.
 */
function RequireLocation(input: Record<string, unknown>): SceneLocation {
  const { location, problems } = normalizeSceneLocation({ input });
  if (!location) {
    const message = `invalid location: ${problems.join('; ')}`;
    throw new ToolError(message, { message, problems });
  }
  return location;
}

/**
 * An EVE id argument: a positive integer, or its decimal string.
 */
function ReadIdArg(value: unknown): Maybe<number> {
  const id = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function ReadKinds<T extends string>(config: { readonly value: unknown; readonly allowed: readonly T[]; readonly hint: string }): Maybe<T[]> {
  const { value, allowed, hint } = config;
  let kinds: Maybe<T[]> = null;
  if (value != null) {
    const list = Array.isArray(value) ? value : [value];
    if (!list.every((kind) => typeof kind === 'string' && (allowed as readonly string[]).includes(kind))) throw new ToolError(`kinds must be among ${allowed.join(', ')}${hint}`);
    kinds = list as T[];
  }
  return kinds?.length ? kinds : null;
}

function IsNotFound(error: unknown): boolean {
  return error instanceof ShipDataError && error.failure === 'not-found';
}
