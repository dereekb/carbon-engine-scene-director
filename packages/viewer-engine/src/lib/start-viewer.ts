/**
 * Boots the engine on a page (StartViewer): restores the page's last scene, starts the Destiny simulation and the
 * renderer, and serves the page-side tools over the hub link. The read-only viewer (apps/viewer) and the battle console
 * both start it; each adds its own UI over the canvas.
 *
 * One animation loop drives everything: time control steps the scene clock and the Destiny parks to the frame's time
 * one tick at a time (at its rate, or not at all while paused), then the page draws at it, so the ships' ball curves
 * are sampled on the clock the parks run on. It runs with or without WebGPU. Space pauses or plays; [ and ] halve or
 * double the rate.
 *
 * Audio (the prop mods' engine sounds) turns on at startup when the tab may autoplay, else on the first click or
 * keypress; `?audio=off` keeps it off.
 *
 * Presentation: `?letterbox=2.39` (or `off`) letterboxes the frame and L toggles a 2.39 letterbox; `?hud=off` hides
 * the host's UI and H toggles it. A movie's look (the timeline's movie block) overrides them while its timeline plays
 * (L and H then switch it for the run), and a playing camera shot's `letterbox` / `hud` override both while it plays.
 *
 * A movie export (export_movie, sd-export) drives the loop instead of time control: each frame steps the scene to the
 * export clock's next frame (or draws nothing while the export waits), the canvas backing store is held at the
 * picture's size, and the frame is captured right after it is drawn. The tab's input is locked meanwhile (Esc
 * cancels, H toggles the UI).
 *
 * The engine's keys skip key events inside the host's UI (ui-focus.ts).
 */

import type { Maybe } from '@dereekb/util';
import { MAX_TIME_RATE, MIN_TIME_RATE, normalizeScene, readEveDataStatus, SCENE_SCHEMA, type SceneDocument, type TimelineSummary, type TimeReport } from '@scene-director/scene';
import type { FleetView, StartViewerOptions, ViewerApi, ViewerChange, ViewerChangeListener } from './api';
import { InAudioDetachScope, SetAudioDetachScope } from './audio-guard';
import { LetterboxRect } from './cinema';
import { SceneClock } from './clock';
import { DestinyWorld } from './destiny';
import { Director } from './director';
import { Engine } from './engine';
import { FetchHubConfig, HubModeChanged, PageEveDataOf, type PageEveData } from './eve-data';
import { HubLink, type HubCallOptions, type ToolHandler } from './link';
import { MoviePresentation, type FramePresentation, type MovieRunOverrides } from './movie';
import { ConfigureResources, ErrorText } from './resources';
import { SceneStore } from './store';
import { TimeControl } from './time-control';
import { IsUiKeyEvent } from './ui-focus';

/**
 * What a first visit shows, so the page is never empty.
 */
const WELCOME_SCENE = {
  schema: SCENE_SCHEMA,
  name: 'welcome',
  ships: [{ id: 'punisher-1', dna: 'af1_t1:amarrbase:amarr', name: 'Punisher', position: [0, 0, 0] }]
};

/**
 * The aspect L letterboxes to: anamorphic scope.
 */
const SCOPE_ASPECT = 2.39;

/**
 * How far ← jumps back, in seconds (as far as the time-control window reaches).
 */
const BACK_KEY_SECONDS = 10;

/**
 * The engine's parts as they come up, for a host that shows them (the viewer's status overlay): the hub link's state,
 * the EVE data mode, the time control and the director.
 */
export interface ViewerStatusPatch {
  readonly hub?: boolean;
  readonly eveData?: PageEveData;
  readonly time?: TimeControl;
  readonly director?: Director;
}

/**
 * StartViewer's options for a host built with the engine's source (the viewer): the public options plus the boot
 * status. The console, on the engine module, passes only the public ones.
 */
export interface ViewerStartOptions extends StartViewerOptions {
  /**
   * Called as each part comes up (the hub link on every change).
   */
  readonly onStatus?: (patch: ViewerStatusPatch) => void;
}

/**
 * The frame's presentation for clean frames: the letterbox resizes the canvas element to the aspect, centred on black
 * bars, so the swap chain, screenshots and captures are exactly the frame; the HUD is the host's UI. Lowest first: the
 * page's settings, a movie's look while its timeline plays (L and H switch a key for the run: the user wins until the
 * next load or restart), a playing shot's `letterbox` / `hud` (MoviePresentation).
 */
class Presentation {
  private letterbox: Maybe<number>;
  private hud: boolean;
  private applied = '';
  private shown: { letterbox: Maybe<number>; hud: boolean };
  /**
   * The movie run the user's switches belong to, while a movie's look applies.
   */
  private run: Maybe<number> = null;
  private overrides: MovieRunOverrides = {};
  /**
   * While a movie export runs: the UI shows whatever the looks say, and H toggles it.
   */
  private exporting = false;
  private exportHud = true;
  /**
   * Whether the host's UI is hidden, as last applied.
   */
  uiHidden = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    search: URLSearchParams,
    private readonly onUi: () => void,
    keys: boolean
  ) {
    const aspect = Number(search.get('letterbox'));
    this.letterbox = Number.isFinite(aspect) && aspect >= 0.5 && aspect <= 4 ? aspect : null;
    this.hud = search.get('hud') !== 'off';
    this.shown = { letterbox: this.letterbox, hud: this.hud };
    if (!keys) return;
    addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      // An export locks the tab: H still toggles the UI then, wherever the focus is.
      if (key === 'h' && this.exporting) this.exportHud = !this.exportHud;
      else if (IsUiKeyEvent(event.target, document.activeElement)) return;
      else if (key === 'h') {
        if (this.run != null) this.overrides = { ...this.overrides, hud: !this.shown.hud };
        else this.hud = !this.hud;
      } else if (key === 'l') {
        if (this.run != null) this.overrides = { ...this.overrides, letterbox: this.shown.letterbox ? null : SCOPE_ASPECT };
        else this.letterbox = this.letterbox ? null : SCOPE_ASPECT;
      }
    });
  }

  /**
   * Shows or hides the host's UI, as H does: for the run while a movie's look applies, else the page's setting.
   *
   * @param shown - Whether the UI shows.
   */
  SetHud(shown: boolean): void {
    if (this.exporting) this.exportHud = shown;
    else if (this.run != null) this.overrides = { ...this.overrides, hud: shown };
    else this.hud = shown;
  }

  /**
   * Applies the page's settings under the movie's and the shot's; cheap when nothing changed (the animation loop calls
   * it every frame).
   *
   * @param frame - The director's presentation (Director.Presentation): the shot's look, the movie's and its run.
   */
  Apply({ shot, movie, export: exported }: FramePresentation): void {
    this.exporting = exported != null;
    if (!exported) this.exportHud = true;
    if (!movie) this.run = null;
    else if (movie.run !== this.run) {
      this.run = movie.run;
      this.overrides = {};
    }
    const look = MoviePresentation({ page: { letterbox: this.letterbox, hud: this.hud }, movie, overrides: this.overrides, shot });
    this.shown = look;
    // An export shows its picture (the canvas held at its size) at its aspect, downscaled to the window.
    const letterbox = exported ? exported.picture.width / exported.picture.height : look.letterbox;
    const hud = exported ? this.exportHud : look.hud;
    const key = `${letterbox}:${hud}:${exported ? 'export' : ''}:${innerWidth}x${innerHeight}`;
    if (key === this.applied) return;
    this.applied = key;
    const box = LetterboxRect(innerWidth, innerHeight, letterbox);
    const style = this.canvas.style;
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    document.body.style.background = letterbox ? '#000' : '';
    if (this.uiHidden !== !hud) {
      this.uiHidden = !hud;
      this.onUi();
    }
  }
}

/**
 * A movie export's input lock (sd-export): while the director exports, capture-phase listeners on the window swallow
 * the pointer, the wheel, the context menu and the keys before the canvas's camera handlers, the UI's buttons and
 * every key handler see them. Esc cancels the export; H still toggles the UI. A live recording locks nothing: Esc
 * stops it and saves the file.
 */
class InputLock {
  constructor(private readonly director: () => Maybe<Director>) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu', 'keydown'] as const) addEventListener(type, (event) => this.Swallow(event), { capture: true, passive: false });
  }

  private Swallow(event: Event): void {
    const director = this.director();
    if (!director?.exporting) {
      if (event instanceof KeyboardEvent && event.key === 'Escape' && director?.recordingMovie) director.StopRecording('Esc in the tab');
      return;
    }
    if (event instanceof KeyboardEvent) {
      if (event.key === 'Escape') director.CancelExport('Esc in the tab');
      else if (event.key.toLowerCase() === 'h' && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}

/**
 * The time control keys: Space pauses or plays, [ and ] halve or double the rate, ← jumps back BACK_KEY_SECONDS (as far
 * as the window reaches). Ignored with Ctrl, Meta or Alt, and inside the host's UI (ui-focus.ts).
 *
 * @param time - The page's time control.
 * @param onChange - Tells the host.
 */
function TimeKeys(time: TimeControl, onChange: () => void): void {
  addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (IsUiKeyEvent(event.target, document.activeElement)) return;
    if (event.key === ' ') {
      event.preventDefault();
      time.Pause(!time.paused);
    } else if (event.key === '[' || event.key === ']') {
      time.SetRate(Math.min(MAX_TIME_RATE, Math.max(MIN_TIME_RATE, event.key === '[' ? time.rate / 2 : time.rate * 2)));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const back = Math.min(BACK_KEY_SECONDS, time.Report().back);
      if (back <= 0) return;
      try {
        time.Command({ back });
      } catch (error) {
        console.warn(`time control: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      return;
    }
    onChange();
  });
}

/**
 * The running engine (ViewerApi), with its parts for a host built with the engine's source.
 */
export class ViewerSession implements ViewerApi {
  private readonly listeners = new Set<ViewerChangeListener>();
  private handlers: Maybe<Record<string, ToolHandler>> = null;

  constructor(
    readonly director: Director,
    readonly time: TimeControl,
    readonly link: HubLink,
    readonly engine: Maybe<Engine>,
    private readonly presentation: Presentation
  ) {}

  async Call(tool: string, args: unknown = {}): Promise<unknown> {
    this.handlers ??= this.director.Handlers();
    const handler = this.handlers[tool];
    if (!handler) throw new Error(`"${tool}" is not a page tool`);
    return handler((args ?? {}) as Record<string, unknown>);
  }

  CallHub(tool: string, args: Record<string, unknown> = {}, options: HubCallOptions = {}): Promise<unknown> {
    return this.link.Call(tool, args, options);
  }

  Fleets(): FleetView[] {
    return this.director.FleetViews();
  }

  Time(): Maybe<TimeReport> {
    return this.time.Report();
  }

  Timeline(): Maybe<TimelineSummary> {
    return this.director.timeline.Summary();
  }

  Scene(): Maybe<SceneDocument> {
    return this.director.scene ?? null;
  }

  OnChange(listener: ViewerChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  SetUiHidden(hidden: boolean): void {
    this.presentation.SetHud(!hidden);
  }

  UiHidden(): boolean {
    return this.presentation.uiHidden;
  }

  /**
   * Tells every listener.
   *
   * @param change - What changed.
   */
  Changed(change: ViewerChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn(`a viewer change listener failed: ${ErrorText(error)}`);
      }
    }
  }
}

/**
 * Boots the engine on a canvas.
 *
 * @param options - The canvas, the store's prefix, the keys, the listener.
 * @returns The running engine, once its director serves the page tools (the initial scene may still be loading).
 */
export async function StartViewer(options: ViewerStartOptions): Promise<ViewerSession> {
  const { canvas, keys = true, onStatus = () => undefined } = options;
  const search = options.search ?? location.search;
  const params = new URLSearchParams(search);
  let session: Maybe<ViewerSession> = null;
  const changed = (change: ViewerChange): void => {
    session?.Changed(change);
    options.onChange?.(change);
  };
  const presentation = new Presentation(canvas, params, () => changed('ui'), keys);
  let liveDirector: Maybe<Director> = null;
  // First, so its capture listeners run before every other handler while an export locks the tab.
  new InputLock(() => liveDirector);
  let booted: Maybe<PageEveData> = null;
  const link = new HubLink({
    onStatus: (connected) => {
      onStatus({ hub: connected });
      liveDirector?.LinkStatus(connected);
    },
    // A hub restarted in another EVE data mode (the MCP hub with SCENE_DIRECTOR_EVE_DATA): reload into its mode.
    onHello: (hub) => {
      const mode = hub !== null && typeof hub === 'object' ? readEveDataStatus((hub as Record<string, unknown>)['eveData']) : null;
      if (booted && HubModeChanged(booted, mode)) location.reload();
    }
  });
  link.CaptureConsole();
  // The EVE data mode, before anything asks for EVE data: the hub's (GET /config), or this tab's ?eve=off.
  const eveData = PageEveDataOf({ hub: (await FetchHubConfig())?.eveData ?? null, search });
  if (eveData.note) console.info(`${eveData.note}: ships and objects draw as stand-in cubes on a green screen; the page asks for no EVE file, lookup, map or sound`);
  booted = eveData;
  onStatus({ eveData });
  ConfigureResources(eveData);

  const store = new SceneStore(options.store);
  let initial: unknown = WELCOME_SCENE;
  try {
    const saved = await store.Get(store.currentKey);
    if (saved) initial = normalizeScene(saved).scene;
  } catch (error) {
    console.warn(`the saved working scene could not be restored (${ErrorText(error)}); showing the welcome scene`);
  }

  const clock = new SceneClock();
  const world = new DestinyWorld();
  const timeControl = new TimeControl({ clock, world });
  onStatus({ time: timeControl });
  if (keys) TimeKeys(timeControl, () => changed('time'));
  let engine: Maybe<Engine> = null;
  let engineError: Maybe<Error> = null;
  let lastTick = world.tick;
  const frame = (timestamp: number): void => {
    // A preparing timeline releases the clock here, so t = 0 is this frame's boundary at the earliest.
    liveDirector?.DriveTimeline();
    const exporter = liveDirector?.exporter;
    const recorder = liveDirector?.recorder;
    let now: number;
    if (exporter?.driving) {
      // A movie export steps the clock to its next frame (FrameTo); null: it waits, and nothing is drawn this frame.
      const step = exporter.Step();
      if (!step) {
        requestAnimationFrame(frame);
        return;
      }
      now = step.clock;
    } else if (recorder?.driving) {
      // A live recording steps the record lock (sd-export): null waits (backpressure, no grid frame due) and draws nothing,
      // unless a screenshot waits for a frame.
      const step = recorder.Step(timestamp, engine?.capturePending ?? false);
      if (!step) {
        requestAnimationFrame(frame);
        return;
      }
      now = step.clock;
    } else if (timeControl.frameLock != null) {
      // The frame lock steps the clock one 1/fps grid frame once it is due (sd-time); a wait frame draws nothing, unless
      // a screenshot waits for a frame.
      const locked = timeControl.LockedFrame(timestamp);
      if (locked.kind === 'wait' && !engine?.capturePending) {
        requestAnimationFrame(frame);
        return;
      }
      now = locked.clock;
    } else {
      // Every tick boundary up to the frame's time, at the clock's rate; a failing tick is logged once and the loop goes on.
      now = timeControl.Frame(timestamp);
    }
    liveDirector?.DriveBoosters(now);
    liveDirector?.DriveStandIns(now);
    liveDirector?.fields.DriveLod();
    liveDirector?.TrackCamera(now);
    const shown = liveDirector?.Presentation() ?? { shot: {}, movie: null };
    presentation.Apply(shown);
    // An export is silent: no sound is posted while it runs (sd-export).
    if (!liveDirector?.exporting) liveDirector?.DriveAudio(now);
    liveDirector?.DriveModuleEffects(now);
    liveDirector?.DriveWarpEffects(now);
    liveDirector?.DriveTurrets(now);
    liveDirector?.DriveMissiles(now);
    liveDirector?.DriveExplosions(now);
    // The scene update copies effect templates (a burning hull's fires, per damage locator): with the audio seams
    // detached, so the copies' emitters stay inert. No page audio is posted inside engine.Frame (sd-runtime → Audio).
    engine?.SetFixedSize(shown.export?.picture ?? null);
    InAudioDetachScope(() => engine?.Frame(timestamp, now));
    // The capture reads the canvas before it is presented: in this task, right after the draw.
    liveDirector?.exporter?.AfterFrame();
    liveDirector?.recorder?.AfterFrame();
    if (world.tick !== lastTick) {
      lastTick = world.tick;
      changed('tick');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  try {
    const universe = normalizeScene(initial).scene.environment.universe;
    engine = await Engine.Create({ canvas, universe, eveData });
    console.info(`renderer: ${engine.adapterInfo}; features ${engine.features.join(', ') || 'none'}`);
  } catch (error) {
    engineError = error instanceof Error ? error : new Error(String(error));
    console.error(`renderer unavailable: ${engineError.message}`);
  }

  const audioOff = params.get('audio') === 'off' ? '?audio=off' : null;
  const director: Director = new Director({ engine, engineError, store, world, clock, onChange: () => changed('scene'), eveData, audioOff, keys });
  liveDirector = director;
  director.AttachTime(timeControl);
  director.AttachLink(link);
  // The runtime's own object loads and the scene update build effects too (a burning hull's fires): they run with the
  // audio seams detached, like every SOF build, so only the page's emitters register (sd-runtime → Audio).
  SetAudioDetachScope((build) => director.audio.Detached(build));
  // Browsers start audio only from a user gesture; at startup it goes on only when the tab may autoplay.
  // A touch activates on pointerup, not pointerdown.
  const gesture = (): void => director.audio.Gesture();
  addEventListener('pointerdown', gesture, { capture: true });
  addEventListener('pointerup', gesture, { capture: true });
  addEventListener('keydown', gesture, { capture: true });
  void director.audio.Enable({ auto: true });
  session = new ViewerSession(director, timeControl, link, engine, presentation);
  onStatus({ director });
  for (const [name, handler] of Object.entries(director.Handlers())) link.Handle(name, handler);
  link.Connect();

  void director
    .Load(initial)
    .then((result) => {
      for (const ship of (result as { ships?: { id: string; status: string; error?: string }[] }).ships ?? []) if (ship.status === 'failed') console.warn(`${ship.id}: ${ship.error}`);
    })
    .catch((error: unknown) => console.error(`initial scene failed: ${ErrorText(error)}`));
  // For poking at from the browser console.
  Object.assign(globalThis, { sceneDirector: { director, engine, link, world, clock, timeControl, session } });
  return session;
}
