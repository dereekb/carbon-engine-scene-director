import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { CELESTIAL_TARGET_REFUSAL } from '../weapons/target';
import { normalizeCeaseFireCommand, normalizeEngageCommand } from './commands';

describe('normalizeEngageCommand', () => {
  it('reads the target, the selection and the modules, turrets by default', () => {
    expect(normalizeEngageCommand({ ships: ['a', 'b'], target: ' punisher ' })).toEqual({ ships: ['a', 'b'], target: 'punisher', modules: ['turret'] });
    expect(normalizeEngageCommand({ fleet: 'red', wing: 'w1', target: 'blue-fc', modules: [' high-0 ', 'turret'] })).toEqual({ fleet: 'red', wing: 'w1', target: 'blue-fc', modules: ['high-0', 'turret'] });
    expect(normalizeEngageCommand({ fleet: 'red', squad: 's1', target: 'astrahus' })).toMatchObject({ fleet: 'red', squad: 's1', target: 'astrahus' });
  });

  it('requires a target and exactly one of ships and fleet, and refuses celestials, bad modules and unknown keys', () => {
    expect(catchSceneError(() => normalizeEngageCommand({ ships: ['a'] })).problems).toEqual(['engage.target must be a ship or object id']);
    expect(catchSceneError(() => normalizeEngageCommand({ ships: ['a'], target: null })).problems).toEqual(['engage.target must be a ship or object id']);
    expect(catchSceneError(() => normalizeEngageCommand({ target: 'x', modules: [], fire: true }, 'beat')).problems).toEqual([
      'beat.fire is not an engage field',
      'beat.modules must be a non-empty array of module selectors ("turret", a module key such as "high-0", or a module name)',
      'beat needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)'
    ]);
    expect(catchSceneError(() => normalizeEngageCommand({ ships: ['a'], target: 'celestial:50001249' })).problems).toEqual([`engage.target "celestial:50001249": ${CELESTIAL_TARGET_REFUSAL}`]);
    expect(catchSceneError(() => normalizeEngageCommand({ ships: ['a'], target: 'b', modules: ['turret', 3] })).problems).toHaveLength(1);
    expect(catchSceneError(() => normalizeEngageCommand([])).problems).toEqual(['engage must be an object { ships | fleet [, wing | squad], target, modules? }']);
  });
});

describe('normalizeCeaseFireCommand', () => {
  it('reads the selection and unlock, false by default', () => {
    expect(normalizeCeaseFireCommand({ ships: ['a'] })).toEqual({ ships: ['a'], unlock: false });
    expect(normalizeCeaseFireCommand({ fleet: 'red', unlock: true })).toEqual({ fleet: 'red', unlock: true });
  });

  it('refuses a non-boolean unlock, a missing selection and unknown keys', () => {
    expect(catchSceneError(() => normalizeCeaseFireCommand({ ships: ['a'], unlock: 'yes' })).problems).toEqual(['cease_fire.unlock must be true or false']);
    expect(catchSceneError(() => normalizeCeaseFireCommand({ target: 'x' })).problems).toEqual(['cease_fire.target is not a cease_fire field', 'cease_fire needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)']);
    expect(catchSceneError(() => normalizeCeaseFireCommand(null)).problems).toEqual(['cease_fire must be an object { ships | fleet [, wing | squad], unlock? }']);
  });
});
