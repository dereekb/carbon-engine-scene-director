/**
 * The client's ship-death explosions, drawn (K3): a destroyed ship's chosen `res:/fisfx/explosion/ecx_*.black`
 * (shipExplosionOf) plays on its ball as the client plays it.
 *
 * - The file's values (explosion-plan.ts' ExplosionFiles, loaded once) hydrate as a NEW EveEffectRoot2 inside
 *   PageAudio.Detached, with every AudEventCurve and observer taken out of the copied values first, so nothing in it
 *   registers with or posts to the page's audio: the page posts the explosion's sounds itself (`onSound`), on the
 *   dying ship's emitter, once per local blast spawned and once for the global blast.
 * - The root rides the ship's ball curves at scale 1 (an authored root scale would throw the blasts off the hull). On
 *   its EveChildExplosion: the file's own `scaling` times max(1, hull bounding radius / the file's referenceRadius) on
 *   all three axes; `SetLocalExplosionTransforms` with a keyed subset of up to
 *   MAX_LOCAL_BLASTS of the built hull's `damage` locators (8 keyed points on its bounding sphere without them);
 *   `SetGlobalExplosionOffset(boundingSphereCenter)`; then the root is added to the scene and `Play()` times it.
 * - At start + `wreckSwitchTime` it calls `onHide` (the director retires the hull's drawing); when it stops playing
 *   or its `totalDuration` has passed, the root comes off the scene and is retired.
 *
 * Runtime module (imports ./runtime): only the director, with a renderer, creates one.
 */

import type { Maybe } from '@dereekb/util';
import { combatShuffle, MAX_LOCAL_BLASTS, type ShipExplosionChoice } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { ShipCurves } from './destiny';
import type { Engine } from './engine';
import type { ExplosionFile, ExplosionFiles } from './explosion-plan';
import { ErrorText } from './resources';
import { CjsSchema, EveChildExplosion, EveEffectRoot2, type CjsModelValues, type EveShip2 } from './runtime';
import { RetireShips, type DetachAudio } from './ships';

/**
 * Errors kept for get_state.
 */
const EXPLOSION_ERRORS_KEPT = 8;

export type ShipExplosionState = 'waiting' | 'playing' | 'done' | 'failed';

export interface ShipExplosionReport {
  readonly state: ShipExplosionState;
  readonly file: string;
  /**
   * The scale on the explosion child.
   */
  readonly scale?: number;
  readonly localBlasts?: number;
  readonly wreckSwitchTime?: number;
  readonly totalDuration?: number;
  readonly error?: string;
}

export interface ShipExplosionStart {
  /**
   * The built hull, null when it has none drawn (the explosion still plays on the ball, sized by `radius`).
   */
  readonly ship: Maybe<EveShip2>;
  readonly curves: ShipCurves;
  readonly choice: ShipExplosionChoice;
  /**
   * The bounding radius to size by when there is no built hull.
   */
  readonly radius: number;
  /**
   * When it starts, scene clock (100 ns ticks): the killing shot's draw plus its set's firing delay.
   */
  readonly at: number;
  /**
   * The document's combat seed: the local blast subset is keyed (seed, "explosion|<ship>").
   */
  readonly seed: number;
}

export interface ShipExplosionsOptions {
  readonly engine: Engine;
  readonly files: ExplosionFiles;
  /**
   * Everything else drawn (ships, dressing, objects, module effects), kept by every retire.
   */
  readonly retained: () => object[];
  readonly detachAudio: DetachAudio;
  /**
   * The explosion reached its wreck switch (or could not play): retire the hull's drawing.
   */
  readonly onHide: (id: string) => void;
  /**
   * A local blast spawned, or the global one: post its sound event.
   */
  readonly onSound: (id: string, event: string, part: 'local' | 'global') => void;
}

interface ExplosionEntry {
  readonly id: string;
  readonly start: ShipExplosionStart;
  state: ShipExplosionState;
  root: Maybe<EveEffectRoot2>;
  child: Maybe<EveChildExplosion>;
  file: Maybe<ExplosionFile>;
  scale: number;
  localBlasts: number;
  hidden: boolean;
  /**
   * Local blasts already heard, and whether the global one was.
   */
  heardLocal: number;
  heardGlobal: boolean;
  error: Maybe<string>;
}

export class ShipExplosions {
  private readonly engine: Engine;
  private readonly files: ExplosionFiles;
  private readonly retained: () => object[];
  private readonly detachAudio: DetachAudio;
  private readonly onHide: (id: string) => void;
  private readonly onSound: (id: string, event: string, part: 'local' | 'global') => void;
  private readonly entries = new Map<string, ExplosionEntry>();
  private readonly errors: string[] = [];

  constructor(options: ShipExplosionsOptions) {
    this.engine = options.engine;
    this.files = options.files;
    this.retained = options.retained;
    this.detachAudio = options.detachAudio;
    this.onHide = options.onHide;
    this.onSound = options.onSound;
  }

  /**
   * Queues a destroyed ship's explosion; it plays at `start.at` once its file has loaded (the load starts now).
   *
   * @param id - The ship id.
   * @param start - Its hull, curves, chosen file, start time and seed.
   */
  Start(id: string, start: ShipExplosionStart): void {
    this.Remove(id);
    const entry: ExplosionEntry = { id, start, state: 'waiting', root: null, child: null, file: null, scale: 1, localBlasts: 0, hidden: false, heardLocal: 0, heardGlobal: false, error: null };
    this.entries.set(id, entry);
    this.files.Load(start.choice.resPath).then(
      (file) => {
        if (this.entries.get(id) === entry) entry.file = file;
      },
      (error: unknown) => {
        if (this.entries.get(id) === entry) this.Fail(entry, `its explosion ${start.choice.resPath} did not load: ${ErrorText(error)}`);
      }
    );
  }

  /**
   * Plays due explosions, hides hulls at their wreck switch, posts blast sounds and removes finished roots. Runs each
   * frame after the turrets are driven.
   *
   * @param now - The scene clock, in 100 ns ticks.
   */
  Frame(now: number): void {
    for (const entry of [...this.entries.values()]) {
      try {
        if (entry.state === 'waiting' && entry.file && now >= entry.start.at) this.Play(entry, entry.file);
        if (entry.state === 'playing') this.Advance(entry, now);
      } catch (error) {
        this.Fail(entry, ErrorText(error));
      }
    }
  }

  /**
   * A ship's explosion, for get_state.
   *
   * @param id - The ship id.
   * @returns Its report, or null.
   */
  Report(id: string): Maybe<ShipExplosionReport> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { child } = entry;
    return {
      state: entry.state,
      file: entry.start.choice.name,
      ...(entry.root ? { scale: entry.scale, localBlasts: entry.localBlasts } : {}),
      ...(child ? { wreckSwitchTime: child.wreckSwitchTime, totalDuration: child.totalDuration } : {}),
      ...(entry.error ? { error: entry.error } : {})
    };
  }

  /**
   * The latest errors.
   *
   * @returns Their messages, oldest first.
   */
  Errors(): string[] {
    return [...this.errors];
  }

  /**
   * Takes a ship's explosion off (its ball left, or remove_ship).
   *
   * @param id - The ship id.
   */
  Remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.Teardown(entry);
  }

  /**
   * Removes every explosion (a load revives everyone).
   */
  Clear(): void {
    for (const id of [...this.entries.keys()]) this.Remove(id);
  }

  /**
   * The drawn explosions' roots, for every retire's retained set.
   *
   * @returns The roots.
   */
  Roots(): object[] {
    const roots: object[] = [];
    for (const { root } of this.entries.values()) if (root) roots.push(root);
    return roots;
  }

  private Play(entry: ExplosionEntry, file: ExplosionFile): void {
    const { start } = entry;
    const root = this.detachAudio(() => CjsSchema.cast(CjsSchema.from<unknown>(file.values._type, WithoutAudio(file.values)), EveEffectRoot2));
    if (!root) throw new Error(`${start.choice.resPath} is not an EveEffectRoot2`);
    const child = root.effectChildren.map((candidate) => CjsSchema.cast(candidate, EveChildExplosion)).find((candidate): candidate is EveChildExplosion => candidate != null);
    if (!child) throw new Error(`${start.choice.resPath} holds no EveChildExplosion`);
    root.observers = [];
    root.translationCurve = start.curves.translation;
    root.rotationCurve = start.curves.rotation;
    // The root stands in the hull's frame: the runtime places the blasts and the global offset through the child's
    // transform alone, so an authored root scale (5 on generic_explosive_long_01a) would throw the blasts off the hull.
    root.scaling[0] = 1;
    root.scaling[1] = 1;
    root.scaling[2] = 1;
    const radius = start.ship?.boundingSphereRadius || start.radius;
    const scale = Math.max(1, radius / start.choice.referenceRadius);
    // The files author their own size on the child (0.5 on the generic ones): the hull's factor multiplies it.
    child.scaling[0] *= scale;
    child.scaling[1] *= scale;
    child.scaling[2] *= scale;
    const blasts = LocalBlastTransforms({ id: entry.id, ship: start.ship, radius, seed: start.seed });
    child.SetLocalExplosionTransforms(blasts);
    child.SetGlobalExplosionOffset(start.ship?.boundingSphereCenter ?? new Float32Array(3));
    this.engine.AddObject(root);
    child.Play();
    entry.root = root;
    entry.child = child;
    entry.scale = scale;
    entry.localBlasts = blasts.length;
    entry.state = 'playing';
  }

  private Advance(entry: ExplosionEntry, now: number): void {
    const { child } = entry;
    if (!child) return;
    const elapsed = (now - entry.start.at) / TICKS_PER_SECOND;
    if (!entry.hidden && (elapsed >= child.wreckSwitchTime || !child.isPlaying)) this.Hide(entry);
    const facts = entry.file?.facts;
    const spawned = child.generatedLocalExplosions.filter((object) => object !== child.localExplosionShared && object !== child.generatedGlobalExplosions).length;
    for (; entry.heardLocal < spawned; entry.heardLocal += 1) {
      const event = facts?.localEvents[0];
      if (event) this.onSound(entry.id, event, 'local');
    }
    // The wreck switch clears the spawned local blasts: keep the count heard.
    if (!entry.heardGlobal && child.generatedGlobalExplosions) {
      entry.heardGlobal = true;
      const event = facts?.globalEvents[0];
      if (event) this.onSound(entry.id, event, 'global');
    }
    if (!child.isPlaying || elapsed > child.totalDuration) {
      entry.state = 'done';
      this.Teardown(entry);
    }
  }

  private Hide(entry: ExplosionEntry): void {
    entry.hidden = true;
    this.onHide(entry.id);
  }

  private Teardown(entry: ExplosionEntry): void {
    const { root, child } = entry;
    entry.root = null;
    entry.child = null;
    if (!root) return;
    try {
      child?.Stop();
      this.engine.RemoveObject(root);
      RetireShips([root], [...this.retained(), ...this.Roots()]);
    } catch (error) {
      this.Record(`ship ${entry.id} explosion teardown: ${ErrorText(error)}`);
    }
  }

  private Fail(entry: ExplosionEntry, error: string): void {
    entry.state = 'failed';
    entry.error = error;
    this.Record(`ship ${entry.id}: ${error}`);
    this.Teardown(entry);
    if (!entry.hidden) this.Hide(entry);
  }

  private Record(message: string): void {
    this.errors.push(message);
    if (this.errors.length > EXPLOSION_ERRORS_KEPT) this.errors.shift();
    console.warn(`explosion ${message}`);
  }
}

/**
 * A copy of an effect file's values (an explosion, a missile impact) with every sound curve (AudEventCurve) and
 * observer list taken out, so the hydrated root holds no emitter.
 *
 * @param values - The file's values.
 * @returns The copy.
 */
export function WithoutAudio(values: CjsModelValues): CjsModelValues {
  const copy = structuredClone(values);
  const seen = new Set<unknown>();
  const strip = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) strip(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const curves = record['curves'];
    if (Array.isArray(curves)) record['curves'] = curves.filter((curve: unknown) => (curve as Maybe<Record<string, unknown>>)?.['_type'] !== 'AudEventCurve');
    if (Array.isArray(record['observers'])) record['observers'] = [];
    for (const item of Object.values(record)) strip(item);
  };
  strip(copy);
  return copy;
}

/**
 * Eight directions spread over a sphere (a Fibonacci lattice), for a hull without damage locators.
 */
const SPHERE_POINTS: readonly (readonly [number, number, number])[] = Array.from({ length: MAX_LOCAL_BLASTS }, (_, index) => {
  const y = 1 - (2 * (index + 0.5)) / MAX_LOCAL_BLASTS;
  const ring = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(angle) * ring, y, Math.sin(angle) * ring] as const;
});

/**
 * The local blasts' hull-local transforms: a keyed subset of up to MAX_LOCAL_BLASTS of the hull's `damage` locators
 * (rotation from the locator, translation its position), else keyed points on its bounding sphere.
 *
 * @param input - The ship id, its built hull, its bounding radius and the seed.
 * @returns Column-major 4×4 matrices.
 */
function LocalBlastTransforms(input: { readonly id: string; readonly ship: Maybe<EveShip2>; readonly radius: number; readonly seed: number }): Float32Array[] {
  const { id, ship, radius, seed } = input;
  const key = `explosion|${id}`;
  const damage = ship?.locatorSets?.find((set) => set.name === 'damage')?.locators ?? [];
  if (damage.length)
    return combatShuffle(seed, key, damage)
      .slice(0, MAX_LOCAL_BLASTS)
      .map((locator) => Transform(locator.position, locator.direction));
  const center = ship?.boundingSphereCenter ?? [0, 0, 0];
  return combatShuffle(seed, key, SPHERE_POINTS).map(([x, y, z]) => Transform([center[0] + x * radius, center[1] + y * radius, center[2] + z * radius], [0, 0, 0, 1]));
}

function Transform(position: ArrayLike<number>, rotation: ArrayLike<number>): Float32Array {
  const [x, y, z, w] = [rotation[0], rotation[1], rotation[2], rotation[3]];
  const out = new Float32Array(16);
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y + w * z);
  out[2] = 2 * (x * z - w * y);
  out[4] = 2 * (x * y - w * z);
  out[5] = 1 - 2 * (x * x + z * z);
  out[6] = 2 * (y * z + w * x);
  out[8] = 2 * (x * z + w * y);
  out[9] = 2 * (y * z - w * x);
  out[10] = 1 - 2 * (x * x + y * y);
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}
