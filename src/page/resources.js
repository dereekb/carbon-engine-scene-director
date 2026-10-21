/**
 * Resource plumbing: every file the runtime asks for is fetched from the hub's
 * /resource proxy (tools-core behind it), and BePaths is composed from the
 * pinned build's resfileindex so SOF can ask whether a texture exists.
 */

import {
  blue,
  BlueResFileSystemRemote,
  CjsWebgpuFormat,
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
} from "./runtime.js";

/**
 * The shader tier. `depth` is the highest one, carrying the local lights;
 * `?tier=hi` or `?tier=lo` selects another for comparison.
 */
export const SHADER_TIER = new URLSearchParams(globalThis.location?.search ?? "").get("tier") || "depth";

let configured = false;
let filesKnown = false;
let fileIndex = null;

/**
 * Fetches one logical resource (with or without `res:/`). The client ships red
 * files compiled, so `.red` is read as its `.black`, as Carbon's file system does.
 */
export async function ResourceBytes(path)
{
  const logical = String(path).replace(/^res:\/+/u, "").replace(/\.red$/iu, ".black");
  const response = await fetch(`/resource/${logical}`);
  if (!response.ok) throw new Error(`${logical}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Whether BePaths knows the file. Before the index arrives every file counts as present. */
export function FileExists(path)
{
  return !filesKnown || blue.paths.FileExists(path);
}

/** Resolves once BePaths is composed (or composing failed); never rejects. */
export function FilesReady()
{
  fileIndex ??= ComposeBePaths();
  return fileIndex;
}

/**
 * Registers the byte source, resource classes and effect-path defaults once.
 * Effects are requested at their WebGPU paths and translated in memory from the
 * shipped dx11 containers, so no prebuilt shader overlay is needed.
 */
export function ConfigureResources()
{
  if (configured) return;
  configured = true;

  blue.resMan.Register({
    source: { Read: path => ResourceBytes(String(path).replace("graphics/effect.webgpu/", "graphics/effect.dx11/")) }
  });
  // Format decoding runs on the main thread: simpler to bundle, and fast enough
  // for a handful of ships. Worker loading needs per-format worker bundles.
  blue.resMan.UseWorkerLoading(false);
  RegisterTextureResources(blue.resMan);
  RegisterSolidColorTexture(blue.resMan);
  RegisterTextureArray(blue.resMan);
  RegisterTexturePack(blue.resMan);
  RegisterShaderResources(blue.resMan, { translator: CjsWebgpuFormat });
  RegisterGeometryResources(blue.resMan);
  RegisterObjectResources(blue.resMan);
  SetEffectPathDefaults({ platformName: "webgpu", shaderModel: SHADER_TIER });
  Tr2Renderer.SetShaderModel({ lo: TR2SHADERMODEL.TR2SM_3_0_LO, hi: TR2SHADERMODEL.TR2SM_3_0_HI }[SHADER_TIER] ?? TR2SHADERMODEL.TR2SM_3_0_DEPTH);
  FilesReady();
}

/**
 * BePaths over the build's resfileindex, registered for existence checks only:
 * SOF's resPathInsert selection asks whether each inserted texture exists, so
 * without it no faction texture insert (navy, pirate...) applies.
 */
async function ComposeBePaths()
{
  const started = performance.now();
  try
  {
    const response = await fetch("/resfileindex.txt", { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const cache = new RemoteFileCache();
    cache.AddFileIndex(text);
    blue.paths.RegisterFileSystem(new BlueResFileSystemRemote(cache));
    filesKnown = true;
    console.info(`file index: ${text.length} bytes in ${Math.round(performance.now() - started)} ms`);
  }
  catch (error)
  {
    console.warn(`file index unavailable (${error.message}); faction texture inserts will not apply`);
  }
}
