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
   * Why it did no damage when it hit (`takes no damage: no EVE dogma for its hull`).
   */
  readonly note?: string;
}

export interface ShipKill {
  /**
   * The destroyed ship.
   */
  readonly ship: string;
  /**
   * The ship whose shot killed it, its module key and weapon name.
   */
  readonly by: string;
  readonly module: string;
  readonly weapon: string;
  /**
   * The master tick boundary of the killing shot, and its exact fractional tick.
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
  readonly by: string;
  readonly module: string;
  readonly weapon: string;
  readonly tick: number;
}
