/**
 * The page's damage model: each fitted ship's current and max HP per layer, its resonances, and the repairs running on
 * it.
 *
 * - SetDefense runs whenever a ship's evaluated numbers change (a hardener cycling, a refit). Current HP starts at max;
 *   when max changes the layer keeps its fraction, clamped to max.
 * - Repairs land at module cycle events (modules.ts): shield boosters at cycle start, armor and hull repairers at cycle
 *   end, remote repairers on their target scaled by their falloff effectiveness.
 * - Damage is internal: no tool calls it yet. Combat rules will; specs use it to show repairs restoring HP.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import { DAMAGE_TYPES, DEFENSE_LAYERS, type DamageType, type DefenseLayerName, type ShipDefense } from '@scene-director/scene';

/**
 * A repair running on a ship from another one's module.
 */
export interface IncomingRepair {
  readonly from: string;
  /**
   * The module's key on the repairing ship.
   */
  readonly module: string;
  readonly layer: DefenseLayerName;
  /**
   * HP per cycle, before effectiveness.
   */
  readonly amount: number;
  /**
   * Seconds.
   */
  readonly cycleTime: number;
  /**
   * The falloff factor, 0-1.
   */
  readonly effectiveness: number;
}

interface DamageLayer {
  hp: number;
  max: number;
  resonances: Readonly<Record<DamageType, number>>;
}

interface ShipDamage {
  readonly layers: Record<DefenseLayerName, DamageLayer>;
  shieldRecharge: number;
  /**
   * HP/s of the running local repairers.
   */
  repairs: Readonly<Record<DefenseLayerName, number>>;
  incoming: readonly IncomingRepair[];
}

/**
 * A layer in get_state's live defense.
 */
export interface DamageLayerReport {
  readonly hp: number;
  readonly max: number;
  /**
   * Percent, 2 decimals.
   */
  readonly resists: Readonly<Record<DamageType, number>>;
  /**
   * Omni EHP of the current HP.
   */
  readonly ehp: number;
}

export type DamageReport = Readonly<Record<DefenseLayerName, DamageLayerReport>> & {
  readonly ehp: number;
  readonly shieldRecharge: number;
  readonly repairs: Readonly<Record<DefenseLayerName, number>>;
  readonly incoming: readonly IncomingRepair[];
};

const NO_REPAIRS: Readonly<Record<DefenseLayerName, number>> = { shield: 0, armor: 0, structure: 0 };

export class DamageModel {
  private readonly ships = new Map<string, ShipDamage>();

  /**
   * Sets a ship's max HP and resonances; current HP keeps its fraction of max.
   *
   * @param id - The ship id.
   * @param defense - Its evaluated defense.
   */
  SetDefense(id: string, defense: ShipDefense): void {
    const ship = this.ships.get(id);
    if (!ship) {
      const layers = Object.fromEntries(DEFENSE_LAYERS.map((name) => [name, { hp: defense[name].hp, max: defense[name].hp, resonances: defense[name].resonances }])) as Record<DefenseLayerName, DamageLayer>;
      this.ships.set(id, { layers, shieldRecharge: defense.shieldRecharge, repairs: NO_REPAIRS, incoming: [] });
      return;
    }
    for (const name of DEFENSE_LAYERS) {
      const layer = ship.layers[name];
      const max = defense[name].hp;
      layer.hp = layer.max > 0 ? Math.min(max, (max * layer.hp) / layer.max) : max;
      layer.max = max;
      layer.resonances = defense[name].resonances;
    }
    ship.shieldRecharge = defense.shieldRecharge;
  }

  /**
   * Whether the model tracks a ship.
   */
  Has(id: string): boolean {
    return this.ships.has(id);
  }

  /**
   * Takes HP off a layer (no resists: the caller applies them). Internal until Combat rules.
   *
   * @param id - The ship id.
   * @param layer - The layer.
   * @param amount - HP.
   * @returns The HP taken.
   */
  Damage(id: string, layer: DefenseLayerName, amount: number): number {
    const entry = this.ships.get(id)?.layers[layer];
    if (!entry || !(amount > 0)) return 0;
    const taken = Math.min(entry.hp, amount);
    entry.hp -= taken;
    return taken;
  }

  /**
   * Restores HP on a layer, up to its max.
   *
   * @param id - The ship id.
   * @param layer - The layer.
   * @param amount - HP.
   * @returns The HP restored.
   */
  Repair(id: string, layer: DefenseLayerName, amount: number): number {
    const entry = this.ships.get(id)?.layers[layer];
    if (!entry || !(amount > 0)) return 0;
    const restored = Math.min(entry.max - entry.hp, amount);
    entry.hp += restored;
    return restored;
  }

  /**
   * Sets the HP/s of a ship's running local repairers, for get_state.
   */
  SetRepairs(id: string, repairs: Readonly<Record<DefenseLayerName, number>>): void {
    const ship = this.ships.get(id);
    if (ship) ship.repairs = repairs;
  }

  /**
   * Sets the remote repairs running on a ship, for get_state.
   */
  SetIncoming(id: string, incoming: readonly IncomingRepair[]): void {
    const ship = this.ships.get(id);
    if (ship) ship.incoming = incoming;
  }

  Remove(id: string): void {
    this.ships.delete(id);
  }

  /**
   * Forgets every ship (a load restarts the scene at full HP).
   */
  Clear(): void {
    this.ships.clear();
  }

  /**
   * A ship's live defense for get_state.
   *
   * @param id - The ship id.
   * @returns The report, rounded; null when the model does not track the ship.
   */
  Report(id: string): Maybe<DamageReport> {
    const ship = this.ships.get(id);
    if (!ship) return null;
    const layer = (name: DefenseLayerName): DamageLayerReport => {
      const { hp, max, resonances } = ship.layers[name];
      const mean = DAMAGE_TYPES.reduce((sum, type) => sum + resonances[type], 0) / DAMAGE_TYPES.length;
      return { hp: Round(hp, 1), max: Round(max, 1), resists: Object.fromEntries(DAMAGE_TYPES.map((type) => [type, Round((1 - resonances[type]) * 100, 2)])) as Record<DamageType, number>, ehp: Math.round(mean > 0 ? hp / mean : hp) };
    };
    const [shield, armor, structure] = DEFENSE_LAYERS.map(layer);
    return {
      shield,
      armor,
      structure,
      ehp: shield.ehp + armor.ehp + structure.ehp,
      shieldRecharge: Round(ship.shieldRecharge, 2),
      repairs: { shield: Round(ship.repairs.shield, 2), armor: Round(ship.repairs.armor, 2), structure: Round(ship.repairs.structure, 2) },
      incoming: ship.incoming.map((repair) => ({ ...repair, amount: Round(repair.amount, 1), effectiveness: Round(repair.effectiveness, 3) }))
    };
  }
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
