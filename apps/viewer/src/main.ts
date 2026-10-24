/**
 * The viewer page: restores the last scene, starts the Destiny simulation and
 * the renderer, and serves the page-side tools over the hub link.
 *
 * One animation loop drives everything: time control steps the scene clock
 * and the Destiny parks to the frame's time one tick at a time (at its rate,
 * or not at all while paused), then the page draws at it, so the ships' ball
 * curves are sampled on the clock the parks run on. It runs with or without
 * WebGPU. Space pauses or plays; [ and ] halve or double the rate.
 *
 * Audio (the prop mods' engine sounds) turns on at startup when the tab may
 * autoplay, else on the first click or keypress; `?audio=off` keeps it off.
 *
 * Presentation: `?letterbox=2.39` (or `off`) letterboxes the frame and L
 * toggles a 2.39 letterbox; `?hud=off` hides the overlay and H toggles it. A
 * playing camera shot's `letterbox` / `hud` override them while it plays.
 */

import type { Maybe } from '@dereekb/util';
import { MAX_TIME_RATE, MIN_TIME_RATE, normalizeScene, SCENE_SCHEMA } from '@scene-director/scene';
import { InAudioDetachScope, SetAudioDetachScope } from './lib/audio-guard';
import { DressingText } from './lib/celestials';
import { SceneClock } from './lib/clock';
import { DestinyWorld } from './lib/destiny';
import { Director } from './lib/director';
import { Engine } from './lib/engine';
import { HubLink } from './lib/link';
import { LocationText } from './lib/location';
import { AsteroidFieldsText } from './lib/asteroid-fields';
import { ObjectsText } from './lib/objects';
import { TimelineText } from './lib/timeline';
import { TimeControl, TimeText } from './lib/time-control';
import { LetterboxRect } from './lib/cinema';
import { CameraDirectorText } from './lib/camera-director';
import { ConfigureResources, ErrorText } from './lib/resources';
import { CURRENT_KEY, SceneStore } from './lib/store';

/**
 * What a first visit shows, so the page is never empty.
 */
const WELCOME_SCENE = {
  schema: SCENE_SCHEMA,
  name: 'welcome',
  ships: [{ id: 'punisher-1', dna: 'af1_t1:amarrbase:amarr', name: 'Punisher', position: [0, 0, 0] }]
};

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * The aspect L letterboxes to: anamorphic scope.
 */
const SCOPE_ASPECT = 2.39;

interface OverlayState {
  hub: boolean;
  renderer: string;
  director: Maybe<Director>;
  time: Maybe<TimeControl>;
}

/**
 * The status panel over the canvas: hub link, renderer, scene, each fleet's formation and per-ship build status, with
 * a button per ship to follow it with the camera. H toggles it.
 */
class Overlay {
  private readonly element: HTMLElement;
  private readonly state: OverlayState = { hub: false, renderer: 'starting', director: null, time: null };

  constructor(element: HTMLElement) {
    this.element = element;
    // pointerdown, not click: the panel re-renders every second, which can swap the button between press and release.
    this.element.addEventListener('pointerdown', (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-follow]') : null;
      const director = this.state.director;
      if (button && director) {
        const id = button.dataset['follow'] ?? null;
        director.FollowShip(id === director.followedShip ? null : id);
      }
    });
    setInterval(() => this.Render(), 1000);
  }

  Set(patch: Partial<OverlayState>): void {
    Object.assign(this.state, patch);
    this.Render();
  }

  Render(director: Maybe<Director> = this.state.director): void {
    this.state.director = director;
    const scene = director?.scene;
    const rows: [string, string][] = [
      ['hub', this.state.hub ? 'connected' : 'connecting...'],
      ['renderer', this.RendererText(director)],
      ['scene', scene ? `${scene.name} · ${scene.ships.length} ship(s)` + (scene.objects?.length ? ` · ${scene.objects.length} object(s)` : '') : 'none']
    ];
    if (this.state.time) rows.push(['time', TimeText(this.state.time.Report())]);
    if (director) rows.push(['audio', director.audio.Text()]);
    const located = director?.location.Report();
    if (located) rows.push(['location', LocationText(located)]);
    const dressed = DressingText(director?.dressing.Report());
    if (dressed) rows.push(['dressing', dressed]);
    const objectsText = ObjectsText((scene?.objects ?? []).map((doc) => ({ status: director?.objects.Entry(doc.id)?.status ?? 'queued' })));
    if (objectsText) rows.push(['objects', objectsText]);
    const fieldsText = AsteroidFieldsText(
      (scene?.asteroidFields ?? []).map((doc) => {
        const entry = director?.fields.Entry(doc.id);
        return { status: entry?.status ?? 'queued', rocks: { placed: entry?.expansion?.placed ?? 0 } };
      })
    );
    if (fieldsText) rows.push(['fields', fieldsText]);
    const timeline = TimelineText(director?.timeline.Summary());
    if (timeline) rows.push(['timeline', timeline]);
    const camera = director ? CameraDirectorText(director.cameraDirector.Report()) : null;
    if (camera) rows.push(['director', camera]);
    for (const fleet of scene?.fleets ?? []) {
      const formation = director?.following.FleetReport(fleet);
      if (formation) rows.push([`fleet ${fleet.id}`, formation.ready ? `${formation.following} following · ${formation.inFormation} in formation` : `${formation.following} waiting for hull radii`]);
    }
    const followed = director?.followedShip;
    const ships = (scene?.ships ?? []).map((doc) => {
      const entry = director?.live.get(doc.id);
      const error = entry?.error ? `<div class="error">${Escape(entry.error)}</div>` : '';
      const following = doc.id === followed;
      const button = `<button class="follow${following ? ' on' : ''}" data-follow="${Escape(doc.id)}" title="${following ? 'Stop following' : 'Follow with the camera'}">${following ? 'following' : 'follow'}</button>`;
      return `<li class="${entry?.status ?? ''}">${button} ${Escape(doc.id)} <span>${Escape(entry?.status ?? '?')}</span>${error}</li>`;
    });
    for (const doc of scene?.objects ?? []) {
      const entry = director?.objects.Entry(doc.id);
      const error = entry?.error ? `<div class="error">${Escape(entry.error)}</div>` : '';
      const following = doc.id === followed;
      const button = `<button class="follow${following ? ' on' : ''}" data-follow="${Escape(doc.id)}" title="${following ? 'Stop following' : 'Follow with the camera'}">${following ? 'following' : 'follow'}</button>`;
      ships.push(`<li class="${entry?.status ?? ''}">${button} ${Escape(doc.id)} <span>${Escape(doc.name ?? String(doc.type ?? 'object'))} · ${Escape(entry?.status ?? '?')}</span>${error}</li>`);
    }
    const list = ships.length ? `<ul>${ships.join('')}</ul>` : '';
    const scrolled = this.element.querySelector('ul')?.scrollTop ?? 0;
    this.element.innerHTML = `
      <h1>scene-director</h1>
      <dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${Escape(value)}</dd>`).join('')}</dl>
      ${list}
      <p class="hint">Drag to orbit · shift-drag to pan · wheel to zoom · alt-click a ship or object to follow it · C chase camera · D director camera · L letterbox · Space pauses · [ ] slower or faster · ← back 10 s · H hides this</p>`;
    const shipList = this.element.querySelector('ul');
    if (shipList) shipList.scrollTop = scrolled;
  }

  private RendererText(director: Maybe<Director>): string {
    const engine = director?.engine;
    let text: string;
    if (engine) {
      const frameError = engine.lastError ? ` · frame error: ${engine.lastError}` : '';
      text = `${engine.adapterInfo} · ${engine.Stats().fps} fps${frameError}`;
    } else {
      text = director?.engineError?.message ?? this.state.renderer;
    }
    return text;
  }
}

/**
 * The frame's presentation for clean frames: the letterbox resizes the canvas element to the aspect, centred on black
 * bars, so the swap chain, screenshots and captures are exactly the frame; the HUD is the overlay. A playing shot's
 * `letterbox` / `hud` win while it plays, then the page's settings come back.
 */
class Presentation {
  private letterbox: Maybe<number>;
  private hud: boolean;
  private applied = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLElement,
    search: URLSearchParams
  ) {
    const aspect = Number(search.get('letterbox'));
    this.letterbox = Number.isFinite(aspect) && aspect >= 0.5 && aspect <= 4 ? aspect : null;
    this.hud = search.get('hud') !== 'off';
    addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'h') this.hud = !this.hud;
      else if (key === 'l') this.letterbox = this.letterbox ? null : SCOPE_ASPECT;
    });
  }

  /**
   * Applies the page's settings under the shot's; cheap when nothing changed (the animation loop calls it every frame).
   *
   * @param shot - The playing shot's presentation (CinemaRig.Presentation).
   */
  Apply(shot: { readonly letterbox?: number | false; readonly hud?: boolean }): void {
    const letterbox = shot.letterbox === undefined ? this.letterbox : shot.letterbox || null;
    const hud = shot.hud ?? this.hud;
    const key = `${letterbox}:${hud}:${innerWidth}x${innerHeight}`;
    if (key === this.applied) return;
    this.applied = key;
    const box = LetterboxRect(innerWidth, innerHeight, letterbox);
    const style = this.canvas.style;
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    document.body.style.background = letterbox ? '#000' : '';
    this.overlay.hidden = !hud;
  }
}

/**
 * The time control keys: Space pauses or plays, [ and ] halve or double the rate, ← jumps back BACK_KEY_SECONDS (as far
 * as the window reaches). Ignored with Ctrl, Meta or Alt, and while a button or a text field has focus.
 *
 * @param time - The page's time control.
 * @param onChange - Re-renders the overlay.
 */
const BACK_KEY_SECONDS = 10;

function TimeKeys(time: TimeControl, onChange: () => void): void {
  addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement || focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) return;
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
 * Escapes text for HTML.
 *
 * @param text - Anything.
 * @returns Its string form with HTML metacharacters escaped.
 */
function Escape(text: unknown): string {
  return String(text).replaceAll(/[&<>"]/gu, (character) => HTML_ESCAPES[character]);
}

/**
 * The element with an id, which the page's HTML guarantees.
 *
 * @param id - The element id.
 * @returns The element.
 * @throws {Error} When the page has no such element.
 */
function RequireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the page has no #${id}`);
  return element as T;
}

/**
 * Boots the viewer.
 */
async function Start(): Promise<void> {
  const overlay = new Overlay(RequireElement('overlay'));
  const presentation = new Presentation(RequireElement<HTMLCanvasElement>('view'), RequireElement('overlay'), new URLSearchParams(location.search));
  const link = new HubLink({ onStatus: (connected) => overlay.Set({ hub: connected }) });
  link.CaptureConsole();
  ConfigureResources();

  const store = new SceneStore();
  let initial: unknown = WELCOME_SCENE;
  try {
    const saved = await store.Get(CURRENT_KEY);
    if (saved) initial = normalizeScene(saved).scene;
  } catch (error) {
    console.warn(`the saved working scene could not be restored (${ErrorText(error)}); showing the welcome scene`);
  }

  const clock = new SceneClock();
  const world = new DestinyWorld();
  const timeControl = new TimeControl({ clock, world });
  overlay.Set({ time: timeControl });
  TimeKeys(timeControl, () => overlay.Render());
  let engine: Maybe<Engine> = null;
  let engineError: Maybe<Error> = null;
  let liveDirector: Maybe<Director> = null;
  const frame = (timestamp: number): void => {
    // A preparing timeline releases the clock here, so t = 0 is this frame's boundary at the earliest.
    liveDirector?.DriveTimeline();
    // Every tick boundary up to the frame's time, at the clock's rate; a failing tick is logged once and the loop goes on.
    const now = timeControl.Frame(timestamp);
    liveDirector?.DriveBoosters(now);
    liveDirector?.fields.DriveLod();
    liveDirector?.TrackCamera(now);
    presentation.Apply(liveDirector?.cinema.Presentation() ?? {});
    liveDirector?.DriveAudio(now);
    liveDirector?.DriveModuleEffects(now);
    liveDirector?.DriveWarpEffects(now);
    liveDirector?.DriveTurrets(now);
    liveDirector?.DriveMissiles(now);
    liveDirector?.DriveExplosions(now);
    // The scene update copies effect templates (a burning hull's fires, per damage locator): with the audio seams
    // detached, so the copies' emitters stay inert. No page audio is posted inside engine.Frame (sd-runtime → Audio).
    InAudioDetachScope(() => engine?.Frame(timestamp, now));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  try {
    const universe = normalizeScene(initial).scene.environment.universe;
    engine = await Engine.Create({ canvas: RequireElement<HTMLCanvasElement>('view'), universe });
    console.info(`renderer: ${engine.adapterInfo}; features ${engine.features.join(', ') || 'none'}`);
  } catch (error) {
    engineError = error instanceof Error ? error : new Error(String(error));
    console.error(`renderer unavailable: ${engineError.message}`);
  }

  const audioDisabled = new URLSearchParams(location.search).get('audio') === 'off';
  const director: Director = new Director({ engine, engineError, store, world, clock, onChange: () => overlay.Render(director), audioDisabled });
  liveDirector = director;
  director.AttachTime(timeControl);
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
  overlay.Render(director);
  for (const [name, handler] of Object.entries(director.Handlers())) link.Handle(name, handler);
  link.Connect();

  try {
    const result = (await director.Load(initial)) as { ships?: { id: string; status: string; error?: string }[] };
    for (const ship of result.ships ?? []) if (ship.status === 'failed') console.warn(`${ship.id}: ${ship.error}`);
  } catch (error) {
    console.error(`initial scene failed: ${ErrorText(error)}`);
  }
  // For poking at from the browser console.
  Object.assign(globalThis, { sceneDirector: { director, engine, link, world, clock, timeControl } });
}

Start().catch((error: unknown) => console.error(`viewer failed to start: ${ErrorText(error)}\n${(error as Maybe<Error>)?.stack ?? ''}`));
