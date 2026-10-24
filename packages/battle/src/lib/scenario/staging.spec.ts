import { describe, expect, it } from 'vitest';
import { FAKE_STAGING_HUB, makeTestScenario } from '../battle.spec-helper';
import { type Scenario, normalizeScenario } from './scenario';
import { SCENARIO_STAGE_CUE, planScenarioStaging, runScenarioStaging, toScenarioCues, toStagingSide } from './staging';

function scenarioOf(input: Record<string, unknown>): Scenario {
  const read = normalizeScenario(input);

  if (read.kind !== 'scenario') {
    throw new Error('not a scenario');
  }

  return read.scenario;
}

describe('planScenarioStaging', () => {
  it('puts the scenario\'s personalities in the base document, so a doctrine can extend one', () => {
    const doctrine = { schema: 'cjs-fleet-personality/1', id: 'blue-doctrine', extends: 'line', targeting: { reach: 60000 } };
    const plan = planScenarioStaging(scenarioOf(makeTestScenario({ personalities: { 'blue-doctrine': doctrine } })));

    expect(plan.base.personalities?.['blue-doctrine']).toMatchObject({ extends: 'line', targeting: { reach: 60000 } });
  });

  it('plans the base document and one stage_engagement at t = 0 when a side warps in', () => {
    const plan = planScenarioStaging(scenarioOf(makeTestScenario()));

    expect(plan.base.name).toBe('Test battle');
    expect(plan.base.combat).toEqual({ seed: 7 });
    expect(plan.warpIn).toBe(true);
    expect(plan.steps.map((step) => step.tool)).toEqual(['stage_engagement']);
    expect(plan.steps[0].args).toMatchObject({ range: 60000, heading: 90, at: 0, cue: SCENARIO_STAGE_CUE });
  });

  it('adds set_location for a location and stages placed sides directly', () => {
    const plan = planScenarioStaging(
      scenarioOf(
        makeTestScenario({
          location: 'Jita IV - Moon 4',
          sides: [
            { fleet: 'a', composition: 'tfis' },
            { fleet: 'b', composition: 'tfis' }
          ]
        })
      )
    );

    expect(plan.steps.map((step) => step.tool)).toEqual(['set_location', 'stage_engagement']);
    expect(plan.steps[0].args).toEqual({ place: 'Jita IV - Moon 4' });
    expect(plan.steps[1].args['at']).toBeUndefined();
  });
});

describe('toStagingSide', () => {
  it('inlines a bundle composition with the fits under its own, and the doctrine as <fleet>-fc', () => {
    const scenario = scenarioOf(makeTestScenario({ fits: { 'fc-fit': '[Rifter, FC]' } }));
    const side = toStagingSide(scenario, scenario.sides[0]);

    expect((side['composition'] as Record<string, unknown>)['fits']).toEqual({ 'fc-fit': '[Rifter, FC]' });
    expect(side['personality']).toEqual({ extends: 'brawler', targeting: { reach: 20000 }, schema: 'cjs-fleet-personality/1', id: 'blue-fc' });
    expect(side['warpIn']).toBe(true);
  });

  it("passes a library composition by name and swaps ship lines' fit keys for their text", () => {
    const scenario = scenarioOf(
      makeTestScenario({
        fits: { rails: '[Ferox, Rails]' },
        sides: [
          { fleet: 'a', composition: 'tfis' },
          { fleet: 'b', ships: [{ hull: 'Ferox', count: 2, fit: 'rails' }] }
        ]
      })
    );

    expect(toStagingSide(scenario, scenario.sides[0])['composition']).toBe('tfis');
    expect(toStagingSide(scenario, scenario.sides[1])['ships']).toEqual([{ hull: 'Ferox', count: 2, fit: '[Ferox, Rails]' }]);
  });
});

describe('toScenarioCues', () => {
  it('cues hold sides on landing (warp-in) or at t = 0, then the camera, then the extra cues', () => {
    const scenario = scenarioOf(makeTestScenario({ timeline: [{ id: 'later', at: 30, cease_fire: { fleet: 'blue' } }] }));
    const cues = toScenarioCues(scenario);

    expect(cues.map((cue) => cue['id'])).toEqual(['red-hold', 'red-hold-fire', 'scenario-camera', 'later']);
    expect(cues[0]).toMatchObject({ at: 0, order_fleet: { fleet: 'red', order: { type: 'stance', set: { type: 'hold' } } } });
    expect(cues[1]).toMatchObject({ at: 0, cease_fire: { fleet: 'red' } });

    const warping = toScenarioCues(
      scenarioOf(
        makeTestScenario({
          camera: undefined,
          sides: [
            { fleet: 'a', composition: 'x', warpIn: true, start: 'hold' },
            { fleet: 'b', composition: 'y' }
          ]
        })
      )
    );
    expect(warping[0]).toMatchObject({ when: { arrival: { fleet: 'a', phase: 'landed' } } });
  });
});

describe('runScenarioStaging', () => {
  it('stages a warp-in scenario on a passed scene and appends the settings to the t = 0 cue', async () => {
    const staged = await runScenarioStaging(planScenarioStaging(scenarioOf(makeTestScenario())), FAKE_STAGING_HUB);
    const cue = staged.scene.timeline?.cues.find((candidate) => candidate.id === SCENARIO_STAGE_CUE) as unknown as { patch_scene: { operations: Record<string, unknown>[] } };
    const operations = cue.patch_scene.operations;

    expect(staged.scene.ships ?? []).toEqual([]);
    expect(operations.map((operation) => operation['op'])).toEqual(['set_personalities', 'stage_engagement', 'update_squad']);
    expect(operations[2]).toEqual({ op: 'update_squad', fleet: 'blue', squad: 'logi', set: { stance: { formation: 'loose' } } });
    expect(staged.scene.timeline?.cues.map((candidate) => candidate.id)).toEqual([SCENARIO_STAGE_CUE, 'red-hold', 'red-hold-fire', 'scenario-camera']);
    expect(staged.load).toEqual({});
  });

  it('applies the settings to the document when nothing warps in, and pauses a paused start', async () => {
    const scenario = scenarioOf(
      makeTestScenario({
        start: 'paused',
        sides: [
          { fleet: 'blue', composition: 'blue-comp', settings: { logi: { autoRepair: { on: false } } } },
          { fleet: 'red', composition: 'blue-comp' }
        ]
      })
    );
    const staged = await runScenarioStaging(planScenarioStaging(scenario), FAKE_STAGING_HUB);
    const blue = staged.scene.fleets?.find((fleet) => fleet.id === 'blue');

    expect(blue?.personality).toBe('blue-fc');
    expect(blue?.wings[0].squads.find((squad) => squad.id === 'logi')?.autoRepair).toEqual({ on: false });
    expect(staged.load).toEqual({ timeline: 'pause' });
  });

  it("points a pre-staged scene's fleets at their doctrines", async () => {
    const first = await runScenarioStaging(
      planScenarioStaging(
        scenarioOf(
          makeTestScenario({
            sides: [
              { fleet: 'blue', composition: 'blue-comp' },
              { fleet: 'red', composition: 'blue-comp' }
            ]
          })
        )
      ),
      FAKE_STAGING_HUB
    );
    const prestaged = { ...first.scene, timeline: undefined, personalities: undefined, fleets: first.scene.fleets?.map((fleet) => ({ ...fleet, personality: 'line' })) };
    const scenario = scenarioOf({ schema: 'cjs-scenario/1', id: 'pre', scene: JSON.parse(JSON.stringify(prestaged)), sides: [{ fleet: 'blue', settings: { personality: 'kiter' } }, { fleet: 'red' }] });
    const staged = await runScenarioStaging(planScenarioStaging(scenario), FAKE_STAGING_HUB);

    expect(staged.scene.fleets?.map((fleet) => fleet.personality)).toEqual(['blue-fc', 'red-fc']);
    expect(staged.scene.personalities?.['blue-fc']).toMatchObject({ extends: 'kiter' });
  });

  it('passes a hub refusal through', async () => {
    const plan = planScenarioStaging(scenarioOf(makeTestScenario({ location: 'Jita' })));

    await expect(runScenarioStaging(plan, FAKE_STAGING_HUB)).rejects.toThrow(/set_location needs EVE data/);
  });
});
