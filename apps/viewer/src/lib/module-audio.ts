/**
 * Module effect commands → the sound events posted on the module's ship (effects.ts's sounds): the hull's size picks
 * the `ship_effect_<size>_*` events, the cycle picks a remote repair's duration switch, and a stop stops the loops the
 * start began (the page's audio backend does not apply authored stop relationships). A beam's sound plays on its
 * source ship. The stretch controllers' own sounds are never triggered (module-effects.ts), so nothing plays twice.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import { moduleEffectSounds, type HullSizeClass, type ModuleEffectTransition } from '@scene-director/scene';
import type { ModuleFxCommand, ModuleFxOp } from './module-fx';

const TRANSITIONS: Readonly<Record<ModuleFxOp, ModuleEffectTransition>> = { start: 'on', cycle: 'cycle', stop: 'off' };

/**
 * The sounds a module effect command posts.
 *
 * @param command - The command.
 * @param size - The ship's hull size.
 * @returns The ship whose emitter posts, the events and the playing events to stop.
 */
export function ModuleAudioPost(command: ModuleFxCommand, size: HullSizeClass): { readonly ship: string; readonly events: string[]; readonly stops: string[] } {
  const { events, stops } = moduleEffectSounds(command.effect, TRANSITIONS[command.op], { size, cycleTime: command.cycleTime });
  return { ship: command.ship, events, stops };
}
