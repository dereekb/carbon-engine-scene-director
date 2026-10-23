/**
 * Launchers' missiles, drawn (missiles M3): the client's EveMissile flies on its missile ball's replica ClientBall, its
 * warheads ejected from the launcher's firing bone, and detonates on the target's drawn hull with the runtime's own
 * warhead logic; the charge's impact effect then plays where it detonated. The schedule (start, vanish, force, freeze,
 * removal, the caps) is missile-plan.ts' MissileDrawPlan; this module is its runtime half.
 *
 * - **Pools.** Missiles are pooled per projectile path (EveMissile) and impacts per impact path (EveEffectRoot2), for the
 *   page session. They hydrate from the cached file values inside PageAudio.Detached; the impact values pass through
 *   WithoutAudio first (the projectile files hold no audio). A missile goes back to its pool once every warhead is DEAD
 *   (RemoveObject); PrepareLaunch re-rolls it and Start resets its clock on its next flight.
 * - **Never Destruct a missile or an impact, and never retire one through RetireShips**: the quad renderer keys sprite
 *   records by effect content and keeps the first registered effect, so a destructed one breaks every later missile's
 *   sprites. Roots() (every pooled root, live or idle) joins every retire's retained set.
 * - **The detonation callback** only queues `(flight, warhead)`: it runs inside the scene update, where removing an
 *   object skips the next one. Frame handles the queue before the next engine.Frame.
 * - A drawn missile whose target's drawn object changes is re-aimed at the new one (a rebuilt hull), or released (its
 *   target nulled) when there is none (a hidden wreck, a removed ship).
 *
 * Runtime module (imports ./runtime): only the director, with a renderer, creates one.
 */

import type { Maybe } from '@dereekb/util';
import type { MissileGraphic } from '@scene-director/scene';
import type { Engine } from './engine';
import { WithoutAudio } from './explosions';
import type { MissileFlight } from './missile-flights';
import { MissileDrawPlan, type MissileDrawCommands, type MissileDrawReport, type MissileFile, type MissileFiles } from './missile-plan';
import { ErrorText } from './resources';
import { CjsSchema, EveEffectRoot2, EveMissile, EveMissileWarhead, Tr2TranslationAdapter, vec3, type CjsDestinyClientBall, type EveShip2, type EveSpaceObject2 } from './runtime';
import type { DetachAudio } from './ships';

/**
 * Errors kept for get_state.
 */
const MISSILE_ERRORS_KEPT = 5;

/**
 * Metres past its closest approach to its target a drawn ball counts as having passed it.
 */
const MISSILE_PASS_MARGIN = 100;

const ZERO_VELOCITY = new Float32Array(3);

type MissileTargetObject = EveShip2 | EveSpaceObject2;

/**
 * What the drawing reads off the live scene.
 */
export interface ShipMissilesPort {
  /**
   * A flight's replica ClientBall, null once its ball left the parks.
   */
  MissileCurves(id: string): Maybe<CjsDestinyClientBall>;
  /**
   * A ship's drawn velocity at `now` (m/s), into `out`; false when it has no ball.
   */
  ShipVelocity(id: string, now: number, out: Float32Array): boolean;
  /**
   * The drawn hull or object of a ship or object id, null when it has none drawn.
   */
  DrawnTarget(id: string): Maybe<MissileTargetObject>;
  /**
   * Its Destiny ball radius (m).
   */
  TargetRadius(id: string): number;
  /**
   * A ship's or object's drawn ball position at `now` into `out`; false when it has none.
   */
  TargetPosition(id: string, now: number, out: Float32Array): boolean;
  /**
   * Metres, surface to surface, null when either is gone.
   */
  SurfaceDistance(a: string, b: string): Maybe<number>;
  /**
   * The launcher's muzzle in world space into `out`; false when its set is not mounted.
   */
  FiringBone(ship: string, module: string, out: Float32Array): boolean;
}

export interface ShipMissilesOptions {
  readonly engine: Engine;
  readonly files: MissileFiles;
  readonly port: ShipMissilesPort;
  readonly detachAudio: DetachAudio;
  /**
   * Seconds per Destiny tick.
   */
  readonly tickSeconds: number;
}

/**
 * A hit's detonation, drawn this frame: the director posts its impact sound and starts a kill's explosion.
 */
export interface MissileDetonation {
  readonly id: string;
  readonly flight: MissileFlight;
}

/**
 * get_state's `renderer.missiles`.
 */
export interface ShipMissilesReport extends MissileDrawReport {
  /**
   * Instances per file (missiles by projectile, impacts by impact path): live plus idle.
   */
  readonly pools: Record<string, number>;
  /**
   * Missile file pairs loading.
   */
  readonly loading: number;
  /**
   * Launches or impacts that threw.
   */
  readonly failed: number;
  readonly errors?: string[];
}

interface LiveMissile {
  readonly flight: MissileFlight;
  readonly file: MissileFile;
  missile: Maybe<EveMissile>;
  ball: Maybe<CjsDestinyClientBall>;
  /**
   * Its ball's last sample, for a freeze.
   */
  readonly last: Float32Array;
  aimed: Maybe<MissileTargetObject>;
  /**
   * Its ball's closest distance to its target's centre so far, and this frame's.
   */
  closest: number;
  distance: Maybe<number>;
}

interface PooledImpact {
  readonly root: EveEffectRoot2;
  readonly curve: Tr2TranslationAdapter;
  readonly path: string;
}

export class ShipMissiles {
  private readonly engine: Engine;
  private readonly files: MissileFiles;
  private readonly port: ShipMissilesPort;
  private readonly detachAudio: DetachAudio;
  readonly plan: MissileDrawPlan;
  private readonly live = new Map<string, LiveMissile>();
  private readonly missilePools = new Map<string, { readonly all: EveMissile[]; readonly idle: EveMissile[] }>();
  private readonly impactPools = new Map<string, { readonly all: PooledImpact[]; readonly idle: PooledImpact[] }>();
  private readonly impacts = new Map<number, PooledImpact>();
  /**
   * Flights whose detonation played before their master end was drained.
   */
  private readonly played = new Set<string>();
  private detonations: { readonly id: string; readonly warhead: number }[] = [];
  private readonly errors: string[] = [];
  private failed = 0;
  private readonly scratch = new Float32Array(16);
  private readonly velocity = vec3.create();
  private readonly targetPosition = vec3.create();

  constructor(options: ShipMissilesOptions) {
    this.engine = options.engine;
    this.files = options.files;
    this.port = options.port;
    this.detachAudio = options.detachAudio;
    this.plan = new MissileDrawPlan({ tickSeconds: options.tickSeconds });
  }

  /**
   * A drawn launch: its missile starts at `startAt` (the burst start) when its files are loaded and the cap allows.
   *
   * @param flight - The flight.
   * @param graphic - Its missile graphic (the /missile answer); null flies it undrawn.
   * @param startAt - Scene clock, 100 ns ticks.
   * @returns Whether it draws.
   */
  Launch(flight: MissileFlight, graphic: Maybe<MissileGraphic>, startAt: number): boolean {
    const file = graphic ? this.files.Cached(graphic) : null;
    if (graphic && !file && !this.files.Failure(graphic)) this.files.Load(graphic).catch(() => undefined);
    if (!this.plan.Launch(flight.id, startAt, file?.facts.impactDuration ?? 0)) return false;
    if (!file) {
      this.plan.Skip(flight.id);
      return false;
    }
    this.live.set(flight.id, { flight, file, missile: null, ball: null, last: vec3.create(), aimed: null, closest: Infinity, distance: null });
    return true;
  }

  /**
   * Its master end is a hit, drawn at `at`.
   *
   * @returns `drawn`: the drawing plays its detonation (MissileDetonation from Frame); `played`: it already did (the
   *   missile arrived and detonated before the hit was drained: the caller starts a kill only); `undrawn`: the caller
   *   posts the impact sound and the kill at `at`.
   */
  Hit(id: string, at: number): 'drawn' | 'played' | 'undrawn' {
    if (this.played.delete(id)) return 'played';
    const drawn = this.plan.Hit(id, at);
    if (!drawn) this.live.delete(id);
    return drawn ? 'drawn' : 'undrawn';
  }

  /**
   * Its master end is an expiry or a loss, drawn at `at`: it vanishes then.
   */
  Vanish(id: string, at: number): void {
    this.played.delete(id);
    this.plan.Vanish(id, at);
    if (!this.plan.Drawn(id)) this.live.delete(id);
  }

  /**
   * Stops drawing every flight of (or at) a ship that left: they explode silently where they are.
   *
   * @param ship - The ship or object id.
   */
  Release(ship: string): void {
    for (const [id, entry] of this.live) {
      if (entry.flight.ship !== ship && entry.flight.target !== ship) continue;
      if (this.plan.Release(id)) this.EndFlight(entry.missile);
    }
  }

  /**
   * The frame at `now`, before engine.Frame: the detonations queued by the last scene update, then the plan's
   * commands.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns The hits detonated this frame.
   */
  Frame(now: number): MissileDetonation[] {
    for (const { id, warhead } of this.detonations.splice(0)) {
      const position = this.live.get(id)?.missile?.warheads[warhead]?.explosionPosition;
      if (position) this.plan.Detonated(id, position);
    }
    for (const [id, entry] of this.live) {
      const { missile } = entry;
      if (!missile) continue;
      const ball = this.port.MissileCurves(id);
      if (ball && ball === entry.ball) ball.GetValueAt__Ticks(now, entry.last);
      entry.distance = null;
      const distance = this.TargetDistance(entry, now);
      if (distance != null) entry.closest = Math.min(entry.closest, distance);
      this.Reaim(id, entry);
    }
    const commands = this.plan.Frame(now, {
      BallLive: (id) => {
        const entry = this.live.get(id);
        return entry?.ball != null && this.port.MissileCurves(id) === entry.ball;
      },
      Reached: (id) => {
        const entry = this.live.get(id);
        const distance = entry ? this.TargetDistance(entry, now) : null;
        return entry != null && distance != null && distance <= (entry.flight.numbers?.radius ?? 0) + this.port.TargetRadius(entry.flight.target);
      },
      // Moving away from its closest approach (a margin: the replica's ball can stall a frame at a boundary).
      Passed: (id) => {
        const entry = this.live.get(id);
        const distance = entry ? this.TargetDistance(entry, now) : null;
        return entry != null && distance != null && distance > entry.closest + MISSILE_PASS_MARGIN;
      },
      Dead: (id) => {
        const warheads = this.live.get(id)?.missile?.warheads;
        return warheads != null && warheads.every((warhead) => warhead.GetState() === EveMissileWarhead.State.STATE_DEAD);
      }
    });
    return this.Apply(commands, now);
  }

  /**
   * Takes every drawn missile and impact off the scene (a load); the pools stay for the page session.
   */
  Clear(): void {
    for (const id of [...this.live.keys()]) this.Return(id);
    this.live.clear();
    for (const token of [...this.impacts.keys()]) this.EndImpact(token);
    this.detonations = [];
    this.played.clear();
    this.plan.Clear();
  }

  /**
   * Every pooled root, live or idle, for every retire's retained set.
   */
  Roots(): object[] {
    const roots: object[] = [];
    for (const pool of this.missilePools.values()) roots.push(...pool.all);
    for (const pool of this.impactPools.values()) roots.push(...pool.all.map((impact) => impact.root));
    return roots;
  }

  Report(): ShipMissilesReport {
    const pools: Record<string, number> = {};
    for (const [path, pool] of this.missilePools) pools[FileName(path)] = pool.all.length;
    for (const [path, pool] of this.impactPools) pools[FileName(path)] = pool.all.length;
    return { ...this.plan.Report(), pools, loading: this.files.loading, failed: this.failed, ...(this.errors.length ? { errors: [...this.errors] } : {}) };
  }

  private Apply(commands: MissileDrawCommands, now: number): MissileDetonation[] {
    // Ended impacts go back to their pool before this frame's take from it.
    for (const token of commands.impactsEnded) this.EndImpact(token);
    for (const id of commands.start) this.Start(id, now);
    for (const id of commands.arrive) this.Freeze(id, false);
    for (const id of [...commands.vanish, ...commands.force]) this.EndFlight(this.live.get(id)?.missile);
    for (const id of commands.freeze) this.Freeze(id, true);
    const detonations: MissileDetonation[] = [];
    for (const impact of commands.impacts) {
      const entry = this.live.get(impact.id);
      if (!entry) continue;
      detonations.push({ id: impact.id, flight: entry.flight });
      if (!this.plan.HitKnown(impact.id)) this.played.add(impact.id);
      if (impact.draw) this.PlayImpact(entry.file, impact.position, impact.token);
    }
    for (const id of commands.remove) this.Return(id);
    // An entry stays while the plan holds its flight (a removed missile whose detonation waits for its master hit).
    const held = new Set(this.plan.Ids());
    for (const [id, entry] of this.live) if (!entry.missile && !held.has(id)) this.live.delete(id);
    return detonations;
  }

  private Start(id: string, now: number): void {
    const entry = this.live.get(id);
    if (!entry) return;
    const { flight, file } = entry;
    const ball = this.port.MissileCurves(id);
    const target = this.port.DrawnTarget(flight.target);
    if (!ball || !target) {
      this.plan.Skip(id);
      this.live.delete(id);
      return;
    }
    try {
      const missile = this.TakeMissile(file);
      entry.missile = missile;
      entry.ball = ball;
      entry.aimed = target;
      ball.GetValueAt__Ticks(now, entry.last);
      missile.translationCurve = ball;
      // Null: the inherited velocity and the warheads' launch transforms are world axes.
      missile.rotationCurve = null;
      missile.target = target;
      missile.targetRadius = this.port.TargetRadius(flight.target);
      missile.explosionCallback = (warhead: number): void => {
        try {
          this.detonations.push({ id, warhead });
        } catch {
          // Never throw inside the scene update.
        }
      };
      if (!this.port.ShipVelocity(flight.ship, now, this.velocity)) vec3.set(this.velocity, 0, 0, 0);
      const speed = flight.numbers?.velocity ?? 0;
      const distance = this.port.SurfaceDistance(flight.ship, flight.target) ?? 0;
      missile.Start(this.velocity, speed > 0 ? distance / speed : 1);
      // The launch transform is the launcher's muzzle in the missile's space (its ball at `now` subtracted): its +Z is
      // the eject direction. Identity when the set is not mounted.
      const start = this.scratch;
      start.fill(0);
      start[0] = start[5] = start[10] = start[15] = 1;
      if (this.port.FiringBone(flight.ship, flight.module, start)) {
        start[12] -= entry.last[0];
        start[13] -= entry.last[1];
        start[14] -= entry.last[2];
      }
      missile.warheads.forEach((warhead, index) => {
        // Without an id >= 0 a warhead never detonates (the files author -1).
        warhead.id = index;
        warhead.PrepareLaunch();
        warhead.Launch(start);
      });
      this.engine.AddObject(missile);
    } catch (error) {
      this.Fail(`${id}: its launch failed: ${ErrorText(error)}`);
      if (entry.missile) this.PoolOf(file.projectileResPath).idle.push(entry.missile);
      entry.missile = null;
      this.plan.Skip(id);
      this.live.delete(id);
    }
  }

  /**
   * Its ball's distance to its target's centre this frame (sampled once), null without a ball or a target.
   */
  private TargetDistance(entry: LiveMissile, now: number): Maybe<number> {
    if (entry.distance == null && entry.ball && this.port.TargetPosition(entry.flight.target, now, this.targetPosition)) entry.distance = vec3.distance(entry.last, this.targetPosition);
    return entry.ball ? entry.distance : null;
  }

  /**
   * Keeps a flying missile on its target's drawn object: a rebuilt hull is re-aimed, a gone one releases it.
   */
  private Reaim(id: string, entry: LiveMissile): void {
    const { missile } = entry;
    if (!missile?.target || this.plan.StateOf(id) !== 'flying') return;
    const object = this.port.DrawnTarget(entry.flight.target);
    if (object === entry.aimed) return;
    entry.aimed = object;
    if (object) missile.target = object;
    else if (this.plan.Release(id)) this.EndFlight(missile);
  }

  /**
   * Ends a drawn flight where it is: no target (no impact on any hull), and a zero time-to-target estimate, so a warhead
   * still tracking (TRACKING_SPREAD waits for its estimate to run out: seconds on a long flight) reaches TRACKING_FINAL
   * and explodes within a frame or two. Start also stops its trails emitting.
   */
  private EndFlight(missile: Maybe<EveMissile>): void {
    if (!missile) return;
    missile.target = null;
    missile.Start(ZERO_VELOCITY, 0);
  }

  /**
   * Holds a missile where its ball was last sampled: an arrival keeps its target (its warhead flies onto it), a freeze
   * (its ball left the parks) drops it.
   */
  private Freeze(id: string, dropTarget: boolean): void {
    const entry = this.live.get(id);
    const missile = entry?.missile;
    if (!entry || !missile) return;
    const curve = new Tr2TranslationAdapter();
    vec3.copy(curve.value, entry.last);
    missile.translationCurve = curve;
    // A frozen curve is no longer its ball: BallLive answers false from now on.
    entry.ball = null;
    if (dropTarget) this.EndFlight(missile);
  }

  private Return(id: string): void {
    const entry = this.live.get(id);
    const missile = entry?.missile;
    if (!entry || !missile) return;
    entry.missile = null;
    try {
      this.engine.RemoveObject(missile);
    } catch (error) {
      this.Fail(`${id}: its removal failed: ${ErrorText(error)}`);
    }
    missile.target = null;
    missile.explosionCallback = null;
    this.PoolOf(entry.file.projectileResPath).idle.push(missile);
  }

  private TakeMissile(file: MissileFile): EveMissile {
    const pool = this.PoolOf(file.projectileResPath);
    const idle = pool.idle.pop();
    if (idle) return idle;
    const missile = this.detachAudio(() => CjsSchema.cast(CjsSchema.from<unknown>(file.projectile._type, structuredClone(file.projectile)), EveMissile));
    if (!missile) throw new Error(`${file.projectileResPath} is not an EveMissile`);
    pool.all.push(missile);
    return missile;
  }

  private PoolOf(path: string): { readonly all: EveMissile[]; readonly idle: EveMissile[] } {
    let pool = this.missilePools.get(path);
    if (!pool) {
      pool = { all: [], idle: [] };
      this.missilePools.set(path, pool);
    }
    return pool;
  }

  private PlayImpact(file: MissileFile, position: readonly [number, number, number], token: number): void {
    try {
      let pool = this.impactPools.get(file.impactResPath);
      if (!pool) {
        pool = { all: [], idle: [] };
        this.impactPools.set(file.impactResPath, pool);
      }
      let impact = pool.idle.pop();
      if (!impact) {
        const root = this.detachAudio(() => CjsSchema.cast(CjsSchema.from<unknown>(file.impact._type, WithoutAudio(file.impact)), EveEffectRoot2));
        if (!root) throw new Error(`${file.impactResPath} is not an EveEffectRoot2`);
        root.observers = [];
        impact = { root, curve: new Tr2TranslationAdapter(), path: file.impactResPath };
        pool.all.push(impact);
      }
      vec3.set(impact.curve.value, position[0], position[1], position[2]);
      impact.root.translationCurve = impact.curve;
      impact.root.rotationCurve = null;
      this.engine.AddObject(impact.root);
      impact.root.Start();
      impact.root.StartControllers();
      this.impacts.set(token, impact);
    } catch (error) {
      this.Fail(`${file.impactResPath}: its impact failed: ${ErrorText(error)}`);
    }
  }

  private EndImpact(token: number): void {
    const impact = this.impacts.get(token);
    this.impacts.delete(token);
    if (!impact) return;
    try {
      impact.root.Stop();
      this.engine.RemoveObject(impact.root);
    } catch (error) {
      this.Fail(`${impact.path}: its impact removal failed: ${ErrorText(error)}`);
    }
    this.impactPools.get(impact.path)?.idle.push(impact);
  }

  private Fail(message: string): void {
    this.failed += 1;
    this.errors.push(message);
    if (this.errors.length > MISSILE_ERRORS_KEPT) this.errors.shift();
    console.warn(`missile ${message}`);
  }
}

function FileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
