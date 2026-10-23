/**
 * A data-driven EVE dogma evaluator for one ship: the hull, its fitted modules and their charges, and the pilot's
 * skills, from a DogmaBundle (tools-core's SDE through the hub). Hull traits come for free: a racial hull skill
 * premultiplies the ship's `shipBonus*` attribute and the hull's own effects apply it.
 *
 * Rules (the sd-fittings ref has the detail):
 * - Effects that run: skills and the hull, category 0; modules, category 0 always, category 4 (online) when online or
 *   active, their default effect when active; charges, category 0 while their module is online or active. Overload
 *   (5) never runs. Modifiers on the target, structure and character domains are skipped (listed in `skipped`).
 * - Operations apply in tools-core's order: preAssign, preMul, preDiv, modAdd, modSub, postMul, postDiv, postPercent,
 *   postAssign. A modifier's amount is its modifying attribute evaluated on its source item.
 * - Stacking penalty: on an attribute that is not stackable, from a source that is not a ship, charge, skill, implant
 *   or subsystem, for preMul, preDiv, postMul, postDiv and postPercent. Each operation is its own group, bonuses and
 *   maluses apart, strongest first; the i-th (from 0) counts `exp(-(i / 2.67)^2)`.
 * - `maxAttributeID` caps the result at the item's value of that attribute. A dependency cycle uses the base value.
 * - Code effects (no modifiers in the SDE; built in here as Pyfa does): the MWD and AB speed, mass and signature, and
 *   the reactive armor hardener's static profile. Other code effects (reps, webs, neuts) change no attribute here;
 *   their numbers are read with moduleAttribute.
 */

import type { Maybe } from '@dereekb/util';
import type { HullStatOverrides } from '../stats/ship-stats';
import { MAX_SKILLS_PILOT, type PilotContext } from '../stats/pilot';
import type { DogmaAttributeRecord, DogmaBundle, DogmaEffectRecord, DogmaTypeRecord } from './dogma-bundle';

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

const REQUIRED_SKILL_ATTRIBUTES = [182, 183, 184, 1285, 1289, 1290] as const;

const SKILL_CATEGORY = 16;

const SKILL_LEVEL_NAMES: readonly string[] = ['0', 'I', 'II', 'III', 'IV', 'V'];

const OVERRIDE_ATTRIBUTES: Readonly<Record<keyof HullStatOverrides, number>> = { mass: 4, maxVelocity: 37, agility: 70, signatureRadius: 552 };

const PENALIZED_OPERATIONS: ReadonlySet<number> = new Set([0, 1, 4, 5, 6]);

const SKIPPED_DOMAINS: ReadonlySet<string> = new Set(['targetID', 'target', 'structureID']);

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
      const targets = resolveTargets({ item, modifier, ship, located, charges });
      if (targets == null) {
        skipped.add(effect.name);
        continue;
      }
      const applied: AppliedModifier = { source: item, effect: effect.name, operation: modifier.operation, amount: () => evaluate(item, modifier.modifyingAttributeID), penalizable: true };
      for (const target of targets) add(target, modifier.modifiedAttributeID, applied);
    }
    addCodeEffect({ item, effect, ship, add, evaluate });
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

const NAMES_BY_BUNDLE = new WeakMap<DogmaBundle, Map<string, number>>();

function attributeNames(bundle: DogmaBundle): Map<string, number> {
  let names = NAMES_BY_BUNDLE.get(bundle);
  if (!names) {
    names = new Map(Object.values(bundle.attributes).map((record) => [record.name, record.attributeID]));
    NAMES_BY_BUNDLE.set(bundle, names);
  }
  return names;
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
  readonly located: readonly DogmaItem[];
  readonly charges: readonly DogmaItem[];
}

/**
 * The items a modifier acts on, or null when it acts on something this evaluator does not model (the character's own
 * attributes).
 */
function resolveTargets(input: ResolveTargetsInput): Maybe<readonly DogmaItem[]> {
  const { item, modifier, ship, located, charges } = input;
  const skill = modifier.skillTypeID === -1 ? item.type.typeID : modifier.skillTypeID;
  const ownerDomain = modifier.domain === 'shipID' || modifier.domain === 'charID';
  let targets: Maybe<readonly DogmaItem[]> = null;
  switch (modifier.func) {
    case 'ItemModifier':
      if (modifier.domain === 'shipID') targets = [ship];
      else if (modifier.domain === 'itemID' || modifier.domain === '') targets = [item];
      else if (modifier.domain === 'otherID') targets = item.other ? [item.other] : [];
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
  readonly add: (target: DogmaItem, attribute: number, modifier: AppliedModifier) => void;
  readonly evaluate: (item: DogmaItem, attribute: number) => number;
}

/**
 * The code effects this evaluator builds in (their SDE records carry no modifiers).
 */
function addCodeEffect(input: CodeEffectInput): void {
  const { item, effect, ship, add, evaluate } = input;
  const own = (attribute: number) => () => evaluate(item, attribute);
  if (effect.name === MWD_EFFECT || effect.name === AB_EFFECT) {
    add(ship, DOGMA_ATTRIBUTES.mass, { source: item, effect: effect.name, operation: 2, amount: own(DOGMA_ATTRIBUTES.massAddition), penalizable: true });
    const boost = (): number => (evaluate(item, DOGMA_ATTRIBUTES.speedFactor) * evaluate(item, DOGMA_ATTRIBUTES.speedBoostFactor)) / evaluate(ship, DOGMA_ATTRIBUTES.mass);
    add(ship, DOGMA_ATTRIBUTES.maxVelocity, { source: item, effect: effect.name, operation: 6, amount: boost, penalizable: false });
    if (effect.name === MWD_EFFECT) add(ship, DOGMA_ATTRIBUTES.signatureRadius, { source: item, effect: effect.name, operation: 6, amount: own(DOGMA_ATTRIBUTES.signatureRadiusBonus), penalizable: true });
  } else if (effect.name === REACTIVE_HARDENER_EFFECT) {
    for (const id of [DOGMA_ATTRIBUTES.armorEmDamageResonance, DOGMA_ATTRIBUTES.armorExplosiveDamageResonance, DOGMA_ATTRIBUTES.armorKineticDamageResonance, DOGMA_ATTRIBUTES.armorThermalDamageResonance]) {
      add(ship, id, { source: item, effect: effect.name, operation: 0, amount: own(id), penalizable: true });
    }
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
