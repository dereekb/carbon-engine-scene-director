/**
 * The scene's script (the document's `timeline`): cues at a scene time, each running one existing lever the way its
 * MCP tool does. A cue is `{ id, at, name?, <action>: <the tool's arguments> }`: `at` is seconds from play start and
 * fires on the first Destiny tick at or after it, and the action key is the lever tool's name. Ships carry their own
 * ordered `orders` (steps.ts). Validation projects the patch cues in time order (projection.ts), so a cue may command a
 * fleet an earlier cue adds.
 *
 * This module holds the types and limits only and imports nothing at run time: the rest of the folder and `../scene`
 * import each other.
 */

import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../json';
import type { ShipOrderRequest } from '../orders';
import type { FleetOrderRequest } from '../fleets/orders';
import type { PropModSwitch } from '../prop-mods/switch';
import type { ModuleSwitch } from '../fitting/switch';
import type { TargetCommand } from '../weapons/target';
import type { CeaseFireCommand, EngageCommand } from '../combat/commands';
import type { AutoRepairCommand } from '../logi/auto-repair';
import type { AutoCameraCommand } from '../cinema/director/command';

/**
 * Seconds: the latest a cue may fire, and the longest a ship step may wait or last (a day).
 */
export const MAX_TIMELINE_SECONDS = 86_400;

/**
 * The most cues a timeline holds.
 */
export const MAX_TIMELINE_CUES = 1000;

/**
 * The most patch_scene cues a timeline holds: each costs a projection step on every normalize.
 */
export const MAX_PATCH_CUES = 50;

/**
 * The most operations one patch_scene cue carries.
 */
export const MAX_CUE_OPERATIONS = 32;

/**
 * The most steps a ship's `orders` holds.
 */
export const MAX_SHIP_STEPS = 64;

/**
 * Metres, ball centre to point: a goto step is done within this range once slower than SCRIPT_STOPPED_SPEED (Destiny's
 * goto creeps to a halt tens of metres short of its point).
 */
export const SCRIPT_GOTO_ARRIVAL_RANGE = 1000;

/**
 * Metres, ball centre to point: a goto step is done within this range at any speed.
 */
export const SCRIPT_GOTO_CLOSE_RANGE = 100;

/**
 * Metres per second: a stop step is done below this speed (Destiny's stop never reaches exactly zero).
 */
export const SCRIPT_STOPPED_SPEED = 1;

/**
 * The levers a cue can pull, each named after its MCP tool.
 */
export const TIMELINE_ACTION_NAMES = ['order_ship', 'order_fleet', 'switch_prop_mods', 'switch_modules', 'set_target', 'engage', 'cease_fire', 'auto_repair', 'play_shot', 'play_sequence', 'stop_shot', 'auto_camera', 'patch_scene'] as const;

export type TimelineActionName = (typeof TIMELINE_ACTION_NAMES)[number];

/**
 * What a cue's action touches when it fires: `live` state (orders, switches, locks: never saved), the `camera`, or the
 * `document` (a patch, an anchor order, auto-repair), which the page applies to the live scene only.
 */
export const TIMELINE_ACTION_KINDS = ['live', 'camera', 'document'] as const;

export type TimelineActionKind = (typeof TIMELINE_ACTION_KINDS)[number];

/**
 * The patch ops that edit the timeline; a patch_scene cue may not carry them.
 */
export const TIMELINE_OPERATION_NAMES = ['add_cue', 'update_cue', 'remove_cue', 'set_timeline', 'clear_timeline'] as const;

/**
 * order_ship's arguments: the ship and its order.
 */
export interface OrderShipCueAction {
  readonly id: string;
  readonly order: ShipOrderRequest;
}

/**
 * stop_shot's arguments.
 */
export interface StopShotCueAction {
  readonly pause?: boolean;
  readonly adopt?: boolean;
  readonly cut?: boolean;
}

/**
 * patch_scene's arguments: the operations, stored as written (they apply when the cue fires).
 */
export interface PatchSceneCueAction {
  readonly operations: JsonObject[];
}

/**
 * Each action's value: the tool's arguments without `at` and `cue`. The levers with a plain-request normalizer store
 * it normalized; camera shots are stored as written (a library shot expands when it plays).
 */
export interface TimelineActionArgs {
  readonly order_ship: OrderShipCueAction;
  readonly order_fleet: FleetOrderRequest;
  readonly switch_prop_mods: PropModSwitch;
  readonly switch_modules: ModuleSwitch;
  readonly set_target: TargetCommand;
  readonly engage: EngageCommand;
  readonly cease_fire: CeaseFireCommand;
  readonly auto_repair: AutoRepairCommand;
  readonly play_shot: JsonObject;
  readonly play_sequence: JsonObject;
  readonly stop_shot: StopShotCueAction;
  readonly auto_camera: AutoCameraCommand;
  readonly patch_scene: PatchSceneCueAction;
}

/**
 * The ids a patch_scene cue adds, derived at normalize and pinned on the cue: an edit that would take one of them is
 * refused. Wings and squads are `<fleet>/<id>` keys.
 */
export interface SceneCueAdds {
  readonly ships?: string[];
  readonly objects?: string[];
  readonly fleets?: string[];
  readonly wings?: string[];
  readonly squads?: string[];
}

export const SCENE_CUE_ADDS_KEYS = ['ships', 'objects', 'fleets', 'wings', 'squads'] as const;

export type SceneCueAddsKey = (typeof SCENE_CUE_ADDS_KEYS)[number];

export interface SceneCueBase {
  /**
   * Unique in the timeline; a missing id gets the lowest free `cue-<n>`.
   */
  readonly id: string;
  /**
   * Seconds from play start, in [0, MAX_TIMELINE_SECONDS]; fires on the first tick at or after it (cueDueSecond).
   */
  readonly at: number;
  readonly name?: string;
  /**
   * patch_scene cues only: what the patch adds (derived).
   */
  readonly adds?: SceneCueAdds;
}

/**
 * One cue: the base plus exactly one action key.
 */
export type SceneCue = { [K in TimelineActionName]: SceneCueBase & { readonly [P in K]: TimelineActionArgs[K] } }[TimelineActionName];

/**
 * The document's `timeline`. A bare array of cues is accepted as shorthand for `{ cues }`.
 */
export interface SceneTimeline {
  /**
   * Sorted by `at`; cues at the same time keep their document order (the order they fire in).
   */
  readonly cues: SceneCue[];
}

/**
 * A cue's action, by name.
 */
export interface SceneCueAction<K extends TimelineActionName = TimelineActionName> {
  readonly name: K;
  readonly args: TimelineActionArgs[K];
}

/**
 * The action a cue carries.
 *
 * @param cue - A normalized cue.
 * @returns Its action's name and arguments.
 */
export function cueActionOf(cue: SceneCue): SceneCueAction {
  const record = cue as unknown as Record<string, unknown>;
  const name = TIMELINE_ACTION_NAMES.find((candidate) => record[candidate] !== undefined) ?? 'patch_scene';
  return { name, args: record[name] } as SceneCueAction;
}

/**
 * The whole second of timeline time a cue fires at: the first tick at or after `at`.
 *
 * @param at - The cue's seconds from play start.
 * @returns ceil(at).
 */
export function cueDueSecond(at: number): number {
  return Math.ceil(at);
}

/**
 * A cue for messages: `"focus" (order_fleet at 25 s)`.
 *
 * @param cue - The cue's id, time and action name.
 * @returns The label.
 */
export function describeCue(cue: { readonly id: string; readonly at: number; readonly action: Maybe<string> }): string {
  return `"${cue.id}" (${cue.action ?? 'cue'} at ${cue.at} s)`;
}
