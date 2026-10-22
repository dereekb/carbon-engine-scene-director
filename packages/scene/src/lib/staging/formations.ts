/**
 * Shape formations for staged ships outside fleets (fleet members fly Follow the FC's shell slots instead). Every
 * shape is laid out in the heading frame (x right, y up, z forward) with the lead, the first ship, at [0, 0, 0].
 */

import { formationSpacing } from '../fleets';
import type { SceneVector } from '../scene';
import { headingVectors, roundVector } from './placement';

export const SHIP_FORMATIONS = ['sphere', 'line', 'column', 'wedge', 'grid', 'wall'] as const;
export type ShipFormation = (typeof SHIP_FORMATIONS)[number];

/**
 * Other names a formation answers to.
 */
export const SHIP_FORMATION_ALIASES: Readonly<Record<string, ShipFormation>> = { blob: 'sphere' };

export const DEFAULT_SHIP_FORMATION: ShipFormation = 'sphere';

/**
 * The angle (degrees) of each wedge arm off the lead's tail.
 */
export const WEDGE_HALF_ANGLE = 45;

/**
 * Fibonacci candidates per sphere shell: `ceil(SPHERE_SHELL_CANDIDATES × i²)` on shell i.
 */
export const SPHERE_SHELL_CANDIDATES = 40;

/**
 * The most sphere shells tried (256 ships fit in 4).
 */
const MAX_SPHERE_SHELLS = 64;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Reads a formation name: trimmed, case-insensitive, aliases allowed.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem for an unknown name.
 * @returns The formation (DEFAULT_SHIP_FORMATION on a problem).
 */
export function readShipFormation(value: unknown, where: string, problems: string[]): ShipFormation {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  let formation: ShipFormation = DEFAULT_SHIP_FORMATION;
  if ((SHIP_FORMATIONS as readonly string[]).includes(name)) formation = name as ShipFormation;
  else if (SHIP_FORMATION_ALIASES[name]) formation = SHIP_FORMATION_ALIASES[name];
  else problems.push(`${where} must be one of ${[...SHIP_FORMATIONS, ...Object.keys(SHIP_FORMATION_ALIASES)].join(', ')}`);
  return formation;
}

/**
 * The default centre-to-centre spacing of a hull: fleets' formationSpacing for two of it, rounded up.
 *
 * @param radius - The hull's EVE radius in metres.
 * @returns Metres.
 */
export function defaultShipSpacing(radius: number): number {
  return Math.ceil(formationSpacing(radius, radius));
}

export interface ShipFormationInput {
  readonly formation: ShipFormation;
  readonly count: number;
  /**
   * Metres between neighbours, centre to centre.
   */
  readonly spacing: number;
}

/**
 * Each ship's offset in the heading frame (x right, y up, z forward), the lead first at [0, 0, 0]:
 * - sphere: shells at i × spacing around the lead, filled from Fibonacci candidates (trailing pole first), each kept
 *   only when it is at least `spacing` from every kept ship;
 * - line: abreast, centre-out (0, +s, −s, +2s, ...);
 * - column: astern of the lead;
 * - wedge: two arms trailing the lead at WEDGE_HALF_ANGLE, alternating right and left;
 * - grid: ranks of ceil(√N) abreast (centre-out), each rank behind the last;
 * - wall: rows of ceil(√N) abreast, stacked up and down centre-out.
 *
 * @param input - The shape, the count and the spacing.
 * @returns The offsets, unrounded.
 * @throws {Error} When the sphere finds no room within MAX_SPHERE_SHELLS (unreachable for EVE's fleet size).
 */
export function layoutShipFormation(input: ShipFormationInput): SceneVector[] {
  const { formation, count, spacing: s } = input;
  const width = Math.ceil(Math.sqrt(count));
  const half = (WEDGE_HALF_ANGLE * Math.PI) / 180;
  let offsets: SceneVector[];
  switch (formation) {
    case 'sphere':
      offsets = layoutSphere(count, s);
      break;
    case 'line':
      offsets = indices(count).map((k) => [s * centreOut(k), 0, 0]);
      break;
    case 'column':
      offsets = indices(count).map((k) => [0, 0, -k * s || 0]);
      break;
    case 'wedge':
      offsets = indices(count).map((k): SceneVector => {
        const arm = Math.ceil(k / 2);
        const side = k % 2 === 1 ? 1 : -1;
        return k === 0 ? [0, 0, 0] : [side * arm * s * Math.sin(half), 0, -arm * s * Math.cos(half)];
      });
      break;
    case 'grid':
      offsets = indices(count).map((k) => [s * centreOut(k % width), 0, -Math.floor(k / width) * s || 0]);
      break;
    case 'wall':
      offsets = indices(count).map((k) => [s * centreOut(k % width), s * centreOut(Math.floor(k / width)), 0]);
      break;
  }
  return offsets;
}

export interface FormationWorldInput {
  readonly offsets: readonly SceneVector[];
  /**
   * The lead's place.
   */
  readonly position: SceneVector;
  /**
   * Yaw degrees: 0 faces +Z, 90 faces +X.
   */
  readonly heading: number;
}

/**
 * The offsets in the scene: `place + x·right + y·up + z·forward`, the place rounded to the metre first and every
 * position rounded to the metre.
 *
 * @param input - The offsets, the place and the heading.
 * @returns The world positions, in the offsets' order.
 */
export function toFormationWorld(input: FormationWorldInput): SceneVector[] {
  const place = roundVector(input.position);
  const { forward, right } = headingVectors(input.heading);
  return input.offsets.map(([x, y, z]) => roundVector([place[0] + x * right[0] + z * forward[0], place[1] + y, place[2] + x * right[2] + z * forward[2]]));
}

/**
 * 0, +1, −1, +2, −2, ...
 *
 * @param k - The index.
 * @returns The centre-out step.
 */
function centreOut(k: number): number {
  return k % 2 === 1 ? (k + 1) / 2 : -k / 2 || 0;
}

function indices(count: number): number[] {
  return Array.from({ length: count }, (_, k) => k);
}

function layoutSphere(count: number, spacing: number): SceneVector[] {
  const kept: SceneVector[] = count > 0 ? [[0, 0, 0]] : [];
  for (let shell = 1; shell <= MAX_SPHERE_SHELLS && kept.length < count; shell += 1) {
    const candidates = Math.ceil(SPHERE_SHELL_CANDIDATES * shell * shell);
    const radius = shell * spacing;
    for (let j = 0; j < candidates && kept.length < count; j += 1) {
      const z = -1 + (2 * j + 1) / candidates;
      const ring = Math.sqrt(1 - z * z);
      const theta = GOLDEN_ANGLE * j;
      const candidate: SceneVector = [ring * Math.cos(theta) * radius, ring * Math.sin(theta) * radius, z * radius];
      if (kept.every((other) => Math.hypot(candidate[0] - other[0], candidate[1] - other[1], candidate[2] - other[2]) >= spacing)) kept.push(candidate);
    }
  }
  if (kept.length < count) throw new Error(`no room for ${count} ships in a sphere of ${MAX_SPHERE_SHELLS} shells`);
  return kept;
}
