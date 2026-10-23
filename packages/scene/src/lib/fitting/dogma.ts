/**
 * A data-driven EVE dogma evaluator for one ship: the hull, its fitted modules and their charges, and the pilot's
 * skills, from a DogmaBundle (tools-core's SDE through the hub). Hull traits come for free: a racial hull skill
 * premultiplies the ship's `shipBonus*` attribute and the hull's own effects apply it.
 *
 * Rules (the sd-fittings ref has the detail):
 * - Effects that run: skills and the hull, category 0; modules, category 0 always, category 4 (online) when online or
 *   active, their default effect when active; charges, category 0 while their module is online or active. Overload
 *   (5) never runs. Modifiers on the target and structure domains are skipped (listed in `skipped`), and so are
 *   `ItemModifier`s on the character, except on the character attributes modelled here (CHARACTER_ATTRIBUTES: the
 *   missileDamageMultiplier that Ballistic Control Systems raise).
 * - Operations apply in tools-core's order: preAssign, preMul, preDiv, modAdd, modSub, postMul, postDiv, postPercent,
 *   postAssign. A modifier's amount is its modifying attribute evaluated on its source item.
 * - Stacking penalty: on an attribute that is not stackable, from a source that is not a ship, charge, skill, implant
 *   or subsystem, for preMul, preDiv, postMul, postDiv and postPercent. Each operation is its own group, bonuses and
 *   maluses apart, strongest first; the i-th (from 0) counts `exp(-(i / 2.67)^2)`.
 * - `maxAttributeID` caps the result at the item's value of that attribute. A dependency cycle uses the base value.
 * - Code effects (no modifiers in the SDE; built in here as Pyfa does): the MWD and AB speed, mass and signature, the
 *   reactive armor hardener's static profile, the missile skills' damage bonus on the charges that require them and
 *   the specializations' rate of fire bonus on the modules that require them. Other code effects (reps, webs, neuts)
 *   change no attribute of their own ship; their numbers are read with moduleAttribute.
 * - Incoming modifiers (`incoming`: webs, painters, points and scrams on this ship, target-effects.ts) act on the ship
 *   from a module-category source, so they stack with its own penalized modifiers, each times the ship's resistance
 *   attribute (1 when it lacks it).
 */

import type { Maybe } from '@dereekb/util';
import type { HullStatOverrides } from '../stats/ship-stats';
import { MAX_SKILLS_PILOT, type PilotContext } from '../stats/pilot';
import type { DogmaAttributeRecord, DogmaBundle, DogmaEffectRecord, DogmaTypeRecord } from './dogma-bundle';
import { scaleModifierAmount } from './target-effects';

/**
 * A fitted module's state as dogma sees it.
 */
export type DogmaModuleState = 'offline' | 'online' | 'active';

export interface DogmaModuleInput {
  /**
   * The module's key (`mid-0`).
   */
  readonly key: string;
  readonly typeID: number;
  readonly state: DogmaModuleState;
  /**
   * Its loaded charge.
   */
  readonly chargeTypeID?: Maybe<number>;
}

export interface EvaluateShipDogmaInput {
  readonly bundle: DogmaBundle;
  readonly hullTypeID: number;
  /**
   * Replace the hull's published mass, maxVelocity, agility and signatureRadius as base values (a scene ship's
   * `stats`).
   */
  readonly overrides?: Maybe<HullStatOverrides>;
  readonly modules?: readonly DogmaModuleInput[];
  /**
   * Defaults to MAX_SKILLS_PILOT.
   */
  readonly pilot?: Maybe<PilotContext>;
  /**
   * The skills the pilot may have. Default: every skill (category 16) in the bundle.
   */
  readonly skillTypeIDs?: Maybe<readonly number[]>;
  /**
   * Modifiers other ships' modules put on this ship (incomingModifiersOf).
   */
  readonly incoming?: Maybe<readonly DogmaIncomingModifier[]>;
}

/**
 * A modifier another ship's module puts on this ship, already scaled by its falloff effectiveness.
 */
export interface DogmaIncomingModifier {
  /**
   * `<ship>: <module name> (<key>)`: the trace's source.
   */
  readonly source: string;
  readonly effect: string;
  readonly attributeID: number;
  /**
   * A dogma operation (DOGMA_OPERATIONS).
   */
  readonly operation: number;
  readonly amount: number;
  /**
   * The ship's attribute that scales the amount (1 when the ship lacks it).
   */
  readonly resistanceAttributeID?: number;
}

/**
 * One applied modifier, for answers that show their work.
 */
export interface DogmaTraceStep {
  /**
   * `ship`, `<module name> (<key>)` (a charge: its name and its module's key) or `<skill name> <level>` (`Navigation V`).
   */
  readonly source: string;
  readonly effect: string;
  readonly operation: DogmaOperationName;
  readonly amount: number;
  /**
   * The stacking factor, when penalized.
   */
  readonly penalty?: number;
  readonly from: number;
  readonly to: number;
}

export interface DogmaShip {
  readonly hull: DogmaTypeRecord;
  /**
   * The pilot context's name.
   */
  readonly pilot: string;
  /**
   * A ship attribute, evaluated.
   */
  attribute(attribute: string | number): number;
  /**
   * A fitted module's attribute, evaluated; null for a key the ship does not fit.
   */
  moduleAttribute(key: string, attribute: string | number): Maybe<number>;
  /**
   * A loaded charge's attribute, evaluated; null when the module has no charge.
   */
  chargeAttribute(key: string, attribute: string | number): Maybe<number>;
  /**
   * A character attribute the evaluator models (CHARACTER_ATTRIBUTES), evaluated; null for any other.
   */
  characterAttribute(attribute: string | number): Maybe<number>;
  /**
   * The steps that made a ship attribute (or a module's, with its key).
   */
  trace(attribute: string | number, key?: Maybe<string>): DogmaTraceStep[];
  /**
   * The modules evaluated (known types), by key.
   */
  readonly modules: ReadonlyMap<string, { readonly type: DogmaTypeRecord; readonly state: DogmaModuleState; readonly charge: Maybe<DogmaTypeRecord> }>;
  /**
   * Modifiers that act on other ships or on the character, by effect name (later entries).
   */
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
}

export type DogmaOperationName = 'preAssign' | 'preMul' | 'preDiv' | 'modAdd' | 'modSub' | 'postMul' | 'postDiv' | 'postPercent' | 'postAssign';

/**
 * tools-core's operation order: operation id → name.
 */
export const DOGMA_OPERATIONS: ReadonlyMap<number, DogmaOperationName> = new Map([
  [-1, 'preAssign'],
  [0, 'preMul'],
  [1, 'preDiv'],
  [2, 'modAdd'],
  [3, 'modSub'],
  [4, 'postMul'],
  [5, 'postDiv'],
  [6, 'postPercent'],
  [7, 'postAssign']
]);

/**
 * The stacking factor of the i-th (from 0) penalized modifier.
 *
 * @param index - Its place, strongest first.
 * @returns The factor: 1, 0.869, 0.571, 0.283, 0.106, ...
 */
export function stackingFactor(index: number): number {
  return Math.exp(-((index / 2.67) ** 2));
}

/**
 * Source categories never stacking-penalized: ship, charge, skill, implant, subsystem.
 */
export const STACKING_EXEMPT_CATEGORIES: ReadonlySet<number> = new Set([6, 8, 16, 20, 32]);

/**
 * Attribute ids the evaluator and the stats read by number.
 */
export const DOGMA_ATTRIBUTES = {
  mass: 4,
  radius: 162,
  capacity: 38,
  volume: 161,
  skillLevel: 280,
  maxVelocity: 37,
  agility: 70,
  signatureRadius: 552,
  warpSpeedMultiplier: 600,
  speedFactor: 20,
  speedBoostFactor: 567,
  massAddition: 796,
  signatureRadiusBonus: 554,
  armorEmDamageResonance: 267,
  armorExplosiveDamageResonance: 268,
  armorKineticDamageResonance: 269,
  armorThermalDamageResonance: 270
} as const;

/**
 * The character attributes the evaluator models: missileDamageMultiplier (212), which Ballistic Control Systems and
 * Warhead Calefaction rigs raise through charID ItemModifiers and every missile's damage is multiplied by. Every other
 * charID ItemModifier is skipped.
 */
export const CHARACTER_ATTRIBUTES = {
  missileDamageMultiplier: 212
} as const;

const CHARACTER_ATTRIBUTE_IDS: ReadonlySet<number> = new Set(Object.values(CHARACTER_ATTRIBUTES));

/**
 * The missile skills' damage code effects (no SDE modifiers): each adds the skill's evaluated damageMultiplierBonus
 * (292, already times the level) as a postPercent to one damage type of every charge that requires the skill.
 */
export const MISSILE_SKILL_DAMAGE_EFFECTS: Readonly<Record<string, number>> = {
  missileEMDmgBonus: 114,
  missileExplosiveDmgBonus: 116,
  missileThermalDmgBonus: 118,
  missileKineticDmgBonus2: 117
};

/**
 * The specializations' rate of fire code effect (no SDE modifiers): the skill's evaluated rofBonus (293, already
 * times the level) as a postPercent to the speed (51) of every module that requires the skill.
 */
export const SELF_ROF_EFFECT = 'selfRof';

const DAMAGE_MULTIPLIER_BONUS_ATTRIBUTE = 292;
const ROF_BONUS_ATTRIBUTE = 293;
const SPEED_ATTRIBUTE = 51;

const REQUIRED_SKILL_ATTRIBUTES = [182, 183, 184, 1285, 1289, 1290] as const;

const SKILL_CATEGORY = 16;

const SKILL_LEVEL_NAMES: readonly string[] = ['0', 'I', 'II', 'III', 'IV', 'V'];

const OVERRIDE_ATTRIBUTES: Readonly<Record<keyof HullStatOverrides, number>> = { mass: 4, maxVelocity: 37, agility: 70, signatureRadius: 552 };

const PENALIZED_OPERATIONS: ReadonlySet<number> = new Set([0, 1, 4, 5, 6]);

const SKIPPED_DOMAINS: ReadonlySet<string> = new Set(['targetID', 'target', 'structureID']);

const MODULE_CATEGORY = 7;

const MWD_EFFECT = 'moduleBonusMicrowarpdrive';
const AB_EFFECT = 'moduleBonusAfterburner';
const REACTIVE_HARDENER_EFFECT = 'adaptiveArmorHardener';

interface DogmaItem {
  readonly id: string;
  readonly label: string;
  readonly type: DogmaTypeRecord;
  readonly base: Map<number, number>;
  readonly located: boolean;
  other: Maybe<DogmaItem>;
  readonly requiredSkills: ReadonlySet<number>;
}

interface AppliedModifier {
  readonly source: DogmaItem;
  readonly effect: string;
  readonly operation: number;
  readonly amount: () => number;
  /**
   * False for a code effect the game does not penalize (the prop mod speed boost).
   */
  readonly penalizable: boolean;
}

interface Running {
  readonly item: DogmaItem;
  readonly effect: DogmaEffectRecord;
}

/**
 * Evaluates a ship's dogma. Accessors are lazy and memoized.
 *
 * @param input - The bundle, the hull, overrides, the modules with their states, the pilot and the skills.
 * @returns The evaluated ship.
 * @throws {RangeError} When the bundle lacks the hull.
 */
export function evaluateShipDogma(input: EvaluateShipDogmaInput): DogmaShip {
  const { bundle, hullTypeID, overrides } = input;
  const pilot = input.pilot ?? MAX_SKILLS_PILOT;
  const hull = bundle.types[hullTypeID];
  if (!hull) throw new RangeError(`the dogma bundle has no hull type ${hullTypeID}`);
  const warnings: string[] = [];
  const skipped = new Set<string>();
  const names = attributeNames(bundle);
  const attributeId = (attribute: string | number): number => {
    const id = typeof attribute === 'number' ? attribute : names.get(attribute);
    if (id == null) throw new RangeError(`the dogma bundle has no attribute "${String(attribute)}"`);
    return id;
  };

  const ship = makeItem({ id: 'ship', label: 'ship', type: hull, located: false });
  const character = characterItem(bundle);
  for (const [key, id] of Object.entries(OVERRIDE_ATTRIBUTES)) {
    const value = overrides?.[key as keyof HullStatOverrides];
    if (value != null) ship.base.set(id, value);
  }

  const modules = new Map<string, { readonly item: DogmaItem; readonly type: DogmaTypeRecord; readonly state: DogmaModuleState; readonly charge: Maybe<DogmaItem> }>();
  for (const module of input.modules ?? []) {
    const type = bundle.types[module.typeID];
    if (!type) {
      warnings.push(`module ${module.key}: the dogma bundle has no type ${module.typeID}; it is left out`);
      continue;
    }
    const item = makeItem({ id: `module:${module.key}`, label: `${type.name} (${module.key})`, type, located: true });
    const chargeType = module.chargeTypeID == null ? null : bundle.types[module.chargeTypeID];
    if (module.chargeTypeID != null && !chargeType) warnings.push(`module ${module.key}: the dogma bundle has no charge type ${module.chargeTypeID}; it is left out`);
    const charge = chargeType ? makeItem({ id: `charge:${module.key}`, label: `${chargeType.name} (${module.key})`, type: chargeType, located: true }) : null;
    if (charge) {
      item.other = charge;
      charge.other = item;
    }
    modules.set(module.key, { item, type, state: module.state, charge });
  }

  const skills: DogmaItem[] = [];
  const skillIDs = input.skillTypeIDs ?? Object.values(bundle.types).flatMap((type) => (type.categoryID === SKILL_CATEGORY ? [type.typeID] : []));
  for (const typeID of skillIDs) {
    const type = bundle.types[typeID];
    if (!type) continue;
    // A level-0 skill still runs: its pre-multiplications zero the hull's per-level trait bonuses.
    const level = pilot.skillLevel({ typeID, name: type.name });
    const item = makeItem({ id: `skill:${typeID}`, label: `${type.name} ${SKILL_LEVEL_NAMES[level] ?? level}`, type, located: false });
    item.base.set(DOGMA_ATTRIBUTES.skillLevel, level);
    skills.push(item);
  }

  const running: Running[] = [];
  const effectsOf = (type: DogmaTypeRecord, accept: (effect: DogmaEffectRecord) => boolean): DogmaEffectRecord[] => type.effects.flatMap((id) => (bundle.effects[id] && accept(bundle.effects[id]) ? [bundle.effects[id]] : []));
  for (const item of [ship, ...skills]) for (const effect of effectsOf(item.type, (candidate) => candidate.category === 0)) running.push({ item, effect });
  for (const { item, type, state, charge } of modules.values()) {
    const on = state !== 'offline';
    for (const effect of effectsOf(type, (candidate) => candidate.category === 0 || (on && candidate.category === 4) || (state === 'active' && candidate.effectID === type.defaultEffect && candidate.category !== 5))) running.push({ item, effect });
    if (charge && on) for (const effect of effectsOf(charge.type, (candidate) => candidate.category === 0)) running.push({ item: charge, effect });
  }

  const located = [...modules.values()].flatMap((module) => (module.charge ? [module.item, module.charge] : [module.item]));
  const charges = located.filter((item) => item.type.categoryID === 8);
  const incoming = new Map<string, Map<number, AppliedModifier[]>>();
  const add = (target: DogmaItem, attribute: number, modifier: AppliedModifier): void => {
    const byAttribute = incoming.get(target.id) ?? new Map<number, AppliedModifier[]>();
    incoming.set(target.id, byAttribute);
    byAttribute.set(attribute, [...(byAttribute.get(attribute) ?? []), modifier]);
  };

  const evaluated = new Map<string, number>();
  const traces = new Map<string, DogmaTraceStep[]>();
  const inProgress = new Set<string>();
  const evaluate = (item: DogmaItem, attribute: number): number => {
    const key = `${item.id}:${attribute}`;
    const known = evaluated.get(key);
    if (known != null) return known;
    const record = bundle.attributes[attribute];
    const base = item.base.get(attribute) ?? record?.defaultValue ?? 0;
    if (inProgress.has(key)) {
      warnings.push(`${item.label}: attribute ${record?.name ?? attribute} depends on itself; its base value is used`);
      return base;
    }
    inProgress.add(key);
    const steps: DogmaTraceStep[] = [];
    let value = applyModifiers({ base, modifiers: incoming.get(item.id)?.get(attribute) ?? [], record, steps });
    if (record?.maxAttributeID != null) {
      const cap = evaluate(item, record.maxAttributeID);
      if (value > cap) value = cap;
    }
    inProgress.delete(key);
    evaluated.set(key, value);
    traces.set(key, steps);
    return value;
  };

  for (const { item, effect } of running) {
    for (const modifier of effect.modifiers) {
      if (modifier.operation === 9 || modifier.func === 'EffectStopper') continue;
      if (SKIPPED_DOMAINS.has(modifier.domain)) {
        skipped.add(effect.name);
        continue;
      }
      if (modifier.modifiedAttributeID === DOGMA_ATTRIBUTES.skillLevel && item.type.categoryID === SKILL_CATEGORY) continue;
      const targets = resolveTargets({ item, modifier, ship, character, located, charges });
      if (targets == null) {
        skipped.add(effect.name);
        continue;
      }
      const applied: AppliedModifier = { source: item, effect: effect.name, operation: modifier.operation, amount: () => evaluate(item, modifier.modifyingAttributeID), penalizable: true };
      for (const target of targets) add(target, modifier.modifiedAttributeID, applied);
    }
    addCodeEffect({ item, effect, ship, located, charges, add, evaluate });
  }

  for (const [index, modifier] of (input.incoming ?? []).entries()) {
    const source = incomingItem(modifier, index);
    const resistance = (): number => {
      const id = modifier.resistanceAttributeID;
      return id != null && resistsWith({ base: ship.base.has(id), record: bundle.attributes[id] }) ? evaluate(ship, id) : 1;
    };
    add(ship, modifier.attributeID, { source, effect: modifier.effect, operation: modifier.operation, amount: () => scaleModifierAmount(modifier.operation, modifier.amount, resistance()), penalizable: true });
  }

  return {
    hull,
    pilot: pilot.name,
    attribute: (attribute) => evaluate(ship, attributeId(attribute)),
    moduleAttribute: (key, attribute) => {
      const module = modules.get(key);
      return module ? evaluate(module.item, attributeId(attribute)) : null;
    },
    chargeAttribute: (key, attribute) => {
      const charge = modules.get(key)?.charge;
      return charge ? evaluate(charge, attributeId(attribute)) : null;
    },
    characterAttribute: (attribute) => {
      const id = typeof attribute === 'number' ? attribute : names.get(attribute);
      return id != null && CHARACTER_ATTRIBUTE_IDS.has(id) ? evaluate(character, id) : null;
    },
    trace: (attribute, key = null) => {
      const item = key == null ? ship : modules.get(key)?.item;
      if (!item) return [];
      const id = attributeId(attribute);
      evaluate(item, id);
      return traces.get(`${item.id}:${id}`) ?? [];
    },
    modules: new Map([...modules].map(([key, module]) => [key, { type: module.type, state: module.state, charge: module.charge?.type ?? null }])),
    skipped: [...skipped].sort(),
    warnings
  };
}

/**
 * A ship's resistance to a remote effect (stasisWebifierResistance, energyWarfareResistance, ...): its evaluated value
 * when the hull carries the attribute or the bundle gives it a non-zero default, else 1. Many hulls lack 2114 or 6463,
 * and a missing value means no resistance, never immunity.
 *
 * @param ship - The evaluated ship.
 * @param bundle - Its bundle.
 * @param attributeID - The resistance attribute.
 * @returns The factor the effect is multiplied by.
 */
export function dogmaResistanceOf(ship: DogmaShip, bundle: DogmaBundle, attributeID: number): number {
  return resistsWith({ base: ship.hull.attributes[attributeID] != null, record: bundle.attributes[attributeID] }) ? ship.attribute(attributeID) : 1;
}

function resistsWith(input: { readonly base: boolean; readonly record: Maybe<DogmaAttributeRecord> }): boolean {
  return input.base || (input.record?.defaultValue ?? 0) > 0;
}

function incomingItem(modifier: DogmaIncomingModifier, index: number): DogmaItem {
  const type: DogmaTypeRecord = { typeID: 0, name: modifier.source, groupID: 0, categoryID: MODULE_CATEGORY, published: false, attributes: {}, effects: [] };
  return { id: `incoming:${index}`, label: modifier.source, type, base: new Map(), located: false, other: null, requiredSkills: new Set() };
}

export interface ApplyIncomingModifiersInput {
  /**
   * The attribute's value before them.
   */
  readonly base: number;
  readonly modifiers: readonly DogmaIncomingModifier[];
  /**
   * Whether the attribute is stackable (maxVelocity and signatureRadius are not: their incoming modifiers are
   * penalized).
   */
  readonly stackable: boolean;
}

/**
 * Applies incoming modifiers to one attribute outside an evaluation (the table path's webs and painters), with the
 * evaluator's operation order and stacking rules. Resistances are not applied: table-path ships resist nothing.
 *
 * @param input - The base value, the modifiers on that attribute and its stacking rule.
 * @returns The value and the steps.
 */
export function applyIncomingModifiers(input: ApplyIncomingModifiersInput): { readonly value: number; readonly steps: DogmaTraceStep[] } {
  const steps: DogmaTraceStep[] = [];
  const modifiers = input.modifiers.map((modifier, index): AppliedModifier => ({ source: incomingItem(modifier, index), effect: modifier.effect, operation: modifier.operation, amount: () => modifier.amount, penalizable: true }));
  const record: DogmaAttributeRecord = { attributeID: 0, name: 'incoming', stackable: input.stackable, highIsGood: true, defaultValue: 0 };
  return { value: applyModifiers({ base: input.base, modifiers, record, steps }), steps };
}

const NAMES_BY_BUNDLE = new WeakMap<DogmaBundle, Map<string, number>>();

function attributeNames(bundle: DogmaBundle): Map<string, number> {
  let names = NAMES_BY_BUNDLE.get(bundle);
  if (!names) {
    names = new Map(Object.values(bundle.attributes).map((record) => [record.name, record.attributeID]));
    NAMES_BY_BUNDLE.set(bundle, names);
  }
  return names;
}

/**
 * The character: one item per evaluation holding the character attributes the evaluator models, each at the bundle's
 * default (1 without a record).
 */
function characterItem(bundle: DogmaBundle): DogmaItem {
  const type: DogmaTypeRecord = { typeID: 0, name: 'character', groupID: 0, categoryID: 0, published: false, attributes: {}, effects: [] };
  const base = new Map([...CHARACTER_ATTRIBUTE_IDS].map((id) => [id, bundle.attributes[id]?.defaultValue ?? 1]));
  return { id: 'character', label: 'character', type, base, located: false, other: null, requiredSkills: new Set() };
}

function makeItem(config: { readonly id: string; readonly label: string; readonly type: DogmaTypeRecord; readonly located: boolean }): DogmaItem {
  const { type } = config;
  const base = new Map<number, number>(Object.entries(type.attributes).map(([id, value]) => [Number(id), value]));
  for (const [column, id] of [
    ['mass', DOGMA_ATTRIBUTES.mass],
    ['radius', DOGMA_ATTRIBUTES.radius],
    ['capacity', DOGMA_ATTRIBUTES.capacity],
    ['volume', DOGMA_ATTRIBUTES.volume]
  ] as const) {
    const value = type[column];
    if (value != null && !base.has(id)) base.set(id, value);
  }
  const requiredSkills = new Set(REQUIRED_SKILL_ATTRIBUTES.flatMap((id) => (base.get(id) ? [base.get(id) as number] : [])));
  return { ...config, base, other: null, requiredSkills };
}

interface ResolveTargetsInput {
  readonly item: DogmaItem;
  readonly modifier: DogmaEffectRecord['modifiers'][number];
  readonly ship: DogmaItem;
  readonly character: DogmaItem;
  readonly located: readonly DogmaItem[];
  readonly charges: readonly DogmaItem[];
}

/**
 * The items a modifier acts on, or null when it acts on something this evaluator does not model (the character's own
 * attributes, but CHARACTER_ATTRIBUTES).
 */
function resolveTargets(input: ResolveTargetsInput): Maybe<readonly DogmaItem[]> {
  const { item, modifier, ship, character, located, charges } = input;
  const skill = modifier.skillTypeID === -1 ? item.type.typeID : modifier.skillTypeID;
  const ownerDomain = modifier.domain === 'shipID' || modifier.domain === 'charID';
  let targets: Maybe<readonly DogmaItem[]> = null;
  switch (modifier.func) {
    case 'ItemModifier':
      if (modifier.domain === 'shipID') targets = [ship];
      else if (modifier.domain === 'itemID' || modifier.domain === '') targets = [item];
      else if (modifier.domain === 'otherID') targets = item.other ? [item.other] : [];
      else if (modifier.domain === 'charID' && CHARACTER_ATTRIBUTE_IDS.has(modifier.modifiedAttributeID)) targets = [character];
      break;
    case 'LocationModifier':
      if (ownerDomain) targets = located;
      break;
    case 'LocationGroupModifier':
      if (ownerDomain) targets = located.filter((target) => target.type.groupID === modifier.groupID);
      break;
    case 'LocationRequiredSkillModifier':
      if (ownerDomain) targets = located.filter((target) => skill != null && target.requiredSkills.has(skill));
      break;
    case 'OwnerRequiredSkillModifier':
      if (ownerDomain) targets = charges.filter((target) => skill != null && target.requiredSkills.has(skill));
      break;
  }
  return targets;
}

interface CodeEffectInput {
  readonly item: DogmaItem;
  readonly effect: DogmaEffectRecord;
  readonly ship: DogmaItem;
  readonly located: readonly DogmaItem[];
  readonly charges: readonly DogmaItem[];
  readonly add: (target: DogmaItem, attribute: number, modifier: AppliedModifier) => void;
  readonly evaluate: (item: DogmaItem, attribute: number) => number;
}

/**
 * The code effects this evaluator builds in (their SDE records carry no modifiers).
 */
function addCodeEffect(input: CodeEffectInput): void {
  const { item, effect, ship, located, charges, add, evaluate } = input;
  const own = (attribute: number) => () => evaluate(item, attribute);
  const skill = item.type.categoryID === SKILL_CATEGORY ? item.type.typeID : null;
  const damageAttribute = MISSILE_SKILL_DAMAGE_EFFECTS[effect.name];
  if (effect.name === MWD_EFFECT || effect.name === AB_EFFECT) {
    add(ship, DOGMA_ATTRIBUTES.mass, { source: item, effect: effect.name, operation: 2, amount: own(DOGMA_ATTRIBUTES.massAddition), penalizable: true });
    const boost = (): number => (evaluate(item, DOGMA_ATTRIBUTES.speedFactor) * evaluate(item, DOGMA_ATTRIBUTES.speedBoostFactor)) / evaluate(ship, DOGMA_ATTRIBUTES.mass);
    add(ship, DOGMA_ATTRIBUTES.maxVelocity, { source: item, effect: effect.name, operation: 6, amount: boost, penalizable: false });
    if (effect.name === MWD_EFFECT) add(ship, DOGMA_ATTRIBUTES.signatureRadius, { source: item, effect: effect.name, operation: 6, amount: own(DOGMA_ATTRIBUTES.signatureRadiusBonus), penalizable: true });
  } else if (effect.name === REACTIVE_HARDENER_EFFECT) {
    for (const id of [DOGMA_ATTRIBUTES.armorEmDamageResonance, DOGMA_ATTRIBUTES.armorExplosiveDamageResonance, DOGMA_ATTRIBUTES.armorKineticDamageResonance, DOGMA_ATTRIBUTES.armorThermalDamageResonance]) {
      add(ship, id, { source: item, effect: effect.name, operation: 0, amount: own(id), penalizable: true });
    }
  } else if (skill != null && damageAttribute != null) {
    for (const charge of charges.filter((target) => target.requiredSkills.has(skill))) add(charge, damageAttribute, { source: item, effect: effect.name, operation: 6, amount: own(DAMAGE_MULTIPLIER_BONUS_ATTRIBUTE), penalizable: true });
  } else if (skill != null && effect.name === SELF_ROF_EFFECT) {
    for (const module of located.filter((target) => target.type.categoryID === MODULE_CATEGORY && target.requiredSkills.has(skill))) add(module, SPEED_ATTRIBUTE, { source: item, effect: effect.name, operation: 6, amount: own(ROF_BONUS_ATTRIBUTE), penalizable: true });
  }
}

interface ApplyModifiersInput {
  readonly base: number;
  readonly modifiers: readonly AppliedModifier[];
  readonly record: Maybe<DogmaAttributeRecord>;
  readonly steps: DogmaTraceStep[];
}

function applyModifiers(input: ApplyModifiersInput): number {
  const { base, modifiers, record, steps } = input;
  let value = base;
  for (const [operation, name] of DOGMA_OPERATIONS) {
    const group = modifiers.filter((modifier) => modifier.operation === operation);
    if (!group.length) continue;
    const step = (modifier: AppliedModifier, amount: number, change: (from: number) => number, penalty?: number): void => {
      const from = value;
      value = change(from);
      steps.push({ source: modifier.source.label, effect: modifier.effect, operation: name, amount, ...(penalty == null ? {} : { penalty }), from, to: value });
    };
    if (name === 'preAssign' || name === 'postAssign') {
      const last = group.at(-1) as AppliedModifier;
      const amount = last.amount();
      step(last, amount, () => amount);
    } else if (name === 'modAdd' || name === 'modSub') {
      for (const modifier of group) {
        const amount = modifier.amount();
        step(modifier, amount, (from) => (name === 'modAdd' ? from + amount : from - amount));
      }
    } else {
      const multipliers = group.map((modifier) => ({ modifier, amount: modifier.amount(), multiplier: toMultiplier(name, modifier.amount()) }));
      const penalized = record?.stackable === false && PENALIZED_OPERATIONS.has(operation);
      const isPenalized = (entry: { readonly modifier: AppliedModifier }): boolean => penalized && entry.modifier.penalizable && !STACKING_EXEMPT_CATEGORIES.has(entry.modifier.source.type.categoryID);
      for (const entry of multipliers.filter((candidate) => !isPenalized(candidate))) step(entry.modifier, entry.amount, (from) => from * entry.multiplier);
      const chained = multipliers.filter(isPenalized);
      for (const side of [chained.filter((entry) => entry.multiplier > 1), chained.filter((entry) => entry.multiplier < 1)]) {
        const sorted = [...side].sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1));
        for (const [index, entry] of sorted.entries()) {
          const factor = stackingFactor(index);
          step(entry.modifier, entry.amount, (from) => from * (1 + (entry.multiplier - 1) * factor), factor);
        }
      }
    }
  }
  return value;
}

function toMultiplier(operation: DogmaOperationName, amount: number): number {
  let multiplier = amount;
  if (operation === 'postPercent') multiplier = 1 + amount / 100;
  else if (operation === 'preDiv' || operation === 'postDiv') multiplier = amount === 0 ? 1 : 1 / amount;
  return multiplier;
}
