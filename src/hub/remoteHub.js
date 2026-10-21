/**
 * A controller connection to a hub running in another process, with the same
 * `Call` surface as an in-process Hub. Used when the port is already taken by
 * a hub that someone started first, so two sessions share one viewer.
 */

import WebSocket from "ws";

import { ToolError } from "./hub.js";

export class RemoteHub
{
  constructor({ host = "127.0.0.1", port, log = () => {} })
  {
    this.host = host;
    this.port = port;
    this._log = log;
    this._ws = null;
    this._opening = null;
    this._pending = new Map();
    this._nextId = 1;
  }

  get url()
  {
    return `http://${this.host}:${this.port}/`;
  }

  async Call(name, args = {})
  {
    const ws = await this._Open();
    const id = this._nextId++;
    return new Promise((resolve, reject) =>
    {
      this._pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: "call", id, name, args }));
    });
  }

  async Stop()
  {
    this._ws?.close();
  }

  _Open()
  {
    if (this._ws?.readyState === WebSocket.OPEN) return Promise.resolve(this._ws);
    this._opening ??= new Promise((resolve, reject) =>
    {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/ws`);
      ws.once("open", () =>
      {
        ws.send(JSON.stringify({ type: "hello", role: "controller" }));
        this._ws = ws;
        this._opening = null;
        this._log(`using the hub already running at ${this.url}`);
        resolve(ws);
      });
      ws.once("error", error =>
      {
        this._opening = null;
        reject(new ToolError(`cannot reach the hub at ${this.url}: ${error.message}`));
      });
      ws.on("message", data =>
      {
        let message;
        try { message = JSON.parse(String(data)); }
        catch { return; }
        if (message.type !== "result") return;
        const pending = this._pending.get(message.id);
        if (!pending) return;
        this._pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new ToolError(message.error?.message ?? "the hub reported an error", message.error));
      });
      ws.on("close", () =>
      {
        if (this._ws === ws) this._ws = null;
        for (const { reject: fail } of this._pending.values()) fail(new ToolError("the hub connection closed"));
        this._pending.clear();
      });
    });
    return this._opening;
  }
}
