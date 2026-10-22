/**
 * The MCP tool list, shared by the hub (which advertises it) and the page
 * (which implements the page-side tools). `where` says who answers a call:
 * "hub" tools are answered by the Node hub itself, so they work with no
 * browser open; "page" tools are forwarded to the connected viewer tab. The
 * saved-scene tools are hub tools that forward to the tab for `store: "browser"`
 * (and to show an opened scene), so the page still implements them too.
 */

import type { Maybe } from '@dereekb/util';
import { COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD, FLEET_COMPOSITION_SCHEMA, MAX_FLEET_SHIPS } from './compositions/composition';
import { DEFAULT_ANCHOR_RANGES, DEFAULT_ANCHOR_UP_RANGE, DEFAULT_FORMATION_RADIUS, FORMATION_GAP, FORMATION_SPACING, SQUAD_ROLES } from './fleets';
import { APPROACH_RANGE, MAX_ORDER_RANGE, MIN_WARP_DISTANCE, SHIP_ORDER_REQUEST_TYPES } from './orders';
import { DEFAULT_UNIVERSE, SCENE_SCHEMA } from './scene';
import { CELESTIAL_KINDS, DEFAULT_STARGATE_LOCATION_RANGE, DEFAULT_STATION_LOCATION_RANGE, LOCATION_NEARBY_LIMIT, MAP_SEARCH_KINDS } from './location';

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
"fleets" (optional) groups ships into EVE fleets: [{ "id", "name"?, "commander": "<FC ship id>", "wings": [{ "id", "name"?, "commander"?, "squads": [{ "id", "name"?, "role": "${SQUAD_ROLES.join('|')}", "commander"?: "<a member>", "members": ["<ship id>"], "anchor"?: { "ship"?: "<ship id; default the FC>", "range"?: <metres, surface to surface; default logi ${DEFAULT_ANCHOR_RANGES.logi}, others ${DEFAULT_ANCHOR_UP_RANGE}> } }] }] }]. A squad anchored on one of its own members (a logi anchor) puts that ship at range off the FC, and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m. A ship holds positions in one fleet and sits in at most one squad. Fleet members keep range on their anchors in formation behind the FC (get_state "following"). "team" is independent of fleets.
"location" (optional) puts the scene at a real EVE place: { "system": <solar system id>, "name"?: "<system>", "region"?: "<region>", "origin": [x, y, z] (system metres: where the scene's [0, 0, 0] sits; the star is at [0, 0, 0]), "anchor"?: { "celestial": <id>, "name"?, "kind"?: "${CELESTIAL_KINDS.join('|')}", "offset"?: [x, y, z] (metres from the celestial's centre to the origin) } }. Use the set_location tool to fill it from a name. Ships stay in scene metres around the origin. A location dresses the scene: the region's nebula replaces environment.universe (which applies only without a location), and the star, nearby planets and moons, and NPC stations and stargates are drawn around the origin.`;

const FLEET_COMPOSITION_FORMAT = String.raw`Fleet composition (${FLEET_COMPOSITION_SCHEMA}): a doctrine fleet to drop into a scene. Metres.
{
  "schema": "${FLEET_COMPOSITION_SCHEMA}",
  "id": "tfis",
  "name": "TFIs",
  "commander": { "hull": "Tempest Fleet Issue", "dna": "mb2_t1:minmatarnavy:minmatar", "radius": 250, "name": "FC" },
  "wings": [
    { "id": "mainline", "name": "Mainline", "squads": [
      { "id": "dps-a", "role": "dps", "ships": [{ "hull": "Tempest Fleet Issue", "count": 10, "propMod": "500MN Cold-Gas Enduring Microwarpdrive", "fit": "tfi" }] },
      { "id": "ewar", "role": "ewar", "anchor": { "range": 2500 }, "ships": [{ "hull": "Bhaalgorn", "count": 3 }, { "hull": "Vindicator", "count": 2 }] }
    ] },
    { "id": "logistics", "squads": [{ "id": "logi", "role": "logi", "ships": [{ "hull": "Guardian", "count": 5 }, { "hull": "Zarmazd", "count": 3 }] }] },
    { "id": "capitals", "squads": [{ "id": "fax", "role": "logi", "anchor": { "on": "logi", "range": 5000 }, "ships": [{ "hull": "Apostle" }] }] }
  ],
  "fits": { "tfi": "[Tempest Fleet Issue, Fleet TFI]\n<EFT text>" }
}
A ship line is { "hull": "<EVE type name or type id>", "count"?: 1, "dna"?: "<SOF DNA>", "radius"?: <the hull's EVE radius>, "name"?, "propMod"?, "fit"?: "<key of fits>" }; the commander is a line without count. role is ${SQUAD_ROLES.join('|')}.
anchor is { "on"?: "${COMPOSITION_ANCHOR_FC}" | "${COMPOSITION_ANCHOR_LEAD}" | "<squad id>", "range"?: <metres, surface to surface> }. Defaults: squads keep ${DEFAULT_ANCHOR_UP_RANGE} m on the FC; logi default to "${COMPOSITION_ANCHOR_LEAD}": their first ship keeps ${DEFAULT_ANCHOR_RANGES.logi} m on the FC and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m; "on" a squad id anchors on that squad's first ship.
Ships are placed at rest in formation: each at its anchor range on shells trailing the FC's heading, at least ${FORMATION_SPACING} x (r1 + r2) + ${FORMATION_GAP} m apart on EVE radii (${DEFAULT_FORMATION_RADIUS} m when unknown), all facing the heading. Ids: fleet "<id>" (numbered "<id>-2", ... when taken), ships "<fleet>-fc" and "<fleet>-<squad>-<nn>". At most ${MAX_FLEET_SHIPS} ships with the FC.
Fits (EFT text) and prop mods are stored for later entries, not applied yet.`;

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
      "A hull's in-game flight numbers from the EVE data (tools-core's SDE): mass (kg), max velocity (m/s), agility, signature radius (m), align time (s) and warp speed (AU/s). They are given as published and as flown by a pilot with every skill at V, optionally with a prop mod running. Name the hull by dna (a scene ship's DNA; its hull:faction:race picks the EVE type) or type (an EVE type id or exact name; it wins over dna). propMod is \"mwd\" or \"ab\" (the Tech II module sized for the hull) or a module type id. stats overrides the hull's values like a scene ship's stats. For a ship in the scene, pass its dna, type and stats. Needs a prepared SDE in tools-core unless all four stats are given.",
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
    name: 'search_map',
    where: 'hub',
    description: `Searches CCP's static EVE map (tools-core's SDE) by name: ${MAP_SEARCH_KINDS.join(', ')}. The match is a case-insensitive substring, exact names first, then prefixes, then shorter names. Moons and asteroid belts are not searchable: get_system lists them, and set_location takes their full names. Stargates are named after their destination ("Stargate (Perimeter)"), so a gate name matches in every system with one; each celestial hit reports its system, and each system hit its region and security status. Needs a prepared SDE in tools-core.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The name, or part of it.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...MAP_SEARCH_KINDS] }, description: 'Only these kinds (default all).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results (default 20).' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_system',
    where: 'hub',
    description: `One EVE solar system from the static data, by id or exact name: name, security, constellation, region, its star (spectral class, temperature, radius, light), the region's nebula (an environment.universe path), counts of each kind, and its celestials (${CELESTIAL_KINDS.join(', ')}) in tools-core's order with id, name, radius (m), position (system metres: the star at [0, 0, 0]), orbit (the parent's name) and, for stargates, destination (the system id). kinds filters the list, not the counts. Needs a prepared SDE in tools-core.`,
    inputSchema: {
      type: 'object',
      properties: {
        system: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'Solar system id or exact name.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...CELESTIAL_KINDS] }, description: 'Only list these kinds.' }
      },
      required: ['system']
    }
  },
  {
    name: 'set_location',
    where: 'hub',
    description: `Puts the scene at a real EVE place: resolves a celestial (a star, planet, moon, asteroid belt, NPC station or stargate) by name or id, computes the scene origin in system metres and sets the document's location; the ships stay where they are in the scene. Examples: { "celestial": "Jita IV - Moon 4 - Caldari Navy Assembly Plant", "range": 30000 } (30 km off the station), { "celestial": "Perimeter gate", "system": "Jita" }, { "celestial": "the Perimeter gate in Jita" }, { "celestial": "Jita IV - Moon 4" }, { "system": "Jita", "celestial": "star" }. Names: the full name, a name inside system ("IV - Moon 4", "star", "Perimeter gate"), or "<celestial> in <system>"; an ambiguous name lists the candidates. range is metres off the celestial's surface (EVE radii): default one radius for the star, planets and moons, ${DEFAULT_STATION_LOCATION_RANGE} m for stations, ${DEFAULT_STARGATE_LOCATION_RANGE} m for stargates, and 0 from an asteroid belt's centre. direction is from the celestial toward the origin: "sun" (default; the scene sits on the sunlit side), "away" or [x, y, z]. offset (metres from the celestial's centre) replaces range and direction; origin (system metres) with system places it with no celestial. The page dresses the scene from the location: the region's nebula, the star (light direction, sun, environment template, lens flare), planets and moons big enough to see, and NPC stations and stargates near the origin (get_state.location.dressing); environment.universe stays the nebula for a scene with no location. Pass scene to edit that document with no tab (returns it with loaded: false). Needs a prepared SDE in tools-core.`,
    inputSchema: {
      type: 'object',
      properties: {
        system: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'Solar system id or exact name.' },
        celestial: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'Celestial id or name.' },
        range: { type: 'number', minimum: 0, description: 'Metres off the surface.' },
        direction: {
          anyOf: [
            { type: 'string', enum: ['sun', 'away'] },
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z]' }
          ],
          description: 'From the celestial toward the origin (default "sun").'
        },
        offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Metres from the celestial centre to the origin, system axes.' },
        origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'The scene origin in system metres (needs system, no celestial).' },
        scene: { type: 'object', description: 'A scene document to edit instead of the live tab.' }
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
{ "op": "add_fleet", "fleet": { ...fleet } }   { "op": "update_fleet", "fleet": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_fleet", "fleet": "<id>", "withShips"?: true }
{ "op": "add_wing", "fleet": "<id>", "wing": { ...wing } }   { "op": "update_wing", "fleet", "wing": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_wing", "fleet", "wing" }
{ "op": "add_squad", "fleet", "wing", "squad": { ...squad } }   { "op": "update_squad", "fleet", "squad": "<id>", "set": { "name"?, "role"?, "commander"?, "anchor"? } }   { "op": "remove_squad", "fleet", "squad" }
{ "op": "move_to_squad", "ships": ["<id>"], "fleet", "squad" }   { "op": "remove_from_fleet", "ships": ["<id>"] }
{ "op": "set_anchor", "fleet", "squad", "anchor": { "ship"?, "range"? } }   (merged; null resets ship to the FC and range to the role default)
{ "op": "add_fleet_composition", "composition": { ...${FLEET_COMPOSITION_SCHEMA} }, "position": [x, y, z], "heading"?: <yaw degrees> | "facing"?: [x, y, z], "fleet"?: "<fleet id>", "team"? }   (needs dna on every ship line; the add_fleet_composition tool resolves hull names and saved names first)
{ "op": "set_location", "location": { ...location } }   (replaces the location whole; the set_location tool resolves names)
{ "op": "clear_location" }
Taking a ship out of a squad (remove_ship, remove_from_fleet, move_to_squad, remove_squad, remove_wing) falls a squad anchored on it back to its squad commander, then its wing commander, then the FC, with a warning; a fleet commander must be replaced (update_fleet) or its fleet removed first. Removing a fleet, wing or squad keeps its ships in the scene, unless remove_fleet has "withShips": true.
Changing dna rebuilds that ship (it keeps flying); changing position or rotation puts it there at rest. Changing type or stats retunes the ship's flight numbers without a rebuild; stats replaces the whole override object and null clears it.
Removing a ship stops the ships approaching, keeping range on or orbiting it (changes.stopped counts them).
A location change moves the scene in its system, not the ships in the scene.
Fleet edits re-plan the following ships at once (a squad set to its own anchor and range breaks off, and rejoins when set back); a removed anchor's followers re-anchor through the fallback above and keep flying. Moving a following ship puts it there at rest and it flies back to its slot; moving the FC makes its fleet follow. Ships whose following ends (they left their fleet, it was removed, or they became its FC) stop, and changes.stopped counts them.`,
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
    name: 'add_fleet_composition',
    where: 'hub',
    description: `Adds a fleet composition to the viewer's live scene: its ships in formation around the FC at position, facing heading (yaw degrees, 0 faces +Z, 90 faces +X) or the facing point, plus its fleet, with ids free in the scene. Give the composition inline or the name of a saved one or a built-in example ("tfis", the TFIs armor doctrine, 44 ships). Hull names without dna or radius are resolved through tools-core's EVE data (needs its SDE). Pass scene to add to that document instead of the viewer's, with no tab: the result is returned, not shown (load_scene or save_scene it). Returns added (fleet, commander, ships), hulls (each hull's dna and radius and where they came from), and the patch_scene result. Remove it again with patch_scene remove_fleet "withShips": true; frame_camera on "<fleet>-fc" looks at it.
${FLEET_COMPOSITION_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: {
        composition: { type: 'object', description: `A ${FLEET_COMPOSITION_SCHEMA} composition. Give this or name.` },
        name: { type: 'string', description: 'A saved composition or built-in example. Give this or composition.' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: "The FC's [x, y, z] in metres." },
        heading: { type: 'number', description: 'The fleet heading, yaw degrees. Default 0.' },
        facing: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'A point the fleet faces, instead of heading.' },
        fleet: { type: 'string', description: "The fleet id. Default the composition's id, numbered when taken." },
        team: { type: 'string', description: 'The team every added ship is on.' },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      },
      required: ['position']
    }
  },
  {
    name: 'save_fleet_composition',
    where: 'hub',
    description: `Saves a fleet composition as a JSON file in the hub's fleets directory, under name (default its name, else its id). A saved composition shadows a built-in example of the same name. Names that differ only in case are the same composition.
${FLEET_COMPOSITION_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: { composition: { type: 'object', description: `A ${FLEET_COMPOSITION_SCHEMA} composition.` }, name: { type: 'string' } },
      required: ['composition']
    }
  },
  {
    name: 'list_fleet_compositions',
    where: 'hub',
    description: 'Lists fleet compositions: the saved ones (store "disk", newest first), then the read-only built-in examples (store "example"), each with its ship and squad counts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_fleet_composition',
    where: 'hub',
    description: 'Returns a saved fleet composition, or a built-in example, by name (or an example by id).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'delete_fleet_composition',
    where: 'hub',
    description: 'Deletes a saved fleet composition by name. Built-in examples are read-only.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'get_state',
    where: 'page',
    description: `Live state of the viewer: renderer status, frame rate, camera, and per-ship build status, world position and bounding radius, plus pairwise distances between ships in metres. Each ship also reports its Destiny motion: position and velocity [x, y, z] (metres, m/s), speed, mode (stop, goto, follow, orbit) and the physics it flies with (below). simulation gives the Destiny tick and scene seconds. Motion is the authoritative state; the drawn ships trail it by up to one 1 s tick, as in EVE's client. Ships in a fleet also report fleet, wing, squad, role, commands and anchor (the ship they keep range on, and the range); fleets is the fleet tree with each squad's anchor resolved, plus formation (ready, the FC's heading, and how many members are following, in formation, catching up, detached or waiting). A fleet member other than the FC also reports following: state (in-formation, catching-up, detached by an explicit order, or waiting for the ships' radii), anchor and range (what it keeps range on), slot (its formation slot: range and direction in the FC's heading frame), distance (metres, surface to surface, to the anchor) and slotError (metres from its slot); its order is keep-at-range on the anchor, and its mode is goto while it steers to its slot and stop once settled. heading is each ship's [yaw, pitch] in degrees, the authoritative heading. Each ship also reports its order (what its ball is flying, with target, range and speed), pendingOrder (given, applying at the next tick), orderNote (why it stopped on its own, such as its target being removed) and targetDistance (metres, surface to surface on the balls' EVE radii, negative when they overlap); distances use the drawn bounding spheres. physics gives mass, agility, maxVelocity, radius (the ball's EVE radius), signatureRadius, alignTime (s) and source: sde (the hull's in-game values via tools-core), stats (the document's four stats) or class (class values when the EVE data cannot name the hull; note says why). location is the scene's EVE location, or null: system (id, name, region, securityStatus), origin (system metres), status (loading, ready or failed, with error), anchor (the celestial it was placed from, with its actual distance and surfaceDistance from the origin), star (distance and direction), and nearby: the ${LOCATION_NEARBY_LIMIT} celestials nearest the origin (id, name, kind, radius, position in scene metres, distance from the origin, surfaceDistance). location.dressing reports what the location drew: state, the nebula, the sun (graphic, environment template, lens flare, distance), counts per kind (drawn, validated without a renderer, loading, failed, skipped) and each dressed planet, moon, station and stargate with its state; environment.nebula says which nebula is drawn and whether it comes from the location or environment.universe.`,
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
{ "type": "warp", "point": [x, y, z], "range"? }   align, warp and land range metres short of the point (default 0)
{ "type": "warp", "target": "<ship id>", "range"? }   align, warp and land range metres from where the target is when the order applies
{ "type": "stop" }   decelerate to a halt
{ "type": "rejoin" }   a fleet member that left its formation keeps range on its anchor in its slot again
Warp: the ship aligns at full speed toward the destination until it reaches 75 % of max velocity on that heading, as in EVE, then warps at its warp speed (warpSpeedMultiplier AU/s; class values without the SDE) and lands. The landing must be at least ${MIN_WARP_DISTANCE / 1000} km away (use goto nearer). While aligning any order cancels the warp; in warp a ship refuses orders until it lands. A fleet holds while its FC is in warp, then flies to the FC's landing. get_state shows warp: phase, landing, progress, remaining, landsIn.
Fleets fly in formation on their FC: ordering the FC moves its fleet. Any order above on a fleet member (not the FC) takes it out of formation until rejoin, a fleet edit that regroups it, or load_scene; rejoin is refused for the FC and for a ship in no fleet.
Removing a ship stops every ship approaching, keeping range on or orbiting it. A new position or rotation (or load_scene) puts a ship at rest and ends its order. Returns { id, order, tick }, plus following: "detached" when the order took a fleet member out of formation, or the member's following report for rejoin. get_state shows each ship's order, pendingOrder, orderNote, targetDistance, mode and physics.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ship id.' },
        order: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...SHIP_ORDER_REQUEST_TYPES] },
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'World position to fly or warp to, metres.' },
            target: { type: 'string', description: 'Ship id to approach, keep range on, orbit or warp to.' },
            range: { type: 'number', minimum: 0, maximum: MAX_ORDER_RANGE, description: 'Metres, surface to surface (warp: metres short of a point, default 0).' },
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
