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
 * - Warp. A warp order is Destiny's WarpTo on both parks at the ship's warp speed (warp.ts: factor = 1000 × AU/s) and
 *   speed fraction 1 (Destiny only enters warp at 75 % of max velocity). The phases are read from the master after
 *   each evolved tick: aligning (warp mode, effectStamp < 0), in proper warp (warping, then exiting), landed (Destiny
 *   dropped it to stop). Nothing may stop a ball in proper warp but a placement: Destiny's orders only switch its mode
 *   and it coasts on at warp speed, so OrderRefusal refuses orders in warp, Halt leaves a warping ship alone and
 *   Steer skips it. Destiny's exit makes the ball massive, so a landed ship is set non-massive again on both parks.
 *   In warp the drawn ship runs up to a tick ahead of the master; both reach the exit point at the tick OnWarp
 *   reports. A fleet member holds (stopped) while its anchor or FC is in proper warp, as Destiny's StopAllFollowers
 *   does, and flies to its slot after the landing.
 */

import type { Maybe } from '@dereekb/util';
import { APPROACH_RANGE, isTargetShipOrder, MIN_WARP_DISTANCE, shipOrderTarget, toFollowTolerance, type SceneShip, type SceneVector, type ShipOrder, type ShipOrderType } from '@scene-director/scene';
import { TICKS_PER_MS } from './clock';
import type { EveShip2 } from './runtime';
import { CjsBallparkController, CjsDestinyBall, CjsDestinyClientBall, ITriQuaternionFunction, quat, vec3, type Quat } from './runtime-sim';
import { FleetFrame, FormationGoto, HeadingForward, SETTLE_HOLD, SETTLE_SPEED, type FormationGoto as FormationGotoResult } from './steering';
import { DEFAULT_WARP_SPEED, LandingPoint, WarpExitTime, WarpFactor, WarpLength, WarpPhaseAt, type WarpProfile } from './warp';

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
  /**
   * AU/s; DEFAULT_WARP_SPEED when absent.
   */
  readonly warpSpeed?: number;
}

/**
 * Cruiser-class physics, for a ship added without any.
 */
export const DEFAULT_SHIP_PHYSICS: ShipPhysics = { mass: 1.1e7, agility: 0.5, maxVelocity: 230, radius: 100, warpSpeed: DEFAULT_WARP_SPEED };

/**
 * A warp's phase: aligning (flying at full speed toward the destination until 75 % of max velocity on its heading,
 * or 180 ticks), warping (accelerating and cruising in warp), exiting (slowing out of warp), landed (out of warp; it
 * coasts to a halt).
 */
export type WarpPhase = 'aligning' | 'warping' | 'exiting' | 'landed';

/**
 * A warp order's progress, from the master park.
 */
export interface ShipWarp {
  readonly phase: WarpPhase;
  /**
   * Where it lands, metres (0.01): from warp start on, Destiny's landing point; while aligning, where it would land if
   * warp began now.
   */
  readonly landing: SceneVector;
  /**
   * AU/s: the warp speed it flies (its warp factor / 1000).
   */
  readonly warpSpeed: number;
  /**
   * Aligning only: ticks spent aligning (Destiny warps anyway after 180).
   */
  readonly alignTicks?: number;
  /**
   * From warp start on: metres from where warp began to the landing point (1 m).
   */
  readonly distance?: number;
  /**
   * Metres to the landing point (1 m); after landing, how far it ended from it.
   */
  readonly remaining: number;
  /**
   * Share of the warp distance covered, 0 to 1 (0.001): 0 while aligning, 1 once landed.
   */
  readonly progress: number;
  /**
   * Warping and exiting only: whole seconds until it drops out of warp, from Destiny's warp profile.
   */
  readonly landsIn?: number;
}

export type WarpEventKind = 'enter' | 'exit';

/**
 * A ship entering or leaving proper warp (OnWarp).
 */
export interface WarpEvent {
  readonly kind: WarpEventKind;
  readonly id: string;
  /**
   * The master's tick count after the evolve it happened in.
   */
  readonly tick: number;
  /**
   * Metres (0.01): where warp began (enter), or the master position one tick past the exit point (exit); the drawn
   * ship is at the exit point on that frame.
   */
  readonly position: SceneVector;
  /**
   * m/s (0.01).
   */
  readonly velocity: SceneVector;
  /**
   * Unit vector from where warp began to the landing point.
   */
  readonly direction: SceneVector;
  readonly landing: SceneVector;
  /**
   * AU/s.
   */
  readonly warpSpeed: number;
}

export type WarpListener = (event: WarpEvent) => void;

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
  /**
   * While a warp order is in force (from apply until the next order, a placement or a follow taking over).
   */
  readonly warp?: ShipWarp;
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
  warp: CjsDestinyBall.DSTBALLMODE.DSTBALL_WARP,
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

interface WarpStart {
  readonly from: SceneVector;
  readonly landing: SceneVector;
  readonly distance: number;
  /**
   * The ball's effectStamp: the tick proper warp began.
   */
  readonly stamp: number;
  readonly profile: WarpProfile;
}

interface WarpEntry {
  /**
   * The resolved destination: the order's point, or the target ship's centre when the order applied.
   */
  readonly destination: SceneVector;
  /**
   * Destiny's minRange, metres back from the destination: the order's range, plus both EVE radii for a ship.
   */
  readonly range: number;
  /**
   * Destiny's warp factor; SetPhysics updates it while the ship aligns.
   */
  factor: number;
  /**
   * The master position at the latest tick boundary while aligning: where warp begins if the next evolve starts it.
   */
  lastAlign: SceneVector;
  start: Maybe<WarpStart>;
  /**
   * The tick it dropped out of warp.
   */
  landed: Maybe<number>;
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
  /**
   * Its warp order's state, while one is in force.
   */
  warp: Maybe<WarpEntry>;
  /**
   * The warping ship (its anchor or FC) a following ship holds for, stopped.
   */
  held: Maybe<string>;
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
  private readonly warpListeners = new Set<WarpListener>();
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
      this.ships.set(doc.id, { id: doc.id, ballId, curves: { translation: ball, rotation: new BallRotation(ball) }, physics, order: STOP_ORDER, note: null, follow: null, followApplied: false, settled: false, warp: null, held: null });
    }
    this.PlaceShip(doc);
  }

  /**
   * Puts a ship at rest at a placement, facing along its rotation, ending its order (a warp too, with no exit event).
   * Its followers chase it there. A ship following its fleet keeps following and flies back to its slot from there.
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
    entry.warp = null;
    entry.held = null;
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
   * Changes what a ship flies with, on both parks. A new warp speed reaches a ship that is aligning; once in warp its
   * warp speed is fixed, as in EVE.
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
    const factor = WarpFactor(physics.warpSpeed ?? DEFAULT_WARP_SPEED);
    if (entry.warp && !entry.warp.start && factor !== entry.warp.factor && this.master.GetBall(ballId)?.IsAligningForWarp()) {
      this.Both((park) => {
        const ball = park.GetBall(ballId);
        if (ball) ball.ownerId = factor;
      });
      entry.warp.factor = factor;
    }
  }

  /**
   * Removes a ship's ball from both parks (they drop it on their next tick). Every ship approaching, keeping range on
   * or orbiting it, or with such an order (or a warp to it) pending, stops at once on both parks first. A warp to it
   * that already applied flies on to where it was. Ships following it in formation
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
      const queued = pending !== undefined && shipOrderTarget(pending) === id;
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
   * @returns False when OrderRefusal refuses it.
   */
  Order(id: string, order: ShipOrder): boolean {
    const entry = this.ships.get(id);
    const valid = entry !== undefined && this.OrderRefusal(id, order) === null;
    if (valid) {
      this.pending.set(id, order);
      entry.follow = null;
      entry.settled = false;
      entry.held = null;
    }
    return valid;
  }

  /**
   * Why Order would refuse an order, from the master's current state.
   *
   * @param id - The ship id.
   * @param order - A normalized order.
   * @returns The reason, or null when Order takes it: no ship (or a target that is itself or has no ball), a ship in
   *   proper warp (any order), and for a warp a max velocity of 0, a target in warp, or a landing under
   *   MIN_WARP_DISTANCE away.
   */
  OrderRefusal(id: string, order: ShipOrder): Maybe<string> {
    const entry = this.ships.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    const target = shipOrderTarget(order);
    const targetEntry = target && target !== id ? this.ships.get(target) : undefined;
    const targetBall = targetEntry ? this.master.GetBall(targetEntry.ballId) : null;
    let refusal: Maybe<string> = null;
    if (!entry || !ball || (target && !targetBall)) {
      refusal = `ship "${id}" or its target has no Destiny ball`;
    } else if (ball.IsWarping()) {
      const landsIn = this.WarpReport(entry, ball)?.landsIn;
      const when = landsIn === undefined ? '' : `, in about ${landsIn} s`;
      refusal = `ship "${id}" is in warp; it takes orders again once it lands${when}`;
    } else if (order.type === 'warp') {
      const destination: SceneVector = 'point' in order ? order.point : [targetBall?.x ?? 0, targetBall?.y ?? 0, targetBall?.z ?? 0];
      const range = order.range + (targetBall ? ball.radius + targetBall.radius : 0);
      const length = WarpLength(destination, range, [ball.x, ball.y, ball.z]);
      if (!(ball.maxVelocity > 0)) refusal = `ship "${id}" cannot warp: its max velocity is 0`;
      else if (targetBall?.IsWarping()) refusal = `target "${target}" is in warp`;
      else if (length < MIN_WARP_DISTANCE) refusal = `ship "${id}" would land ${Round(Math.max(0, length) / 1000, 10)} km away; EVE warps only ${MIN_WARP_DISTANCE / 1000} km or more, so use goto`;
    }
    return refusal;
  }

  /**
   * Calls a listener after every tick a ship enters or leaves proper warp, once both parks evolved and the exit was
   * fixed up. A placement that ends a warp emits nothing. A throwing listener is logged and the rest still run.
   *
   * @param listener - Called with each event.
   * @returns The unsubscribe.
   */
  OnWarp(listener: WarpListener): () => void {
    this.warpListeners.add(listener);
    return () => {
      this.warpListeners.delete(listener);
    };
  }

  /**
   * The warping ship a following ship holds for.
   *
   * @param id - The ship id.
   * @returns Its anchor or FC while that ship is in proper warp and this one is held, else null.
   */
  FollowHold(id: string): Maybe<string> {
    return this.ships.get(id)?.held ?? null;
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
      entry.held = null;
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
      entry.held = null;
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
   * always precedes the tick it is for, which is why there is one OnTick per call rather than a loop. After an evolved
   * tick the warps are tracked and OnWarp's listeners called.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @throws {Error} The first park failure, after both parks have had their turn.
   */
  Tick(now: number): void {
    const time = BigInt(Math.round(now));
    const due = time - this.master.time >= BigInt(this.master.tickInterval * TICKS_PER_MS);
    if (due) {
      const orders = [...this.pending];
      this.pending.clear();
      for (const [id, order] of orders) {
        const entry = this.ships.get(id);
        if (entry) this.ApplyOrder(entry, order);
      }
      this.Steer();
      this.MarkAligning();
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
    if (due) this.TrackWarps();
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
    const warp = this.WarpReport(entry, ball);
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
      ...(warp ? { warp } : {}),
      physics: entry.physics
    };
  }

  /**
   * Re-aims every following ship at its formation slot on both parks, or settles it there (section Following above).
   * A following ship in proper warp finishes its warp first; one whose anchor or FC is in proper warp holds, stopped,
   * until that ship lands.
   */
  private Steer(): void {
    for (const entry of this.ships.values()) {
      const follow = entry.follow;
      if (!follow || this.InProperWarp(entry)) continue;
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
        entry.warp = null;
        entry.followApplied = true;
      }
      const warping = [follow.anchor, follow.frame].find((other) => this.InProperWarp(this.ships.get(other)));
      if (warping) {
        if (entry.held !== warping) this.Both((park) => park.Stop(entry.ballId));
        entry.held = warping;
        entry.settled = false;
        continue;
      }
      entry.held = null;
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
   * Gives an order to both parks; a missing target or Destiny's silent refusal stops the ship instead. An order that
   * finds the ship in proper warp is dropped (OrderRefusal keeps Order from queueing one).
   *
   * @param entry - The ordered ship.
   * @param order - A normalized order.
   */
  private ApplyOrder(entry: ShipEntry, order: ShipOrder): void {
    const { ballId } = entry;
    const ball = this.master.GetBall(ballId);
    if (!ball) return;
    if (ball.IsWarping()) {
      entry.note = `dropped: the ${order.type} order came after it entered warp`;
      return;
    }
    const target = shipOrderTarget(order);
    const targetEntry = target ? this.ships.get(target) : undefined;
    const targetBall = targetEntry ? this.master.GetBall(targetEntry.ballId) : null;
    if (target && (!targetEntry || !targetBall)) {
      this.Halt(entry, `stopped: target "${target}" was removed`);
      return;
    }
    const targetBallId = targetEntry?.ballId ?? 0;
    let warp: Maybe<WarpEntry> = null;
    if (order.type === 'warp') {
      // Computed once from the master, outside Both: WarpTo throws for a bad factor, which would leave the replica behind.
      const destination: SceneVector = 'point' in order ? order.point : [targetBall?.x ?? 0, targetBall?.y ?? 0, targetBall?.z ?? 0];
      const range = order.range + (targetBall ? ball.radius + targetBall.radius : 0);
      warp = { destination, range, factor: WarpFactor(entry.physics.warpSpeed ?? DEFAULT_WARP_SPEED), lastAlign: [ball.x, ball.y, ball.z], start: null, landed: null };
    }
    this.Both((park) => {
      if (order.type !== 'stop') park.SetSpeedFraction(ballId, 'speed' in order ? order.speed : 1);
      switch (order.type) {
        case 'direction':
          park.GotoDirection(ballId, ...order.direction);
          break;
        case 'goto':
          park.GotoPoint(ballId, ...order.point);
          break;
        case 'approach':
          park.FollowBall(ballId, targetBallId, APPROACH_RANGE);
          break;
        case 'keep-at-range':
          park.FollowBall(ballId, targetBallId, order.range);
          break;
        case 'orbit':
          park.Orbit(ballId, targetBallId, order.range);
          break;
        case 'warp':
          if (warp) park.WarpTo(ballId, ...warp.destination, warp.range, warp.factor);
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
      entry.warp = warp;
    } else {
      console.warn(`ship ${entry.id}: Destiny refused the ${order.type} order, so it stops`);
      this.Halt(entry, `stopped: Destiny refused the ${order.type} order`);
    }
  }

  /**
   * Stops a ship on both parks and records why. A ship in proper warp only records why: nothing stops it but a
   * placement, so it keeps its warp order and stops when it lands.
   *
   * @param entry - The ship.
   * @param note - Why the world stopped it.
   */
  private Halt(entry: ShipEntry, note: string): void {
    entry.note = note;
    if (this.InProperWarp(entry)) return;
    this.Both((park) => park.Stop(entry.ballId));
    entry.order = STOP_ORDER;
    entry.warp = null;
  }

  /**
   * Whether a ship's master ball is in proper warp (past aligning, not yet dropped out).
   *
   * @param entry - The ship.
   * @returns False for no ship.
   */
  private InProperWarp(entry: Maybe<ShipEntry>): boolean {
    return entry ? (this.master.GetBall(entry.ballId)?.IsWarping() ?? false) : false;
  }

  /**
   * Notes where every aligning ship is at this tick boundary: where its warp begins if the next evolve starts it.
   */
  private MarkAligning(): void {
    for (const entry of this.ships.values()) {
      const ball = entry.warp && !entry.warp.start ? this.master.GetBall(entry.ballId) : null;
      if (entry.warp && ball) entry.warp.lastAlign = [ball.x, ball.y, ball.z];
    }
  }

  /**
   * After an evolved tick: notes each warp that began or ended on the master, sets landed ships non-massive again on
   * both parks (Destiny's exit makes them massive), then calls the OnWarp listeners.
   */
  private TrackWarps(): void {
    const events: WarpEvent[] = [];
    for (const entry of this.ships.values()) {
      const warp = entry.warp;
      const ball = warp?.landed === null ? this.master.GetBall(entry.ballId) : null;
      if (!warp || !ball) continue;
      if (!warp.start && ball.IsWarping()) {
        const landing: SceneVector = [ball.gotoX, ball.gotoY, ball.gotoZ];
        const distance = Distance(landing, warp.lastAlign);
        warp.start = { from: warp.lastAlign, landing, distance, stamp: ball.effectStamp, profile: this.master.SetupWarpConstants(warp.factor, distance, {}) };
        events.push(this.WarpEventOf('enter', entry, warp, ball));
      } else if (warp.start && !ball.IsWarpish()) {
        warp.landed = this.master.currentTime;
        this.Both((park) => park.SetBallMassive(entry.ballId, false));
        events.push(this.WarpEventOf('exit', entry, warp, ball));
      } else if (!warp.start && !ball.IsWarpish()) {
        console.warn(`ship ${entry.id}: its warp ended while aligning, so it stops`);
        entry.warp = null;
        this.Halt(entry, 'stopped: the warp ended while aligning');
      }
    }
    for (const event of events) {
      for (const listener of this.warpListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error(`an OnWarp listener failed on ship ${event.id}'s warp ${event.kind}`, error);
        }
      }
    }
  }

  /**
   * An OnWarp event for a warp that has started.
   *
   * @param kind - Entering or leaving warp.
   * @param entry - The ship.
   * @param warp - Its warp, with a start.
   * @param ball - Its master ball.
   * @returns The event: at where warp began (enter) or the ball (exit).
   */
  private WarpEventOf(kind: WarpEventKind, entry: ShipEntry, warp: WarpEntry, ball: CjsDestinyBall): WarpEvent {
    const { from, landing, distance } = warp.start ?? { from: warp.lastAlign, landing: warp.destination, distance: 0 };
    const scale = distance > 0 ? 1 / distance : 0;
    return {
      kind,
      id: entry.id,
      tick: this.master.currentTime,
      position: RoundVector(kind === 'enter' ? from : [ball.x, ball.y, ball.z], 100),
      velocity: RoundVector([ball.vx, ball.vy, ball.vz], 100),
      direction: [(landing[0] - from[0]) * scale, (landing[1] - from[1]) * scale, (landing[2] - from[2]) * scale],
      landing: RoundVector(landing, 100),
      warpSpeed: warp.factor / 1000
    };
  }

  /**
   * A ship's warp progress (ShipMotion.warp).
   *
   * @param entry - The ship.
   * @param ball - Its master ball.
   * @returns The report, or null without a warp order in force.
   */
  private WarpReport(entry: ShipEntry, ball: CjsDestinyBall): Maybe<ShipWarp> {
    const warp = entry.warp;
    if (!warp) return null;
    const position = [ball.x, ball.y, ball.z];
    const warpSpeed = warp.factor / 1000;
    let report: ShipWarp;
    if (warp.start) {
      const { landing, distance, profile, stamp } = warp.start;
      const remaining = Distance(landing, position);
      const common = { landing: RoundVector(landing, 100), warpSpeed, distance: Round(distance, 1), remaining: Round(remaining, 1) };
      if (warp.landed === null) {
        const t = (this.master.currentTime - 1 - stamp) * this.master.dt;
        const exit = WarpExitTime(profile, ball.maxVelocity, this.master.dt);
        const progress = distance > 0 ? Math.min(1, Math.max(0, 1 - remaining / distance)) : 1;
        report = { phase: WarpPhaseAt(profile, t), ...common, progress: Round(progress, 1000), ...(Number.isFinite(exit) ? { landsIn: Math.max(0, Math.round(exit - t)) } : {}) };
      } else {
        report = { phase: 'landed', ...common, progress: 1 };
      }
    } else {
      const landing = LandingPoint(warp.destination, warp.range, position);
      report = { phase: 'aligning', landing: RoundVector(landing, 100), warpSpeed, alignTicks: Math.max(0, -1 - ball.effectStamp), remaining: Round(Distance(landing, position), 1), progress: 0 };
    }
    return report;
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
  const bad: string[] = (['mass', 'agility', 'maxVelocity', 'radius'] as const).filter((key) => {
    const value = physics[key];
    return !Number.isFinite(value) || value < 0 || (value === 0 && key !== 'maxVelocity');
  });
  const { warpSpeed } = physics;
  if (warpSpeed !== undefined && (!(warpSpeed > 0) || !IsWarpFactor(warpSpeed))) bad.push('warpSpeed');
  if (bad.length) throw new Error(`ship physics must be finite and positive (max velocity may be 0): ${bad.join(', ')}`);
}

function IsWarpFactor(warpSpeed: number): boolean {
  let valid = true;
  try {
    WarpFactor(warpSpeed);
  } catch {
    valid = false;
  }
  return valid;
}

function Distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function RoundVector(vector: ArrayLike<number>, scale: number): SceneVector {
  return [Round(vector[0], scale), Round(vector[1], scale), Round(vector[2], scale)];
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
