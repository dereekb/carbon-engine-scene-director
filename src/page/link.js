/**
 * The page's connection to the hub: answers tool calls with registered
 * handlers, reconnects when the hub restarts, and forwards the console so the
 * bridge's page_log can show what the browser saw.
 */

const RECONNECT_MS = 2000;
const LOG_FLUSH_MS = 250;
const LOG_BUFFER_LIMIT = 500;

export class HubLink
{
  constructor({ onStatus = () => {} } = {})
  {
    this._handlers = new Map();
    this._onStatus = onStatus;
    this._ws = null;
    this._logs = [];
    this._flushTimer = null;
    this.connected = false;
  }

  /** Registers the handler for one tool; it may return a value or a promise. */
  Handle(name, handler)
  {
    this._handlers.set(name, handler);
  }

  Connect()
  {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this._ws = ws;
    ws.addEventListener("open", () =>
    {
      ws.send(JSON.stringify({ type: "hello", role: "page", tools: [ ...this._handlers.keys() ] }));
      this.connected = true;
      this._onStatus(true);
      this._Flush();
    });
    ws.addEventListener("message", event => this._OnMessage(event.data));
    ws.addEventListener("close", () =>
    {
      if (this._ws !== ws) return;
      this.connected = false;
      this._onStatus(false);
      setTimeout(() => this.Connect(), RECONNECT_MS);
    });
  }

  /** Mirrors console output and uncaught errors to the hub, keeping the console's own behaviour. */
  CaptureConsole()
  {
    for (const [ method, level ] of [ [ "log", "info" ], [ "info", "info" ], [ "warn", "warn" ], [ "error", "error" ] ])
    {
      const original = console[method].bind(console);
      console[method] = (...args) =>
      {
        original(...args);
        this._Log(level, args.map(FormatArgument).join(" "));
      };
    }
    addEventListener("error", event => this._Log("error", `uncaught: ${event.message} at ${event.filename}:${event.lineno}`));
    addEventListener("unhandledrejection", event => this._Log("error", `unhandled rejection: ${FormatArgument(event.reason)}`));
  }

  async _OnMessage(data)
  {
    let message;
    try { message = JSON.parse(data); }
    catch { return; }
    if (message.type !== "call") return;

    const handler = this._handlers.get(message.name);
    let reply;
    try
    {
      if (!handler) throw new Error(`the page has no handler for "${message.name}"`);
      reply = { type: "result", id: message.id, ok: true, value: await handler(message.args ?? {}) };
    }
    catch (error)
    {
      reply = { type: "result", id: message.id, ok: false, error: { message: error?.message ?? String(error), ...(error?.problems ? { problems: error.problems } : {}) } };
    }
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(reply));
  }

  _Log(level, message)
  {
    this._logs.push({ time: Date.now(), level, message });
    if (this._logs.length > LOG_BUFFER_LIMIT) this._logs.splice(0, this._logs.length - LOG_BUFFER_LIMIT);
    this._flushTimer ??= setTimeout(() => this._Flush(), LOG_FLUSH_MS);
  }

  _Flush()
  {
    this._flushTimer = null;
    if (!this._logs.length || this._ws?.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: "log", entries: this._logs.splice(0) }));
  }
}

function FormatArgument(value)
{
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}
