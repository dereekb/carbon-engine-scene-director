import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { CELESTIAL_TARGET_REFUSAL, normalizeTargetCommand } from './target';

describe('normalizeTargetCommand', () => {
  it('reads a target or null and the selection', () => {
    expect(normalizeTargetCommand({ ships: ['a', 'b'], target: ' punisher ' })).toEqual({ ships: ['a', 'b'], target: 'punisher' });
    expect(normalizeTargetCommand({ fleet: 'tfis', squad: 'logi', target: 'astrahus' })).toEqual({ fleet: 'tfis', squad: 'logi', target: 'astrahus' });
    expect(normalizeTargetCommand({ fleet: 'tfis', wing: 'w1', target: null })).toEqual({ fleet: 'tfis', wing: 'w1', target: null });
  });

  it('requires a target key and exactly one of ships and fleet, and refuses celestials and unknown keys', () => {
    expect(catchSceneError(() => normalizeTargetCommand({ ships: ['a'] })).problems).toEqual(['set_target.target is required: a ship or object id, or null to clear the targets']);
    expect(catchSceneError(() => normalizeTargetCommand({ target: '', lock: true }, 'beat')).problems).toEqual([
      'beat.lock is not a set_target field',
      'beat.target must be a ship or object id, or null to clear the targets',
      'beat needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)'
    ]);
    expect(catchSceneError(() => normalizeTargetCommand({ ships: ['a'], target: 'celestial:50001249' })).problems).toEqual([`set_target.target "celestial:50001249": ${CELESTIAL_TARGET_REFUSAL}`]);
    expect(catchSceneError(() => normalizeTargetCommand([])).problems).toEqual(['set_target must be an object { ships | fleet [, wing | squad], target }']);
  });
});
