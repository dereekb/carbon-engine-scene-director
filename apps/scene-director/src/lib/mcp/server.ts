/**
 * The MCP face of the hub over stdio. Tool definitions are the shared JSON
 * Schema list (@scene-director/scene), so the low-level SDK server is used
 * rather than the zod-based McpServer.
 */

import type { Maybe } from '@dereekb/util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from '@scene-director/scene';
import { ErrorMessage, ErrorProblems, type ToolCaller } from '../hub/tool-call';

const INSTRUCTIONS = `scene-director drives a CarbonEngineJS (EVE Online) space scene rendered in a browser tab.
Workflow: viewer_status -> (open the viewer URL if no tab) -> search_hulls to find hull names -> load_scene with a scene document -> screenshot to look at it -> patch_scene to adjust.
If a page tool fails, check page_log for the browser's errors.
ship_stats gives a hull's in-game speed, agility, signature and align time (needs tools-core's SDE).
order_ship flies a ship (direction, goto, approach, keep-at-range, orbit, stop) at its in-game speed; get_state shows each ship's order and motion.`;

export interface ServeMcpOptions {
  readonly version?: string;
}

/**
 * Serves the tool list on stdio until the transport closes.
 *
 * @param hub - An in-process Hub or a RemoteHub.
 * @param options - Server options.
 * @returns The connected server.
 */
// The low-level Server is deliberate: the tool definitions are shared JSON Schema, and McpServer wants zod schemas.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export async function ServeMcp(hub: Pick<ToolCaller, 'Call'>, { version = '0.1.0' }: ServeMcpOptions = {}): Promise<Server> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server({ name: 'scene-director', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return ToContent(await hub.Call(name, args ?? {}));
    } catch (error) {
      const problems = ErrorProblems(error);
      const list = problems?.map((problem) => `- ${problem}`).join('\n');
      const text = list ? `${ErrorMessage(error)}\n${list}` : ErrorMessage(error);
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });

  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Maps a tool value to MCP content. A value carrying `image: { data, mimeType }`
 * (base64) becomes an image block followed by the remaining fields as JSON.
 *
 * @param value - The tool's value.
 * @returns The MCP tool result.
 */
export function ToContent(value: unknown): CallToolResult {
  const image = ImageOf(value);
  if (image) {
    const { image: _image, ...rest } = value as { image: unknown };
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' },
        { type: 'text', text: JSON.stringify(rest, null, 2) }
      ]
    };
  }
  return { content: [{ type: 'text', text: value === undefined ? 'ok' : JSON.stringify(value, null, 2) }] };
}

/**
 * The base64 image a tool value carries, as a screenshot does.
 *
 * @param value - The tool's value.
 * @returns The image, or null when the value carries none.
 */
export function ImageOf(value: unknown): Maybe<{ readonly data: string; readonly mimeType?: string }> {
  let image: Maybe<{ readonly data: string; readonly mimeType?: string }> = null;
  if (value && typeof value === 'object' && 'image' in value) {
    const candidate = value.image as Maybe<{ data?: unknown; mimeType?: unknown }>;
    if (typeof candidate?.data === 'string' && candidate.data) image = { data: candidate.data, ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}) };
  }
  return image;
}
