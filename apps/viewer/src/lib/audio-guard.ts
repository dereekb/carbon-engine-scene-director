/**
 * Keeps the runtime's Web Audio backend (CjsWebAudioSoundEngine) from throwing into the page's frames.
 *
 * The backend reschedules each playing voice's AudioParams on every emitter placement and RTPC refresh: it reads
 * `context.currentTime` once, `cancelAndHoldAtTime(now)`, `setValueAtTime(v, now)`, `param.value = v`, then one
 * `setValueCurveAtTime` per future fade boundary. Chrome throws NotSupportedError ("setValueAtTime(...) overlaps
 * setValueCurveAtTime(...)") from that pattern:
 *
 * - the audio thread moves events scheduled after a param was processed up to the next render quantum, except value
 *   curves (ClampNewEventsToCurrentTime in Chromium's audio_param_handler.cc), so the scheduler's own setValue events
 *   land inside its curve; `cancelAndHoldAtTime` truncates only the last event before the cancel time (now that stray
 *   setValue), so the curve survives and the next `setValueAtTime(now)` overlaps it, exactly one quantum (128 frames)
 *   after the curve's start;
 * - a curve's start is clamped to the live clock, which moves within a task, while its duration is kept, so a segment
 *   computed from a stale `now` can overlap the next one (and a float seam does the same in a young context).
 *
 * The throws came from inside EveSpaceScene.Update (a SOF hull's emitter placement or RTPC binding) and from
 * CjsAudioMan.Process, so one aborted the whole frame. GuardWebAudioBackend patches the backend instance:
 *
 * - each per-voice applier owns its params (VOICE_APPLIER_PARAMS). On an overlap it clears them
 *   (`cancelScheduledValues(0)`, the runtime's own branch for browsers without `cancelAndHoldAtTime`, which has no
 *   first kind) and retries once; anything else is contained. The clear runs only on that error path, so the happy
 *   path schedules exactly as the runtime does;
 * - every backend entry point an emitter, a controller or the page reaches (CONTAINED_BACKEND_CALLS) is contained:
 *   it reports the error and returns a neutral value.
 *
 * The guard reaches private runtime names (declared in carbonenginejs-runtime.d.ts): re-check both lists against
 * CjsWebAudioSoundEngine.js on a runtime pin bump (the page warns on the names an instance lacks), and delete the
 * recovery once upstream schedules from a future render quantum.
 */

import type { Maybe } from '@dereekb/util';
import type { CjsWebAudioSoundEngine, CjsWebAudioVoice } from './runtime';

/**
 * The backend's per-voice schedulers the guard recovers.
 */
export type VoiceApplier = '_ApplyVoiceGain' | '_ApplyVoicePlaybackRate' | '_ApplyVoiceFilters' | '_ApplyVoiceBusGain' | '_ApplyVoiceBusActionGain' | '_ApplyVoiceBusRtpcGain' | '_ApplyVoiceSourceEffects';

/**
 * The AudioParams each applier alone schedules (the stop, fade and transition gains are other nodes; the RTPC lane's
 * bindings are the voice's source-effect params, which nothing else schedules).
 */
export const VOICE_APPLIER_PARAMS: Readonly<Record<VoiceApplier, (voice: CjsWebAudioVoice) => readonly Maybe<AudioParam>[]>> = {
  _ApplyVoiceGain: (voice) => [voice.gain?.gain],
  _ApplyVoicePlaybackRate: (voice) => [voice.source?.playbackRate],
  _ApplyVoiceFilters: (voice) => [voice.lowPassFilter?.frequency, voice.highPassFilter?.frequency],
  _ApplyVoiceBusGain: (voice) => [voice.busGain?.gain],
  _ApplyVoiceBusActionGain: (voice) => [voice.busVoiceActionGain?.gain],
  _ApplyVoiceBusRtpcGain: (voice) => [voice.busVoiceGain?.gain],
  _ApplyVoiceSourceEffects: (voice) => voice.sourceEffectRtpcLane?._bindings.map((binding) => binding.param) ?? []
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
   * An applier hit an automation overlap, and its retry after clearing its params went through.
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

/**
 * What GuardWebAudioBackend patched, and the names the instance lacks (runtime pin drift).
 */
export interface WebAudioGuardResult {
  readonly guarded: readonly string[];
  readonly missing: readonly string[];
}

const GUARDED = new WeakSet<object>();

/**
 * Patches a backend instance so no audio throw escapes it (see the module doc). Idempotent per backend.
 *
 * @param backend - CjsAudioMan.backend, the instance emitters reach as AudGameObjResource.backend.
 * @param options - Where rescheduled and contained errors are reported.
 * @returns The names patched and the names skipped; both empty when the backend was already guarded.
 */
export function GuardWebAudioBackend(backend: CjsWebAudioSoundEngine, options: WebAudioGuardOptions): WebAudioGuardResult {
  const guarded: string[] = [];
  const missing: string[] = [];
  if (GUARDED.has(backend)) return { guarded, missing };
  GUARDED.add(backend);
  for (const applier of Object.keys(VOICE_APPLIER_PARAMS) as VoiceApplier[]) {
    const original: BackendMember = backend[applier];
    // A pin bump may drop a member: the .d.ts still declares it until someone re-checks.
    if (typeof original !== 'function') missing.push(applier);
    else {
      Patch(backend, applier, GuardedApplier(original, applier, options));
      guarded.push(applier);
    }
  }
  for (const call of CONTAINED_BACKEND_CALLS) {
    const original: BackendMember = backend[call];
    if (typeof original !== 'function') missing.push(call);
    else {
      Patch(backend, call, ContainedCall(original, call, options));
      guarded.push(call);
    }
  }
  return { guarded, missing };
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
 * How deep each seams object is in RunDetached windows: only the outermost one detaches and re-attaches.
 */
const DETACHED_DEPTH = new WeakMap<AudioSeams, number>();

/**
 * Runs a build with the audio seams detached, so the audio objects it creates (a SOF hull's emitters) stay headless,
 * and re-attaches them afterwards, also when the build throws. Re-entrant: nested windows detach once.
 *
 * @param seams - The audio manager; null (audio off) just builds.
 * @param build - The synchronous build.
 * @returns What the build returns.
 */
export function RunDetached<T>(seams: Maybe<AudioSeams>, build: () => T): T {
  if (!seams) return build();
  const depth = DETACHED_DEPTH.get(seams) ?? 0;
  if (depth === 0) seams.Detach();
  DETACHED_DEPTH.set(seams, depth + 1);
  try {
    return build();
  } finally {
    DETACHED_DEPTH.set(seams, depth);
    if (depth === 0) seams.Attach();
  }
}

/**
 * Runs a build with the runtime's audio seams detached (PageAudio.Detached once the page exists).
 */
export type AudioDetachScope = <T>(build: () => T) => T;

let audioDetachScope: AudioDetachScope = (build) => build();

/**
 * Sets the page's detached-audio scope: the runtime's object builds and the scene update run in it.
 *
 * @param scope - The page's PageAudio.Detached.
 */
export function SetAudioDetachScope(scope: AudioDetachScope): void {
  audioDetachScope = scope;
}

/**
 * Runs a build in the page's detached-audio scope (the identity until SetAudioDetachScope).
 *
 * @param build - The synchronous build.
 * @returns What the build returns.
 */
export function InAudioDetachScope<T>(build: () => T): T {
  return audioDetachScope(build);
}

/**
 * IBlueObjectBuilder as the resource manager calls it: `{ Create: builder => builder.CreateObject(0) }`.
 */
export interface ObjectBuilder {
  CreateObject(objectMarker?: number, callingProxy?: unknown): unknown;
  CreateObjectWithYield?(objectMarker?: number, callingProxy?: unknown): unknown;
}

/**
 * What the resource manager keeps per object extension: one builder per file.
 */
export type ObjectBuilderFactory = (bytes: Uint8Array, context: unknown) => ObjectBuilder;

/**
 * The resource manager's object route (CjsBlueResMan GetObjectLoader / RegisterObjectBuilder).
 */
export interface ObjectRoutes {
  GetObjectLoader(extension: string): ObjectBuilderFactory | null;
  RegisterObjectBuilder(extension: string, factory: ObjectBuilderFactory): unknown;
}

/**
 * The builder members DetachedBuilds wraps.
 */
const OBJECT_BUILDS = ['CreateObject', 'CreateObjectWithYield'] as const;

/**
 * Re-registers each extension's object builder so every object it builds is built inside `detach`. An extension
 * without a loader is skipped.
 *
 * @param routes - blue.resMan.
 * @param extensions - The object extensions (ObjectResourceExtensions: black, red).
 * @param detach - The scope the builds run in (InAudioDetachScope).
 * @returns The extensions re-registered.
 */
export function DetachObjectRoutes(routes: ObjectRoutes, extensions: readonly string[], detach: AudioDetachScope): readonly string[] {
  const detached: string[] = [];
  for (const extension of extensions) {
    const factory = routes.GetObjectLoader(extension);
    if (!factory) continue;
    routes.RegisterObjectBuilder(extension, (bytes, context) => DetachedBuilds(factory(bytes, context), detach));
    detached.push(extension);
  }
  return detached;
}

/**
 * Patches one builder instance (its class untouched): CreateObject, and CreateObjectWithYield when present, run
 * inside `detach`. The runtime keeps one builder per file, so this touches only that file's builds.
 *
 * @param builder - What the extension's factory returned.
 * @param detach - The scope the builds run in.
 * @returns The same builder.
 */
export function DetachedBuilds<B extends ObjectBuilder>(builder: B, detach: AudioDetachScope): B {
  for (const name of OBJECT_BUILDS) {
    const original: unknown = builder[name];
    if (typeof original !== 'function') continue;
    const value = function (this: unknown, ...args: unknown[]): unknown {
      return detach(() => Reflect.apply(original, builder, args));
    };
    Object.defineProperty(builder, name, { value, writable: true, configurable: true, enumerable: false });
  }
  return builder;
}

function GuardedApplier(original: BackendMember, applier: VoiceApplier, options: WebAudioGuardOptions) {
  const paramsOf = VOICE_APPLIER_PARAMS[applier];
  return function (this: unknown, voice: CjsWebAudioVoice, ...rest: unknown[]): unknown {
    try {
      return Reflect.apply(original, this, [voice, ...rest]);
    } catch (error) {
      if (!IsAutomationOverlap(error)) {
        options.onContained(error, applier);
        return undefined;
      }
      try {
        for (const param of paramsOf(voice)) param?.cancelScheduledValues(0);
        const result = Reflect.apply(original, this, [voice, ...rest]);
        options.onRescheduled(error, applier);
        return result;
      } catch (retryError) {
        options.onContained(retryError, applier);
        return undefined;
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
