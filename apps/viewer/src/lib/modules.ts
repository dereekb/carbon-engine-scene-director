/**
 * The page's module activation layer: every fitted module but the prop mod, on EVE's cycle timing (module-cycle.ts).
 * The prop mod stays DestinyWorld's (the director routes its switches there).
 *
 * - SetFit gives a ship its modules (their activation: moduleActivationOf); states carry over by (key, type id), and a
 *   running module that vanished stops at once (`refitted`). Modules beyond their group's maxGroupOnline start offline.
 * - Switch asks one module for a state now or after a pilot delay. Refused: activating a module that cannot run yet
 *   (weapons, MJDs, cloaks, cynos, bubbles, smartbombs, ECM bursts, passive modules), beyond maxGroupActive, in warp, a
 *   targeted module without a target ship, on itself, on a ship in warp, beyond its reach (optimal + 2 × falloff), or
 *   already running on another target.
 * - Boundary advances every cycle at a tick boundary. A running targeted module whose target drifts out of reach stops
 *   at its cycle end; one whose target is removed (Remove) or enters warp (OnWarpEnter) stops at once. Entering warp
 *   stops a ship's own modules that are not warp safe, and its targeted ones, at once.
 * - RepairLandings turns cycle events into repairs: shield boosters at cycle start, armor and hull repairers at cycle
 *   end, remote ones on their target scaled by effectiveness (damage.ts applies them).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { falloffEffectiveness, moduleReach, type DefenseLayerName, type ModuleActivation } from '@scene-director/scene';
import { IsCycleRunning, ModuleCycle, type ModuleCycleEvent, type ModuleCycleReport, type ModuleCycleRequest, type ModuleCycleState } from './module-cycle';

/**
 * What the layer needs from the world: distances, warp and the ships there are.
 */
export interface ShipModulesPort {
  /**
   * Metres, surface to surface on the EVE radii; null when either ship is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
  /**
   * Whether a ship is in proper warp.
   */
  InWarp(id: string): boolean;
  HasShip(id: string): boolean;
  /**
   * Seconds per Destiny tick.
   */
  readonly tickSeconds: number;
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
}

/**
 * A module event at a boundary, with its ship and, for a targeted module, its target.
 */
export interface ShipModuleEvent extends ModuleCycleEvent {
  readonly ship: string;
  readonly module: string;
  readonly target?: string;
  readonly effectiveness?: number;
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
 * A module's state in get_state (beside its key and name).
 */
export interface ShipModuleLiveState extends ModuleCycleReport {
  readonly target?: string;
  readonly targetDistance?: number;
  readonly effectiveness?: number;
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
  effectiveness: Maybe<number>;
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
        entry = { spec, cycle, target: null, effectiveness: null };
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
   * @returns The `off` events.
   */
  Remove(id: string, boundary: number): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [key, entry] of this.ships.get(id) ?? []) events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'removed')));
    this.ships.delete(id);
    events.push(...this.StopTargeting(id, boundary, 'its target is gone'));
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
        entry.target = options.target ?? entry.target;
        entry.effectiveness = this.Effectiveness(id, entry);
      }
      entry.cycle.Request(request, { boundary: options.boundary, delay: options.delay });
      if (!entry.cycle.engaged && !entry.cycle.running && entry.spec.activation.targeted) entry.target = null;
    }
    return refusal;
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
          const gone = !this.port.HasShip(entry.target) || this.port.InWarp(entry.target);
          const distance = gone ? null : this.port.SurfaceDistance(id, entry.target);
          if (gone || distance == null) {
            events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'its target is gone')));
          } else if (distance > moduleReach(entry.spec.activation)) {
            if (entry.cycle.state === 'activating') events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, 'its target is out of range')));
            else entry.cycle.StopAtCycleEnd(boundary, 'its target is out of range');
          }
          entry.effectiveness = this.Effectiveness(id, entry);
        }
        events.push(...this.Events(id, key, entry, entry.cycle.Boundary(boundary)));
        if (!entry.cycle.running && !entry.cycle.engaged) entry.target = null;
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
      ...(distance == null ? {} : { targetDistance: Math.round(distance) }),
      ...(entry.effectiveness == null ? {} : { effectiveness: Math.round(entry.effectiveness * 1000) / 1000 }),
      ...(!report.note && entry.spec.activation.note && entry.cycle.running ? { note: entry.spec.activation.note } : {})
    };
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
      const aim = target ?? (running ? entry.target : null);
      const distance = aim ? this.port.SurfaceDistance(id, aim) : null;
      const reach = moduleReach(activation);
      if (!aim) refusal = 'it needs a target: a ship id';
      else if (aim === id) refusal = 'it cannot target its own ship';
      else if (!this.port.HasShip(aim)) refusal = `no ship "${aim}" (a targeted module runs on a ship, not an object)`;
      else if (this.port.InWarp(aim)) refusal = `its target "${aim}" is in warp`;
      else if (running && entry.target && entry.target !== aim) refusal = `it is running on "${entry.target}"; switch it online first`;
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

  private Effectiveness(id: string, entry: ModuleEntry): Maybe<number> {
    const distance = entry.target ? this.port.SurfaceDistance(id, entry.target) : null;
    return distance == null ? null : falloffEffectiveness({ distance, range: entry.spec.activation.range, falloff: entry.spec.activation.falloff });
  }

  private StopTargeting(target: string, boundary: number, why: string): ShipModuleEvent[] {
    const events: ShipModuleEvent[] = [];
    for (const [id, modules] of this.ships) {
      for (const [key, entry] of modules) {
        if (entry.target !== target) continue;
        events.push(...this.Events(id, key, entry, entry.cycle.StopNow(boundary, why)));
        entry.target = null;
      }
    }
    return events;
  }

  private Events(ship: string, module: string, entry: ModuleEntry, events: readonly ModuleCycleEvent[]): ShipModuleEvent[] {
    return events.map((event) => ({ ...event, ship, module, ...(entry.target ? { target: entry.target } : {}), ...(entry.effectiveness == null ? {} : { effectiveness: entry.effectiveness }) }));
  }

  private Timing(spec: ShipModuleSpec): { readonly cycleTicks: number; readonly reactivationTicks: number } {
    const tick = this.port.tickSeconds;
    return { cycleTicks: spec.activation.cycleTime / tick, reactivationTicks: spec.activation.reactivationDelay / tick };
  }
}

/**
 * Whether a module state runs its effect.
 */
export function IsModuleRunning(state: Maybe<ModuleCycleState>): boolean {
  return state != null && IsCycleRunning(state);
}
