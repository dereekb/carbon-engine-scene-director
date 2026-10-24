/**
 * The plain-data records combat leaves: what a shot did and who killed whom. The page reports them in get_state; the
 * timeline, time control and the automatic camera read them later.
 */

import type { Maybe } from '@dereekb/util';
import type { DefenseLayerName } from '../fitting/defense';
import type { ShotResult } from './accuracy';
import type { CombatDeathMode } from './document';

/**
 * What one shot did.
 */
export interface ShotOutcome {
  readonly result: ShotResult;
  /**
   * The hit chance it rolled against (the application factor for a vorton).
   */
  readonly chance: number;
  /**
   * The damage factor (0 for a miss): roll + 0.49, 3 for a wrecking shot, a vorton's application.
   */
  readonly quality: number;
  /**
   * HP it took off the target, the layers summed.
   */
  readonly damage: number;
  /**
   * HP it took off each layer.
   */
  readonly layers: Readonly<Record<DefenseLayerName, number>>;
  /**
   * HP its target's immunity absorbed, at the immune layer's resists (omitted when none): the whole hit for an
   * `immune` result, the rest of it for a hit that took some HP first.
   */
  readonly absorbed?: number;
  /**
   * Why it did no damage when it hit (`takes no damage: no EVE dogma for its hull`).
   */
  readonly note?: string;
}

/**
 * What killed a ship when no shot did: a gameplay set_hp that left its structure at 0.
 */
export type ShipKillCause = 'set_hp';

export interface ShipKill {
  /**
   * The destroyed ship.
   */
  readonly ship: string;
  /**
   * The ship whose shot killed it, its module key and weapon name; absent for a set_hp kill.
   */
  readonly by?: string;
  readonly module?: string;
  readonly weapon?: string;
  /**
   * Set when no shot killed it (`set_hp`); absent for a shot.
   */
  readonly cause?: ShipKillCause;
  /**
   * The master tick boundary of the killing shot (a set_hp kill: the boundary that swept it), and its exact
   * fractional tick.
   */
  readonly tick: number;
  readonly at: number;
  readonly mode: CombatDeathMode;
  /**
   * Every ship that damaged it, with the HP it took off, most first.
   */
  readonly contributors: readonly { readonly ship: string; readonly damage: number }[];
}

/**
 * A kill as get_state lists it.
 */
export interface ShipKillReport {
  readonly ship: string;
  readonly name?: Maybe<string>;
  readonly team?: Maybe<string>;
  readonly by?: string;
  readonly module?: string;
  readonly weapon?: string;
  readonly cause?: ShipKillCause;
  readonly tick: number;
}
