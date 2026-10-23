/**
 * Every runtime symbol the page uses, in one place, so a runtime API change has
 * one file to fix. The runtime ships no type declarations; the minimal types
 * for these imports live beside this file in carbonenginejs-runtime.d.ts.
 *
 * Most come from the package's public subpaths. The `runtime-dist/` specifier
 * (resolved by apps/viewer/esbuild.config.mjs) reaches files the package does
 * not export: the WebGPU abstraction-layer context, which the runtime keeps
 * internal by design, and the child-list helpers. Both resolve to the same
 * files the public subpaths load, so there is still one copy of each class.
 *
 * Math, the Blue curve bases and the Destiny server come from runtime-sim.ts,
 * re-exported here; node-tested modules import that file directly.
 */

// SOF hull values carry audio classes (AudEmitter and friends); hydrating them
// needs the audio class families registered, which this import also does.
export { AudEventCurve, CjsAudioMan } from '@carbonenginejs/runtime/audio';
export type { AudEmitter, AudManager, CjsAudioLibraryDocument, CjsAudioMediaProvider, CjsAudioMediaRead, CjsAudioMediaRecord, CjsWebAudioSoundEngine, CjsWebAudioVoice } from '@carbonenginejs/runtime/audio';

export * from './runtime-sim';
export { blue, BlueResFileSystemRemote, RemoteFileCache } from '@carbonenginejs/runtime/blue';
export { addChild, removeChild } from 'runtime-dist/global/blue/children.js';
export { CjsSchema } from '@carbonenginejs/runtime/schema';
export type { CjsModelValues } from '@carbonenginejs/runtime/schema';
export { CjsBatchManager, gTriDev, Tr2QuadRenderer, Tr2Renderer, Tr2RenderContext_GetMainThreadRenderContext, TriDevice, TriRenderBatchAccumulator } from '@carbonenginejs/runtime/trinity/core';
export {
  EveCamera,
  EveChildBehaviorSystem,
  EveChildExplosion,
  EveChildLineSet,
  EveEffectRoot2,
  EveLensflare,
  EveMeshOverlayEffect,
  EveRootTransform,
  EveSpaceScene,
  EveSpaceSceneRenderDriver,
  EveSpherePin,
  EveStretch,
  EveStretch3,
  EveTransform,
  EveTurretFiringFX,
  EveTurretSet,
  EveTurretTarget,
  Tr2CurveLineSet,
  Tr2DirectInstanceData,
  Tr2GrannyPrimitiveSet,
  Tr2ImpostorManager,
  Tr2InstancedMesh,
  Tr2ParticleSystem,
  Tr2PostProcess2,
  Tr2PPDynamicExposureEffect,
  Tr2PPTonemappingEffect,
  Tr2RuntimeInstanceData,
  Tr2RotationAdapter,
  Tr2SSAO,
  Tr2TranslationAdapter,
  TriFloat
} from '@carbonenginejs/runtime/trinity';
export type { EveLocatorSets, EvePlanet, EveShip2, EveSpaceObject2, Tr2Effect, TriCurveSet } from '@carbonenginejs/runtime/trinity';
export { Tr2RenderJobs, TriRenderJob, TriStepPythonCB } from '@carbonenginejs/runtime/trinity/renderJob';
export { RenderingMode, TR2SHADERMODEL, TriBatchType } from '@carbonenginejs/runtime/consts/graphics';
export { SetEffectPathDefaults } from '@carbonenginejs/runtime/utils';
export { CjsWebgpuDevice } from '@carbonenginejs/runtime/trinityal/webgpu';
export { CjsWebgpuRenderContextAL, CjsWebgpuRenderTarget } from 'runtime-dist/trinityal/webgpu/internal.js';
export { EveSOF } from '@carbonenginejs/runtime/sof';
export { RegisterGeometryResources, RegisterSolidColorTexture, RegisterTextureArray, RegisterTexturePack, RegisterTextureResources } from '@carbonenginejs/runtime/resource';
export { ObjectResourceExtensions, RegisterObjectResources } from '@carbonenginejs/runtime/resource/object';
export { RegisterShaderResources } from '@carbonenginejs/runtime/resource/shader';
export { default as CjsWebgpuFormat } from '@carbonenginejs/runtime/resource/formats/webgpu';
export { CjsBlackFormat } from '@carbonenginejs/runtime/resource/formats/black';
export { CjsPngFormat } from '@carbonenginejs/runtime/resource/formats/png';
export { ImageIO } from '@carbonenginejs/runtime/resource/imageio';
