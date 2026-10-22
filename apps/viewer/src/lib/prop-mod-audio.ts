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
 * the wind-down. Only `_on` carries the motion RTPCs and the larger L / XL radii, so the stems' static `_activate` /
 * `_idle` / `_deactivate` family stays the other choice.
 */
export const PROP_MOD_AUDIO_STAGES: Readonly<Record<PropModAudioTransition, readonly string[]>> = { on: ['on'], off: ['powerdown'] };

/**
 * The stem suffixes each transition stops on the ship's emitter, after posting its own. The library says `_powerdown`
 * stops `_on`, but the runtime's Web Audio backend leaves that stop to `_powerdown`'s authored program, which does not
 * stop the `_on` voices: the loop played on after the module went off (Windows Chrome, 2026-10-22; `_off` does not stop
 * it either). The page stops it itself, the way the runtime's metadata fallback does.
 */
export const PROP_MOD_AUDIO_STOPS: Readonly<Record<PropModAudioTransition, readonly string[]>> = { on: [], off: ['on'] };

/**
 * How long a stopped `_on` loop fades out, the runtime's own stop fade (AudGameObjResource.ApplyEventStopRelationships).
 */
export const PROP_MOD_AUDIO_STOP_FADE_MS = 1000;

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

/**
 * The playing events to stop when a prop mod switches, after its own events post.
 *
 * @param transition - On or off.
 * @param sound - The module's kind and the hull's size class.
 * @returns The event names, e.g. `ship_engine_L_microwarpdrive_3rd_on` when it switches off.
 */
export function PropModAudioStops(transition: PropModAudioTransition, sound: PropModSound): string[] {
  const stem = PropModAudioStem(sound);
  return PROP_MOD_AUDIO_STOPS[transition].map((stage) => `${stem}_${stage}`);
}
