/**
 * The battle console's read-only fleet views (api.ts FleetView), assembled from the page's fleet reports: the brain's
 * (FleetCommanders.Report and Targets, FreeFireOf), the calls (FleetTargets.GroupReport), the pilots' stance states,
 * the logi (AutoRepair.FleetReport), the formation (FleetFollowing.FleetReport) and each member's life, arrival and HP.
 *
 * Node-tested: pure, type-only imports.
 */

import type { Maybe } from '@dereekb/util';
import type { FleetPictureShip, SceneFleet, SceneVector } from '@scene-director/scene';
import type { FleetView, FleetViewBrain, FleetViewTarget } from './api';
import type { AutoRepairFleetReport } from './auto-repair';
import type { FleetCommandReport } from './fleet-commanders';
import type { FleetGroupCalledReport } from './fleet-targets';
import type { FleetFormationReport } from './following';

/**
 * How many of the brain's decisions a view keeps, newest last.
 */
export const FLEET_VIEW_DECISIONS = 5;

/**
 * One fleet member, as the director sees it now.
 */
export interface FleetViewMember {
  readonly id: string;
  readonly team?: string;
  /**
   * Not destroyed.
   */
  readonly alive: boolean;
  /**
   * Parked off grid or landing from a warp-in.
   */
  readonly arriving: boolean;
  /**
   * Its HP and max HP over every layer (0 / 0 without a damage model).
   */
  readonly hp: number;
  readonly max: number;
  readonly position?: SceneVector;
  readonly velocity?: SceneVector;
}

/**
 * Everything one fleet's view is built from.
 */
export interface FleetViewSources {
  readonly fleet: Pick<SceneFleet, 'id' | 'name' | 'commander' | 'personality'>;
  /**
   * The fleet's members (its live ships), in fleet order.
   */
  readonly members: readonly FleetViewMember[];
  readonly fc: Maybe<FleetCommandReport>;
  readonly called: Maybe<Pick<FleetGroupCalledReport, 'primary' | 'queue'>>;
  readonly freeFire: boolean;
  readonly targets: Maybe<{ readonly ranked: readonly FleetPictureShip[]; readonly reach: number }>;
  readonly stances: Maybe<Readonly<Record<string, number>>>;
  readonly formation: Maybe<FleetFormationReport>;
  readonly autoRepair: Maybe<AutoRepairFleetReport>;
}

/**
 * Builds a fleet's view.
 *
 * @param sources - The fleet's reports and members.
 * @returns The view.
 */
export function toFleetView(sources: FleetViewSources): FleetView {
  const { fleet, members, fc, called, freeFire, targets, stances, formation, autoRepair } = sources;
  const ship = fc?.ship ?? fleet.commander;
  const commander = members.find((member) => member.id === ship);
  const alive = members.filter((member) => member.alive);
  let hp = 0;
  let max = 0;
  for (const member of alive) {
    hp += member.hp;
    max += member.max;
  }
  const primary = called?.primary ?? null;
  const queue = called?.queue ?? [];
  const team = commander?.team ?? members.find((member) => member.team != null)?.team;
  return {
    id: fleet.id,
    ...(fleet.name != null ? { name: fleet.name } : {}),
    ...(team != null ? { team } : {}),
    personality: fleet.personality ?? null,
    fc: ship,
    state: fc?.state ?? 'none',
    brain: fc ? toFleetViewBrain(fc) : null,
    ships: members.length,
    alive: alive.length,
    arriving: alive.filter((member) => member.arriving).length,
    health: alive.length && max > 0 ? hp / max : null,
    primary,
    queue,
    freeFire,
    targets: (targets?.ranked ?? []).map((target) => toFleetViewTarget(target, targets?.reach ?? 0, primary, queue)),
    reach: targets?.reach ?? null,
    fcMotion: commander?.alive && commander.position ? { position: commander.position, ...(commander.velocity ? { velocity: commander.velocity } : {}) } : null,
    stances: stances ?? {},
    formation: formation ? { ready: formation.ready, following: formation.following, inFormation: formation.inFormation, warping: formation.warping } : null,
    logi: autoRepair ? { logi: autoRepair.logi, repairing: autoRepair.repairing, idle: autoRepair.idle, off: autoRepair.off } : null
  };
}

function toFleetViewBrain(fc: FleetCommandReport): FleetViewBrain {
  return {
    personality: fc.personality,
    state: fc.state,
    ability: fc.ability,
    engaged: fc.engaged,
    ...(fc.engagedBy != null ? { engagedBy: fc.engagedBy } : {}),
    stance: fc.stance,
    manual: fc.manual,
    held: fc.held === true,
    ...(fc.successor != null ? { successor: fc.successor } : {}),
    ...(fc.takesOverIn != null ? { takesOverIn: fc.takesOverIn } : {}),
    hostiles: fc.hostiles,
    decisions: fc.decisions.slice(-FLEET_VIEW_DECISIONS).map((decision) => ({ tick: decision.tick, lever: decision.lever, why: decision.why, ...(decision.refused != null ? { refused: decision.refused } : {}) })),
    ...(fc.note != null ? { note: fc.note } : {})
  };
}

function toFleetViewTarget(ship: FleetPictureShip, reach: number, primary: Maybe<string>, queue: readonly string[]): FleetViewTarget {
  let called: FleetViewTarget['called'];
  if (ship.id === primary) called = 'primary';
  else if (queue.includes(ship.id)) called = 'queued';
  return {
    id: ship.id,
    ...(ship.team != null ? { team: ship.team } : {}),
    role: ship.role,
    distance: ship.distance,
    health: ship.health,
    dps: ship.dps,
    inReach: ship.distance <= reach,
    ...(called ? { called } : {})
  };
}
