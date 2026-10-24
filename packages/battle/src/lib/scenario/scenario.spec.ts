import { describe, expect, it } from 'vitest';
import { makeTestScenario } from '../battle.spec-helper';
import { type ScenarioError, isScenarioSettingsDrop, normalizeScenario } from './scenario';

describe('normalizeScenario', () => {
  it('reads a whole scenario', () => {
    const read = normalizeScenario(makeTestScenario());

    expect(read.kind).toBe('scenario');

    if (read.kind === 'scenario') {
      expect(read.scenario.id).toBe('test-battle');
      expect(read.scenario.sides.map((side) => side.fleet)).toEqual(['blue', 'red']);
      expect(read.scenario.sides[0].settings?.logi).toEqual({ formation: 'loose' });
      expect(read.scenario.sides[1].start).toBe('hold');
      expect(read.scenario.camera).toEqual({ auto: true });
      expect(read.warnings).toEqual([]);
    }
  });

  it('reports every problem at once', () => {
    let problems: readonly string[] = [];

    try {
      normalizeScenario({
        schema: 'cjs-scenario/1',
        start: 'later',
        sides: [
          { fleet: 'a', settings: { retreat: 5, logi: { formation: 'tight' } } },
          { fleet: 'a', composition: 'x', ships: [] }
        ]
      });
    } catch (error) {
      problems = (error as ScenarioError).problems;
    }

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^id is required/),
        expect.stringMatching(/^start must be one of/),
        expect.stringMatching(/sides\[0\] needs a composition or ships/),
        expect.stringMatching(/sides\[0\]\.settings\.retreat must be/),
        expect.stringMatching(/sides\[0\]\.settings\.logi\.formation must be one of/),
        expect.stringMatching(/sides\[1\]: give a composition or ships, not both/),
        expect.stringMatching(/the two sides need different fleet ids/)
      ])
    );
  });

  it('refuses a wrong schema and a side count other than two', () => {
    expect(() => normalizeScenario({ schema: 'cjs-scene/1' })).toThrow(/schema must be "cjs-scenario\/1"/);
    expect(() => normalizeScenario({ schema: 'cjs-scenario/1', id: 'x', sides: [{ fleet: 'a', composition: 'tfis' }] })).toThrow(/exactly two sides/);
  });

  it('warns on unknown fields and a side personality outside settings', () => {
    const read = normalizeScenario(
      makeTestScenario({
        extra: 1,
        sides: [
          { fleet: 'a', composition: 'x', personality: 'line' },
          { fleet: 'b', composition: 'y' }
        ]
      })
    );

    expect(read.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/scenario\.extra is not a known field/), expect.stringMatching(/sides\[0\]\.personality is ignored/)]));
  });

  it('reads a settings drop', () => {
    const drop = { schema: 'cjs-scenario/1', id: 'test-battle', sides: [{ fleet: 'blue', settings: { personality: 'kiter', retreat: [0, 0, 500000] } }] };

    expect(isScenarioSettingsDrop(drop)).toBe(true);
    expect(isScenarioSettingsDrop(makeTestScenario())).toBe(false);

    const read = normalizeScenario(drop);
    expect(read.kind).toBe('settings');

    if (read.kind === 'settings') {
      expect(read.drop.sides).toEqual([{ fleet: 'blue', settings: { personality: 'kiter', retreat: [0, 0, 500000] } }]);
    }
  });

  it('accepts a pre-staged scene instead of compositions', () => {
    const read = normalizeScenario({ schema: 'cjs-scenario/1', id: 'x', scene: { schema: 'cjs-scene/1', name: 'pre' }, sides: [{ fleet: 'a' }, { fleet: 'b' }] });

    expect(read.kind).toBe('scenario');
  });
});
