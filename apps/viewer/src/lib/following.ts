/**
 * Follow the FC in the page: keeps the world's following (DestinyWorld.Follow) in line with the document's fleets.
 *
 * - Every fleet member with an anchor (toFleetMemberships; never the FC) follows its plan (toFleetFollowPlans): its
 *   resolved anchor, and its formation slot laid out at the FC's document placement with the balls' radii.
 * - A fleet is planned only once every ship holding a position in it has a settled radius (radiusOf), so a fleet added
 *   in formation is planned with the radii it was laid out with. Until then members already following keep their
 *   slots, and new members wait.
 * - An explicit order on a member (Detach) takes it out of formation until Rejoin, a fleet edit that regroups it, or a
 *   restart (load_scene / open_scene). The FC is never detached: its orders are how its fleet moves.
 * - Ships whose following ends (they left their fleet, it was removed, they became its FC) stop on both parks;
 *   Reconcile returns them for changes.stopped.
 *
 * Node-tested: it imports the world's types only.
 */

import type { Maybe } from '@dereekb/util';
import { toFleetAnchors, toFleetFollowPlans, toFleetMemberships, toFollowTolerance, type FleetFollowPlan, type SceneDocument, type SceneFleet, type SceneVector, type ShipFleetMembership } from '@scene-director/scene';
import type { DestinyWorld, ShipFollow } from './destiny';

export type FollowingState = 'in-formation' | 'catching-up' | 'detached' | 'waiting';

/**
 * A fleet member's following, as get_state reports it.
 */
export interface ShipFollowingReport {
  readonly state: FollowingState;
  /**
   * The ship it keeps range on.
   */
  readonly anchor: string;
  /**
   * The range it keeps, metres surface to surface.
   */
  readonly range: number;
  /**
   * Its formation slot: the range from its anchor and the direction in the FC's heading frame.
   */
  readonly slot?: { readonly range: number; readonly direction: SceneVector };
  /**
   * Metres, surface to surface on the balls' radii, to the anchor.
   */
  readonly distance?: number;
  /**
   * Metres from the slot point.
   */
  readonly slotError?: number;
}

/**
 * A fleet's formation, as get_state reports it.
 */
export interface FleetFormationReport {
  /**
   * Whether the fleet is planned (every ship holding a position in it has a settled radius).
   */
  readonly ready: boolean;
  /**
   * The FC's heading, [yaw, pitch] degrees.
   */
  readonly heading: [number, number];
  /**
   * The members that keep range on an anchor (all but the FC); the four counts below split them.
   */
  readonly following: number;
  readonly inFormation: number;
  readonly catchingUp: number;
  readonly detached: number;
  readonly waiting: number;
}

export interface FleetFollowingOptions {
  readonly world: DestinyWorld;
  readonly scene: () => Maybe<SceneDocument>;
  /**
   * A ship's settled ball radius, or null while its /ship-stats answer or SOF build is pending.
   */
  readonly radiusOf: (id: string) => Maybe<number>;
}

export interface FleetReconcileInput {
  /**
   * Ships whose membership changed (diffScenes' regrouped): they leave the detached state.
   */
  readonly regrouped?: Iterable<string>;
  /**
   * A load: every ship leaves the detached state.
   */
  readonly restart?: boolean;
}

interface PlannedFleet {
  readonly key: string;
  readonly plans: Map<string, FleetFollowPlan>;
}

/**
 * The page's fleet following: the document's fleets turned into the world's follows.
 */
export class FleetFollowing {
  private readonly world: DestinyWorld;
  private readonly scene: () => Maybe<SceneDocument>;
  private readonly radiusOf: (id: string) => Maybe<number>;
  /**
   * Members an explicit order took out of formation.
   */
  private readonly detached = new Set<string>();
  /**
   * Each fleet's plans, by fleet id, with the input they were made from.
   */
  private readonly planned = new Map<string, PlannedFleet>();
  /**
   * The fleet each ship was last told to follow in, for the note when its following ends.
   */
  private readonly fleetOf = new Map<string, string>();
  private memberships: Maybe<{ readonly scene: SceneDocument; readonly map: Map<string, ShipFleetMembership> }> = null;

  constructor(options: FleetFollowingOptions) {
    this.world = options.world;
    this.scene = options.scene;
    this.radiusOf = options.radiusOf;
  }

  /**
   * Brings the world's following in line with the document: follows every member's plan where it differs from what
   * the world flies, and ends the following of ships that no longer follow.
   *
   * @param input - The regrouped ships and whether this is a load.
   * @returns The ships whose following ended (they stopped), in document order.
   */
  Reconcile(input: FleetReconcileInput = {}): string[] {
    const scene = this.scene();
    if (input.restart) this.detached.clear();
    for (const id of input.regrouped ?? []) this.detached.delete(id);
    const memberships = this.Memberships();
    for (const id of [...this.detached]) if (!memberships.get(id)?.anchor) this.detached.delete(id);

    const wanted = new Map<string, ShipFollow>();
    const kept = new Set<string>();
    const fleets = new Set<string>();
    for (const fleet of scene?.fleets ?? []) {
      fleets.add(fleet.id);
      const plans = scene ? this.Plans(scene, fleet) : null;
      for (const [ship, membership] of toFleetAnchors(fleet)) {
        if (!membership.anchor || this.detached.has(ship)) continue;
        const plan = plans?.get(ship);
        if (plan) wanted.set(ship, ToFollow(plan));
        else if (!plans && this.world.Following(ship)?.frame === fleet.commander) kept.add(ship);
      }
    }
    for (const id of [...this.planned.keys()]) if (!fleets.has(id)) this.planned.delete(id);

    const stopped: string[] = [];
    for (const { id } of scene?.ships ?? []) {
      const want = wanted.get(id);
      const current = this.world.Following(id);
      if (want) {
        if (!SameFollow(want, current) && this.world.Follow(id, want)) this.fleetOf.set(id, memberships.get(id)?.fleet ?? '');
      } else if (current && !kept.has(id) && this.world.Unfollow(id, this.EndNote(id, fleets))) {
        stopped.push(id);
      }
    }
    return stopped;
  }

  /**
   * Records that an explicit order took a member out of formation.
   *
   * @param id - The ordered ship.
   * @returns True when it is a fleet member with an anchor (not the FC, not a ship in no fleet).
   */
  Detach(id: string): boolean {
    const member = Boolean(this.Memberships().get(id)?.anchor);
    if (member) this.detached.add(id);
    return member;
  }

  /**
   * Puts a detached member back in formation; a no-op for a member already following.
   *
   * @param id - The ship.
   * @returns Its following report.
   * @throws {Error} For the FC (it follows nobody) and for a ship in no fleet.
   */
  Rejoin(id: string): ShipFollowingReport {
    const membership = this.Memberships().get(id);
    if (!membership) throw new Error(`ship "${id}" is in no fleet; rejoin is for fleet members`);
    if (!membership.anchor) throw new Error(`ship "${id}" commands fleet "${membership.fleet}" and follows nobody; order it directly and its fleet follows`);
    this.detached.delete(id);
    this.Reconcile();
    return this.Report(id) ?? { state: 'waiting', anchor: membership.anchor.ship, range: membership.anchor.range };
  }

  /**
   * A fleet member's following.
   *
   * @param id - The ship.
   * @returns The report; null for the FC and ships in no fleet.
   */
  Report(id: string): Maybe<ShipFollowingReport> {
    const anchor = this.Memberships().get(id)?.anchor;
    if (!anchor) return null;
    const follow = this.detached.has(id) ? null : this.world.Following(id);
    const motion = follow ? this.world.Motion(id) : null;
    const anchorMotion = follow ? this.world.Motion(follow.anchor) : null;
    let report: ShipFollowingReport;
    if (this.detached.has(id)) {
      report = { state: 'detached', anchor: anchor.ship, range: anchor.range };
    } else if (!follow || !motion || !anchorMotion) {
      report = { state: 'waiting', anchor: anchor.ship, range: anchor.range };
    } else {
      const slotError = motion.slotError ?? 0;
      const tolerance = toFollowTolerance({ slotRange: follow.slotRange, anchorSpeed: anchorMotion.speed });
      const [x, y, z] = motion.position;
      const [ax, ay, az] = anchorMotion.position;
      report = {
        state: slotError <= tolerance ? 'in-formation' : 'catching-up',
        anchor: follow.anchor,
        range: follow.range,
        slot: { range: follow.slotRange, direction: follow.direction },
        distance: Math.round(Math.hypot(x - ax, y - ay, z - az) - motion.physics.radius - anchorMotion.physics.radius),
        slotError
      };
    }
    return report;
  }

  /**
   * A fleet's formation summary.
   *
   * @param fleet - The fleet (its id and commander).
   * @returns Whether it is planned, the FC's heading and the members' states.
   */
  FleetReport(fleet: Pick<SceneFleet, 'id' | 'commander'>): FleetFormationReport {
    const scene = this.scene();
    const document = scene?.fleets?.find((candidate) => candidate.id === fleet.id);
    const counts: Record<FollowingState, number> = { 'in-formation': 0, 'catching-up': 0, detached: 0, waiting: 0 };
    for (const [id, membership] of this.Memberships()) {
      if (membership.fleet !== fleet.id || !membership.anchor) continue;
      const state = this.Report(id)?.state;
      if (state) counts[state] += 1;
    }
    return {
      ready: Boolean(scene && document && this.Plans(scene, document)),
      heading: this.world.Motion(fleet.commander)?.heading ?? [0, 0],
      following: counts['in-formation'] + counts['catching-up'] + counts.detached + counts.waiting,
      inFormation: counts['in-formation'],
      catchingUp: counts['catching-up'],
      detached: counts.detached,
      waiting: counts.waiting
    };
  }

  /**
   * A fleet's plans, made at the FC's document placement with the settled radii; memoized per fleet.
   *
   * @param scene - The document.
   * @param fleet - One of its fleets.
   * @returns The plans; null while a radius is unsettled (or the fleet cannot be laid out, logged).
   */
  private Plans(scene: SceneDocument, fleet: SceneFleet): Maybe<Map<string, FleetFollowPlan>> {
    const fc = scene.ships.find((ship) => ship.id === fleet.commander);
    const holders = [...toFleetAnchors(fleet).keys()];
    const radii = holders.map((id) => this.radiusOf(id));
    if (!fc || radii.some((radius) => radius == null)) return null;
    const key = JSON.stringify([fleet, fc.position, fc.rotation[0], radii]);
    const memo = this.planned.get(fleet.id);
    if (memo?.key === key) return memo.plans;
    const radius = new Map(holders.map((id, index) => [id, radii[index] ?? 0]));
    let plans: Maybe<Map<string, FleetFollowPlan>> = null;
    try {
      plans = toFleetFollowPlans({ fleet, origin: fc.position, heading: fc.rotation[0], radiusOf: (id) => radius.get(id) ?? 0 });
      this.planned.set(fleet.id, { key, plans });
    } catch (error) {
      console.warn(`fleet ${fleet.id}: no formation (${error instanceof Error ? error.message : String(error)}); its members keep their slots`);
    }
    return plans;
  }

  /**
   * The document's fleet memberships, cached per document.
   *
   * @returns Each fleet ship's membership.
   */
  private Memberships(): Map<string, ShipFleetMembership> {
    const scene = this.scene();
    if (!scene) return new Map();
    if (this.memberships?.scene !== scene) this.memberships = { scene, map: toFleetMemberships(scene) };
    return this.memberships.map;
  }

  /**
   * Why a ship's following ended.
   *
   * @param id - The ship.
   * @param fleets - The document's fleet ids.
   * @returns Its orderNote.
   */
  private EndNote(id: string, fleets: ReadonlySet<string>): string {
    const fleet = this.fleetOf.get(id) ?? '';
    const membership = this.Memberships().get(id);
    this.fleetOf.delete(id);
    let reason = `it left fleet "${fleet}"`;
    if (membership && !membership.anchor) reason = `it is the fleet commander of "${membership.fleet}"`;
    else if (!fleets.has(fleet)) reason = `fleet "${fleet}" was removed`;
    return `stopped: no longer following (${reason})`;
  }
}

/**
 * The follow a plan gives the world: at each member's own speed.
 *
 * @param plan - The member's plan.
 * @returns The follow.
 */
function ToFollow(plan: FleetFollowPlan): ShipFollow {
  return { anchor: plan.anchor.ship, range: plan.anchor.range, frame: plan.commander, direction: plan.slot.direction, slotRange: plan.slot.range, speed: 1 };
}

/**
 * Whether two follows fly the same.
 *
 * @param a - One follow.
 * @param b - The other, or null.
 * @returns True when every field matches.
 */
function SameFollow(a: ShipFollow, b: Maybe<ShipFollow>): boolean {
  return Boolean(b) && a.anchor === b?.anchor && a.range === b.range && a.frame === b.frame && a.slotRange === b.slotRange && a.speed === b.speed && a.direction.every((value, axis) => value === b.direction[axis]);
}
