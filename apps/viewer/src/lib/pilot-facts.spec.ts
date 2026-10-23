import { agilityTimeConstant, TARGET_EFFECT_ATTRIBUTES, type ModuleActivation, type ShipDefense } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import type { ShipFlight } from './flight';
import type { ShipModuleSpec } from './modules';
import { CombatProfileOf, HeadingVectorOf, IncomingRepsOf, RemainingEhpOf, TABLE_PATH_LOCK_RANGE, TackleOn } from './pilot-facts';

const FLIGHT = {
  mass: 1_000_000,
  agility: 3,
  maxVelocity: 400,
  radius: 40,
  signatureRadius: 35,
  alignTime: 4,
  warpSpeed: 5,
  source: 'hub',
  math: 'dogma',
  warpScrambleStatus: 0,
  propMod: { mass: 1_500_000, maxVelocity: 2400, signatureRadius: 180, alignTime: 6, kind: 'microwarpdrive' },
  targeting: { maxTargetRange: 30_000, scanResolution: 700, maxLockedTargets: 5 },
  defense: { ehp: 3000 }
} as unknown as ShipFlight;

function specOf(key: string, activation: Partial<ModuleActivation>, extra: Partial<ShipModuleSpec> = {}): ShipModuleSpec {
  return { key, name: key, typeID: 1, offline: false, activation: { refusal: null, targeted: true, cycleTime: 5, range: null, falloff: null, ...activation } as ModuleActivation, ...extra };
}

const WEB = specOf('web', { category: 'web', range: 10_000, targetEffect: { effect: 'web', modifiers: [{ attributeID: TARGET_EFFECT_ATTRIBUTES.maxVelocity, operation: 6, amount: -60 }] } });

const SCRAM = specOf('scram', { category: 'scram', range: 9000, targetEffect: { effect: 'scram', modifiers: [], blocksMicrowarpdrive: true } });

const REP = specOf('rep', { category: 'remote-armor-repairer', range: 7000, falloff: 3000, repair: { layer: 'armor', amount: 400, remote: true } });

describe('CombatProfileOf', () => {
  it('reads the flight off and on, tackle, reps and lock range', () => {
    const profile = CombatProfileOf({ flight: FLIGHT, specs: [WEB, SCRAM, REP, specOf('point', { category: 'point', range: 24_000 }, { offline: true })], maxHp: 2000 });
    expect(profile?.flight).toEqual({ speed: 400, signature: 35, tau: agilityTimeConstant(1_000_000, 3) });
    expect(profile?.propMod).toEqual({ kind: 'mwd', speed: 2400, signature: 180, tau: agilityTimeConstant(1_500_000, 3) });
    expect(profile?.tackle).toEqual({ scram: 9000, web: 10_000, webFactor: 0.4 });
    expect(profile?.reps).toEqual([{ layer: 'armor', hps: 80, optimal: 7000, falloff: 3000 }]);
    expect(profile).toMatchObject({ radius: 40, ehp: 3000, lockRange: 30_000, weapons: [] });
  });

  it('is null while the flight is pending; the table path locks at TABLE_PATH_LOCK_RANGE with EHP as HP', () => {
    expect(CombatProfileOf({ flight: null, specs: [], maxHp: 1 })).toBeNull();
    const table = CombatProfileOf({ flight: { ...FLIGHT, targeting: undefined, defense: undefined, propMod: undefined }, specs: [], maxHp: 2000 });
    expect(table).toMatchObject({ lockRange: TABLE_PATH_LOCK_RANGE, ehp: 2000, propMod: null });
  });
});

describe('TackleOn', () => {
  it('reads a scram and webs at their applied effectiveness', () => {
    expect(TackleOn([])).toEqual({ scrammed: false, webFactor: 1 });
    const tackle = TackleOn([
      { from: 'a', spec: SCRAM, effectiveness: 1, applied: 1 },
      { from: 'b', spec: WEB, effectiveness: 1, applied: 1 },
      { from: 'c', spec: WEB, effectiveness: 0.5, applied: 0.5 }
    ]);
    expect(tackle.scrammed).toBe(true);
    expect(tackle.webFactor).toBeCloseTo(0.4 * 0.7, 6);
  });
});

describe('RemainingEhpOf and IncomingRepsOf', () => {
  it('weighs each layer by its EHP over HP', () => {
    const defense = { shield: { hp: 100, ehp: 200 }, armor: { hp: 100, ehp: 100 }, structure: { hp: 100, ehp: 150 } } as unknown as ShipDefense;
    const health = { shield: { hp: 50, max: 100 }, armor: { hp: 100, max: 100 }, structure: { hp: 100, max: 100 } };
    expect(RemainingEhpOf(health, defense)).toBe(100 + 100 + 150);
    expect(RemainingEhpOf(health, null)).toBe(250);
    expect(IncomingRepsOf([{ spec: REP, effectiveness: 0.5 }])).toBe(40);
  });

  it('turns a heading into the nose vector', () => {
    const [x, y, z] = HeadingVectorOf([90, 0]);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });
});
