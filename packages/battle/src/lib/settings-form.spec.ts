import { describe, expect, it } from 'vitest';
import { fromFleetSettingsFormValue, toFleetSettingsFormValue, toRetreat } from './settings-form';

describe('toFleetSettingsFormValue', () => {
  it('reads a base name as the doctrine', () => {
    expect(toFleetSettingsFormValue({ personality: 'kiter' })).toEqual({ doctrine: 'kiter' });
  });

  it('defaults the doctrine to line', () => {
    expect(toFleetSettingsFormValue()).toEqual({ doctrine: 'line' });
  });

  it('reads a template, the logi settings and the retreat', () => {
    const value = toFleetSettingsFormValue({
      personality: { extends: 'brawler', engage: 'in-range', movement: { stance: 'kite', range: 25_000, propMods: 'always' }, targeting: { calls: false, freeFire: true, priority: ['logi', 'dps'], reach: 'lock', queue: 2 }, command: { backups: 1 } },
      logi: { formation: 'loose', autoRepair: { on: true, policy: 'urgent' } },
      retreat: [1, 2, 3]
    });

    expect(value).toEqual({
      doctrine: 'brawler',
      engage: 'in-range',
      stance: 'kite',
      range: 'metres',
      rangeMetres: 25_000,
      propMods: 'always',
      fire: 'free',
      priority: 'logi, dps',
      reach: 'lock',
      queue: 2,
      backups: 1,
      logiFormation: 'loose',
      autoRepair: true,
      autoRepairPolicy: 'urgent',
      retreat: '1, 2, 3'
    });
  });
});

describe('fromFleetSettingsFormValue', () => {
  it('makes a template extending the doctrine with only the fields set', () => {
    expect(fromFleetSettingsFormValue({ doctrine: 'sniper', stance: '', range: 'metres', rangeMetres: 40_000, fire: 'focus-free', priority: ' logi , ,dps', reach: 'metres', reachMetres: 60_000 })).toEqual({
      personality: { extends: 'sniper', movement: { range: 40_000 }, targeting: { calls: true, freeFire: true, priority: ['logi', 'dps'], reach: 60_000 } }
    });
  });

  it('keeps the logi settings and the retreat', () => {
    expect(fromFleetSettingsFormValue({ doctrine: 'line', logiFormation: 'follow', autoRepair: false, retreat: 'away' })).toEqual({ personality: { extends: 'line' }, logi: { formation: 'follow', autoRepair: { on: false } }, retreat: 'away' });
  });

  it('round-trips a form value', () => {
    const settings = { personality: { extends: 'kiter', engage: 'on-sight', movement: { stance: 'snipe' }, targeting: { calls: true, freeFire: false, switch: 'on-kill' } }, retreat: 'Jita IV - Moon 4' };

    expect(fromFleetSettingsFormValue(toFleetSettingsFormValue(settings))).toEqual(settings);
  });
});

describe('toRetreat', () => {
  it('reads away, a point and a name', () => {
    expect(toRetreat('away')).toBe('away');
    expect(toRetreat(' 100, -2e5, 0 ')).toEqual([100, -200_000, 0]);
    expect(toRetreat('Perimeter gate')).toBe('Perimeter gate');
    expect(toRetreat('  ')).toBeUndefined();
  });
});
