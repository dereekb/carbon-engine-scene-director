/**
 * order_fleet's live half: what a fleet, wing or squad order does to the world once the request is resolved (and any
 * document edit applied), and each group's command as get_state reports it.
 *
 * - Move: the order goes to the group's leader (the FC for a fleet, so the fleet follows as it always does). A wing or
 *   squad then flies apart from its fleet on its leader (FleetFollowing.BreakAway) until a regroup.
 * - Warp: the whole group warps in formation. The leader warps; every other ship warps with it to its slot
 *   (DestinyWorld.WarpInFormation), its at-rest offset from the leader (toFleetGroupOffsets) around the leader's
 *   landing in the warp's heading frame. Ships in warp keep their own warp; tackled ships (DestinyWorld.Tackle) stay,
 *   regrouped, holding while the leader warps; ships that cannot move or whose slot is under MIN_WARP_DISTANCE away fly
 *   instead. A fleet warp regroups every ship apart or detached first; a wing or squad warp lands the group apart, on
 *   its leader.
 * - Regroup: ships apart or detached rejoin their fleet formation, and those MIN_WARP_DISTANCE or more from their slot
 *   warp back to it in formation with the FC.
 * - anchor and break-off are document edits the director applies; here they only record the order.
 * - delay (0 to 1): each pilot but the giver responds after its own time (toPilotDelays): the leader's order and each
 *   ship's formation warp wait that many ticks, and a formation warp also waits for its leader's order to apply.
 *   Without a delay a move waits on the pilots' reactions (options.reactionOf); warps and regroups never do (a fleet
 *   warp is simultaneous).
 *
 * Node-tested: it imports the world's and FleetFollowing's types only.
 */

import type { Maybe } from '@dereekb/util';
import {
  MIN_WARP_DISTANCE,
  resolveFleetOrderRequest,
  toFleetGroupKey,
  toPilotDelays,
  type FleetGroup,
  type FleetGroupCommandReport,
  type FleetGroupState,
  type FleetGroupWarpReport,
  type FleetOrder,
  type FleetOrderRequest,
  type ResolvedFleetOrder,
  type SceneDocument,
  type SceneVector,
  type ShipOrder,
  type WarpShipOrder
} from '@scene-director/scene';
import type { DestinyWorld, ShipMotion } from './destiny';
import type { FleetFollowing } from './following';
import { FleetFrame, FramePoint, SETTLE_SPEED, WarpFrame } from './steering';
import { LandingPoint } from './warp';

const DEGREES = Math.PI / 180;

export interface FleetOrdersOptions {
  readonly world: DestinyWorld;
  readonly following: FleetFollowing;
  readonly scene: () => Maybe<SceneDocument>;
  /**
   * A pilot's reaction (0..1) for an order given without a delay; absent or null: it answers at once.
   */
  readonly reactionOf?: (ship: string) => Maybe<number>;
}

/**
 * A ship an order left out, and why.
 */
export interface FleetOrderSkip {
  readonly id: string;
  readonly reason: string;
}

/**
 * What order_fleet returns for its live half.
 */
export interface FleetOrderResult {
  readonly fleet: string;
  readonly wing?: string;
  readonly squad?: string;
  readonly order: FleetOrder;
  /**
   * The ship that gave it.
   */
  readonly by: string;
  readonly leader: string;
  /**
   * The world's tick when it was given.
   */
  readonly tick: number;
  /**
   * The ships it moves; for a warp, the ships warping in formation with their predicted slot landings.
   */
  readonly ships: readonly string[] | readonly { readonly id: string; readonly landing: SceneVector }[];
  readonly skipped?: readonly FleetOrderSkip[];
  /**
   * A warp: the leader's predicted landing.
   */
  readonly landing?: SceneVector;
  /**
   * A regroup: the ships warping back to their slots.
   */
  readonly warping?: readonly string[];
  /**
   * With a delay: each responding ship's response time, seconds.
   */
  readonly delays?: Readonly<Record<string, number>>;
}

interface WarpRecord {
  readonly leader: string;
  readonly ships: readonly string[];
  readonly skipped: number;
  readonly landed: Set<string>;
}

interface LastRecord {
  readonly order: FleetOrder;
  readonly by: string;
  readonly tick: number;
}

/**
 * The page's fleet orders.
 */
export class FleetOrders {
  private readonly world: DestinyWorld;
  private readonly following: FleetFollowing;
  private readonly scene: () => Maybe<SceneDocument>;
  private readonly reactionOf?: (ship: string) => Maybe<number>;
  private readonly last = new Map<string, LastRecord>();
  private readonly warps = new Map<string, WarpRecord>();
  private readonly regroups = new Map<string, readonly string[]>();

  constructor(options: FleetOrdersOptions) {
    this.world = options.world;
    this.following = options.following;
    this.reactionOf = options.reactionOf;
    this.scene = options.scene;
    this.world.OnWarp((event) => {
      if (event.kind !== 'exit') return;
      for (const record of this.warps.values()) if (record.leader === event.id || record.ships.includes(event.id)) record.landed.add(event.id);
    });
  }

  /**
   * Resolves a request against the current document.
   *
   * @param request - A normalized request.
   * @returns The resolved order.
   * @throws {SceneError} As resolveFleetOrderRequest does, or when no document is loaded.
   */
  Resolve(request: FleetOrderRequest): ResolvedFleetOrder {
    const scene = this.scene();
    if (!scene) throw new Error('order_fleet: no scene is loaded');
    return resolveFleetOrderRequest(scene, request);
  }

  /**
   * The live half of an order, after any document edit it made has applied: moves, warps and regroups fly; anchor,
   * break-off and targets only record the order (the director's FleetTargets runs a call).
   *
   * @param resolved - The resolved order.
   * @param options - `tick`: when the order was given, for its record and delays, if not now (a document order
   *   captures it before its asynchronous edit).
   * @returns What it did.
   * @throws {Error} When the leader refuses the order, or a wing or squad move or a warp finds the fleet unplanned.
   */
  Fly(resolved: ResolvedFleetOrder, options: { readonly tick?: number } = {}): FleetOrderResult {
    const { request, group } = resolved;
    const order = request.order;
    const key = toFleetGroupKey(group);
    const tick = options.tick ?? this.world.tick;
    const simultaneous = order.type === 'warp' || order.type === 'regroup';
    const delays = toPilotDelays({ key, tick, delay: request.delay, ships: resolved.ships, issuer: resolved.issuer, reactionOf: simultaneous ? undefined : this.reactionOf });
    let result: FleetOrderResult;
    if (order.type === 'warp') result = this.Warp(resolved, order, delays);
    else if (order.type === 'regroup') result = this.Regroup(resolved, delays);
    else if (order.type === 'anchor' || order.type === 'break-off' || order.type === 'targets' || order.type === 'free-fire') result = { ...this.Result(resolved, { ships: resolved.ships }), tick };
    else result = this.Move(resolved, order, delays);
    const waits = (request.delay ?? 0) > 0 || [...delays.values()].some((delay) => delay > 0);
    if (waits && order.type !== 'anchor' && order.type !== 'break-off') result = { ...result, delays: Object.fromEntries(delays) };
    this.last.set(key, { order, by: resolved.issuer, tick: result.tick });
    return result;
  }

  /**
   * A fleet's, wing's or squad's command (FleetGroupCommandReport): its state, the first that applies of warping,
   * regrouping, moving, broken-off and idle.
   *
   * @param group - The group.
   * @returns The report.
   */
  GroupReport(group: FleetGroup): FleetGroupCommandReport {
    const key = toFleetGroupKey(group);
    const fleet = this.scene()?.fleets?.find((candidate) => candidate.id === group.fleet);
    const apart = group.kind === 'fleet' ? null : this.following.Apart(key);
    const leader = group.kind === 'fleet' ? fleet?.commander : apart?.leader;
    const home = group.kind === 'squad' ? fleet?.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === group.id)?.home : undefined;
    const warp = this.WarpReport(key);
    const regrouping = this.Regrouping(key);
    const motion = leader ? this.world.Motion(leader) : null;
    const moving = motion ? IsMoving(motion) : false;
    let state: FleetGroupState = 'idle';
    if (warp) state = 'warping';
    else if (regrouping) state = 'regrouping';
    else if (moving) state = 'moving';
    else if (apart || home) state = 'broken-off';
    const last = this.last.get(key);
    return {
      state,
      ...(leader ? { leader } : {}),
      ...(apart ? { away: true } : {}),
      ...(home ? { home } : {}),
      ...(motion && moving ? { order: motion.order } : {}),
      ...(last ? { last } : {}),
      ...(warp ? { warp } : {}),
      ...(regrouping ? { regrouping } : {})
    };
  }

  /**
   * Forgets every record (load_scene / open_scene).
   */
  Reset(): void {
    this.last.clear();
    this.warps.clear();
    this.regroups.clear();
  }

  private Move(resolved: ResolvedFleetOrder, order: ShipOrder, delays: ReadonlyMap<string, number>): FleetOrderResult {
    const { group, leader, ships } = resolved;
    const refusal = this.world.OrderRefusal(leader, order);
    if (refusal) throw new Error(`order_fleet: ${refusal}`);
    if (group.kind !== 'fleet') this.RequireReady(group.fleet);
    this.Forget(group);
    this.world.Order(leader, order, { delay: delays.get(leader) });
    if (group.kind !== 'fleet') this.following.BreakAway({ key: toFleetGroupKey(group), group, leader, ships });
    return this.Result(resolved, { ships });
  }

  private Warp(resolved: ResolvedFleetOrder, order: WarpShipOrder, delays: ReadonlyMap<string, number>): FleetOrderResult {
    const { group, leader, ships } = resolved;
    const refusal = this.world.OrderRefusal(leader, order);
    if (refusal) throw new Error(`order_fleet: ${refusal}`);
    this.RequireReady(group.fleet);
    const others = ships.filter((id) => id !== leader);
    const offsets = this.following.GroupOffsets(group.fleet, leader, others);
    const from = this.world.Motion(leader);
    if (!offsets || !from) throw new Error(NotReady(group.fleet));

    // The leader's landing as OrderRefusal and the aligning warp report estimate it; the target is a ship, an object or
    // a celestial target (both radii, as ApplyOrder's warp).
    const target = 'target' in order ? this.TargetBall(order.target) : null;
    const destination = 'point' in order ? order.point : (target?.position ?? from.position);
    const range = order.range + (target ? from.physics.radius + target.radius : 0);
    const landing = LandingPoint(destination, range, from.position);
    const frame = WarpFrame(from.position, landing);

    const skipped: FleetOrderSkip[] = [];
    const inWarp = new Set<string>();
    const warpers: { readonly id: string; readonly offset: SceneVector; readonly landing: SceneVector }[] = [];
    for (const id of others) {
      const motion = this.world.Motion(id);
      const offset = offsets.get(id);
      const predicted = offset ? FramePoint({ origin: landing, frame, offset }) : null;
      const away = motion && predicted ? Distance(predicted, motion.position) : 0;
      if (!motion || !offset || !predicted) skipped.push({ id, reason: 'no ball' });
      else if (InProperWarp(motion)) {
        inWarp.add(id);
        skipped.push({ id, reason: 'in warp; it keeps its own warp' });
      } else if (this.world.Tackle(id)?.warp) skipped.push({ id, reason: `cannot warp: ${this.world.Tackle(id)?.warp}` });
      else if (!(motion.physics.maxVelocity > 0)) skipped.push({ id, reason: 'cannot warp: its max velocity is 0' });
      else if (away < MIN_WARP_DISTANCE) skipped.push({ id, reason: `its slot is ${Math.round(away / 100) / 10} km away; EVE warps only ${MIN_WARP_DISTANCE / 1000} km or more, so it flies there` });
      else warpers.push({ id, offset, landing: RoundVector(predicted) });
    }

    this.Forget(group);
    const staying = ships.filter((id) => !inWarp.has(id));
    // Everyone not in warp comes back first (out of groups apart and detached); a wing or squad then flies apart on its
    // leader, which the order has just taken out of following.
    this.following.Regroup(staying);
    this.world.Order(leader, order, { delay: delays.get(leader) });
    if (group.kind !== 'fleet') this.following.BreakAway({ key: toFleetGroupKey(group), group, leader, ships: staying });
    const warping: { readonly id: string; readonly landing: SceneVector }[] = [];
    for (const warper of warpers) {
      if (this.world.WarpInFormation(warper.id, { leader, offset: warper.offset, delay: delays.get(warper.id) })) warping.push({ id: warper.id, landing: warper.landing });
      else skipped.push({ id: warper.id, reason: 'not following, so it cannot warp in formation' });
    }
    this.warps.set(toFleetGroupKey(group), { leader, ships: warping.map((ship) => ship.id), skipped: skipped.length, landed: new Set() });
    return this.Result(resolved, { ships: warping, skipped, landing: RoundVector(landing) });
  }

  /**
   * A warp target's ball: a ship's master ball, else an object's or a celestial target's.
   */
  private TargetBall(id: string): Maybe<{ readonly position: SceneVector; readonly radius: number }> {
    const motion = this.world.Motion(id);
    return motion ? { position: motion.position, radius: motion.physics.radius } : this.world.ObjectBall(id);
  }

  private Regroup(resolved: ResolvedFleetOrder, delays: ReadonlyMap<string, number>): FleetOrderResult {
    const { group, ships } = resolved;
    const fc = this.scene()?.fleets?.find((candidate) => candidate.id === group.fleet)?.commander;
    const members = ships.filter((id) => id !== fc);
    this.Forget(group);
    this.following.Regroup(members);
    const warping: string[] = [];
    const skipped: FleetOrderSkip[] = [];
    const offsets = fc ? this.following.GroupOffsets(group.fleet, fc, members) : null;
    const fcMotion = fc ? this.world.Motion(fc) : null;
    if (fc && offsets && fcMotion) {
      // With the FC warping, the formation warps resolve against its landing (DestinyWorld), so the check does too.
      const fcWarp = fcMotion.warp && fcMotion.warp.phase !== 'landed' ? fcMotion.warp : null;
      const origin = fcWarp ? fcWarp.landing : fcMotion.position;
      const frame = fcWarp ? WarpFrame(fcMotion.position, fcWarp.landing) : FleetFrame(fcMotion.heading[0] * DEGREES, fcMotion.heading[1] * DEGREES);
      for (const id of members) {
        const motion = this.world.Motion(id);
        const offset = offsets.get(id);
        if (!motion || !offset || !this.world.Following(id)) continue;
        if (Distance(FramePoint({ origin, frame, offset }), motion.position) < MIN_WARP_DISTANCE) continue;
        if (InProperWarp(motion)) skipped.push({ id, reason: 'in warp; it keeps its own warp' });
        else if (this.world.Tackle(id)?.warp) skipped.push({ id, reason: `cannot warp: ${this.world.Tackle(id)?.warp}` });
        else if (!(motion.physics.maxVelocity > 0)) skipped.push({ id, reason: 'cannot warp: its max velocity is 0' });
        else if (this.world.WarpInFormation(id, { leader: fc, offset, delay: delays.get(id) })) warping.push(id);
      }
    }
    this.regroups.set(toFleetGroupKey(group), members);
    return this.Result(resolved, { ships: members, ...(skipped.length ? { skipped } : {}), warping });
  }

  private Result(resolved: ResolvedFleetOrder, rest: Pick<FleetOrderResult, 'ships' | 'skipped' | 'landing' | 'warping'>): FleetOrderResult {
    const { request } = resolved;
    return {
      fleet: request.fleet,
      ...(request.wing ? { wing: request.wing } : {}),
      ...(request.squad ? { squad: request.squad } : {}),
      order: request.order,
      by: resolved.issuer,
      leader: resolved.leader,
      tick: this.world.tick,
      ...rest
    };
  }

  /**
   * A new order on a group replaces its warp and regroup records.
   *
   * @param group - The group.
   */
  private Forget(group: FleetGroup): void {
    const key = toFleetGroupKey(group);
    this.warps.delete(key);
    this.regroups.delete(key);
  }

  private RequireReady(fleet: string): void {
    if (!this.following.Ready(fleet)) throw new Error(NotReady(fleet));
  }

  /**
   * A group warp's progress, while some ship (the leader included) is still pending, aligning or in warp; the record is
   * dropped once none is.
   *
   * @param key - The group key.
   * @returns The counts, or null.
   */
  private WarpReport(key: string): Maybe<FleetGroupWarpReport> {
    const record = this.warps.get(key);
    if (!record) return null;
    const counts = { aligning: 0, warping: 0, landed: 0, dropped: 0 };
    for (const id of [record.leader, ...record.ships]) {
      const motion = this.world.Motion(id);
      const phase = motion?.warp?.phase;
      if (record.landed.has(id) || phase === 'landed') counts.landed += 1;
      else if (motion?.formationWarp?.pending || phase === 'aligning' || motion?.pendingOrder?.type === 'warp') counts.aligning += 1;
      else if (phase === 'warping' || phase === 'exiting') counts.warping += 1;
      else counts.dropped += 1;
    }
    const active = counts.aligning + counts.warping > 0;
    if (!active) this.warps.delete(key);
    return active ? { leader: record.leader, ...counts, skipped: record.skipped } : null;
  }

  /**
   * How many of a regroup's ships are not yet in formation; the record is dropped once all are.
   *
   * @param key - The group key.
   * @returns The count, or 0.
   */
  private Regrouping(key: string): number {
    const ships = this.regroups.get(key);
    const out = (ships ?? []).filter((id) => {
      const state = this.following.Report(id)?.state;
      return state !== undefined && state !== 'in-formation';
    }).length;
    if (ships && !out) this.regroups.delete(key);
    return out;
  }
}

function NotReady(fleet: string): string {
  return `order_fleet: fleet "${fleet}" is not planned yet (waiting for its ships' radii); retry once get_state fleets[].formation.ready`;
}

function InProperWarp(motion: ShipMotion): boolean {
  return motion.warp?.phase === 'warping' || motion.warp?.phase === 'exiting';
}

/**
 * Whether a group's leader is under way: an order still to apply, a speed of SETTLE_SPEED or more, or an order that
 * keeps flying (anything but stop, a goto that has crept to a halt, or a landed warp).
 *
 * @param motion - The leader's motion.
 * @returns True while it moves.
 */
function IsMoving(motion: ShipMotion): boolean {
  const order: ShipOrder = motion.order;
  let moving = motion.speed >= SETTLE_SPEED || (motion.pendingOrder != null && motion.pendingOrder.type !== 'stop');
  if (!moving && order.type === 'warp') moving = motion.warp != null && motion.warp.phase !== 'landed';
  else if (!moving) moving = order.type !== 'stop' && order.type !== 'goto';
  return moving;
}

function Distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function RoundVector(vector: ArrayLike<number>): SceneVector {
  return [Math.round(vector[0]) || 0, Math.round(vector[1]) || 0, Math.round(vector[2]) || 0];
}
