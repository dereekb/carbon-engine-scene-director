import type { Maybe } from '@dereekb/util';
import { combatRoll, type ShipDefense, type ShotTargetKind, type TurretCombatNumbers, type WeaponShot } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { type AccuracyNumbers, type CombatPort, CombatRules, DPS_WINDOW_SECONDS } from './combat';
import { DamageModel } from './damage';

const ONES = { em: 1, thermal: 1, kinetic: 1, explosive: 1 };

function Defense(hp: number): ShipDefense {
  const layer = { hp, resonances: ONES, resists: { em: 0, thermal: 0, kinetic: 0, explosive: 0 }, ehp: hp };
  return { shield: layer, armor: layer, structure: layer, ehp: 3 * hp, shieldRecharge: 0 };
}

const GUN: TurretCombatNumbers = {
  key: 'high-0',
  typeID: 2889,
  name: '200mm AutoCannon II',
  kind: 'tracking',
  damage: { em: 50, thermal: 0, kinetic: 10, explosive: 0 },
  volley: 60,
  cycleTime: 2,
  dps: 30,
  optimal: 750,
  falloff: 9675,
  tracking: 393.75,
  signatureResolution: 40_000
};

class FakePort implements CombatPort {
  readonly tickSeconds = 1;
  chance = 1;
  readonly weapons = new Map<string, TurretCombatNumbers>([['high-0', GUN]]);
  readonly objects = new Set(['astrahus']);
  readonly asked: AccuracyNumbers[] = [];

  Accuracy(_ship: string, _target: string, numbers: AccuracyNumbers): Maybe<{ chance: number; distance: number; angularVelocity: number }> {
    this.asked.push(numbers);
    return { chance: this.chance, distance: 5000, angularVelocity: 0 };
  }

  Speed(): number {
    return 400;
  }

  Weapon(_ship: string, module: string): Maybe<TurretCombatNumbers> {
    return this.weapons.get(module) ?? null;
  }

  SignatureOf(): number {
    return 37;
  }

  KindOf(id: string): Maybe<ShotTargetKind> {
    return this.objects.has(id) ? 'object' : 'ship';
  }
}

function Shot(extra: Partial<WeaponShot> = {}): WeaponShot {
  return { ship: 'rifter', module: 'high-0', typeID: 2889, name: '200mm AutoCannon II', target: 'punisher', targetKind: 'ship', cycle: 1, activation: 1, tick: 10, at: 10, distance: 5000, effectiveness: 1, ...extra };
}

function Rules(hp = 10_000, port = new FakePort()): { rules: CombatRules; damage: DamageModel; port: FakePort; kills: string[]; damaged: string[] } {
  const damage = new DamageModel();
  damage.SetDefense('punisher', Defense(hp));
  damage.SetDefense('rifter', Defense(hp));
  const kills: string[] = [];
  const damaged: string[] = [];
  const rules = new CombatRules({ port, damage, onKill: (kill) => kills.push(`${kill.ship} by ${kill.by}:${kill.module}`), onDamaged: (id) => damaged.push(id) });
  return { rules, damage, port, kills, damaged };
}

describe('CombatRules', () => {
  it('applies a boundary in (at, ship, module) order: the earliest shot kills and the rest overkill', () => {
    const { rules, kills, damaged } = Rules(1);
    const late = Shot({ ship: 'ferox', at: 9.8 });
    const early = Shot({ ship: 'zealot', at: 9.2 });
    const tie = Shot({ ship: 'abaddon', at: 9.8 });
    rules.Resolve([late, early, tie], 10);
    expect(early.fatal).toBe(true);
    expect(early.outcome?.damage).toBeGreaterThan(0);
    expect(tie.outcome?.result).toBe('overkill');
    expect(late.outcome?.result).toBe('overkill');
    expect([late, tie].map((shot) => shot.missed)).toEqual([false, false]);
    expect(kills).toEqual(['punisher by zealot:high-0']);
    expect(damaged).toEqual(['punisher']);
    expect(rules.IsDestroyed('punisher')).toBe(true);
    expect(rules.Kills()[0]).toMatchObject({ ship: 'punisher', by: 'zealot', weapon: '200mm AutoCannon II', tick: 10, at: 9.2, mode: 'explode' });
    expect(rules.Kills()[0].contributors).toEqual([{ ship: 'zealot', damage: 3 }]);
  });

  it('rolls the same for a seed, and differently for another', () => {
    const run = (seed: number): number[] => {
      const { rules, port } = Rules();
      port.chance = 0.6;
      rules.SetCombat({ seed, death: 'flag' });
      const shots = Array.from({ length: 30 }, (_, i) => Shot({ cycle: i + 1, at: i }));
      rules.Resolve(shots, 40);
      return shots.map((shot) => shot.outcome?.quality ?? -1);
    };
    expect(run(1)).toEqual(run(1));
    expect(run(2)).not.toEqual(run(1));
    expect(run(1).some((quality) => quality === 0)).toBe(true);
  });

  it('marks misses, and does EVE damage on hits: quality × base, wrecking at 3 ×', () => {
    const { rules, port } = Rules();
    port.chance = 0;
    const miss = Shot();
    rules.Resolve([miss], 10);
    expect(miss.missed).toBe(true);
    expect(miss.outcome).toMatchObject({ result: 'misses', quality: 0, damage: 0 });
    port.chance = 1;
    const cycles = Array.from({ length: 3000 }, (_, i) => i + 1);
    const wrecking = cycles.find((cycle) => combatRoll(1, { ship: 'rifter', module: 'high-0', activation: 1, cycle, target: 'punisher' }) < 0.01) ?? 0;
    const normal = cycles.find((cycle) => combatRoll(1, { ship: 'rifter', module: 'high-0', activation: 1, cycle, target: 'punisher' }) >= 0.01) ?? 0;
    const wreck = Shot({ cycle: wrecking });
    const hit = Shot({ cycle: normal });
    rules.Resolve([wreck, hit], 11);
    expect(wreck.outcome).toMatchObject({ result: 'wrecks', quality: 3, damage: 180 });
    const roll = combatRoll(1, { ship: 'rifter', module: 'high-0', activation: 1, cycle: normal, target: 'punisher' });
    expect(hit.outcome?.quality).toBeCloseTo(roll + 0.49, 12);
    expect(hit.outcome?.damage).toBeCloseTo(60 * (roll + 0.49), 9);
    expect(port.asked[0]).toEqual({ optimal: 750, falloff: 9675, tracking: 393.75, signatureRadius: 37, signatureResolution: 40_000 });
  });

  it('spills through shield and armor into structure', () => {
    const { rules, damage, port } = Rules(50);
    port.weapons.set('high-0', { ...GUN, damage: { em: 1000, thermal: 0, kinetic: 0, explosive: 0 } });
    const shot = Shot();
    rules.Resolve([shot], 10);
    const { layers } = shot.outcome ?? { layers: null };
    expect(layers?.shield).toBe(50);
    expect(layers?.armor).toBe(50);
    expect(layers?.structure).toBe(50);
    expect(damage.Destroyed('punisher')).toBe(true);
    expect(shot.fatal).toBe(true);
  });

  it('spools a disintegrator per consecutive cycle and resets it on a new activation; vortons apply without a roll', () => {
    const { rules, port } = Rules(1e9);
    port.weapons.set('high-0', { ...GUN, kind: 'disintegrator', falloff: null, spool: { perCycle: 0.07, max: 2.125 } });
    const shots = [1, 2, 3].map((cycle) => Shot({ cycle, at: cycle }));
    rules.Resolve(shots, 10);
    const factors = shots.map((shot) => (shot.outcome?.damage ?? 0) / (60 * (shot.outcome?.quality ?? 1)));
    expect(factors.map((factor) => Math.round(factor * 1000) / 1000)).toEqual([1, 1.07, 1.14]);
    expect(port.asked[0].falloff).toBe(1);
    const again = Shot({ activation: 2, cycle: 1, at: 11 });
    rules.Resolve([again], 11);
    expect((again.outcome?.damage ?? 0) / (60 * (again.outcome?.quality ?? 1))).toBeCloseTo(1, 9);

    port.weapons.set('high-1', { ...GUN, key: 'high-1', kind: 'vorton', falloff: null, tracking: null, signatureResolution: null, optimal: 6000, explosion: { radius: 43, velocity: 190, drf: 0.4 } });
    const vorton = Shot({ module: 'high-1', at: 12 });
    const far = Shot({ module: 'high-1', at: 12.5, distance: 7000 });
    rules.Resolve([vorton, far], 12);
    expect(vorton.outcome?.quality).toBeCloseTo(Math.min(37 / 43, (((37 / 43) * 190) / 400) ** 0.4), 9);
    expect(vorton.outcome?.result).toBe('hits');
    expect(far.outcome).toMatchObject({ result: 'misses', damage: 0 });
  });

  it('rolls an object on range only and does it no damage', () => {
    const { rules } = Rules();
    const shot = Shot({ target: 'astrahus', targetKind: 'object', effectiveness: 1 });
    rules.Resolve([shot], 10);
    expect(shot.missed).toBe(false);
    expect(shot.outcome).toMatchObject({ chance: 1, damage: 0, note: 'objects take no damage' });
    const past = Shot({ target: 'astrahus', targetKind: 'object', effectiveness: 0 });
    rules.Resolve([past], 11);
    expect(past.missed).toBe(true);
  });

  it('flags a dead ship: one kill, no more damage until a load', () => {
    const { rules, damage, kills } = Rules(1);
    rules.SetCombat({ seed: 1, death: 'flag' });
    rules.Resolve([Shot()], 10);
    rules.Resolve([Shot({ cycle: 2, at: 11 })], 11);
    expect(kills).toHaveLength(1);
    expect(rules.Kills()[0].mode).toBe('flag');
    damage.Repair('punisher', 'structure', 1);
    rules.Resolve([Shot({ cycle: 3, at: 12 })], 12);
    expect(damage.Report('punisher')?.structure.hp).toBe(1);
    rules.Clear();
    expect(rules.IsDestroyed('punisher')).toBe(false);
    expect(rules.Kills()).toEqual([]);
  });

  it('keeps a 20 s DPS window and the 3 latest rows fired and taken', () => {
    const { rules } = Rules(1e9);
    for (let cycle = 1; cycle <= 5; cycle++) rules.Resolve([Shot({ cycle, at: cycle * 10, tick: cycle * 10 })], cycle * 10);
    const shooter = rules.Report('rifter', 50);
    const victim = rules.Report('punisher', 50);
    expect(shooter?.shots).toBe(5);
    expect(shooter?.lastHits.map((row) => row.tick)).toEqual([50, 40, 30]);
    expect(shooter?.lastHits[0]).toMatchObject({ target: 'punisher', module: 'high-0', name: '200mm AutoCannon II', layer: 'shield' });
    expect(victim?.lastTaken[0]).toMatchObject({ from: 'rifter' });
    expect(victim?.taken).toBe(shooter?.dealt);
    const recent = (rules.Report('rifter', 50)?.dps.dealt ?? 0) * DPS_WINDOW_SECONDS;
    const last2 = victim?.lastTaken.slice(0, 2).reduce((sum, row) => sum + row.damage, 0) ?? 0;
    // dps is rounded to 0.1 HP/s: 2 HP over the window.
    expect(Math.abs(recent - last2)).toBeLessThan(2);
    expect(rules.Attackers('punisher', 50)).toEqual(['rifter']);
    expect(rules.Attackers('punisher', 100)).toEqual([]);
    expect(rules.Totals()).toEqual({ shots: 5, hits: 5 });
  });
});
