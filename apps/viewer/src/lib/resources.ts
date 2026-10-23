/**
 * Resource plumbing: every file the runtime asks for is fetched from the hub's
 * /resource proxy (tools-core behind it), and BePaths is composed from the
 * pinned build's resfileindex so SOF can ask whether a texture exists.
 */

import type { Maybe } from '@dereekb/util';
import { DetachObjectRoutes, InAudioDetachScope } from './audio-guard';
import {
  blue,
  BlueResFileSystemRemote,
  CjsBlackFormat,
  type CjsModelValues,
  CjsPngFormat,
  CjsWebgpuFormat,
  ImageIO,
  ObjectResourceExtensions,
  RegisterGeometryResources,
  RegisterObjectResources,
  RegisterShaderResources,
  RegisterSolidColorTexture,
  RegisterTextureArray,
  RegisterTexturePack,
  RegisterTextureResources,
  RemoteFileCache,
  SetEffectPathDefaults,
  TR2SHADERMODEL,
  Tr2Renderer
} from './runtime';

/**
 * The shader tier. `depth` is the highest one, carrying the local lights;
 * `?tier=hi` or `?tier=lo` selects another for comparison.
 */
export const SHADER_TIER = new URLSearchParams(globalThis.location?.search ?? '').get('tier') || 'depth';

const SHADER_MODELS: Record<string, number> = { lo: TR2SHADERMODEL.TR2SM_3_0_LO, hi: TR2SHADERMODEL.TR2SM_3_0_HI };

let configured = false;
let filesKnown = false;
let fileIndex: Maybe<Promise<void>> = null;

/**
 * Fetches one logical resource (with or without `res:/`). The client ships red
 * files compiled, so `.red` is read as its `.black`, as Carbon's file system does.
 *
 * @param path - A res:/ path or a logical path.
 * @returns The file's bytes.
 * @throws {Error} When the hub answers with an error status.
 */
export async function ResourceBytes(path: string): Promise<Uint8Array> {
  const logical = String(path)
    .replace(/^res:\/+/u, '')
    .replace(/\.red$/iu, '.black');
  const response = await fetch(`/resource/${logical}`);
  if (!response.ok) throw new Error(`${logical}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Reads a `.black` file as plain values (the root object), ready for `CjsSchema.from` or `setValues`.
 *
 * @param path - A res:/ path.
 * @returns The file's root values.
 * @throws {Error} When the hub answers with an error status or the file has no root object.
 */
export async function ResourceValues(path: string): Promise<CjsModelValues> {
  const read = CjsBlackFormat.read(await ResourceBytes(path), { emit: 'json' });
  const values = (read.root ?? read).object;
  if (!values) throw new Error(`${path}: no root object`);
  return values;
}

/**
 * Whether BePaths knows the file. Before the index arrives every file counts as present.
 *
 * @param path - A res:/ path.
 * @returns Whether the file exists in the pinned build.
 */
export function FileExists(path: string): boolean {
  return !filesKnown || blue.paths.FileExists(path);
}

/**
 * Starts composing BePaths once.
 *
 * @returns A promise that resolves once BePaths is composed (or composing failed); it never rejects.
 */
export function FilesReady(): Promise<void> {
  fileIndex ??= ComposeBePaths();
  return fileIndex;
}

/**
 * Registers the byte source, resource classes and effect-path defaults once.
 * Effects are requested at their WebGPU paths and translated in memory from the
 * shipped dx11 containers, so no prebuilt shader overlay is needed.
 */
export function ConfigureResources(): void {
  if (configured) return;
  configured = true;

  blue.resMan.Register({
    source: { Read: (path) => ResourceBytes(String(path).replace('graphics/effect.webgpu/', 'graphics/effect.dx11/')) }
  });
  // Format decoding runs on the main thread: simpler to bundle, and fast enough
  // for a handful of ships. Worker loading needs per-format worker bundles.
  blue.resMan.UseWorkerLoading(false);
  // Image files (as opposed to DDS textures) decode through ImageIO, which
  // knows only the codecs the host registers; the post process reads PNGs.
  ImageIO.registerImageHandler(CjsPngFormat);
  RegisterTextureResources(blue.resMan);
  RegisterSolidColorTexture(blue.resMan);
  RegisterTextureArray(blue.resMan);
  RegisterTexturePack(blue.resMan);
  RegisterShaderResources(blue.resMan, { translator: CjsWebgpuFormat });
  RegisterGeometryResources(blue.resMan);
  RegisterObjectResources(blue.resMan);
  // Every object the runtime loads (a controller's child effect, an overlay, an EveChildRef) builds with the audio seams
  // detached, like the page's own SOF builds, so its emitters stay inert (sd-runtime → Audio).
  const detached = DetachObjectRoutes(blue.resMan, ObjectResourceExtensions, InAudioDetachScope);
  const attached = ObjectResourceExtensions.filter((extension) => !detached.includes(extension));
  if (attached.length) console.warn(`object builds attach audio for .${attached.join(', .')}: the runtime's object route changed (re-check on a pin bump)`);
  SetEffectPathDefaults({ platformName: 'webgpu', shaderModel: SHADER_TIER });
  Tr2Renderer.SetShaderModel(SHADER_MODELS[SHADER_TIER] ?? TR2SHADERMODEL.TR2SM_3_0_DEPTH);
  void FilesReady();
}

/**
 * BePaths over the build's resfileindex, registered for existence checks only:
 * SOF's resPathInsert selection asks whether each inserted texture exists, so
 * without it no faction texture insert (navy, pirate...) applies.
 */
async function ComposeBePaths(): Promise<void> {
  const started = performance.now();
  try {
    const response = await fetch('/resfileindex.txt', { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const cache = new RemoteFileCache();
    cache.AddFileIndex(text);
    blue.paths.RegisterFileSystem(new BlueResFileSystemRemote(cache));
    filesKnown = true;
    console.info(`file index: ${text.length} bytes in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    console.warn(`file index unavailable (${ErrorText(error)}); faction texture inserts will not apply`);
  }
}

/**
 * The message of anything thrown.
 *
 * @param error - Whatever was thrown.
 * @returns Its message, or its string form.
 */
export function ErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
