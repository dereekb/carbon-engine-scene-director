/**
 * The hub: one local HTTP + WebSocket server that serves the viewer page,
 * proxies EVE resources from tools-core, and routes tool calls.
 *
 * HTTP routes: /build, /resfileindex.txt, /resource/<path> (tools-core proxies),
 * /ship-stats?dna=&type=&propMod= (the ship_stats answer as JSON), /prop-mod?module= (a prop mod's numbers by type id
 * or EVE name), /map/system?id=&origin=x,y,z (a location's system, celestials relative to the origin, nearest
 * first), /audio/library and /audio/path/<encoded res:/ path> (streaming tools-core audio proxies that forward Range),
 * /health, and the viewer files.
 *
 * Roles on the WebSocket (`/ws`):
 *   page        a viewer tab; it implements the "page" tools and streams its console
 *   controller  another process (an MCP bridge started after this hub) that sends calls
 *
 * Messages are JSON:
 *   -> { type: "hello", role }
 *   hub -> page        { type: "call", id, name, args }
 *   page -> hub        { type: "result", id, ok, value | error }
 *   page -> hub        { type: "log", entries: [{ time, level, message }] }
 *   controller -> hub  { type: "call", id, name, args }
 *   hub -> controller  { type: "result", id, ok, value | error }
 */

import type { Maybe } from '@dereekb/util';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { findTool, MAX_LOCATION_COORDINATE, SceneError, type SceneVector } from '@scene-director/scene';
import { FleetCompositionFileStore } from '../store/composition-files';
import { SceneFileStore } from '../store/scene-files';
import { FleetCompositions } from './fleet-compositions';
import { Locations } from './locations';
import { MapData, type MapDataApi } from './map-data';
import { SavedScenes } from './saved-scenes';
import { ShipData, ShipDataError, type ShipDataApi } from './ship-data';
import { AnswerPropMod, AnswerShipStats } from './ship-stats-tool';
import { ErrorMessage, ErrorToJson, ToolError, type SerializedError, type ToolArgs, type ToolCaller } from './tool-call';
import { ToolsCore, type SofCatalogKind, type ToolsCoreApi } from './tools-core';

export const DEFAULT_PORT = 5520;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};
const LOG_LIMIT = 2000;
/**
 * Building ships fetches many files on first use, so scene edits get a long deadline.
 */
const SLOW_TOOLS = new Set(['load_scene', 'open_scene', 'patch_scene']);
const LOG_LEVEL_RANK: Record<string, number> = { all: 0, info: 0, warn: 1, error: 2 };

export type PageLogLevel = 'info' | 'warn' | 'error';

export interface PageLogEntry {
  readonly time: string;
  readonly level: PageLogLevel;
  readonly message: string;
}

export interface HubOptions {
  readonly host?: string;
  /**
   * 0 picks a free port.
   */
  readonly port?: number;
  readonly toolsCore?: ToolsCoreApi;
  /**
   * The built viewer: a directory holding index.html and the page bundle it loads from /app/.
   */
  readonly viewerDirectory?: Maybe<string>;
  /**
   * Saved scenes on disk; the per-user default directory when omitted.
   */
  readonly scenes?: SceneFileStore;
  /**
   * Saved fleet compositions on disk; the per-user default directory when omitted.
   */
  readonly compositions?: FleetCompositionFileStore;
  /**
   * Hull and prop mod values from tools-core's SDE; read from `toolsCore.url` when omitted.
   */
  readonly shipData?: ShipDataApi;
  /**
   * tools-core's map routes, for the location tools; read from `toolsCore.url` on ShipData's pinned SDE build when omitted.
   */
  readonly mapData?: MapDataApi;
  /**
   * Diagnostics sink; stderr by default, never stdout (MCP owns stdout).
   */
  readonly log?: (line: string) => void;
}

interface PendingCall {
  readonly page: WebSocket;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Any message on the socket; fields are checked where they are read.
 */
interface HubMessage {
  readonly type?: string;
  readonly role?: string;
  readonly id?: number;
  readonly name?: string;
  readonly args?: ToolArgs;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
  readonly entries?: { readonly time?: number; readonly level?: PageLogLevel; readonly message?: unknown }[];
}

/**
 * Writes one diagnostics line to stderr.
 *
 * @param line - The line, without a newline.
 */
export function LogToStderr(line: string): void {
  process.stderr.write(`[scene-director] ${line}\n`);
}

export class Hub implements ToolCaller {
  readonly host: string;
  port: number;
  readonly toolsCore: ToolsCoreApi;
  readonly viewerDirectory: Maybe<string>;
  readonly savedScenes: SavedScenes;
  readonly fleetCompositions: FleetCompositions;
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  readonly locations: Locations;
  private readonly log: (line: string) => void;
  private readonly pages: WebSocket[] = [];
  private readonly pending = new Map<number, PendingCall>();
  private readonly pageLog: PageLogEntry[] = [];
  private nextId = 1;
  private server: Maybe<Server> = null;
  private wss: Maybe<WebSocketServer> = null;

  constructor({ host = '127.0.0.1', port = DEFAULT_PORT, toolsCore = new ToolsCore(), viewerDirectory = null, scenes = new SceneFileStore(), compositions = new FleetCompositionFileStore(), shipData, mapData, log = LogToStderr }: HubOptions = {}) {
    this.host = host;
    this.port = port;
    this.toolsCore = toolsCore;
    this.shipData = shipData ?? new ShipData({ url: toolsCore.url });
    this.mapData = mapData ?? new MapData({ url: toolsCore.url, sdeBuild: () => this.shipData.SdeBuild(), log });
    this.viewerDirectory = viewerDirectory ? path.resolve(viewerDirectory) : null;
    const page = {
      Connected: () => this.pages.length > 0,
      NotConnected: () => this.NotConnected(),
      Call: (name: string, args?: ToolArgs) => this.CallPage(name, args)
    };
    this.savedScenes = new SavedScenes({ files: scenes, page });
    this.fleetCompositions = new FleetCompositions({ files: compositions, shipData: this.shipData, page });
    this.locations = new Locations({ mapData: this.mapData, page });
    this.log = log;
  }

  get url(): string {
    return `http://${this.host}:${this.port}/`;
  }

  /**
   * Starts listening. Rejects with code EADDRINUSE when another hub owns the port.
   */
  async Start(): Promise<this> {
    const server = createServer((request, response) => {
      this.HandleHttp(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`hub error: ${ErrorMessage(error)}`);
      });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname === '/ws') wss.handleUpgrade(request, socket, head, (ws) => this.Accept(ws));
      else socket.destroy();
    });
    this.server = server;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.log(`viewer at ${this.url} (tools-core ${this.toolsCore.url}, saved scenes in ${this.savedScenes.files.directory}, fleet compositions in ${this.fleetCompositions.files.directory})`);
    if (!this.viewerDirectory) this.log('no viewer directory is configured; the page will not be served');
    this.toolsCore.ResolveBuild().then(
      (build) => this.log(`EVE resource build ${build}`),
      (error: unknown) => this.log(ErrorMessage(error))
    );
    return this;
  }

  async Stop(): Promise<void> {
    for (const { reject } of this.pending.values()) reject(new ToolError('the hub is shutting down'));
    this.pending.clear();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    const server = this.server;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  /**
   * Runs one tool: hub tools here, page tools in the most recently connected tab.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The tool's value.
   */
  async Call(name: string, args: ToolArgs = {}): Promise<unknown> {
    const tool = findTool(name);
    if (!tool) throw new ToolError(`unknown tool "${name}"`);
    return tool.where === 'hub' ? this.CallHubTool(name, args) : this.CallPage(name, args);
  }

  /**
   * Sends one call to the most recently connected tab, whoever answers the tool in the list.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The page's value.
   */
  private async CallPage(name: string, args: ToolArgs = {}): Promise<unknown> {
    const page = this.pages.at(-1);
    if (!page) throw this.NotConnected();
    const id = this.nextId++;
    const timeoutMs = SLOW_TOOLS.has(name) ? 600000 : 60000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError(`${name} timed out after ${timeoutMs / 1000}s; see page_log`));
      }, timeoutMs);
      this.pending.set(id, {
        page,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      page.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  private NotConnected(): ToolError {
    return new ToolError(`No viewer tab is connected. Open ${this.url} in Chrome or Edge (WebGPU required), then retry.`);
  }

  private async CallHubTool(name: string, args: ToolArgs): Promise<unknown> {
    const saved = this.savedScenes.Call(name, args) ?? this.fleetCompositions.call(name, args) ?? this.locations.Call(name, args);
    if (saved) return saved;
    switch (name) {
      case 'viewer_status':
        return {
          viewerUrl: this.url,
          connectedTabs: this.pages.length,
          toolsCore: await this.toolsCore.Status(),
          scenesDirectory: this.savedScenes.files.directory,
          fleetsDirectory: this.fleetCompositions.files.directory,
          hint: this.pages.length ? undefined : `Open ${this.url} in Chrome or Edge on this machine.`
        };
      case 'page_log': {
        const limit = Math.min(500, Math.max(1, Number(args['limit']) || 50));
        const minimum = LOG_LEVEL_RANK[String(args['level'] ?? 'all')] ?? 0;
        return this.pageLog.filter((entry) => (LOG_LEVEL_RANK[entry.level] ?? 0) >= minimum).slice(-limit);
      }
      case 'search_hulls': {
        const kind: SofCatalogKind = args['kind'] === 'factions' || args['kind'] === 'races' ? args['kind'] : 'hulls';
        const query = String(args['query'] ?? '').toLowerCase();
        const limit = Math.min(500, Math.max(1, Number(args['limit']) || 50));
        const names = await this.toolsCore.SofCatalog(kind);
        const matches = names.filter((entry) => String(entry).toLowerCase().includes(query));
        return { kind, total: matches.length, names: matches.slice(0, limit) };
      }
      case 'ship_stats':
        return AnswerShipStats(this.shipData, args);
      default:
        throw new ToolError(`hub tool "${name}" has no handler`);
    }
  }

  private Accept(ws: WebSocket): void {
    let role: Maybe<string> = null;
    ws.on('message', (data: RawData) => {
      const message = ParseMessage(data);
      if (!message) return;

      if (message.type === 'hello') {
        role = message.role ?? null;
        if (role === 'page') {
          this.pages.push(ws);
          this.Record('info', `viewer tab connected (${this.pages.length} open)`);
        }
        ws.send(JSON.stringify({ type: 'hello', role, hub: { url: this.url } }));
      } else if (role === 'page' && message.type === 'result') {
        this.Settle(message);
      } else if (role === 'page' && message.type === 'log') {
        for (const entry of message.entries ?? []) this.Record(entry.level, entry.message, entry.time);
      } else if (role === 'controller' && message.type === 'call') {
        this.Call(String(message.name), message.args).then(
          (value) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, value })),
          (error: unknown) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: ErrorToJson(error) }))
        );
      }
    });
    ws.on('close', () => {
      const index = this.pages.indexOf(ws);
      if (index < 0) return;
      this.pages.splice(index, 1);
      this.Record('info', `viewer tab disconnected (${this.pages.length} open)`);
      for (const [id, pending] of this.pending) {
        if (pending.page !== ws) continue;
        this.pending.delete(id);
        pending.reject(new ToolError('the viewer tab closed or reloaded before answering'));
      }
    });
  }

  private Settle(message: HubMessage): void {
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new ToolError(message.error?.message ?? 'the page reported an error', message.error));
  }

  private Record(level: PageLogLevel | undefined, message: unknown, time: number = Date.now()): void {
    this.pageLog.push({ time: new Date(time).toISOString(), level: level ?? 'info', message: String(message) });
    if (this.pageLog.length > LOG_LIMIT) this.pageLog.splice(0, this.pageLog.length - LOG_LIMIT);
  }

  private async HandleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/build') {
      const status = await this.toolsCore.Status();
      response.writeHead(status.reachable ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(status));
    } else if (pathname === '/resfileindex.txt') {
      await this.Proxy(await this.toolsCore.ResFileIndexUrl(), response);
    } else if (pathname.startsWith('/resource/')) {
      await this.Proxy(await this.toolsCore.ResourceUrl(pathname.slice('/resource/'.length)), response);
    } else if (pathname === '/ship-stats') {
      await this.ServeShipStats(url, response);
    } else if (pathname === '/prop-mod') {
      await this.ServePropMod(url, response);
    } else if (pathname === '/audio/library') {
      await this.StreamProxy({ source: () => this.toolsCore.AudioLibraryUrl(), request, response });
    } else if (pathname.startsWith('/audio/path/')) {
      const resPath = pathname.slice('/audio/path/'.length);
      await this.StreamProxy({ source: () => this.toolsCore.AudioPathUrl(resPath), request, response });
    } else if (pathname === '/map/system') {
      await this.ServeMapSystem(url, response);
    } else if (pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, tabs: this.pages.length }));
    } else {
      await this.ServeViewerFile(pathname, response);
    }
  }

  /**
   * The ship_stats answer for the page: dna, type and propMod from the query. Errors map to
   * 400 (bad arguments), 404 (no such hull or module), 409 (ambiguous name) and 503 (no SDE).
   */
  private async ServeShipStats(url: URL, response: ServerResponse): Promise<void> {
    const args: ToolArgs = {};
    for (const key of ['dna', 'type', 'propMod']) {
      const value = url.searchParams.get(key);
      if (value) args[key] = value;
    }
    let status = 200;
    let body: unknown;
    try {
      body = await AnswerShipStats(this.shipData, args);
    } catch (error) {
      status = ShipStatsErrorStatus(error);
      body = { error: ErrorToJson(error), ...(error instanceof ShipDataError ? { failure: error.failure } : {}) };
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  /**
   * A prop mod's numbers for the page: `module` is a type id or an EVE module name. Errors map as /ship-stats does:
   * 400 (no module, or "mwd" / "ab" / "none", which the page sizes itself), 404 (no such module) and 503 (no SDE).
   */
  private async ServePropMod(url: URL, response: ServerResponse): Promise<void> {
    let status = 200;
    let body: unknown;
    try {
      body = await AnswerPropMod(this.shipData, { module: url.searchParams.get('module') ?? undefined });
    } catch (error) {
      status = ShipStatsErrorStatus(error);
      body = { error: ErrorToJson(error), ...(error instanceof ShipDataError ? { failure: error.failure } : {}) };
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  /**
   * A streaming proxy for tools-core's audio: forwards Range and If-None-Match, and answers tools-core's status
   * (200, 206, 304, 404, 416) with its content headers; an unreachable tools-core is a 502. The resource proxy
   * buffers whole bodies and drops Range, which the 32 MB boosters.bnk cannot afford.
   */
  private async StreamProxy(input: { readonly source: () => Promise<string>; readonly request: IncomingMessage; readonly response: ServerResponse }): Promise<void> {
    const { request, response } = input;
    const headers: Record<string, string> = {};
    for (const name of ['range', 'if-none-match']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    let upstream: Response;
    try {
      upstream = await fetch(await input.source(), { headers });
    } catch (error) {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`audio proxy: ${ErrorMessage(error)}`);
      return;
    }
    const forwarded: OutgoingHttpHeaders = { 'cache-control': 'no-store' };
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const value = upstream.headers.get(name);
      if (value != null) forwarded[name] = value;
    }
    response.writeHead(upstream.status, forwarded);
    if (upstream.body) Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>).pipe(response);
    else response.end();
  }

  /**
   * A location's system for the page: `id` (a solar system id) and `origin` (x,y,z system metres, 0,0,0 by default).
   * The hub subtracts the origin in float64, so the page gets origin-relative metres. Errors map as /ship-stats does:
   * 400 (bad arguments), 404 (no such system) and 503 (no SDE).
   */
  private async ServeMapSystem(url: URL, response: ServerResponse): Promise<void> {
    let status = 200;
    let body: unknown;
    try {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id <= 0) throw new ToolError('id must be a solar system id (a positive integer)');
      const parts = (url.searchParams.get('origin') ?? '0,0,0').split(',').map((part) => (part.trim() ? Number(part) : NaN));
      if (parts.length !== 3 || !parts.every((part) => Number.isFinite(part) && Math.abs(part) <= MAX_LOCATION_COORDINATE)) {
        throw new ToolError('origin must be x,y,z: three finite numbers of system metres, within 1e15 m of the star');
      }
      body = await this.locations.SystemAnswer({ system: id, origin: parts as SceneVector });
    } catch (error) {
      status = ShipStatsErrorStatus(error);
      body = { error: ErrorToJson(error), ...(error instanceof ShipDataError ? { failure: error.failure } : {}) };
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  /**
   * `/` and `/index.html` are the page; `/app/<file>` is the bundle beside it. Nothing outside the viewer directory is served.
   */
  private async ServeViewerFile(pathname: string, response: ServerResponse): Promise<void> {
    const directory = this.viewerDirectory;
    let file: Maybe<string> = null;
    if (directory && (pathname === '/' || pathname === '/index.html')) {
      file = path.join(directory, 'index.html');
    } else if (directory && pathname.startsWith('/app/')) {
      const bundled = path.resolve(directory, `.${path.posix.normalize(pathname.slice('/app'.length))}`);
      if (bundled.startsWith(directory + path.sep)) file = bundled;
    }
    const info = file ? await stat(file).catch(() => null) : null;
    if (file && info?.isFile()) {
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store'
      });
      createReadStream(file).pipe(response);
    } else if (file) {
      this.NotFound(response, `${pathname} (run "npx nx build viewer" first)`);
    } else {
      this.NotFound(response, pathname);
    }
  }

  private async Proxy(source: string, response: ServerResponse): Promise<void> {
    let upstream: Response;
    try {
      upstream = await fetch(source);
    } catch (error) {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`resource proxy: ${ErrorMessage(error)}`);
      return;
    }
    if (upstream.ok) {
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store'
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } else {
      // A file the build lacks is a 404 to the page, not a gateway failure.
      response.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' });
      response.end(`resource proxy: ${source} answered ${upstream.status}`);
    }
  }

  private NotFound(response: ServerResponse, what: string): void {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`not found: ${what}`);
  }
}

const SHIP_DATA_FAILURE_STATUS: Record<ShipDataError['failure'], number> = { invalid: 400, 'not-found': 404, ambiguous: 409, unavailable: 503 };

/**
 * The HTTP status for a failed ship stats answer.
 *
 * @param error - Whatever AnswerShipStats threw.
 * @returns 400 for bad arguments, the lookup failure's status, or 500.
 */
function ShipStatsErrorStatus(error: unknown): number {
  let status = 500;
  if (error instanceof ShipDataError) status = SHIP_DATA_FAILURE_STATUS[error.failure];
  else if (error instanceof SceneError || error instanceof ToolError) status = 400;
  return status;
}

/**
 * Parses one socket message; anything that is not a JSON object is ignored.
 *
 * @param data - The raw frame.
 * @returns The message, or null.
 */
export function ParseMessage(data: RawData): Maybe<HubMessage> {
  let message: Maybe<HubMessage> = null;
  try {
    const parsed: unknown = JSON.parse(String(data));
    if (parsed && typeof parsed === 'object') message = parsed as HubMessage;
  } catch {
    message = null;
  }
  return message;
}
