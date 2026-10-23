import { describe, expect, it } from 'vitest';
import { sameJson } from '../json';
import { SHIP_ORDER_TYPES } from '../orders';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import { catchSceneError, makeFleetScene, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { toFleetMemberships } from './membership';
import { CELESTIAL_TARGET_REFUSAL } from '../weapons/target';
import { DEFAULT_BREAK_OFF_RANGE, FLEET_ORDER_TYPES, FLEET_STRUCTURE_ORDER_TYPES, isFleetDocumentOrder, isFleetFreeFireOrder, isFleetShipOrder, isFleetStructureOrder, MAX_FLEET_ORDER_DELAY, normalizeFleetOrderRequest, toPilotDelays, resolveFleetOrderRequest, toFleetGroupKey, toFleetOrderOperations } from './orders';
import { FLEET_TARGETS_ACTIONS, MAX_CALLED_TARGETS } from './targets';

/**
 * Two wings: w1 (commander wc1) with a dps squad the FC sits in (commander a1) and a logi squad on its lead l1 at 5 km;
 * w2 (no commander) with a tackle squad and an empty one. A second fleet g.
 */
const TWO_WINGS = (): SceneDocument =>
  normalizeScene(
    makeFleetScene(
      ['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2', 'gfc'],
      [
        {
          id: 'f',
          commander: 'fc',
          wings: [
            {
              id: 'w1',
              commander: 'wc1',
              squads: [
                { id: 'dps', role: 'dps', commander: 'a1', members: ['fc', 'a1', 'a2', 'a3'] },
                { id: 'logi', role: 'logi', members: ['l1', 'l2'], anchor: { ship: 'l1', range: 5000 } }
              ]
            },
            {
              id: 'w2',
              squads: [
                { id: 'tackle', role: 'tackle', members: ['b1', 'b2'] },
                { id: 'empty', role: 'dps', members: [] }
              ]
            }
          ]
        },
        { id: 'g', commander: 'gfc' }
      ]
    )
  ).scene;

const SHIPS = new Set(['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2', 'gfc']);
const normalize = (input: unknown) => normalizeFleetOrderRequest(input, { ships: SHIPS });
const problemsOf = (input: unknown) => catchSceneError(() => normalize(input)).problems;
const resolve = (request: object, scene: SceneDocument = TWO_WINGS()) => resolveFleetOrderRequest(scene, normalizeFleetOrderRequest(request));
const resolveProblems = (request: object, scene: SceneDocument = TWO_WINGS()) => catchSceneError(() => resolve(request, scene)).problems;
const STOP = { type: 'stop' } as const;
const WARP = { type: 'warp', point: [0, 0, 400000] } as const;

describe('normalizeFleetOrderRequest', () => {
  it('lists the ship orders, then the document orders', () => {
    expect([...FLEET_ORDER_TYPES]).toEqual([...SHIP_ORDER_TYPES, ...FLEET_STRUCTURE_ORDER_TYPES, 'targets', 'free-fire', 'stance']);
  });

  it('round-trips every order type with its defaults filled', () => {
    expect(normalize({ fleet: 'f', order: { type: 'direction', direction: [0, 0, 1] } })).toEqual({ fleet: 'f', order: { type: 'direction', direction: [0, 0, 1], speed: 1 } });
    expect(normalize({ fleet: 'f', squad: 'dps', by: 'a1', order: { type: 'warp', point: [0, 0, 400000] } })).toEqual({ fleet: 'f', squad: 'dps', by: 'a1', order: { type: 'warp', point: [0, 0, 400000], range: 0 } });
    expect(normalize({ fleet: 'f', wing: 'w1', order: { type: 'keep-at-range', target: 'gfc', range: 2000 } }).order).toEqual({ type: 'keep-at-range', target: 'gfc', range: 2000, speed: 1 });
    expect(normalize({ fleet: 'f', order: STOP }).order).toEqual(STOP);
    expect(normalize({ fleet: 'f', squad: 'logi', order: { type: 'break-off' } }).order).toEqual({ type: 'break-off', range: DEFAULT_BREAK_OFF_RANGE });
    expect(DEFAULT_BREAK_OFF_RANGE).toBe(30000);
    expect(normalize({ fleet: 'f', squad: 'logi', order: { type: 'break-off', ship: 'l2', range: 12000 } }).order).toEqual({ type: 'break-off', ship: 'l2', range: 12000 });
    expect(normalize({ fleet: 'f', order: { type: 'anchor', range: null } }).order).toEqual({ type: 'anchor', range: null });
    expect(normalize({ fleet: 'f', order: { type: 'anchor', ship: null, range: 4000 } }).order).toEqual({ type: 'anchor', ship: null, range: 4000 });
    expect(normalize({ fleet: 'f', order: { type: 'regroup' } }).order).toEqual({ type: 'regroup' });
  });

  it('refuses unknown keys at both levels, and points ships at order_ship', () => {
    expect(problemsOf({ fleet: 'f', order: STOP, foo: 1 })).toEqual(['order_fleet.foo is not an order_fleet field']);
    expect(problemsOf({ fleet: 'f', order: { type: 'regroup', x: 1 } })).toEqual(['order_fleet.order.x is not a regroup order field']);
    expect(problemsOf({ fleet: 'f', order: { type: 'stop', x: 1 } })).toEqual(['order_fleet.order.x is not a stop order field']);
    expect(problemsOf({ ships: ['a1'], fleet: 'f', order: STOP })).toEqual(['order_fleet.ships: order_fleet orders a fleet, wing or squad; order_ship orders single ships']);
  });

  it('selects as switch_prop_mods does: fleet required, wing or squad narrowing it', () => {
    expect(problemsOf({ fleet: 'f', wing: 'w1', squad: 'dps', order: STOP })).toEqual(['order_fleet: give wing or squad, not both']);
    expect(problemsOf({ wing: 'w1', order: STOP })).toContain('order_fleet.fleet is required: the fleet to order (narrow it with wing or squad)');
    expect(problemsOf({ fleet: 'f f', order: STOP })[0]).toMatch(/order_fleet\.fleet must be an id/u);
    expect(problemsOf({ fleet: 'f', by: 'a b', order: STOP })).toEqual(['order_fleet.by must be an id (1-64 letters, digits, "_", "-" or ".")']);
  });

  it('checks the order: its type, rejoin, anchor keys, ranges, and order_ship rules under order.', () => {
    expect(problemsOf({ fleet: 'f' })[0]).toMatch(/order_fleet\.order is required/u);
    expect(problemsOf({ fleet: 'f', order: { type: 'rejoin' } })).toEqual([`order_fleet.order.type: rejoin is order_ship's, for one ship; use regroup`]);
    expect(problemsOf({ fleet: 'f', order: { type: 'jump' } })).toEqual([`order_fleet.order.type must be one of ${FLEET_ORDER_TYPES.join(', ')}`]);
    expect(problemsOf({ fleet: 'f', order: { type: 'anchor' } })[0]).toMatch(/order_fleet\.order needs ship or range/u);
    expect(problemsOf({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: -1 } })).toEqual(['order_fleet.order.range must be a number in [0, 1000000] (metres)']);
    expect(problemsOf({ fleet: 'f', order: { type: 'anchor', range: 2e6 } })).toEqual(['order_fleet.order.range must be a number in [0, 1000000] (metres)']);
    expect(problemsOf({ fleet: 'f', order: { type: 'anchor', ship: 'nobody' } })).toEqual(['order_fleet.order.ship: no ship "nobody"']);
    expect(problemsOf({ fleet: 'f', order: { type: 'direction', direction: [0, 0, 1], speed: 2 } })).toEqual(['order_fleet.order.speed must be a number in (0, 1]']);
    expect(problemsOf({ fleet: 'f', order: { type: 'approach', target: 'nobody' } }).join('\n')).toMatch(/order_fleet\.order\.target/u);
  });
});

describe('resolveFleetOrderRequest', () => {
  it('picks the group ships, never the FC for a wing or squad', () => {
    expect(resolve({ fleet: 'f', order: STOP }).ships).toEqual(['fc', 'wc1', 'a1', 'a2', 'a3', 'l1', 'l2', 'b1', 'b2']);
    expect(resolve({ fleet: 'f', wing: 'w1', order: STOP }).ships).toEqual(['wc1', 'a1', 'a2', 'a3', 'l1', 'l2']);
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP }).ships).toEqual(['a1', 'a2', 'a3']);
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP }).group).toEqual({ fleet: 'f', kind: 'squad', id: 'dps' });
    expect(resolveProblems({ fleet: 'f', squad: 'empty', order: STOP })).toEqual(['order_fleet: squad "empty" has no ships to order (the FC never joins a wing or squad order)']);
    const fcOnly = normalizeScene(makeFleetScene(['fc'], [{ id: 'f', commander: 'fc', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['fc'] }] }] }])).scene;
    expect(resolveProblems({ fleet: 'f', squad: 's', order: STOP }, fcOnly)).toEqual(['order_fleet: squad "s" has no ships to order (the FC never joins a wing or squad order)']);
    expect(resolveProblems({ fleet: 'x', order: STOP })).toEqual(['order_fleet: no fleet "x"']);
    expect(resolveProblems({ fleet: 'f', wing: 'x', order: STOP })).toEqual(['order_fleet: no wing "x" in fleet "f"']);
    expect(resolveProblems({ fleet: 'f', squad: 'x', order: STOP })).toEqual(['order_fleet: no squad "x" in fleet "f"']);
  });

  it('defaults the giver to the nearest commander: squad, then wing, then the FC', () => {
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP })).toMatchObject({ issuer: 'a1', commanders: ['a1', 'wc1', 'fc'] });
    expect(resolve({ fleet: 'f', squad: 'logi', order: STOP })).toMatchObject({ issuer: 'wc1', commanders: ['wc1', 'fc'] });
    expect(resolve({ fleet: 'f', wing: 'w1', order: STOP })).toMatchObject({ issuer: 'wc1', commanders: ['wc1', 'fc'] });
    expect(resolve({ fleet: 'f', squad: 'tackle', order: STOP })).toMatchObject({ issuer: 'fc', commanders: ['fc'] });
    expect(resolve({ fleet: 'f', order: STOP })).toMatchObject({ issuer: 'fc', commanders: ['fc'] });
  });

  it('lets only the group commanders give an order: the FC warps the fleet, a wing commander its wing, a squad commander its squad', () => {
    for (const request of [{ fleet: 'f' }, { fleet: 'f', wing: 'w1' }, { fleet: 'f', wing: 'w2' }, { fleet: 'f', squad: 'dps' }, { fleet: 'f', squad: 'tackle' }]) {
      expect(resolve({ ...request, by: 'fc', order: WARP }).issuer).toBe('fc');
    }
    expect(resolve({ fleet: 'f', wing: 'w1', by: 'wc1', order: WARP }).issuer).toBe('wc1');
    expect(resolve({ fleet: 'f', squad: 'logi', by: 'wc1', order: WARP }).issuer).toBe('wc1');
    expect(resolve({ fleet: 'f', squad: 'dps', by: 'a1', order: WARP }).issuer).toBe('a1');

    expect(resolveProblems({ fleet: 'f', by: 'wc1', order: WARP })[0]).toMatch(/^order_fleet: ship "wc1" has no command over fleet "f": its commanders are "fc" \(fleet\);/u);
    expect(resolveProblems({ fleet: 'f', wing: 'w2', by: 'wc1', order: WARP })[0]).toMatch(/no command over wing "w2" of fleet "f"/u);
    expect(resolveProblems({ fleet: 'f', wing: 'w1', by: 'a1', order: WARP })[0]).toMatch(/no command over wing "w1"/u);
    expect(resolveProblems({ fleet: 'f', squad: 'logi', by: 'a1', order: WARP })[0]).toMatch(/no command over squad "logi"/u);
    expect(resolveProblems({ fleet: 'f', squad: 'dps', by: 'gfc', order: WARP })).toEqual([
      'order_fleet: ship "gfc" has no command over squad "dps" of fleet "f": its commanders are "a1" (squad), "wc1" (wing "w1") and "fc" (fleet); a warp, like any fleet order, is given by one of them (the FC warps the fleet, a wing commander their wing, a squad commander their squad)'
    ]);
    expect(resolveProblems({ fleet: 'f', squad: 'dps', by: 'a2', order: STOP })[0]).toMatch(/ship "a2" has no command over squad "dps"/u);
  });

  it('leads a squad with its commander, else the giver in it, else its lead, else its first member; never the FC', () => {
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP }).leader).toBe('a1');
    expect(resolve({ fleet: 'f', squad: 'dps', by: 'fc', order: STOP }).leader).toBe('a1');
    expect(resolve({ fleet: 'f', squad: 'logi', order: STOP }).leader).toBe('l1');
    expect(resolve({ fleet: 'f', squad: 'tackle', order: STOP }).leader).toBe('b1');
    const noCommander = applySceneOperations(TWO_WINGS(), [{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { commander: null } }]).scene;
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP }, noCommander).leader).toBe('a1');
    const commanderA3 = applySceneOperations(TWO_WINGS(), [{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { commander: 'a3' } }]).scene;
    expect(resolve({ fleet: 'f', squad: 'dps', order: STOP }, commanderA3).leader).toBe('a3');
    const logiCommander = applySceneOperations(TWO_WINGS(), [{ op: 'update_squad', fleet: 'f', squad: 'logi', set: { commander: 'l2' } }]).scene;
    expect(resolve({ fleet: 'f', squad: 'logi', by: 'l2', order: STOP }, logiCommander).leader).toBe('l2');
  });

  it('leads a wing with its commander, else the giver in it, else its first squad leader; a fleet with its FC', () => {
    expect(resolve({ fleet: 'f', wing: 'w1', order: STOP }).leader).toBe('wc1');
    expect(resolve({ fleet: 'f', wing: 'w2', order: STOP }).leader).toBe('b1');
    const noWingCommander = applySceneOperations(TWO_WINGS(), [{ op: 'update_wing', fleet: 'f', wing: 'w1', set: { commander: null } }]).scene;
    expect(resolve({ fleet: 'f', wing: 'w1', order: STOP }, noWingCommander).leader).toBe('a1');
    expect(resolve({ fleet: 'f', order: STOP }).leader).toBe('fc');
    const fcCommandsWing = applySceneOperations(TWO_WINGS(), [{ op: 'update_wing', fleet: 'f', wing: 'w1', set: { commander: 'fc' } }]).scene;
    expect(resolve({ fleet: 'f', wing: 'w1', order: STOP }, fcCommandsWing)).toMatchObject({ leader: 'a1', issuer: 'fc', commanders: ['fc'] });
  });

  it('refuses a target inside the group and accepts one outside it, such as the FC', () => {
    expect(resolveProblems({ fleet: 'f', squad: 'dps', order: { type: 'approach', target: 'a2', speed: 1 } })).toEqual(['order_fleet.order.target: squad "dps" of fleet "f" cannot target one of its own ships ("a2")']);
    expect(resolveProblems({ fleet: 'f', order: { type: 'warp', target: 'l1', range: 0 } })[0]).toMatch(/fleet "f" cannot target one of its own ships \("l1"\)/u);
    expect(resolve({ fleet: 'f', squad: 'dps', order: { type: 'keep-at-range', target: 'fc', range: 5000, speed: 1 } }).leader).toBe('a1');
    expect(resolve({ fleet: 'f', order: { type: 'warp', target: 'gfc', range: 0 } }).leader).toBe('fc');
  });

  it('keys groups by fleet, kind and id', () => {
    expect(toFleetGroupKey({ fleet: 'tfis', kind: 'fleet', id: 'tfis' })).toBe('tfis');
    expect(toFleetGroupKey({ fleet: 'tfis', kind: 'wing', id: 'mainline' })).toBe('tfis/wing/mainline');
    expect(toFleetGroupKey({ fleet: 'tfis', kind: 'squad', id: 'logi' })).toBe('tfis/squad/logi');
  });
});

describe('toFleetOrderOperations', () => {
  const opsOf = (request: object, scene: SceneDocument = TWO_WINGS()) => toFleetOrderOperations(scene, resolve(request, scene));
  const squadOf = (scene: SceneDocument, id: string) => scene.fleets?.flatMap((fleet) => fleet.wings.flatMap((wing) => wing.squads)).find((squad) => squad.id === id);

  it('compiles nothing for a movement or warp order', () => {
    expect(opsOf({ fleet: 'f', order: WARP })).toEqual([]);
    expect(opsOf({ fleet: 'f', squad: 'dps', order: STOP })).toEqual([]);
  });

  it('re-anchors every squad of the group with set_anchor', () => {
    expect(opsOf({ fleet: 'f', order: { type: 'anchor', range: 6000 } })).toEqual(['dps', 'logi', 'tackle', 'empty'].map((squad) => ({ op: 'set_anchor', fleet: 'f', squad, anchor: { range: 6000 } })));
    expect(opsOf({ fleet: 'f', wing: 'w2', order: { type: 'anchor', ship: 'wc1', range: null } })).toEqual([
      { op: 'set_anchor', fleet: 'f', squad: 'tackle', anchor: { ship: 'wc1', range: null } },
      { op: 'set_anchor', fleet: 'f', squad: 'empty', anchor: { ship: 'wc1', range: null } }
    ]);
    expect(opsOf({ fleet: 'f', squad: 'logi', order: { type: 'anchor', ship: null } })).toEqual([{ op: 'set_anchor', fleet: 'f', squad: 'logi', anchor: { ship: null } }]);

    const applied = applySceneOperations(TWO_WINGS(), opsOf({ fleet: 'f', wing: 'w1', order: { type: 'anchor', range: 6000 } })).scene;
    const memberships = toFleetMemberships(applied);
    expect(memberships.get('a2')?.anchor).toEqual({ ship: 'fc', range: 6000 });
    expect(memberships.get('l1')?.anchor).toEqual({ ship: 'fc', range: 6000 });
    expect(memberships.get('b1')?.anchor).toEqual({ ship: 'fc', range: 1000 });
    const noSquads = normalizeScene(makeFleetScene(['fc'], [{ id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'fc' }] }])).scene;
    expect(catchSceneError(() => toFleetOrderOperations(noSquads, resolveFleetOrderRequest(noSquads, { fleet: 'f', order: { type: 'anchor', range: 1 } }))).problems).toEqual(['order_fleet: fleet "f" has no squads to anchor']);
  });

  it('breaks one squad off on its lead, keeping its old anchor as home', () => {
    expect(opsOf({ fleet: 'f', squad: 'dps', order: { type: 'break-off', range: 12000 } })).toEqual([{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { anchor: { ship: 'a1', range: 12000 }, home: {} } }]);
    expect(opsOf({ fleet: 'f', squad: 'dps', order: { type: 'break-off', ship: 'a3', range: 12000 } })[0]['set']).toEqual({ anchor: { ship: 'a3', range: 12000 }, home: {} });
    expect(opsOf({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: 20000 } })[0]['set']).toEqual({ anchor: { ship: 'l1', range: 20000 }, home: { ship: 'l1', range: 5000 } });
    expect(opsOf({ fleet: 'f', squad: 'tackle', order: { type: 'break-off', range: 20000 } })[0]['set']).toEqual({ anchor: { ship: 'b1', range: 20000 }, home: {} });

    const once = applySceneOperations(TWO_WINGS(), opsOf({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: 20000 } })).scene;
    expect(squadOf(once, 'logi')).toMatchObject({ anchor: { ship: 'l1', range: 20000 }, home: { ship: 'l1', range: 5000 } });
    expect(toFleetMemberships(once).get('l1')?.anchor).toEqual({ ship: 'fc', range: 20000 });
    const twice = opsOf({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: 40000 } }, once);
    expect(twice[0]['set']).toEqual({ anchor: { ship: 'l1', range: 40000 } });

    expect(catchSceneError(() => opsOf({ fleet: 'f', wing: 'w1', order: { type: 'break-off', range: 1 } })).problems).toEqual(['order_fleet: break-off takes one squad; give squad']);
    expect(catchSceneError(() => opsOf({ fleet: 'f', order: { type: 'break-off', range: 1 } })).problems).toEqual(['order_fleet: break-off takes one squad; give squad']);
    expect(catchSceneError(() => opsOf({ fleet: 'f', squad: 'dps', order: { type: 'break-off', ship: 'fc', range: 1 } })).problems[0]).toMatch(/"fc" is not a member of squad "dps"/u);
    expect(catchSceneError(() => opsOf({ fleet: 'f', squad: 'dps', order: { type: 'break-off', ship: 'l1', range: 1 } })).problems[0]).toMatch(/"l1" is not a member of squad "dps"/u);
  });

  it('regroups only squads with a home, restoring it', () => {
    expect(opsOf({ fleet: 'f', order: { type: 'regroup' } })).toEqual([]);
    const broken = applySceneOperations(TWO_WINGS(), [...opsOf({ fleet: 'f', squad: 'tackle', order: { type: 'break-off', range: 20000 } }), ...opsOf({ fleet: 'f', squad: 'logi', order: { type: 'break-off', range: 20000 } })]).scene;
    expect(opsOf({ fleet: 'f', order: { type: 'regroup' } }, broken)).toEqual([
      { op: 'update_squad', fleet: 'f', squad: 'logi', set: { anchor: { ship: 'l1', range: 5000 }, home: null } },
      { op: 'update_squad', fleet: 'f', squad: 'tackle', set: { anchor: null, home: null } }
    ]);
    expect(opsOf({ fleet: 'f', wing: 'w1', order: { type: 'regroup' } }, broken)).toHaveLength(1);
    const back = applySceneOperations(broken, opsOf({ fleet: 'f', order: { type: 'regroup' } }, broken)).scene;
    expect(sameJson(back.fleets, TWO_WINGS().fleets)).toBe(true);
  });

  it('break-off then regroup gives the fleets back exactly, for the TFIs logi on its own lead and for a dps squad', () => {
    const original = normalizeScene(TFI_FLEET_SCENE).scene;
    for (const squad of ['logi', 'dps']) {
      const broken = applySceneOperations(original, toFleetOrderOperations(original, resolveFleetOrderRequest(original, { fleet: 'tfi', squad, order: { type: 'break-off', range: 12000 } }))).scene;
      expect(sameJson(broken.fleets, original.fleets)).toBe(false);
      const back = applySceneOperations(broken, toFleetOrderOperations(broken, resolveFleetOrderRequest(broken, { fleet: 'tfi', squad, order: { type: 'regroup' } }))).scene;
      expect(sameJson(back.fleets, original.fleets), squad).toBe(true);
    }
  });
});

describe('pilot delays', () => {
  it('takes a delay in [0, 1], keeping an explicit 0', () => {
    expect(normalize({ fleet: 'f', delay: 0.5, order: STOP })).toEqual({ fleet: 'f', delay: 0.5, order: STOP });
    expect(normalize({ fleet: 'f', delay: 0, order: STOP })).toEqual({ fleet: 'f', delay: 0, order: STOP });
    for (const delay of [-0.1, 1.5, 'slow']) expect(problemsOf({ fleet: 'f', delay, order: STOP })).toEqual([`order_fleet.delay must be a number in [0, 1]: 0 the pilots respond at once, 1 very delayed (up to ${MAX_FLEET_ORDER_DELAY} s)`]);
  });

  it('draws whole seconds up to delay x MAX_FLEET_ORDER_DELAY, the same for the same order and tick, the giver at once', () => {
    const ships = Array.from({ length: 40 }, (_, index) => `s${index}`);
    const input = { key: 'tfis', tick: 1234, delay: 1, ships, issuer: 's0' };
    const delays = toPilotDelays(input);
    expect([...delays.keys()]).toEqual(ships);
    expect(delays.get('s0')).toBe(0);
    for (const value of delays.values()) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(MAX_FLEET_ORDER_DELAY);
    }
    expect(new Set(delays.values()).size).toBeGreaterThan(5);
    expect(toPilotDelays(input)).toEqual(delays);
    expect(toPilotDelays({ ...input, tick: 1235 })).not.toEqual(delays);
    for (const value of toPilotDelays({ ...input, delay: 0.3 }).values()) expect(value).toBeLessThanOrEqual(3);
    for (const value of toPilotDelays({ ...input, delay: 0 }).values()) expect(value).toBe(0);
  });

  it("answers after each pilot's reaction when no delay is given; an explicit delay wins", () => {
    const ships = Array.from({ length: 40 }, (_, index) => `s${index}`);
    const reactions = new Map<string, number>(ships.map((ship, index) => [ship, index % 4 === 0 ? 1 : index % 4 === 1 ? 0 : 0.5]));
    reactions.delete('s3');
    const input = { key: 'f', tick: 77, ships, issuer: 's1', reactionOf: (ship: string) => reactions.get(ship) };
    const delays = toPilotDelays(input);
    expect(delays.get('s1')).toBe(0);
    expect(delays.get('s3')).toBe(0);
    for (const [ship, value] of delays) {
      const reaction = reactions.get(ship);
      expect(Number.isInteger(value)).toBe(true);
      if (ship === 's1' || reaction == null || reaction === 1) expect(value, ship).toBe(0);
      else if (reaction === 0) expect(value, ship).toBeGreaterThanOrEqual(5);
      else {
        expect(value, ship).toBeGreaterThanOrEqual(2);
        expect(value, ship).toBeLessThanOrEqual(5);
      }
    }
    expect(toPilotDelays(input)).toEqual(delays);
    expect([...toPilotDelays({ ...input, delay: 0 }).values()].every((value) => value === 0)).toBe(true);
    expect(toPilotDelays({ ...input, delay: 1 })).toEqual(toPilotDelays({ key: 'f', tick: 77, delay: 1, ships, issuer: 's1' }));
    expect([...toPilotDelays({ ...input, reactionOf: undefined }).values()].every((value) => value === 0)).toBe(true);
  });

  it('spreads ids that differ only in their last character (composition ids)', () => {
    const ships = Array.from({ length: 8 }, (_, index) => `tfis-logi-0${index + 1}`);
    for (const tick of [349, 418, 1000]) {
      const delays = [...toPilotDelays({ key: 'tfis/squad/logi', tick, delay: 1, ships, issuer: 'tfis-fc' }).values()];
      expect(new Set(delays).size, `tick ${tick}: ${delays.join(', ')}`).toBeGreaterThanOrEqual(4);
      expect(Math.max(...delays) - Math.min(...delays), `tick ${tick}: ${delays.join(', ')}`).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('targets orders', () => {
  const TARGETS = (order: object) => ({ type: 'targets', ...order });
  const CALLED = (): SceneDocument => applySceneOperations(TWO_WINGS(), [{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: ['b1', 'b2', 'l1'] } }]).scene;
  const opsOf = (order: object, options: Parameters<typeof toFleetOrderOperations>[2] = {}, selection: object = { squad: 'dps' }, scene: SceneDocument = CALLED()) => toFleetOrderOperations(scene, resolve({ fleet: 'f', ...selection, order: TARGETS(order) }, scene), options);
  const listOf = (order: object, options: Parameters<typeof toFleetOrderOperations>[2] = {}) => {
    const operations = opsOf(order, options);
    return operations.length ? (operations[0]['set'] as { targets: unknown }).targets : 'unchanged';
  };

  it('reads exactly one action: primary, queue, set, drop, next or clear', () => {
    expect(normalize({ fleet: 'f', order: TARGETS({ primary: 'gfc' }) }).order).toEqual({ type: 'targets', primary: 'gfc' });
    expect(normalize({ fleet: 'f', order: TARGETS({ queue: ['gfc', 'b1', 'gfc'] }) }).order).toEqual({ type: 'targets', queue: ['gfc', 'b1'] });
    expect(normalize({ fleet: 'f', order: TARGETS({ set: [] }) }).order).toEqual({ type: 'targets', set: [] });
    expect(normalize({ fleet: 'f', order: TARGETS({ drop: ['b1'] }) }).order).toEqual({ type: 'targets', drop: ['b1'] });
    expect(normalize({ fleet: 'f', order: TARGETS({ next: true }) }).order).toEqual({ type: 'targets', next: true });
    expect(normalize({ fleet: 'f', delay: 0.5, order: TARGETS({ clear: true }) })).toEqual({ fleet: 'f', delay: 0.5, order: { type: 'targets', clear: true } });
    expect(normalizeFleetOrderRequest({ fleet: 'f', order: TARGETS({ primary: 'astra' }) }, { ships: SHIPS, objects: new Set(['astra']) }).order).toEqual({ type: 'targets', primary: 'astra' });

    expect(problemsOf({ fleet: 'f', order: TARGETS({}) })).toEqual([`order_fleet.order needs exactly one of ${FLEET_TARGETS_ACTIONS.join(', ')}`]);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ primary: 'gfc', clear: true }) })).toEqual([`order_fleet.order needs exactly one of ${FLEET_TARGETS_ACTIONS.join(', ')} (got primary, clear)`]);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ clear: true, x: 1 }) })).toEqual(['order_fleet.order.x is not a targets order field']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ next: false }) })).toEqual(['order_fleet.order.next must be true']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ primary: 'celestial:60003760' }) })).toEqual([`order_fleet.order.primary "celestial:60003760": ${CELESTIAL_TARGET_REFUSAL}`]);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ primary: 'nobody' }) })).toEqual(['order_fleet.order.primary "nobody" is not a ship or object in the scene']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ queue: ['gfc', 'nobody'] }) })).toEqual(['order_fleet.order.queue[1] "nobody" is not a ship or object in the scene']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ queue: [] }) })).toEqual(['order_fleet.order.queue must be a non-empty array of ship or object ids']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ set: ['gfc', 'gfc'] }) })).toEqual(['order_fleet.order.set[1] "gfc" is named more than once']);
    expect(problemsOf({ fleet: 'f', order: TARGETS({ drop: 'gfc' }) })).toEqual(['order_fleet.order.drop must be a non-empty array of ship or object ids']);
  });

  it('reads free fire: on is a boolean, nothing else', () => {
    const order = normalize({ fleet: 'f', squad: 'dps', order: { type: 'free-fire', on: true } }).order;
    expect(order).toEqual({ type: 'free-fire', on: true });
    expect(isFleetFreeFireOrder(order)).toBe(true);
    expect(isFleetDocumentOrder(order)).toBe(false);
    expect(isFleetShipOrder(order)).toBe(false);
    expect(isFleetShipOrder(normalize({ fleet: 'f', order: STOP }).order)).toBe(true);
    expect(normalize({ fleet: 'f', order: { type: 'free-fire', on: false } }).order).toEqual({ type: 'free-fire', on: false });
    expect(problemsOf({ fleet: 'f', order: { type: 'free-fire' } })).toEqual(['order_fleet.order.on must be true (each member without a call picks its own target) or false (free fire ends)']);
    expect(problemsOf({ fleet: 'f', order: { type: 'free-fire', on: 'yes', range: 5 } })).toEqual(['order_fleet.order.range is not a free-fire order field', 'order_fleet.order.on must be true (each member without a call picks its own target) or false (free fire ends)']);
    expect(resolve({ fleet: 'f', squad: 'dps', order: { type: 'free-fire', on: true } })).toMatchObject({ issuer: 'a1', ships: ['a1', 'a2', 'a3'] });
    expect(toFleetOrderOperations(TWO_WINGS(), resolve({ fleet: 'f', order: { type: 'free-fire', on: true } }))).toEqual([]);
  });

  it('is a document order, not a structure order', () => {
    const order = normalize({ fleet: 'f', order: TARGETS({ clear: true }) }).order;
    expect(isFleetDocumentOrder(order)).toBe(true);
    expect(isFleetStructureOrder(order)).toBe(false);
    expect(isFleetDocumentOrder(normalize({ fleet: 'f', order: { type: 'regroup' } }).order)).toBe(true);
    expect(isFleetDocumentOrder(normalize({ fleet: 'f', order: STOP }).order)).toBe(false);
  });

  it("is given by the group's commanders, and may not call one of its own ships", () => {
    expect(resolve({ fleet: 'f', squad: 'dps', order: TARGETS({ primary: 'b1' }) })).toMatchObject({ issuer: 'a1', ships: ['a1', 'a2', 'a3'] });
    expect(resolveProblems({ fleet: 'f', by: 'wc1', order: TARGETS({ clear: true }) })[0]).toMatch(/^order_fleet: ship "wc1" has no command over fleet "f"/u);
    expect(resolveProblems({ fleet: 'f', squad: 'dps', order: TARGETS({ primary: 'a2' }) })).toEqual(['order_fleet.order: squad "dps" of fleet "f" cannot call one of its own ships ("a2")']);
    expect(resolveProblems({ fleet: 'f', squad: 'dps', order: TARGETS({ set: ['b1', 'fc', 'a3'] }) })).toEqual(['order_fleet.order: squad "dps" of fleet "f" cannot call one of its own ships ("fc")', 'order_fleet.order: squad "dps" of fleet "f" cannot call one of its own ships ("a3")']);
    expect(resolveProblems({ fleet: 'f', order: TARGETS({ queue: ['gfc', 'l2'] }) })).toEqual(['order_fleet.order: fleet "f" cannot call one of its own ships ("l2")']);
    expect(resolve({ fleet: 'f', squad: 'dps', order: TARGETS({ drop: ['a2'] }) }).group).toEqual({ fleet: 'f', kind: 'squad', id: 'dps' });
  });

  it("compiles each action to the group's new list", () => {
    expect(opsOf({ primary: 'l1' })).toEqual([{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: ['l1', 'b1', 'b2'] } }]);
    expect(listOf({ primary: 'gfc' })).toEqual(['gfc', 'b1', 'b2', 'l1']);
    expect(listOf({ primary: 'b1' })).toBe('unchanged');
    expect(listOf({ queue: ['l2', 'b1', 'gfc'] })).toEqual(['b1', 'b2', 'l1', 'l2', 'gfc']);
    expect(listOf({ queue: ['b2'] })).toBe('unchanged');
    expect(listOf({ set: ['gfc'] })).toEqual(['gfc']);
    expect(listOf({ set: [] })).toBeNull();
    expect(listOf({ drop: ['b2', 'b1'] })).toEqual(['l1']);
    expect(listOf({ clear: true })).toBeNull();
    expect(opsOf({ clear: true }, {}, { squad: 'tackle' })).toEqual([]);
    expect(opsOf({ primary: 'gfc' }, {}, {})).toEqual([{ op: 'update_fleet', fleet: 'f', set: { targets: ['gfc'] } }]);
    expect(opsOf({ set: ['b1', 'gfc'] }, {}, { wing: 'w1' })).toEqual([{ op: 'update_wing', fleet: 'f', wing: 'w1', set: { targets: ['b1', 'gfc'] } }]);

    const applied = applySceneOperations(CALLED(), opsOf({ primary: 'gfc' })).scene;
    expect(applied.fleets?.[0].wings[0].squads[0].targets).toEqual(['gfc', 'b1', 'b2', 'l1']);
  });

  it('moves next past the live primary (every entry live without a status), else past the first entry', () => {
    expect(listOf({ next: true })).toEqual(['b2', 'l1']);
    expect(listOf({ next: true }, { statusOf: (id) => (id === 'b1' ? 'destroyed' : 'live') })).toEqual(['b1', 'l1']);
    expect(listOf({ next: true }, { statusOf: () => 'destroyed' })).toEqual(['b2', 'l1']);
    const single = applySceneOperations(TWO_WINGS(), [{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: ['gfc'] } }]).scene;
    expect(opsOf({ next: true }, {}, { squad: 'dps' }, single)).toEqual([{ op: 'update_squad', fleet: 'f', squad: 'dps', set: { targets: null } }]);
  });

  it('refuses a drop of an uncalled id, next on an empty list and a list past the fleet size', () => {
    expect(catchSceneError(() => opsOf({ drop: ['gfc', 'b1'] })).problems).toEqual(['order_fleet.order.drop: squad "dps" of fleet "f" does not call "gfc"']);
    expect(catchSceneError(() => opsOf({ next: true }, {}, { squad: 'tackle' })).problems).toEqual(['order_fleet.order.next: squad "tackle" of fleet "f" calls no targets']);
    const full = structuredClone(CALLED());
    const dps = full.fleets?.[0].wings[0].squads[0];
    if (dps) dps.targets = Array.from({ length: MAX_CALLED_TARGETS }, (_, index) => `x${index}`);
    expect(catchSceneError(() => opsOf({ queue: ['gfc'] }, {}, { squad: 'dps' }, full)).problems).toEqual([`order_fleet.order: squad "dps" of fleet "f" would call ${MAX_CALLED_TARGETS + 1} targets; at most ${MAX_CALLED_TARGETS} (EVE's fleet size)`]);
  });
});
