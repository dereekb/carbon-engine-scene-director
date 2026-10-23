/**
 * The page's audio: the runtime's CjsAudioMan on tools-core's audio library, read through the hub's `/audio/library`
 * and `/audio/path/<resPath>` routes. It plays the prop mods' engine stems (prop-mod-audio.ts) on one emitter per
 * ship, placed at the drawn ship, with the listener at the camera's eye.
 *
 * - Browsers start audio only after a user gesture. Enable({ auto: true }) at startup turns it on at once only when
 *   the tab may autoplay; otherwise the first click or keypress in the tab does (main.ts, Gesture). `?audio=off` keeps
 *   it off. Chromium grants no activation for a modifier key alone or Escape, so a first Shift or Alt can turn audio
 *   on with a suspended AudioContext: every later gesture resumes it.
 * - The library is about 20 MB of JSON, fetched once, when audio turns on. Media is read per event, with HTTP ranges
 *   into the sound banks (the engine stems sit in the 32 MB boosters.bnk).
 * - Every posted event is recorded (get_state's audio.posted), played or not, so a headless check sees what would
 *   play. `played` means the event reached the enabled audio manager; an emitter out of the listener's range is
 *   culled and plays its loops once it comes into range.
 * - Only the page's emitters play: SOF ships, stations and gates hydrate inside Detached, so their own emitters stay
 *   headless whatever the audio state.
 * - The backend is guarded once on (audio-guard.ts): Chrome's AudioParam overlap throws are rescheduled or contained
 *   and counted, so audio never aborts a render frame.
 * - An event none of whose media the runtime can decode (the turrets' firing and impact sounds are Wwise PTADPCM, and
 *   the runtime ships no PTADPCM decoder) is learned once, from its first post, and then only recorded: each post
 *   would otherwise read and fail every media variant again (a 20-ship fight: ~15 MB/s through the hub, ~3 fps).
 */

import type { Maybe } from '@dereekb/util';
import type { CameraEye } from './engine';
import { GuardWebAudioBackend, RunDetached } from './audio-guard';
import { PROP_MOD_AUDIO_STOP_FADE_MS } from './prop-mod-audio';
import { ErrorText } from './resources';
import { type AudEmitter, CjsAudioMan, type CjsAudioLibraryDocument, type CjsAudioMediaProvider, type CjsAudioMediaRead, type CjsAudioMediaRecord } from './runtime';

/**
 * off: `?audio=off`; waiting-for-gesture: a click or keypress turns it on; loading: reading the library; on;
 * failed (error says why); unavailable: the browser has no Web Audio.
 */
export type PageAudioState = 'off' | 'waiting-for-gesture' | 'loading' | 'on' | 'failed' | 'unavailable';

/**
 * An audio event the page posted on a ship's emitter.
 */
export interface PostedAudioEvent {
  /**
   * The Destiny tick of the change that posted it.
   */
  readonly tick: number;
  readonly ship: string;
  readonly event: string;
  /**
   * Whether it reached the enabled audio manager.
   */
  readonly played: boolean;
  /**
   * Not sent: none of the event's media can be decoded by the runtime.
   */
  readonly undecodable?: true;
  /**
   * Not sent: time control muted the page (fast-forward).
   */
  readonly muted?: true;
}

/**
 * Get_state's audio.
 */
export interface PageAudioReport {
  readonly state: PageAudioState;
  readonly error?: string;
  /**
   * Ships with an emitter.
   */
  readonly emitters: number;
  /**
   * The last POSTED_AUDIO_LIMIT events, oldest first.
   */
  readonly posted: readonly PostedAudioEvent[];
  /**
   * Audio game objects registered with the runtime's manager (the page's emitters and the listener; 0 while off).
   * More than `emitters + 1`: see `foreign`.
   */
  readonly gameObjects: number;
  /**
   * Audio game objects registered with the runtime's manager that are neither the page's emitters nor the listener,
   * counted by name (omitted when none): what built with the audio seams attached.
   */
  readonly foreign?: Readonly<Record<string, number>>;
  /**
   * Audio frames the runtime failed (CjsAudioMan.Process threw), with the last failure.
   */
  readonly frameErrors?: number;
  readonly lastFrameError?: string;
  /**
   * Voice schedules the guard cleared and retried after an AudioParam overlap (audio-guard.ts).
   */
  readonly rescheduled?: number;
  /**
   * Backend calls the guard contained (they threw and were dropped), with the last failure.
   */
  readonly backendErrors?: number;
  readonly lastBackendError?: string;
  /**
   * The AudioContext's state once one exists: `suspended` while audio is on means the browser holds it until a gesture.
   */
  readonly context?: AudioContextState;
  /**
   * Events posted whose media the runtime cannot decode (UNDECODABLE_MEDIA_CODE), so they are recorded, never sent.
   */
  readonly undecodable?: readonly string[];
}

export interface PageAudioPost {
  readonly ship: string;
  readonly tick: number;
  readonly events: readonly string[];
  /**
   * Playing events to stop after posting (prop-mod-audio.ts PROP_MOD_AUDIO_STOPS: `_powerdown` does not stop them).
   */
  readonly stops?: readonly string[];
  /**
   * Where the ship is drawn now; a new emitter is placed there before its first event.
   */
  readonly placement: Maybe<CameraEye>;
}

export interface PageAudioFrame {
  /**
   * The scene clock, in integer 100 ns ticks.
   */
  readonly now: number;
  /**
   * The camera's eye; null without a renderer (the listener then sits at the origin facing +Z).
   */
  readonly listener: Maybe<CameraEye>;
  /**
   * Where a ship is drawn at `now`.
   */
  readonly placementOf: (ship: string) => Maybe<CameraEye>;
}

export interface PageAudioOptions {
  /**
   * `?audio=off`: never turn on.
   */
  readonly disabled?: boolean;
  /**
   * Called once audio is on.
   */
  readonly onReady?: () => void;
  /**
   * Called when the state changes.
   */
  readonly onChange?: () => void;
}

/**
 * How many posted events get_state keeps.
 */
export const POSTED_AUDIO_LIMIT = 20;

/**
 * The code CjsAudioMan.LoadMedia rejects with for a codec it cannot decode (PTADPCM without a registered decoder).
 */
export const UNDECODABLE_MEDIA_CODE = 'CJS_FORMAT_OUTPUT_NOT_SUPPORTED';

/**
 * How long startup waits to learn whether the tab may play audio without a gesture.
 */
const AUTOPLAY_PROBE_MS = 500;
/**
 * How often a run of failing audio frames, rescheduled voices or contained backend calls is logged.
 */
const FRAME_ERROR_LOG_MS = 10_000;
const TICKS_PER_SECOND = 1e7;
const DEFAULT_LISTENER: CameraEye = { position: [0, 0, 0], front: [0, 0, 1], up: [0, 1, 0] };
const LIBRARY_URL = '/audio/library';
const PATH_URL = '/audio/path/';

export class PageAudio {
  state: PageAudioState;
  error: Maybe<string> = null;
  private readonly onReady: () => void;
  private readonly onChange: () => void;
  private context: Maybe<AudioContext> = null;
  private man: Maybe<CjsAudioMan> = null;
  private library: Maybe<CjsAudioLibraryDocument> = null;
  /**
   * Per posted event: whether any of its media decodes, or `probing` while that is being learned.
   */
  private readonly decodable = new Map<string, boolean | 'probing'>();
  private readonly emitters = new Map<string, AudEmitter>();
  private readonly posted: PostedAudioEvent[] = [];
  private frame = 0;
  private lastRealTime: Maybe<number> = null;
  private suspended = false;
  private muted = false;
  /**
   * When a frame failure was last logged (performance.now() ms).
   */
  private frameErrorLoggedAt = -Infinity;
  private frameErrors = 0;
  private lastFrameError: Maybe<string> = null;
  private rescheduledLoggedAt = -Infinity;
  private rescheduled = 0;
  private backendErrorLoggedAt = -Infinity;
  private backendErrors = 0;
  private lastBackendError: Maybe<string> = null;
  /**
   * Media reads over the hub's /audio/path route, the shape the runtime's demo provider returns.
   */
  private readonly provider: CjsAudioMediaProvider = {
    Read: async (record, options) => {
      const response = await FetchAudioPath(record, { signal: options.signal });
      return { bytes: await response.arrayBuffer(), mediaType: MediaType(response), complete: true };
    },
    ReadRange: async (record, options) => {
      const { offset, byteLength, signal } = options;
      const response = await FetchAudioPath(record, { signal, headers: { Range: `bytes=${offset}-${offset + byteLength - 1}` } });
      const read: CjsAudioMediaRead = { bytes: await response.arrayBuffer(), mediaType: MediaType(response), complete: response.status !== 206, offset, byteLength };
      return read;
    }
  };

  constructor(options: PageAudioOptions = {}) {
    this.state = options.disabled ? 'off' : 'waiting-for-gesture';
    this.onReady = options.onReady ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
  }

  /**
   * Turns audio on: from a user gesture, or with `auto` at startup, where it goes on only when the tab may autoplay
   * (otherwise it keeps waiting for a gesture). Idempotent.
   *
   * @param input - `auto`: not from a gesture.
   */
  async Enable(input: { readonly auto: boolean }): Promise<void> {
    if (this.state !== 'waiting-for-gesture') return;
    const context = this.Context();
    if (!context) return;
    // From a gesture this runs while the activation holds; at startup it starts only when autoplay is allowed.
    const resumed = context.resume().then(
      () => true,
      () => false
    );
    if (input.auto) {
      const running = await Promise.race([resumed, Delay(AUTOPLAY_PROBE_MS).then(() => false)]);
      // A gesture may have turned it on meanwhile.
      if (!running || context.state !== 'running' || this.state !== 'waiting-for-gesture') return;
    }
    this.SetState('loading');
    let man: Maybe<CjsAudioMan> = null;
    try {
      const response = await fetch(LIBRARY_URL);
      if (!response.ok) throw new Error(`the hub's ${LIBRARY_URL} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const library = (await response.json()) as CjsAudioLibraryDocument;
      man = new CjsAudioMan(library, {
        // Scales only the panner and listener positions, which are inaudible here (the panners are HRTF with rolloff
        // 0, so only the direction counts); the stems' distance curves and culling read raw positions, in metres,
        // the scene's unit. 1/150 (the runtime demo's) measured within 1.2 dB of 1 (Windows Chrome, 2026-10-22).
        distanceScale: 1,
        createContext: () => context,
        mediaProvider: this.provider,
        wwiseDynamics: 'approximate-web-audio',
        wwiseDistortion: 'approximate-web-audio',
        wwiseModulation: 'approximate-web-audio',
        wwiseReverb: 'approximate-web-audio',
        wwiseRoomVerb: 'approximate-web-audio',
        wwiseMeterFeedback: 'omit-telemetry',
        wwiseVoiceLimits: 'ignore'
      });
      // Every bank, as the runtime's demo does: the engine gates PostEvent on bank status, and the catalog backend
      // reads nothing up front (media is read per event).
      if (!man.Enable(Object.keys(library.metadata.SoundBanks))) throw new Error('the audio manager could not create its AudioContext');
      if (man.backend) GuardWebAudioBackend(man.backend, { onRescheduled: (error) => this.Rescheduled(error), onContained: (error, where) => this.BackendError(error, where) });
      void context.resume().catch(() => undefined);
      this.man = man;
      this.library = library;
      this.SetState('on');
      console.info(`audio on: ${Object.keys(library.metadata.SoundBanks).length} sound banks`);
      this.onReady();
    } catch (error) {
      // Enable attached the seams: a failed enable leaves the runtime headless.
      man?.Detach();
      this.error = ErrorText(error);
      console.warn(`audio failed: ${this.error}`);
      this.SetState('failed');
    }
  }

  /**
   * A user gesture in the tab (main.ts: pointerdown, pointerup, keydown). Resumes a suspended context, which a
   * gesture without activation (a modifier key alone, Escape, a touch's pointerdown) can leave behind, then turns
   * audio on if it is still waiting.
   */
  Gesture(): void {
    if (this.state !== 'off' && !this.suspended && this.context?.state === 'suspended') void this.context.resume().catch(() => undefined);
    void this.Enable({ auto: false });
  }

  /**
   * Runs a SOF build with the runtime's audio seams detached: SOF graphs hydrate inert; only the page's emitters play.
   * Their own emitters (Engine_SFX, the boosters' controllers) would otherwise register with the manager when audio is
   * on and play sounds the page never posted, which nothing releases with the ship. The page's detached-audio scope
   * (InAudioDetachScope: the runtime's object builds and the scene update) is this too. Re-entrant: nested windows
   * detach once. Never post page audio inside a window: PostEvent finds no static data there and returns 0.
   *
   * @param build - The synchronous hydration.
   * @returns What the build returns.
   */
  Detached<T>(build: () => T): T {
    return RunDetached(this.man, build);
  }

  /**
   * Posts events on a ship's emitter (created on its first event, at its placement), and records them either way. An
   * event learned undecodable is only recorded; the first send of any other starts learning whether it decodes.
   *
   * @param post - The ship, the tick, the events and where the ship is drawn.
   */
  Post(post: PageAudioPost): void {
    if (this.muted) {
      for (const event of post.events) this.posted.push({ tick: post.tick, ship: post.ship, event, played: false, muted: true });
      this.posted.splice(0, Math.max(0, this.posted.length - POSTED_AUDIO_LIMIT));
      return;
    }
    // Undecodable events alone need no emitter.
    const sends = post.events.some((event) => this.decodable.get(event) !== false) || Boolean(post.stops?.length);
    const emitter = sends ? this.Emitter(post.ship, post.placement) : null;
    for (const event of post.events) {
      if (this.decodable.get(event) === false) {
        this.posted.push({ tick: post.tick, ship: post.ship, event, played: false, undecodable: true });
        continue;
      }
      let played = false;
      if (emitter) {
        try {
          emitter.SendEvent(event);
          played = true;
        } catch (error) {
          console.warn(`audio event ${event} on ship ${post.ship} failed: ${ErrorText(error)}`);
        }
      }
      this.posted.push({ tick: post.tick, ship: post.ship, event, played });
      if (played && !this.decodable.has(event)) this.Probe(event);
    }
    if (emitter && post.stops?.length) {
      try {
        for (const [playingID, name] of emitter.GetPlayingEvents()) {
          if (post.stops.includes(name)) StopPlaying(emitter, playingID);
        }
      } catch (error) {
        console.warn(`stopping ${post.stops.join(', ')} on ship ${post.ship} failed: ${ErrorText(error)}`);
      }
    }
    this.posted.splice(0, Math.max(0, this.posted.length - POSTED_AUDIO_LIMIT));
  }

  /**
   * Places the listener and every emitter, then runs the audio manager's frame. A failure is logged once and the
   * loop goes on.
   *
   * @param input - The scene clock, the camera's eye and where each ship is drawn.
   */
  Frame(input: PageAudioFrame): void {
    // A gesture or Enable may have resumed the context while time control holds it.
    if (this.suspended && this.state === 'on' && this.context?.state === 'running') void this.context.suspend().catch(() => undefined);
    const man = this.man;
    if (this.state !== 'on' || !man) return;
    try {
      const listener = input.listener ?? DEFAULT_LISTENER;
      man.listener?.SetPosition(listener.front, listener.up, listener.position);
      for (const [ship, emitter] of this.emitters) {
        const placement = input.placementOf(ship);
        if (placement) emitter.SetPlacement(placement.front, placement.up, placement.position);
      }
      const realTime = performance.now() / 1000;
      man.Process({ time: input.now / TICKS_PER_SECOND, realTime, deltaTime: this.lastRealTime == null ? 0 : Math.max(0, realTime - this.lastRealTime), frame: ++this.frame });
      this.lastRealTime = realTime;
    } catch (error) {
      // What the guard does not cover in the manager's own frame (its RTPC lanes and source effects schedule
      // AudioParams too) can throw for a burst of frames while fades overlap, with a different message each frame:
      // log a burst once.
      const message = ErrorText(error);
      this.frameErrors += 1;
      this.lastFrameError = message;
      const at = performance.now();
      if (at - this.frameErrorLoggedAt >= FRAME_ERROR_LOG_MS) {
        console.error(`audio frame failed: ${message} (${this.frameErrors} so far, logged at most every ${FRAME_ERROR_LOG_MS / 1000} s; get_state's audio.frameErrors counts them)`);
        this.frameErrorLoggedAt = at;
      }
    }
  }

  /**
   * Time control's pause: suspends the AudioContext, so every voice holds where it is, and resumes it on play. While
   * paused a gesture does not resume it, and Frame suspends it again after Enable.
   *
   * @param on - True suspends.
   */
  Suspend(on: boolean): void {
    this.suspended = on;
    const context = this.context;
    if (!context || this.state !== 'on') return;
    if (on && context.state === 'running') void context.suspend().catch(() => undefined);
    else if (!on && context.state === 'suspended') void context.resume().catch(() => undefined);
  }

  /**
   * Time control's fast-forward (above AUDIBLE_MAX_RATE): releases every emitter, so every voice stops, and drops the
   * posts while muted (recorded with muted: true). An emitter comes back on its ship's next post after. The prop mods'
   * and modules' activation sounds are one-shots, so unmuting re-posts nothing.
   *
   * @param on - True mutes.
   */
  Mute(on: boolean): void {
    this.muted = on;
    if (on) this.ReleaseAll();
  }

  /**
   * Stops and drops every ship's emitter (a time-control jump: the voices belong to the time left behind); each comes
   * back on its ship's next post.
   */
  ReleaseAll(): void {
    for (const ship of [...this.emitters.keys()]) this.Release(ship);
  }

  /**
   * Stops and drops a ship's emitter (the ship was removed).
   *
   * @param ship - The ship id.
   */
  Release(ship: string): void {
    const emitter = this.emitters.get(ship);
    this.emitters.delete(ship);
    if (emitter) this.man?.ReleaseEmitter(emitter);
  }

  Report(): PageAudioReport {
    const objects = this.man?.manager?.GetPrioritizedEmitters() ?? [];
    const mine = new Set<unknown>([...this.emitters.values(), this.man?.listener]);
    const foreign: Record<string, number> = {};
    for (const object of objects) {
      if (mine.has(object)) continue;
      const name = object.name || '(unnamed)';
      foreign[name] = (foreign[name] ?? 0) + 1;
    }
    return {
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      emitters: this.emitters.size,
      gameObjects: objects.length,
      ...(Object.keys(foreign).length ? { foreign } : {}),
      posted: [...this.posted],
      ...(this.frameErrors ? { frameErrors: this.frameErrors, ...(this.lastFrameError ? { lastFrameError: this.lastFrameError } : {}) } : {}),
      ...(this.rescheduled ? { rescheduled: this.rescheduled } : {}),
      ...(this.backendErrors ? { backendErrors: this.backendErrors, ...(this.lastBackendError ? { lastBackendError: this.lastBackendError } : {}) } : {}),
      ...(this.context ? { context: this.context.state } : {}),
      ...([...this.decodable.values()].includes(false) ? { undecodable: [...this.decodable].flatMap(([event, decodable]) => (decodable === false ? [event] : [])).sort() } : {})
    };
  }

  /**
   * The overlay's audio row.
   */
  Text(): string {
    const texts: Record<PageAudioState, string> = {
      off: 'off (?audio=off)',
      'waiting-for-gesture': 'click the view to turn audio on',
      loading: 'loading the audio library...',
      on: this.OnText(),
      failed: `failed: ${this.error ?? 'unknown'}`,
      unavailable: `unavailable: ${this.error ?? 'no Web Audio'}`
    };
    return texts[this.state];
  }

  private OnText(): string {
    if (this.suspended) return 'on · paused';
    if (this.muted) return 'on · muted while fast-forwarding';
    return this.context?.state === 'suspended' ? 'on, but the browser holds it: click the view' : `on · ${this.emitters.size} emitter(s)`;
  }

  private Context(): Maybe<AudioContext> {
    if (!this.context) {
      try {
        if (typeof AudioContext === 'undefined') throw new Error('this browser has no Web Audio');
        this.context = new AudioContext();
      } catch (error) {
        this.error = ErrorText(error);
        this.SetState('unavailable');
      }
    }
    return this.context;
  }

  private Emitter(ship: string, placement: Maybe<CameraEye>): Maybe<AudEmitter> {
    const man = this.man;
    let emitter = this.emitters.get(ship) ?? null;
    if (!emitter && man && this.state === 'on') {
      try {
        emitter = man.CreateEmitter({ name: ship });
        if (placement) emitter.SetPlacement(placement.front, placement.up, placement.position);
        this.emitters.set(ship, emitter);
      } catch (error) {
        console.warn(`no audio emitter for ship ${ship}: ${ErrorText(error)}`);
        emitter = null;
      }
    }
    return emitter;
  }

  /**
   * Learns whether an event can play: whether the runtime decodes any of its media. All of them failing on their
   * codec marks it undecodable; any other failure (a read) leaves it unknown, to learn again on a later post.
   *
   * @param event - The event name.
   */
  private Probe(event: string): void {
    const man = this.man;
    const media = this.library?.eventMedia?.[event] ?? [];
    if (!man || !media.length) return;
    this.decodable.set(event, 'probing');
    void Promise.all(
      media.map((id) =>
        man.LoadMedia(id).then(
          () => 'decoded' as const,
          (error: unknown) => ((error as Maybe<{ code?: unknown }>)?.code === UNDECODABLE_MEDIA_CODE ? ('codec' as const) : ('failed' as const))
        )
      )
    ).then((results) => {
      if (results.includes('decoded')) this.decodable.set(event, true);
      else if (results.every((result) => result === 'codec')) {
        this.decodable.set(event, false);
        console.info(`audio: ${event} is not sent: the runtime decodes none of its ${media.length} media (PTADPCM needs a registered decoder)`);
      } else this.decodable.delete(event);
    });
  }

  /**
   * The guard cleared and retried a voice schedule after an AudioParam overlap.
   */
  private Rescheduled(error: unknown): void {
    this.rescheduled += 1;
    const at = performance.now();
    if (at - this.rescheduledLoggedAt >= FRAME_ERROR_LOG_MS) {
      console.info(`audio: rescheduled a voice after ${ErrorText(error)} (${this.rescheduled} so far, logged at most every ${FRAME_ERROR_LOG_MS / 1000} s; get_state's audio.rescheduled counts them)`);
      this.rescheduledLoggedAt = at;
    }
  }

  /**
   * The guard contained a backend call that threw: the frame goes on, the next placement or refresh reschedules.
   */
  private BackendError(error: unknown, where: string): void {
    const message = `${where}: ${ErrorText(error)}`;
    this.backendErrors += 1;
    this.lastBackendError = message;
    const at = performance.now();
    if (at - this.backendErrorLoggedAt >= FRAME_ERROR_LOG_MS) {
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
      console.warn(`audio backend call contained: ${message} (${this.backendErrors} so far, logged at most every ${FRAME_ERROR_LOG_MS / 1000} s; get_state's audio.backendErrors counts them)${stack}`);
      this.backendErrorLoggedAt = at;
    }
  }

  private SetState(state: PageAudioState): void {
    this.state = state;
    this.onChange();
  }
}

/**
 * Stops one playing event with the runtime's own stop fade, the way its metadata fallback does, and keeps a culled
 * loop from resuming when the emitter wakes.
 *
 * @param emitter - The ship's emitter.
 * @param playingID - The playing id SendEvent returned.
 */
function StopPlaying(emitter: AudEmitter, playingID: number): void {
  emitter.MarkPlayingIDStoppedByRequest(playingID);
  emitter.ExecuteActionOnPlayingID(playingID, 'stop', PROP_MOD_AUDIO_STOP_FADE_MS);
}

/**
 * Reads an audio record through the hub's /audio/path route.
 *
 * @param record - The library record (a media file or a sound bank).
 * @param init - The signal and any Range header.
 * @returns The response (200, or 206 for a range).
 * @throws {Error} When the record has no res: path or the hub answers anything else.
 */
async function FetchAudioPath(record: CjsAudioMediaRecord, init: RequestInit): Promise<Response> {
  if (!record.resPath) throw new Error('an audio record without a resPath');
  const response = await fetch(`${PATH_URL}${encodeURIComponent(record.resPath)}`, init);
  if (response.status !== 200 && response.status !== 206) throw new Error(`the hub's /audio/path answered ${response.status} for ${record.resPath}`);
  return response;
}

function MediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
