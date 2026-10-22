import type { SceneVector } from '../scene';
import { DEFAULT_ANCHOR_UP_RANGE, type SceneFleet } from './fleet';
import { toFleetAnchors } from './membership';

/**
 * How far apart two ships sit at least, as a multiple of their two radii (plus FORMATION_GAP).
 */
export const FORMATION_SPACING = 1.5;

/**
 * Metres added to every spacing, so small hulls do not touch.
 */
export const FORMATION_GAP = 100;

/**
 * The radius (metres) that spaces a hull whose EVE radius is unknown; safe for every subcapital.
 */
export const DEFAULT_FORMATION_RADIUS = 500;

/**
 * The most shells tried around an anchor before giving up (unreachable within EVE's fleet size).
 */
const MAX_FORMATION_SHELLS = 64;
const MIN_SHELL_POINTS = 16;
const MAX_SHELL_POINTS = 1024;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * The least centre distance between two ships of a formation.
 *
 * @param a - One ship's radius in metres.
 * @param b - The other's.
 * @returns FORMATION_SPACING times the two radii, plus FORMATION_GAP.
 */
export function formationSpacing(a: number, b: number): number {
  return FORMATION_SPACING * (a + b) + FORMATION_GAP;
}

export interface FleetFormationInput {
  readonly fleet: SceneFleet;
  /**
   * The FC's position.
   */
  readonly origin: SceneVector;
  /**
   * The fleet's heading, yaw degrees: 0 faces +Z, 90 faces +X.
   */
  readonly heading: number;
  /**
   * Each ship's radius in metres (its EVE radius).
   */
  readonly radiusOf: (ship: string) => number;
}

interface PlacedShip {
  readonly position: SceneVector;
  readonly radius: number;
}

/**
 * A ship's place in its fleet's formation, relative to its anchor: Follow the FC flies it.
 */
export interface FleetFormationSlot {
  /**
   * The ship the slot is relative to: the ship's anchor (toFleetAnchors).
   */
  readonly anchor: string;
  /**
   * Unit direction from the anchor in the fleet's heading frame: x right, y up, z forward.
   */
  readonly direction: SceneVector;
  /**
   * Metres, surface to surface: the anchor's range on the first shell, one formationSpacing further per outer shell.
   */
  readonly range: number;
}

interface PlacedFleetShip extends PlacedShip {
  /**
   * Null for the FC.
   */
  readonly slot: FleetFormationSlot | null;
}

/**
 * Lays a fleet out around its FC, at rest: every ship sits at its anchor's range (toFleetAnchors, surface to
 * surface) on a shell trailing the FC's heading, and no two ships sit closer than formationSpacing of their radii.
 * Deterministic: the same fleet, origin, heading and radii give the same positions.
 *
 * Each ship tries its anchor's shell at exactly its range first, from the trailing pole forward over a Fibonacci
 * sphere's trailing hemisphere, then shells one spacing further out. Positions are rounded to the metre, and the
 * spacing is checked on the rounded positions.
 *
 * Follow the FC flies these slots (toFleetFormationSlots: each ship's offset from its anchor, in the FC's heading
 * frame) on top of toFleetMemberships' anchors, so a fleet added in formation starts following without a scramble.
 *
 * @param input - The fleet, the FC's position, the heading and each ship's radius.
 * @returns Each fleet ship's position, keyed by ship id: the FC first, then toFleetAnchors' order.
 * @throws {Error} When a ship's anchor chain does not end at the FC, or a ship finds no room (neither happens for a
 *   normalized fleet within EVE's fleet size).
 */
export function layoutFleetFormation(input: FleetFormationInput): Map<string, SceneVector> {
  return new Map([...placeFleet(input)].map(([ship, { position }]) => [ship, position]));
}

/**
 * Every ship's formation slot but the FC's: the same placement as layoutFleetFormation (same input, same shells, same
 * fit checks on the same rounded positions), kept as a direction and a range instead of a position. A ship flown to
 * `anchor + rotate(heading, direction) × (range + anchor radius + radius)` from where layoutFleetFormation put its
 * anchor lands where layoutFleetFormation put it, to rounding.
 *
 * @param input - The fleet, the FC's position, the heading and each ship's radius.
 * @returns Each non-FC fleet ship's slot, keyed by ship id, in layoutFleetFormation's order.
 * @throws {Error} As layoutFleetFormation does.
 */
export function toFleetFormationSlots(input: FleetFormationInput): Map<string, FleetFormationSlot> {
  const slots = new Map<string, FleetFormationSlot>();
  for (const [ship, { slot }] of placeFleet(input)) if (slot) slots.set(ship, slot);
  return slots;
}

function placeFleet(input: FleetFormationInput): Map<string, PlacedFleetShip> {
  const { fleet, origin, heading, radiusOf } = input;
  const anchors = toFleetAnchors(fleet);
  const placed = new Map<string, PlacedFleetShip>([[fleet.commander, { position: [...origin], radius: radiusOf(fleet.commander), slot: null }]]);
  const yaw = (heading * Math.PI) / 180;
  const frame: Frame = { forward: [Math.sin(yaw), 0, Math.cos(yaw)], right: [Math.cos(yaw), 0, -Math.sin(yaw)] };

  let pending = [...anchors.keys()].filter((ship) => ship !== fleet.commander);
  while (pending.length) {
    const waiting: string[] = [];
    for (const ship of pending) {
      const anchor = anchors.get(ship)?.anchor ?? { ship: fleet.commander, range: DEFAULT_ANCHOR_UP_RANGE };
      const at = placed.get(anchor.ship);
      if (at) placed.set(ship, placeShip({ ship, radius: radiusOf(ship), anchor: { id: anchor.ship, ...at }, range: anchor.range, frame, placed }));
      else waiting.push(ship);
    }
    if (waiting.length === pending.length) throw new Error(`fleet "${fleet.id}": ship "${waiting[0]}" anchors on a ship that is never placed; every anchor chain must end at the FC`);
    pending = waiting;
  }

  return placed;
}

interface Frame {
  readonly forward: SceneVector;
  readonly right: SceneVector;
}

interface PlaceShipInput {
  readonly ship: string;
  readonly radius: number;
  readonly anchor: PlacedShip & { readonly id: string };
  readonly range: number;
  readonly frame: Frame;
  readonly placed: ReadonlyMap<string, PlacedShip>;
}

function placeShip(input: PlaceShipInput): PlacedFleetShip {
  const { ship, radius, anchor, range, frame, placed } = input;
  const step = formationSpacing(radius, radius);
  for (let shell = 0; shell < MAX_FORMATION_SHELLS; shell += 1) {
    const distance = range + anchor.radius + radius + shell * step;
    for (const direction of shellDirections(distance, step)) {
      const position = toWorld({ anchor: anchor.position, distance, direction, frame });
      if (fits(position, radius, placed)) return { position, radius, slot: { anchor: anchor.id, direction, range: range + shell * step } };
    }
  }
  throw new Error(`no room for ship "${ship}" within ${MAX_FORMATION_SHELLS} shells of its anchor`);
}

/**
 * The candidate directions on one shell, in the heading frame: the trailing pole, then a Fibonacci sphere's
 * trailing hemisphere (the beam included) from the pole forward.
 *
 * @param distance - The shell's radius in metres.
 * @param step - The spacing the shell's points should leave between ships.
 * @yields Local directions (x right, y up, z forward).
 */
function* shellDirections(distance: number, step: number): Generator<SceneVector> {
  yield [0, 0, -1];
  const count = Math.min(MAX_SHELL_POINTS, Math.max(MIN_SHELL_POINTS, Math.ceil((2 * 4 * Math.PI * distance * distance) / (0.866 * step * step))));
  for (let index = 0; index < count; index += 1) {
    const t = 1 - (2 * index + 1) / count;
    if (t < 0) break;
    const rho = Math.sqrt(1 - t * t);
    const phi = index * GOLDEN_ANGLE;
    yield [rho * Math.cos(phi), rho * Math.sin(phi), -t];
  }
}

function toWorld(input: { readonly anchor: SceneVector; readonly distance: number; readonly direction: SceneVector; readonly frame: Frame }): SceneVector {
  const { anchor, distance, direction, frame } = input;
  const [x, y, z] = direction;
  const world = [0, 1, 2].map((axis) => anchor[axis] + distance * (x * frame.right[axis] + z * frame.forward[axis]) + (axis === 1 ? distance * y : 0));
  return world.map((component) => Math.round(component) || 0) as SceneVector;
}

function fits(position: SceneVector, radius: number, placed: ReadonlyMap<string, PlacedShip>): boolean {
  for (const other of placed.values()) {
    const spacing = formationSpacing(radius, other.radius);
    const dx = position[0] - other.position[0];
    const dy = position[1] - other.position[1];
    const dz = position[2] - other.position[2];
    if (dx * dx + dy * dy + dz * dz < spacing * spacing) return false;
  }
  return true;
}
