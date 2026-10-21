#!/usr/bin/env node
/**
 * scene-director serve   runs the hub: the viewer page, the resource proxy and the tool router
 * scene-director mcp     runs an MCP server on stdio, starting the hub or joining a running one
 * scene-director call <tool> [json-args] [--out shot.png]
 *                        calls one tool on a running hub and prints the result; a screenshot
 *                        is written to --out (default screenshot.png) instead of printed
 *
 * Options: --port <n> (5520), --host <addr> (127.0.0.1), --tools-core <url> (http://127.0.0.1:5510),
 *          --build <exact EVE build> (resolved from tools-core "latest" when omitted)
 */

import { DEFAULT_PORT, Hub } from "../src/hub/hub.js";
import { RemoteHub } from "../src/hub/remoteHub.js";
import { DEFAULT_TOOLS_CORE, ToolsCore } from "../src/hub/toolsCore.js";
import { ServeMcp } from "../src/mcp/server.js";

const log = line => process.stderr.write(`[scene-director] ${line}\n`);

function Option(name, fallback)
{
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
const host = Option("--host", process.env.SCENE_DIRECTOR_HOST ?? "127.0.0.1");
const port = Number(Option("--port", process.env.SCENE_DIRECTOR_PORT ?? DEFAULT_PORT));
const toolsCore = new ToolsCore({
  url: Option("--tools-core", process.env.CJS_TOOLS_CORE ?? DEFAULT_TOOLS_CORE),
  build: Option("--build", process.env.SCENE_DIRECTOR_BUILD ?? null)
});

async function StartHubOrJoin()
{
  const hub = new Hub({ host, port, toolsCore, log });
  try
  {
    return await hub.Start();
  }
  catch (error)
  {
    if (error.code !== "EADDRINUSE") throw error;
    log(`port ${port} is in use; joining the hub there as a controller`);
    return new RemoteHub({ host, port, log });
  }
}

if (command === "serve")
{
  const hub = await new Hub({ host, port, toolsCore, log }).Start();
  const stop = async () => { await hub.Stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
else if (command === "mcp")
{
  const hub = await StartHubOrJoin();
  await ServeMcp(hub);
  process.stdin.on("close", async () => { await hub.Stop(); process.exit(0); });
}
else if (command === "call" && process.argv[3])
{
  const remote = new RemoteHub({ host, port });
  try
  {
    const argsText = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : "{}";
    const value = await remote.Call(process.argv[3], JSON.parse(argsText));
    if (value?.image?.data)
    {
      const { writeFile } = await import("node:fs/promises");
      const out = Option("--out", "screenshot.png");
      await writeFile(out, Buffer.from(value.image.data, "base64"));
      const { image, ...rest } = value;
      process.stdout.write(`${JSON.stringify({ ...rest, written: out }, null, 2)}\n`);
    }
    else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
  catch (error)
  {
    const problems = error.details?.problems ?? [];
    process.stderr.write(`${error.message}${problems.length ? `\n- ${problems.join("\n- ")}` : ""}\n`);
    process.exitCode = 1;
  }
  finally
  {
    await remote.Stop();
  }
}
else
{
  process.stderr.write("usage: scene-director serve|mcp|call <tool> [json] [--port 5520] [--host 127.0.0.1] [--tools-core http://127.0.0.1:5510] [--build <n>] [--out file.png]\n");
  process.exit(2);
}
