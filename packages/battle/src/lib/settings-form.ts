import type { Maybe } from '@dereekb/util';
import { type AutoRepairPolicy } from '@scene-director/scene';
import { SCENARIO_RETREAT_AWAY, compactObject, type ScenarioFleetSettings, type ScenarioLogiFormation, type ScenarioPersonalityTemplate, type ScenarioRetreat } from './scenario/scenario';

/**
 * The doctrine base a fleet's settings extend when they name none (the scenario's default too).
 */
export const DEFAULT_FLEET_DOCTRINE = 'line';

/**
 * How the fleet fires: the FC's calls only (focus), free fire only, or both.
 */
export const FLEET_SETTINGS_FIRE_MODES = ['focus', 'free', 'focus-free'] as const;

export type FleetSettingsFireMode = (typeof FLEET_SETTINGS_FIRE_MODES)[number];

/**
 * A range choice in the form: a named reach, or `metres` (the number beside it).
 */
export type FleetSettingsReachChoice = 'lock' | 'optimal' | 'falloff' | 'metres';

/**
 * The FC settings dialog's flat value. Every field is optional: blank inherits the doctrine base. Ranges are metres;
 * the priority is the roles in order, comma separated; the retreat is `away`, a place name or `x, y, z` metres.
 */
export interface FleetSettingsFormValue {
  readonly doctrine?: string;
  readonly stance?: string;
  readonly range?: FleetSettingsReachChoice;
  readonly rangeMetres?: number;
  readonly propMods?: string;
  readonly engage?: string;
  readonly fire?: FleetSettingsFireMode;
  readonly priority?: string;
  readonly prefer?: string;
  readonly reach?: FleetSettingsReachChoice;
  readonly reachMetres?: number;
  readonly queue?: number;
  readonly switch?: string;
  readonly logiFormation?: ScenarioLogiFormation;
  readonly autoRepair?: boolean;
  readonly autoRepairPolicy?: AutoRepairPolicy;
  readonly retreat?: string;
  readonly ability?: number;
  readonly backups?: number;
  readonly handover?: number;
  readonly reaction?: number;
}

/**
 * The form value for a fleet's settings: the doctrine's base and its overrides, the logi settings and the retreat.
 *
 * @param settings - The fleet's settings (the console scenario's side, or none).
 * @returns The form's value.
 */
export function toFleetSettingsFormValue(settings: ScenarioFleetSettings = {}): FleetSettingsFormValue {
  const personality = settings.personality;
  const template: ScenarioPersonalityTemplate = typeof personality === 'string' ? { extends: personality } : (personality ?? {});
  const movement = template.movement ?? {};
  const targeting = template.targeting ?? {};
  const command = template.command ?? {};
  const range = toReachChoice(movement['range']);
  const reach = toReachChoice(targeting['reach']);
  const retreat = settings.retreat;

  return compactObject<FleetSettingsFormValue>({
    doctrine: template.extends ?? DEFAULT_FLEET_DOCTRINE,
    stance: movement['stance'],
    range: range.choice,
    rangeMetres: range.metres,
    propMods: movement['propMods'],
    engage: template.engage,
    fire: toFireMode(targeting['calls'], targeting['freeFire']),
    priority: Array.isArray(targeting['priority']) ? targeting['priority'].join(', ') : undefined,
    prefer: targeting['prefer'],
    reach: reach.choice,
    reachMetres: reach.metres,
    queue: targeting['queue'],
    switch: targeting['switch'],
    logiFormation: settings.logi?.formation,
    autoRepair: settings.logi?.autoRepair?.on,
    autoRepairPolicy: settings.logi?.autoRepair?.policy,
    retreat: typeof retreat === 'string' ? retreat : retreat ? retreat.join(', ') : undefined,
    ability: typeof command['ability'] === 'number' ? command['ability'] : undefined,
    backups: command['backups'],
    handover: command['handover'],
    reaction: typeof template.pilots?.['reaction'] === 'number' ? template.pilots['reaction'] : undefined
  });
}

/**
 * The fleet settings a form value makes: the doctrine as a template extending the base with only the fields set, the
 * logi settings and the retreat. Feed it to toFleetSettingsOperations and mergeScenarioSettings.
 *
 * @param value - The form's value.
 * @returns The settings.
 */
export function fromFleetSettingsFormValue(value: FleetSettingsFormValue): ScenarioFleetSettings {
  const movement = compactObject<Record<string, unknown>>({ stance: blankToUndefined(value.stance), range: fromReachChoice(value.range, value.rangeMetres), propMods: blankToUndefined(value.propMods) });
  const fire = value.fire ? { calls: value.fire !== 'free', freeFire: value.fire !== 'focus' } : {};
  const priority = value.priority
    ?.split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  const targeting = compactObject<Record<string, unknown>>({ ...fire, priority: priority?.length ? priority : undefined, prefer: blankToUndefined(value.prefer), reach: fromReachChoice(value.reach, value.reachMetres), queue: value.queue, switch: blankToUndefined(value.switch) });
  const command = compactObject<Record<string, unknown>>({ ability: value.ability, backups: value.backups, handover: value.handover });
  const pilots = compactObject<Record<string, unknown>>({ reaction: value.reaction });
  const personality = compactObject<ScenarioPersonalityTemplate>({
    extends: blankToUndefined(value.doctrine) ?? DEFAULT_FLEET_DOCTRINE,
    engage: blankToUndefined(value.engage),
    movement: nonEmpty(movement),
    targeting: nonEmpty(targeting),
    command: nonEmpty(command),
    pilots: nonEmpty(pilots)
  });
  const autoRepair = value.autoRepair != null || value.autoRepairPolicy ? compactObject<{ on?: boolean; policy?: AutoRepairPolicy }>({ on: value.autoRepair, policy: value.autoRepairPolicy }) : undefined;
  const logi = compactObject<Record<string, unknown>>({ formation: blankToUndefined(value.logiFormation), autoRepair });

  return compactObject<ScenarioFleetSettings>({ personality, logi: nonEmpty(logi), retreat: toRetreat(value.retreat) });
}

/**
 * Reads the form's retreat: `away`, `x, y, z` metres, or a place name; blank is none.
 *
 * @param text - The retreat field.
 * @returns The retreat, or null when blank.
 */
export function toRetreat(text: Maybe<string>): Maybe<ScenarioRetreat> {
  const trimmed = text?.trim();
  let result: Maybe<ScenarioRetreat>;

  if (trimmed) {
    const parts = trimmed.split(',').map((part) => Number(part.trim()));
    result = trimmed === SCENARIO_RETREAT_AWAY ? SCENARIO_RETREAT_AWAY : parts.length === 3 && parts.every((part) => Number.isFinite(part)) ? [parts[0], parts[1], parts[2]] : trimmed;
  }

  return result;
}

function toReachChoice(reach: unknown): { choice?: FleetSettingsReachChoice; metres?: number } {
  return typeof reach === 'number' ? { choice: 'metres', metres: reach } : reach === 'lock' || reach === 'optimal' || reach === 'falloff' ? { choice: reach } : {};
}

function fromReachChoice(choice: Maybe<string>, metres: Maybe<number>): Maybe<string | number> {
  return choice === 'metres' ? (metres != null && metres > 0 ? metres : undefined) : blankToUndefined(choice);
}

function toFireMode(calls: unknown, freeFire: unknown): Maybe<FleetSettingsFireMode> {
  let result: Maybe<FleetSettingsFireMode>;

  if (calls === false && freeFire === true) {
    result = 'free';
  } else if (freeFire === true) {
    result = 'focus-free';
  } else if (calls === true || freeFire === false) {
    result = 'focus';
  }

  return result;
}

function blankToUndefined<T extends string>(value: Maybe<T | ''>): Maybe<T> {
  return value ? value : undefined;
}

function nonEmpty<T extends object>(object: T): Maybe<T> {
  return Object.keys(object).length > 0 ? object : undefined;
}
