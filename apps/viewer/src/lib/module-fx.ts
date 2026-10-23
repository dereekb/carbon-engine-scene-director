/**
 * Module events → module effect commands: which client effect (effects.ts) starts, replays or stops on which ship.
 *
 * - `start` when a module starts (its first cycle), `cycle` at every later cycle start, `stop` when it stops. A cycle
 *   that retargeted (`retargeted`: a remote repairer moved on by auto-repair) starts again, so its beam restarts on the
 *   new target with the start sounds.
 * - An overlay plays on the module's ship; a beam runs from the ship to its target; the web's trigger plays at the
 *   target. A beam or trigger without a target, and a module whose effect the page does not draw, give no command.
 * - Commands are keyed `<ship>|<module>`: module-effects.ts keeps one live effect per key.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { moduleEffectOf, type ModuleEffect } from '@scene-director/scene';
import type { ShipModuleEvent } from './modules';

export type ModuleFxOp = 'start' | 'cycle' | 'stop';

export interface ModuleFxCommand {
  readonly op: ModuleFxOp;
  /**
   * `<ship>|<module>`.
   */
  readonly key: string;
  readonly ship: string;
  readonly module: string;
  readonly effect: ModuleEffect;
  /**
   * The target ship of a beam or trigger.
   */
  readonly target?: string;
  /**
   * The module's cycle, seconds.
   */
  readonly cycleTime: number;
  readonly tick: number;
}

/**
 * The effect commands a batch of module events gives.
 *
 * @param events - Module events, in order.
 * @returns The commands, in event order.
 */
export function ModuleFxCommands(events: readonly ShipModuleEvent[]): ModuleFxCommand[] {
  const commands: ModuleFxCommand[] = [];
  for (const event of events) {
    const effect = moduleEffectOf(event.effectGuid);
    const op = FxOp(event);
    if (!effect || !op || (effect.kind !== 'overlay' && !event.target && op !== 'stop')) continue;
    commands.push({
      op,
      key: ModuleFxKey(event.ship, event.module),
      ship: event.ship,
      module: event.module,
      effect,
      ...(event.target ? { target: event.target } : {}),
      cycleTime: event.cycleTime,
      tick: event.tick
    });
  }
  return commands;
}

/**
 * A module running at a time-control landing (ShipModules.RunningEffects).
 */
export interface RunningModuleFx {
  readonly ship: string;
  readonly module: string;
  readonly effectGuid?: string;
  readonly target?: string;
  readonly cycleTime: number;
  /**
   * The master tick now.
   */
  readonly tick: number;
}

/**
 * The effects to draw again after a time-control jump (sd-time): the re-simulation drew none, so every running module
 * with a drawable effect starts it, silently (no sound posts go with them): an overlay on its ship, a beam on its target.
 * A beam without a target gives nothing, and a trigger (a one-shot at a cycle start) waits for its next cycle.
 *
 * @param running - The running modules, in fit order.
 * @returns `start` commands.
 */
export function RunningModuleFxCommands(running: readonly RunningModuleFx[]): ModuleFxCommand[] {
  const commands: ModuleFxCommand[] = [];
  for (const module of running) {
    const effect = moduleEffectOf(module.effectGuid);
    if (!effect || effect.kind === 'trigger' || (effect.kind === 'beam' && !module.target)) continue;
    commands.push({
      op: 'start',
      key: ModuleFxKey(module.ship, module.module),
      ship: module.ship,
      module: module.module,
      effect,
      ...(module.target && effect.kind === 'beam' ? { target: module.target } : {}),
      cycleTime: module.cycleTime,
      tick: module.tick
    });
  }
  return commands;
}

/**
 * The key module-effects.ts keeps a module's live effect under.
 */
export function ModuleFxKey(ship: string, module: string): string {
  return `${ship}|${module}`;
}

function FxOp(event: ShipModuleEvent): Maybe<ModuleFxOp> {
  let op: Maybe<ModuleFxOp> = null;
  if (event.kind === 'on' || (event.kind === 'cycle' && event.retargeted)) op = 'start';
  else if (event.kind === 'cycle' && event.cycle > 1) op = 'cycle';
  else if (event.kind === 'off') op = 'stop';
  return op;
}
