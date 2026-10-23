/**
 * What a targeted module does to the ship it runs on (SDE 3632936; the sd-fittings ref has the rules):
 *
 * - Webs cut the target's max velocity (`speedFactor`, postPercent) and target painters grow its signature radius
 *   (`signatureRadiusBonus`, postPercent). Both are code effects (no SDE modifiers), built in here as Pyfa does, and
 *   stacking-penalized on the target like its own modules.
 * - Warp disruptors and scramblers add their `warpScrambleStrength` to its `warpScrambleStatus` (the SDE's own
 *   `targetID` modifiers); above 0 it cannot warp. A scrambler's `activationBlocked` modifier on modules requiring
 *   High Speed Maneuvering blocks its microwarpdrive.
 * - Neuts, nos and remote capacitor transmitters move capacitor: `energyNeutralizerAmount` or `powerTransferAmount` GJ
 *   per cycle (a nos never below its shooter's level unless its `nosOverride` is set).
 *
 * The numbers come from the shooter's evaluated ship, so its skills and hull bonuses apply (a Vindicator's web is
 * −90 %). The target scales them by the module's falloff effectiveness and its own resistance attribute.
 */

import type { Maybe } from '@dereekb/util';
import type { DogmaIncomingModifier, DogmaShip } from './dogma';
import type { DogmaBundle } from './dogma-bundle';

/**
 * Attribute ids the target effects read.
 */
export const TARGET_EFFECT_ATTRIBUTES = {
  maxVelocity: 37,
  signatureRadius: 552,
  speedFactor: 20,
  signatureRadiusBonus: 554,
  warpScrambleStatus: 104,
  warpScrambleStrength: 105,
  activationBlocked: 1349,
  activationBlockedStrength: 1350,
  energyNeutralizerAmount: 97,
  powerTransferAmount: 90,
  nosOverride: 1945,
  remoteResistanceID: 2138,
  energyWarfareResistance: 2045,
  sensorDampenerResistance: 2112,
  weaponDisruptionResistance: 2113,
  targetPainterResistance: 2114,
  stasisWebifierResistance: 2115,
  remoteRepairImpedance: 2116,
  remoteAssistanceImpedance: 2135,
  ecmResistance: 2253,
  remoteCapacitorImpedance: 6463
} as const;

/**
 * The skill microwarpdrives require (High Speed Maneuvering): a scrambler blocks the modules that need it.
 */
export const HIGH_SPEED_MANEUVERING = 3454;

/**
 * One modifier a module puts on its target's attributes.
 */
export interface TargetModifier {
  readonly attributeID: number;
  /**
   * A dogma operation (DOGMA_OPERATIONS).
   */
  readonly operation: number;
  /**
   * The shooter's evaluated amount, before falloff and resistance.
   */
  readonly amount: number;
}

export type CapacitorTransferKind = 'neut' | 'nos' | 'transfer';

export interface ModuleTargetCapacitor {
  readonly kind: CapacitorTransferKind;
  /**
   * GJ per cycle, before falloff and resistance.
   */
  readonly amount: number;
  /**
   * A nos that drains below its shooter's level (nosOverride, the Blood Raider hulls).
   */
  readonly override?: true;
}

export interface ModuleTargetEffect {
  /**
   * The default effect's name, for traces.
   */
  readonly effect: string;
  /**
   * On the target ship's attributes.
   */
  readonly modifiers: readonly TargetModifier[];
  /**
   * The target's attribute that scales the effect (1 when the target lacks it).
   */
  readonly resistanceAttributeID?: number;
  /**
   * A scrambler: the target's microwarpdrive cannot run.
   */
  readonly blocksMicrowarpdrive?: true;
  readonly capacitor?: ModuleTargetCapacitor;
}

const TARGET_DOMAINS: ReadonlySet<string> = new Set(['targetID', 'target']);

const ASSIGN_OPERATIONS: ReadonlySet<number> = new Set([-1, 7]);

const POST_PERCENT = 6;

type CodeTargetEffect = (read: (attribute: number) => number) => Pick<ModuleTargetEffect, 'modifiers' | 'capacitor'>;

/**
 * Target effects the SDE leaves to code (their records carry no modifiers), by effect name.
 */
const CODE_TARGET_EFFECTS: Readonly<Record<string, CodeTargetEffect>> = {
  remoteWebifierFalloff: (read) => ({ modifiers: [{ attributeID: TARGET_EFFECT_ATTRIBUTES.maxVelocity, operation: POST_PERCENT, amount: read(TARGET_EFFECT_ATTRIBUTES.speedFactor) }] }),
  remoteTargetPaintFalloff: (read) => ({ modifiers: [{ attributeID: TARGET_EFFECT_ATTRIBUTES.signatureRadius, operation: POST_PERCENT, amount: read(TARGET_EFFECT_ATTRIBUTES.signatureRadiusBonus) }] }),
  energyNeutralizerFalloff: (read) => ({ modifiers: [], capacitor: { kind: 'neut', amount: read(TARGET_EFFECT_ATTRIBUTES.energyNeutralizerAmount) } }),
  energyNosferatuFalloff: (read) => ({ modifiers: [], capacitor: { kind: 'nos', amount: read(TARGET_EFFECT_ATTRIBUTES.powerTransferAmount), ...(read(TARGET_EFFECT_ATTRIBUTES.nosOverride) > 0 ? { override: true as const } : {}) } }),
  shipModuleRemoteCapacitorTransmitter: (read) => ({ modifiers: [], capacitor: { kind: 'transfer', amount: read(TARGET_EFFECT_ATTRIBUTES.powerTransferAmount) } })
};

/**
 * What a fitted module does to its target, from the shooter's evaluation.
 *
 * @param ship - The shooter, evaluated.
 * @param bundle - The bundle it was evaluated from.
 * @param key - The module key.
 * @returns The effect, or null for a module whose default effect is not a target effect or does nothing modelled to
 *   its target (remote reps, which have `repair`; damps, disruptors, ECM).
 */
export function moduleTargetEffectOf(ship: DogmaShip, bundle: DogmaBundle, key: string): Maybe<ModuleTargetEffect> {
  const module = ship.modules.get(key);
  const effect = module?.type.defaultEffect == null ? null : bundle.effects[module.type.defaultEffect];
  if (!effect || effect.category !== 2) return null;
  const read = (attribute: number): number => ship.moduleAttribute(key, attribute) ?? 0;
  const modifiers: TargetModifier[] = [];
  let blocksMicrowarpdrive = false;
  for (const modifier of effect.modifiers) {
    if (!TARGET_DOMAINS.has(modifier.domain)) continue;
    if (modifier.func === 'ItemModifier' && !ASSIGN_OPERATIONS.has(modifier.operation)) modifiers.push({ attributeID: modifier.modifiedAttributeID, operation: modifier.operation, amount: read(modifier.modifyingAttributeID) });
    else if (modifier.func === 'LocationRequiredSkillModifier' && modifier.modifiedAttributeID === TARGET_EFFECT_ATTRIBUTES.activationBlocked && modifier.skillTypeID === HIGH_SPEED_MANEUVERING) blocksMicrowarpdrive = true;
  }
  const code = CODE_TARGET_EFFECTS[effect.name]?.(read);
  if (code) modifiers.push(...code.modifiers);
  const capacitor = code?.capacitor;
  let result: Maybe<ModuleTargetEffect> = null;
  if (modifiers.length || capacitor || blocksMicrowarpdrive) {
    const remoteResistance = read(TARGET_EFFECT_ATTRIBUTES.remoteResistanceID);
    const resistanceAttributeID = effect.resistanceAttributeID ?? (remoteResistance > 0 ? remoteResistance : null);
    result = {
      effect: effect.name,
      modifiers,
      ...(resistanceAttributeID == null ? {} : { resistanceAttributeID }),
      ...(blocksMicrowarpdrive ? { blocksMicrowarpdrive: true as const } : {}),
      ...(capacitor ? { capacitor } : {})
    };
  }
  return result;
}

/**
 * One running module on a ship, as incomingModifiersOf takes it.
 */
export interface IncomingTargetModule {
  /**
   * The shooter's id.
   */
  readonly from: string;
  readonly key: string;
  readonly name: string;
  readonly effect: ModuleTargetEffect;
  /**
   * Its falloff effectiveness at the latest cycle start, 0-1.
   */
  readonly effectiveness: number;
}

/**
 * The label a module on another ship carries in the target's traces and notes.
 *
 * @param input - The shooter, the module's name and key.
 * @returns `<ship>: <module name> (<key>)`.
 */
export function incomingSourceLabel(input: { readonly from: string; readonly name: string; readonly key: string }): string {
  return `${input.from}: ${input.name} (${input.key})`;
}

/**
 * Scales a modifier's amount by a factor (falloff effectiveness, a resistance): additive and percent amounts times the
 * factor, multipliers `1 + (m − 1) × factor`.
 *
 * @param operation - The dogma operation.
 * @param amount - The amount.
 * @param factor - The factor, 0-1.
 * @returns The scaled amount.
 */
export function scaleModifierAmount(operation: number, amount: number, factor: number): number {
  let scaled = amount * factor;
  if (operation === 0 || operation === 4) scaled = 1 + (amount - 1) * factor;
  else if (operation === 1 || operation === 5) scaled = amount === 0 ? amount : 1 / (1 + (1 / amount - 1) * factor);
  return scaled;
}

/**
 * The modifiers the running modules put on their target, scaled by each module's effectiveness.
 *
 * @param modules - The running targeted modules on the ship.
 * @returns The incoming modifiers for evaluateShipDogma (or applyIncomingModifiers on the table path).
 */
export function incomingModifiersOf(modules: readonly IncomingTargetModule[]): DogmaIncomingModifier[] {
  return modules.flatMap((module) =>
    module.effect.modifiers.map((modifier) => ({
      source: incomingSourceLabel(module),
      effect: module.effect.effect,
      attributeID: modifier.attributeID,
      operation: modifier.operation,
      amount: scaleModifierAmount(modifier.operation, modifier.amount, module.effectiveness),
      ...(module.effect.resistanceAttributeID == null ? {} : { resistanceAttributeID: module.effect.resistanceAttributeID })
    }))
  );
}

/**
 * One step that changed a ship's warp scramble status: a point, a scram, its own warp core stabilizer or siege.
 */
export interface WarpScrambleStep {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Why a ship can or cannot warp, from its warp scramble status and the steps that made it.
 *
 * @param input - The status and the steps (the ship's 104 trace).
 * @returns `warp scramble status 3 (tackle: Warp Scrambler II (mid-1) +2, ...): above 0 it cannot warp`; null when
 *   nothing changed it and it can warp.
 */
export function warpScrambleNoteOf(input: { readonly status: number; readonly steps: readonly WarpScrambleStep[] }): Maybe<string> {
  const { status, steps } = input;
  const changes = steps.filter((step) => step.to !== step.from).map((step) => `${step.source} ${signed(step.to - step.from)}`);
  let note: Maybe<string> = null;
  const list = changes.length ? ` (${changes.join(', ')})` : '';
  if (status > 0) note = `warp scramble status ${round(status)}${list}: above 0 it cannot warp`;
  else if (changes.length) note = `warp scramble status ${round(status)}${list}: it can warp`;
  return note;
}

/**
 * Why a ship's microwarpdrive cannot run.
 *
 * @param blockers - The labels of the scramblers on it.
 * @returns `a warp scrambler blocks its microwarpdrive (tackle: Warp Scrambler II (mid-1))`; null without one.
 */
export function microwarpdriveBlockNoteOf(blockers: readonly string[]): Maybe<string> {
  return blockers.length ? `a warp scrambler blocks its microwarpdrive (${blockers.join(', ')})` : null;
}

function signed(value: number): string {
  return value > 0 ? `+${round(value)}` : `${round(value)}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
