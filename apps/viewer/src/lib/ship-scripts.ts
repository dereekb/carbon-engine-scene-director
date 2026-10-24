/**
 * Ship scripts: each scripted ship flies its document `orders` in turn (@scene-director/scene's timeline/steps.ts),
 * stepped by the timeline player (timeline.ts) at every tick boundary it plays, before that boundary's cues. A step's
 * order is given in the pre-boundary hook and applies at that boundary; it ends `duration` played ticks later, or when
 * its order completes (shipStepCompletion), and the next step's order follows `after` ticks later.
 *
 * Plain data and no runtime: the director is the port, and the specs fake it.
 */

import type { Maybe } from '@dereekb/util';
import { SCRIPT_GOTO_ARRIVAL_RANGE, SCRIPT_GOTO_CLOSE_RANGE, SCRIPT_STOPPED_SPEED, shipStepCompletion, type SceneShipStep, type SceneVector, type ShipOrderRequest, type ShipScriptReport, type ShipScriptState } from '@scene-director/scene';

/**
 * What a script reads of its ship's flight.
 */
export interface ShipScriptMotion {
  /**
   * The order the ball flies.
   */
  readonly order: object;
  /**
   * The order given since the last tick, applying at the next one.
   */
  readonly pendingOrder?: object;
  /**
   * Why the world stopped the ship itself.
   */
  readonly orderNote?: string;
  readonly speed: number;
  readonly position: SceneVector;
  readonly warp?: { readonly phase: string };
}

export interface ShipScriptsPort {
  /**
   * Gives a ship a step's order now (order_ship's path).
   *
   * @returns The order as given (normalized, names resolved): what the ship flies while the step runs.
   * @throws {Error} The refusal.
   */
  Order(id: string, order: ShipOrderRequest): object;
  Motion(id: string): Maybe<ShipScriptMotion>;
  /**
   * False once the ship was destroyed.
   */
  Alive(id: string): boolean;
  /**
   * A warp-in that has not landed.
   */
  Arriving(id: string): boolean;
  InWarp(id: string): boolean;
}

/**
 * One ship's script state: plain data (Snapshot / Restore).
 */
export interface ShipScriptRecord {
  /**
   * The `orders` it runs, as JSON: a change restarts the script.
   */
  readonly key: string;
  readonly steps: SceneShipStep[];
  step: number;
  state: ShipScriptState;
  /**
   * The played tick the step's order is given at (waiting), or was given at (flying, holding).
   */
  startAt: number;
  /**
   * The order as given, JSON (flying, holding): another order on the ship interrupts the script.
   */
  given?: string;
  /**
   * The played tick a duration ends the step at.
   */
  endAt?: number;
  /**
   * A warp step: its own warp has begun since the order applied.
   */
  seenWarp?: boolean;
  note?: string;
}

/**
 * A live ship's id and its `orders`, as the live scene holds them.
 */
export interface ScriptedShip {
  readonly id: string;
  readonly orders?: readonly SceneShipStep[];
}

const IN_WARP_NOTE = 'waits for its warp to land';

const ENDED_STATES: ReadonlySet<ShipScriptState> = new Set(['done', 'failed', 'interrupted', 'destroyed']);

/**
 * Whether a script has nothing more to do (holding counts: its last order flies on by design).
 *
 * @param state - The script's state.
 * @returns True when it ended or holds its last order.
 */
export function ShipScriptSettled(state: ShipScriptState): boolean {
  return ENDED_STATES.has(state) || state === 'holding';
}

export class ShipScripts {
  private scripts = new Map<string, ShipScriptRecord>();

  constructor(private readonly port: ShipScriptsPort) {}

  /**
   * Drops every script (a load).
   */
  Clear(): void {
    this.scripts.clear();
  }

  /**
   * Steps every script at a played tick: starts the scripts of live ships with orders, restarts those whose orders
   * changed, drops removed ships, then advances each in `ships[]` order.
   *
   * @param played - The timeline's played tick (0 at t = 0).
   * @param ships - The live scene's ships.
   */
  Step(played: number, ships: readonly ScriptedShip[]): void {
    const present = new Set<string>();
    for (const ship of ships) {
      if (!ship.orders?.length) continue;
      present.add(ship.id);
      const key = JSON.stringify(ship.orders);
      const existing = this.scripts.get(ship.id);
      if (!existing || existing.key !== key) this.scripts.set(ship.id, { key, steps: ship.orders.map((step) => ({ ...step })), step: 0, state: 'waiting', startAt: played + Math.ceil(ship.orders[0].after ?? 0), ...(existing ? { note: 'its orders changed: restarted from step 0' } : {}) });
    }
    for (const id of [...this.scripts.keys()]) if (!present.has(id)) this.scripts.delete(id);
    for (const ship of ships) {
      const script = this.scripts.get(ship.id);
      if (script) this.Advance(ship.id, script, played);
    }
  }

  /**
   * A ship's script, for get_state.
   *
   * @param id - The ship id.
   * @param played - The played tick now.
   * @returns Its report, or null when the ship has no script running.
   */
  Report(id: string, played: number): Maybe<ShipScriptReport> {
    const script = this.scripts.get(id);
    if (!script) return null;
    const step = script.steps[Math.min(script.step, script.steps.length - 1)];
    const startsIn = script.state === 'waiting' || script.state === 'arriving' ? Math.max(0, script.startAt - played) : null;
    const endsIn = script.endAt != null && (script.state === 'flying' || script.state === 'holding') ? Math.max(0, script.endAt - played) : null;
    return {
      state: script.state,
      step: script.step,
      steps: script.steps.length,
      ...(step && !ENDED_STATES.has(script.state) ? { order: DescribeStep(step) } : {}),
      ...(startsIn != null ? { startsIn } : {}),
      ...(endsIn != null ? { endsIn } : {}),
      ...(script.note ? { note: script.note } : {})
    };
  }

  /**
   * The scripted ships, in the order their scripts started.
   */
  get ships(): string[] {
    return [...this.scripts.keys()];
  }

  /**
   * How many scripts are in each state.
   */
  Counts(): Record<'ships' | ShipScriptState, number> {
    const counts: Record<'ships' | ShipScriptState, number> = { ships: 0, waiting: 0, arriving: 0, flying: 0, holding: 0, done: 0, failed: 0, interrupted: 0, destroyed: 0 };
    for (const script of this.scripts.values()) {
      counts.ships += 1;
      counts[script.state] += 1;
    }
    return counts;
  }

  /**
   * Whether every script ended or holds its last order.
   */
  Settled(): boolean {
    return [...this.scripts.values()].every((script) => ShipScriptSettled(script.state));
  }

  /**
   * A ship's script record as it stands (read it, never change it), or null without one.
   */
  Record(id: string): Maybe<Readonly<ShipScriptRecord>> {
    return this.scripts.get(id) ?? null;
  }

  /**
   * Swaps a running script's steps in place (a script edit that only changes steps it has not reached, Movie mode M3):
   * its step, state and startAt stay, and the next step's `after` is read from the new steps. Step then sees the same
   * key and does not restart it.
   *
   * @param id - The ship id.
   * @param steps - Its new `orders`, as the live scene holds them.
   * @returns True when the ship had a script with other steps.
   */
  Swap(id: string, steps: readonly SceneShipStep[]): boolean {
    const script = this.scripts.get(id);
    const key = JSON.stringify(steps);
    if (!script || script.key === key) return false;
    this.scripts.set(id, { ...script, key, steps: steps.map((step) => ({ ...step })) });
    return true;
  }

  Snapshot(): Record<string, ShipScriptRecord> {
    return structuredClone(Object.fromEntries(this.scripts));
  }

  Restore(snapshot: Record<string, ShipScriptRecord>): void {
    this.scripts = new Map(Object.entries(structuredClone(snapshot)));
  }

  private Advance(id: string, script: ShipScriptRecord, played: number): void {
    if (ENDED_STATES.has(script.state)) return;
    if (!this.port.Alive(id)) {
      script.state = 'destroyed';
      return;
    }
    // A step done this tick hands over to the next in the same tick when its after is 0.
    for (let guard = 0; guard <= script.steps.length; guard++) {
      if (script.state === 'flying' || script.state === 'holding') {
        if (!this.Running(id, script, played)) return;
        if (ENDED_STATES.has(script.state)) return;
        continue;
      }
      if (!this.Give(id, script, played)) return;
    }
  }

  /**
   * Gives the step's order once its time came and the ship can take it.
   *
   * @returns True when the step was given and completed at once (a rejoin), or skipped (its target was destroyed), so
   *   the next step may run this tick.
   */
  private Give(id: string, script: ShipScriptRecord, played: number): boolean {
    if (played < script.startAt) {
      script.state = 'waiting';
      return false;
    }
    if (this.port.Arriving(id)) {
      script.state = 'arriving';
      return false;
    }
    if (this.port.InWarp(id)) {
      script.state = 'waiting';
      script.note = IN_WARP_NOTE;
      return false;
    }
    const step = script.steps[script.step];
    const target = (step as { readonly target?: unknown }).target;
    if (typeof target === 'string' && !this.port.Alive(target)) {
      script.note = `step ${script.step} (${DescribeStep(step)}) was skipped: its target was destroyed`;
      return this.Next(script, played);
    }
    const { after: _after, duration, ...order } = step;
    let given: object;
    try {
      given = this.port.Order(id, order as ShipOrderRequest);
    } catch (error) {
      script.state = 'failed';
      script.note = `step ${script.step} (${DescribeStep(step)}) was refused: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
    if (script.note === IN_WARP_NOTE) delete script.note;
    script.startAt = played;
    script.given = JSON.stringify(given);
    script.seenWarp = false;
    if (duration != null) script.endAt = played + Math.ceil(duration);
    else delete script.endAt;
    const completion = shipStepCompletion(step.type);
    if (completion === 'given') return this.Next(script, played);
    script.state = completion === 'never' && duration == null ? 'holding' : 'flying';
    return false;
  }

  /**
   * Checks a running step: interrupted, dropped, its target destroyed, its duration over, or its order complete.
   *
   * @returns True when the step ended this tick and the next may start.
   */
  private Running(id: string, script: ShipScriptRecord, played: number): boolean {
    const motion = this.port.Motion(id);
    if (!motion) return false;
    const step = script.steps[script.step];
    const flying = JSON.stringify(motion.pendingOrder ?? motion.order);
    if (flying !== script.given) {
      // The world stopped it because its target was destroyed: in a scripted fight that is the expected end of an
      // attack run, so the step ends there and the script goes on.
      const target = (JSON.parse(script.given ?? '{}') as { readonly target?: unknown }).target;
      if (typeof target === 'string' && motion.orderNote && !motion.pendingOrder && !this.port.Alive(target)) {
        script.note = `step ${script.step} (${DescribeStep(step)}) ended: its target was destroyed`;
        return this.Next(script, played);
      }
      if (motion.orderNote && !motion.pendingOrder) {
        script.state = 'failed';
        script.note = `step ${script.step} (${DescribeStep(step)}) was dropped: ${motion.orderNote}`;
      } else {
        script.state = 'interrupted';
        script.note = `another order took the ship at step ${script.step} (${DescribeStep(step)})`;
      }
      return false;
    }
    if (script.endAt != null && played >= script.endAt) return this.Next(script, played);
    if (motion.pendingOrder) return false;
    if (Complete(step, motion, script)) return this.Next(script, played);
    return false;
  }

  private Next(script: ShipScriptRecord, played: number): boolean {
    script.step += 1;
    delete script.given;
    delete script.endAt;
    delete script.seenWarp;
    if (script.step >= script.steps.length) {
      script.state = 'done';
      return false;
    }
    script.state = 'waiting';
    script.startAt = played + Math.ceil(script.steps[script.step].after ?? 0);
    return true;
  }
}

function Complete(step: SceneShipStep, motion: ShipScriptMotion, script: ShipScriptRecord): boolean {
  switch (shipStepCompletion(step.type)) {
    case 'landed':
      if (motion.warp && motion.warp.phase !== 'landed') script.seenWarp = true;
      return script.seenWarp === true && motion.warp?.phase === 'landed';
    case 'arrived': {
      const point = (step as { readonly point?: SceneVector }).point;
      if (!point) return motion.speed < SCRIPT_STOPPED_SPEED;
      const distance = Math.hypot(motion.position[0] - point[0], motion.position[1] - point[1], motion.position[2] - point[2]);
      return distance <= SCRIPT_GOTO_CLOSE_RANGE || (distance <= SCRIPT_GOTO_ARRIVAL_RANGE && motion.speed < SCRIPT_STOPPED_SPEED);
    }
    case 'stopped':
      return motion.speed < SCRIPT_STOPPED_SPEED;
    default:
      return false;
  }
}

/**
 * A step for reports: `orbit red-fc`, `goto`, `stop`.
 *
 * @param step - The step.
 * @returns Its order type and target.
 */
export function DescribeStep(step: SceneShipStep): string {
  const target = (step as { readonly target?: unknown }).target;
  return typeof target === 'string' ? `${step.type} ${target}` : step.type;
}
