import { describe, expect, it } from 'vitest';
import type { SceneDocument } from '@scene-director/scene';
import { FAKE_STAGING_HUB, makeTestScenario } from '../battle.spec-helper';
import { type Scenario, normalizeScenario } from './scenario';
import { fleetDoctrineKey, mergeFleetSettings, mergeScenarioSettings, toFleetDoctrineTemplate, toFleetSettingsOperations, toSettingsDropOperations } from './settings';
import { planScenarioStaging, runScenarioStaging } from './staging';

function scenarioOf(input: Record<string, unknown>): Scenario {
  return (normalizeScenario(input) as { scenario: Scenario }).scenario;
}

async function stagedScene(): Promise<SceneDocument> {
  const scenario = scenarioOf(
    makeTestScenario({
      sides: [
        { fleet: 'blue', composition: 'blue-comp' },
        { fleet: 'red', composition: 'blue-comp' }
      ]
    })
  );
  return (await runScenarioStaging(planScenarioStaging(scenario), FAKE_STAGING_HUB)).scene;
}

describe('toFleetDoctrineTemplate', () => {
  it("extends a base name, or keeps a template's overrides over line", () => {
    expect(fleetDoctrineKey('blue')).toBe('blue-fc');
    expect(toFleetDoctrineTemplate('blue', 'kiter')).toEqual({ extends: 'kiter', schema: 'cjs-fleet-personality/1', id: 'blue-fc' });
    expect(toFleetDoctrineTemplate('blue', { engage: 'when-attacked' })).toEqual({ extends: 'line', engage: 'when-attacked', schema: 'cjs-fleet-personality/1', id: 'blue-fc' });
    expect(toFleetDoctrineTemplate('blue')).toEqual({ extends: 'line', schema: 'cjs-fleet-personality/1', id: 'blue-fc' });
  });
});

describe('toFleetSettingsOperations', () => {
  it("sets the doctrine and each logi squad's stance and auto-repair, with no update_fleet", async () => {
    const scene = await stagedScene();
    const operations = toFleetSettingsOperations(scene, 'blue', { personality: 'sniper', logi: { formation: 'follow', autoRepair: { policy: 'damaged' } } });

    expect(operations).toEqual([
      { op: 'set_personalities', personalities: { 'blue-fc': { extends: 'sniper', schema: 'cjs-fleet-personality/1', id: 'blue-fc' } } },
      { op: 'update_squad', fleet: 'blue', squad: 'logi', set: { stance: null, autoRepair: { policy: 'damaged' } } }
    ]);
  });

  it('only edits fleets the live document has (a settings drop)', async () => {
    const scene = await stagedScene();

    expect(
      toSettingsDropOperations(scene, {
        sides: [
          { fleet: 'green', settings: { personality: 'line' } },
          { fleet: 'red', settings: { logi: { formation: 'loose' } } }
        ]
      })
    ).toEqual([{ op: 'update_squad', fleet: 'red', squad: 'logi', set: { stance: { formation: 'loose' } } }]);
  });
});

describe('mergeScenarioSettings', () => {
  it('merges a drop into the scenario by fleet, logi key by key, and names unknown fleets', () => {
    const scenario = scenarioOf(makeTestScenario());
    const merged = mergeScenarioSettings(scenario, {
      sides: [
        { fleet: 'blue', settings: { logi: { autoRepair: { on: false } } } },
        { fleet: 'green', settings: {} }
      ]
    });

    expect(merged.unknownFleets).toEqual(['green']);
    expect(merged.scenario.sides[0].settings).toEqual({ personality: { extends: 'brawler', targeting: { reach: 20000 } }, logi: { formation: 'loose', autoRepair: { on: false } }, retreat: 'away' });
    expect(merged.scenario.sides[1]).toBe(scenario.sides[1]);
    expect(mergeFleetSettings(undefined, { retreat: 'away' })).toEqual({ retreat: 'away' });
  });
});
