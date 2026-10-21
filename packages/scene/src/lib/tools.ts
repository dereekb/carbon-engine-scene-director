/**
 * The MCP tool list, shared by the hub (which advertises it) and the page
 * (which implements the page-side tools). `where` says who answers a call:
 * "hub" tools are answered by the Node hub itself, so they work with no
 * browser open; "page" tools are forwarded to the connected viewer tab. The
 * saved-scene tools are hub tools that forward to the tab for `store: "browser"`
 * (and to show an opened scene), so the page still implements them too.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_UNIVERSE, SCENE_SCHEMA } from './scene';

/**
 * Who answers a tool call.
 */
export type ToolHost = 'hub' | 'page';

/**
 * A tool's arguments, as JSON Schema.
 */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, object>;
  readonly required?: string[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly where: ToolHost;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

const SCENE_FORMAT = `Scene document (${SCENE_SCHEMA}). Metres and degrees, Y up.
{
  "schema": "${SCENE_SCHEMA}",
  "name": "duel",
  "environment": { "universe": "${DEFAULT_UNIVERSE}" },
  "camera": { "target": "<ship id or null to frame every ship>", "distance": <metres or null to fit>, "yaw": 45, "pitch": -15, "fov": 45 },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "name": "Punisher", "team": "red", "position": [0, 0, 0], "rotation": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
dna is a SOF DNA string, hull:faction:race[:commands]; use search_hulls to find hull names. rotation is [yaw, pitch, roll].
"orders" on a ship and a top-level "timeline" are reserved for later phases: stored, not played.`;

const STORE_ARGUMENT = {
  type: 'string',
  enum: ['disk', 'browser'],
  description: "disk: scene files kept by the hub; browser: the viewer tab's IndexedDB."
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'viewer_status',
    where: 'hub',
    description: 'Reports whether a viewer tab is connected, the URL to open, and whether tools-core (the EVE data service) is reachable. Call this first if other tools fail.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'page_log',
    where: 'hub',
    description: 'Recent console output and errors from the viewer tab, newest last. Kept by the bridge, so it survives page reloads.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many lines (default 50).' },
        level: { type: 'string', enum: ['all', 'warn', 'error'], description: 'Minimum level (default all).' }
      }
    }
  },
  {
    name: 'search_hulls',
    where: 'hub',
    description: 'Lists SOF hull names from the EVE data, optionally filtered by a substring (e.g. "af1" or "titan"). Hull names are the first part of a DNA string. Also returns faction and race names when asked.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring filter.' },
        kind: { type: 'string', enum: ['hulls', 'factions', 'races'], description: 'Which catalog (default hulls).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum results (default 50).' }
      }
    }
  },
  {
    name: 'load_scene',
    where: 'page',
    description: `Replaces the scene in the viewer with a scene document and builds it. Returns the normalized document, warnings, and per-ship build results.\n\n${SCENE_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: { scene: { type: 'object', description: 'The scene document.' } },
      required: ['scene']
    }
  },
  {
    name: 'get_scene',
    where: 'page',
    description: 'Returns the current scene document as JSON.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'patch_scene',
    where: 'page',
    description: `Edits the current scene with a list of operations, applied in order, then updates the viewer to match. Operations:
{ "op": "add_ship", "ship": { ...ship } }
{ "op": "update_ship", "id": "<id>", "set": { "dna"?, "name"?, "team"?, "position"?, "rotation"? } }
{ "op": "remove_ship", "id": "<id>" }
{ "op": "set_camera", "camera": { ...fields to change } }
{ "op": "set_environment", "environment": { "universe": "res:/..." } }   (reloads the page)
{ "op": "rename", "name": "<name>" }
Changing dna rebuilds that ship; changing position or rotation moves it in place.`,
    inputSchema: {
      type: 'object',
      properties: { operations: { type: 'array', items: { type: 'object' }, minItems: 1 } },
      required: ['operations']
    }
  },
  {
    name: 'save_scene',
    where: 'hub',
    description: `Saves a scene under a name (the scene's own name when omitted). By default it saves the viewer's current scene as a ${SCENE_SCHEMA} JSON file in the hub's scenes directory, which works without a viewer tab when "scene" is passed. store "browser" saves in the viewer tab's IndexedDB instead. Names that differ only in case are the same scene.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        store: STORE_ARGUMENT,
        scene: { type: 'object', description: "A scene document to save instead of the viewer's current scene (disk only)." }
      }
    }
  },
  {
    name: 'list_scenes',
    where: 'hub',
    description: "Lists saved scenes, newest first, each marked with its store: scene files on disk, plus the browser's IndexedDB saves when a viewer tab is connected. Pass store to list only one.",
    inputSchema: { type: 'object', properties: { store: STORE_ARGUMENT } }
  },
  {
    name: 'open_scene',
    where: 'hub',
    description: "Loads a saved scene by name into the viewer. Without store it looks on disk first, then in the browser's storage. With no viewer tab connected, a disk scene is returned without being shown.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, store: STORE_ARGUMENT }, required: ['name'] }
  },
  {
    name: 'delete_scene',
    where: 'hub',
    description: "Deletes a saved scene by name. Without store it deletes the disk file when there is one, otherwise the browser's save.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, store: STORE_ARGUMENT }, required: ['name'] }
  },
  {
    name: 'get_state',
    where: 'page',
    description: 'Live state of the viewer: renderer status, frame rate, camera, and per-ship build status, world position and bounding radius, plus pairwise distances between ships in metres.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'screenshot',
    where: 'page',
    description: 'Captures the next rendered frame of the viewer as a PNG image, so you can see the scene.',
    inputSchema: {
      type: 'object',
      properties: { maxWidth: { type: 'integer', minimum: 64, maximum: 4096, description: 'Downscale to at most this width (default 1280).' } }
    }
  },
  {
    name: 'frame_camera',
    where: 'page',
    description: 'Points the camera at one ship, or fits every ship when target is omitted, without editing the saved camera settings unless persist is true.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ship id; omit to frame all ships.' },
        yaw: { type: 'number' },
        pitch: { type: 'number' },
        distance: { type: 'number' },
        persist: { type: 'boolean', description: 'Also write this camera into the scene document.' }
      }
    }
  }
];

export const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/**
 * Looks up a tool by name.
 *
 * @param name - The tool name.
 * @returns The tool, or null when no tool has that name.
 */
export function findTool(name: string): Maybe<ToolDefinition> {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}
