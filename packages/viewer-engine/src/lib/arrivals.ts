/**
 * Arrivals: ships an operation adds with `warpIn` (applySceneOperations' `arrivals`) wait parked off-grid, then warp
 * in on Destiny's EntityWarpIn (DestinyWorld.Arrive) and land staggered at their landings.
 *
 * - PlanArrivals is the timing planner, pure over Destiny's warp profile (a callback): each ship starts at least
 *   WARP_IN_HIDDEN_DISTANCE out when its warp-in begins (D_min by bisection on log D), and its start tick and lane
 *   length are picked so it drops out of warp at its target time: together, the group lands within `stagger` seconds
 *   of its slowest hull's natural landing; by speed, each hull at its own pace plus its offset. The leader lands first.
 * - Arrivals holds the page's groups: Add parks each ship at a provisional point right after its ball exists (so a
 *   hull never shows at its landing), Boundary plans a group once every ship's flight numbers and build have settled
 *   (a group added with `waitForBuild: false`, a timeline cue's, its flight numbers only), or after
 *   ARRIVAL_READY_TIMEOUT ticks, and Report gives get_state its per-ship and per-group states. The landing staggers
 *   hash scene ticks (config.seedTick), so a timeline replay lands the same.
 *
 * Node-tested: no runtime import (the world and the director are ports).
 */
import type { Maybe } from '@dereekb/util';
import { type ArrivalTimelineEvent, type SceneArrival, type SceneShip, type SceneVector, toArrivalLane, toArrivalOffsets } from '@scene-director/scene';
import type { ShipArrival, ShipArrivalReport, ShipMotion } from './destiny';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';
import { FleetFrame, FramePoint, WarpFrame } from './steering';
import { DEFAULT_WARP_SPEED, WARP_IN_BACKDATE_TICKS, WarpDropOutTime, WarpFactor, WarpInBackdate, WarpInExitTicks, type WarpProfileDistances, WarpRemainingAt } from './warp';

/**
 * Metres: an arriving ship is at least this far from its landing when its warp-in begins (drawn a tick ahead too).
 */
export const WARP_IN_HIDDEN_DISTANCE = 2_000_000;

/**
 * Metres: where an arriving ship waits before its group is planned, back along its lane.
 */
export const ARRIVAL_PARK_DISTANCE = 4_000_000;

/**
 * Ticks: a group not ready after this long (flight numbers or builds still pending) is planned anyway.
 */
export const ARRIVAL_READY_TIMEOUT = 20;

/**
 * Ticks a formed group stays in the report before it is dropped.
 */
export const ARRIVAL_FORMED_KEEP = 30;

/**
 * m/s: a landed free ship slower than this counts as formed.
 */
export const ARRIVAL_SETTLED_SPEED = 1;

const DEGREES = Math.PI / 180;
const MAX_DOUBLINGS = 60;
const BISECTIONS = 60;

/**
 * Destiny's warp profile for a factor over a distance (DestinyWorld.WarpProfile).
 */
export type WarpProfileOf = (factor: number, distance: number) => WarpProfileDistances;

export interface WarpInShipNumbers {
  /**
   * Destiny's warp factor (WarpFactor of the hull's warp speed).
   */
  readonly factor: number;
  readonly maxVelocity: number;
  readonly profile: WarpProfileOf;
}

/**
 * The shortest lane that keeps a ship hidden when its warp-in begins: the smallest D whose remaining distance a tick
 * past the longest backdate is at least `hidden` (bisection on log D).
 *
 * @param numbers - The ship's warp factor, max velocity and the profile callback.
 * @param hidden - Metres; default WARP_IN_HIDDEN_DISTANCE.
 * @returns Metres.
 */
export function WarpInMinDistance(numbers: WarpInShipNumbers, hidden = WARP_IN_HIDDEN_DISTANCE): number {
  const { factor, profile } = numbers;
  const at = WARP_IN_BACKDATE_TICKS + 1;
  const hides = (distance: number): boolean => WarpRemainingAt(profile(factor, distance), at) >= hidden;
  let low = hidden;
  let high = hidden * 2;
  for (let doubling = 0; !hides(high) && doubling < MAX_DOUBLINGS; doubling++) {
    low = high;
    high *= 2;
  }
  if (hides(low)) return low;
  for (let step = 0; step < BISECTIONS; step++) {
    const middle = Math.sqrt(low * high);
    if (hides(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * The lane (at least `min`) whose warp drops out `extra` seconds later than the lane `min` does: the start tick's
 * fractional rest, absorbed by flying further.
 *
 * @param numbers - The ship's warp factor, max velocity and the profile callback.
 * @param min - Metres: the shortest lane (WarpInMinDistance).
 * @param extra - Seconds, in [0, 1).
 * @returns Metres.
 */
export function WarpInDistanceFor(numbers: WarpInShipNumbers, min: number, extra: number): number {
  const { factor, maxVelocity, profile } = numbers;
  const dropOut = (distance: number): number => WarpDropOutTime(profile(factor, distance), maxVelocity);
  const target = dropOut(min) + extra;
  if (!(extra > 0)) return min;
  let low = min;
  let high = min * 2;
  for (let doubling = 0; dropOut(high) < target && doubling < MAX_DOUBLINGS; doubling++) {
    low = high;
    high *= 2;
  }
  for (let step = 0; step < BISECTIONS; step++) {
    const middle = Math.sqrt(low * high);
    if (dropOut(middle) >= target) high = middle;
    else low = middle;
  }
  return high;
}

export interface PlanArrivalShip extends Omit<WarpInShipNumbers, 'profile'> {
  readonly id: string;
  readonly landing: SceneVector;
  /**
   * Seconds after the group's target landing (toArrivalOffsets); 0 for the leader.
   */
  readonly offset: number;
}

export interface PlanArrivalsInput {
  readonly ships: readonly PlanArrivalShip[];
  /**
   * The unit direction they warp in along.
   */
  readonly lane: SceneVector;
  /**
   * The first master tick boundary a warp-in may start at.
   */
  readonly boundary: number;
  readonly together: boolean;
  readonly profile: WarpProfileOf;
}

export interface PlannedArrival {
  readonly id: string;
  readonly from: SceneVector;
  readonly landing: SceneVector;
  /**
   * The master tick boundary its warp-in starts at.
   */
  readonly at: number;
  readonly factor: number;
  /**
   * Metres: the lane's length.
   */
  readonly distance: number;
  /**
   * Seconds after `boundary` it drops out of warp (continuous).
   */
  readonly lands: number;
  /**
   * The master tick its exit event reports (at + WarpInExitTicks).
   */
  readonly exitTick: number;
}

/**
 * Plans a group's warp-ins: each ship's start tick and off-grid start point, so it lands at its target time.
 *
 * @param input - The ships, the lane, the first boundary, the timing and the profile callback.
 * @returns One plan per ship, in `ships` order.
 */
export function PlanArrivals(input: PlanArrivalsInput): PlannedArrival[] {
  const { ships, lane, boundary, together, profile } = input;
  const first = WarpInBackdate(boundary);
  const bases = ships.map((ship) => {
    const numbers = { ...ship, profile };
    const min = WarpInMinDistance(numbers);
    return { ship, numbers, min, dropOut: WarpDropOutTime(profile(ship.factor, min), ship.maxVelocity) };
  });
  const slowest = Math.max(...bases.map((base) => base.dropOut - first));
  return bases.map(({ ship, numbers, min, dropOut }) => {
    // Seconds after the boundary it should drop out of warp.
    const target = (together ? slowest : dropOut - first) + ship.offset;
    let backdate = first;
    let wait = Math.max(0, target - (dropOut - backdate));
    // The first ticks of a world backdate less (WarpInBackdate): a later start may backdate more, so settle it.
    for (let pass = 0; pass < WARP_IN_BACKDATE_TICKS + 1; pass++) {
      const next = WarpInBackdate(boundary + Math.floor(wait));
      if (next === backdate) break;
      backdate = next;
      wait = Math.max(0, target - (dropOut - backdate));
    }
    const at = boundary + Math.floor(wait);
    const distance = WarpInDistanceFor(numbers, min, wait - Math.floor(wait));
    const warp = profile(ship.factor, distance);
    const from: SceneVector = [ship.landing[0] - lane[0] * distance, ship.landing[1] - lane[1] * distance, ship.landing[2] - lane[2] * distance];
    return {
      id: ship.id,
      from,
      landing: ship.landing,
      at,
      factor: ship.factor,
      distance,
      lands: at - boundary + WarpDropOutTime(warp, ship.maxVelocity) - backdate,
      exitTick: at + WarpInExitTicks(warp, ship.maxVelocity, backdate)
    };
  });
}

/**
 * Per ship: waiting (parked until its group is planned), scheduled, warping, landed (out of warp; a follower holds for
 * its group), forming-up (following to its slot), formed (in formation, or a landed free ship at rest), dropped.
 */
export type ArrivalShipState = 'waiting' | 'scheduled' | 'warping' | 'landed' | 'forming-up' | 'formed' | 'dropped';

const STATE_ORDER: readonly ArrivalShipState[] = ['waiting', 'scheduled', 'warping', 'landed', 'forming-up', 'formed'];

export interface ArrivalShipReport {
  readonly id: string;
  readonly state: ArrivalShipState;
  /**
   * Seconds until it drops out of warp, while scheduled or warping.
   */
  readonly landsIn?: number;
  /**
   * Why it was dropped, or what happened instead.
   */
  readonly note?: string;
}

export interface ArrivalGroupReport {
  readonly group: string;
  readonly fleet?: string;
  readonly leader?: string;
  readonly ships: readonly ArrivalShipReport[];
  /**
   * The least advanced state of its ships still arriving (formed when all are, dropped when none is left).
   */
  readonly state: ArrivalShipState;
  readonly counts: Partial<Record<ArrivalShipState, number>>;
  /**
   * Seconds from now until the first and last ship drop out of warp, once planned (negative once past).
   */
  readonly lands?: { readonly first: number; readonly last: number };
  readonly together: boolean;
  readonly stagger: number;
  readonly landing: SceneArrival['landing'];
  readonly notes?: readonly string[];
}

/**
 * The world an Arrivals drives (DestinyWorld).
 */
export interface ArrivalsWorld {
  readonly tick: number;
  Motion(id: string): Maybe<ShipMotion>;
  Arrive(id: string, arrival: ShipArrival): boolean;
  ArrivalRefusal(id: string, arrival: ShipArrival): Maybe<string>;
  ArrivalOf(id: string): Maybe<ShipArrivalReport>;
  Arriving(id: string): boolean;
  WarpProfile(factor: number, distance: number): WarpProfileDistances;
  PlaceShip(doc: Pick<SceneShip, 'id' | 'position' | 'rotation'>): void;
}

export interface ArrivalsConfig {
  readonly world: ArrivalsWorld;
  /**
   * A ship's document placement: where a `document` arrival lands, and its roll.
   */
  readonly placement: (id: string) => Maybe<Pick<SceneShip, 'position' | 'rotation'>>;
  /**
   * Whether a ship's flight numbers and build have settled (the hub answered /ship-stats, the SOF build finished);
   * `build: false` (a group added with waitForBuild false, a timeline cue's) asks for the flight numbers only.
   */
  readonly ready: (id: string, options: { readonly build: boolean }) => boolean;
  /**
   * A world tick as the scene counts it (Director.SeedTick: ticks since the last load), which the landing staggers hash
   * so a replay lands the same; default the world tick itself.
   */
  readonly seedTick?: (tick: number) => number;
  /**
   * Whether a fleet's formation is planned (FleetFollowing.Ready), for a group landing at its slots.
   */
  readonly fleetReady: (fleet: string) => boolean;
  /**
   * Each ship's at-rest offset from a leader in its fleet's formation (FleetFollowing.GroupOffsets).
   */
  readonly groupOffsets: (fleet: string, leader: string, ships: readonly string[]) => Maybe<Map<string, SceneVector>>;
  /**
   * A ship's Follow-the-FC state (FleetFollowing.Report), null when it does not follow.
   */
  readonly followState: (id: string) => Maybe<string>;
}

interface ArrivalShip {
  readonly id: string;
  note: Maybe<string>;
  dropped: boolean;
  landing: Maybe<SceneVector>;
  /**
   * The last arrival state seen on its ball: an arrival that ends before it was warping was ended by a placement.
   */
  seen: Maybe<ShipArrivalReport['state']>;
}

interface ArrivalGroup {
  readonly arrival: SceneArrival;
  readonly added: number;
  /**
   * Whether planning waits for the SOF builds as well as the flight numbers (Add's option).
   */
  readonly waitForBuild: boolean;
  readonly ships: ArrivalShip[];
  planned: Maybe<{ readonly tick: number; readonly exits: ReadonlyMap<string, number> }>;
  formedAt: Maybe<number>;
  /**
   * The boundaries Transitions first saw the group's first landing, every ship landed and every ship formed (the
   * timeline's arrival events).
   */
  firstAt: Maybe<number>;
  landedAt: Maybe<number>;
  formedSeenAt: Maybe<number>;
  readonly notes: string[];
}

/**
 * What an Arrivals snapshot (sd-time) leaves out: its wiring (config).
 */
const ARRIVALS_CAPTURE: CaptureOptions = { wiring: ['config'] };

/**
 * The page's arriving groups.
 */
export class Arrivals {
  private readonly groups = new Map<string, ArrivalGroup>();

  constructor(private readonly config: ArrivalsConfig) {}

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, ARRIVALS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, ARRIVALS_CAPTURE, memo);
  }

  /**
   * Parks a group's ships off-grid at once, each back along the lane from its provisional landing: call right after
   * the balls exist and before the builds. A ship Destiny refuses (max velocity 0, ...) stays where it was placed.
   *
   * @param arrival - The group, from applySceneOperations' `arrivals`.
   * @param options - `waitForBuild` (default true): plan once the builds settled too, so every hull is drawn before it
   *   lands; false plans on the flight numbers alone (a timeline cue's group, at its own boundary).
   * @returns The group key (re-keyed when a group of that key is still arriving).
   */
  Add(arrival: SceneArrival, { waitForBuild = true }: { readonly waitForBuild?: boolean } = {}): string {
    const { world } = this.config;
    let key = arrival.group;
    for (let suffix = 2; this.groups.has(key); suffix++) key = `${arrival.group}#${suffix}`;
    const group: ArrivalGroup = { arrival: { ...arrival, group: key }, added: world.tick, waitForBuild, ships: [], planned: null, formedAt: null, firstAt: null, landedAt: null, formedSeenAt: null, notes: [] };
    for (const id of arrival.ships) this.Remove(id);
    const lane = this.Lane(group);
    for (const id of arrival.ships) {
      const ship: ArrivalShip = { id, note: null, dropped: false, landing: null, seen: null };
      group.ships.push(ship);
      const landing = this.ProvisionalLanding(group, id);
      const parked = landing ? this.ArrivalFor(group, id, { landing, lane, distance: ARRIVAL_PARK_DISTANCE, at: null }) : null;
      const refusal = parked ? world.ArrivalRefusal(id, parked) : 'no landing for it';
      if (parked && !refusal) world.Arrive(id, parked);
      else this.Drop(ship, `not warped in: ${refusal}`);
    }
    this.groups.set(key, group);
    return key;
  }

  /**
   * At a tick boundary (or after an Apply's builds): plans every group that is ready, or past ARRIVAL_READY_TIMEOUT,
   * and drops formed groups after ARRIVAL_FORMED_KEEP ticks.
   *
   * @param boundary - The master tick of the boundary the warp-ins may start at (DestinyWorld.tick between ticks).
   */
  Boundary(boundary: number): void {
    for (const [key, group] of [...this.groups]) {
      this.Track(group);
      if (!group.planned && this.Ready(group, boundary)) this.Plan(group, boundary);
      const state = this.GroupState(group);
      if (group.planned && (state === 'formed' || state === 'dropped')) group.formedAt ??= boundary;
      if (group.formedAt != null && boundary - group.formedAt >= ARRIVAL_FORMED_KEEP) this.groups.delete(key);
    }
  }

  /**
   * The arrival phases groups reached since the last call: a group's first ship out of warp (`first`), every ship landed
   * (`landed`), every ship formed up (`formed`), each once per group, in that order. Call it only from the director's
   * OnBoundary listener right after Boundary, never after an Apply's builds, so the timeline's arrival events fall on
   * the same boundaries in every run.
   *
   * @param boundary - The master tick.
   * @returns The timeline events.
   */
  Transitions(boundary: number): ArrivalTimelineEvent[] {
    const events: ArrivalTimelineEvent[] = [];
    for (const group of this.groups.values()) {
      if (!group.planned || group.formedSeenAt != null) continue;
      const ships = group.ships.filter((ship) => !ship.dropped);
      const order = ships.map((ship) => STATE_ORDER.indexOf(this.ShipState(group, ship).state));
      if (!order.length) continue;
      const landed = STATE_ORDER.indexOf('landed');
      const reached = { first: Math.max(...order) >= landed, landed: Math.min(...order) >= landed, formed: Math.min(...order) === STATE_ORDER.indexOf('formed') };
      const event = (phase: ArrivalTimelineEvent['phase']): ArrivalTimelineEvent => ({ kind: 'arrival', group: group.arrival.group, ...(group.arrival.fleet ? { fleet: group.arrival.fleet } : {}), phase, ships: ships.map((ship) => ship.id) });
      if (reached.first && group.firstAt == null) {
        group.firstAt = boundary;
        events.push(event('first'));
      }
      if (reached.landed && group.landedAt == null) {
        group.landedAt = boundary;
        events.push(event('landed'));
      }
      if (reached.formed) {
        group.formedSeenAt = boundary;
        events.push(event('formed'));
      }
    }
    return events;
  }

  /**
   * Every group still arriving, or formed within ARRIVAL_FORMED_KEEP ticks.
   *
   * @param keys - Only these groups (Add's keys); default all.
   * @returns The reports.
   */
  Report(keys?: readonly string[]): ArrivalGroupReport[] {
    const groups = keys ? keys.flatMap((key) => this.groups.get(key) ?? []) : [...this.groups.values()];
    for (const group of groups) this.Track(group);
    return groups.map((group) => this.GroupReport(group));
  }

  /**
   * Whether a ship's build landing can still change its arrival: it is in a group not planned yet that waits for its
   * builds (Add's `waitForBuild`). A timeline cue's group plans on flight numbers alone.
   *
   * @param id - The ship id.
   */
  AwaitsBuild(id: string): boolean {
    for (const group of this.groups.values()) if (group.waitForBuild && !group.planned && group.ships.some((ship) => ship.id === id && !ship.dropped)) return true;
    return false;
  }

  /**
   * Forgets every group (a load or an open).
   */
  Clear(): void {
    this.groups.clear();
  }

  /**
   * Forgets a removed ship.
   *
   * @param id - The ship id.
   */
  Remove(id: string): void {
    for (const group of this.groups.values()) {
      const index = group.ships.findIndex((ship) => ship.id === id);
      if (index >= 0) group.ships.splice(index, 1);
    }
    for (const [key, group] of [...this.groups]) if (!group.ships.length) this.groups.delete(key);
  }

  private Drop(ship: ArrivalShip, note: string): void {
    ship.dropped = true;
    ship.note = note;
  }

  /**
   * Marks ships whose arrival ended without landing (a placement, a removal, a death) as dropped.
   *
   * @param group - The group.
   */
  private Track(group: ArrivalGroup): void {
    const { world } = this.config;
    for (const ship of group.ships) {
      if (ship.dropped) continue;
      const motion = world.Motion(ship.id);
      const arrival = world.ArrivalOf(ship.id);
      const placed = motion?.orderNote?.startsWith('placed at its landing') ? motion.orderNote : null;
      if (arrival) ship.seen = arrival.state;
      else if (!motion) this.Drop(ship, 'it left the scene');
      else if (placed) this.Drop(ship, placed);
      else if (ship.seen !== 'landed' && !(ship.seen === 'warping' && ship.landing && Distance(motion.position, ship.landing) < WARP_IN_HIDDEN_DISTANCE)) this.Drop(ship, 'placed before it landed');
    }
  }

  private Ready(group: ArrivalGroup, boundary: number): boolean {
    const { ready, fleetReady } = this.config;
    const { arrival } = group;
    const live = group.ships.filter((ship) => !ship.dropped);
    const settled = live.every((ship) => ready(ship.id, { build: group.waitForBuild })) && (arrival.landing !== 'formation' || !arrival.fleet || fleetReady(arrival.fleet));
    return live.length > 0 && (settled || boundary - group.added >= ARRIVAL_READY_TIMEOUT);
  }

  private Plan(group: ArrivalGroup, boundary: number): void {
    const { world } = this.config;
    const { arrival } = group;
    const lane = this.Lane(group);
    const landings = this.Landings(group);
    const offsets = toArrivalOffsets({ key: arrival.group, tick: this.config.seedTick?.(boundary) ?? boundary, ships: group.ships.map((ship) => ship.id), leader: arrival.leader, stagger: arrival.stagger });
    const planned: PlanArrivalShip[] = [];
    for (const ship of group.ships) {
      if (ship.dropped) continue;
      const motion = world.Motion(ship.id);
      const landing = landings.get(ship.id);
      const maxVelocity = motion?.physics.maxVelocity ?? 0;
      if (!landing || !motion) {
        this.Drop(ship, 'not warped in: no landing for it');
      } else if (!(maxVelocity > 0)) {
        world.PlaceShip({ id: ship.id, position: landing, rotation: this.Rotation(ship.id, lane) });
        this.Drop(ship, 'placed at its landing: its max velocity is 0, so it cannot warp');
      } else {
        ship.landing = landing;
        planned.push({ id: ship.id, landing, factor: WarpFactor(motion.physics.warpSpeed ?? DEFAULT_WARP_SPEED), maxVelocity, offset: offsets.get(ship.id) ?? 0 });
      }
    }
    const plans = planned.length ? PlanArrivals({ ships: planned, lane, boundary, together: arrival.together, profile: (factor, distance) => world.WarpProfile(factor, distance) }) : [];
    const exits = new Map<string, number>();
    for (const plan of plans) {
      const ship = group.ships.find((candidate) => candidate.id === plan.id);
      const request = this.ArrivalFor(group, plan.id, { landing: plan.landing, lane, distance: plan.distance, at: plan.at, factor: plan.factor });
      const refusal = world.ArrivalRefusal(plan.id, request);
      if (!refusal && world.Arrive(plan.id, request)) exits.set(plan.id, plan.exitTick);
      else if (ship) this.Drop(ship, `not warped in: ${refusal ?? 'Destiny refused it'}`);
    }
    if (group.ships.some((ship) => ship.dropped)) group.notes.push(`${group.ships.filter((ship) => ship.dropped).length} of ${group.ships.length} ships could not warp in`);
    if (boundary - group.added >= ARRIVAL_READY_TIMEOUT && group.ships.some((ship) => !ship.dropped && !this.config.ready(ship.id, { build: group.waitForBuild }))) group.notes.push(`planned after ${ARRIVAL_READY_TIMEOUT} s without every ship's flight numbers${group.waitForBuild ? ' or build' : ''}`);
    group.planned = { tick: boundary, exits };
  }

  private ArrivalFor(group: ArrivalGroup, id: string, input: { readonly landing: SceneVector; readonly lane: SceneVector; readonly distance: number; readonly at: Maybe<number>; readonly factor?: number }): ShipArrival {
    const { landing, lane, distance, at, factor } = input;
    const { arrival } = group;
    const from: SceneVector = [landing[0] - lane[0] * distance, landing[1] - lane[1] * distance, landing[2] - lane[2] * distance];
    const leader = arrival.fleet && arrival.leader && arrival.leader !== id ? arrival.leader : undefined;
    return { from, landing, at, ...(factor === undefined ? {} : { factor }), ...(leader ? { leader } : {}), roll: this.config.placement(id)?.rotation[2] ?? 0 };
  }

  /**
   * The group's lane: a formation landing's follows the FC (its own arrival's when it is arriving, else its live
   * heading); a document one is the operation's.
   *
   * @param group - The group.
   * @returns The unit direction.
   */
  private Lane(group: ArrivalGroup): SceneVector {
    const { world } = this.config;
    const { arrival } = group;
    let lane = arrival.lane;
    const fc = arrival.landing === 'formation' && arrival.leader ? arrival.leader : null;
    const fcArrival = fc ? world.ArrivalOf(fc) : null;
    const fcMotion = fc ? world.Motion(fc) : null;
    if (fcArrival && fcArrival.state !== 'landed') lane = Unit([fcArrival.landing[0] - fcArrival.from[0], 0, fcArrival.landing[2] - fcArrival.from[2]]) ?? lane;
    else if (fcMotion) lane = toArrivalLane(fcMotion.heading[0]);
    return lane;
  }

  private ProvisionalLanding(group: ArrivalGroup, id: string): Maybe<SceneVector> {
    const { arrival } = group;
    return arrival.landing === 'formation' && arrival.leader ? (this.FcOrigin(arrival.leader)?.origin ?? null) : (this.config.placement(id)?.position ?? null);
  }

  /**
   * Where the group lands: its document placements, or its slots around the FC as FleetOrders.Warp predicts them
   * (around the FC's landing while it is warping or arriving, in its warp frame; else around it, in its heading's).
   *
   * @param group - The group.
   * @returns The landing per ship.
   */
  private Landings(group: ArrivalGroup): Map<string, SceneVector> {
    const { placement, groupOffsets } = this.config;
    const { arrival } = group;
    const landings = new Map<string, SceneVector>();
    const ids = group.ships.filter((ship) => !ship.dropped).map((ship) => ship.id);
    if (arrival.landing === 'formation' && arrival.fleet && arrival.leader) {
      const fc = this.FcOrigin(arrival.leader);
      const offsets = groupOffsets(arrival.fleet, arrival.leader, ids);
      for (const id of ids) {
        const offset = offsets?.get(id);
        if (fc && offset) landings.set(id, FramePoint({ origin: fc.origin, frame: fc.frame, offset }) as SceneVector);
      }
    } else {
      for (const id of ids) {
        const position = placement(id)?.position;
        if (position) landings.set(id, [...position]);
      }
    }
    return landings;
  }

  private FcOrigin(fc: string): Maybe<{ readonly origin: SceneVector; readonly frame: ReturnType<typeof FleetFrame> }> {
    const { world } = this.config;
    const motion = world.Motion(fc);
    const arrival = world.ArrivalOf(fc);
    const warp = motion?.warp && motion.warp.phase !== 'landed' ? motion.warp : null;
    let result: Maybe<{ readonly origin: SceneVector; readonly frame: ReturnType<typeof FleetFrame> }> = null;
    if (arrival && arrival.state !== 'landed') result = { origin: arrival.landing, frame: WarpFrame(arrival.from, arrival.landing) };
    else if (motion && warp) result = { origin: warp.landing, frame: WarpFrame(motion.position, warp.landing) };
    else if (motion) result = { origin: motion.position, frame: FleetFrame(motion.heading[0] * DEGREES, motion.heading[1] * DEGREES) };
    return result;
  }

  private Rotation(id: string, lane: SceneVector): SceneVector {
    return [Math.atan2(lane[0], lane[2]) / DEGREES, 0, this.config.placement(id)?.rotation[2] ?? 0];
  }

  private ShipState(group: ArrivalGroup, ship: ArrivalShip): ArrivalShipReport {
    const { world, followState } = this.config;
    const arrival = world.ArrivalOf(ship.id);
    const follow = followState(ship.id);
    const speed = world.Motion(ship.id)?.speed ?? 0;
    let state: ArrivalShipState = 'dropped';
    if (ship.dropped) state = 'dropped';
    else if (!group.planned) state = 'waiting';
    else if (arrival?.state === 'parked' || arrival?.state === 'scheduled') state = 'scheduled';
    else if (arrival?.state === 'warping') state = 'warping';
    else if (arrival?.state === 'landed') state = follow == null && speed < ARRIVAL_SETTLED_SPEED ? 'formed' : 'landed';
    else if (follow != null) state = follow === 'in-formation' || follow === 'leading' ? 'formed' : 'forming-up';
    else state = speed < ARRIVAL_SETTLED_SPEED ? 'formed' : 'landed';
    const landsIn = arrival && (state === 'scheduled' || state === 'warping') ? arrival.landsIn : undefined;
    return { id: ship.id, state, ...(landsIn == null ? {} : { landsIn }), ...(ship.note ? { note: ship.note } : {}) };
  }

  private GroupState(group: ArrivalGroup): ArrivalShipState {
    const states = group.ships.map((ship) => this.ShipState(group, ship).state).filter((state) => state !== 'dropped');
    return states.length ? STATE_ORDER[Math.min(...states.map((state) => STATE_ORDER.indexOf(state)))] : 'dropped';
  }

  private GroupReport(group: ArrivalGroup): ArrivalGroupReport {
    const { world } = this.config;
    const { arrival } = group;
    const ships = group.ships.map((ship) => this.ShipState(group, ship));
    const counts: Partial<Record<ArrivalShipState, number>> = {};
    for (const ship of ships) counts[ship.state] = (counts[ship.state] ?? 0) + 1;
    const exits = group.planned ? [...group.planned.exits.values()] : [];
    const lands = exits.length ? { first: Math.min(...exits) - world.tick, last: Math.max(...exits) - world.tick } : null;
    return {
      group: arrival.group,
      ...(arrival.fleet ? { fleet: arrival.fleet } : {}),
      ...(arrival.leader ? { leader: arrival.leader } : {}),
      ships,
      state: this.GroupState(group),
      counts,
      ...(lands ? { lands } : {}),
      together: arrival.together,
      stagger: arrival.stagger,
      landing: arrival.landing,
      ...(group.notes.length ? { notes: [...group.notes] } : {})
    };
  }
}

function Distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function Unit(vector: SceneVector): Maybe<SceneVector> {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}
