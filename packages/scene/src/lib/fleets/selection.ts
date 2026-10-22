/**
 * Selecting ships by id or by their place in a fleet: the whole fleet, one wing, or one squad. Prop mod switches
 * use it now; fleet commands and fleet targeting will select the same way.
 */

import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';

/**
 * Exactly one of `ships` and `fleet`; `wing` or `squad` narrow a fleet.
 */
export interface FleetSelection {
  /**
   * Ship ids.
   */
  readonly ships?: readonly string[];
  readonly fleet?: string;
  /**
   * A wing of the fleet: its commander and every member of its squads.
   */
  readonly wing?: string;
  /**
   * A squad of the fleet: its members.
   */
  readonly squad?: string;
}

/**
 * The keys a selection takes.
 */
export const FLEET_SELECTION_KEYS: readonly (keyof FleetSelection)[] = ['ships', 'fleet', 'wing', 'squad'];

/**
 * Reads a selection off a command or an operation: exactly one of `ships` (a non-empty array of ids) and `fleet`;
 * `wing` and `squad` need `fleet` and exclude each other.
 *
 * @param record - The command or operation.
 * @param where - Where it sits, for messages.
 * @param problems - Receives every problem found.
 * @returns The selection as given (empty when invalid).
 */
export function readFleetSelection(record: JsonObject, where: string, problems: string[]): FleetSelection {
  const { ships, fleet, wing, squad } = record;
  const selection: { ships?: string[]; fleet?: string; wing?: string; squad?: string } = {};
  const before = problems.length;
  if ((ships == null) === (fleet == null)) problems.push(`${where} needs exactly one of ships (ship ids) and fleet (a fleet id, optionally with wing or squad)`);
  if (ships != null) {
    if (Array.isArray(ships) && ships.length > 0 && ships.every((id) => typeof id === 'string' && ID_PATTERN.test(id))) selection.ships = [...(ships as string[])];
    else problems.push(`${where}.ships must be a non-empty array of ship ids`);
  }
  for (const [key, value] of [
    ['fleet', fleet],
    ['wing', wing],
    ['squad', squad]
  ] as const) {
    if (value == null) continue;
    if (typeof value === 'string' && ID_PATTERN.test(value)) selection[key] = value;
    else problems.push(`${where}.${key} must be an id (1-64 letters, digits, "_", "-" or ".")`);
  }
  if ((wing != null || squad != null) && fleet == null) problems.push(`${where}: wing and squad select within a fleet; give fleet too`);
  if (wing != null && squad != null) problems.push(`${where}: give wing or squad, not both`);
  return problems.length > before ? {} : selection;
}

export interface SelectedFleetShips {
  /**
   * The selected ship ids, deduplicated, in the document's ships[] order.
   */
  readonly ships: string[];
  readonly problems: string[];
}

/**
 * The ships a selection picks. Tolerant of a document mid-patch: entries that are not objects are skipped.
 *
 * - `ships`: those ids.
 * - `fleet`: every ship holding a position in it (the FC, the wing commanders, the squad members).
 * - `fleet` + `wing`: the wing's commander and every member of its squads.
 * - `fleet` + `squad`: the squad's members.
 *
 * An unknown ship, fleet, wing or squad is a problem; an empty squad selects nothing without one.
 *
 * @param scene - The document (or a draft of it).
 * @param selection - What to select.
 * @param where - Where the selection sits, for messages.
 * @returns The ships and every problem found.
 */
export function selectFleetShips(scene: { readonly ships?: unknown; readonly fleets?: unknown }, selection: FleetSelection, where = 'selection'): SelectedFleetShips {
  const problems: string[] = [];
  const order = objectsOf(scene.ships)
    .map((ship) => ship['id'])
    .filter((id): id is string => typeof id === 'string');
  const known = new Set(order);
  const picked = new Set<string>();

  if (selection.ships) {
    for (const id of selection.ships) {
      if (known.has(id)) picked.add(id);
      else problems.push(`${where}: no ship "${id}"`);
    }
  } else if (selection.fleet != null) {
    const fleet = objectsOf(scene.fleets).find((candidate) => candidate['id'] === selection.fleet);
    if (!fleet) problems.push(`${where}: no fleet "${selection.fleet}"`);
    else pickInFleet({ fleet, selection, picked, problems, where });
  }

  return { ships: order.filter((id) => picked.has(id)), problems };
}

interface PickInFleetInput {
  readonly fleet: JsonObject;
  readonly selection: FleetSelection;
  readonly picked: Set<string>;
  readonly problems: string[];
  readonly where: string;
}

function pickInFleet(input: PickInFleetInput): void {
  const { fleet, selection, picked, problems, where } = input;
  const wings = objectsOf(fleet['wings']);
  const add = (id: unknown): void => {
    if (typeof id === 'string') picked.add(id);
  };
  const addSquad = (squad: JsonObject): void => {
    const members = squad['members'];
    if (Array.isArray(members)) for (const member of members) add(member);
  };

  if (selection.wing != null) {
    const wing = wings.find((candidate) => candidate['id'] === selection.wing);
    if (!wing) problems.push(`${where}: no wing "${selection.wing}" in fleet "${selection.fleet}"`);
    else {
      add(wing['commander']);
      for (const squad of objectsOf(wing['squads'])) addSquad(squad);
    }
  } else if (selection.squad != null) {
    const squad = wings.flatMap((wing) => objectsOf(wing['squads'])).find((candidate) => candidate['id'] === selection.squad);
    if (!squad) problems.push(`${where}: no squad "${selection.squad}" in fleet "${selection.fleet}"`);
    else addSquad(squad);
  } else {
    add(fleet['commander']);
    for (const wing of wings) {
      add(wing['commander']);
      for (const squad of objectsOf(wing['squads'])) addSquad(squad);
    }
  }
}

function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}
