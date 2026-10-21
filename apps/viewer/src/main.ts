/**
 * The viewer page: restores the last scene, starts the renderer, and serves
 * the page-side tools over the hub link.
 */

import type { Maybe } from '@dereekb/util';
import { normalizeScene, SCENE_SCHEMA } from '@scene-director/scene';
import { Director } from './lib/director';
import { Engine } from './lib/engine';
import { HubLink } from './lib/link';
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

interface OverlayState {
  hub: boolean;
  renderer: string;
  director: Maybe<Director>;
}

/**
 * The status panel over the canvas: hub link, renderer, scene and per-ship build status. H toggles it.
 */
class Overlay {
  private readonly element: HTMLElement;
  private readonly state: OverlayState = { hub: false, renderer: 'starting', director: null };

  constructor(element: HTMLElement) {
    this.element = element;
    addEventListener('keydown', (event) => {
      if (event.key === 'h' && !event.ctrlKey && !event.metaKey) this.element.hidden = !this.element.hidden;
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
      ['scene', scene ? `${scene.name} · ${scene.ships.length} ship(s)` : 'none']
    ];
    const ships = (scene?.ships ?? []).map((doc) => {
      const entry = director?.live.get(doc.id);
      const error = entry?.error ? `<div class="error">${Escape(entry.error)}</div>` : '';
      return `<li class="${entry?.status ?? ''}">${Escape(doc.id)} <span>${Escape(entry?.status ?? '?')}</span>${error}</li>`;
    });
    const list = ships.length ? `<ul>${ships.join('')}</ul>` : '';
    this.element.innerHTML = `
      <h1>scene-director</h1>
      <dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${Escape(value)}</dd>`).join('')}</dl>
      ${list}
      <p class="hint">Drag to orbit · shift-drag to pan · wheel to zoom · H hides this</p>`;
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

  let engine: Maybe<Engine> = null;
  let engineError: Maybe<Error> = null;
  try {
    const universe = normalizeScene(initial).scene.environment.universe;
    engine = await Engine.Create({ canvas: RequireElement<HTMLCanvasElement>('view'), universe });
    console.info(`renderer: ${engine.adapterInfo}; features ${engine.features.join(', ') || 'none'}`);
  } catch (error) {
    engineError = error instanceof Error ? error : new Error(String(error));
    console.error(`renderer unavailable: ${engineError.message}`);
  }

  const director: Director = new Director({ engine, engineError, store, onChange: () => overlay.Render(director) });
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
  Object.assign(globalThis, { sceneDirector: { director, engine, link } });
}

Start().catch((error: unknown) => console.error(`viewer failed to start: ${ErrorText(error)}\n${(error as Maybe<Error>)?.stack ?? ''}`));
