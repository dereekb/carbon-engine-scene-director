import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { SceneDocument } from '@scene-director/scene';
import type { ViewerApi } from '@scene-director/viewer-engine/api';
import { ConsoleDialogs, type ConsoleProblemsDialogData, type ConsoleSameScenarioChoice } from './console-dialogs';
import { ConsoleScenarioService, problemsOfError } from './console-scenario.service';
import { ConsoleViewerService } from './console-viewer.service';

const DNA = 'wreck_s:genericbase:generic';

function makeScenarioJson(overrides: Record<string, unknown> = {}): string {
  const composition = (id: string) => ({ schema: 'cjs-fleet/1', id, commander: { dna: DNA }, wings: [{ id: 'wing-1', squads: [{ id: 'dps', role: 'dps', ships: [{ dna: DNA, count: 2 }] }] }] });

  return JSON.stringify({
    schema: 'cjs-scenario/1',
    id: 'duel',
    name: 'Duel',
    combat: { seed: 3 },
    range: 40000,
    sides: [
      { fleet: 'blue', team: 'blue', composition: composition('blue-comp'), settings: { personality: 'brawler' } },
      { fleet: 'red', team: 'red', composition: composition('red-comp'), settings: { personality: 'sniper', retreat: 'away' } }
    ],
    ...overrides
  });
}

interface FakeEngine {
  readonly api: ViewerApi;
  readonly calls: { tool: string; args: Record<string, unknown>; hub: boolean }[];
  scene: SceneDocument | null;
}

function makeFakeEngine(): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    scene: null,
    api: {
      Call: async (tool: string, args?: unknown) => {
        engine.calls.push({ tool, args: args as Record<string, unknown>, hub: false });

        if (tool === 'load_scene') {
          // the fake "stages" two fleets so later drops find them
          engine.scene = { ...((args as { scene: SceneDocument }).scene as SceneDocument), fleets: [{ id: 'blue' }, { id: 'red', personality: 'red-fc' }], ships: [{ id: 'blue-1' }] } as unknown as SceneDocument;
        }

        return {};
      },
      CallHub: async (tool: string, args?: Record<string, unknown>) => {
        engine.calls.push({ tool, args: args ?? {}, hub: true });
        return { scene: args?.['scene'] };
      },
      Fleets: () => [],
      Time: () => null,
      Timeline: () => null,
      Scene: () => engine.scene,
      OnChange: () => () => undefined,
      SetUiHidden: () => undefined,
      UiHidden: () => false
    } as unknown as ViewerApi
  };

  return engine;
}

class FakeDialogs {
  confirmAnswer = true;
  sameChoice: ConsoleSameScenarioChoice | undefined = 'apply';
  readonly confirms: string[] = [];
  readonly problems: ConsoleProblemsDialogData[] = [];

  async confirm(config: { title?: string }): Promise<boolean> {
    this.confirms.push(config.title ?? '');
    return this.confirmAnswer;
  }

  async chooseSameScenario(): Promise<ConsoleSameScenarioChoice | undefined> {
    return this.sameChoice;
  }

  async showProblems(data: ConsoleProblemsDialogData): Promise<void> {
    this.problems.push(data);
  }
}

describe('ConsoleScenarioService', () => {
  let engine: FakeEngine;
  let dialogs: FakeDialogs;
  let service: ConsoleScenarioService;

  beforeEach(() => {
    engine = makeFakeEngine();
    dialogs = new FakeDialogs();
    TestBed.configureTestingModule({ providers: [{ provide: ConsoleDialogs, useValue: dialogs }, { provide: ConsoleViewerService, useValue: { api: engine.api, flush: () => undefined, fleets: () => [] } }] });
    service = TestBed.inject(ConsoleScenarioService);
  });

  it('stages a scenario over CallHub and loads it', async () => {
    expect(await service.load([{ path: 'duel/scenario.json', text: makeScenarioJson() }])).toBe('loaded');

    expect(engine.calls.filter((call) => call.hub).map((call) => call.tool)).toEqual(['stage_engagement']);
    expect(engine.calls.at(-1)?.tool).toBe('load_scene');
    expect(service.scenario()?.id).toBe('duel');
    expect(service.state()).toBe('loaded');
    expect(dialogs.confirms).toEqual([]);
  });

  it('asks before replacing a running fight with another scenario', async () => {
    await service.load([{ path: 'scenario.json', text: makeScenarioJson() }]);
    dialogs.confirmAnswer = false;

    expect(await service.load([{ path: 'other.json', text: makeScenarioJson({ id: 'other' }) }])).toBe('cancelled');
    expect(dialogs.confirms).toEqual(['Replace the running battle?']);
    expect(service.scenario()?.id).toBe('duel');
  });

  it('applies the running scenario dropped again as settings, without a restart', async () => {
    await service.load([{ path: 'scenario.json', text: makeScenarioJson() }]);
    const loads = engine.calls.filter((call) => call.tool === 'load_scene').length;

    expect(await service.load([{ path: 'scenario.json', text: makeScenarioJson({ sides: [{ fleet: 'blue', team: 'blue', composition: 'x', settings: { personality: 'kiter' } }, { fleet: 'red', team: 'red', composition: 'y' }] }) }])).toBe('applied');
    expect(engine.calls.filter((call) => call.tool === 'load_scene').length).toBe(loads);
    expect(engine.calls.at(-1)).toMatchObject({ tool: 'patch_scene', args: { operations: [{ op: 'set_personalities', personalities: { 'blue-fc': { extends: 'kiter' } } }] } });
    expect(service.scenario()?.sides[0].settings?.personality).toBe('kiter');
  });

  it('refuses a settings drop for another scenario', async () => {
    await service.load([{ path: 'scenario.json', text: makeScenarioJson() }]);

    expect(await service.load([{ path: 'settings.json', text: JSON.stringify({ schema: 'cjs-scenario/1', id: 'other', sides: [{ fleet: 'blue', settings: { personality: 'kiter' } }] }) }])).toBe('failed');
    expect(dialogs.problems.at(-1)?.title).toBe('Settings for another scenario');
  });

  it('makes a lone personality dropped on a fleet card its doctrine', async () => {
    await service.load([{ path: 'scenario.json', text: makeScenarioJson() }]);

    expect(await service.load([{ path: 'kite.json', text: JSON.stringify({ schema: 'cjs-fleet-personality/1', id: 'my-kite', extends: 'kiter' }) }], 'blue')).toBe('doctrine');
    const operations = engine.calls.at(-1)?.args['operations'] as Record<string, unknown>[];

    expect(operations.map((operation) => operation['op'])).toEqual(['set_personalities', 'update_fleet']);
    expect(operations[1]).toEqual({ op: 'update_fleet', fleet: 'blue', set: { personality: 'blue-fc' } });
  });

  it('lists every problem of an invalid drop', async () => {
    expect(await service.load([{ path: 'bad.json', text: JSON.stringify({ schema: 'cjs-scenario/1', sides: [] }) }])).toBe('failed');
    expect(dialogs.problems[0].problems.length).toBeGreaterThan(1);
  });

  it('resets by re-staging the scenario with its merged settings', async () => {
    await service.load([{ path: 'scenario.json', text: makeScenarioJson() }]);
    await service.applyFleetSettings('red', { personality: 'kiter' });

    expect(await service.reset()).toBe('loaded');
    expect(dialogs.confirms).toEqual(['Reset the battle?']);
    const stage = engine.calls.findLast((call) => call.tool === 'stage_engagement');
    const red = (stage?.args['sides'] as Record<string, unknown>[]).find((side) => side['fleet'] === 'red');

    expect(red?.['personality']).toMatchObject({ id: 'red-fc', extends: 'kiter' });
  });

  it('restarts the timeline of a scene no scenario built', async () => {
    expect(await service.reset()).toBe('loaded');
    expect(engine.calls).toEqual([{ tool: 'timeline', args: { action: 'restart' }, hub: false }]);
  });
});

describe('problemsOfError', () => {
  it('reads a hub refusal’s problems, else the message', () => {
    expect(problemsOfError(Object.assign(new Error('refused'), { problems: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(problemsOfError(new Error('refused'))).toEqual(['refused']);
  });
});
