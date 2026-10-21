/**
 * The hub: one local HTTP + WebSocket server that serves the viewer page,
 * proxies EVE resources from tools-core, and routes tool calls.
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

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { findTool } from "../shared/tools.js";
import { ToolsCore } from "./toolsCore.js";

export const DEFAULT_PORT = 5520;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE_FILES = {
  "/": path.join(ROOT, "src/page/index.html"),
  "/index.html": path.join(ROOT, "src/page/index.html")
};
const BUNDLE_DIRECTORY = path.join(ROOT, "dist/page");
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};
const LOG_LIMIT = 2000;
/** Building ships fetches many files on first use, so scene edits get a long deadline. */
const SLOW_TOOLS = new Set([ "load_scene", "open_scene", "patch_scene" ]);

/** A tool call that failed in a way the caller should read. */
export class ToolError extends Error
{
  constructor(message, details = undefined)
  {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

export class Hub
{
  /**
   * @param {object} [options]
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {ToolsCore} [options.toolsCore]
   * @param {(line: string) => void} [options.log] Diagnostics sink; stderr by default, never stdout (MCP owns stdout).
   */
  constructor({ host = "127.0.0.1", port = DEFAULT_PORT, toolsCore = new ToolsCore(), log = line => process.stderr.write(`[scene-director] ${line}\n`) } = {})
  {
    this.host = host;
    this.port = port;
    this.toolsCore = toolsCore;
    this._log = log;
    this._pages = [];
    this._pending = new Map();
    this._nextId = 1;
    this._pageLog = [];
    this._server = null;
    this._wss = null;
  }

  get url()
  {
    return `http://${this.host}:${this.port}/`;
  }

  /** Starts listening. Rejects with code EADDRINUSE when another hub owns the port. */
  async Start()
  {
    this._server = createServer((request, response) =>
    {
      this._HandleHttp(request, response).catch(error =>
      {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end(`hub error: ${error.message}`);
      });
    });
    this._wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this._server.on("upgrade", (request, socket, head) =>
    {
      if (new URL(request.url, "http://localhost").pathname !== "/ws")
      {
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(request, socket, head, ws => this._Accept(ws));
    });
    await new Promise((resolve, reject) =>
    {
      this._server.once("error", reject);
      this._server.listen(this.port, this.host, () =>
      {
        this._server.off("error", reject);
        resolve();
      });
    });
    this.port = this._server.address().port;
    this._log(`viewer at ${this.url} (tools-core ${this.toolsCore.url})`);
    this.toolsCore.ResolveBuild().then(
      build => this._log(`EVE resource build ${build}`),
      error => this._log(error.message)
    );
    return this;
  }

  async Stop()
  {
    for (const { reject } of this._pending.values()) reject(new ToolError("the hub is shutting down"));
    this._pending.clear();
    for (const ws of this._wss?.clients ?? []) ws.terminate();
    await new Promise(resolve => this._server ? this._server.close(() => resolve()) : resolve());
  }

  /**
   * Runs one tool: hub tools here, page tools in the most recently connected tab.
   *
   * @param {string} name Tool name.
   * @param {object} args Tool arguments.
   * @returns {Promise<unknown>} The tool's value.
   */
  async Call(name, args = {})
  {
    const tool = findTool(name);
    if (!tool) throw new ToolError(`unknown tool "${name}"`);
    if (tool.where === "hub") return this._CallHubTool(name, args);

    const page = this._pages.at(-1);
    if (!page) throw new ToolError(`No viewer tab is connected. Open ${this.url} in Chrome or Edge (WebGPU required), then retry.`);
    const id = this._nextId++;
    const timeoutMs = SLOW_TOOLS.has(name) ? 600000 : 60000;
    return new Promise((resolve, reject) =>
    {
      const timer = setTimeout(() =>
      {
        this._pending.delete(id);
        reject(new ToolError(`${name} timed out after ${timeoutMs / 1000}s; see page_log`));
      }, timeoutMs);
      this._pending.set(id, {
        page,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      page.send(JSON.stringify({ type: "call", id, name, args }));
    });
  }

  async _CallHubTool(name, args)
  {
    switch (name)
    {
      case "viewer_status":
        return {
          viewerUrl: this.url,
          connectedTabs: this._pages.length,
          toolsCore: await this.toolsCore.Status(),
          hint: this._pages.length ? undefined : `Open ${this.url} in Chrome or Edge on this machine.`
        };
      case "page_log":
      {
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
        const minimum = { all: 0, warn: 1, error: 2 }[args.level ?? "all"] ?? 0;
        const rank = level => (level === "error" ? 2 : level === "warn" ? 1 : 0);
        return this._pageLog.filter(entry => rank(entry.level) >= minimum).slice(-limit);
      }
      case "search_hulls":
      {
        const kind = [ "hulls", "factions", "races" ].includes(args.kind) ? args.kind : "hulls";
        const query = String(args.query ?? "").toLowerCase();
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
        const names = await this.toolsCore.SofCatalog(kind);
        const matches = names.filter(entry => String(entry).toLowerCase().includes(query));
        return { kind, total: matches.length, names: matches.slice(0, limit) };
      }
      default:
        throw new ToolError(`hub tool "${name}" has no handler`);
    }
  }

  _Accept(ws)
  {
    let role = null;
    ws.on("message", data =>
    {
      let message;
      try { message = JSON.parse(String(data)); }
      catch { return; }

      if (message.type === "hello")
      {
        role = message.role;
        if (role === "page")
        {
          this._pages.push(ws);
          this._Record("info", `viewer tab connected (${this._pages.length} open)`);
        }
        ws.send(JSON.stringify({ type: "hello", role, hub: { url: this.url } }));
        return;
      }
      if (role === "page" && message.type === "result") this._Settle(message);
      else if (role === "page" && message.type === "log")
      {
        for (const entry of message.entries ?? []) this._Record(entry.level, entry.message, entry.time);
      }
      else if (role === "controller" && message.type === "call")
      {
        this.Call(message.name, message.args).then(
          value => ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value })),
          error => ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: SerializeError(error) }))
        );
      }
    });
    ws.on("close", () =>
    {
      const index = this._pages.indexOf(ws);
      if (index < 0) return;
      this._pages.splice(index, 1);
      this._Record("info", `viewer tab disconnected (${this._pages.length} open)`);
      for (const [ id, pending ] of this._pending)
      {
        if (pending.page !== ws) continue;
        this._pending.delete(id);
        pending.reject(new ToolError("the viewer tab closed or reloaded before answering"));
      }
    });
  }

  _Settle(message)
  {
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new ToolError(message.error?.message ?? "the page reported an error", message.error));
  }

  _Record(level, message, time = Date.now())
  {
    this._pageLog.push({ time: new Date(time).toISOString(), level: level ?? "info", message: String(message) });
    if (this._pageLog.length > LOG_LIMIT) this._pageLog.splice(0, this._pageLog.length - LOG_LIMIT);
  }

  async _HandleHttp(request, response)
  {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/build")
    {
      const status = await this.toolsCore.Status();
      response.writeHead(status.reachable ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(status));
      return;
    }
    if (pathname === "/resfileindex.txt") return this._Proxy(await this.toolsCore.ResFileIndexUrl(), response);
    if (pathname.startsWith("/resource/")) return this._Proxy(await this.toolsCore.ResourceUrl(pathname.slice("/resource/".length)), response);
    if (pathname === "/health")
    {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, tabs: this._pages.length }));
      return;
    }

    const bundled = pathname.startsWith("/app/") ? path.resolve(BUNDLE_DIRECTORY, `.${path.posix.normalize(pathname.slice("/app".length))}`) : null;
    const file = PAGE_FILES[pathname] ?? (bundled?.startsWith(BUNDLE_DIRECTORY + path.sep) ? bundled : null);
    if (!file) return this._NotFound(response, pathname);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile())
    {
      if (pathname.startsWith("/app/")) return this._NotFound(response, `${pathname} (run "npm run build" first)`);
      return this._NotFound(response, pathname);
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store"
    });
    createReadStream(file).pipe(response);
  }

  async _Proxy(source, response)
  {
    let upstream;
    try
    {
      upstream = await fetch(source);
    }
    catch (error)
    {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`resource proxy: ${error.message}`);
      return;
    }
    // A file the build lacks is a 404 to the page, not a gateway failure.
    if (!upstream.ok)
    {
      response.writeHead(upstream.status === 404 ? 404 : 502, { "content-type": "text/plain" });
      response.end(`resource proxy: ${source} answered ${upstream.status}`);
      return;
    }
    response.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }

  _NotFound(response, what)
  {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${what}`);
  }
}

/** A JSON-safe error, keeping a SceneError's problem list. */
export function SerializeError(error)
{
  return {
    message: error?.message ?? String(error),
    ...(error?.details?.problems ? { problems: error.details.problems } : {}),
    ...(error?.problems ? { problems: error.problems } : {})
  };
}
