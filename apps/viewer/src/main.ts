/**
 * The read-only viewer page: the engine (StartViewer, @scene-director/viewer-engine) on the canvas, under a status
 * overlay: hub link, renderer, scene, each fleet's formation and per-ship build status, with a button per ship to
 * follow it with the camera. H toggles the overlay (the engine's HUD switch); the keys are the engine's.
 */

import type { Maybe } from '@dereekb/util';
import { AsteroidFieldsText, CameraDirectorText, type Director, DressingText, EVE_DATA_ON, EveDataText, ErrorText, ExportText, LocationText, ObjectsText, type PageEveData, RecordText, StartViewer, type TimeControl, TimelineText, TimeText } from '@scene-director/viewer-engine';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

interface OverlayState {
  hub: boolean;
  eveData: PageEveData;
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
  private readonly state: OverlayState = { hub: false, eveData: EVE_DATA_ON, renderer: 'starting', director: null, time: null };

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
    const eveData = EveDataText(this.state.eveData);
    const rows: [string, string][] = [
      ['hub', this.state.hub ? 'connected' : 'connecting...'],
      ...(eveData ? [['EVE data', eveData] as [string, string]] : []),
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
    const exported = director?.exporter;
    if (exported) rows.push(['export', ExportText(exported.Report())]);
    const recorded = director?.recorder;
    if (recorded) rows.push(['record', RecordText(recorded.Report())]);
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
      let greenScreen = '';
      if (!engine.eveData.on) greenScreen = ' · stand-in cubes on a green screen';
      else if (engine.greenScreen) greenScreen = ' · the universe file did not load: green screen and cubes';
      text = `${engine.adapterInfo} · ${engine.Stats().fps} fps${greenScreen}${frameError}`;
    } else {
      text = director?.engineError?.message ?? this.state.renderer;
    }
    return text;
  }
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
 * Boots the viewer: the engine, with the overlay following its status and changes.
 */
async function Start(): Promise<void> {
  const element = RequireElement('overlay');
  const overlay = new Overlay(element);
  const viewer = await StartViewer({ canvas: RequireElement<HTMLCanvasElement>('view'), onStatus: (patch) => overlay.Set(patch) });
  viewer.OnChange((change) => {
    if (change === 'ui') element.hidden = viewer.UiHidden();
    else if (change !== 'tick') overlay.Render();
  });
  // The first frames may have applied ?hud=off before this listener.
  element.hidden = viewer.UiHidden();
}

Start().catch((error: unknown) => console.error(`viewer failed to start: ${ErrorText(error)}\n${(error as Maybe<Error>)?.stack ?? ''}`));
