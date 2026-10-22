/**
 * The engine sound a prop mod plays as it switches: the EVE client's `ship_engine_<size>_<kind>_3rd` lifecycle stems
 * from the runtime's audio library, sized by the hull (S, M, L, XL).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { HullSizeClass, PropModKind } from '@scene-director/scene';

/**
 * Which way a prop mod switched.
 */
export type PropModAudioTransition = 'on' | 'off';

/**
 * The stem suffixes each transition posts, in order. `_on` plays the layered engine boost as a loop and `_powerdown`
 * stops it with the wind-down; the stems' `_activate` / `_idle` / `_deactivate` family is the other choice, for the
 * real-browser listening check to try.
 */
export const PROP_MOD_AUDIO_STAGES: Readonly<Record<PropModAudioTransition, readonly string[]>> = { on: ['on'], off: ['powerdown'] };

export interface PropModSound {
  readonly kind: PropModKind;
  readonly size: HullSizeClass;
}

/**
 * The engine stem of a prop mod.
 *
 * @param sound - The module's kind and the hull's size class.
 * @returns e.g. `ship_engine_L_microwarpdrive_3rd`.
 */
export function PropModAudioStem(sound: PropModSound): string {
  return `ship_engine_${sound.size}_${sound.kind}_3rd`;
}

/**
 * The audio events to post when a prop mod switches, whatever switched it (a switch, the document or warp).
 *
 * @param transition - On or off.
 * @param sound - The module's kind and the hull's size class.
 * @returns The event names, in order.
 */
export function PropModAudioEvents(transition: PropModAudioTransition, sound: PropModSound): string[] {
  const stem = PropModAudioStem(sound);
  return PROP_MOD_AUDIO_STAGES[transition].map((stage) => `${stem}_${stage}`);
}
