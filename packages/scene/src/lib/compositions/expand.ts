import type { Maybe } from '@dereekb/util';
import { DEFAULT_FORMATION_RADIUS, layoutFleetFormation, type SceneFleet, type SceneSquad, type SceneSquadAnchor } from '../fleets';
import type { SceneShip, SceneVector } from '../scene';
import { COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD, type CompositionShip, type CompositionSquad, type FleetComposition } from './composition';
import { PROP_MOD_MODULE_NONE, type PropModModule, readPropModModule } from '../stats/prop-mods';
import { readEftHeader, readEftPropMod } from './eft';

/**
 * The longest ship id a scene accepts.
 */
const MAX_SHIP_ID_LENGTH = 64;

/**
 * The last numbered fleet id tried (`<id>-2` ... `<id>-999`) when the composition's id is taken.
 */
const MAX_FLEET_ID_SUFFIX = 999;

/**
 * How many overlapping ships an overlap warning names.
 */
const OVERLAP_EXAMPLES = 3;

export interface ExpandFleetCompositionExisting {
  /**
   * The scene's ship ids and positions.
   */
  readonly ships: ReadonlyMap<string, SceneVector>;
  /**
   * The scene's fleet ids.
   */
  readonly fleets: ReadonlySet<string>;
}

export interface ExpandFleetCompositionInput {
  /**
   * A normalized composition.
   */
  readonly composition: FleetComposition;
  /**
   * The FC's position.
   */
  readonly position: SceneVector;
  /**
   * The fleet's heading, yaw degrees: 0 faces +Z, 90 faces +X.
   */
  readonly heading: number;
  /**
   * The fleet id to use. Default: the composition's id, numbered when taken.
   */
  readonly fleet?: Maybe<string>;
  /**
   * The team every added ship is on.
   */
  readonly team?: Maybe<string>;
  /**
   * What the scene already holds.
   */
  readonly existing: ExpandFleetCompositionExisting;
  /**
   * The message prefix. Default "composition".
   */
  readonly where?: string;
}

export interface ExpandedFleetComposition {
  /**
   * The scene fleet, or null on a problem.
   */
  readonly fleet: Maybe<SceneFleet>;
  /**
   * The new ships: the FC first, then wings, squads, lines and count in order. Empty on a problem.
   */
  readonly ships: SceneShip[];
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * One ship to add: its id, the composition ship it comes from, and where that sits.
 */
interface ShipSlot {
  readonly id: string;
  readonly ship: CompositionShip;
  readonly where: string;
  /**
   * The ship's 1-based number within its line, or null when the line adds one ship (and for the FC).
   */
  readonly number: Maybe<number>;
}

interface SquadSlots {
  readonly squad: CompositionSquad;
  readonly slots: ShipSlot[];
}

interface FleetSlots {
  readonly commander: ShipSlot;
  readonly wings: { readonly squads: SquadSlots[] }[];
  readonly all: ShipSlot[];
}

/**
 * Expands a composition into scene ships in formation (layoutFleetFormation) and one scene fleet, with ids that are
 * free in the scene: fleet `<id>` (or `<id>-2`, `<id>-3`, ...), ships `<fleet>-fc` and `<fleet>-<squad>-<nn>`. Every
 * ship faces the heading. Pure: it looks nothing up, so every ship needs its `dna` (the add_fleet_composition tool
 * fills it from the EVE data first); a ship without a `radius` is spaced as DEFAULT_FORMATION_RADIUS.
 *
 * @param input - The composition, the FC's position and heading, and what the scene already holds.
 * @returns The fleet and ships, or the problems; warnings name missing radii and ships landing on existing ones.
 */
export function expandFleetComposition(input: ExpandFleetCompositionInput): ExpandedFleetComposition {
  const { composition, position, heading, team, existing, where = 'composition' } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const fleetId = chooseFleetId(input, problems);
  const slots = fleetId ? toSlots(composition, fleetId) : null;

  for (const slot of slots?.all ?? []) {
    if (slot.id.length > MAX_SHIP_ID_LENGTH) problems.push(`${where}.${slot.where}: ship id "${slot.id}" is longer than ${MAX_SHIP_ID_LENGTH} characters; use a shorter fleet or squad id`);
  }
  const reported = new Set<string>();
  for (const slot of slots?.all ?? []) {
    if (slot.ship.dna || reported.has(slot.where)) continue;
    reported.add(slot.where);
    problems.push(`${where}.${slot.where}: hull "${hullLabel(slot.ship, composition)}" has no dna. The add_fleet_composition tool resolves hull names to DNA through tools-core; patch_scene needs every ship line's dna.`);
  }
  if (!slots || !fleetId || problems.length) return { fleet: null, ships: [], problems, warnings };

  const fleet = toSceneFleet({ composition, fleetId, slots });
  const radii = new Map(slots.all.map((slot) => [slot.id, slot.ship.radius ?? DEFAULT_FORMATION_RADIUS]));
  const positions = layoutFleetFormation({ fleet, origin: position, heading, radiusOf: (ship) => radii.get(ship) ?? DEFAULT_FORMATION_RADIUS });
  const ships = slots.all.map((slot): SceneShip => {
    const type = slot.ship.hull ?? fitHull(slot.ship, composition);
    return {
      id: slot.id,
      dna: slot.ship.dna ?? '',
      name: shipName(slot, composition),
      ...(team ? { team } : {}),
      position: positions.get(slot.id) ?? [...position],
      rotation: [heading, 0, 0],
      ...(type == null ? {} : { type }),
      ...shipPropMod(slot.ship, composition)
    };
  });

  const unsized = [...new Set(slots.all.filter((slot) => slot.ship.radius == null).map((slot) => hullLabel(slot.ship, composition)))];
  if (unsized.length) {
    warnings.push(`fleet "${fleetId}": no radius for ${unsized.join(', ')}; their spacing assumes ${DEFAULT_FORMATION_RADIUS} m. Give each ship line a radius, or add the fleet with the add_fleet_composition tool, which reads it from the EVE data.`);
  }
  warnOverlaps({ fleetId, ships, radii, existing, warnings });
  return { fleet, ships, problems, warnings };
}

/**
 * The fleet id: the explicit one when it and its ship ids are free, else the composition's id, numbered until the
 * fleet id and every ship id are free.
 *
 * @param input - The expansion input.
 * @param problems - Receives the problem when no id is free.
 * @returns The fleet id, or null.
 */
function chooseFleetId(input: ExpandFleetCompositionInput, problems: string[]): Maybe<string> {
  const { composition, fleet, existing, where = 'composition' } = input;
  const taken = (id: string): Maybe<string> => toSlots(composition, id).all.find((slot) => existing.ships.has(slot.id))?.id ?? null;
  let chosen: Maybe<string> = null;
  if (fleet) {
    const ship = taken(fleet);
    if (existing.fleets.has(fleet)) problems.push(`${where}: fleet "${fleet}" already exists in the scene; give another fleet id or omit it`);
    else if (ship) problems.push(`${where}: ship "${ship}" already exists in the scene; give another fleet id or omit it`);
    else chosen = fleet;
  } else {
    for (let suffix = 1; suffix <= MAX_FLEET_ID_SUFFIX && !chosen; suffix += 1) {
      const id = suffix === 1 ? composition.id : `${composition.id}-${suffix}`;
      if (!existing.fleets.has(id) && !taken(id)) chosen = id;
    }
    if (!chosen) problems.push(`${where}: fleets "${composition.id}" to "${composition.id}-${MAX_FLEET_ID_SUFFIX}" are all taken; give a fleet id`);
  }
  return chosen;
}

function toSlots(composition: FleetComposition, fleetId: string): FleetSlots {
  const commander: ShipSlot = { id: `${fleetId}-fc`, ship: composition.commander, where: 'commander', number: null };
  const all: ShipSlot[] = [commander];
  const wings = composition.wings.map((wing, wingIndex) => ({
    squads: wing.squads.map((squad, squadIndex): SquadSlots => {
      const size = squad.ships.reduce((total, line) => total + (line.count ?? 1), 0);
      const digits = Math.max(2, String(size).length);
      const slots: ShipSlot[] = [];
      for (const [lineIndex, line] of squad.ships.entries()) {
        const count = line.count ?? 1;
        for (let number = 1; number <= count; number += 1) {
          const id = `${fleetId}-${squad.id}-${String(slots.length + 1).padStart(digits, '0')}`;
          slots.push({ id, ship: line, where: `wings[${wingIndex}].squads[${squadIndex}].ships[${lineIndex}]`, number: count > 1 ? number : null });
        }
      }
      all.push(...slots);
      return { squad, slots };
    })
  }));
  return { commander, wings, all };
}

function toSceneFleet(input: { readonly composition: FleetComposition; readonly fleetId: string; readonly slots: FleetSlots }): SceneFleet {
  const { composition, fleetId, slots } = input;
  const leads = new Map<string, string>();
  for (const wing of slots.wings) for (const { squad, slots: members } of wing.squads) if (members.length) leads.set(squad.id, members[0].id);

  return {
    id: fleetId,
    ...(composition.name ? { name: composition.name } : {}),
    commander: slots.commander.id,
    wings: composition.wings.map((wing, wingIndex) => ({
      id: wing.id,
      ...(wing.name ? { name: wing.name } : {}),
      squads: slots.wings[wingIndex].squads.map(({ squad, slots: members }): SceneSquad => {
        const anchor = members.length ? toSceneAnchor(squad, leads) : null;
        return { id: squad.id, ...(squad.name ? { name: squad.name } : {}), role: squad.role, members: members.map((slot) => slot.id), ...(anchor ? { anchor } : {}) };
      })
    }))
  };
}

/**
 * The scene anchor a composition squad's anchor maps to; see the README's Fleet compositions anchors.
 *
 * @param squad - A squad with ships.
 * @param leads - Each squad's first ship id.
 * @returns The scene anchor, or null when the defaults say it all (on the FC at the role's range).
 */
export function toSceneAnchor(squad: CompositionSquad, leads: ReadonlyMap<string, string>): Maybe<SceneSquadAnchor> {
  const on = squad.anchor?.on ?? (squad.role === 'logi' ? COMPOSITION_ANCHOR_LEAD : COMPOSITION_ANCHOR_FC);
  const range = squad.anchor?.range;
  const ship = on === COMPOSITION_ANCHOR_FC ? undefined : leads.get(on === COMPOSITION_ANCHOR_LEAD ? squad.id : on);
  const anchor: SceneSquadAnchor = { ...(ship ? { ship } : {}), ...(range == null ? {} : { range }) };
  return Object.keys(anchor).length ? anchor : null;
}

/**
 * A line ship's prop mod: the line's `propMod` as written; else its fit's module, or "none" when the fit has none;
 * else nothing (the hull-sized default).
 *
 * @param ship - The composition ship.
 * @param composition - The composition, for its fits.
 * @returns The scene ship's `propMod` key, or nothing.
 */
function shipPropMod(ship: CompositionShip, composition: FleetComposition): Pick<SceneShip, 'propMod'> {
  const fit = ship.fit ? composition.fits?.[ship.fit] : undefined;
  let module: Maybe<PropModModule> = null;
  if (ship.propMod != null) module = readPropModModule(ship.propMod, 'propMod', []);
  else if (fit != null) module = readEftPropMod(fit) ?? PROP_MOD_MODULE_NONE;
  return module == null ? {} : { propMod: { module } };
}

function fitHull(ship: CompositionShip, composition: FleetComposition): Maybe<string> {
  const fit = ship.fit ? composition.fits?.[ship.fit] : undefined;
  return fit ? (readEftHeader(fit)?.hull ?? null) : null;
}

function hullLabel(ship: CompositionShip, composition: FleetComposition): string {
  let label = typeof ship.hull === 'string' ? ship.hull : fitHull(ship, composition);
  if (label == null && typeof ship.hull === 'number') label = `type ${ship.hull}`;
  return label ?? ship.dna?.split(':')[0] ?? 'ship';
}

function shipName(slot: ShipSlot, composition: FleetComposition): string {
  let name: string;
  if (slot.ship === composition.commander) name = composition.commander.name ?? 'FC';
  else name = slot.ship.name ?? hullLabel(slot.ship, composition);
  return slot.number == null ? name : `${name} ${slot.number}`;
}

interface OverlapInput {
  readonly fleetId: string;
  readonly ships: readonly SceneShip[];
  readonly radii: ReadonlyMap<string, number>;
  readonly existing: ExpandFleetCompositionExisting;
  readonly warnings: string[];
}

function warnOverlaps(input: OverlapInput): void {
  const { fleetId, ships, radii, existing, warnings } = input;
  const overlaps: string[] = [];
  for (const ship of ships) {
    const reach = (radii.get(ship.id) ?? DEFAULT_FORMATION_RADIUS) + DEFAULT_FORMATION_RADIUS;
    for (const [other, at] of existing.ships) {
      if (Math.hypot(ship.position[0] - at[0], ship.position[1] - at[1], ship.position[2] - at[2]) < reach) {
        overlaps.push(`${ship.id} near "${other}"`);
        break;
      }
    }
  }
  if (overlaps.length) {
    const examples = overlaps.slice(0, OVERLAP_EXAMPLES).join(', ') + (overlaps.length > OVERLAP_EXAMPLES ? ', ...' : '');
    const count = overlaps.length === 1 ? '1 ship lands' : `${overlaps.length} ships land`;
    warnings.push(`fleet "${fleetId}": ${count} within ${DEFAULT_FORMATION_RADIUS} m of ships already in the scene (${examples}); add the fleet at another position`);
  }
}
