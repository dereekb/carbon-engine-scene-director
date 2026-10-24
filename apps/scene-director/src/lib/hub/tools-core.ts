/**
 * The tools-core client: resolves the EVE resource build once, then addresses
 * every resource and catalog request to that exact build so one session never
 * mixes files from two builds.
 *
 * tools-core may be another machine's, shared through that machine's hub: its HTTPS listener's `/tools-core/`
 * passthrough (hub.ts), with the listener's access token on every request (`token`, sent as a Bearer header).
 */

import type { Maybe } from '@dereekb/util';
import { ErrorMessage } from './tool-call';

export const DEFAULT_TOOLS_CORE = 'http://127.0.0.1:5510';

/**
 * How to get EVE data when tools-core is unreachable: start it, or run without it (no-EVE-data mode).
 */
export const NO_TOOLS_CORE_HINT = 'Start it with: node bin/cjs-tools-service.js in the tools-core checkout, or run the hub with --eve-data off on a machine without EVE data.';

/**
 * The same for another machine's tools-core, shared through its hub (an https URL).
 */
export const SHARED_TOOLS_CORE_HINT = "It is another machine's, shared through that machine's hub: run that hub with --https-port and its tools-core, at a build with the /tools-core/ passthrough (sd-dev-env), or run this hub with --eve-data off.";

/**
 * How long a status probe waits for tools-core.
 */
const STATUS_PROBE_TIMEOUT_MS = 3000;

export type SofCatalogKind = 'hulls' | 'factions' | 'races';

export interface ToolsCoreStatus {
  readonly reachable: boolean;
  readonly url: string;
  readonly build: Maybe<string>;
  /**
   * tools-core's current build, reported only when it moved on from the pinned one (restart the hub to follow it).
   */
  readonly latestBuild?: string;
  readonly error?: string;
}

/**
 * The tools-core surface the hub uses; tests stand in a fake.
 */
export interface ToolsCoreApi {
  readonly url: string;
  /**
   * The fetch every request to tools-core goes through, the hub's proxies and data clients included: it carries the
   * access token of a hub that shares tools-core (`ToolsCoreOptions.token`).
   */
  readonly fetch: typeof fetch;
  ResolveBuild(): Promise<string>;
  ResourceUrl(path: string): Promise<string>;
  ResFileIndexUrl(): Promise<string>;
  AudioLibraryUrl(): Promise<string>;
  AudioPathUrl(path: string): Promise<string>;
  SofCatalog(kind: SofCatalogKind): Promise<string[]>;
  Status(): Promise<ToolsCoreStatus>;
}

export interface ToolsCoreOptions {
  /**
   * tools-core origin.
   */
  readonly url?: string;
  /**
   * Exact build to pin; resolved from `latest` when absent.
   */
  readonly build?: Maybe<string>;
  /**
   * The access token of the hub `url` reaches tools-core through (another machine's `/tools-core/` passthrough),
   * sent as `authorization: Bearer <token>` on every request.
   */
  readonly token?: Maybe<string>;
  readonly fetch?: typeof fetch;
}

/**
 * A fetch that sends a Bearer token with every request.
 *
 * @param fetchImpl - The fetch to wrap.
 * @param token - The access token.
 * @returns The fetch.
 */
export function FetchWithToken(fetchImpl: typeof fetch, token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

export class ToolsCore implements ToolsCoreApi {
  readonly url: string;
  readonly fetch: typeof fetch;
  build: Maybe<string>;
  lastError: Maybe<string> = null;
  private resolving: Maybe<Promise<string>> = null;

  constructor({ url = DEFAULT_TOOLS_CORE, build = null, token = null, fetch: fetchImpl = globalThis.fetch }: ToolsCoreOptions = {}) {
    this.url = url.replace(/\/+$/u, '');
    this.build = build;
    this.fetch = token ? FetchWithToken(fetchImpl, token) : fetchImpl;
  }

  /**
   * Resolves and caches the exact build; retried on the next call after a failure.
   */
  async ResolveBuild(): Promise<string> {
    if (this.build) return this.build;
    this.resolving ??= this.FetchLatestBuild();
    return this.resolving;
  }

  /**
   * The URL of one logical resource path (no `res:/` prefix) in the pinned build.
   */
  async ResourceUrl(path: string): Promise<string> {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/resources/${path.replace(/^\/+/u, '')}`;
  }

  /**
   * The URL of the pinned build's resfileindex, used by the page for file-existence checks.
   */
  async ResFileIndexUrl(): Promise<string> {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/app/resfileindex.txt`;
  }

  /**
   * The URL of the pinned build's prepared audio library (the CjsAudioMan catalog, ~20 MB of JSON).
   */
  async AudioLibraryUrl(): Promise<string> {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/audio/library`;
  }

  /**
   * The URL of one audio file (a sound bank or a media file) by its `res:/` path in the pinned build. It answers
   * byte ranges: the engine stems' media sit inside the 32 MB boosters.bnk.
   */
  async AudioPathUrl(path: string): Promise<string> {
    const build = await this.ResolveBuild();
    return `${this.url}/eve/${build}/audio/path/${encodeURIComponent(path)}`;
  }

  /**
   * One SOF catalog list: "hulls", "factions" or "races".
   */
  async SofCatalog(kind: SofCatalogKind): Promise<string[]> {
    const build = await this.ResolveBuild();
    const response = await this.fetch(`${this.url}/eve/${build}/sof/${kind}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`tools-core sof/${kind}: HTTP ${response.status}`);
    return (await response.json()) as string[];
  }

  /**
   * Reachability and the pinned build, never throwing. Probes tools-core on
   * every call: a build resolved earlier says nothing about whether it is still
   * up. The pinned build is kept either way, so resource URLs never switch
   * builds mid-session.
   */
  async Status(): Promise<ToolsCoreStatus> {
    let status: ToolsCoreStatus;
    try {
      const probed = Boolean(this.build);
      const build = await this.ResolveBuild();
      // Resolving just now was itself the probe.
      const latest = probed ? await this.FetchBuild(STATUS_PROBE_TIMEOUT_MS) : build;
      this.lastError = null;
      status = { reachable: true, url: this.url, build, ...(latest === build ? {} : { latestBuild: latest }) };
    } catch (error) {
      status = { reachable: false, url: this.url, build: this.build, error: this.Unreachable(error).message };
    }
    return status;
  }

  private async FetchLatestBuild(): Promise<string> {
    try {
      this.build = await this.FetchBuild(15000);
      this.lastError = null;
      return this.build;
    } catch (error) {
      throw this.Unreachable(error);
    } finally {
      this.resolving = null;
    }
  }

  /**
   * Tools-core's current build.
   */
  private async FetchBuild(timeoutMs: number): Promise<string> {
    const response = await this.fetch(`${this.url}/eve/latest/build`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) throw new Error('HTTP 401: the hub sharing it refused the access token (--tools-core-token or SCENE_DIRECTOR_TOOLS_CORE_TOKEN; sd-dev-env)');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Maybe<{ build?: unknown }>;
    if (!body?.build) throw new Error('no build in the answer');
    return String(body.build);
  }

  /**
   * Records why tools-core is unreachable, with how to start it.
   */
  private Unreachable(error: unknown): Error {
    // A failed resolve already carries the full message.
    if (error instanceof Error && error.message === this.lastError) return error;
    const hint = this.url.startsWith('https:') ? SHARED_TOOLS_CORE_HINT : NO_TOOLS_CORE_HINT;
    this.lastError = `tools-core at ${this.url} is not reachable (${ErrorMessage(error)}). ${hint}`;
    return new Error(this.lastError, { cause: error });
  }
}
