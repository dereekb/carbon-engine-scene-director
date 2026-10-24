/**
 * The camera director's discrete events: what the page's hooks report at a Destiny tick boundary (a kill, a called
 * primary switching, a warp, a prop mod switching on). Everything else it reacts to (fleets opening fire, doomed ships,
 * reps, close passes, motion) it derives from the picture.
 *
 * Ticks are scene ticks (since the load), so a replay sees the same stream.
 */

import type { Maybe } from '@dereekb/util';

export const DIRECTOR_EVENT_KINDS = ['kill', 'primary', 'warp', 'prop-mod'] as const;

export type DirectorEventKind = (typeof DIRECTOR_EVENT_KINDS)[number];

export interface DirectorKillEvent {
  readonly kind: 'kill';
  readonly tick: number;
  readonly ship: string;
  /**
   * The killer, when known.
   */
  readonly by?: Maybe<string>;
}

export interface DirectorPrimaryEvent {
  readonly kind: 'primary';
  readonly tick: number;
  /**
   * The fleet whose group called it.
   */
  readonly fleet: string;
  /**
   * The group ("fleet", a wing or a squad id), for messages.
   */
  readonly group?: string;
  readonly primary: Maybe<string>;
  readonly previous?: Maybe<string>;
}

export interface DirectorWarpEvent {
  readonly kind: 'warp';
  readonly tick: number;
  readonly ship: string;
  /**
   * Into warp (aligned and away) or out of it (landing).
   */
  readonly phase: 'enter' | 'exit';
  /**
   * Part of an arrival by warp (warpIn): the arrival lead covers it.
   */
  readonly arrival?: boolean;
}

export interface DirectorPropModEvent {
  readonly kind: 'prop-mod';
  readonly tick: number;
  readonly ship: string;
}

export type CameraDirectorEvent = DirectorKillEvent | DirectorPrimaryEvent | DirectorWarpEvent | DirectorPropModEvent;

/**
 * An event's weight on a subject and its half-life, seconds. Interest decays as w × 2^(−age / halfLife). The values are
 * starting values: the specs pin orderings (a recognisable kill beats a primary switch beats an MWD), not numbers.
 */
export interface DirectorEventWeight {
  readonly weight: number;
  readonly halfLife: number;
}

export const DIRECTOR_EVENT_WEIGHTS = {
  kill: { victim: { weight: 10, halfLife: 5 }, killer: { weight: 2, halfLife: 4 }, fleet: { weight: 4, halfLife: 8 }, flagFactor: 0.5 },
  primary: { primary: { weight: 5, halfLife: 6 }, pair: { weight: 3, halfLife: 6 } },
  engage: { engagement: { weight: 8, halfLife: 10 }, fleet: { weight: 3, halfLife: 10 } },
  arrival: { group: { weight: 9, halfLife: 8 } },
  warpExit: { group: { weight: 6, halfLife: 6 } },
  warpEnter: { group: { weight: 3, halfLife: 5 } },
  propMod: { ship: { weight: 1.5, halfLife: 5 }, fleet: { weight: 4, halfLife: 6 } },
  pass: { ship: { weight: 4, halfLife: 3 }, pair: { weight: 2, halfLife: 3 } }
} as const;

/**
 * Below this an interest entry is dropped.
 */
export const DIRECTOR_INTEREST_FLOOR = 0.05;

/**
 * The events in a fixed order: tick, then kind (DIRECTOR_EVENT_KINDS), then ship or fleet id, then phase.
 *
 * @param events - The events, in any order.
 * @returns A sorted copy.
 */
export function sortDirectorEvents(events: readonly CameraDirectorEvent[]): CameraDirectorEvent[] {
  const name = (event: CameraDirectorEvent): string => (event.kind === 'primary' ? `${event.fleet}|${event.group ?? ''}|${event.primary ?? ''}` : event.ship);
  const phase = (event: CameraDirectorEvent): string => (event.kind === 'warp' ? event.phase : '');
  return [...events].sort((a, b) => a.tick - b.tick || DIRECTOR_EVENT_KINDS.indexOf(a.kind) - DIRECTOR_EVENT_KINDS.indexOf(b.kind) || compare(name(a), name(b)) || compare(phase(a), phase(b)));
}

/**
 * Code-unit order (never the locale's, so every runtime sorts alike).
 */
export function compareDirectorKeys(a: string, b: string): number {
  let result = 0;
  if (a < b) result = -1;
  else if (a > b) result = 1;
  return result;
}

const compare = compareDirectorKeys;
