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
