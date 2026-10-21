/**
 * The MCP face of the hub over stdio. Tool definitions are the shared JSON
 * Schema list (src/shared/tools.js), so the low-level SDK server is used
 * rather than the zod-based McpServer.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOLS } from "../shared/tools.js";

const INSTRUCTIONS = `scene-director drives a CarbonEngineJS (EVE Online) space scene rendered in a browser tab.
Workflow: viewer_status -> (open the viewer URL if no tab) -> search_hulls to find hull names -> load_scene with a scene document -> screenshot to look at it -> patch_scene to adjust.
If a page tool fails, check page_log for the browser's errors.`;

/**
 * Serves the tool list on stdio until the transport closes.
 *
 * @param {{ Call: (name: string, args: object) => Promise<unknown> }} hub An in-process Hub or a RemoteHub.
 * @param {object} [options]
 * @param {string} [options.version]
 * @returns {Promise<Server>} The connected server.
 */
export async function ServeMcp(hub, { version = "0.1.0" } = {})
{
  const server = new Server(
    { name: "scene-director", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async request =>
  {
    const { name, arguments: args } = request.params;
    try
    {
      return ToContent(await hub.Call(name, args ?? {}));
    }
    catch (error)
    {
      const problems = error?.details?.problems ?? error?.problems;
      const text = problems?.length ? `${error.message}\n${problems.map(problem => `- ${problem}`).join("\n")}` : String(error?.message ?? error);
      return { isError: true, content: [ { type: "text", text } ] };
    }
  });

  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Maps a tool value to MCP content. A value carrying `image: { data, mimeType }`
 * (base64) becomes an image block followed by the remaining fields as JSON.
 */
export function ToContent(value)
{
  if (value && typeof value === "object" && value.image?.data)
  {
    const { image, ...rest } = value;
    return {
      content: [
        { type: "image", data: image.data, mimeType: image.mimeType ?? "image/png" },
        { type: "text", text: JSON.stringify(rest, null, 2) }
      ]
    };
  }
  return { content: [ { type: "text", text: value === undefined ? "ok" : JSON.stringify(value, null, 2) } ] };
}
