import type { Maybe } from '@dereekb/util';
import { FLEET_COMPOSITION_SCHEMA, FLEET_PERSONALITY_SCHEMA, SCENE_SCHEMA } from '@scene-director/scene';
import { type NormalizedScenarioInput, SCENARIO_SCHEMA, type Scenario, ScenarioError, isJsonObject, normalizeScenario } from './scenario';

/**
 * One file of a dropped bundle: its path inside the zip or folder (or its name) and its text.
 */
export interface ScenarioBundleFile {
  readonly path: string;
  readonly text: string;
}

/**
 * What a drop holds once classified: a scenario (merged with the bundle's parts), a settings drop, or a lone
 * personality (a fleet card's doctrine).
 */
export type ScenarioBundleKind = 'scenario' | 'settings' | 'personality' | 'empty';

export interface ScenarioBundle {
  readonly kind: ScenarioBundleKind;
  /**
   * The scenario or settings drop, normalized; the scenario's inline parts merged with the bundle's.
   */
  readonly read?: NormalizedScenarioInput;
  /**
   * The bundle's personalities (every kind), for a lone personality drop the one template.
   */
  readonly personalities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * The text file extensions read as EFT fits, keyed by their file stem.
 */
export const SCENARIO_FIT_EXTENSIONS = ['.eft', '.txt'] as const;

type JsonObject = Record<string, unknown>;

interface ClassifiedParts {
  scenarios: { path: string; json: JsonObject }[];
  scenes: { path: string; json: JsonObject }[];
  compositions: Record<string, JsonObject>;
  personalities: Record<string, JsonObject>;
  fits: Record<string, string>;
}

/**
 * Reads a dropped bundle (a zip's files, a folder's, several files or one): classifies each JSON part by its `schema`
 * (cjs-scenario/1, cjs-fleet/1, cjs-fleet-personality/1, cjs-scene/1) and each .eft / .txt as an EFT fit keyed by its
 * file stem, merges the parts into the scenario's inline ones, and reports every unknown, invalid or duplicate part.
 *
 * @param files - The bundle's files.
 * @returns The classified bundle and every problem.
 */
export function readScenarioBundle(files: readonly ScenarioBundleFile[]): ScenarioBundle {
  const problems: string[] = [];
  const warnings: string[] = [];
  const parts: ClassifiedParts = { scenarios: [], scenes: [], compositions: {}, personalities: {}, fits: {} };

  for (const file of files) {
    classifyFile(file, parts, problems, warnings);
  }

  let kind: ScenarioBundleKind = 'empty';
  let read: NormalizedScenarioInput | undefined;

  if (parts.scenarios.length > 1) {
    problems.push(`a drop holds one scenario; found ${parts.scenarios.length} (${parts.scenarios.map((part) => part.path).join(', ')})`);
  } else if (parts.scenarios.length === 1) {
    const merged = mergeParts(parts.scenarios[0].json, parts, problems);

    try {
      read = normalizeScenario(merged);
      kind = read.kind;
      warnings.push(...read.warnings);
    } catch (error) {
      problems.push(...(error instanceof ScenarioError ? error.problems : [String(error)]));
    }
  } else if (Object.keys(parts.personalities).length === 1 && Object.keys(parts.compositions).length === 0 && parts.scenes.length === 0) {
    kind = 'personality';
  } else if (files.length > 0) {
    problems.push(`a drop needs a ${SCENARIO_SCHEMA} file (scenario.json), or one ${FLEET_PERSONALITY_SCHEMA} for a fleet's doctrine`);
  }

  return { kind, read, personalities: parts.personalities, problems, warnings };
}

function classifyFile(file: ScenarioBundleFile, parts: ClassifiedParts, problems: string[], warnings: string[]): void {
  const name = file.path.split('/').pop() ?? file.path;
  const lower = name.toLowerCase();
  const stem = name.replace(/\.[^.]+$/u, '');

  if (name.startsWith('.') || file.path.includes('__MACOSX/')) {
    // a zip's or a folder's hidden files (.DS_Store, macOS resource forks)
  } else if (SCENARIO_FIT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    addUnique(parts.fits, stem, file.text, `fit "${stem}" (${file.path})`, problems);
  } else if (lower.endsWith('.json')) {
    classifyJson(file, stem, parts, problems);
  } else {
    warnings.push(`${file.path} is not a JSON part or an EFT fit and is ignored`);
  }
}

function classifyJson(file: ScenarioBundleFile, stem: string, parts: ClassifiedParts, problems: string[]): void {
  let json: unknown;

  try {
    json = JSON.parse(file.text);
  } catch (error) {
    problems.push(`${file.path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (json === undefined) {
    // reported above
  } else if (!isJsonObject(json)) {
    problems.push(`${file.path} must hold a JSON object`);
  } else {
    const schema = json['schema'];
    const key = typeof json['id'] === 'string' && json['id'] ? json['id'] : stem;

    switch (schema) {
      case SCENARIO_SCHEMA:
        parts.scenarios.push({ path: file.path, json });
        break;
      case SCENE_SCHEMA:
        parts.scenes.push({ path: file.path, json });
        break;
      case FLEET_COMPOSITION_SCHEMA:
        addUnique(parts.compositions, key, json, `composition "${key}" (${file.path})`, problems);
        break;
      case FLEET_PERSONALITY_SCHEMA:
        addUnique(parts.personalities, key, json, `personality "${key}" (${file.path})`, problems);
        break;
      default:
        problems.push(`${file.path}: unknown part (schema ${JSON.stringify(schema ?? null)}; expected ${[SCENARIO_SCHEMA, FLEET_COMPOSITION_SCHEMA, FLEET_PERSONALITY_SCHEMA, SCENE_SCHEMA].join(', ')})`);
    }
  }
}

function mergeParts(scenario: JsonObject, parts: ClassifiedParts, problems: string[]): JsonObject {
  const merged: JsonObject = { ...scenario };
  const mergeMap = (field: 'compositions' | 'personalities' | 'fits', bundle: Record<string, unknown>) => {
    if (Object.keys(bundle).length > 0) {
      const inline = isJsonObject(scenario[field]) ? (scenario[field] as JsonObject) : {};

      for (const key of Object.keys(bundle)) {
        if (key in inline) {
          problems.push(`${field.slice(0, -1)} "${key}" is both inline in the scenario and a part of the bundle`);
        }
      }

      merged[field] = { ...bundle, ...inline };
    }
  };

  mergeMap('compositions', parts.compositions);
  mergeMap('personalities', parts.personalities);
  mergeMap('fits', parts.fits);

  if (parts.scenes.length > 1) {
    problems.push(`a drop holds at most one ${SCENE_SCHEMA} part; found ${parts.scenes.length}`);
  } else if (parts.scenes.length === 1) {
    if (scenario['scene'] == null) {
      merged['scene'] = parts.scenes[0].json;
    } else {
      problems.push(`the scenario has an inline scene and the bundle another (${parts.scenes[0].path})`);
    }
  }

  return merged;
}

function addUnique<T>(map: Record<string, T>, key: string, value: T, what: string, problems: string[]): void {
  if (key in map) {
    problems.push(`duplicate ${what}`);
  } else {
    map[key] = value;
  }
}

/**
 * The scenario a bundle read, if it was a whole scenario.
 *
 * @param bundle - A read bundle.
 * @returns Its scenario, or null.
 */
export function scenarioOfBundle(bundle: ScenarioBundle): Maybe<Scenario> {
  return bundle.read?.kind === 'scenario' ? bundle.read.scenario : null;
}
