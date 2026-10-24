/**
 * The page's fleet command state: the live call book, free fire, and the FC brain of each personality fleet.
 * order_fleet's targets order edits a group's live list here at once, as moves and warps fly at once, and never writes
 * the document: the document's `targets` are the opening calls a load starts with, so a reload replays the same fight.
 * Its free-fire order turns a group's free fire on or off here (FleetTargets picks the targets); the document has no
 * free fire, so a load ends it. Its stance order (and order_ship's, for one pilot) sets a group's or ship's live stance
 * in the stance book here, spliced over the document's stances the same way (piloting/stances.ts); a load resets it.
 *
 * - The book overlays the document (Overlay → toLiveFleetScene), so FleetTargets, FleetFollowing, FleetOrders and
 *   get_state read the live calls with no change of their own. `[]` shadows the document's list: the group calls
 *   nothing. The overlay also names each personality fleet's acting commander (its succession's designate).
 * - A load clears it (Clear). A patch (AfterEdit) drops a group's live call when the group is gone or the patch edited
 *   its document list (beyond pruning a removed id), and prunes removed ships and objects from the live lists, with
 *   remove_ship's warning; a group gone also ends its free fire.
 * - The brain (Step, each Destiny boundary): per personality fleet in document order, the gate (the formation planned,
 *   every ship's numbers and fit settled, no member arriving or in warp; it waits out a warp-in, then gives up on
 *   unsettled ships after FLEET_GATE_TICKS), the succession (CommanderDown: the protocol's designate, the handover; a
 *   leaderless fleet runs it again each boundary), the picture (toFleetPicture over the port's
 *   facts), stepFleetBrain, and its actions run through the port as the tool calls a model makes, the acting FC as
 *   `by`. A model pulling a lever (TakeLevers) makes it manual until set_fleet_personality re-arms it (Rearm).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  calledTargetsOf,
  type CalledTargetStatus,
  EMPTY_FLEET_BRAIN_MEMORY,
  FLEET_BRAIN_LEVERS,
  FLEET_TARGETING_LEVERS,
  type FleetBrainAction,
  type FleetBrainDecision,
  type FleetBrainLever,
  type FleetBrainMemory,
  type FleetGroup,
  groupStanceOf,
  type FleetPicturePropMods,
  type FleetPictureShip,
  type FleetPilotTraitSource,
  type FleetReachNumbers,
  type FleetShipFacts,
  type FleetSuccessor,
  fleetTraitUnit,
  type LiveFleetOverlay,
  type ResolvedFleetPersonality,
  resolveFleetPersonality,
  type SceneDocument,
  type SceneFleet,
  sceneCombatOf,
  selectFleetShips,
  shipPilotTraits,
  type ShipOrder,
  type ShipStance,
  pruneStanceOn,
  rankFleetTargets,
  stanceEdited,
  stepFleetBrain,
  toFleetGroupKey,
  toFleetTargetingReach,
  toFleetMemberships,
  toFleetPicture,
  toFleetPilotTraits,
  toFleetShipOrder,
  toFleetSuccessor,
  toHandoverTicks
} from '@scene-director/scene';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

/**
 * One group's live call.
 */
interface LiveCall {
  readonly group: FleetGroup;
  readonly targets: readonly string[];
}

/**
 * A group's live stance (order_fleet's stance order).
 */
export interface LiveStance {
  readonly group: FleetGroup;
  /**
   * Null: cleared live (the document's stance at this level does not apply).
   */
  readonly stance: Maybe<ShipStance>;
  /**
   * The tick the order was given at.
   */
  readonly tick: number;
  /**
   * Each pilot's response, in ticks (toPilotDelays): the pilots flying the stance take it up after theirs.
   */
  readonly delays: ReadonlyMap<string, number>;
}

/**
 * Whether the document holds the group.
 *
 * @param scene - The document.
 * @param group - The fleet, wing or squad.
 * @returns True when its fleet, wing or squad is there.
 */
function hasGroup(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): boolean {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let found = fleet != null;
  if (fleet && group.kind === 'wing') found = fleet.wings.some((wing) => wing.id === group.id);
  else if (fleet && group.kind === 'squad') found = fleet.wings.some((wing) => wing.squads.some((squad) => squad.id === group.id));
  return found;
}

/**
 * The group as remove_ship's pruning warning names it.
 *
 * @param group - The group.
 * @returns E.g. `fleet "blue": squad "dps"`.
 */
function pruneLabel(group: FleetGroup): string {
  return group.kind === 'fleet' ? `fleet "${group.fleet}"` : `fleet "${group.fleet}": ${group.kind} "${group.id}"`;
}

function isStanceOrder(order: unknown): boolean {
  return order !== null && typeof order === 'object' && (order as Readonly<Record<string, unknown>>)['type'] === 'stance';
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The levers a stance flown by a personality fleet's acting FC takes from its brain.
 */
export const FLEET_PILOTED_LEVERS: readonly FleetBrainLever[] = ['move', 'prop-mods'];

/**
 * Ticks: the gate stops waiting for unsettled ships after this many boundaries with no member away (a warp-in is waited
 * out first); they count as they are, noted.
 */
export const FLEET_GATE_TICKS = 20;

/**
 * Where a personality fleet's command stands: `waiting` for the gate, `commanding`, `handover` (its FC went down and the
 * designate has yet to take over), `leaderless` (the protocol found nobody) or `no-team` (no team, so no hostiles).
 */
export type FleetCommandState = 'waiting' | 'commanding' | 'handover' | 'leaderless' | 'no-team';

/**
 * The page's side of the brain: what it reads of the fight and how it runs the brain's tool calls.
 */
export interface FleetBrainPort {
  /**
   * The live document (personalities, pilots, the combat seed).
   */
  Document(): Maybe<SceneDocument>;
  /**
   * The document as its fleets fly (the live view: live calls, the dead out, acting commanders).
   */
  Live(): Maybe<SceneDocument>;
  /**
   * Whether a ship is down: destroyed, flagged or exploded.
   */
  Destroyed(id: string): boolean;
  /**
   * Whether a fleet's formation is planned (FleetFollowing.Ready).
   */
  Ready(fleet: string): boolean;
  /**
   * Whether a ship's hull numbers and fit (or default weapons) have settled.
   */
  Settled(id: string): boolean;
  /**
   * Every ship with a ball that is not dead (destroyed and exploded), in document order.
   */
  Facts(): readonly FleetShipFacts[];
  /**
   * A ship's order: its pending one, else the applied one.
   */
  OrderOf(id: string): Maybe<ShipOrder>;
  /**
   * The fleet's live call: its live primary, then its live queue.
   */
  CallOf(fleet: string): readonly string[];
  /**
   * Whether the ships' prop mods run.
   */
  PropMods(ships: readonly string[]): FleetPicturePropMods;
  /**
   * Runs one brain action as its tool call (order_fleet through the live dispatch, switch_prop_mods) at the boundary.
   *
   * @throws {Error} When the tool refuses it.
   */
  Run(action: FleetBrainAction, boundary: number): void;
  /**
   * Moves a fleet's command to its designate while the old commander still flies (a flagged FC at its handover):
   * captures what the old one flew, runs `apply` (the overlay's new commander), re-plans the formation and has the
   * designate inherit the order.
   */
  HandOver(fleet: string, from: string, to: string, apply: () => void): void;
  /**
   * Whether a stance's pilot flies the ship now (ShipPilots.Flies): on the acting FC it takes the brain's move and prop
   * mods levers.
   */
  Piloted?(id: string): boolean;
  /**
   * A called target's status (Director.CalledTargetStatus): a lent call lever comes back once none of its targets is
   * `live`.
   */
  TargetStatus?(id: string): CalledTargetStatus;
}

/**
 * A ship's pilot for get_state: its traits and where they came from.
 */
export interface ShipPilotReport {
  readonly command?: number;
  readonly reaction?: number;
  readonly source: FleetPilotTraitSource;
}

/**
 * A personality fleet's brain for get_state (fleets[].fc).
 */
export interface FleetCommandReport {
  readonly personality: string;
  /**
   * The acting FC (the formation's root); during a handover, the one the designate takes over from.
   */
  readonly ship: string;
  /**
   * The acting FC's command ability (0 for a pilot that is not FC-capable).
   */
  readonly ability: number;
  readonly state: FleetCommandState;
  /**
   * The levers a stance flown by the acting FC holds (its pilot moves it and runs the prop mods).
   */
  readonly piloted?: readonly FleetBrainLever[];
  readonly successor?: string;
  /**
   * Seconds until the designate takes command.
   */
  readonly takesOverIn?: number;
  readonly readyAt?: number;
  readonly engaged: boolean;
  readonly engagedBy?: string;
  /**
   * Hostiles in the last picture.
   */
  readonly hostiles: number;
  readonly reach: FleetReachNumbers;
  readonly stance: string;
  readonly manual: readonly FleetBrainLever[];
  /**
   * The call lever lent by a targets order with `until: "gone"`: the targets it named; the brain calls again once
   * none of them is live.
   */
  readonly lent?: { readonly lever: 'call'; readonly targets: readonly string[] };
  readonly held?: true;
  readonly pending: readonly { readonly lever: FleetBrainLever; readonly dueIn: number; readonly why: string }[];
  readonly decisions: readonly FleetBrainLogEntry[];
  /**
   * What the gate gave up waiting for, or the last step's failure.
   */
  readonly note?: string;
}

/**
 * A decision as get_state logs it: the tool call and why, and why the tool refused it, if it did.
 */
export interface FleetBrainLogEntry extends FleetBrainDecision {
  readonly refused?: string;
}

/**
 * The designate taking over from a commander that went down.
 */
interface FleetHandover {
  readonly from: string;
  readonly designate: FleetSuccessor;
  /**
   * The tick it takes command at.
   */
  readonly at: number;
  /**
   * The old commander still flies (flag mode): the overlay moves the root at the handover.
   */
  readonly flagged: boolean;
}

/**
 * One personality fleet's brain.
 */
interface FleetBrain {
  /**
   * The first boundary the gate ran at with no member away (arriving or in warp): its give-up clock.
   */
  since: Maybe<number>;
  readyAt: Maybe<number>;
  memory: FleetBrainMemory;
  /**
   * Refusals by decision (tick and lever), for the log.
   */
  refusals: Map<string, string>;
  readonly manual: Set<FleetBrainLever>;
  /**
   * A stance's pilot flew the acting FC at the last step (it held the move and prop mods levers).
   */
  piloted?: boolean;
  held: boolean;
  /**
   * The targets a lent call lever (targets `until: "gone"`) waits on; null when the call is not lent.
   */
  lent: Maybe<readonly string[]>;
  handover: Maybe<FleetHandover>;
  leaderless: boolean;
  hostiles: number;
  reach: FleetReachNumbers;
  team: Maybe<string>;
  /**
   * Every hostile in the brain's last picture, ranked by its targeting (in reach or not), and the reach it calls within:
   * the battle console's target list (Targets).
   */
  targets?: { readonly ranked: readonly FleetPictureShip[]; readonly reach: number };
  note?: string;
}

/**
 * The traits and personalities a document gives, memoized per document.
 */
interface FleetTraitBook {
  readonly scene: SceneDocument;
  readonly personalities: ReadonlyMap<string, ResolvedFleetPersonality>;
  readonly pilots: ReadonlyMap<string, ShipPilotReport>;
}

const NO_REACH: FleetReachNumbers = { lock: 0, optimal: 0, falloff: 0 };

/**
 * The order types that fly a fleet's FC (the move lever).
 */
const FLEET_MOVE_ORDERS = new Set(['direction', 'goto', 'approach', 'keep-at-range', 'orbit', 'stop', 'warp']);

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Round(value: number, scale = 100): number {
  return Math.round(value * scale) / scale;
}

/**
 * A tool call's selection (ships, fleet, wing, squad) as far as it is well formed.
 *
 * @param args - The tool's arguments.
 * @returns The selection.
 */
function SelectionOf(args: Readonly<Record<string, unknown>>): { ships?: string[]; fleet?: string; wing?: string; squad?: string } {
  const ships = Array.isArray(args['ships']) ? args['ships'].filter((id): id is string => typeof id === 'string') : null;
  const text = (key: string): Maybe<string> => (typeof args[key] === 'string' ? (args[key] as string) : null);
  const fleet = text('fleet');
  const wing = text('wing');
  const squad = text('squad');
  return { ...(ships ? { ships } : {}), ...(fleet ? { fleet } : {}), ...(wing ? { wing } : {}), ...(squad ? { squad } : {}) };
}

/**
 * Every pilot's traits and every personality fleet's personality: personality fleets' members their toFleetPilotTraits
 * (authored traits win, the rest seeded draws), then the other ships with authored traits.
 *
 * @param scene - The document.
 * @returns The book.
 */
function toFleetTraitBook(scene: SceneDocument): FleetTraitBook {
  const docs = new Map(scene.ships.map((doc) => [doc.id, doc]));
  const seed = sceneCombatOf(scene).seed;
  const personalities = new Map<string, ResolvedFleetPersonality>();
  const pilots = new Map<string, ShipPilotReport>();
  for (const fleet of scene.fleets ?? []) {
    const personality = fleet.personality ? resolveFleetPersonality({ name: fleet.personality, personalities: scene.personalities }).personality : null;
    if (!personality) continue;
    personalities.set(fleet.id, personality);
    for (const [id, traits] of toFleetPilotTraits({ fleet, personality, pilotOf: (ship) => shipPilotTraits(docs.get(ship)?.pilot), seed })) if (!pilots.has(id)) pilots.set(id, traits);
  }
  for (const doc of scene.ships) {
    if (pilots.has(doc.id)) continue;
    const authored = shipPilotTraits(doc.pilot);
    if (authored.command != null || authored.reaction != null) pilots.set(doc.id, { ...authored, source: 'pilot' });
  }
  return { scene, personalities, pilots };
}

/**
 * What a FleetCommanders snapshot (sd-time) leaves out: its wiring (port).
 */
const FLEET_COMMANDERS_CAPTURE: CaptureOptions = { wiring: ['port'] };

export class FleetCommanders {
  /**
   * The live calls by group key (toFleetGroupKey).
   */
  private readonly calls = new Map<string, LiveCall>();
  /**
   * The groups with free fire on, by group key.
   */
  private readonly freeFire = new Map<string, FleetGroup>();
  /**
   * The live group stances by group key, in the overlay.
   */
  private readonly stances = new Map<string, LiveStance>();
  /**
   * The pilots' own live stances by ship id (order_ship's stance order; a rejoin clears one): null clears the
   * document's.
   */
  private readonly shipStances = new Map<string, Maybe<ShipStance>>();
  /**
   * The acting commander by fleet id (a personality fleet's designate), in the overlay.
   */
  private readonly acting = new Map<string, string>();
  /**
   * Each personality fleet's brain, by fleet id.
   */
  private readonly brains = new Map<string, FleetBrain>();
  /**
   * The first boundary each ship was seen unsettled at, for the gate's give-up.
   */
  private readonly unsettledSince = new Map<string, number>();
  private book: Maybe<FleetTraitBook> = null;
  private overlay: LiveFleetOverlay = {};
  private changes = 0;
  private readonly port: Maybe<FleetBrainPort>;

  /**
   * @param config - `port`: the page's side of the brain; without it the brain never runs (the call book alone).
   */
  constructor(config: { readonly port?: FleetBrainPort } = {}) {
    this.port = config.port ?? null;
  }

  /**
   * Bumped on every change to the calls or the acting commanders, so a memo of the live view keys on it (free fire is
   * not in the view).
   */
  get version(): number {
    return this.changes;
  }

  /**
   * The per-tick state for a time-control snapshot (sd-time): every field but the wiring.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, FLEET_COMMANDERS_CAPTURE, memo);
  }

  /**
   * Restores a Snapshot, refilling every container in place.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, FLEET_COMMANDERS_CAPTURE, memo);
  }

  /**
   * Sets a group's live call: its list in kill order, `[]` to call nothing over the document's list.
   *
   * @param group - The fleet, wing or squad.
   * @param targets - Its called targets.
   */
  SetCall(group: FleetGroup, targets: readonly string[]): void {
    const key = toFleetGroupKey(group);
    const before = this.calls.get(key);
    if (before && sameList(before.targets, targets)) return;
    this.calls.set(key, { group, targets: [...targets] });
    this.Changed();
  }

  /**
   * A group's live call; null when the document's list stands.
   *
   * @param group - The fleet, wing or squad.
   * @returns Its live list.
   */
  CallOf(group: FleetGroup): readonly string[] | null {
    return this.calls.get(toFleetGroupKey(group))?.targets ?? null;
  }

  /**
   * Turns a group's free fire on or off.
   *
   * @param group - The fleet, wing or squad.
   * @param on - Whether its members without a call pick their own targets.
   */
  SetFreeFire(group: FleetGroup, on: boolean): void {
    const key = toFleetGroupKey(group);
    if (on) this.freeFire.set(key, group);
    else this.freeFire.delete(key);
  }

  /**
   * Whether a group has free fire on.
   *
   * @param group - The fleet, wing or squad.
   * @returns True when it is on.
   */
  FreeFireOf(group: FleetGroup): boolean {
    return this.freeFire.has(toFleetGroupKey(group));
  }

  /**
   * The groups with free fire on, for FleetTargets.Sync.
   *
   * @returns Their group keys.
   */
  FreeFireKeys(): ReadonlySet<string> {
    return new Set(this.freeFire.keys());
  }

  /**
   * Sets a group's live stance: a stance over the document's, or null to clear it.
   *
   * @param group - The fleet, wing or squad.
   * @param stance - Its stance.
   * @param given - The tick the order was given at and each pilot's response, in ticks.
   */
  SetStance(group: FleetGroup, stance: Maybe<ShipStance>, given: { readonly tick: number; readonly delays: ReadonlyMap<string, number> }): void {
    this.stances.set(toFleetGroupKey(group), { group, stance: stance ? structuredClone(stance) : null, tick: given.tick, delays: new Map(given.delays) });
    this.Changed();
  }

  /**
   * A group's live stance; null when the document's stands.
   *
   * @param group - The fleet, wing or squad.
   * @returns Its entry.
   */
  StanceOf(group: FleetGroup): Maybe<LiveStance> {
    return this.stances.get(toFleetGroupKey(group)) ?? null;
  }

  /**
   * When a pilot takes up the latest live stance order that named it: that order's tick + its delay.
   *
   * @param id - The ship.
   * @returns The tick; null when no live stance order named it.
   */
  StanceDueOf(id: string): Maybe<number> {
    let latest: Maybe<LiveStance> = null;
    for (const entry of this.stances.values()) if (entry.delays.has(id) && (!latest || entry.tick >= latest.tick)) latest = entry;
    return latest ? latest.tick + (latest.delays.get(id) ?? 0) : null;
  }

  /**
   * Sets a pilot's own live stance: a stance over the document's, or null to clear it.
   *
   * @param id - The ship.
   * @param stance - Its stance.
   */
  SetShipStance(id: string, stance: Maybe<ShipStance>): void {
    this.shipStances.set(id, stance ? structuredClone(stance) : null);
    this.Changed();
  }

  /**
   * The pilots' own live stances, for resolveShipStances.
   *
   * @returns By ship id; null clears the document's.
   */
  ShipStances(): ReadonlyMap<string, Maybe<ShipStance>> {
    return this.shipStances;
  }

  /**
   * Brings the book in line with a patched document: a group gone or whose document list the patch edited drops its
   * live call (the document's new list stands), and ids no longer in the scene leave the live lists.
   *
   * @param before - The document before the patch.
   * @param after - The patched document.
   * @returns A warning per live list a removed id left, in remove_ship's words.
   */
  AfterEdit(before: Pick<SceneDocument, 'fleets'>, after: Pick<SceneDocument, 'ships' | 'objects' | 'fleets'>): string[] {
    const warnings: string[] = [];
    for (const [key, group] of [...this.freeFire]) if (!hasGroup(after, group)) this.freeFire.delete(key);
    this.AfterFleetEdit(before, after);
    this.AfterStanceEdit(before, after, warnings);
    if (!this.calls.size) return warnings;
    const ids = new Set([...after.ships.map((doc) => doc.id), ...(after.objects ?? []).map((doc) => doc.id)]);
    let changed = false;
    for (const [key, call] of [...this.calls]) {
      const { group } = call;
      const written = calledTargetsOf(after, group);
      const edited = !sameList(
        calledTargetsOf(before, group).filter((id) => ids.has(id)),
        written
      );
      if (!hasGroup(after, group) || edited) {
        this.calls.delete(key);
        changed = true;
        continue;
      }
      const removed = call.targets.filter((id) => !ids.has(id));
      if (removed.length) {
        this.calls.set(key, { group, targets: call.targets.filter((id) => ids.has(id)) });
        for (const id of removed) warnings.push(`${pruneLabel(group)} no longer calls "${id}" (it was removed)`);
        changed = true;
      }
    }
    if (changed) this.Changed();
    return warnings;
  }

  /**
   * The stance book after a patch: a group gone, or whose document stance the patch edited, drops its live stance (the
   * document's stands); a ship gone, or whose own stance the patch edited, drops its own; a live `on` naming a ship
   * that is gone, or a squad or wing its fleet no longer holds, falls back to the focus with a warning.
   *
   * @param before - The document before the patch.
   * @param after - The patched document.
   * @param warnings - Where the fall-backs' warnings go.
   */
  private AfterStanceEdit(before: Pick<SceneDocument, 'fleets'> & { readonly ships?: SceneDocument['ships'] }, after: Pick<SceneDocument, 'ships' | 'fleets'>, warnings: string[]): void {
    if (!this.stances.size && !this.shipStances.size) return;
    const ships = new Set(after.ships.map((doc) => doc.id));
    const memberships = toFleetMemberships(after);
    const fleetOf = (id: Maybe<string>): Maybe<SceneFleet> => (id == null ? null : (after.fleets?.find((fleet) => fleet.id === id) ?? null));
    let changed = false;
    for (const [key, entry] of [...this.stances]) {
      const { group } = entry;
      if (!hasGroup(after, group) || stanceEdited(groupStanceOf(before, group), groupStanceOf(after, group))) {
        this.stances.delete(key);
        changed = true;
        continue;
      }
      const pruned = pruneStanceOn(entry.stance, { ships, fleet: fleetOf(group.fleet) });
      if (pruned) {
        this.stances.set(key, { ...entry, stance: pruned.stance });
        warnings.push(`${pruneLabel(group)}'s live stance now flies on its focus (its on ${pruned.gone} was removed)`);
        changed = true;
      }
    }
    for (const [id, stance] of [...this.shipStances]) {
      const written = (ship: Maybe<{ readonly stance?: ShipStance }>): Maybe<ShipStance> => ship?.stance ?? null;
      if (!ships.has(id) || stanceEdited(written(before.ships?.find((doc) => doc.id === id)), written(after.ships.find((doc) => doc.id === id)))) {
        this.shipStances.delete(id);
        changed = true;
        continue;
      }
      const pruned = pruneStanceOn(stance, { ships, fleet: fleetOf(memberships.get(id)?.fleet) });
      if (pruned) {
        this.shipStances.set(id, pruned.stance);
        warnings.push(`ship "${id}"'s live stance now flies on its focus (its on ${pruned.gone} was removed)`);
        changed = true;
      }
    }
    if (changed) this.Changed();
  }

  /**
   * The live state toLiveFleetScene splices over the document; the same object until the next change.
   *
   * @returns The overlay.
   */
  Overlay(): LiveFleetOverlay {
    return this.overlay;
  }

  /**
   * Forgets every live call, free fire and live stance (a load: the document's calls and stances open the fight again).
   */
  Clear(): void {
    this.freeFire.clear();
    this.brains.clear();
    this.unsettledSince.clear();
    this.book = null;
    if (!this.calls.size && !this.acting.size && !this.stances.size && !this.shipStances.size) return;
    this.calls.clear();
    this.acting.clear();
    this.stances.clear();
    this.shipStances.clear();
    this.Changed();
  }

  /**
   * A ship's pilot: its personality fleet's traits (authored ones win over the seeded draws), else its authored traits;
   * null for a ship with neither.
   *
   * @param id - The ship.
   * @returns Its traits and their source.
   */
  PilotOf(id: string): Maybe<ShipPilotReport> {
    return this.Book()?.pilots.get(id) ?? null;
  }

  /**
   * A pilot's reaction for an order given without delay (toPilotDelays): PilotOf's; null answers at once.
   *
   * @param id - The ship.
   * @returns Its reaction, 0..1.
   */
  ReactionOf(id: string): Maybe<number> {
    return this.PilotOf(id)?.reaction ?? null;
  }

  /**
   * The brain at a Destiny boundary (between the shield recharge and the fleets' target sync): per personality fleet in
   * document order, the succession, the gate, the picture and stepFleetBrain, its actions run through the port. A fleet
   * whose step throws notes the failure; the others still step.
   *
   * @param boundary - The master tick.
   */
  Step(boundary: number): void {
    const port = this.port;
    const scene = port?.Document();
    const book = this.Book();
    if (!port || !scene || !book) return;
    for (const id of [...this.brains.keys()]) if (!book.personalities.has(id)) this.brains.delete(id);
    if (!book.personalities.size) return;
    let facts: Maybe<readonly FleetShipFacts[]> = null;
    const factsOf = (): readonly FleetShipFacts[] => {
      if (!facts) {
        facts = port.Facts();
        for (const ship of facts) {
          if (port.Settled(ship.id)) this.unsettledSince.delete(ship.id);
          else if (!this.unsettledSince.has(ship.id)) this.unsettledSince.set(ship.id, boundary);
        }
      }
      return facts;
    };
    const seed = sceneCombatOf(scene).seed;
    for (const fleet of scene.fleets ?? []) {
      const personality = book.personalities.get(fleet.id);
      if (!personality) continue;
      const brain = this.BrainOf(fleet.id);
      brain.since ??= boundary;
      try {
        this.StepFleet({ fleet, personality, brain, boundary, seed, book, factsOf });
      } catch (error) {
        brain.note = `the brain failed at tick ${boundary}: ${ErrorMessage(error)}`;
      }
    }
  }

  /**
   * A personality fleet's commander went down (destroyed, flagged or exploded): the protocol picks the designate over
   * the live members, who takes command after its handover (toHandoverTicks). When the old commander leaves the
   * formation (it exploded) the designate becomes the formation's root at once (the overlay); when it still flies
   * (`flagged`) it stays the root until the handover. Nobody found: leaderless (the default rule keeps a root, and the
   * step runs the protocol again each boundary until it finds someone). Fleets with no personality are left to the
   * default rule.
   *
   * @param fleet - The fleet id.
   * @param down - The commander that went down.
   * @param tick - The master tick.
   * @param options - `flagged`: the old commander still flies as the formation's root.
   */
  CommanderDown(fleet: string, down: string, tick: number, options: { readonly flagged?: boolean } = {}): void {
    const port = this.port;
    const scene = port?.Document();
    const book = this.Book();
    const doc = scene?.fleets?.find((candidate) => candidate.id === fleet);
    const personality = book?.personalities.get(fleet);
    if (!port || !scene || !book || !doc || !personality) return;
    const brain = this.BrainOf(fleet);
    const designate = this.DesignateOf(doc, personality, book, down);
    if (!designate) {
      brain.leaderless = true;
      brain.handover = null;
      this.SetCommander(fleet, null);
      return;
    }
    this.HandTo(fleet, brain, down, designate, tick, options.flagged === true);
  }

  /**
   * A model's tool call on a personality fleet takes the lever it pulls (manual until set_fleet_personality): order_fleet
   * targets or free-fire, engage and cease_fire the call and free fire (cease_fire also holds the fleet, a targets
   * order, free fire or engage lets it go); a fleet move or warp, or order_ship on its acting FC, the movement;
   * switch_prop_mods the prop mods. The brain's own calls never come through here.
   *
   * @param tool - The tool's name.
   * @param args - Its arguments, as given.
   */
  TakeLevers(tool: string, args: unknown): void {
    const book = this.Book();
    const live = this.port?.Live() ?? this.port?.Document();
    if (!book?.personalities.size || !live || args === null || typeof args !== 'object' || Array.isArray(args)) return;
    const record = args as Readonly<Record<string, unknown>>;
    const take = (fleet: unknown, levers: readonly FleetBrainLever[], held?: boolean): void => {
      if (typeof fleet !== 'string' || !book.personalities.has(fleet)) return;
      const brain = this.BrainOf(fleet);
      for (const lever of levers) brain.manual.add(lever);
      if (held != null) brain.held = held;
    };
    if (tool === 'order_fleet') {
      const order = record['order'];
      const fields = order !== null && typeof order === 'object' ? (order as Readonly<Record<string, unknown>>) : {};
      const type = fields['type'];
      if (type === 'targets' && fields['until'] === 'gone') this.LendCall(record['fleet'], fields);
      else if (type === 'targets' || type === 'free-fire') take(record['fleet'], FLEET_TARGETING_LEVERS, false);
      else if (typeof type === 'string' && FLEET_MOVE_ORDERS.has(type) && record['wing'] == null && record['squad'] == null) take(record['fleet'], ['move']);
    } else if (tool === 'order_ship' && !isStanceOrder(record['order'])) {
      for (const fleet of live.fleets ?? []) if (fleet.commander === record['id']) take(fleet.id, ['move']);
    } else if (tool === 'engage' || tool === 'cease_fire' || tool === 'switch_prop_mods') {
      const memberships = toFleetMemberships(live);
      const fleets = new Set(selectFleetShips(live, SelectionOf(record)).ships.flatMap((id) => memberships.get(id)?.fleet ?? []));
      for (const fleet of fleets) {
        if (tool === 'switch_prop_mods') take(fleet, ['prop-mods']);
        else take(fleet, FLEET_TARGETING_LEVERS, tool === 'cease_fire');
      }
    }
  }

  /**
   * A targets order with `until: "gone"` lends a personality fleet's call lever alone, until none of the targets it
   * names is live (StepFleet); `clear` hands it back at once. Either lets a cease_fire hold go, as a targets order does.
   */
  private LendCall(fleet: unknown, order: Readonly<Record<string, unknown>>): void {
    if (typeof fleet !== 'string' || !this.Book()?.personalities.has(fleet)) return;
    const brain = this.BrainOf(fleet);
    // primary, set and queue name their targets; next and drop wait on the call they leave.
    const given = [order['primary'], order['set'], order['queue']].flatMap((value) => (Array.isArray(value) ? value : value == null ? [] : [value])).filter((id): id is string => typeof id === 'string');
    const named = given.length ? given : [...(this.port?.CallOf(fleet) ?? [])];
    brain.held = false;
    if (order['clear'] === true || !named.length) {
      brain.manual.delete('call');
      brain.lent = null;
    } else {
      brain.manual.add('call');
      brain.lent = [...new Set(named)];
    }
  }

  /**
   * order_fleet engage: hands a personality fleet back to its brain and engages it now. The fleet's live stances (its
   * own, its wings' and squads') are dropped so the document's apply again; every manual and lent lever, the cease_fire
   * hold and the pending decisions are let go; the brain is engaged (`engagedBy: "ordered"`).
   *
   * @param fleet - The fleet id.
   * @returns Whether a cease_fire hold was let go (its members' holds lift too); null for a fleet with no personality.
   */
  Engage(fleet: string): Maybe<{ readonly released: boolean }> {
    if (!this.Book()?.personalities.has(fleet)) return null;
    for (const [key, entry] of this.stances) if (entry.group.fleet === fleet) this.stances.delete(key);
    const brain = this.BrainOf(fleet);
    const released = brain.held;
    brain.manual.clear();
    brain.held = false;
    brain.lent = null;
    brain.memory = { ...brain.memory, engaged: true, engagedBy: 'ordered', pending: [] };
    this.Changed();
    return { released };
  }

  /**
   * set_fleet_personality (an update_fleet setting `personality`) hands every lever back to the fleet's brain: manual
   * levers re-armed, the cease_fire hold let go, its pending decisions dropped.
   *
   * @param operations - The edit's operations.
   * @returns The fleets whose cease_fire hold it let go (their members' holds lift too).
   */
  AfterOperations(operations: unknown): string[] {
    const released: string[] = [];
    for (const operation of Array.isArray(operations) ? operations : []) {
      if (operation === null || typeof operation !== 'object') continue;
      const { op, fleet, set } = operation as Readonly<Record<string, unknown>>;
      if (op !== 'update_fleet' || typeof fleet !== 'string' || set === null || typeof set !== 'object' || !('personality' in set)) continue;
      const brain = this.brains.get(fleet);
      if (!brain) continue;
      if (brain.held) released.push(fleet);
      brain.manual.clear();
      brain.held = false;
      brain.lent = null;
      brain.memory = { ...brain.memory, pending: [] };
    }
    return released;
  }

  /**
   * A personality fleet's brain for get_state.
   *
   * @param fleet - The fleet id.
   * @param tick - The master tick.
   * @returns Its report; null for a fleet with no personality.
   */
  /**
   * A personality fleet's hostiles from its brain's last picture, ranked by its targeting, and the reach it calls
   * within; null before its first picture.
   *
   * @param fleet - The fleet id.
   * @returns The ranked hostiles and the reach in metres.
   */
  Targets(fleet: string): Maybe<{ readonly ranked: readonly FleetPictureShip[]; readonly reach: number }> {
    return this.brains.get(fleet)?.targets ?? null;
  }

  Report(fleet: string, tick: number): Maybe<FleetCommandReport> {
    const port = this.port;
    const book = this.Book();
    const doc = port?.Document()?.fleets?.find((candidate) => candidate.id === fleet);
    const personality = book?.personalities.get(fleet);
    if (!port || !book || !doc?.personality || !personality) return null;
    const brain = this.brains.get(fleet);
    const ship = port.Live()?.fleets?.find((candidate) => candidate.id === fleet)?.commander ?? this.acting.get(fleet) ?? doc.commander;
    let state: FleetCommandState = 'commanding';
    if (brain?.handover) state = 'handover';
    else if (brain?.leaderless) state = 'leaderless';
    else if (brain?.readyAt == null) state = 'waiting';
    else if (brain.team == null) state = 'no-team';
    const memory = brain?.memory ?? EMPTY_FLEET_BRAIN_MEMORY;
    const manual = FLEET_BRAIN_LEVERS.filter((lever) => brain?.manual.has(lever));
    const handover = brain?.handover;
    return {
      personality: doc.personality,
      ship,
      ability: Round(book.pilots.get(ship)?.command ?? 0),
      state,
      ...(handover ? { successor: handover.designate.ship, takesOverIn: Math.max(0, handover.at - tick) } : {}),
      ...(brain?.readyAt != null ? { readyAt: brain.readyAt } : {}),
      engaged: memory.engaged,
      ...(memory.engagedBy ? { engagedBy: memory.engagedBy } : {}),
      hostiles: brain?.hostiles ?? 0,
      reach: brain?.reach ?? NO_REACH,
      stance: personality.movement.stance,
      manual,
      ...(brain?.lent ? { lent: { lever: 'call' as const, targets: [...brain.lent] } } : {}),
      ...(brain?.piloted ? { piloted: [...FLEET_PILOTED_LEVERS] } : {}),
      ...(brain?.held ? { held: true as const } : {}),
      pending: memory.pending.map((each) => ({ lever: each.lever, dueIn: Math.max(0, each.due - tick), why: each.why })),
      decisions: memory.decisions.map((decision) => {
        const refused = brain?.refusals.get(`${decision.tick}|${decision.lever}`);
        return refused ? { ...decision, refused } : decision;
      }),
      ...(brain?.note ? { note: brain.note } : {})
    };
  }

  /**
   * One personality fleet's step: the succession (a flagged FC or a designate down, a handover due), the gate, the
   * picture, then stepFleetBrain and its actions. The brain idles while the acting FC is in warp, arriving or without
   * a ball.
   */
  private StepFleet(input: { readonly fleet: SceneFleet; readonly personality: ResolvedFleetPersonality; readonly brain: FleetBrain; readonly boundary: number; readonly seed: number; readonly book: FleetTraitBook; readonly factsOf: () => readonly FleetShipFacts[] }): void {
    const { fleet, personality, brain, boundary: tick, seed, book } = input;
    const port = this.port as FleetBrainPort;
    const liveFleet = (): Maybe<SceneFleet> => port.Live()?.fleets?.find((candidate) => candidate.id === fleet.id) ?? null;
    const before = liveFleet();
    if (!before) return;
    const pending = brain.handover;
    if (pending && port.Destroyed(pending.designate.ship)) this.CommanderDown(fleet.id, pending.flagged ? pending.from : pending.designate.ship, tick, { flagged: pending.flagged });
    else if (!pending && !brain.leaderless && port.Destroyed(before.commander)) this.CommanderDown(fleet.id, before.commander, tick, { flagged: true });
    else if (brain.leaderless) {
      // The protocol again over the live members: a ship that can command may have joined since. The root the default
      // rule picked flies on until the handover, as a flagged FC does, unless it is the designate itself.
      const designate = this.DesignateOf(fleet, personality, book, null);
      if (designate) this.HandTo(fleet.id, brain, before.commander, designate, tick, designate.ship !== before.commander);
    }
    const handover = brain.handover;
    if (handover && tick >= handover.at) {
      const to = handover.designate.ship;
      if (handover.flagged) port.HandOver(fleet.id, handover.from, to, () => this.SetCommander(fleet.id, to));
      brain.handover = null;
    }
    const facts = input.factsOf();
    if (brain.readyAt == null) {
      const { waits, away } = this.GateWaits(fleet, facts);
      // A warp-in is waited out (its landings are scheduled): the give-up clock runs from the last landing.
      if (away) brain.since = tick;
      if (waits.length && (away || tick - (brain.since ?? tick) < FLEET_GATE_TICKS)) return;
      brain.readyAt = tick;
      if (waits.length) brain.note = `the gate gave up waiting for ${waits.join(', ')} after ${FLEET_GATE_TICKS} s`;
    }
    const live = port.Live();
    const now = liveFleet();
    if (!live || !now) return;
    const commanding = !brain.handover && !brain.leaderless;
    const fc = commanding ? { ship: now.commander, ability: book.pilots.get(now.commander)?.command ?? 0 } : null;
    const counted = facts.filter((ship) => this.Counts(ship.id, tick));
    const fcFacts = fc ? counted.find((ship) => ship.id === fc.ship) : null;
    if (fc && (!fcFacts || fcFacts.away)) return;
    const picture = toFleetPicture({
      fleet: now,
      memberships: toFleetMemberships(live),
      ships: counted,
      fc,
      call: port.CallOf(fleet.id),
      order: fc ? port.OrderOf(fc.ship) : null,
      freeFire: this.FreeFireOf({ fleet: fleet.id, kind: 'fleet', id: fleet.id }),
      propMods: port.PropMods(toFleetShipOrder(now))
    });
    brain.team = picture.team;
    brain.hostiles = picture.hostiles.length;
    brain.reach = picture.reach;
    brain.targets = { ranked: rankFleetTargets({ hostiles: picture.hostiles, targeting: personality.targeting, reach: Number.POSITIVE_INFINITY }), reach: toFleetTargetingReach(personality.targeting.reach, picture.reach) };
    // A lent call comes back once none of the targets it named is live: the brain calls again this step.
    if (brain.lent && port.TargetStatus && !brain.lent.some((id) => port.TargetStatus?.(id) === 'live')) {
      brain.manual.delete('call');
      brain.lent = null;
    }
    // A stance flown by the acting FC moves it and runs the prop mods; the brain still calls targets and free fire.
    const piloted = fc != null && port.Piloted?.(fc.ship) === true;
    const manual = piloted ? [...new Set<FleetBrainLever>([...brain.manual, ...FLEET_PILOTED_LEVERS])] : [...brain.manual];
    brain.piloted = piloted;
    const step = stepFleetBrain({ picture, personality, memory: brain.memory, tick, readyAt: brain.readyAt, seed, manual, held: brain.held });
    brain.memory = step.memory;
    for (const action of step.actions) {
      try {
        port.Run(action, tick);
      } catch (error) {
        brain.refusals.set(`${tick}|${action.lever}`, ErrorMessage(error));
      }
    }
    const logged = new Set(step.memory.decisions.map((decision) => `${decision.tick}|${decision.lever}`));
    for (const key of [...brain.refusals.keys()]) if (!logged.has(key)) brain.refusals.delete(key);
  }

  /**
   * What the gate still waits for: the formation's plan, members arriving or in warp, and ships (members, and ships of
   * another team once the fleet has one) whose numbers or fit have not settled.
   *
   * @param fleet - The fleet (the document's).
   * @param facts - The scene's live ships.
   * @returns A label per wait (none when the fleet is ready), and whether a member is away (arriving or in warp).
   */
  private GateWaits(fleet: SceneFleet, facts: readonly FleetShipFacts[]): { readonly waits: string[]; readonly away: boolean } {
    const port = this.port as FleetBrainPort;
    const members = new Set(toFleetShipOrder(fleet));
    const teams = facts.filter((ship) => members.has(ship.id) && ship.team != null).map((ship) => ship.team);
    const waits: string[] = [];
    let away = false;
    if (!port.Ready(fleet.id)) waits.push('the formation');
    for (const ship of facts) {
      const member = members.has(ship.id);
      if (member && ship.away && !port.Destroyed(ship.id)) {
        away = true;
        waits.push(`"${ship.id}" (arriving or in warp)`);
      } else if ((member || (ship.team != null && teams.length > 0 && !teams.includes(ship.team))) && !port.Settled(ship.id)) waits.push(`"${ship.id}"`);
    }
    return { waits, away };
  }

  /**
   * Whether a ship counts in the pictures: settled, or unsettled for FLEET_GATE_TICKS.
   */
  private Counts(id: string, tick: number): boolean {
    const since = this.unsettledSince.get(id);
    return since == null || tick - since >= FLEET_GATE_TICKS;
  }

  /**
   * The protocol's designate over the fleet's live members (the document's commander, `down` and the destroyed left
   * out); null when it finds nobody.
   */
  private DesignateOf(fleet: SceneFleet, personality: ResolvedFleetPersonality, book: FleetTraitBook, down: Maybe<string>): Maybe<FleetSuccessor> {
    const port = this.port as FleetBrainPort;
    const gone = new Set(toFleetShipOrder(fleet).filter((ship) => ship === down || port.Destroyed(ship)));
    return toFleetSuccessor({ fleet, gone, steps: personality.command.succession, abilityOf: (ship) => book.pilots.get(ship)?.command ?? null });
  }

  /**
   * Starts the designate's handover from `from` (toHandoverTicks, its unit keyed on the fleet, the designate and the
   * ticks since the gate). Not flagged, the designate becomes the formation's root at once (the overlay); flagged, `from`
   * stays the root until the handover.
   */
  private HandTo(fleet: string, brain: FleetBrain, from: string, designate: FleetSuccessor, tick: number, flagged: boolean): void {
    const scene = this.port?.Document();
    const personality = this.Book()?.personalities.get(fleet);
    if (!scene || !personality) return;
    brain.leaderless = false;
    const unit = fleetTraitUnit(sceneCombatOf(scene).seed, `${fleet}|handover|${designate.ship}|${tick - (brain.readyAt ?? tick)}`);
    brain.handover = { from, designate, at: tick + toHandoverTicks({ ability: designate.ability, handover: personality.command.handover, unit }), flagged };
    if (!flagged) this.SetCommander(fleet, designate.ship);
  }

  private BrainOf(fleet: string): FleetBrain {
    let brain = this.brains.get(fleet);
    if (!brain) {
      brain = { since: null, readyAt: null, memory: EMPTY_FLEET_BRAIN_MEMORY, refusals: new Map(), manual: new Set(), held: false, lent: null, handover: null, leaderless: false, hostiles: 0, reach: NO_REACH, team: null };
      this.brains.set(fleet, brain);
    }
    return brain;
  }

  /**
   * Sets (or clears) a fleet's acting commander in the overlay.
   */
  private SetCommander(fleet: string, ship: Maybe<string>): void {
    if ((this.acting.get(fleet) ?? null) === ship) return;
    if (ship == null) this.acting.delete(fleet);
    else this.acting.set(fleet, ship);
    this.Changed();
  }

  /**
   * A patch's fleets: a fleet gone drops its brain and acting commander; a fleet whose document commander changed
   * drops its acting commander and its succession (the author's commander stands).
   */
  private AfterFleetEdit(before: Pick<SceneDocument, 'fleets'>, after: Pick<SceneDocument, 'fleets'>): void {
    const ids = new Set([...this.brains.keys(), ...this.acting.keys()]);
    for (const id of ids) {
      const was = before.fleets?.find((fleet) => fleet.id === id);
      const now = after.fleets?.find((fleet) => fleet.id === id);
      if (!now) this.brains.delete(id);
      if (!now || (was && was.commander !== now.commander)) {
        this.SetCommander(id, null);
        const brain = this.brains.get(id);
        if (brain) {
          brain.handover = null;
          brain.leaderless = false;
        }
      }
    }
  }

  private Book(): Maybe<FleetTraitBook> {
    const scene = this.port?.Document();
    if (!scene) return null;
    if (this.book?.scene !== scene) this.book = toFleetTraitBook(scene);
    return this.book;
  }

  private Changed(): void {
    this.changes++;
    this.overlay = {
      ...(this.calls.size ? { calls: new Map([...this.calls].map(([key, call]) => [key, call.targets])) } : {}),
      ...(this.acting.size ? { commanders: new Map(this.acting) } : {}),
      ...(this.stances.size ? { stances: new Map([...this.stances].map(([key, entry]) => [key, entry.stance])) } : {})
    };
  }
}
