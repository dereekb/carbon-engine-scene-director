/**
 * The viewer page: restores the last scene, starts the renderer, and serves
 * the page-side tools over the hub link.
 */

import { normalizeScene, SCENE_SCHEMA } from "../shared/scene.js";
import { Director } from "./director.js";
import { Engine } from "./engine.js";
import { HubLink } from "./link.js";
import { ConfigureResources } from "./resources.js";
import { CURRENT_KEY, SceneStore } from "./store.js";

/** What a first visit shows, so the page is never empty. */
const WELCOME_SCENE = {
  schema: SCENE_SCHEMA,
  name: "welcome",
  ships: [ { id: "punisher-1", dna: "af1_t1:amarrbase:amarr", name: "Punisher", position: [ 0, 0, 0 ] } ]
};

class Overlay
{
  constructor(element)
  {
    this.element = element;
    this.state = { hub: false, renderer: "starting", director: null };
    addEventListener("keydown", event =>
    {
      if (event.key === "h" && !event.ctrlKey && !event.metaKey) this.element.hidden = !this.element.hidden;
    });
    setInterval(() => this.Render(), 1000);
  }

  Set(patch)
  {
    Object.assign(this.state, patch);
    this.Render();
  }

  Render(director = this.state.director)
  {
    this.state.director = director;
    const scene = director?.scene;
    const engine = director?.engine;
    const rows = [
      [ "hub", this.state.hub ? "connected" : "connecting..." ],
      [ "renderer", engine ? `${engine.adapterInfo} · ${engine.Stats().fps} fps${engine.lastError ? ` · frame error: ${engine.lastError}` : ""}` : (director?.engineError?.message ?? this.state.renderer) ],
      [ "scene", scene ? `${scene.name} · ${scene.ships.length} ship(s)` : "none" ]
    ];
    const ships = (scene?.ships ?? []).map(doc =>
    {
      const entry = director.live.get(doc.id);
      return `<li class="${entry?.status ?? ""}">${Escape(doc.id)} <span>${Escape(entry?.status ?? "?")}</span>${entry?.error ? `<div class="error">${Escape(entry.error)}</div>` : ""}</li>`;
    });
    this.element.innerHTML = `
      <h1>scene-director</h1>
      <dl>${rows.map(([ key, value ]) => `<dt>${key}</dt><dd>${Escape(value)}</dd>`).join("")}</dl>
      ${ships.length ? `<ul>${ships.join("")}</ul>` : ""}
      <p class="hint">Drag to orbit · shift-drag to pan · wheel to zoom · H hides this</p>`;
  }
}

function Escape(text)
{
  return String(text).replace(/[&<>"]/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
}

async function Start()
{
  const overlay = new Overlay(document.getElementById("overlay"));
  const link = new HubLink({ onStatus: connected => overlay.Set({ hub: connected }) });
  link.CaptureConsole();
  ConfigureResources();

  const store = new SceneStore();
  let initial = WELCOME_SCENE;
  try
  {
    const saved = await store.Get(CURRENT_KEY);
    if (saved) initial = normalizeScene(saved).scene;
  }
  catch (error)
  {
    console.warn(`the saved working scene could not be restored (${error.message}); showing the welcome scene`);
  }

  let engine = null;
  let engineError = null;
  try
  {
    engine = await Engine.Create({ canvas: document.getElementById("view"), universe: normalizeScene(initial).scene.environment.universe });
    console.info(`renderer: ${engine.adapterInfo}; features ${engine.features.join(", ") || "none"}`);
  }
  catch (error)
  {
    engineError = error;
    console.error(`renderer unavailable: ${error.message}`);
  }

  const director = new Director({ engine, engineError, store, onChange: () => overlay.Render(director) });
  overlay.Render(director);
  for (const [ name, handler ] of Object.entries(director.Handlers())) link.Handle(name, handler);
  link.Connect();

  try
  {
    const result = await director.Load(initial);
    for (const ship of result.ships ?? []) if (ship.status === "failed") console.warn(`${ship.id}: ${ship.error}`);
  }
  catch (error)
  {
    console.error(`initial scene failed: ${error.message}`);
  }
  // For poking at from the browser console.
  globalThis.sceneDirector = { director, engine, link };
}

Start().catch(error => console.error(`viewer failed to start: ${error.message}\n${error.stack ?? ""}`));
