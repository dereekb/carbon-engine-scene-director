import type { Maybe } from '@dereekb/util';
import { combatRoll, type ShipDefense, type ShotTargetKind, type TurretCombatNumbers, type WeaponShot } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { type AccuracyNumbers, type CombatPort, CombatRules, DPS_WINDOW_SECONDS, MISSILE_EXPIRED_NOTE, MISSILE_TARGET_DESTROYED } from './combat';
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
  speed = 400;
  readonly weapons = new Map<string, TurretCombatNumbers>([['high-0', GUN]]);
  readonly objects = new Set(['astrahus']);
  readonly asked: AccuracyNumbers[] = [];

  Accuracy(_ship: string, _target: string, numbers: AccuracyNumbers): Maybe<{ chance: number; distance: number; angularVelocity: number }> {
    this.asked.push(numbers);
    return { chance: this.chance, distance: 5000, angularVelocity: 0 };
  }

  Speed(): number {
    return this.speed;
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
    expect(rules.Totals()).toEqual({ shots: 5, hits: 5, repaired: 0 });
  });
});

// A Caracal's HML II with Scourge Heavy at max skills (plan §1.6): 204.875 kinetic per missile, explosion 105 m,
// 127.5 m/s, drf 0.682.
const SCOURGE = { em: 0, thermal: 0, kinetic: 204.875, explosive: 0 };
const HEAVY_EXPLOSION = { radius: 105, velocity: 127.5, drf: 0.682 };

function MissileShot(extra: Partial<WeaponShot> = {}): WeaponShot {
  return Shot({ ship: 'caracal', module: 'high-1', typeID: 2410, name: 'Heavy Missile Launcher II', distance: 0, at: 9.5, missile: { id: 'caracal|high-1|1|1', launchedAt: 7.2, damage: SCOURGE, explosion: HEAVY_EXPLOSION }, ...extra });
}

describe('CombatRules missiles', () => {
  it("hits a Punisher at rest for 37 / 105 of its damage, through the shield's kinetic resonance", () => {
    const { rules, damage, port, damaged } = Rules();
    port.speed = 0;
    const layer = { hp: 10_000, resonances: { ...ONES, kinetic: 0.6 }, resists: { em: 0, thermal: 0, kinetic: 0.4, explosive: 0 }, ehp: 10_000 };
    damage.SetDefense('punisher', { shield: layer, armor: layer, structure: layer, ehp: 30_000, shieldRecharge: 0 });
    const shot = MissileShot();
    rules.Resolve([shot], 10);
    expect(shot.missed).toBe(false);
    expect(shot.outcome?.result).toBe('hits');
    expect(shot.outcome?.chance).toBeCloseTo(37 / 105, 3);
    expect(shot.outcome?.quality).toBeCloseTo(37 / 105, 3);
    expect(204.875 * (37 / 105)).toBeCloseTo(72.2, 1);
    expect(shot.outcome?.damage).toBeCloseTo(204.875 * (37 / 105) * 0.6, 6);
    expect(port.asked).toEqual([]);
    expect(damaged).toEqual(['punisher']);
    expect(rules.Report('caracal', 10)?.lastHits[0]).toMatchObject({ target: 'punisher', result: 'hits', missile: true, layer: 'shield' });
  });

  it('applies less to a fast target, with no roll', () => {
    const { rules } = Rules();
    const shot = MissileShot();
    rules.Resolve([shot], 10);
    expect(shot.outcome?.quality).toBeCloseTo(((37 / 105) * (127.5 / 400)) ** 0.682, 9);
  });

  it('sorts missile hits with the turret shots: after a turret kill they are overkill, and a killing missile is fatal', () => {
    const turretFirst = Rules(1);
    const turret = Shot({ at: 9.2 });
    const missile = MissileShot({ at: 9.5 });
    turretFirst.rules.Resolve([missile, turret], 10);
    expect(turret.fatal).toBe(true);
    expect(missile.outcome).toMatchObject({ result: 'overkill', damage: 0 });

    const missileFirst = Rules(1);
    const kill = MissileShot({ at: 9.1 });
    missileFirst.rules.Resolve([Shot({ at: 9.2 }), kill], 10);
    expect(kill.fatal).toBe(true);
    expect(missileFirst.rules.Kills()[0]).toMatchObject({ ship: 'punisher', by: 'caracal', module: 'high-1', weapon: 'Heavy Missile Launcher II', at: 9.1 });
    const later = MissileShot({ at: 10.4, tick: 11 });
    missileFirst.rules.Resolve([later], 11);
    expect(later.outcome).toMatchObject({ result: 'overkill', damage: 0 });
  });

  it('records expired and lost missiles with no damage: misses with their note, overkill on a destroyed target', () => {
    const { rules, damaged } = Rules();
    const expired = MissileShot();
    rules.Expire(expired, MISSILE_EXPIRED_NOTE, 20);
    const warped = MissileShot({ missile: { id: 'caracal|high-1|1|2', launchedAt: 8, damage: SCOURGE, explosion: HEAVY_EXPLOSION } });
    rules.Expire(warped, 'its target entered warp', 21);
    const dead = MissileShot();
    rules.Expire(dead, MISSILE_TARGET_DESTROYED, 22);
    expect([expired, warped, dead].map((shot) => [shot.missed, shot.outcome?.result, shot.outcome?.damage])).toEqual([
      [true, 'misses', 0],
      [true, 'misses', 0],
      [false, 'overkill', 0]
    ]);
    expect(damaged).toEqual([]);
    const report = rules.Report('caracal', 22);
    expect(report).toMatchObject({ shots: 3, hits: 1, misses: 2, dealt: 0 });
    expect(report?.lastHits.map((row) => [row.result, row.note, row.missile])).toEqual([
      ['overkill', MISSILE_TARGET_DESTROYED, true],
      ['misses', 'its target entered warp', true],
      ['misses', MISSILE_EXPIRED_NOTE, true]
    ]);
  });

  it('does no damage to an object, or without dogma', () => {
    const { rules } = Rules();
    const object = MissileShot({ target: 'astrahus', targetKind: 'object' });
    const bare = MissileShot({ missile: { id: 'x', launchedAt: 7, damage: null, explosion: null } });
    rules.Resolve([object, bare], 10);
    expect(object.outcome).toMatchObject({ result: 'hits', damage: 0, note: 'objects take no damage' });
    expect(bare.outcome).toMatchObject({ result: 'hits', damage: 0, note: 'no EVE dogma for its weapon: it does no damage' });
  });

  it('tallies repairs received and given with their 20 s windows and latest rows, 0 HP landings included, and forgets them', () => {
    const { rules } = Rules();
    rules.Resolve([Shot({ tick: 10, at: 10 })], 10);
    expect(rules.Report('rifter', 10)?.repairs).toBeUndefined();
    rules.RecordRepair({ ship: 'punisher', from: 'logi', module: 'high-0', layer: 'armor', amount: 300, nominal: 300, tick: 12 });
    rules.RecordRepair({ ship: 'punisher', from: 'logi', module: 'high-1', layer: 'armor', amount: 0, nominal: 511.96, tick: 18 });
    rules.RecordRepair({ ship: 'rifter', from: 'rifter', module: 'low-0', layer: 'armor', amount: 100, nominal: 100, tick: 18 });
    expect(rules.Report('punisher', 18)?.repairs).toEqual({
      received: 300,
      given: 0,
      hps: { received: 300 / DPS_WINDOW_SECONDS, given: 0 },
      lastReceived: [
        { tick: 18, from: 'logi', module: 'high-1', layer: 'armor', amount: 0, nominal: 512 },
        { tick: 12, from: 'logi', module: 'high-0', layer: 'armor', amount: 300, nominal: 300 }
      ]
    });
    expect(rules.Report('logi', 18)).toMatchObject({ dealt: 0, taken: 0, shots: 0, repairs: { received: 0, given: 300, hps: { received: 0, given: 15 }, lastReceived: [] } });
    expect(rules.Report('rifter', 18)?.repairs).toMatchObject({ received: 100, given: 0 });
    expect(rules.Report('punisher', 40)?.repairs).toMatchObject({ received: 300, hps: { received: 0, given: 0 } });
    expect(rules.Totals()).toMatchObject({ shots: 1, repaired: 400 });
    rules.Remove('logi');
    expect(rules.Report('logi', 40)).toBeNull();
    rules.Clear();
    expect(rules.Totals().repaired).toBe(0);
    expect(rules.Report('punisher', 40)).toBeNull();
  });

  it('sums the HP a ship took over the trailing seconds', () => {
    const { rules } = Rules();
    rules.Resolve([Shot({ tick: 10, at: 10 })], 10);
    rules.Resolve([Shot({ tick: 25, at: 25, cycle: 2 })], 25);
    const [second, first] = rules.Report('punisher', 25)?.lastTaken ?? [];
    expect(first.damage).toBeGreaterThan(0);
    expect(rules.TakenSince('punisher', 26, 10)).toBeCloseTo(second.damage, 0);
    expect(rules.TakenSince('punisher', 26, 20)).toBeCloseTo(first.damage + second.damage, 0);
    expect(rules.TakenSince('rifter', 26, 10)).toBe(0);
    expect(rules.TakenSince('nobody', 26, 10)).toBe(0);
  });
});
