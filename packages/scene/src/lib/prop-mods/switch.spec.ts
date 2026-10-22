import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { normalizePropModSwitch } from './switch';

describe('normalizePropModSwitch', () => {
  it('reads active and the selection', () => {
    expect(normalizePropModSwitch({ active: true, fleet: 'tfis' })).toEqual({ fleet: 'tfis', active: true });
    expect(normalizePropModSwitch({ active: false, fleet: 'tfis', squad: 'logi' })).toEqual({ fleet: 'tfis', squad: 'logi', active: false });
    expect(normalizePropModSwitch({ active: true, ships: ['a', 'b'] })).toEqual({ ships: ['a', 'b'], active: true });
  });

  it('requires active and exactly one of ships and fleet', () => {
    expect(catchSceneError(() => normalizePropModSwitch({ fleet: 'tfis' })).problems).toEqual(['switch.active is required: true switches prop mods on, false off']);
    expect(catchSceneError(() => normalizePropModSwitch({ active: 'on', ships: ['a'], fleet: 'f' })).problems).toEqual(['switch.active is required: true switches prop mods on, false off', 'switch needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)']);
    expect(catchSceneError(() => normalizePropModSwitch({ active: true, squad: 'logi' })).problems).toContain('switch: wing and squad select within a fleet; give fleet too');
    expect(catchSceneError(() => normalizePropModSwitch({ active: true, fleet: 'f', wing: 'w', squad: 's' })).problems).toEqual(['switch: give wing or squad, not both']);
  });

  it('refuses unknown keys and a value that is not an object', () => {
    expect(catchSceneError(() => normalizePropModSwitch({ active: true, fleet: 'f', ship: 'a' }, 'beat')).problems).toEqual(['beat.ship is not a switch_prop_mods field']);
    expect(catchSceneError(() => normalizePropModSwitch('on')).problems).toEqual(['switch must be an object { active, ships | fleet [, wing | squad] }']);
  });
});
