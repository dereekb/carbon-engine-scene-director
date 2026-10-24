/**
 * Damage immunity: a ship's `immune` (every layer, or chosen layers) makes it ignore incoming damage there. A rule of
 * the scene saved in the document, like combat.death; HP, kills and locks stay live. The rule itself is
 * applyLayeredDamage's (combat/damage.ts): an immune layer that has HP keeps it and stops the hit, an empty one stops
 * nothing. Immune ships are still locked and fired at; the page's DamageModel enforces it for every damage source.
 */

import type { Maybe } from '@dereekb/util';
import { DEFENSE_LAYERS, type DefenseLayerName } from '../fitting/defense';
import type { FleetOperationContext } from '../fleets/operations';
import { isPlainObject, type JsonObject } from '../json';
import { SceneError } from '../scene';
import { selectShips } from '../selectors/select';
import { readShipSelector, SHIP_SELECTOR_KEYS, SHIP_SELECTOR_SHAPE, type ShipSelector } from '../selectors/selector';

/**
 * A ship's immunity: `true` for every layer, or its immune layers in layer order (never all three: that is `true`).
 */
export type ShipImmunity = true | DefenseLayerName[];

/**
 * What a command sets: an immunity, or `false` to lift it.
 */
export type ImmunityValue = ShipImmunity | false;

export interface NormalizeShipImmunityInput {
  readonly input: unknown;
  readonly where: string;
}

export interface NormalizedShipImmunity {
  /**
   * The immunity; null when the ship is not immune.
   */
  readonly immune: Maybe<ShipImmunity>;
  readonly problems: string[];
}

/**
 * Reads a ship's `immune`: `true`, or a list of layers (case-insensitive, deduplicated, put in layer order; all three
 * is `true`). `false`, null and `[]` mean not immune. `"hull"` is refused with a hint (the hull layer is structure).
 *
 * @param input - The value and where it sits.
 * @returns The immunity and every problem found.
 */
export function normalizeShipImmunity(input: NormalizeShipImmunityInput): NormalizedShipImmunity {
  const { input: value, where } = input;
  const problems: string[] = [];
  let immune: Maybe<ShipImmunity> = null;
  const shape = `${where} must be true, false, or a list of layers (${DEFENSE_LAYERS.join(', ')})`;
  if (value === true) immune = true;
  else if (Array.isArray(value)) {
    const layers = new Set<DefenseLayerName>();
    let malformed = false;
    for (const entry of value) {
      const text = typeof entry === 'string' ? entry.trim().toLowerCase() : null;
      if (text === 'hull') problems.push(`${where}: "hull" is not a layer (the hull layer is structure)`);
      else if (text != null && (DEFENSE_LAYERS as readonly string[]).includes(text)) layers.add(text as DefenseLayerName);
      else malformed = true;
    }
    if (malformed) problems.push(shape);
    const ordered = DEFENSE_LAYERS.filter((layer) => layers.has(layer));
    if (!problems.length && ordered.length) immune = ordered.length === DEFENSE_LAYERS.length ? true : ordered;
  } else if (value != null && value !== false) problems.push(shape);
  return { immune, problems };
}

/**
 * A ship's immune layers.
 *
 * @param ship - The ship (its `immune`).
 * @returns Every layer for `true`, its list, or none.
 */
export function immuneLayersOf(ship: { readonly immune?: Maybe<ImmunityValue> }): readonly DefenseLayerName[] {
  const { immune } = ship;
  let layers: readonly DefenseLayerName[] = [];
  if (immune === true) layers = DEFENSE_LAYERS;
  else if (Array.isArray(immune)) layers = immune;
  return layers;
}

/**
 * The scene's immune ships and their layers: what the page's damage model indexes on every apply.
 *
 * @param scene - The document.
 * @returns Ship id → immune layers, for immune ships only.
 */
export function toSceneImmunity(scene: { readonly ships: readonly { readonly id: string; readonly immune?: Maybe<ShipImmunity> }[] }): Map<string, readonly DefenseLayerName[]> {
  const index = new Map<string, readonly DefenseLayerName[]>();
  for (const ship of scene.ships) {
    const layers = immuneLayersOf(ship);
    if (layers.length) index.set(ship.id, layers);
  }
  return index;
}

/**
 * Whether two immunities cover the same layers (`false`, null and absent are the same: none).
 *
 * @param a - One immunity.
 * @param b - The other.
 * @returns True when they match.
 */
export function sameImmunity(a: Maybe<ImmunityValue>, b: Maybe<ImmunityValue>): boolean {
  const left = immuneLayersOf({ immune: a });
  const right = immuneLayersOf({ immune: b });
  return left.length === right.length && left.every((layer) => right.includes(layer));
}

/**
 * The patch operations that edit immunity.
 */
export const IMMUNITY_OPERATIONS: ReadonlySet<string> = new Set(['set_immunity']);

const SET_IMMUNITY_KEYS = new Set<string>(['op', 'immune', ...SHIP_SELECTOR_KEYS]);

/**
 * What the op says when its selector filters by hull or state, which only the page knows.
 */
export const IMMUNITY_LIVE_HINT = 'use the set_immunity tool, which resolves them in the viewer';

/**
 * Applies `{ op: "set_immunity", <selector without hull or state>, immune: true | false | [layers] }`: replaces each
 * selected ship's `immune` (`false` deletes it). Runs mid-patch, so it composes after an op that adds the ships.
 * Unknown keys warn.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyImmunityOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  const before = problems.length;
  for (const key of Object.keys(operation)) if (!SET_IMMUNITY_KEYS.has(key)) warnings.push(`${where}.${key} is not a set_immunity field and was ignored`);
  const selector = readShipSelector(operation, where, problems);
  const immune = readImmunityValue(operation, where, problems);
  if (problems.length > before) return;

  const selected = selectShips(draft, selector, { where, liveHint: IMMUNITY_LIVE_HINT });
  problems.push(...selected.problems);
  warnings.push(...selected.warnings);
  if (selected.problems.length) return;
  const ships = new Map((Array.isArray(draft['ships']) ? draft['ships'] : []).filter(isPlainObject).map((ship) => [ship['id'], ship]));
  for (const id of selected.ships) {
    const ship = ships.get(id) as JsonObject;
    if (immune === false) delete ship['immune'];
    else ship['immune'] = immune === true ? true : [...immune];
  }
}

/**
 * A set_immunity command: a selector and the immunity to set.
 */
export interface ImmunityCommand extends ShipSelector {
  readonly immune: ImmunityValue;
}

const IMMUNITY_COMMAND_KEYS = new Set<string>(['immune', ...SHIP_SELECTOR_KEYS]);

/**
 * Validates a set_immunity command: a selector (sd-selectors) and `immune` (true, false or a list of layers;
 * required). Unknown keys are problems.
 *
 * @param input - The candidate command.
 * @param where - Where it sits, for messages.
 * @returns The command, a plain object a timeline cue can embed.
 * @throws {SceneError} With every problem found.
 */
export function normalizeImmunityCommand(input: unknown, where = 'set_immunity'): ImmunityCommand {
  const problems: string[] = [];
  let result: ImmunityCommand = { immune: false };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ${SHIP_SELECTOR_SHAPE}, immune }`);
  } else {
    for (const key of Object.keys(input)) if (!IMMUNITY_COMMAND_KEYS.has(key)) problems.push(`${where}.${key} is not a set_immunity field`);
    const selector = readShipSelector(input, where, problems);
    const immune = readImmunityValue(input, where, problems);
    result = { ...selector, immune };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}

/**
 * The warning a lever gives when its target is immune: what the shots will do to it.
 *
 * @param id - The target ship.
 * @param layers - Its immune layers.
 * @returns The warning, or null when it is not immune.
 */
export function immunityWarning(id: string, layers: readonly DefenseLayerName[]): Maybe<string> {
  const immune = DEFENSE_LAYERS.filter((layer) => layers.includes(layer));
  const mortal = DEFENSE_LAYERS.filter((layer) => !immune.includes(layer));
  let warning: Maybe<string> = null;
  if (!immune.length) warning = null;
  else if (!mortal.length) warning = `"${id}" is immune to damage: the guns lock, fire and hit, but it takes none`;
  else if (immune.includes('structure')) {
    const drops = mortal.length === 1 ? `only its ${mortal[0]} drops` : `its ${andList(mortal)} still drop`;
    warning = `"${id}" cannot be destroyed: its ${andList(immune)} ${immune.length === 1 ? 'is' : 'are'} immune (${drops})`;
  } else warning = `"${id}" is immune on its ${andList(immune)}: hits stop there while ${immune.length === 1 ? 'it has' : 'they have'} HP`;
  return warning;
}

function readImmunityValue(record: JsonObject, where: string, problems: string[]): ImmunityValue {
  let immune: ImmunityValue = false;
  if (!('immune' in record) || record['immune'] === undefined) problems.push(`${where} needs immune (true, false, or a list of layers: ${DEFENSE_LAYERS.join(', ')})`);
  else {
    const read = normalizeShipImmunity({ input: record['immune'], where: `${where}.immune` });
    problems.push(...read.problems);
    immune = read.immune ?? false;
  }
  return immune;
}

function andList(values: readonly string[]): string {
  return values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}
