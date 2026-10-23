/**
 * The fleet targeting lever: every fleet member without its own target locks and shoots its group's called primary
 * (fleets/targets.ts in the scene package: the nearest group in its chain with a live primary), pre-locks the next
 * called targets, and moves to the next when the primary dies, warps off or is removed.
 *
 * - Own targets win: a target given by set_target, engage or switch_modules (Own) stands until it clears, then the ship
 *   takes its group's call again.
 * - cease_fire holds a member (Hold "hold": it keeps the call and its locks, but is not armed) or stands it down
 *   ("stand-down": no called target). Both lift on engage (Rearm), a targets order to a group it takes calls from
 *   (Respond), a change to such a group's live called targets (Sync), or a load (Clear).
 * - A targets order's pilot delay (Respond) keeps what each member shoots until its response tick.
 * - Free fire (order_fleet free-fire, a group key in Sync's `freeFire`): a member whose chain has it on, with no
 *   primary to take and not logi, picks the nearest hostile within its own reach (pickFreeFireTarget over the port's
 *   FreeFireView) once its pick is due, keeps it while it stays live and in reach, and picks again after its reaction
 *   (FreeFireDelay) once it is gone. Precedence: own > called > free; a call takes over at once. `hold` keeps a free
 *   target unarmed, `stand-down` clears it; free fire off clears it.
 *
 * Sync works out the target each member should have and returns the changes; the director applies them through its
 * SetShipTarget, arms Armed() like an engagement, and adds PreLocks to the wanted locks. All state is plain data.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { CALLED_PRE_LOCKS, type CalledTargetSkip, type CalledTargetStatus, describeFleetGroup, type FleetGroup, type FleetGroupCall, type FreeFirePickInput, pickFreeFireTarget, type SceneDocument, type ShipCallPlan, toFleetGroupCalls, toFleetGroupKey, toShipCallPlans } from '@scene-director/scene';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

export interface FleetTargetsPort {
  /**
   * A called target's live status (Director.CalledTargetStatus).
   */
  Status(id: string): CalledTargetStatus;
  /**
   * Whether a ship can hold a target now: alive, with a ball, out of warp.
   */
  CanTarget(ship: string): boolean;
  /**
   * The ship's target now (ShipTargets.Of).
   */
  TargetOf(ship: string): Maybe<string>;
  /**
   * Seconds per Destiny tick, for respondsIn.
   */
  readonly tickSeconds: number;
  /**
   * What a free-firing member can pick from: the live hostiles (ships on another team) with their surface distance from
   * it, and its own reach in metres. Null (or absent): it picks nothing.
   */
  FreeFireView?(ship: string): Maybe<FreeFirePickInput>;
  /**
   * Ticks a free-firing member's pilot takes to pick a new target once its last one is gone (its reaction,
   * toPilotDelays); absent: at once.
   */
  FreeFireDelay?(ship: string, tick: number): number;
}

/**
 * How cease_fire leaves a called member: `hold` keeps the call and its locks without firing; `stand-down` takes no
 * called target.
 */
export type FleetTargetHold = 'hold' | 'stand-down';

/**
 * Where a ship's target came from: its own (set_target, engage, switch_modules), its group's call, or its own pick under
 * free fire.
 */
export type ShipTargetSource = 'own' | 'called' | 'free';

/**
 * A ship's state under its groups' calls, in get_state's priority order.
 */
export const SHIP_CALL_STATES = ['own-target', 'stood-down', 'responding', 'in-warp', 'logi', 'free-fire', 'no-primary', 'holding', 'following'] as const;

export type ShipCallState = (typeof SHIP_CALL_STATES)[number];

/**
 * A target the director must set: the lever's call, or null when the call ends for the ship.
 */
export interface FleetTargetChange {
  readonly ship: string;
  readonly target: Maybe<string>;
  /**
   * The group whose call it takes (or, `free`, whose free fire it picks under); null when the change clears it.
   */
  readonly group: Maybe<FleetGroup>;
  /**
   * A free-fire pick, not a call.
   */
  readonly free?: true;
}

/**
 * A group's live primary moved (Director.OnPrimary).
 */
export interface CalledPrimaryChange {
  readonly group: FleetGroup;
  readonly primary: Maybe<string>;
  readonly previous: Maybe<string>;
  readonly tick: number;
}

export interface FleetTargetsSync {
  readonly changes: FleetTargetChange[];
  readonly primaries: CalledPrimaryChange[];
}

/**
 * A ship's `call` in get_state.
 */
export interface ShipCallReport {
  readonly state: ShipCallState;
  /**
   * The group whose call it takes (or would take).
   */
  readonly group?: FleetGroup;
  readonly primary?: string;
  /**
   * Seconds until it takes a new call (a targets order's pilot delay).
   */
  readonly respondsIn?: number;
  /**
   * Under free fire: the target it picked.
   */
  readonly free?: string;
  /**
   * Under free fire: seconds until it picks (its reaction).
   */
  readonly picksIn?: number;
}

/**
 * A fleet's, wing's or squad's `called` in get_state.
 */
export interface FleetGroupCalledReport {
  readonly primary: Maybe<string>;
  readonly queue: string[];
  readonly skipped?: CalledTargetSkip[];
  /**
   * How many members are on this primary for this group's call.
   */
  readonly following: number;
}

interface CalledEntry {
  readonly target: string;
  readonly group: FleetGroup;
}

/**
 * What a FleetTargets snapshot (sd-time) leaves out: its wiring (port).
 */
const FLEET_TARGETS_CAPTURE: CaptureOptions = { wiring: ['port'] };

export class FleetTargets {
  private readonly port: FleetTargetsPort;
  private readonly own = new Set<string>();
  private readonly called = new Map<string, CalledEntry>();
  private readonly holds = new Map<string, FleetTargetHold>();
  private readonly responds = new Map<string, number>();
  private readonly lastCalls = new Map<string, string>();
  private readonly primaries = new Map<string, { readonly group: FleetGroup; readonly primary: Maybe<string> }>();
  /**
   * Free-fire picks: ship → the target it picked and the group whose free fire it picked under.
   */
  private readonly free = new Map<string, CalledEntry>();
  /**
   * Ship → the tick its next free-fire pick is due.
   */
  private readonly picksAt = new Map<string, number>();
  private freeFire: ReadonlySet<string> = new Set();
  private plans = new Map<string, ShipCallPlan>();
  private calls = new Map<string, FleetGroupCall>();

  constructor(port: FleetTargetsPort) {
    this.port = port;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, FLEET_TARGETS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, FLEET_TARGETS_CAPTURE, memo);
  }

  /**
   * Works out every fleet member's call and returns the targets to change, and the groups whose live primary moved.
   *
   * 1. Groups whose called list changed since the last sync lift the holds of the ships they reach (not those still
   *    responding to an order: their response lifts it).
   * 2. Per member, in fleet order: an own target stands (the mark drops once its target clears); a ship that cannot
   *    target forgets its call; a stood-down ship drops its called target; a responding ship keeps what it has until
   *    due; every other takes its plan's primary.
   *    A member with no primary under free fire keeps a free target still live and in reach, else drops it and picks
   *    the nearest hostile in its reach once its pick is due (its reaction after the last one went).
   * 3. A ship that left every fleet, or free fire, drops its called or free target.
   *
   * @param scene - The live fleet view (the destroyed out of their fleets).
   * @param tick - The master tick now.
   * @param freeFire - The group keys with free fire on (FleetCommanders.FreeFireKeys).
   * @returns The changes, in fleet order, and the primary changes.
   */
  Sync(scene: Pick<SceneDocument, 'ships' | 'fleets'>, tick: number, freeFire: ReadonlySet<string> = new Set()): FleetTargetsSync {
    this.freeFire = freeFire;
    const calling = (scene.fleets ?? []).some((fleet) => fleet.targets?.length || fleet.wings.some((wing) => wing.targets?.length || wing.squads.some((squad) => squad.targets?.length)));
    if (!calling && !freeFire.size && !this.called.size && !this.free.size && !this.picksAt.size && !this.holds.size && !this.responds.size && !this.primaries.size && !this.lastCalls.size) {
      this.plans = new Map();
      this.calls = new Map();
      return { changes: [], primaries: [] };
    }
    const { Status, CanTarget, TargetOf } = this.port;
    this.calls = toFleetGroupCalls(scene, (id) => Status(id));
    this.plans = toShipCallPlans(scene, this.calls);
    const changed = new Set<string>();
    for (const [key, call] of this.calls) {
      const written = JSON.stringify(call.targets);
      if (this.lastCalls.get(key) !== written) changed.add(key);
      this.lastCalls.set(key, written);
    }
    for (const key of [...this.lastCalls.keys()]) if (!this.calls.has(key)) this.lastCalls.delete(key);
    const changes: FleetTargetChange[] = [];
    const change = (ship: string, target: Maybe<string>, group: Maybe<FleetGroup>): void => {
      changes.push({ ship, target, group });
      this.free.delete(ship);
      if (target && group) this.called.set(ship, { target, group });
      else this.called.delete(ship);
    };
    // Drops what the lever gave a ship (its call or its free pick), clearing the target when it still holds it.
    const release = (ship: string, target: Maybe<string>): void => {
      const given = this.called.get(ship) ?? this.free.get(ship);
      if (given && target === given.target) change(ship, null, null);
      this.called.delete(ship);
      this.free.delete(ship);
    };
    for (const [ship, plan] of this.plans) {
      if (changed.size && !this.responds.has(ship) && plan.chain.some((group) => changed.has(toFleetGroupKey(group)))) this.holds.delete(ship);
      const target = TargetOf(ship);
      const freeGroup = this.FreeGroupOf(plan);
      if (!freeGroup || this.own.has(ship) || !CanTarget(ship)) this.picksAt.delete(ship);
      if (this.own.has(ship) && target == null) this.own.delete(ship);
      if (this.own.has(ship) || !CanTarget(ship)) {
        this.called.delete(ship);
        this.free.delete(ship);
        continue;
      }
      if (this.holds.get(ship) === 'stand-down') {
        release(ship, target);
        this.picksAt.delete(ship);
        continue;
      }
      const respondsAt = this.responds.get(ship);
      if (respondsAt != null && respondsAt > tick) continue;
      if (respondsAt != null) {
        this.responds.delete(ship);
        this.holds.delete(ship);
      }
      if (plan.primary != null && plan.group) {
        this.picksAt.delete(ship);
        this.free.delete(ship);
        if (plan.primary !== target) change(ship, plan.primary, plan.group);
        else this.called.set(ship, { target: plan.primary, group: plan.group });
      } else if (freeGroup) {
        const pick = this.FreePick(ship, target, tick);
        if (pick == null) release(ship, target);
        else {
          if (pick !== target) changes.push({ ship, target: pick, group: freeGroup, free: true });
          this.called.delete(ship);
          this.free.set(ship, { target: pick, group: freeGroup });
        }
      } else release(ship, target);
    }
    for (const ship of [...this.called.keys(), ...this.free.keys()]) {
      if (this.plans.has(ship)) continue;
      release(ship, TargetOf(ship));
    }
    for (const ship of [...this.picksAt.keys()]) if (!this.plans.has(ship)) this.picksAt.delete(ship);
    for (const ship of [...this.holds.keys(), ...this.responds.keys()]) {
      if (this.plans.has(ship)) continue;
      this.holds.delete(ship);
      this.responds.delete(ship);
    }
    return { changes, primaries: this.PrimaryChanges(tick) };
  }

  /**
   * Marks a ship's target as its own (set_target, engage, switch_modules): the lever leaves it alone until it clears.
   *
   * @param ship - The ship.
   */
  Own(ship: string): void {
    this.own.add(ship);
    this.called.delete(ship);
    this.free.delete(ship);
    this.picksAt.delete(ship);
  }

  /**
   * Holds a member's fire (cease_fire), or stands it down from the call (cease_fire unlock). Ships that take no calls
   * (in no fleet) are not held.
   *
   * @param ship - The ship.
   * @param mode - hold or stand-down.
   * @returns Whether it is held.
   */
  Hold(ship: string, mode: FleetTargetHold): boolean {
    const member = this.plans.has(ship);
    if (member) this.holds.set(ship, mode);
    return member;
  }

  /**
   * Lifts the holds and stand-downs of ships (engage).
   *
   * @param ships - The ships.
   */
  Rearm(ships: Iterable<string>): void {
    for (const ship of ships) {
      this.holds.delete(ship);
      this.responds.delete(ship);
    }
  }

  /**
   * A targets order reached ships: each takes the call after its pilot delay, keeping what it shoots (and any hold)
   * until then; one with no delay is re-armed at once.
   *
   * @param ships - The order's ships.
   * @param delays - Each ship's delay in ticks (toPilotDelays); absent means none.
   * @param tick - The tick the order was given.
   */
  Respond(ships: Iterable<string>, delays: ReadonlyMap<string, number>, tick: number): void {
    for (const ship of ships) {
      const delay = delays.get(ship) ?? 0;
      if (delay > 0) this.responds.set(ship, tick + delay);
      else {
        this.responds.delete(ship);
        this.holds.delete(ship);
      }
    }
  }

  /**
   * A free-fire order reached ships: each picks after its pilot delay (keeping what it shoots, and any hold, until
   * then, as Respond); one with no delay is re-armed and picks at once.
   *
   * @param ships - The order's ships.
   * @param delays - Each ship's delay in ticks (toPilotDelays); absent means none.
   * @param tick - The tick the order was given.
   */
  FreeFire(ships: Iterable<string>, delays: ReadonlyMap<string, number>, tick: number): void {
    const reached = [...ships];
    this.Respond(reached, delays, tick);
    for (const ship of reached) if (!this.free.has(ship)) this.picksAt.set(ship, tick + (delays.get(ship) ?? 0));
  }

  /**
   * The members whose turrets the director keeps firing, like an engagement: following a call or a free-fire pick, not
   * held.
   *
   * @returns Their ids: the called in fleet order, then the free-firing.
   */
  Armed(): string[] {
    const armed: string[] = [];
    for (const given of [this.called, this.free]) for (const [ship, entry] of given) if (!this.holds.has(ship) && this.port.TargetOf(ship) === entry.target) armed.push(ship);
    return armed;
  }

  /**
   * What a following or holding member pre-locks: the next CALLED_PRE_LOCKS live targets queued after its primary.
   *
   * @param ship - The ship.
   * @returns The ids; empty for any other ship.
   */
  PreLocks(ship: string): string[] {
    const entry = this.called.get(ship);
    const plan = this.plans.get(ship);
    const following = entry != null && plan?.primary === entry.target && this.holds.get(ship) !== 'stand-down' && this.port.TargetOf(ship) === entry.target;
    return following ? plan.queue.slice(0, CALLED_PRE_LOCKS) : [];
  }

  /**
   * Where a ship's target came from.
   *
   * @param ship - The ship.
   * @returns `called` or `free` when the lever gave it (a call, a free-fire pick) and it still holds it, `own` for any
   *   other target, null without one.
   */
  Source(ship: string): Maybe<ShipTargetSource> {
    const target = this.port.TargetOf(ship);
    let source: Maybe<ShipTargetSource> = null;
    if (target != null) source = 'own';
    if (target != null && !this.own.has(ship) && this.called.get(ship)?.target === target) source = 'called';
    else if (target != null && !this.own.has(ship) && this.free.get(ship)?.target === target) source = 'free';
    return source;
  }

  /**
   * The free-fire pick a ship shoots.
   *
   * @param ship - The ship.
   * @returns Its pick and the group whose free fire it picked under, or null.
   */
  FreeOf(ship: string): Maybe<{ readonly target: string; readonly group: FleetGroup }> {
    const entry = this.free.get(ship);
    return entry && this.port.TargetOf(ship) === entry.target ? entry : null;
  }

  /**
   * The call a ship follows: the group and primary it takes.
   *
   * @param ship - The ship.
   * @returns Its call entry, or null when it follows none.
   */
  CallOf(ship: string): Maybe<{ readonly target: string; readonly group: FleetGroup }> {
    const entry = this.called.get(ship);
    return entry && this.port.TargetOf(ship) === entry.target ? entry : null;
  }

  /**
   * A ship's `call` for get_state: for fleet members a group of whose chain calls targets, or that hold, stand down or
   * respond.
   *
   * @param ship - The ship.
   * @param tick - The master tick now.
   * @returns The report, or null.
   */
  Report(ship: string, tick: number): Maybe<ShipCallReport> {
    const plan = this.plans.get(ship);
    const hold = this.holds.get(ship);
    const respondsAt = this.responds.get(ship);
    const responding = respondsAt != null && respondsAt > tick;
    const freeGroup = plan ? this.FreeGroupOf(plan) : null;
    const seconds = (ticks: number): number => Math.round(ticks * this.port.tickSeconds * 100) / 100;
    let report: Maybe<ShipCallReport> = null;
    if (plan && (plan.called || freeGroup || hold || responding)) {
      let state: ShipCallState = 'following';
      if (this.own.has(ship) && this.port.TargetOf(ship) != null) state = 'own-target';
      else if (hold === 'stand-down') state = 'stood-down';
      else if (responding) state = 'responding';
      else if (!this.port.CanTarget(ship)) state = 'in-warp';
      else if (plan.logi && plan.primary == null) state = 'logi';
      else if (freeGroup && plan.primary == null) state = 'free-fire';
      else if (plan.primary == null) state = 'no-primary';
      else if (hold === 'hold') state = 'holding';
      const free = state === 'free-fire' ? this.FreeOf(ship)?.target : null;
      const picksAt = state === 'free-fire' ? this.picksAt.get(ship) : null;
      const group = state === 'free-fire' ? freeGroup : plan.group;
      report = {
        state,
        ...(group ? { group } : {}),
        ...(plan.primary ? { primary: plan.primary } : {}),
        ...(responding ? { respondsIn: seconds(respondsAt - tick) } : {}),
        ...(free ? { free } : {}),
        ...(picksAt != null && picksAt > tick ? { picksIn: seconds(picksAt - tick) } : {})
      };
    }
    return report;
  }

  /**
   * Why a ship of a targets order does not shoot that group's call, for the order's `skipped`.
   *
   * @param ship - The ship.
   * @param group - The order's group.
   * @param tick - The master tick now.
   * @returns The reason, or null when it follows the group's call (or the group has no live primary).
   */
  SkipReason(ship: string, group: FleetGroup, tick: number): Maybe<string> {
    const primary = this.calls.get(toFleetGroupKey(group))?.primary;
    const report = this.Report(ship, tick);
    const plan = this.plans.get(ship);
    let reason: Maybe<string> = null;
    if (primary == null || !report) reason = null;
    else if (report.state === 'own-target') reason = `it has its own target "${String(this.port.TargetOf(ship))}" (it takes the call once that clears; set_target null clears it)`;
    else if (report.state === 'stood-down') reason = 'cease_fire unlock stood it down (engage, or its group calling again, re-arms it)';
    else if (report.state === 'responding') reason = `it responds in ${report.respondsIn ?? 0} s`;
    else if (report.state === 'in-warp') reason = 'it is in warp (it takes the call once it lands)';
    else if (plan?.logi && !plan.chain.some((candidate) => toFleetGroupKey(candidate) === toFleetGroupKey(group))) reason = "it is logi: it takes only its own squad's call";
    else if (report.state === 'holding') reason = 'cease_fire holds its fire (engage, or its group calling again, re-arms it)';
    else if (plan?.group && toFleetGroupKey(plan.group) !== toFleetGroupKey(group)) reason = `it follows ${describeFleetGroup(plan.group)}'s call on "${String(plan.primary)}"`;
    return reason;
  }

  /**
   * A group's `called` for get_state.
   *
   * @param group - The fleet, wing or squad.
   * @returns Its live primary, queue, skipped entries and how many follow it; null when it calls no targets.
   */
  GroupReport(group: FleetGroup): Maybe<FleetGroupCalledReport> {
    const key = toFleetGroupKey(group);
    const call = this.calls.get(key);
    let report: Maybe<FleetGroupCalledReport> = null;
    if (call) {
      let following = 0;
      for (const [ship, entry] of this.called) if (entry.target === call.primary && toFleetGroupKey(entry.group) === key && this.port.TargetOf(ship) === entry.target) following += 1;
      report = { primary: call.primary, queue: [...call.queue], ...(call.skipped.length ? { skipped: call.skipped.map((skip) => ({ ...skip })) } : {}), following };
    }
    return report;
  }

  /**
   * A ship left the scene or died: its marks, call, hold and response go.
   *
   * @param ship - The ship.
   */
  Forget(ship: string): void {
    this.own.delete(ship);
    this.called.delete(ship);
    this.free.delete(ship);
    this.picksAt.delete(ship);
    this.holds.delete(ship);
    this.responds.delete(ship);
  }

  /**
   * A load: every mark, call, free pick, hold and response goes; the next sync starts over.
   */
  Clear(): void {
    this.own.clear();
    this.called.clear();
    this.free.clear();
    this.picksAt.clear();
    this.freeFire = new Set();
    this.holds.clear();
    this.responds.clear();
    this.lastCalls.clear();
    this.primaries.clear();
    this.plans = new Map();
    this.calls = new Map();
  }

  /**
   * The group a member free-fires under: the nearest in its chain with free fire on; never for logi.
   *
   * @param plan - The member's call plan.
   * @returns The group, or null.
   */
  private FreeGroupOf(plan: ShipCallPlan): Maybe<FleetGroup> {
    return plan.logi || !this.freeFire.size ? null : (plan.chain.find((group) => this.freeFire.has(toFleetGroupKey(group))) ?? null);
  }

  /**
   * A free-firing member's target: the pick it holds while that stays live and in its reach, else the nearest hostile
   * in its reach once its pick is due (its reaction after the last one went, kept in picksAt), else null.
   *
   * @param ship - The member.
   * @param target - Its target now.
   * @param tick - The master tick now.
   * @returns The target it should have, or null while it waits or has nothing in reach.
   */
  private FreePick(ship: string, target: Maybe<string>, tick: number): Maybe<string> {
    const view = this.port.FreeFireView?.(ship) ?? null;
    const current = this.free.get(ship)?.target;
    const inReach = (id: string): boolean => view != null && this.port.Status(id) === 'live' && view.hostiles.some((each) => each.id === id && each.distance <= view.reach);
    let pick: Maybe<string> = null;
    if (current != null && current === target && inReach(current)) pick = current;
    else {
      const due = this.picksAt.get(ship) ?? tick + (this.port.FreeFireDelay?.(ship, tick) ?? 0);
      pick = due <= tick && view ? pickFreeFireTarget(view) : null;
      if (pick == null) this.picksAt.set(ship, due);
      else this.picksAt.delete(ship);
    }
    return pick;
  }

  private PrimaryChanges(tick: number): CalledPrimaryChange[] {
    const changes: CalledPrimaryChange[] = [];
    for (const [key, call] of this.calls) {
      const previous = this.primaries.get(key)?.primary ?? null;
      if (previous !== call.primary) changes.push({ group: call.group, primary: call.primary, previous, tick });
      this.primaries.set(key, { group: call.group, primary: call.primary });
    }
    for (const [key, { group, primary }] of [...this.primaries]) {
      if (this.calls.has(key)) continue;
      if (primary != null) changes.push({ group, primary: null, previous: primary, tick });
      this.primaries.delete(key);
    }
    return changes;
  }
}
