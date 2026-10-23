/**
 * The page's module activation layer: every fitted module but the prop mod, on EVE's cycle timing (module-cycle.ts).
 * The prop mod stays DestinyWorld's (the director routes its switches there).
 *
 * - SetFit gives a ship its modules (their activation: moduleActivationOf); states carry over by (key, type id), and a
 *   running module that vanished stops at once (`refitted`). Modules beyond their group's maxGroupOnline start offline.
 * - Switch asks one module for a state now or after a pilot delay. Refused: activating a module that cannot run yet
 *   (launchers, MJDs, cloaks, cynos, bubbles, smartbombs, ECM bursts, passive modules), beyond maxGroupActive, in warp,
 *   a targeted module without a target ship, on itself, on a ship in warp, beyond its reach (`activation.reach`:
 *   optimal + 2 × falloff; Infinity for turrets), or already running on another target. A turret's target may also be
 *   an authored object, and a running turret given another target retargets at its next cycle (Retarget).
 * - Boundary advances every cycle at a tick boundary. A running targeted module whose target drifts out of reach stops
 *   at its cycle end; one whose target is removed (Remove) or enters warp (OnWarpEnter) stops at once. Entering warp
 *   stops a ship's own modules that are not warp safe, and its targeted ones, at once.
 * - RepairLandings turns cycle events into repairs: shield boosters at cycle start, armor and hull repairers at cycle
 *   end, remote ones on their target scaled by effectiveness (damage.ts applies them).
 * - Target effects (target-effects.ts): each running targeted module keeps `applied`, its effectiveness at its latest
 *   cycle start (kept while it stops, null once off). Targeting / TargetIndex list them per target, for the target's
 *   flight (webs, painters, points, scrams); CapacitorLandings turns cycle starts into neut, nos and transmitter
 *   transfers (capacitor.ts applies them).
 * - Locks (locks.ts, through the port's LockHold): a turret activated before its lock completes waits in `activating`
 *   with the lock note (EVE's pre-activation); a running turret whose lock is lost stops at its cycle end; a pending
 *   retarget switches at the first cycle start once the new target is locked. Without LockHold nothing waits.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { type CapacitorTransferKind, falloffEffectiveness, type DefenseLayerName, type ModuleActivation, type TurretCombatNumbers } from '@scene-director/scene';
import { IsCycleRunning, ModuleCycle, type ModuleCycleEvent, type ModuleCycleReport, type ModuleCycleRequest, type ModuleCycleState } from './module-cycle';

/**
 * What the layer needs from the world: distances, warp and the ships there are.
 */
export interface ShipModulesPort {
  /**
   * Metres, surface to surface on the EVE radii (`b` may be an object); null when either is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
  /**
   * Whether a ship is in proper warp.
   */
  InWarp(id: string): boolean;
  HasShip(id: string): boolean;
  /**
   * Whether an authored object is in the world (a turret's target may be one).
   */
  HasObject(id: string): boolean;
  /**
   * Seconds per Destiny tick.
   */
  readonly tickSeconds: number;
  /**
   * Why a turret must wait for its lock on a target (ShipLocks.Hold); null once locked. Absent: turrets never wait.
   */
  LockHold?(ship: string, target: string): Maybe<string>;
}

/**
 * A fitted module the layer runs.
 */
export interface ShipModuleSpec {
  readonly key: string;
  readonly name: string;
  readonly typeID: number;
  /**
   * Fitted `/OFFLINE`.
   */
  readonly offline: boolean;
  readonly activation: ModuleActivation;
  /**
   * A turret's damage, tracking and ranges from the same live evaluation (turretCombatNumbersOf); null without dogma.
   */
  readonly combat?: Maybe<TurretCombatNumbers>;
}

/**
 * A module event at a boundary, with its ship and, for a targeted module, its target.
 */
export interface ShipModuleEvent extends ModuleCycleEvent {
  readonly ship: string;
  readonly module: string;
  readonly target?: string;
  readonly effectiveness?: number;
  /**
   * The module's default effect guid (its client effect, effects.ts) and cycle (s): what module-fx.ts and
   * module-audio.ts need even after the module or its ship is gone.
   */
  readonly effectGuid?: string;
  readonly cycleTime: number;
}

/**
 * A repair landing on a ship.
 */
export interface RepairLanding {
  readonly ship: string;
  readonly layer: DefenseLayerName;
  readonly amount: number;
  readonly from: string;
  readonly module: string;
}

/**
 * A running targeted module on a ship.
 */
export interface TargetingModule {
  readonly from: string;
  readonly spec: ShipModuleSpec;
  /**
   * Its falloff effectiveness now (1 when unknown).
   */
  readonly effectiveness: number;
  /**
   * Its effectiveness at its latest cycle start: what its effect on the target is scaled by this cycle.
   */
  readonly applied: number;
}

/**
 * A capacitor transfer a cycle start lands: a neut or nos draining the target, a transmitter giving to it.
 */
export interface CapacitorLanding {
  readonly from: string;
  readonly module: string;
  readonly target: string;
  readonly kind: CapacitorTransferKind;
  /**
   * GJ, scaled by the cycle's effectiveness (the target's resistance not yet applied).
   */
  readonly amount: number;
  readonly override: boolean;
  readonly resistanceAttributeID?: number;
}

/**
 * A module's state in get_state (beside its key and name).
 */
export interface ShipModuleLiveState extends ModuleCycleReport {
  readonly target?: string;
  /**
   * A running turret's next target: it retargets at its next cycle.
   */
  readonly nextTarget?: string;
  readonly targetDistance?: number;
  readonly effectiveness?: number;
  /**
   * While it runs: seconds per cycle (2 decimals), a gun's rate of fire.
   */
  readonly cycleTime?: number;
}

export interface SwitchModuleOptions {
  readonly boundary: number;
  readonly target?: Maybe<string>;
  /**
   * Whole ticks.
   */
  readonly delay?: number;
}

interface ModuleEntry {
  spec: ShipModuleSpec;
  readonly cycle: ModuleCycle;
  target: Maybe<string>;
  /**
   * A running turret's next target, taken at its next cycle start; null stops it at its cycle end instead.
   */
  retarget?: string;
  effectiveness: Maybe<number>;
  /**
   * The effectiveness at its latest cycle start; null once it is not running.
   */
  applied: Maybe<number>;
}

export class ShipModules {
  private readonly port: ShipModulesPort;
  private readonly ships = new Map<string, Map<string, ModuleEntry>>();

  constructor(port: ShipModulesPort) {
    this.port = port;
  }

  /**
   * Gives a ship its modules, keeping each one's state when its key and type are unchanged.
   *
   * @param id - The ship id.
   * @param specs - Its modules (the prop mod excluded).
   * @param boundary - The master tick now.
   * @returns `off` events for running modules that vanished.
   */
  SetFit(id: string, specs: readonly ShipModuleSpec[], boundary: number): ShipModuleEvent[] {
    const before = this.ships.get(id) ?? new Map<string, ModuleEntry>();
    const after = new Map<string, ModuleEntry>();
    const events: ShipModuleEvent[] = [];
    const online = new Map<number, number>();
    for (const spec of specs) {
      const kept = before.get(spec.key);
      const timing = this.Timing(spec);
      let entry: ModuleEntry;
      if (kept && kept.spec.typeID === spec.typeID) {
        kept.spec = spec;
        kept.cycle.timing = timing;
        entry = kept;
      } else {
        const limit = spec.activation.maxGroupOnline;
        const count = online.get(spec.activation.groupID) ?? 0;
        const over = !spec.offline && limit > 0 && count >= limit;
        const cycle = new ModuleCycle(spec.offline || over ? 'offline' : 'online', timing);
        if (over) cycle.note = `offline: at most ${limit} of its group may be online`;
        entry = { spec, cycle, target: null, effectiveness: null, applied: null };
      }
      if (entry.cycle.state !== 'offline') online.set(spec.activation.groupID, (online.get(spec.activation.groupID) ?? 0) + 1);
      after.set(spec.key, entry);
    }
    for (const [key, entry] of before) if (after.get(key) !== entry) events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'refitted')));
    if (specs.length) this.ships.set(id, after);
    else this.ships.delete(id);
    return events;
  }

  /**
   * Removes a ship's modules, and stops at once every module targeting it.
   *
   * @param id - The ship id.
   * @param boundary - The master tick now.
   * @param why - Why the modules on it stop (`its target was destroyed`).
   * @returns The `off` events.
   */
  Remove(id: string, boundary: number, why = 'its target is gone'): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [key, entry] of this.ships.get(id) ?? []) events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'removed')));
    this.ships.delete(id);
    events.push(...this.StopTargeting(id, boundary, why));
    return events;
  }

  /**
   * Asks a module for a state.
   *
   * @param id - The ship id.
   * @param key - The module key.
   * @param request - Active, online or offline.
   * @param options - The boundary, a target and a pilot delay.
   * @returns The refusal, or null when the switch was made (or queued).
   */
  Switch(id: string, key: string, request: ModuleCycleRequest, options: SwitchModuleOptions): Maybe<string> {
    const entry = this.ships.get(id)?.get(key);
    let refusal: Maybe<string> = null;
    if (!entry) {
      refusal = `ship "${id}" fits no module ${key}`;
    } else if (request === 'active') {
      refusal = this.ActivationRefusal(id, entry, options.target ?? null);
    } else if (request === 'online' && entry.cycle.state === 'offline') {
      refusal = this.OnlineRefusal(id, entry);
    }
    if (entry && refusal === null) {
      if (request === 'active' && entry.spec.activation.targeted) {
        const aim = options.target ?? entry.retarget ?? entry.target;
        if (IsTurret(entry) && entry.cycle.running && entry.target && aim && aim !== entry.target) entry.retarget = aim;
        else entry.target = aim;
        if (entry.retarget === entry.target) delete entry.retarget;
        entry.effectiveness = this.Effectiveness(id, entry);
      }
      entry.cycle.Request(request, { boundary: options.boundary, delay: options.delay });
      if (!entry.cycle.engaged && !entry.cycle.running && entry.spec.activation.targeted) this.Untarget(entry);
    }
    return refusal;
  }

  /**
   * A ship's target changed: its running and starting turrets follow it. A running turret takes a new target at its
   * next cycle start; a starting one at once; null stops them at their cycle end.
   *
   * @param id - The ship id.
   * @param target - The new target (a ship or object), or null.
   * @param boundary - The master tick now.
   * @returns The `off` events of turrets that could not start on it.
   */
  Retarget(id: string, target: Maybe<string>, boundary: number): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [key, entry] of this.ships.get(id) ?? []) {
      if (!IsTurret(entry) || (!entry.cycle.running && !entry.cycle.engaged)) continue;
      if (target == null) {
        delete entry.retarget;
        if (entry.cycle.running) entry.cycle.StopAtCycleEnd(boundary, 'its target was cleared');
        else events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'its target was cleared')));
      } else if (entry.cycle.running && entry.target && entry.target !== target) {
        entry.retarget = target;
      } else {
        delete entry.retarget;
        entry.target = target;
        entry.effectiveness = this.Effectiveness(id, entry);
      }
      if (!entry.cycle.engaged && !entry.cycle.running) this.Untarget(entry);
    }
    return events;
  }

  /**
   * Advances every module to a tick boundary.
   *
   * @param boundary - The master tick.
   * @returns The events, ship by ship in fit order.
   */
  Boundary(boundary: number): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [id, modules] of this.ships) {
      for (const [key, entry] of modules) {
        if (entry.spec.activation.targeted && entry.target && (entry.cycle.running || entry.cycle.state === 'activating')) {
          const gone = !this.Targetable(entry, entry.target) || this.port.InWarp(entry.target);
          const distance = gone ? null : this.port.SurfaceDistance(id, entry.target);
          if (gone || distance == null) {
            events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'its target is gone')));
          } else if (distance > entry.spec.activation.reach) {
            if (entry.cycle.state === 'activating') events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'its target is out of range')));
            else entry.cycle.StopAtCycleEnd(boundary, 'its target is out of range');
          }
          entry.effectiveness = this.Effectiveness(id, entry);
        }
        const hold = entry.target && IsTurret(entry) ? this.LockHold(id, entry.target) : null;
        if (hold && entry.cycle.state === 'active') entry.cycle.StopAtCycleEnd(boundary, `it lost its lock on "${entry.target}"`);
        const cycled = entry.cycle.Boundary(boundary, hold ? { hold } : undefined);
        const next = entry.retarget === undefined || this.LockHold(id, entry.retarget) ? -1 : cycled.findIndex((event) => event.kind === 'cycle');
        if (next < 0) {
          events.push(...this.Events(id, key, entry, cycled));
        } else {
          events.push(...this.Events(id, key, entry, cycled.slice(0, next)));
          entry.target = entry.retarget;
          delete entry.retarget;
          entry.effectiveness = this.Effectiveness(id, entry);
          events.push(...this.Events(id, key, entry, cycled.slice(next)));
        }
        if (!entry.cycle.running && !entry.cycle.engaged) this.Untarget(entry);
      }
    }
    return events;
  }

  /**
   * A ship enters proper warp: its modules that are not warp safe, and its targeted ones, stop at once, as does every
   * module targeting it.
   *
   * @param id - The ship id.
   * @param boundary - The master tick.
   * @returns The `off` events.
   */
  OnWarpEnter(id: string, boundary: number): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [key, entry] of this.ships.get(id) ?? []) {
      if (!entry.spec.activation.warpSafe || entry.spec.activation.targeted) events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'entered warp')));
    }
    events.push(...this.StopTargeting(id, boundary, 'its target entered warp'));
    return events;
  }

  /**
   * A module's state for get_state.
   *
   * @param id - The ship id.
   * @param key - The module key.
   * @param boundary - The master tick now.
   * @returns The state; null for a module the layer does not run.
   */
  State(id: string, key: string, boundary: number): Maybe<ShipModuleLiveState> {
    const entry = this.ships.get(id)?.get(key);
    if (!entry) return null;
    const report = entry.cycle.Report(boundary, this.port.tickSeconds);
    const distance = entry.target ? this.port.SurfaceDistance(id, entry.target) : null;
    return {
      ...report,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.retarget ? { nextTarget: entry.retarget } : {}),
      ...(distance == null ? {} : { targetDistance: Math.round(distance) }),
      ...(entry.effectiveness == null ? {} : { effectiveness: Math.round(entry.effectiveness * 1000) / 1000 }),
      ...(entry.cycle.running ? { cycleTime: Math.round(entry.spec.activation.cycleTime * 100) / 100 } : {}),
      ...(!report.note && entry.spec.activation.note && entry.cycle.running ? { note: entry.spec.activation.note } : {})
    };
  }

  /**
   * A module's spec (a turret's combat numbers).
   *
   * @param id - The ship id.
   * @param key - The module key.
   * @returns It, or null for a module the layer does not run.
   */
  Spec(id: string, key: string): Maybe<ShipModuleSpec> {
    return this.ships.get(id)?.get(key)?.spec ?? null;
  }

  /**
   * What every ship's turrets aim at while running, stopping or waiting to start, a pending retarget included: the
   * locks the lock sweep keeps.
   *
   * @returns The targets by ship id.
   */
  TurretAims(): Map<string, Set<string>> {
    const aims = new Map<string, Set<string>>();
    for (const [id, modules] of this.ships) {
      for (const entry of modules.values()) {
        if (!IsTurret(entry) || (!entry.cycle.running && !entry.cycle.engaged)) continue;
        const set = aims.get(id) ?? new Set<string>();
        if (entry.target) set.add(entry.target);
        if (entry.retarget) set.add(entry.retarget);
        aims.set(id, set);
      }
    }
    return aims;
  }

  /**
   * A ship's turrets, whatever their state.
   *
   * @param id - The ship id.
   * @returns Their keys, in fit order.
   */
  TurretKeys(id: string): string[] {
    return [...(this.ships.get(id) ?? [])].flatMap(([key, entry]) => (IsTurret(entry) ? [key] : []));
  }

  /**
   * A module's cycle state.
   *
   * @param id - The ship id.
   * @param key - The module key.
   * @param typeID - When given, the type the module must be (a refit may have put another type under the key).
   * @returns It, or null for a module the layer does not run.
   */
  CycleState(id: string, key: string, typeID?: number): Maybe<ModuleCycleState> {
    const entry = this.ships.get(id)?.get(key);
    return entry && (typeID == null || entry.spec.typeID === typeID) ? entry.cycle.state : null;
  }

  /**
   * Forgets every ship's modules (a load restarts the scene), stopping the running ones at once.
   *
   * @param boundary - The master tick now.
   * @returns The `off` events.
   */
  Clear(boundary: number): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [id, modules] of this.ships) for (const [key, entry] of modules) events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'the scene was loaded')));
    this.ships.clear();
    return events;
  }

  /**
   * The specs of a ship's modules running now.
   *
   * @param id - The ship id.
   * @returns Them, in fit order.
   */
  Running(id: string): ShipModuleSpec[] {
    return [...(this.ships.get(id)?.values() ?? [])].flatMap((entry) => (entry.cycle.running ? [entry.spec] : []));
  }

  /**
   * The remote repairers running on a ship, with their effectiveness.
   *
   * @param id - The target ship's id.
   * @returns The repairs.
   */
  Incoming(id: string): { readonly from: string; readonly spec: ShipModuleSpec; readonly effectiveness: number }[] {
    const incoming: { readonly from: string; readonly spec: ShipModuleSpec; readonly effectiveness: number }[] = [];
    for (const [from, modules] of this.ships) {
      for (const entry of modules.values()) if (entry.target === id && entry.cycle.running && entry.spec.activation.repair?.remote) incoming.push({ from, spec: entry.spec, effectiveness: entry.effectiveness ?? 1 });
    }
    return incoming;
  }

  /**
   * The running targeted modules on a ship (remote reps included), with their effectiveness now and at their latest
   * cycle start.
   *
   * @param target - The target ship's id.
   * @returns Them, ship by ship in fit order.
   */
  Targeting(target: string): TargetingModule[] {
    return this.TargetIndex().get(target) ?? [];
  }

  /**
   * Targeting for every target, in one pass.
   *
   * @returns The running targeted modules by target id.
   */
  TargetIndex(): Map<string, TargetingModule[]> {
    const index = new Map<string, TargetingModule[]>();
    for (const [from, modules] of this.ships) {
      for (const entry of modules.values()) {
        if (!entry.target || !entry.cycle.running || !entry.spec.activation.targeted || IsTurret(entry)) continue;
        const list = index.get(entry.target) ?? [];
        list.push({ from, spec: entry.spec, effectiveness: entry.effectiveness ?? 1, applied: entry.applied ?? entry.effectiveness ?? 1 });
        index.set(entry.target, list);
      }
    }
    return index;
  }

  /**
   * The capacitor transfers a batch of events lands: at each cycle start (the first at `on`) of a neut, nos or
   * transmitter on a target, scaled by the effectiveness at that start.
   *
   * @param events - Boundary events.
   * @returns The transfers, in event order.
   */
  CapacitorLandings(events: readonly ShipModuleEvent[]): CapacitorLanding[] {
    const landings: CapacitorLanding[] = [];
    for (const event of events) {
      if (event.kind !== 'cycle' || !event.target) continue;
      const effect = this.ships.get(event.ship)?.get(event.module)?.spec.activation.targetEffect;
      const capacitor = effect?.capacitor;
      if (!capacitor) continue;
      landings.push({
        from: event.ship,
        module: event.module,
        target: event.target,
        kind: capacitor.kind,
        amount: capacitor.amount * (event.effectiveness ?? 1),
        override: capacitor.override === true,
        ...(effect.resistanceAttributeID == null ? {} : { resistanceAttributeID: effect.resistanceAttributeID })
      });
    }
    return landings;
  }

  /**
   * The repairs a batch of events lands: shield at a cycle's start, armor and hull at its end, remote ones on their
   * target scaled by effectiveness.
   *
   * @param events - Boundary events.
   * @returns The repairs.
   */
  RepairLandings(events: readonly ShipModuleEvent[]): RepairLanding[] {
    const landings: RepairLanding[] = [];
    for (const event of events) {
      const repair = this.ships.get(event.ship)?.get(event.module)?.spec.activation.repair;
      if (!repair) continue;
      const lands = repair.layer === 'shield' ? event.kind === 'cycle' : event.kind === 'end';
      const ship = repair.remote ? event.target : event.ship;
      if (lands && ship) landings.push({ ship, layer: repair.layer, amount: repair.amount * (repair.remote ? (event.effectiveness ?? 1) : 1), from: event.ship, module: event.module });
    }
    return landings;
  }

  private ActivationRefusal(id: string, entry: ModuleEntry, target: Maybe<string>): Maybe<string> {
    const { activation } = entry.spec;
    let refusal: Maybe<string> = null;
    const running = entry.cycle.running || entry.cycle.engaged;
    if (activation.refusal) {
      refusal = activation.refusal;
    } else if (this.port.InWarp(id)) {
      refusal = `ship "${id}" is in warp`;
    } else if (activation.targeted) {
      const turret = IsTurret(entry);
      const aim = target ?? (running ? (entry.retarget ?? entry.target) : null);
      const distance = aim ? this.port.SurfaceDistance(id, aim) : null;
      const { reach } = activation;
      if (!aim) refusal = turret ? 'it needs a target: set_target or switch_modules target' : 'it needs a target: a ship id';
      else if (aim === id) refusal = 'it cannot target its own ship';
      else if (!this.Targetable(entry, aim)) refusal = turret ? `no ship or object "${aim}"` : `no ship "${aim}" (a targeted module runs on a ship, not an object)`;
      else if (this.port.InWarp(aim)) refusal = `its target "${aim}" is in warp`;
      else if (!turret && running && entry.target && entry.target !== aim) refusal = `it is running on "${entry.target}"; switch it online first`;
      else if (distance == null || distance > reach) refusal = `"${aim}" is out of range: ${Math.round(distance ?? 0)} m, it reaches ${Math.round(reach)} m`;
    }
    if (refusal === null && !running && activation.maxGroupActive > 0) {
      const engaged = [...(this.ships.get(id)?.values() ?? [])].filter((other) => other !== entry && other.spec.activation.groupID === activation.groupID && (other.cycle.running || other.cycle.engaged)).length;
      if (engaged >= activation.maxGroupActive) refusal = `at most ${activation.maxGroupActive} of its group may run at once`;
    }
    if (refusal === null && entry.cycle.state === 'offline') refusal = this.OnlineRefusal(id, entry);
    return refusal;
  }

  private OnlineRefusal(id: string, entry: ModuleEntry): Maybe<string> {
    const { maxGroupOnline, groupID } = entry.spec.activation;
    if (maxGroupOnline <= 0) return null;
    const online = [...(this.ships.get(id)?.values() ?? [])].filter((other) => other !== entry && other.spec.activation.groupID === groupID && other.cycle.state !== 'offline').length;
    return online >= maxGroupOnline ? `at most ${maxGroupOnline} of its group may be online` : null;
  }

  /**
   * Whether a module may run on a target: a ship, or for a turret an authored object too.
   */
  private Targetable(entry: ModuleEntry, target: string): boolean {
    return this.port.HasShip(target) || (IsTurret(entry) && this.port.HasObject(target));
  }

  private LockHold(id: string, target: string): Maybe<string> {
    return this.port.LockHold?.(id, target) ?? null;
  }

  private Untarget(entry: ModuleEntry): void {
    entry.target = null;
    delete entry.retarget;
  }

  private Effectiveness(id: string, entry: ModuleEntry): Maybe<number> {
    const distance = entry.target ? this.port.SurfaceDistance(id, entry.target) : null;
    return distance == null ? null : falloffEffectiveness({ distance, range: entry.spec.activation.range, falloff: entry.spec.activation.falloff });
  }

  private StopTargeting(target: string, boundary: number, why: string): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [id, modules] of this.ships) {
      for (const [key, entry] of modules) {
        if (entry.retarget === target) delete entry.retarget;
        if (entry.target !== target) continue;
        events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, why)));
        this.Untarget(entry);
      }
    }
    return events;
  }

  private Events(ship: string, module: string, entry: ModuleEntry, events: readonly ModuleCycleEvent[]): ShipModuleEvent[] {
    const { effectGuid, cycleTime } = entry.spec.activation;
    if (events.some((event) => event.kind === 'cycle')) entry.applied = entry.effectiveness ?? 1;
    if (!entry.cycle.running) entry.applied = null;
    return events.map((event) => ({ ...event, ship, module, ...(entry.target ? { target: entry.target } : {}), ...(entry.effectiveness == null ? {} : { effectiveness: entry.effectiveness }), ...(effectGuid ? { effectGuid } : {}), cycleTime }));
  }

  private Timing(spec: ShipModuleSpec): { readonly cycleTicks: number; readonly reactivationTicks: number } {
    const tick = this.port.tickSeconds;
    return { cycleTicks: spec.activation.cycleTime / tick, reactivationTicks: spec.activation.reactivationDelay / tick };
  }
}

/**
 * Whether a module is a turret: it fires at its ship's target, a ship or an object, at any range.
 */
function IsTurret(entry: ModuleEntry): boolean {
  return entry.spec.activation.weapon === 'turret';
}

/**
 * Whether a module state runs its effect.
 */
export function IsModuleRunning(state: Maybe<ModuleCycleState>): boolean {
  return state != null && IsCycleRunning(state);
}
