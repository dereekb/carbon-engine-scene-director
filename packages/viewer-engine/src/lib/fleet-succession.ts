/**
 * The FC dies, the fleet flies on. DestinyWorld.Destroy halts every ship anchored or framed on the dead FC, its heir
 * included, and FleetFollowing.Reconcile re-plans the formation on the heir, who then follows nobody. So the director
 * captures, before the death, what the dead FC flew and whether each heir flew in its formation, and once the formation
 * has re-planned the heir inherits the FC's order:
 *
 * - its pending order, else its applied one, the pending order's response delay carried; a stop inherits nothing;
 * - an order aimed at the heir, or one the world refuses for it: `direction` along the dead FC's velocity at its speed
 *   over its max velocity (only at SETTLE_SPEED or more);
 * - a warp still aligning: `direction` toward its landing (as a cancelled warp flies on);
 * - only an heir that flew in the formation inherits: a detached heir or a group-apart leader keeps its own order.
 *
 * Kills resolve inside the boundary listeners and pending orders apply after them in the same Tick, so the heir never
 * flies a stopped tick.
 *
 * Node-tested: it imports the world's types only.
 */

import type { Maybe } from '@dereekb/util';
import { shipOrderTarget, type SceneVector, type ShipOrder } from '@scene-director/scene';
import type { DestinyWorld, ShipMotion } from './destiny';
import { SETTLE_SPEED } from './steering';

/**
 * A fleet whose commander died, captured before DestinyWorld.Destroy.
 */
export interface FleetHeir {
  readonly fleet: string;
  /**
   * The dead commander.
   */
  readonly dead: string;
  /**
   * The ship that commands the fleet now.
   */
  readonly heir: string;
  /**
   * The dead commander's motion just before it died.
   */
  readonly motion: Pick<ShipMotion, 'order' | 'pendingOrder' | 'respondsIn' | 'velocity' | 'speed' | 'warp' | 'physics'>;
  /**
   * The heir's position just before the death.
   */
  readonly position: SceneVector;
  /**
   * Whether the heir flew in the dead commander's formation (it followed, framed on it).
   */
  readonly inFormation: boolean;
}

/**
 * What the heir flies on with.
 */
export interface HeirOrder {
  readonly order: ShipOrder;
  /**
   * Whole ticks until it applies.
   */
  readonly delay: number;
  /**
   * `inherited`: the dead commander's own order; `along`: on along its velocity; `landing`: toward its aligning warp's
   * landing.
   */
  readonly source: 'inherited' | 'along' | 'landing';
}

/**
 * An heir's inherited order as the world took it.
 */
export interface FleetInheritance extends HeirOrder {
  readonly fleet: string;
  readonly heir: string;
}

/**
 * Captures each fleet's heir before its commander's DestinyWorld.Destroy.
 *
 * @param world - The world.
 * @param dead - The dying commander.
 * @param heirs - Each fleet it commanded, with the ship that commands it now.
 * @returns The heirs; none when the dead ship has no ball.
 */
export function CaptureFleetHeirs(world: Pick<DestinyWorld, 'Motion' | 'Following'>, dead: string, heirs: Iterable<readonly [fleet: string, heir: string]>): FleetHeir[] {
  const motion = world.Motion(dead);
  const captured: FleetHeir[] = [];
  for (const [fleet, heir] of heirs) {
    const position = world.Motion(heir)?.position;
    if (motion && position) captured.push({ fleet, dead, heir, motion, position, inFormation: world.Following(heir)?.frame === dead });
  }
  return captured;
}

/**
 * A unit vector, or null for a zero one.
 *
 * @param vector - Any vector.
 * @returns Its direction.
 */
function UnitOf(vector: SceneVector): Maybe<SceneVector> {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

/**
 * On along the dead commander's velocity, at its speed over its max velocity.
 *
 * @param motion - The dead commander's motion.
 * @returns The order; null below SETTLE_SPEED.
 */
function AlongOf(motion: FleetHeir['motion']): Maybe<ShipOrder> {
  const direction = motion.speed >= SETTLE_SPEED ? UnitOf(motion.velocity) : null;
  const max = motion.physics.maxVelocity;
  return direction ? { type: 'direction', direction, speed: max > 0 ? Math.min(1, motion.speed / max) : 1 } : null;
}

/**
 * What an heir flies on with (the module's rules).
 *
 * @param heir - The captured heir.
 * @param refusal - Why the world would refuse an order for the heir (DestinyWorld.OrderRefusal), after the death.
 * @returns Its order; null when it keeps its own (not in formation) or inherits nothing.
 */
export function HeirOrderOf(heir: FleetHeir, refusal: (order: ShipOrder) => Maybe<string>): Maybe<HeirOrder> {
  const { motion } = heir;
  const order = motion.pendingOrder ?? motion.order;
  if (!heir.inFormation || order.type === 'stop') return null;
  let result: Maybe<HeirOrder> = null;
  if (order.type === 'warp') {
    const landing = motion.pendingOrder || motion.warp?.phase !== 'aligning' ? null : motion.warp.landing;
    const direction = landing ? UnitOf([landing[0] - heir.position[0], landing[1] - heir.position[1], landing[2] - heir.position[2]]) : null;
    if (direction) result = { order: { type: 'direction', direction, speed: 1 }, delay: 0, source: 'landing' };
  } else if (shipOrderTarget(order) !== heir.heir) {
    result = { order, delay: motion.pendingOrder ? (motion.respondsIn ?? 0) : 0, source: 'inherited' };
  }
  if (result && refusal(result.order) != null) result = null;
  if (!result) {
    const along = AlongOf(motion);
    result = along && refusal(along) == null ? { order: along, delay: 0, source: 'along' } : null;
  }
  return result;
}

/**
 * Orders each heir on with what it inherits, once the formation re-planned on it (FleetFollowing.Reconcile).
 *
 * @param world - The world.
 * @param heirs - The heirs CaptureFleetHeirs captured.
 * @returns The orders the world took, in the heirs' order.
 */
export function InheritFleetOrders(world: Pick<DestinyWorld, 'Order' | 'OrderRefusal'>, heirs: readonly FleetHeir[]): FleetInheritance[] {
  const taken: FleetInheritance[] = [];
  for (const heir of heirs) {
    const inherited = HeirOrderOf(heir, (order) => world.OrderRefusal(heir.heir, order));
    if (inherited && world.Order(heir.heir, inherited.order, { delay: inherited.delay })) taken.push({ fleet: heir.fleet, heir: heir.heir, ...inherited });
  }
  return taken;
}
