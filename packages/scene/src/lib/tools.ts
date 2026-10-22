/**
 * The MCP tool list, shared by the hub (which advertises it) and the page
 * (which implements the page-side tools). `where` says who answers a call:
 * "hub" tools are answered by the Node hub itself, so they work with no
 * browser open; "page" tools are forwarded to the connected viewer tab. The
 * saved-scene tools are hub tools that forward to the tab for `store: "browser"`
 * (and to show an opened scene), so the page still implements them too.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_ANCHOR_RANGES, DEFAULT_ANCHOR_UP_RANGE, SQUAD_ROLES } from './fleets';
import { APPROACH_RANGE, MAX_ORDER_RANGE, SHIP_ORDER_TYPES } from './orders';
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
"type" (EVE type id or name) and "stats" ({ "mass": kg, "maxVelocity": m/s, "agility", "signatureRadius": m }, each optional) set a ship's flight numbers; ship_stats shows them.
"orders" and "pilot" on a ship and a top-level "timeline" are reserved for later phases: stored, not played.
"fleets" (optional) groups ships into EVE fleets: [{ "id", "name"?, "commander": "<FC ship id>", "wings": [{ "id", "name"?, "commander"?, "squads": [{ "id", "name"?, "role": "${SQUAD_ROLES.join('|')}", "commander"?: "<a member>", "members": ["<ship id>"], "anchor"?: { "ship"?: "<ship id; default the FC>", "range"?: <metres, surface to surface; default logi ${DEFAULT_ANCHOR_RANGES.logi}, others ${DEFAULT_ANCHOR_UP_RANGE}> } }] }] }]. A squad anchored on one of its own members (a logi anchor) puts that ship at range off the FC, and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m. A ship holds positions in one fleet and sits in at most one squad. Fleets are stored and reported by get_state; ships do not follow yet. "team" is independent of fleets.`;

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
    name: 'ship_stats',
    where: 'hub',
    description:
      "A hull's in-game flight numbers from the EVE data (tools-core's SDE): mass (kg), max velocity (m/s), agility, signature radius (m) and align time (s). They are given as published and as flown by a pilot with every skill at V, optionally with a prop mod running. Name the hull by dna (a scene ship's DNA; its hull:faction:race picks the EVE type) or type (an EVE type id or exact name; it wins over dna). propMod is \"mwd\" or \"ab\" (the Tech II module sized for the hull) or a module type id. stats overrides the hull's values like a scene ship's stats. For a ship in the scene, pass its dna, type and stats. Needs a prepared SDE in tools-core unless all four stats are given.",
    inputSchema: {
      type: 'object',
      properties: {
        dna: { type: 'string', description: 'SOF DNA, hull:faction:race[:commands].' },
        type: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'EVE type id or exact English type name.' },
        propMod: { description: '"mwd" or "ab" (sized for the hull), a module type id, or { "speedFactor", "speedBoostFactor", "massAddition", "signatureRadiusBonus"? }.' },
        stats: { type: 'object', description: '{ "mass": kg, "maxVelocity": m/s, "agility", "signatureRadius": m }, each optional; replaces the published values before skills.' },
        pilot: { type: 'object', description: '{ "skills": { "Navigation": 4 }, "defaultLevel": 5 }; every skill at V when omitted' }
      }
    }
  },
  {
    name: 'load_scene',
    where: 'page',
    description: `Replaces the scene in the viewer with a scene document and builds it. Returns the normalized document, warnings, and per-ship build results. Every ship starts at rest at its document placement (ships already flying are put back, and their orders end).\n\n${SCENE_FORMAT}`,
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
{ "op": "update_ship", "id": "<id>", "set": { "dna"?, "name"?, "team"?, "position"?, "rotation"?, "type"?, "stats"? } }
{ "op": "remove_ship", "id": "<id>" }
{ "op": "set_camera", "camera": { ...fields to change } }
{ "op": "set_environment", "environment": { "universe": "res:/..." } }   (reloads the page)
{ "op": "rename", "name": "<name>" }
{ "op": "add_fleet", "fleet": { ...fleet } }   { "op": "update_fleet", "fleet": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_fleet", "fleet": "<id>" }
{ "op": "add_wing", "fleet": "<id>", "wing": { ...wing } }   { "op": "update_wing", "fleet", "wing": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_wing", "fleet", "wing" }
{ "op": "add_squad", "fleet", "wing", "squad": { ...squad } }   { "op": "update_squad", "fleet", "squad": "<id>", "set": { "name"?, "role"?, "commander"?, "anchor"? } }   { "op": "remove_squad", "fleet", "squad" }
{ "op": "move_to_squad", "ships": ["<id>"], "fleet", "squad" }   { "op": "remove_from_fleet", "ships": ["<id>"] }
{ "op": "set_anchor", "fleet", "squad", "anchor": { "ship"?, "range"? } }   (merged; null resets ship to the FC and range to the role default)
Taking a ship out of a squad (remove_ship, remove_from_fleet, move_to_squad, remove_squad, remove_wing) falls a squad anchored on it back to its squad commander, then its wing commander, then the FC, with a warning; a fleet commander must be replaced (update_fleet) or its fleet removed first. Removing a fleet, wing or squad keeps its ships in the scene.
Changing dna rebuilds that ship (it keeps flying); changing position or rotation puts it there at rest. Changing type or stats retunes the ship's flight numbers without a rebuild; stats replaces the whole override object and null clears it.
Removing a ship stops the ships approaching, keeping range on or orbiting it (changes.stopped counts them).`,
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
    description:
      "Live state of the viewer: renderer status, frame rate, camera, and per-ship build status, world position and bounding radius, plus pairwise distances between ships in metres. Each ship also reports its Destiny motion: position and velocity [x, y, z] (metres, m/s), speed, mode (stop, goto, follow, orbit) and the physics it flies with (below). simulation gives the Destiny tick and scene seconds. Motion is the authoritative state; the drawn ships trail it by up to one 1 s tick, as in EVE's client. Ships in a fleet also report fleet, wing, squad, role, commands and anchor (the ship they keep range on, and the range); fleets is the fleet tree with each squad's anchor resolved. Fleets do not move ships yet. Each ship also reports its order (what its ball is flying, with target, range and speed), pendingOrder (given, applying at the next tick), orderNote (why it stopped on its own, such as its target being removed) and targetDistance (metres, surface to surface on the balls' EVE radii, negative when they overlap); distances use the drawn bounding spheres. physics gives mass, agility, maxVelocity, radius (the ball's EVE radius), signatureRadius, alignTime (s) and source: sde (the hull's in-game values via tools-core), stats (the document's four stats) or class (class values when the EVE data cannot name the hull; note says why).",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'order_ship',
    where: 'page',
    description: `Gives a ship a live movement order through its Destiny ball, flown at the ship's in-game speed and agility (its hull as flown by a pilot with every skill at V, after the document's stats). Orders take effect at the next 1 s Destiny tick and are not saved in the scene document. speed is a fraction of max velocity in (0, 1], default 1. Ranges are metres, surface to surface between the two ships' Destiny balls (EVE's radii), as EVE's overview shows them. Orders:
{ "type": "direction", "direction": [x, y, z], "speed"? }   fly along a world direction
{ "type": "goto", "point": [x, y, z], "speed"? }   fly to a world point and slow to a halt near it
{ "type": "approach", "target": "<ship id>", "speed"? }   close on the target (Destiny aims for ${APPROACH_RANGE} m)
{ "type": "keep-at-range", "target": "<ship id>", "range": <metres>, "speed"? }   hold the range on the target, following it
{ "type": "orbit", "target": "<ship id>", "range": <metres>, "speed"? }   circle the target; fast ships settle a little wider than the range, as in EVE
{ "type": "stop" }   decelerate to a halt
Removing a ship stops every ship approaching, keeping range on or orbiting it. A new position or rotation (or load_scene) puts a ship at rest and ends its order. Returns { id, order, tick }. get_state shows each ship's order, pendingOrder, orderNote, targetDistance, mode and physics.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ship id.' },
        order: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...SHIP_ORDER_TYPES] },
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'World position to fly to, metres.' },
            target: { type: 'string', description: 'Ship id to approach, keep range on or orbit.' },
            range: { type: 'number', minimum: 0, maximum: MAX_ORDER_RANGE, description: 'Metres, surface to surface.' },
            speed: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
          },
          required: ['type']
        }
      },
      required: ['id', 'order']
    }
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
