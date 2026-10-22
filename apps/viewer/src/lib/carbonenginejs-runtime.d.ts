/**
 * Minimal types for the CarbonEngineJS runtime imports in runtime.ts. The
 * runtime ships no declarations, so each module below states only the members
 * the page uses. Add a member here when the page starts using it.
 */

declare module '@carbonenginejs/runtime/math/vec3' {
  /**
   * The runtime allocates vectors as Float32Arrays.
   */
  export type Vec3 = Float32Array;

  export const vec3: {
    create(): Vec3;
    fromValues(x: number, y: number, z: number): Vec3;
    set<T extends ArrayLike<number>>(out: T, x: number, y: number, z: number): T;
    copy<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>): T;
    add<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>, b: ArrayLike<number>): T;
    scale<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>, scale: number): T;
    normalize<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>): T;
    dot(a: ArrayLike<number>, b: ArrayLike<number>): number;
    length(a: ArrayLike<number>): number;
    distance(a: ArrayLike<number>, b: ArrayLike<number>): number;
    transformQuat<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>, q: ArrayLike<number>): T;
  };
}

declare module '@carbonenginejs/runtime/math/quat' {
  export type Quat = Float32Array;

  export const quat: {
    create(): Quat;
    copy<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>): T;
    setAxisAngle<T extends ArrayLike<number>>(out: T, axis: ArrayLike<number>, radians: number): T;
    multiply<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>, b: ArrayLike<number>): T;
    conjugate<T extends ArrayLike<number>>(out: T, a: ArrayLike<number>): T;
    /**
     * Ry(yaw) * Rx(pitch) * Rz(roll), in radians.
     */
    fromYawPitchRoll<T extends ArrayLike<number>>(out: T, yaw: number, pitch: number, roll: number): T;
  };
}

declare module '@carbonenginejs/runtime/blue' {
  import type { Quat } from '@carbonenginejs/runtime/math/quat';
  import type { Vec3 } from '@carbonenginejs/runtime/math/vec3';

  export interface BlueResourceSource {
    Read(path: string): Promise<Uint8Array>;
  }

  export interface BlueResMan {
    Register(options: { readonly source: BlueResourceSource }): unknown;
    UseWorkerLoading(enabled: boolean): void;
    LoadObject(path: string): Promise<unknown>;
  }

  export interface BluePaths {
    FileExists(path: string): boolean;
    RegisterFileSystem(fileSystem: BlueResFileSystemRemote): void;
  }

  export interface BlueOs {
    RegisterForTicks(target: object, cookie: string): void;
    PumpOS(): void;
  }

  export const blue: {
    readonly resMan: BlueResMan;
    readonly paths: BluePaths;
    readonly os: BlueOs;
    /**
     * Every object reachable from `root` (the root itself is not included).
     */
    FindAllReferences(root: object): Map<object, unknown>;
  };

  export class RemoteFileCache {
    AddFileIndex(text: string): void;
  }

  export class BlueResFileSystemRemote {
    constructor(cache: RemoteFileCache);
  }

  /**
   * A vector curve. The base `*__Ticks` methods pass arguments in the opposite
   * order from their own docs, so subclasses override every one they need.
   */
  export class ITriVectorFunction {
    Update__Ticks(time: number, out: Vec3): Vec3;
    GetValueAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDotAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDoubleDotAt__Ticks(time: number, out: Vec3): Vec3;
  }

  /**
   * What a ship's translation curve must answer: an ITriVectorFunction, or a Destiny CjsDestinyClientBall.
   */
  export interface TriVectorCurve {
    Update__Ticks(time: number, out: Vec3): Vec3;
    GetValueAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDotAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDoubleDotAt__Ticks(time: number, out: Vec3): Vec3;
  }

  /**
   * A quaternion curve; see ITriVectorFunction about the `*__Ticks` methods.
   */
  export class ITriQuaternionFunction {
    Update__Ticks(time: number, out: Quat): Quat;
    GetValueAt__Ticks(time: number, out: Quat): Quat;
  }
}

declare module 'runtime-dist/global/blue/children.js' {
  export interface ChildListOptions {
    readonly listNotify?: object;
  }

  export function addChild(parent: object, list: string, child: object, options?: ChildListOptions): void;
  export function removeChild(parent: object, list: string, child: object, options?: ChildListOptions): void;
}

declare module '@carbonenginejs/runtime/schema' {
  /**
   * A model as plain values: a schema type name plus its fields.
   */
  export interface CjsModelValues {
    readonly _type: string;
    readonly [field: string]: unknown;
  }

  export const CjsSchema: {
    /**
     * Hydrates values into a live object of the named type.
     */
    from<T = unknown>(type: string, values: CjsModelValues): T;
    setValues(target: object, values: CjsModelValues): void;
    /**
     * The model as `type` when it is one, else null.
     */
    cast<T>(model: unknown, type: abstract new (...args: never[]) => T): T | null;
  };
}

declare module '@carbonenginejs/runtime/trinity/core' {
  import type { CjsWebgpuRenderContextAL } from 'runtime-dist/trinityal/webgpu/internal.js';
  import type { Tr2RenderJobs } from '@carbonenginejs/runtime/trinity/renderJob';

  /**
   * A registered device resource. Runtime ca8b32652 renamed Destroy() to Destruct(); some have neither.
   */
  export interface DeviceResource {
    Destruct?(managed?: Set<unknown>): void;
    Destroy?(managed?: Set<unknown>): void;
  }

  export class TriDevice {
    static readonly TICK_COOKIE: string;
    static GetResourcesRegistered(): DeviceResource[];
    PrepareDeviceResources(): void;
    GetRenderJobs(): Tr2RenderJobs | null;
    SetRenderJobs(jobs: Tr2RenderJobs): void;
  }

  export const gTriDev: { readonly device: TriDevice };

  export interface Tr2RendererSettings {
    SetValue(name: string, value: unknown): void;
  }

  export class Tr2Renderer {
    static getSettings(): Tr2RendererSettings;
    static SetShaderModel(model: number): void;
    /**
     * Draws a camera-space quad (the nebula) through the blitter; false when it
     * refused (no material, shader, prepared resources or mapped vertex buffer).
     * A plain writable static: the page wraps it to count draws.
     */
    static drawCameraSpaceScreenQuad: (renderContext: Tr2RenderContext, shader: unknown, material: unknown) => boolean;
  }

  export interface Tr2RenderContext {
    SetRenderContextAL(al: CjsWebgpuRenderContextAL): void;
  }

  export function Tr2RenderContext_GetMainThreadRenderContext(): Tr2RenderContext;

  export class TriRenderBatchAccumulator {
    renderingMode: number;
    Clear(...args: unknown[]): unknown;
  }

  export interface BatchMap {
    GetAccumulator(batchType: number): TriRenderBatchAccumulator;
  }

  export interface BatchCollector {
    Collect(renderables: unknown, batchMap: BatchMap): void;
  }

  export interface CjsBatchManagerOptions {
    readonly batchTypes: number[];
    createAccumulator(batchType: number): TriRenderBatchAccumulator;
  }

  export class CjsBatchManager {
    constructor(options: CjsBatchManagerOptions);
    RegisterCollector(name: string, collector: BatchCollector): void;
    Initialize(): void;
  }

  export class Tr2QuadRenderer {
    static Instance(): Tr2QuadRenderer;
    GetBatches(batchType: number, accumulator: TriRenderBatchAccumulator): void;
  }
}

declare module '@carbonenginejs/runtime/trinity/renderJob' {
  export class TriStepPythonCB {
    SetCallback(callback: () => void): void;
  }

  export class TriRenderJob {
    name: string;
    readonly steps: TriStepPythonCB[];
  }

  export class Tr2RenderJobs {
    readonly recurring: TriRenderJob[];
  }
}

declare module '@carbonenginejs/runtime/trinity' {
  import type { ITriQuaternionFunction, TriVectorCurve } from '@carbonenginejs/runtime/blue';
  import type { Quat } from '@carbonenginejs/runtime/math/quat';
  import type { Vec3 } from '@carbonenginejs/runtime/math/vec3';
  import type { CjsBatchManager, DeviceResource, Tr2RenderContext } from '@carbonenginejs/runtime/trinity/core';
  import type { CjsWebgpuRenderTarget } from 'runtime-dist/trinityal/webgpu/internal.js';

  export interface EveViewMatrix {
    /**
     * Column-major 4x4; rows 0-2 of the rotation are the camera's right, up and back axes.
     */
    readonly transform: Float32Array;
  }

  /**
   * The camera's TriProjection.
   */
  export interface EveProjectionMatrix {
    /**
     * Column-major 4x4, as EveCamera.Update last built it: indices 0 and 5 are the near plane's inverse half width and
     * height, Carbon's aspect clamp and the zoom curve's field of view included.
     */
    readonly transform: Float32Array;
  }

  export class EveCamera {
    useExtraTranslation: boolean;
    readonly extraTranslation: Vec3;
    translationFromParent: number;
    fieldOfView: number;
    frontClip: number;
    backClip: number;
    SetOrbit(yaw: number, pitch: number): void;
    Update(time: number, aspect: number, realTime: number): void;
    GetViewMatrix(): EveViewMatrix;
    GetProjection(): EveProjectionMatrix;
  }

  export interface EveUpdateContext {
    readonly renderContext: Tr2RenderContext;
    GetFrustum(): object;
  }

  /**
   * A loaded resource; `state` is CjsResource.State ("empty" ... "prepared", "failed").
   */
  export interface CjsResourceState {
    readonly state: string;
    readonly error: Error | null;
    IsPrepared(): boolean;
    IsFailed(): boolean;
  }

  export interface TriTextureRes extends CjsResourceState {
    /**
     * The GPU format, a DXGI number once decoded.
     */
    readonly format: number | null;
    readonly width: number;
    readonly height: number;
    /**
     * 6 for a cube map.
     */
    readonly arraySize: number;
  }

  /**
   * An effect resource parameter; texture parameters carry a path and a texture.
   */
  export interface TriEffectResourceParameter {
    readonly name: string;
    readonly resourcePath?: string;
    readonly resource?: TriTextureRes | null;
  }

  export interface Tr2Effect {
    readonly effectFilePath: string;
    readonly effectResource: CjsResourceState | null;
    readonly shader: object | null;
    readonly resources: Iterable<TriEffectResourceParameter>;
    Destruct(): void;
  }

  /**
   * A fixed translation: with no child curve it answers `value` (and zero velocity).
   */
  export class Tr2TranslationAdapter implements TriVectorCurve {
    readonly value: Vec3;
    Update__Ticks(time: number, out: Vec3): Vec3;
    GetValueAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDotAt__Ticks(time: number, out: Vec3): Vec3;
    GetValueDoubleDotAt__Ticks(time: number, out: Vec3): Vec3;
  }

  /**
   * A fixed rotation: with no child curve it answers `value`.
   */
  export class Tr2RotationAdapter {
    readonly value: Quat;
    Update__Ticks(time: number, out: Quat): Quat;
    GetValueAt__Ticks(time: number, out: Quat): Quat;
  }

  /**
   * A hydrated SOF object (a station or stargate's EveStation2): placed by its curves.
   */
  export interface EveSpaceObject2 {
    translationCurve: TriVectorCurve | null;
    rotationCurve: (ITriQuaternionFunction | Tr2RotationAdapter) | null;
    readonly boundingSphereCenter: Vec3;
    readonly boundingSphereRadius: number;
    display: boolean;
    StartControllers(): void;
  }

  /**
   * A celestial body drawn in the scene's planet pass (at 1 / 1e6 scale): placed by its translation curve and
   * scaling; `radius` (metres) drives its pixel-size LOD and the sun angle.
   */
  export interface EvePlanet {
    radius: number;
    readonly scaling: Vec3;
    translationCurve: TriVectorCurve | null;
    rotationCurve: (ITriQuaternionFunction | Tr2RotationAdapter) | null;
    display: boolean;
    readonly estimatedPixelDiameter: number;
    SetControllerVariable(name: string, value: number): void;
    StartControllers(): void;
  }

  export class Tr2PPTonemappingEffect {}

  export class Tr2PPDynamicExposureEffect {}

  /**
   * A scene post process: an environment template, or the client's effects alone.
   */
  export class Tr2PostProcess2 {
    readonly tonemapping: Tr2PPTonemappingEffect | null;
    readonly dynamicExposure: Tr2PPDynamicExposureEffect | null;
    SetTonemapping(effect: Tr2PPTonemappingEffect | null): void;
    SetDynamicExposure(effect: Tr2PPDynamicExposureEffect | null): void;
  }

  export class EveLensflare {
    /**
     * Where the flare sits; its direction is the negated position. A translation curve writes it each update.
     */
    readonly position: Vec3;
    translationCurve: TriVectorCurve | null;
    /**
     * Unlinks its controllers and frees its occlusion slots.
     */
    Destruct(): void;
  }

  export class EveSpaceScene {
    readonly objects: object[];
    readonly updateContext: EveUpdateContext;
    gpuParticleSystem: unknown;
    postprocess: Tr2PostProcess2 | null;
    readonly lensflares: EveLensflare[];
    readonly planets: ArrayLike<EvePlanet> & Iterable<EvePlanet>;
    readonly sunDirection: Vec3;
    /**
     * The sun's position curve: Update sets sunDirection from it, and the planet whose translation curve is this same
     * object is the sun disc.
     */
    sunBall: TriVectorCurve | null;
    backgroundRenderingEnabled: boolean;
    display: boolean;
    nebulaIntensity: number;
    backgroundEffect: Tr2Effect | null;
    readonly ambientColor: Float32Array;
    fogStart: number;
    fogEnd: number;
    reflectionIntensity: number;
    envMapResPath: string;
    envMap1ResPath: string;
    envMap2ResPath: string;
    envMap3ResPath: string;
    lowQualityNebulaResPath: string;
    lowQualityNebulaMixResPath: string;
    /**
     * Reloads a changed env map path (and handles the other notify fields).
     */
    OnModified(property: string): boolean;
    Initialize(renderContext: Tr2RenderContext): void;
    UpdateQuadRenderer(frustum: object, objects: object[], renderContext: Tr2RenderContext): void;
  }

  export class Tr2SSAO {}

  export class EveSpaceSceneRenderDriver {
    static readonly AntiAliasingQuality: {
      readonly Disabled: number;
      readonly Low: number;
      readonly Medium: number;
      readonly High: number;
    };
    /**
     * TAA quality; a scene post process turns TAA on at this setting.
     */
    antiAliasingQuality: number;
    SSAO: Tr2SSAO | null;
    enableDistortion: boolean;
    clearColor: number[];
    scene: EveSpaceScene | null;
    view: EveViewMatrix;
    projection: object;
    SetBatchManager(manager: CjsBatchManager): this;
    Execute(renderTargets: CjsWebgpuRenderTarget[], depthStencil: null, time: number, realTime: number, viewport: null, renderContext: Tr2RenderContext): void;
  }

  export class TriFloat {
    value: number;
  }

  /**
   * A ship's booster set: glows, halos, lights and trails.
   */
  export interface EveBoosterSet2 {
    /**
     * m/s: intensity is speed / maxVel (capped at 2); 250 by default for every hull.
     */
    maxVel: number;
    /**
     * 0 to 1: blends the glows, halos and lights to the hull's warp colours.
     */
    warpIntensity: number;
  }

  /**
   * A hydrated ship (CjsSchema.from of SOF values).
   */
  export interface EveShip2 {
    translationCurve: TriVectorCurve | null;
    rotationCurve: (ITriQuaternionFunction & { readonly value?: Quat }) | null;
    readonly boundingSphereCenter: Vec3;
    readonly boundingSphereRadius: number;
    speed: TriFloat | null;
    /**
     * m/s: scales the audio speed parameter (speed / maxSpeed); 0 by default.
     */
    maxSpeed: number;
    readonly boosters: EveBoosterSet2 | null;
    /**
     * The booster set's last intensity, 0 to 2.
     */
    GetBoosterIntensity(): number;
    UpdateBoosters(context: { GetTime(): number; GetDeltaT(): number }): void;
    /**
     * Sampled from the curves by UpdateWorldTransform each frame.
     */
    readonly worldPosition: Vec3;
    readonly worldVelocity: Vec3;
    readonly worldRotation: Quat;
    StartControllers(): void;
    /**
     * Samples the translation and rotation curves at `time` (100 ns ticks).
     */
    UpdateWorldTransform(time: number): boolean;
  }

  /**
   * Ship-owned resource classes the page retires; only their identity and teardown matter here.
   */
  export class Tr2GrannyPrimitiveSet {}
  export class Tr2ParticleSystem {}
  export class Tr2InstancedMesh {}
  export class Tr2RuntimeInstanceData {}
  export class Tr2DirectInstanceData {}
  export class EveChildBehaviorSystem {}
  export class EveChildLineSet {}
  export class Tr2CurveLineSet {}

  /**
   * Owns effects with explicit JavaScript lifetimes but no device registration.
   */
  export class Tr2ImpostorManager {
    readonly _ownedEffects?: Iterable<DeviceResource>;
    readonly effect: DeviceResource | null;
  }

  export class EveSpherePin {
    readonly _ownedEffects?: Iterable<DeviceResource>;
    readonly pinEffect: DeviceResource | null;
    readonly pickEffect: DeviceResource | null;
  }
}

declare module '@carbonenginejs/runtime/consts/graphics' {
  export const RenderingMode: {
    readonly RM_OPAQUE: number;
    readonly RM_DECAL: number;
    readonly RM_ALPHA: number;
    readonly RM_ALPHA_ADDITIVE: number;
  };

  export const TriBatchType: {
    readonly TRIBATCHTYPE_OPAQUE: number;
    readonly TRIBATCHTYPE_DECAL: number;
    readonly TRIBATCHTYPE_TRANSPARENT: number;
    readonly TRIBATCHTYPE_ADDITIVE: number;
    readonly TRIBATCHTYPE_DISTORTION: number;
  };

  export const TR2SHADERMODEL: {
    readonly TR2SM_3_0_LO: number;
    readonly TR2SM_3_0_HI: number;
    readonly TR2SM_3_0_DEPTH: number;
  };
}

declare module '@carbonenginejs/runtime/utils' {
  export function SetEffectPathDefaults(options: { readonly platformName: string; readonly shaderModel: string }): void;
}

declare module '@carbonenginejs/runtime/trinityal/webgpu' {
  export class CjsWebgpuDevice {
    constructor(options: { readonly device: GPUDevice; readonly shaderStage: typeof GPUShaderStage });
  }
}

declare module 'runtime-dist/trinityal/webgpu/internal.js' {
  import type { CjsWebgpuDevice } from '@carbonenginejs/runtime/trinityal/webgpu';

  export interface CjsWebgpuRenderTargetOptions {
    readonly canvas: HTMLCanvasElement;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;
    readonly depthFormat: GPUTextureFormat;
    readonly extraUsage: number;
    readonly alphaMode: GPUCanvasAlphaMode;
  }

  export class CjsWebgpuRenderTarget {
    constructor(webgpu: CjsWebgpuDevice, options: CjsWebgpuRenderTargetOptions);
    Configure(size: { readonly width: number; readonly height: number }): this;
  }

  export class CjsWebgpuRenderContextAL {
    constructor(options: { readonly webgpu: CjsWebgpuDevice; readonly renderTarget: CjsWebgpuRenderTarget });
    CreateDevice(): void;
    SetRenderTarget(index: number, target: CjsWebgpuRenderTarget): void;
    SetDepthStencil(target: null): void;
    GetDrawnBatchCount?(): number;
    DrainTransitions?(): void;
  }
}

declare module '@carbonenginejs/runtime/sof' {
  import type { CjsModelValues } from '@carbonenginejs/runtime/schema';

  export interface EveSofRegisterOptions {
    readonly lazyData: {
      source(path: string): Promise<Uint8Array>;
      exists(path: string): boolean;
    };
    readonly resources: {
      getObject(path: string): Promise<CjsModelValues | null>;
    };
    readonly volumetricTrailPath: string;
  }

  export interface DnaInspection {
    readonly valid: boolean;
    readonly error?: string;
  }

  export class EveSOF {
    Register(options: EveSofRegisterOptions): Promise<this>;
    InitializeAsync(): Promise<unknown>;
    InspectDna(dna: string): Promise<DnaInspection>;
    BuildValuesFromDNAAsync(dna: string): Promise<CjsModelValues>;
    GetBuildDiagnostics(): Promise<unknown[] | null>;
    GetHullData(name: string): Promise<EveSofHullData | null>;
  }

  /**
   * The hull record members the page reads.
   */
  export interface EveSofHullData {
    /**
     * The hull class, for example "frigate" or "battleship".
     */
    readonly category?: string;
    /**
     * [x, y, z, radius] in metres.
     */
    readonly boundingSphere?: ArrayLike<number>;
  }
}

declare module '@carbonenginejs/runtime/resource' {
  import type { BlueResMan } from '@carbonenginejs/runtime/blue';

  export function RegisterGeometryResources(resMan: BlueResMan): void;
  export function RegisterSolidColorTexture(resMan: BlueResMan): void;
  export function RegisterTextureArray(resMan: BlueResMan): void;
  export function RegisterTexturePack(resMan: BlueResMan): void;
  export function RegisterTextureResources(resMan: BlueResMan): void;
}

declare module '@carbonenginejs/runtime/resource/object' {
  import type { BlueResMan } from '@carbonenginejs/runtime/blue';

  export function RegisterObjectResources(resMan: BlueResMan): void;
}

declare module '@carbonenginejs/runtime/resource/shader' {
  import type { BlueResMan } from '@carbonenginejs/runtime/blue';

  export function RegisterShaderResources(resMan: BlueResMan, options: { readonly translator: object }): void;
}

declare module '@carbonenginejs/runtime/resource/imageio' {
  /**
   * Image files (as opposed to DDS textures) decode through the codecs registered here.
   */
  export class ImageIO {
    static registerImageHandler(handler: object): void;
  }
}

declare module '@carbonenginejs/runtime/resource/formats/webgpu' {
  /**
   * Translates dx11 effect containers to WebGPU in memory.
   */
  const CjsWebgpuFormat: object;
  export default CjsWebgpuFormat;
}

declare module '@carbonenginejs/runtime/resource/formats/black' {
  import type { CjsModelValues } from '@carbonenginejs/runtime/schema';

  export interface CjsBlackReadResult {
    readonly object?: CjsModelValues | null;
    readonly root?: { readonly object?: CjsModelValues | null };
  }

  export const CjsBlackFormat: {
    read(bytes: Uint8Array, options: { readonly emit: 'json' }): CjsBlackReadResult;
  };
}

declare module '@carbonenginejs/runtime/resource/formats/png' {
  export interface CjsPngImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array;
    readonly origin: 'top-left';
  }

  export const CjsPngFormat: {
    writeAsync(image: CjsPngImage): Promise<Uint8Array>;
  };
}

/**
 * Registers the audio class families; SOF hull values carry AudEmitter and friends.
 */
declare module '@carbonenginejs/runtime/audio' {}
