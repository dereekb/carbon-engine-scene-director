import { type SceneDocument, applySceneOperations, createEmptyScene, normalizeScene, sceneAtTimelineTime } from '@scene-director/scene';
import type { Maybe } from '@dereekb/util';
import type { Scenario, ScenarioSide } from './scenario';
import { fleetDoctrineKey, toFleetDoctrineTemplate, toFleetSettingsOperations } from './settings';

/**
 * The id of the t = 0 cue a warp-in scenario's staging lands as (stage_engagement with `at: 0`): its patch carries
 * the arrivals, and the settings ops are appended to it, since the fleets exist only once it fires.
 */
export const SCENARIO_STAGE_CUE = 'scenario-stage';

/**
 * One hub tool call of the staging pipeline; the runner adds the scene being built as `scene`.
 */
export interface ScenarioStagingStep {
  readonly tool: 'set_location' | 'stage_engagement';
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * What staging a scenario takes: the pure start document, the hub calls on it, and what finishes it.
 */
export interface ScenarioStagingPlan {
  readonly scenario: Scenario;
  /**
   * The document the hub calls build on: an empty scene renamed with the scenario's combat, or its pre-staged scene.
   */
  readonly base: SceneDocument;
  readonly steps: readonly ScenarioStagingStep[];
  /**
   * Whether a side warps in: the staging is the t = 0 cue SCENARIO_STAGE_CUE.
   */
  readonly warpIn: boolean;
}

/**
 * A staged scenario, ready for load_scene.
 */
export interface StagedScenario {
  readonly scene: SceneDocument;
  /**
   * load_scene's arguments besides the scene: `timeline: "pause"` when the scenario starts paused.
   */
  readonly load: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

/**
 * Calls a hub tool (ViewerApi.CallHub in the console, a fake in specs).
 */
export type ScenarioHubCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Plans staging a scenario (pure): the base document (createEmptyScene, rename, set_combat, the scenario's
 * personalities; or the pre-staged scene with them),
 * then set_location and stage_engagement on it (each side carrying its composition inline with the bundle's fits, and
 * its doctrine as the inline template `<fleet>-fc`), at t = 0 when a side warps in.
 *
 * @param scenario - A normalized scenario.
 * @returns The plan.
 */
export function planScenarioStaging(scenario: Scenario): ScenarioStagingPlan {
  let plan: ScenarioStagingPlan;

  // the scenario's personalities go into the document, so a doctrine extending one of them resolves on the hub
  const personalities = scenario.personalities && Object.keys(scenario.personalities).length > 0 ? [{ op: 'set_personalities', personalities: scenario.personalities }] : [];

  if (scenario.scene) {
    const scene = normalizeScene(scenario.scene).scene;
    plan = { scenario, base: personalities.length > 0 ? applySceneOperations(scene, personalities).scene : scene, steps: [], warpIn: false };
  } else {
    const warpIn = scenario.sides.some((side) => Boolean(side.warpIn));
    const operations = [...(scenario.combat ? [{ op: 'set_combat', ...scenario.combat }] : []), ...personalities];
    const base = operations.length > 0 ? applySceneOperations(createEmptyScene(scenario.name ?? scenario.id), operations).scene : createEmptyScene(scenario.name ?? scenario.id);
    const steps: ScenarioStagingStep[] = [];

    if (scenario.location) {
      steps.push({ tool: 'set_location', args: { place: scenario.location } });
    }

    const engagement: Record<string, unknown> = { sides: scenario.sides.map((side) => toStagingSide(scenario, side)) };

    for (const key of ['range', 'heading', 'center', 'near'] as const) {
      if (scenario[key] != null) {
        engagement[key] = scenario[key];
      }
    }

    if (warpIn) {
      engagement['at'] = 0;
      engagement['cue'] = SCENARIO_STAGE_CUE;
    }

    steps.push({ tool: 'stage_engagement', args: engagement });
    plan = { scenario, base, steps, warpIn };
  }

  return plan;
}

/**
 * One side as stage_engagement takes it: its composition inline (a bundle composition, with the scenario's fits
 * merged under its own) or by name for the hub to resolve, ship lines with fit keys replaced by their EFT text, and its
 * doctrine as the inline template `<fleet>-fc`.
 *
 * @param scenario - The scenario (for its compositions and fits).
 * @param side - The side.
 * @returns stage_engagement's side.
 */
export function toStagingSide(scenario: Scenario, side: ScenarioSide): Record<string, unknown> {
  const fits = scenario.fits ?? {};
  const staged: Record<string, unknown> = { fleet: side.fleet, personality: toFleetDoctrineTemplate(side.fleet, side.settings?.personality) };

  if (typeof side.composition === 'string') {
    const inline = scenario.compositions?.[side.composition];
    staged['composition'] = inline ? withFits(inline, fits) : side.composition;
  } else if (side.composition) {
    staged['composition'] = withFits(side.composition, fits);
  }

  if (side.ships) {
    staged['ships'] = side.ships.map((line) => (typeof line['fit'] === 'string' && fits[line['fit']] ? { ...line, fit: fits[line['fit']] } : line));
  }

  for (const key of ['team', 'name', 'formation', 'spacing', 'prefix', 'warpIn'] as const) {
    if (side[key] != null) {
      staged[key] = side[key];
    }
  }

  return staged;
}

function withFits(composition: Readonly<Record<string, unknown>>, fits: Readonly<Record<string, string>>): Record<string, unknown> {
  const own = (composition['fits'] ?? {}) as Record<string, string>;
  return Object.keys(fits).length > 0 ? { ...composition, fits: { ...fits, ...own } } : { ...composition };
}

/**
 * The cues a scenario adds besides its staging: each `start: "hold"` side's hold stance plus cease_fire (on landing for
 * a warp-in side, else at t = 0), a t = 0 auto_camera for `camera.auto`, then the scenario's extra cues.
 *
 * @param scenario - The scenario.
 * @returns The cues, for add_cue.
 */
export function toScenarioCues(scenario: Scenario): Record<string, unknown>[] {
  const cues: Record<string, unknown>[] = [];

  for (const side of scenario.sides) {
    if (side.start === 'hold') {
      const timing = side.warpIn && !scenario.scene ? { when: { arrival: { fleet: side.fleet, phase: 'landed' } } } : { at: 0 };
      cues.push({ id: `${side.fleet}-hold`, ...timing, name: `${side.fleet} holds for Engage`, order_fleet: { fleet: side.fleet, order: { type: 'stance', set: { type: 'hold' } } } }, { id: `${side.fleet}-hold-fire`, ...timing, name: `${side.fleet} holds fire for Engage`, cease_fire: { fleet: side.fleet } });
    }
  }

  const auto = scenario.camera?.auto;

  if (auto) {
    cues.push({ id: 'scenario-camera', at: 0, name: 'director camera', auto_camera: auto === true ? {} : auto });
  }

  cues.push(...(scenario.timeline ?? []).map((cue) => ({ ...cue })));
  return cues;
}

/**
 * Finishes a staged document (pure): the settings ops (appended to the t = 0 staging cue when a side warps in, since
 * the fleets exist only once it fires; else applied to the document, with each fleet of a pre-staged scene pointed at
 * its `<fleet>-fc` doctrine), then the scenario's cues.
 *
 * @param plan - The staging plan.
 * @param staged - The document after the hub calls.
 * @returns The document to load, load_scene's arguments and the warnings.
 */
export function finishScenarioStaging(plan: ScenarioStagingPlan, staged: SceneDocument): StagedScenario {
  const { scenario } = plan;
  const warnings: string[] = [];
  let scene = staged;

  // stage_engagement already embedded each side's doctrine as <fleet>-fc: staging adds only the logi edits, and points a
  // pre-staged scene's fleets at their doctrines
  const settings = (document: Pick<SceneDocument, 'fleets'>) =>
    scenario.sides.flatMap((side) => {
      const { personality: _personality, ...rest } = side.settings ?? {};
      const key = fleetDoctrineKey(side.fleet);
      const fleet = document.fleets?.find((candidate) => candidate.id === side.fleet);
      const pointed = scenario.scene && fleet ? [{ op: 'set_personalities', personalities: { [key]: toFleetDoctrineTemplate(side.fleet, side.settings?.personality) } }, ...(fleet.personality === key ? [] : [{ op: 'update_fleet', fleet: side.fleet, set: { personality: key } }])] : [];
      return [...pointed, ...toFleetSettingsOperations(document, side.fleet, rest)];
    });

  if (plan.warpIn) {
    const cue = scene.timeline?.cues.find((candidate) => candidate.id === SCENARIO_STAGE_CUE);
    const patch = cue && 'patch_scene' in cue ? (cue.patch_scene as { operations?: Record<string, unknown>[] }) : undefined;

    if (cue && patch?.operations) {
      const landed = sceneAtTimelineTime(scene, 0, applySceneOperations);
      const extra = settings(landed);

      if (extra.length > 0) {
        scene = apply(scene, [{ op: 'update_cue', id: SCENARIO_STAGE_CUE, set: { patch_scene: { ...patch, operations: [...patch.operations, ...extra] } } }], warnings);
      }
    } else {
      warnings.push(`the staging cue "${SCENARIO_STAGE_CUE}" is missing; the settings were not applied`);
    }
  } else {
    const extra = settings(scene);

    if (extra.length > 0) {
      scene = apply(scene, extra, warnings);
    }
  }

  const cues = toScenarioCues(scenario);

  if (cues.length > 0) {
    scene = apply(
      scene,
      cues.map((cue) => ({ op: 'add_cue', cue })),
      warnings
    );
  }

  return { scene, load: scenario.start === 'paused' ? { timeline: 'pause' } : {}, warnings };
}

function apply(scene: SceneDocument, operations: Record<string, unknown>[], warnings: string[]): SceneDocument {
  const result = applySceneOperations(scene, operations);
  warnings.push(...result.warnings);
  return result.scene;
}

/**
 * Runs a staging plan: each hub call on the document built so far (`scene` passed, nothing loaded), then
 * finishScenarioStaging. Nothing reaches the page until the caller loads the result.
 *
 * @param plan - The staging plan.
 * @param callHub - Runs one hub tool.
 * @returns The staged scenario.
 * @throws {Error} When a hub call refuses (its error, with the hub's problems) or returns no scene.
 */
export async function runScenarioStaging(plan: ScenarioStagingPlan, callHub: ScenarioHubCall): Promise<StagedScenario> {
  let scene = plan.base;
  const warnings: string[] = [];

  for (const step of plan.steps) {
    const result = (await callHub(step.tool, { ...step.args, scene })) as Maybe<{ readonly scene?: SceneDocument; readonly warnings?: readonly string[] }>;

    if (!result?.scene) {
      throw new Error(`${step.tool} returned no scene`);
    }

    scene = result.scene;
    warnings.push(...(result.warnings ?? []));
  }

  const finished = finishScenarioStaging(plan, scene);
  return { ...finished, warnings: [...warnings, ...finished.warnings] };
}
