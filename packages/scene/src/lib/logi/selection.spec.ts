import { describe, expect, it } from 'vitest';
import { falloffEffectiveness } from '../fitting/activation';
import type { AutoRepairPolicy } from './auto-repair';
import { chooseRepairTargets, REPAIR_PRE_LOCKS, type RepairCandidate, type RepairLogi, type RepairModule, repairChoiceWhy, repairModuleHps, type RepairPlan } from './selection';

/**
 * A Large Remote Armor Repairer II on a Guardian at max skills (SDE 3632936): 512 HP per 6 s, 57.6 km + 16.8 km.
 */
const LRAR = (key: string): RepairModule => ({ key, layer: 'armor', amount: 512, cycleTime: 6, range: 57600, falloff: 16800 });

/**
 * A Large Remote Shield Booster II: 680 HP per 8 s, 8.04 km + 12 km.
 */
const LRSB = (key: string): RepairModule => ({ key, layer: 'shield', amount: 680, cycleTime: 8, range: 8040, falloff: 12000 });

/**
 * Two LRAR II: 170.67 HP/s within optimal.
 */
const GUARDIAN_HPS = (2 * 512) / 6;

interface LogiOptions {
  readonly policy?: AutoRepairPolicy;
  readonly modules?: readonly RepairModule[];
  readonly current?: RepairLogi['current'];
  readonly locks?: readonly string[];
  readonly lockRange?: number;
}

/**
 * A Guardian with two LRAR II that locks to 81.25 km.
 *
 * @param id - Its id.
 * @param distances - Metres to each candidate.
 * @param options - Overrides.
 * @returns The logi.
 */
function guardian(id: string, distances: Record<string, number>, options: LogiOptions = {}): RepairLogi {
  return {
    id,
    policy: options.policy ?? 'urgent',
    modules: options.modules ?? [LRAR('m1'), LRAR('m2')],
    lockRange: options.lockRange ?? 81250,
    distances: new Map(Object.entries(distances)),
    current: options.current ?? {},
    locks: new Set(options.locks ?? [])
  };
}

interface MemberOptions {
  readonly shield?: number;
  readonly armor?: number;
  readonly structure?: number;
  readonly taken?: number;
  readonly hostileLocks?: number;
  readonly otherReps?: number;
}

/**
 * A bare Punisher: 438 shield, 625 armor, 563 structure.
 *
 * @param id - Its id.
 * @param options - Its HP left per layer, HP taken over the window, hostile locks and other reps.
 * @returns The candidate.
 */
function punisher(id: string, options: MemberOptions = {}): RepairCandidate {
  return {
    id,
    layers: { shield: { hp: options.shield ?? 438, max: 438 }, armor: { hp: options.armor ?? 625, max: 625 }, structure: { hp: options.structure ?? 563, max: 563 } },
    taken: options.taken ?? 0,
    hostileLocks: options.hostileLocks ?? 0,
    otherReps: options.otherReps ?? 0
  };
}

const at = (distance: number, ids: readonly string[]): Record<string, number> => Object.fromEntries(ids.map((id) => [id, distance]));
const targetsOf = (plans: readonly RepairPlan[]) => Object.fromEntries(plans.map((plan) => [plan.logi, plan.choices.map((choice) => choice.target)]));

describe('chooseRepairTargets', () => {
  it('picks a shot member in range with every rep, at full effectiveness within optimal and less in falloff', () => {
    const [plan] = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033 })], logi: [guardian('g1', { b1: 30000 })] });
    const [choice] = plan.choices;
    expect(choice).toMatchObject({ layer: 'armor', target: 'b1', reason: 'under-fire', kept: false, modules: ['m1', 'm2'], idle: [], pressure: 103.3, reps: 0, distance: 30000 });
    expect(choice.hps).toBeCloseTo(170.67, 2);
    const inFalloff = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033 })], logi: [guardian('g1', { b1: 74400 })] })[0].choices[0];
    expect(inFalloff.hps).toBeCloseTo(GUARDIAN_HPS * falloffEffectiveness({ distance: 74400, range: 57600, falloff: 16800 }), 6);
    expect(inFalloff.hps).toBeCloseTo(GUARDIAN_HPS / 2, 6);
    expect(repairModuleHps(LRAR('m1'), 91201)).toBe(0);
  });

  it('never picks a member past optimal + one falloff new, but keeps an incumbent up to its reach and lock range', () => {
    const candidates = [punisher('b1', { taken: 1033 })];
    const fresh = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 80000 })] })[0].choices[0];
    expect(fresh).toMatchObject({ target: null, reason: 'out-of-range', unreachable: [{ id: 'b1', distance: 80000, pressure: 103.3 }], idle: ['m1', 'm2'], reach: 74400 });
    const kept = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 80000 }, { current: { armor: 'b1' } })] })[0].choices[0];
    expect(kept).toMatchObject({ target: 'b1', kept: true, modules: ['m1', 'm2'] });
    expect(kept.hps).toBeCloseTo(GUARDIAN_HPS * falloffEffectiveness({ distance: 80000, range: 57600, falloff: 16800 }), 6);
    const lost = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 85000 }, { current: { armor: 'b1' } })] })[0].choices[0];
    expect(lost).toMatchObject({ target: null, reason: 'out-of-range' });
    const shortLock = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 30000 }, { lockRange: 20000 })] })[0].choices[0];
    expect(shortLock).toMatchObject({ target: null, reason: 'out-of-range', reach: 20000 });
  });

  it('runs only the reps that reach the target and leaves the rest idle', () => {
    const modules = [LRAR('m1'), { ...LRAR('m2'), range: 10000, falloff: 5000 }];
    const choice = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033 })], logi: [guardian('g1', { b1: 30000 }, { modules })] })[0].choices[0];
    expect(choice).toMatchObject({ target: 'b1', modules: ['m1'], idle: ['m2'] });
    expect(choice.hps).toBeCloseTo(512 / 6, 6);
  });

  it('orders a tier by its policy: urgent the shortest time to live, damaged the lowest HP, shot-at the most damage', () => {
    // a: 200 HP at 50 HP/s (4 s); b: full at 300 HP/s (5.4 s); c: 100 HP at 1 HP/s.
    const candidates = [punisher('a', { shield: 0, armor: 0, structure: 200, taken: 500 }), punisher('b', { taken: 3000 }), punisher('c', { shield: 0, armor: 0, structure: 100, taken: 10 })];
    const pick = (policy: AutoRepairPolicy) => chooseRepairTargets({ candidates, logi: [guardian('g1', at(1000, ['a', 'b', 'c']), { policy })] })[0].choices[0].target;
    expect(pick('urgent')).toBe('a');
    expect(pick('damaged')).toBe('c');
    expect(pick('shot-at')).toBe('b');
  });

  it('spreads logi over split fire, piles them on one heavy primary, and counts reps it does not assign', () => {
    const split = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033 }), punisher('b2', { taken: 1033 })], logi: [guardian('g1', at(1000, ['b1', 'b2'])), guardian('g2', at(1000, ['b1', 'b2']))] });
    expect(targetsOf(split)).toEqual({ g1: ['b1'], g2: ['b2'] });
    const heavy = chooseRepairTargets({ candidates: [punisher('b1', { taken: 4000 }), punisher('b2')], logi: [guardian('g1', at(1000, ['b1', 'b2'])), guardian('g2', at(1000, ['b1', 'b2']))] });
    expect(targetsOf(heavy)).toEqual({ g1: ['b1'], g2: ['b1'] });
    expect(heavy[1].choices[0]).toMatchObject({ reason: 'under-fire' });
    expect(heavy[1].choices[0].reps).toBeCloseTo(GUARDIAN_HPS, 6);
    const covered = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033, otherReps: 200 }), punisher('b2', { taken: 500 })], logi: [guardian('g1', at(1000, ['b1', 'b2']))] });
    expect(targetsOf(covered)).toEqual({ g1: ['b2'] });
    const one = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1033 })], logi: [guardian('g1', at(1000, ['b1'])), guardian('g2', at(1000, ['b1']))] });
    expect(targetsOf(one)).toEqual({ g1: ['b1'], g2: ['b1'] });
    expect(one[1].choices[0].reason).toBe('covering');
  });

  it('keeps its target within a tier below twice the urgency, and switches at twice or for a better tier', () => {
    const both = (b1: number, b2: MemberOptions) => [punisher('b1', { taken: b1 }), punisher('b2', b2)];
    const g1 = guardian('g1', at(1000, ['b1', 'b2']), { current: { armor: 'b2' } });
    const kept = chooseRepairTargets({ candidates: both(1500, { taken: 1000 }), logi: [g1] })[0].choices[0];
    expect(kept).toMatchObject({ target: 'b2', kept: true });
    expect(chooseRepairTargets({ candidates: both(2500, { taken: 1000 }), logi: [g1] })[0].choices[0]).toMatchObject({ target: 'b1', kept: false });
    expect(chooseRepairTargets({ candidates: both(500, { taken: 1000, otherReps: 400 }), logi: [g1] })[0].choices[0]).toMatchObject({ target: 'b1', reason: 'under-fire' });
  });

  it('releases a healed calm target, keeps topping off one below full, and drops one that is gone', () => {
    const current = { armor: 'b1' };
    expect(chooseRepairTargets({ candidates: [punisher('b1')], logi: [guardian('g1', { b1: 1000 }, { current })] })[0].choices[0]).toMatchObject({ target: null, reason: 'idle' });
    expect(chooseRepairTargets({ candidates: [punisher('b1', { armor: 610 })], logi: [guardian('g1', { b1: 1000 }, { current })] })[0].choices[0]).toMatchObject({ target: 'b1', reason: 'topping-off', kept: true });
    expect(chooseRepairTargets({ candidates: [punisher('b1', { armor: 610 })], logi: [guardian('g1', { b1: 1000 })] })[0].choices[0]).toMatchObject({ target: null, reason: 'idle' });
    expect(chooseRepairTargets({ candidates: [punisher('b2', { taken: 100 })], logi: [guardian('g1', { b1: 1000, b2: 1000 }, { current })] })[0].choices[0]).toMatchObject({ target: 'b2', kept: false });
  });

  it('tops off only when nobody in reach is under fire, the lowest layer first', () => {
    const calm = [punisher('b1', { armor: 312 }), punisher('b2', { armor: 500 })];
    expect(chooseRepairTargets({ candidates: calm, logi: [guardian('g1', at(1000, ['b1', 'b2', 'b3']))] })[0].choices[0]).toMatchObject({ target: 'b1', reason: 'topping-off' });
    expect(chooseRepairTargets({ candidates: [...calm, punisher('b3', { taken: 10 })], logi: [guardian('g1', at(1000, ['b1', 'b2', 'b3']))] })[0].choices[0]).toMatchObject({ target: 'b3', reason: 'under-fire' });
  });

  it('chooses for each layer on its own', () => {
    const plan = chooseRepairTargets({ candidates: [punisher('b1', { armor: 300 }), punisher('b2', { shield: 200 })], logi: [guardian('g1', at(1000, ['b1', 'b2']), { modules: [LRAR('m1'), LRSB('s1')] })] })[0];
    expect(plan.choices.map((choice) => [choice.layer, choice.target, choice.modules])).toEqual([
      ['shield', 'b2', ['s1']],
      ['armor', 'b1', ['m1']]
    ]);
  });

  it('pre-locks members under fire or yellow-boxed: held ones first, never its target or itself, within lock range', () => {
    const candidates = [punisher('b1', { taken: 2000 }), punisher('b2', { taken: 500 }), punisher('b3', { hostileLocks: 2 }), punisher('b4', { taken: 800 }), punisher('b5', { taken: 100 }), punisher('g1', { taken: 3000 })];
    const distances = { ...at(1000, ['b1', 'b2', 'b3', 'b5', 'g1']), b4: 90000 };
    const held = chooseRepairTargets({ candidates, logi: [guardian('g1', distances, { locks: ['b5'] })] })[0];
    expect(held.choices[0].target).toBe('b1');
    expect(held.preLocks).toEqual(['b5', 'b2']);
    expect(held.preLocks).toHaveLength(REPAIR_PRE_LOCKS);
    const fresh = chooseRepairTargets({ candidates: candidates.filter((candidate) => candidate.id !== 'b2'), logi: [guardian('g1', distances)] })[0];
    expect(fresh.preLocks).toEqual(['b5', 'b3']);
  });

  it('is deterministic: candidate order does not change the plans', () => {
    const candidates = [punisher('b1', { taken: 1033 }), punisher('b2', { taken: 1033 }), punisher('b3', { armor: 100 }), punisher('b4', { hostileLocks: 1 })];
    const logi = [guardian('g1', at(1000, ['b1', 'b2', 'b3', 'b4'])), guardian('g2', at(1000, ['b1', 'b2', 'b3', 'b4']))];
    const plans = chooseRepairTargets({ candidates, logi });
    expect(chooseRepairTargets({ candidates: [...candidates].reverse(), logi })).toEqual(plans);
    expect(chooseRepairTargets({ candidates: [candidates[2], candidates[0], candidates[3], candidates[1]], logi })).toEqual(plans);
  });
});

describe('repairChoiceWhy', () => {
  it('says why in every reason', () => {
    const candidates = [punisher('b1', { taken: 1033 })];
    const [first, second] = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 1000 }), guardian('g2', { b1: 1000 })] });
    expect(repairChoiceWhy(first.choices[0], 'urgent')).toBe('"b1" is under fire: 103.3 HP/s against 0.0 HP/s of reps, about 16 s to live');
    expect(repairChoiceWhy(first.choices[0], 'damaged')).toBe('"b1" is under fire: 103.3 HP/s against 0.0 HP/s of reps, about 16 s to live, 100 % of its HP left');
    expect(repairChoiceWhy(first.choices[0], 'shot-at')).toBe('"b1" is under fire: 103.3 HP/s against 0.0 HP/s of reps');
    expect(repairChoiceWhy(second.choices[0], 'urgent')).toBe('"b1" is under fire and covered (341.3 of 103.3 HP/s); no member needs it more');
    const topOff = chooseRepairTargets({ candidates: [punisher('b1', { armor: 312.5 })], logi: [guardian('g1', { b1: 1000 }, { current: { armor: 'b1' } })] })[0].choices[0];
    expect(repairChoiceWhy(topOff, 'urgent')).toBe('"b1" is calm with armor at 50 % (kept: it still needs reps)');
    const idle = chooseRepairTargets({ candidates: [punisher('b1')], logi: [guardian('g1', { b1: 1000 })] })[0].choices[0];
    expect(repairChoiceWhy(idle, 'urgent')).toBe('no fleet member in reach needs reps');
    const far = chooseRepairTargets({ candidates, logi: [guardian('g1', { b1: 80000 })] })[0].choices[0];
    expect(repairChoiceWhy(far, 'urgent')).toBe('"b1" is under fire 80.0 km off; its reps reach 74.4 km');
    const covered = chooseRepairTargets({ candidates: [punisher('b1', { taken: 1000, otherReps: 110 })], logi: [guardian('g1', { b1: 1000 })] })[0].choices[0];
    expect(repairChoiceWhy(covered, 'urgent')).toBe('"b1" is under fire: 100.0 HP/s against 110.0 HP/s of reps, short of 125 % cover');
  });
});
