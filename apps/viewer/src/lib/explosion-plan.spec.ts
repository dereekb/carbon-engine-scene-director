import { SHIP_EXPLOSIONS } from '@scene-director/scene';
import { describe, expect, it, vi } from 'vitest';
import { EXPLOSION_LINGER_MARGIN_SECONDS, ExplosionFileFacts, ExplosionFiles, ExplosionRemoveTick, ExplosionSchedule } from './explosion-plan';
import type { CjsModelValues } from './runtime';

const Sound = (name: string, event: string) => ({
  _type: 'TriCurveSet',
  curves: [{ _type: 'AudEventCurve', name, keys: [{ _type: 'AudEventKey', value: event }, { _type: 'AudEventKey' }], sourceTriObserver: { _type: 'TriObserverLocal', observer: { _type: 'AudEmitter', name: `${name}Emitter` } } }]
});

// Shaped like ecx_generic_explosive_short_01a.black (tools-core ?format=json, build 3632936), particles left out.
const SHORT = {
  _type: 'EveEffectRoot2',
  name: 'ecx_generic_explosive_short_01a',
  effectChildren: [
    {
      _type: 'EveChildExplosion',
      localExplosions: [{ _type: 'EveChildContainer', curveSets: [{ _type: 'TriCurveSet', curves: [] }, Sound('local', 'ecx_generic_explosive_short_individual_01a_play')] }],
      localExplosionShared: { _type: 'EveChildContainer' },
      globalExplosion: { _type: 'EveChildContainer', curveSets: [Sound('global', 'ecx_generic_explosive_short_global_01a_play')] },
      localExplosionInterval: 0.1,
      localExplosionIntervalFactor: 0.966,
      globalExplosionDelay: 1.5,
      localDuration: 15,
      globalDuration: 13
    }
  ]
} as unknown as CjsModelValues;

// Shaped like ecx_triglavian_explosive_tgdn01_t1.black: the older single localExplosion and globalExplosions list.
const TGDN = {
  _type: 'EveEffectRoot2',
  effectChildren: [
    {
      _type: 'EveChildExplosion',
      localExplosion: { _type: 'EveChildContainer', curveSets: [Sound('local_explosion_sfx', 'triglavian_structure_individual_explosion_play')] },
      globalExplosions: [{ _type: 'EveChildContainer' }, { _type: 'EveChildContainer' }],
      localExplosionInterval: 0.42,
      localExplosionIntervalFactor: 0.98,
      localDuration: 15,
      globalDuration: 38
    }
  ]
} as unknown as CjsModelValues;

describe('ExplosionFileFacts', () => {
  it('reads the timing values and the local and global sound events', () => {
    expect(ExplosionFileFacts(SHORT)).toEqual({
      timing: { localExplosionInterval: 0.1, localExplosionIntervalFactor: 0.966, localExplosionDelay: 0, globalExplosionDelay: 1.5, localDuration: 15, globalDuration: 13, wreckSwitchOffsetFromGlobalStart: 0 },
      localEvents: ['ecx_generic_explosive_short_individual_01a_play'],
      globalEvents: ['ecx_generic_explosive_short_global_01a_play'],
      variants: 1,
      members: 'list'
    });
  });

  it("reads the older single members, the runtime's defaults where the file has none", () => {
    expect(ExplosionFileFacts(TGDN)).toMatchObject({
      timing: { localExplosionDelay: 0, globalExplosionDelay: 0, globalDuration: 38 },
      localEvents: ['triglavian_structure_individual_explosion_play'],
      globalEvents: [],
      variants: 1,
      members: 'single'
    });
  });

  it('answers null without an EveChildExplosion', () => {
    expect(ExplosionFileFacts({ _type: 'EveEffectRoot2', effectChildren: [] })).toBeNull();
    expect(ExplosionFileFacts(null)).toBeNull();
  });
});

describe('ExplosionFiles', () => {
  it('loads each path once and keeps a failure until ForgetFailures', async () => {
    const read = vi.fn(async (path: string): Promise<CjsModelValues> => {
      if (path === 'bad') return { _type: 'EveTransform' } as unknown as CjsModelValues;
      return SHORT;
    });
    const files = new ExplosionFiles({ read });
    const [a, b] = await Promise.all([files.Load('short'), files.Load('short')]);
    expect(a).toBe(b);
    expect(files.Cached('short')?.facts.globalEvents).toEqual(['ecx_generic_explosive_short_global_01a_play']);
    expect(read).toHaveBeenCalledTimes(1);

    await expect(files.Load('bad')).rejects.toThrow('bad is a EveTransform, not an EveEffectRoot2');
    await expect(files.Load('bad')).rejects.toThrow('not an EveEffectRoot2');
    expect(read).toHaveBeenCalledTimes(2);
    expect(files.Failure('bad')).toBe('bad is a EveTransform, not an EveEffectRoot2');
    files.ForgetFailures();
    await expect(files.Load('bad')).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('ExplosionSchedule', () => {
  it('posts the local event at the start and the global one after the delays, and removes the ball after the linger', () => {
    const facts = ExplosionFileFacts(SHORT);
    const short = SHIP_EXPLOSIONS.S[0];
    expect(short.lingerSeconds).toBe(16);
    const times = ExplosionSchedule({ start: 100.4, facts, deathTick: 50, lingerSeconds: short.lingerSeconds, tickSeconds: 1 });
    expect(times).toEqual({
      start: 100.4,
      hide: 101.9,
      end: 116.4,
      removeTick: 50 + 16 + EXPLOSION_LINGER_MARGIN_SECONDS,
      sounds: [
        { at: 100.4, part: 'local', event: 'ecx_generic_explosive_short_individual_01a_play' },
        { at: 101.9, part: 'global', event: 'ecx_generic_explosive_short_global_01a_play' }
      ]
    });
  });

  it('without facts posts nothing and hides at the start; the removal tick rounds up', () => {
    expect(ExplosionSchedule({ start: 3, facts: null, deathTick: 10, lingerSeconds: 21, tickSeconds: 1 })).toMatchObject({ hide: 3, sounds: [], removeTick: 33 });
    expect(ExplosionRemoveTick(10, 21, 0.5)).toBe(56);
    expect(ExplosionRemoveTick(10, 21.2, 1)).toBe(34);
  });
});
