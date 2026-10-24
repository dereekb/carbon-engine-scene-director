/**
 * The engine's public face (sd-workspace → the engine library): what a page that hosts the engine (the read-only viewer,
 * the battle console) reaches it through. Runtime-free: types only, plus `@scene-director/scene`'s, so a host's type
 * check (the console's ambient `@scene-director/viewer-engine` module) never sees the runtime.
 *
 * Page tools go through the director's handlers (`Call`), so a host's calls are journaled for time control and take a
 * fleet's brain levers exactly as a model's do. Fleet state comes from read-only views (`Fleets`), assembled each call
 * from the brain, the calls, the pilots, the logi and the arrivals (fleet-view.ts `toFleetView`).
 */

import type { Maybe } from '@dereekb/util';
import type { FleetBrainLever, FleetTargetRole, SceneDocument, SceneVector, TimelineSummary, TimeReport } from '@scene-director/scene';

/**
 * What a personality fleet's FC brain is doing: commanding, handing over to a successor, leaderless, waiting at its gate
 * (the formation, arrivals), or with no team (so no hostiles). `none`: the fleet runs no brain (no personality).
 */
export type FleetViewBrainState = 'commanding' | 'handover' | 'leaderless' | 'waiting' | 'no-team' | 'none';

/**
 * One hostile in a fleet's target list: the brain's last picture, ranked by its targeting.
 */
export interface FleetViewTarget {
  readonly id: string;
  readonly team?: string;
  readonly role: FleetTargetRole;
  /**
   * Metres from the fleet's FC.
   */
  readonly distance: number;
  /**
   * Remaining HP over max, 0..1.
   */
  readonly health: number;
  /**
   * The damage per second it can apply now.
   */
  readonly dps: number;
  /**
   * Within the reach the fleet calls targets in.
   */
  readonly inReach: boolean;
  /**
   * The fleet's primary (`primary`) or in its queue (`queued`).
   */
  readonly called?: 'primary' | 'queued';
}

/**
 * A personality fleet's FC brain: its report (get_state fleets[].fc), trimmed to what a panel shows.
 */
export interface FleetViewBrain {
  readonly personality: string;
  readonly state: Exclude<FleetViewBrainState, 'none'>;
  readonly ability: number;
  readonly engaged: boolean;
  readonly engagedBy?: string;
  /**
   * The stance the brain flies the FC in (its personality's, or the live one an order set).
   */
  readonly stance: string;
  /**
   * The levers a manual order took, and whether a cease_fire holds its calls and free fire.
   */
  readonly manual: readonly FleetBrainLever[];
  readonly held: boolean;
  readonly successor?: string;
  readonly takesOverIn?: number;
  readonly hostiles: number;
  /**
   * The latest decisions, newest last.
   */
  readonly decisions: readonly { readonly tick: number; readonly lever: FleetBrainLever; readonly why: string; readonly refused?: string }[];
  readonly note?: string;
}

/**
 * Where the acting FC is and how it moves, origin-relative metres and m/s.
 */
export interface FleetViewMotion {
  readonly position: SceneVector;
  readonly velocity?: SceneVector;
}

/**
 * A read-only view of one fleet for a panel: built fresh on each `ViewerApi.Fleets()`.
 */
export interface FleetView {
  readonly id: string;
  readonly name?: string;
  readonly team?: string;
  /**
   * The fleet's personality key; null: no brain runs it.
   */
  readonly personality: Maybe<string>;
  /**
   * The acting FC ship.
   */
  readonly fc: string;
  readonly state: FleetViewBrainState;
  readonly brain: Maybe<FleetViewBrain>;
  /**
   * Members in the live document, those not destroyed, and those still arriving from a warp-in.
   */
  readonly ships: number;
  readonly alive: number;
  readonly arriving: number;
  /**
   * The alive members' remaining HP over their max, 0..1; null with none alive.
   */
  readonly health: Maybe<number>;
  /**
   * The fleet's called primary and queue, and whether its free fire is on.
   */
  readonly primary: Maybe<string>;
  readonly queue: readonly string[];
  readonly freeFire: boolean;
  /**
   * The ranked hostiles (brain fleets only; empty before the brain's first picture).
   */
  readonly targets: readonly FleetViewTarget[];
  /**
   * The reach the brain calls targets within, metres; null before its first picture.
   */
  readonly reach: Maybe<number>;
  readonly fcMotion: Maybe<FleetViewMotion>;
  /**
   * Members by stance state (get_state fleets[].stances).
   */
  readonly stances: Readonly<Record<string, number>>;
  readonly formation: Maybe<{ readonly ready: boolean; readonly following: number; readonly inFormation: number; readonly warping: number }>;
  readonly logi: Maybe<{ readonly logi: number; readonly repairing: number; readonly idle: number; readonly off: number }>;
}

/**
 * What changed, for a listener: `scene` when the director reports a change (a load, a patch, a build, an order), `tick`
 * at each Destiny tick boundary the clock passes, `time` after a time key (Space, [ ], ←), `ui` when the host's UI was
 * shown or hidden (H, SetUiHidden, a movie's or a shot's look).
 */
export type ViewerChange = 'scene' | 'tick' | 'time' | 'ui';

export type ViewerChangeListener = (change: ViewerChange) => void;

/**
 * What StartViewer takes.
 */
export interface StartViewerOptions {
  /**
   * The canvas the engine draws to.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * The working copy's IndexedDB key prefix (store.ts): pages on one origin each restore their own scene. None (the
   * viewer's) by default.
   */
  readonly store?: { readonly prefix?: string };
  /**
   * Whether the engine's keys run (Space, [ ], ←, H, L, C, D); on by default. Either way they skip key events inside an
   * element marked `data-ui` or a form-like one (ui-focus.ts).
   */
  readonly keys?: boolean;
  /**
   * Called on every change (as ViewerApi.OnChange).
   */
  readonly onChange?: ViewerChangeListener;
  /**
   * The page's settings: `?letterbox=`, `?hud=off`, `?audio=off`, `?eve=off`. The window's location by default.
   */
  readonly search?: string;
}

/**
 * The running engine, for its host page.
 */
export interface ViewerApi {
  /**
   * Runs a page tool (the director's handlers, the same ones the hub link forwards to).
   *
   * @param tool - The tool name (packages/scene tools.ts, `where: 'page'`).
   * @param args - Its arguments.
   * @returns Its result.
   */
  Call(tool: string, args?: unknown): Promise<unknown>;
  /**
   * Runs a hub tool over the page's link (`where: 'hub'`: staging on a passed scene, the libraries, lookups). The hub
   * refuses page tools; call those with Call.
   *
   * @param tool - The tool name (packages/scene tools.ts, `where: 'hub'`).
   * @param args - Its arguments.
   * @param options - `timeout` in milliseconds (120 s by default).
   * @returns Its result; a refusal rejects with an Error carrying the hub's `problems` when it gave them.
   */
  CallHub(tool: string, args?: Record<string, unknown>, options?: { readonly timeout?: number }): Promise<unknown>;
  /**
   * Every fleet in the live scene, as panel views.
   */
  Fleets(): FleetView[];
  /**
   * The time control's report (get_state time); null before the engine started.
   */
  Time(): Maybe<TimeReport>;
  /**
   * The timeline's summary; null without one.
   */
  Timeline(): Maybe<TimelineSummary>;
  /**
   * The live scene document; null before the first load.
   */
  Scene(): Maybe<SceneDocument>;
  /**
   * Listens for changes; returns the unsubscribe.
   */
  OnChange(listener: ViewerChangeListener): () => void;
  /**
   * Hides or shows the host's UI, as H does (the movie's and the shot's looks still apply over it).
   */
  SetUiHidden(hidden: boolean): void;
  /**
   * Whether the host's UI is hidden now.
   */
  UiHidden(): boolean;
}
