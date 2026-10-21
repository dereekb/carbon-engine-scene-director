import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";

import { Hub } from "../src/hub/hub.js";
import { RemoteHub } from "../src/hub/remoteHub.js";
import { ToContent } from "../src/mcp/server.js";

/** A tools-core stand-in: no network, one pinned build, a small hull catalog. */
const toolsCore = {
  url: "http://tools-core.test",
  async ResolveBuild() { return "1234"; },
  async ResourceUrl(path) { return `http://tools-core.test/eve/1234/resources/${path}`; },
  async ResFileIndexUrl() { return "http://tools-core.test/eve/1234/app/resfileindex.txt"; },
  async SofCatalog(kind) { return kind === "hulls" ? [ "af1_t1", "af1_t2", "cf1_t1", "mf1_t1" ] : [ "amarrbase" ]; },
  async Status() { return { reachable: true, url: this.url, build: "1234" }; }
};

let hub;

before(async () =>
{
  hub = await new Hub({ port: 0, toolsCore, log: () => {} }).Start();
});

after(async () =>
{
  await hub.Stop();
});

/** Connects a fake viewer tab that answers tools from `handlers`. */
async function ConnectPage(handlers)
{
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
  await new Promise(resolve => ws.once("open", resolve));
  ws.on("message", data =>
  {
    const message = JSON.parse(String(data));
    if (message.type !== "call") return;
    Promise.resolve()
      .then(() => handlers[message.name](message.args))
      .then(
        value => ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value })),
        error => ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: { message: error.message, problems: error.problems } }))
      );
  });
  ws.send(JSON.stringify({ type: "hello", role: "page" }));
  await new Promise(resolve => ws.once("message", resolve));
  return ws;
}

test("hub tools answer without a viewer tab", async () =>
{
  const status = await hub.Call("viewer_status");
  assert.equal(status.connectedTabs, 0);
  assert.match(status.hint, /Open http:\/\/127\.0\.0\.1:/);
  const hulls = await hub.Call("search_hulls", { query: "AF1" });
  assert.deepEqual(hulls.names, [ "af1_t1", "af1_t2" ]);
});

test("page tools without a tab explain what to open", async () =>
{
  await assert.rejects(hub.Call("get_scene"), /No viewer tab is connected\. Open http/);
  await assert.rejects(hub.Call("no_such_tool"), /unknown tool/);
});

test("page tools round-trip through the newest tab, errors keep their problem list", async () =>
{
  const page = await ConnectPage({
    get_scene: () => ({ name: "duel" }),
    load_scene: () => { const error = new Error("Invalid scene document"); error.problems = [ "ships[0].dna is bad" ]; throw error; }
  });
  try
  {
    assert.deepEqual(await hub.Call("get_scene"), { name: "duel" });
    await assert.rejects(hub.Call("load_scene", { scene: {} }), error =>
    {
      assert.deepEqual(error.details.problems, [ "ships[0].dna is bad" ]);
      return true;
    });
    assert.equal((await hub.Call("viewer_status")).connectedTabs, 1);
  }
  finally
  {
    page.close();
  }
});

test("page console lines reach page_log, filtered by level", async () =>
{
  const page = await ConnectPage({});
  page.send(JSON.stringify({ type: "log", entries: [
    { time: Date.now(), level: "info", message: "booted" },
    { time: Date.now(), level: "error", message: "frame failed: boom" }
  ] }));
  await new Promise(resolve => setTimeout(resolve, 50));
  page.close();
  const errors = await hub.Call("page_log", { level: "error" });
  assert.ok(errors.some(entry => entry.message === "frame failed: boom"));
  assert.ok(errors.every(entry => entry.level === "error"));
});

test("a controller in another process shares the hub's tab", async () =>
{
  const page = await ConnectPage({ get_state: () => ({ ships: [] }) });
  const remote = new RemoteHub({ port: hub.port });
  try
  {
    assert.deepEqual(await remote.Call("get_state"), { ships: [] });
    assert.equal((await remote.Call("viewer_status")).connectedTabs, 1);
  }
  finally
  {
    await remote.Stop();
    page.close();
  }
});

test("a pending call fails when its tab closes", async () =>
{
  const page = await ConnectPage({ screenshot: () => new Promise(() => {}) });
  const call = hub.Call("screenshot", {});
  setTimeout(() => page.close(), 50);
  await assert.rejects(call, /closed or reloaded/);
});

test("the HTTP side serves the page and refuses paths outside the bundle", async () =>
{
  const page = await fetch(`http://127.0.0.1:${hub.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<canvas id="view">/);
  const escape = await fetch(`http://127.0.0.1:${hub.port}/app/..%2F..%2Fpackage.json`);
  assert.equal(escape.status, 404);
});

test("screenshot values become MCP image content", () =>
{
  const content = ToContent({ image: { data: "iVBORw0KGgo=", mimeType: "image/png" }, width: 2, height: 1 });
  assert.equal(content.content[0].type, "image");
  assert.equal(content.content[0].data, "iVBORw0KGgo=");
  assert.deepEqual(JSON.parse(content.content[1].text), { width: 2, height: 1 });
  assert.equal(ToContent({ a: 1 }).content[0].type, "text");
});
