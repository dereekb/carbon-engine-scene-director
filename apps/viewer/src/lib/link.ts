import type { Maybe } from '@dereekb/util';
/**
 * The page's connection to the hub: answers tool calls with registered
 * handlers, reconnects when the hub restarts, and forwards the console so the
 * hub's page_log can show what the browser saw.
 */

const RECONNECT_MS = 2000;
const LOG_FLUSH_MS = 250;
const LOG_BUFFER_LIMIT = 500;

/**
 * Answers one tool call; it may return a value or a promise.
 */
export type ToolHandler = (args: Record<string, unknown>) => unknown;

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  readonly time: number;
  readonly level: LogLevel;
  readonly message: string;
}

interface CallMessage {
  readonly type?: string;
  readonly id?: number;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly hub?: unknown;
}

const CONSOLE_LEVELS: [keyof Pick<Console, 'log' | 'info' | 'warn' | 'error'>, LogLevel][] = [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error']
];

export interface HubLinkOptions {
  readonly onStatus?: (connected: boolean) => void;
  /**
   * The hub's movie export messages (`{ type: "export", ... }`: saved, failed; sd-export).
   */
  readonly onExport?: (message: Record<string, unknown>) => void;
  /**
   * The hub's hello reply's `hub` ({ url, eveData }), on every (re)connect.
   */
  readonly onHello?: (hub: unknown) => void;
}

export class HubLink {
  connected = false;
  /**
   * The hub's movie export messages; the director sets it (kept across reconnects).
   */
  onExport: (message: Record<string, unknown>) => void;
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly onStatus: (connected: boolean) => void;
  private readonly onHello: (hub: unknown) => void;
  private readonly logs: LogEntry[] = [];
  private ws: Maybe<WebSocket> = null;
  private flushTimer: Maybe<ReturnType<typeof setTimeout>> = null;

  constructor({ onStatus = () => undefined, onExport = () => undefined, onHello = () => undefined }: HubLinkOptions = {}) {
    this.onStatus = onStatus;
    this.onExport = onExport;
    this.onHello = onHello;
  }

  /**
   * Bytes queued on the socket and not yet sent (a movie export's backpressure).
   */
  get buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Sends a binary message (a movie export's chunk packet).
   *
   * @param bytes - The packet.
   * @returns False when the socket is not open.
   */
  SendBinary(bytes: Uint8Array): boolean {
    const open = this.ws?.readyState === WebSocket.OPEN;
    if (open) this.ws?.send(bytes as Uint8Array<ArrayBuffer>);
    return open;
  }

  /**
   * Sends a JSON message (a movie export's config, progress and end).
   *
   * @param message - The message.
   * @returns False when the socket is not open.
   */
  SendMessage(message: object): boolean {
    const open = this.ws?.readyState === WebSocket.OPEN;
    if (open) this.ws?.send(JSON.stringify(message));
    return open;
  }

  /**
   * Registers the handler for one tool.
   */
  Handle(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  Connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'page', tools: [...this.handlers.keys()] }));
      this.connected = true;
      this.onStatus(true);
      this.Flush();
    });
    ws.addEventListener('message', (event: MessageEvent<string>) => void this.OnMessage(event.data));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.onStatus(false);
      setTimeout(() => this.Connect(), RECONNECT_MS);
    });
  }

  /**
   * Mirrors console output and uncaught errors to the hub, keeping the console's own behaviour.
   */
  CaptureConsole(): void {
    for (const [method, level] of CONSOLE_LEVELS) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        this.Log(level, args.map(FormatArgument).join(' '));
      };
    }
    addEventListener('error', (event) => this.Log('error', `uncaught: ${event.message} at ${event.filename}:${event.lineno}`));
    addEventListener('unhandledrejection', (event) => this.Log('error', `unhandled rejection: ${FormatArgument(event.reason)}`));
  }

  private async OnMessage(data: string): Promise<void> {
    let message: CallMessage;
    try {
      message = JSON.parse(data) as CallMessage;
    } catch {
      return;
    }
    if (message.type === 'export') {
      this.onExport(message as Record<string, unknown>);
      return;
    }
    if (message.type === 'hello') {
      this.onHello(message.hub);
      return;
    }
    if (message.type !== 'call') return;

    const handler = this.handlers.get(String(message.name));
    let reply: object;
    try {
      if (!handler) throw new Error(`the page has no handler for "${message.name}"`);
      reply = { type: 'result', id: message.id, ok: true, value: await handler(message.args ?? {}) };
    } catch (error) {
      const problems = (error as Maybe<{ problems?: unknown }>)?.problems;
      reply = { type: 'result', id: message.id, ok: false, error: { message: error instanceof Error ? error.message : String(error), ...(problems ? { problems } : {}) } };
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(reply));
  }

  private Log(level: LogLevel, message: string): void {
    this.logs.push({ time: Date.now(), level, message });
    if (this.logs.length > LOG_BUFFER_LIMIT) this.logs.splice(0, this.logs.length - LOG_BUFFER_LIMIT);
    this.flushTimer ??= setTimeout(() => this.Flush(), LOG_FLUSH_MS);
  }

  private Flush(): void {
    this.flushTimer = null;
    if (!this.logs.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'log', entries: this.logs.splice(0) }));
  }
}

/**
 * One console argument as text.
 *
 * @param value - The argument.
 * @returns Its text: an error's message and stack, a string as is, anything else as JSON.
 */
function FormatArgument(value: unknown): string {
  let text: string;
  if (value instanceof Error) {
    text = value.stack ? `${value.message}\n${value.stack}` : value.message;
  } else if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text;
}
