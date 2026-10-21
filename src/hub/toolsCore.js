/**
 * The tools-core client: resolves the EVE resource build once, then addresses
 * every resource and catalog request to that exact build so one session never
 * mixes files from two builds.
 */

export const DEFAULT_TOOLS_CORE = "http://127.0.0.1:5510";

export class ToolsCore
{
  /**
   * @param {object} [options]
   * @param {string} [options.url] tools-core origin.
   * @param {string|null} [options.build] Exact build to pin; resolved from `latest` when absent.
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ url = DEFAULT_TOOLS_CORE, build = null, fetch: fetchImpl = globalThis.fetch } = {})
  {
    this.url = url.replace(/\/+$/u, "");
    this.build = build;
    this.lastError = null;
    this._fetch = fetchImpl;
    this._resolving = null;
  }

  /** Resolves and caches the exact build; retried on the next call after a failure. */
  async ResolveBuild()
  {
    if (this.build) return this.build;
    this._resolving ??= (async () =>
    {
      try
      {
        const response = await this._fetch(`${this.url}/eve/latest/build`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (!body?.build) throw new Error("no build in the answer");
        this.build = String(body.build);
        this.lastError = null;
        return this.build;
      }
      catch (error)
      {
        this.lastError = `tools-core at ${this.url} is not reachable (${error.message}). Start it with: node bin/cjs-tools-service.js in the tools-core checkout.`;
        throw new Error(this.lastError);
      }
      finally
      {
        this._resolving = null;
      }
    })();
    return this._resolving;
  }

  /** The URL of one logical resource path (no `res:/` prefix) in the pinned build. */
  async ResourceUrl(path)
  {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/resources/${path.replace(/^\/+/u, "")}`;
  }

  /** The URL of the pinned build's resfileindex, used by the page for file-existence checks. */
  async ResFileIndexUrl()
  {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/app/resfileindex.txt`;
  }

  /** One SOF catalog list: "hulls", "factions" or "races". */
  async SofCatalog(kind)
  {
    const build = await this.ResolveBuild();
    const response = await this._fetch(`${this.url}/eve/${build}/sof/${kind}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`tools-core sof/${kind}: HTTP ${response.status}`);
    return response.json();
  }

  /** Reachability and the pinned build, never throwing. */
  async Status()
  {
    try
    {
      return { reachable: true, url: this.url, build: await this.ResolveBuild() };
    }
    catch (error)
    {
      return { reachable: false, url: this.url, build: this.build, error: error.message };
    }
  }
}
