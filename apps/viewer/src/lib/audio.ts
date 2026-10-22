/**
 * The page's audio: the runtime's CjsAudioMan on tools-core's audio library, read through the hub's `/audio/library`
 * and `/audio/path/<resPath>` routes. It plays the prop mods' engine stems (prop-mod-audio.ts) on one emitter per
 * ship, placed at the drawn ship, with the listener at the camera's eye.
 *
 * - Browsers start audio only after a user gesture. Enable({ auto: true }) at startup turns it on at once only when
 *   the tab may autoplay; otherwise the first click or keypress in the tab does (main.ts). `?audio=off` keeps it off.
 * - The library is about 20 MB of JSON, fetched once, when audio turns on. Media is read per event, with HTTP ranges
 *   into the sound banks (the engine stems sit in the 32 MB boosters.bnk).
 * - Every posted event is recorded (get_state's audio.posted), played or not, so a headless check sees what would
 *   play. `played` means the event reached the enabled audio manager; an emitter out of the listener's range is
 *   culled and plays its loops once it comes into range.
 */

import type { Maybe } from '@dereekb/util';
import type { CameraEye } from './engine';
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
   * Audio frames the runtime failed (CjsAudioMan.Process threw), with the last failure.
   */
  readonly frameErrors?: number;
  readonly lastFrameError?: string;
}

export interface PageAudioPost {
  readonly ship: string;
  readonly tick: number;
  readonly events: readonly string[];
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
   * Called once audio is on, to post what is already running.
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
 * How long startup waits to learn whether the tab may play audio without a gesture.
 */
const AUTOPLAY_PROBE_MS = 500;
/**
 * How often a run of failing audio frames is logged.
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
  private readonly emitters = new Map<string, AudEmitter>();
  private readonly posted: PostedAudioEvent[] = [];
  private frame = 0;
  private lastRealTime: Maybe<number> = null;
  /**
   * When a frame failure was last logged (performance.now() ms).
   */
  private frameErrorLoggedAt = -Infinity;
  private frameErrors = 0;
  private lastFrameError: Maybe<string> = null;
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
    try {
      const response = await fetch(LIBRARY_URL);
      if (!response.ok) throw new Error(`the hub's ${LIBRARY_URL} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const library = (await response.json()) as CjsAudioLibraryDocument;
      const man = new CjsAudioMan(library, {
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
      void context.resume().catch(() => undefined);
      this.man = man;
      this.SetState('on');
      console.info(`audio on: ${Object.keys(library.metadata.SoundBanks).length} sound banks`);
      this.onReady();
    } catch (error) {
      this.error = ErrorText(error);
      console.warn(`audio failed: ${this.error}`);
      this.SetState('failed');
    }
  }

  /**
   * Posts events on a ship's emitter (created on its first event, at its placement), and records them either way.
   *
   * @param post - The ship, the tick, the events and where the ship is drawn.
   */
  Post(post: PageAudioPost): void {
    const emitter = this.Emitter(post.ship, post.placement);
    for (const event of post.events) {
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
      // The runtime's Web Audio backend can throw for a burst of frames while fades overlap (an AudioParam curve
      // scheduled twice in one render quantum), with a different message each frame: log a burst once.
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
    return {
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      emitters: this.emitters.size,
      posted: [...this.posted],
      ...(this.frameErrors ? { frameErrors: this.frameErrors, ...(this.lastFrameError ? { lastFrameError: this.lastFrameError } : {}) } : {})
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
      on: `on · ${this.emitters.size} emitter(s)`,
      failed: `failed: ${this.error ?? 'unknown'}`,
      unavailable: `unavailable: ${this.error ?? 'no Web Audio'}`
    };
    return texts[this.state];
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

  private SetState(state: PageAudioState): void {
    this.state = state;
    this.onChange();
  }
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
