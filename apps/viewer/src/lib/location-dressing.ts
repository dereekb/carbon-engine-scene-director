/**
 * Draws a scene location the way the EVE client dresses a system: the region's nebula swapped in live, the star's
 * light direction (a sun ball), sun disc, environment template and lens flare, the planets and moons big enough to see
 * in the planet pass, and the NPC stations and stargates near the origin as static SOF objects (not Destiny balls).
 * `toLocationDressingPlan` (packages/scene) decides what; this reconciles the live scene with each new plan by slot
 * (keep and move, build, retire), so changing the location re-dresses without a reload and clearing it undresses.
 *
 * Everything is placed from /map/system's origin-relative metres, so float32 holds. Without a renderer (headless
 * verify-page) the plan still runs: bodies load as values and stations and gates build to SOF values, all reported
 * `validated`.
 */

import type { Maybe } from '@dereekb/util';
import { LOCATION_DRESSING_PARTS, toLocationDressingPlan, type DressedKind, type DressedState, type LocationDressingNebulaReport, type LocationDressingParts, type LocationDressingPlan, type LocationDressingReport, type LocationStatus, type MapSystemAnswer, type SceneLocation } from '@scene-director/scene';
import { DressingReport, DressingSlot, DYNAMIC_RESOURCE_STANDIN, PatchHeightMap, PlanDressingChanges, type DressingEntryState, type WantedDressing } from './celestials';
import type { Engine } from './engine';
import { ErrorText, ResourceValues } from './resources';
import { CjsSchema, quat, Tr2RotationAdapter, Tr2TranslationAdapter, vec3, type EvePlanet, type EveSpaceObject2 } from './runtime';
import { BuildStaticObject, RetireShips, type DetachAudio } from './ships';

export interface LocationDressingOptions {
  readonly engine: Maybe<Engine>;
  readonly parts: LocationDressingParts;
  /**
   * Every ship root the page keeps, so retiring a dressing object never tears down what a ship still reaches.
   */
  readonly retained: () => object[];
  readonly onChange: () => void;
  /**
   * Hydrates the sun, planets, moons, stations and gates with the audio seams detached (PageAudio.Detached).
   */
  readonly detachAudio: DetachAudio;
}

export interface LocationDressingInput {
  readonly location: Maybe<SceneLocation>;
  readonly answer: Maybe<MapSystemAnswer>;
  readonly status: LocationStatus;
  readonly error?: Maybe<string>;
}

interface DressingEntry {
  readonly slot: string;
  readonly key: string;
  readonly kind: DressedKind | 'sun';
  readonly name: string;
  readonly id: number;
  /**
   * The body or object's own fixed position (the sun disc rides the shared sun ball instead).
   */
  readonly curve: Tr2TranslationAdapter;
  readonly rotation: Tr2RotationAdapter;
  state: DressedState;
  error: Maybe<string>;
  sofRadius: Maybe<number>;
  planet: Maybe<EvePlanet>;
  object: Maybe<EveSpaceObject2>;
}

export class LocationDressing {
  private readonly engine: Maybe<Engine>;
  private readonly parts: LocationDressingParts;
  private readonly retained: () => object[];
  private readonly onChange: () => void;
  private readonly detachAudio: DetachAudio;
  /**
   * The sun ball: scene.sunBall and the sun disc's translation curve must be this same object (Carbon picks the sun
   * disc by identity), at the drawn (pulled-in) position.
   */
  private readonly sunCurve = new Tr2TranslationAdapter();
  private readonly entries = new Map<string, DressingEntry>();
  private located = false;
  private key: Maybe<string> = null;
  private plan: Maybe<LocationDressingPlan> = null;
  private failure: Maybe<string> = null;
  private notes: string[] = [];

  constructor(options: LocationDressingOptions) {
    this.engine = options.engine;
    this.parts = options.parts;
    this.retained = options.retained;
    this.onChange = options.onChange;
    this.detachAudio = options.detachAudio;
  }

  /**
   * Re-dresses for the document's location and its answer. Idempotent: it re-plans only when the location key, the
   * answer or the parts change. While a changed location's answer loads the old dressing stays; a failed or cleared
   * location undresses at once.
   */
  Update(input: LocationDressingInput): void {
    const { location, answer, status, error } = input;
    const off = LOCATION_DRESSING_PARTS.every((part) => !this.parts[part]);
    this.located = location != null;
    if (!location || off) {
      this.Undress();
    } else if (status === 'failed') {
      this.Undress();
      this.failure = error ?? 'the location could not be read';
    } else if (status === 'ready' && answer) {
      const plan = toLocationDressingPlan({ answer, parts: this.parts });
      this.failure = null;
      if (plan.key !== this.key) this.Apply(plan, answer);
      else this.plan = plan;
    } else {
      // The answer is in flight: keep what is dressed, report loading.
      this.failure = null;
      this.plan = null;
    }
  }

  Report(): Maybe<LocationDressingReport> {
    let report: Maybe<LocationDressingReport> = null;
    if (this.located) {
      const entries = new Map<string, DressingEntryState>([...this.entries].map(([slot, entry]) => [slot, { state: entry.state, error: entry.error, sofRadius: entry.sofRadius }]));
      report = DressingReport({ parts: this.parts, plan: this.plan, entries, nebula: this.NebulaReport(), sunDressing: this.SunDressing(), error: this.failure, notes: this.notes });
    }
    return report;
  }

  /**
   * The hydrated dressing roots, for the Director's retained set.
   */
  Roots(): object[] {
    const roots: object[] = [];
    for (const entry of this.entries.values()) {
      if (entry.planet) roots.push(entry.planet);
      if (entry.object) roots.push(entry.object);
    }
    return roots;
  }

  private Apply(plan: LocationDressingPlan, answer: MapSystemAnswer): void {
    const engine = this.engine;
    this.key = plan.key;
    this.plan = plan;
    this.notes = [];

    if (this.parts.nebula && !plan.nebula) this.notes.push(`${answer.system.region?.name ?? answer.system.name} has no nebula in the EVE data; environment.universe is drawn`);
    if (engine) {
      const nebula = plan.nebula ?? engine.universe;
      if (nebula) void engine.SetNebula(nebula, plan.nebula ? 'location' : 'universe').then(() => this.onChange());
    }

    const sun = plan.sun;
    if (sun) vec3.set(this.sunCurve.value, sun.drawnPosition[0], sun.drawnPosition[1], sun.drawnPosition[2]);
    engine?.SetSunBall(sun ? this.sunCurve : null);
    engine?.DressSun(sun);

    const wanted: (WantedDressing & { readonly build: () => DressingEntry; readonly move: (entry: DressingEntry) => void; readonly load: (entry: DressingEntry) => Promise<void> })[] = [];
    if (sun?.disc) {
      const scale = sun.scale;
      wanted.push({
        slot: DressingSlot('sun', sun.id),
        key: sun.graphic,
        build: () => this.CreateEntry(DressingSlot('sun', sun.id), sun.graphic, 'sun', sun.name, sun.id),
        move: (entry) => SetPlanetSize(entry.planet, scale),
        load: (entry) => this.LoadPlanet(entry, sun.graphic, null, scale, null, this.sunCurve)
      });
    }
    for (const body of plan.bodies) {
      const slot = DressingSlot(body.kind, body.id);
      const place = (entry: DressingEntry): void => {
        vec3.set(entry.curve.value, body.drawnPosition[0], body.drawnPosition[1], body.drawnPosition[2]);
        SetPlanetSize(entry.planet, body.drawnRadius);
      };
      wanted.push({
        slot,
        key: body.template,
        build: () => this.CreateEntry(slot, body.template, body.kind, body.name, body.id),
        move: place,
        load: (entry) => {
          place(entry);
          return this.LoadPlanet(entry, body.template, body.heightMap, body.drawnRadius, body.radius, entry.curve);
        }
      });
    }
    for (const object of plan.objects) {
      const slot = DressingSlot(object.kind, object.id);
      const place = (entry: DressingEntry): void => {
        vec3.set(entry.curve.value, object.position[0], object.position[1], object.position[2]);
        quat.copy(entry.rotation.value, object.rotation);
      };
      wanted.push({
        slot,
        key: object.dna,
        build: () => this.CreateEntry(slot, object.dna, object.kind, object.name, object.id),
        move: place,
        load: (entry) => {
          place(entry);
          return this.LoadObject(entry, object.dna);
        }
      });
    }

    const changes = PlanDressingChanges(new Map([...this.entries].map(([slot, entry]) => [slot, entry.key])), wanted);
    for (const slot of changes.retire) this.RetireEntry(slot);
    const keep = new Set(changes.keep);
    for (const item of wanted) {
      const current = this.entries.get(item.slot);
      if (keep.has(item.slot) && current) item.move(current);
      else {
        const entry = item.build();
        this.entries.set(item.slot, entry);
        void item.load(entry).then(() => this.onChange());
      }
    }
    engine?.SetDrawReach(plan.reach);
    this.onChange();
  }

  private CreateEntry(slot: string, key: string, kind: DressingEntry['kind'], name: string, id: number): DressingEntry {
    return { slot, key, kind, name, id, curve: new Tr2TranslationAdapter(), rotation: new Tr2RotationAdapter(), state: 'loading', error: null, sofRadius: null, planet: null, object: null };
  }

  /**
   * Loads a planet file (the sun graphic, or a planet or moon template) and adds it to the planet pass.
   *
   * @param scale - The EvePlanet's scaling and radius: the sun's is twice its drawn radius (its mesh has radius 0.5).
   * @param radius - Planets and moons: the true radius in metres, the gas giants' CTRL_Scale variable.
   */
  private async LoadPlanet(entry: DressingEntry, path: string, heightMap: Maybe<string>, scale: number, radius: Maybe<number>, curve: Tr2TranslationAdapter): Promise<void> {
    await this.Settle(entry, async () => {
      const values = await ResourceValues(path);
      if (heightMap) PatchHeightMap(values, heightMap);
      let state: DressedState = 'validated';
      if (this.engine) {
        // The sun graphic carries its own ambience emitter (sun_sfx_atmo): it stays inert, as a ship's do.
        const planet = this.detachAudio(() => {
          const hydrated = CjsSchema.from<EvePlanet>(values._type, values);
          hydrated.translationCurve = curve;
          SetPlanetSize(hydrated, scale);
          if (radius != null) hydrated.SetControllerVariable('radius', radius);
          hydrated.StartControllers();
          return hydrated;
        });
        entry.planet = planet;
        if (this.entries.get(entry.slot) === entry) this.engine.AddPlanet(planet);
        state = 'drawn';
      }
      return state;
    });
  }

  /**
   * Builds a station or stargate from its SOF DNA (queued with the ship builds) and adds it to the scene on its fixed
   * curves.
   */
  private async LoadObject(entry: DressingEntry, dna: string): Promise<void> {
    await this.Settle(entry, async () => {
      const build = await BuildStaticObject({ dna, curves: { translation: entry.curve, rotation: entry.rotation }, hydrate: () => Boolean(this.engine) && this.entries.get(entry.slot) === entry, detachAudio: this.detachAudio });
      if (build.dynamic.length > 0) console.info(`location dressing: ${entry.name} (${entry.id}): dynamic resources ${build.dynamic.join(', ')} drawn as ${DYNAMIC_RESOURCE_STANDIN}`);
      entry.sofRadius = build.sofRadius;
      let state: DressedState = 'validated';
      if (build.object) {
        entry.object = build.object;
        if (this.entries.get(entry.slot) === entry) this.engine?.AddObject(build.object);
        state = 'drawn';
      }
      return state;
    });
  }

  /**
   * Runs one load and records its outcome; a load whose entry was retired meanwhile tears down what it built.
   */
  private async Settle(entry: DressingEntry, load: () => Promise<DressedState>): Promise<void> {
    try {
      const state = await load();
      entry.state = state;
    } catch (error) {
      entry.state = 'failed';
      entry.error = ErrorText(error);
      console.warn(`location dressing: ${entry.name} (${entry.id}): ${entry.error}`);
    }
    if (this.entries.get(entry.slot) !== entry) this.Teardown(entry);
  }

  private RetireEntry(slot: string): void {
    const entry = this.entries.get(slot);
    if (entry) {
      this.entries.delete(slot);
      if (entry.planet) this.engine?.RemovePlanet(entry.planet);
      if (entry.object) this.engine?.RemoveObject(entry.object);
      this.Teardown(entry);
    }
  }

  /**
   * Retires a detached entry's graph against every live ship and the rest of the dressing.
   */
  private Teardown(entry: DressingEntry): void {
    const roots = [entry.planet, entry.object].filter((root): root is NonNullable<typeof root> => root != null);
    entry.planet = null;
    entry.object = null;
    if (roots.length > 0) {
      try {
        RetireShips(roots, [...this.retained(), ...this.Roots()]);
      } catch (error) {
        console.warn(`location dressing: retiring ${entry.name} (${entry.id}): ${ErrorText(error)}`);
      }
    }
  }

  private Undress(): void {
    for (const slot of [...this.entries.keys()]) this.RetireEntry(slot);
    const engine = this.engine;
    if (engine && this.key != null) {
      engine.SetSunBall(null);
      engine.DressSun(null);
      if (engine.universe) void engine.SetNebula(engine.universe, 'universe').then(() => this.onChange());
      engine.SetDrawReach(0);
    }
    this.key = null;
    this.plan = null;
    this.failure = null;
    this.notes = [];
  }

  private NebulaReport(): Maybe<LocationDressingNebulaReport> {
    const path = this.plan?.nebula;
    let report: Maybe<LocationDressingNebulaReport> = null;
    if (path) {
      const nebula = this.engine?.nebula;
      let state: DressedState = 'planned';
      if (nebula) state = nebula.path !== path || nebula.state === 'loading' ? 'loading' : nebula.state === 'failed' ? 'failed' : 'drawn';
      report = { path, state, ...(nebula?.path === path && nebula.error ? { error: nebula.error } : {}) };
    }
    return report;
  }

  /**
   * The environment template and lens flare the scene dresser applied, or the star's first choices without a
   * renderer.
   */
  private SunDressing(): Maybe<{ template?: Maybe<string>; flare?: Maybe<string> }> {
    const sun = this.plan?.sun;
    let dressing: Maybe<{ template?: Maybe<string>; flare?: Maybe<string> }> = null;
    if (sun) {
      const applied = this.engine?.Dressing();
      dressing = applied ? { template: ResourceName(applied.postProcess), flare: ResourceName(applied.flare) } : { template: sun.templates[0], flare: sun.flares[0] };
    }
    return dressing;
  }
}

function SetPlanetSize(planet: Maybe<EvePlanet>, scale: number): void {
  if (planet) {
    vec3.set(planet.scaling, scale, scale, scale);
    planet.radius = scale;
  }
}

/**
 * The bare name of a res path (`res:/fisfx/lensflare/blue_sun.black` → `blue_sun`); null for anything else.
 */
function ResourceName(path: Maybe<string>): Maybe<string> {
  const match = path ? /\/([^/]+)\.black$/iu.exec(path) : null;
  return match ? match[1] : null;
}
