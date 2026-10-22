/**
 * Destiny in the page: every document ship flies as a Destiny ball, and the ball drives the ship's translation and
 * rotation curves.
 *
 * - Two parks, kept in lockstep. The master park (`isMaster`) holds the authoritative CjsDestinyBall state that
 *   get_state, distances and framing read. The replica park creates CjsDestinyClientBall, the renderer curve the
 *   server documents (docs/destiny-client-curves.md): it interpolates, shifts two ticks back and damps rotation the
 *   way EVE's client does. An adapter over master balls would re-implement all of that. Replication (the server
 *   ticker) is unported, so this class is the only code that touches the parks: every state change goes to both in
 *   the same call, orders apply to both at the same tick boundary, and both get OnTick with the same clock value. They
 *   stay bit-identical.
 * - One clock (clock.ts). Tick(now) evolves both parks to `now`, and the renderer then samples the curves at the same
 *   `now` (100 ns ticks).
 * - Absolute coordinates. The replica's ego is a fixed reference ball at the origin, so ClientBall samples are world
 *   positions. Ship balls take ids from FIRST_SHIP_BALL_ID up and never reuse one.
 * - Rotation. Destiny's legacy orientation faces the velocity, or the goto point at rest. A ship is seeded to face
 *   along its document forward vector; BallRotation then multiplies in the document's remaining attitude (its roll),
 *   so a ship at rest has exactly its document rotation and keeps its roll while flying.
 * - When things apply. Adding, removing, placing and physics apply at once (they teleport). Movement orders wait for
 *   the next tick boundary, as EVE applies commands before a tick, so the interval a ClientBall is interpolating is
 *   never disturbed.
 * - Orders. A target order's ball resolves at the tick boundary. Destiny refuses some orders without a word, keeping
 *   the old one, so both parks must reach the order's mode, or the ship stops on both. Removing a ship stops its
 *   followers first, because Destiny alone sends an orbiter straight on along its velocity.
 * - Physics come from flight.ts (Ship stats); the world takes them as given and accepts a max velocity of 0.
 * - Following (Follow the FC). A fleet member flies its formation slot by per-tick goto steering: at every tick
 *   boundary, right after the pending orders, Steer re-aims its GotoPoint on both parks at its slot (its anchor's live
 *   position plus the slot's direction in the FC's heading frame, Destiny's legacy heading without roll), led along
 *   the anchor's velocity by Destiny's goto lag (steering.ts), at its own max velocity. Not FollowBall, which aims at
 *   the nearest point of the range sphere and cannot hold a bearing (followers stack at the trailing pole), and not
 *   Destiny's native formations (16 slots per leader, a leader frame that banks, park-held tables). A member whose
 *   anchor is at rest settles in its slot: it stops and turns smoothly to the fleet heading. It reports itself as
 *   keep-at-range on its anchor. An explicit order ends following; RemoveShip leaves followers to the director
 *   (FleetFollowing re-anchors them in the same edit), and Steer halts any whose anchor or FC is gone.
 */

import type { Maybe } from '@dereekb/util';
import { APPROACH_RANGE, isTargetShipOrder, toFollowTolerance, type SceneShip, type SceneVector, type ShipOrder, type ShipOrderType } from '@scene-director/scene';
import { TICKS_PER_MS } from './clock';
import type { EveShip2 } from './runtime';
import { CjsBallparkController, CjsDestinyBall, CjsDestinyClientBall, ITriQuaternionFunction, quat, vec3, type Quat } from './runtime-sim';
import { FleetFrame, FormationGoto, HeadingForward, SETTLE_HOLD, SETTLE_SPEED, type FormationGoto as FormationGotoResult } from './steering';

/**
 * The replica's ego: a fixed ball at the origin, which makes ClientBall samples absolute.
 */
export const REFERENCE_BALL_ID = 1;
export const FIRST_SHIP_BALL_ID = 1000;
/**
 * How far away a heading's goto point is; Destiny's GotoDirection uses the same distance.
 */
const GOTO_DISTANCE = 1e17;
const DEGREES = Math.PI / 180;

/**
 * What a ball flies with.
 */
export interface ShipPhysics {
  /**
   * kg.
   */
  readonly mass: number;
  /**
   * EVE's inertia modifier: align time is -ln(0.25) * mass * agility / 1e6 seconds.
   */
  readonly agility: number;
  /**
   * m/s.
   */
  readonly maxVelocity: number;
  /**
   * m.
   */
  readonly radius: number;
}

/**
 * Cruiser-class physics, for a ship added without any.
 */
export const DEFAULT_SHIP_PHYSICS: ShipPhysics = { mass: 1.1e7, agility: 0.5, maxVelocity: 230, radius: 100 };

/**
 * A hull's class and size, from SOF.
 */
export interface ShipHull {
  readonly category: Maybe<string>;
  /**
   * The SOF bounding-sphere radius, in metres.
   */
  readonly radius: Maybe<number>;
}

/**
 * A ship's authoritative motion, from the master park.
 */
export interface ShipMotion {
  /**
   * The ball centre, metres, rounded to 0.01.
   */
  readonly position: SceneVector;
  /**
   * m/s, rounded to 0.01.
   */
  readonly velocity: SceneVector;
  /**
   * m/s, rounded to 0.1.
   */
  readonly speed: number;
  /**
   * The ball mode: direction and goto orders fly goto, approach and keep-at-range fly follow, orbit flies orbit, and
   * stop flies stop.
   */
  readonly mode: string;
  /**
   * What the ball is flying: the last order applied, or stop when the world ended it (placement, a removed target, a
   * refusal). Stop at first.
   */
  readonly order: ShipOrder;
  /**
   * The order given since the last tick, applying at the next one.
   */
  readonly pendingOrder?: ShipOrder;
  /**
   * Why the world stopped the ship itself, e.g. `stopped: target "x" was removed`; cleared by the next order.
   */
  readonly orderNote?: string;
  /**
   * For an applied approach, keep-at-range or orbit: metres to the target, surface to surface on the two balls' radii
   * (EVE's measure), rounded to 1 m; negative when the balls overlap.
   */
  readonly targetDistance?: number;
  /**
   * The authoritative heading, [yaw, pitch] degrees in the document-rotation convention: Destiny's legacy heading,
   * yaw in [0, 360), rounded to 0.1.
   */
  readonly heading: [number, number];
  /**
   * For a ship following its fleet: metres from its formation slot, rounded to 1 m.
   */
  readonly slotError?: number;
  readonly physics: ShipPhysics;
}

/**
 * What a fleet member flies while following (FleetFollowing gives it).
 */
export interface ShipFollow {
  /**
   * The ship it keeps range on: its resolved fleet anchor.
   */
  readonly anchor: string;
  /**
   * The anchor's range (metres, surface to surface): the range its keep-at-range order reports.
   */
  readonly range: number;
  /**
   * The fleet commander: its heading frames the slot.
   */
  readonly frame: string;
  /**
   * The slot's unit direction from the anchor in the frame (x right, y up, z forward).
   */
  readonly direction: SceneVector;
  /**
   * The slot's range, metres surface to surface.
   */
  readonly slotRange: number;
  /**
   * Fraction of max velocity, (0, 1]; 1 (each member's own speed) unless a later fleet command sets it.
   */
  readonly speed: number;
}

const STOP_ORDER: ShipOrder = { type: 'stop' };

/**
 * The ball mode each order flies in.
 */
const ORDER_MODES: Readonly<Record<ShipOrderType, number>> = {
  direction: CjsDestinyBall.DSTBALLMODE.DSTBALL_GOTO,
  goto: CjsDestinyBall.DSTBALLMODE.DSTBALL_GOTO,
  approach: CjsDestinyBall.DSTBALLMODE.DSTBALL_FOLLOW,
  'keep-at-range': CjsDestinyBall.DSTBALLMODE.DSTBALL_FOLLOW,
  orbit: CjsDestinyBall.DSTBALLMODE.DSTBALL_ORBIT,
  stop: CjsDestinyBall.DSTBALLMODE.DSTBALL_STOP
};

/**
 * The curves a ship's ball drives.
 */
export interface ShipCurves {
  readonly translation: CjsDestinyClientBall;
  readonly rotation: BallRotation;
}

/**
 * The part of a live ship the curves attach to.
 */
export type CurveHost = Pick<EveShip2, 'translationCurve' | 'rotationCurve'>;

/**
 * A ship's rotation curve: the ClientBall's heading times the document's fixed attitude offset.
 */
export class BallRotation extends ITriQuaternionFunction {
  /**
   * The last sample, for framing.
   */
  readonly value: Quat = quat.create();
  /**
   * Post-multiplied onto every sample.
   */
  readonly attitude: Quat = quat.create();
  readonly ball: CjsDestinyClientBall;

  constructor(ball: CjsDestinyClientBall) {
    super();
    this.ball = ball;
  }

  // The base *__Ticks methods pass arguments in the opposite order from their docs, so each one is overridden.
  override Update__Ticks(time: number, out: Quat): Quat {
    this.ball.Update__Ticks(time, out);
    quat.multiply(out, out, this.attitude);
    quat.copy(this.value, out);
    return out;
  }

  override GetValueAt__Ticks(time: number, out: Quat): Quat {
    this.ball.GetValueAt__Ticks(time, out);
    return quat.multiply(out, out, this.attitude);
  }
}

interface ShipEntry {
  readonly id: string;
  readonly ballId: number;
  readonly curves: ShipCurves;
  physics: ShipPhysics;
  /**
   * The order the ball is flying.
   */
  order: ShipOrder;
  /**
   * Why the world stopped the ship itself.
   */
  note: Maybe<string>;
  /**
   * The formation slot it follows; null when it flies its own order.
   */
  follow: Maybe<ShipFollow>;
  /**
   * Whether Steer has applied `follow` since it was set (or since the ship was placed).
   */
  followApplied: boolean;
  /**
   * Whether it sits settled in its slot (mode stop, turning to the fleet heading).
   */
  settled: boolean;
}

/**
 * The page's Destiny simulation: a master and a replica park in lockstep, one ball per document ship.
 */
export class DestinyWorld {
  readonly master: CjsBallparkController;
  readonly replica: CjsBallparkController;
  private readonly ships = new Map<string, ShipEntry>();
  /**
   * Movement orders waiting for the next tick boundary, by ship id; the latest order wins.
   */
  private readonly pending = new Map<string, ShipOrder>();
  private nextBallId = FIRST_SHIP_BALL_ID;

  constructor() {
    this.master = new CjsBallparkController();
    this.master.isMaster = true;
    this.replica = new CjsBallparkController();
    // Both parks get the reference ball, so they hold the same balls.
    this.Both((park) => park.AddBall(REFERENCE_BALL_ID, 1, 0, 0, false, false, false, false, false, 0, 0, 0, 0, 0, 0, 1, 0));
    this.replica.ego = REFERENCE_BALL_ID;
    this.master.ego = REFERENCE_BALL_ID;
  }

  /**
   * Whole Destiny ticks evolved so far.
   *
   * @returns The master park's tick count.
   */
  get tick(): number {
    return this.master.currentTime;
  }

  /**
   * Gives a document ship a ball at rest at its placement. A ship that already has one is re-placed.
   *
   * @param doc - The document ship.
   * @param physics - What it flies with until its hull is known.
   * @throws {Error} When the physics are invalid, or the replica creates no ClientBall.
   */
  AddShip(doc: Pick<SceneShip, 'id' | 'position' | 'rotation'>, physics: ShipPhysics = DEFAULT_SHIP_PHYSICS): void {
    if (!this.ships.has(doc.id)) {
      RequireValidPhysics(physics);
      const ballId = this.nextBallId++;
      const [x, y, z] = doc.position;
      this.Both((park) => park.AddBall(ballId, physics.mass, physics.radius, physics.maxVelocity, true, false, false, true, false, x, y, z, 0, 0, 0, physics.agility, 1));
      const ball = this.replica.GetBall(ballId);
      if (!(ball instanceof CjsDestinyClientBall)) throw new Error(`the replica park did not create a ClientBall for ${doc.id}`);
      this.ships.set(doc.id, { id: doc.id, ballId, curves: { translation: ball, rotation: new BallRotation(ball) }, physics, order: STOP_ORDER, note: null, follow: null, followApplied: false, settled: false });
    }
    this.PlaceShip(doc);
  }

  /**
   * Puts a ship at rest at a placement, facing along its rotation, ending its order. Its followers chase it there. A
   * ship following its fleet keeps following and flies back to its slot from there.
   *
   * @param doc - The document ship.
   */
  PlaceShip(doc: Pick<SceneShip, 'id' | 'position' | 'rotation'>): void {
    const entry = this.ships.get(doc.id);
    if (!entry) return;
    const { ballId } = entry;
    this.pending.delete(doc.id);
    entry.order = STOP_ORDER;
    entry.note = null;
    entry.followApplied = false;
    entry.settled = false;
    const rotation = DocumentRotation(doc.rotation);
    const forward = vec3.transformQuat(vec3.create(), [0, 0, 1], rotation);
    const goto = this.Both((park) => {
      park.Stop(ballId);
      park.SetBallPosition(ballId, ...doc.position);
      const aimed = this.AimAlong(park, ballId, doc.position, forward);
      // Zero velocity snaps the legacy heading to the goto point.
      park.SetBallVelocity(ballId, 0, 0, 0);
      return aimed;
    });
    // The heading Destiny derives from the same goto offsets, then whatever the document adds to it (its roll).
    const [x, y, z] = doc.position;
    const heading = HeadingRotation(goto[0] - x, goto[1] - y, goto[2] - z);
    quat.multiply(entry.curves.rotation.attitude, quat.conjugate(heading, heading), rotation);
  }

  /**
   * Changes what a ship flies with, on both parks.
   *
   * @param id - The ship id.
   * @param physics - The new physics.
   * @throws {Error} When a value is not finite, or not positive (max velocity may be 0); Destiny would stop the whole
   *   park on it.
   */
  SetPhysics(id: string, physics: ShipPhysics): void {
    RequireValidPhysics(physics);
    const entry = this.ships.get(id);
    if (!entry) return;
    const { ballId } = entry;
    this.Both((park) => {
      park.SetBallMass(ballId, physics.mass);
      park.SetBallRadius(ballId, physics.radius);
      park.SetMaxSpeed(ballId, physics.maxVelocity);
      park.SetBallAgility(ballId, physics.agility);
    });
    entry.physics = physics;
  }

  /**
   * Removes a ship's ball from both parks (they drop it on their next tick). Every ship approaching, keeping range on
   * or orbiting it, or with such an order pending, stops at once on both parks first. Ships following it in formation
   * are left to the caller to re-point (Follow) in the same call; Steer halts any it does not.
   *
   * @param id - The ship id.
   * @returns The ids of the ships it stopped, in the order they were added.
   */
  RemoveShip(id: string): string[] {
    const entry = this.ships.get(id);
    if (!entry) return [];
    this.ships.delete(id);
    this.pending.delete(id);
    const stopped: string[] = [];
    for (const other of this.ships.values()) {
      const pending = this.pending.get(other.id);
      const queued = pending !== undefined && TargetOf(pending) === id;
      if (queued) this.pending.delete(other.id);
      if (queued || (!other.follow && TargetOf(other.order) === id)) {
        this.Halt(other, `stopped: target "${id}" was removed`);
        stopped.push(other.id);
      }
    }
    this.Both((park) => park.RemoveBall(entry.ballId));
    return stopped;
  }

  /**
   * Queues a movement order for the next tick boundary. It supersedes following: the ship leaves its formation.
   *
   * @param id - The ship id.
   * @param order - A normalized order.
   * @returns False when no ship has that id, or the order targets the ship itself or an id with no ship.
   */
  Order(id: string, order: ShipOrder): boolean {
    const target = TargetOf(order);
    const entry = this.ships.get(id);
    const valid = entry !== undefined && (!target || (target !== id && this.ships.has(target)));
    if (valid) {
      this.pending.set(id, order);
      entry.follow = null;
      entry.settled = false;
    }
    return valid;
  }

  /**
   * Starts or re-points a ship's following from the next tick boundary, dropping any order it has pending.
   *
   * @param id - The ship id.
   * @param follow - Its anchor, frame and slot.
   * @returns False for an unknown ship, an anchor or frame that is the ship itself, or an anchor or frame with no ball.
   */
  Follow(id: string, follow: ShipFollow): boolean {
    const entry = this.ships.get(id);
    const valid = entry !== undefined && follow.anchor !== id && follow.frame !== id && this.ships.has(follow.anchor) && this.ships.has(follow.frame);
    if (valid) {
      this.pending.delete(id);
      entry.follow = follow;
      entry.followApplied = false;
      entry.settled = false;
    }
    return valid;
  }

  /**
   * Ends a ship's following: it stops at once on both parks.
   *
   * @param id - The ship id.
   * @param note - Why, for its orderNote.
   * @returns Whether the ship was following.
   */
  Unfollow(id: string, note: string): boolean {
    const entry = this.ships.get(id);
    const following = Boolean(entry?.follow);
    if (entry && following) {
      entry.follow = null;
      entry.settled = false;
      this.Halt(entry, note);
    }
    return following;
  }

  /**
   * What a ship flies while following.
   *
   * @param id - The ship id.
   * @returns Its follow, or null when it is not following (or no ship has that id).
   */
  Following(id: string): Maybe<ShipFollow> {
    return this.ships.get(id)?.follow ?? null;
  }

  /**
   * Evolves both parks to `now`. When this call will run a tick, pending orders apply first, then every following
   * ship is steered. The clock caps a frame at 1 s and a tick is 1 s, so a call evolves at most one tick: the steering
   * always precedes the tick it is for, which is why there is one OnTick per call rather than a loop.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @throws {Error} The first park failure, after both parks have had their turn.
   */
  Tick(now: number): void {
    const time = BigInt(Math.round(now));
    if (time - this.master.time >= BigInt(this.master.tickInterval * TICKS_PER_MS)) {
      const orders = [...this.pending];
      this.pending.clear();
      for (const [id, order] of orders) {
        const entry = this.ships.get(id);
        if (entry) this.ApplyOrder(entry, order);
      }
      this.Steer();
    }
    let failure: unknown = null;
    for (const park of [this.master, this.replica]) {
      try {
        park.OnTick(time, time, null);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure instanceof Error ? failure : new Error(String(failure));
  }

  /**
   * The curves a ship's ball drives; the same objects every call, so a rebuilt ship re-attaches to them.
   *
   * @param id - The ship id.
   * @returns The curves, or null when no ship has that id.
   */
  Curves(id: string): Maybe<ShipCurves> {
    return this.ships.get(id)?.curves ?? null;
  }

  /**
   * A ship's authoritative motion.
   *
   * @param id - The ship id.
   * @returns The motion, or null when no ship has that id.
   */
  Motion(id: string): Maybe<ShipMotion> {
    const entry = this.ships.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    if (!entry || !ball) return null;
    const pending = this.pending.get(id) ?? (entry.follow && !entry.followApplied ? FollowOrder(entry.follow) : null);
    const target = TargetOf(entry.order);
    const targetEntry = target ? this.ships.get(target) : null;
    const targetBall = targetEntry ? this.master.GetBall(targetEntry.ballId) : null;
    const slot = entry.follow ? this.Slot(entry, entry.follow) : null;
    return {
      position: [Round(ball.x, 100), Round(ball.y, 100), Round(ball.z, 100)],
      velocity: [Round(ball.vx, 100), Round(ball.vy, 100), Round(ball.vz, 100)],
      speed: Round(Math.hypot(ball.vx, ball.vy, ball.vz), 10),
      mode: ModeName(ball.mode),
      order: entry.order,
      ...(pending ? { pendingOrder: pending } : {}),
      ...(entry.note ? { orderNote: entry.note } : {}),
      ...(targetBall ? { targetDistance: Round(Math.hypot(ball.x - targetBall.x, ball.y - targetBall.y, ball.z - targetBall.z) - ball.radius - targetBall.radius, 1) } : {}),
      heading: [Round(Wrap(ball.mNewYaw / DEGREES, 0), 10) % 360, Round(Wrap(ball.mNewPitch / DEGREES, -180), 10)],
      ...(slot ? { slotError: Round(slot.error, 1) } : {}),
      physics: entry.physics
    };
  }

  /**
   * Re-aims every following ship at its formation slot on both parks, or settles it there (section Following above).
   */
  private Steer(): void {
    for (const entry of this.ships.values()) {
      const follow = entry.follow;
      if (!follow) continue;
      const missing = this.ships.has(follow.frame) ? `anchor "${follow.anchor}"` : `fleet commander "${follow.frame}"`;
      const slot = this.ships.has(follow.anchor) && this.ships.has(follow.frame) ? this.Slot(entry, follow) : null;
      if (!slot) {
        entry.follow = null;
        this.Halt(entry, `stopped: ${missing} was removed`);
        continue;
      }
      if (!entry.followApplied) {
        entry.order = FollowOrder(follow);
        entry.note = null;
        entry.followApplied = true;
      }
      const tolerance = toFollowTolerance({ slotRange: follow.slotRange, anchorSpeed: slot.anchorSpeed });
      const anchorAtRest = slot.anchorSpeed < SETTLE_SPEED;
      if (entry.settled && anchorAtRest && slot.error <= SETTLE_HOLD * tolerance) continue;
      let mode: number;
      if (anchorAtRest && slot.error <= tolerance && slot.memberSpeed < SETTLE_SPEED) {
        this.Settle(entry, slot.forward);
        mode = CjsDestinyBall.DSTBALLMODE.DSTBALL_STOP;
      } else {
        entry.settled = false;
        this.Both((park) => {
          park.SetSpeedFraction(entry.ballId, follow.speed);
          park.GotoPoint(entry.ballId, ...slot.goto);
        });
        mode = CjsDestinyBall.DSTBALLMODE.DSTBALL_GOTO;
      }
      if (this.master.GetBall(entry.ballId)?.mode !== mode || this.replica.GetBall(entry.ballId)?.mode !== mode) {
        console.warn(`ship ${entry.id}: Destiny refused the formation goto, so it stops`);
        entry.follow = null;
        entry.settled = false;
        this.Halt(entry, 'stopped: Destiny refused the formation goto');
      }
    }
  }

  /**
   * A following ship's slot, from the master park.
   *
   * @param entry - The ship.
   * @param follow - What it follows.
   * @returns The slot point, the goto point and the slot error; null when its anchor or frame has no ball.
   */
  private Slot(entry: ShipEntry, follow: ShipFollow): Maybe<FormationGotoResult> {
    const ball = this.master.GetBall(entry.ballId);
    const anchorEntry = this.ships.get(follow.anchor);
    const frameEntry = this.ships.get(follow.frame);
    const anchor = anchorEntry ? this.master.GetBall(anchorEntry.ballId) : null;
    const frame = frameEntry ? this.master.GetBall(frameEntry.ballId) : null;
    if (!ball || !anchor || !frame) return null;
    return FormationGoto({
      anchor: { position: [anchor.x, anchor.y, anchor.z], velocity: [anchor.vx, anchor.vy, anchor.vz], radius: anchor.radius },
      member: { position: [ball.x, ball.y, ball.z], velocity: [ball.vx, ball.vy, ball.vz], radius: ball.radius, maxVelocity: ball.maxVelocity, speed: follow.speed },
      frame: FleetFrame(frame.mNewYaw, frame.mNewPitch),
      direction: follow.direction,
      slotRange: follow.slotRange,
      tickSeconds: this.master.tickInterval / 1000
    });
  }

  /**
   * Settles a following ship in its slot on both parks: it stops, and Destiny's legacy heading then turns it smoothly
   * to the fleet heading. The goto point is aimed along its current heading before the velocity is zeroed, because
   * zero velocity snaps the heading to the goto point; only then is it aimed along the fleet heading.
   *
   * @param entry - The ship.
   * @param forward - The fleet's forward vector.
   */
  private Settle(entry: ShipEntry, forward: ArrayLike<number>): void {
    const ball = this.master.GetBall(entry.ballId);
    if (!ball) return;
    const position = [ball.x, ball.y, ball.z];
    const current = HeadingForward(ball.mNewYaw, ball.mNewPitch);
    this.Both((park) => {
      park.Stop(entry.ballId);
      this.AimAlong(park, entry.ballId, position, current);
      park.SetBallVelocity(entry.ballId, 0, 0, 0);
      this.AimAlong(park, entry.ballId, position, forward);
    });
    entry.settled = true;
  }

  /**
   * Puts a ball's goto point far along a forward vector, so its legacy heading faces that way.
   *
   * @param park - The park.
   * @param ballId - The ball.
   * @param from - The ball's position.
   * @param forward - A unit vector.
   * @returns The goto point.
   */
  private AimAlong(park: CjsBallparkController, ballId: number, from: ArrayLike<number>, forward: ArrayLike<number>): SceneVector {
    const goto: SceneVector = [from[0] + forward[0] * GOTO_DISTANCE, from[1] + forward[1] * GOTO_DISTANCE, from[2] + forward[2] * GOTO_DISTANCE];
    const ball = park.GetBall(ballId);
    if (ball) [ball.gotoX, ball.gotoY, ball.gotoZ] = goto;
    return goto;
  }

  /**
   * Gives an order to both parks; a missing target or Destiny's silent refusal stops the ship instead.
   *
   * @param entry - The ordered ship.
   * @param order - A normalized order.
   */
  private ApplyOrder(entry: ShipEntry, order: ShipOrder): void {
    const { ballId } = entry;
    const target = TargetOf(order);
    const targetBallId = target ? (this.ships.get(target)?.ballId ?? null) : null;
    if (target && targetBallId === null) {
      this.Halt(entry, `stopped: target "${target}" was removed`);
      return;
    }
    this.Both((park) => {
      if (order.type !== 'stop') park.SetSpeedFraction(ballId, order.speed);
      switch (order.type) {
        case 'direction':
          park.GotoDirection(ballId, ...order.direction);
          break;
        case 'goto':
          park.GotoPoint(ballId, ...order.point);
          break;
        case 'approach':
          park.FollowBall(ballId, targetBallId ?? 0, APPROACH_RANGE);
          break;
        case 'keep-at-range':
          park.FollowBall(ballId, targetBallId ?? 0, order.range);
          break;
        case 'orbit':
          park.Orbit(ballId, targetBallId ?? 0, order.range);
          break;
        case 'stop':
          park.Stop(ballId);
          break;
      }
    });
    const mode = ORDER_MODES[order.type];
    if (this.master.GetBall(ballId)?.mode === mode && this.replica.GetBall(ballId)?.mode === mode) {
      entry.order = order;
      entry.note = null;
    } else {
      console.warn(`ship ${entry.id}: Destiny refused the ${order.type} order, so it stops`);
      this.Halt(entry, `stopped: Destiny refused the ${order.type} order`);
    }
  }

  /**
   * Stops a ship on both parks and records why.
   *
   * @param entry - The ship.
   * @param note - Why the world stopped it.
   */
  private Halt(entry: ShipEntry, note: string): void {
    this.Both((park) => park.Stop(entry.ballId));
    entry.order = STOP_ORDER;
    entry.note = note;
  }

  /**
   * Applies a change to the master, then the replica.
   *
   * @param change - Called with each park.
   * @returns What the change returned for the master.
   */
  private Both<T>(change: (park: CjsBallparkController) => T): T {
    const result = change(this.master);
    change(this.replica);
    return result;
  }
}

/**
 * Makes a ship's ball drive its curves.
 *
 * @param ship - The live ship.
 * @param curves - Its ball's curves.
 */
export function AttachShipCurves(ship: CurveHost, curves: ShipCurves): void {
  ship.translationCurve = curves.translation;
  ship.rotationCurve = curves.rotation;
}

/**
 * A document rotation as a quaternion: yaw about +Y, then pitch about +X, then roll about +Z.
 *
 * @param rotation - [yaw, pitch, roll] in degrees.
 * @returns The quaternion.
 */
export function DocumentRotation(rotation: ArrayLike<number>): Quat {
  return quat.fromYawPitchRoll(quat.create(), rotation[0] * DEGREES, rotation[1] * DEGREES, rotation[2] * DEGREES);
}

/**
 * A ball mode's name.
 *
 * @param mode - A DSTBALLMODE value.
 * @returns Its lower-case name without the DSTBALL_ prefix, e.g. "goto".
 */
export function ModeName(mode: number): string {
  return MODE_NAMES.get(mode) ?? `mode ${mode}`;
}

const MODE_NAMES = new Map(Object.entries(CjsDestinyBall.DSTBALLMODE).map(([name, value]) => [value, name.replace(/^DSTBALL_/u, '').toLowerCase()]));

/**
 * The legacy heading Destiny gives a ball at rest facing an offset: yaw atan2(x, z), pitch -asin(y / r), no roll.
 *
 * @param x - The offset's x.
 * @param y - The offset's y.
 * @param z - The offset's z.
 * @returns The heading.
 */
function HeadingRotation(x: number, y: number, z: number): Quat {
  const length = Math.hypot(x, y, z);
  return quat.fromYawPitchRoll(quat.create(), Math.atan2(x, z), length > 0 ? -Math.asin(Math.min(1, Math.max(-1, y / length))) : 0, 0);
}

function RequireValidPhysics(physics: ShipPhysics): void {
  const bad = (['mass', 'agility', 'maxVelocity', 'radius'] as const).filter((key) => {
    const value = physics[key];
    return !Number.isFinite(value) || value < 0 || (value === 0 && key !== 'maxVelocity');
  });
  if (bad.length) throw new Error(`ship physics must be finite and positive (max velocity may be 0): ${bad.join(', ')}`);
}

/**
 * The ship an order flies relative to.
 *
 * @param order - A normalized order.
 * @returns The target's id, or null for an order without one.
 */
function TargetOf(order: ShipOrder): Maybe<string> {
  return isTargetShipOrder(order) ? order.target : null;
}

/**
 * The keep-at-range order a following ship reports: on its anchor at the anchor's range.
 *
 * @param follow - What it follows.
 * @returns The order.
 */
function FollowOrder(follow: ShipFollow): ShipOrder {
  return { type: 'keep-at-range', target: follow.anchor, range: follow.range, speed: follow.speed };
}

/**
 * An angle in degrees wrapped to one turn from `from`.
 *
 * @param degrees - The angle.
 * @param from - The lower bound, inclusive.
 * @returns The angle in [from, from + 360).
 */
function Wrap(degrees: number, from: number): number {
  return ((((degrees - from) % 360) + 360) % 360) + from;
}

function Round(value: number, scale: number): number {
  return Math.round(value * scale) / scale + 0;
}
