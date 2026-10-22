import { describe, expect, it } from 'vitest';
import { expandFleetComposition } from '../compositions/expand';
import { tfisComposition } from '../compositions/compositions.spec-helper';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import type { SceneFleet } from './fleet';
import { makeFleetScene, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { type FleetFollowPlan, toFleetFollowPlans, toFleetGroupFollowPlans, toFollowTolerance } from './following';
import { layoutFleetFormation } from './formation';
import { toFleetAnchors, toFleetMemberships } from './membership';

const RADIUS = 150;

function plansOf(scene: SceneDocument, fleetIndex = 0): Map<string, FleetFollowPlan> {
  const fleet = scene.fleets![fleetIndex];
  const fc = scene.ships.find((ship) => ship.id === fleet.commander)!;
  return toFleetFollowPlans({ fleet, origin: fc.position, heading: fc.rotation[0], radiusOf: () => RADIUS });
}

function expectPlansFollowTheMemberships(scene: Pick<SceneDocument, 'fleets'>, plans: Map<string, FleetFollowPlan>, fleet: SceneFleet): void {
  const anchored = [...toFleetMemberships(scene)].filter(([, membership]) => membership.fleet === fleet.id && membership.anchor);
  expect([...plans.keys()].sort()).toEqual(anchored.map(([ship]) => ship).sort());
  for (const [ship, membership] of anchored) {
    const plan = plans.get(ship)!;
    expect(plan.anchor, ship).toEqual(membership.anchor);
    expect(plan.slot.anchor, ship).toBe(plan.anchor.ship);
    expect(plan.commander).toBe(fleet.commander);
    expect(plan.fleet).toBe(fleet.id);
  }
}

describe('toFleetFollowPlans', () => {
  it('flies exactly the resolved anchors of the TFIs composition', () => {
    const expanded = expandFleetComposition({ composition: tfisComposition(), position: [0, 0, 0], heading: 0, existing: { ships: new Map(), fleets: new Set() } });
    const fleet = expanded.fleet!;
    const plans = toFleetFollowPlans({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: () => RADIUS });
    expectPlansFollowTheMemberships({ fleets: [fleet] }, plans, fleet);
    expect(plans.has(fleet.commander)).toBe(false);
  });

  it('flies the sd-fleets example: the logi lead on the FC at 30 km, guardian-2 on the lead at 1 km', () => {
    const scene = normalizeScene(TFI_FLEET_SCENE).scene;
    const plans = plansOf(scene);
    expectPlansFollowTheMemberships(scene, plans, scene.fleets![0]);
    expect(plans.get('guardian-1')?.anchor).toEqual({ ship: 'fc', range: 30000 });
    expect(plans.get('guardian-2')?.anchor).toEqual({ ship: 'guardian-1', range: 1000 });
    expect(plans.get('guardian-2')?.slot).toMatchObject({ anchor: 'guardian-1', range: 1000 });
  });

  it('plans a wing commander outside squads, and none for an FC sitting in a squad', () => {
    const scene = normalizeScene(makeFleetScene(['fc', 'wc', 'a', 'b'], [{ id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'wc', squads: [{ id: 's', role: 'dps', members: ['fc', 'a', 'b'] }] }] }])).scene;
    const plans = plansOf(scene);
    expectPlansFollowTheMemberships(scene, plans, scene.fleets![0]);
    expect(plans.get('wc')?.anchor).toEqual({ ship: 'fc', range: 1000 });
    expect(plans.has('fc')).toBe(false);
  });

  it('re-plans on fleet edits', () => {
    const scene = normalizeScene(TFI_FLEET_SCENE).scene;
    const edit = (operations: unknown[]): SceneDocument => applySceneOperations(scene, operations).scene;

    expect(plansOf(edit([{ op: 'set_anchor', fleet: 'tfi', squad: 'logi', anchor: { range: 12000 } }])).get('guardian-1')?.anchor).toEqual({ ship: 'fc', range: 12000 });
    expect(plansOf(edit([{ op: 'move_to_squad', ships: ['tfi-3'], fleet: 'tfi', squad: 'logi' }])).get('tfi-3')?.anchor).toEqual({ ship: 'guardian-1', range: 1000 });

    const noLead = plansOf(edit([{ op: 'remove_ship', id: 'guardian-1' }]));
    expect(noLead.has('guardian-1')).toBe(false);
    expect(noLead.get('guardian-2')?.anchor).toEqual({ ship: 'fc', range: 30000 });

    const newFc = edit([{ op: 'update_fleet', fleet: 'tfi', set: { commander: 'tfi-1' } }]);
    const reframed = plansOf(newFc);
    expectPlansFollowTheMemberships(newFc, reframed, newFc.fleets![0]);
    expect(reframed.has('tfi-1')).toBe(false);
    for (const plan of reframed.values()) expect(plan.commander).toBe('tfi-1');
  });
});

describe('toFollowTolerance', () => {
  it('grows with the slot range and the anchor speed', () => {
    expect(toFollowTolerance({ slotRange: 1000, anchorSpeed: 0 })).toBe(250);
    expect(toFollowTolerance({ slotRange: 1000, anchorSpeed: 162 })).toBe(655);
    expect(toFollowTolerance({ slotRange: 30000, anchorSpeed: 0 })).toBe(1700);
  });
});

describe('toFleetGroupFollowPlans', () => {
  const HEADING = 30;
  const tfis = (): SceneFleet => expandFleetComposition({ composition: tfisComposition(), position: [0, 0, 0], heading: 0, existing: { ships: new Map(), fleets: new Set() } }).fleet!;
  const inputOf = (fleet: SceneFleet) => ({ fleet, origin: [0, 0, 5000] as [number, number, number], heading: HEADING, radiusOf: () => RADIUS });
  const rotate = ([x, y, z]: readonly number[]): number[] => {
    const yaw = (HEADING * Math.PI) / 180;
    return [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  };

  /**
   * Checks the plans of a group apart: in-group anchors keep the fleet plan; the rest re-root on the leader, landing on
   * their laid-out positions.
   */
  function expectGroupPlans(fleet: SceneFleet, leader: string, ships: string[]): Map<string, FleetFollowPlan> {
    const input = inputOf(fleet);
    const plans = toFleetGroupFollowPlans({ ...input, leader, ships });
    const fleetPlans = toFleetFollowPlans(input);
    const anchors = toFleetAnchors(fleet);
    const positions = layoutFleetFormation(input);
    expect([...plans.keys()]).toEqual(ships.filter((ship) => ship !== leader));
    for (const [ship, plan] of plans) {
      expect(plan.commander, ship).toBe(leader);
      expect(plan.fleet).toBe(fleet.id);
      const anchor = anchors.get(ship)!.anchor!;
      if (ships.includes(anchor.ship)) {
        expect(plan.anchor, ship).toEqual(anchor);
        expect(plan.slot, ship).toEqual(fleetPlans.get(ship)!.slot);
      } else {
        expect(plan.anchor.ship, ship).toBe(leader);
        expect(plan.slot.anchor, ship).toBe(leader);
        expect(plan.anchor.range).toBe(Math.round(plan.slot.range));
        const from = positions.get(leader)!;
        const direction = rotate(plan.slot.direction);
        const reach = plan.slot.range + 2 * RADIUS;
        const flown = [0, 1, 2].map((axis) => from[axis] + direction[axis] * reach);
        const at = positions.get(ship)!;
        expect(Math.hypot(flown[0] - at[0], flown[1] - at[1], flown[2] - at[2]), ship).toBeLessThanOrEqual(1);
      }
    }
    return plans;
  }

  it('re-roots a squad anchored on the FC on its leader, at the laid-out offsets', () => {
    const fleet = tfis();
    const squad = fleet.wings[0].squads.find((candidate) => candidate.id === 'dps-a')!;
    const plans = expectGroupPlans(fleet, squad.members[0], squad.members);
    for (const plan of plans.values()) expect(plan.anchor.ship).toBe(squad.members[0]);
  });

  it('keeps every anchor and slot of the logi squad apart on its own lead', () => {
    const fleet = tfis();
    const squad = fleet.wings.flatMap((wing) => wing.squads).find((candidate) => candidate.id === 'logi')!;
    const lead = squad.anchor!.ship!;
    const plans = expectGroupPlans(fleet, lead, squad.members);
    for (const plan of plans.values()) expect(plan.anchor.ship).toBe(lead);
  });

  it("re-roots a wing's squads anchored outside it and keeps its inner chains; the leader and outsiders get no plan", () => {
    const fleet = tfis();
    for (const wing of fleet.wings) {
      const ships = wing.squads.flatMap((squad) => squad.members).filter((ship) => ship !== fleet.commander);
      const plans = expectGroupPlans(fleet, ships[0], ships);
      expect(plans.has(ships[0])).toBe(false);
      expect(plans.has(fleet.commander)).toBe(false);
    }
  });
});
