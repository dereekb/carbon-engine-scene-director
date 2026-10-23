import type { Maybe } from '@dereekb/util';
import { agilityTimeConstant, DEFENSE_LAYERS, type DefenseLayerName, maxWeaponReachOf, type PilotRemoteRepair, type PilotTackle, type PilotWeapon, type SceneVector, pilotWeaponOfMissile, pilotWeaponOfTurret, type ShipCombatProfile, type ShipDefense, TARGET_EFFECT_ATTRIBUTES } from '@scene-director/scene';
import type { ShipFlight } from './flight';
import type { ShipModuleSpec, TargetingModule } from './modules';
import { HeadingForward } from './steering';

/**
 * The page's side of the piloting facts (sd-piloting): a ship's plain combat profile from its flight and fitted
 * modules, the tackle running on it, and its effective HP left. Director.BrainFacts reads these for every live ship;
 * toShipOverview and the pilots read the facts.
 */

/**
 * Metres a ship without targeting numbers (the table path, which fires unlocked) is taken to lock at, unless its
 * weapons reach further.
 */
export const TABLE_PATH_LOCK_RANGE = 50_000;

/**
 * Dogma's postPercent operation: what a web's speedFactor is applied with.
 */
const POST_PERCENT = 6;

export interface CombatProfileInput {
  /**
   * The ship's flight; null while its numbers are pending (no profile then).
   */
  readonly flight: Maybe<ShipFlight>;
  /**
   * Its fitted modules, in fit order.
   */
  readonly specs: readonly ShipModuleSpec[];
  /**
   * Its total HP (shield + armor + hull at full), for EHP on the table path (no defense numbers).
   */
  readonly maxHp: number;
}

/**
 * A web's speed multiplier on its target: its maxVelocity postPercent modifier (−60 → 0.4).
 *
 * @param spec - The web.
 * @returns The factor; 1 when it carries none.
 */
function WebFactorOf(spec: ShipModuleSpec): number {
  const modifier = spec.activation.targetEffect?.modifiers.find((each) => each.attributeID === TARGET_EFFECT_ATTRIBUTES.maxVelocity && each.operation === POST_PERCENT);
  return modifier ? Math.max(0, 1 + modifier.amount / 100) : 1;
}

/**
 * Whether a module can run: online, and nothing refuses its activation.
 */
function IsUsable(spec: ShipModuleSpec): boolean {
  return !spec.offline && !spec.activation.refusal;
}

/**
 * A ship's combat profile for the piloting math: its flight with the prop mod off and on (τ from mass and agility),
 * radius, EHP, weapons (turret and launcher combat numbers), tackle ranges (point, scram, web and the web's factor),
 * lock range and remote repairers.
 *
 * @param input - Its flight, fitted modules and max HP.
 * @returns The profile; null while its flight is pending.
 */
export function CombatProfileOf(input: CombatProfileInput): Maybe<ShipCombatProfile> {
  const { flight, specs, maxHp } = input;
  if (!flight) return null;
  const weapons: PilotWeapon[] = [];
  let point = 0;
  let scram = 0;
  let web = 0;
  let webFactor = 1;
  const reps: PilotRemoteRepair[] = [];
  for (const spec of specs) {
    if (!IsUsable(spec)) continue;
    const { activation } = spec;
    if (spec.combat) weapons.push(pilotWeaponOfTurret(spec.combat));
    else if (spec.missile) weapons.push(pilotWeaponOfMissile(spec.missile));
    const range = activation.range ?? 0;
    if (activation.category === 'point') point = Math.max(point, range);
    else if (activation.category === 'scram') scram = Math.max(scram, range);
    else if (activation.category === 'web') {
      web = Math.max(web, range);
      webFactor = Math.min(webFactor, WebFactorOf(spec));
    }
    const repair = activation.repair;
    if (repair?.remote && activation.targeted && activation.cycleTime > 0) reps.push({ layer: repair.layer === 'structure' ? 'hull' : repair.layer, hps: repair.amount / activation.cycleTime, optimal: activation.range ?? 0, falloff: activation.falloff ?? 0 });
  }
  const tackle: PilotTackle = { ...(point ? { point } : {}), ...(scram ? { scram } : {}), ...(web ? { web, webFactor } : {}) };
  const on = flight.propMod;
  return {
    flight: { speed: flight.maxVelocity, signature: flight.signatureRadius, tau: agilityTimeConstant(flight.mass, flight.agility) },
    propMod: on ? { kind: on.kind === 'microwarpdrive' ? 'mwd' : 'ab', speed: on.maxVelocity, signature: on.signatureRadius, tau: agilityTimeConstant(on.mass, flight.agility) } : null,
    radius: flight.radius,
    ehp: flight.defense?.ehp ?? maxHp,
    weapons,
    tackle,
    lockRange: flight.targeting?.maxTargetRange ?? Math.max(TABLE_PATH_LOCK_RANGE, maxWeaponReachOf(weapons)),
    reps
  };
}

export interface TackleOnShip {
  /**
   * A running scram holds it: its MWD cannot run.
   */
  readonly scrammed: boolean;
  /**
   * The speed multiplier of the running webs on it (1 for none), each at its applied effectiveness.
   */
  readonly webFactor: number;
}

/**
 * The tackle running on a ship.
 *
 * @param modules - The running targeted modules on it (ShipModules.Targeting).
 * @returns Whether it is scrammed, and its webs' factor.
 */
export function TackleOn(modules: readonly TargetingModule[]): TackleOnShip {
  let scrammed = false;
  let webFactor = 1;
  for (const { spec, applied } of modules) {
    if (spec.activation.targetEffect?.blocksMicrowarpdrive) scrammed = true;
    if (spec.activation.category === 'web') webFactor *= 1 - (1 - WebFactorOf(spec)) * applied;
  }
  return { scrammed, webFactor };
}

/**
 * Effective HP left: each layer's HP over its omni resonance (the defense's EHP over HP per layer); plain HP on the
 * table path.
 *
 * @param health - HP and max per layer (DamageModel.Health).
 * @param defense - The dogma defense, when the ship has one.
 * @returns EHP.
 */
export function RemainingEhpOf(health: Readonly<Record<DefenseLayerName, { readonly hp: number; readonly max: number }>>, defense: Maybe<ShipDefense>): number {
  return DEFENSE_LAYERS.reduce((sum, name) => {
    const layer = defense?.[name];
    const share = layer && layer.hp > 0 ? layer.ehp / layer.hp : 1;
    return sum + health[name].hp * share;
  }, 0);
}

/**
 * Where a ship's nose points.
 *
 * @param heading - ShipMotion.heading: [yaw, pitch] degrees.
 * @returns A unit vector.
 */
export function HeadingVectorOf(heading: readonly [number, number]): SceneVector {
  const [x, y, z] = HeadingForward((heading[0] * Math.PI) / 180, (heading[1] * Math.PI) / 180);
  return [x, y, z];
}

/**
 * HP per second the remote repairers running on a ship land on it now.
 *
 * @param incoming - The repairs running on it (ShipModules.Incoming).
 * @returns HP/s.
 */
export function IncomingRepsOf(incoming: readonly { readonly spec: ShipModuleSpec; readonly effectiveness: number }[]): number {
  return incoming.reduce((sum, { spec, effectiveness }) => {
    const { repair, cycleTime } = spec.activation;
    return sum + (repair && cycleTime > 0 ? (repair.amount / cycleTime) * effectiveness : 0);
  }, 0);
}
