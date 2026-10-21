/**
 * A controller connection to a hub running in another process, with the same
 * `Call` surface as an in-process Hub. Used when the port is already taken by
 * a hub that someone started first, so two sessions share one viewer.
 */

import type { Maybe } from '@dereekb/util';
import { WebSocket } from 'ws';
import { ParseMessage } from './hub';
import { ErrorMessage, ToolError, type ToolArgs, type ToolCaller } from './tool-call';

export interface RemoteHubOptions {
  readonly host?: string;
  readonly port: number;
  readonly log?: (line: string) => void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RemoteHub implements ToolCaller {
  readonly host: string;
  readonly port: number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private ws: Maybe<WebSocket> = null;
  private opening: Maybe<Promise<WebSocket>> = null;

  constructor({ host = '127.0.0.1', port, log = () => undefined }: RemoteHubOptions) {
    this.host = host;
    this.port = port;
    this.log = log;
  }

  get url(): string {
    return `http://${this.host}:${this.port}/`;
  }

  async Call(name: string, args: ToolArgs = {}): Promise<unknown> {
    const ws = await this.Open();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  async Stop(): Promise<void> {
    this.ws?.close();
  }

  private Open(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.opening ??= new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/ws`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'controller' }));
        this.ws = ws;
        this.opening = null;
        this.log(`using the hub already running at ${this.url}`);
        resolve(ws);
      });
      ws.once('error', (error) => {
        this.opening = null;
        reject(new ToolError(`cannot reach the hub at ${this.url}: ${ErrorMessage(error)}`));
      });
      ws.on('message', (data) => {
        const message = ParseMessage(data);
        if (message?.type !== 'result' || message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new ToolError(message.error?.message ?? 'the hub reported an error', message.error));
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        for (const { reject: fail } of this.pending.values()) fail(new ToolError('the hub connection closed'));
        this.pending.clear();
      });
    });
    return this.opening;
  }
}
