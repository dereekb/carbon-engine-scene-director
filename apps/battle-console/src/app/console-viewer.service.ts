import { DOCUMENT, Injectable, InjectionToken, type OnDestroy, computed, inject, signal } from '@angular/core';
import type { Maybe } from '@dereekb/util';
import type { SceneDocument, TimelineSummary, TimeReport } from '@scene-director/scene';
import type { FleetView, StartViewerOptions, ViewerApi, ViewerChange } from '@scene-director/viewer-engine/api';

/**
 * Loads the engine module and starts it (`StartViewer` from @scene-director/viewer-engine, which the import map
 * resolves to /console/engine.js). A token so specs can hand in a fake engine.
 */
export type ConsoleEngineStarter = (options: StartViewerOptions) => Promise<ViewerApi>;

export const CONSOLE_ENGINE_STARTER = new InjectionToken<ConsoleEngineStarter>('ConsoleEngineStarter');

/**
 * The panel's refresh period: OnChange fires at every Destiny tick and scene change, the panel redraws at most 4 times
 * a second.
 */
export const CONSOLE_PANEL_REFRESH_MS = 250;

/**
 * The working copy's IndexedDB key prefix: the console restores its own scene, not the viewer's (same origin).
 */
export const CONSOLE_STORE_PREFIX = 'console:';

/**
 * The body class that hides the whole console UI (the panels and the CDK overlay container) while the engine's UI is
 * hidden (H, a movie's or a shot's look).
 */
export const CONSOLE_UI_HIDDEN_CLASS = 'console-ui-hidden';

export type ConsoleEngineState = 'idle' | 'starting' | 'running' | 'failed';

/**
 * Holds the running engine and feeds the panel's signals from ViewerApi.OnChange, throttled to CONSOLE_PANEL_REFRESH_MS.
 * No template getter builds a report: components read these signals.
 */
@Injectable({ providedIn: 'root' })
export class ConsoleViewerService implements OnDestroy {
  private readonly _document = inject(DOCUMENT);
  private readonly _starter = inject(CONSOLE_ENGINE_STARTER);

  private _api: Maybe<ViewerApi>;
  private _flushTimer: Maybe<ReturnType<typeof setTimeout>>;
  private _lastFlush = 0;

  readonly state = signal<ConsoleEngineState>('idle');
  readonly error = signal<Maybe<string>>(undefined);
  readonly fleets = signal<readonly FleetView[]>([]);
  readonly time = signal<Maybe<TimeReport>>(undefined);
  readonly timeline = signal<Maybe<TimelineSummary>>(undefined);
  readonly scene = signal<Maybe<SceneDocument>>(undefined);
  readonly uiHidden = signal(false);

  readonly sceneName = computed(() => this.scene()?.name);
  readonly shipCount = computed(() => this.scene()?.ships?.length ?? 0);

  /**
   * The running engine; null until start() resolves.
   *
   * @returns The engine, or null.
   */
  get api(): Maybe<ViewerApi> {
    return this._api;
  }

  /**
   * Starts the engine on the canvas once; later calls return the same start.
   *
   * @param canvas - The page's canvas.
   * @returns The engine, or null when it failed to start (state 'failed', error set).
   */
  async start(canvas: HTMLCanvasElement): Promise<Maybe<ViewerApi>> {
    let result: Maybe<ViewerApi> = this._api;

    if (this.state() === 'idle') {
      this.state.set('starting');

      try {
        const api = await this._starter({ canvas, store: { prefix: CONSOLE_STORE_PREFIX }, onChange: (change) => this.changed(change) });
        this._api = api;
        this.state.set('running');
        this.flush();
        result = api;
      } catch (error) {
        this.state.set('failed');
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }

    return result;
  }

  /**
   * Called on every engine change: a UI change applies at once, the rest flush at most every CONSOLE_PANEL_REFRESH_MS.
   *
   * @param change - What changed.
   */
  changed(change: ViewerChange): void {
    if (change === 'ui') {
      this.applyUiHidden();
    } else if (this._flushTimer == null) {
      const wait = Math.max(0, this._lastFlush + CONSOLE_PANEL_REFRESH_MS - Date.now());

      this._flushTimer = setTimeout(() => {
        this._flushTimer = undefined;
        this.flush();
      }, wait);
    }
  }

  /**
   * Reads the engine's views into the signals now.
   */
  flush(): void {
    const api = this._api;

    if (api) {
      this._lastFlush = Date.now();
      this.fleets.set(api.Fleets());
      this.time.set(api.Time());
      this.timeline.set(api.Timeline());
      this.scene.set(api.Scene());
      this.applyUiHidden();
    }
  }

  private applyUiHidden(): void {
    const hidden = this._api?.UiHidden() ?? false;
    this.uiHidden.set(hidden);
    this._document.body.classList.toggle(CONSOLE_UI_HIDDEN_CLASS, hidden);
  }

  ngOnDestroy(): void {
    if (this._flushTimer != null) {
      clearTimeout(this._flushTimer);
    }
  }
}
