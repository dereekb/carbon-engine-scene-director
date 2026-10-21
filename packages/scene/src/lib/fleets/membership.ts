import type { Maybe } from '@dereekb/util';
import type { SceneDocument } from '../scene';
import { DEFAULT_ANCHOR_RANGES, DEFAULT_ANCHOR_UP_RANGE, FLEET_COMMANDS, type FleetCommand, type SceneFleet, type SceneSquad, type SceneWing, type SquadRole } from './fleet';

/**
 * A resolved anchor: the ship kept at range, and the range in metres, surface to surface.
 */
export interface FleetAnchor {
  readonly ship: string;
  readonly range: number;
}

/**
 * Where a ship sits in its fleet and what it keeps range on. These are the anchor rules, resolved in one place:
 * Follow the FC flies exactly these anchors rather than re-deriving them.
 */
export interface ShipFleetMembership {
  readonly fleet: string;
  /**
   * The ship's wing; null for a fleet commander in no squad and commanding no wing.
   */
  readonly wing: Maybe<string>;
  /**
   * The ship's squad; null for a fleet or wing commander in no squad.
   */
  readonly squad: Maybe<string>;
  /**
   * The squad's role; null outside squads.
   */
  readonly role: Maybe<SquadRole>;
  /**
   * The commands the ship holds, in the order fleet, wing, squad; empty when none.
   */
  readonly commands: FleetCommand[];
  /**
   * What this ship keeps range on; null for the fleet commander, which follows nobody.
   */
  readonly anchor: Maybe<FleetAnchor>;
}

export interface SquadReport extends Omit<SceneSquad, 'anchor'> {
  /**
   * The squad's anchor with its defaults filled in.
   */
  readonly anchor: FleetAnchor;
}

export interface WingReport extends Omit<SceneWing, 'squads'> {
  readonly squads: SquadReport[];
}

/**
 * A fleet as get_state reports it: as written, plus the ships holding a position, with every squad's anchor resolved.
 */
export interface FleetReport extends Omit<SceneFleet, 'wings'> {
  /**
   * The distinct ships holding a position: the FC, the wing commanders and the squad members.
   */
  readonly ships: string[];
  readonly wings: WingReport[];
}

interface MembershipRecord {
  wing: Maybe<string>;
  squad: Maybe<string>;
  role: Maybe<SquadRole>;
  readonly commands: Set<FleetCommand>;
  anchor: Maybe<FleetAnchor>;
}

/**
 * The anchor a squad names, with its defaults: the fleet commander, and the role's default range.
 *
 * @param fleet - The squad's fleet.
 * @param squad - The squad.
 * @returns The ship the squad anchors on and the range it holds.
 */
export function toSquadAnchor(fleet: SceneFleet, squad: SceneSquad): FleetAnchor {
  return { ship: squad.anchor?.ship ?? fleet.commander, range: squad.anchor?.range ?? DEFAULT_ANCHOR_RANGES[squad.role] };
}

/**
 * Resolves one fleet's anchor rules for every ship holding a position in it.
 *
 * - A squad anchored on the FC or on a ship outside the squad: every member but the FC keeps the squad's range on it.
 * - A squad anchored on one of its own members (not the FC): that ship is the squad's lead, as a logi anchor is. It
 *   keeps the squad's range on the FC, and the other members anchor up on it at DEFAULT_ANCHOR_UP_RANGE.
 * - The FC follows nobody; a wing commander in no squad anchors up on the FC.
 *
 * @param fleet - A normalized fleet.
 * @returns Each ship's membership, keyed by ship id: the FC first, then in document order.
 */
export function toFleetAnchors(fleet: SceneFleet): Map<string, ShipFleetMembership> {
  const fc = fleet.commander;
  const records = new Map<string, MembershipRecord>();
  const at = (id: string): MembershipRecord => {
    let record = records.get(id);
    if (!record) {
      record = { wing: null, squad: null, role: null, commands: new Set(), anchor: null };
      records.set(id, record);
    }
    return record;
  };

  at(fc).commands.add('fleet');
  for (const wing of fleet.wings) {
    for (const squad of wing.squads) {
      const { ship: anchor, range } = toSquadAnchor(fleet, squad);
      const lead = anchor !== fc && squad.members.includes(anchor) ? anchor : null;
      for (const member of squad.members) {
        const record = at(member);
        record.wing = wing.id;
        record.squad = squad.id;
        record.role = squad.role;
        if (member === fc) record.anchor = null;
        else if (lead === null) record.anchor = { ship: anchor, range };
        else if (member === lead) record.anchor = { ship: fc, range };
        else record.anchor = { ship: lead, range: DEFAULT_ANCHOR_UP_RANGE };
      }
      if (squad.commander) at(squad.commander).commands.add('squad');
    }
    if (wing.commander) {
      const record = at(wing.commander);
      record.commands.add('wing');
      if (record.squad === null) {
        record.wing = wing.id;
        if (wing.commander !== fc) record.anchor = { ship: fc, range: DEFAULT_ANCHOR_UP_RANGE };
      }
    }
  }

  const memberships = new Map<string, ShipFleetMembership>();
  for (const [id, record] of records) {
    memberships.set(id, {
      fleet: fleet.id,
      wing: record.wing,
      squad: record.squad,
      role: record.role,
      commands: FLEET_COMMANDS.filter((command) => record.commands.has(command)),
      anchor: record.anchor
    });
  }
  return memberships;
}

/**
 * Every ship's fleet membership in a document.
 *
 * @param scene - A normalized document.
 * @returns Each fleet ship's membership, keyed by ship id; ships in no fleet are absent.
 */
export function toFleetMemberships(scene: Pick<SceneDocument, 'fleets'>): Map<string, ShipFleetMembership> {
  const memberships = new Map<string, ShipFleetMembership>();
  for (const fleet of scene.fleets ?? []) {
    for (const [id, membership] of toFleetAnchors(fleet)) memberships.set(id, membership);
  }
  return memberships;
}

/**
 * The fleet tree as get_state reports it.
 *
 * @param scene - A normalized document.
 * @returns Each fleet as written, plus its ships, with every squad's anchor resolved.
 */
export function toFleetReports(scene: Pick<SceneDocument, 'fleets'>): FleetReport[] {
  return (scene.fleets ?? []).map((fleet) => {
    const { wings, ...rest } = fleet;
    return {
      ...rest,
      ships: [...toFleetAnchors(fleet).keys()],
      wings: wings.map((wing) => ({ ...wing, squads: wing.squads.map((squad) => ({ ...squad, anchor: toSquadAnchor(fleet, squad) })) }))
    };
  });
}
