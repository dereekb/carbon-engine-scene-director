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
 * - Physics are class defaults by SOF hull category (or bounding radius), not dogma; the document's `stats`
 *   overrides replace them.
 */

import type { Maybe } from '@dereekb/util';
import type { HullStatOverrides, SceneShip, SceneVector, ShipOrder } from '@scene-director/scene';
import { TICKS_PER_MS } from './clock';
import type { EveShip2 } from './runtime';
import { CjsBallparkController, CjsDestinyBall, CjsDestinyClientBall, ITriQuaternionFunction, quat, vec3, type Quat } from './runtime-sim';

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
 * Cruiser-class physics, used until a ship's hull is known.
 */
export const DEFAULT_SHIP_PHYSICS: ShipPhysics = { mass: 1.1e7, agility: 0.5, maxVelocity: 230, radius: 100 };

type ShipClass = 'frigate' | 'destroyer' | 'cruiser' | 'battlecruiser' | 'battleship' | 'capital' | 'titan';

/**
 * Class defaults, chosen for plausible align times (frigate about 5 s, battleship about 17 s).
 */
const CLASS_PHYSICS: Record<ShipClass, Omit<ShipPhysics, 'radius'>> = {
  frigate: { mass: 1.2e6, agility: 3.2, maxVelocity: 350 },
  destroyer: { mass: 1.7e6, agility: 3.5, maxVelocity: 260 },
  cruiser: { mass: 1.1e7, agility: 0.5, maxVelocity: 230 },
  battlecruiser: { mass: 1.3e7, agility: 0.7, maxVelocity: 160 },
  battleship: { mass: 1e8, agility: 0.12, maxVelocity: 110 },
  capital: { mass: 1.1e9, agility: 0.035, maxVelocity: 80 },
  titan: { mass: 2.4e9, agility: 0.025, maxVelocity: 70 }
};

/**
 * SOF hull categories by class. Names other than frigate and battleship are unconfirmed; an unknown category falls
 * back to the radius bands.
 */
const CATEGORY_CLASSES: Readonly<Record<string, ShipClass>> = {
  frigate: 'frigate',
  destroyer: 'destroyer',
  cruiser: 'cruiser',
  battlecruiser: 'battlecruiser',
  battleship: 'battleship',
  carrier: 'capital',
  dreadnought: 'capital',
  supercarrier: 'capital',
  forceauxiliary: 'capital',
  titan: 'titan'
};

/**
 * Bounding radius (m) upper bounds by class; anything larger is a titan.
 */
const RADIUS_BANDS: readonly (readonly [number, ShipClass])[] = [
  [75, 'frigate'],
  [150, 'destroyer'],
  [350, 'cruiser'],
  [600, 'battlecruiser'],
  [1500, 'battleship'],
  [5000, 'capital']
];

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
   * The ball mode: stop, goto, follow, orbit, warp, ...
   */
  readonly mode: string;
  readonly physics: ShipPhysics;
}

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
  readonly ballId: number;
  readonly curves: ShipCurves;
  physics: ShipPhysics;
}

/**
 * The page's Destiny simulation: a master and a replica park in lockstep, one ball per document ship.
 */
export class DestinyWorld {
  readonly master: CjsBallparkController;
  readonly replica: CjsBallparkController;
  private readonly ships = new Map<string, ShipEntry>();
  /**
   * Movement orders waiting for the next tick boundary, by ball id; the latest order wins.
   */
  private readonly pending = new Map<number, ShipOrder>();
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
      this.ships.set(doc.id, { ballId, curves: { translation: ball, rotation: new BallRotation(ball) }, physics });
    }
    this.PlaceShip(doc);
  }

  /**
   * Puts a ship at rest at a placement, facing along its rotation.
   *
   * @param doc - The document ship.
   */
  PlaceShip(doc: Pick<SceneShip, 'id' | 'position' | 'rotation'>): void {
    const entry = this.ships.get(doc.id);
    if (!entry) return;
    const { ballId } = entry;
    this.pending.delete(ballId);
    const [x, y, z] = doc.position;
    const rotation = DocumentRotation(doc.rotation);
    const forward = vec3.transformQuat(vec3.create(), [0, 0, 1], rotation);
    const gotoX = x + forward[0] * GOTO_DISTANCE;
    const gotoY = y + forward[1] * GOTO_DISTANCE;
    const gotoZ = z + forward[2] * GOTO_DISTANCE;
    this.Both((park) => {
      park.Stop(ballId);
      park.SetBallPosition(ballId, x, y, z);
      const ball = park.GetBall(ballId);
      if (ball) {
        ball.gotoX = gotoX;
        ball.gotoY = gotoY;
        ball.gotoZ = gotoZ;
      }
      // Zero velocity snaps the legacy heading to the goto point.
      park.SetBallVelocity(ballId, 0, 0, 0);
    });
    // The heading Destiny derives from the same goto offsets, then whatever the document adds to it (its roll).
    const heading = HeadingRotation(gotoX - x, gotoY - y, gotoZ - z);
    quat.multiply(entry.curves.rotation.attitude, quat.conjugate(heading, heading), rotation);
  }

  /**
   * Changes what a ship flies with, on both parks.
   *
   * @param id - The ship id.
   * @param physics - The new physics.
   * @throws {Error} When a value is not positive and finite (Destiny would stop the whole park on it).
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
   * Removes a ship's ball from both parks (they drop it on their next tick).
   *
   * @param id - The ship id.
   */
  RemoveShip(id: string): void {
    const entry = this.ships.get(id);
    if (!entry) return;
    this.ships.delete(id);
    this.pending.delete(entry.ballId);
    this.Both((park) => park.RemoveBall(entry.ballId));
  }

  /**
   * Queues a movement order for the next tick boundary.
   *
   * @param id - The ship id.
   * @param order - A normalized order.
   * @returns False when no ship has that id.
   */
  Order(id: string, order: ShipOrder): boolean {
    const entry = this.ships.get(id);
    if (!entry) return false;
    this.pending.set(entry.ballId, order);
    return true;
  }

  /**
   * Evolves both parks to `now`. Pending orders apply first when this call will run a tick.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @throws {Error} The first park failure, after both parks have had their turn.
   */
  Tick(now: number): void {
    const time = BigInt(Math.round(now));
    if (this.pending.size && time - this.master.time >= BigInt(this.master.tickInterval * TICKS_PER_MS)) {
      for (const [ballId, order] of this.pending) this.ApplyOrder(ballId, order);
      this.pending.clear();
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
    return {
      position: [Round(ball.x, 100), Round(ball.y, 100), Round(ball.z, 100)],
      velocity: [Round(ball.vx, 100), Round(ball.vy, 100), Round(ball.vz, 100)],
      speed: Round(Math.hypot(ball.vx, ball.vy, ball.vz), 10),
      mode: ModeName(ball.mode),
      physics: entry.physics
    };
  }

  private ApplyOrder(ballId: number, order: ShipOrder): void {
    this.Both((park) => {
      if (order.type === 'stop') {
        park.Stop(ballId);
      } else {
        park.SetSpeedFraction(ballId, order.speed);
        park.GotoDirection(ballId, ...order.direction);
      }
    });
  }

  /**
   * Applies a change to the master, then the replica.
   *
   * @param change - Called with each park.
   */
  private Both(change: (park: CjsBallparkController) => void): void {
    change(this.master);
    change(this.replica);
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
 * Class-default physics for a hull, with the document's stat overrides on top.
 *
 * @param hull - The hull's SOF category and radius; null when unknown.
 * @param overrides - The document ship's `stats`.
 * @returns The physics.
 */
export function ShipPhysicsFromHull(hull: Maybe<ShipHull>, overrides?: Maybe<HullStatOverrides>): ShipPhysics {
  const radius = IsPositive(hull?.radius) ? hull.radius : DEFAULT_SHIP_PHYSICS.radius;
  const category = hull?.category?.toLowerCase().replaceAll(/[^a-z]/gu, '');
  let shipClass: Maybe<ShipClass> = category ? CATEGORY_CLASSES[category] : null;
  if (!shipClass && IsPositive(hull?.radius)) shipClass = RADIUS_BANDS.find(([bound]) => radius < bound)?.[1] ?? 'titan';
  const base = shipClass ? { ...CLASS_PHYSICS[shipClass], radius } : DEFAULT_SHIP_PHYSICS;
  return {
    mass: IsPositive(overrides?.mass) ? overrides.mass : base.mass,
    agility: IsPositive(overrides?.agility) ? overrides.agility : base.agility,
    maxVelocity: IsPositive(overrides?.maxVelocity) ? overrides.maxVelocity : base.maxVelocity,
    radius: base.radius
  };
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
  const bad = (['mass', 'agility', 'maxVelocity', 'radius'] as const).filter((key) => !IsPositive(physics[key]));
  if (bad.length) throw new Error(`ship physics must be positive and finite: ${bad.join(', ')}`);
}

function IsPositive(value: Maybe<number>): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function Round(value: number, scale: number): number {
  return Math.round(value * scale) / scale + 0;
}
