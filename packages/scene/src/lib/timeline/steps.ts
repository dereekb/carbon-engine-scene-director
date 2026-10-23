/**
 * A ship's own script (the ship's `orders`): an ordered list of steps it flies from play start. Each step is an
 * order_ship order (normalizeShipOrderRequest) plus `after` (seconds to wait first, once the previous step is done) and
 * `duration` (seconds it lasts once its order applied). Without a duration a step ends when its order completes
 * (shipStepCompletion); approach, keep-at-range, orbit and direction never complete, so they need a duration unless
 * they are the last step.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject } from '../json';
import { normalizeShipOrderRequest, type ShipOrderRequest, type ShipOrderRequestType } from '../orders';
import { SceneError } from '../scene';
import { MAX_SHIP_STEPS, MAX_TIMELINE_SECONDS } from './timeline';

/**
 * One step: an order_ship order, the seconds to wait before giving it, and the seconds it lasts.
 */
export type SceneShipStep = ShipOrderRequest & {
  /**
   * Seconds in [0, MAX_TIMELINE_SECONDS] to wait after the previous step is done (or the script starts). Default 0.
   */
  readonly after?: number;
  /**
   * Seconds in (0, MAX_TIMELINE_SECONDS]: the step is done this long after its order applied, or when the order
   * completes, whichever comes first.
   */
  readonly duration?: number;
};

/**
 * When a step's order completes on its own: `landed` (its own warp, begun after the order applied, has landed),
 * `arrived` (a goto: near its point and slow, SCRIPT_GOTO_ARRIVAL_RANGE / SCRIPT_GOTO_CLOSE_RANGE), `stopped` (slower
 * than SCRIPT_STOPPED_SPEED), `given` (at once: a rejoin hands the ship to its formation), `never`.
 */
export const SHIP_STEP_COMPLETIONS = ['landed', 'arrived', 'stopped', 'given', 'never'] as const;

export type ShipStepCompletion = (typeof SHIP_STEP_COMPLETIONS)[number];

const COMPLETIONS: Readonly<Record<ShipOrderRequestType, ShipStepCompletion>> = {
  warp: 'landed',
  goto: 'arrived',
  stop: 'stopped',
  rejoin: 'given',
  direction: 'never',
  approach: 'never',
  'keep-at-range': 'never',
  orbit: 'never'
};

/**
 * When a step of an order type completes without a duration.
 *
 * @param type - The step's order type.
 * @returns Its completion rule.
 */
export function shipStepCompletion(type: ShipOrderRequestType): ShipStepCompletion {
  return COMPLETIONS[type];
}

/**
 * A step's target that is no ship or object id the document (or a cue) holds: a name resolved when the step runs.
 */
export interface ShipStepName {
  readonly where: string;
  readonly target: string;
}

export interface NormalizeShipOrderStepsInput {
  readonly input: unknown;
  /**
   * The list's message prefix: `ships[2].orders`.
   */
  readonly where: string;
  /**
   * The ship flying them: a step cannot target it.
   */
  readonly self: string;
  /**
   * The ship and object ids a target may name without a warning.
   */
  readonly targets: ReadonlySet<string>;
  /**
   * Whether the ship holds a position in a fleet (a rejoin outside one warns).
   */
  readonly inFleet: boolean;
}

export interface NormalizedShipOrderSteps {
  /**
   * The steps; null when absent, null or empty (normalize omits them).
   */
  readonly steps: Maybe<SceneShipStep[]>;
  readonly problems: string[];
  readonly warnings: string[];
  /**
   * Targets that are no known id, for the caller to warn about once every id a cue adds is known.
   */
  readonly names: ShipStepName[];
}

const CELESTIAL_ID_PATTERN = /^celestial:\d+$/u;

function readSeconds(value: unknown, where: string, problems: string[], positive: boolean): Maybe<number> {
  if (value == null) return null;
  const valid = typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0) && value <= MAX_TIMELINE_SECONDS;
  if (!valid) problems.push(`${where} must be a number of seconds in ${positive ? '(0' : '[0'}, ${MAX_TIMELINE_SECONDS}]`);
  return valid ? value : null;
}

/**
 * Validates a ship's `orders`: each step's order through normalizeShipOrderRequest (with the context orders.ts keeps
 * for it), `after` and `duration`, at most MAX_SHIP_STEPS steps, and a never-completing step (direction, approach,
 * keep-at-range, orbit) without a duration only as the last step.
 *
 * @param input - The list, its ship and the ids its targets may name.
 * @returns The steps, the problems and warnings, and the targets read as names.
 */
export function normalizeShipOrderSteps(input: NormalizeShipOrderStepsInput): NormalizedShipOrderSteps {
  const { where, self, targets } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const names: ShipStepName[] = [];
  const steps: SceneShipStep[] = [];
  const list = input.input;
  if (list != null && !Array.isArray(list)) problems.push(`${where} must be an array of steps: order_ship orders with after? and duration? (seconds)`);
  const entries = Array.isArray(list) ? list : [];
  if (entries.length > MAX_SHIP_STEPS) problems.push(`${where} holds ${entries.length} steps; at most ${MAX_SHIP_STEPS}`);

  for (const [index, entry] of entries.entries()) {
    const at = `${where}[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${at} must be an object: an order_ship order with after? and duration?`);
      continue;
    }
    const { after: afterInput, duration: durationInput, ...rest } = entry as JsonObject;
    const after = readSeconds(afterInput, `${at}.after`, problems, false);
    const duration = readSeconds(durationInput, `${at}.duration`, problems, true);
    let order: Maybe<ShipOrderRequest> = null;
    try {
      order = normalizeShipOrderRequest(rest, { self, where: at });
    } catch (error) {
      if (!(error instanceof SceneError)) throw error;
      problems.push(...error.problems);
    }
    if (!order) continue;
    const target = 'target' in order ? order.target : null;
    if (target != null && !targets.has(target) && !CELESTIAL_ID_PATTERN.test(target)) names.push({ where: `${at}.target`, target });
    if (shipStepCompletion(order.type) === 'never' && duration == null && index < entries.length - 1) problems.push(`${at} (${order.type}) never ends on its own: give it a duration (seconds) or make it the last step`);
    if (order.type === 'rejoin' && !input.inFleet) warnings.push(`${at} (rejoin): ship "${self}" is in no fleet; it rejoins only if a cue puts it in one`);
    steps.push({ ...(after ? { after } : {}), ...order, ...(duration == null ? {} : { duration }) });
  }
  return { steps: steps.length && !problems.length ? steps : null, problems, warnings, names };
}

/**
 * The warning for a step target read as a name.
 *
 * @param name - The step's target.
 * @returns The message.
 */
export function shipStepNameWarning(name: ShipStepName): string {
  return `${name.where} "${name.target}" is no ship or object id: it is resolved as a name when the step runs`;
}
