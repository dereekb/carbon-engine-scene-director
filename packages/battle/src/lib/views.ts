import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '@scene-director/scene';

/**
 * The fleet view the console's panel and commands read: the engine's `FleetView` (viewer-engine api.ts), structurally.
 * Declared here so this package never imports the engine library.
 */
export interface BattleFleetView {
  readonly id: string;
  readonly name?: string;
  readonly team?: string;
  readonly personality: Maybe<string>;
  readonly fc: string;
  readonly state: string;
  readonly brain: Maybe<BattleFleetBrainView>;
  readonly ships: number;
  readonly alive: number;
  readonly arriving: number;
  readonly health: Maybe<number>;
  readonly primary: Maybe<string>;
  readonly queue: readonly string[];
  readonly freeFire: boolean;
  readonly targets: readonly BattleFleetTargetView[];
  readonly fcMotion: Maybe<{ readonly position: SceneVector; readonly velocity?: SceneVector }>;
}

export interface BattleFleetBrainView {
  readonly personality: string;
  readonly state: string;
  readonly engaged: boolean;
  readonly engagedBy?: string;
  readonly stance: string;
  readonly manual: readonly string[];
  readonly held: boolean;
  readonly successor?: string;
  readonly takesOverIn?: number;
}

export interface BattleFleetTargetView {
  readonly id: string;
  readonly role: string;
  readonly distance: number;
  readonly health: number;
  readonly dps: number;
  readonly inReach: boolean;
  readonly called?: 'primary' | 'queued';
}

/**
 * What a fleet card shows.
 */
export interface FleetCardView {
  readonly id: string;
  readonly title: string;
  readonly team?: string;
  readonly fc: string;
  /**
   * The FC brain's state in words (commanding, handover to X in Ns, leaderless, waiting, no brain).
   */
  readonly stateText: string;
  readonly aliveText: string;
  /**
   * The alive members' HP share, 0..100; null with none alive.
   */
  readonly healthPercent: Maybe<number>;
  readonly primary: Maybe<string>;
  readonly engaged: boolean;
  readonly held: boolean;
  readonly freeFire: boolean;
  readonly stance: Maybe<string>;
  /**
   * The levers a command or an agent took from the brain.
   */
  readonly manual: readonly string[];
  /**
   * Why the command bar is off (arriving, no brain); null when it is on.
   */
  readonly commandsBlocked: Maybe<string>;
  /**
   * No FC brain runs the fleet: the card offers a doctrine instead.
   */
  readonly offerDoctrine: boolean;
}

/**
 * One row of a fleet's target list.
 */
export interface FleetTargetRow {
  readonly id: string;
  readonly role: string;
  readonly distanceText: string;
  readonly healthPercent: number;
  readonly dps: number;
  readonly inReach: boolean;
  readonly called: Maybe<'primary' | 'queued'>;
}

/**
 * How many hostiles a card's target list shows.
 */
export const DEFAULT_FLEET_TARGET_ROWS = 8;

/**
 * Why a fleet's command bar is off, or null when commands run: while it is still arriving from a warp-in, and for a
 * fleet no FC brain runs.
 *
 * @param fleet - The fleet view.
 * @returns The reason, or null.
 */
export function fleetCommandsBlocked(fleet: BattleFleetView): Maybe<string> {
  let blocked: Maybe<string> = null;

  if (!fleet.brain) {
    blocked = 'no FC brain runs this fleet: pick a doctrine';
  } else if (fleet.arriving > 0) {
    blocked = `arriving (${fleet.arriving} still in warp)`;
  } else if (fleet.alive === 0) {
    blocked = 'no ship left';
  }

  return blocked;
}

/**
 * A fleet card's view.
 *
 * @param fleet - The fleet view.
 * @returns The card.
 */
export function toFleetCardView(fleet: BattleFleetView): FleetCardView {
  const brain = fleet.brain;
  return {
    id: fleet.id,
    title: fleet.name ?? fleet.id,
    team: fleet.team,
    fc: fleet.fc,
    stateText: brainStateText(fleet),
    aliveText: fleet.arriving > 0 ? `${fleet.alive}/${fleet.ships} alive, ${fleet.arriving} arriving` : `${fleet.alive}/${fleet.ships} alive`,
    healthPercent: fleet.health == null ? null : Math.round(fleet.health * 100),
    primary: fleet.primary,
    engaged: brain?.engaged ?? false,
    held: brain?.held ?? false,
    freeFire: fleet.freeFire,
    stance: brain?.stance ?? null,
    manual: brain?.manual ?? [],
    commandsBlocked: fleetCommandsBlocked(fleet),
    offerDoctrine: !brain
  };
}

function brainStateText(fleet: BattleFleetView): string {
  const brain = fleet.brain;
  let text: string;

  if (!brain) {
    text = 'no FC brain';
  } else if (brain.state === 'handover' && brain.successor) {
    text = brain.takesOverIn == null ? `handover to ${brain.successor}` : `handover to ${brain.successor} in ${Math.ceil(brain.takesOverIn)} s`;
  } else {
    text = `${brain.state} (${brain.personality})`;
  }

  return text;
}

/**
 * A fleet's target list: its brain's ranked hostiles, the first `limit`.
 *
 * @param fleet - The fleet view.
 * @param limit - How many rows.
 * @returns The rows.
 */
export function toFleetTargetRows(fleet: BattleFleetView, limit: number = DEFAULT_FLEET_TARGET_ROWS): FleetTargetRow[] {
  return fleet.targets.slice(0, limit).map((target) => ({
    id: target.id,
    role: target.role,
    distanceText: formatDistance(target.distance),
    healthPercent: Math.round(target.health * 100),
    dps: Math.round(target.dps),
    inReach: target.inReach,
    called: target.called ?? null
  }));
}

/**
 * A distance as a panel shows it: metres under 10 km, then km (one decimal under 100 km).
 *
 * @param metres - The distance.
 * @returns e.g. "850 m", "12.3 km", "240 km".
 */
export function formatDistance(metres: number): string {
  let text: string;

  if (metres < 10_000) {
    text = `${Math.round(metres)} m`;
  } else if (metres < 100_000) {
    text = `${(metres / 1000).toFixed(1)} km`;
  } else {
    text = `${Math.round(metres / 1000)} km`;
  }

  return text;
}
