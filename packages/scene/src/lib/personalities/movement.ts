import type { Maybe } from '@dereekb/util';
import type { DirectionShipOrder, KeepAtRangeShipOrder, ShipOrder } from '../orders';
import type { SceneVector } from '../scene';
import type { FleetPropModRule, FleetStance } from './personality';
import type { FleetPicturePropMods, FleetPictureShip } from './picture';
import { describeMetres } from './targeting';

/**
 * How a personality fleet moves on its focus (the primary, else the nearest hostile) and when it runs its prop mods.
 * The FC's order moves the fleet (Follow the FC), so a stance is one order for the FC. Bands keep a fleet from
 * flapping between two orders, or its prop mods on and off, at the edge of a range.
 */

/**
 * A kiter backs off inside this share of its range and closes beyond KITE_CLOSE_BAND of it.
 */
export const KITE_BACK_OFF_BAND = 0.9;

export const KITE_CLOSE_BAND = 1.1;

/**
 * `closing` prop mods come on beyond this share of the range, and go off inside PROP_MODS_OFF_BAND of it.
 */
export const PROP_MODS_ON_BAND = 1.25;

export const PROP_MODS_OFF_BAND = 1.1;

/**
 * A wanted keep-at-range differs from the FC's when its range moves by more than this share.
 */
export const FLEET_RANGE_TOLERANCE = 0.1;

/**
 * A wanted direction differs from the FC's when the cosine between them falls below this (about 25°).
 */
export const FLEET_DIRECTION_TOLERANCE = 0.9;

export interface FleetMoveDecision {
  readonly order: ShipOrder;
  readonly why: string;
}

export interface FleetMoveInput {
  readonly stance: FleetStance;
  /**
   * Metres the stance keeps.
   */
  readonly range: number;
  /**
   * The focus; null when the picture has no hostile.
   */
  readonly focus: Maybe<FleetPictureShip>;
  /**
   * The FC's order.
   */
  readonly order: Maybe<ShipOrder>;
}

/**
 * The unit vector away from a focus.
 *
 * @param offset - The focus's centre minus the FC's.
 * @returns The direction away; +z when the focus sits on the FC.
 */
function awayFrom(offset: SceneVector): SceneVector {
  const length = Math.hypot(offset[0], offset[1], offset[2]);
  const away = (value: number) => (value === 0 ? 0 : -value / length);
  return length > 0 ? [away(offset[0]), away(offset[1]), away(offset[2])] : [0, 0, 1];
}

/**
 * The order the stance wants for the FC: brawl and snipe keep at range on the focus; kite keeps at range beyond
 * KITE_CLOSE_BAND × range, flies directly away inside KITE_BACK_OFF_BAND × range (no orbit: rigid formation slots
 * swing wide on one), and keeps what it flies between; hold wants nothing.
 *
 * @param input - The stance, its range, the focus and the FC's order.
 * @returns The wanted order and why; null when the stance wants none.
 */
export function toFleetMove(input: FleetMoveInput): Maybe<FleetMoveDecision> {
  const { stance, range, focus, order } = input;
  let decision: Maybe<FleetMoveDecision> = null;
  if (focus && stance !== 'hold') {
    const keep: KeepAtRangeShipOrder = { type: 'keep-at-range', target: focus.id, range: Math.round(range), speed: 1 };
    const away: DirectionShipOrder = { type: 'direction', direction: awayFrom(focus.offset), speed: 1 };
    if (stance !== 'kite') decision = { order: keep, why: `${stance}: keep ${focus.id} at ${describeMetres(range)}` };
    else if (focus.distance < KITE_BACK_OFF_BAND * range) decision = { order: away, why: `kite: ${focus.id} is inside ${describeMetres(KITE_BACK_OFF_BAND * range)}; back off` };
    else if (focus.distance > KITE_CLOSE_BAND * range || order?.type !== 'direction') decision = { order: keep, why: `kite: keep ${focus.id} at ${describeMetres(range)}` };
    else decision = { order: away, why: `kite: still backing off ${focus.id}` };
  }
  return decision;
}

/**
 * Whether a wanted order differs from the FC's enough to give it: a new type or target, a keep range or orbit range
 * moving by more than FLEET_RANGE_TOLERANCE, or a direction turning past FLEET_DIRECTION_TOLERANCE.
 *
 * @param wanted - The wanted order.
 * @param current - The FC's order.
 * @returns True when the wanted order should be given.
 */
export function isFleetMoveChange(wanted: ShipOrder, current: Maybe<ShipOrder>): boolean {
  let changed = true;
  if (current && current.type === wanted.type) {
    if (wanted.type === 'keep-at-range' && current.type === 'keep-at-range') changed = current.target !== wanted.target || Math.abs(current.range - wanted.range) > FLEET_RANGE_TOLERANCE * Math.max(1, current.range);
    else if (wanted.type === 'direction' && current.type === 'direction') {
      const [a, b] = [wanted.direction, current.direction];
      const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
      changed = cosine < FLEET_DIRECTION_TOLERANCE;
    } else changed = JSON.stringify(current) !== JSON.stringify(wanted);
  }
  return changed;
}

export interface FleetPropModsInput {
  readonly rule: FleetPropModRule;
  readonly stance: FleetStance;
  readonly range: number;
  readonly focus: Maybe<FleetPictureShip>;
  readonly engaged: boolean;
  /**
   * Whether the fleet's prop mods run now.
   */
  readonly current: FleetPicturePropMods;
}

/**
 * Whether the fleet wants its prop mods on: `never` off; `closing` on while closing on its range (on beyond
 * PROP_MODS_ON_BAND × range, off inside PROP_MODS_OFF_BAND ×, unchanged between; a holding fleet never closes);
 * `always` on while engaged or closing. Null when no member has a prop mod.
 *
 * @param input - The rule, the stance, its range, the focus, engaged and the current state.
 * @returns On or off and why; null when there is nothing to switch.
 */
export function toFleetPropMods(input: FleetPropModsInput): Maybe<{ readonly active: boolean; readonly why: string }> {
  const { rule, stance, range, focus, engaged, current } = input;
  let result: Maybe<{ readonly active: boolean; readonly why: string }> = null;
  if (current !== 'none') {
    let closing = false;
    if (focus && stance !== 'hold') closing = focus.distance > PROP_MODS_ON_BAND * range || (current === 'on' && focus.distance > PROP_MODS_OFF_BAND * range);
    if (rule === 'never') result = { active: false, why: 'prop mods never run' };
    else if (closing && focus) result = { active: true, why: `closing on ${focus.id} (${describeMetres(focus.distance)} out, range ${describeMetres(range)})` };
    else if (rule === 'always' && engaged) result = { active: true, why: 'engaged' };
    else result = { active: false, why: focus ? `within ${describeMetres(PROP_MODS_OFF_BAND * range)} of ${focus.id}` : 'no hostile' };
  }
  return result;
}
