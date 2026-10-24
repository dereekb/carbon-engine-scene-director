import { describe, expect, it } from 'vitest';
import { makeTestComposition, makeTestScenario } from '../battle.spec-helper';
import { readScenarioBundle, scenarioOfBundle } from './bundle';

const json = (value: unknown) => JSON.stringify(value);

describe('readScenarioBundle', () => {
  it('classifies a zip of parts and merges them into the scenario', () => {
    const scenario = makeTestScenario({ compositions: undefined });
    const bundle = readScenarioBundle([
      { path: 'battle/scenario.json', text: json(scenario) },
      { path: 'battle/compositions/blue.json', text: json(makeTestComposition('blue-comp')) },
      { path: 'battle/personalities/hunter.json', text: json({ schema: 'cjs-fleet-personality/1', id: 'hunter', extends: 'headhunter' }) },
      { path: 'battle/fits/fc-fit.eft', text: '[Rifter, FC]\n' },
      { path: '__MACOSX/battle/._scenario.json', text: 'x' },
      { path: 'battle/.DS_Store', text: '' }
    ]);

    expect(bundle.problems).toEqual([]);
    expect(bundle.kind).toBe('scenario');
    const read = scenarioOfBundle(bundle);
    expect(Object.keys(read?.compositions ?? {})).toEqual(['blue-comp']);
    expect(Object.keys(read?.personalities ?? {})).toEqual(['hunter']);
    expect(read?.fits).toEqual({ 'fc-fit': '[Rifter, FC]\n' });
  });

  it('reports unknown, invalid and duplicate parts together', () => {
    const bundle = readScenarioBundle([
      { path: 'scenario.json', text: json(makeTestScenario()) },
      { path: 'blue.json', text: json(makeTestComposition('blue-comp')) },
      { path: 'what.json', text: json({ schema: 'cjs-thing/1' }) },
      { path: 'broken.json', text: '{ nope' },
      { path: 'a/x.eft', text: 'a' },
      { path: 'b/x.txt', text: 'b' }
    ]);

    expect(bundle.problems).toEqual(expect.arrayContaining([expect.stringMatching(/what\.json: unknown part/), expect.stringMatching(/broken\.json is not valid JSON/), expect.stringMatching(/duplicate fit "x"/), expect.stringMatching(/composition "blue-comp" is both inline in the scenario and a part of the bundle/)]));
  });

  it('reads a settings drop and a lone personality', () => {
    const settings = readScenarioBundle([{ path: 'settings.json', text: json({ schema: 'cjs-scenario/1', id: 'test-battle', sides: [{ fleet: 'blue', settings: { personality: 'kiter' } }] }) }]);
    const personality = readScenarioBundle([{ path: 'kite.json', text: json({ schema: 'cjs-fleet-personality/1', id: 'kite', extends: 'kiter' }) }]);

    expect(settings.kind).toBe('settings');
    expect(personality.kind).toBe('personality');
    expect(Object.keys(personality.personalities)).toEqual(['kite']);
  });

  it('refuses two scenarios and a drop without one', () => {
    expect(
      readScenarioBundle([
        { path: 'a.json', text: json(makeTestScenario()) },
        { path: 'b.json', text: json(makeTestScenario()) }
      ]).problems[0]
    ).toMatch(/a drop holds one scenario/);
    expect(readScenarioBundle([{ path: 'c.json', text: json(makeTestComposition('c')) }]).problems[0]).toMatch(/a drop needs a cjs-scenario\/1 file/);
  });
});
