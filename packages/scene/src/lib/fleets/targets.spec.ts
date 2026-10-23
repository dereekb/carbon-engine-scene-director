import { describe, expect, it } from 'vitest';
import { applySceneOperations, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import { CELESTIAL_TARGET_REFUSAL } from '../weapons/target';
import { catchSceneError, TFI } from './fleets.spec-helper';
import { normalizeFleets } from './normalize';
import { type CalledTargetStatus, calledTargetsOf, MAX_CALLED_TARGETS, toCalledTargets, toFleetGroupCalls, toShipCallPlans } from './targets';

const RED = ['r1', 'r2', 'r3', 'r4'];
const BLUE = ['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2', 'gfc'];

/**
 * orders.spec.ts's TWO_WINGS (w1 under wc1: a dps squad the FC sits in, commanded by a1, and a logi squad on its lead l1;
 * w2: a tackle squad and an empty one; a second fleet g), plus red ships, a ship in no fleet and an object to call.
 */
const twoWingsInput = (calls: { fleet?: string[]; w1?: string[]; dps?: string[]; logi?: string[]; tackle?: string[]; g?: string[] } = {}) => ({
  ships: [...BLUE, ...RED, 'solo'].map((id) => ({ id, dna: TFI })),
  objects: [{ id: 'astra', dna: TFI }],
  fleets: [
    {
      id: 'f',
      commander: 'fc',
      ...(calls.fleet ? { targets: calls.fleet } : {}),
      wings: [
        {
          id: 'w1',
          commander: 'wc1',
          ...(calls.w1 ? { targets: calls.w1 } : {}),
          squads: [
            { id: 'dps', role: 'dps', commander: 'a1', members: ['fc', 'a1', 'a2', 'a3'], ...(calls.dps ? { targets: calls.dps } : {}) },
            { id: 'logi', role: 'logi', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 }, ...(calls.logi ? { targets: calls.logi } : {}) }
          ]
        },
        {
          id: 'w2',
          squads: [
            { id: 'tackle', role: 'tackle', members: ['b1', 'b2'], ...(calls.tackle ? { targets: calls.tackle } : {}) },
            { id: 'empty', role: 'dps', members: [] }
          ]
        }
      ]
    },
    { id: 'g', commander: 'gfc', ...(calls.g ? { targets: calls.g } : {}) }
  ]
});

const twoWings = (calls: Parameters<typeof twoWingsInput>[0] = {}): SceneDocument => normalizeScene(twoWingsInput(calls)).scene;
const problemsOf = (calls: Parameters<typeof twoWingsInput>[0]) => catchSceneError(() => normalizeScene(twoWingsInput(calls))).problems;
const statuses = (map: Record<string, CalledTargetStatus>) => (id: string) => map[id] ?? 'live';

describe('called targets in the document', () => {
  it('normalizes a list of ship and object ids on a fleet, a wing and a squad, and omits an empty one', () => {
    const scene = twoWings({ fleet: ['r1', 'astra'], w1: ['r2'], dps: ['r3', 'r1'], tackle: [] });
    expect(scene.fleets?.[0].targets).toEqual(['r1', 'astra']);
    expect(scene.fleets?.[0].wings[0].targets).toEqual(['r2']);
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'dps' })).toEqual(['r3', 'r1']);
    expect(scene.fleets?.[0].wings[1].squads[0]).not.toHaveProperty('targets');
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'tackle' })).toEqual([]);
    expect(calledTargetsOf(scene, { fleet: 'x', kind: 'fleet', id: 'x' })).toEqual([]);
  });

  it('refuses unknown ids, celestials, repeats, non-arrays and more than the fleet size', () => {
    expect(problemsOf({ fleet: ['nobody'] })).toEqual(['fleets[0].targets[0] "nobody" is not a ship or object in the scene']);
    expect(problemsOf({ dps: ['celestial:60003760'] })).toEqual([`fleets[0].wings[0].squads[0].targets[0] "celestial:60003760": ${CELESTIAL_TARGET_REFUSAL}`]);
    expect(problemsOf({ w1: ['r1', 'r2', 'r1'] })).toEqual(['fleets[0].wings[0].targets[2] "r1" is called more than once']);
    expect(catchSceneError(() => normalizeScene({ ...twoWingsInput(), fleets: [{ id: 'g', commander: 'gfc', targets: 'r1' }] })).problems).toEqual(["fleets[0].targets must be an array of ship or object ids: the group's called targets, in kill order"]);
    const many = Array.from({ length: MAX_CALLED_TARGETS + 1 }, (_, index) => `x${index}`);
    const shipIds = new Set(many);
    const result = normalizeFleets({ input: [{ id: 'g', commander: 'x0', targets: many }], shipIds, targetIds: shipIds });
    expect(result.problems).toEqual([`fleets[0].targets calls ${MAX_CALLED_TARGETS + 1} targets; at most ${MAX_CALLED_TARGETS} (EVE's fleet size)`]);
  });

  it("keeps one of the group's own ships: membership can change after a call", () => {
    expect(twoWings({ dps: ['a2'] }).fleets?.[0].wings[0].squads[0].targets).toEqual(['a2']);
  });

  it('checks existence only against targetIds (add_ships normalizes one fleet against ship ids)', () => {
    const fleet = { id: 'g', commander: 'gfc', targets: ['astra'] };
    expect(normalizeFleets({ input: [fleet], shipIds: new Set(['gfc']) }).problems).toEqual([]);
    expect(normalizeFleets({ input: [fleet], shipIds: new Set(['gfc']), targetIds: new Set(['gfc']) }).problems).toEqual(['fleets[0].targets[0] "astra" is not a ship or object in the scene']);
  });

  it('is edited with update_fleet, update_wing and update_squad set (null clears) and add_* objects', () => {
    let scene = applySceneOperations(twoWings(), [{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: ['r1', 'r2'] } }]).scene;
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'dps' })).toEqual(['r1', 'r2']);
    scene = applySceneOperations(scene, [
      { op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: null } },
      { op: 'update_wing', fleet: 'f', wing: 'w2', set: { targets: ['astra'] } },
      { op: 'update_fleet', fleet: 'g', set: { targets: ['r4'] } },
      { op: 'add_squad', fleet: 'f', wing: 'w2', squad: { id: 'new', role: 'dps', members: [], targets: ['r3'] } }
    ]).scene;
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'dps' })).toEqual([]);
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'wing', id: 'w2' })).toEqual(['astra']);
    expect(calledTargetsOf(scene, { fleet: 'g', kind: 'fleet', id: 'g' })).toEqual(['r4']);
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'new' })).toEqual(['r3']);
    const added = applySceneOperations(twoWings(), [{ op: 'add_fleet', fleet: { id: 'h', commander: 'solo', targets: ['r1'], wings: [] } }]).scene;
    expect(added.fleets?.[2]).toEqual({ id: 'h', commander: 'solo', targets: ['r1'], wings: [] });
    expect(catchSceneError(() => applySceneOperations(twoWings(), [{ op: 'update_fleet', fleet: 'f', set: { targets: ['nobody'] } }])).problems).toEqual(['fleets[0].targets[0] "nobody" is not a ship or object in the scene']);
  });

  it('diffs as a fleets change, never a regroup', () => {
    const before = twoWings();
    const after = applySceneOperations(before, [{ op: 'update_fleet', fleet: 'f', set: { targets: ['r1'] } }]).scene;
    const diff = diffScenes(before, after);
    expect(diff.fleets).toBe(true);
    expect(diff.regrouped).toEqual([]);
  });
});

describe('removing a called ship or object prunes it', () => {
  it('takes a removed ship off every list with a warning, deleting an emptied list and leaving the rest', () => {
    const before = twoWings({ fleet: ['r1', 'r2'], dps: ['r1'], tackle: ['r2'], g: ['r3'] });
    const { scene, warnings } = applySceneOperations(before, [{ op: 'remove_ship', id: 'r1' }]);
    expect(warnings).toEqual(['fleet "f" no longer calls "r1" (it was removed)', 'fleet "f": squad "dps" no longer calls "r1" (it was removed)']);
    expect(scene.fleets?.[0].targets).toEqual(['r2']);
    expect(scene.fleets?.[0].wings[0].squads[0]).not.toHaveProperty('targets');
    expect(calledTargetsOf(scene, { fleet: 'f', kind: 'squad', id: 'tackle' })).toEqual(['r2']);
    expect(scene.fleets?.[1].targets).toEqual(['r3']);
  });

  it("takes a removed object off a wing's list", () => {
    const { scene, warnings } = applySceneOperations(twoWings({ w1: ['astra', 'r1'] }), [{ op: 'remove_object', id: 'astra' }]);
    expect(warnings).toEqual(['fleet "f": wing "w1" no longer calls "astra" (it was removed)']);
    expect(scene.fleets?.[0].wings[0].targets).toEqual(['r1']);
  });

  it("takes the ships of a fleet removed withShips off the other fleets' lists", () => {
    const { scene, warnings } = applySceneOperations(twoWings({ fleet: ['gfc', 'r1'] }), [{ op: 'remove_fleet', fleet: 'g', withShips: true }]);
    expect(warnings).toContain('fleet "f" no longer calls "gfc" (it was removed)');
    expect(scene.fleets?.[0].targets).toEqual(['r1']);
    const kept = applySceneOperations(twoWings({ fleet: ['gfc'] }), [{ op: 'remove_fleet', fleet: 'g' }]);
    expect(kept.scene.fleets?.[0].targets).toEqual(['gfc']);
  });
});

describe('toFleetGroupCalls', () => {
  it("splits each calling group's list into its live primary, queue and skipped entries", () => {
    const scene = twoWings({ fleet: ['r1', 'r2', 'r3', 'r4'], dps: ['a2', 'r2'], logi: ['r4'] });
    const calls = toFleetGroupCalls(scene, statuses({ r1: 'destroyed', r3: 'warping', r4: 'missing' }));
    expect([...calls.keys()]).toEqual(['f', 'f/squad/dps', 'f/squad/logi']);
    expect(calls.get('f')).toEqual({
      group: { fleet: 'f', kind: 'fleet', id: 'f' },
      targets: ['r1', 'r2', 'r3', 'r4'],
      primary: 'r2',
      queue: [],
      skipped: [
        { id: 'r1', why: 'destroyed' },
        { id: 'r3', why: 'warping' },
        { id: 'r4', why: 'missing' }
      ]
    });
    expect(calls.get('f/squad/dps')).toMatchObject({ primary: 'r2', queue: [], skipped: [{ id: 'a2', why: 'own-ship' }] });
    expect(calls.get('f/squad/logi')).toMatchObject({ primary: null, queue: [], skipped: [{ id: 'r4', why: 'missing' }] });
  });

  it('counts every entry live without a status', () => {
    expect(toCalledTargets(['r1', 'r2', 'r3'])).toEqual({ primary: 'r1', queue: ['r2', 'r3'], skipped: [] });
    expect(toFleetGroupCalls(twoWings()).size).toBe(0);
  });
});

describe('toShipCallPlans', () => {
  const plansOf = (calls: Parameters<typeof twoWingsInput>[0], status: Record<string, CalledTargetStatus> = {}) => {
    const scene = twoWings(calls);
    return toShipCallPlans(scene, toFleetGroupCalls(scene, statuses(status)));
  };
  const primaries = (plans: ReturnType<typeof plansOf>) => Object.fromEntries([...plans].map(([ship, plan]) => [ship, plan.primary]));

  it("gives each ship the nearest call: its squad's, else its wing's, else its fleet's", () => {
    const plans = plansOf({ fleet: ['r1', 'r4'], w1: ['r2'], dps: ['r3'] });
    expect(primaries(plans)).toEqual({ fc: 'r1', wc1: 'r2', a1: 'r3', a2: 'r3', a3: 'r3', l1: null, l2: null, b1: 'r1', b2: 'r1', gfc: null });
    expect(plans.get('a2')).toEqual({
      ship: 'a2',
      fleet: 'f',
      chain: [
        { fleet: 'f', kind: 'squad', id: 'dps' },
        { fleet: 'f', kind: 'wing', id: 'w1' },
        { fleet: 'f', kind: 'fleet', id: 'f' }
      ],
      logi: false,
      called: true,
      group: { fleet: 'f', kind: 'squad', id: 'dps' },
      primary: 'r3',
      queue: []
    });
    expect(plans.get('b1')).toMatchObject({ group: { fleet: 'f', kind: 'fleet', id: 'f' }, queue: ['r4'] });
    expect(plans.get('wc1')?.chain).toEqual([
      { fleet: 'f', kind: 'wing', id: 'w1' },
      { fleet: 'f', kind: 'fleet', id: 'f' }
    ]);
  });

  it("keeps the FC on its fleet's call, whatever squad it sits in", () => {
    const plans = plansOf({ dps: ['r3'], w1: ['r2'] });
    expect(plans.get('fc')).toMatchObject({ chain: [{ fleet: 'f', kind: 'fleet', id: 'f' }], called: true, group: null, primary: null });
    expect(plans.get('a1')?.primary).toBe('r3');
  });

  it("gives logi only their own squad's call", () => {
    const above = plansOf({ fleet: ['r1'], w1: ['r2'] });
    expect(above.get('l1')).toMatchObject({ logi: true, called: true, chain: [{ fleet: 'f', kind: 'squad', id: 'logi' }], primary: null });
    const own = plansOf({ fleet: ['r1'], logi: ['r4'] });
    expect(own.get('l2')).toMatchObject({ logi: true, primary: 'r4', group: { fleet: 'f', kind: 'squad', id: 'logi' } });
  });

  it("falls back to the wing's call, then the fleet's, once a squad's targets are all dead or gone", () => {
    const plans = plansOf({ fleet: ['r4'], w1: ['r2'], dps: ['r1', 'r3'] }, { r1: 'destroyed', r3: 'missing' });
    expect(plans.get('a1')).toMatchObject({ primary: 'r2', group: { fleet: 'f', kind: 'wing', id: 'w1' } });
    const wingDead = plansOf({ fleet: ['r4'], w1: ['r2'], dps: ['r1'] }, { r1: 'destroyed', r2: 'warping' });
    expect(wingDead.get('a1')).toMatchObject({ primary: 'r4', group: { fleet: 'f', kind: 'fleet', id: 'f' } });
    const none = plansOf({ dps: ['r1'] }, { r1: 'destroyed' });
    expect(none.get('a1')).toMatchObject({ called: true, group: null, primary: null, queue: [] });
  });

  it('plans fleet ships only, and leaves an uncalled fleet without calls', () => {
    const plans = plansOf({ fleet: ['r1'] });
    expect(plans.has('solo')).toBe(false);
    expect(plans.has('r1')).toBe(false);
    expect(plans.get('gfc')).toMatchObject({ called: false, primary: null });
    expect(plansOf({ g: ['r1'] }).get('gfc')).toMatchObject({ primary: 'r1' });
  });
});
