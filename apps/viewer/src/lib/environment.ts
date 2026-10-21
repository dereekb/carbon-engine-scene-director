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
 * `?post=off|<template>`, `?flare=off|<name>` and `?aa=off` switch each part
 * for A/B checks, as `?tier=` does in resources.ts.
 */

import type { Maybe } from '@dereekb/util';
import { ErrorText } from './resources';
import { blue, CjsSchema, EveLensflare, Tr2PostProcess2, Tr2PPDynamicExposureEffect, Tr2PPTonemappingEffect, Tr2Renderer, vec3, type EveSpaceScene } from './runtime';

export const DEFAULT_SUN_TEMPLATE = 'env_sun_yellow_01a';
export const DEFAULT_LENS_FLARE = 'yellow';

const OFF = 'off';
const RESOURCE_NAME = /^[a-z0-9_]+$/u;
const CLIENT_DEFAULTS_ONLY = 'client defaults only';

/**
 * One astronomical unit in metres: where the demo puts a flare with no authored distance.
 */
const AU = 1.4959787e11;

export interface RenderOptions {
  /**
   * The sun environment template under res:/dx9/postprocess/environmenttemplate/, or `off`.
   */
  readonly post: string;
  /**
   * The lens flare under res:/fisfx/lensflare/, or `off`.
   */
  readonly flare: string;
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
 * @returns The options, defaulting to the client's dressing with TAA on.
 */
export function ReadRenderOptions(search: string = globalThis.location?.search ?? ''): RenderOptions {
  const params = new URLSearchParams(search);
  return {
    post: ResourceName(params, 'post', DEFAULT_SUN_TEMPLATE),
    flare: ResourceName(params, 'flare', DEFAULT_LENS_FLARE),
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
  return { state: 'loading', postProcess: null, tonemapping: null, dynamicExposure: null, flare: null, antiAliasing: options.antiAliasing, errors: [] };
}

/**
 * Gives the live scene the client's post process and lens flare. Runs after the
 * scene is initialized and the device resources are prepared, so the template's
 * effects initialize against a live device; frames draw meanwhile. Never throws:
 * every failure goes to console.warn and `dressing.errors`.
 *
 * @param scene - The initialized scene.
 * @param options - The render options.
 * @param dressing - The record to fill in; get_state reads it.
 */
export async function DressScene(scene: EveSpaceScene, options: RenderOptions, dressing: SceneDressing): Promise<void> {
  const parts: Promise<boolean>[] = [];
  if (options.post !== OFF) parts.push(ApplyPostProcess(scene, options.post, dressing));
  if (options.flare !== OFF) parts.push(AddLensFlare(scene, options.flare, dressing));
  const results = await Promise.all(parts);
  if (results.length === 0) dressing.state = 'off';
  else dressing.state = results.every(Boolean) ? 'applied' : 'partial';
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

/**
 * Loads the sun template as the scene's post process and adds the client's
 * tonemapping and dynamic exposure where it lacks them, as the client does.
 *
 * @param scene - The live scene.
 * @param name - The template name.
 * @param dressing - The record to fill in.
 * @returns True when the template loaded; on failure the client defaults still apply.
 */
async function ApplyPostProcess(scene: EveSpaceScene, name: string, dressing: SceneDressing): Promise<boolean> {
  const path = `res:/dx9/postprocess/environmenttemplate/${name}.black`;
  let loaded = false;
  let post: Maybe<Tr2PostProcess2> = null;
  try {
    const object = await blue.resMan.LoadObject(path);
    post = CjsSchema.cast(object, Tr2PostProcess2);
    if (!post) throw new Error(`it is a ${TypeName(object)}, not a Tr2PostProcess2`);
    dressing.postProcess = path;
    loaded = true;
  } catch (error) {
    Fail(dressing, `post process ${path}: ${ErrorText(error)}; using the client's tonemapping and dynamic exposure only`);
  }
  try {
    post ??= new Tr2PostProcess2();
    dressing.postProcess ??= CLIENT_DEFAULTS_ONLY;
    dressing.tonemapping = post.tonemapping ? 'template' : 'client';
    if (!post.tonemapping) post.SetTonemapping(new Tr2PPTonemappingEffect());
    dressing.dynamicExposure = post.dynamicExposure ? 'template' : 'client';
    if (!post.dynamicExposure) post.SetDynamicExposure(new Tr2PPDynamicExposureEffect());
    scene.postprocess = post;
  } catch (error) {
    Fail(dressing, `post process: ${ErrorText(error)}`);
    loaded = false;
  }
  return loaded;
}

/**
 * Adds the sun's lens flare, placed along the sun direction at its authored
 * distance (EveLensflare's direction is the negated position), as the demo's
 * PlaceSun does.
 *
 * @param scene - The live scene.
 * @param name - The flare name.
 * @param dressing - The record to fill in.
 * @returns True when the flare was added.
 */
async function AddLensFlare(scene: EveSpaceScene, name: string, dressing: SceneDressing): Promise<boolean> {
  const path = `res:/fisfx/lensflare/${name}.black`;
  let added = false;
  try {
    const object = await blue.resMan.LoadObject(path);
    const flare = CjsSchema.cast(object, EveLensflare);
    if (!flare) throw new Error(`it is a ${TypeName(object)}, not an EveLensflare`);
    const direction = vec3.normalize(vec3.create(), scene.sunDirection);
    vec3.scale(flare.position, direction, -(vec3.length(flare.position) || AU));
    scene.lensflares.push(flare);
    dressing.flare = path;
    added = true;
  } catch (error) {
    Fail(dressing, `lens flare ${path}: ${ErrorText(error)}`);
  }
  return added;
}

function Fail(dressing: SceneDressing, message: string): void {
  dressing.errors.push(message);
  console.warn(message);
}

function ResourceName(params: URLSearchParams, key: string, fallback: string): string {
  const value = params.get(key);
  if (!value) return fallback;
  if (RESOURCE_NAME.test(value)) return value;
  console.warn(`?${key}=${value} is not a resource name (lower-case letters, digits, underscores); using ${fallback}`);
  return fallback;
}

function TypeName(value: unknown): string {
  return (value as Maybe<{ constructor?: { name?: string } }>)?.constructor?.name ?? typeof value;
}
