import { describe, expect, it } from 'vitest';
import { expandFleetComposition } from '../compositions/expand';
import { tfisComposition } from '../compositions/compositions.spec-helper';
import { applySceneOperations, normalizeScene, type SceneDocument } from '../scene';
import type { SceneFleet } from './fleet';
import { makeFleetScene, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { type FleetFollowPlan, toFleetFollowPlans, toFollowTolerance } from './following';
import { toFleetMemberships } from './membership';

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
