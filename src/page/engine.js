/**
 * The renderer: a WebGPU device, an EveSpaceScene with its render driver, the
 * frame loop, an orbit camera, and frame capture. Ported from the runtime's
 * Oct 3 WebGPU viewer, minus its diagnostics, and holding any number of ships.
 *
 * The scene initializes empty; ships join and leave it through the scene's
 * child list afterwards, which is how the viewer swapped skins on a live scene.
 */

import { ResourceBytes } from "./resources.js";
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
  vec3
} from "./runtime.js";

const DEGREES = Math.PI / 180;

export class Engine
{
  /**
   * Creates the device and an initialized, empty scene, and starts drawing.
   *
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas
   * @param {string} options.universe res:/ path of the EveSpaceScene whose values dress the scene.
   * @returns {Promise<Engine>}
   * @throws {Error} When WebGPU or a suitable adapter is unavailable.
   */
  static async Create({ canvas, universe })
  {
    if (!navigator.gpu) throw new Error("this browser has no WebGPU (navigator.gpu is missing); use a current Chrome or Edge");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU found no adapter; check chrome://gpu");

    // EVE's maps are BC7/BC5; without the feature the reader decodes to RGBA8.
    const features = [ "texture-compression-bc", "texture-compression-bc-sliced-3d", "float32-filterable", "depth-clip-control" ]
      .filter(feature => adapter.features.has(feature));
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
    await engine._Initialize(universe);
    return engine;
  }

  constructor(canvas, adapter, device, features)
  {
    this.canvas = canvas;
    this.adapterInfo = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "unknown adapter";
    this.device = device;
    this.features = features;
    this.universe = null;
    this.ships = new Set();
    this.lastError = null;
    this.deviceLost = null;
    this._capture = new FrameCapture(device);
    this._fps = { frames: 0, since: performance.now(), value: 0 };
    device.lost.then(info =>
    {
      this.deviceLost = `${info.reason}: ${info.message}`;
      this._capture.Fail(new Error(`device lost: ${this.deviceLost}`));
      console.error(`WebGPU device lost: ${this.deviceLost}`);
    });
  }

  async _Initialize(universe)
  {
    const { canvas, device } = this;
    FitCanvasSize(canvas);
    const webgpu = new CjsWebgpuDevice({ device, shaderStage: GPUShaderStage });
    const context = canvas.getContext("webgpu");
    this._format = navigator.gpu.getPreferredCanvasFormat();

    // Remember which swap-chain image the frame went into: asking the context
    // again after the submit can hand back a different one, and the capture
    // then reads a blank image.
    const getCurrentTexture = context.getCurrentTexture.bind(context);
    context.getCurrentTexture = () => (this._presented = getCurrentTexture());

    const scene = new EveSpaceScene();
    if (universe)
    {
      // Applied as values: loading it as an object would run Initialize before the device exists.
      const values = CjsBlackFormat.read(await ResourceBytes(universe), { emit: "json" }).object;
      if (values?._type !== "EveSpaceScene") throw new Error(`${universe} is a ${values?._type}, not an EveSpaceScene`);
      CjsSchema.setValues(scene, values);
      this.universe = universe;
    }
    // The client's dynamic-lights setting (off by default in Carbon); without it
    // attachment lights never reach a shader. The client also turns new bloom off.
    Tr2Renderer.getSettings().SetValue("eveSpaceSceneDynamicLighting", true);
    Tr2Renderer.getSettings().SetValue("newBloom", false);
    try
    {
      scene.gpuParticleSystem = await blue.resMan.LoadObject("res:/fisfx/gpuparticles/system.black");
    }
    catch (error)
    {
      console.warn(`gpu particles unavailable: ${error.message}`);
    }

    // The canvas texture must be copyable for capture. The context is
    // configured once, here; configuring it again destroys the acquired texture.
    this._renderTarget = new CjsWebgpuRenderTarget(webgpu, {
      canvas,
      context,
      format: this._format,
      depthFormat: "depth24plus",
      extraUsage: GPUTextureUsage.COPY_SRC,
      alphaMode: "opaque"
    }).Configure({ width: canvas.width, height: canvas.height });

    const batchManager = CreateBatchManager(scene);
    this._al = new CjsWebgpuRenderContextAL({ webgpu, renderTarget: this._renderTarget });
    this._al.CreateDevice();
    this._renderContext = Tr2RenderContext_GetMainThreadRenderContext();
    this._renderContext.SetRenderContextAL(this._al);
    scene.Initialize(this._renderContext);
    // What TriDevice.CreateDevice does once the device is up: prepare every
    // device resource registered before it existed.
    gTriDev.device.PrepareDeviceResources();

    const driver = new EveSpaceSceneRenderDriver().SetBatchManager(batchManager);
    driver.SSAO = new Tr2SSAO();
    driver.enableDistortion = true;
    driver.clearColor = [ 0.02, 0.03, 0.05, 1 ];
    driver.scene = scene;

    this.camera = new OrbitCamera(canvas);
    driver.view = this.camera.eve.GetViewMatrix();
    driver.projection = this.camera.eve.GetProjection();

    this.scene = scene;
    this.driver = driver;
    this._pump = CreateFramePump(gTriDev.device, () =>
    {
      this._al.SetRenderTarget(0, this._renderTarget);
      this._al.SetDepthStencil(null);
      const now = Math.round(performance.now() * 10000);
      driver.Execute([ this._renderTarget ], null, now, now, null, this._renderContext);
    });
    requestAnimationFrame(timestamp => this._Tick(timestamp));
  }

  /** Adds a hydrated ship to the live scene. */
  AddShip(ship)
  {
    addChild(this.scene, "objects", ship, { listNotify: this.scene });
    this.ships.add(ship);
  }

  /** Removes a ship from the scene; the caller retires its resources. */
  RemoveShip(ship)
  {
    removeChild(this.scene, "objects", ship, { listNotify: this.scene });
    this.ships.delete(ship);
  }

  /** Resolves with the PNG bytes of the next completed frame. */
  Capture()
  {
    return this._capture.Request();
  }

  Stats()
  {
    return {
      adapter: this.adapterInfo,
      features: this.features,
      canvas: [ this.canvas.width, this.canvas.height ],
      fps: this._fps.value,
      drawnBatches: this._al?.GetDrawnBatchCount?.() ?? null,
      lastFrameError: this.lastError,
      deviceLost: this.deviceLost
    };
  }

  _Tick(timestamp)
  {
    if (this.deviceLost) return;
    try
    {
      if (FitCanvasSize(this.canvas)) this._renderTarget.Configure({ width: this.canvas.width, height: this.canvas.height });
      this.camera.Update(timestamp / 1000, this.canvas.width / this.canvas.height);
      this._pump.Render();
      this._capture.AfterFrame(this._presented, this.canvas.width, this.canvas.height, this._format);
      this._al.DrainTransitions?.();
      this.lastError = null;
    }
    catch (error)
    {
      // A failed frame must not end the loop; the next one may succeed.
      if (this.lastError !== error.message) console.error(`frame failed: ${error.message}\n${error.stack ?? ""}`);
      this.lastError = error.message;
      this._capture.Fail(error);
    }
    this._fps.frames += 1;
    if (timestamp - this._fps.since >= 1000)
    {
      this._fps.value = Math.round(this._fps.frames * 1000 / (timestamp - this._fps.since));
      this._fps.frames = 0;
      this._fps.since = timestamp;
    }
    requestAnimationFrame(next => this._Tick(next));
  }
}

/**
 * An orbit camera around a focus point, driven by the pointer: drag to orbit,
 * shift-drag or middle-drag to pan, wheel to zoom.
 */
export class OrbitCamera
{
  constructor(canvas)
  {
    this.eve = new EveCamera();
    this.eve.useExtraTranslation = true;
    this.focus = vec3.create();
    this.distance = 1000;
    this.yaw = 45;
    this.pitch = -15;
    this.fov = 45;
    this._Attach(canvas);
  }

  /** Points the camera; degrees and metres. Omitted fields keep their value. */
  Set({ focus, distance, yaw, pitch, fov } = {})
  {
    if (focus) vec3.set(this.focus, focus[0], focus[1], focus[2]);
    if (Number.isFinite(distance)) this.distance = Math.max(1, distance);
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (Number.isFinite(pitch)) this.pitch = Math.max(-89, Math.min(89, pitch));
    if (Number.isFinite(fov)) this.fov = fov;
  }

  /** Fits a bounding sphere in view at the current angles. */
  Fit(center, radius)
  {
    const half = this.fov * DEGREES / 2;
    this.Set({ focus: center, distance: Math.max(radius, 1) / Math.sin(half) * 1.15 });
  }

  Get()
  {
    return { focus: Array.from(this.focus), distance: this.distance, yaw: this.yaw, pitch: this.pitch, fov: this.fov };
  }

  Update(seconds, aspect)
  {
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

  _Attach(canvas)
  {
    let drag = null;
    canvas.addEventListener("pointerdown", event =>
    {
      drag = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event =>
    {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.pan) this._Pan(dx, dy, canvas.clientHeight);
      else this.Set({ yaw: this.yaw - dx * 0.3, pitch: this.pitch - dy * 0.3 });
    });
    const end = event => { drag = null; canvas.releasePointerCapture?.(event.pointerId); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", event =>
    {
      event.preventDefault();
      this.Set({ distance: this.distance * Math.exp(event.deltaY * 0.001) });
    }, { passive: false });
  }

  /** Moves the focus in the view plane, scaled so the grab point tracks the pointer. */
  _Pan(dx, dy, height)
  {
    const view = this.eve.GetViewMatrix().transform;
    const metresPerPixel = 2 * this.distance * Math.tan(this.fov * DEGREES / 2) / Math.max(1, height);
    // The view matrix rows are the camera's right and up axes in world space.
    const right = [ view[0], view[4], view[8] ];
    const up = [ view[1], view[5], view[9] ];
    for (let axis = 0; axis < 3; axis++) this.focus[axis] += (-dx * right[axis] + dy * up[axis]) * metresPerPixel;
  }
}

/** Captures the next completed frame as PNG; one capture in flight at a time. */
class FrameCapture
{
  constructor(device)
  {
    this._device = device;
    this._pending = null;
  }

  Request()
  {
    if (this._pending) return this._pending.promise;
    const job = { copied: false, buffer: null };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this._pending = job;
    return job.promise;
  }

  Fail(error)
  {
    const job = this._pending;
    if (!job || job.copied) return;
    this._pending = null;
    job.reject(error);
  }

  /** Called right after the frame is submitted, before yielding: the canvas texture is still this frame's. */
  AfterFrame(texture, width, height, format)
  {
    const job = this._pending;
    if (!job || job.copied) return;
    job.copied = true;
    const device = this._device;
    try
    {
      if (!texture) throw new Error("no rendered frame to capture");
      const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const buffer = device.createBuffer({ label: "frame capture", size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      job.buffer = buffer;
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
      device.queue.submit([ encoder.finish() ]);
      (async () =>
      {
        try
        {
          await buffer.mapAsync(GPUMapMode.READ);
          const rgba = PackRows(new Uint8Array(buffer.getMappedRange()), width, height, bytesPerRow, format.startsWith("bgra"));
          job.resolve({ width, height, rgba });
        }
        catch (error) { job.reject(error); }
        finally
        {
          buffer.destroy();
          if (this._pending === job) this._pending = null;
        }
      })();
    }
    catch (error)
    {
      this._pending = null;
      job.reject(error);
    }
  }
}

/**
 * Encodes captured RGBA as PNG, box-downscaled to at most `maxWidth` wide.
 *
 * @returns {Promise<{ png: Uint8Array, width: number, height: number }>}
 */
export async function EncodePng({ width, height, rgba }, maxWidth = 1280)
{
  const factor = Math.max(1, Math.ceil(width / maxWidth));
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  let data = rgba;
  if (factor > 1)
  {
    data = new Uint8Array(outWidth * outHeight * 4);
    const area = factor * factor;
    for (let y = 0; y < outHeight; y++)
    {
      for (let x = 0; x < outWidth; x++)
      {
        for (let channel = 0; channel < 4; channel++)
        {
          let sum = 0;
          for (let sy = 0; sy < factor; sy++)
          {
            const row = ((y * factor + sy) * width + x * factor) * 4 + channel;
            for (let sx = 0; sx < factor; sx++) sum += rgba[row + sx * 4];
          }
          data[(y * outWidth + x) * 4 + channel] = Math.round(sum / area);
        }
      }
    }
  }
  const png = await CjsPngFormat.writeAsync({ width: outWidth, height: outHeight, data, origin: "top-left" });
  return { png: new Uint8Array(png.buffer ?? png), width: outWidth, height: outHeight };
}

/** Packs padded readback rows into top-down RGBA, swizzling BGRA, with alpha forced opaque. */
function PackRows(bytes, width, height, bytesPerRow, bgra)
{
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
  {
    for (let x = 0; x < width; x++)
    {
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

/** Matches the canvas backing size to its CSS size; true when it changed. */
function FitCanvasSize(canvas)
{
  const width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  if (width === canvas.width && height === canvas.height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/**
 * The batch lists Carbon's scene makes (EveSpaceScene.cpp:224-228), each
 * carrying the rendering mode the driver applies to it. `Clear` resets the
 * mode every frame, so it is re-applied there. The quad step collects sprite
 * and spotlight quads between the renderables and finalization.
 */
function CreateBatchManager(scene)
{
  const modes = {
    [TriBatchType.TRIBATCHTYPE_DECAL]: RenderingMode.RM_DECAL,
    [TriBatchType.TRIBATCHTYPE_TRANSPARENT]: RenderingMode.RM_ALPHA,
    [TriBatchType.TRIBATCHTYPE_ADDITIVE]: RenderingMode.RM_ALPHA_ADDITIVE,
    [TriBatchType.TRIBATCHTYPE_DISTORTION]: RenderingMode.RM_ALPHA_ADDITIVE
  };
  const manager = new CjsBatchManager({
    batchTypes: [ TriBatchType.TRIBATCHTYPE_OPAQUE, TriBatchType.TRIBATCHTYPE_DECAL, TriBatchType.TRIBATCHTYPE_TRANSPARENT, TriBatchType.TRIBATCHTYPE_ADDITIVE, TriBatchType.TRIBATCHTYPE_DISTORTION ],
    createAccumulator: batchType =>
    {
      const accumulator = new TriRenderBatchAccumulator();
      const mode = modes[batchType] ?? RenderingMode.RM_OPAQUE;
      const clear = accumulator.Clear.bind(accumulator);
      accumulator.Clear = (...rest) =>
      {
        const out = clear(...rest);
        accumulator.renderingMode = mode;
        return out;
      };
      accumulator.renderingMode = mode;
      return accumulator;
    }
  });
  manager.RegisterCollector("Tr2QuadRenderer", {
    Collect: (_renderables, batchMap) =>
    {
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
 */
function CreateFramePump(device, draw)
{
  const jobs = device.GetRenderJobs() ?? new Tr2RenderJobs();
  const job = new TriRenderJob();
  const step = new TriStepPythonCB();
  let failure = null;
  step.SetCallback(() =>
  {
    try { draw(); }
    catch (error) { failure = error; }
  });
  job.name = "scene-director";
  job.steps.push(step);
  jobs.recurring.push(job);
  device.SetRenderJobs(jobs);
  blue.os.RegisterForTicks(device, TriDevice.TICK_COOKIE);
  return {
    Render()
    {
      failure = null;
      blue.os.PumpOS();
      // Reported after the device closes its frame and retires pools.
      if (failure) throw failure;
    }
  };
}
