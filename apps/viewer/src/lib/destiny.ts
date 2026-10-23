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
 * - Scene epoch (SetSceneEpoch, at every load). Destiny's legacy orbit turns its plane by the park's absolute tick and
 *   seeds it with the ball id's low 16 bits. From the epoch on, the parks (ScenePark) count orbit time from the load,
 *   and a ship's ball id has its document id's hash as its low 16 bits, so an orbit given at the same tick since the
 *   load flies the same in every timeline replay. Every other order is time-invariant as Destiny has it (spec'd).
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
 * - Objects. A scene object (a station, gate, structure or wreck) or a celestial target of the location is a static
 *   ball on both parks: not free, not massive (nothing collides; ships are not massive either), not interactive, from
 *   the ship ball counter, sized by its SDE radius. Approach, keep-at-range, orbit and warp take an object id as
 *   their target; following and fleet anchors stay ships. Removing an object halts the ships flying at it, as
 *   removing a ship does. FollowBall and Orbit refuse a target in another bubble on the master only (the replica has
 *   no bubbles), so OrderRefusal refuses one up front rather than letting the parks diverge.
 * - Warp. A warp order is Destiny's WarpTo on both parks at the ship's warp speed (warp.ts: factor = 1000 × AU/s) and
 *   speed fraction 1 (Destiny only enters warp at 75 % of max velocity). The phases are read from the master after
 *   each evolved tick: aligning (warp mode, effectStamp < 0), in proper warp (warping, then exiting), landed (Destiny
 *   dropped it to stop). Nothing may stop a ball in proper warp but a placement: Destiny's orders only switch its mode
 *   and it coasts on at warp speed, so OrderRefusal refuses orders in warp, Halt leaves a warping ship alone and
 *   Steer skips it. Destiny's exit makes the ball massive, so a landed ship is set non-massive again on both parks.
 *   In warp the drawn ship runs up to a tick ahead of the master; both reach the exit point at the tick OnWarp
 *   reports. A fleet member holds (stopped) while its anchor or FC is in proper warp, as Destiny's StopAllFollowers
 *   does, and flies to its slot after the landing; a fleet member warping in formation keeps its follow.
 * - Formation warps (WarpInFormation, order_fleet's fleet warp). A fleet member warps to its slot: its offset from its
 *   leader's landing in the warp's heading frame (WarpFrame: the leader faces its landing in warp and after it), or
 *   from the leader itself when the leader has no warp in force (a regroup). The slot point is resolved at the tick
 *   boundary right after the plain pending orders, so the leader's warp has applied, and flown as an ordinary warp to a
 *   point (ApplyOrder); Steer then leaves the ship alone until it, its leader, its anchor and its frame ship have all
 *   finished their warps, and it follows again from where it landed.
 * - Prop mods. A running module flies the physics' `propMod` mass and max velocity on both parks (SetBallMass and
 *   SetMaxSpeed, the EVE server's own path); Destiny then accelerates or slows the ball at its agility. SwitchPropMod
 *   follows EVE's module rules: switching on applies at the next tick boundary, before the pending orders and Steer;
 *   switching off waits for the end of the running cycle (rounded up to a tick). SetPropModActive (the document's
 *   state) applies at once, like a placement. Entering proper warp switches a running module off; it stays off after
 *   landing. Steer and the orders read the master ball's live max velocity, so following and orders need nothing more.
 *   OnPropMod reports every on and off after the tick (or the call) that made it.
 * - Tackle (SetTackle: the director's reasons, from the target's warp scramble status and the scrams on it). A ship
 *   that cannot warp is refused warp orders; a pending or delayed warp is dropped at its boundary; a warp still
 *   aligning is cancelled into a direction order along it (a formation-warp member drops its formation warp and
 *   follows again). A ship whose microwarpdrive is blocked has it switched off at once and refused switching on; it
 *   stays off when the scram ends. Tackle is module state: a placement keeps it.
 * - Arrivals (Arrive: a ship landing from warp, Destiny's EntityWarpIn). The ship waits parked at rest off-grid, facing
 *   its landing; at its scheduled boundary (after the formation warps, before Steer) it enters proper warp there at
 *   once, with no align, its start backdated WARP_IN_BACKDATE_TICKS, and lands like any warp. While it waits or warps
 *   it takes no orders, no prop mod and no formation warp, is no one's target, and Steer leaves it alone; a follower
 *   that landed holds, stopped, until its group's leader, its anchor and its frame ship have landed too, then follows.
 *   A follower whose anchor or FC is still arriving holds as it does for a warping one. A placement ends an arrival.
 * - Missiles (LaunchMissile). A missile is a ball on both parks from the same counter, launched by the server's own
 *   LaunchMissile (aimed, non-massive) and pursuing its target with MissileFollow. Destiny's own completion needs a
 *   massive target and a PyOS host, so after each evolve the page runs the contact itself on the master balls: expiry
 *   first (the whole-tick floor / ceil rule), then a lost shooter (it vanishes), a lost target (Destiny turned it: it
 *   flies on to its expiry), then Destiny's swept CollideTwoSpheres. An ended ball flies on straight and leaves both
 *   parks MISSILE_BALL_LINGER_TICKS boundaries later, for the drawn missile.
 */

import type { Maybe } from '@dereekb/util';
import { APPROACH_RANGE, formatSceneDistance, isTargetShipOrder, MIN_WARP_DISTANCE, NO_FALLOFF_METRES, shipOrderTarget, toFollowTolerance, unitHash, type SceneShip, type SceneVector, type ShipOrder, type ShipOrderType } from '@scene-director/scene';
import { TICKS_PER_MS } from './clock';
import { CapturePark, RestorePark, type ParkSnapshot } from './destiny-snapshot';
import { CycleEnd } from './module-cycle';
import type { EveShip2 } from './runtime';
import { CjsBallparkController, CjsDestinyBall, CjsDestinyClientBall, CollideTwoSpheres, ITriQuaternionFunction, quat, vec3, type Quat } from './runtime-sim';
import { CaptureFields, CloneState, RestoreFields, type CaptureOptions, type CapturedFields } from './state-capture';
import { FleetFrame, FormationGoto, FramePoint, HeadingForward, SETTLE_HOLD, SETTLE_SPEED, WarpFrame, type FormationGoto as FormationGotoResult } from './steering';
import { DEFAULT_WARP_SPEED, LandingPoint, WarpExitTime, WarpFactor, WarpInBackdate, WarpInExitTicks, WarpLength, WarpPhaseAt, type WarpProfile, type WarpProfileDistances } from './warp';

export { CycleEnd } from './module-cycle';
export { WARP_IN_BACKDATE_TICKS } from './warp';

/**
 * The replica's ego: a fixed ball at the origin, which makes ClientBall samples absolute.
 */
export const REFERENCE_BALL_ID = 1;
export const FIRST_SHIP_BALL_ID = 1000;

/**
 * A seeded ship ball id's low part (SetSceneEpoch): Destiny's legacy orbit seeds its plane with the id's low 16 bits.
 */
const BALL_ID_SEED_SPAN = 0x10000;

/**
 * A Destiny park whose legacy orbit plane precesses from the scene's epoch (the last load) rather than the park's first
 * tick: EVE turns the plane by `currentTime × 0.001` rad, which is the only use EvolveOldStyleOrbit makes of the time.
 * Everything else is the runtime's.
 */
class ScenePark extends CjsBallparkController {
  /**
   * The park tick orbit time counts from (DestinyWorld.SetSceneEpoch).
   */
  orbitEpoch = 0;

  override EvolveOldStyleOrbit(ball: CjsDestinyBall, currentTime: number): void {
    super.EvolveOldStyleOrbit(ball, currentTime - this.orbitEpoch);
  }
}
/**
 * A static object ball's mass: it is neither free nor massive, so Destiny never reads it.
 */
const OBJECT_BALL_MASS = 1;
/**
 * How far away a heading's goto point is; Destiny's GotoDirection uses the same distance.
 */
const GOTO_DISTANCE = 1e17;
const INT32_MAX = 2 ** 31 - 1;
const MISSILE_MODE = CjsDestinyBall.DSTBALLMODE.DSTBALL_MISSILE;
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
  /**
   * The prop mod's running numbers; the ship flies them while the module runs. Absent: no prop mod.
   */
  readonly propMod?: ShipPropMod;
}

/**
 * What a ship flies while its prop mod runs.
 */
export interface ShipPropMod {
  /**
   * kg, the module's mass addition included.
   */
  readonly mass: number;
  /**
   * m/s.
   */
  readonly maxVelocity: number;
  /**
   * Seconds per cycle; a switched-off module stops at the end of its running cycle.
   */
  readonly cycleTime: number;
}

/**
 * A prop mod's state: off; activating (switched on, applying at the next tick); active (running); stopping (switched
 * off, running until its cycle ends).
 */
export type PropModState = 'off' | 'activating' | 'active' | 'stopping';

/**
 * A ship's prop mod in ShipMotion.
 */
export interface ShipPropModReport {
  readonly state: PropModState;
  /**
   * Whether the ship flies the module's numbers now (active or stopping, with a prop mod in its physics).
   */
  readonly running: boolean;
  /**
   * Seconds per cycle; absent when the physics carry no prop mod.
   */
  readonly cycleTime?: number;
  /**
   * The tick the running module started.
   */
  readonly since?: number;
  /**
   * The tick an activation applies at (activating).
   */
  readonly at?: number;
  /**
   * Seconds until a stopping module stops.
   */
  readonly stopsIn?: number;
  /**
   * A switch the pilot has yet to make (switch_prop_mods with a delay): on or off, in about respondsIn seconds.
   */
  readonly queued?: { readonly on: boolean; readonly respondsIn: number };
  /**
   * Why it is off, e.g. `off: entered warp`.
   */
  readonly note?: string;
}

/**
 * Why a prop mod changed: a live switch, the document's state, entering warp, or a warp scrambler.
 */
export type PropModCause = 'switch' | 'document' | 'warp' | 'tackle' | 'destroyed';

/**
 * A prop mod starting (on) or stopping (off).
 */
export interface PropModEvent {
  readonly kind: 'on' | 'off';
  readonly id: string;
  readonly tick: number;
  readonly cause: PropModCause;
}

export type PropModListener = (event: PropModEvent) => void;

/**
 * A switch's state after the call: activating with the tick it applies at, stopping with when it stops, or unchanged.
 */
export interface PropModSwitchResult {
  readonly state: PropModState;
  /**
   * Seconds until a delayed switch is made (the pilot's response); the state is the one before it.
   */
  readonly respondsIn?: number;
  readonly at?: number;
  readonly stopsAt?: number;
  readonly stopsIn?: number;
}

/**
 * What tackle stops a ship doing (SetTackle): the director's reasons, null for what it may do.
 */
export interface ShipTackle {
  /**
   * Why it cannot warp (its warp scramble status is above 0); null when it can.
   */
  readonly warp: Maybe<string>;
  /**
   * Why its prop mod cannot run (a warp scrambler on its microwarpdrive); null when it can.
   */
  readonly propMod: Maybe<string>;
}

const FREE: ShipTackle = { warp: null, propMod: null };

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
  /**
   * A warp-in (Arrive): it began in proper warp, with no align.
   */
  readonly arrival?: true;
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
  /**
   * A warp-in (Arrive): no warp-out; `position` is where it waited off-grid.
   */
  readonly arrival?: true;
}

export type WarpListener = (event: WarpEvent) => void;

/**
 * Called at a due tick boundary (OnBoundary) with its master tick.
 */
export type BoundaryListener = (boundary: number) => void;

/**
 * Called right before a due tick boundary is processed (OnBeforeBoundary) with its master tick and the boundary's
 * scene-clock time, in 100 ns ticks.
 */
export type BeforeBoundaryListener = (boundary: number, time: number) => void;

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
  /**
   * Seconds until a delayed pending order applies (a pilot responding to a fleet order).
   */
  readonly respondsIn?: number;
  /**
   * While it warps in formation (WarpInFormation): the ship it warps with, and whether the warp still waits for the
   * tick boundary that resolves its slot.
   */
  readonly formationWarp?: { readonly leader: string; readonly pending: boolean; readonly respondsIn?: number };
  /**
   * While it arrives by warp (Arrive), and after it landed until it follows, takes an order or is placed.
   */
  readonly arrival?: ShipArrivalReport;
  readonly physics: ShipPhysics;
  readonly propMod: ShipPropModReport;
}

/**
 * A warp in formation (WarpInFormation): the ship warps to its slot, `offset` from its leader's landing (the leader's warp
 * in force), or from the leader itself (no warp in force), in that warp's or the leader's heading frame.
 */
export interface FormationWarp {
  /**
   * The ship it warps with: a fleet's FC, or the leader of a wing or squad.
   */
  readonly leader: string;
  /**
   * Metres centre to centre in the frame (x right, y up, z forward): toFleetGroupOffsets from the leader.
   */
  readonly offset: SceneVector;
  /**
   * Whole ticks the pilot takes to respond (default 0); it also waits for its leader's own order to apply.
   */
  readonly delay?: number;
}

/**
 * A ship's arrival by warp (Arrive): where it waits, where it lands and when its warp-in starts.
 */
export interface ShipArrival {
  /**
   * Where it waits off-grid at rest, metres: at least MIN_WARP_DISTANCE from the landing.
   */
  readonly from: SceneVector;
  /**
   * The warp's destination (range 0): where it drops out of warp.
   */
  readonly landing: SceneVector;
  /**
   * The master tick at whose boundary its warp-in starts (an overdue one starts at the next boundary); null to wait
   * parked until it is scheduled.
   */
  readonly at: Maybe<number>;
  /**
   * Destiny's warp factor (1000 × AU/s); default its physics' warp speed.
   */
  readonly factor?: number;
  /**
   * Its group's leader: a landed follower holds until it has landed too.
   */
  readonly leader?: string;
  /**
   * Degrees: the drawn roll it keeps (default 0); yaw and pitch face the landing.
   */
  readonly roll?: number;
}

/**
 * Parked: waiting with no start; scheduled: waiting for its start; warping: in its warp-in; landed: out of warp (a
 * follower may still hold for its group).
 */
export type ShipArrivalState = 'parked' | 'scheduled' | 'warping' | 'landed';

/**
 * A ship's arrival (ArrivalOf, ShipMotion.arrival).
 */
export interface ShipArrivalReport {
  readonly state: ShipArrivalState;
  readonly from: SceneVector;
  readonly landing: SceneVector;
  /**
   * Scheduled only: whole ticks (seconds) until its start boundary; 0 for the next one.
   */
  readonly startsIn?: number;
  /**
   * Scheduled or warping: whole seconds until it drops out of warp (the exit event's tick), from Destiny's profile.
   */
  readonly landsIn?: number;
  /**
   * Landed only: the master tick it dropped out of warp.
   */
  readonly landedAt?: number;
  readonly leader?: string;
}

export interface OrderOptions {
  /**
   * Whole ticks before the order applies (a pilot's response to a fleet order); default 0, the next boundary.
   */
  readonly delay?: number;
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
  /**
   * A warp-in (Arrive).
   */
  readonly arrival?: true;
}

interface ArrivalEntry {
  readonly from: SceneVector;
  readonly landing: SceneVector;
  /**
   * The drawn rotation it waits at: facing the landing, with its roll.
   */
  readonly rotation: SceneVector;
  readonly at: Maybe<number>;
  readonly factor: Maybe<number>;
  readonly leader: Maybe<string>;
  state: ShipArrivalState;
  landed: Maybe<number>;
}

/**
 * How many tick boundaries a missile's ball stays on the parks after its flight ended (a hit, an expiry or a lost
 * shooter): the drawn missile trails the master by about a tick and its warhead decides its own detonation, so it needs
 * its ClientBall until then. The same with or without a renderer, so the parks hold the same balls either way.
 */
export const MISSILE_BALL_LINGER_TICKS = 3;

/**
 * What a missile ball flies with: the charge's mass (kg), agility, max velocity (m/s) and radius (m).
 */
export interface MissilePhysics {
  readonly mass: number;
  readonly agility: number;
  readonly maxVelocity: number;
  readonly radius: number;
}

export interface MissileLaunch {
  /**
   * The flight's id (the director's `<ship>|<module>|<activation>|<cycle>`).
   */
  readonly id: string;
  /**
   * The launching ship.
   */
  readonly owner: string;
  /**
   * A ship or an object.
   */
  readonly target: string;
  readonly physics: MissilePhysics;
  /**
   * The fractional master tick its flight time runs from, at or after the current tick: the ball flies from the next
   * evolved tick on.
   */
  readonly launchedAt: number;
  /**
   * The fractional master tick it expires at: launchedAt + flightTime / tick seconds.
   */
  readonly expiresAt: number;
}

export type MissileEventKind = 'hit' | 'expired' | 'lost';

/**
 * Where a missile's flight stands: pursuing its target, flying on straight after losing it, or ended (its ball lingers).
 */
export type MissileFlightState = 'flying' | 'lost' | 'done';

/**
 * A missile's end or loss, queued until TakeMissileEvents.
 */
export interface MissileEvent {
  readonly kind: MissileEventKind;
  readonly id: string;
  readonly owner: string;
  readonly target: string;
  /**
   * The exact, fractional master tick: a hit's contact, an expiry's expiresAt, a loss's tick.
   */
  readonly at: number;
  /**
   * The master tick it was found at.
   */
  readonly tick: number;
  readonly why?: string;
  /**
   * Whether the flight ended (a hit, an expiry, a lost shooter). A missile that lost its target flies on straight to
   * its expiry, doing no damage.
   */
  readonly ended: boolean;
}

/**
 * A missile as the master holds it.
 */
export interface MissileReport {
  readonly id: string;
  readonly owner: string;
  readonly target: string;
  readonly state: MissileFlightState;
  readonly position: SceneVector;
  readonly velocity: SceneVector;
  readonly speed: number;
  readonly mode: string;
  /**
   * Metres, surface to surface to its target; null when the target has no ball.
   */
  readonly distance: Maybe<number>;
  /**
   * Seconds until it expires (0 once ended).
   */
  readonly expiresIn: number;
  readonly why?: string;
}

interface MissileEntry {
  readonly id: string;
  readonly ballId: number;
  readonly owner: string;
  readonly target: string;
  readonly radius: number;
  readonly launchedAt: number;
  readonly expiresAt: number;
  state: MissileFlightState;
  why: Maybe<string>;
  /**
   * The tick its ball leaves both parks, once ended.
   */
  removeAt: Maybe<number>;
  /**
   * The master positions of the missile and its target at the start of the tick being evolved.
   */
  from: Maybe<{ readonly missile: SceneVector; readonly target: Maybe<SceneVector> }>;
}

/**
 * A static object's ball.
 */
interface ObjectEntry {
  readonly id: string;
  readonly ballId: number;
  radius: number;
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
  /**
   * Its warp in formation, until its group has landed; `applied` once the boundary resolved and ordered it.
   */
  formationWarp: Maybe<Omit<FormationWarp, 'delay'> & { readonly at: number; applied: boolean }>;
  prop: PropModEntry;
  /**
   * What tackle stops it doing; a placement keeps it.
   */
  tackle: ShipTackle;
  /**
   * Destroy stopped it for good: it takes no orders, follows nothing and is no one's target until RemoveShip.
   */
  destroyed: boolean;
  /**
   * Its arrival by warp (Arrive), until it follows, takes an order or is placed.
   */
  arrival: Maybe<ArrivalEntry>;
}

interface PropModEntry {
  state: PropModState;
  /**
   * The tick the running module started.
   */
  since: Maybe<number>;
  /**
   * The tick a stopping module stops at.
   */
  stopAt: Maybe<number>;
  note: Maybe<string>;
  /**
   * A switch the pilot has not made yet (SwitchPropMod with a delay): on or off, at the boundary of master tick `at`.
   */
  queued: Maybe<{ readonly on: boolean; readonly at: number }>;
}

/**
 * A ship entry as Snapshot holds it: everything but its curves, plus the rotation curve's attitude and last sample.
 */
interface ShipSnapshot {
  readonly entry: Omit<ShipEntry, 'curves'>;
  readonly attitude: readonly number[];
  readonly value: readonly number[];
}

/**
 * The whole simulation between ticks (DestinyWorld.Snapshot).
 */
export interface DestinySnapshot {
  readonly master: ParkSnapshot;
  readonly replica: ParkSnapshot;
  /**
   * The world's own fields (objects, pending orders, missiles, events, ball ids), ships aside.
   */
  readonly fields: CapturedFields;
  readonly ships: readonly ShipSnapshot[];
}

/**
 * The world's wiring: the parks (snapshotted on their own), the ships (their curves are runtime objects) and the
 * listeners.
 */
const WORLD_CAPTURE: CaptureOptions = { wiring: ['masterPark', 'replicaPark', 'ships', 'warpListeners', 'boundaryListeners', 'beforeBoundaryListeners', 'propModListeners'] };

/**
 * The page's Destiny simulation: a master and a replica park in lockstep, one ball per document ship.
 */
export class DestinyWorld {
  /**
   * The parks; Restore swaps in new ones, so read them through master / replica each time.
   */
  private masterPark: ScenePark;
  private replicaPark: ScenePark;
  private readonly ships = new Map<string, ShipEntry>();
  private readonly objects = new Map<string, ObjectEntry>();
  /**
   * Movement orders waiting for the next tick boundary, by ship id; the latest order wins.
   */
  private readonly pending = new Map<string, ShipOrder>();
  /**
   * For a pending order given with a delay (a fleet order's pilot response): the master tick at whose boundary it
   * applies.
   */
  private readonly pendingAt = new Map<string, number>();
  private readonly warpListeners = new Set<WarpListener>();
  private readonly boundaryListeners = new Set<BoundaryListener>();
  private readonly beforeBoundaryListeners = new Set<BeforeBoundaryListener>();
  private readonly propModListeners = new Set<PropModListener>();
  /**
   * Prop mod events waiting for the end of the tick (or the call) that made them.
   */
  private propModEvents: PropModEvent[] = [];
  private readonly missiles = new Map<string, MissileEntry>();
  /**
   * Missile ends and losses waiting for TakeMissileEvents.
   */
  private missileEvents: MissileEvent[] = [];
  private nextBallId = FIRST_SHIP_BALL_ID;
  /**
   * Whether ship ball ids are seeded by their document ids (after the first SetSceneEpoch).
   */
  private seeded = false;

  constructor() {
    this.masterPark = new ScenePark();
    this.masterPark.isMaster = true;
    this.replicaPark = new ScenePark();
    // Both parks get the reference ball, so they hold the same balls.
    this.Both((park) => park.AddBall(REFERENCE_BALL_ID, 1, 0, 0, false, false, false, false, false, 0, 0, 0, 0, 0, 0, 1, 0));
    this.replica.ego = REFERENCE_BALL_ID;
    this.master.ego = REFERENCE_BALL_ID;
  }

  /**
   * The authoritative park.
   *
   * @returns The master park (a new object after Restore).
   */
  get master(): CjsBallparkController {
    return this.masterPark;
  }

  /**
   * The renderer's park: its ClientBalls are the ships' curves.
   *
   * @returns The replica park (a new object after Restore).
   */
  get replica(): CjsBallparkController {
    return this.replicaPark;
  }

  private get parks(): readonly ScenePark[] {
    return [this.masterPark, this.replicaPark];
  }

  /**
   * Snapshots the whole simulation between ticks (sd-time): both parks (stream + scalar overlay), every ship entry with
   * its curve attitude, the objects, pending orders, missiles, queued events and the ball id counter. The listeners are
   * wiring and stay.
   *
   * @returns The snapshot, plain data.
   */
  Snapshot(): DestinySnapshot {
    const ships: ShipSnapshot[] = [];
    for (const entry of this.ships.values()) {
      const { curves, ...rest } = entry;
      ships.push({ entry: CloneState(rest), attitude: [...curves.rotation.attitude], value: [...curves.rotation.value] });
    }
    return { master: CapturePark(this.masterPark), replica: CapturePark(this.replicaPark), fields: CaptureFields(this, WORLD_CAPTURE), ships };
  }

  /**
   * Restores a snapshot: both parks are rebuilt fresh first, so a failure there changes nothing; then they are swapped
   * in, every map is replaced and every ship gets new curves on its new ClientBall (Curves returns the new objects:
   * the director re-attaches the drawn hulls). The listeners stay.
   *
   * @param snapshot - From Snapshot.
   * @throws {Error} When a park does not restore, or a ship's ball is not a ClientBall on the new replica.
   */
  Restore(snapshot: DestinySnapshot): void {
    const master = RestorePark(snapshot.master, true, () => new ScenePark());
    const replica = RestorePark(snapshot.replica, false, () => new ScenePark());
    const ships = new Map<string, ShipEntry>();
    for (const saved of snapshot.ships) {
      const rest = CloneState(saved.entry);
      const ball = replica.GetBall(rest.ballId);
      if (!(ball instanceof CjsDestinyClientBall)) throw new Error(`a Destiny snapshot has no ClientBall for ${rest.id}`);
      const rotation = new BallRotation(ball);
      rotation.attitude.set(saved.attitude);
      rotation.value.set(saved.value);
      ships.set(rest.id, { ...rest, curves: { translation: ball, rotation } });
    }
    this.masterPark = master;
    this.replicaPark = replica;
    RestoreFields(this, snapshot.fields, WORLD_CAPTURE);
    this.ships.clear();
    for (const [id, entry] of ships) this.ships.set(id, entry);
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
   * Starts the scene's epoch (a load): both parks count their legacy orbit time from `tick`, and from now on a ship's
   * new ball id has its document id's hash as its low 16 bits, so its orbit plane is the same in every replay, however
   * many ticks and balls came before.
   *
   * @param tick - The world tick of the load.
   */
  SetSceneEpoch(tick: number): void {
    for (const park of this.parks) park.orbitEpoch = tick;
    this.seeded = true;
  }

  /**
   * A ship's ball id on both parks.
   *
   * @param id - The ship id.
   * @returns The ball id; null for an unknown ship.
   */
  BallIdOf(id: string): Maybe<number> {
    return this.ships.get(id)?.ballId ?? null;
  }

  /**
   * The next ship ball id: the next free one, or after SetSceneEpoch the next whose low 16 bits are the ship's seed.
   * Never a used one.
   */
  private NextShipBallId(id: string): number {
    let ballId = this.nextBallId;
    if (this.seeded) {
      const seed = Math.floor(unitHash(`ball|${id}`) * BALL_ID_SEED_SPAN);
      ballId += (seed - (ballId % BALL_ID_SEED_SPAN) + BALL_ID_SEED_SPAN) % BALL_ID_SEED_SPAN;
    }
    this.nextBallId = ballId + 1;
    return ballId;
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
      const ballId = this.NextShipBallId(doc.id);
      const [x, y, z] = doc.position;
      this.Both((park) => park.AddBall(ballId, physics.mass, physics.radius, physics.maxVelocity, true, false, false, true, false, x, y, z, 0, 0, 0, physics.agility, 1));
      const ball = this.replica.GetBall(ballId);
      if (!(ball instanceof CjsDestinyClientBall)) throw new Error(`the replica park did not create a ClientBall for ${doc.id}`);
      this.ships.set(doc.id, {
        id: doc.id,
        ballId,
        curves: { translation: ball, rotation: new BallRotation(ball) },
        physics,
        order: STOP_ORDER,
        note: null,
        follow: null,
        followApplied: false,
        settled: false,
        warp: null,
        held: null,
        formationWarp: null,
        prop: { state: 'off', since: null, stopAt: null, note: null, queued: null },
        tackle: FREE,
        destroyed: false,
        arrival: null
      });
    }
    this.PlaceShip(doc);
  }

  /**
   * Puts a ship at rest at a placement, facing along its rotation, ending its order (a warp too, with no exit event)
   * and its arrival.
   * Its followers chase it there. A ship following its fleet keeps following and flies back to its slot from there.
   * Its prop mod and its tackle keep their state: that is module state, not motion.
   *
   * @param doc - The document ship.
   */
  PlaceShip(doc: Pick<SceneShip, 'id' | 'position' | 'rotation'>): void {
    const entry = this.ships.get(doc.id);
    if (!entry || entry.destroyed) return;
    const { ballId } = entry;
    this.pending.delete(doc.id);
    entry.order = STOP_ORDER;
    entry.note = null;
    entry.followApplied = false;
    entry.settled = false;
    entry.warp = null;
    entry.held = null;
    entry.formationWarp = null;
    entry.arrival = null;
    const rotation = DocumentRotation(doc.rotation);
    const forward = vec3.transformQuat(vec3.create(), [0, 0, 1], rotation);
    const goto = this.Both((park) => {
      park.Stop(ballId);
      park.SetBallPosition(ballId, ...doc.position);
      const aimed = this.AimAlong(park, ballId, doc.position, forward);
      // Zero velocity snaps the legacy heading to the goto point.
      park.SetBallVelocity(ballId, 0, 0, 0);
      RestartInterval(park, ballId);
      return aimed;
    });
    // The heading Destiny derives from the same goto offsets, then whatever the document adds to it (its roll).
    const [x, y, z] = doc.position;
    const heading = HeadingRotation(goto[0] - x, goto[1] - y, goto[2] - z);
    quat.multiply(entry.curves.rotation.attitude, quat.conjugate(heading, heading), rotation);
  }

  /**
   * Changes what a ship flies with, on both parks. A new warp speed reaches a ship that is aligning; once in warp its
   * warp speed is fixed, as in EVE. A running prop mod flies the new physics' `propMod` numbers at once; physics
   * without one fly their own numbers whatever the module's state.
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
    entry.physics = physics;
    const flown = this.FlownNumbers(entry);
    this.Both((park) => {
      park.SetBallMass(ballId, flown.mass);
      park.SetBallRadius(ballId, physics.radius);
      park.SetMaxSpeed(ballId, flown.maxVelocity);
      park.SetBallAgility(ballId, physics.agility);
    });
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
   * are left to the caller to re-point (Follow) in the same call; Steer halts any it does not. Destiny turns the
   * missiles pursuing it, which the next tick reports lost; its own missiles vanish then too (RemoveMissilesOf takes
   * them off at once).
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
   * Stops a destroyed ship for good on both parks while its ball stays for its explosion: its order, pending order,
   * following and formation warp end, its prop mod switches off (cause `destroyed`, delivered before this returns),
   * and every ship following it, or ordered or queued at it, stops (re-point followers with Follow in the same call).
   * Every missile pursuing it is lost (LoseMissileTargets); its own missiles vanish at the next tick. From then on OrderRefusal, Follow, WarpInFormation and PropModRefusal refuse it, as an anchor, frame or target
   * too. RemoveShip takes the ball off later.
   *
   * @param id - The ship id.
   * @returns The ids of the ships it stopped, in the order they were added; empty for an unknown or destroyed ship.
   */
  Destroy(id: string): string[] {
    const entry = this.ships.get(id);
    if (!entry || entry.destroyed) return [];
    entry.destroyed = true;
    this.pending.delete(id);
    this.pendingAt.delete(id);
    entry.follow = null;
    entry.settled = false;
    entry.held = null;
    entry.formationWarp = null;
    if (entry.arrival?.state !== 'warping') entry.arrival = null;
    entry.prop.queued = null;
    this.PropModOffNow(entry, 'it was destroyed', 'destroyed');
    this.Halt(entry, 'destroyed');
    this.DeliverPropModEvents();
    this.LoseMissileTargets(id, 'its target was destroyed');
    const stopped: string[] = [];
    for (const other of this.ships.values()) {
      if (other === entry) continue;
      const pending = this.pending.get(other.id);
      const queued = pending !== undefined && shipOrderTarget(pending) === id;
      if (queued) {
        this.pending.delete(other.id);
        this.pendingAt.delete(other.id);
      }
      const follows = other.follow != null && (other.follow.anchor === id || other.follow.frame === id);
      const leads = other.formationWarp?.leader === id;
      if (follows || leads) {
        other.follow = null;
        other.settled = false;
        other.held = null;
        other.formationWarp = null;
      }
      if (queued || follows || leads || (!other.follow && TargetOf(other.order) === id)) {
        this.Halt(other, `stopped: target "${id}" was destroyed`);
        stopped.push(other.id);
      }
    }
    return stopped;
  }

  /**
   * Whether Destroy stopped a ship (its ball may still be on the parks).
   *
   * @param id - The ship id.
   * @returns False for an unknown ship.
   */
  IsDestroyed(id: string): boolean {
    return this.ships.get(id)?.destroyed === true;
  }

  /**
   * Adds a static object ball on both parks, or re-places and resizes a known one: not free, not massive (no
   * collisions: ships are not massive either), not interactive, at rest at its position. Ships can target it.
   *
   * @param doc - The object's id and position (a document object, or a celestial target).
   * @param radius - The ball's radius in metres: the SDE radius, else the SOF bounding radius, else a default.
   * @throws {Error} For a radius that is not above 0, or an id a ship holds.
   */
  AddObject(doc: { readonly id: string; readonly position: SceneVector }, radius: number): void {
    if (!(Number.isFinite(radius) && radius > 0)) throw new Error(`object "${doc.id}": radius must be a finite number above 0, got ${radius}`);
    if (this.ships.has(doc.id)) throw new Error(`object "${doc.id}": a ship holds that id`);
    const known = this.objects.get(doc.id);
    if (known) {
      this.PlaceObject(doc);
      this.SetObjectRadius(doc.id, radius);
      return;
    }
    const ballId = this.nextBallId++;
    const [x, y, z] = doc.position;
    this.objects.set(doc.id, { id: doc.id, ballId, radius });
    this.Both((park) => park.AddBall(ballId, OBJECT_BALL_MASS, radius, 0, false, false, false, false, false, x, y, z, 0, 0, 0, 1, 0));
  }

  /**
   * Moves an object's ball on both parks. Ships flying at it chase it there.
   *
   * @param doc - The object's id and position.
   */
  PlaceObject(doc: { readonly id: string; readonly position: SceneVector }): void {
    const entry = this.objects.get(doc.id);
    if (entry) this.Both((park) => park.SetBallPosition(entry.ballId, ...doc.position));
  }

  /**
   * Resizes an object's ball on both parks.
   *
   * @param id - The object id.
   * @param radius - Metres, above 0.
   * @throws {Error} For a radius that is not above 0.
   */
  SetObjectRadius(id: string, radius: number): void {
    if (!(Number.isFinite(radius) && radius > 0)) throw new Error(`object "${id}": radius must be a finite number above 0, got ${radius}`);
    const entry = this.objects.get(id);
    if (!entry || entry.radius === radius) return;
    entry.radius = radius;
    this.Both((park) => park.SetBallRadius(entry.ballId, radius));
  }

  /**
   * Removes an object's ball, as RemoveShip does for a ship's targets: a pending order on it is dropped and the ship
   * halted, an applied approach, keep-at-range or orbit on it halts, and an applied warp to it flies on.
   *
   * @param id - The object id.
   * @returns The ids of the ships it stopped, in the order they were added.
   */
  RemoveObject(id: string): string[] {
    const entry = this.objects.get(id);
    if (!entry) return [];
    this.objects.delete(id);
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

  HasObject(id: string): boolean {
    return this.objects.has(id);
  }

  ObjectIds(): string[] {
    return [...this.objects.keys()];
  }

  /**
   * An object ball as the master holds it, rounded to the centimetre.
   *
   * @param id - The object id.
   * @returns Its position and radius, or null.
   */
  ObjectBall(id: string): Maybe<{ readonly position: SceneVector; readonly radius: number }> {
    const entry = this.objects.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    return ball ? { position: [Round(ball.x, 100), Round(ball.y, 100), Round(ball.z, 100)], radius: ball.radius } : null;
  }

  /**
   * A target's entry: a ship's, else an object's.
   */
  private TargetEntry(id: string): Maybe<{ readonly ballId: number }> {
    return this.ships.get(id) ?? this.objects.get(id) ?? null;
  }

  /**
   * Queues a movement order for the next tick boundary, or `delay` ticks later (a pilot's response to a fleet order).
   * It supersedes following: the ship leaves its formation.
   *
   * @param id - The ship id.
   * @param order - A normalized order.
   * @param options - Its delay, whole ticks (default 0).
   * @returns False when OrderRefusal refuses it.
   */
  Order(id: string, order: ShipOrder, options: OrderOptions = {}): boolean {
    const entry = this.ships.get(id);
    const valid = entry !== undefined && this.OrderRefusal(id, order) === null;
    if (valid) {
      this.pending.set(id, order);
      const delay = Math.max(0, Math.round(options.delay ?? 0));
      if (delay > 0) this.pendingAt.set(id, this.tick + delay);
      else this.pendingAt.delete(id);
      entry.follow = null;
      entry.settled = false;
      entry.held = null;
      entry.formationWarp = null;
      entry.arrival = null;
    }
    return valid;
  }

  /**
   * Why Order would refuse an order, from the master's current state.
   *
   * @param id - The ship id.
   * @param order - A normalized order.
   * @returns The reason, or null when Order takes it: no ship (or a target that is itself or has no ball), a ship or
   *   target still arriving by warp, a ship in proper warp (any order), and for a warp a tackled ship (SetTackle), a max velocity of 0, a target in warp, or a
   *   landing under MIN_WARP_DISTANCE away.
   */
  OrderRefusal(id: string, order: ShipOrder): Maybe<string> {
    const entry = this.ships.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    const target = shipOrderTarget(order);
    const targetEntry = target && target !== id ? this.TargetEntry(target) : undefined;
    const targetBall = targetEntry ? this.master.GetBall(targetEntry.ballId) : null;
    let refusal: Maybe<string> = null;
    if (!entry || !ball || (target && !targetBall)) {
      refusal = `ship "${id}" or its target has no Destiny ball`;
    } else if (entry.destroyed) {
      refusal = `ship "${id}" was destroyed`;
    } else if (target && target !== id && this.ships.get(target)?.destroyed) {
      refusal = `target "${target}" was destroyed`;
    } else if (entry.arrival && entry.arrival.state !== 'landed') {
      const landsIn = this.ArrivalReport(entry, entry.arrival).landsIn;
      const when = landsIn === undefined ? '' : `, in about ${landsIn} s`;
      refusal = `ship "${id}" is arriving by warp; it takes orders once it lands${when}`;
    } else if (target && target !== id && this.Arriving(target)) {
      refusal = `target "${target}" is arriving by warp`;
    } else if (ball.IsWarping()) {
      const landsIn = this.WarpReport(entry, ball)?.landsIn;
      const when = landsIn === undefined ? '' : `, in about ${landsIn} s`;
      refusal = `ship "${id}" is in warp; it takes orders again once it lands${when}`;
    } else if (isTargetShipOrder(order) && targetBall && ball.mNewBubble !== targetBall.mNewBubble) {
      const away = Math.hypot(ball.x - targetBall.x, ball.y - targetBall.y, ball.z - targetBall.z);
      refusal = `target "${target}" is ${formatSceneDistance(away)} away, in another Destiny bubble; warp to it first`;
    } else if (order.type === 'warp') {
      const destination: SceneVector = 'point' in order ? order.point : [targetBall?.x ?? 0, targetBall?.y ?? 0, targetBall?.z ?? 0];
      const range = order.range + (targetBall ? ball.radius + targetBall.radius : 0);
      const length = WarpLength(destination, range, [ball.x, ball.y, ball.z]);
      if (entry.tackle.warp) refusal = `ship "${id}" cannot warp: ${entry.tackle.warp}`;
      else if (!(ball.maxVelocity > 0)) refusal = `ship "${id}" cannot warp: its max velocity is 0`;
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
   * Switches a ship's prop mod live, by EVE's module rules. On: off becomes activating (it applies at the next tick
   * boundary) and stopping becomes active again (the stop is cancelled). Off: activating is cancelled, and active
   * becomes stopping, running until the end of its cycle (rounded up to a tick). Anything else is unchanged.
   *
   * With a delay (a pilot's response to a fleet command), the switch is made that many ticks later, at a tick boundary
   * before the activations apply, and checked again then (switching on in warp is noted and dropped). A new switch
   * replaces a delayed one.
   *
   * @param id - The ship id.
   * @param on - Switch on, or off.
   * @param options - Its delay, whole ticks (default 0).
   * @returns The state after the call, or null when PropModRefusal refuses it.
   */
  SwitchPropMod(id: string, on: boolean, options: OrderOptions = {}): Maybe<PropModSwitchResult> {
    const entry = this.ships.get(id);
    if (!entry || this.PropModRefusal(id, on) !== null) return null;
    const delay = Math.max(0, Math.round(options.delay ?? 0));
    entry.prop.queued = delay > 0 ? { on, at: this.tick + delay } : null;
    if (delay > 0) return { state: entry.prop.state, respondsIn: delay };
    this.Switch(entry, on);
    const prop = entry.prop;
    const boundary = this.master.currentTime;
    let result: PropModSwitchResult = { state: prop.state };
    if (prop.state === 'activating') result = { state: prop.state, at: boundary };
    else if (prop.state === 'stopping' && prop.stopAt != null) result = { state: prop.state, stopsAt: prop.stopAt, stopsIn: this.StopsIn(prop.stopAt) };
    return result;
  }

  /**
   * The module rules of a switch (SwitchPropMod), made now.
   *
   * @param entry - The ship.
   * @param on - Switch on, or off.
   */
  private Switch(entry: ShipEntry, on: boolean): void {
    const prop = entry.prop;
    const boundary = this.master.currentTime;
    if (on && prop.state === 'off') {
      prop.state = 'activating';
      prop.note = null;
    } else if (on && prop.state === 'stopping') {
      prop.state = 'active';
      prop.stopAt = null;
    } else if (!on && prop.state === 'activating') {
      prop.state = 'off';
    } else if (!on && prop.state === 'active') {
      prop.state = 'stopping';
      prop.stopAt = CycleEnd({ since: prop.since ?? boundary, boundary, cycle: this.CycleTicks(entry) });
    }
  }

  /**
   * Why SwitchPropMod would refuse a switch.
   *
   * @param id - The ship id.
   * @param on - Switch on, or off.
   * @returns The reason, or null: no ship, or switching on while arriving by warp, in proper warp or while a warp
   *   scrambler blocks it.
   */
  PropModRefusal(id: string, on: boolean): Maybe<string> {
    const entry = this.ships.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    let refusal: Maybe<string> = null;
    if (!entry || !ball) {
      refusal = `ship "${id}" has no Destiny ball`;
    } else if (on && entry.destroyed) {
      refusal = `ship "${id}" was destroyed`;
    } else if (on && entry.arrival && entry.arrival.state !== 'landed') {
      refusal = `ship "${id}" is arriving by warp; switch its prop mod on once it lands`;
    } else if (on && ball.IsWarping()) {
      const landsIn = this.WarpReport(entry, ball)?.landsIn;
      const when = landsIn === undefined ? '' : `, in about ${landsIn} s`;
      refusal = `ship "${id}" is in warp; switch its prop mod on once it lands${when}`;
    } else if (on && entry.tackle.propMod) {
      refusal = `ship "${id}" cannot switch its prop mod on: ${entry.tackle.propMod}`;
    }
    return refusal;
  }

  /**
   * Sets a ship's prop mod to the document's state at once, like a placement: no tick wait and no cycle wait. On in
   * proper warp, or while a warp scrambler blocks it, leaves it off, with a note. Its event (if it changed) reaches the
   * listeners before this returns.
   *
   * @param id - The ship id.
   * @param on - Running, or off.
   */
  SetPropModActive(id: string, on: boolean): void {
    const entry = this.ships.get(id);
    if (!entry || (on && entry.destroyed)) return;
    const prop = entry.prop;
    // The document's state overrides a switch the pilot has yet to make.
    prop.queued = null;
    const running = IsRunning(prop.state);
    if (on && entry.tackle.propMod) {
      if (running) this.PropModOffNow(entry, `off: ${entry.tackle.propMod}`, 'tackle');
      prop.state = 'off';
      prop.note = `not switched on: ${entry.tackle.propMod}`;
    } else if (on && (this.InProperWarp(entry) || this.Arriving(id))) {
      if (!running) {
        prop.state = 'off';
        prop.note = this.Arriving(id) ? 'not switched on: arriving by warp' : 'not switched on: in warp';
      }
    } else if (on) {
      if (!running) {
        prop.since = this.master.currentTime;
        this.PropModEventOf('on', entry, 'document');
      }
      prop.state = 'active';
      prop.stopAt = null;
      prop.note = null;
    } else {
      prop.state = 'off';
      prop.stopAt = null;
      if (running) this.PropModEventOf('off', entry, 'document');
    }
    this.ApplyPropModNumbers(entry);
    this.DeliverPropModEvents();
  }

  /**
   * Sets what tackle stops a ship doing (the director computes the reasons from its dogma; this only enforces them).
   * With `warp`: a pending or delayed warp order is dropped, a warp still aligning is cancelled (a plain ship flies on
   * along it as a direction order at full speed; a formation-warp member drops its formation warp and follows its
   * fleet again), and later warp orders are refused. With `propMod`: an activating, running or stopping prop mod
   * switches off at once (its event reaches the listeners before this returns), and switching it on is refused.
   * OnBoundary listeners run before the evolve, so a point landing on the boundary a warp would begin wins.
   *
   * @param id - The ship id.
   * @param tackle - The reasons; null fields for what it may do.
   */
  SetTackle(id: string, tackle: ShipTackle): void {
    const entry = this.ships.get(id);
    if (!entry) return;
    entry.tackle = tackle.warp == null && tackle.propMod == null ? FREE : { warp: tackle.warp ?? null, propMod: tackle.propMod ?? null };
    const { warp, propMod } = entry.tackle;
    if (warp) {
      if (this.pending.get(id)?.type === 'warp') {
        this.pending.delete(id);
        this.pendingAt.delete(id);
        entry.note = `dropped: the warp order (${warp})`;
      }
      const formation = entry.formationWarp;
      const aligning = entry.warp && !entry.warp.start && !this.InProperWarp(entry) ? entry.warp : null;
      if (formation && (!formation.applied || aligning)) {
        entry.formationWarp = null;
        if (aligning && entry.follow) {
          this.Both((park) => park.Stop(entry.ballId));
          entry.order = FollowOrder(entry.follow);
          entry.warp = null;
          entry.followApplied = true;
          entry.settled = false;
        }
        entry.note = `dropped: its formation warp (${warp})`;
      } else if (aligning && !formation) {
        const ball = this.master.GetBall(entry.ballId);
        const along: SceneVector = ball ? [aligning.destination[0] - ball.x, aligning.destination[1] - ball.y, aligning.destination[2] - ball.z] : [0, 0, 1];
        const length = Math.hypot(...along);
        this.ApplyOrder(entry, { type: 'direction', direction: length > 0 ? [along[0] / length, along[1] / length, along[2] / length] : [0, 0, 1], speed: 1 });
        entry.note = `warp cancelled: ${warp}`;
      }
    }
    if (propMod && entry.prop.state !== 'off') {
      this.PropModOffNow(entry, `off: ${propMod}`, 'tackle');
      this.DeliverPropModEvents();
    }
  }

  /**
   * What tackle stops a ship doing.
   *
   * @param id - The ship id.
   * @returns Its tackle, or null for no ship.
   */
  Tackle(id: string): Maybe<ShipTackle> {
    return this.ships.get(id)?.tackle ?? null;
  }

  /**
   * Calls a listener at every due tick boundary, right after the prop mods apply and before orders, steering and the
   * evolve: the fitted modules' cycles (modules.ts) and any physics they change (SetPhysics) land there, on the prop
   * mod's timing. A throwing listener is logged and the rest still run.
   *
   * @param listener - Called with the boundary's master tick.
   * @returns The unsubscribe.
   */
  OnBoundary(listener: BoundaryListener): () => void {
    this.boundaryListeners.add(listener);
    return () => {
      this.boundaryListeners.delete(listener);
    };
  }

  /**
   * Calls a listener at the top of every due tick boundary, before the prop mods apply: the timeline's cues fire there
   * (timeline.ts), so a cue is exactly the same MCP call made just before that tick (its order applies at this
   * boundary, a prop mod switch-on lands in this boundary's ApplyPropMods, a module activation in this boundary's
   * cycle). It touches no park itself; the listener's calls are the world's ordinary methods. A throwing listener is
   * logged and the rest still run.
   *
   * @param listener - Called with the boundary's master tick and its scene-clock time (100 ns ticks).
   * @returns The unsubscribe.
   */
  OnBeforeBoundary(listener: BeforeBoundaryListener): () => void {
    this.beforeBoundaryListeners.add(listener);
    return () => {
      this.beforeBoundaryListeners.delete(listener);
    };
  }

  /**
   * The surface-to-surface distance between two balls, on their EVE radii (negative when they overlap): ships, or an
   * authored object for either (a turret's target).
   *
   * @param a - One ship or object id.
   * @param b - The other.
   * @returns Metres, or null when either has no ball.
   */
  SurfaceDistance(a: string, b: string): Maybe<number> {
    const first = this.TargetEntry(a);
    const second = this.TargetEntry(b);
    const ballA = first ? this.master.GetBall(first.ballId) : null;
    const ballB = second ? this.master.GetBall(second.ballId) : null;
    return ballA && ballB ? Math.hypot(ballA.x - ballB.x, ballA.y - ballB.y, ballA.z - ballB.z) - ballA.radius - ballB.radius : null;
  }

  /**
   * EVE's turret hit chance on the master park's balls now (Destiny's own GetAccuracy): a query, so it reads the master
   * only. At a boundary (OnBoundary, before orders and the evolve) the balls' new positions and velocities are the
   * tick's state.
   *
   * @param source - The shooting ship.
   * @param target - Its target: a ship or an authored object.
   * @param numbers - The turret's optimal, falloff (null: none, NO_FALLOFF_METRES), tracking and signature resolution,
   *   and the target's live signature radius.
   * @returns The chance, the surface distance (m) and the angular velocity (rad/s); null for a missing ball or the
   *   same id.
   */
  Accuracy(source: string, target: string, numbers: { readonly optimal: number; readonly falloff: Maybe<number>; readonly tracking: number; readonly signatureRadius: number; readonly signatureResolution: number }): Maybe<{ readonly chance: number; readonly distance: number; readonly angularVelocity: number }> {
    const first = this.TargetEntry(source);
    const second = this.TargetEntry(target);
    if (!first || !second || source === target || !this.master.GetBall(first.ballId) || !this.master.GetBall(second.ballId)) return null;
    const [chance, distance, angularVelocity] = this.master.GetAccuracy(first.ballId, second.ballId, numbers.optimal, numbers.falloff ?? NO_FALLOFF_METRES, numbers.tracking, numbers.signatureRadius, numbers.signatureResolution);
    return { chance, distance, angularVelocity };
  }

  /**
   * Whether a ship is in proper warp (past its align).
   *
   * @param id - The ship id.
   * @returns True while it warps.
   */
  InWarp(id: string): boolean {
    return this.InProperWarp(this.ships.get(id));
  }

  /**
   * Calls a listener for every prop mod that starts or stops, after the tick (or the SetPropModActive call) that made
   * it. A throwing listener is logged and the rest still run.
   *
   * @param listener - Called with each event.
   * @returns The unsubscribe.
   */
  OnPropMod(listener: PropModListener): () => void {
    this.propModListeners.add(listener);
    return () => {
      this.propModListeners.delete(listener);
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
    const live = (other: string): boolean => this.ships.get(other)?.destroyed === false;
    const valid = entry !== undefined && !entry.destroyed && follow.anchor !== id && follow.frame !== id && live(follow.anchor) && live(follow.frame);
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
      entry.formationWarp = null;
      this.Halt(entry, note);
    }
    return following;
  }

  /**
   * Warps a following ship in formation with its leader from the next tick boundary. There, after the plain pending
   * orders (so the leader's own warp has applied), its slot point is resolved: `offset` from the leader's landing in
   * WarpFrame(where the leader's warp begins, its landing) while the leader has a warp in force (Destiny's landing once
   * in warp, else the LandingPoint estimate), else from the leader's position in its heading frame. The ship then warps
   * there as an ordinary warp to a point (OrderRefusal checked again: a refused one is dropped with a note and the ship
   * keeps following). Steer leaves it alone until it, its leader, its anchor and its frame ship have all finished their
   * warps, then it follows again. A re-plan (Follow) keeps it; an explicit order, a placement or Unfollow ends it.
   *
   * @param id - The ship id.
   * @param warp - The leader and the ship's offset from it.
   * @returns False for an unknown ship, a ship that does not follow, a leader that is the ship itself or has no ship,
   *   a ship in proper warp, or a ship or leader still arriving by warp.
   */
  WarpInFormation(id: string, warp: FormationWarp): boolean {
    const entry = this.ships.get(id);
    const valid = entry !== undefined && entry.follow !== null && warp.leader !== id && this.ships.get(warp.leader)?.destroyed === false && !this.InProperWarp(entry) && !this.Arriving(id) && !this.Arriving(warp.leader);
    if (valid) {
      entry.formationWarp = { leader: warp.leader, offset: [warp.offset[0], warp.offset[1], warp.offset[2]], at: this.tick + Math.max(0, Math.round(warp.delay ?? 0)), applied: false };
      entry.held = null;
      entry.settled = false;
    }
    return valid;
  }

  /**
   * A ship's warp in formation, until its group has landed.
   *
   * @param id - The ship id.
   * @returns Its leader and offset, or null.
   */
  FormationWarpOf(id: string): Maybe<FormationWarp> {
    const warp = this.ships.get(id)?.formationWarp;
    return warp ? { leader: warp.leader, offset: warp.offset, ...(warp.at > this.tick ? { delay: warp.at - this.tick } : {}) } : null;
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
   * Parks a ship off-grid to arrive by warp (Destiny's EntityWarpIn), at once: placed at rest at `from`, facing its
   * landing (yaw and pitch along the lane, `roll` kept), ending its order, pending order, warp and formation warp; it
   * keeps its follow and its prop mod state (a running one switches off when it enters warp). At the boundary of
   * master tick `at` its warp-in starts on both parks (ApplyArrivals): proper warp at once, no align, the start
   * backdated min(WARP_IN_BACKDATE_TICKS, tick); it drops out at `landing` like any warp (OnWarp's enter and exit
   * carry `arrival`). Called again before its warp-in starts, it re-parks and re-schedules.
   *
   * @param id - The ship id.
   * @param arrival - Where it waits, where it lands and when it starts.
   * @returns False when ArrivalRefusal refuses it.
   */
  Arrive(id: string, arrival: ShipArrival): boolean {
    const entry = this.ships.get(id);
    const valid = entry !== undefined && this.ArrivalRefusal(id, arrival) === null;
    if (valid) {
      const from: SceneVector = [arrival.from[0], arrival.from[1], arrival.from[2]];
      const landing: SceneVector = [arrival.landing[0], arrival.landing[1], arrival.landing[2]];
      const lane = [landing[0] - from[0], landing[1] - from[1], landing[2] - from[2]];
      const length = Math.hypot(lane[0], lane[1], lane[2]);
      const rotation: SceneVector = [Math.atan2(lane[0], lane[2]) / DEGREES, -Math.asin(Math.min(1, Math.max(-1, lane[1] / length))) / DEGREES, arrival.roll ?? 0];
      this.pendingAt.delete(id);
      this.PlaceShip({ id, position: from, rotation });
      const at = arrival.at == null ? null : Math.max(0, Math.round(arrival.at));
      entry.arrival = { from, landing, rotation, at, factor: arrival.factor ?? null, leader: arrival.leader ?? null, state: at == null ? 'parked' : 'scheduled', landed: null };
    }
    return valid;
  }

  /**
   * Why Arrive would refuse an arrival, from the master's current state.
   *
   * @param id - The ship id.
   * @param arrival - The arrival.
   * @returns The reason, or null: no ship, a destroyed ship, a ship in proper warp (its own warp-in too), a point that
   *   is not finite, a max velocity of 0 (it would never drop out), a lane under MIN_WARP_DISTANCE (Destiny turns a
   *   warp within 100 km into a goto), or a warp factor that is not a positive int32.
   */
  ArrivalRefusal(id: string, arrival: ShipArrival): Maybe<string> {
    const entry = this.ships.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    const finite = [...arrival.from, ...arrival.landing, arrival.at ?? 0, arrival.roll ?? 0].every((value) => Number.isFinite(value));
    const length = finite ? Distance(arrival.landing, arrival.from) : 0;
    let refusal: Maybe<string> = null;
    if (!entry || !ball) refusal = `ship "${id}" has no Destiny ball`;
    else if (entry.destroyed) refusal = `ship "${id}" was destroyed`;
    else if (ball.IsWarping()) refusal = `ship "${id}" is in warp`;
    else if (!finite) refusal = `ship "${id}": a warp-in needs finite points, tick and roll`;
    else if (!(ball.maxVelocity > 0)) refusal = `ship "${id}" cannot warp in: its max velocity is 0`;
    else if (length < MIN_WARP_DISTANCE) refusal = `ship "${id}" would warp in from ${Round(length / 1000, 10)} km away; EVE warps only ${MIN_WARP_DISTANCE / 1000} km or more`;
    else if (arrival.factor !== undefined && !(Number.isInteger(arrival.factor) && arrival.factor >= 1 && arrival.factor <= INT32_MAX)) refusal = `ship "${id}": a warp factor is a positive int32, got ${arrival.factor}`;
    return refusal;
  }

  /**
   * A ship's arrival by warp.
   *
   * @param id - The ship id.
   * @returns Its state, points and timing; null when it has none (never arrived, or it follows, took an order or was
   *   placed since it landed).
   */
  ArrivalOf(id: string): Maybe<ShipArrivalReport> {
    const entry = this.ships.get(id);
    return entry?.arrival ? this.ArrivalReport(entry, entry.arrival) : null;
  }

  /**
   * Whether a ship is still arriving: parked, scheduled or in its warp-in.
   *
   * @param id - The ship id.
   * @returns False once it landed, and for no ship.
   */
  Arriving(id: string): boolean {
    const arrival = this.ships.get(id)?.arrival;
    return arrival != null && arrival.state !== 'landed';
  }

  /**
   * Destiny's warp profile for a warp factor over a distance (SetupWarpConstants), for planning arrivals.
   *
   * @param factor - The warp factor, 1000 × AU/s.
   * @param distance - Metres.
   * @returns The whole profile.
   */
  WarpProfile(factor: number, distance: number): WarpProfileDistances {
    return this.master.SetupWarpConstants(factor, distance, {});
  }

  /**
   * Launches a missile: a new ball on both parks at the owner's centre (free, not massive, not interactive), then the
   * server's LaunchMissile, aimed at the target and non-massive, whose MissileFollow pursues it (mode DSTBALL_MISSILE).
   * Nothing is added when it is refused (MissileRefusal), or when either park did not reach the missile mode.
   *
   * @param launch - The flight's id, owner, target, physics and times.
   * @returns Why it was refused, or null.
   */
  LaunchMissile(launch: MissileLaunch): Maybe<string> {
    const refusal = this.MissileRefusal(launch);
    if (refusal) return refusal;
    const owner = this.ships.get(launch.owner) as ShipEntry;
    const target = this.TargetEntry(launch.target) as { readonly ballId: number };
    const from = this.master.GetBall(owner.ballId) as CjsDestinyBall;
    const ballId = this.nextBallId++;
    const { mass, agility, maxVelocity, radius } = launch.physics;
    this.Both((park) => {
      park.AddBall(ballId, mass, radius, maxVelocity, true, false, false, false, false, from.x, from.y, from.z, 0, 0, 0, agility, 1);
      park.LaunchMissile(ballId, target.ballId, owner.ballId, 1, 0);
    });
    if (this.master.GetBall(ballId)?.mode !== MISSILE_MODE || this.replica.GetBall(ballId)?.mode !== MISSILE_MODE) {
      this.Both((park) => park.RemoveBall(ballId));
      return 'Destiny refused the launch';
    }
    this.missiles.set(launch.id, { id: launch.id, ballId, owner: launch.owner, target: launch.target, radius, launchedAt: launch.launchedAt, expiresAt: launch.expiresAt, state: 'flying', why: null, removeAt: null, from: null });
    return null;
  }

  /**
   * Why a missile cannot be launched: the owner or the target has no ball, the owner was destroyed or is in proper warp
   * or arriving, the target is the owner, was destroyed, is in proper warp, arriving, or in another Destiny bubble
   * (MissileFollow refuses that on the master only, so the parks would diverge), the id is already flying, or the
   * missile does not fly.
   *
   * @param launch - The launch.
   * @returns The refusal, or null.
   */
  MissileRefusal(launch: MissileLaunch): Maybe<string> {
    const owner = this.ships.get(launch.owner);
    const ownerBall = owner ? this.master.GetBall(owner.ballId) : null;
    const targetShip = this.ships.get(launch.target);
    const target = this.TargetEntry(launch.target);
    const targetBall = target ? this.master.GetBall(target.ballId) : null;
    const { mass, agility, maxVelocity, radius } = launch.physics;
    let refusal: Maybe<string> = null;
    if (!owner || !ownerBall) refusal = `ship "${launch.owner}" has no ball`;
    else if (owner.destroyed) refusal = `ship "${launch.owner}" was destroyed`;
    else if (this.InProperWarp(owner)) refusal = `ship "${launch.owner}" is in warp`;
    else if (this.Arriving(launch.owner)) refusal = `ship "${launch.owner}" is arriving`;
    else if (launch.target === launch.owner) refusal = 'a ship cannot launch at itself';
    else if (!targetBall) refusal = `target "${launch.target}" is gone`;
    else if (targetShip?.destroyed) refusal = `target "${launch.target}" was destroyed`;
    else if (this.InProperWarp(targetShip)) refusal = `target "${launch.target}" is in warp`;
    else if (targetShip && this.Arriving(launch.target)) refusal = `target "${launch.target}" is arriving`;
    else if (ownerBall.mNewBubble !== targetBall.mNewBubble) refusal = `target "${launch.target}" is in another Destiny bubble`;
    else if (this.missiles.has(launch.id)) refusal = `missile "${launch.id}" is already flying`;
    else if (![mass, agility, maxVelocity, radius].every(Number.isFinite) || mass <= 0 || agility <= 0 || maxVelocity <= 0 || radius < 0) refusal = 'its missile does not fly';
    else if (!(launch.expiresAt > launch.launchedAt)) refusal = 'its missile has no flight time';
    return refusal;
  }

  /**
   * Turns every missile pursuing a target straight on along its velocity (as Destiny's StopAllFollowers does), on both
   * parks: it is lost and flies on to its expiry, doing no damage. Destroy calls it, because a destroyed ship's ball
   * stays for its explosion and Destiny never stops the pursuit itself.
   *
   * @param target - The ship or object id.
   * @param why - The loss's reason ("its target was destroyed").
   * @returns The missiles it turned.
   */
  LoseMissileTargets(target: string, why: string): string[] {
    const lost: string[] = [];
    for (const entry of this.missiles.values()) {
      if (entry.state !== 'flying' || entry.target !== target) continue;
      this.Straighten(entry);
      entry.state = 'lost';
      entry.why = why;
      this.missileEvents.push(this.MissileEventOf(entry, 'lost', this.master.currentTime, false));
      lost.push(entry.id);
    }
    return lost;
  }

  /**
   * The missile ends and losses since the last call, in the order they happened.
   *
   * @returns The events.
   */
  TakeMissileEvents(): MissileEvent[] {
    const events = this.missileEvents;
    this.missileEvents = [];
    return events;
  }

  /**
   * Takes a missile's ball off both parks now, with no event.
   *
   * @param id - The flight id.
   * @returns False for an unknown missile.
   */
  RemoveMissile(id: string): boolean {
    const entry = this.missiles.get(id);
    if (entry) this.DropMissile(entry);
    return entry != null;
  }

  /**
   * Takes every missile a ship launched off both parks now, with no event: for a shooter removed from the scene.
   *
   * @param ship - The owner's id.
   * @returns The flights removed.
   */
  RemoveMissilesOf(ship: string): string[] {
    const removed: string[] = [];
    for (const entry of [...this.missiles.values()]) {
      if (entry.owner !== ship) continue;
      this.DropMissile(entry);
      removed.push(entry.id);
    }
    return removed;
  }

  /**
   * Takes every missile off both parks and drops the queued events: for a load.
   */
  ClearMissiles(): void {
    for (const entry of [...this.missiles.values()]) this.DropMissile(entry);
    this.missileEvents = [];
  }

  MissileIds(): string[] {
    return [...this.missiles.keys()];
  }

  /**
   * A missile as the master holds it.
   *
   * @param id - The flight id.
   * @returns The report, or null for an unknown missile.
   */
  Missile(id: string): Maybe<MissileReport> {
    const entry = this.missiles.get(id);
    const ball = entry ? this.master.GetBall(entry.ballId) : null;
    if (!entry || !ball) return null;
    const target = this.TargetEntry(entry.target);
    const targetBall = target ? this.master.GetBall(target.ballId) : null;
    const tickSeconds = this.master.tickInterval / 1000;
    return {
      id: entry.id,
      owner: entry.owner,
      target: entry.target,
      state: entry.state,
      position: [Round(ball.x, 100), Round(ball.y, 100), Round(ball.z, 100)],
      velocity: [Round(ball.vx, 100), Round(ball.vy, 100), Round(ball.vz, 100)],
      speed: Round(Math.hypot(ball.vx, ball.vy, ball.vz), 10),
      mode: ModeName(ball.mode),
      distance: targetBall ? Round(Math.hypot(ball.x - targetBall.x, ball.y - targetBall.y, ball.z - targetBall.z) - ball.radius - targetBall.radius, 1) : null,
      expiresIn: entry.state === 'done' ? 0 : Round(Math.max(0, entry.expiresAt - this.master.currentTime) * tickSeconds, 1000),
      ...(entry.why ? { why: entry.why } : {})
    };
  }

  /**
   * The replica ClientBall a drawn missile flies on (translation only); a new object after a Restore.
   *
   * @param id - The flight id.
   * @returns The ClientBall, or null for an unknown missile.
   */
  MissileCurves(id: string): Maybe<CjsDestinyClientBall> {
    const entry = this.missiles.get(id);
    const ball = entry ? this.replica.GetBall(entry.ballId) : null;
    return ball instanceof CjsDestinyClientBall ? ball : null;
  }

  /**
   * Before an evolve: where each missile in flight and its target are on the master.
   */
  private SnapshotMissiles(): void {
    for (const entry of this.missiles.values()) {
      const ball = entry.state === 'done' ? null : this.master.GetBall(entry.ballId);
      const target = entry.state === 'flying' ? this.TargetEntry(entry.target) : null;
      const targetBall = target ? this.master.GetBall(target.ballId) : null;
      entry.from = ball ? { missile: [ball.x, ball.y, ball.z], target: targetBall ? [targetBall.x, targetBall.y, targetBall.z] : null } : null;
    }
  }

  /**
   * After an evolved tick k → k + 1, on the master: ended balls past their linger leave both parks; then each missile
   * in flight expires first (k + 1 past its expiresAt: the EVE server removes it before the tick that would carry it
   * on, which gives the whole-tick floor / ceil range), else is lost with its shooter (destroyed, in warp, removed: it
   * vanishes), else loses its target (its ball left the missile mode: Destiny's StopAllFollowers turned it, because the
   * target entered warp or was removed), else hits on Destiny's swept CollideTwoSpheres over the tick (missile radius
   * plus target radius; a point test would miss frigates at 10 km/s). Ends send the ball straight on.
   */
  private TrackMissiles(): void {
    const tick = this.master.currentTime;
    const start = tick - 1;
    for (const entry of [...this.missiles.values()]) {
      if (entry.state === 'done') {
        if (entry.removeAt != null && tick >= entry.removeAt) this.DropMissile(entry);
        continue;
      }
      const ball = this.master.GetBall(entry.ballId);
      const from = entry.from;
      entry.from = null;
      if (!ball) {
        this.EndMissile(entry, 'lost', tick, 'its ball is gone');
        continue;
      }
      if (tick > entry.expiresAt) {
        this.EndMissile(entry, 'expired', entry.expiresAt);
        continue;
      }
      const shooter = this.ShooterLoss(entry);
      if (shooter) {
        this.EndMissile(entry, 'lost', tick, shooter);
        continue;
      }
      if (entry.state !== 'flying') continue;
      const target = this.TargetEntry(entry.target);
      const targetBall = target ? this.master.GetBall(target.ballId) : null;
      if (ball.mode !== MISSILE_MODE || !targetBall) {
        entry.state = 'lost';
        entry.why = this.TargetLoss(entry);
        this.missileEvents.push(this.MissileEventOf(entry, 'lost', tick, false));
        continue;
      }
      if (!from?.target) continue;
      const contact = CollideTwoSpheres(from.missile, [ball.x, ball.y, ball.z], from.target, [targetBall.x, targetBall.y, targetBall.z], entry.radius + targetBall.radius);
      if (contact >= 0 && contact <= 1) this.EndMissile(entry, 'hit', start + contact);
    }
  }

  /**
   * Why a missile's shooter can no longer have it: removed, destroyed or in proper warp.
   */
  private ShooterLoss(entry: MissileEntry): Maybe<string> {
    const owner = this.ships.get(entry.owner);
    let why: Maybe<string> = null;
    if (!owner) why = 'its ship was removed';
    else if (owner.destroyed) why = 'its ship was destroyed';
    else if (this.InProperWarp(owner)) why = 'its ship entered warp';
    return why;
  }

  /**
   * Why a missile's pursuit ended without a hit.
   */
  private TargetLoss(entry: MissileEntry): string {
    const ship = this.ships.get(entry.target);
    let why = 'its target was lost';
    if (!this.TargetEntry(entry.target)) why = 'its target was removed';
    else if (ship?.destroyed) why = 'its target was destroyed';
    else if (this.InProperWarp(ship)) why = 'its target entered warp';
    return why;
  }

  /**
   * Ends a missile's flight: straight on along its velocity on both parks, its ball leaving MISSILE_BALL_LINGER_TICKS
   * boundaries later.
   */
  private EndMissile(entry: MissileEntry, kind: MissileEventKind, at: number, why?: string): void {
    if (entry.state === 'flying') this.Straighten(entry);
    entry.state = 'done';
    if (why) entry.why = why;
    entry.removeAt = this.master.currentTime + MISSILE_BALL_LINGER_TICKS;
    this.missileEvents.push(this.MissileEventOf(entry, kind, at, true));
  }

  /**
   * GotoDirection along the master velocity on both parks (the parks are in lockstep, so the replica's is the same).
   */
  private Straighten(entry: MissileEntry): void {
    const ball = this.master.GetBall(entry.ballId);
    if (!ball || Math.hypot(ball.vx, ball.vy, ball.vz) === 0) return;
    const { vx, vy, vz } = ball;
    this.Both((park) => park.GotoDirection(entry.ballId, vx, vy, vz));
  }

  private DropMissile(entry: MissileEntry): void {
    this.missiles.delete(entry.id);
    this.Both((park) => park.RemoveBall(entry.ballId));
  }

  private MissileEventOf(entry: MissileEntry, kind: MissileEventKind, at: number, ended: boolean): MissileEvent {
    return { kind, id: entry.id, owner: entry.owner, target: entry.target, at, tick: this.master.currentTime, ...(entry.why && kind === 'lost' ? { why: entry.why } : {}), ended };
  }

  /**
   * Evolves both parks to `now`. When this call will run a tick, the OnBeforeBoundary listeners run first (the
   * timeline's cues), then the prop mods and the OnBoundary listeners, then pending orders, then formation warps,
   * then the arrivals due, then every following ship is steered. A call evolves at most one tick, which is why there is one OnTick per call
   * rather than a loop: the steering always precedes the tick it is for. TimeControl calls it once per boundary
   * (NextBoundaryTime), however fast the scene runs. After an evolved
   * tick the warps are tracked and OnWarp's listeners called.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @throws {Error} The first park failure, after both parks have had their turn.
   */
  Tick(now: number): void {
    const time = BigInt(Math.round(now));
    const due = time - this.master.time >= BigInt(this.master.tickInterval * TICKS_PER_MS);
    if (due) {
      this.DeliverBeforeBoundary();
      this.ApplyPropMods();
      this.DeliverBoundary();
      const boundary = this.master.currentTime;
      for (const [id, order] of [...this.pending]) {
        if ((this.pendingAt.get(id) ?? boundary) > boundary) continue;
        this.pending.delete(id);
        this.pendingAt.delete(id);
        const entry = this.ships.get(id);
        if (entry) this.ApplyOrder(entry, order);
      }
      this.ApplyFormationWarps();
      this.ApplyArrivals();
      this.Steer();
      this.MarkAligning();
    }
    if (due) this.SnapshotMissiles();
    let failure: unknown = null;
    for (const park of [this.master, this.replica]) {
      try {
        park.OnTick(time, time, null);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure instanceof Error ? failure : new Error(String(failure));
    if (due) {
      this.TrackWarps();
      this.TrackMissiles();
      this.DeliverPropModEvents();
    }
  }

  /**
   * The scene-clock time of the next tick boundary: Tick at exactly this time evolves once and leaves the grid there.
   * TimeControl (time-control.ts) steps a frame's boundaries one by one with it, so fast-forward runs every tick.
   *
   * @returns 100 ns ticks; null before the first evolve, which anchors the grid at the clock it is called with.
   */
  NextBoundaryTime(): Maybe<number> {
    return this.master.currentTime === 0 ? null : this.BoundaryTimeAfter();
  }

  /**
   * The scene-clock time of a tick boundary: OnBeforeBoundary listeners see `boundary` (the master tick before the
   * evolve) with this time. Boundaries sit on one grid, so past and future ones are a whole number of intervals away.
   *
   * @param boundary - The master tick before the boundary's evolve.
   * @returns 100 ns ticks; null before the first evolve.
   */
  BoundaryTime(boundary: number): Maybe<number> {
    return this.master.currentTime === 0 ? null : this.BoundaryTimeAfter() + (boundary - this.master.currentTime) * this.master.tickInterval * TICKS_PER_MS;
  }

  private BoundaryTimeAfter(): number {
    return Number(this.master.time) + this.master.tickInterval * TICKS_PER_MS;
  }

  /**
   * The curves a ship's ball drives; the same objects every call, so a rebuilt ship re-attaches to them, until a
   * time-control Restore replaces them (the director re-attaches the drawn hulls).
   *
   * @param id - The ship id.
   * @returns The curves, or null when no ship has that id.
   */
  Curves(id: string): Maybe<ShipCurves> {
    return this.ships.get(id)?.curves ?? null;
  }

  /**
   * Samples every ship's translation and rotation curve and every missile's translation at a time, the way the drawn
   * frame does: a jump's re-simulation calls it over its last ticks (WARMUP_TICKS) so the ClientBalls' damped history
   * is warm when drawing resumes.
   *
   * @param time - Scene ticks.
   */
  SampleCurves(time: number): void {
    const position = vec3.create();
    const rotation = quat.create();
    for (const entry of this.ships.values()) {
      entry.curves.translation.Update__Ticks(time, position);
      entry.curves.rotation.Update__Ticks(time, rotation);
    }
    for (const id of this.missiles.keys()) this.MissileCurves(id)?.Update__Ticks(time, position);
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
    const pendingAt = this.pending.has(id) ? this.pendingAt.get(id) : undefined;
    const target = TargetOf(entry.order);
    const targetEntry = target ? this.TargetEntry(target) : null;
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
      ...(pendingAt !== undefined && pendingAt > this.tick ? { respondsIn: pendingAt - this.tick } : {}),
      ...(entry.note ? { orderNote: entry.note } : {}),
      ...(targetBall ? { targetDistance: Round(Math.hypot(ball.x - targetBall.x, ball.y - targetBall.y, ball.z - targetBall.z) - ball.radius - targetBall.radius, 1) } : {}),
      heading: [Round(Wrap(ball.mNewYaw / DEGREES, 0), 10) % 360, Round(Wrap(ball.mNewPitch / DEGREES, -180), 10)],
      ...(slot ? { slotError: Round(slot.error, 1) } : {}),
      ...(warp ? { warp } : {}),
      ...(entry.formationWarp ? { formationWarp: { leader: entry.formationWarp.leader, pending: !entry.formationWarp.applied, ...(entry.formationWarp.at > this.tick ? { respondsIn: entry.formationWarp.at - this.tick } : {}) } } : {}),
      ...(entry.arrival ? { arrival: this.ArrivalReport(entry, entry.arrival) } : {}),
      physics: entry.physics,
      propMod: this.PropModReport(entry)
    };
  }

  /**
   * At a tick boundary: activations apply (unless the ship entered proper warp meanwhile), and stopping modules whose
   * cycle has ended stop.
   */
  private ApplyPropMods(): void {
    const boundary = this.master.currentTime;
    for (const entry of this.ships.values()) {
      const prop = entry.prop;
      if (prop.queued && prop.queued.at <= boundary) {
        const { on } = prop.queued;
        prop.queued = null;
        const refusal = this.PropModRefusal(entry.id, on);
        if (refusal) prop.note = `not switched ${on ? 'on' : 'off'}: ${refusal}`;
        else this.Switch(entry, on);
      }
      if (prop.state === 'activating' && (this.InProperWarp(entry) || this.Arriving(entry.id))) {
        prop.state = 'off';
        prop.note = this.Arriving(entry.id) ? 'not switched on: arriving by warp' : 'not switched on: in warp';
      } else if (prop.state === 'activating') {
        prop.state = 'active';
        prop.since = boundary;
        this.ApplyPropModNumbers(entry);
        this.PropModEventOf('on', entry, 'switch');
      } else if (prop.state === 'stopping' && (prop.stopAt ?? boundary) <= boundary) {
        prop.state = 'off';
        prop.stopAt = null;
        this.ApplyPropModNumbers(entry);
        this.PropModEventOf('off', entry, 'switch');
      }
    }
  }

  /**
   * Switches a ship's prop mod off at once (it enters proper warp, a scram lands): no event if it was only activating.
   *
   * @param entry - The ship.
   * @param note - Why, for get_state.
   * @param cause - The event's cause.
   */
  private PropModOffNow(entry: ShipEntry, note: string, cause: PropModCause): void {
    const prop = entry.prop;
    if (prop.state === 'off') return;
    const running = IsRunning(prop.state);
    prop.state = 'off';
    prop.stopAt = null;
    prop.note = note;
    this.ApplyPropModNumbers(entry);
    if (running) this.PropModEventOf('off', entry, cause);
  }

  /**
   * The mass and max velocity a ship flies now: its prop mod's while the module runs, else its own.
   *
   * @param entry - The ship.
   * @returns The numbers.
   */
  private FlownNumbers(entry: ShipEntry): { readonly mass: number; readonly maxVelocity: number } {
    const propMod = IsRunning(entry.prop.state) ? entry.physics.propMod : undefined;
    return propMod ?? entry.physics;
  }

  /**
   * Sets the numbers a ship flies now on both parks.
   *
   * @param entry - The ship.
   */
  private ApplyPropModNumbers(entry: ShipEntry): void {
    const { mass, maxVelocity } = this.FlownNumbers(entry);
    this.Both((park) => {
      park.SetBallMass(entry.ballId, mass);
      park.SetMaxSpeed(entry.ballId, maxVelocity);
    });
  }

  private PropModEventOf(kind: PropModEvent['kind'], entry: ShipEntry, cause: PropModCause): void {
    this.propModEvents.push({ kind, id: entry.id, tick: this.master.currentTime, cause });
  }

  private DeliverBeforeBoundary(): void {
    const boundary = this.master.currentTime;
    const time = this.BoundaryTimeAfter();
    for (const listener of this.beforeBoundaryListeners) {
      try {
        listener(boundary, time);
      } catch (error) {
        console.error(`an OnBeforeBoundary listener failed at tick ${boundary}`, error);
      }
    }
  }

  private DeliverBoundary(): void {
    const boundary = this.master.currentTime;
    for (const listener of this.boundaryListeners) {
      try {
        listener(boundary);
      } catch (error) {
        console.error(`an OnBoundary listener failed at tick ${boundary}`, error);
      }
    }
  }

  private DeliverPropModEvents(): void {
    const events = this.propModEvents;
    this.propModEvents = [];
    for (const event of events) {
      for (const listener of this.propModListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error(`an OnPropMod listener failed on ship ${event.id}'s prop mod ${event.kind}`, error);
        }
      }
    }
  }

  /**
   * A ship's prop mod cycle in ticks.
   *
   * @param entry - The ship.
   * @returns The cycle; DEFAULT_PROP_MOD_CYCLE_SECONDS without a prop mod in the physics.
   */
  private CycleTicks(entry: ShipEntry): number {
    return (entry.physics.propMod?.cycleTime ?? DEFAULT_PROP_MOD_CYCLE_SECONDS) / (this.master.tickInterval / 1000);
  }

  private StopsIn(stopAt: number): number {
    return Round(Math.max(0, stopAt - this.master.currentTime) * (this.master.tickInterval / 1000), 10);
  }

  private PropModReport(entry: ShipEntry): ShipPropModReport {
    const { state, since, stopAt, note } = entry.prop;
    const cycleTime = entry.physics.propMod?.cycleTime;
    return {
      state,
      running: IsRunning(state) && entry.physics.propMod !== undefined,
      ...(cycleTime === undefined ? {} : { cycleTime }),
      ...(IsRunning(state) && since != null ? { since } : {}),
      ...(state === 'activating' ? { at: this.master.currentTime } : {}),
      ...(state === 'stopping' && stopAt != null ? { stopsIn: this.StopsIn(stopAt) } : {}),
      ...(entry.prop.queued ? { queued: { on: entry.prop.queued.on, respondsIn: Math.max(0, entry.prop.queued.at - this.tick) } } : {}),
      ...(note ? { note } : {})
    };
  }

  /**
   * Re-aims every following ship at its formation slot on both parks, or settles it there (section Following above).
   * A following ship in proper warp finishes its warp first; one whose anchor or FC is in proper warp or still arriving
   * holds, stopped, until that ship lands. An arriving follower is left alone until it lands, then holds until its
   * group's leader, anchor and frame ship have finished their warps and arrivals.
   */
  private Steer(): void {
    for (const entry of this.ships.values()) {
      const follow = entry.follow;
      if (!follow || this.InProperWarp(entry)) continue;
      if (entry.arrival) {
        if (entry.arrival.state !== 'landed') continue;
        const waiting = [entry.arrival.leader, follow.anchor, follow.frame].find((other) => other != null && other !== entry.id && WarpUnfinished(this.ships.get(other)));
        if (waiting) {
          if (entry.held !== waiting) this.Both((park) => park.Stop(entry.ballId));
          entry.held = waiting;
          entry.settled = false;
          continue;
        }
        entry.arrival = null;
        entry.held = null;
        // Re-applies FollowOrder below, which clears its warp report.
        entry.followApplied = false;
      }
      if (entry.formationWarp) {
        if (this.FormationWarpWaits(entry, follow)) continue;
        entry.formationWarp = null;
        // Re-applies FollowOrder below, which clears its warp report.
        entry.followApplied = false;
      }
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
      const warping = [follow.anchor, follow.frame].find((other) => this.InProperWarp(this.ships.get(other)) || this.Arriving(other));
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
   * Resolves and orders every formation warp not yet applied (WarpInFormation), after the plain pending orders. All the
   * math reads the master once, outside Both, as ApplyOrder does for warps.
   */
  private ApplyFormationWarps(): void {
    for (const entry of this.ships.values()) {
      const formation = entry.formationWarp;
      // A delayed pilot, or a leader whose own (delayed) order has not applied yet, waits.
      if (!formation || formation.applied || formation.at > this.master.currentTime || this.pending.has(formation.leader)) continue;
      const leader = this.ships.get(formation.leader);
      const leaderBall = leader ? this.master.GetBall(leader.ballId) : null;
      if (!leader || !leaderBall) {
        entry.note = `dropped: its formation warp's leader "${formation.leader}" was removed`;
        entry.formationWarp = null;
        continue;
      }
      const at: SceneVector = [leaderBall.x, leaderBall.y, leaderBall.z];
      const warp = leader.warp && leader.warp.landed == null ? leader.warp : null;
      const landing = warp ? (warp.start?.landing ?? LandingPoint(warp.destination, warp.range, at)) : at;
      const frame = warp ? WarpFrame(warp.start?.from ?? at, landing) : FleetFrame(leaderBall.mNewYaw, leaderBall.mNewPitch);
      const order: ShipOrder = { type: 'warp', point: RoundVector(FramePoint({ origin: landing, frame, offset: formation.offset }), 100), range: 0 };
      const refusal = this.OrderRefusal(entry.id, order);
      if (refusal) {
        entry.note = `dropped: its formation warp (${refusal})`;
        entry.formationWarp = null;
      } else {
        // Applied even when Destiny refuses it (ApplyOrder halts it): the wait rule then lets it follow once the group lands.
        this.ApplyOrder(entry, order);
        formation.applied = true;
      }
    }
  }

  /**
   * Starts every scheduled arrival due at this boundary, after the formation warps: Destiny's EntityWarpIn on both
   * parks at its warp factor (WarpFactor first, outside Both: a bad factor would throw between the parks) and speed
   * fraction 1. Both balls must be in proper warp; otherwise the ship is placed at its landing with a note.
   */
  private ApplyArrivals(): void {
    const boundary = this.master.currentTime;
    for (const entry of this.ships.values()) {
      const arrival = entry.arrival;
      if (!arrival || arrival.state !== 'scheduled' || arrival.at == null || arrival.at > boundary) continue;
      const { ballId } = entry;
      const factor = arrival.factor ?? WarpFactor(entry.physics.warpSpeed ?? DEFAULT_WARP_SPEED);
      const refusal = this.master.GetBall(ballId)?.maxVelocity ? null : 'its max velocity is 0';
      if (!refusal) {
        this.Both((park) => {
          park.SetSpeedFraction(ballId, 1);
          park.EntityWarpIn(ballId, ...arrival.landing, factor);
        });
      }
      if (!refusal && this.master.GetBall(ballId)?.IsWarping() && this.replica.GetBall(ballId)?.IsWarping()) {
        entry.order = { type: 'warp', point: arrival.landing, range: 0 };
        entry.note = null;
        entry.warp = { destination: arrival.landing, range: 0, factor, lastAlign: arrival.from, start: null, landed: null, arrival: true };
        arrival.state = 'warping';
      } else {
        const why = refusal ?? 'Destiny refused the warp-in';
        console.warn(`ship ${entry.id}: ${why}, so it is placed at its landing`);
        this.PlaceShip({ id: entry.id, position: arrival.landing, rotation: arrival.rotation });
        entry.note = `placed at its landing: ${why}`;
      }
    }
  }

  /**
   * A ship's arrival report.
   *
   * @param entry - The ship.
   * @param arrival - Its arrival.
   * @returns The report: a scheduled one's landsIn from Destiny's profile over its lane, a warping one's from its warp.
   */
  private ArrivalReport(entry: ShipEntry, arrival: ArrivalEntry): ShipArrivalReport {
    const ball = this.master.GetBall(entry.ballId);
    let timing: { readonly startsIn?: number; readonly landsIn?: number; readonly landedAt?: number } = {};
    if (arrival.state === 'scheduled' && arrival.at != null && ball) {
      const startsIn = Math.max(0, arrival.at - this.tick);
      const factor = arrival.factor ?? WarpFactor(entry.physics.warpSpeed ?? DEFAULT_WARP_SPEED);
      const ticks = WarpInExitTicks(this.WarpProfile(factor, Distance(arrival.landing, arrival.from)), ball.maxVelocity, WarpInBackdate(this.tick + startsIn));
      timing = { startsIn, ...(Number.isFinite(ticks) ? { landsIn: startsIn + ticks } : {}) };
    } else if (arrival.state === 'warping' && ball) {
      const landsIn = this.WarpReport(entry, ball)?.landsIn;
      timing = landsIn === undefined ? {} : { landsIn };
    } else if (arrival.state === 'landed' && arrival.landed != null) {
      timing = { landedAt: arrival.landed };
    }
    return { state: arrival.state, from: RoundVector(arrival.from, 100), landing: RoundVector(arrival.landing, 100), ...timing, ...(arrival.leader ? { leader: arrival.leader } : {}) };
  }

  /**
   * Whether a formation-warp ship still waits for its group: its warp not yet applied, or it, its leader, its anchor or
   * its frame ship not yet done with a warp.
   *
   * @param entry - The ship, with a formation warp.
   * @param follow - What it follows.
   * @returns True while Steer should leave it alone.
   */
  private FormationWarpWaits(entry: ShipEntry, follow: ShipFollow): boolean {
    const formation = entry.formationWarp;
    if (!formation?.applied || WarpUnfinished(entry)) return Boolean(formation);
    return [formation.leader, follow.anchor, follow.frame].some((id) => WarpUnfinished(this.ships.get(id)));
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
    if (order.type === 'warp' && entry.tackle.warp) {
      entry.note = `dropped: the warp order (${entry.tackle.warp})`;
      return;
    }
    const target = shipOrderTarget(order);
    const targetEntry = target ? this.TargetEntry(target) : undefined;
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
        this.PropModOffNow(entry, 'off: entered warp', 'warp');
        const landing: SceneVector = [ball.gotoX, ball.gotoY, ball.gotoZ];
        const distance = Distance(landing, warp.lastAlign);
        warp.start = { from: warp.lastAlign, landing, distance, stamp: ball.effectStamp, profile: this.master.SetupWarpConstants(warp.factor, distance, {}) };
        events.push(this.WarpEventOf('enter', entry, warp, ball));
      } else if (warp.start && !ball.IsWarpish()) {
        warp.landed = this.master.currentTime;
        this.Both((park) => park.SetBallMassive(entry.ballId, false));
        if (warp.arrival && entry.arrival) {
          entry.arrival.state = 'landed';
          entry.arrival.landed = warp.landed;
        }
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
      warpSpeed: warp.factor / 1000,
      ...(warp.arrival ? { arrival: true as const } : {})
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
      if (warp.arrival) report = { ...report, arrival: true };
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

/**
 * Starts a placed ball's current tick interval over at rest. Between ticks a ClientBall integrates from the
 * interval's start with the ball's last forces and turns from the interval's old heading, and neither
 * SetBallPosition nor SetBallVelocity resets them: a ship placed mid-tick at full speed slid on along its old thrust
 * (about 56 m for a Punisher), popped back at the next tick, and swung a third of the way back toward its old
 * heading before easing to the new one. Clearing the forces (as every evolve does first) and snapping the heading a
 * second time (the snap keeps the previous heading as the interval's old one) holds it still. Both parks get it, so
 * they stay identical.
 *
 * @param park - The park.
 * @param ballId - The placed ball.
 */
function RestartInterval(park: CjsBallparkController, ballId: number): void {
  const ball = park.GetBall(ballId);
  if (ball) {
    ball.mLastG.fill(0);
    ball.mLastC.fill(0);
    park.SetBallVelocity(ballId, 0, 0, 0);
  }
}

function RequireValidPhysics(physics: ShipPhysics): void {
  const bad: string[] = (['mass', 'agility', 'maxVelocity', 'radius'] as const).filter((key) => {
    const value = physics[key];
    return !Number.isFinite(value) || value < 0 || (value === 0 && key !== 'maxVelocity');
  });
  const { propMod } = physics;
  if (propMod) bad.push(...(['mass', 'maxVelocity', 'cycleTime'] as const).filter((key) => !Number.isFinite(propMod[key]) || propMod[key] < 0 || (propMod[key] === 0 && key !== 'maxVelocity')).map((key) => `propMod.${key}`));
  const { warpSpeed } = physics;
  if (warpSpeed !== undefined && (!(warpSpeed > 0) || !IsWarpFactor(warpSpeed))) bad.push('warpSpeed');
  if (bad.length) throw new Error(`ship physics must be finite and positive (max velocity may be 0): ${bad.join(', ')}`);
}

/**
 * Seconds per prop mod cycle when the physics carry no prop mod.
 */
const DEFAULT_PROP_MOD_CYCLE_SECONDS = 10;

function IsRunning(state: PropModState): boolean {
  return state === 'active' || state === 'stopping';
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

/**
 * Whether a ship is still busy with a warp: a formation warp not yet resolved, a warp in force not yet landed, or an
 * arrival not yet landed.
 *
 * @param entry - The ship, if any.
 * @returns False for no ship.
 */
function WarpUnfinished(entry: Maybe<ShipEntry>): boolean {
  return entry ? Boolean(entry.formationWarp && !entry.formationWarp.applied) || (entry.warp != null && entry.warp.landed == null) || (entry.arrival != null && entry.arrival.state !== 'landed') : false;
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
