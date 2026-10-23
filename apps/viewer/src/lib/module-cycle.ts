/**
 * One fitted module's activation on EVE's timing: the rules DestinyWorld's prop mod follows (destiny.ts SwitchPropMod
 * and ApplyPropMods), generalized to every module, plus online / offline and the reactivation delay.
 *
 * - States: offline, online, activating (applies at the next tick boundary), active (cycling), stopping (runs to its
 *   cycle end, rounded up to a tick: CycleEnd), reactivating (after a stop, for the module's reactivation delay).
 * - Active: online becomes activating; stopping becomes active again; reactivating queues the activation until it is
 *   ready; offline is onlined and activated at the same boundary.
 * - Online (deactivate): activating is cancelled; active becomes stopping; an offline module comes online at the next
 *   boundary.
 * - Offline: a running module stops at its cycle end, then goes offline; the rest go offline at the next boundary.
 * - Events at boundaries: `on`, `cycle` (cycle n starts), `end` (cycle n ends), `off`. A cycle boundary that falls
 *   between ticks fires at the first tick boundary at or after it.
 * - A switch with a pilot delay is queued and made at the boundary of master tick `at`, as DestinyWorld's prop mod does.
 * - A gate (`Boundary(boundary, { hold })`) keeps an activating module waiting with the hold as its note: a turret
 *   switched on before its lock completes (EVE's pre-activation). It starts at the first boundary without a hold.
 * - `activations` counts its `on` events since it was made; every event carries the activation it belongs to, which
 *   keys the combat rolls (combat.ts).
 *
 * DestinyWorld keeps its own prop mod code (destiny.spec.ts pins it); this class copies its rules for the other
 * modules and owns CycleEnd, which destiny.ts imports.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';

export type ModuleCycleState = 'offline' | 'online' | 'activating' | 'active' | 'stopping' | 'reactivating';

/**
 * What a switch asks of a module.
 */
export type ModuleCycleRequest = 'active' | 'online' | 'offline';

export type ModuleCycleEventKind = 'on' | 'cycle' | 'end' | 'off';

export interface ModuleCycleEvent {
  readonly kind: ModuleCycleEventKind;
  /**
   * The master tick it happened at.
   */
  readonly tick: number;
  /**
   * The cycle it starts or ends (1-based); 0 for an `off` before a first cycle.
   */
  readonly cycle: number;
  /**
   * `cycle` and `end` events: the exact, fractional master tick that cycle starts or ends at (at most `tick`); a
   * cycle n starts at since + (n - 1) × cycleTicks.
   */
  readonly at?: number;
  /**
   * Why a module stopped on its own (warp, its target gone, refitted).
   */
  readonly why?: string;
  /**
   * The activation it belongs to (1 for the first `on`); 0 before any.
   */
  readonly activation: number;
}

/**
 * What may hold an activating module at a boundary.
 */
export interface ModuleCycleGate {
  /**
   * Why it must wait (`waiting for its lock on "x" (1.6 s)`); null lets it start.
   */
  readonly hold?: Maybe<string>;
}

export interface ModuleCycleTiming {
  /**
   * Ticks per cycle; may be fractional.
   */
  readonly cycleTicks: number;
  /**
   * Ticks after a stop before it can start again.
   */
  readonly reactivationTicks: number;
}

/**
 * A module's cycle in get_state, at a boundary.
 */
export interface ModuleCycleReport {
  readonly state: ModuleCycleState;
  /**
   * While active or stopping: the cycle running and seconds until it ends.
   */
  readonly cycle?: { readonly number: number; readonly endsIn: number };
  /**
   * The tick an activation applies at.
   */
  readonly at?: number;
  readonly stopsIn?: number;
  /**
   * Seconds until a queued activation starts (reactivating).
   */
  readonly activatesIn?: number;
  /**
   * Seconds until it can start again (reactivating).
   */
  readonly readyIn?: number;
  /**
   * Seconds until a delayed switch is made.
   */
  readonly respondsIn?: number;
  readonly note?: string;
}

/**
 * Below this, a cycle boundary counts as reached (float ticks); DestinyWorld's value.
 */
const CYCLE_EPSILON = 1e-9;

/**
 * The tick a module switched off stops at: the end of the cycle running at the boundary, rounded up to a tick.
 * On at 100 with a 10-tick cycle, off at 101 stops at 110 and off at 111 at 120; a 7.5-tick cycle off at 101 stops at
 * 108.
 *
 * @param input - When it started, the boundary the switch applies at, and its cycle in ticks.
 * @param input.since - The tick it started.
 * @param input.boundary - The tick boundary the switch applies at.
 * @param input.cycle - Its cycle, in ticks.
 * @returns The stop tick.
 */
export function CycleEnd(input: { readonly since: number; readonly boundary: number; readonly cycle: number }): number {
  const { since, boundary, cycle } = input;
  const cycles = Math.max(1, Math.ceil((boundary - since) / cycle - CYCLE_EPSILON));
  return Math.ceil(since + cycles * cycle - CYCLE_EPSILON);
}

/**
 * Whether a state runs the module's effect (its cycle counts).
 *
 * @param state - The state.
 * @returns True for active and stopping.
 */
export function IsCycleRunning(state: ModuleCycleState): boolean {
  return state === 'active' || state === 'stopping';
}

export class ModuleCycle {
  state: ModuleCycleState;
  timing: ModuleCycleTiming;
  /**
   * The tick it went active.
   */
  private since: Maybe<number> = null;
  /**
   * Cycles started since it went active.
   */
  private cycles = 0;
  private stopAt: Maybe<number> = null;
  private readyAt: Maybe<number> = null;
  private activateWhenReady = false;
  private offlineAfterStop = false;
  /**
   * Offline, asked online: it comes online at the next boundary.
   */
  private onlineNext = false;
  /**
   * Online (or reactivating), asked offline: it goes offline at the next boundary.
   */
  private offlineNext = false;
  private queued: Maybe<{ readonly request: ModuleCycleRequest; readonly at: number }> = null;
  note: Maybe<string> = null;
  /**
   * Its `on` events so far.
   */
  activations = 0;

  constructor(state: 'offline' | 'online', timing: ModuleCycleTiming) {
    this.state = state;
    this.timing = timing;
  }

  /**
   * Whether its effect runs now.
   */
  get running(): boolean {
    return IsCycleRunning(this.state);
  }

  /**
   * Whether it is or will be running: activating, active, or queued to start once ready.
   */
  get engaged(): boolean {
    return this.state === 'activating' || this.state === 'active' || (this.state === 'reactivating' && this.activateWhenReady);
  }

  /**
   * Asks for a state now, between boundaries (it applies at the next one), or after a pilot delay.
   *
   * @param request - Active, online or offline.
   * @param options - The boundary it applies at and a delay in whole ticks.
   */
  Request(request: ModuleCycleRequest, options: { readonly boundary: number; readonly delay?: number }): void {
    const delay = Math.max(0, Math.round(options.delay ?? 0));
    this.queued = delay > 0 ? { request, at: options.boundary + delay } : null;
    if (delay === 0) this.Apply(request, options.boundary);
  }

  /**
   * Advances to a tick boundary: a delayed switch is made, activations apply, cycles start and end, stops land.
   *
   * @param boundary - The master tick.
   * @param gate - What holds an activation (a turret's lock).
   * @returns The events, in order.
   */
  Boundary(boundary: number, gate?: ModuleCycleGate): ModuleCycleEvent[] {
    const events: ModuleCycleEvent[] = [];
    if (this.queued && this.queued.at <= boundary) {
      const { request } = this.queued;
      this.queued = null;
      this.Apply(request, boundary);
    }
    if (this.state === 'reactivating' && (this.readyAt ?? boundary) <= boundary) {
      this.readyAt = null;
      if (this.offlineNext) {
        this.state = 'offline';
        this.offlineNext = false;
      } else {
        this.state = this.activateWhenReady ? 'activating' : 'online';
      }
      this.activateWhenReady = false;
    }
    const hold = gate?.hold;
    if (this.state === 'activating' && hold) {
      this.note = hold;
    } else if (this.state === 'activating') {
      this.state = 'active';
      this.since = boundary;
      this.cycles = 1;
      this.note = null;
      this.activations += 1;
      const activation = this.activations;
      events.push({ kind: 'on', tick: boundary, cycle: 1, activation }, { kind: 'cycle', tick: boundary, cycle: 1, at: boundary, activation });
    } else if (this.running) {
      events.push(...this.Cycles(boundary));
    } else if (this.state === 'offline' && this.onlineNext) {
      this.state = 'online';
      this.onlineNext = false;
    } else if (this.offlineNext && this.state === 'online') {
      this.state = 'offline';
      this.offlineNext = false;
    }
    return events;
  }

  /**
   * Stops a running or activating module at once (warp, its target gone, refitted): no cycle end.
   *
   * @param boundary - The master tick.
   * @param why - Why, for get_state.
   * @returns The `off` event when it was running.
   */
  StopNow(boundary: number, why: string): ModuleCycleEvent[] {
    const events: ModuleCycleEvent[] = [];
    this.queued = null;
    if (this.running) {
      events.push({ kind: 'off', tick: boundary, cycle: this.cycles, why, activation: this.activations });
      this.Stopped(boundary);
      this.note = `stopped: ${why}`;
    } else if (this.state === 'activating' || this.activateWhenReady) {
      this.state = this.state === 'activating' ? 'online' : this.state;
      this.activateWhenReady = false;
      this.note = `not started: ${why}`;
    }
    return events;
  }

  /**
   * Stops a running module at the end of its cycle (its target out of range).
   *
   * @param boundary - The master tick.
   * @param why - Why, for get_state.
   */
  StopAtCycleEnd(boundary: number, why: string): void {
    if (this.state !== 'active') return;
    this.state = 'stopping';
    this.stopAt = CycleEnd({ since: this.since ?? boundary, boundary, cycle: this.timing.cycleTicks });
    this.note = `stopping: ${why}`;
  }

  /**
   * The cycle for get_state.
   *
   * @param boundary - The master tick now.
   * @param tickSeconds - Seconds per tick.
   * @returns The report.
   */
  Report(boundary: number, tickSeconds: number): ModuleCycleReport {
    const seconds = (ticks: number): number => Math.round(Math.max(0, ticks) * tickSeconds * 10) / 10;
    const nextEnd = this.since == null ? null : Math.ceil(this.since + this.cycles * this.timing.cycleTicks - CYCLE_EPSILON);
    return {
      state: this.state,
      ...(this.running && nextEnd != null ? { cycle: { number: this.cycles, endsIn: seconds(nextEnd - boundary) } } : {}),
      ...(this.state === 'activating' ? { at: boundary } : {}),
      ...(this.state === 'stopping' && this.stopAt != null ? { stopsIn: seconds(this.stopAt - boundary) } : {}),
      ...(this.state === 'reactivating' && this.readyAt != null ? { readyIn: seconds(this.readyAt - boundary), ...(this.activateWhenReady ? { activatesIn: seconds(this.readyAt - boundary) } : {}) } : {}),
      ...(this.queued ? { respondsIn: seconds(this.queued.at - boundary) } : {}),
      ...(this.note ? { note: this.note } : {})
    };
  }

  private Apply(request: ModuleCycleRequest, boundary: number): void {
    const { state } = this;
    if (request === 'active') {
      this.offlineAfterStop = false;
      this.offlineNext = false;
      if (state === 'online' || state === 'offline') {
        this.state = 'activating';
        this.onlineNext = false;
        this.note = null;
      } else if (state === 'stopping') {
        this.state = 'active';
        this.stopAt = null;
      } else if (state === 'reactivating') {
        this.activateWhenReady = true;
      }
    } else if (request === 'online') {
      this.offlineAfterStop = false;
      this.offlineNext = false;
      if (state === 'activating') {
        this.state = 'online';
        this.note = null;
      } else if (state === 'active') this.StopAtCycleEnd(boundary, 'switched off');
      else if (state === 'reactivating') this.activateWhenReady = false;
      else if (state === 'offline') this.onlineNext = true;
      if (this.state === 'stopping') this.note = null;
    } else {
      this.onlineNext = false;
      this.activateWhenReady = false;
      if (state === 'active' || state === 'stopping') {
        this.StopAtCycleEnd(boundary, 'switched offline');
        this.offlineAfterStop = true;
        this.note = null;
      } else if (state === 'activating' || state === 'online' || state === 'reactivating') {
        if (state === 'activating') this.state = 'online';
        this.offlineNext = true;
      }
    }
  }

  /**
   * The cycle ends and starts a running module reaches by a boundary, and its stop.
   */
  private Cycles(boundary: number): ModuleCycleEvent[] {
    const events: ModuleCycleEvent[] = [];
    const since = this.since ?? boundary;
    const cycle = Math.max(this.timing.cycleTicks, CYCLE_EPSILON);
    let end = Math.ceil(since + this.cycles * cycle - CYCLE_EPSILON);
    while (end <= boundary && this.running) {
      const activation = this.activations;
      events.push({ kind: 'end', tick: boundary, cycle: this.cycles, at: since + this.cycles * cycle, activation });
      if (this.state === 'stopping' && (this.stopAt ?? end) <= end) {
        events.push({ kind: 'off', tick: boundary, cycle: this.cycles, activation });
        this.Stopped(boundary);
      } else {
        this.cycles += 1;
        events.push({ kind: 'cycle', tick: boundary, cycle: this.cycles, at: since + (this.cycles - 1) * cycle, activation });
        end = Math.ceil(since + this.cycles * cycle - CYCLE_EPSILON);
      }
    }
    return events;
  }

  /**
   * After a stop: offline when asked, else reactivating for the delay, else online.
   */
  private Stopped(boundary: number): void {
    this.since = null;
    this.cycles = 0;
    this.stopAt = null;
    if (this.offlineAfterStop) {
      this.state = 'offline';
      this.offlineAfterStop = false;
    } else if (this.timing.reactivationTicks > 0) {
      this.state = 'reactivating';
      this.readyAt = Math.ceil(boundary + this.timing.reactivationTicks - CYCLE_EPSILON);
    } else {
      this.state = 'online';
    }
  }
}
