/**
 * Every ship's guns, drawn: one EveTurretSet per fitted weapon (turret-plan.ts's mounts) on the built hull's locators.
 *
 * - A ship mounts once its hull is built and its mounts are known, and again from scratch whenever the hull object or
 *   its mounts change (a rebuild, a refit, a graphic that landed): every set is removed and fresh ones mounted, since
 *   the runtime's per-ship turret list never shrinks.
 * - Per mount: the turret file and its firing effect hydrate as NEW objects inside PageAudio.Detached, and every path
 *   that would place or fire their emitters is cut (the movement observer and sound, the effect's observers, and its
 *   AudEventCurves set to length 0), so only the page posts sounds. The slot comes from assignTurretSlots, the LOD is
 *   frozen at high detail (unless `?turretlod=on`), the set is painted with its graphic's SOF faction (else the ship's
 *   DNA), normalized to IDLE, then added with `listNotify` so the ship rebuilds its turret positions, and its
 *   controllers start. All sets of a ship are added together in mount order, so the engine numbers XL, launcher,
 *   atomic and chain sets as assignTurretSlots reported them.
 * - Animated hulls bind bone locators only once their geometry loads: Frame rebuilds the positions once then.
 * - Aim (set_target): a ship's sets track its target's drawn object (`SetTargetObject` + `EnterStateTargeting`), or
 *   idle without one (`target.SetTargetable(null)` + `EnterStateIdle`); Frame re-aims a set whose target's drawn object
 *   changed (a rebuilt hull, a target that finished building). Fire draws one burst at a shot's target
 *   (`SetShotMissed`, `EnterStateFiring`), and the set stays FIRING until Settle returns it to its aim.
 *
 * Runtime module (imports ./runtime): only the director, with a renderer, creates one.
 */

import type { Maybe } from '@dereekb/util';
import { assignTurretSlots, CLASSIC_TURRET_LOCATOR } from '@scene-director/scene';
import { ErrorText } from './resources';
import { addChild, AudEventCurve, CjsSchema, EveTurretFiringFX, EveTurretSet, removeChild, type EveShip2, type EveSpaceObject2, type TriCurveSet } from './runtime';
import { SetupTurretMaterial, type DetachAudio } from './ships';
import { TurretMountsKey, type TurretAim, type TurretFile, type TurretFiles, type TurretMount, type TurretMountReport, type TurretMountState } from './turret-plan';

/**
 * `?turretlod=on` lets the runtime's own LOD drop turret geometry (an A/B against the default frozen high detail).
 */
export const TURRET_LOD_ON = new URLSearchParams(globalThis.location?.search ?? '').get('turretlod') === 'on';

/**
 * EveTurretSet.State.STATE_IDLE.
 */
export const TURRET_STATE_IDLE = 2;

/**
 * The most recent mount errors get_state reports.
 */
export const TURRET_ERRORS_KEPT = 5;

/**
 * get_state's `renderer.turrets`.
 */
export interface TurretsReport {
  readonly sets: number;
  readonly loading: number;
  readonly failed: number;
  readonly unplaced: number;
  /**
   * Mounted sets aiming at a target, and of those the ones firing.
   */
  readonly targeting: number;
  readonly firing: number;
  /**
   * Bursts drawn since the load.
   */
  readonly bursts: number;
  /**
   * The most recent errors, newest last.
   */
  readonly errors: string[];
}

/**
 * One drawn burst (Fire).
 */
export interface TurretBurst {
  /**
   * Seconds the burst draws (the firing effect's duration).
   */
  readonly duration: number;
  /**
   * Seconds until it starts: the set's random firing delay, when its effect and its sounds begin.
   */
  readonly delay: number;
}

/**
 * What a turret may aim at: a built hull or object.
 */
export type TurretTargetObject = EveShip2 | EveSpaceObject2;

export interface ShipTurretsOptions {
  readonly files: TurretFiles;
  readonly detachAudio: DetachAudio;
  /**
   * The drawn object of a ship or authored object id; null while it builds or when there is none.
   */
  readonly drawnTarget: (id: string) => Maybe<TurretTargetObject>;
  /**
   * Freeze every set at high detail; defaults to !TURRET_LOD_ON.
   */
  readonly frozenLod?: boolean;
}

interface MountEntry {
  readonly mount: TurretMount;
  state: TurretMountState;
  locator: Maybe<string>;
  models: number;
  error: Maybe<string>;
  set: Maybe<EveTurretSet>;
  /**
   * The drawn object the set aims at.
   */
  aimed: Maybe<TurretTargetObject>;
  /**
   * A burst was drawn since the weapon last settled: the set stays FIRING.
   */
  firing: boolean;
}

interface ShipEntry {
  readonly id: string;
  readonly ship: Maybe<EveShip2>;
  readonly dna: string;
  readonly key: string;
  readonly mounts: Map<string, MountEntry>;
  /**
   * An animated hull's positions were rebuilt with its bones.
   */
  bonesBound: boolean;
}

export class ShipTurrets {
  private readonly files: TurretFiles;
  private readonly detachAudio: DetachAudio;
  private readonly drawnTarget: (id: string) => Maybe<TurretTargetObject>;
  private readonly frozenLod: boolean;
  private readonly ships = new Map<string, ShipEntry>();
  /**
   * Each ship's target id (set_target), kept across remounts.
   */
  private readonly aims = new Map<string, string>();
  private readonly errors: string[] = [];
  private bursts = 0;

  constructor(options: ShipTurretsOptions) {
    this.files = options.files;
    this.detachAudio = options.detachAudio;
    this.drawnTarget = options.drawnTarget;
    this.frozenLod = options.frozenLod ?? !TURRET_LOD_ON;
  }

  /**
   * Mounts a ship's weapons on its hull, unless that hull already carries exactly these mounts.
   *
   * @param id - The ship id.
   * @param ship - The built hull; null while it builds (the mounts wait).
   * @param dna - The ship's DNA (paints a graphic without a faction).
   * @param mounts - The ship's mounts (TurretMountsOf).
   */
  Sync(id: string, ship: Maybe<EveShip2>, dna: string, mounts: readonly TurretMount[]): void {
    const key = TurretMountsKey(mounts);
    const previous = this.ships.get(id);
    if (previous && previous.ship === ship && previous.key === key && previous.dna === dna) return;
    if (previous) this.Unmount(previous);
    const entry: ShipEntry = { id, ship, dna, key, mounts: new Map(mounts.map((mount) => [mount.key, { mount, state: 'loading', locator: null, models: 0, error: null, set: null, aimed: null, firing: false }])), bonesBound: false };
    this.ships.set(id, entry);
    if (ship && mounts.length) void this.Mount(entry, ship);
  }

  /**
   * Removes a ship's sets (before its hull retires). Its aim is kept for a rebuilt hull: Aim(id, null) forgets it.
   *
   * @param id - The ship id.
   */
  Remove(id: string): void {
    const entry = this.ships.get(id);
    if (entry) this.Unmount(entry);
    this.ships.delete(id);
  }

  /**
   * Points a ship's sets at its target, or idles them (null). Sets firing a burst keep it until they settle.
   *
   * @param id - The ship id.
   * @param target - The ship or object it targets; null for none.
   */
  Aim(id: string, target: Maybe<string>): void {
    if (target == null) this.aims.delete(id);
    else this.aims.set(id, target);
    const entry = this.ships.get(id);
    if (entry) for (const item of entry.mounts.values()) if (!item.firing) this.ApplyAim(item, this.AimObject(id));
  }

  /**
   * Forgets every aim (a load); the sets idle on their next frame.
   */
  ClearAims(): void {
    this.aims.clear();
  }

  /**
   * Draws one burst of a weapon's set at a shot's target.
   *
   * @param id - The ship id.
   * @param key - The weapon module's key.
   * @param target - The shot's target id.
   * @param missed - The shot misses: no impact, the end point past the target.
   * @returns The burst: seconds it draws, and seconds until it starts (the set's random firing delay, up to 0.6 s);
   *   null when the set is not mounted or the target is not drawn.
   */
  Fire(id: string, key: string, target: string, missed: boolean): Maybe<TurretBurst> {
    const item = this.ships.get(id)?.mounts.get(key);
    const object = this.drawnTarget(target);
    const set = item?.set;
    if (!item || !set || !object) return null;
    if (item.aimed !== object) {
      set.SetTargetObject(object);
      item.aimed = object;
    }
    set.SetShotMissed(missed);
    set.EnterStateFiring();
    item.firing = true;
    this.bursts++;
    return { duration: set.firingEffect?.GetFiringDuration() ?? 0, delay: set.randomFiringDelay || 0 };
  }

  /**
   * A mounted weapon's muzzle in world space (the firing turret's, else the closest): where a launcher's missile ejects.
   *
   * @param id - The ship id.
   * @param key - The weapon module's key.
   * @param out - Receives the 4×4.
   * @returns Whether its set is mounted (`out` untouched otherwise).
   */
  FiringBone(id: string, key: string, out: Float32Array): boolean {
    const set = this.ships.get(id)?.mounts.get(key)?.set;
    if (set) set.GetFiringBoneWorldTransform(0, out);
    return set != null;
  }

  /**
   * A weapon stopped and its last burst ran: its set returns to TARGETING on the ship's target, or IDLE.
   *
   * @param id - The ship id.
   * @param key - The weapon module's key.
   */
  Settle(id: string, key: string): void {
    const item = this.ships.get(id)?.mounts.get(key);
    if (!item?.firing) return;
    item.firing = false;
    // Re-enter the aim even when the object is unchanged: the set is still FIRING.
    item.aimed = null;
    this.ApplyAim(item, this.AimObject(id));
  }

  /**
   * Runs every frame: rebinds an animated hull's turrets to its bones once its geometry has loaded, and re-aims a set
   * whose target's drawn object changed (a rebuilt hull, a target that finished building, a fresh mount).
   */
  Frame(): void {
    for (const entry of this.ships.values()) {
      const { ship } = entry;
      if (ship?.isAnimated && !entry.bonesBound && [...entry.mounts.values()].some((mount) => mount.set) && BoneNames(ship).length) {
        ship.RebuildTurretPositions();
        entry.bonesBound = true;
      }
      const object = this.AimObject(entry.id);
      for (const item of entry.mounts.values()) if (item.set && !item.firing && item.aimed !== object) this.ApplyAim(item, object);
    }
  }

  /**
   * A weapon module's mount.
   *
   * @param id - The ship id.
   * @param key - The fitted module's key.
   * @returns Its mount, or null when the ship does not mount it (yet).
   */
  MountOf(id: string, key: string): Maybe<TurretMountReport> {
    const mount = this.ships.get(id)?.mounts.get(key);
    return mount ? { ...(mount.locator ? { locator: mount.locator } : {}), state: mount.state, ...(mount.state === 'mounted' ? { models: mount.models, aim: AimOf(mount) } : {}), ...(mount.error ? { error: mount.error } : {}) } : null;
  }

  Report(): TurretsReport {
    const counts = { sets: 0, loading: 0, failed: 0, unplaced: 0, targeting: 0, firing: 0 };
    for (const entry of this.ships.values()) {
      for (const mount of entry.mounts.values()) {
        if (mount.state === 'mounted') counts.sets++;
        else counts[mount.state]++;
        if (mount.set && mount.aimed) counts.targeting++;
        if (mount.set && mount.firing) counts.firing++;
      }
    }
    return { ...counts, bursts: this.bursts, errors: [...this.errors] };
  }

  /**
   * Forgets the burst count (a load).
   */
  ResetBursts(): void {
    this.bursts = 0;
  }

  private async Mount(entry: ShipEntry, ship: EveShip2): Promise<void> {
    const current = (): boolean => this.ships.get(entry.id) === entry;
    const items = [...entry.mounts.values()];
    const files = await Promise.all(
      items.map(async (item): Promise<Maybe<TurretFile>> => {
        try {
          return await this.files.Load(item.mount.resPath);
        } catch (error) {
          this.Fail(entry, item, ErrorText(error));
          return null;
        }
      })
    );
    if (!current()) return;
    const slots = assignTurretSlots(
      items.map((item, index) => ({ key: item.mount.key, locatorName: files[index]?.facts.locatorName || CLASSIC_TURRET_LOCATOR, highIndex: item.mount.highIndex })),
      LocatorNames(ship)
    );
    const prepared = await Promise.all(
      items.map(async (item, index): Promise<Maybe<EveTurretSet>> => {
        const file = files[index];
        const slot = slots[index];
        if (!file) return null;
        if (!slot.placed) {
          item.state = 'unplaced';
          return null;
        }
        item.locator = slot.locator;
        item.models = slot.models;
        try {
          const set = this.Hydrate(file);
          set.slotNumber = slot.slot ?? -1;
          if (this.frozenLod) set.FreezeHighDetailLOD();
          await SetupTurretMaterial(set, { faction: item.mount.faction, dna: entry.dna });
          return set;
        } catch (error) {
          this.Fail(entry, item, ErrorText(error));
          return null;
        }
      })
    );
    if (!current()) {
      for (const set of prepared) set?.Destruct();
      return;
    }
    items.forEach((item, index) => {
      const set = prepared[index];
      if (!set) return;
      // Some files author TARGETING (the Mega Pulse); EnterStateTargeting from there does nothing.
      set.state = TURRET_STATE_IDLE;
      addChild(ship, 'turretSets', set, { listNotify: ship });
      set.StartControllers();
      item.set = set;
      item.state = 'mounted';
    });
    entry.bonesBound = BoneNames(ship).length > 0;
  }

  private AimObject(id: string): Maybe<TurretTargetObject> {
    const target = this.aims.get(id);
    return target ? this.drawnTarget(target) : null;
  }

  private ApplyAim(item: MountEntry, object: Maybe<TurretTargetObject>): void {
    const { set } = item;
    if (!set) return;
    if (object) {
      set.SetTargetObject(object);
      set.EnterStateTargeting();
    } else {
      // SetTargetObject(null) does nothing: clear the holder, then idle.
      set.target.SetTargetable(null);
      set.EnterStateIdle();
    }
    item.aimed = object ?? null;
  }

  /**
   * A new turret set from a loaded file, with its firing effect, every audio path cut.
   */
  private Hydrate(file: TurretFile): EveTurretSet {
    return this.detachAudio(() => {
      const set = CjsSchema.cast(CjsSchema.from<unknown>(file.turret._type, structuredClone(file.turret)), EveTurretSet);
      if (!set) throw new Error(`${file.turret._type} is not an EveTurretSet`);
      set.playMovementSound = false;
      set.turretMovementObserver = null;
      const fx = file.fx ? CjsSchema.cast(CjsSchema.from<unknown>(file.fx._type, structuredClone(file.fx)), EveTurretFiringFX) : null;
      if (fx) {
        for (const curveSet of [fx.startCurveSet, fx.stopCurveSet]) MuteCurves(curveSet);
        fx.sourceObserver = null;
        fx.destinationObserver = null;
        set.SetFiringEffect(fx);
      }
      return set;
    });
  }

  private Unmount(entry: ShipEntry): void {
    for (const item of entry.mounts.values()) {
      const { set } = item;
      if (!set) continue;
      if (entry.ship) removeChild(entry.ship, 'turretSets', set, { listNotify: entry.ship });
      set.Destruct();
      item.set = null;
    }
    // A mount still loading for this entry is dropped when it lands (the entry is no longer current).
    this.ships.delete(entry.id);
  }

  private Fail(entry: ShipEntry, item: MountEntry, error: string): void {
    item.state = 'failed';
    item.error = error;
    const message = `ship ${entry.id} ${item.mount.key} (${item.mount.name}): ${error}`;
    this.errors.push(message);
    if (this.errors.length > TURRET_ERRORS_KEPT) this.errors.shift();
    console.warn(`turret ${message}`);
  }
}

function AimOf(mount: MountEntry): TurretAim {
  let aim: TurretAim = 'idle';
  if (mount.firing) aim = 'firing';
  else if (mount.aimed) aim = 'targeting';
  return aim;
}

/**
 * Stops a curve set's sound curves from ever posting (an AudEventCurve of length 0 never fires).
 */
function MuteCurves(curveSet: Maybe<TriCurveSet>): void {
  for (const curve of curveSet?.curves ?? []) {
    const sound = CjsSchema.cast(curve, AudEventCurve);
    if (!sound) continue;
    sound.length = 0;
    sound.keys = [];
    sound.sourceTriObserver = null;
  }
}

/**
 * The hull's locator names, with its animation bones once loaded.
 */
function LocatorNames(ship: EveShip2): string[] {
  return [...ship.locators.map((locator) => locator.GetName()), ...BoneNames(ship)];
}

function BoneNames(ship: EveShip2): string[] {
  return ship.animationUpdater?.GetAnimationBoneList() ?? [];
}
