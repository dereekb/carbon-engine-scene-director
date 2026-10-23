/**
 * Logi auto-repair: a fleet's logi repair the members that are being shot, on their own. At each boundary, per fleet,
 * the logi (members whose resolved autoRepair is on, with an online remote repairer, not taken over by a manual
 * switch_modules, able to act) choose their targets together through chooseRepairTargets (logi/selection.ts in the
 * scene package), and the controller switches their remote repairers onto them:
 *
 * - `Switch(active, target, { retarget: true })`: a rep running on another target takes the new one at its next cycle
 *   start once locked, so its last cycle still lands on the old target. Reps that cannot reach the target stay off.
 * - A logi with no target, or turned off, switches the reps it owns online: they stop at their cycle end.
 * - A manual switch_modules on a logi's reps (Manual) takes it off auto-repair until auto_repair is called on its group
 *   (Rearm), its resolved settings change in the document, or a load (Clear).
 * - Each logi pre-locks up to REPAIR_PRE_LOCKS members (PreLocks): the director adds them to the wanted locks.
 *
 * The controller only ever touches the modules it switched on (owned). All state is plain data.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  type AutoRepairPolicy,
  type AutoRepairSource,
  chooseRepairTargets,
  DEFENSE_LAYERS,
  type DefenseLayerName,
  type RepairCandidate,
  type RepairChoice,
  type RepairLogi,
  type RepairModule,
  type RepairPlan,
  type RepairReason,
  type RepairUnreachable,
  repairChoiceWhy,
  type ResolvedAutoRepair,
  resolveAutoRepair,
  type SceneDocument,
  type ShipFleetMembership,
  toFleetMemberships
} from '@scene-director/scene';
import type { LockTargeting } from './locks';
import type { ModuleCycleState } from './module-cycle';
import type { RemoteRepairerState } from './modules';

/**
 * Whether a ship can repair or be repaired now: `ready`, or why not. `waiting` is a ship without its ball or whose fit
 * has not resolved yet.
 */
export type AutoRepairCondition = 'ready' | 'destroyed' | 'in-warp' | 'waiting';

export interface AutoRepairPort {
  readonly tickSeconds: number;
  /**
   * The live fleet view (LiveFleets().scene), or the document.
   */
  Scene(): Maybe<Pick<SceneDocument, 'ships' | 'fleets'>>;
  /**
   * `ready`: it has a ball and a resolved fit, is not destroyed (either death mode), not in warp or arriving.
   */
  Condition(id: string): AutoRepairCondition;
  Health(id: string): Maybe<Readonly<Record<DefenseLayerName, { readonly hp: number; readonly max: number }>>>;
  /**
   * HP it lost to shots over the last REPAIR_PRESSURE_SECONDS before the boundary.
   */
  Taken(id: string, boundary: number): number;
  /**
   * Ships locking or locked on it that are outside `friends` and not on `team`.
   */
  HostileLocks(id: string, friends: ReadonlySet<string>, team: Maybe<string>): number;
  SurfaceDistance(a: string, b: string): Maybe<number>;
  Targeting(id: string): Maybe<LockTargeting>;
  /**
   * The targets it holds a lock on, any state.
   */
  Locks(id: string): readonly string[];
  RemoteRepairers(id: string): readonly RemoteRepairerState[];
  /**
   * The remote repairers running on a ship: who, which module, and the HP/s they land with their effectiveness.
   */
  IncomingReps(id: string): readonly { readonly from: string; readonly module: string; readonly hps: number }[];
  /**
   * Switches one module (ShipModules.Switch at the current tick).
   *
   * @returns The refusal, or null.
   */
  Switch(id: string, key: string, request: 'active' | 'online', options?: { readonly target?: string; readonly retarget?: boolean }): Maybe<string>;
}

/**
 * A logi's auto-repair state in get_state, the first that applies.
 */
export const AUTO_REPAIR_STATES = ['destroyed', 'in-warp', 'waiting', 'no-repairers', 'off', 'manual', 'repairing', 'locking', 'out-of-range', 'idle'] as const;

export type AutoRepairState = (typeof AUTO_REPAIR_STATES)[number];

/**
 * One layer of a logi's auto-repair report.
 */
export interface AutoRepairLayerReport {
  readonly layer: DefenseLayerName;
  readonly target?: string;
  readonly reason?: RepairReason;
  readonly why: string;
  /**
   * Seconds on this target.
   */
  readonly since?: number;
  readonly modules?: { readonly module: string; readonly state: ModuleCycleState }[];
  /**
   * HP/s it lands on the target, after falloff.
   */
  readonly hps?: number;
  readonly unreachable?: RepairUnreachable[];
}

/**
 * A fleet member's `autoRepair` in get_state.
 */
export interface AutoRepairReport {
  readonly state: AutoRepairState;
  readonly on: boolean;
  readonly policy: AutoRepairPolicy;
  readonly source: AutoRepairSource;
  readonly policySource: AutoRepairSource;
  readonly target?: string;
  readonly reason?: RepairReason;
  readonly why: string;
  readonly since?: number;
  /**
   * Its main layer: the one it carries the most repair HP/s for.
   */
  readonly layer?: DefenseLayerName;
  readonly modules?: { readonly module: string; readonly state: ModuleCycleState }[];
  readonly hps?: number;
  readonly preLocks?: string[];
  readonly unreachable?: RepairUnreachable[];
  /**
   * A refused switch at its last pass.
   */
  readonly note?: string;
  /**
   * Its other layers, when it carries remote repairers for more than one.
   */
  readonly layers?: AutoRepairLayerReport[];
}

/**
 * A fleet's `autoRepair` in get_state: how many logi do what, and whom they hold up.
 */
export interface AutoRepairFleetReport {
  /**
   * Members auto-repairing: repairing, locking, idle or out of range.
   */
  readonly logi: number;
  readonly repairing: number;
  readonly locking: number;
  readonly idle: number;
  readonly outOfRange: number;
  readonly manual: number;
  readonly off: number;
  readonly targets: { readonly target: string; readonly logi: string[]; readonly hps: number }[];
}

interface LogiPass {
  readonly plan: RepairPlan;
  readonly modules: readonly RepairModule[];
  readonly note: Maybe<string>;
}

const ENGAGED_STATES = new Set<ModuleCycleState>(['activating', 'active']);

const RUNNING_STATES = new Set<ModuleCycleState>(['active', 'stopping']);

export class AutoRepair {
  private readonly port: AutoRepairPort;
  /**
   * The modules each ship's auto-repair switched on, with the target it last asked (null once it switched it online).
   */
  private readonly owned = new Map<string, Map<string, Maybe<string>>>();
  private readonly targets = new Map<string, Partial<Record<DefenseLayerName, { readonly target: string; readonly since: number }>>>();
  private readonly manual = new Set<string>();
  /**
   * Ships whose engaged reps the next sync adopts as owned (Rearm, a settings change).
   */
  private readonly adopt = new Set<string>();
  private readonly lastSettings = new Map<string, string>();
  private readonly preLocks = new Map<string, string[]>();
  private passes = new Map<string, LogiPass>();
  private settings = new Map<string, ResolvedAutoRepair>();
  private memberships = new Map<string, ShipFleetMembership>();

  constructor(input: { readonly port: AutoRepairPort }) {
    this.port = input.port;
  }

  /**
   * One pass: every fleet's logi choose their targets and their reps are switched onto them.
   *
   * @param boundary - The tick boundary.
   * @returns Whether it switched anything.
   */
  Sync(boundary: number): boolean {
    const scene = this.port.Scene();
    const settings = scene ? resolveAutoRepair(scene) : new Map<string, ResolvedAutoRepair>();
    this.memberships = scene ? toFleetMemberships(scene) : new Map();
    let switched = this.SyncSettings(settings);
    this.settings = settings;
    const repairers = new Map<string, RemoteRepairerState[]>();
    for (const id of settings.keys()) {
      const online = this.port.RemoteRepairers(id).filter((row) => row.state !== 'offline' && row.spec.activation.repair);
      if (online.length) repairers.set(id, online);
    }
    const passes = new Map<string, LogiPass>();
    if (scene && (repairers.size || this.owned.size)) {
      const teams = new Map(scene.ships.map((doc) => [doc.id, doc.team]));
      for (const fleet of scene.fleets ?? []) {
        const members = [...this.memberships].filter(([, membership]) => membership.fleet === fleet.id).map(([id]) => id);
        switched = this.SyncFleet({ boundary, members, repairers, teams, passes }) || switched;
      }
    }
    this.passes = passes;
    for (const id of [...this.preLocks.keys()]) if (!passes.has(id)) this.preLocks.delete(id);
    for (const id of [...this.targets.keys()]) if (!passes.has(id)) this.targets.delete(id);
    return switched;
  }

  /**
   * The pre-locks by logi, for the wanted locks.
   */
  PreLocks(): ReadonlyMap<string, readonly string[]> {
    return this.preLocks;
  }

  /**
   * A manual switch_modules on a ship's remote repairers: auto-repair lets go of them (without switching) and leaves
   * the ship alone until it is re-armed.
   *
   * @param ship - The ship id.
   */
  Manual(ship: string): void {
    this.owned.delete(ship);
    this.targets.delete(ship);
    this.preLocks.delete(ship);
    this.adopt.delete(ship);
    this.passes.delete(ship);
    this.manual.add(ship);
  }

  /**
   * Hands ships back to auto-repair (auto_repair on their group): the next sync adopts their engaged reps.
   *
   * @param ships - The ship ids.
   */
  Rearm(ships: readonly string[]): void {
    for (const ship of ships) {
      if (this.manual.delete(ship)) this.adopt.add(ship);
    }
  }

  /**
   * Whether auto-repair runs a ship's remote repairers: its resolved setting is on, it fits one, and no manual switch
   * took it over.
   *
   * @param ship - The ship id.
   */
  IsAuto(ship: string): boolean {
    const scene = this.port.Scene();
    const resolved = scene ? resolveAutoRepair(scene).get(ship) : null;
    return resolved?.on === true && !this.manual.has(ship) && this.port.RemoteRepairers(ship).length > 0;
  }

  /**
   * A fleet member's `autoRepair` for get_state.
   *
   * @param ship - The ship id.
   * @param tick - The tick now, for `since`.
   * @returns It, for a member with remote repairers or with auto-repair on; else null.
   */
  Report(ship: string, tick: number): Maybe<AutoRepairReport> {
    const resolved = this.settings.get(ship);
    const repairers = resolved ? this.port.RemoteRepairers(ship) : [];
    if (!resolved || (!resolved.on && !repairers.length)) return null;
    const settings = { on: resolved.on, policy: resolved.policy, source: resolved.source, policySource: resolved.policySource };
    const condition = this.port.Condition(ship);
    const online = repairers.filter((row) => row.state !== 'offline');
    const pass = this.passes.get(ship);
    let report: AutoRepairReport;
    if (condition === 'destroyed') report = { state: 'destroyed', ...settings, why: 'it was destroyed' };
    else if (condition === 'in-warp') report = { state: 'in-warp', ...settings, why: 'it is in warp' };
    else if (condition === 'waiting') report = { state: 'waiting', ...settings, why: 'its fit has not resolved yet' };
    else if (resolved.on && !online.length) report = { state: 'no-repairers', ...settings, why: repairers.length ? 'its remote repairers are offline' : 'it fits no remote repairer' };
    else if (!resolved.on) report = { state: 'off', ...settings, why: OffWhy(resolved.source) };
    else if (this.manual.has(ship)) report = { state: 'manual', ...settings, why: 'switch_modules took its remote repairers off auto-repair; auto_repair on its group hands them back' };
    else if (!pass?.plan.choices.length) report = { state: 'idle', ...settings, why: 'no fleet member in reach needs reps' };
    else {
      const layers = this.LayerReports(ship, pass, resolved.policy, repairers, tick);
      const [main, ...rest] = layers;
      const { layer: _layer, ...flat } = main;
      report = {
        state: this.LayerState(main, repairers),
        ...settings,
        ...flat,
        layer: main.layer,
        ...(this.preLocks.get(ship)?.length ? { preLocks: [...(this.preLocks.get(ship) ?? [])] } : {}),
        ...(pass.note ? { note: pass.note } : {}),
        ...(rest.length ? { layers: rest } : {})
      };
    }
    return report;
  }

  /**
   * A fleet's `autoRepair` for get_state.
   *
   * @param fleet - The fleet id.
   * @param tick - The tick now.
   * @returns Its counts and targets; null for a fleet with no remote repairers.
   */
  FleetReport(fleet: string, tick: number): Maybe<AutoRepairFleetReport> {
    const members = [...this.memberships].filter(([, membership]) => membership.fleet === fleet).map(([id]) => id);
    const reports = members.flatMap((id) => {
      const report = this.port.RemoteRepairers(id).length ? this.Report(id, tick) : null;
      return report ? [{ id, report }] : [];
    });
    if (!reports.length) return null;
    const count = (...states: AutoRepairState[]): number => reports.filter(({ report }) => states.includes(report.state)).length;
    const targets = new Map<string, { target: string; logi: string[]; hps: number }>();
    for (const { id, report } of reports) {
      for (const layer of [report, ...(report.layers ?? [])]) {
        if (!layer.target || (report.state !== 'repairing' && report.state !== 'locking')) continue;
        const row = targets.get(layer.target) ?? { target: layer.target, logi: [], hps: 0 };
        if (!row.logi.includes(id)) row.logi.push(id);
        row.hps = Round(row.hps + (layer.hps ?? 0));
        targets.set(layer.target, row);
      }
    }
    return {
      logi: count('repairing', 'locking', 'idle', 'out-of-range'),
      repairing: count('repairing'),
      locking: count('locking'),
      idle: count('idle'),
      outOfRange: count('out-of-range'),
      manual: count('manual'),
      off: count('off'),
      targets: [...targets.values()]
    };
  }

  /**
   * A removed or destroyed ship: its modules are gone with it, so nothing is switched.
   *
   * @param ship - The ship id.
   */
  Forget(ship: string): void {
    this.owned.delete(ship);
    this.targets.delete(ship);
    this.manual.delete(ship);
    this.adopt.delete(ship);
    this.lastSettings.delete(ship);
    this.preLocks.delete(ship);
    this.passes.delete(ship);
    for (const pass of this.targets.values()) for (const layer of DEFENSE_LAYERS) if (pass[layer]?.target === ship) delete pass[layer];
  }

  /**
   * A load: everything is forgotten.
   */
  Clear(): void {
    this.owned.clear();
    this.targets.clear();
    this.manual.clear();
    this.adopt.clear();
    this.lastSettings.clear();
    this.preLocks.clear();
    this.passes.clear();
    this.settings.clear();
    this.memberships.clear();
  }

  /**
   * Settings changes re-arm a manual ship; ships that left every fleet are let go of (their owned reps switched
   * online).
   */
  private SyncSettings(settings: ReadonlyMap<string, ResolvedAutoRepair>): boolean {
    let switched = false;
    for (const [id, resolved] of settings) {
      const key = JSON.stringify(resolved);
      const last = this.lastSettings.get(id);
      if (last != null && last !== key && this.manual.delete(id)) this.adopt.add(id);
      this.lastSettings.set(id, key);
    }
    for (const id of [...this.lastSettings.keys()]) {
      if (settings.has(id)) continue;
      switched = this.Release(id, true) || switched;
      this.Forget(id);
    }
    return switched;
  }

  private SyncFleet(input: { readonly boundary: number; readonly members: readonly string[]; readonly repairers: ReadonlyMap<string, RemoteRepairerState[]>; readonly teams: ReadonlyMap<string, Maybe<string>>; readonly passes: Map<string, LogiPass> }): boolean {
    const { boundary, members, repairers, teams, passes } = input;
    let switched = false;
    const logi: string[] = [];
    for (const id of members) {
      const resolved = this.settings.get(id);
      const isLogi = resolved?.on === true && repairers.has(id) && !this.manual.has(id) && this.port.Condition(id) === 'ready';
      if (isLogi) logi.push(id);
      else if (this.owned.has(id)) {
        // Off: its reps stop at their cycle end. Manual: the user's switch already acted. Can't act: they stopped.
        switched = this.Release(id, resolved?.on !== true && !this.manual.has(id)) || switched;
        this.targets.delete(id);
      }
    }
    if (!logi.length) return switched;
    for (const id of logi) if (this.adopt.delete(id)) this.Adopt(id, repairers.get(id) ?? []);
    const friends = new Set(members);
    const candidates: RepairCandidate[] = [];
    for (const id of members) {
      const layers = this.port.Condition(id) === 'ready' ? this.port.Health(id) : null;
      if (!layers) continue;
      const otherReps = this.port.IncomingReps(id).reduce((sum, row) => (this.owned.get(row.from)?.has(row.module) ? sum : sum + row.hps), 0);
      candidates.push({ id, layers, taken: this.port.Taken(id, boundary), hostileLocks: this.port.HostileLocks(id, friends, teams.get(id)), otherReps });
    }
    const inputs: RepairLogi[] = logi.map((id) => {
      const distances = new Map<string, number>();
      for (const candidate of candidates) {
        const distance = candidate.id === id ? null : this.port.SurfaceDistance(id, candidate.id);
        if (distance != null) distances.set(candidate.id, distance);
      }
      const current: Partial<Record<DefenseLayerName, string>> = {};
      for (const layer of DEFENSE_LAYERS) {
        const target = this.targets.get(id)?.[layer]?.target;
        if (target) current[layer] = target;
      }
      return {
        id,
        policy: this.settings.get(id)?.policy ?? 'urgent',
        modules: (repairers.get(id) ?? []).map(RepairModuleOf),
        lockRange: this.port.Targeting(id)?.maxTargetRange ?? Infinity,
        distances,
        current,
        locks: new Set(this.port.Locks(id))
      };
    });
    for (const plan of chooseRepairTargets({ candidates, logi: inputs })) {
      const modules = inputs.find((row) => row.id === plan.logi)?.modules ?? [];
      const applied = this.ApplyPlan(plan, repairers.get(plan.logi) ?? [], boundary);
      switched = applied.switched || switched;
      this.preLocks.set(plan.logi, plan.preLocks);
      passes.set(plan.logi, { plan, modules, note: applied.note });
    }
    return switched;
  }

  /**
   * Switches a logi's reps onto its plan's targets, and the ones it owns but no longer needs online.
   */
  private ApplyPlan(plan: RepairPlan, repairers: readonly RemoteRepairerState[], boundary: number): { switched: boolean; note: Maybe<string> } {
    const id = plan.logi;
    const owned = this.owned.get(id) ?? new Map<string, Maybe<string>>();
    const targets = { ...this.targets.get(id) };
    const wanted = new Set<string>();
    const notes: string[] = [];
    let switched = false;
    for (const choice of plan.choices) {
      const layerKeys = repairers.filter((row) => row.spec.activation.repair?.layer === choice.layer).map((row) => row.key);
      const target = choice.target;
      if (target) {
        for (const key of choice.modules) {
          wanted.add(key);
          const row = repairers.find((candidate) => candidate.key === key);
          if (!row || IsOnTarget(row, target, owned.get(key))) continue;
          const refusal = this.port.Switch(id, key, 'active', { target, retarget: true });
          if (refusal) notes.push(`${key}: ${refusal}`);
          else {
            owned.set(key, target);
            switched = true;
          }
        }
        if (targets[choice.layer]?.target !== target) targets[choice.layer] = { target, since: boundary };
      } else {
        delete targets[choice.layer];
      }
      const stop = target ? choice.idle : layerKeys;
      for (const key of stop) switched = this.StopOwned(id, owned, key, repairers) || switched;
    }
    for (const [key] of owned) {
      const row = repairers.find((candidate) => candidate.key === key);
      if (!wanted.has(key) && (!row || !(ENGAGED_STATES.has(row.state) || RUNNING_STATES.has(row.state)))) owned.delete(key);
    }
    if (owned.size) this.owned.set(id, owned);
    else this.owned.delete(id);
    this.targets.set(id, targets);
    return { switched, note: notes.length ? notes.join('; ') : null };
  }

  /**
   * Switches an owned, engaged module online: it stops at its cycle end.
   */
  private StopOwned(id: string, owned: Map<string, Maybe<string>>, key: string, repairers: readonly RemoteRepairerState[]): boolean {
    const row = repairers.find((candidate) => candidate.key === key);
    let switched = false;
    if (owned.has(key) && row && (ENGAGED_STATES.has(row.state) || (row.state === 'reactivating' && owned.get(key) != null))) {
      switched = this.port.Switch(id, key, 'online') == null;
      owned.set(key, null);
    }
    return switched;
  }

  /**
   * Lets go of a ship's owned modules, switching the engaged ones online when `stop`.
   */
  private Release(id: string, stop: boolean): boolean {
    const owned = this.owned.get(id);
    let switched = false;
    if (owned && stop) {
      const repairers = this.port.RemoteRepairers(id);
      for (const key of owned.keys()) switched = this.StopOwned(id, owned, key, repairers) || switched;
    }
    this.owned.delete(id);
    this.preLocks.delete(id);
    return switched;
  }

  /**
   * A re-armed logi takes its engaged reps as its own, and their targets as its incumbents.
   */
  private Adopt(id: string, repairers: readonly RemoteRepairerState[]): void {
    const owned = this.owned.get(id) ?? new Map<string, Maybe<string>>();
    const targets = { ...this.targets.get(id) };
    for (const row of repairers) {
      const target = row.retarget ?? row.target;
      const layer = row.spec.activation.repair?.layer;
      if (!target || !layer || !(ENGAGED_STATES.has(row.state) || row.state === 'stopping')) continue;
      owned.set(row.key, target);
      targets[layer] ??= { target, since: 0 };
    }
    if (owned.size) this.owned.set(id, owned);
    this.targets.set(id, targets);
  }

  private LayerReports(ship: string, pass: LogiPass, policy: AutoRepairPolicy, repairers: readonly RemoteRepairerState[], tick: number): AutoRepairLayerReport[] {
    const nominal = (layer: DefenseLayerName): number => pass.modules.filter((module) => module.layer === layer).reduce((sum, module) => sum + module.amount / module.cycleTime, 0);
    const choices = [...pass.plan.choices].sort((a, b) => nominal(b.layer) - nominal(a.layer));
    return choices.map((choice) => this.LayerReport(ship, choice, policy, repairers, tick));
  }

  private LayerReport(ship: string, choice: RepairChoice, policy: AutoRepairPolicy, repairers: readonly RemoteRepairerState[], tick: number): AutoRepairLayerReport {
    const since = this.targets.get(ship)?.[choice.layer]?.since;
    const modules = choice.modules.flatMap((key) => {
      const row = repairers.find((candidate) => candidate.key === key);
      return row ? [{ module: key, state: row.state }] : [];
    });
    return {
      layer: choice.layer,
      ...(choice.target ? { target: choice.target } : {}),
      reason: choice.reason,
      why: repairChoiceWhy(choice, policy),
      ...(choice.target && since != null ? { since: Round(Math.max(0, tick - since) * this.port.tickSeconds) } : {}),
      ...(modules.length ? { modules } : {}),
      ...(choice.target ? { hps: Round(choice.hps) } : {}),
      ...(choice.unreachable?.length ? { unreachable: choice.unreachable } : {})
    };
  }

  private LayerState(layer: AutoRepairLayerReport, repairers: readonly RemoteRepairerState[]): AutoRepairState {
    let state: AutoRepairState = layer.reason === 'out-of-range' ? 'out-of-range' : 'idle';
    if (layer.target) {
      const running = (layer.modules ?? []).some(({ module }) => {
        const row = repairers.find((candidate) => candidate.key === module);
        return row != null && RUNNING_STATES.has(row.state) && row.target === layer.target;
      });
      state = running ? 'repairing' : 'locking';
    }
    return state;
  }
}

/**
 * A remote repairer as the selection sees it.
 */
function RepairModuleOf(row: RemoteRepairerState): RepairModule {
  const { activation } = row.spec;
  return { key: row.key, layer: activation.repair?.layer ?? 'armor', amount: activation.repair?.amount ?? 0, cycleTime: activation.cycleTime, range: activation.range, falloff: activation.falloff };
}

/**
 * Whether a rep already runs (or is about to run) on the target: nothing to switch.
 */
function IsOnTarget(row: RemoteRepairerState, target: string, asked: Maybe<string>): boolean {
  const aim = row.retarget ?? row.target;
  return aim === target && (ENGAGED_STATES.has(row.state) || (row.state === 'reactivating' && asked === target));
}

function OffWhy(source: AutoRepairSource): string {
  return source === 'default' ? 'auto-repair is off by default outside logi squads; auto_repair on: true turns it on' : `auto-repair is off on its ${source}`;
}

function Round(value: number): number {
  return Math.round(value * 10) / 10;
}
