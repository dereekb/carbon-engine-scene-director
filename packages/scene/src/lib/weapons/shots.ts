/**
 * A weapon shot: one turret cycle start on a target. The page raises one at each tick boundary for every turret cycle
 * (Director.OnShot), before it draws; Combat rules decides the hit there and applies the damage.
 */

import type { ShotOutcome } from '../combat/kill';

export type ShotTargetKind = 'ship' | 'object';

export interface WeaponShot {
  /**
   * The shooting ship's id.
   */
  readonly ship: string;
  /**
   * The weapon's module key (`high-0`).
   */
  readonly module: string;
  readonly typeID: number;
  readonly name: string;
  /**
   * The loaded charge, when there is one.
   */
  readonly charge?: { readonly typeID: number; readonly name: string };
  /**
   * The target's id: a ship or an authored object.
   */
  readonly target: string;
  readonly targetKind: ShotTargetKind;
  /**
   * The weapon's cycle number since it was activated (1 for the first shot).
   */
  readonly cycle: number;
  /**
   * The master tick boundary the shot was raised at.
   */
  readonly tick: number;
  /**
   * The exact, fractional master tick the cycle started at (at most `tick`).
   */
  readonly at: number;
  /**
   * Metres, surface to surface, at the boundary.
   */
  readonly distance: number;
  /**
   * The range half of EVE's turret hit chance (falloffEffectiveness): 1 within optimal, 0.5 at one falloff beyond it.
   */
  readonly effectiveness: number;
  /**
   * The weapon's activation (since the load) the cycle belongs to: with `cycle`, it keys the shot's roll.
   */
  readonly activation: number;
  /**
   * Set by a listener (Combat rules) when the shot misses: it draws past the target, without an impact.
   */
  missed?: boolean;
  /**
   * Set by Combat rules: the roll, the damage and the layers it took it from.
   */
  outcome?: ShotOutcome;
  /**
   * Set by Combat rules on the shot that destroyed its target.
   */
  fatal?: true;
}
