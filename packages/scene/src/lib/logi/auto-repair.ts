/**
 * Logi auto-repair settings: the `autoRepair` field a fleet, wing or squad carries, how a ship's settings resolve from
 * it, and the auto_repair tool's pure half.
 *
 * - `autoRepair: { on?, policy? }` on a fleet, wing or squad. Each key resolves on its own from the nearest group in a
 *   ship's chain that sets it: its squad, its wing (its squad's, or the one it commands), its fleet. Else the default:
 *   on for ships in a logi squad, policy `urgent`.
 * - auto_repair compiles to one update_fleet, update_wing or update_squad with `set: { autoRepair }`, so a timeline beat
 *   can cue the command or the op.
 *
 * The page's AutoRepair (apps/viewer auto-repair.ts) runs the logi: selection.ts picks their targets.
 */

import type { Maybe } from '@dereekb/util';
import type { ModuleCategory } from '../fitting/categories';
import { isPlainObject, type JsonObject, reportUnknownKeys } from '../json';
import { type SceneDocument, SceneError } from '../scene';
import type { SceneFleet } from '../fleets/fleet';
import { describeFleetGroup, type FleetGroup } from '../fleets/group';
import { toFleetMemberships } from '../fleets/membership';
import { readFleetSelection, selectFleetShips } from '../fleets/selection';

/**
 * How a logi orders the members under fire: `urgent` the shortest time to live (incoming damage net of reps over HP
 * left), `damaged` the lowest HP, `shot-at` the most incoming damage.
 */
export const AUTO_REPAIR_POLICIES = ['urgent', 'damaged', 'shot-at'] as const;

export type AutoRepairPolicy = (typeof AUTO_REPAIR_POLICIES)[number];

export const DEFAULT_AUTO_REPAIR_POLICY: AutoRepairPolicy = 'urgent';

/**
 * The module categories auto-repair runs: remote armor repairers, shield transporters and remote hull repairers
 * (groups 325, 2018, 41, 585).
 */
export const REMOTE_REPAIRER_CATEGORIES: readonly ModuleCategory[] = ['remote-armor-repairer', 'remote-shield-booster', 'remote-hull-repairer'];

/**
 * A fleet's, wing's or squad's auto-repair settings; an omitted key inherits from the group above.
 */
export interface SceneAutoRepair {
  /**
   * Its logi repair fleet members under fire on their own. Default: on in logi squads, off elsewhere.
   */
  on?: boolean;
  /**
   * How they pick. Default: `urgent`.
   */
  policy?: AutoRepairPolicy;
}

const AUTO_REPAIR_KEYS = new Set<string>(['on', 'policy']);

export interface ReadSceneAutoRepairContext {
  /**
   * Where the field sits, for messages.
   */
  readonly where: string;
  readonly problems: string[];
  readonly warnings: string[];
}

function isAutoRepairPolicy(value: unknown): value is AutoRepairPolicy {
  return typeof value === 'string' && (AUTO_REPAIR_POLICIES as readonly string[]).includes(value);
}

const POLICY_MESSAGE = `must be one of ${AUTO_REPAIR_POLICIES.join(', ')} (urgent: the shortest time to live; damaged: the lowest HP; shot-at: the most incoming damage)`;

/**
 * Reads a fleet's, wing's or squad's `autoRepair`. Unknown keys warn and are dropped.
 *
 * @param value - The candidate field.
 * @param context - Where it sits and where problems and warnings go.
 * @returns The field, or null when absent, null or empty (normalize omits it).
 */
export function readSceneAutoRepair(value: unknown, context: ReadSceneAutoRepairContext): Maybe<SceneAutoRepair> {
  const { where, problems, warnings } = context;
  let field: Maybe<SceneAutoRepair> = null;
  if (value != null && !isPlainObject(value)) {
    problems.push(`${where} must be an object { on?, policy? }: the group's logi auto-repair`);
  } else if (value != null) {
    reportUnknownKeys(value, AUTO_REPAIR_KEYS, where, warnings);
    const { on, policy } = value;
    const read: SceneAutoRepair = {};
    if (on != null && typeof on !== 'boolean') problems.push(`${where}.on must be true or false`);
    else if (on != null) read.on = on;
    if (policy != null && !isAutoRepairPolicy(policy)) problems.push(`${where}.policy ${POLICY_MESSAGE}`);
    else if (policy != null) read.policy = policy;
    if (Object.keys(read).length) field = read;
  }
  return field;
}

/**
 * Which group a resolved setting came from.
 */
export type AutoRepairSource = 'squad' | 'wing' | 'fleet' | 'default';

/**
 * A ship's auto-repair settings, resolved.
 */
export interface ResolvedAutoRepair {
  readonly on: boolean;
  readonly policy: AutoRepairPolicy;
  /**
   * Where `on` came from.
   */
  readonly source: AutoRepairSource;
  /**
   * Where `policy` came from.
   */
  readonly policySource: AutoRepairSource;
}

/**
 * Every fleet ship's auto-repair settings, key by key from the nearest group in its chain that sets the key: its
 * squad (when it sits in one), its wing (its squad's, or the one it commands), its fleet; else the default (on for a
 * logi squad, policy urgent). The fleet commander follows the same chain.
 *
 * @param scene - The document, or the live fleet view.
 * @returns Each ship holding a position, keyed by id, in fleet order.
 */
export function resolveAutoRepair(scene: Pick<SceneDocument, 'fleets'>): Map<string, ResolvedAutoRepair> {
  const fleets = new Map<string, SceneFleet>((scene.fleets ?? []).map((fleet) => [fleet.id, fleet]));
  const resolved = new Map<string, ResolvedAutoRepair>();
  for (const [id, membership] of toFleetMemberships(scene)) {
    const fleet = fleets.get(membership.fleet);
    const wing = membership.wing == null ? null : fleet?.wings.find((candidate) => candidate.id === membership.wing);
    const squad = membership.squad == null ? null : wing?.squads.find((candidate) => candidate.id === membership.squad);
    const chain: [AutoRepairSource, Maybe<SceneAutoRepair>][] = [
      ['squad', squad?.autoRepair],
      ['wing', wing?.autoRepair],
      ['fleet', fleet?.autoRepair]
    ];
    const onFrom = chain.find(([, field]) => field?.on != null);
    const policyFrom = chain.find(([, field]) => field?.policy != null);
    resolved.set(id, {
      on: onFrom?.[1]?.on ?? membership.role === 'logi',
      policy: policyFrom?.[1]?.policy ?? DEFAULT_AUTO_REPAIR_POLICY,
      source: onFrom?.[0] ?? 'default',
      policySource: policyFrom?.[0] ?? 'default'
    });
  }
  return resolved;
}

/**
 * A group's `autoRepair` as the document writes it.
 *
 * @param scene - The document.
 * @param group - The fleet, wing or squad.
 * @returns A copy of its field; null when it sets none or does not exist.
 */
export function autoRepairOf(scene: Pick<SceneDocument, 'fleets'>, group: FleetGroup): Maybe<SceneAutoRepair> {
  const fleet = scene.fleets?.find((candidate) => candidate.id === group.fleet);
  let field: Maybe<SceneAutoRepair> = fleet?.autoRepair;
  if (group.kind === 'wing') field = fleet?.wings.find((wing) => wing.id === group.id)?.autoRepair;
  else if (group.kind === 'squad') field = fleet?.wings.flatMap((wing) => wing.squads).find((squad) => squad.id === group.id)?.autoRepair;
  return field ? { ...field } : null;
}

/**
 * auto_repair: a fleet's, wing's or squad's auto-repair on or off, and its policy. `null` resets a key (the group then
 * inherits it); an omitted key stays as it is.
 */
export interface AutoRepairCommand {
  readonly fleet: string;
  readonly wing?: string;
  readonly squad?: string;
  readonly on?: boolean | null;
  readonly policy?: AutoRepairPolicy | null;
}

const COMMAND_KEYS = new Set<string>(['fleet', 'wing', 'squad', 'on', 'policy']);

/**
 * Validates an auto_repair command: `fleet`, optionally `wing` or `squad`, and at least one of `on` and `policy`.
 *
 * @param input - The candidate command.
 * @param where - The message prefix.
 * @returns The command.
 * @throws {SceneError} With every problem found.
 */
export function normalizeAutoRepairCommand(input: unknown, where = 'auto_repair'): AutoRepairCommand {
  const problems: string[] = [];
  let command: Maybe<AutoRepairCommand> = null;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { fleet, wing? | squad?, on?, policy? }`);
  } else {
    for (const key of Object.keys(input)) {
      if (key === 'ships') problems.push(`${where}.ships: auto-repair is set per fleet, wing or squad; a ship repairs its fleet as its squad does`);
      else if (!COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not an auto_repair field`);
    }
    const { fleet, wing, squad, on, policy } = input;
    const selection = fleet == null ? null : readFleetSelection({ fleet, wing, squad }, where, problems);
    if (fleet == null) problems.push(`${where}.fleet is required: the fleet whose logi to set (narrow it with wing or squad)`);
    if (on === undefined && policy === undefined) problems.push(`${where} needs on (true, false, or null to inherit) or policy (${AUTO_REPAIR_POLICIES.join(', ')}, or null to inherit)`);
    if (on != null && typeof on !== 'boolean') problems.push(`${where}.on must be true, false or null (inherit from the group above)`);
    if (policy != null && !isAutoRepairPolicy(policy)) problems.push(`${where}.policy ${POLICY_MESSAGE}, or null (inherit from the group above)`);
    if (selection?.fleet) {
      command = {
        fleet: selection.fleet,
        ...(selection.wing ? { wing: selection.wing } : {}),
        ...(selection.squad ? { squad: selection.squad } : {}),
        ...(on !== undefined ? { on: on as boolean | null } : {}),
        ...(policy !== undefined ? { policy: policy as AutoRepairPolicy | null } : {})
      };
    }
  }
  if (problems.length || !command) throw new SceneError(problems);
  return command;
}

/**
 * The group a command sets.
 *
 * @param command - The command.
 * @returns Its squad, else its wing, else the fleet.
 */
export function toAutoRepairGroup(command: Pick<AutoRepairCommand, 'fleet' | 'wing' | 'squad'>): FleetGroup {
  let group: FleetGroup = { fleet: command.fleet, kind: 'fleet', id: command.fleet };
  if (command.squad) group = { fleet: command.fleet, kind: 'squad', id: command.squad };
  else if (command.wing) group = { fleet: command.fleet, kind: 'wing', id: command.wing };
  return group;
}

/**
 * The patch op an auto_repair command compiles to: one update_fleet, update_wing or update_squad with `set: {
 * autoRepair }`, merged into the group's field (a value sets its key, null deletes it, and an emptied field is
 * `null`), or none when nothing changes.
 *
 * @param scene - The document.
 * @param command - The command.
 * @returns The ops, for applySceneOperations.
 * @throws {SceneError} When the fleet, wing or squad does not exist.
 */
export function toAutoRepairOperations(scene: Pick<SceneDocument, 'ships' | 'fleets'>, command: AutoRepairCommand): JsonObject[] {
  const group = toAutoRepairGroup(command);
  const selected = selectFleetShips(scene, { fleet: command.fleet, ...(command.wing ? { wing: command.wing } : {}), ...(command.squad ? { squad: command.squad } : {}) }, 'auto_repair');
  if (selected.problems.length) throw new SceneError(selected.problems);
  const current = autoRepairOf(scene, group) ?? {};
  const next: SceneAutoRepair = { ...current };
  if (command.on === null) delete next.on;
  else if (command.on !== undefined) next.on = command.on;
  if (command.policy === null) delete next.policy;
  else if (command.policy !== undefined) next.policy = command.policy;
  const unchanged = next.on === current.on && next.policy === current.policy;
  return unchanged ? [] : [toAutoRepairOperation(group, Object.keys(next).length ? next : null)];
}

function toAutoRepairOperation(group: FleetGroup, field: Maybe<SceneAutoRepair>): JsonObject {
  const set: JsonObject = { autoRepair: field ? { ...field } : null };
  let operation: JsonObject = { op: 'update_fleet', fleet: group.fleet, set };
  if (group.kind === 'wing') operation = { op: 'update_wing', fleet: group.fleet, wing: group.id, set };
  else if (group.kind === 'squad') operation = { op: 'update_squad', fleet: group.fleet, squad: group.id, set };
  return operation;
}

/**
 * The group as auto_repair's messages name it.
 *
 * @param command - The command.
 * @returns E.g. `squad "logi" of fleet "tfis"`.
 */
export function describeAutoRepairGroup(command: Pick<AutoRepairCommand, 'fleet' | 'wing' | 'squad'>): string {
  return describeFleetGroup(toAutoRepairGroup(command));
}
