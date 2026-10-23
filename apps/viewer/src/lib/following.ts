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
 * - Groups apart (order_fleet on a wing or squad, BreakAway): the group's leader flies its own order and the group's
 *   other ships follow it (toFleetGroupFollowPlans: in-group anchors kept, the rest re-rooted on the leader at their
 *   at-rest offsets, framed by the leader's heading), the most specific group apart winning. The document's anchors
 *   are untouched. A group stays apart until Regroup (order_fleet regroup, a fleet warp), a fleet edit that regroups
 *   one of its ships, its leader leaving the group, its fleet, wing or squad being removed, or a restart.
 *
 * Node-tested: it imports the world's types only.
 */

import type { Maybe } from '@dereekb/util';
import { selectFleetShips, toFleetAnchors, toFleetFollowPlans, toFleetGroupFollowPlans, toFleetGroupOffsets, toFleetMemberships, toFollowTolerance, type FleetFollowPlan, type FleetGroup, type SceneDocument, type SceneFleet, type SceneVector, type ShipFleetMembership } from '@scene-director/scene';
import type { DestinyWorld, ShipFollow } from './destiny';

/**
 * holding: stopped while its anchor or FC is in warp; it flies to its slot once that ship lands. warping: in a
 * formation warp, from the order until its group has landed. leading: it leads a wing or squad apart from its fleet.
 */
export type FollowingState = 'in-formation' | 'catching-up' | 'holding' | 'warping' | 'leading' | 'detached' | 'waiting' | 'arriving';

/**
 * A wing or squad flying apart from its fleet's formation on its leader.
 */
export interface FleetGroupApart {
  /**
   * toFleetGroupKey of the group.
   */
  readonly key: string;
  /**
   * Its kind is wing or squad.
   */
  readonly group: FleetGroup;
  readonly leader: string;
  /**
   * The group's ships, the leader among them.
   */
  readonly ships: readonly string[];
}

interface ApartRecord {
  readonly key: string;
  readonly group: FleetGroup;
  readonly leader: string;
  readonly ships: Set<string>;
}

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
  /**
   * Holding: the ship in warp it holds for; warping: the leader it warps with.
   */
  readonly warping?: string;
  /**
   * While it flies in, or leads, a wing or squad apart from its fleet.
   */
  readonly group?: { readonly kind: FleetGroup['kind']; readonly id: string; readonly leader: string };
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
   * The members that keep range on an anchor (all but the FC); the eight counts below split them.
   */
  readonly following: number;
  readonly inFormation: number;
  readonly catchingUp: number;
  readonly holding: number;
  readonly warping: number;
  readonly leading: number;
  readonly detached: number;
  readonly waiting: number;
  /**
   * Members still arriving by warp (parked off-grid, scheduled or in their warp-in).
   */
  readonly arriving: number;
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
  /**
   * The wings and squads flying apart, by group key.
   */
  private readonly apart = new Map<string, ApartRecord>();
  /**
   * Each group apart's plans, by group key, with the input they were made from.
   */
  private readonly apartPlanned = new Map<string, PlannedFleet>();
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
    const regrouped = new Set(input.regrouped ?? []);
    if (input.restart) {
      this.detached.clear();
      this.apart.clear();
    }
    for (const id of regrouped) this.detached.delete(id);
    const memberships = this.Memberships();
    for (const id of [...this.detached]) if (!memberships.get(id)?.anchor) this.detached.delete(id);
    this.CheckApart(scene, regrouped);
    const leaders = new Set([...this.apart.values()].map((record) => record.leader));

    const wanted = new Map<string, ShipFollow>();
    const kept = new Set<string>();
    const fleets = new Set<string>();
    for (const fleet of scene?.fleets ?? []) {
      fleets.add(fleet.id);
      const plans = scene ? this.Plans(scene, fleet) : null;
      for (const [ship, membership] of toFleetAnchors(fleet)) {
        if (!membership.anchor || this.detached.has(ship) || leaders.has(ship)) continue;
        const record = this.ApartRecordOf(ship);
        const groupPlans = record && scene ? this.ApartPlans(scene, fleet, record) : null;
        const plan = record ? groupPlans?.get(ship) : plans?.get(ship);
        const frame = record ? record.leader : fleet.commander;
        if (plan) wanted.set(ship, ToFollow(plan));
        else if (!(record ? groupPlans : plans) && this.world.Following(ship)?.frame === frame) kept.add(ship);
      }
    }
    for (const id of [...this.planned.keys()]) if (!fleets.has(id)) this.planned.delete(id);
    for (const key of [...this.apartPlanned.keys()]) if (!this.apart.has(key)) this.apartPlanned.delete(key);

    const stopped: string[] = [];
    for (const { id } of scene?.ships ?? []) {
      const want = wanted.get(id);
      const current = this.world.Following(id);
      if (want) {
        if (!SameFollow(want, current) && this.world.Follow(id, want)) this.fleetOf.set(id, memberships.get(id)?.fleet ?? '');
      } else if (current && !kept.has(id) && !leaders.has(id) && this.world.Unfollow(id, this.EndNote(id, fleets))) {
        stopped.push(id);
      }
    }
    return stopped;
  }

  /**
   * Records that an explicit order took a member out of formation; the leader of a group apart keeps leading it.
   *
   * @param id - The ordered ship.
   * @returns `detached`, `leading` for a group apart's leader, or null for the FC and ships in no fleet.
   */
  Detach(id: string): Maybe<'detached' | 'leading'> {
    let result: Maybe<'detached' | 'leading'> = null;
    if (this.LeadRecordOf(id)) result = 'leading';
    else if (this.Memberships().get(id)?.anchor) {
      this.detached.add(id);
      result = 'detached';
    }
    return result;
  }

  /**
   * Sets a wing or squad flying apart from its fleet on its leader (the caller has already ordered the leader, so it
   * follows nobody), and re-plans. A group apart whose ships all lie inside the new one merges into it.
   *
   * @param apart - The group, its leader and its ships.
   * @returns The ships whose following ended, as Reconcile returns them.
   */
  BreakAway(apart: FleetGroupApart): string[] {
    const ships = new Set(apart.ships);
    for (const [key, record] of this.apart) if (key !== apart.key && record.group.fleet === apart.group.fleet && [...record.ships].every((id) => ships.has(id))) this.apart.delete(key);
    this.apart.set(apart.key, { key: apart.key, group: apart.group, leader: apart.leader, ships });
    this.detached.delete(apart.leader);
    return this.Reconcile();
  }

  /**
   * Brings ships back into their fleet formation: out of the detached state and out of every group apart (a group whose
   * leader is among them dissolves), then re-plans.
   *
   * @param ships - The ships.
   * @returns The ships whose following ended, as Reconcile returns them.
   */
  Regroup(ships: Iterable<string>): string[] {
    const back = new Set(ships);
    for (const id of back) this.detached.delete(id);
    for (const [key, record] of this.apart) {
      if (back.has(record.leader)) this.apart.delete(key);
      else for (const id of back) record.ships.delete(id);
    }
    return this.Reconcile();
  }

  /**
   * Whether a fleet is planned (every ship holding a position in it has a settled radius).
   *
   * @param fleet - The fleet id.
   * @returns False for an unknown fleet.
   */
  Ready(fleet: string): boolean {
    const scene = this.scene();
    const document = scene?.fleets?.find((candidate) => candidate.id === fleet);
    return Boolean(scene && document && this.Plans(scene, document));
  }

  /**
   * Each ship's offset from a leader in the fleet's at-rest formation (toFleetGroupOffsets), laid out as the fleet's
   * plans are: at the FC's document placement with the settled radii.
   *
   * @param fleet - The fleet id.
   * @param leader - The ship the offsets are from.
   * @param ships - The ships to give offsets for.
   * @returns The offsets, or null while the fleet is not planned.
   */
  GroupOffsets(fleet: string, leader: string, ships: readonly string[]): Maybe<Map<string, SceneVector>> {
    const scene = this.scene();
    const document = scene?.fleets?.find((candidate) => candidate.id === fleet);
    const input = scene && document && this.Plans(scene, document) ? this.LayoutInput(scene, document) : null;
    let offsets: Maybe<Map<string, SceneVector>> = null;
    if (input) {
      try {
        offsets = toFleetGroupOffsets({ ...input, leader, ships });
      } catch (error) {
        console.warn(`fleet ${fleet}: no group offsets (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return offsets;
  }

  /**
   * A group apart.
   *
   * @param key - Its group key.
   * @returns The group, its leader and its ships; null when it is not apart.
   */
  Apart(key: string): Maybe<FleetGroupApart> {
    const record = this.apart.get(key);
    return record ? ToApart(record) : null;
  }

  /**
   * The most specific group apart a ship flies in or leads.
   *
   * @param id - The ship.
   * @returns The group, or null.
   */
  ApartOf(id: string): Maybe<FleetGroupApart> {
    const record = this.LeadRecordOf(id) ?? this.ApartRecordOf(id);
    return record ? ToApart(record) : null;
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
    const leads = this.LeadRecordOf(id);
    if (leads) throw new Error(`ship "${id}" leads ${leads.group.kind} "${leads.group.id}" apart from fleet "${leads.group.fleet}"; order_fleet regroup brings the group back`);
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
    const apart = this.ApartOf(id);
    const group = apart ? { group: { kind: apart.group.kind, id: apart.group.id, leader: apart.leader } } : {};
    let report: ShipFollowingReport;
    if (this.detached.has(id)) {
      report = { state: 'detached', anchor: anchor.ship, range: anchor.range, ...group };
    } else if (apart?.leader === id) {
      report = { state: 'leading', anchor: anchor.ship, range: anchor.range, ...group };
    } else if (this.world.Arriving(id)) {
      report = { state: 'arriving', anchor: anchor.ship, range: anchor.range, ...group };
    } else if (!follow || !motion || !anchorMotion) {
      report = { state: 'waiting', anchor: anchor.ship, range: anchor.range };
    } else {
      const slotError = motion.slotError ?? 0;
      const tolerance = toFollowTolerance({ slotRange: follow.slotRange, anchorSpeed: anchorMotion.speed });
      const [x, y, z] = motion.position;
      const [ax, ay, az] = anchorMotion.position;
      // The tolerance grows with the anchor's speed, which an anchor in warp would make meaningless.
      const formation = this.world.FormationWarpOf(id);
      const warping = formation?.leader ?? this.world.FollowHold(id);
      let state: FollowingState = slotError <= tolerance ? 'in-formation' : 'catching-up';
      if (formation) state = 'warping';
      else if (warping) state = 'holding';
      report = {
        state,
        anchor: follow.anchor,
        range: follow.range,
        slot: { range: follow.slotRange, direction: follow.direction },
        distance: Math.round(Math.hypot(x - ax, y - ay, z - az) - motion.physics.radius - anchorMotion.physics.radius),
        slotError,
        ...(warping ? { warping } : {}),
        ...group
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
    const counts: Record<FollowingState, number> = { 'in-formation': 0, 'catching-up': 0, holding: 0, warping: 0, leading: 0, detached: 0, waiting: 0, arriving: 0 };
    for (const [id, membership] of this.Memberships()) {
      if (membership.fleet !== fleet.id || !membership.anchor) continue;
      const state = this.Report(id)?.state;
      if (state) counts[state] += 1;
    }
    return {
      ready: Boolean(scene && document && this.Plans(scene, document)),
      heading: this.world.Motion(fleet.commander)?.heading ?? [0, 0],
      following: Object.values(counts).reduce((sum, count) => sum + count, 0),
      inFormation: counts['in-formation'],
      catchingUp: counts['catching-up'],
      holding: counts.holding,
      warping: counts.warping,
      leading: counts.leading,
      detached: counts.detached,
      waiting: counts.waiting,
      arriving: counts.arriving
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
    const input = this.LayoutInput(scene, fleet);
    if (!input) return null;
    const memo = this.planned.get(fleet.id);
    if (memo?.key === input.key) return memo.plans;
    let plans: Maybe<Map<string, FleetFollowPlan>> = null;
    try {
      plans = toFleetFollowPlans(input);
      this.planned.set(fleet.id, { key: input.key, plans });
    } catch (error) {
      console.warn(`fleet ${fleet.id}: no formation (${error instanceof Error ? error.message : String(error)}); its members keep their slots`);
    }
    return plans;
  }

  /**
   * A group apart's plans, laid out as its fleet's are; memoized per group.
   *
   * @param scene - The document.
   * @param fleet - The group's fleet.
   * @param record - The group apart.
   * @returns The plans; null while a radius is unsettled (or the group cannot be laid out, logged).
   */
  private ApartPlans(scene: SceneDocument, fleet: SceneFleet, record: ApartRecord): Maybe<Map<string, FleetFollowPlan>> {
    const input = this.LayoutInput(scene, fleet);
    if (!input) return null;
    const ships = [...record.ships];
    const key = JSON.stringify([record.key, record.leader, ships, input.key]);
    const memo = this.apartPlanned.get(record.key);
    if (memo?.key === key) return memo.plans;
    let plans: Maybe<Map<string, FleetFollowPlan>> = null;
    try {
      plans = toFleetGroupFollowPlans({ ...input, leader: record.leader, ships });
      this.apartPlanned.set(record.key, { key, plans });
    } catch (error) {
      console.warn(`${record.key}: no formation apart (${error instanceof Error ? error.message : String(error)}); its ships keep their slots`);
    }
    return plans;
  }

  /**
   * What a fleet is laid out with: the FC's document placement and the settled radii.
   *
   * @param scene - The document.
   * @param fleet - One of its fleets.
   * @returns The layout input with its memo key; null while a radius is unsettled.
   */
  private LayoutInput(scene: SceneDocument, fleet: SceneFleet): Maybe<{ readonly key: string; readonly fleet: SceneFleet; readonly origin: SceneVector; readonly heading: number; readonly radiusOf: (id: string) => number }> {
    const fc = scene.ships.find((ship) => ship.id === fleet.commander);
    const holders = [...toFleetAnchors(fleet).keys()];
    const radii = holders.map((id) => this.radiusOf(id));
    if (!fc || radii.some((radius) => radius == null)) return null;
    const radius = new Map(holders.map((id, index) => [id, radii[index] ?? 0]));
    // Called targets do not move anyone: a live call must not re-run the layout.
    const shape = JSON.stringify(fleet, (key, value: unknown) => (key === 'targets' ? undefined : value));
    return { key: JSON.stringify([shape, fc.position, fc.rotation[0], radii]), fleet, origin: fc.position, heading: fc.rotation[0], radiusOf: (id) => radius.get(id) ?? 0 };
  }

  /**
   * Ends the groups apart the document no longer holds (their fleet, wing or squad is gone, their leader left the
   * group, or a fleet edit regrouped one of their ships) and trims the rest to the group's current ships.
   *
   * @param scene - The document.
   * @param regrouped - Ships whose membership changed.
   */
  private CheckApart(scene: Maybe<SceneDocument>, regrouped: ReadonlySet<string>): void {
    for (const [key, record] of this.apart) {
      const { fleet, kind, id } = record.group;
      const document = scene?.fleets?.find((candidate) => candidate.id === fleet);
      const selected = scene && document ? selectFleetShips(scene, kind === 'wing' ? { fleet, wing: id } : { fleet, squad: id }) : null;
      const current = new Set((selected?.ships ?? []).filter((ship) => ship !== document?.commander));
      if (!selected || selected.problems.length || !current.has(record.leader) || [...record.ships].some((ship) => regrouped.has(ship))) {
        this.apart.delete(key);
      } else {
        for (const ship of [...record.ships]) if (!current.has(ship)) record.ships.delete(ship);
      }
    }
  }

  /**
   * The most specific group apart a ship flies in (the smallest containing it).
   *
   * @param id - The ship.
   * @returns The record, or null.
   */
  private ApartRecordOf(id: string): Maybe<ApartRecord> {
    let found: Maybe<ApartRecord> = null;
    for (const record of this.apart.values()) if (record.ships.has(id) && (!found || record.ships.size < found.ships.size)) found = record;
    return found;
  }

  /**
   * The most specific group apart a ship leads.
   *
   * @param id - The ship.
   * @returns The record, or null.
   */
  private LeadRecordOf(id: string): Maybe<ApartRecord> {
    let found: Maybe<ApartRecord> = null;
    for (const record of this.apart.values()) if (record.leader === id && (!found || record.ships.size < found.ships.size)) found = record;
    return found;
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

function ToApart(record: ApartRecord): FleetGroupApart {
  return { key: record.key, group: record.group, leader: record.leader, ships: [...record.ships] };
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
