import type { Maybe } from '@dereekb/util';
import { MAX_SCENE_DISTANCE, MIN_WARP_DISTANCE, type SceneVector, type ShipStanceRange } from '@scene-director/scene';
import { SCENARIO_RETREAT_AWAY, type ScenarioRetreat } from './scenario/scenario';
import { type BattleFleetView, fleetCommandsBlocked } from './views';

/**
 * The fleet panel's buttons, each one tool call (sd-console "Commands").
 */
export const FLEET_COMMANDS = ['engage', 'hold-position', 'pull-range', 'dive-close', 'retreat', 'warp-out', 'hold-fire', 'call-primary', 'clear-call'] as const;

export type FleetCommand = (typeof FLEET_COMMANDS)[number];

/**
 * The share of the 10,000 km scene extent a warp-out point is clamped inside.
 */
export const WARP_OUT_EXTENT_SHARE = 0.95;

/**
 * How far an `away` retreat aligns and warps out, metres from the FC (well off grid; clamped inside the extent).
 */
export const RETREAT_AWAY_DISTANCE = 2_000_000;

export interface FleetCommandInput {
  readonly command: FleetCommand;
  readonly fleet: BattleFleetView;
  /**
   * call-primary: the hostile to call.
   */
  readonly target?: string;
  /**
   * pull-range: ideal (default: the kite's own), falloff, lock or metres.
   */
  readonly range?: ShipStanceRange;
  /**
   * retreat and warp-out: the fleet's out (its settings' retreat); `away` (the default) flies from the nearest enemy.
   */
  readonly retreat?: ScenarioRetreat;
  /**
   * The other fleets, for `away`.
   */
  readonly fleets?: readonly BattleFleetView[];
}

/**
 * One page tool call (ViewerApi.Call).
 */
export interface FleetCommandCall {
  readonly tool: 'order_fleet' | 'cease_fire';
  readonly args: Record<string, unknown>;
}

/**
 * A command that cannot run now (the bar is off, a missing target, nowhere to retreat).
 */
export class FleetCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetCommandError';
  }
}

/**
 * The tool call a fleet button makes: you steer, the brain shoots. Engage hands everything back (order_fleet engage);
 * Hold position, Pull range, Dive close and Retreat set a stance (move and prop mods held, calls and free fire go on);
 * Warp out warps to the out (a point clamped inside the extent); Hold fire is cease_fire; Call primary lends only the
 * call lever until the target is gone, and Clear returns it.
 *
 * @param input - The command, the fleet and what the command needs.
 * @returns The call.
 * @throws {FleetCommandError} When the command cannot run now.
 */
export function toFleetCommandCall(input: FleetCommandInput): FleetCommandCall {
  const { command, fleet } = input;
  const blocked = fleetCommandsBlocked(fleet);

  if (blocked) {
    throw new FleetCommandError(`${fleet.name ?? fleet.id}: ${blocked}`);
  }

  const order = (body: Record<string, unknown>): FleetCommandCall => ({ tool: 'order_fleet', args: { fleet: fleet.id, order: body } });
  let call: FleetCommandCall;

  switch (command) {
    case 'engage':
      call = order({ type: 'engage' });
      break;
    case 'hold-position':
      call = order({ type: 'stance', set: { type: 'hold' } });
      break;
    case 'pull-range':
      call = order({ type: 'stance', set: { type: 'kite', ...(input.range == null ? {} : { range: input.range }), propMods: 'auto' } });
      break;
    case 'dive-close':
      call = order({ type: 'stance', set: { type: 'brawl', propMods: 'always' } });
      break;
    case 'retreat':
      call = order({ type: 'stance', set: { type: 'align', to: retreatAlignTo(input), propMods: 'always' } });
      break;
    case 'warp-out':
      call = order({ type: 'warp', ...warpOutTarget(input) });
      break;
    case 'hold-fire':
      call = { tool: 'cease_fire', args: { fleet: fleet.id } };
      break;
    case 'call-primary':
      if (!input.target) {
        throw new FleetCommandError('call-primary needs a target');
      }

      call = order({ type: 'targets', primary: input.target, until: 'gone' });
      break;
    case 'clear-call':
      call = order({ type: 'targets', clear: true, until: 'gone' });
      break;
  }

  return call;
}

function retreatAlignTo(input: FleetCommandInput): string | SceneVector {
  const retreat = input.retreat ?? SCENARIO_RETREAT_AWAY;
  return retreat === SCENARIO_RETREAT_AWAY ? awayPoint(input) : retreat;
}

function warpOutTarget(input: FleetCommandInput): { readonly target: string } | { readonly point: SceneVector } {
  const retreat = input.retreat ?? SCENARIO_RETREAT_AWAY;
  let target: { readonly target: string } | { readonly point: SceneVector };

  if (typeof retreat === 'string' && retreat !== SCENARIO_RETREAT_AWAY) {
    target = { target: retreat };
  } else {
    const fc = fcPosition(input.fleet);
    const point = clampWarpOutPoint(fc, retreat === SCENARIO_RETREAT_AWAY ? awayPoint(input) : (retreat as SceneVector));

    if (distance(fc, point) < MIN_WARP_DISTANCE) {
      throw new FleetCommandError(`the out is within ${MIN_WARP_DISTANCE / 1000} km of the FC: too close to warp to`);
    }

    target = { point };
  }

  return target;
}

/**
 * A point RETREAT_AWAY_DISTANCE from the FC straight away from the nearest other-team fleet's FC, inside the extent.
 *
 * @param input - The command input (its fleet and the other fleets).
 * @returns The point.
 * @throws {FleetCommandError} With no enemy fleet in view.
 */
function awayPoint(input: FleetCommandInput): SceneVector {
  const fc = fcPosition(input.fleet);
  const enemies = (input.fleets ?? []).filter((other) => other.id !== input.fleet.id && other.fcMotion && (input.fleet.team == null || other.team !== input.fleet.team));
  let nearest: Maybe<SceneVector>;

  for (const enemy of enemies) {
    const position = enemy.fcMotion?.position;

    if (position && (!nearest || distance(fc, position) < distance(fc, nearest))) {
      nearest = position;
    }
  }

  if (!nearest) {
    throw new FleetCommandError('no enemy fleet to retreat from: set a retreat in the fleet settings');
  }

  const away = subtract(fc, nearest);
  const length = Math.hypot(...away);
  const direction: SceneVector = length > 0 ? [away[0] / length, away[1] / length, away[2] / length] : [0, 0, -1];
  return clampWarpOutPoint(fc, [fc[0] + direction[0] * RETREAT_AWAY_DISTANCE, fc[1] + direction[1] * RETREAT_AWAY_DISTANCE, fc[2] + direction[2] * RETREAT_AWAY_DISTANCE]);
}

/**
 * The out as a warp point: the out itself when it lies inside WARP_OUT_EXTENT_SHARE of the scene extent, else the point
 * where the line from the FC to it leaves that sphere.
 *
 * @param from - The FC's position.
 * @param to - The out.
 * @returns The point, inside the extent.
 */
export function clampWarpOutPoint(from: SceneVector, to: SceneVector): SceneVector {
  const limit = MAX_SCENE_DISTANCE * WARP_OUT_EXTENT_SHARE;
  let point: SceneVector = to;

  if (Math.hypot(...to) > limit) {
    const d = subtract(to, from);
    const a = dot(d, d);
    const b = dot(from, d);
    const c = dot(from, from) - limit * limit;
    const t = a > 0 ? Math.min(1, (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a) : 0;
    point = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
  }

  return point;
}

function fcPosition(fleet: BattleFleetView): SceneVector {
  const position = fleet.fcMotion?.position;

  if (!position) {
    throw new FleetCommandError(`${fleet.name ?? fleet.id}: its FC's position is not known yet`);
  }

  return position;
}

function subtract(a: SceneVector, b: SceneVector): SceneVector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: SceneVector, b: SceneVector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(a: SceneVector, b: SceneVector): number {
  return Math.hypot(...subtract(a, b));
}
