import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readId, readNumber, readString, reportUnknownKeys } from '../json';
import { FLEET_PERSONALITY_EXAMPLES } from './examples';
import {
  DEFAULT_FLEET_PERSONALITY,
  FLEET_ENGAGE_RULES,
  FLEET_PERSONALITY_SCHEMA,
  FLEET_PROP_MOD_RULES,
  FLEET_REACHES,
  FLEET_STANCES,
  FLEET_SUCCESSION_STEPS,
  FLEET_TARGET_PREFERENCES,
  FLEET_TARGET_ROLES,
  FLEET_TARGET_SWITCHES,
  type FleetEngageRule,
  type FleetPersonality,
  type FleetPersonalityCommand,
  type FleetPersonalityMovement,
  type FleetPersonalityPilots,
  type FleetPersonalityTargeting,
  type FleetReach,
  type FleetTraitRange,
  MAX_FLEET_BACKUPS,
  MAX_FLEET_HANDOVER,
  MAX_FLEET_TARGET_QUEUE,
  MIN_FLEET_HANDOVER,
  type ResolvedFleetPersonality
} from './personality';

const PERSONALITY_KEYS = new Set<string>(['schema', 'id', 'extends', 'name', 'description', 'command', 'pilots', 'engage', 'targeting', 'movement']);
const COMMAND_KEYS = new Set<string>(['ability', 'backups', 'succession', 'handover']);
const PILOTS_KEYS = new Set<string>(['reaction']);
const TARGETING_KEYS = new Set<string>(['priority', 'prefer', 'reach', 'queue', 'switch', 'calls', 'freeFire']);
const MOVEMENT_KEYS = new Set<string>(['stance', 'range', 'propMods']);

/**
 * The farthest metre reach or range: the brain's awareness around its FC.
 */
export const MAX_FLEET_REACH = 250_000;

/**
 * How many templates an `extends` chain may hold, the root included.
 */
export const MAX_FLEET_PERSONALITY_CHAIN = 8;

export interface NormalizeFleetPersonalityInput {
  readonly input: unknown;
  /**
   * Where the template sits, e.g. `personalities["brawler-2"]`.
   */
  readonly where: string;
  /**
   * The key it sits under in the document's `personalities`: its `id` defaults to it and must match it.
   */
  readonly key?: string;
}

export interface NormalizedFleetPersonality {
  readonly personality: Maybe<FleetPersonality>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a `cjs-fleet-personality/1` template as written: each set field is checked, unknown keys warn and are
 * dropped, and nothing is filled from its base (resolveFleetPersonality merges the chain).
 *
 * @param config - The candidate, where it sits and its document key.
 * @returns The normalized template, or null with the problems found.
 */
export function normalizeFleetPersonality(config: NormalizeFleetPersonalityInput): NormalizedFleetPersonality {
  const { input, where, key } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  let personality: Maybe<FleetPersonality> = null;
  if (isPlainObject(input)) {
    personality = readPersonality(input, { where, key, problems, warnings });
  } else {
    problems.push(`${where} must be a ${FLEET_PERSONALITY_SCHEMA} object`);
  }
  return { personality: problems.length ? null : personality, problems, warnings };
}

/**
 * The built-in personalities by id, normalized once.
 *
 * @returns The built-ins.
 */
export function builtInFleetPersonalities(): ReadonlyMap<string, FleetPersonality> {
  if (!builtIns) {
    const map = new Map<string, FleetPersonality>();
    for (const [index, example] of FLEET_PERSONALITY_EXAMPLES.entries()) {
      const normalized = normalizeFleetPersonality({ input: example, where: `built-in personality ${index}` });
      if (!normalized.personality) throw new Error(normalized.problems.join('; '));
      map.set(normalized.personality.id, normalized.personality);
    }
    builtIns = map;
  }
  return builtIns;
}

let builtIns: Maybe<Map<string, FleetPersonality>> = null;

/**
 * Whether a name is a built-in personality.
 *
 * @param name - The candidate.
 * @returns Whether it names one.
 */
export function isBuiltInFleetPersonality(name: string): boolean {
  return builtInFleetPersonalities().has(name);
}

export interface ResolveFleetPersonalityInput {
  /**
   * A built-in name or a key of `personalities`.
   */
  readonly name: string;
  /**
   * The document's embedded templates (normalized).
   */
  readonly personalities?: Maybe<Readonly<Record<string, FleetPersonality>>>;
  /**
   * Where the name sits, for messages. Default `personality "<name>"`.
   */
  readonly where?: string;
}

export interface ResolvedFleetPersonalityResult {
  readonly personality: Maybe<ResolvedFleetPersonality>;
  readonly problems: string[];
}

/**
 * Resolves a personality by name: follows its `extends` chain (a key of `personalities` first, else a built-in) to
 * `line` and merges each template's fields over its base's, section by section. A loop, an unknown name or a chain
 * longer than MAX_FLEET_PERSONALITY_CHAIN is a problem.
 *
 * @param config - The name and the document's templates.
 * @returns The resolved personality, or null with the problems found.
 */
export function resolveFleetPersonality(config: ResolveFleetPersonalityInput): ResolvedFleetPersonalityResult {
  const { name, personalities } = config;
  const where = config.where ?? `personality "${name}"`;
  const problems: string[] = [];
  const chain: FleetPersonality[] = [];
  let next: Maybe<string> = name;
  while (next != null && !problems.length) {
    const template: Maybe<FleetPersonality> = personalities?.[next] ?? builtInFleetPersonalities().get(next);
    if (!template) problems.push(chain.length ? `${where}: "${chain[chain.length - 1].id}" extends "${next}", which is not a built-in personality or a key of personalities` : `${where}: "${next}" is not a built-in personality or a key of personalities`);
    else if (chain.some((link) => link.id === template.id)) problems.push(`${where}: its extends chain loops (${[...chain.map((link) => link.id), template.id].join(' -> ')})`);
    else if (chain.length >= MAX_FLEET_PERSONALITY_CHAIN) problems.push(`${where}: its extends chain is longer than ${MAX_FLEET_PERSONALITY_CHAIN}`);
    else {
      chain.push(template);
      next = template.extends ?? (template.id === DEFAULT_FLEET_PERSONALITY ? null : DEFAULT_FLEET_PERSONALITY);
    }
  }
  return { personality: problems.length ? null : mergeChain(chain), problems };
}

/**
 * Merges a chain, root last: each field is the first template's that sets it.
 *
 * @param chain - The templates from the named one to the root.
 * @returns The resolved personality.
 */
function mergeChain(chain: readonly FleetPersonality[]): ResolvedFleetPersonality {
  const ordered = [...chain].reverse();
  const merged = (pick: (template: FleetPersonality) => Maybe<object>) => Object.assign({}, ...ordered.map((template) => pick(template) ?? {}));
  const head = chain[0];
  return {
    id: head.id,
    name: head.name ?? head.id,
    ...(head.description ? { description: head.description } : {}),
    chain: chain.map((template) => template.id),
    command: merged((template) => template.command) as FleetPersonalityCommand,
    pilots: merged((template) => template.pilots) as FleetPersonalityPilots,
    engage: ordered.reduce<FleetEngageRule>((engage, template) => template.engage ?? engage, FLEET_ENGAGE_RULES[1]),
    targeting: merged((template) => template.targeting) as FleetPersonalityTargeting,
    movement: merged((template) => template.movement) as FleetPersonalityMovement
  };
}

interface ReadContext {
  readonly where: string;
  readonly key?: string;
  readonly problems: string[];
  readonly warnings: string[];
}

function readPersonality(input: JsonObject, context: ReadContext): FleetPersonality {
  const { where, key, problems, warnings } = context;
  reportUnknownKeys(input, PERSONALITY_KEYS, where, warnings);
  if (input['schema'] !== undefined && input['schema'] !== FLEET_PERSONALITY_SCHEMA) problems.push(`${where}.schema must be "${FLEET_PERSONALITY_SCHEMA}", got ${JSON.stringify(input['schema'])}`);
  const id = input['id'] == null && key ? key : readId(input['id'], `${where}.id`, problems);
  if (key && id && id !== key) problems.push(`${where}.id "${id}" must match its key "${key}"`);
  const personality: FleetPersonality = { schema: FLEET_PERSONALITY_SCHEMA, id };
  if (input['extends'] != null) {
    personality.extends = readId(input['extends'], `${where}.extends`, problems);
    if (personality.extends && personality.extends === id) problems.push(`${where}.extends cannot name the template itself`);
  }
  if (input['name'] != null) personality.name = readString(input['name'], `${where}.name`, problems);
  if (input['description'] != null) personality.description = readString(input['description'], `${where}.description`, problems);
  const command = readSection(input['command'], { ...context, where: `${where}.command`, keys: COMMAND_KEYS, read: readCommand });
  if (command) personality.command = command;
  const pilots = readSection(input['pilots'], { ...context, where: `${where}.pilots`, keys: PILOTS_KEYS, read: readPilots });
  if (pilots) personality.pilots = pilots;
  if (input['engage'] != null) personality.engage = readChoice(input['engage'], { where: `${where}.engage`, choices: FLEET_ENGAGE_RULES, problems });
  const targeting = readSection(input['targeting'], { ...context, where: `${where}.targeting`, keys: TARGETING_KEYS, read: readTargeting });
  if (targeting) personality.targeting = targeting;
  const movement = readSection(input['movement'], { ...context, where: `${where}.movement`, keys: MOVEMENT_KEYS, read: readMovement });
  if (movement) personality.movement = movement;
  return personality;
}

interface SectionInput<T> extends ReadContext {
  readonly keys: Set<string>;
  readonly read: (input: JsonObject, where: string, problems: string[]) => Partial<T>;
}

function readSection<T>(input: unknown, config: SectionInput<T>): Maybe<Partial<T>> {
  const { where, keys, read, problems, warnings } = config;
  let section: Maybe<Partial<T>> = null;
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object`);
  } else if (input != null) {
    reportUnknownKeys(input, keys, where, warnings);
    const fields = read(input, where, problems);
    if (Object.keys(fields).length) section = fields;
  }
  return section;
}

function readCommand(input: JsonObject, where: string, problems: string[]): Partial<FleetPersonalityCommand> {
  const command: Partial<FleetPersonalityCommand> = {};
  if (input['ability'] != null) command.ability = readTraitRange(input['ability'], `${where}.ability`, problems);
  if (input['backups'] != null) command.backups = readCount(input['backups'], { where: `${where}.backups`, max: MAX_FLEET_BACKUPS, problems });
  if (input['succession'] != null) {
    const steps = readChoiceList(input['succession'], { where: `${where}.succession`, choices: FLEET_SUCCESSION_STEPS, problems });
    if (!steps.length) problems.push(`${where}.succession must name at least one of ${FLEET_SUCCESSION_STEPS.join(', ')}`);
    command.succession = steps;
  }
  if (input['handover'] != null) command.handover = readNumber(input['handover'], `${where}.handover (seconds)`, problems, { min: MIN_FLEET_HANDOVER, max: MAX_FLEET_HANDOVER });
  return command;
}

function readPilots(input: JsonObject, where: string, problems: string[]): Partial<FleetPersonalityPilots> {
  return input['reaction'] == null ? {} : { reaction: readTraitRange(input['reaction'], `${where}.reaction`, problems) };
}

function readTargeting(input: JsonObject, where: string, problems: string[]): Partial<FleetPersonalityTargeting> {
  const targeting: Partial<FleetPersonalityTargeting> = {};
  if (input['priority'] != null) targeting.priority = readChoiceList(input['priority'], { where: `${where}.priority`, choices: FLEET_TARGET_ROLES, problems });
  if (input['prefer'] != null) targeting.prefer = readChoice(input['prefer'], { where: `${where}.prefer`, choices: FLEET_TARGET_PREFERENCES, problems });
  if (input['reach'] != null) targeting.reach = readReach(input['reach'], `${where}.reach`, problems);
  if (input['queue'] != null) targeting.queue = readCount(input['queue'], { where: `${where}.queue`, max: MAX_FLEET_TARGET_QUEUE, problems });
  if (input['switch'] != null) targeting.switch = readChoice(input['switch'], { where: `${where}.switch`, choices: FLEET_TARGET_SWITCHES, problems });
  if (input['calls'] != null) {
    if (typeof input['calls'] === 'boolean') targeting.calls = input['calls'];
    else problems.push(`${where}.calls must be true or false`);
  }
  if (input['freeFire'] != null) {
    if (typeof input['freeFire'] === 'boolean') targeting.freeFire = input['freeFire'];
    else problems.push(`${where}.freeFire must be true or false`);
  }
  return targeting;
}

function readMovement(input: JsonObject, where: string, problems: string[]): Partial<FleetPersonalityMovement> {
  const movement: Partial<FleetPersonalityMovement> = {};
  if (input['stance'] != null) movement.stance = readChoice(input['stance'], { where: `${where}.stance`, choices: FLEET_STANCES, problems });
  if (input['range'] != null) movement.range = readReach(input['range'], `${where}.range`, problems);
  if (input['propMods'] != null) movement.propMods = readChoice(input['propMods'], { where: `${where}.propMods`, choices: FLEET_PROP_MOD_RULES, problems });
  return movement;
}

/**
 * Reads an ability or reaction: a number in [0, 1], or `[lo, hi]` with 0 <= lo <= hi <= 1.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem.
 * @returns The value or range.
 */
export function readTraitRange(value: unknown, where: string, problems: string[]): FleetTraitRange {
  const isUnit = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1;
  let range: FleetTraitRange = 0;
  if (isUnit(value)) range = value;
  else if (Array.isArray(value) && value.length === 2 && isUnit(value[0]) && isUnit(value[1]) && value[0] <= value[1]) range = [value[0], value[1]];
  else problems.push(`${where} must be a number in [0, 1] or [lo, hi] with 0 <= lo <= hi <= 1`);
  return range;
}

function readReach(value: unknown, where: string, problems: string[]): FleetReach {
  let reach: FleetReach = FLEET_REACHES[1];
  if (typeof value === 'string' && (FLEET_REACHES as readonly string[]).includes(value)) reach = value as FleetReach;
  else if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_FLEET_REACH) reach = value;
  else problems.push(`${where} must be one of ${FLEET_REACHES.join(', ')} or metres in (0, ${MAX_FLEET_REACH}]`);
  return reach;
}

function readCount(value: unknown, config: { readonly where: string; readonly max: number; readonly problems: string[] }): number {
  const { where, max, problems } = config;
  let count = 0;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max) count = value;
  else problems.push(`${where} must be a whole number in [0, ${max}]`);
  return count;
}

interface ChoiceInput<T extends string> {
  readonly where: string;
  readonly choices: readonly T[];
  readonly problems: string[];
}

function readChoice<T extends string>(value: unknown, config: ChoiceInput<T>): T {
  const { where, choices, problems } = config;
  const known = typeof value === 'string' && (choices as readonly string[]).includes(value);
  if (!known) problems.push(`${where} must be one of ${choices.join(', ')}, got ${JSON.stringify(value)}`);
  return (known ? value : choices[0]) as T;
}

function readChoiceList<T extends string>(value: unknown, config: ChoiceInput<T>): T[] {
  const { where, problems } = config;
  const list: T[] = [];
  if (!Array.isArray(value)) problems.push(`${where} must be an array of ${config.choices.join(', ')}`);
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    const choice = readChoice(entry, { ...config, where: `${where}[${index}]` });
    if (list.includes(choice)) problems.push(`${where} names "${choice}" more than once`);
    else list.push(choice);
  }
  return list;
}
