/**
 * The EVE client's scene dressing, and the environment report get_state shows.
 *
 * A universe file carries the nebula (its backgroundEffect), the env maps and
 * the sun direction, but not what the client adds to every space scene: a post
 * process (the system's sun environment template, with the client's own
 * tonemapping and dynamic exposure injected when the template lacks them; only
 * 1 of the 168 shipped templates carries tonemapping) and the sun's lens flare.
 * Without dynamic exposure the nebula, whose median texel is about 0.01 linear,
 * lands at the clear colour's level and reads as no background at all. The
 * runtime's Oct 3 WebGPU demo, whose skybox rendered, dressed its scene the
 * same way.
 *
 * With a location the star picks them (`toSunDressingNames`): its environment
 * template and flare, with the flare on a curve at the star's true position for
 * Carbon's distance falloff. `SceneDresser.Dress` re-dresses the live scene when
 * the star changes, keeping the client-injected exposure so it does not ramp
 * from scratch.
 *
 * `?post=off|<template>`, `?flare=off|<name>` and `?aa=off` switch each part
 * for A/B checks, as `?tier=` does in resources.ts; a named one overrides the
 * star's.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_LENS_FLARE, DEFAULT_SUN_TEMPLATE, type DressedSun } from '@scene-director/scene';
import { ErrorText } from './resources';
import { blue, CjsSchema, EveLensflare, Tr2PostProcess2, Tr2PPDynamicExposureEffect, Tr2PPTonemappingEffect, Tr2Renderer, Tr2TranslationAdapter, vec3, type EveSpaceScene } from './runtime';

const OFF = 'off';
const RESOURCE_NAME = /^[a-z0-9_]+$/u;
const CLIENT_DEFAULTS_ONLY = 'client defaults only';

/**
 * One astronomical unit in metres: where the demo puts a flare with no authored distance.
 */
const AU = 1.4959787e11;

export interface RenderOptions {
  /**
   * The sun environment template under res:/dx9/postprocess/environmenttemplate/, or `off`; null (absent from the
   * URL) means the location star's, else DEFAULT_SUN_TEMPLATE.
   */
  readonly post: Maybe<string>;
  /**
   * The lens flare under res:/fisfx/lensflare/, or `off`; null means the location star's, else DEFAULT_LENS_FLARE.
   */
  readonly flare: Maybe<string>;
  /**
   * TAA, which a scene post process turns on at Carbon's default quality.
   */
  readonly antiAliasing: boolean;
}

export type DressingSource = 'template' | 'client';

/**
 * What the dressing applied; get_state reports it as is.
 */
export interface SceneDressing {
  state: 'loading' | 'applied' | 'partial' | 'off';
  /**
   * The template's res path, or "client defaults only" when it failed to load.
   */
  postProcess: Maybe<string>;
  tonemapping: Maybe<DressingSource>;
  dynamicExposure: Maybe<DressingSource>;
  flare: Maybe<string>;
  antiAliasing: boolean;
  /**
   * Where the template and flare came from: the URL (`?post=` / `?flare=`), the location's star, or the defaults.
   */
  source: Maybe<'url' | 'star' | 'default'>;
  /**
   * The location star's name, or null without one.
   */
  star: Maybe<string>;
  errors: string[];
}

export interface BackgroundTextureReport {
  readonly name: string;
  readonly path: string;
  readonly state: Maybe<string>;
  readonly good: boolean;
  readonly failed: boolean;
  readonly format: Maybe<number>;
  readonly cube: boolean;
  readonly width: number;
  readonly height: number;
  readonly error: Maybe<string>;
}

export interface BackgroundQuadCounts {
  /**
   * Camera-space quads the blitter drew: the nebula, plus the reflection pass when a probe exists.
   */
  drawn: number;
  /**
   * Quads it refused: no material, shader, prepared resources or mapped vertex buffer.
   */
  refused: number;
}

export interface SceneEnvironmentReport {
  readonly backgroundRenderingEnabled: boolean;
  readonly display: boolean;
  readonly nebulaIntensity: number;
  readonly sunDirection: number[];
  /**
   * Whether a sun ball (the location's star) drives sunDirection.
   */
  readonly sunBall: boolean;
  /**
   * EvePlanets in the planet pass: the sun disc and the dressed planets and moons.
   */
  readonly planets: number;
  readonly lensflares: number;
  readonly background: {
    readonly effect: Maybe<string>;
    readonly ready: boolean;
    readonly effectFailed: boolean;
    readonly textures: BackgroundTextureReport[];
  };
  readonly envMaps: {
    readonly envMapResPath: string;
    readonly envMap1ResPath: string;
    readonly envMap2ResPath: string;
    readonly envMap3ResPath: string;
  };
  readonly dressing: SceneDressing;
  readonly backgroundQuad: BackgroundQuadCounts;
}

const quadCounts: BackgroundQuadCounts = { drawn: 0, refused: 0 };
let countingQuads = false;

/**
 * Reads the render switches from the page URL. Called after the console is
 * captured, so a rejected value reaches page_log.
 *
 * @param search - The URL query string.
 * @returns The options: null template and flare (the star's, or the defaults) with TAA on.
 */
export function ReadRenderOptions(search: string = globalThis.location?.search ?? ''): RenderOptions {
  const params = new URLSearchParams(search);
  return {
    post: ResourceName(params, 'post'),
    flare: ResourceName(params, 'flare'),
    antiAliasing: params.get('aa') !== OFF
  };
}

/**
 * A dressing record before DressScene runs.
 *
 * @param options - The render options.
 * @returns The record, in the `loading` state.
 */
export function CreateSceneDressing(options: RenderOptions): SceneDressing {
  return { state: 'loading', postProcess: null, tonemapping: null, dynamicExposure: null, flare: null, antiAliasing: options.antiAliasing, source: null, star: null, errors: [] };
}

/**
 * Gives the live scene the client's post process and lens flare, for the location's star or the defaults, and
 * re-dresses it when the star changes. Runs after the scene is initialized and the device resources are prepared, so
 * the template's effects initialize against a live device; frames draw meanwhile. Never throws: every failure goes to
 * console.warn and `report.errors`.
 */
export class SceneDresser {
  /**
   * What the dressing applied; get_state reads it.
   */
  readonly report: SceneDressing;
  private readonly options: RenderOptions;
  /**
   * The flare's curve at the star's true position (EveLensflare.Update writes position and its distance falloff).
   */
  private readonly flareCurve = new Tr2TranslationAdapter();
  private flare: Maybe<EveLensflare> = null;
  /**
   * The flare's authored distance, used along sunDirection without a star.
   */
  private flareDistance = AU;
  private sun: Maybe<DressedSun> = null;
  private postKey: Maybe<string> = null;
  private flareKey: Maybe<string> = null;
  private postGeneration = 0;
  private flareGeneration = 0;
  private postOk = true;
  private flareOk = true;
  private postErrors: string[] = [];
  private flareErrors: string[] = [];
  private clientTonemapping: Maybe<Tr2PPTonemappingEffect> = null;
  private clientExposure: Maybe<Tr2PPDynamicExposureEffect> = null;

  constructor(options: RenderOptions) {
    this.options = options;
    this.report = CreateSceneDressing(options);
  }

  /**
   * Dresses the scene for a star (or the defaults without one): loads the first template and flare that load when
   * their candidates changed, and puts the flare on the star's position.
   *
   * @param scene - The live scene.
   * @param sun - The location's dressed star, or null.
   */
  async Dress(scene: EveSpaceScene, sun: Maybe<DressedSun>): Promise<void> {
    this.sun = sun;
    const templates = Candidates(this.options.post, sun?.templates, DEFAULT_SUN_TEMPLATE);
    const flares = Candidates(this.options.flare, sun?.flares, DEFAULT_LENS_FLARE);
    this.report.star = sun?.name ?? null;
    this.report.source = this.options.post != null || this.options.flare != null ? 'url' : sun ? 'star' : 'default';
    const parts: Promise<void>[] = [];
    const postKey = templates.join(',');
    const flareKey = flares.join(',');
    if (postKey !== this.postKey) {
      this.postKey = postKey;
      if (templates.length > 0) parts.push(this.ApplyPostProcess(scene, templates, ++this.postGeneration));
    }
    if (flareKey !== this.flareKey) {
      this.flareKey = flareKey;
      parts.push(this.ApplyLensFlare(scene, flares, ++this.flareGeneration));
    }
    this.PlaceFlare(scene);
    if (parts.length > 0) {
      this.report.state = 'loading';
      await Promise.all(parts);
    }
    if (this.postKey === postKey && this.flareKey === flareKey) {
      this.report.errors = [...this.postErrors, ...this.flareErrors];
      if (templates.length + flares.length === 0) this.report.state = 'off';
      else this.report.state = this.postOk && this.flareOk ? 'applied' : 'partial';
    }
  }

  /**
   * Loads the first template that loads as the scene's post process and adds the client's tonemapping and dynamic
   * exposure where it lacks them, as the client does (reusing the ones it injected before).
   */
  private async ApplyPostProcess(scene: EveSpaceScene, templates: readonly string[], generation: number): Promise<void> {
    const errors: string[] = [];
    let post: Maybe<Tr2PostProcess2> = null;
    let path: Maybe<string> = null;
    for (const name of templates) {
      const candidate = `res:/dx9/postprocess/environmenttemplate/${name}.black`;
      try {
        const object = await blue.resMan.LoadObject(candidate);
        post = CjsSchema.cast(object, Tr2PostProcess2);
        if (!post) throw new Error(`it is a ${TypeName(object)}, not a Tr2PostProcess2`);
        path = candidate;
        break;
      } catch (error) {
        errors.push(`post process ${candidate}: ${ErrorText(error)}`);
      }
    }
    if (generation !== this.postGeneration) return;
    if (!post) errors.push("post process: no template loaded; using the client's tonemapping and dynamic exposure only");
    else if (errors.length > 0) errors.push(`post process: fell back from ${templates.slice(0, errors.length).join(', ')} to ${path}`);
    let ok = path === `res:/dx9/postprocess/environmenttemplate/${templates[0]}.black`;
    try {
      post ??= new Tr2PostProcess2();
      this.report.postProcess = path ?? CLIENT_DEFAULTS_ONLY;
      this.report.tonemapping = post.tonemapping ? 'template' : 'client';
      if (!post.tonemapping) post.SetTonemapping((this.clientTonemapping ??= new Tr2PPTonemappingEffect()));
      this.report.dynamicExposure = post.dynamicExposure ? 'template' : 'client';
      if (!post.dynamicExposure) post.SetDynamicExposure((this.clientExposure ??= new Tr2PPDynamicExposureEffect()));
      scene.postprocess = post;
    } catch (error) {
      errors.push(`post process: ${ErrorText(error)}`);
      ok = false;
    }
    for (const message of errors) console.warn(message);
    this.postErrors = errors;
    this.postOk = ok;
  }

  /**
   * Swaps the lens flare for the first candidate that loads; the old one is spliced out and destructed.
   */
  private async ApplyLensFlare(scene: EveSpaceScene, flares: readonly string[], generation: number): Promise<void> {
    const errors: string[] = [];
    let flare: Maybe<EveLensflare> = null;
    let path: Maybe<string> = null;
    for (const name of flares) {
      const candidate = `res:/fisfx/lensflare/${name}.black`;
      try {
        const object = await blue.resMan.LoadObject(candidate);
        flare = CjsSchema.cast(object, EveLensflare);
        if (!flare) throw new Error(`it is a ${TypeName(object)}, not an EveLensflare`);
        path = candidate;
        break;
      } catch (error) {
        errors.push(`lens flare ${candidate}: ${ErrorText(error)}`);
      }
    }
    if (generation !== this.flareGeneration) {
      flare?.Destruct();
      return;
    }
    if (flare && errors.length > 0) errors.push(`lens flare: fell back from ${flares.slice(0, errors.length).join(', ')} to ${path}`);
    this.RemoveFlare(scene);
    if (flare) {
      this.flareDistance = vec3.length(flare.position) || AU;
      scene.lensflares.push(flare);
      this.flare = flare;
    }
    this.report.flare = path;
    this.PlaceFlare(scene);
    for (const message of errors) console.warn(message);
    this.flareErrors = errors;
    this.flareOk = flares.length === 0 || path === `res:/fisfx/lensflare/${flares[0]}.black`;
  }

  /**
   * With a star the flare rides a curve at its true position; without one it sits along the sun direction at its
   * authored distance (EveLensflare's direction is the negated position), as the demo's PlaceSun does.
   */
  private PlaceFlare(scene: EveSpaceScene): void {
    const flare = this.flare;
    if (flare) {
      if (this.sun) {
        vec3.set(this.flareCurve.value, this.sun.position[0], this.sun.position[1], this.sun.position[2]);
        flare.translationCurve = this.flareCurve;
      } else {
        flare.translationCurve = null;
        const direction = vec3.normalize(vec3.create(), scene.sunDirection);
        vec3.scale(flare.position, direction, -this.flareDistance);
      }
    }
  }

  private RemoveFlare(scene: EveSpaceScene): void {
    const flare = this.flare;
    if (flare) {
      const index = scene.lensflares.indexOf(flare);
      if (index >= 0) scene.lensflares.splice(index, 1);
      try {
        flare.Destruct();
      } catch (error) {
        console.warn(`lens flare teardown: ${ErrorText(error)}`);
      }
      this.flare = null;
    }
  }
}

/**
 * The names to try: none for `off`, the URL's when it names one, else the star's (which end in the default), else the
 * default.
 */
function Candidates(option: Maybe<string>, star: Maybe<readonly string[]>, fallback: string): readonly string[] {
  let candidates: readonly string[] = star ?? [fallback];
  if (option === OFF) candidates = [];
  else if (option) candidates = [option];
  return candidates;
}

/**
 * Plain JSON describing the scene's background and dressing, for get_state.
 * Reads state only: Tr2Effect.IsGood renews resources and adds notify targets,
 * so it is never called from here.
 *
 * @param scene - The scene.
 * @param dressing - The dressing record.
 * @returns The report.
 */
export function EnvironmentReport(scene: EveSpaceScene, dressing: SceneDressing): SceneEnvironmentReport {
  const effect = scene.backgroundEffect;
  const textures: BackgroundTextureReport[] = [];
  for (const parameter of effect?.resources ?? []) {
    const resource = parameter.resource ?? null;
    textures.push({
      name: parameter.name,
      path: parameter.resourcePath ?? '',
      state: resource?.state ?? null,
      good: resource?.IsPrepared() ?? false,
      failed: resource?.IsFailed() ?? false,
      format: resource?.format ?? null,
      cube: resource?.arraySize === 6,
      width: resource?.width ?? 0,
      height: resource?.height ?? 0,
      error: resource?.error?.message ?? null
    });
  }
  return {
    backgroundRenderingEnabled: scene.backgroundRenderingEnabled,
    display: scene.display,
    nebulaIntensity: scene.nebulaIntensity,
    sunDirection: Array.from(scene.sunDirection),
    sunBall: scene.sunBall != null,
    planets: scene.planets.length,
    lensflares: scene.lensflares.length,
    background: {
      effect: effect?.effectFilePath ?? null,
      ready: effect?.effectResource?.IsPrepared() === true && effect.shader !== null,
      effectFailed: effect?.effectResource?.IsFailed() ?? false,
      textures
    },
    envMaps: { envMapResPath: scene.envMapResPath, envMap1ResPath: scene.envMap1ResPath, envMap2ResPath: scene.envMap2ResPath, envMap3ResPath: scene.envMap3ResPath },
    dressing,
    backgroundQuad: { ...quadCounts }
  };
}

/**
 * Counts what `Tr2Renderer.drawCameraSpaceScreenQuad` returns, transparently and
 * once. Only the nebula (and the reflection pass, when a probe exists) draws
 * through it, so the counts show whether the blitter actually drew the
 * background. Page-side instrumentation; the runtime is not edited.
 */
export function CountBackgroundQuads(): void {
  if (countingQuads) return;
  countingQuads = true;
  const draw = Tr2Renderer.drawCameraSpaceScreenQuad.bind(Tr2Renderer);
  Tr2Renderer.drawCameraSpaceScreenQuad = (renderContext, shader, material) => {
    const drawn = draw(renderContext, shader, material);
    if (drawn) quadCounts.drawn += 1;
    else quadCounts.refused += 1;
    return drawn;
  };
}

function ResourceName(params: URLSearchParams, key: string): Maybe<string> {
  const value = params.get(key);
  let name: Maybe<string> = null;
  if (value && RESOURCE_NAME.test(value)) name = value;
  else if (value) console.warn(`?${key}=${value} is not a resource name (lower-case letters, digits, underscores); using the star's or the default`);
  return name;
}

function TypeName(value: unknown): string {
  return (value as Maybe<{ constructor?: { name?: string } }>)?.constructor?.name ?? typeof value;
}
