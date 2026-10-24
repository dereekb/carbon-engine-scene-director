/**
 * Damage per shot and how it passes through a ship's layers, and the passive shield recharge. Pure: the page's
 * DamageModel keeps the live HP and calls these.
 */

import { DAMAGE_TYPES, DEFENSE_LAYERS, type DamageType, type DefenseLayerName } from '../fitting/defense';

/**
 * Damage by type (EM, thermal, kinetic, explosive).
 */
export type DamageVector = Readonly<Record<DamageType, number>>;

/**
 * No damage.
 */
export const NO_DAMAGE: DamageVector = { em: 0, thermal: 0, kinetic: 0, explosive: 0 };

/**
 * A shot's damage: its base damage by type scaled by one factor (quality × spool).
 *
 * @param base - The weapon's damage per shot by type.
 * @param factor - The factor.
 * @returns The damage by type.
 */
export function shotDamage(base: DamageVector, factor: number): DamageVector {
  return { em: base.em * factor, thermal: base.thermal * factor, kinetic: base.kinetic * factor, explosive: base.explosive * factor };
}

/**
 * The damage summed over the types.
 *
 * @param damage - The damage by type.
 * @returns The total.
 */
export function damageTotal(damage: DamageVector): number {
  return DAMAGE_TYPES.reduce((total, type) => total + damage[type], 0);
}

export interface DamageLayerState {
  /**
   * The HP the layer has left.
   */
  readonly hp: number;
  /**
   * The fraction of each damage type it takes (1 − resist).
   */
  readonly resonances: Readonly<Record<DamageType, number>>;
}

export type DamageLayers = Readonly<Record<DefenseLayerName, DamageLayerState>>;

export interface LayeredDamage {
  /**
   * The layers after the damage (the input is not changed).
   */
  readonly layers: DamageLayers;
  /**
   * HP each layer lost.
   */
  readonly taken: Readonly<Record<DefenseLayerName, number>>;
  /**
   * HP lost over the layers.
   */
  readonly total: number;
  /**
   * The structure HP left; at 0 the ship is destroyed (unless its structure is immune).
   */
  readonly structure: number;
  /**
   * The effective damage an immune layer stopped, at that layer's resonances and uncapped by its HP; omitted when
   * none was.
   */
  readonly absorbed?: number;
  /**
   * The immune layer that stopped it.
   */
  readonly absorbedBy?: DefenseLayerName;
}

/**
 * Applies raw damage shield first, then armor, then structure. A layer takes `Σ raw × resonance`; when that is more than
 * its HP it absorbs the share `hp / effective` of the raw damage and goes to 0, and the rest of the raw damage moves on
 * to the next layer, which takes it through its own resonances.
 *
 * An immune layer (combat/immunity.ts) that still has HP keeps it and stops the whole hit that reaches it: nothing
 * passes on, and `absorbed` is that hit's effective damage at its resonances. An immune layer at 0 HP has nothing to
 * protect and stops nothing. So `["structure"]` lets the shield and armor drain but never the structure, and every
 * layer immune lets nothing land.
 *
 * @param layers - The layers' HP and resonances.
 * @param damage - The raw damage by type.
 * @param immune - The ship's immune layers (none when omitted).
 * @returns The layers after, what each took, the structure left, and what an immune layer absorbed.
 */
export function applyLayeredDamage(layers: DamageLayers, damage: DamageVector, immune?: Iterable<DefenseLayerName>): LayeredDamage {
  const immuneLayers = new Set(immune ?? []);
  let raw: DamageVector = damage;
  let absorbed = 0;
  let absorbedBy: DefenseLayerName | undefined;
  const after: Partial<Record<DefenseLayerName, DamageLayerState>> = {};
  const taken: Record<DefenseLayerName, number> = { shield: 0, armor: 0, structure: 0 };
  for (const name of DEFENSE_LAYERS) {
    const layer = layers[name];
    const effective = DAMAGE_TYPES.reduce((total, type) => total + raw[type] * layer.resonances[type], 0);
    if (immuneLayers.has(name) && layer.hp > 0) {
      after[name] = { ...layer };
      if (effective > 0) {
        absorbed = effective;
        absorbedBy = name;
      }
      raw = NO_DAMAGE;
    } else if (effective <= layer.hp) {
      taken[name] = effective;
      after[name] = { ...layer, hp: layer.hp - effective };
      raw = NO_DAMAGE;
    } else {
      const share = layer.hp / effective;
      taken[name] = layer.hp;
      after[name] = { ...layer, hp: 0 };
      raw = shotDamage(raw, 1 - share);
    }
  }
  const result = after as DamageLayers;
  return { layers: result, taken, total: taken.shield + taken.armor + taken.structure, structure: result.structure.hp, ...(absorbedBy ? { absorbed, absorbedBy } : {}) };
}

export interface PassiveRechargeInput {
  /**
   * The fraction full now, 0 to 1.
   */
  readonly fraction: number;
  readonly seconds: number;
  /**
   * Seconds to recharge from empty (shieldRechargeRate, or the capacitor's rechargeRate).
   */
  readonly rechargeTime: number;
}

/**
 * EVE's shield (and capacitor) recharge curve `dS/dt = 10 × Smax / τ × (√s − s)` in closed form:
 * `(1 + (√s₀ − 1) × e^(−5t/τ))²`. Peak recharge at 25 %: 2.5 × Smax / τ.
 *
 * @param input - The fraction now, the seconds that pass and the recharge time.
 * @returns The fraction full after them.
 */
export function passiveRecharge(input: PassiveRechargeInput): number {
  const { fraction, seconds, rechargeTime } = input;
  const start = Math.min(1, Math.max(0, fraction));
  let result = start;
  if (seconds > 0 && rechargeTime > 0) {
    const root = 1 + (Math.sqrt(start) - 1) * Math.exp((-5 * seconds) / rechargeTime);
    result = root * root;
  }
  return result;
}
