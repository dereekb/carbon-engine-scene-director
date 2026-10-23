import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../json';
import { isFleetMoveChange, toFleetMove, toFleetPropMods } from './movement';
import type { ResolvedFleetPersonality } from './personality';
import { type FleetPicture, fleetReachMetres } from './picture';
import { toFcDelayTicks } from './succession';
import { toFleetCall, toFleetEngaged } from './targeting';
import { fleetTraitUnit } from './traits';

/**
 * The FC brain: one pure step per Destiny boundary for one personality fleet with an acting FC. It reads the picture,
 * decides what each lever wants, and where that differs from what the fleet does, opens a pending decision due after
 * the FC's delay (toFcDelayTicks); at due it decides again and gives the result as tool calls (the same JSON a model
 * gives), which the page runs. Every jitter is keyed `seed | fleet | lever | tick − readyAt`, so a reload replays the
 * same decisions at the same ticks.
 */

/**
 * The levers the brain pulls: the call (order_fleet targets), free fire (order_fleet free-fire), the FC's movement
 * (order_fleet with a ship order) and prop mods (switch_prop_mods). A lever a model pulls is manual until
 * set_fleet_personality.
 */
export const FLEET_BRAIN_LEVERS = ['call', 'free-fire', 'move', 'prop-mods'] as const;
export type FleetBrainLever = (typeof FLEET_BRAIN_LEVERS)[number];

/**
 * The levers cease_fire holds.
 */
export const FLEET_TARGETING_LEVERS: readonly FleetBrainLever[] = ['call', 'free-fire'];

/**
 * How many decisions a fleet's log keeps (the latest).
 */
export const MAX_FLEET_DECISIONS = 20;

export type FleetBrainTool = 'order_fleet' | 'switch_prop_mods';

export interface FleetBrainPending {
  readonly lever: FleetBrainLever;
  /**
   * The tick it is decided at.
   */
  readonly due: number;
  readonly why: string;
}

export interface FleetBrainAction {
  readonly lever: FleetBrainLever;
  readonly tool: FleetBrainTool;
  /**
   * The tool's arguments, exactly as a model would give them.
   */
  readonly args: JsonObject;
  readonly why: string;
}

export interface FleetBrainDecision extends FleetBrainAction {
  readonly tick: number;
}

export interface FleetBrainMemory {
  readonly engaged: boolean;
  /**
   * Why it engaged, once it has.
   */
  readonly engagedBy?: string;
  readonly pending: readonly FleetBrainPending[];
  /**
   * The latest decisions, oldest first.
   */
  readonly decisions: readonly FleetBrainDecision[];
}

export const EMPTY_FLEET_BRAIN_MEMORY: FleetBrainMemory = { engaged: false, pending: [], decisions: [] };

export interface FleetBrainStepInput {
  readonly picture: FleetPicture;
  readonly personality: Pick<ResolvedFleetPersonality, 'engage' | 'targeting' | 'movement'>;
  readonly memory: FleetBrainMemory;
  readonly tick: number;
  /**
   * The tick the fleet's picture first passed the gate.
   */
  readonly readyAt: number;
  /**
   * The scene's combat seed.
   */
  readonly seed: number;
  /**
   * Levers a model took: the brain leaves them alone.
   */
  readonly manual?: readonly FleetBrainLever[];
  /**
   * The fleet is held by cease_fire: no calls and no free fire.
   */
  readonly held?: boolean;
}

export interface FleetBrainStep {
  readonly memory: FleetBrainMemory;
  /**
   * The tool calls to run now, in lever order.
   */
  readonly actions: FleetBrainAction[];
}

/**
 * What each lever wants now that differs from what the fleet does. The fleet moves on its focus: the live primary,
 * else the primary it wants to call, else the nearest hostile.
 *
 * @param input - The step's input.
 * @param engaged - Whether the fleet is engaged.
 * @returns The wanted actions per lever.
 */
function toWanted(input: FleetBrainStepInput, engaged: boolean): Map<FleetBrainLever, FleetBrainAction> {
  const { picture, personality, held } = input;
  const { targeting, movement } = personality;
  const by = picture.fc?.ship ?? '';
  const wanted = new Map<FleetBrainLever, FleetBrainAction>();
  const orderFleet = (lever: FleetBrainLever, order: JsonObject, why: string) => wanted.set(lever, { lever, tool: 'order_fleet', args: { fleet: picture.fleet, by, order }, why });
  let primary: Maybe<string> = null;
  if (engaged && !held) {
    const { call, why } = toFleetCall({ picture, targeting });
    primary = call[0];
    if (call.length !== picture.call.length || call.some((id, index) => id !== picture.call[index])) orderFleet('call', call.length ? { type: 'targets', set: call } : { type: 'targets', clear: true }, why);
    if (targeting.freeFire && !picture.freeFire) orderFleet('free-fire', { type: 'free-fire', on: true }, 'engaged: members without a call pick their own targets');
  }
  const focus = picture.hostiles.find((ship) => ship.id === picture.call[0]) ?? picture.hostiles.find((ship) => ship.id === primary) ?? picture.hostiles[0];
  const range = fleetReachMetres(movement.range, picture.reach);
  const move = toFleetMove({ stance: movement.stance, range, focus, order: picture.order });
  if (move && isFleetMoveChange(move.order, picture.order)) orderFleet('move', move.order as unknown as JsonObject, move.why);
  const props = toFleetPropMods({ rule: movement.propMods, stance: movement.stance, range, focus, engaged, current: picture.propMods });
  if (props && props.active !== (picture.propMods === 'on')) wanted.set('prop-mods', { lever: 'prop-mods', tool: 'switch_prop_mods', args: { fleet: picture.fleet, active: props.active }, why: props.why });
  return wanted;
}

/**
 * One brain step for a fleet with an acting FC: updates engaged, then per lever (not manual) opens, keeps, drops or
 * decides its pending decision. A lever with no pending decision opens one due after the FC delay (ability 1 decides
 * in the same step); at due the lever's want is recomputed and given. A want that goes away drops its decision.
 * Without an FC (leaderless) it decides nothing and drops every pending decision.
 *
 * @param input - The picture, the personality, the memory, the tick and the seed.
 * @returns The new memory and the tool calls to run.
 */
export function stepFleetBrain(input: FleetBrainStepInput): FleetBrainStep {
  const { picture, personality, memory, tick, readyAt, seed } = input;
  const manual = new Set(input.manual ?? []);
  const fc = picture.fc;
  const actions: FleetBrainAction[] = [];
  const pending: FleetBrainPending[] = [];
  let engaged = memory.engaged;
  let engagedBy = memory.engagedBy;
  if (fc) {
    const engagement = toFleetEngaged({ engage: personality.engage, picture, targeting: personality.targeting, was: memory.engaged });
    engaged = engagement.engaged;
    if (engagement.why) engagedBy = engagement.why;
    const wanted = toWanted(input, engaged);
    for (const lever of FLEET_BRAIN_LEVERS) {
      const want: Maybe<FleetBrainAction> = manual.has(lever) ? null : wanted.get(lever);
      const open = memory.pending.find((each) => each.lever === lever);
      if (want) {
        const due = open?.due ?? tick + toFcDelayTicks(fc.ability, fleetTraitUnit(seed, `${picture.fleet}|${lever}|${tick - readyAt}`));
        if (due <= tick) actions.push(want);
        else pending.push({ lever, due, why: want.why });
      }
    }
  }
  const decisions = [...memory.decisions, ...actions.map((action) => ({ tick, ...action }))].slice(-MAX_FLEET_DECISIONS);
  return { memory: { engaged, ...(engagedBy ? { engagedBy } : {}), pending, decisions }, actions };
}
