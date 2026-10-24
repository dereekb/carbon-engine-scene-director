/**
 * The hub: one local HTTP + WebSocket server that serves the viewer page,
 * proxies EVE resources from tools-core, and routes tool calls.
 *
 * HTTP routes: /config (what the page reads before it boots: the EVE data mode), /build, /resfileindex.txt,
 * /resource/<path> (tools-core proxies; 503 in no-EVE-data mode),
 * /ship-stats?dna=&type=&propMod= (the ship_stats answer as JSON), /prop-mod?module= (a prop mod's numbers by type id
 * or EVE name), /fit/type?name=&hull= (a fit line's EVE type and slot), /dogma/types?ids= (a DogmaBundle of up to 200
 * types) and /dogma/skills (every published skill's), /weapon?type= (a weapon's graphic: its .black, slot collection and
 * SOF faction), /missile?charge=&launcher= (a missile's EveMissile and impact effect), /map/system?id=&origin=x,y,z (a location's system, celestials relative to the origin, nearest
 * first), /audio/library and /audio/path/<encoded res:/ path> (streaming tools-core audio proxies that forward Range;
 * with an audio cache, ranged reads come from local copies of the banks: audio-cache.ts), /movies/<file> (an exported
 * movie, GET and HEAD with Range: movie-files.ts), /health, and the viewer files.
 *
 * An optional HTTPS listener (https.ts, `--https-port`) serves the same routes and /ws to other devices on the LAN,
 * behind an access token, plus /ca.crt (its CA certificate) without one.
 *
 * Roles on the WebSocket (`/ws`):
 *   page        a viewer tab; it implements the "page" tools and streams its console
 *   controller  another process (an MCP bridge started after this hub) that sends calls
 *
 * Messages are JSON:
 *   -> { type: "hello", role }
 *   hub -> any         { type: "hello", role, hub: { url, eveData } }
 *   hub -> page        { type: "call", id, name, args }
 *   page -> hub        { type: "result", id, ok, value | error }
 *   page -> hub        { type: "log", entries: [{ time, level, message }] }
 *   controller -> hub  { type: "call", id, name, args }
 *   hub -> controller  { type: "result", id, ok, value | error }
 *
 * A movie export or a live recording (export_movie, record_movie: movie-exports.ts) adds, between the page and the hub:
 *   page -> hub        { type: "export", id, kind: "config" | "progress" | "end" | "failed" | "cancelled", ... }
 *   page -> hub        binary: one encoded chunk, "SDX1" + u32 header length + JSON header + bytes (wire.ts)
 *   hub -> page        { type: "export", id, kind: "saved" | "failed", ... }
 */

import type { Maybe } from '@dereekb/util';
import { X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type Duplex, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DEFAULT_EVE_DATA_MODE, type EveDataMode, findTool, isMovieExportMessage, listCameraShots, MAX_LOCATION_COORDINATE, SceneError, type SceneVector } from '@scene-director/scene';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetPersonalityFileStore } from '../store/personality-files';
import { MovieFileStore } from '../store/movie-files';
import { MovieExports } from './movie-exports';
import type { AudioBankCache } from './audio-cache';
import { SceneFileStore } from '../store/scene-files';
import { FleetCompositions } from './fleet-compositions';
import { FleetPersonalities } from './fleet-personalities';
import { Locations } from './locations';
import { Staging } from './staging';
import type { ObjectDataApi } from './object-data';
import { ObjectTools } from './objects';
import type { AsteroidDataApi } from './asteroid-data';
import { AsteroidFieldTools } from './asteroid-fields';
import type { MapDataApi } from './map-data';
import { SavedScenes } from './saved-scenes';
import { ShipDataError, type ShipDataApi } from './ship-data';
import { type DogmaDataApi, MAX_DOGMA_TYPE_IDS } from './dogma-data';
import type { WeaponDataApi } from './weapon-data';
import { EveDataStatusOf, HubEveDataSources } from './eve-data';
import { AdmitHttpsRequest, AdmitHttpsUpgrade, DEFAULT_HTTPS_HOST, DEFAULT_HTTPS_PORT, HTTPS_CA_PATH, HttpsUrls, type HubHttpsOptions } from './https';
import { AnswerPropMod, AnswerShipStats } from './ship-stats-tool';
import { ErrorMessage, ErrorToJson, ToolError, type SerializedError, type ToolArgs, type ToolCaller } from './tool-call';
import type { SofCatalogKind, ToolsCoreApi } from './tools-core';

export const DEFAULT_PORT = 5520;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
/**
 * Where the battle console is served (`--console <dir>`): every path under it, index.html for a route with no file.
 */
const CONSOLE_PREFIX = '/console/';
const LOG_LIMIT = 2000;
/**
 * Building ships fetches many files on first use, so scene edits get a long deadline, and so do document fleet orders
 * (order_fleet anchor, break-off and regroup edit the document as patch_scene does).
 */
const SLOW_TOOLS = new Set(['load_scene', 'open_scene', 'patch_scene', 'order_fleet', 'auto_repair', 'set_immunity', 'timeline', 'time_control', 'movie', 'export_movie', 'record_movie']);
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
  /**
   * Where EVE data comes from: tools-core (the default), or `off` (no-EVE-data mode: the hub never touches tools-core,
   * and `toolsCore` and every data source option below are ignored; eve-data.ts).
   */
  readonly eveData?: EveDataMode;
  readonly toolsCore?: ToolsCoreApi;
  /**
   * The built viewer: a directory holding index.html and the page bundle it loads from /app/.
   */
  readonly viewerDirectory?: Maybe<string>;
  /**
   * The built battle console (`dist/apps/battle-console/browser`), served at /console/; not served when omitted.
   */
  readonly consoleDirectory?: Maybe<string>;
  /**
   * Saved scenes on disk; the per-user default directory when omitted.
   */
  readonly scenes?: SceneFileStore;
  /**
   * Saved fleet compositions on disk; the per-user default directory when omitted.
   */
  readonly compositions?: FleetCompositionFileStore;
  /**
   * Saved fleet personalities on disk; the per-user default directory when omitted.
   */
  readonly personalities?: FleetPersonalityFileStore;
  /**
   * Exported movies on disk (export_movie, served at /movies/<file>); the per-user default directory when omitted.
   */
  readonly movies?: MovieFileStore;
  /**
   * Hull and prop mod values from tools-core's SDE; read from `toolsCore.url` when omitted.
   */
  readonly shipData?: ShipDataApi;
  /**
   * Fit type names and dogma bundles from tools-core's SDE; shares ShipData's client (build pin and cache) when both
   * are defaults.
   */
  readonly dogmaData?: DogmaDataApi;
  /**
   * Weapon graphics from tools-core (`/weapon`); shares ShipData's client when both are defaults.
   */
  readonly weaponData?: WeaponDataApi;
  /**
   * tools-core's map routes, for the location tools; read from `toolsCore.url` on ShipData's pinned SDE build when omitted.
   */
  readonly mapData?: MapDataApi;
  /**
   * EVE object types, for the objects tools (add_objects, search_objects); read from `toolsCore.url` on ShipData's
   * pinned SDE build, and SOF hulls on toolsCore's pinned resource build, when omitted.
   */
  readonly objectData?: ObjectDataApi;
  /**
   * EVE ores and their SOF rock sets, for add_asteroid_field; over `objectData` and ShipData's pinned SDE build when
   * omitted.
   */
  readonly asteroidData?: AsteroidDataApi;
  /**
   * Serves ranged audio reads from local copies of tools-core's banks (audio-cache.ts); without one every read is
   * proxied to tools-core.
   */
  readonly audioCache?: Maybe<AudioBankCache>;
  /**
   * An HTTPS listener for other devices on the LAN, beside the loopback HTTP one (https.ts); none by default.
   */
  readonly https?: Maybe<HubHttpsOptions>;
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
  readonly eveData: EveDataMode;
  readonly toolsCore: ToolsCoreApi;
  readonly viewerDirectory: Maybe<string>;
  readonly consoleDirectory: Maybe<string>;
  readonly savedScenes: SavedScenes;
  readonly fleetCompositions: FleetCompositions;
  readonly fleetPersonalities: FleetPersonalities;
  readonly shipData: ShipDataApi;
  readonly dogmaData: DogmaDataApi;
  readonly weaponData: WeaponDataApi;
  readonly mapData: MapDataApi;
  readonly locations: Locations;
  readonly staging: Staging;
  readonly objectData: ObjectDataApi;
  readonly objects: ObjectTools;
  readonly asteroidData: AsteroidDataApi;
  readonly asteroidFields: AsteroidFieldTools;
  readonly movieExports: MovieExports;
  readonly https: Maybe<HubHttpsOptions>;
  /**
   * The HTTPS listener's port once it listens.
   */
  httpsPort: Maybe<number> = null;
  private readonly log: (line: string) => void;
  private readonly audioCache: Maybe<AudioBankCache>;
  private readonly pages: WebSocket[] = [];
  private readonly pending = new Map<number, PendingCall>();
  private readonly pageLog: PageLogEntry[] = [];
  private nextId = 1;
  private server: Maybe<Server> = null;
  private wss: Maybe<WebSocketServer> = null;
  private httpsServer: Maybe<HttpsServer> = null;

  constructor({
    host = '127.0.0.1',
    port = DEFAULT_PORT,
    eveData = DEFAULT_EVE_DATA_MODE,
    toolsCore,
    viewerDirectory = null,
    consoleDirectory = null,
    scenes = new SceneFileStore(),
    compositions = new FleetCompositionFileStore(),
    personalities = new FleetPersonalityFileStore(),
    movies = new MovieFileStore(),
    shipData,
    dogmaData,
    weaponData,
    mapData,
    objectData,
    asteroidData,
    audioCache = null,
    https = null,
    log = LogToStderr
  }: HubOptions = {}) {
    this.host = host;
    this.port = port;
    this.eveData = eveData;
    const sources = HubEveDataSources({ mode: eveData, toolsCore, shipData, dogmaData, weaponData, mapData, objectData, asteroidData, log });
    this.toolsCore = sources.toolsCore;
    this.shipData = sources.shipData;
    this.dogmaData = sources.dogmaData;
    this.weaponData = sources.weaponData;
    this.mapData = sources.mapData;
    this.objectData = sources.objectData;
    this.asteroidData = sources.asteroidData;
    this.viewerDirectory = viewerDirectory ? path.resolve(viewerDirectory) : null;
    this.consoleDirectory = consoleDirectory ? path.resolve(consoleDirectory) : null;
    const page = {
      Connected: () => this.pages.length > 0,
      NotConnected: () => this.NotConnected(),
      Call: (name: string, args?: ToolArgs) => this.CallPage(name, args)
    };
    this.savedScenes = new SavedScenes({ files: scenes, page });
    this.fleetPersonalities = new FleetPersonalities({ files: personalities, shipData: this.shipData, mapData: this.mapData, page });
    this.fleetCompositions = new FleetCompositions({ files: compositions, shipData: this.shipData, mapData: this.mapData, personalities: this.fleetPersonalities, page });
    this.locations = new Locations({ mapData: this.mapData, page });
    this.staging = new Staging({ shipData: this.shipData, mapData: this.mapData, compositions: this.fleetCompositions, personalities: this.fleetPersonalities, page });
    this.objects = new ObjectTools({ objectData: this.objectData, shipData: this.shipData, mapData: this.mapData, page });
    this.asteroidFields = new AsteroidFieldTools({ asteroidData: this.asteroidData, shipData: this.shipData, mapData: this.mapData, page });
    this.movieExports = new MovieExports({
      files: movies,
      pages: { Newest: () => this.pages.at(-1), NotConnected: () => this.NotConnected(), Call: (name, args, tab) => this.CallPage(name, args, tab) },
      url: () => this.url,
      log
    });
    this.log = log;
    this.audioCache = audioCache;
    this.https = https;
  }

  get url(): string {
    return `http://${this.host}:${this.port}/`;
  }

  /**
   * The HTTPS listener's URLs for another device, once it listens.
   */
  get httpsUrls(): string[] {
    const port = this.httpsPort;
    return this.https && typeof port === 'number' ? HttpsUrls({ host: this.https.host ?? DEFAULT_HTTPS_HOST, port }) : [];
  }

  /**
   * The HTTPS URLs with the access token: what a device opens first.
   */
  get httpsLinks(): string[] {
    const token = this.https?.token ?? '';
    return this.httpsUrls.map((url) => `${url}?token=${token}`);
  }

  /**
   * Starts listening. Rejects with code EADDRINUSE when another hub owns the port.
   */
  async Start(): Promise<this> {
    const handle: RequestListener = (request, response) => {
      this.HandleHttp(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`hub error: ${ErrorMessage(error)}`);
      });
    };
    const server = createServer(handle);
    server.on('upgrade', (request, socket, head) => this.Upgrade(request, socket, head));
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    await Listen(server, this.port, this.host);
    this.port = (server.address() as AddressInfo).port;
    if (this.https) {
      const { host = DEFAULT_HTTPS_HOST, port = DEFAULT_HTTPS_PORT } = this.https;
      try {
        await this.StartHttps(this.https, handle);
      } catch (error) {
        // No EADDRINUSE code: a caller that joins the hub on a busy port must not take this for the HTTP port.
        await this.Stop();
        throw new Error(`the HTTPS listener could not start on ${host}:${port}: ${ErrorMessage(error)}`, { cause: error });
      }
    }
    const stores = `saved scenes in ${this.savedScenes.files.directory}, fleet compositions in ${this.fleetCompositions.files.directory}, fleet personalities in ${this.fleetPersonalities.files.directory}, movies in ${this.movieExports.directory}`;
    const off = this.eveData === 'off';
    const source = off ? 'no EVE data: tools-core is not used' : 'tools-core ' + this.toolsCore.url;
    this.log(`viewer at ${this.url} (${source}; ${stores})`);
    if (!this.viewerDirectory) this.log('no viewer directory is configured; the page will not be served');
    if (this.consoleDirectory) this.log(`battle console at ${this.url}${CONSOLE_PREFIX.slice(1)} (${this.consoleDirectory})`);
    if (this.https) this.log(`HTTPS for other devices at ${this.httpsLinks.join(', ')} (a device trusts ${HTTPS_CA_PATH} once first; sd-dev-env)`);
    if (!off) {
      this.toolsCore.ResolveBuild().then(
        (build) => this.log(`EVE resource build ${build}`),
        (error: unknown) => this.log(ErrorMessage(error))
      );
    }
    return this;
  }

  async Stop(): Promise<void> {
    await this.movieExports.Stop();
    for (const { reject } of this.pending.values()) reject(new ToolError('the hub is shutting down'));
    this.pending.clear();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    const servers = [this.server, this.httpsServer].filter((server): server is Server => !!server?.listening);
    const closed = Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    // Drop the browsers' keep-alive connections too: left open, they keep reaching this stopped hub after a new one took
    // the port, so a tab reloading for the new hub's EVE data mode would read this one's GET /config and reload again.
    for (const server of servers) server.closeAllConnections();
    await closed;
  }

  /**
   * Starts the HTTPS listener: the same routes and /ws as the HTTP one, each request admitted by its token, and
   * HTTPS_CA_PATH without one.
   *
   * @param options - The listener's options.
   * @param handle - The HTTP listener's request handler.
   */
  private async StartHttps(options: HubHttpsOptions, handle: RequestListener): Promise<void> {
    const ca = options.ca ? new X509Certificate(options.ca).raw : null;
    const server = createHttpsServer({ cert: options.cert, key: options.key }, (request, response) => {
      const admission = new URL(request.url ?? '/', 'https://hub').pathname === HTTPS_CA_PATH ? null : AdmitHttpsRequest(options.token, request);
      if (!admission) {
        response.writeHead(ca ? 200 : 404, ca ? { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="scene-director-ca.crt"', 'cache-control': 'no-store' } : { 'content-type': 'text/plain' });
        response.end(ca ?? 'no CA certificate is configured');
      } else if (admission.kind === 'pass') {
        handle(request, response);
      } else if (admission.kind === 'redirect') {
        response.writeHead(302, { location: admission.location, 'set-cookie': admission.cookie, 'cache-control': 'no-store' });
        response.end();
      } else {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('scene-director: this HTTPS listener needs its access token. Open the link the hub printed (https://…/?token=…), or viewer_status.https.links on the hub.\n');
      }
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (AdmitHttpsUpgrade(options.token, request)) this.Upgrade(request, socket, head);
      else socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    });
    this.httpsServer = server;
    await Listen(server, options.port ?? DEFAULT_HTTPS_PORT, options.host ?? DEFAULT_HTTPS_HOST);
    this.httpsPort = (server.address() as AddressInfo).port;
  }

  /**
   * Hands a /ws upgrade to the WebSocket server; any other upgrade is dropped.
   *
   * @param request - The upgrade request.
   * @param socket - Its socket.
   * @param head - The first packet of the upgraded stream.
   */
  private Upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const wss = this.wss;
    if (wss && new URL(request.url ?? '/', 'http://localhost').pathname === '/ws') wss.handleUpgrade(request, socket, head, (ws) => this.Accept(ws));
    else socket.destroy();
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
   * Runs a hub tool a page asked for (`HubLink.Call`: the console staging a scenario on a passed scene). Page tools are
   * refused: the page answers its own through its director, and forwarding them would land in the newest tab instead.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The tool's value.
   */
  private async CallFromPage(name: string, args: ToolArgs = {}): Promise<unknown> {
    const tool = findTool(name);
    if (!tool) throw new ToolError(`unknown tool "${name}"`);
    if (tool.where !== 'hub') throw new ToolError(`"${name}" is a page tool: a page calls its own (ViewerApi.Call), not through the hub`);
    return this.CallHubTool(name, args);
  }

  /**
   * Sends one call to a tab (the most recently connected by default), whoever answers the tool in the list.
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @param target - The tab (a movie export's cancel goes to the export's own); it must still be connected.
   * @returns The page's value.
   */
  private async CallPage(name: string, args: ToolArgs = {}, target?: WebSocket): Promise<unknown> {
    const page = target ?? this.pages.at(-1);
    if (!page) throw this.NotConnected();
    if (!this.pages.includes(page)) throw new ToolError('that viewer tab is no longer connected');
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
    const saved = this.savedScenes.Call(name, args) ?? this.fleetCompositions.call(name, args) ?? this.fleetPersonalities.Call(name, args) ?? this.locations.Call(name, args) ?? this.staging.Call(name, args) ?? this.objects.Call(name, args) ?? this.asteroidFields.Call(name, args) ?? this.movieExports.Call(name, args);
    if (saved) return saved;
    switch (name) {
      case 'list_shots':
        return { shots: listCameraShots() };
      case 'viewer_status':
        return {
          viewerUrl: this.url,
          connectedTabs: this.pages.length,
          eveData: EveDataStatusOf(this.eveData),
          toolsCore: this.eveData === 'off' ? null : await this.toolsCore.Status(),
          scenesDirectory: this.savedScenes.files.directory,
          fleetsDirectory: this.fleetCompositions.files.directory,
          personalitiesDirectory: this.fleetPersonalities.files.directory,
          moviesDirectory: this.movieExports.directory,
          https: this.https ? { urls: this.httpsUrls, links: this.httpsLinks, ca: this.httpsUrls.map((url) => `${url}${HTTPS_CA_PATH.slice(1)}`) } : null,
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
        return AnswerShipStats(this.shipData, args, this.dogmaData);
      default:
        throw new ToolError(`hub tool "${name}" has no handler`);
    }
  }

  private Accept(ws: WebSocket): void {
    let role: Maybe<string> = null;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (role === 'page') this.movieExports.Binary(ws, RawBytes(data));
        return;
      }
      const message = ParseMessage(data);
      if (!message) return;

      if (message.type === 'hello') {
        role = message.role ?? null;
        if (role === 'page') {
          this.pages.push(ws);
          this.Record('info', `viewer tab connected (${this.pages.length} open)`);
        }
        ws.send(JSON.stringify({ type: 'hello', role, hub: { url: this.url, eveData: EveDataStatusOf(this.eveData) } }));
      } else if (role === 'page' && message.type === 'result') {
        this.Settle(message);
      } else if (role === 'page' && isMovieExportMessage(message)) {
        this.movieExports.Message(ws, message as unknown as Record<string, unknown>);
      } else if (role === 'page' && message.type === 'log') {
        for (const entry of message.entries ?? []) this.Record(entry.level, entry.message, entry.time);
      } else if (role === 'page' && message.type === 'call') {
        this.CallFromPage(String(message.name), message.args).then(
          (value) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, value })),
          (error: unknown) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: ErrorToJson(error) }))
        );
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
      this.movieExports.Closed(ws);
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

    if (pathname === '/config') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ eveData: EveDataStatusOf(this.eveData) }));
    } else if (pathname === '/build') {
      const status = await this.toolsCore.Status();
      response.writeHead(status.reachable ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(status));
    } else if (pathname === '/resfileindex.txt') {
      await this.Proxy(() => this.toolsCore.ResFileIndexUrl(), response);
    } else if (pathname.startsWith('/resource/')) {
      await this.Proxy(() => this.toolsCore.ResourceUrl(pathname.slice('/resource/'.length)), response);
    } else if (pathname === '/ship-stats') {
      await this.ServeShipStats(url, response);
    } else if (pathname === '/prop-mod') {
      await this.ServePropMod(url, response);
    } else if (pathname === '/fit/type' || pathname === '/dogma/types' || pathname === '/dogma/skills') {
      await this.ServeJson(response, () => this.AnswerDogma(pathname, url));
    } else if (pathname === '/weapon') {
      await this.ServeJson(response, () => this.AnswerWeapon(url));
    } else if (pathname === '/missile') {
      await this.ServeJson(response, () => this.AnswerMissile(url));
    } else if (pathname === '/audio/library') {
      await this.StreamProxy({ source: () => this.toolsCore.AudioLibraryUrl(), request, response });
    } else if (pathname.startsWith('/audio/path/')) {
      const resPath = pathname.slice('/audio/path/'.length);
      if (!(await this.ServeCachedAudio(resPath, request, response))) await this.StreamProxy({ source: () => this.toolsCore.AudioPathUrl(resPath), request, response });
    } else if (pathname === '/map/system') {
      await this.ServeMapSystem(url, response);
    } else if (pathname.startsWith('/movies/')) {
      await this.ServeMovie(pathname.slice('/movies/'.length), request, response);
    } else if (pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, tabs: this.pages.length }));
    } else if (pathname === '/console' || pathname.startsWith(CONSOLE_PREFIX)) {
      await this.ServeConsoleFile(pathname, response);
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
      body = await AnswerShipStats(this.shipData, args, this.dogmaData);
    } catch (error) {
      status = ShipStatsErrorStatus(error);
      body = { error: ErrorToJson(error), ...(error instanceof ShipDataError ? { failure: error.failure } : {}) };
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  /**
   * The fit routes for the page: `/fit/type?name=&hull=` (FitTypeAnswer), `/dogma/types?ids=<comma list, at most
   * MAX_DOGMA_TYPE_IDS>` and `/dogma/skills` (DogmaBundle). Errors map as /ship-stats does.
   *
   * @param pathname - The route.
   * @param url - The request URL.
   * @returns The answer.
   */
  private async AnswerDogma(pathname: string, url: URL): Promise<unknown> {
    let answer: Promise<unknown>;
    if (pathname === '/fit/type') {
      answer = this.dogmaData.TypeByName(url.searchParams.get('name') ?? '', url.searchParams.get('hull'));
    } else if (pathname === '/dogma/types') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (!ids.length || ids.length > MAX_DOGMA_TYPE_IDS || ids.some((id) => !/^\d+$/u.test(id))) throw new ShipDataError('invalid', `ids must be a comma list of 1-${MAX_DOGMA_TYPE_IDS} EVE type ids`);
      answer = this.dogmaData.Bundle(ids.map(Number));
    } else {
      answer = this.dogmaData.Skills();
    }
    return answer;
  }

  /**
   * A weapon's graphic for the page: `type` is its EVE type id. Errors map as /ship-stats does.
   *
   * @param url - The request URL.
   * @returns The WeaponGraphic.
   */
  private async AnswerWeapon(url: URL): Promise<unknown> {
    const type = url.searchParams.get('type') ?? '';
    if (!/^\d+$/u.test(type)) throw new ShipDataError('invalid', 'type must be an EVE type id');
    return this.weaponData.Weapon(Number(type));
  }

  /**
   * A missile's graphics for the page: `charge` and `launcher` are EVE type ids. Errors map as /ship-stats does.
   *
   * @param url - The request URL.
   * @returns The MissileGraphic.
   */
  private async AnswerMissile(url: URL): Promise<unknown> {
    const charge = url.searchParams.get('charge') ?? '';
    const launcher = url.searchParams.get('launcher') ?? '';
    if (!/^\d+$/u.test(charge) || !/^\d+$/u.test(launcher)) throw new ShipDataError('invalid', 'charge and launcher must be EVE type ids');
    return this.weaponData.Missile(Number(charge), Number(launcher));
  }

  /**
   * Answers JSON, mapping errors as /ship-stats does.
   *
   * @param response - The response.
   * @param answer - Produces the body.
   */
  private async ServeJson(response: ServerResponse, answer: () => Promise<unknown>): Promise<void> {
    let status = 200;
    let body: unknown;
    try {
      body = await answer();
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
   * A ranged audio read from the audio cache's local copy of the file (audio-cache.ts).
   *
   * @returns Whether it answered; false without a cache, a Range, a tools-core URL or a local copy (proxy it).
   */
  private async ServeCachedAudio(resPath: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const range = request.headers.range;
    const cache = this.audioCache;
    if (!cache || typeof range !== 'string') return false;
    const url = await this.toolsCore.AudioPathUrl(resPath).catch(() => null);
    return url ? cache.Serve({ url, range, response }) : false;
  }

  /**
   * A streaming proxy for tools-core's audio: forwards Range and If-None-Match, and answers tools-core's status
   * (200, 206, 304, 404, 416) with its content headers; an unreachable tools-core is a 502, and no EVE data a 503
   * (ProxySourceFailure). The resource proxy
   * buffers whole bodies and drops Range, which the 32 MB boosters.bnk cannot afford. A body cut short on either side
   * (tools-core closing, the tab going away mid-read) ends the response and is not an error of the hub's.
   */
  private async StreamProxy(input: { readonly source: () => Promise<string>; readonly request: IncomingMessage; readonly response: ServerResponse }): Promise<void> {
    const { request, response } = input;
    const headers: Record<string, string> = {};
    for (const name of ['range', 'if-none-match']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    let source: string;
    try {
      source = await input.source();
    } catch (error) {
      ProxySourceFailure('audio proxy', error, response);
      return;
    }
    let upstream: Response;
    try {
      upstream = await fetch(source, { headers });
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
    // pipeline, not pipe: an upstream error mid-body would otherwise be an unhandled stream error that ends the hub.
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), response).catch(() => response.destroy());
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
      this.SendFile(file, info.size, response);
    } else if (file) {
      this.NotFound(response, `${pathname} (run "npx nx build viewer" first)`);
    } else {
      this.NotFound(response, pathname);
    }
  }

  /**
   * The battle console under /console/: its files, and index.html for `/console` and any route without a file
   * extension (the app's own routes). Nothing outside the console directory is served.
   *
   * @param pathname - The decoded request path, `/console` or under /console/.
   * @param response - The response.
   */
  private async ServeConsoleFile(pathname: string, response: ServerResponse): Promise<void> {
    const directory = this.consoleDirectory;
    const relative = path.posix.normalize(`/${pathname.slice(CONSOLE_PREFIX.length)}`);
    let file: Maybe<string> = null;
    if (directory) {
      const resolved = path.resolve(directory, `.${relative}`);
      if (resolved === directory || resolved.startsWith(directory + path.sep)) file = resolved;
    }
    let info = file ? await stat(file).catch(() => null) : null;
    if (directory && file && !info?.isFile() && !path.extname(file)) {
      file = path.join(directory, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (file && info?.isFile()) {
      this.SendFile(file, info.size, response);
    } else if (directory) {
      this.NotFound(response, `${pathname} (run "npx nx build battle-console" first)`);
    } else {
      this.NotFound(response, `${pathname} (no battle console directory is configured: --console <dir>)`);
    }
  }

  /**
   * Streams one static file with its content type, never cached (a rebuild shows on reload).
   */
  private SendFile(file: string, size: number, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-store'
    });
    createReadStream(file).pipe(response);
  }

  /**
   * An exported movie: GET and HEAD, with one `bytes=a-b`, `bytes=a-` or `bytes=-n` Range (206, or 416 past the end).
   *
   * @param fileName - The file's name in the movies directory.
   * @param request - The request (its method and Range).
   * @param response - The response.
   */
  private async ServeMovie(fileName: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const file = this.movieExports.Resolve(fileName);
    const info = file ? await stat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) {
      this.NotFound(response, `/movies/${fileName}`);
      return;
    }
    const headers: OutgoingHttpHeaders = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const range = ByteRange(request.headers.range, info.size);
    if (range === 'unsatisfiable') {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` });
      response.end();
      return;
    }
    const [start, end] = range ?? [0, info.size - 1];
    response.writeHead(range ? 206 : 200, { ...headers, 'content-length': Math.max(0, end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) });
    if (request.method === 'HEAD' || info.size === 0) response.end();
    else await pipeline(createReadStream(file, { start, end }), response);
  }

  /**
   * A buffering proxy for one tools-core file: the source's URL (an unavailable source, as with no EVE data, is a 503;
   * any other failure a 502), then tools-core's answer (a 404 stays a 404, other errors are a 502).
   */
  private async Proxy(resolve: () => Promise<string>, response: ServerResponse): Promise<void> {
    let source: string;
    try {
      source = await resolve();
    } catch (error) {
      ProxySourceFailure('resource proxy', error, response);
      return;
    }
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

/**
 * Starts a server listening.
 *
 * @param server - The HTTP or HTTPS server.
 * @param port - The port; 0 picks a free one.
 * @param host - The address.
 */
async function Listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

const SHIP_DATA_FAILURE_STATUS: Record<ShipDataError['failure'], number> = { invalid: 400, 'not-found': 404, ambiguous: 409, unavailable: 503 };

/**
 * Answers a proxy whose source URL could not be had: 503 when the source is unavailable (no EVE data: a
 * NoEveDataError), 502 for anything else (tools-core unreachable while resolving its build).
 *
 * @param proxy - `resource proxy` or `audio proxy`.
 * @param error - Why the source failed.
 * @param response - The response.
 */
function ProxySourceFailure(proxy: string, error: unknown, response: ServerResponse): void {
  const unavailable = error instanceof ShipDataError && error.failure === 'unavailable';
  response.writeHead(unavailable ? 503 : 502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.end(`${proxy}: ${ErrorMessage(error)}`);
}

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
 * A binary socket message's bytes.
 *
 * @param data - The raw frame (a Buffer, an ArrayBuffer or fragments).
 * @returns The bytes.
 */
function RawBytes(data: RawData): Uint8Array {
  let bytes: Uint8Array;
  if (Array.isArray(data)) bytes = Buffer.concat(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  return bytes;
}

/**
 * One satisfiable byte range from a Range header.
 *
 * @param header - The Range header.
 * @param size - The file's size.
 * @returns [start, end] inclusive, null for none or one this does not read (the whole file), or unsatisfiable.
 */
export function ByteRange(header: Maybe<string>, size: number): Maybe<[number, number]> | 'unsatisfiable' {
  const match = typeof header === 'string' ? /^bytes=(\d*)-(\d*)$/u.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  return start >= size || end < start ? 'unsatisfiable' : [start, end];
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
