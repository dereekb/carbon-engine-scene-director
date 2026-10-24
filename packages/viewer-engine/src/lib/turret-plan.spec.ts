import { describe, expect, it, vi } from 'vitest';
import type { WeaponGraphic } from '@scene-director/scene';
import type { ShipFitModule } from './fittings';
import type { CjsModelValues } from './runtime';
import { HighIndexOf, TurretFileFacts, TurretFiles, TurretMountsKey, TurretMountsOf } from './turret-plan';

const CANNON: WeaponGraphic = { typeID: 2929, name: '800mm Repeating Cannon II', kind: 'turret', slot: 'turrets', size: 3, resPath: 'res:/dx9/model/turret/projectile/auto/l/auto_800mm_t1.black', sofFactionName: 'brutor' };
const VORTON: WeaponGraphic = { typeID: 54748, name: 'Medium Vorton Projector II', kind: 'turret', slot: 'chains', size: 2, resPath: 'res:/dx9/model/turret/vorton/m/vorton_m_t1.black' };

// Shaped like the decoded 425mm AutoCannon files (SDE 3632936).
const TURRET: CjsModelValues = {
  _type: 'EveTurretSet',
  name: 'Auto_425mm_T1',
  locatorName: 'locator_turret_',
  firingEffectResPath: 'res:/dx9/model/turret/projectile/auto/m/auto_425mm_fx.red',
  turretMovementObserver: { _type: 'TriObserverLocal', name: 'TurretMovement', observer: { _type: 'AudEmitter', name: 'TurretMovement' } },
  idleToTargetingMovementAudioEvent: 'turret_move_projectile_out_medium',
  targetingToIdleMovementAudioEvent: 'turret_move_projectile_in_medium'
};
const FX: CjsModelValues = {
  _type: 'EveTurretFiringFX',
  stretch: [],
  startCurveSet: {
    _type: 'TriCurveSet',
    name: 'play_start',
    curves: [
      {
        _type: 'AudEventCurve',
        name: 'PlayTurretFX',
        keys: [
          { _type: 'AudEventKey', value: 'ship_turret_mp3_play' },
          { _type: 'AudEventKey', time: 1 }
        ],
        sourceTriObserver: { _type: 'TriObserverLocal', observer: { _type: 'AudEmitter', name: 'TurretFX' } }
      },
      {
        _type: 'AudEventCurve',
        name: 'PlayTurretImpact',
        keys: [
          { _type: 'AudEventKey', value: 'ship_impact_mp3_play' },
          { _type: 'AudEventKey', time: 1 }
        ],
        sourceTriObserver: { _type: 'TriObserverLocal', observer: { _type: 'AudEmitter', name: 'TurretImpact' } }
      },
      { _type: 'Tr2CurveScalar', name: 'Fade', keys: [{ time: 0, value: 1 }] }
    ]
  }
};

function Module(key: string, name: string, typeID: number | null, weapon?: 'turret' | 'launcher', extra: Partial<ShipFitModule> = {}): ShipFitModule {
  return { key, name, typeID, groupID: null, slot: 'high', category: weapon ? 'weapon' : 'other', line: 0, ...(weapon ? { weapon } : {}), ...extra } as ShipFitModule;
}

describe('TurretMountsOf', () => {
  it('mounts every weapon with a graphic, offline ones included, in key order, and skips the rest', () => {
    const modules = [
      Module('high-7', '800mm Repeating Cannon II', 2929, 'turret'),
      Module('high-2', 'Heavy Energy Neutralizer II', 12271),
      Module('high-0', '800mm Repeating Cannon II', 2929, 'turret', { offline: true }),
      Module('high-1', 'Medium Vorton Projector II', 54748, 'turret'),
      Module('high-3', 'Unresolved Gun', null, 'turret'),
      Module('high-4', 'Pending Gun', 9999, 'turret')
    ];
    const graphics = new Map([
      [2929, CANNON],
      [54748, VORTON]
    ]);
    const mounts = TurretMountsOf({ modules }, (typeID) => graphics.get(typeID) ?? null);
    expect(mounts.map((mount) => [mount.key, mount.highIndex, mount.faction])).toEqual([
      ['high-0', 0, 'brutor'],
      ['high-1', 1, null],
      ['high-7', 7, 'brutor']
    ]);
    expect(mounts[0]).toMatchObject({ typeID: 2929, kind: 'turret', resPath: CANNON.resPath, name: '800mm Repeating Cannon II' });
    expect(TurretMountsOf(null, () => CANNON)).toEqual([]);
    expect(HighIndexOf('mid-2')).toBeNull();
  });

  it('keys the mounts so a refit or a new graphic remounts', () => {
    const modules = [Module('high-0', '800mm Repeating Cannon II', 2929, 'turret')];
    const before = TurretMountsKey(TurretMountsOf({ modules }, () => CANNON));
    expect(TurretMountsKey(TurretMountsOf({ modules }, () => CANNON))).toBe(before);
    expect(TurretMountsKey(TurretMountsOf({ modules }, () => ({ ...CANNON, sofFactionName: 'sarum' })))).not.toBe(before);
    expect(TurretMountsKey(TurretMountsOf({ modules: [...modules, Module('high-1', '800mm Repeating Cannon II', 2929, 'turret')] }, () => CANNON))).not.toBe(before);
  });
});

describe('TurretFileFacts', () => {
  it("reads the collection, the firing effect and the files' sound events", () => {
    expect(TurretFileFacts(TURRET, FX)).toEqual({
      locatorName: 'locator_turret_',
      firingEffectResPath: 'res:/dx9/model/turret/projectile/auto/m/auto_425mm_fx.red',
      deployEvent: 'turret_move_projectile_out_medium',
      packEvent: 'turret_move_projectile_in_medium',
      sounds: [
        { curve: 'PlayTurretFX', emitter: 'TurretFX', events: ['ship_turret_mp3_play'] },
        { curve: 'PlayTurretImpact', emitter: 'TurretImpact', events: ['ship_impact_mp3_play'] }
      ],
      fireEvents: ['ship_turret_mp3_play'],
      impactEvents: ['ship_impact_mp3_play']
    });
    expect(TurretFileFacts({ _type: 'EveTurretSet' })).toMatchObject({ locatorName: '', firingEffectResPath: null, sounds: [], fireEvents: [] });
  });
});

describe('TurretFiles', () => {
  it('loads a turret and its firing effect once per path, keeping a failed effect apart', async () => {
    const read = vi.fn((path: string) => (path.endsWith('_fx.red') ? Promise.resolve(FX) : Promise.resolve(TURRET)));
    const files = new TurretFiles({ read });
    expect(files.Cached('res:/a.black')).toBeNull();
    const [first, second] = await Promise.all([files.Load('res:/a.black'), files.Load('res:/a.black')]);
    expect(second).toBe(first);
    expect(read.mock.calls.map(([path]) => path)).toEqual(['res:/a.black', TURRET['firingEffectResPath']]);
    expect(first).toMatchObject({ turret: TURRET, fx: FX, fxError: null });
    expect(first.facts.fireEvents).toEqual(['ship_turret_mp3_play']);
    expect(files.Cached('res:/a.black')).toBe(first);

    const noFx = new TurretFiles({ read: (path) => (path.endsWith('_fx.red') ? Promise.reject(new Error('404')) : Promise.resolve(TURRET)) });
    expect(await noFx.Load('res:/b.black')).toMatchObject({ fx: null, fxError: '404' });
  });

  it('keeps a failed turret until ForgetFailures, and refuses a file that is no turret', async () => {
    let fail = true;
    const read = vi.fn((path: string) => (fail ? Promise.reject(new Error(`${path}: 404`)) : Promise.resolve(path.endsWith('.red') ? FX : TURRET)));
    const files = new TurretFiles({ read });
    await expect(files.Load('res:/c.black')).rejects.toThrow('res:/c.black: 404');
    await expect(files.Load('res:/c.black')).rejects.toThrow('res:/c.black: 404');
    expect(read).toHaveBeenCalledTimes(1);
    expect(files.Failure('res:/c.black')).toBe('res:/c.black: 404');
    fail = false;
    files.ForgetFailures();
    expect((await files.Load('res:/c.black')).facts.locatorName).toBe('locator_turret_');
    const wrong = new TurretFiles({ read: () => Promise.resolve({ _type: 'EveStretch' }) });
    await expect(wrong.Load('res:/d.black')).rejects.toThrow('not an EveTurretSet');
  });
});
