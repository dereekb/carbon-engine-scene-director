import { describe, expect, it } from 'vitest';
import { catchSceneError } from '../fleets/fleets.spec-helper';
import { normalizeModuleSwitch } from './switch';

describe('normalizeModuleSwitch', () => {
  it('reads the selectors, the state, a target, a delay and the selection', () => {
    expect(normalizeModuleSwitch({ fleet: 'tfis', squad: 'logi', modules: ['remote-armor-repairer'], state: 'active', target: ' tfis-fc ' })).toEqual({ fleet: 'tfis', squad: 'logi', modules: ['remote-armor-repairer'], state: 'active', target: 'tfis-fc' });
    expect(normalizeModuleSwitch({ ships: ['a'], modules: [' mid-2 ', 'Damage Control II'], state: 'offline', delay: 0.5 })).toEqual({ ships: ['a'], modules: ['mid-2', 'Damage Control II'], state: 'offline', delay: 0.5 });
    expect(normalizeModuleSwitch({ ships: ['a'], modules: ['all'], state: 'online', delay: 0 })).toEqual({ ships: ['a'], modules: ['all'], state: 'online' });
  });

  it('requires selectors, a known state and exactly one of ships and fleet', () => {
    expect(catchSceneError(() => normalizeModuleSwitch({ ships: ['a'], modules: [], state: 'on' })).problems).toEqual([
      'switch.modules must be a non-empty array of module selectors: a module key ("mid-2"), a category ("hardener", "remote-armor-repairer", "prop", ...), "turret", "launcher", "all" or a module name',
      'switch.state must be one of active, online, offline'
    ]);
    expect(catchSceneError(() => normalizeModuleSwitch({ modules: ['all', 3], state: 'active', target: '' })).problems).toEqual([
      'switch.modules must be a non-empty array of module selectors: a module key ("mid-2"), a category ("hardener", "remote-armor-repairer", "prop", ...), "turret", "launcher", "all" or a module name',
      'switch.target must be a ship id (or, for turrets, an object id)',
      'switch needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)'
    ]);
    expect(catchSceneError(() => normalizeModuleSwitch({ ships: ['a'], modules: ['all'], state: 'active', delay: 2 })).problems).toEqual(['switch.delay must be a number in [0, 1]: 0 the pilots respond at once, 1 very delayed (up to 10 s)']);
  });

  it('refuses unknown keys and a value that is not an object', () => {
    expect(catchSceneError(() => normalizeModuleSwitch({ ships: ['a'], modules: ['all'], state: 'active', active: true }, 'beat')).problems).toEqual(['beat.active is not a switch_modules field']);
    expect(catchSceneError(() => normalizeModuleSwitch('on')).problems).toEqual(['switch must be an object { ships | fleet [, wing | squad], modules, state, target?, delay? }']);
  });
});
