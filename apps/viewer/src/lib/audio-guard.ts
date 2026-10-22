/**
 * Keeps the runtime's Web Audio backend (CjsWebAudioSoundEngine) from throwing into the page's frames.
 *
 * The backend reschedules each playing voice's AudioParams on every emitter placement and RTPC refresh: it reads
 * `context.currentTime` once, `cancelAndHoldAtTime(now)`, `setValueAtTime(v, now)`, `param.value = v`, then one
 * `setValueCurveAtTime` per future fade boundary. Chrome throws NotSupportedError ("setValueAtTime(...) overlaps
 * setValueCurveAtTime(...)") from that pattern:
 *
 * - the audio thread moves events scheduled after a param was processed up to the next render quantum, except value
 *   curves, so the scheduler's own setValue events land inside its curve; `cancelAndHoldAtTime` then keeps the curve,
 *   and the next `setValueAtTime(now)` overlaps it;
 * - a curve's start is clamped to the live clock, which moves within a task, while its duration is kept, so a segment
 *   computed from a stale `now` can overlap the next one (and a float seam does the same in a young context).
 *
 * The throws come from inside EveSpaceScene.Update (a SOF hull's emitter placement or RTPC binding) and from
 * CjsAudioMan.Process, so one aborted the whole frame. GuardWebAudioBackend patches the backend instance:
 *
 * - each per-voice applier owns its params (VOICE_APPLIER_PARAMS), so it clears them (`cancelScheduledValues(0)`, the
 *   runtime's own branch for browsers without `cancelAndHoldAtTime`) before the runtime schedules, which ends the
 *   first kind; an overlap anyway is retried once after clearing again, and anything else is contained;
 * - every backend entry point an emitter, a controller or the page reaches (CONTAINED_BACKEND_CALLS) is contained:
 *   it reports the error and returns a neutral value.
 *
 * The guard reaches private runtime names (declared in carbonenginejs-runtime.d.ts): re-check both lists against
 * CjsWebAudioSoundEngine.js on a runtime pin bump, and drop the pre-clear once upstream schedules safely.
 */

import type { Maybe } from '@dereekb/util';
import type { CjsWebAudioSoundEngine, CjsWebAudioVoice } from './runtime';

/**
 * The backend's per-voice schedulers the guard pre-clears.
 */
export type VoiceApplier = '_ApplyVoiceGain' | '_ApplyVoicePlaybackRate' | '_ApplyVoiceFilters' | '_ApplyVoiceBusGain' | '_ApplyVoiceBusActionGain' | '_ApplyVoiceBusRtpcGain';

/**
 * The AudioParams each applier alone schedules (the stop, fade and transition gains are other nodes).
 */
export const VOICE_APPLIER_PARAMS: Readonly<Record<VoiceApplier, (voice: CjsWebAudioVoice) => readonly Maybe<AudioParam>[]>> = {
  _ApplyVoiceGain: (voice) => [voice.gain?.gain],
  _ApplyVoicePlaybackRate: (voice) => [voice.source?.playbackRate],
  _ApplyVoiceFilters: (voice) => [voice.lowPassFilter?.frequency, voice.highPassFilter?.frequency],
  _ApplyVoiceBusGain: (voice) => [voice.busGain?.gain],
  _ApplyVoiceBusActionGain: (voice) => [voice.busVoiceActionGain?.gain],
  _ApplyVoiceBusRtpcGain: (voice) => [voice.busVoiceGain?.gain]
};

/**
 * The backend calls Tr2ActionPlaySound, Tr2ActionSetAudioSwitch, Tr2ActionBindRTPC, TriObserverLocal, turret FX,
 * AudParameter and the page reach.
 */
export type ContainedBackendCall = 'PostEvent' | 'ExecuteActionOnPlayingID' | 'SetPosition' | 'SetListenerPosition' | 'SetScalingFactor' | 'SetRTPCValue' | 'SetSwitch' | 'SeekOnEventPercent' | 'SeekOnEventMs';

export const CONTAINED_BACKEND_CALLS: readonly ContainedBackendCall[] = ['PostEvent', 'ExecuteActionOnPlayingID', 'SetPosition', 'SetListenerPosition', 'SetScalingFactor', 'SetRTPCValue', 'SetSwitch', 'SeekOnEventPercent', 'SeekOnEventMs'];

/**
 * What a contained call returns: PostEvent's INVALID_PLAYING_ID, else nothing (callers test `=== true` / `=== false`).
 */
const CONTAINED_RESULTS: Readonly<Partial<Record<ContainedBackendCall, unknown>>> = { PostEvent: 0 };

export interface WebAudioGuardOptions {
  /**
   * An applier hit an automation overlap, and its retry after clearing again went through.
   */
  readonly onRescheduled: (error: unknown, applier: VoiceApplier) => void;
  /**
   * A backend call threw and was swallowed; `where` names the applier or the entry point.
   */
  readonly onContained: (error: unknown, where: string) => void;
}

/**
 * A backend member as the guard holds it: called through Reflect.apply with the backend as `this`.
 */
type BackendMember = (this: unknown, ...args: never[]) => unknown;

const GUARDED = new WeakSet<object>();

/**
 * Patches a backend instance so no audio throw escapes it (see the module doc). Idempotent per backend.
 *
 * @param backend - CjsAudioMan.backend, the instance emitters reach as AudGameObjResource.backend.
 * @param options - Where rescheduled and contained errors are reported.
 * @returns False when the backend was already guarded.
 */
export function GuardWebAudioBackend(backend: CjsWebAudioSoundEngine, options: WebAudioGuardOptions): boolean {
  if (GUARDED.has(backend)) return false;
  GUARDED.add(backend);
  for (const applier of Object.keys(VOICE_APPLIER_PARAMS) as VoiceApplier[]) {
    const original: BackendMember = backend[applier];
    // A pin bump may drop a member: the .d.ts still declares it until someone re-checks.
    if (typeof original === 'function') Patch(backend, applier, GuardedApplier(original, applier, options));
  }
  for (const call of CONTAINED_BACKEND_CALLS) {
    const original: BackendMember = backend[call];
    if (typeof original === 'function') Patch(backend, call, ContainedCall(original, call, options));
  }
  return true;
}

/**
 * Whether an error is Web Audio's automation overlap (a DOMException named NotSupportedError).
 *
 * @param error - What was thrown.
 * @returns True for an overlap.
 */
export function IsAutomationOverlap(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { readonly name?: unknown }).name === 'NotSupportedError';
}

/**
 * The audio manager's static seams (CjsAudioMan.Attach / Detach).
 */
export interface AudioSeams {
  Detach(): void;
  Attach(): unknown;
}

/**
 * Runs a build with the audio seams detached, so the audio objects it creates (a SOF hull's emitters) stay headless,
 * and re-attaches them afterwards, also when the build throws. Not re-entrant: a nested call re-attaches early.
 *
 * @param seams - The audio manager; null (audio off) just builds.
 * @param build - The synchronous build.
 * @returns What the build returns.
 */
export function RunDetached<T>(seams: Maybe<AudioSeams>, build: () => T): T {
  if (!seams) return build();
  seams.Detach();
  try {
    return build();
  } finally {
    seams.Attach();
  }
}

function GuardedApplier(original: BackendMember, applier: VoiceApplier, options: WebAudioGuardOptions) {
  const paramsOf = VOICE_APPLIER_PARAMS[applier];
  return function (this: unknown, voice: CjsWebAudioVoice, ...rest: unknown[]): void {
    const schedule = () => {
      for (const param of paramsOf(voice)) param?.cancelScheduledValues(0);
      Reflect.apply(original, this, [voice, ...rest]);
    };
    try {
      schedule();
    } catch (error) {
      if (!IsAutomationOverlap(error)) {
        options.onContained(error, applier);
        return;
      }
      try {
        schedule();
        options.onRescheduled(error, applier);
      } catch (retryError) {
        options.onContained(retryError, applier);
      }
    }
  };
}

function ContainedCall(original: BackendMember, call: ContainedBackendCall, options: WebAudioGuardOptions) {
  return function (this: unknown, ...args: unknown[]): unknown {
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      options.onContained(error, call);
      return CONTAINED_RESULTS[call];
    }
  };
}

/**
 * Replaces a member on the instance itself: the runtime calls them as `this.<name>(...)` and emitters through the
 * same instance, so the class stays untouched.
 */
function Patch(backend: CjsWebAudioSoundEngine, name: string, value: BackendMember): void {
  Object.defineProperty(backend, name, { value, writable: true, configurable: true, enumerable: false });
}
