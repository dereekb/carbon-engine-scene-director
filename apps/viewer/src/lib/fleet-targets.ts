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
 *
 * Sync works out the target each member should have and returns the changes; the director applies them through its
 * SetShipTarget, arms Armed() like an engagement, and adds PreLocks to the wanted locks. All state is plain data.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { CALLED_PRE_LOCKS, type CalledTargetSkip, type CalledTargetStatus, describeFleetGroup, type FleetGroup, type FleetGroupCall, type SceneDocument, type ShipCallPlan, toFleetGroupCalls, toFleetGroupKey, toShipCallPlans } from '@scene-director/scene';

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
}

/**
 * How cease_fire leaves a called member: `hold` keeps the call and its locks without firing; `stand-down` takes no
 * called target.
 */
export type FleetTargetHold = 'hold' | 'stand-down';

/**
 * Where a ship's target came from: its own (set_target, engage, switch_modules), or its group's call.
 */
export type ShipTargetSource = 'own' | 'called';

/**
 * A ship's state under its groups' calls, in get_state's priority order.
 */
export const SHIP_CALL_STATES = ['own-target', 'stood-down', 'responding', 'in-warp', 'logi', 'no-primary', 'holding', 'following'] as const;

export type ShipCallState = (typeof SHIP_CALL_STATES)[number];

/**
 * A target the director must set: the lever's call, or null when the call ends for the ship.
 */
export interface FleetTargetChange {
  readonly ship: string;
  readonly target: Maybe<string>;
  /**
   * The group whose call it takes; null when the change clears it.
   */
  readonly group: Maybe<FleetGroup>;
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

export class FleetTargets {
  private readonly port: FleetTargetsPort;
  private readonly own = new Set<string>();
  private readonly called = new Map<string, CalledEntry>();
  private readonly holds = new Map<string, FleetTargetHold>();
  private readonly responds = new Map<string, number>();
  private readonly lastCalls = new Map<string, string>();
  private readonly primaries = new Map<string, { readonly group: FleetGroup; readonly primary: Maybe<string> }>();
  private plans = new Map<string, ShipCallPlan>();
  private calls = new Map<string, FleetGroupCall>();

  constructor(port: FleetTargetsPort) {
    this.port = port;
  }

  /**
   * Works out every fleet member's call and returns the targets to change, and the groups whose live primary moved.
   *
   * 1. Groups whose called list changed since the last sync lift the holds of the ships they reach (not those still
   *    responding to an order: their response lifts it).
   * 2. Per member, in fleet order: an own target stands (the mark drops once its target clears); a ship that cannot
   *    target forgets its call; a stood-down ship drops its called target; a responding ship keeps what it has until
   *    due; every other takes its plan's primary.
   * 3. A ship that left every fleet drops its called target.
   *
   * @param scene - The live fleet view (the destroyed out of their fleets).
   * @param tick - The master tick now.
   * @returns The changes, in fleet order, and the primary changes.
   */
  Sync(scene: Pick<SceneDocument, 'ships' | 'fleets'>, tick: number): FleetTargetsSync {
    const calling = (scene.fleets ?? []).some((fleet) => fleet.targets?.length || fleet.wings.some((wing) => wing.targets?.length || wing.squads.some((squad) => squad.targets?.length)));
    if (!calling && !this.called.size && !this.holds.size && !this.responds.size && !this.primaries.size && !this.lastCalls.size) {
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
      if (target && group) this.called.set(ship, { target, group });
      else this.called.delete(ship);
    };
    for (const [ship, plan] of this.plans) {
      if (changed.size && !this.responds.has(ship) && plan.chain.some((group) => changed.has(toFleetGroupKey(group)))) this.holds.delete(ship);
      const target = TargetOf(ship);
      if (this.own.has(ship) && target == null) this.own.delete(ship);
      if (this.own.has(ship)) {
        this.called.delete(ship);
        continue;
      }
      if (!CanTarget(ship)) {
        this.called.delete(ship);
        continue;
      }
      const entry = this.called.get(ship);
      if (this.holds.get(ship) === 'stand-down') {
        if (entry && target === entry.target) change(ship, null, null);
        else this.called.delete(ship);
        continue;
      }
      const respondsAt = this.responds.get(ship);
      if (respondsAt != null && respondsAt > tick) continue;
      if (respondsAt != null) {
        this.responds.delete(ship);
        this.holds.delete(ship);
      }
      if (plan.primary == null || !plan.group) {
        if (entry && target === entry.target) change(ship, null, null);
        else this.called.delete(ship);
      } else if (plan.primary !== target) change(ship, plan.primary, plan.group);
      else this.called.set(ship, { target: plan.primary, group: plan.group });
    }
    for (const [ship, entry] of [...this.called]) {
      if (this.plans.has(ship)) continue;
      if (TargetOf(ship) === entry.target) change(ship, null, null);
      else this.called.delete(ship);
    }
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
   * The members whose turrets the director keeps firing, like an engagement: following a call, not held.
   *
   * @returns Their ids, in fleet order.
   */
  Armed(): string[] {
    const armed: string[] = [];
    for (const [ship, entry] of this.called) if (!this.holds.has(ship) && this.port.TargetOf(ship) === entry.target) armed.push(ship);
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
   * @returns `called` when the lever gave it and it still holds it, `own` for any other target, null without one.
   */
  Source(ship: string): Maybe<ShipTargetSource> {
    const target = this.port.TargetOf(ship);
    let source: Maybe<ShipTargetSource> = null;
    if (target != null) source = !this.own.has(ship) && this.called.get(ship)?.target === target ? 'called' : 'own';
    return source;
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
    let report: Maybe<ShipCallReport> = null;
    if (plan && (plan.called || hold || responding)) {
      let state: ShipCallState = 'following';
      if (this.own.has(ship) && this.port.TargetOf(ship) != null) state = 'own-target';
      else if (hold === 'stand-down') state = 'stood-down';
      else if (responding) state = 'responding';
      else if (!this.port.CanTarget(ship)) state = 'in-warp';
      else if (plan.logi && plan.primary == null) state = 'logi';
      else if (plan.primary == null) state = 'no-primary';
      else if (hold === 'hold') state = 'holding';
      report = {
        state,
        ...(plan.group ? { group: plan.group } : {}),
        ...(plan.primary ? { primary: plan.primary } : {}),
        ...(responding ? { respondsIn: Math.round((respondsAt - tick) * this.port.tickSeconds * 100) / 100 } : {})
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
    this.holds.delete(ship);
    this.responds.delete(ship);
  }

  /**
   * A load: every mark, call, hold and response goes; the next sync starts over.
   */
  Clear(): void {
    this.own.clear();
    this.called.clear();
    this.holds.clear();
    this.responds.clear();
    this.lastCalls.clear();
    this.primaries.clear();
    this.plans = new Map();
    this.calls = new Map();
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
