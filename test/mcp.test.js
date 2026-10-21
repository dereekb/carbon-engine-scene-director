import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { TOOLS } from "../src/shared/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the stdio MCP server lists every tool and answers a hub tool", async () =>
{
  // Port 0 picks a free port; an unreachable tools-core keeps the test offline.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ path.join(root, "bin/scene-director.js"), "mcp", "--port", "0", "--tools-core", "http://127.0.0.1:9" ],
    stderr: "ignore"
  });
  const client = new Client({ name: "scene-director-test", version: "0.0.0" });
  await client.connect(transport);
  try
  {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), TOOLS.map(tool => tool.name).sort());

    const status = await client.callTool({ name: "viewer_status", arguments: {} });
    const body = JSON.parse(status.content[0].text);
    assert.equal(body.connectedTabs, 0);
    assert.equal(body.toolsCore.reachable, false);

    const missing = await client.callTool({ name: "get_scene", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No viewer tab is connected/);
  }
  finally
  {
    await client.close();
  }
});
