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
    /**
     * Copies a view matrix in (TriView.SetTransform); the cinematic free camera writes its own.
     */
    SetTransform(value: ArrayLike<number>): void;
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
    /**
     * Makes the projection a custom one and copies the matrix into it (TriProjection.CustomProjection).
     */
    CustomProjection(value: ArrayLike<number>): void;
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
    /**
     * Builds Carbon's perspective projection into `out` (above an aspect of 1.6 both half extents shrink by aspect / 1.6)
     * and, given a projection, makes it that custom projection.
     *
     * @param fieldOfView - Vertical, radians.
     */
    static CalculateProjectionMatrix(out: Float32Array, aspectRatio: number, fieldOfView: number, offsetX: number, offsetY: number, front: number, back: number, projection?: EveProjectionMatrix | null): Float32Array;
    /**
     * The vertical field of view, radians, of a projection CalculateProjectionMatrix built (the aspect clamp undone).
     */
    static CalculateFovFromProjection(transform: ArrayLike<number>): number;
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
    /**
     * The distance fog (a Tr2PPFogEffect, not declared here), or null.
     */
    readonly fog: object | null;
    SetTonemapping(effect: Tr2PPTonemappingEffect | null): void;
    SetDynamicExposure(effect: Tr2PPDynamicExposureEffect | null): void;
    /**
     * Installs the fog effect; null clears the slot.
     */
    SetFog(effect: object | null): void;
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
    /**
     * Set by the SOF for animated (skinned) hulls.
     */
    readonly isAnimated: boolean;
    readonly overlayEffects: readonly EveMeshOverlayEffect[];
    AddOverlayEffect(overlay: EveMeshOverlayEffect): void;
    RemoveOverlayEffect(overlay: EveMeshOverlayEffect): void;
    /**
     * The mounted turret sets. Add and remove them with `addChild` / `removeChild` and `{ listNotify: ship }`: the
     * ship's OnListModified then rebuilds the turret positions and registers the set.
     */
    readonly turretSets: readonly EveTurretSet[];
    /**
     * The hull's authored locators (`locator_turret_1a`, ...).
     */
    readonly locators: readonly { GetName(): string }[];
    /**
     * Binds every turret set to its locators (bones preferred on an animated hull, once its geometry has loaded).
     */
    RebuildTurretPositions(): void;
    /**
     * Consecutive classic turret slots with an `a` locator.
     */
    GetTurretLocatorCount(): number;
    readonly animationUpdater: { GetAnimationBoneList(): string[] } | null;
    /**
     * Arms the impact overlay with the remaining shield, armor and hull fractions; no impacts draw before a call.
     */
    SetImpactDamageState(shield: number, armor: number, hull: number, doCreateArmorImpacts?: boolean): void;
  }

  /**
   * A gun's target holder (EveTurretSet.target).
   */
  export class EveTurretTarget {
    /**
     * Sets or (with null) clears the object the set aims at.
     */
    SetTargetable(object: EveSpaceObject2 | EveShip2 | null): boolean;
  }

  /**
   * A turret's firing effect (muzzle flashes, tracers or beams): one per set, loaded by the page (the set stores only
   * its path). Its `play_start` curve set carries audio curves the page cuts.
   */
  export class EveTurretFiringFX {
    startCurveSet: TriCurveSet | null;
    stopCurveSet: TriCurveSet | null;
    sourceObserver: object | null;
    destinationObserver: object | null;
    /**
     * Seconds one burst draws.
     */
    GetFiringDuration(): number;
  }

  /**
   * One fitted weapon's turret models on a hull's locators: a set binds every lettered locator of its slot.
   */
  export class EveTurretSet {
    /**
     * 1-9 for a classic `locator_turret_` set; -1 (the default) mounts nothing.
     */
    slotNumber: number;
    readonly locatorName: string;
    readonly firingEffectResPath: string;
    readonly firingEffect: EveTurretFiringFX | null;
    readonly target: EveTurretTarget;
    /**
     * INVALID 0, DEACTIVE 1, IDLE 2, TARGETING 3, FIRING 4, RELOADING 5.
     */
    state: number;
    isOnline: boolean;
    playMovementSound: boolean;
    turretMovementObserver: object | null;
    SetFiringEffect(effect: EveTurretFiringFX | null): void;
    SetTargetObject(object: EveSpaceObject2 | EveShip2 | null): boolean;
    EnterStateIdle(): void;
    EnterStateTargeting(): void;
    EnterStateFiring(): void;
    EnterStateDeactive(): void;
    EnterStateReloading(): void;
    ForceStateDeactive(): void;
    ForceStateTargeting(): void;
    SetShotMissed(missed: boolean): void;
    /**
     * Turns the set's LOD off and loads its high-detail geometry now.
     */
    FreezeHighDetailLOD(): void;
    StartControllers(): void;
    Destruct(): void;
  }

  /**
   * A named set of curves played together (an effect's `play_start`).
   */
  export interface TriCurveSet {
    readonly curves: readonly object[];
    GetName(): string;
    Play(): void;
    PlayFrom(time: number): void;
    Stop(): void;
    ResetTimeRange(): void;
    IsPlaying(): boolean;
    /**
     * Seconds.
     */
    GetMaxCurveDuration(): number;
  }

  /**
   * A hull overlay (a module's hardener, booster or repair glow): its effects draw over the ship's mesh. Its curve set
   * plays once on load (playOnLoad).
   */
  export class EveMeshOverlayEffect {
    name: string;
    readonly curveSet: TriCurveSet | null;
    display: boolean;
    readonly opaqueEffects: readonly Tr2Effect[];
    readonly decalEffects: readonly Tr2Effect[];
    readonly transparentEffects: readonly Tr2Effect[];
    readonly additiveEffects: readonly Tr2Effect[];
    readonly distortionEffects: readonly Tr2Effect[];
  }

  /**
   * A beam between two points (energy transfer, neut, nos, scram, point): fired by its `play_start` curve set.
   */
  export class EveStretch {
    source: TriVectorCurve | null;
    dest: TriVectorCurve | null;
    /**
     * The stretch's own sounds (a Tr2AudioStretch*): StartFiring triggers them, and controller sound actions find
     * their emitters here.
     */
    audio: object | null;
    stretchAudio: object | null;
    display: boolean;
    readonly curveSets: readonly TriCurveSet[];
    /**
     * Pins the endpoints (a 3-vector source, or a 16-element transform) and marks the stretch -Z forward, the turret
     * muzzle path: a module beam fired this way points away from its target. The loaded `source` / `dest` curves stay
     * and overwrite the ends unless nulled first. The page writes the loaded adapters' `value` instead.
     */
    SetFiringTransform(source: ArrayLike<number>, destination: ArrayLike<number>): void;
    StartFiring(delay?: number): void;
    StopFiring(): void;
    /**
     * Seconds.
     */
    GetCurveDuration(): number;
  }

  /**
   * A remote repair beam (remote armor, shield and hull repair): fired through its controllers' IsFiring variable.
   */
  export class EveStretch3 {
    /**
     * As loaded: Tr2TranslationAdapters. Its stretch modifier keeps the loaded `dest` and samples it at Blue's frame
     * time, so the page writes the adapters' `value` instead of replacing them.
     */
    source: TriVectorCurve | null;
    dest: TriVectorCurve | null;
    /**
     * As on EveStretch.
     */
    audio: object | null;
    stretchAudio: object | null;
    display: boolean;
    readonly sourcePosition: Vec3;
    readonly destinationPosition: Vec3;
    readonly curveSets: readonly TriCurveSet[];
    readonly controllers: readonly { Unlink(): void }[];
    /**
     * Pins both endpoints and drops the `source` / `dest` curves (which drops the stretch modifier as well when the
     * change notifies): the page writes the adapters' `value` instead.
     */
    SetFiringTransform(source: ArrayLike<number>, destination: ArrayLike<number>): void;
    StartFiring(delay?: number): void;
    StopFiring(): void;
    PlayCurveSet(name: string, rangeName?: string): void;
  }

  /**
   * A transform with children, meshes and curve sets (the stasis web's trigger effect).
   */
  export class EveTransform {
    name: string;
    readonly scaling: Vec3;
    readonly children: EveTransform[];
    readonly curveSets: readonly TriCurveSet[];
    display: boolean;
    /**
     * When true, small-on-screen curve sets update at 1 Hz.
     */
    useLodLevel: boolean;
    PlayCurveSet(name: string, rangeName?: string): void;
  }

  /**
   * A scene-level transform placed by its curves, like a ship.
   */
  export class EveRootTransform extends EveTransform {
    translationCurve: TriVectorCurve | null;
    rotationCurve: (ITriQuaternionFunction | Tr2RotationAdapter) | null;
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
    /**
     * Paints a turret set with a SOF faction's turret material (async: it awaits the faction's data).
     */
    SetupTurretMaterialFromFaction(turretSet: object, factionName: string): Promise<void>;
    /**
     * Paints a turret set from a ship DNA's faction.
     */
    SetupTurretMaterialFromDNA(turretSet: object, dna: string): Promise<void>;
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
 * Registers the audio class families (SOF hull values carry AudEmitter and friends), and the audio manager the page
 * plays engine sounds through (audio.ts).
 */
declare module '@carbonenginejs/runtime/audio' {
  /**
   * An audio-library record the manager asks the host to read: a media file or a sound bank, by its res: path.
   */
  export interface CjsAudioMediaRecord {
    readonly resPath?: string;
  }

  export interface CjsAudioReadOptions {
    readonly signal?: AbortSignal;
    /**
     * `media` (an individual file) or `bank` (a whole bank the manager slices).
     */
    readonly kind?: string;
  }

  export interface CjsAudioRangeOptions extends CjsAudioReadOptions {
    readonly offset: number;
    readonly byteLength: number;
  }

  /**
   * What a media read returns: the bytes, and whether they are the whole file (the manager slices a whole bank).
   */
  export interface CjsAudioMediaRead {
    readonly bytes: ArrayBuffer;
    readonly mediaType: string;
    readonly complete: boolean;
    readonly offset?: number;
    readonly byteLength?: number;
  }

  /**
   * The host's media acquisition (CjsAudioMan.SetMediaProvider).
   */
  export interface CjsAudioMediaProvider {
    Read(record: CjsAudioMediaRecord, options: CjsAudioReadOptions): Promise<CjsAudioMediaRead>;
    ReadRange(record: CjsAudioMediaRecord, options: CjsAudioRangeOptions): Promise<CjsAudioMediaRead>;
  }

  /**
   * A complete `carbonenginejs.audioLibrary` document (tools-core's prepared audio library).
   */
  export interface CjsAudioLibraryDocument {
    readonly metadata: {
      /**
       * Sound banks by name.
       */
      readonly SoundBanks: Readonly<Record<string, unknown>>;
      readonly Events: Readonly<Record<string, unknown>>;
    };
  }

  export type CjsWwiseEffectMode = 'strict' | 'approximate-web-audio';

  export interface CjsAudioManOptions {
    readonly mediaProvider?: CjsAudioMediaProvider;
    /**
     * Called on the first Enable; the default creates a global AudioContext.
     */
    readonly createContext?: () => AudioContext;
    /**
     * World units to panner units.
     */
    readonly distanceScale?: number;
    readonly wwiseDynamics?: CjsWwiseEffectMode;
    readonly wwiseDistortion?: CjsWwiseEffectMode;
    readonly wwiseModulation?: CjsWwiseEffectMode;
    readonly wwiseReverb?: CjsWwiseEffectMode;
    readonly wwiseRoomVerb?: CjsWwiseEffectMode;
    readonly wwiseMeterFeedback?: 'strict' | 'omit-telemetry';
    readonly wwiseVoiceLimits?: 'strict' | 'ignore';
  }

  /**
   * A Carbon audio emitter: a game object events play on, at its placement.
   */
  export interface AudEmitter {
    /**
     * Posts an event.
     *
     * @returns Its playing id; 0 when nothing played.
     */
    SendEvent(name: string, bypassPrefix?: boolean): number;
    SetPlacement(front: ArrayLike<number>, top: ArrayLike<number>, position: ArrayLike<number>): number;
    /**
     * A copy of the playing events: playing id to full event name.
     */
    GetPlayingEvents(): Map<number, string>;
    /**
     * Keeps a stopped loop from resuming when the emitter wakes (AudGameObjResource.MarkPlayingIDStoppedByRequest).
     */
    MarkPlayingIDStoppedByRequest(playingID: number): void;
    /**
     * Stops ("stop") or breaks ("break") a playing event, fading out over `fadeOutDuration` ms (default 1000).
     *
     * @returns False when the id is not playing or audio is off.
     */
    ExecuteActionOnPlayingID(playingID: number, action: 'stop' | 'break', fadeOutDuration?: number): boolean;
  }

  /**
   * The manager-owned listener.
   */
  export interface AudListener {
    SetPosition(front: ArrayLike<number>, top: ArrayLike<number>, position: ArrayLike<number>): number;
  }

  /**
   * The host's frame timing, in seconds.
   */
  export interface CjsAudioFrame {
    readonly time: number;
    readonly realTime: number;
    readonly deltaTime: number;
    readonly frame: number;
  }

  /**
   * One playing voice's Web Audio nodes (CjsWebAudioSoundEngine's voice descriptor). A node is null when the voice's
   * route has none.
   */
  export interface CjsWebAudioVoice {
    readonly gain: GainNode | null;
    readonly busGain: GainNode | null;
    readonly busVoiceActionGain: GainNode | null;
    readonly busVoiceGain: GainNode | null;
    readonly source: AudioBufferSourceNode | null;
    readonly lowPassFilter: BiquadFilterNode | null;
    readonly highPassFilter: BiquadFilterNode | null;
  }

  /**
   * The runtime's Web Audio backend (CjsAudioMan.backend), which emitters reach as AudGameObjResource.backend.
   * audio-guard.ts wraps these members on the instance: they are runtime-called names, never rename them.
   */
  export class CjsWebAudioSoundEngine {
    /**
     * @returns The playing id; 0 when nothing played.
     */
    PostEvent(eventID: number | string, gameObjID: number, additionalFlags?: number, emitter?: unknown, eventName?: string): number;
    ExecuteActionOnPlayingID(action: string, playingID: number, fadeOutDuration?: number): boolean;
    SetPosition(gameObjID: number, front: ArrayLike<number>, top: ArrayLike<number>, position: ArrayLike<number>): unknown;
    SeekOnEventPercent(playingID: number, percentToSeek: number): unknown;
    SeekOnEventMs(playingID: number, msToSeek: number): unknown;
    SetListenerPosition(gameObjID: number, front: ArrayLike<number>, top: ArrayLike<number>, position: ArrayLike<number>): unknown;
    SetScalingFactor(gameObjID: number, value: number): unknown;
    SetRTPCValue(rtpcName: string, value: number, gameObjID?: number): unknown;
    SetSwitch(switchGroup: string, switchState: string, gameObjID?: number): unknown;
    /**
     * The per-voice schedulers: each owns its AudioParams and reschedules them on every placement and RTPC refresh.
     */
    _ApplyVoiceGain(voice: CjsWebAudioVoice, smoothDistance?: boolean): void;
    _ApplyVoicePlaybackRate(voice: CjsWebAudioVoice): void;
    _ApplyVoiceFilters(voice: CjsWebAudioVoice): void;
    _ApplyVoiceBusGain(voice: CjsWebAudioVoice): void;
    _ApplyVoiceBusActionGain(voice: CjsWebAudioVoice): void;
    _ApplyVoiceBusRtpcGain(voice: CjsWebAudioVoice): void;
  }

  /**
   * Carbon's audio manager (CjsAudioMan.manager).
   */
  export interface AudManager {
    /**
     * Every registered audio game object (emitters and the listener), a copy.
     */
    GetPrioritizedEmitters(): readonly unknown[];
  }

  export class CjsAudioMan {
    constructor(library: CjsAudioLibraryDocument, options?: CjsAudioManOptions);
    readonly listener: AudListener | null;
    /**
     * The Web Audio backend, once Enable realized it.
     */
    readonly backend: CjsWebAudioSoundEngine | null;
    readonly manager: AudManager | null;
    /**
     * Wires AudGameObjResource's static seams (manager, static data, backend) to this manager: audio objects created
     * while attached register with it. Enable attaches.
     */
    Attach(): unknown;
    /**
     * Clears those seams: audio objects created while detached stay headless.
     */
    Detach(): void;
    /**
     * The AudioContext, once Enable created it.
     */
    readonly context: AudioContext | null;
    /**
     * Attaches, realizes Web Audio and enables audio with the banks; call it from a user gesture.
     *
     * @returns False when no AudioContext could be created.
     */
    Enable(soundBanks?: readonly string[]): boolean;
    /**
     * 0 uninitialized, 1 disabled, 2 enabled.
     */
    GetState(): number;
    CreateEmitter(descriptor?: { readonly name?: string; readonly position?: ArrayLike<number> }): AudEmitter;
    /**
     * Stops and unregisters an emitter.
     */
    ReleaseEmitter(emitter: AudEmitter): boolean;
    /**
     * Drives culling, the Web Audio backend and log flushing, once per frame.
     */
    Process(frame: CjsAudioFrame): unknown;
  }

  /**
   * A curve that posts sound events at its keys' times on its observer's emitter (a firing effect's `PlayTurretFX`).
   * With `length` 0 it never posts.
   */
  export class AudEventCurve {
    length: number;
    keys: object[];
    sourceTriObserver: object | null;
  }
}
