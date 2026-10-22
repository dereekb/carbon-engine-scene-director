/**
 * Minimal types for the @carbonenginejs/server (Destiny) imports in runtime-sim.ts. The server ships no
 * declarations, so this states only the members the page uses. Add a member here when the page starts using it.
 */

declare module '@carbonenginejs/server/destiny' {
  /**
   * A native signed int64 (ball ids, 100 ns timestamps). The server keeps them as bigint and accepts safe integers.
   */
  export type DestinyInt64 = number | bigint;

  /**
   * A Destiny ball: the master park's authoritative state. It has no sampling methods.
   */
  export class CjsDestinyBall {
    /**
     * Ball modes by name (DSTBALL_GOTO, DSTBALL_STOP, ...).
     */
    static readonly DSTBALLMODE: Readonly<Record<string, number>> & {
      readonly DSTBALL_GOTO: number;
      readonly DSTBALL_FOLLOW: number;
      readonly DSTBALL_STOP: number;
      readonly DSTBALL_ORBIT: number;
      readonly DSTBALL_WARP: number;
    };
    readonly id: bigint;
    /**
     * The authoritative position, in metres.
     */
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /**
     * The authoritative velocity, in metres per second.
     */
    readonly vx: number;
    readonly vy: number;
    readonly vz: number;
    readonly mode: number;
    readonly mass: number;
    readonly radius: number;
    readonly maxVelocity: number;
    /**
     * EVE's inertia modifier: the align time is -ln(0.25) * mass * agility / 1e6 seconds.
     */
    readonly agility: number;
    readonly speedFraction: number;
    readonly isFree: boolean;
    /**
     * The ball a follow or orbit order flies relative to.
     */
    readonly followId: bigint;
    /**
     * A follow or orbit range in metres (f32), surface to surface.
     */
    readonly followRange: number;
    /**
     * The legacy heading in radians, yaw atan2(x, z) and pitch -asin(y / r) (DocumentRotation's convention), that
     * Destiny turns each tick toward the velocity, biased toward the goto point, or toward the goto point at exactly
     * zero velocity. Damped by mass; the yaw is kept continuous, so it is not wrapped to one turn.
     */
    readonly mNewYaw: number;
    readonly mNewPitch: number;
    /**
     * The last tick's goal and collision accelerations (vec3d): a ClientBall integrates between ticks with their
     * sum. Every evolve clears and recomputes them.
     */
    readonly mLastG: Float64Array;
    readonly mLastC: Float64Array;
    /**
     * The point a legacy-oriented ball heads for, and faces while it is at rest.
     */
    gotoX: number;
    gotoY: number;
    gotoZ: number;
    /**
     * In warp mode: -1 minus the ticks spent aligning, then the tick proper warp began.
     */
    readonly effectStamp: number;
    /**
     * In warp mode, the warp factor (1000 × AU/s).
     */
    get ownerId(): bigint;
    set ownerId(value: DestinyInt64);
    readonly isMassive: boolean;
    /**
     * Whether the ball is in warp mode: aligning or in proper warp.
     */
    IsWarpish(): boolean;
    IsAligningForWarp(): boolean;
    /**
     * Whether the ball is in proper warp (past aligning).
     */
    IsWarping(): boolean;
  }

  /**
   * SetupWarpConstants' record: Destiny's three-phase warp profile.
   */
  export interface WarpConstants {
    accelDuration: number;
    cruiseDuration: number;
    decelDuration: number;
    accelDistance: number;
    cruiseDistance: number;
    decelDistance: number;
    accelRate: number;
    decelRate: number;
    /**
     * m/s, capped for short warps.
     */
    warpSpeed: number;
  }

  /**
   * A replica park's ball: the renderer's translation and rotation curve. A vec3 output samples the position relative
   * to the park's ego, a quaternion output samples the rotation. Time is integer 100 ns ticks; samples trail the
   * park by two ticks.
   */
  export class CjsDestinyClientBall extends CjsDestinyBall {
    Update__Ticks<T extends Float32Array>(time: DestinyInt64, out: T): T;
    GetValueAt__Ticks<T extends Float32Array>(time: DestinyInt64, out: T): T;
    GetValueDotAt__Ticks<T extends Float32Array>(time: DestinyInt64, out: T): T;
    GetValueDoubleDotAt__Ticks<T extends Float32Array>(time: DestinyInt64, out: T): T;
  }

  /**
   * A Destiny ballpark. A replica (the default) creates CjsDestinyClientBall; a master creates CjsDestinyBall.
   */
  export class CjsBallparkController {
    constructor(blueOS?: null, pyOS?: null);
    isMaster: boolean;
    /**
     * Whole ticks evolved so far.
     */
    readonly currentTime: number;
    /**
     * The last simulation timestamp, in 100 ns ticks.
     */
    readonly time: bigint;
    /**
     * The tick length, in milliseconds.
     */
    tickInterval: number;
    /**
     * Seconds per tick.
     */
    readonly dt: number;
    get ego(): bigint;
    set ego(value: DestinyInt64);
    AddBall(objectId: DestinyInt64, mass: number, radius: number, maxVel: number, isFree: boolean, isGlobal: boolean, isMassive: boolean, isInteractive: boolean, isSpaceJunk: boolean, x: number, y: number, z: number, vx: number, vy: number, vz: number, agility: number, speedFraction: number): CjsDestinyBall;
    GetBall(id: DestinyInt64): CjsDestinyBall | null;
    RemoveBall(id: DestinyInt64, delay?: number): void;
    /**
     * Evolves every whole tick up to `simTime` (100 ns ticks).
     */
    OnTick(realTime: DestinyInt64, simTime: DestinyInt64, cookie: unknown): void;
    GotoDirection(id: DestinyInt64, x: number, y: number, z: number): void;
    /**
     * Flies to a world point (mode GOTO), slowing within one tick's travel of it. Returns without a word, keeping the
     * old order, for a non-finite point.
     */
    GotoPoint(id: DestinyInt64, x: number, y: number, z: number): void;
    /**
     * Follows another ball at `range` metres surface to surface (mode FOLLOW). Returns without a word, keeping the old
     * order, for a non-finite range, a self target, a missing, moribund or cloaked target, or a target in another
     * bubble (a master only).
     */
    FollowBall(id: DestinyInt64, targetId: DestinyInt64, range?: number): void;
    /**
     * Orbits another ball at `range` metres surface to surface (mode ORBIT). Refuses silently in the same cases as
     * FollowBall.
     */
    Orbit(id: DestinyInt64, targetId: DestinyInt64, range?: number): void;
    Stop(id: DestinyInt64): void;
    SetBallPosition(id: DestinyInt64, x: number, y: number, z: number): void;
    /**
     * Sets the velocity and snaps the heading (legacy orientation faces the goto point at rest).
     */
    SetBallVelocity(id: DestinyInt64, x: number, y: number, z: number): void;
    SetBallMass(id: DestinyInt64, mass: number): void;
    SetBallRadius(id: DestinyInt64, radius: number): void;
    SetMaxSpeed(id: DestinyInt64, speed: number): void;
    SetBallAgility(id: DestinyInt64, agility: number): void;
    /**
     * Clamped to [0, 1].
     */
    SetSpeedFraction(id: DestinyInt64, fraction: number): void;
    /**
     * Aligns and warps a ball, landing minRange metres back from the point toward where warp begins. Returns without a
     * word for a non-finite point or a missing ball; a point within 100 km becomes GotoPoint; the same destination while
     * in warp mode is a no-op.
     *
     * @throws {RangeError} For a warp factor that is not an int32.
     */
    WarpTo(id: DestinyInt64, x: number, y: number, z: number, minRange?: number, warpFactor?: number): void;
    SetBallMassive(id: DestinyInt64, flag: boolean): void;
    SetupWarpConstants(warpFactor: number, warpDistance: number, out: Partial<WarpConstants>): WarpConstants;
  }
}
