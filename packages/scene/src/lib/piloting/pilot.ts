import type { Maybe } from '@dereekb/util';
import type { ShipOrder } from '../orders';
import { describeMetres } from '../personalities/targeting';
import type { SceneVector } from '../scene';
import { maxWeaponReachOf } from './application';
import type { PilotContact } from './envelope';
import { idealRangeOf, type IdealRange } from './ideal';
import { burnOutDirectionOf, closeInDirectionOf, isOutOfReachOf, isReaim, kiteAwayDirectionOf, leverBandOf, leverOrderOf, supportPointOf, SUPPORT_POINT_SLACK_SHARE } from './maneuvers';
import { canRunPropModOf, flightOf, repairReachOf, tackleRangeOf } from './profile';
import { relativeMotionOf, surfaceDistanceOf } from './relative';
import { ALIGNED_SPEED_SHARE, isLeverStanceType, REENGAGE_MARGIN, type IdealStanceType, type PilotStance, type ShipStanceRange } from './stance';
import { dotVectors, scaleVector, subtractVectors, unitVector, vectorLength } from './vectors';

/**
 * One pilot's step: from its picture, its resolved stance and its memory, the tool calls it makes this tick (each with
 * why) and its new memory. The page runs the calls on its ship (sd-piloting); an outside program could make the same
 * calls. Bands keep it from flapping: it acts only when its range leaves the window, a direction turns past
 * REAIM_DEGREES, or its prop mod state should change.
 */

export type ShipPilotState = 'in-line' | 'closing' | 'holding' | 'orbiting' | 'kiting' | 'aligning' | 'aligned' | 'disengaging' | 'waiting' | 'manual' | 'idle';

/**
 * Ticks between a pilot's ideal refreshes (a new focus, a new hostile or an HP drop refreshes at once).
 */
export const PILOT_REFRESH_TICKS = 5;

/**
 * An HP drop of this share since the last refresh refreshes the ideal at once.
 */
export const PILOT_REFRESH_HEALTH_DROP = 0.15;

/**
 * Seconds a hostile that shot the ship keeps it from re-engaging (it re-engages once every such hostile is gone).
 */
export const PILOT_SHOOTER_WINDOW = 20;

/**
 * `closing` prop mods run while the range is beyond this share of the window's far edge.
 */
export const PILOT_PROP_MODS_CLOSING_SHARE = 1.1;

/**
 * A disengaged ship waits this far off its nearest friend (keep at range).
 */
export const PILOT_WAIT_RANGE = 2500;

export interface ShipPilotSelf extends PilotContact {
  /**
   * HP left over its total, 0..1.
   */
  readonly health: number;
  /**
   * Its order (the pending one, else the applied one).
   */
  readonly order?: Maybe<ShipOrder>;
}

export interface ShipPilotPicture {
  readonly self: ShipPilotSelf;
  /**
   * Its focus (own target, the group's primary, the nearest hostile); null when there is none.
   */
  readonly focus?: Maybe<PilotContact>;
  /**
   * The stance's `on` ship (a lever's target, a support's friend), resolved; null flies on the focus.
   */
  readonly anchor?: Maybe<PilotContact>;
  /**
   * An align stance's `to`, resolved to a point (origin-relative metres); null aligns away from the hostiles.
   */
  readonly alignTo?: Maybe<SceneVector>;
  readonly hostiles: readonly PilotContact[];
  readonly friends: readonly PilotContact[];
  /**
   * HP per second friendly logi put on it.
   */
  readonly incomingReps?: number;
  /**
   * Hostiles that shot it and the second each last did.
   */
  readonly attackedBy?: readonly { readonly id: string; readonly at: number }[];
  /**
   * Scene seconds (whole ticks).
   */
  readonly now: number;
}

export interface ShipPilotMemory {
  readonly ideal?: Maybe<IdealRange>;
  readonly idealAt?: number;
  readonly focus?: Maybe<string>;
  readonly hostiles?: number;
  readonly health?: number;
  /**
   * Burning out or waiting, below its disengage fraction; the hostiles that had shot it then.
   */
  readonly disengaged?: boolean;
  readonly shooters?: readonly string[];
  readonly state?: ShipPilotState;
}

export interface OrderShipCall {
  readonly tool: 'order_ship';
  readonly args: { readonly id: string; readonly order: ShipOrder };
  readonly why: string;
}

export interface SwitchPropModsCall {
  readonly tool: 'switch_prop_mods';
  readonly args: { readonly ships: readonly string[]; readonly active: boolean };
  readonly why: string;
}

export type ShipPilotCall = OrderShipCall | SwitchPropModsCall;

export interface ShipPilotStep {
  readonly calls: readonly ShipPilotCall[];
  readonly memory: ShipPilotMemory;
  readonly state: ShipPilotState;
  readonly why: string;
  readonly ideal?: Maybe<IdealRange>;
}

export interface ShipPilotInput {
  readonly picture: ShipPilotPicture;
  readonly stance: PilotStance;
  readonly memory?: Maybe<ShipPilotMemory>;
  readonly refreshTicks?: number;
}

interface PilotIntent {
  readonly order?: Maybe<ShipOrder>;
  /**
   * A direction to fly (given again once it turns past REAIM_DEGREES).
   */
  readonly direction?: Maybe<SceneVector>;
  readonly propMod?: Maybe<boolean>;
  readonly state: ShipPilotState;
  readonly why: string;
}

/**
 * A stance's range as metres or a band, from the ship's own numbers for a keyword; null for `ideal`.
 *
 * @param range - The stance's range.
 * @param self - The ship.
 * @returns Metres, a band, or null.
 */
export function stanceRangeOf(range: ShipStanceRange, self: PilotContact): Maybe<number | readonly [number, number]> {
  const { weapons, tackle, lockRange, reps } = self.profile;
  const firstTurret = weapons.find((weapon) => weapon.kind !== 'missile' && weapon.dps > 0);
  let metres: Maybe<number | readonly [number, number]> = null;
  if (typeof range === 'number' || Array.isArray(range)) metres = range as number | readonly [number, number];
  else if (range === 'optimal') metres = firstTurret?.optimal ?? maxWeaponReachOf(weapons);
  else if (range === 'falloff') metres = firstTurret ? firstTurret.optimal + firstTurret.falloff : maxWeaponReachOf(weapons);
  else if (range === 'lock') metres = 0.9 * lockRange;
  else if (range === 'point') metres = 0.9 * tackleRangeOf(tackle);
  else if (range === 'scram') metres = 0.9 * (tackle.scram ?? tackleRangeOf(tackle));
  else if (range === 'web') metres = 0.9 * (tackle.web ?? tackleRangeOf(tackle));
  else if (range === 'reps') metres = repairReachOf(reps);
  return metres;
}

function isOrderChange(wanted: ShipOrder, current: Maybe<ShipOrder>): boolean {
  return JSON.stringify(wanted) !== JSON.stringify(current ?? null);
}

/**
 * Whether the ideal needs computing again: none yet, a new focus, more hostiles, an HP drop, or its refresh is due.
 *
 * @param input - The step's input.
 * @param focus - The focus id.
 * @returns True to refresh.
 */
function isIdealStale(input: ShipPilotInput, focus: string): boolean {
  const { picture, memory } = input;
  const refresh = input.refreshTicks ?? PILOT_REFRESH_TICKS;
  return !memory?.ideal || memory.focus !== focus || (memory.hostiles ?? 0) < picture.hostiles.length || (memory.health ?? 1) - picture.self.health > PILOT_REFRESH_HEALTH_DROP || picture.now - (memory.idealAt ?? Number.NEGATIVE_INFINITY) >= refresh;
}

/**
 * The prop mod state a stance wants: never off, always on, closing on while closing beyond the window, auto the
 * ideal's choice in the window and on while moving between ranges.
 *
 * @param stance - The stance.
 * @param moving - Whether the ship is closing, kiting away or burning out.
 * @param ideal - Its ideal (in the window).
 * @returns On or off.
 */
function wantedPropModOf(stance: PilotStance, moving: boolean, ideal: Maybe<IdealRange>): boolean {
  let on: boolean;
  if (stance.propMods === 'never') on = false;
  else if (stance.propMods === 'always') on = true;
  else if (stance.propMods === 'closing') on = moving;
  else on = moving || (ideal?.propMod ?? false);
  return on;
}

/**
 * The disengage check: below the stance's fraction the ship burns out until out of every hostile's reach, then waits
 * on its nearest friend; it re-engages at disengage + REENGAGE_MARGIN HP, or once every hostile that shot it in the
 * last PILOT_SHOOTER_WINDOW seconds is gone.
 *
 * @param input - The step's input.
 * @returns The intent and the memory's disengage state; null intent when the ship fights.
 */
function disengageOf(input: ShipPilotInput): { readonly intent: Maybe<PilotIntent>; readonly disengaged: boolean; readonly shooters: readonly string[] } {
  const { picture, stance, memory } = input;
  const { self, hostiles, friends, now } = picture;
  const recentShooters = (picture.attackedBy ?? []).filter((shot) => now - shot.at <= PILOT_SHOOTER_WINDOW).map((shot) => shot.id);
  let disengaged = memory?.disengaged ?? false;
  let shooters = memory?.shooters ?? [];
  if (!disengaged && self.health <= stance.disengage && hostiles.length) {
    disengaged = true;
    shooters = recentShooters;
  } else if (disengaged) {
    const present = new Set(hostiles.map((hostile) => hostile.id));
    if (self.health >= stance.disengage + REENGAGE_MARGIN || !shooters.some((id) => present.has(id))) [disengaged, shooters] = [false, []];
  }
  let intent: Maybe<PilotIntent> = null;
  if (disengaged) {
    if (isOutOfReachOf(self, hostiles)) {
      const nearest = [...friends].sort((a, b) => surfaceDistanceOf(self, a) - surfaceDistanceOf(self, b))[0];
      const order: ShipOrder = nearest ? { type: 'keep-at-range', target: nearest.id, range: PILOT_WAIT_RANGE, speed: 1 } : { type: 'stop' };
      const on = nearest ? ' on ' + nearest.id : '';
      intent = { order, propMod: false, state: 'waiting', why: `out of reach at ${Math.round(self.health * 100)} % HP; waiting${on} to re-engage at ${Math.round((stance.disengage + REENGAGE_MARGIN) * 100)} %` };
    } else {
      intent = { direction: burnOutDirectionOf(self, hostiles), propMod: true, state: 'disengaging', why: `burning out at ${Math.round(self.health * 100)} % HP (disengage ${Math.round(stance.disengage * 100)} %)` };
    }
  }
  return { intent, disengaged, shooters };
}

/**
 * A lever's intent: orbit, keep at range on or approach its ship, the order's range at the band's middle.
 *
 * @param input - The step's input.
 * @param target - The lever's ship.
 * @returns The intent.
 */
function leverIntentOf(input: ShipPilotInput, target: PilotContact): PilotIntent {
  const { picture, stance } = input;
  const { self } = picture;
  const type = stance.type as 'orbit' | 'keep-at-range' | 'approach';
  const metres = stanceRangeOf(stance.range, self) ?? stanceRangeOf('optimal', self) ?? 0;
  const band = leverBandOf(metres);
  const distance = surfaceDistanceOf(self, target);
  const moving = distance > PILOT_PROP_MODS_CLOSING_SHARE * band[1];
  const propMod = wantedPropModOf(stance, moving, null);
  const order = leverOrderOf({ type, self, target, band, propModOn: propMod && canRunPropModOf(self.profile, self.scrammed) });
  const held = self.order?.type === order.type && 'target' in self.order && self.order.target === target.id;
  const inBand = distance >= band[0] && distance <= band[1];
  return { order: held && inBand ? null : order, propMod, state: type === 'orbit' ? 'orbiting' : type === 'approach' ? 'closing' : 'holding', why: `${type} ${target.id} in ${describeMetres(band[0])}-${describeMetres(band[1])} (at ${describeMetres(distance)})` };
}

/**
 * A support intent: fly to a point behind its friend from the hostiles, then keep at range on the friend inside
 * repair reach.
 *
 * @param input - The step's input.
 * @param friend - The friend it supports.
 * @returns The intent.
 */
function supportIntentOf(input: ShipPilotInput, friend: PilotContact): PilotIntent {
  const { picture, stance } = input;
  const { self, hostiles } = picture;
  const reach = stanceRangeOf(stance.range === 'ideal' ? 'reps' : stance.range, self);
  const reachMetres = (typeof reach === 'number' ? reach : reach ? (reach[0] + reach[1]) / 2 : 0) || 10_000;
  const { point, range } = supportPointOf({ self, friend, hostiles, reach: reachMetres });
  const off = vectorLength([point[0] - self.position[0], point[1] - self.position[1], point[2] - self.position[2]]);
  let intent: PilotIntent;
  if (off > SUPPORT_POINT_SLACK_SHARE * reachMetres) intent = { order: { type: 'goto', point, speed: 1 }, propMod: wantedPropModOf(stance, true, null), state: 'closing', why: `support: to a point ${describeMetres(range)} behind ${friend.id} from the hostiles` };
  else {
    const order: ShipOrder = { type: 'keep-at-range', target: friend.id, range: Math.round(range), speed: 1 };
    intent = { order, propMod: wantedPropModOf(stance, false, null), state: 'holding', why: `support: keep ${friend.id} at ${describeMetres(range)}, inside repair reach` };
  }
  return intent;
}

/**
 * A fighting intent around the ideal: in the window orbit at the ideal's order (when the ship dictates and the ideal
 * orbits) or keep at range; too close kite away (kite, snipe); too far close in, spiralling while the focus can shoot.
 *
 * @param input - The step's input.
 * @param focus - The focus.
 * @param ideal - The ideal.
 * @returns The intent.
 */
function fightIntentOf(input: ShipPilotInput, focus: PilotContact, ideal: IdealRange): PilotIntent {
  const { picture, stance } = input;
  const { self } = picture;
  const range = stanceRangeOf(stance.range, self);
  const window = range == null ? ideal.window : leverBandOf(range);
  const target = range == null ? ideal.ideal : (window[0] + window[1]) / 2;
  const distance = relativeMotionOf(self, focus).distance;
  const orbit = ideal.posture === 'orbit' && ideal.dictates === 'self';
  let intent: PilotIntent;
  if (ideal.disengage) intent = { direction: burnOutDirectionOf(self, picture.hostiles), propMod: true, state: 'disengaging', why: `burning out: ${ideal.why}` };
  else if (distance < window[0] && (ideal.type === 'kite' || ideal.type === 'snipe')) intent = { direction: kiteAwayDirectionOf(self, focus), propMod: wantedPropModOf(stance, true, ideal), state: 'kiting', why: `${focus.id} at ${describeMetres(distance)} is inside ${describeMetres(window[0])}: kite away` };
  else if (distance > PILOT_PROP_MODS_CLOSING_SHARE * window[1] || (distance > window[1] && !(self.order && 'target' in self.order && self.order.target === focus.id))) {
    const spiral = distance <= maxWeaponReachOf(focus.profile.weapons);
    intent = { direction: closeInDirectionOf(self, focus, spiral), propMod: wantedPropModOf(stance, true, ideal), state: 'closing', why: `${focus.id} at ${describeMetres(distance)} is beyond ${describeMetres(window[1])}: ${spiral ? 'spiral in' : 'close in'}` };
  } else {
    let order: ShipOrder;
    if (range != null) order = leverOrderOf({ type: orbit ? 'orbit' : 'keep-at-range', self, target: focus, band: window, propModOn: ideal.propMod });
    else if (orbit) order = { type: 'orbit', target: focus.id, range: ideal.ordered, speed: 1 };
    else order = { type: 'keep-at-range', target: focus.id, range: Math.round(target), speed: 1 };
    const held = self.order?.type === order.type && 'target' in self.order && self.order.target === focus.id && distance >= window[0] && distance <= window[1];
    intent = { order: held ? null : order, propMod: wantedPropModOf(stance, false, ideal), state: orbit ? 'orbiting' : 'holding', why: `${ideal.why}; window ${describeMetres(window[0])}-${describeMetres(window[1])}` };
  }
  return intent;
}

/**
 * An align stance: a direction toward its `to` (else straight away from the hostiles' centre, else on along its
 * velocity), re-aimed past REAIM_DEGREES, the prop mod per the stance; aligned once its speed along that line is
 * ALIGNED_SPEED_SHARE of its top speed now, so a warp then leaves at once. Disengage does not apply: it already flies out.
 */
function alignIntentOf(input: ShipPilotInput): PilotIntent {
  const { picture, stance } = input;
  const { self, alignTo, hostiles } = picture;
  let direction: SceneVector;
  let where: string;
  if (alignTo && vectorLength(subtractVectors(alignTo, self.position)) > self.radius) {
    direction = unitVector(subtractVectors(alignTo, self.position));
    where = `toward ${typeof stance.to === 'string' ? stance.to : 'its point'}`;
  } else if (hostiles.length) {
    const centre = scaleVector(
      hostiles.reduce<SceneVector>((sum, hostile) => [sum[0] + hostile.position[0], sum[1] + hostile.position[1], sum[2] + hostile.position[2]], [0, 0, 0]),
      1 / hostiles.length
    );
    direction = unitVector(subtractVectors(self.position, centre), unitVector(self.velocity));
    where = 'away from the hostiles';
  } else {
    direction = unitVector(self.velocity);
    where = 'on its heading (nothing to align to or from)';
  }
  const along = dotVectors(self.velocity, direction);
  const top = flightOf(self.profile, self.propModOn, self.scrammed).speed * (self.webFactor ?? 1);
  const aligned = top > 0 && along >= ALIGNED_SPEED_SHARE * top;
  return { direction, propMod: wantedPropModOf(stance, true, null), state: aligned ? 'aligned' : 'aligning', why: `align ${where}: ${Math.round(along)} of ${Math.round(top)} m/s along the line${aligned ? ', aligned' : ''}` };
}

/**
 * One pilot's step.
 *
 * @param input - Its picture, resolved stance, memory and refresh interval.
 * @returns The calls to make, the new memory, its state and why.
 */
export function stepShipPilot(input: ShipPilotInput): ShipPilotStep {
  const { picture, stance, memory } = input;
  const { self, focus, anchor, now } = picture;
  const disengage = disengageOf(input);
  let ideal: Maybe<IdealRange> = memory?.ideal ?? null;
  let idealAt = memory?.idealAt;
  let intent: PilotIntent;
  if (stance.type === 'align') intent = alignIntentOf(input);
  else if (disengage.intent) intent = disengage.intent;
  else if (stance.type === 'hold') intent = { order: self.order?.type === 'stop' ? null : { type: 'stop' }, propMod: false, state: 'holding', why: 'hold: stop where it is' };
  else if (isLeverStanceType(stance.type)) {
    const target = anchor ?? focus;
    intent = target ? leverIntentOf(input, target) : { state: 'idle', why: `${stance.type}: nothing to fly on` };
  } else if (stance.type === 'support') {
    const friend = anchor ?? [...picture.friends].sort((a, b) => surfaceDistanceOf(self, a) - surfaceDistanceOf(self, b))[0];
    intent = friend ? supportIntentOf(input, friend) : { state: 'idle', why: 'support: no friend to support' };
  } else if (focus) {
    if (isIdealStale(input, focus.id)) {
      ideal = idealRangeOf({ self, focus, hostiles: picture.hostiles, incomingReps: picture.incomingReps, type: stance.type as IdealStanceType | 'auto', propMods: stance.propMods });
      idealAt = now;
    }
    intent = ideal ? fightIntentOf(input, focus, ideal) : { state: 'idle', why: `${stance.type}: no range can be held on ${focus.id}` };
  } else {
    intent = { state: 'idle', why: 'no focus' };
  }
  const calls: ShipPilotCall[] = [];
  const direction = intent.direction;
  if (direction && isReaim(direction, self.order)) calls.push({ tool: 'order_ship', args: { id: self.id, order: { type: 'direction', direction, speed: 1 } }, why: intent.why });
  if (intent.order && isOrderChange(intent.order, self.order)) calls.push({ tool: 'order_ship', args: { id: self.id, order: intent.order }, why: intent.why });
  const canRun = canRunPropModOf(self.profile, self.scrammed);
  if (intent.propMod != null && canRun && intent.propMod !== self.propModOn) calls.push({ tool: 'switch_prop_mods', args: { ships: [self.id], active: intent.propMod }, why: `prop mod ${intent.propMod ? 'on' : 'off'}: ${intent.why}` });
  return {
    calls,
    memory: { ideal, idealAt, focus: focus?.id ?? null, hostiles: picture.hostiles.length, health: idealAt === now ? self.health : (memory?.health ?? self.health), disengaged: disengage.disengaged, shooters: disengage.shooters, state: intent.state },
    state: intent.state,
    why: intent.why,
    ideal
  };
}
