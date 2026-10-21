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
 */

// SOF hull values carry audio classes (AudEmitter and friends); hydrating them
// needs the audio class families registered.
import '@carbonenginejs/runtime/audio';

export { blue, BlueResFileSystemRemote, ITriQuaternionFunction, ITriVectorFunction, RemoteFileCache } from '@carbonenginejs/runtime/blue';
export { addChild, removeChild } from 'runtime-dist/global/blue/children.js';
export { CjsSchema } from '@carbonenginejs/runtime/schema';
export type { CjsModelValues } from '@carbonenginejs/runtime/schema';
export { CjsBatchManager, gTriDev, Tr2QuadRenderer, Tr2Renderer, Tr2RenderContext_GetMainThreadRenderContext, TriDevice, TriRenderBatchAccumulator } from '@carbonenginejs/runtime/trinity/core';
export {
  EveCamera,
  EveChildBehaviorSystem,
  EveChildLineSet,
  EveLensflare,
  EveSpaceScene,
  EveSpaceSceneRenderDriver,
  EveSpherePin,
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
  Tr2SSAO,
  TriFloat
} from '@carbonenginejs/runtime/trinity';
export type { EveShip2 } from '@carbonenginejs/runtime/trinity';
export { Tr2RenderJobs, TriRenderJob, TriStepPythonCB } from '@carbonenginejs/runtime/trinity/renderJob';
export { RenderingMode, TR2SHADERMODEL, TriBatchType } from '@carbonenginejs/runtime/consts/graphics';
export { SetEffectPathDefaults } from '@carbonenginejs/runtime/utils';
export { CjsWebgpuDevice } from '@carbonenginejs/runtime/trinityal/webgpu';
export { CjsWebgpuRenderContextAL, CjsWebgpuRenderTarget } from 'runtime-dist/trinityal/webgpu/internal.js';
export { EveSOF } from '@carbonenginejs/runtime/sof';
export { RegisterGeometryResources, RegisterSolidColorTexture, RegisterTextureArray, RegisterTexturePack, RegisterTextureResources } from '@carbonenginejs/runtime/resource';
export { RegisterObjectResources } from '@carbonenginejs/runtime/resource/object';
export { RegisterShaderResources } from '@carbonenginejs/runtime/resource/shader';
export { default as CjsWebgpuFormat } from '@carbonenginejs/runtime/resource/formats/webgpu';
export { CjsBlackFormat } from '@carbonenginejs/runtime/resource/formats/black';
export { CjsPngFormat } from '@carbonenginejs/runtime/resource/formats/png';
export { ImageIO } from '@carbonenginejs/runtime/resource/imageio';
export { quat } from '@carbonenginejs/runtime/math/quat';
export type { Quat } from '@carbonenginejs/runtime/math/quat';
export { vec3 } from '@carbonenginejs/runtime/math/vec3';
export type { Vec3 } from '@carbonenginejs/runtime/math/vec3';
