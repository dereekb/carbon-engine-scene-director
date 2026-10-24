/**
 * Pilots that fly their stances (sd-piloting): at each boundary, every ship whose live stance it flies itself (the
 * leader of an in-line group stance, the FC for a fleet's; every loose member; a ship with its own stance; a free ship
 * with one) steps stepShipPilot over its picture and runs the calls it makes, as a model would make them.
 *
 * - **Response**: a stance that changes through a live order_fleet stance order is taken up after the pilot's
 *   response (the order's tick + its delay, StanceDue); until then the ship keeps flying its previous stance (or stays
 *   in line). A ship's own (order_ship) applies at once.
 * - **Formation**: ships that fly their own or a loose stance leave the formation while they do (Formation's
 *   `piloted`, FleetFollowing skips them); an in-line wing or squad stance flies apart on its leader (BreakAway) and
 *   regroups when it ends. No stance anywhere: nothing changes.
 * - **Gate**: a pilot waits while its numbers are unsettled, it is in warp or arriving, or its profile is pending.
 * - **The picture**: from the facts port (Director.BrainFacts) through toPilotContact; hostiles and friends by team
 *   (overviewRelationOf) within FLEET_AWARENESS_RANGE; the focus is its own target, else its group's called target,
 *   else the nearest hostile; the anchor is the stance's `on` ship.
 * - **Calls**: order_ship through Order, switch_prop_mods through SwitchPropMod (the port adds the pilot's reaction
 *   delay; a repeat of the same switch within PILOT_PROP_MOD_REPEAT_TICKS is dropped), and the ship's point, scram and
 *   web on its focus while it is in their range, as owned modules: the pilot only ever switches off what it switched
 *   on (AutoRepair's rule).
 * - **Refresh**: stepShipPilot recomputes the ideal every PILOT_REFRESH_TICKS from its first step; the first ideal's
 *   time is set back by a hash of the ship's id so a fleet's pilots do not all refresh at the same boundary.
 * - **Manual**: a model's order_ship, switch_prop_mods or switch_modules on a piloted ship (and a ship script's steps)
 *   hold its pilot (`manual`) until a stance order names it or it rejoins (Release).
 *
 * All state is plain data. Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  FLEET_AWARENESS_RANGE,
  type FleetGroup,
  type FleetShipFacts,
  overviewRelationOf,
  type PilotContact,
  PILOT_REFRESH_TICKS,
  type ResolvedShipStance,
  type SceneVector,
  type ShipOrder,
  type ShipPilotCall,
  type ShipPilotMemory,
  type ShipPilotPicture,
  type ShipPilotState,
  type ShipStanceTo,
  stepShipPilot,
  surfaceDistanceOf,
  toFleetGroupKey,
  toPilotContact,
  unitHash
} from '@scene-director/scene';
import type { FleetGroupApart } from './following';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

/**
 * Decisions a pilot keeps for get_state.
 */
export const PILOT_DECISIONS_KEPT = 6;

/**
 * Ticks a repeated prop mod switch (the same way) is dropped for: the switch is queued behind the pilot's reaction, or
 * the module runs out its cycle.
 */
export const PILOT_PROP_MOD_REPEAT_TICKS = 10;

/**
 * Tackle the pilot runs on its focus.
 */
export type PilotTackleKind = 'point' | 'scram' | 'web';

/**
 * A point, scram or web the ship fits.
 */
export interface PilotTackleModule {
  readonly key: string;
  readonly kind: PilotTackleKind;
  /**
   * Activation range (m), surface to surface.
   */
  readonly range: number;
  /**
   * Whether it runs (activating or active) and on what.
   */
  readonly running: boolean;
  readonly target?: Maybe<string>;
}

/**
 * The page's side of the pilots: what they read and how their calls run.
 */
export interface ShipPilotsPort {
  readonly tickSeconds: number;
  /**
   * Every ship's live stance (Director.ResolvedStances).
   */
  Stances(): ReadonlyMap<string, ResolvedShipStance>;
  /**
   * The tick the ship takes up the latest live stance order that named it (its tick + the pilot's delay); null when
   * none named it.
   */
  StanceDue(id: string): Maybe<number>;
  /**
   * Every live ship (Director.BrainFacts).
   */
  Facts(): readonly FleetShipFacts[];
  /**
   * Whether a ship's numbers and fit have settled.
   */
  Settled(id: string): boolean;
  /**
   * A ship's order: its pending one, else the applied one.
   */
  OrderOf(id: string): Maybe<ShipOrder>;
  /**
   * The target its group calls for it (FleetTargets.CallOf).
   */
  CalledOf(id: string): Maybe<string>;
  /**
   * Hostiles that hit it lately and the scene second each last did.
   */
  AttackedBy(id: string, boundary: number): readonly { readonly id: string; readonly at: number }[];
  /**
   * Gives an order_ship order.
   *
   * @throws {Error} When the world refuses it.
   */
  Order(id: string, order: ShipOrder): void;
  /**
   * Switches the ship's prop mod after its reaction.
   *
   * @returns Ticks until it takes the switch.
   * @throws {Error} When it cannot.
   */
  SwitchPropMod(id: string, active: boolean, boundary: number): number;
  /**
   * Its point, scram and web.
   */
  Tackle(id: string): readonly PilotTackleModule[];
  /**
   * Runs a tackle module on a target, or stops it at its cycle end.
   *
   * @returns The refusal, or null.
   */
  SwitchTackle(id: string, key: string, active: boolean, target?: string): Maybe<string>;
  /**
   * Who leaves the formation (piloted) and the groups flying apart on their leaders; `regroup` lists the ships of
   * groups apart whose stance ended.
   */
  Formation(input: PilotFormation): void;
  /**
   * An align stance's `to` (a ship, object or celestial target id, or a place name) as a point, measured from the
   * ship; null when nothing matches (the pilot aligns away from the hostiles).
   */
  AlignPoint?(to: string, from: string): Maybe<SceneVector>;
}

export interface PilotFormation {
  readonly piloted: ReadonlySet<string>;
  /**
   * Every group a stance flies apart on its leader now (the page breaks away the ones not apart that way yet).
   */
  readonly apart: readonly FleetGroupApart[];
  readonly regroup: readonly string[];
}

/**
 * One call a pilot made, for get_state.
 */
export interface ShipPilotDecision {
  readonly tick: number;
  readonly tool: ShipPilotCall['tool'] | 'switch_modules';
  readonly args: object;
  readonly why: string;
  readonly refused?: string;
}

/**
 * A ship's stance for get_state's ships[].stance.
 */
export interface ShipStanceReport extends ResolvedShipStance {
  /**
   * in-line for a ship its group's leader flies (or with no stance), manual while a model holds its pilot.
   */
  readonly state: ShipPilotState;
  readonly focus?: Maybe<string>;
  readonly window?: readonly [number, number];
  readonly ideal?: number;
  readonly why?: string;
  /**
   * A live stance the pilot has yet to take up.
   */
  readonly pending?: { readonly type: string; readonly flownBy: Maybe<string>; readonly at: number; readonly in: number };
  readonly decisions?: readonly ShipPilotDecision[];
}

interface PilotRecord {
  /**
   * The stance it flies (or holds formation on) now.
   */
  stance: ResolvedShipStance;
  pending: Maybe<{ readonly stance: ResolvedShipStance; readonly at: number }>;
  memory: Maybe<ShipPilotMemory>;
  manual: boolean;
  state: ShipPilotState;
  why: string;
  focus: Maybe<string>;
  decisions: ShipPilotDecision[];
  propMod: Maybe<{ readonly active: boolean; readonly at: number }>;
  /**
   * Tackle module key → the target it switched it on for.
   */
  owned: Map<string, string>;
}

const PILOTS_CAPTURE: CaptureOptions = { wiring: ['port'] };

function stanceKey(stance: ResolvedShipStance): string {
  return JSON.stringify(stance);
}

/**
 * Whether the ship flies its stance on its own (its own, a role default, a loose formation, or a free ship's), as
 * against leading its group in line.
 *
 * @param id - The ship.
 * @param stance - Its stance.
 * @returns True when it leaves the formation to fly it.
 */
export function fliesAlone(id: string, stance: ResolvedShipStance): boolean {
  return stance.type !== 'in-line' && stance.flownBy === id && (stance.formation === 'loose' || stance.sources.type === 'ship' || stance.sources.type === 'role' || !stance.group);
}

/**
 * The page's pilots.
 */
export class ShipPilots {
  private readonly port: ShipPilotsPort;
  private readonly pilots = new Map<string, PilotRecord>();
  /**
   * Groups apart by stance, by group key.
   */
  private readonly apart = new Map<string, FleetGroupApart>();

  constructor(input: { readonly port: ShipPilotsPort }) {
    this.port = input.port;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, PILOTS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, PILOTS_CAPTURE, memo);
  }

  /**
   * Forgets every pilot (a load).
   */
  Clear(): void {
    this.pilots.clear();
    this.apart.clear();
  }

  /**
   * A ship left the scene.
   */
  Forget(id: string): void {
    this.pilots.delete(id);
  }

  /**
   * Whether a ship flies a stance itself now (and no model holds it): the FC brain gives up its move and prop mods
   * levers to it.
   *
   * @param id - The ship.
   * @returns True while its pilot flies.
   */
  Flies(id: string): boolean {
    const record = this.pilots.get(id);
    return Boolean(record && !record.manual && record.stance.pilot && record.stance.flownBy === id);
  }

  /**
   * A model's call on a ship takes its pilot over until a stance order or a rejoin (Release).
   *
   * @param ids - The ships it named.
   */
  Manual(ids: Iterable<string>): void {
    for (const id of ids) {
      const record = this.pilots.get(id);
      if (record?.stance.pilot && !record.manual) {
        record.manual = true;
        record.state = 'manual';
        record.why = 'a model took the ship over; a stance order or rejoin hands it back';
      }
    }
  }

  /**
   * Hands ships back to their pilots (a stance order naming them, a rejoin).
   *
   * @param ids - The ships.
   */
  Release(ids: Iterable<string>): void {
    for (const id of ids) {
      const record = this.pilots.get(id);
      if (record) record.manual = false;
    }
  }

  /**
   * The pilots' boundary: the stances they take up, the formation, then each pilot's step.
   *
   * @param boundary - The master tick.
   */
  Step(boundary: number): void {
    const port = this.port;
    this.TakeUp(port.Stances(), boundary);
    this.SyncFormation();
    let facts: Maybe<Map<string, FleetShipFacts>> = null;
    for (const [id, record] of this.pilots) {
      if (!record.stance.pilot || record.stance.flownBy !== id) {
        record.state = 'in-line';
        record.why = record.stance.flownBy ? `holds formation on ${record.stance.flownBy}` : 'in line';
        continue;
      }
      if (record.manual) continue;
      facts ??= new Map(port.Facts().map((ship) => [ship.id, ship]));
      this.StepPilot(id, record, facts, boundary);
    }
  }

  /**
   * A ship's stance for get_state.
   *
   * @param id - The ship.
   * @param resolved - Its resolved live stance.
   * @param boundary - The master tick.
   * @returns The report.
   */
  Report(id: string, resolved: ResolvedShipStance, boundary: number): ShipStanceReport {
    const record = this.pilots.get(id);
    const memory = record?.memory;
    const ideal = memory?.ideal;
    const pending = record?.pending;
    return {
      ...resolved,
      state: record?.state ?? 'in-line',
      ...(record?.focus ? { focus: record.focus } : {}),
      ...(ideal && record?.stance.pilot ? { window: [Math.round(ideal.window[0]), Math.round(ideal.window[1])] as const, ideal: Math.round(ideal.ideal) } : {}),
      ...(record?.why ? { why: record.why } : {}),
      ...(pending ? { pending: { type: pending.stance.type, flownBy: pending.stance.flownBy, at: pending.at, in: Math.max(0, pending.at - boundary) } } : {}),
      ...(record?.decisions.length ? { decisions: [...record.decisions] } : {})
    };
  }

  /**
   * Whether the ship has a pilot record (a stance flies it, or it holds formation on a group stance's leader).
   */
  Has(id: string): boolean {
    return this.pilots.has(id);
  }

  /**
   * Each ship takes up its live stance, after its response to a live stance order.
   *
   * @param stances - The live stances.
   * @param boundary - The master tick.
   */
  private TakeUp(stances: ReadonlyMap<string, ResolvedShipStance>, boundary: number): void {
    for (const id of [...this.pilots.keys()]) if (!stances.has(id)) this.Drop(id);
    for (const [id, stance] of stances) {
      const record = this.pilots.get(id);
      const current = record?.pending?.stance ?? record?.stance;
      const due = this.port.StanceDue(id);
      const waits = due != null && due > boundary;
      if (current && stanceKey(current) === stanceKey(stance)) {
        if (record?.pending && !waits) this.Fly(id, record.pending.stance);
        continue;
      }
      if (!record && stance.type === 'in-line') continue;
      // Back to what it flies before taking the pending one up: the pending one is dropped.
      if (record && stanceKey(record.stance) === stanceKey(stance)) {
        record.pending = null;
        continue;
      }
      if (waits) {
        if (record) record.pending = { stance, at: due };
        else {
          const { pilot: _pilot, group: _group, ...rest } = stance;
          this.pilots.set(id, this.NewRecord({ ...rest, type: 'in-line', flownBy: null }, { stance, at: due }));
        }
      } else this.Fly(id, stance);
    }
  }

  private NewRecord(stance: ResolvedShipStance, pending: PilotRecord['pending'] = null): PilotRecord {
    return { stance, pending, memory: null, manual: false, state: 'in-line', why: '', focus: null, decisions: [], propMod: null, owned: new Map() };
  }

  /**
   * The ship flies a stance now: a new one starts its pilot's memory afresh.
   */
  private Fly(id: string, stance: ResolvedShipStance): void {
    const record = this.pilots.get(id);
    if (stance.type === 'in-line' && !stance.flownBy) {
      this.Drop(id);
      return;
    }
    if (!record) {
      this.pilots.set(id, this.NewRecord(stance));
      return;
    }
    record.stance = stance;
    record.pending = null;
    record.memory = null;
    record.manual = false;
    if (!stance.pilot) this.StopTackle(id, record);
  }

  /**
   * The ship no longer flies or follows a stance: its owned tackle stops.
   */
  private Drop(id: string): void {
    const record = this.pilots.get(id);
    if (record) this.StopTackle(id, record);
    this.pilots.delete(id);
  }

  /**
   * The formation from the stances flown now: piloted ships out of it, in-line wing and squad stances apart on their
   * leaders, groups whose stance ended regrouped.
   */
  private SyncFormation(): void {
    const piloted = new Set<string>();
    const groups = new Map<string, { group: FleetGroup; leader: string; ships: string[] }>();
    for (const [id, record] of this.pilots) {
      const { stance } = record;
      if (fliesAlone(id, stance)) piloted.add(id);
      else if (stance.group && stance.group.kind !== 'fleet' && stance.flownBy) {
        const key = toFleetGroupKey(stance.group);
        const entry = groups.get(key) ?? { group: stance.group, leader: stance.flownBy, ships: [] };
        entry.ships.push(id);
        groups.set(key, entry);
      }
    }
    const apart: FleetGroupApart[] = [];
    for (const [key, entry] of groups) {
      if (!entry.ships.includes(entry.leader)) continue;
      const wanted: FleetGroupApart = { key, group: entry.group, leader: entry.leader, ships: entry.ships };
      apart.push(wanted);
      this.apart.set(key, wanted);
    }
    const regroup: string[] = [];
    for (const [key, before] of [...this.apart]) {
      if (groups.has(key) && groups.get(key)?.ships.includes(before.leader)) continue;
      regroup.push(...before.ships);
      this.apart.delete(key);
    }
    this.port.Formation({ piloted, apart, regroup });
  }

  /**
   * One pilot's step: the gate, its picture, stepShipPilot, its calls and its tackle.
   */
  private StepPilot(id: string, record: PilotRecord, facts: ReadonlyMap<string, FleetShipFacts>, boundary: number): void {
    const port = this.port;
    const stance = record.stance.pilot;
    const selfFacts = facts.get(id);
    if (!stance || !selfFacts) return;
    const self = toPilotContact(selfFacts);
    if (selfFacts.away || !port.Settled(id) || !self) {
      record.state = 'waiting';
      record.why = selfFacts.away ? 'away: in warp, arriving or destroyed' : 'its numbers have not settled';
      return;
    }
    const picture = this.PictureOf({ id, self, selfFacts, facts, boundary, on: stance.on ?? null, to: stance.type === 'align' ? (stance.to ?? null) : null });
    const refreshTicks = PILOT_REFRESH_TICKS * port.tickSeconds;
    const step = stepShipPilot({ picture, stance, memory: record.memory, refreshTicks });
    let memory = step.memory;
    // The first ideal's time goes back by the ship's share of the refresh, so a fleet's pilots refresh staggered.
    if (!record.memory?.ideal && memory.ideal && memory.idealAt === picture.now) memory = { ...memory, idealAt: picture.now - Math.floor(unitHash(`pilot|${id}`) * refreshTicks) };
    record.memory = memory;
    record.state = step.state;
    record.why = step.why;
    record.focus = picture.focus?.id ?? null;
    for (const call of step.calls) this.Run(id, record, call, boundary);
    this.SyncTackle(id, record, picture, boundary);
  }

  private PictureOf(input: { readonly id: string; readonly self: PilotContact; readonly selfFacts: FleetShipFacts; readonly facts: ReadonlyMap<string, FleetShipFacts>; readonly boundary: number; readonly on: Maybe<string>; readonly to: Maybe<ShipStanceTo> }): ShipPilotPicture {
    const { id, self, selfFacts, facts, boundary, on, to } = input;
    const port = this.port;
    const hostiles: PilotContact[] = [];
    const friends: PilotContact[] = [];
    let anchor: Maybe<PilotContact> = null;
    for (const other of facts.values()) {
      if (other.id === id || other.away) continue;
      const contact = toPilotContact(other);
      if (!contact) continue;
      if (other.id === on) anchor = contact;
      if (surfaceDistanceOf(self, contact) > FLEET_AWARENESS_RANGE) continue;
      const relation = overviewRelationOf(selfFacts, other);
      if (relation === 'hostile') hostiles.push(contact);
      else if (relation === 'friendly') friends.push(contact);
    }
    const byId = (target: Maybe<string>): Maybe<PilotContact> => (target ? (hostiles.find((hostile) => hostile.id === target) ?? null) : null);
    const nearest = [...hostiles].sort((a, b) => surfaceDistanceOf(self, a) - surfaceDistanceOf(self, b))[0] ?? null;
    const focus = byId(selfFacts.target) ?? byId(port.CalledOf(id)) ?? nearest;
    const seconds = port.tickSeconds;
    let alignTo: Maybe<SceneVector> = null;
    if (Array.isArray(to)) alignTo = to as SceneVector;
    else if (typeof to === 'string') alignTo = facts.get(to)?.position ?? port.AlignPoint?.(to, id) ?? null;
    return {
      self: { ...self, health: selfFacts.health, order: port.OrderOf(id) },
      focus,
      anchor,
      ...(to != null ? { alignTo } : {}),
      hostiles,
      friends,
      incomingReps: selfFacts.incomingReps ?? 0,
      attackedBy: port.AttackedBy(id, boundary),
      now: boundary * seconds
    };
  }

  private Run(id: string, record: PilotRecord, call: ShipPilotCall, boundary: number): void {
    let refused: Maybe<string> = null;
    if (call.tool === 'order_ship') {
      try {
        this.port.Order(id, call.args.order);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    } else {
      const active = call.args.active;
      if (record.propMod?.active === active && boundary < record.propMod.at) return;
      try {
        const respondsIn = this.port.SwitchPropMod(id, active, boundary);
        record.propMod = { active, at: boundary + respondsIn + PILOT_PROP_MOD_REPEAT_TICKS };
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    }
    this.Decided(record, { tick: boundary, tool: call.tool, args: call.args, why: call.why, ...(refused ? { refused } : {}) });
  }

  private Decided(record: PilotRecord, decision: ShipPilotDecision): void {
    record.decisions.push(decision);
    if (record.decisions.length > PILOT_DECISIONS_KEPT) record.decisions.splice(0, record.decisions.length - PILOT_DECISIONS_KEPT);
  }

  /**
   * The ship's point, scram and web on its focus while it fights in their range; off (only those it switched on) when
   * the focus changes, leaves their range, or the pilot disengages, waits or idles.
   */
  private SyncTackle(id: string, record: PilotRecord, picture: ShipPilotPicture, boundary: number): void {
    const modules = this.port.Tackle(id);
    if (!modules.length && !record.owned.size) return;
    const focus = picture.focus;
    const fighting = record.state !== 'disengaging' && record.state !== 'waiting' && record.state !== 'idle' && record.stance.pilot?.type !== 'support';
    const distance = focus ? surfaceDistanceOf(picture.self, focus) : Number.POSITIVE_INFINITY;
    for (const module of modules) {
      const owned = record.owned.get(module.key);
      const wanted = fighting && focus != null && distance <= module.range;
      if (wanted && focus && (owned !== focus.id || !module.running)) {
        if (!owned && module.running) continue;
        const refusal = this.port.SwitchTackle(id, module.key, true, focus.id);
        if (refusal == null) record.owned.set(module.key, focus.id);
        if (owned !== focus.id) this.Decided(record, { tick: boundary, tool: 'switch_modules', args: { ships: [id], modules: [module.key], state: 'active', target: focus.id }, why: `${module.kind} on ${focus.id} in ${Math.round(module.range)} m`, ...(refusal ? { refused: refusal } : {}) });
      } else if (!wanted && owned) {
        this.port.SwitchTackle(id, module.key, false);
        record.owned.delete(module.key);
        this.Decided(record, { tick: boundary, tool: 'switch_modules', args: { ships: [id], modules: [module.key], state: 'online' }, why: `${module.kind} off ${owned}` });
      }
    }
  }

  private StopTackle(id: string, record: PilotRecord): void {
    for (const key of record.owned.keys()) this.port.SwitchTackle(id, key, false);
    record.owned.clear();
  }
}
