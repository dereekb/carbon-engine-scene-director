import type { Maybe } from '@dereekb/util';
import { isPlainObject, readNumber } from '../json';

/**
 * A ship's pilot traits, 0..1 and higher is better for both: `command` is FC ability (a pilot with it is FC-capable),
 * `reaction` how fast it answers an order (fleets/orders.ts toPilotDelays). Unset traits in a personality fleet are
 * seeded draws from its personality. Any other key is reserved for the character system: stored, not used yet.
 */
export interface SceneShipPilotTraits {
  command?: number;
  reaction?: number;
  [reserved: string]: unknown;
}

/**
 * A ship's pilot: its traits, or a pilot name (reserved for the character system, stored but not used yet).
 */
export type SceneShipPilot = string | SceneShipPilotTraits;

/**
 * The pilot keys the page reads; the rest are reserved.
 */
export const SHIP_PILOT_TRAITS = ['command', 'reaction'] as const;

const RESERVED_PILOT_WARNING = 'is reserved for the character system and is stored but not used yet; ships fly with the max-skills pilot';

export interface NormalizeShipPilotInput {
  readonly input: unknown;
  /**
   * Where it sits, e.g. "ships[0].pilot".
   */
  readonly where: string;
}

export interface NormalizedShipPilot {
  /**
   * The pilot, or null when absent.
   */
  readonly pilot: Maybe<SceneShipPilot>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a ship's `pilot`: `command` and `reaction` are numbers in [0, 1]; a pilot name and any other key are kept
 * with a warning that they are reserved.
 *
 * @param config - The candidate and where it sits.
 * @returns The pilot (a copy), or null, with its problems and warnings.
 */
export function normalizeShipPilot(config: NormalizeShipPilotInput): NormalizedShipPilot {
  const { input, where } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  let pilot: Maybe<SceneShipPilot> = null;
  if (typeof input === 'string' && input.trim()) {
    pilot = input;
    warnings.push(`${where} ${RESERVED_PILOT_WARNING}`);
  } else if (isPlainObject(input)) {
    const traits: SceneShipPilotTraits = {};
    for (const [key, value] of Object.entries(input)) {
      if ((SHIP_PILOT_TRAITS as readonly string[]).includes(key)) {
        if (value != null) traits[key] = readNumber(value, `${where}.${key}`, problems, { min: 0, max: 1 });
      } else {
        traits[key] = structuredClone(value);
        warnings.push(`${where}.${key} ${RESERVED_PILOT_WARNING}`);
      }
    }
    if (Object.keys(traits).length) pilot = traits;
  } else if (input != null) {
    problems.push(`${where} must be an object of command and reaction (0..1) or a pilot name`);
  }
  return { pilot, problems, warnings };
}

/**
 * A pilot's traits, or none for a pilot name or an absent pilot.
 *
 * @param pilot - The ship's pilot.
 * @returns Its command and reaction, each when set.
 */
export function shipPilotTraits(pilot: Maybe<SceneShipPilot>): Pick<SceneShipPilotTraits, 'command' | 'reaction'> {
  const traits = isPlainObject(pilot) ? pilot : {};
  return { ...(typeof traits['command'] === 'number' ? { command: traits['command'] } : {}), ...(typeof traits['reaction'] === 'number' ? { reaction: traits['reaction'] } : {}) };
}

/**
 * The part of a pilot that sets the ship's flight (everything but its traits): the diff retunes a ship only when
 * this changes, so a command or reaction edit does not.
 *
 * @param pilot - The ship's pilot.
 * @returns The pilot without command and reaction, or null when nothing is left.
 */
export function pilotFlightPart(pilot: Maybe<SceneShipPilot>): Maybe<SceneShipPilot> {
  let part: Maybe<SceneShipPilot> = pilot ?? null;
  if (isPlainObject(pilot)) {
    const rest = Object.fromEntries(Object.entries(pilot).filter(([key]) => !(SHIP_PILOT_TRAITS as readonly string[]).includes(key)));
    part = Object.keys(rest).length ? rest : null;
  }
  return part;
}
