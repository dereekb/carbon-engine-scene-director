/**
 * Combat rules in the page: every turret shot is rolled on EVE's hit chance and does EVE damage into the damage model.
 * Live state only, never written to the document; a load clears it (Clear) and every ship comes back alive.
 *
 * - Resolve takes a boundary's shots sorted by (exact cycle start, ship id, module key), so which shot kills is
 *   deterministic. Per shot:
 *   - a target destroyed already (or earlier in this boundary): `overkill`, no roll, no damage, drawn as a hit;
 *   - an object: a range-only roll on the shot's falloff effectiveness (0 past optimal for no-falloff turrets), no
 *     damage (objects have no HP);
 *   - a ship: the hit chance from Destiny's GetAccuracy (port.Accuracy) with the turret's evaluated tracking, optimal,
 *     falloff (none: NO_FALLOFF_METRES) and signature resolution against the target's live signature; a vorton applies
 *     like a missile within its optimal (no roll); EVE's roll (rollShot) keyed by (seed, ship, module, activation,
 *     cycle, target) (combatRoll); a disintegrator's spool (consecutive cycles on the target since its activation);
 *     then the damage through shield, armor and structure (DamageModel.ApplyHit). A ship the model does not track
 *     takes nothing (`takes no damage: no EVE dogma for its hull`).
 * - Every shot gets `missed` and `outcome`; the killing one `fatal`. Structure at 0 records a ShipKill (onKill); the
 *   ship is then flagged destroyed: it takes no more damage until a load and its kill is not repeated.
 * - Tallies per ship: dealt and taken, a 20 s trailing DPS window, shots, hits and misses, the 3 latest rows fired and
 *   taken, and per victim the contributors.
 * - Recharge runs the passive shield recharge at each boundary, before the shots.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import {
  combatRoll,
  DEFAULT_COMBAT_DEATH,
  DEFAULT_COMBAT_SEED,
  DEFENSE_LAYERS,
  type DefenseLayerName,
  NO_FALLOFF_METRES,
  type ResolvedSceneCombat,
  rollShot,
  type ShipKill,
  type ShotOutcome,
  type ShotResult,
  type ShotTargetKind,
  shotDamage,
  type TurretCombatNumbers,
  missileApplication,
  vortonApplication,
  type WeaponShot,
  type WeaponShotMissile
} from '@scene-director/scene';
import type { DamageModel } from './damage';

/**
 * The turret numbers Destiny's GetAccuracy takes.
 */
export interface AccuracyNumbers {
  readonly optimal: number;
  /**
   * Metres; null: no falloff (NO_FALLOFF_METRES).
   */
  readonly falloff: Maybe<number>;
  readonly tracking: number;
  /**
   * The target's live signature radius (m).
   */
  readonly signatureRadius: number;
  /**
   * The turret's optimalSigRadius (m).
   */
  readonly signatureResolution: number;
}

export interface ShotAccuracy {
  readonly chance: number;
  readonly distance: number;
  readonly angularVelocity: number;
}

export interface CombatPort {
  /**
   * The hit chance on the master park's balls now (DestinyWorld.Accuracy); null when either is gone.
   */
  Accuracy(ship: string, target: string, numbers: AccuracyNumbers): Maybe<ShotAccuracy>;
  /**
   * A ship's speed (m/s): what a vorton's application reads.
   */
  Speed(id: string): number;
  /**
   * A turret's combat numbers (ShipModules.Spec(...).combat); null without dogma.
   */
  Weapon(ship: string, module: string): Maybe<TurretCombatNumbers>;
  /**
   * The target's live signature radius (m).
   */
  SignatureOf(id: string): number;
  KindOf(id: string): Maybe<ShotTargetKind>;
  readonly tickSeconds: number;
}

export interface CombatRulesOptions {
  readonly port: CombatPort;
  readonly damage: DamageModel;
  /**
   * A ship's structure reached 0 (once per ship until a load).
   */
  readonly onKill?: (kill: ShipKill, shot: WeaponShot) => void;
  /**
   * A ship's HP changed: its impact overlay follows (Director.SyncImpactState).
   */
  readonly onDamaged?: (id: string) => void;
}

/**
 * Trailing seconds the DPS figures average over.
 */
export const DPS_WINDOW_SECONDS = 20;

/**
 * Rows kept of the latest shots fired and taken.
 */
export const COMBAT_ROWS = 3;

/**
 * One shot in get_state's latest rows.
 */
export interface CombatRow {
  readonly tick: number;
  /**
   * Fired rows: the target; taken rows: the shooter.
   */
  readonly target?: string;
  readonly from?: string;
  readonly module: string;
  readonly name: string;
  readonly result: ShotResult;
  readonly chance: number;
  readonly quality: number;
  readonly damage: number;
  /**
   * The deepest layer it took HP from.
   */
  readonly layer?: DefenseLayerName;
  readonly note?: string;
  /**
   * A missile's row.
   */
  readonly missile?: true;
}

/**
 * Why an expired or lost missile did nothing: its row's note.
 */
export const MISSILE_EXPIRED_NOTE = 'it ran out of flight time';

/**
 * The loss reason that makes a lost missile's row `overkill` rather than `misses`.
 */
export const MISSILE_TARGET_DESTROYED = 'its target was destroyed';

/**
 * A ship's combat in get_state.
 */
export interface ShipCombatReport {
  readonly dealt: number;
  readonly taken: number;
  /**
   * HP per second over the trailing DPS_WINDOW_SECONDS.
   */
  readonly dps: { readonly dealt: number; readonly taken: number };
  readonly shots: number;
  readonly hits: number;
  readonly misses: number;
  readonly lastHits: readonly CombatRow[];
  readonly lastTaken: readonly CombatRow[];
}

interface Tally {
  dealt: number;
  taken: number;
  shots: number;
  hits: number;
  misses: number;
  /**
   * (tick, HP) within the DPS window.
   */
  readonly dealtWindow: { readonly tick: number; readonly amount: number }[];
  readonly takenWindow: { readonly tick: number; readonly amount: number }[];
  readonly lastHits: CombatRow[];
  readonly lastTaken: CombatRow[];
  /**
   * Victim side: attacker → HP it took off, and the tick it last shot.
   */
  readonly contributors: Map<string, number>;
  readonly attackers: Map<string, number>;
}

interface Spool {
  readonly activation: number;
  readonly target: string;
  cycles: number;
}

const NO_LAYERS: Readonly<Record<DefenseLayerName, number>> = { shield: 0, armor: 0, structure: 0 };

export class CombatRules {
  private readonly port: CombatPort;
  private readonly damage: DamageModel;
  private readonly onKill: NonNullable<CombatRulesOptions['onKill']>;
  private readonly onDamaged: NonNullable<CombatRulesOptions['onDamaged']>;
  private combat: ResolvedSceneCombat = { seed: DEFAULT_COMBAT_SEED, death: DEFAULT_COMBAT_DEATH };
  private readonly tallies = new Map<string, Tally>();
  private readonly destroyed = new Map<string, ShipKill>();
  private readonly kills: ShipKill[] = [];
  private readonly spools = new Map<string, Spool>();
  private shots = 0;
  private hits = 0;

  constructor(options: CombatRulesOptions) {
    this.port = options.port;
    this.damage = options.damage;
    this.onKill = options.onKill ?? (() => undefined);
    this.onDamaged = options.onDamaged ?? (() => undefined);
  }

  /**
   * The document's seed and death mode: later shots roll on the seed, later deaths follow the mode.
   */
  SetCombat(combat: ResolvedSceneCombat): void {
    this.combat = combat;
  }

  get settings(): ResolvedSceneCombat {
    return this.combat;
  }

  /**
   * Passive shield recharge at a boundary.
   *
   * @param seconds - Seconds since the last boundary.
   * @returns The ships whose shields rose.
   */
  Recharge(seconds: number): string[] {
    return this.damage.Recharge(seconds);
  }

  /**
   * Rolls and applies a boundary's shots in their fixed order, setting `missed`, `outcome` and `fatal` on each.
   *
   * @param shots - The shots (mutated in place).
   * @param boundary - The master tick.
   */
  Resolve(shots: readonly WeaponShot[], boundary: number): void {
    const damaged = new Set<string>();
    const sorted = [...shots].sort((a, b) => a.at - b.at || Compare(a.ship, b.ship) || Compare(a.module, b.module));
    for (const shot of sorted) {
      const outcome = this.Outcome(shot);
      shot.missed = outcome.result === 'misses';
      shot.outcome = outcome;
      this.Record(shot, outcome, boundary);
      if (outcome.damage > 0) damaged.add(shot.target);
      if (outcome.damage > 0 && !this.destroyed.has(shot.target) && this.damage.Destroyed(shot.target)) {
        const kill = this.Kill(shot, boundary);
        shot.fatal = true;
        this.onKill(kill, shot);
      }
    }
    for (const id of damaged) this.onDamaged(id);
  }

  /**
   * Records a missile that finished without reaching its target: no damage, no onDamaged. Its row is `overkill` when
   * its target was destroyed (or is now), else `misses`.
   *
   * @param shot - The missile's shot (missile set; at the end's time).
   * @param why - Its note: MISSILE_EXPIRED_NOTE, or the loss's reason.
   * @param boundary - The master tick.
   */
  Expire(shot: WeaponShot, why: string, boundary: number): void {
    const overkill = why === MISSILE_TARGET_DESTROYED || this.destroyed.has(shot.target);
    const outcome: ShotOutcome = { result: overkill ? 'overkill' : 'misses', chance: 0, quality: 0, damage: 0, layers: NO_LAYERS, note: why };
    shot.missed = !overkill;
    shot.outcome = outcome;
    this.Record(shot, outcome, boundary);
  }

  IsDestroyed(id: string): boolean {
    return this.destroyed.has(id);
  }

  /**
   * A destroyed ship's kill.
   */
  KillOf(id: string): Maybe<ShipKill> {
    return this.destroyed.get(id) ?? null;
  }

  Kills(): readonly ShipKill[] {
    return this.kills;
  }

  /**
   * Scene totals.
   */
  Totals(): { readonly shots: number; readonly hits: number } {
    return { shots: this.shots, hits: this.hits };
  }

  /**
   * A ship's combat for get_state.
   *
   * @param id - The ship id.
   * @param boundary - The master tick now.
   * @returns The report; null for a ship that never fired or was shot.
   */
  Report(id: string, boundary: number): Maybe<ShipCombatReport> {
    const tally = this.tallies.get(id);
    if (!tally) return null;
    this.Prune(tally, boundary);
    const window = (rows: readonly { readonly amount: number }[]): number => Round(rows.reduce((sum, row) => sum + row.amount, 0) / DPS_WINDOW_SECONDS, 1);
    return {
      dealt: Round(tally.dealt, 1),
      taken: Round(tally.taken, 1),
      dps: { dealt: window(tally.dealtWindow), taken: window(tally.takenWindow) },
      shots: tally.shots,
      hits: tally.hits,
      misses: tally.misses,
      lastHits: [...tally.lastHits],
      lastTaken: [...tally.lastTaken]
    };
  }

  /**
   * The ships that shot at a ship within the DPS window.
   *
   * @param id - The ship id.
   * @param boundary - The master tick now.
   * @returns Their ids, the latest first.
   */
  Attackers(id: string, boundary: number): string[] {
    const tally = this.tallies.get(id);
    const since = boundary - DPS_WINDOW_SECONDS / this.port.tickSeconds;
    return [...(tally?.attackers ?? [])]
      .filter(([, tick]) => tick > since)
      .sort((a, b) => b[1] - a[1])
      .map(([ship]) => ship);
  }

  /**
   * A ship left the scene: its tallies, spools and destroyed flag go (its kill stays in Kills).
   */
  Remove(id: string): void {
    this.tallies.delete(id);
    this.destroyed.delete(id);
    for (const key of [...this.spools.keys()]) if (key.startsWith(`${id}\u0000`)) this.spools.delete(key);
  }

  /**
   * A load: every kill, tally and spool goes; every ship is alive again.
   */
  Clear(): void {
    this.tallies.clear();
    this.destroyed.clear();
    this.kills.length = 0;
    this.spools.clear();
    this.shots = 0;
    this.hits = 0;
  }

  private Outcome(shot: WeaponShot): ShotOutcome {
    const { target } = shot;
    let outcome: ShotOutcome;
    const numbers = shot.missile ? null : this.port.Weapon(shot.ship, shot.module);
    if (this.destroyed.has(target)) {
      outcome = { result: 'overkill', chance: 1, quality: 0, damage: 0, layers: NO_LAYERS };
    } else if (shot.missile) {
      outcome = this.MissileOutcome(shot, shot.missile);
    } else if (this.port.KindOf(target) !== 'ship' || !numbers) {
      const chance = numbers && numbers.falloff == null ? (shot.distance <= numbers.optimal ? 1 : 0) : shot.effectiveness;
      const roll = rollShot(this.Roll(shot), chance);
      const note = numbers ? 'objects take no damage' : 'no EVE dogma for its weapon: it does no damage';
      outcome = { result: roll.result, chance, quality: roll.quality, damage: 0, layers: NO_LAYERS, ...(roll.hit ? { note } : {}) };
    } else {
      outcome = this.ShipOutcome(shot, numbers);
    }
    return outcome;
  }

  private ShipOutcome(shot: WeaponShot, numbers: TurretCombatNumbers): ShotOutcome {
    const { target } = shot;
    const signatureRadius = this.port.SignatureOf(target);
    let chance: number;
    let quality: number;
    let result: ShotResult;
    if (numbers.kind === 'vorton') {
      const explosion = numbers.explosion;
      chance = shot.distance > numbers.optimal ? 0 : explosion ? vortonApplication({ signatureRadius, targetSpeed: this.port.Speed(target), explosionRadius: explosion.radius, explosionVelocity: explosion.velocity, drf: explosion.drf }) : 1;
      quality = chance;
      result = chance > 0 ? 'hits' : 'misses';
    } else {
      const accuracy = this.port.Accuracy(shot.ship, target, {
        optimal: numbers.optimal,
        falloff: numbers.falloff ?? NO_FALLOFF_METRES,
        tracking: numbers.tracking ?? 0,
        signatureRadius,
        signatureResolution: numbers.signatureResolution ?? 0
      });
      chance = accuracy?.chance ?? 0;
      const roll = rollShot(this.Roll(shot), chance);
      quality = roll.quality;
      result = roll.result;
    }
    const spool = this.Spool(shot, numbers);
    let damage = 0;
    let layers: Readonly<Record<DefenseLayerName, number>> = NO_LAYERS;
    let note: Maybe<string> = numbers.note ?? null;
    if (quality > 0) {
      const applied = this.damage.ApplyHit(target, shotDamage(numbers.damage, quality * (1 + spool)));
      if (applied) {
        damage = applied.total;
        layers = applied.taken;
      } else {
        note = 'takes no damage: no EVE dogma for its hull';
      }
    }
    return { result, chance, quality, damage, layers, ...(quality > 0 && note ? { note } : {}) };
  }

  /**
   * A missile that reached its target: it always hits, for EVE's missile formula on its launch damage with the
   * target's live signature and speed.
   */
  private MissileOutcome(shot: WeaponShot, missile: WeaponShotMissile): ShotOutcome {
    const { target } = shot;
    let outcome: ShotOutcome;
    if (this.port.KindOf(target) !== 'ship' || !missile.damage) {
      outcome = { result: 'hits', chance: 1, quality: 1, damage: 0, layers: NO_LAYERS, note: missile.damage ? 'objects take no damage' : 'no EVE dogma for its weapon: it does no damage' };
    } else {
      const explosion = missile.explosion;
      const quality = explosion ? missileApplication({ signatureRadius: this.port.SignatureOf(target), targetSpeed: this.port.Speed(target), explosionRadius: explosion.radius, explosionVelocity: explosion.velocity, drf: explosion.drf }) : 1;
      let damage = 0;
      let layers: Readonly<Record<DefenseLayerName, number>> = NO_LAYERS;
      let note: Maybe<string> = null;
      const applied = quality > 0 ? this.damage.ApplyHit(target, shotDamage(missile.damage, quality)) : null;
      if (applied) {
        damage = applied.total;
        layers = applied.taken;
      } else if (quality > 0) {
        note = 'takes no damage: no EVE dogma for its hull';
      }
      outcome = { result: 'hits', chance: quality, quality, damage, layers, ...(note ? { note } : {}) };
    }
    return outcome;
  }

  /**
   * A disintegrator's spool for this shot: consecutive cycles on the target since its activation, × perCycle, capped.
   * The first shot has none; a new activation or target resets it.
   */
  private Spool(shot: WeaponShot, numbers: TurretCombatNumbers): number {
    if (!numbers.spool) return 0;
    const key = `${shot.ship}\u0000${shot.module}`;
    const previous = this.spools.get(key);
    const spool: Spool = previous && previous.activation === shot.activation && previous.target === shot.target ? previous : { activation: shot.activation, target: shot.target, cycles: 0 };
    const bonus = Math.min(numbers.spool.max, spool.cycles * numbers.spool.perCycle);
    spool.cycles += 1;
    this.spools.set(key, spool);
    return bonus;
  }

  private Roll(shot: WeaponShot): number {
    return combatRoll(this.combat.seed, { ship: shot.ship, module: shot.module, activation: shot.activation, cycle: shot.cycle, target: shot.target });
  }

  private Record(shot: WeaponShot, outcome: ShotOutcome, boundary: number): void {
    const shooter = this.Tally(shot.ship);
    const victim = this.port.KindOf(shot.target) === 'ship' ? this.Tally(shot.target) : null;
    const hit = outcome.result !== 'misses';
    const deepest = [...DEFENSE_LAYERS].reverse().find((layer) => outcome.layers[layer] > 0);
    const row = {
      tick: boundary,
      module: shot.module,
      name: shot.name,
      result: outcome.result,
      chance: Round(outcome.chance, 3),
      quality: Round(outcome.quality, 3),
      damage: Round(outcome.damage, 1),
      ...(deepest ? { layer: deepest } : {}),
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(shot.missile ? { missile: true as const } : {})
    };
    this.shots += 1;
    if (hit) this.hits += 1;
    shooter.shots += 1;
    if (hit) shooter.hits += 1;
    else shooter.misses += 1;
    shooter.dealt += outcome.damage;
    if (outcome.damage > 0) shooter.dealtWindow.push({ tick: boundary, amount: outcome.damage });
    Latest(shooter.lastHits, { ...row, target: shot.target });
    this.Prune(shooter, boundary);
    if (victim) {
      victim.taken += outcome.damage;
      if (outcome.damage > 0) {
        victim.takenWindow.push({ tick: boundary, amount: outcome.damage });
        victim.contributors.set(shot.ship, (victim.contributors.get(shot.ship) ?? 0) + outcome.damage);
      }
      victim.attackers.set(shot.ship, boundary);
      Latest(victim.lastTaken, { ...row, from: shot.ship });
      this.Prune(victim, boundary);
    }
  }

  private Kill(shot: WeaponShot, boundary: number): ShipKill {
    const contributors = [...(this.tallies.get(shot.target)?.contributors ?? [])].sort((a, b) => b[1] - a[1]).map(([ship, damage]) => ({ ship, damage: Round(damage, 1) }));
    const kill: ShipKill = { ship: shot.target, by: shot.ship, module: shot.module, weapon: shot.name, tick: boundary, at: shot.at, mode: this.combat.death, contributors };
    this.destroyed.set(shot.target, kill);
    this.kills.push(kill);
    return kill;
  }

  private Tally(id: string): Tally {
    let tally = this.tallies.get(id);
    if (!tally) {
      tally = { dealt: 0, taken: 0, shots: 0, hits: 0, misses: 0, dealtWindow: [], takenWindow: [], lastHits: [], lastTaken: [], contributors: new Map(), attackers: new Map() };
      this.tallies.set(id, tally);
    }
    return tally;
  }

  private Prune(tally: Tally, boundary: number): void {
    const since = boundary - DPS_WINDOW_SECONDS / this.port.tickSeconds;
    for (const window of [tally.dealtWindow, tally.takenWindow]) {
      const stale = window.findIndex((row) => row.tick > since);
      window.splice(0, stale < 0 ? window.length : stale);
    }
  }
}

function Latest(rows: CombatRow[], row: CombatRow): void {
  rows.unshift(row);
  if (rows.length > COMBAT_ROWS) rows.length = COMBAT_ROWS;
}

function Compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
