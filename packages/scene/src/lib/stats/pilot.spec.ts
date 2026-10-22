import { describe, expect, it } from 'vitest';
import { createPilotContext, MAX_SKILLS_PILOT } from './pilot';
import { ACCELERATION_CONTROL_SKILL, EVASIVE_MANEUVERING_SKILL, NAVIGATION_SKILL, SHIP_SKILLS, SPACESHIP_COMMAND_SKILL } from './skills';

const UNKNOWN_SKILL = { typeID: 99_999_999, name: 'Underwater Basket Weaving' };

describe('pilot context', () => {
  it('the max-skills pilot has every skill at V', () => {
    expect(MAX_SKILLS_PILOT.name).toBe('max-skills');
    for (const skill of [...SHIP_SKILLS, UNKNOWN_SKILL]) expect(MAX_SKILLS_PILOT.skillLevel(skill)).toBe(5);
    expect(Object.isFrozen(MAX_SKILLS_PILOT)).toBe(true);
  });

  it('reads skills by name (any case), by type id in a list or a Record, and defaults the rest', () => {
    const byName = createPilotContext({ skills: { navigation: 4, 'EVASIVE MANEUVERING': 3 } });
    expect(byName.name).toBe('custom');
    expect(byName.skillLevel(NAVIGATION_SKILL)).toBe(4);
    expect(byName.skillLevel(EVASIVE_MANEUVERING_SKILL)).toBe(3);
    expect(byName.skillLevel(SPACESHIP_COMMAND_SKILL)).toBe(0);

    const byList = createPilotContext({ name: 'list', skills: [{ typeID: 3449, level: 2 }], defaultLevel: 4 });
    expect(byList.skillLevel(NAVIGATION_SKILL)).toBe(2);
    expect(byList.skillLevel(ACCELERATION_CONTROL_SKILL)).toBe(4);

    expect(createPilotContext({ skills: { '3452': 1 } }).skillLevel(ACCELERATION_CONTROL_SKILL)).toBe(1);
  });

  it('a type id beats a name for the same skill', () => {
    const pilot = createPilotContext({ skills: { Navigation: 1, '3449': 3 } });
    expect(pilot.skillLevel(NAVIGATION_SKILL)).toBe(3);
  });

  it('the partial pilot', () => {
    const pilot = createPilotContext({ name: 'partial', skills: { Navigation: 4, 'Evasive Maneuvering': 3, 'Spaceship Command': 5, 'Acceleration Control': 4 } });
    expect(SHIP_SKILLS.map((skill) => pilot.skillLevel(skill))).toEqual([4, 3, 5, 0, 0, 4, 0]);
  });

  it('rejects impossible levels and repeated skills', () => {
    for (const level of [6, 2.5, -1, Number.NaN]) {
      expect(() => createPilotContext({ skills: { Navigation: level } })).toThrow(/skill "Navigation" must be a skill level/);
    }
    expect(() => createPilotContext({ defaultLevel: 9 })).toThrow(RangeError);
    expect(() => createPilotContext({ skills: { navigation: 1, Navigation: 2 } })).toThrow(/more than once/);
    expect(() =>
      createPilotContext({
        skills: [
          { typeID: 3449, level: 1 },
          { typeID: 3449, level: 2 }
        ]
      })
    ).toThrow(/more than once/);
    expect(() => createPilotContext({ skills: { ' ': 2 } })).toThrow(RangeError);
  });
});
