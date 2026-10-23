/**
 * The client's module effects: what a running module draws and plays, by its default dogma effect's `guid`
 * (`effects.ArmorHardening`). Pure data: the page turns module cycle events into effect commands and sound posts with
 * it (module-fx.ts, module-audio.ts) and draws them (module-effects.ts).
 *
 * - `overlay`: an EveMeshOverlayEffect on the ship's hull, attached when the module starts and replayed every cycle.
 * - `beam`: an EveStretch / EveStretch3 from the ship to its target, fired when it starts and every cycle.
 * - `trigger`: an EveTransform played at the target every cycle (the stasis web).
 *
 * Paths and sound events are SDE / client build 3632936's (the res file index and the audio library).
 */

import type { Maybe } from '@dereekb/util';
import type { HullSizeClass } from '../stats/prop-mods';

export type ModuleEffectKind = 'overlay' | 'beam' | 'trigger';

/**
 * Sound events by module transition. `<size>` stands for the ship's size (S, M, L, XL) and `<duration>` for the
 * module's cycle in milliseconds, rounded to an event the library has (MODULE_EFFECT_SOUND_DURATIONS).
 */
export interface ModuleEffectSounds {
  /**
   * Posted when the module starts.
   */
  readonly on?: readonly string[];
  /**
   * Posted at every cycle after the first.
   */
  readonly cycle?: readonly string[];
  /**
   * Posted when it stops.
   */
  readonly off?: readonly string[];
  /**
   * Playing events stopped when it stops (the page's backend does not apply authored stop relationships).
   */
  readonly stops?: readonly string[];
}

export interface ModuleEffect {
  readonly guid: string;
  readonly kind: ModuleEffectKind;
  /**
   * The effect's `.black` file.
   */
  readonly resPath: string;
  readonly sounds: ModuleEffectSounds;
}

/**
 * The remote module sound's duration switches in the audio library, in milliseconds.
 */
export const MODULE_EFFECT_SOUND_DURATIONS: readonly number[] = [2500, 2700, 3000, 3600, 4000, 4500, 5000, 5400, 6000, 7200, 8000, 10000, 12000, 13000, 15000, 16000, 17280, 20000];

const OVERLAY = (name: string): string => `res:/dx9/model/effect/${name}_skinned.black`;
const MODULE_FX = (name: string): string => `res:/fisfx/module/${name}.black`;

/**
 * A remote repair beam's sounds: the size and duration switches, the event, and the shared stop.
 */
function RemoteSounds(event: string): ModuleEffectSounds {
  return { on: ['remote_shipeffect_switch_size_<size>', 'remote_shipeffect_switch_duration_<duration>', event], off: ['remote_shipeffect_stop'], stops: [event] };
}

function Effect(guid: string, kind: ModuleEffectKind, resPath: string, sounds: ModuleEffectSounds = {}): ModuleEffect {
  return { guid, kind, resPath, sounds };
}

/**
 * The module effects by dogma effect guid.
 */
export const MODULE_EFFECTS: Readonly<Record<string, ModuleEffect>> = Object.fromEntries(
  [
    Effect('effects.ShieldBoosting', 'overlay', OVERLAY('shieldboosting'), { on: ['ship_effect_<size>_shieldboost_play'], cycle: ['ship_effect_<size>_shieldboost_play'] }),
    Effect('effects.ArmorRepair', 'overlay', OVERLAY('armorrepair'), { on: ['ship_effect_<size>_armorrepair_play'], off: ['ship_effect_<size>_armorrepair_stop'], stops: ['ship_effect_<size>_armorrepair_play'] }),
    Effect('effects.StructureRepair', 'overlay', OVERLAY('hullrepair'), { on: ['ship_effect_<size>_hullrepair_play'], off: ['ship_effect_<size>_hullrepair_stop'], stops: ['ship_effect_<size>_hullrepair_play'] }),
    Effect('effects.ArmorHardening', 'overlay', OVERLAY('armorhardening'), { on: ['ship_effect_<size>_armorhardener_play'], off: ['ship_effect_<size>_armorhardener_stop'], stops: ['ship_effect_<size>_armorhardener_play'] }),
    Effect('effects.ModifyShieldResonance', 'overlay', OVERLAY('shieldhardening'), { on: ['ship_effect_<size>_shieldhardener_play'] }),
    Effect('effects.Invulnerability', 'overlay', MODULE_FX('invulnerability_ov_t1a_skinned'), { on: ['ship_effect_invulnerability_field_play'] }),
    Effect('effects.TriageMode', 'overlay', MODULE_FX('triagemode_ov_t1a_skinned'), { on: ['ship_effect_triage_overlay_play'] }),
    Effect('effects.RemoteArmourRepair', 'beam', MODULE_FX('remotearmorrepair_st_t1a'), RemoteSounds('remote_armorrepair')),
    Effect('effects.ShieldTransfer', 'beam', MODULE_FX('shieldtransfer_st_t1a'), RemoteSounds('remote_shieldbooster')),
    Effect('effects.RemoteHullRepair', 'beam', MODULE_FX('remotehullrepair_st_t1a'), RemoteSounds('remote_hullrepair')),
    Effect('effects.EnergyTransfer', 'beam', MODULE_FX('energytransfer_st_t1a')),
    Effect('effects.WarpScramble', 'beam', MODULE_FX('warpscrambler_st_t1a')),
    Effect('effects.WarpDisrupt', 'beam', MODULE_FX('warpdisruptor_st_t1a')),
    Effect('effects.EnergyDestabilization', 'beam', MODULE_FX('energydestabilization_st_t1a')),
    Effect('effects.EnergyVampire', 'beam', MODULE_FX('energyvampire_st_t1a')),
    Effect('effects.ModifyTargetSpeed', 'trigger', MODULE_FX('stasisweb_tr_t1a'))
  ].map((effect) => [effect.guid, effect])
);

/**
 * A module's effect.
 *
 * @param guid - Its default dogma effect's guid.
 * @returns The effect; null for one the page does not draw (weapons, prop mods, siege, command bursts, ...).
 */
export function moduleEffectOf(guid: Maybe<string>): Maybe<ModuleEffect> {
  return guid ? (MODULE_EFFECTS[guid] ?? null) : null;
}

export type ModuleEffectTransition = 'on' | 'cycle' | 'off';

export interface ModuleEffectSoundInput {
  readonly size: HullSizeClass;
  /**
   * Seconds.
   */
  readonly cycleTime: number;
}

/**
 * The sound events a module transition posts, and the playing events it stops.
 *
 * @param effect - The module's effect.
 * @param transition - Started, a new cycle, or stopped.
 * @param input - The ship's size and the module's cycle.
 * @returns The events and stops, with their placeholders filled in.
 */
export function moduleEffectSounds(effect: ModuleEffect, transition: ModuleEffectTransition, input: ModuleEffectSoundInput): { readonly events: string[]; readonly stops: string[] } {
  const duration = nearestSoundDuration(input.cycleTime * 1000);
  const fill = (event: string): string => event.replace('<size>', input.size).replace('<duration>', String(duration));
  const { sounds } = effect;
  return { events: (sounds[transition] ?? []).map(fill), stops: transition === 'off' ? (sounds.stops ?? []).map(fill) : [] };
}

/**
 * The duration switch nearest a cycle.
 *
 * @param ms - The cycle, in milliseconds.
 * @returns One of MODULE_EFFECT_SOUND_DURATIONS.
 */
export function nearestSoundDuration(ms: number): number {
  return MODULE_EFFECT_SOUND_DURATIONS.reduce((best, duration) => (Math.abs(duration - ms) < Math.abs(best - ms) ? duration : best));
}
