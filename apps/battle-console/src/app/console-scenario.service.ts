import { Injectable, computed, inject, signal } from '@angular/core';
import type { Maybe } from '@dereekb/util';
import {
  ScenarioError,
  fleetDoctrineKey,
  mergeScenarioSettings,
  planScenarioStaging,
  readScenarioBundle,
  runScenarioStaging,
  toFleetSettingsOperations,
  toSettingsDropOperations,
  type Scenario,
  type ScenarioBundleFile,
  type ScenarioFleetSettings,
  type ScenarioPersonality,
  type ScenarioSettingsDrop
} from '@scene-director/battle';
import { ConsoleDialogs } from './console-dialogs';
import { readConsoleFiles, type ConsoleDroppedFile } from './console-files';
import { ConsoleScenarioStore } from './console-scenario.store';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * Where the console's scenario stands: none, being read and staged, loaded (this tab staged it), restored (kept from
 * an earlier tab: Reset still works), or failed (the problems dialog said why).
 */
export type ConsoleScenarioState = 'none' | 'loading' | 'loaded' | 'restored' | 'failed';

/**
 * What a drop did, for the card and the checks.
 */
export type ConsoleDropOutcome = 'loaded' | 'applied' | 'doctrine' | 'cancelled' | 'failed';

/**
 * The problems of an error: a ScenarioError's or a hub refusal's (HubCallError carries the hub's `problems`), else its
 * message.
 *
 * @param error - What was thrown.
 * @returns Every problem it names.
 */
export function problemsOfError(error: unknown): string[] {
  const problems = error instanceof ScenarioError ? error.problems : (error as Maybe<{ problems?: unknown }>)?.problems;
  let result: string[];

  if (Array.isArray(problems) && problems.length > 0) {
    result = problems.map(String);
  } else {
    result = [error instanceof Error ? error.message : String(error)];
  }

  return result;
}

/**
 * Loads scenario files into the console and keeps its scenario: reads a drop (readScenarioBundle), stages a scenario
 * over ViewerApi.CallHub and loads it (load_scene), applies settings drops and the panel's settings live (patch_scene)
 * merging them into its copy so Reset keeps them, and resets (re-stage, or timeline restart for a scene no scenario
 * built). The copy is kept in IndexedDB so a reload keeps Reset (sd-console).
 */
@Injectable({ providedIn: 'root' })
export class ConsoleScenarioService {
  private readonly _viewer = inject(ConsoleViewerService);
  private readonly _dialogs = inject(ConsoleDialogs);
  private readonly _store = inject(ConsoleScenarioStore);

  readonly scenario = signal<Maybe<Scenario>>(undefined);
  readonly state = signal<ConsoleScenarioState>('none');
  readonly warnings = signal<readonly string[]>([]);
  readonly busy = computed(() => this.state() === 'loading');

  private _restored: Maybe<Promise<void>>;

  /**
   * Restores the kept scenario once (the engine restores its own scene).
   */
  restore(): Promise<void> {
    this._restored ??= this._store
      .read()
      .then((saved) => {
        if (saved && this.scenario() == null) {
          this.scenario.set(saved.scenario);
          this.state.set('restored');
        }
      })
      .catch(() => undefined);

    return this._restored;
  }

  /**
   * Loads dropped or picked files.
   *
   * @param files - The files, with their paths in the drop.
   * @param fleet - The fleet card they were dropped on: a lone personality becomes its doctrine.
   * @returns What the drop did.
   */
  async drop(files: readonly ConsoleDroppedFile[], fleet?: string): Promise<ConsoleDropOutcome> {
    let outcome: ConsoleDropOutcome;

    try {
      outcome = await this.load(await readConsoleFiles(files), fleet);
    } catch (error) {
      await this.fail('The files could not be read', problemsOfError(error));
      outcome = 'failed';
    }

    return outcome;
  }

  /**
   * Loads a bundle's files: a scenario (staged and loaded, or its settings applied when it is the running one), a
   * settings drop (applied live), or a lone personality dropped on a fleet card (its doctrine).
   *
   * @param files - The bundle's files.
   * @param fleet - The fleet card they were dropped on.
   * @returns What the drop did.
   */
  async load(files: readonly ScenarioBundleFile[], fleet?: string): Promise<ConsoleDropOutcome> {
    const bundle = readScenarioBundle(files);
    const read = bundle.read;
    let outcome: ConsoleDropOutcome = 'failed';

    if (bundle.problems.length > 0) {
      await this.fail('The drop has problems', bundle.problems, bundle.warnings);
    } else if (bundle.kind === 'personality') {
      const [template] = Object.values(bundle.personalities);

      if (fleet && template) {
        outcome = await this.applyFleetSettings(fleet, { personality: template as ScenarioPersonality });
        outcome = outcome === 'applied' ? 'doctrine' : outcome;
      } else {
        await this.fail('A lone personality', ['Drop a lone personality file on a fleet card to make it that fleet’s doctrine.']);
      }
    } else if (read?.kind === 'settings') {
      outcome = await this.applySettingsDrop(read.drop, bundle.warnings);
    } else if (read?.kind === 'scenario') {
      outcome = await this.loadScenario(read.scenario, bundle.warnings);
    } else {
      await this.fail('Nothing to load', ['The drop holds no scenario, settings or personality.'], bundle.warnings);
    }

    return outcome;
  }

  /**
   * Applies one fleet's settings live (toFleetSettingsOperations through patch_scene) and merges them into the
   * console's scenario. A fleet whose doctrine is not its own `<fleet>-fc` template (a scene no scenario staged, or a
   * fleet without a brain) is pointed at it (update_fleet set personality).
   *
   * @param fleet - The fleet.
   * @param settings - Its new settings.
   * @returns 'applied', or 'failed' (the problems dialog said why).
   */
  async applyFleetSettings(fleet: string, settings: ScenarioFleetSettings): Promise<ConsoleDropOutcome> {
    const api = this._viewer.api;
    const scene = api?.Scene();
    let outcome: ConsoleDropOutcome = 'failed';

    if (api && scene?.fleets?.some((candidate) => candidate.id === fleet)) {
      const key = fleetDoctrineKey(fleet);
      const pointed = settings.personality != null && scene.fleets.find((candidate) => candidate.id === fleet)?.personality !== key;
      const operations = [...toFleetSettingsOperations(scene, fleet, settings), ...(pointed ? [{ op: 'update_fleet', fleet, set: { personality: key } }] : [])];

      try {
        if (operations.length > 0) {
          await api.Call('patch_scene', { operations });
        }

        this.mergeSettings({ sides: [{ fleet, settings }] });
        outcome = 'applied';
      } catch (error) {
        await this.fail(`${fleet}'s settings were refused`, problemsOfError(error));
      }

      this._viewer.flush();
    } else {
      await this.fail('No such fleet', [`The live scene has no fleet "${fleet}".`]);
    }

    return outcome;
  }

  /**
   * Resets the battle (after a confirmation): re-stages the console's scenario (the file plus the settings merged
   * since) and loads it; a scene no scenario built restarts its timeline.
   *
   * @param confirm - Ask first (the card's button does; the checks do not).
   * @returns What it did.
   */
  async reset(confirm = true): Promise<ConsoleDropOutcome> {
    const scenario = this.scenario();
    const api = this._viewer.api;
    let outcome: ConsoleDropOutcome = 'cancelled';

    if (api && (!confirm || (await this._dialogs.confirm({ title: 'Reset the battle?', prompt: scenario ? `Re-stage ${scenario.name ?? scenario.id} with your settings and start again.` : 'Restart the timeline from the start.', confirmText: 'Reset' })))) {
      if (scenario) {
        outcome = await this.stageAndLoad(scenario, []);
      } else {
        try {
          await api.Call('timeline', { action: 'restart' });
          outcome = 'loaded';
        } catch (error) {
          await this.fail('The timeline could not restart', problemsOfError(error));
          outcome = 'failed';
        }

        this._viewer.flush();
      }
    }

    return outcome;
  }

  private async loadScenario(scenario: Scenario, warnings: readonly string[]): Promise<ConsoleDropOutcome> {
    const current = this.scenario();
    let outcome: ConsoleDropOutcome = 'cancelled';

    if (current?.id === scenario.id) {
      const choice = await this._dialogs.chooseSameScenario(current.name ?? current.id);

      if (choice === 'apply') {
        outcome = await this.applySettingsDrop({ schema: scenario.schema, id: scenario.id, sides: scenario.sides.filter((side) => side.settings != null).map((side) => ({ fleet: side.fleet, settings: side.settings ?? {} })) }, warnings);
      } else if (choice === 'new') {
        outcome = await this.stageAndLoad(scenario, warnings);
      }
    } else if (!this.fightRunning() || (await this._dialogs.confirm({ title: 'Replace the running battle?', prompt: `Load ${scenario.name ?? scenario.id} in its place.`, confirmText: 'Load' }))) {
      outcome = await this.stageAndLoad(scenario, warnings);
    }

    return outcome;
  }

  private async applySettingsDrop(drop: ScenarioSettingsDrop, warnings: readonly string[]): Promise<ConsoleDropOutcome> {
    const api = this._viewer.api;
    const scene = api?.Scene();
    const current = this.scenario();
    let outcome: ConsoleDropOutcome = 'failed';

    if (current && current.id !== drop.id) {
      await this.fail('Settings for another scenario', [`These settings are for "${drop.id}"; the console runs "${current.id}".`]);
    } else if (api && scene) {
      const operations = toSettingsDropOperations(scene, drop);

      try {
        if (operations.length > 0) {
          await api.Call('patch_scene', { operations });
        }

        const unknown = this.mergeSettings(drop);
        this.warnings.set([...warnings, ...unknown.map((fleet) => `The scenario has no fleet "${fleet}"; its settings were ignored.`)]);
        outcome = 'applied';
      } catch (error) {
        await this.fail('The settings were refused', problemsOfError(error));
      }

      this._viewer.flush();
    } else {
      await this.fail('No battle to apply settings to', ['Load a scenario first.']);
    }

    return outcome;
  }

  private async stageAndLoad(scenario: Scenario, warnings: readonly string[]): Promise<ConsoleDropOutcome> {
    const api = this._viewer.api;
    let outcome: ConsoleDropOutcome = 'failed';

    if (api) {
      this.state.set('loading');

      try {
        const staged = await runScenarioStaging(planScenarioStaging(scenario), (tool, args) => api.CallHub(tool, args));
        await api.Call('load_scene', { scene: staged.scene, ...staged.load });
        this.scenario.set(scenario);
        this.warnings.set([...warnings, ...staged.warnings]);
        this.state.set('loaded');
        await this._store.write(scenario).catch(() => undefined);
        outcome = 'loaded';
      } catch (error) {
        this.state.set(this.scenario() ? 'loaded' : 'failed');
        await this.fail(`${scenario.name ?? scenario.id} could not be staged`, problemsOfError(error), warnings);
      }

      this._viewer.flush();
    } else {
      await this.fail('The engine is not running', ['Wait for the engine to start, then drop the scenario again.']);
    }

    return outcome;
  }

  private mergeSettings(drop: Pick<ScenarioSettingsDrop, 'sides'>): readonly string[] {
    const current = this.scenario();
    let unknownFleets: readonly string[] = [];

    if (current) {
      const merged = mergeScenarioSettings(current, drop);
      this.scenario.set(merged.scenario);
      unknownFleets = merged.unknownFleets;
      void this._store.write(merged.scenario).catch(() => undefined);
    }

    return unknownFleets;
  }

  // a fight is fleets on the grid (the welcome scene's lone ship is not one)
  private fightRunning(): boolean {
    return (this._viewer.api?.Scene()?.fleets?.length ?? 0) > 0;
  }

  private async fail(title: string, problems: readonly string[], warnings?: readonly string[]): Promise<void> {
    await this._dialogs.showProblems({ title, problems, warnings });
  }
}
