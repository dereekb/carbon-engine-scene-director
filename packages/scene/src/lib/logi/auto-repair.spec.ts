import { describe, expect, it } from 'vitest';
import { catchSceneError, TFI, TFI_FLEET_SCENE } from '../fleets/fleets.spec-helper';
import { toLiveFleetScene } from '../fleets/live';
import { normalizeFleets } from '../fleets/normalize';
import { applySceneOperations, diffScenes, normalizeScene, type SceneDocument } from '../scene';
import { autoRepairOf, normalizeAutoRepairCommand, readSceneAutoRepair, resolveAutoRepair, toAutoRepairOperations } from './auto-repair';

const BLUE = ['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2', 'wc2', 'gfc'];

interface Settings {
  readonly fleet?: unknown;
  readonly w1?: unknown;
  readonly w2?: unknown;
  readonly dps?: unknown;
  readonly logi?: unknown;
  readonly tackle?: unknown;
}

const field = (value: unknown) => (value === undefined ? {} : { autoRepair: value });

/**
 * orders.spec.ts's TWO_WINGS (w1 under wc1: a dps squad the FC sits in, and a logi squad on its lead l1; w2 under wc2,
 * who sits in no squad: a tackle squad), plus a second fleet g.
 */
const twoWingsInput = (settings: Settings = {}) => ({
  ships: BLUE.map((id) => ({ id, dna: TFI })),
  fleets: [
    {
      id: 'f',
      commander: 'fc',
      ...field(settings.fleet),
      wings: [
        {
          id: 'w1',
          commander: 'wc1',
          ...field(settings.w1),
          squads: [
            { id: 'dps', role: 'dps', commander: 'a1', members: ['fc', 'a1', 'a2', 'a3'], ...field(settings.dps) },
            { id: 'logi', role: 'logi', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 }, ...field(settings.logi) }
          ]
        },
        { id: 'w2', commander: 'wc2', ...field(settings.w2), squads: [{ id: 'tackle', role: 'tackle', members: ['b1', 'b2'], ...field(settings.tackle) }] }
      ]
    },
    { id: 'g', commander: 'gfc', wings: [] }
  ]
});

const twoWings = (settings: Settings = {}): SceneDocument => normalizeScene(twoWingsInput(settings)).scene;

describe('the autoRepair field', () => {
  it('normalizes on a fleet, a wing and a squad, and omits an empty or null one', () => {
    const scene = twoWings({ fleet: { policy: 'damaged' }, w2: { on: true }, logi: { on: false, policy: 'shot-at' }, dps: {}, tackle: null });
    expect(scene.fleets?.[0].autoRepair).toEqual({ policy: 'damaged' });
    expect(scene.fleets?.[0].wings[1].autoRepair).toEqual({ on: true });
    expect(autoRepairOf(scene, { fleet: 'f', kind: 'squad', id: 'logi' })).toEqual({ on: false, policy: 'shot-at' });
    expect(scene.fleets?.[0].wings[0].squads[0]).not.toHaveProperty('autoRepair');
    expect(scene.fleets?.[0].wings[1].squads[0]).not.toHaveProperty('autoRepair');
    expect(autoRepairOf(scene, { fleet: 'x', kind: 'fleet', id: 'x' })).toBeNull();
  });

  it('refuses a non-object, a bad on and a bad policy, and warns on unknown keys', () => {
    const problems: string[] = [];
    const warnings: string[] = [];
    expect(readSceneAutoRepair('on', { where: 'x', problems, warnings })).toBeNull();
    expect(readSceneAutoRepair({ on: 'yes', policy: 'bogus', range: 3 }, { where: 'y', problems, warnings })).toBeNull();
    expect(problems).toEqual(["x must be an object { on?, policy? }: the group's logi auto-repair", 'y.on must be true or false', 'y.policy must be one of urgent, damaged, shot-at (urgent: the shortest time to live; damaged: the lowest HP; shot-at: the most incoming damage)']);
    expect(warnings).toEqual(['y.range is not a known field and was dropped']);
    expect(catchSceneError(() => normalizeScene(twoWingsInput({ logi: { on: 1 } }))).problems).toEqual(['fleets[0].wings[0].squads[1].autoRepair.on must be true or false']);
  });

  it('is edited with update_fleet, update_wing and update_squad set (null clears) and add_* objects', () => {
    let scene = applySceneOperations(twoWings(), [{ op: 'update_squad', fleet: 'f', squad: 'tackle', set: { autoRepair: { on: true } } }]).scene;
    expect(autoRepairOf(scene, { fleet: 'f', kind: 'squad', id: 'tackle' })).toEqual({ on: true });
    scene = applySceneOperations(scene, [
      { op: 'update_squad', fleet: 'f', squad: 'tackle', set: { autoRepair: null } },
      { op: 'update_wing', fleet: 'f', wing: 'w1', set: { autoRepair: { policy: 'shot-at' } } },
      { op: 'update_fleet', fleet: 'g', set: { autoRepair: { on: false } } },
      { op: 'add_squad', fleet: 'f', wing: 'w2', squad: { id: 'new', role: 'logi', members: [], autoRepair: { policy: 'damaged' } } }
    ]).scene;
    expect(autoRepairOf(scene, { fleet: 'f', kind: 'squad', id: 'tackle' })).toBeNull();
    expect(autoRepairOf(scene, { fleet: 'f', kind: 'wing', id: 'w1' })).toEqual({ policy: 'shot-at' });
    expect(autoRepairOf(scene, { fleet: 'g', kind: 'fleet', id: 'g' })).toEqual({ on: false });
    expect(autoRepairOf(scene, { fleet: 'f', kind: 'squad', id: 'new' })).toEqual({ policy: 'damaged' });
    expect(catchSceneError(() => applySceneOperations(twoWings(), [{ op: 'update_fleet', fleet: 'f', set: { autoRepair: { policy: 'bogus' } } }])).problems[0]).toMatch(/^fleets\[0\]\.autoRepair\.policy must be one of urgent, damaged, shot-at/u);
  });

  it('diffs as a fleets change, never a regroup', () => {
    const before = twoWings();
    const after = applySceneOperations(before, [{ op: 'update_squad', fleet: 'f', squad: 'logi', set: { autoRepair: { on: false } } }]).scene;
    const diff = diffScenes(before, after);
    expect(diff.fleets).toBe(true);
    expect(diff.regrouped).toEqual([]);
  });

  it("normalizes in add_ships' one-fleet path against ship ids only", () => {
    const result = normalizeFleets({ input: [{ id: 'h', commander: 'x', autoRepair: { on: true }, wings: [] }], shipIds: new Set(['x']) });
    expect(result.problems).toEqual([]);
    expect(result.fleets?.[0].autoRepair).toEqual({ on: true });
  });
});

describe('resolveAutoRepair', () => {
  it('turns a logi squad on by default and leaves every other ship off, policy urgent', () => {
    const resolved = resolveAutoRepair(twoWings());
    expect(resolved.get('l1')).toEqual({ on: true, policy: 'urgent', source: 'default', policySource: 'default' });
    expect(resolved.get('l2')?.on).toBe(true);
    for (const id of ['fc', 'wc1', 'a1', 'a2', 'b1', 'wc2', 'gfc']) expect(resolved.get(id)?.on).toBe(false);
    expect(resolved.has('nobody')).toBe(false);
    const tfis = resolveAutoRepair(normalizeScene(TFI_FLEET_SCENE).scene);
    expect([...tfis].filter(([, settings]) => settings.on).map(([id]) => id)).toEqual(['guardian-1', 'guardian-2']);
  });

  it('takes each key from the nearest group that sets it: squad, wing, fleet', () => {
    const resolved = resolveAutoRepair(twoWings({ fleet: { on: false, policy: 'damaged' }, w1: { policy: 'shot-at' }, dps: { on: true }, logi: {} }));
    expect(resolved.get('a2')).toEqual({ on: true, policy: 'shot-at', source: 'squad', policySource: 'wing' });
    expect(resolved.get('l1')).toEqual({ on: false, policy: 'shot-at', source: 'fleet', policySource: 'wing' });
    expect(resolved.get('b1')).toEqual({ on: false, policy: 'damaged', source: 'fleet', policySource: 'fleet' });
    const squadOn = resolveAutoRepair(twoWings({ fleet: { on: false }, logi: { on: true } }));
    expect(squadOn.get('l1')).toEqual({ on: true, policy: 'urgent', source: 'squad', policySource: 'default' });
    expect(resolveAutoRepair(twoWings({ logi: { policy: 'damaged' } })).get('l1')).toEqual({ on: true, policy: 'damaged', source: 'default', policySource: 'squad' });
  });

  it('runs the FC through its squad, and a wing commander outside squads through its wing, then its fleet', () => {
    const resolved = resolveAutoRepair(twoWings({ fleet: { policy: 'damaged' }, w2: { on: true }, dps: { policy: 'shot-at' } }));
    expect(resolved.get('fc')).toEqual({ on: false, policy: 'shot-at', source: 'default', policySource: 'squad' });
    expect(resolved.get('wc2')).toEqual({ on: true, policy: 'damaged', source: 'wing', policySource: 'fleet' });
    expect(resolved.get('wc1')).toEqual({ on: false, policy: 'damaged', source: 'default', policySource: 'fleet' });
    expect(resolved.get('gfc')).toEqual({ on: false, policy: 'urgent', source: 'default', policySource: 'default' });
  });

  it('keeps the field in the live view', () => {
    const live = toLiveFleetScene(twoWings({ logi: { policy: 'shot-at' } }), new Set(['l2'])).scene;
    expect(resolveAutoRepair(live).get('l1')?.policy).toBe('shot-at');
    expect(resolveAutoRepair(live).has('l2')).toBe(false);
  });
});

describe('the auto_repair command', () => {
  it('normalizes fleet, wing xor squad, on and policy', () => {
    expect(normalizeAutoRepairCommand({ fleet: 'f', squad: 'logi', on: true, policy: 'shot-at' })).toEqual({ fleet: 'f', squad: 'logi', on: true, policy: 'shot-at' });
    expect(normalizeAutoRepairCommand({ fleet: 'f', wing: 'w1', on: null })).toEqual({ fleet: 'f', wing: 'w1', on: null });
    expect(normalizeAutoRepairCommand({ fleet: 'f', policy: null })).toEqual({ fleet: 'f', policy: null });
  });

  it('refuses ships, nothing to set, bad values, both wing and squad, and unknown keys', () => {
    const problemsOf = (input: unknown) => catchSceneError(() => normalizeAutoRepairCommand(input)).problems;
    expect(problemsOf({ ships: ['l1'], on: true })).toEqual(['auto_repair.ships: auto-repair is set per fleet, wing or squad; a ship repairs its fleet as its squad does', 'auto_repair.fleet is required: the fleet whose logi to set (narrow it with wing or squad)']);
    expect(problemsOf({ fleet: 'f' })).toEqual(['auto_repair needs on (true, false, or null to inherit) or policy (urgent, damaged, shot-at, or null to inherit)']);
    expect(problemsOf({ fleet: 'f', on: 'yes', policy: 'bogus' })).toEqual([
      'auto_repair.on must be true, false or null (inherit from the group above)',
      'auto_repair.policy must be one of urgent, damaged, shot-at (urgent: the shortest time to live; damaged: the lowest HP; shot-at: the most incoming damage), or null (inherit from the group above)'
    ]);
    expect(problemsOf({ fleet: 'f', wing: 'w1', squad: 'logi', on: true })).toEqual(['auto_repair: give wing or squad, not both']);
    expect(problemsOf({ fleet: 'f', on: true, range: 3 })).toEqual(['auto_repair.range is not an auto_repair field']);
    expect(problemsOf('on')).toEqual(['auto_repair must be an object { fleet, wing? | squad?, on?, policy? }']);
  });

  it("compiles to one update_* op merged into the group's field: null deletes, an emptied field is null", () => {
    const scene = twoWings({ logi: { policy: 'damaged' } });
    expect(toAutoRepairOperations(scene, { fleet: 'f', squad: 'logi', on: false })).toEqual([{ op: 'update_squad', fleet: 'f', squad: 'logi', set: { autoRepair: { policy: 'damaged', on: false } } }]);
    expect(toAutoRepairOperations(scene, { fleet: 'f', squad: 'logi', policy: null })).toEqual([{ op: 'update_squad', fleet: 'f', squad: 'logi', set: { autoRepair: null } }]);
    expect(toAutoRepairOperations(scene, { fleet: 'f', wing: 'w2', on: true })).toEqual([{ op: 'update_wing', fleet: 'f', wing: 'w2', set: { autoRepair: { on: true } } }]);
    expect(toAutoRepairOperations(scene, { fleet: 'f', policy: 'shot-at' })).toEqual([{ op: 'update_fleet', fleet: 'f', set: { autoRepair: { policy: 'shot-at' } } }]);
    const applied = applySceneOperations(scene, toAutoRepairOperations(scene, { fleet: 'f', squad: 'logi', on: false, policy: 'urgent' })).scene;
    expect(autoRepairOf(applied, { fleet: 'f', kind: 'squad', id: 'logi' })).toEqual({ policy: 'urgent', on: false });
  });

  it('gives no op when nothing changes, and refuses an unknown group', () => {
    const scene = twoWings({ logi: { policy: 'damaged' } });
    expect(toAutoRepairOperations(scene, { fleet: 'f', squad: 'logi', policy: 'damaged' })).toEqual([]);
    expect(toAutoRepairOperations(scene, { fleet: 'f', squad: 'dps', on: null })).toEqual([]);
    expect(catchSceneError(() => toAutoRepairOperations(scene, { fleet: 'nope', on: true })).problems).toEqual(['auto_repair: no fleet "nope"']);
    expect(catchSceneError(() => toAutoRepairOperations(scene, { fleet: 'f', squad: 'nope', on: true })).problems).toEqual(['auto_repair: no squad "nope" in fleet "f"']);
  });
});
