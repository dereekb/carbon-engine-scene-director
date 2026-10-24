/**
 * Snapshots of a Destiny park (sd-time): the native full-state stream plus a scalar overlay. WriteFullStateToStream
 * carries each ball's id, mode, radius, position, flags, mass, velocity, agility, speed fraction, formation and its
 * mode's payload, but not the park's own clock (mTime, mFirstTime), nor per ball the old samples, the legacy heading and
 * roll state (mass-damped, so stateful), mGoto outside the goto modes, the stamps outside the stamped modes, or any
 * ClientBall sampling cache. So CapturePark also copies every own scalar field of the park and of each ball (numbers,
 * bigints, booleans, strings, typed arrays and arrays of primitives), and RestorePark reads the stream into a fresh
 * park and lays those scalars back over it. Object references and registries are left to the stream's re-insertion
 * (the structural lists below); the bubble ids too, since re-insertion allocates them afresh.
 *
 * The restore builds a new park, so a failure leaves the live parks as they were. destiny-snapshot.spec.ts audits the
 * result field by field against an uninterrupted run, across every mode the page flies.
 *
 * Node-tested: it imports only runtime-sim.
 */

import { CjsDestinyStream, type CjsBallparkController } from './runtime-sim';

/**
 * How many ticks before its target a jump's snapshot is at least, so the re-simulation can warm the ClientBalls.
 */
export const WARMUP_TICKS = 3;
/**
 * How often per tick the warm-up samples every curve (DestinyWorld.SampleCurves) over the last WARMUP_TICKS ticks. The
 * ClientBall's rotation damping is implicit Euler per sample, so its history depends on how often it was sampled: 30 a
 * tick lands within 0.4° of a run drawn at 60 fps (4 a tick, 3.6°).
 */
export const WARMUP_SAMPLES_PER_TICK = 30;

/**
 * A scalar field's value: a primitive, a typed array (copied) or an array of primitives (copied).
 */
export type ScalarValue = number | bigint | boolean | string | ArrayLike<number> | ArrayLike<bigint> | readonly (number | bigint | boolean | string)[];

/**
 * An object's scalar fields by name.
 */
export type Scalars = Readonly<Record<string, ScalarValue>>;

/**
 * One park as CapturePark took it.
 */
export interface ParkSnapshot {
  /**
   * The park's tick count, checked after the restore.
   */
  readonly currentTime: number;
  /**
   * The native full-state stream.
   */
  readonly stream: Uint8Array;
  /**
   * The park's own scalars.
   */
  readonly park: Scalars;
  /**
   * Each live ball's scalars, in the park's ball order.
   */
  readonly balls: readonly (readonly [bigint, Scalars])[];
}

/**
 * Ball fields the overlay leaves to the stream's re-insertion: object references and containers (the park, the follow
 * pointer and followers, mini shapes, the proximity sensor, collisions, the tracking pointer), the partition's
 * membership (boxes, active boxes, the box list and modulus, recomputed from the position) and the bubble ids.
 */
export const STRUCTURAL_BALL_FIELDS: ReadonlySet<string> = new Set(['mPark', 'mFollowPtr', 'mFollowers', 'mMiniBalls', 'mMiniCapsules', 'mMiniBoxes', 'mSensor', 'mCollisions', 'mTrackingPtr', 'mBoxes', 'mMyBox', 'mActiveBoxes', 'mMod', 'mBoxList', 'mNewBubble', 'mOldBubble']);

/**
 * Park fields the overlay leaves alone: the ball map and every registry the stream's re-insertion rebuilds, the host
 * links, the ego ball cache and the bubble counter.
 */
export const STRUCTURAL_PARK_FIELDS: ReadonlySet<string> = new Set([
  '_balls',
  '_blueOS',
  '_pyOS',
  '_freeBallIds',
  'mFreeBalls',
  'mPartition',
  'mFormations',
  'mGlobals',
  'mStaticCollidables',
  'mCapsules',
  'mOrientedBoxes',
  'mCollisionLocations',
  'mProximityBalls',
  'mPotentialCollisionBalls',
  'mPotentialCollidables',
  'moribundBalls',
  'moribundCapsules',
  'moribundOrientedBoxes',
  'bubbles',
  'bubbleInteractives',
  'bubbleKeepAlives',
  'bubbleKeepAliveBalls',
  'mBubbleSubscriptions',
  'mBubbleId',
  'mLastEgoBall'
]);

/**
 * Copies an object's own scalar fields, skipping the structural ones.
 *
 * @param object - A park or a ball.
 * @param structural - Fields to skip.
 * @returns The scalars.
 */
export function CaptureScalars(object: object, structural: ReadonlySet<string>): Scalars {
  const fields = object as Record<string, unknown>;
  const scalars: Record<string, ScalarValue> = {};
  for (const key of Object.keys(fields)) {
    if (structural.has(key)) continue;
    const value = fields[key];
    const kind = typeof value;
    if (kind === 'number' || kind === 'bigint' || kind === 'boolean' || kind === 'string') scalars[key] = value as ScalarValue;
    else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) scalars[key] = (value as unknown as Float64Array).slice();
    else if (Array.isArray(value) && value.every(IsPrimitive)) scalars[key] = [...(value as (number | bigint | boolean | string)[])];
  }
  return scalars;
}

/**
 * Lays scalars over an object: primitives assigned, typed arrays and arrays refilled in place.
 *
 * @param object - A park or a ball.
 * @param scalars - From CaptureScalars.
 */
export function OverlayScalars(object: object, scalars: Scalars): void {
  const fields = object as Record<string, unknown>;
  for (const key of Object.keys(scalars)) {
    const value = scalars[key];
    const current = fields[key];
    if (ArrayBuffer.isView(value)) {
      if (ArrayBuffer.isView(current) && (current as Float64Array).length === (value as Float64Array).length) (current as Float64Array).set(value as Float64Array);
      else fields[key] = (value as unknown as Float64Array).slice();
    } else if (Array.isArray(value)) {
      if (Array.isArray(current)) {
        current.length = 0;
        for (const item of value) current.push(item);
      } else fields[key] = [...value];
    } else fields[key] = value;
  }
}

function IsPrimitive(value: unknown): boolean {
  const kind = typeof value;
  return kind === 'number' || kind === 'bigint' || kind === 'boolean' || kind === 'string';
}

/**
 * Snapshots a park between ticks.
 *
 * @param park - The park.
 * @returns Its stream and scalars.
 * @throws {Error} When a ball holds collisions (ships are non-massive, so none should).
 */
export function CapturePark(park: CjsBallparkController): ParkSnapshot {
  const stream = new CjsDestinyStream();
  park.WriteFullStateToStream(stream);
  const balls: (readonly [bigint, Scalars])[] = [];
  for (const ball of park.balls.values()) {
    const fields = ball as unknown as Record<string, unknown>;
    if (fields['isMoribund'] === true) continue;
    const collisions = fields['mCollisions'];
    if (Array.isArray(collisions) && collisions.length > 0) throw new Error(`a Destiny snapshot cannot carry ball ${String(fields['mId'])}'s collisions`);
    balls.push([fields['mId'] as bigint, CaptureScalars(ball, STRUCTURAL_BALL_FIELDS)]);
  }
  return { currentTime: park.currentTime, stream: stream.GetBytes(), park: CaptureScalars(park, STRUCTURAL_PARK_FIELDS), balls };
}

/**
 * Builds a fresh park from a snapshot: the stream read into it, then the park's and every ball's scalars laid over.
 * Nothing else is touched, so a failure leaves the caller's parks as they were.
 *
 * @param snapshot - From CapturePark.
 * @param isMaster - Whether it is the master.
 * @param create - Makes the empty park (the page's park class).
 * @returns The park.
 * @throws {Error} When the stream does not read back, or the balls or tick do not match the snapshot.
 */
export function RestorePark<T extends CjsBallparkController>(snapshot: ParkSnapshot, isMaster: boolean, create: () => T): T {
  const park = create();
  park.isMaster = isMaster;
  park.ReadFullStateFromStream(new CjsDestinyStream(snapshot.stream), 0);
  if (park.balls.size !== snapshot.balls.length) throw new Error(`a Destiny snapshot read back ${park.balls.size} balls for ${snapshot.balls.length}`);
  OverlayScalars(park, snapshot.park);
  for (const [id, scalars] of snapshot.balls) {
    const ball = park.GetBall(id);
    if (!ball) throw new Error(`a Destiny snapshot lost ball ${id}`);
    OverlayScalars(ball, scalars);
  }
  if (park.currentTime !== snapshot.currentTime || park.isMaster !== isMaster) throw new Error(`a Destiny snapshot restored tick ${park.currentTime} for ${snapshot.currentTime}`);
  return park;
}

/**
 * A park snapshot's size in bytes (the stream, plus 8 B per scalar and each array's length).
 *
 * @param snapshot - The snapshot.
 * @returns Bytes.
 */
export function ParkSnapshotBytes(snapshot: ParkSnapshot): number {
  let bytes = snapshot.stream.byteLength + ScalarBytes(snapshot.park);
  for (const [, scalars] of snapshot.balls) bytes += 8 + ScalarBytes(scalars);
  return bytes;
}

function ScalarBytes(scalars: Scalars): number {
  let bytes = 0;
  for (const key of Object.keys(scalars)) {
    const value = scalars[key];
    bytes += 8 + (ArrayBuffer.isView(value) ? value.byteLength : Array.isArray(value) ? 8 * value.length : 0);
  }
  return bytes;
}
