/**
 * The tools-core client: resolves the EVE resource build once, then addresses
 * every resource and catalog request to that exact build so one session never
 * mixes files from two builds.
 */

import type { Maybe } from '@dereekb/util';
import { ErrorMessage } from './tool-call';

export const DEFAULT_TOOLS_CORE = 'http://127.0.0.1:5510';

export type SofCatalogKind = 'hulls' | 'factions' | 'races';

export interface ToolsCoreStatus {
  readonly reachable: boolean;
  readonly url: string;
  readonly build: Maybe<string>;
  readonly error?: string;
}

/**
 * The tools-core surface the hub uses; tests stand in a fake.
 */
export interface ToolsCoreApi {
  readonly url: string;
  ResolveBuild(): Promise<string>;
  ResourceUrl(path: string): Promise<string>;
  ResFileIndexUrl(): Promise<string>;
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
  readonly fetch?: typeof fetch;
}

export class ToolsCore implements ToolsCoreApi {
  readonly url: string;
  build: Maybe<string>;
  lastError: Maybe<string> = null;
  private readonly fetchImpl: typeof fetch;
  private resolving: Maybe<Promise<string>> = null;

  constructor({ url = DEFAULT_TOOLS_CORE, build = null, fetch: fetchImpl = globalThis.fetch }: ToolsCoreOptions = {}) {
    this.url = url.replace(/\/+$/u, '');
    this.build = build;
    this.fetchImpl = fetchImpl;
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
   * One SOF catalog list: "hulls", "factions" or "races".
   */
  async SofCatalog(kind: SofCatalogKind): Promise<string[]> {
    const build = await this.ResolveBuild();
    const response = await this.fetchImpl(`${this.url}/eve/${build}/sof/${kind}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`tools-core sof/${kind}: HTTP ${response.status}`);
    return (await response.json()) as string[];
  }

  /**
   * Reachability and the pinned build, never throwing.
   */
  async Status(): Promise<ToolsCoreStatus> {
    try {
      return { reachable: true, url: this.url, build: await this.ResolveBuild() };
    } catch (error) {
      return { reachable: false, url: this.url, build: this.build, error: ErrorMessage(error) };
    }
  }

  private async FetchLatestBuild(): Promise<string> {
    try {
      const response = await this.fetchImpl(`${this.url}/eve/latest/build`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Maybe<{ build?: unknown }>;
      if (!body?.build) throw new Error('no build in the answer');
      this.build = String(body.build);
      this.lastError = null;
      return this.build;
    } catch (error) {
      this.lastError = `tools-core at ${this.url} is not reachable (${ErrorMessage(error)}). Start it with: node bin/cjs-tools-service.js in the tools-core checkout.`;
      throw new Error(this.lastError, { cause: error });
    } finally {
      this.resolving = null;
    }
  }
}
