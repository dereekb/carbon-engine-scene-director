/**
 * The renderer: a WebGPU device, an EveSpaceScene with its render driver, the
 * frame loop, an orbit camera, and frame capture. Ported from the runtime's
 * Oct 3 WebGPU viewer, minus its diagnostics, and holding any number of ships.
 *
 * The scene initializes empty; ships join and leave it through the scene's
 * child list afterwards, which is how the viewer swapped skins on a live scene.
 */

import type { Maybe } from '@dereekb/util';
import { blendPoses, DEFAULT_CAMERA_FOV, poseFromViewMatrix, poseViewMatrix, type CameraPose, type DressedSun } from '@scene-director/scene';
import { AnimationClock } from './animation-clock';
import { DriveEveCamera, OrbitFitDistance, PanMetresPerPixel } from './camera';
import { TICKS_PER_MS } from './clock';
import type { CinemaFrame } from './cinema';
import { EVE_DATA_ON, type PageEveData } from './eve-data';
import { CountBackgroundQuads, EnvironmentReport, ReadRenderOptions, SceneDresser, type SceneDressing, type SceneEnvironmentReport } from './environment';
import { ErrorText, ExpectRefusals, ResourceValues } from './resources';
import { GREEN_SCREEN, StandInPass, type StandInCube } from './stand-ins';
import {
  addChild,
  blue,
  CjsBatchManager,
  CjsPngFormat,
  CjsSchema,
  CjsWebgpuDevice,
  CjsWebgpuRenderContextAL,
  CjsWebgpuRenderTarget,
  EveCamera,
  EveSpaceScene,
  EveSpaceSceneRenderDriver,
  gTriDev,
  removeChild,
  RenderingMode,
  Tr2QuadRenderer,
  Tr2RenderContext_GetMainThreadRenderContext,
  Tr2RenderJobs,
  Tr2Renderer,
  Tr2SSAO,
  TriBatchType,
  TriDevice,
  TriRenderBatchAccumulator,
  TriRenderJob,
  TriStepPythonCB,
  vec3,
  type CjsModelValues,
  type EvePlanet,
  type EveShip2,
  type EveEffectRoot2,
  type EveMissile,
  type EveRootTransform,
  type EveSpaceObject2,
  type EveStretch,
  type EveStretch3,
  type Tr2Effect,
  type TriVectorCurve,
  type Vec3
} from './runtime';

const DEGREES = Math.PI / 180;

/**
 * `?anim=real` keeps Blue's own real-time frame clock: the runtime's animations then go on while paused; the A/B for
 * the animation clock, sd-time.
 */
export const ANIMATION_ON_SCENE_CLOCK = new URLSearchParams(globalThis.location?.search ?? '').get('anim') !== 'real';

/**
 * What the page puts in scene.objects besides ships: static objects, module effects (module-effects.ts) and ship-death
 * explosions (explosions.ts), drawn missiles and their impacts (missile-effects.ts).
 */
export type SceneObjectRoot = EveSpaceObject2 | EveStretch | EveStretch3 | EveRootTransform | EveEffectRoot2 | EveMissile;

/**
 * EVE's maps are BC7/BC5; without the feature the reader decodes to RGBA8.
 */
const WANTED_FEATURES: GPUFeatureName[] = ['texture-compression-bc', 'texture-compression-bc-sliced-3d', 'float32-filterable', 'depth-clip-control'];

/**
 * Distinct WebGPU error messages logged before the rest are only counted.
 */
const MAX_GPU_ERROR_MESSAGES = 20;

/**
 * A captured frame: top-down RGBA, alpha forced opaque.
 */
export interface CapturedFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface EncodedPng {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface EngineStats {
  readonly adapter: string;
  readonly features: string[];
  readonly canvas: [number, number];
  readonly fps: number;
  readonly drawnBatches: Maybe<number>;
  readonly lastFrameError: Maybe<string>;
  readonly deviceLost: Maybe<string>;
  /**
   * WebGPU's uncaptured errors (validation, out-of-memory, internal): every one counted, the first distinct ones kept.
   */
  readonly gpuErrors: { readonly count: number; readonly messages: string[] };
  /**
   * The clock the runtime's own animations run on (animation-clock.ts): scene, or real under ?anim=real; the seconds it
   * advanced, whether the last frame held it, and the shaders' Time.
   */
  readonly animation: { readonly clock: 'scene' | 'real'; readonly seconds?: number; readonly frozen?: boolean; readonly shaderTime: number };
  /**
   * What the page draws without EVE data (stand-ins.ts): whether the backdrop is the green screen (the universe file
   * did not load), and the cubes drawn last frame for ships and objects with no model.
   */
  readonly standIns: { readonly greenScreen: boolean; readonly cubes: number };
}

export interface EngineEnvironment extends SceneEnvironmentReport {
  readonly universe: Maybe<string>;
  readonly nebula: EngineNebula;
}

/**
 * The nebula drawn: the document's universe, or the location's region nebula swapped in live.
 */
export interface EngineNebula {
  readonly path: Maybe<string>;
  readonly source: 'universe' | 'location';
  /**
   * `off`: no-EVE-data mode, where no universe file is read (`note` says why).
   */
  readonly state: 'applied' | 'loading' | 'failed' | 'off';
  readonly error?: string;
  readonly note?: string;
}

/**
 * The EveSpaceScene fields every shipped universe file sets, besides backgroundEffect and the env map paths, with the
 * class defaults a live nebula swap resets them to first.
 */
const NEBULA_FIELDS = { backgroundRenderingEnabled: false, nebulaIntensity: 1, reflectionIntensity: 1, fogStart: 0, fogEnd: 0, lowQualityNebulaResPath: '', lowQualityNebulaMixResPath: '' } as const;
const NEBULA_ENV_MAPS = ['envMapResPath', 'envMap1ResPath', 'envMap2ResPath', 'envMap3ResPath'] as const;
const DEFAULT_AMBIENT_COLOR = [0.25, 0.25, 0.25, 1];

/**
 * The clear colour behind the nebula.
 */
const SPACE_CLEAR_COLOR = [0.02, 0.03, 0.05, 1];

export interface CameraPlacement {
  readonly focus?: ArrayLike<number>;
  readonly distance?: Maybe<number>;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly fov?: number;
}

/**
 * Where the camera's eye is and which way it looks, in world space.
 */
export interface CameraEye {
  readonly position: number[];
  readonly front: number[];
  readonly up: number[];
}

/**
 * The camera the last frame drew with: its pose and clip planes.
 */
export interface DrawnCamera extends CameraPose {
  readonly near: number;
  readonly far: number;
}

export interface EngineCreateOptions {
  readonly canvas: HTMLCanvasElement;
  /**
   * res:/ path of the EveSpaceScene whose values dress the scene.
   */
  readonly universe: string;
  /**
   * The tab's EVE data mode; with it off the engine reads no universe, particles or dressing and runs no runtime frame:
   * StandInPass draws every frame (the green screen and the cubes).
   */
  readonly eveData?: PageEveData;
}

interface EngineParts {
  readonly scene: EveSpaceScene;
  /**
   * The runtime's render driver; null with no EVE data (nothing renders the scene then).
   */
  readonly driver: Maybe<EveSpaceSceneRenderDriver>;
  readonly camera: OrbitCamera;
  readonly renderTarget: CjsWebgpuRenderTarget;
  readonly al: CjsWebgpuRenderContextAL;
  readonly pump: FramePump;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

interface FramePump {
  Render(): void;
}

/**
 * What asks the camera's back clip to reach far: the location dressing, the scene's objects, or its asteroid fields.
 */
export type DrawReachSource = 'dressing' | 'objects' | 'fields';

export class Engine {
  private readonly reaches = new Map<DrawReachSource, number>();
  readonly canvas: HTMLCanvasElement;
  readonly adapterInfo: string;
  readonly device: GPUDevice;
  readonly features: GPUFeatureName[];
  readonly ships = new Set<EveShip2>();
  /**
   * The document's universe the engine was created with (a change reloads the tab: CLAUDE.md's reload trick).
   */
  universe: Maybe<string> = null;
  /**
   * The nebula drawn; a location's region nebula swaps in live (SetNebula).
   */
  nebula: EngineNebula = { path: null, source: 'universe', state: 'applied' };
  lastError: Maybe<string> = null;
  deviceLost: Maybe<string> = null;
  /**
   * No EVE data (the mode, or a universe file that did not load): the backdrop is GREEN_SCREEN instead of a nebula.
   */
  greenScreen = false;
  /**
   * The tab's EVE data mode, from Create.
   */
  eveData: PageEveData = EVE_DATA_ON;
  /**
   * Whether the last Frame drew into a swap-chain image (no error, not lost): a movie export captures only such a
   * frame (sd-export).
   */
  lastFrameDrawn = false;
  private readonly capture: FrameCapture;
  /**
   * The canvas backing store's size while a movie export holds it (SetFixedSize), else null: fit to the CSS box.
   */
  private fixedSize: Maybe<{ readonly width: number; readonly height: number }> = null;
  private compositor: Maybe<ExportCompositor> = null;
  /**
   * Blue's frame clock while it follows the scene clock (ANIMATION_ON_SCENE_CLOCK), else null.
   */
  private animation: Maybe<AnimationClock> = null;
  private animationChecked = false;
  private readonly fps = { frames: 0, since: performance.now(), value: 0 };
  private readonly gpuErrors = { count: 0, messages: [] as string[], capped: false };
  private dresser: Maybe<SceneDresser> = null;
  private nebulaGeneration = 0;
  private readonly defaultSunDirection: Vec3 = vec3.fromValues(0, -1, 0);
  private parts: Maybe<EngineParts> = null;
  /**
   * The swap-chain image this frame went into.
   */
  private presented: Maybe<GPUTexture> = null;
  /**
   * The scene clock of the frame being drawn.
   */
  private frameNow = 0;
  /**
   * The cinematic camera for the next frame (cinema.ts), or null for the orbit camera.
   */
  private cinematic: Maybe<CinemaFrame> = null;
  private readonly free = new FreeCamera();
  private drawn: Maybe<DrawnCamera> = null;
  /**
   * The cubes to draw for ships and objects with no model (stand-ins.ts), set by the director every frame.
   */
  private standIns: readonly StandInCube[] = [];
  private standInPass: Maybe<StandInPass> = null;

  /**
   * Creates the device and an initialized, empty scene. The page's animation loop draws it through Frame.
   *
   * @param options - The canvas and the universe to dress the scene with.
   * @returns The running engine.
   * @throws {Error} When WebGPU or a suitable adapter is unavailable.
   */
  static async Create({ canvas, universe, eveData = EVE_DATA_ON }: EngineCreateOptions): Promise<Engine> {
    if (!navigator.gpu) throw new Error('this browser has no WebGPU (navigator.gpu is missing); use a current Chrome or Edge');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU found no adapter; check chrome://gpu');

    const features = WANTED_FEATURES.filter((feature) => adapter.features.has(feature));
    const device = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: {
        // CORTAO packs sixteen mips and the reflection probe filters seven; WebGPU's default is four.
        maxStorageTexturesPerShaderStage: Math.min(16, adapter.limits.maxStorageTexturesPerShaderStage),
        // The cascaded shadow atlas is 16384 wide at its default cell.
        maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D)
      }
    });
    const engine = new Engine(canvas, adapter, device, features);
    engine.eveData = eveData;
    await engine.Initialize(universe);
    return engine;
  }

  private constructor(canvas: HTMLCanvasElement, adapter: GPUAdapter, device: GPUDevice, features: GPUFeatureName[]) {
    this.canvas = canvas;
    const info = adapter.info;
    this.adapterInfo = info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : 'unknown adapter';
    this.device = device;
    this.features = features;
    this.capture = new FrameCapture(device);
    void device.lost.then((lost) => {
      this.deviceLost = `${lost.reason}: ${lost.message}`;
      this.capture.Fail(new Error(`device lost: ${this.deviceLost}`));
      console.error(`WebGPU device lost: ${this.deviceLost}`);
    });
    // Chrome prints WebGPU validation errors to DevTools only; this is how they reach page_log.
    device.addEventListener('uncapturederror', (event) => this.OnGpuError(event.error));
  }

  get camera(): OrbitCamera {
    return this.Parts().camera;
  }

  /**
   * Draws the next frames from the cinematic camera (the director sets it every frame, before Frame), or from the orbit
   * camera with null.
   */
  SetCinematicFrame(frame: Maybe<CinemaFrame>): void {
    this.cinematic = frame;
  }

  /**
   * Holds the canvas backing store at a size (a movie export's picture, sd-export), or fits it to the CSS box again
   * with null. The next Frame reconfigures the render target on a change.
   *
   * @param size - The picture's size in pixels, or null.
   */
  SetFixedSize(size: Maybe<{ readonly width: number; readonly height: number }>): void {
    this.fixedSize = size ? { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) } : null;
  }

  /**
   * The frame just drawn as a movie export's source, called right after Frame in the same task (a VideoFrame reads
   * the canvas only before it is presented, sd-runtime): the canvas itself when the picture fills the output, else the
   * picture composited onto black bars on an output-sized WebGPU OffscreenCanvas.
   *
   * @param output - The output frame's size.
   * @param picture - Where the picture sits in it.
   * @returns The source, or null when the frame did not draw.
   */
  ExportSource(output: { readonly width: number; readonly height: number }, picture: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Maybe<HTMLCanvasElement | OffscreenCanvas> {
    const presented = this.presented;
    if (!this.lastFrameDrawn || !presented) return null;
    const fills = picture.x === 0 && picture.y === 0 && this.canvas.width === output.width && this.canvas.height === output.height;
    if (fills) return this.canvas;
    this.compositor ??= new ExportCompositor(this.device, this.Parts().format);
    return this.compositor.Compose(presented, output, picture);
  }

  /**
   * The cubes the next frames draw for ships and objects with no model (stand-ins.ts); empty draws none.
   *
   * @param cubes - The cubes, placed for the frame about to draw.
   */
  SetStandIns(cubes: readonly StandInCube[]): void {
    this.standIns = cubes;
  }

  /**
   * The canvas's width / height.
   */
  Aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  /**
   * The camera the last frame drew with, or null before the first frame.
   */
  DrawnCamera(): Maybe<DrawnCamera> {
    return this.drawn;
  }

  get scene(): EveSpaceScene {
    return this.Parts().scene;
  }

  /**
   * Adds a hydrated ship to the live scene.
   */
  AddShip(ship: EveShip2): void {
    const { scene } = this.Parts();
    addChild(scene, 'objects', ship, { listNotify: scene });
    this.ships.add(ship);
  }

  /**
   * Removes a ship from the scene; the caller retires its resources.
   */
  RemoveShip(ship: EveShip2): void {
    const { scene } = this.Parts();
    removeChild(scene, 'objects', ship, { listNotify: scene });
    this.ships.delete(ship);
  }

  /**
   * Adds a static object (a dressed station or stargate) or a module effect (a beam, the web's trigger) to the live
   * scene. A module effect is added when it starts, so it follows the ships built before it in scene.objects.
   */
  AddObject(object: SceneObjectRoot): void {
    const { scene } = this.Parts();
    addChild(scene, 'objects', object, { listNotify: scene });
  }

  RemoveObject(object: SceneObjectRoot): void {
    const { scene } = this.Parts();
    removeChild(scene, 'objects', object, { listNotify: scene });
  }

  /**
   * Adds a body (a dressed planet, moon or the sun disc) to the planet pass.
   */
  AddPlanet(planet: EvePlanet): void {
    const { scene } = this.Parts();
    addChild(scene, 'planets', planet, { listNotify: scene });
  }

  RemovePlanet(planet: EvePlanet): void {
    const { scene } = this.Parts();
    removeChild(scene, 'planets', planet, { listNotify: scene });
  }

  /**
   * Points the light from the location's star: the scene sets sunDirection from the curve every frame. Null restores
   * the universe's direction.
   */
  SetSunBall(curve: Maybe<TriVectorCurve>): void {
    const { scene } = this.Parts();
    scene.sunBall = curve ?? null;
    if (!curve) vec3.copy(scene.sunDirection, this.defaultSunDirection);
  }

  /**
   * Re-dresses the post process and lens flare for the location's star, or the defaults without one.
   */
  DressSun(sun: Maybe<DressedSun>): void {
    const { scene } = this.Parts();
    if (this.dresser) void this.dresser.Dress(scene, sun);
  }

  /**
   * What the scene dresser applied (the post process and lens flare), or null before the engine is up.
   */
  Dressing(): Maybe<SceneDressing> {
    return this.dresser?.report ?? null;
  }

  /**
   * Metres from the origin the camera's back clip must reach for one source (the farthest dressed object, or the
   * farthest scene object); 0 for none. The camera reaches the largest of the sources.
   *
   * @param metres - The reach.
   * @param source - What it is for; default the location dressing.
   */
  SetDrawReach(metres: number, source: DrawReachSource = 'dressing'): void {
    this.reaches.set(source, Math.max(0, metres));
    this.Parts().camera.reach = Math.max(0, ...this.reaches.values());
  }

  /**
   * Swaps the drawn nebula live: reads the universe file as values, hydrates a fresh background effect, then between
   * frames resets the fields every universe file sets, copies the file's, and reloads the env maps. On failure the old
   * nebula stays and the error is recorded.
   *
   * @param path - A universe file (an EveSpaceScene).
   * @param source - Why it is drawn.
   */
  async SetNebula(path: string, source: EngineNebula['source']): Promise<void> {
    const { scene } = this.Parts();
    if (path === this.nebula.path) {
      this.nebula = { ...this.nebula, source };
      return;
    }
    const generation = ++this.nebulaGeneration;
    this.nebula = { path, source, state: 'loading' };
    let effect: Maybe<Tr2Effect> = null;
    try {
      const values = await ResourceValues(path);
      if (values._type !== 'EveSpaceScene') throw new Error(`it is a ${values._type}, not an EveSpaceScene`);
      effect = NebulaEffect(values);
      if (generation !== this.nebulaGeneration) {
        effect?.Destruct();
        return;
      }
      const old = scene.backgroundEffect;
      ApplyNebulaValues(scene, values, effect);
      if (old && old !== effect) old.Destruct();
      this.nebula = { path, source, state: 'applied' };
    } catch (error) {
      if (generation === this.nebulaGeneration) {
        const message = `nebula ${path}: ${ErrorText(error)}`;
        console.warn(message);
        this.nebula = { path, source, state: 'failed', error: message };
      }
    }
  }

  /**
   * Resolves with the next completed frame.
   */
  Capture(): Promise<CapturedFrame> {
    return this.capture.Request();
  }

  /**
   * Whether a Capture waits for its frame: the frame lock's wait frames draw then (main.ts), so a screenshot never waits
   * on a slow grid.
   */
  get capturePending(): boolean {
    return this.capture.waiting;
  }

  Stats(): EngineStats {
    return {
      adapter: this.adapterInfo,
      features: this.features,
      canvas: [this.canvas.width, this.canvas.height],
      fps: this.fps.value,
      drawnBatches: this.parts?.al.GetDrawnBatchCount?.() ?? null,
      lastFrameError: this.lastError,
      deviceLost: this.deviceLost,
      gpuErrors: { count: this.gpuErrors.count, messages: [...this.gpuErrors.messages] },
      animation: { clock: this.animation ? 'scene' : 'real', ...this.animation?.Report(), shaderTime: Math.round(Tr2Renderer.GetAnimationTime() * 100) / 100 },
      standIns: { greenScreen: this.greenScreen, cubes: this.standIns.length }
    };
  }

  /**
   * The scene's background and the client dressing, for get_state.
   */
  Environment(): Maybe<EngineEnvironment> {
    const { parts, dresser } = this;
    return parts && dresser ? { universe: this.universe, nebula: this.nebula, ...EnvironmentReport(parts.scene, dresser.report) } : null;
  }

  /**
   * Counts every uncaptured WebGPU error and logs each distinct one once, up to a cap.
   */
  private OnGpuError(error: GPUError): void {
    const errors = this.gpuErrors;
    errors.count += 1;
    // Native error classes keep their names: GPUValidationError, GPUOutOfMemoryError, GPUInternalError.
    const message = `${error.constructor.name}: ${error.message}`;
    const known = errors.messages.includes(message);
    if (!known && errors.messages.length < MAX_GPU_ERROR_MESSAGES) {
      errors.messages.push(message);
      console.error(`WebGPU ${message}`);
    } else if (!known && !errors.capped) {
      errors.capped = true;
      console.error(`WebGPU: ${MAX_GPU_ERROR_MESSAGES} distinct errors logged; further WebGPU errors are counted, not logged`);
    }
  }

  private Parts(): EngineParts {
    if (!this.parts) throw new Error('the engine is not initialized');
    return this.parts;
  }

  private async Initialize(universe: string): Promise<void> {
    const { canvas, device } = this;
    FitCanvasSize(canvas);
    const webgpu = new CjsWebgpuDevice({ device, shaderStage: GPUShaderStage });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('the canvas has no WebGPU context');
    const format = navigator.gpu.getPreferredCanvasFormat();

    // Remember which swap-chain image the frame went into: asking the context
    // again after the submit can hand back a different one, and the capture
    // then reads a blank image.
    const getCurrentTexture = context.getCurrentTexture.bind(context);
    context.getCurrentTexture = () => {
      this.presented = getCurrentTexture();
      return this.presented;
    };

    const noEveData = this.eveData.on ? null : (this.eveData.note ?? 'no EVE data');
    // A new EveSpaceScene asks for its volumetric fog effects (the runtime's field initializers): with no EVE data the
    // gate refuses them as expected (resources.ts ExpectRefusals), and nothing ever draws the scene.
    const scene = noEveData ? await ExpectRefusals(() => new EveSpaceScene()) : new EveSpaceScene();
    let universeValues: Maybe<CjsModelValues> = null;
    if (noEveData) {
      // No-EVE-data mode: nothing to read. StandInPass draws the green screen and the cubes every frame.
      this.universe = universe || null;
      this.nebula = { path: universe || null, source: 'universe', state: 'off', note: noEveData };
      this.greenScreen = true;
    } else if (universe) {
      this.universe = universe;
      try {
        // Applied as values: loading it as an object would run Initialize before the device exists.
        const values = await ResourceValues(universe);
        if (values._type !== 'EveSpaceScene') throw new Error(`${universe} is a ${values._type}, not an EveSpaceScene`);
        CjsSchema.setValues(scene, values);
        universeValues = values;
        this.nebula = { path: universe, source: 'universe', state: 'applied' };
      } catch (error) {
        const message = `nebula ${universe}: ${ErrorText(error)}`;
        console.warn(`${message}; drawing the green screen and stand-in cubes`);
        this.nebula = { path: universe, source: 'universe', state: 'failed', error: message };
        this.greenScreen = true;
      }
    }
    vec3.copy(this.defaultSunDirection, scene.sunDirection);
    // The client's dynamic-lights setting (off by default in Carbon); without it
    // attachment lights never reach a shader. The client also turns new bloom off.
    Tr2Renderer.getSettings().SetValue('eveSpaceSceneDynamicLighting', true);
    Tr2Renderer.getSettings().SetValue('newBloom', false);
    if (!noEveData) {
      try {
        scene.gpuParticleSystem = await blue.resMan.LoadObject('res:/fisfx/gpuparticles/system.black');
      } catch (error) {
        console.warn(`gpu particles unavailable: ${ErrorText(error)}`);
      }
    }

    // The canvas texture must be copyable for capture. The context is
    // configured once, here; configuring it again destroys the acquired texture.
    const renderTarget = new CjsWebgpuRenderTarget(webgpu, {
      canvas,
      context,
      format,
      depthFormat: 'depth24plus',
      extraUsage: GPUTextureUsage.COPY_SRC,
      alphaMode: 'opaque'
    }).Configure({ width: canvas.width, height: canvas.height });

    const batchManager = CreateBatchManager(scene);
    const al = new CjsWebgpuRenderContextAL({ webgpu, renderTarget });
    al.CreateDevice();
    const renderContext = Tr2RenderContext_GetMainThreadRenderContext();
    renderContext.SetRenderContextAL(al);
    const camera = new OrbitCamera(canvas);
    const options = ReadRenderOptions();
    // Without EVE data the scene is never drawn: initializing it, preparing the device resources or building the render
    // driver (its post process, fog, TAA and distortion) would ask for effect files ResourceBytes refuses (2026-10-24).
    let driver: Maybe<EveSpaceSceneRenderDriver> = null;
    if (!noEveData) {
      scene.Initialize(renderContext);
      // What TriDevice.CreateDevice does once the device is up: prepare every
      // device resource registered before it existed.
      gTriDev.device.PrepareDeviceResources();
      driver = new EveSpaceSceneRenderDriver().SetBatchManager(batchManager);
      driver.SSAO = new Tr2SSAO();
      driver.enableDistortion = true;
      driver.clearColor = [...(this.greenScreen ? GREEN_SCREEN : SPACE_CLEAR_COLOR)];
      driver.scene = scene;
      driver.view = camera.eve.GetViewMatrix();
      driver.projection = camera.eve.GetProjection();
      if (!options.antiAliasing) driver.antiAliasingQuality = EveSpaceSceneRenderDriver.AntiAliasingQuality.Disabled;
    }

    // The client's post process and sun flare (environment.ts), applied to the
    // live scene once they load; the first frames draw without them. A
    // location's star re-dresses them (DressSun).
    CountBackgroundQuads();
    const dresser = new SceneDresser(options);
    this.dresser = dresser;
    if (noEveData) dresser.Off(noEveData);
    else void dresser.Dress(scene, null);

    // Blue's frame clock follows the scene clock, so the runtime's own animations (controllers, lights, the shaders'
    // Time) hold while paused and slow in slow motion (sd-time, sd-runtime → The clocks the runtime reads).
    if (ANIMATION_ON_SCENE_CLOCK) {
      this.animation = new AnimationClock(blue.os.GetActualTime());
      blue.os.frameClock = this.animation;
    }
    const pump = CreateFramePump(gTriDev.device, () => {
      al.SetRenderTarget(0, renderTarget);
      al.SetDepthStencil(null);
      // The scene clock's tick, the same value the Destiny parks were just evolved to (destiny.ts).
      driver?.Execute([renderTarget], null, this.frameNow, this.frameNow, null, renderContext);
    });
    this.parts = { scene, driver, camera, renderTarget, al, pump, context, format };
    // The background effect setValues hydrated above draws black on the GPU (2026-10-22: no location, ?dress=off, or
    // a location whose region nebula is the universe), while one SetNebula swaps in draws. Apply the universe's nebula
    // the same way: a fresh effect, and the env map and low quality paths reloaded through OnModified.
    if (universeValues) {
      const old = scene.backgroundEffect;
      const effect = NebulaEffect(universeValues);
      ApplyNebulaValues(scene, universeValues, effect);
      if (old && old !== effect) old.Destruct();
    }
  }

  /**
   * A time-control jump moved the scene clock (backwards, or far forwards): the update context takes the new time as
   * its last, so the next frame's GetDeltaT is the small step from it and no runtime object sees a negative dt, and the
   * animation clock steps from the landing, not across the jump.
   *
   * @param now - The scene clock after the jump, 100 ns ticks.
   */
  ResetSceneTime(now: number): void {
    this.scene.updateContext.SetTime(now);
    this.frameNow = now;
    this.animation?.Rebase(now);
  }

  /**
   * Draws one frame. The page's animation loop (main.ts) calls it after evolving the Destiny parks to `now`, so the
   * ships' ball curves are sampled on the clock the parks run on.
   *
   * @param timestamp - The animation frame's timestamp, in milliseconds.
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  Frame(timestamp: number, now: number): void {
    this.lastFrameDrawn = false;
    if (this.deviceLost) return;
    this.frameNow = now;
    this.animation?.Frame(now);
    const { camera, renderTarget, pump, al, context, format } = this.Parts();
    try {
      const resized = this.fixedSize ? HoldCanvasSize(this.canvas, this.fixedSize) : FitCanvasSize(this.canvas);
      if (resized) renderTarget.Configure({ width: this.canvas.width, height: this.canvas.height });
      this.presented = null;
      camera.Update(Math.round(timestamp * TICKS_PER_MS));
      // The orbit camera updates underneath a cinematic shot, so its release blend has a live target.
      this.drawn = this.cinematic ? this.free.Apply(camera, this.cinematic, this.Aspect()) : camera.Drawn();
      if (this.eveData.on) {
        // The runtime's batch count is cumulative: this frame's is the difference.
        const batches = al.GetDrawnBatchCount?.() ?? 0;
        pump.Render();
        this.DrawStandIns(camera, context, format, (al.GetDrawnBatchCount?.() ?? 0) - batches);
        this.CheckAnimationClock();
      } else {
        // No EVE data: no runtime frame (it has no shaders to draw with); the stand-in pass draws the whole image.
        this.DrawStandIns(camera, context, format, 0);
      }
      this.capture.AfterFrame(this.presented, this.canvas.width, this.canvas.height, format);
      al.DrainTransitions?.();
      this.lastError = null;
      this.lastFrameDrawn = this.presented != null;
    } catch (error) {
      // A failed frame must not end the loop; the next one may succeed.
      const message = ErrorText(error);
      if (this.lastError !== message) console.error(`frame failed: ${message}\n${(error as Maybe<Error>)?.stack ?? ''}`);
      this.lastError = message;
      this.capture.Fail(error instanceof Error ? error : new Error(message));
    }
    this.fps.frames += 1;
    if (timestamp - this.fps.since >= 1000) {
      this.fps.value = Math.round((this.fps.frames * 1000) / (timestamp - this.fps.since));
      this.fps.frames = 0;
      this.fps.since = timestamp;
    }
  }

  /**
   * Draws the stand-in cubes over the frame just rendered, into its swap-chain image, before the capture reads it. With
   * the green screen on and no batch drawn by the runtime this frame (without EVE's shaders it leaves the image black),
   * the pass clears the image to the green first, cubes or none.
   */
  private DrawStandIns(camera: OrbitCamera, context: GPUCanvasContext, format: GPUTextureFormat, batches: number): void {
    const cubes = this.standIns;
    const backdrop = this.greenScreen && batches === 0 ? GREEN_SCREEN : null;
    if (cubes.length === 0 && !backdrop) return;
    // The wrapped getCurrentTexture records the image as presented, so the capture and an export read it.
    const target = this.presented ?? context.getCurrentTexture();
    this.standInPass ??= new StandInPass(this.device, format);
    this.standInPass.Draw({ target, backdrop, cubes, eye: camera.Eye().position, view: camera.eve.GetViewMatrix().transform, projection: camera.eve.GetProjection().transform });
  }

  /**
   * Once, after the first pump: a runtime that stopped reading blue.os.frameClock leaves its frame time off the clock.
   */
  private CheckAnimationClock(): void {
    if (this.animationChecked || !this.animation) return;
    this.animationChecked = true;
    if (blue.os.GetCurrentFrameTime() !== this.animation.ticks) {
      console.warn('the runtime ignores blue.os.frameClock: its own animations run on real time and keep moving while paused (sd-runtime → The clocks the runtime reads)');
    }
  }
}

/**
 * An orbit camera around a focus point, driven by the pointer: drag to orbit,
 * shift-drag or middle-drag to pan, wheel to zoom.
 */
export class OrbitCamera {
  readonly eve = new EveCamera();
  readonly focus: Vec3 = vec3.create();
  distance = 1000;
  yaw = 45;
  pitch = -15;
  fov = DEFAULT_CAMERA_FOV;
  /**
   * Metres from the origin to the farthest dressed object; the back clip covers it.
   */
  reach = 0;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.Attach(canvas);
  }

  /**
   * The canvas's width / height: what the view draws at, so Fit and Pan agree with the drawing.
   */
  Aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  /**
   * Points the camera; degrees and metres. Omitted fields keep their value.
   */
  Set({ focus, distance, yaw, pitch, fov }: CameraPlacement = {}): void {
    if (focus) vec3.set(this.focus, focus[0], focus[1], focus[2]);
    if (IsFiniteNumber(distance)) this.distance = Math.max(1, distance);
    if (IsFiniteNumber(yaw)) this.yaw = yaw;
    if (IsFiniteNumber(pitch)) this.pitch = Math.max(-89, Math.min(89, pitch));
    if (IsFiniteNumber(fov)) this.fov = fov;
  }

  /**
   * Fits a bounding sphere in view at the current angles: it spans 1 / FIT_MARGIN (87 %) of the view's narrower
   * extent, at the fov just set (not the last frame's projection).
   */
  Fit(center: ArrayLike<number>, radius: number): void {
    this.Set({ focus: center, distance: OrbitFitDistance(radius, this.fov, this.Aspect()) });
  }

  Get(): { focus: number[]; distance: number; yaw: number; pitch: number; fov: number } {
    return { focus: Array.from(this.focus), distance: this.distance, yaw: this.yaw, pitch: this.pitch, fov: this.fov };
  }

  /**
   * The eye in world space, from the view matrix the last frame drew with (the audio listener).
   *
   * @returns Its position, forward and up vectors.
   */
  Eye(): CameraEye {
    const view = this.eve.GetViewMatrix().transform;
    // The view matrix rows are the camera's right, up and back axes in world space; its translation row is the eye
    // in view space, so the eye in world space is minus that row through the axes.
    const right = [view[0], view[4], view[8]];
    const up = [view[1], view[5], view[9]];
    const back = [view[2], view[6], view[10]];
    const position = [0, 1, 2].map((axis) => -(right[axis] * view[12] + up[axis] * view[13] + back[axis] * view[14]));
    return { position, front: back.map((value) => -value), up };
  }

  /**
   * The pose and clip planes EveCamera built last Update: the eye off its view matrix, the look at the focus, the field
   * of view off its projection (the aspect clamp undone, so `fov`).
   */
  Drawn(): DrawnCamera {
    const fov = EveCamera.CalculateFovFromProjection(this.eve.GetProjection().transform) / DEGREES;
    const pose = poseFromViewMatrix(this.eve.GetViewMatrix().transform, this.distance, fov);
    return { ...pose, look: [this.focus[0], this.focus[1], this.focus[2]], near: this.eve.frontClip, far: this.eve.backClip };
  }

  /**
   * Points EveCamera at the orbit for this frame (DriveEveCamera), at the canvas's aspect.
   *
   * @param ticks - The animation frame's time, 100 ns ticks.
   */
  Update(ticks: number): void {
    DriveEveCamera(this.eve, this, ticks, this.Aspect());
  }

  private Attach(canvas: HTMLCanvasElement): void {
    let drag: Maybe<{ x: number; y: number; pan: boolean }> = null;
    canvas.addEventListener('pointerdown', (event) => {
      drag = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.pan) this.Pan(dx, dy, canvas.clientHeight);
      else this.Set({ yaw: this.yaw - dx * 0.3, pitch: this.pitch - dy * 0.3 });
    });
    const end = (event: PointerEvent): void => {
      drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.Set({ distance: this.distance * Math.exp(event.deltaY * 0.001) });
      },
      { passive: false }
    );
  }

  /**
   * Moves the focus in the view plane, scaled so the grab point tracks the pointer.
   */
  private Pan(dx: number, dy: number, height: number): void {
    const view = this.eve.GetViewMatrix().transform;
    const metresPerPixel = PanMetresPerPixel(this.distance, this.fov, this.Aspect(), height);
    // The view matrix rows are the camera's right and up axes in world space.
    const right = [view[0], view[4], view[8]];
    const up = [view[1], view[5], view[9]];
    for (let axis = 0; axis < 3; axis++) this.focus[axis] += (-dx * right[axis] + dy * up[axis]) * metresPerPixel;
  }
}

/**
 * The cinematic camera's drawing half: it writes a pose straight into EveCamera's view and projection (the TriView and
 * TriProjection the render driver reads), after the orbit's Update, so the zoom curve, the ±1.4 rad pitch clamp and
 * the float32 orbit math never touch it. Picking, the audio listener and the planet pass read the same matrices.
 */
export class FreeCamera {
  /**
   * Draws a cinematic frame.
   *
   * @param orbit - The orbit camera, just updated (the release blend's target).
   * @param frame - The cinematic pose, its clip planes and how far to blend toward the orbit.
   * @param aspect - The canvas's width / height.
   * @returns What was drawn.
   */
  Apply(orbit: OrbitCamera, frame: CinemaFrame, aspect: number): DrawnCamera {
    let pose: CameraPose = frame.pose;
    let { near, far } = frame;
    if (frame.toOrbit > 0) {
      const target = orbit.Drawn();
      pose = blendPoses(pose, target, frame.toOrbit);
      near = Math.min(near, target.near);
      far = Math.max(far, target.far);
    }
    const eve = orbit.eve;
    eve.GetViewMatrix().SetTransform(poseViewMatrix(pose));
    const projection = eve.GetProjection();
    EveCamera.CalculateProjectionMatrix(projection.transform, aspect, pose.fov * DEGREES, 0, 0, near, far, projection);
    return { ...pose, near, far };
  }
}

interface CaptureJob {
  copied: boolean;
  readonly promise: Promise<CapturedFrame>;
  resolve(frame: CapturedFrame): void;
  reject(error: unknown): void;
}

/**
 * Captures the next completed frame; one capture in flight at a time.
 */
class FrameCapture {
  private readonly device: GPUDevice;
  private pending: Maybe<CaptureJob> = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Whether a capture waits for the next frame.
   */
  get waiting(): boolean {
    return this.pending != null && !this.pending.copied;
  }

  Request(): Promise<CapturedFrame> {
    if (!this.pending) {
      let resolve!: (frame: CapturedFrame) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<CapturedFrame>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      this.pending = { copied: false, promise, resolve, reject };
    }
    return this.pending.promise;
  }

  Fail(error: Error): void {
    const job = this.pending;
    if (!job || job.copied) return;
    this.pending = null;
    job.reject(error);
  }

  /**
   * Called right after the frame is submitted, before yielding: the canvas texture is still this frame's.
   */
  AfterFrame(texture: Maybe<GPUTexture>, width: number, height: number, format: GPUTextureFormat): void {
    const job = this.pending;
    if (!job || job.copied) return;
    job.copied = true;
    try {
      if (!texture) throw new Error('no rendered frame to capture');
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = this.device.createBuffer({ label: 'frame capture', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
      this.device.queue.submit([encoder.finish()]);
      void this.ReadBack(job, buffer, { width, height, bytesPerRow, bgra: format.startsWith('bgra') });
    } catch (error) {
      this.pending = null;
      job.reject(error);
    }
  }

  private async ReadBack(job: CaptureJob, buffer: GPUBuffer, layout: { width: number; height: number; bytesPerRow: number; bgra: boolean }): Promise<void> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const rgba = PackRows(new Uint8Array(buffer.getMappedRange()), layout);
      job.resolve({ width: layout.width, height: layout.height, rgba });
    } catch (error) {
      job.reject(error);
    } finally {
      buffer.destroy();
      if (this.pending === job) this.pending = null;
    }
  }
}

/**
 * Encodes a captured frame as PNG, box-downscaled to at most `maxWidth` wide.
 *
 * @param maxWidth - The widest image to return.
 * @param frame - The captured frame.
 * @returns The PNG bytes and their size.
 */
export async function EncodePng({ width, height, rgba }: CapturedFrame, maxWidth: number = 1280): Promise<EncodedPng> {
  const factor = Math.max(1, Math.ceil(width / maxWidth));
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const data = factor > 1 ? BoxDownscale(rgba, width, factor, outWidth, outHeight) : rgba;
  const png = await CjsPngFormat.writeAsync({ width: outWidth, height: outHeight, data, origin: 'top-left' });
  return { png, width: outWidth, height: outHeight };
}

/**
 * Averages each `factor` x `factor` block of RGBA pixels into one.
 *
 * @param rgba - The source pixels.
 * @param width - The source width.
 * @param factor - The block size.
 * @param outWidth - The result width.
 * @param outHeight - The result height.
 * @returns The downscaled pixels.
 */
function BoxDownscale(rgba: Uint8Array, width: number, factor: number, outWidth: number, outHeight: number): Uint8Array {
  const data = new Uint8Array(outWidth * outHeight * 4);
  const area = factor * factor;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let sy = 0; sy < factor; sy++) {
          const row = ((y * factor + sy) * width + x * factor) * 4 + channel;
          for (let sx = 0; sx < factor; sx++) sum += rgba[row + sx * 4];
        }
        data[(y * outWidth + x) * 4 + channel] = Math.round(sum / area);
      }
    }
  }
  return data;
}

/**
 * Packs padded readback rows into top-down RGBA, swizzling BGRA, with alpha forced opaque.
 *
 * @param bytes - The mapped readback buffer.
 * @param layout - The frame size, padded row stride and channel order.
 * @returns Tightly packed RGBA.
 */
function PackRows(bytes: Uint8Array, { width, height, bytesPerRow, bgra }: { width: number; height: number; bytesPerRow: number; bgra: boolean }): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = y * bytesPerRow + x * 4;
      const target = (y * width + x) * 4;
      pixels[target] = bytes[source + (bgra ? 2 : 0)];
      pixels[target + 1] = bytes[source + 1];
      pixels[target + 2] = bytes[source + (bgra ? 0 : 2)];
      pixels[target + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Holds the canvas backing store at a fixed size (a movie export's picture).
 *
 * @param canvas - The canvas.
 * @param size - The size in pixels.
 * @returns True when the size changed.
 */
function HoldCanvasSize(canvas: HTMLCanvasElement, size: { readonly width: number; readonly height: number }): boolean {
  const changed = size.width !== canvas.width || size.height !== canvas.height;
  if (changed) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  return changed;
}

/**
 * A movie export's letterbox compositor (sd-export): an output-sized OffscreenCanvas with a WebGPU context on the
 * engine's device, in the canvas's format. Each frame it clears to black and copies the presented picture into its
 * rect (the canvas is configured COPY_SRC), then submits; a VideoFrame of it reads the composite.
 */
class ExportCompositor {
  private canvas: Maybe<OffscreenCanvas> = null;
  private context: Maybe<GPUCanvasContext> = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat
  ) {}

  Compose(source: GPUTexture, output: { readonly width: number; readonly height: number }, picture: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): OffscreenCanvas {
    let { canvas, context } = this;
    if (!canvas || !context || canvas.width !== output.width || canvas.height !== output.height) {
      canvas = new OffscreenCanvas(output.width, output.height);
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('the export compositor has no WebGPU context');
      context.configure({ device: this.device, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST, alphaMode: 'opaque' });
      this.canvas = canvas;
      this.context = context;
    }
    const target = context.getCurrentTexture();
    const encoder = this.device.createCommandEncoder({ label: 'movie export compositor' });
    encoder.beginRenderPass({ label: 'movie export bars', colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
    const width = Math.min(picture.width, source.width, output.width - picture.x);
    const height = Math.min(picture.height, source.height, output.height - picture.y);
    if (width > 0 && height > 0) encoder.copyTextureToTexture({ texture: source }, { texture: target, origin: { x: picture.x, y: picture.y } }, { width, height });
    this.device.queue.submit([encoder.finish()]);
    return canvas;
  }
}

/**
 * Matches the canvas backing size to its CSS size.
 *
 * @param canvas - The canvas.
 * @returns True when the size changed.
 */
function FitCanvasSize(canvas: HTMLCanvasElement): boolean {
  const width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  const changed = width !== canvas.width || height !== canvas.height;
  if (changed) {
    canvas.width = width;
    canvas.height = height;
  }
  return changed;
}

/**
 * Narrows to a finite number.
 *
 * @param value - Anything.
 * @returns True when the value is a finite number.
 */
function IsFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The batch lists Carbon's scene makes (EveSpaceScene.cpp:224-228), each
 * carrying the rendering mode the driver applies to it. `Clear` resets the
 * mode every frame, so it is re-applied there. The quad step collects sprite
 * and spotlight quads between the renderables and finalization.
 *
 * @param scene - The scene whose quads the collector gathers.
 * @returns The initialized batch manager.
 */
function CreateBatchManager(scene: EveSpaceScene): CjsBatchManager {
  const modes: Record<number, number> = {
    [TriBatchType.TRIBATCHTYPE_DECAL]: RenderingMode.RM_DECAL,
    [TriBatchType.TRIBATCHTYPE_TRANSPARENT]: RenderingMode.RM_ALPHA,
    [TriBatchType.TRIBATCHTYPE_ADDITIVE]: RenderingMode.RM_ALPHA_ADDITIVE,
    [TriBatchType.TRIBATCHTYPE_DISTORTION]: RenderingMode.RM_ALPHA_ADDITIVE
  };
  const manager = new CjsBatchManager({
    batchTypes: [TriBatchType.TRIBATCHTYPE_OPAQUE, TriBatchType.TRIBATCHTYPE_DECAL, TriBatchType.TRIBATCHTYPE_TRANSPARENT, TriBatchType.TRIBATCHTYPE_ADDITIVE, TriBatchType.TRIBATCHTYPE_DISTORTION],
    createAccumulator: (batchType) => {
      const accumulator = new TriRenderBatchAccumulator();
      const mode = modes[batchType] ?? RenderingMode.RM_OPAQUE;
      const clear = accumulator.Clear.bind(accumulator);
      accumulator.Clear = (...rest: unknown[]) => {
        const out = clear(...rest);
        accumulator.renderingMode = mode;
        return out;
      };
      accumulator.renderingMode = mode;
      return accumulator;
    }
  });
  manager.RegisterCollector('Tr2QuadRenderer', {
    Collect: (_renderables, batchMap) => {
      const context = scene.updateContext;
      scene.UpdateQuadRenderer(context.GetFrustum(), scene.objects, context.renderContext);
      const quads = Tr2QuadRenderer.Instance();
      quads.GetBatches(TriBatchType.TRIBATCHTYPE_OPAQUE, batchMap.GetAccumulator(TriBatchType.TRIBATCHTYPE_OPAQUE));
      quads.GetBatches(TriBatchType.TRIBATCHTYPE_ADDITIVE, batchMap.GetAccumulator(TriBatchType.TRIBATCHTYPE_ADDITIVE));
    }
  });
  manager.Initialize();
  return manager;
}

/**
 * Runs the draw inside the device's recurring render job: pumping Blue's OS
 * ticks the device, which runs its render jobs, as Carbon's frame does.
 *
 * @param device - The Trinity device.
 * @param draw - The frame's draw.
 * @returns The pump; its Render throws whatever the draw threw.
 */
function CreateFramePump(device: TriDevice, draw: () => void): FramePump {
  const jobs = device.GetRenderJobs() ?? new Tr2RenderJobs();
  const job = new TriRenderJob();
  const step = new TriStepPythonCB();
  let failure: unknown = null;
  step.SetCallback(() => {
    try {
      draw();
    } catch (error) {
      failure = error;
    }
  });
  job.name = 'scene-director';
  job.steps.push(step);
  jobs.recurring.push(job);
  device.SetRenderJobs(jobs);
  blue.os.RegisterForTicks(device, TriDevice.TICK_COOKIE);
  return {
    Render() {
      failure = null;
      blue.os.PumpOS();
      // Reported after the device closes its frame and retires pools.
      if (failure) throw failure;
    }
  };
}

/**
 * Hydrates a universe file's background effect (the nebula) as a fresh Tr2Effect; null when the file has none.
 */
function NebulaEffect(values: CjsModelValues): Maybe<Tr2Effect> {
  const background = values['backgroundEffect'] as Maybe<CjsModelValues>;
  return background ? CjsSchema.from<Tr2Effect>(background._type || 'Tr2Effect', background) : null;
}

/**
 * Applies a universe file's nebula fields to a live scene: the class defaults first, then the file's values, the new
 * background effect, and the env map paths through OnModified so their textures reload.
 */
function ApplyNebulaValues(scene: EveSpaceScene, values: CjsModelValues, effect: Maybe<Tr2Effect>): void {
  scene.backgroundRenderingEnabled = typeof values['backgroundRenderingEnabled'] === 'boolean' ? values['backgroundRenderingEnabled'] : NEBULA_FIELDS.backgroundRenderingEnabled;
  scene.nebulaIntensity = NumberValue(values['nebulaIntensity'], NEBULA_FIELDS.nebulaIntensity);
  scene.reflectionIntensity = NumberValue(values['reflectionIntensity'], NEBULA_FIELDS.reflectionIntensity);
  scene.fogStart = NumberValue(values['fogStart'], NEBULA_FIELDS.fogStart);
  scene.fogEnd = NumberValue(values['fogEnd'], NEBULA_FIELDS.fogEnd);
  scene.ambientColor.set(ColorValue(values['ambientColor']) ?? DEFAULT_AMBIENT_COLOR);
  scene.lowQualityNebulaResPath = StringValue(values['lowQualityNebulaResPath'], NEBULA_FIELDS.lowQualityNebulaResPath);
  scene.OnModified('lowQualityNebulaResPath');
  scene.lowQualityNebulaMixResPath = StringValue(values['lowQualityNebulaMixResPath'], NEBULA_FIELDS.lowQualityNebulaMixResPath);
  scene.OnModified('lowQualityNebulaMixResPath');
  scene.backgroundEffect = effect ?? null;
  for (const field of NEBULA_ENV_MAPS) {
    scene[field] = StringValue(values[field], '');
    scene.OnModified(field);
  }
}

function NumberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function StringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function ColorValue(value: unknown): Maybe<number[]> {
  const list = value != null && typeof value === 'object' && 'length' in value ? Array.from(value as ArrayLike<unknown>) : null;
  return list && list.length >= 3 && list.every((component) => typeof component === 'number') ? [...(list as number[]).slice(0, 4), ...(list.length === 3 ? [1] : [])] : null;
}
