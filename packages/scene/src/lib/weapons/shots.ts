/**
 * A weapon shot: one turret cycle start on a target, or one missile reaching its target. The page raises one at each
 * tick boundary for every turret cycle and every missile hit (Director.OnShot), before it draws; Combat rules decides
 * the hit there and applies the damage.
 */

import type { Maybe } from '@dereekb/util';
import type { DamageVector } from '../combat/damage';
import type { ShotOutcome } from '../combat/kill';
import type { MissileExplosion } from '../combat/missile-numbers';

export type ShotTargetKind = 'ship' | 'object';

/**
 * A missile hit's flight: what the missile carried from its launch.
 */
export interface WeaponShotMissile {
  /**
   * The flight's id (`<ship>|<module>|<activation>|<cycle>`).
   */
  readonly id: string;
  /**
   * The fractional master tick its launcher's cycle started at.
   */
  readonly launchedAt: number;
  /**
   * Per type, fixed at launch; null without dogma (it does no damage).
   */
  readonly damage: Maybe<DamageVector>;
  /**
   * Its explosion, fixed at launch; null without dogma.
   */
  readonly explosion: Maybe<MissileExplosion>;
}

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
   * The weapon's cycle number since it was activated (1 for the first shot; a missile's, its launch's).
   */
  readonly cycle: number;
  /**
   * The master tick boundary the shot was raised at.
   */
  readonly tick: number;
  /**
   * The exact, fractional master tick the cycle started at (at most `tick`); a missile's, its contact.
   */
  readonly at: number;
  /**
   * Metres, surface to surface, at the boundary (0 for a missile).
   */
  readonly distance: number;
  /**
   * The range half of EVE's turret hit chance (falloffEffectiveness): 1 within optimal, 0.5 at one falloff beyond it
   * (1 for a missile).
   */
  readonly effectiveness: number;
  /**
   * Set on a missile hit: its flight. Missiles apply EVE's missile formula at impact, with no roll.
   */
  readonly missile?: WeaponShotMissile;
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
