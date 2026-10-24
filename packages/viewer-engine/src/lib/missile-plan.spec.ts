import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './clock';
import { MISSILE_IMPACT_DEFAULT_DURATION, MissileDrawPlan, MissileFileFacts, MissileFiles, type MissileDrawProbe } from './missile-plan';
import type { CjsModelValues } from './runtime';

// The decoded files' shapes (SDE 3632936): heavy_missile.black and heavy_impact_scourge.black, trimmed.
const PROJECTILE = { _type: 'EveMissile', name: 'heavy_missile', warheads: [{ _type: 'EveMissileWarhead', maxExplosionDistance: 85, impactSize: 1.5, impactDuration: 1.2 }] };
const IMPACT = {
  _type: 'EveEffectRoot2',
  duration: 6,
  observers: [{ _type: 'TriObserverLocal', observer: { _type: 'AudEmitter', name: 'missile_impact_sfx' } }],
  controllers: [
    {
      _type: 'Tr2Controller',
      name: 'explosion_ctrl',
      stateMachines: [{ _type: 'Tr2StateMachine', states: [{ _type: 'Tr2StateMachineState', actions: [{ _type: 'Tr2ActionPlaySound', emitter: 'missile_impact_sfx', event: 'missile_explosion_kinetic_medium_play' }] }] }]
    }
  ]
};
const SECOND = TICKS_PER_SECOND;

function Probe(state: { balls?: Set<string>; dead?: Set<string> } = {}): MissileDrawProbe & { balls: Set<string>; dead: Set<string>; reached: Set<string>; passed: Set<string> } {
  const balls = state.balls ?? new Set<string>();
  const dead = state.dead ?? new Set<string>();
  const reached = new Set<string>();
  const passed = new Set<string>();
  return { balls, dead, reached, passed, BallLive: (id) => balls.has(id), Reached: (id) => reached.has(id), Passed: (id) => passed.has(id), Dead: (id) => dead.has(id) };
}

describe('MissileFileFacts', () => {
  it('reads the warheads, the impact duration and its Tr2ActionPlaySound events', () => {
    expect(MissileFileFacts(PROJECTILE, IMPACT)).toEqual({ warheads: 1, impactDuration: 6, impactEvents: ['missile_explosion_kinetic_medium_play'] });
  });

  it("adds an AudEventCurve's events after the actions, and defaults a missing duration", () => {
    const impact = { ...IMPACT, duration: -1, curveSets: [{ _type: 'TriCurveSet', curves: [{ _type: 'AudEventCurve', keys: [{ value: 'missile_explosion_em_medium_play' }] }] }] };
    expect(MissileFileFacts({}, impact)).toEqual({ warheads: 0, impactDuration: MISSILE_IMPACT_DEFAULT_DURATION, impactEvents: ['missile_explosion_kinetic_medium_play', 'missile_explosion_em_medium_play'] });
  });
});

describe('MissileFiles', () => {
  const graphic = { projectileResPath: 'res:/dx9/model/missile/heavy_missile.black', impactResPath: 'res:/fisfx/impact/missile/heavy_impact_scourge.black' };

  it('loads a pair once and keeps a failure until ForgetFailures', async () => {
    const reads: string[] = [];
    let broken = true;
    const files = new MissileFiles({
      read: (path) => {
        reads.push(path);
        if (broken && path.includes('impact')) return Promise.resolve({ _type: 'EveTransform' } as CjsModelValues);
        return Promise.resolve((path.includes('impact') ? IMPACT : PROJECTILE) as CjsModelValues);
      }
    });
    await expect(files.Load(graphic)).rejects.toThrow('not an EveEffectRoot2');
    expect(files.Failure(graphic)).toContain('not an EveEffectRoot2');
    await expect(files.Load(graphic)).rejects.toThrow();
    expect(reads).toHaveLength(2);
    broken = false;
    files.ForgetFailures();
    const [first, second] = await Promise.all([files.Load(graphic), files.Load(graphic)]);
    expect(second).toBe(first);
    expect(first.facts.impactEvents).toEqual(['missile_explosion_kinetic_medium_play']);
    expect(files.Cached(graphic)).toBe(first);
    expect(reads).toHaveLength(4);
  });
});

describe('MissileDrawPlan', () => {
  it('starts at the burst start, plays a hit detonated by the runtime, then removes it', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['m']) });
    expect(plan.Launch('m', 10 * SECOND, 6)).toBe(true);
    expect(plan.Frame(9 * SECOND, probe).start).toEqual([]);
    expect(plan.Frame(10 * SECOND, probe).start).toEqual(['m']);
    expect(plan.Hit('m', 12 * SECOND)).toBe(true);
    plan.Detonated('m', [1, 2, 3]);
    const commands = plan.Frame(12.2 * SECOND, probe);
    expect(commands.impacts).toEqual([{ id: 'm', position: [1, 2, 3], draw: true, token: 1 }]);
    expect(commands.force).toEqual([]);
    probe.dead.add('m');
    expect(plan.Frame(12.3 * SECOND, probe).remove).toEqual(['m']);
    expect(plan.Ids()).toEqual([]);
    expect(plan.Frame(18.1 * SECOND, probe).impactsEnded).toEqual([]);
    expect(plan.Frame(18.2 * SECOND, probe).impactsEnded).toEqual([1]);
    expect(plan.Report()).toMatchObject({ live: 0, impacts: 0, detonated: 1, vanished: 0, forced: 0, skipped: 0 });
  });

  it('plays a detonation that came before its master hit once the hit is known, and keeps it past its removal', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['m']) });
    plan.Launch('m', 0, 6);
    plan.Frame(0, probe);
    plan.Detonated('m', [5, 0, 0]);
    probe.dead.add('m');
    expect(plan.Frame(SECOND, probe)).toMatchObject({ impacts: [], remove: ['m'] });
    expect(plan.Ids()).toEqual(['m']);
    plan.Hit('m', 1.5 * SECOND);
    expect(plan.Frame(1.5 * SECOND, probe).impacts).toEqual([{ id: 'm', position: [5, 0, 0], draw: true, token: 1 }]);
    expect(plan.Ids()).toEqual([]);
  });

  it("plays an arrived missile's detonation at once, before its master hit is drained", () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['m']) });
    plan.Launch('m', 0, 6);
    plan.Frame(0, probe);
    probe.reached.add('m');
    expect(plan.Frame(2 * SECOND, probe).arrive).toEqual(['m']);
    plan.Detonated('m', [3, 0, 0]);
    expect(plan.Frame(2.5 * SECOND, probe).impacts).toEqual([{ id: 'm', position: [3, 0, 0], draw: true, token: 1 }]);
    expect(plan.HitKnown('m')).toBe(false);
    // Its hit, drained later, finds it played.
    expect(plan.Hit('m', 3 * SECOND)).toBe(false);
    expect(plan.Report()).toMatchObject({ detonated: 1 });
  });

  it('vanishes an expired or lost flight at its drawn end, silently', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['m']) });
    plan.Launch('m', 0, 6);
    plan.Frame(0, probe);
    plan.Vanish('m', 8 * SECOND);
    expect(plan.Frame(7.9 * SECOND, probe).vanish).toEqual([]);
    expect(plan.Frame(8 * SECOND, probe).vanish).toEqual(['m']);
    expect(plan.StateOf('m')).toBe('ending');
    plan.Detonated('m', [0, 0, 0]);
    probe.dead.add('m');
    const commands = plan.Frame(8.1 * SECOND, probe);
    expect(commands.impacts).toEqual([]);
    expect(commands.remove).toEqual(['m']);
    expect(plan.Report()).toMatchObject({ vanished: 1, detonated: 0 });
  });

  it('arrives once its ball reaches the target (hit known or not), or passes it with its hit known', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['a', 'b', 'c']) });
    for (const id of ['a', 'b', 'c']) plan.Launch(id, 0, 6);
    plan.Frame(0, probe);
    probe.reached.add('a');
    probe.passed.add('b');
    // The drawn ball reaches its target before the master hit is drained: it arrives then.
    expect(plan.Frame(SECOND, probe).arrive).toEqual(['a']);
    expect(plan.Frame(1.1 * SECOND, probe).arrive).toEqual([]);
    plan.Hit('b', 1.5 * SECOND);
    expect(plan.Frame(1.5 * SECOND, probe).arrive).toEqual(['b']);
    // A vanishing flight never arrives.
    plan.Vanish('c', 1.6 * SECOND);
    probe.reached.add('c');
    expect(plan.Frame(1.6 * SECOND, probe)).toMatchObject({ arrive: [], vanish: ['c'] });
    // An arrived missile holds its own curve: its ball leaving freezes only the vanishing one.
    probe.balls.clear();
    expect(plan.Frame(2 * SECOND, probe)).toMatchObject({ arrive: [], freeze: ['c'] });
  });

  it('forces a hit not detonated two ticks after its draw time, and plays its impact where it explodes', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['m']) });
    plan.Launch('m', 0, 6);
    plan.Frame(0, probe);
    plan.Hit('m', 5 * SECOND);
    probe.reached.add('m');
    expect(plan.Frame(5 * SECOND, probe)).toMatchObject({ arrive: ['m'], force: [] });
    expect(plan.Frame(6.9 * SECOND, probe).force).toEqual([]);
    expect(plan.Frame(7 * SECOND, probe).force).toEqual(['m']);
    expect(plan.Frame(7.1 * SECOND, probe).force).toEqual([]);
    plan.Detonated('m', [9, 9, 9]);
    expect(plan.Frame(7.2 * SECOND, probe).impacts).toMatchObject([{ id: 'm', position: [9, 9, 9], draw: true }]);
    expect(plan.Report()).toMatchObject({ forced: 1, detonated: 1 });
  });

  it('freezes a live missile whose ball left: silent without a hit, with its impact once a hit is known', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['a', 'b']) });
    plan.Launch('a', 0, 6);
    plan.Launch('b', 0, 6);
    plan.Frame(0, probe);
    probe.balls.clear();
    expect(plan.Frame(SECOND, probe).freeze).toEqual(['a', 'b']);
    expect(plan.Frame(1.1 * SECOND, probe).freeze).toEqual([]);
    plan.Hit('b', 1.2 * SECOND);
    plan.Detonated('a', [1, 0, 0]);
    plan.Detonated('b', [2, 0, 0]);
    expect(plan.Frame(1.3 * SECOND, probe).impacts.map((impact) => impact.id)).toEqual(['b']);
    expect(plan.Report()).toMatchObject({ frozen: 2, detonated: 1 });
  });

  it('caps live missiles (over it flown undrawn: skipped) and impacts (over it: no effect, sound and kill still play)', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1, maxLive: 2, maxImpacts: 1 });
    const probe = Probe({ balls: new Set(['a', 'b']) });
    expect([plan.Launch('a', 0, 6), plan.Launch('b', 0, 6), plan.Launch('c', 0, 6)]).toEqual([true, true, false]);
    expect(plan.Report()).toMatchObject({ waiting: 2, skipped: 1 });
    expect(plan.Hit('c', SECOND)).toBe(false);
    plan.Frame(0, probe);
    plan.Hit('a', SECOND);
    plan.Hit('b', SECOND);
    plan.Detonated('a', [0, 0, 0]);
    plan.Detonated('b', [0, 0, 0]);
    expect(plan.Frame(SECOND, probe).impacts.map((impact) => [impact.id, impact.draw])).toEqual([
      ['a', true],
      ['b', false]
    ]);
    expect(plan.Report()).toMatchObject({ live: 2, impacts: 1, detonated: 2, impactsSkipped: 1 });
    probe.dead.add('a');
    plan.Frame(1.1 * SECOND, probe);
    expect(plan.Launch('d', 2 * SECOND, 6)).toBe(true);
  });

  it('drops a flight still waiting when it ends or is released, and nulls a live one on Release', () => {
    const plan = new MissileDrawPlan({ tickSeconds: 1 });
    const probe = Probe({ balls: new Set(['a', 'b']) });
    plan.Launch('a', 5 * SECOND, 6);
    plan.Launch('b', 0, 6);
    plan.Frame(0, probe);
    expect(plan.Release('a')).toBe(false);
    expect(plan.Release('b')).toBe(true);
    expect(plan.Release('b')).toBe(false);
    plan.Detonated('b', [0, 0, 0]);
    expect(plan.Frame(SECOND, probe).impacts).toEqual([]);
    expect(plan.Report()).toMatchObject({ skipped: 1 });
    plan.Clear();
    expect(plan.Ids()).toEqual([]);
  });
});
