/**
 * The renderer: a WebGPU device, an EveSpaceScene with its render driver, the
 * frame loop, an orbit camera, and frame capture. Ported from the runtime's
 * Oct 3 WebGPU viewer, minus its diagnostics, and holding any number of ships.
 *
 * The scene initializes empty; ships join and leave it through the scene's
 * child list afterwards, which is how the viewer swapped skins on a live scene.
 */

import type { Maybe } from '@dereekb/util';
import { CountBackgroundQuads, CreateSceneDressing, DressScene, EnvironmentReport, ReadRenderOptions, type SceneDressing, type SceneEnvironmentReport } from './environment';
import { ErrorText, ResourceBytes } from './resources';
import {
  addChild,
  blue,
  CjsBatchManager,
  CjsBlackFormat,
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
  type EveShip2,
  type Vec3
} from './runtime';

const DEGREES = Math.PI / 180;

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
}

export interface EngineEnvironment extends SceneEnvironmentReport {
  readonly universe: Maybe<string>;
}

export interface CameraPlacement {
  readonly focus?: ArrayLike<number>;
  readonly distance?: Maybe<number>;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly fov?: number;
}

export interface EngineCreateOptions {
  readonly canvas: HTMLCanvasElement;
  /**
   * res:/ path of the EveSpaceScene whose values dress the scene.
   */
  readonly universe: string;
}

interface EngineParts {
  readonly scene: EveSpaceScene;
  readonly driver: EveSpaceSceneRenderDriver;
  readonly camera: OrbitCamera;
  readonly renderTarget: CjsWebgpuRenderTarget;
  readonly al: CjsWebgpuRenderContextAL;
  readonly pump: FramePump;
  readonly format: GPUTextureFormat;
}

interface FramePump {
  Render(): void;
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly adapterInfo: string;
  readonly device: GPUDevice;
  readonly features: GPUFeatureName[];
  readonly ships = new Set<EveShip2>();
  universe: Maybe<string> = null;
  lastError: Maybe<string> = null;
  deviceLost: Maybe<string> = null;
  private readonly capture: FrameCapture;
  private readonly fps = { frames: 0, since: performance.now(), value: 0 };
  private readonly gpuErrors = { count: 0, messages: [] as string[], capped: false };
  private dressing: Maybe<SceneDressing> = null;
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
   * Creates the device and an initialized, empty scene. The page's animation loop draws it through Frame.
   *
   * @param options - The canvas and the universe to dress the scene with.
   * @returns The running engine.
   * @throws {Error} When WebGPU or a suitable adapter is unavailable.
   */
  static async Create({ canvas, universe }: EngineCreateOptions): Promise<Engine> {
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
   * Resolves with the next completed frame.
   */
  Capture(): Promise<CapturedFrame> {
    return this.capture.Request();
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
      gpuErrors: { count: this.gpuErrors.count, messages: [...this.gpuErrors.messages] }
    };
  }

  /**
   * The scene's background and the client dressing, for get_state.
   */
  Environment(): Maybe<EngineEnvironment> {
    const { parts, dressing } = this;
    return parts && dressing ? { universe: this.universe, ...EnvironmentReport(parts.scene, dressing) } : null;
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

    const scene = new EveSpaceScene();
    if (universe) {
      // Applied as values: loading it as an object would run Initialize before the device exists.
      const values = CjsBlackFormat.read(await ResourceBytes(universe), { emit: 'json' }).object;
      if (values?._type !== 'EveSpaceScene') throw new Error(`${universe} is a ${values?._type}, not an EveSpaceScene`);
      CjsSchema.setValues(scene, values);
      this.universe = universe;
    }
    // The client's dynamic-lights setting (off by default in Carbon); without it
    // attachment lights never reach a shader. The client also turns new bloom off.
    Tr2Renderer.getSettings().SetValue('eveSpaceSceneDynamicLighting', true);
    Tr2Renderer.getSettings().SetValue('newBloom', false);
    try {
      scene.gpuParticleSystem = await blue.resMan.LoadObject('res:/fisfx/gpuparticles/system.black');
    } catch (error) {
      console.warn(`gpu particles unavailable: ${ErrorText(error)}`);
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
    scene.Initialize(renderContext);
    // What TriDevice.CreateDevice does once the device is up: prepare every
    // device resource registered before it existed.
    gTriDev.device.PrepareDeviceResources();

    const driver = new EveSpaceSceneRenderDriver().SetBatchManager(batchManager);
    driver.SSAO = new Tr2SSAO();
    driver.enableDistortion = true;
    driver.clearColor = [0.02, 0.03, 0.05, 1];
    driver.scene = scene;

    const camera = new OrbitCamera(canvas);
    driver.view = camera.eve.GetViewMatrix();
    driver.projection = camera.eve.GetProjection();

    // The client's post process and sun flare (environment.ts), applied to the
    // live scene once they load; the first frames draw without them.
    const options = ReadRenderOptions();
    if (!options.antiAliasing) driver.antiAliasingQuality = EveSpaceSceneRenderDriver.AntiAliasingQuality.Disabled;
    CountBackgroundQuads();
    const dressing = CreateSceneDressing(options);
    this.dressing = dressing;
    void DressScene(scene, options, dressing);

    const pump = CreateFramePump(gTriDev.device, () => {
      al.SetRenderTarget(0, renderTarget);
      al.SetDepthStencil(null);
      // The scene clock's tick, the same value the Destiny parks were just evolved to (destiny.ts).
      driver.Execute([renderTarget], null, this.frameNow, this.frameNow, null, renderContext);
    });
    this.parts = { scene, driver, camera, renderTarget, al, pump, format };
  }

  /**
   * Draws one frame. The page's animation loop (main.ts) calls it after evolving the Destiny parks to `now`, so the
   * ships' ball curves are sampled on the clock the parks run on.
   *
   * @param timestamp - The animation frame's timestamp, in milliseconds.
   * @param now - The scene clock, in integer 100 ns ticks.
   */
  Frame(timestamp: number, now: number): void {
    if (this.deviceLost) return;
    this.frameNow = now;
    const { camera, renderTarget, pump, al, format } = this.Parts();
    try {
      if (FitCanvasSize(this.canvas)) renderTarget.Configure({ width: this.canvas.width, height: this.canvas.height });
      camera.Update(timestamp / 1000, this.canvas.width / this.canvas.height);
      pump.Render();
      this.capture.AfterFrame(this.presented, this.canvas.width, this.canvas.height, format);
      al.DrainTransitions?.();
      this.lastError = null;
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
  fov = 45;

  constructor(canvas: HTMLCanvasElement) {
    this.eve.useExtraTranslation = true;
    this.Attach(canvas);
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
   * Fits a bounding sphere in view at the current angles.
   */
  Fit(center: ArrayLike<number>, radius: number): void {
    const half = (this.fov * DEGREES) / 2;
    this.Set({ focus: center, distance: (Math.max(radius, 1) / Math.sin(half)) * 1.15 });
  }

  Get(): { focus: number[]; distance: number; yaw: number; pitch: number; fov: number } {
    return { focus: Array.from(this.focus), distance: this.distance, yaw: this.yaw, pitch: this.pitch, fov: this.fov };
  }

  Update(seconds: number, aspect: number): void {
    const camera = this.eve;
    vec3.copy(camera.extraTranslation, this.focus);
    camera.translationFromParent = this.distance;
    camera.fieldOfView = this.fov * DEGREES;
    // Reversed depth keeps precision with a far back plane.
    camera.frontClip = Math.max(0.5, this.distance * 0.0005);
    camera.backClip = Math.max(1e5, this.distance * 1000);
    camera.SetOrbit(this.yaw * DEGREES, this.pitch * DEGREES);
    camera.Update(seconds, aspect, seconds);
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
    const metresPerPixel = (2 * this.distance * Math.tan((this.fov * DEGREES) / 2)) / Math.max(1, height);
    // The view matrix rows are the camera's right and up axes in world space.
    const right = [view[0], view[4], view[8]];
    const up = [view[1], view[5], view[9]];
    for (let axis = 0; axis < 3; axis++) this.focus[axis] += (-dx * right[axis] + dy * up[axis]) * metresPerPixel;
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
