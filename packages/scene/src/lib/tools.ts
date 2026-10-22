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
import { DEFAULT_ANCHOR_RANGES, DEFAULT_ANCHOR_UP_RANGE, DEFAULT_BREAK_OFF_RANGE, DEFAULT_FORMATION_RADIUS, FLEET_ORDER_TYPES, FORMATION_GAP, FORMATION_SPACING, MAX_FLEET_ORDER_DELAY, SQUAD_ROLES } from './fleets';
import { APPROACH_RANGE, MAX_ORDER_RANGE, MIN_WARP_DISTANCE, SHIP_ORDER_REQUEST_TYPES } from './orders';
import { DEFAULT_UNIVERSE, SCENE_SCHEMA } from './scene';
import { PROP_MOD_MODULE_AB, PROP_MOD_MODULE_MWD, PROP_MOD_MODULE_NONE } from './stats';
import { CELESTIAL_KINDS, DEFAULT_STARGATE_LOCATION_RANGE, DEFAULT_STATION_LOCATION_RANGE, LOCATION_NEARBY_LIMIT, MAP_SEARCH_KINDS } from './location';
import { DEFAULT_ENGAGEMENT_RANGE, DEFAULT_NEAR_SHIP_RANGE, ENGAGEMENT_TEAMS, NEAR_DIRECTIONS, SHIP_FORMATION_ALIASES, SHIP_FORMATIONS } from './staging';

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
"propMod" is the ship's propulsion module and its state at load: "<module>" or { "module"?: "<module>", "active"?: true }, where a module is an EVE type name ("50MN Microwarpdrive II"), a type id, "${PROP_MOD_MODULE_MWD}" / "${PROP_MOD_MODULE_AB}" (the Tech II module of that kind sized for the hull) or "${PROP_MOD_MODULE_NONE}". Omitted: the hull-sized Tech II microwarpdrive, off. "active": true runs it from the moment the scene loads; switch_prop_mods switches it live.
"orders" and "pilot" on a ship and a top-level "timeline" are reserved for later phases: stored, not played.
"fleets" (optional) groups ships into EVE fleets: [{ "id", "name"?, "commander": "<FC ship id>", "wings": [{ "id", "name"?, "commander"?, "squads": [{ "id", "name"?, "role": "${SQUAD_ROLES.join('|')}", "commander"?: "<a member>", "members": ["<ship id>"], "anchor"?: { "ship"?: "<ship id; default the FC>", "range"?: <metres, surface to surface; default logi ${DEFAULT_ANCHOR_RANGES.logi}, others ${DEFAULT_ANCHOR_UP_RANGE}> }, "home"?: { "ship"?, "range"? } }] }] }] (home is set by order_fleet break-off: the anchor regroup restores). A squad anchored on one of its own members (a logi anchor) puts that ship at range off the FC, and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m. A ship holds positions in one fleet and sits in at most one squad. Fleet members keep range on their anchors in formation behind the FC (get_state "following"). "team" is independent of fleets.
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
A line's propMod (a module name, a type id, "${PROP_MOD_MODULE_MWD}" / "${PROP_MOD_MODULE_AB}" or "${PROP_MOD_MODULE_NONE}") becomes each of its ships' propMod; without one a line with a fit takes the fit's microwarpdrive or afterburner ("${PROP_MOD_MODULE_NONE}" when it fits neither), else the hull-sized microwarpdrive. The rest of a fit (EFT text) is stored for later entries, not applied yet.`;

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
      'A hull\'s in-game flight numbers from the EVE data (tools-core\'s SDE): mass (kg), max velocity (m/s), agility, signature radius (m), align time (s) and warp speed (AU/s). They are given as published and as flown by a pilot with every skill at V, optionally with a prop mod running. Name the hull by dna (a scene ship\'s DNA; its hull:faction:race picks the EVE type) or type (an EVE type id or exact name; it wins over dna). propMod is "mwd" or "ab" (the Tech II module sized for the hull), a module\'s EVE name ("500MN Cold-Gas Enduring Microwarpdrive", any case, MWD/AB abbreviated) or type id, or explicit values; withPropMod is the ship with it running, and propModCycleTime its cycle in seconds (the Afterburner skill shortens an afterburner\'s). A ship that fits "none" needs no propMod here. stats overrides the hull\'s values like a scene ship\'s stats. For a ship in the scene, pass its dna, type and stats. Needs a prepared SDE in tools-core unless all four stats are given.',
    inputSchema: {
      type: 'object',
      properties: {
        dna: { type: 'string', description: 'SOF DNA, hull:faction:race[:commands].' },
        type: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'EVE type id or exact English type name.' },
        propMod: { description: '"mwd" or "ab" (sized for the hull), a module name or type id, or { "speedFactor", "speedBoostFactor", "massAddition", "signatureRadiusBonus"?, "duration"?: ms }.' },
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
{ "op": "update_ship", "id": "<id>", "set": { "dna"?, "name"?, "team"?, "position"?, "rotation"?, "type"?, "stats"?, "propMod"? } }
{ "op": "remove_ship", "id": "<id>" }
{ "op": "set_camera", "camera": { ...fields to change } }
{ "op": "set_environment", "environment": { "universe": "res:/..." } }   (reloads the page)
{ "op": "rename", "name": "<name>" }
{ "op": "add_fleet", "fleet": { ...fleet } }   { "op": "update_fleet", "fleet": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_fleet", "fleet": "<id>", "withShips"?: true }
{ "op": "add_wing", "fleet": "<id>", "wing": { ...wing } }   { "op": "update_wing", "fleet", "wing": "<id>", "set": { "name"?, "commander"? } }   { "op": "remove_wing", "fleet", "wing" }
{ "op": "add_squad", "fleet", "wing", "squad": { ...squad } }   { "op": "update_squad", "fleet", "squad": "<id>", "set": { "name"?, "role"?, "commander"?, "anchor"?, "home"? } }   { "op": "remove_squad", "fleet", "squad" }
{ "op": "move_to_squad", "ships": ["<id>"], "fleet", "squad" }   { "op": "remove_from_fleet", "ships": ["<id>"] }
{ "op": "set_anchor", "fleet", "squad", "anchor": { "ship"?, "range"? } }   (merged; null resets ship to the FC and range to the role default)
{ "op": "add_fleet_composition", "composition": { ...${FLEET_COMPOSITION_SCHEMA} }, "position": [x, y, z], "heading"?: <yaw degrees> | "facing"?: [x, y, z], "fleet"?: "<fleet id>", "team"? }   (needs dna on every ship line; the add_fleet_composition tool resolves hull names and saved names first)
{ "op": "add_ships", "dna", "hull"?, "radius"?, "count"?, "formation"?, "spacing"?, "position"? | "near"?: { "ship", "range"?, "direction"? }, "heading"? | "facing"?: [x, y, z] | "<ship id>", "team"?, "name"?, "prefix"?, "stats"?, "propMod"?, "fleet"?, "radii"?: { "<ship id>": metres } }   (the add_ships tool resolves hull names, celestials and radii first)
{ "op": "stage_engagement", "sides": [{ "composition": { ... } | "ships": [{ "dna", ... }], "team"?, "fleet"?, ... }, { ... }], "range"?, "center"? | "near"?: { "ship", ... }, "heading"? }   (every ship line needs its dna; the stage_engagement tool resolves names first)
{ "op": "set_prop_mods", "ships": ["<id>"] | "fleet": "<id>" [, "wing" | "squad": "<id>"], "active"?: true | false, "module"?: "<module>" | null }   (merged into each selected ship's propMod; module null is the hull-sized default)
{ "op": "set_location", "location": { ...location } }   (replaces the location whole; the set_location tool resolves names)
{ "op": "clear_location" }
Taking a ship out of a squad (remove_ship, remove_from_fleet, move_to_squad, remove_squad, remove_wing) falls a squad anchored on it back to its squad commander, then its wing commander, then the FC, with a warning; a fleet commander must be replaced (update_fleet) or its fleet removed first. Removing a fleet, wing or squad keeps its ships in the scene, unless remove_fleet has "withShips": true.
Changing dna rebuilds that ship (it keeps flying); changing position or rotation puts it there at rest. Changing type or stats retunes the ship's flight numbers without a rebuild; stats replaces the whole override object and null clears it. Changing a ship's propMod.module retunes it; changing propMod.active switches its prop mod at once, with no cycle wait (changes.switched counts them); switch_prop_mods is the live, EVE-timed switch.
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
    name: 'add_ships',
    where: 'hub',
    description: `Adds ships of one EVE type to the viewer's live scene in one call: count ships of hull (an EVE type name or id, resolved to SOF DNA and the hull's EVE radius through tools-core), in a formation at a place, facing a heading or a target, on a team, optionally as a new fleet or into a fleet's squad. A shortcut for a one-line fleet template: the result's template is that ${FLEET_COMPOSITION_SCHEMA} composition, ready for save_fleet_composition, add_fleet_composition and stage_engagement.
- formation: ${SHIP_FORMATIONS.map((formation) => `"${formation}"`).join(', ')} (${Object.entries(SHIP_FORMATION_ALIASES)
      .map(([alias, formation]) => `"${alias}" is ${formation}`)
      .join(', ')}). sphere is the default blob; line is abreast; column is astern; wedge is a V behind the lead; grid is ranks of lines behind the lead; wall is rows abreast stacked up and down.
- spacing: metres between neighbours, centre to centre (default ${FORMATION_SPACING} × two radii + ${FORMATION_GAP} m).
- The first ship (the lead) sits at the place: position [x, y, z], or near { ship | celestial, range?, direction? }. range is metres off its surface (default ${DEFAULT_NEAR_SHIP_RANGE} off a ship; off a celestial of the scene's location as set_location's defaults). direction is from it: ${NEAR_DIRECTIONS.join(', ')} or [x, y, z]; ahead, behind, left, right, above and below follow the ship's own heading. Default: ahead off a ship, sun off a celestial. Ships are placed off a ship's document placement, not where it has flown since.
- heading is yaw degrees (0 faces +Z, 90 faces +X; default the near ship's heading, else 0), or facing (a point, a ship id or { celestial }).
- fleet: { new: true, id?, name?, squad?: { id?, role?, anchor? } } makes a new fleet (the first ship is the FC, the rest one squad; the role defaults from the hull's EVE group: logistics are logi, interdictors and interceptors tackle, recons and EAFs ewar, command ships boost, carriers support, the rest dps). { id, squad: "<squad id>" } joins a squad. { id, squad: { id?, role?, anchor? }, wing? } makes a new squad (in the fleet's last wing by default). Fleet members are placed at their formation slots around the FC instead of a formation; joining a squad can move members of later squads, a new squad moves nobody.
- Ids are "<prefix>-01", "-02", ... after the highest number already used (prefix: the hull name; "<fleet>-<squad>" when joining). stats, propMod and team go on every ship.
- Pass scene to add to that document with no tab (returned, not shown). Returns added (ships, lead, fleet), hull (dna, radius and where they came from), template and the patch_scene result. Needs a prepared SDE in tools-core for names, celestials and radii; with dna and radius it needs none.`,
    inputSchema: {
      type: 'object',
      properties: {
        hull: { type: ['string', 'integer'], description: 'An EVE type name ("Rifter", "Tempest Fleet Issue") or type id.' },
        dna: { type: 'string', description: "SOF DNA (hull:faction:race), instead of or to override the hull's." },
        radius: { type: 'number', description: "The hull's EVE radius in metres. Default from the EVE data." },
        count: { type: 'integer', minimum: 1, maximum: MAX_FLEET_SHIPS, description: 'How many ships. Default 1.' },
        formation: { type: 'string', enum: [...SHIP_FORMATIONS, ...Object.keys(SHIP_FORMATION_ALIASES)], description: 'The shape, for ships outside fleets. Default sphere.' },
        spacing: { type: 'number', description: 'Metres between neighbours, centre to centre.' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: "The lead's [x, y, z] in metres. Default [0, 0, 0]." },
        near: {
          type: 'object',
          description: 'Where the lead goes instead of position: off a ship or a celestial of the scene location.',
          properties: {
            ship: { type: 'string' },
            celestial: { type: ['string', 'integer'], description: "A celestial name or id in the scene location's system." },
            range: { type: 'number', minimum: 0, description: 'Metres off its surface.' },
            direction: {
              anyOf: [
                { type: 'string', enum: [...NEAR_DIRECTIONS] },
                { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
              ]
            }
          }
        },
        heading: { type: 'number', description: 'Yaw degrees.' },
        facing: {
          anyOf: [
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            { type: 'string', description: 'A ship id.' },
            { type: 'object', properties: { celestial: { type: ['string', 'integer'] } } }
          ],
          description: 'What the ships face, instead of heading.'
        },
        team: { type: 'string' },
        name: { type: 'string', description: 'The ship name base (default the hull name); ships are "<name> <n>".' },
        prefix: { type: 'string', description: 'The ship id prefix.' },
        stats: { type: 'object', description: "Hull stat overrides for every ship (as a scene ship's stats)." },
        propMod: { description: "Every ship's prop mod: a module, or { module?, active? } (as a scene ship's propMod)." },
        fleet: { type: 'object', description: 'A new fleet { new: true, ... }, a squad to join { id, squad: "<id>" }, or a new squad { id, squad: { ... }, wing? }.' },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      }
    }
  },
  {
    name: 'stage_engagement',
    where: 'hub',
    description: `Stages a fight in the viewer's live scene in one call: two sides facing each other range metres apart (between their front lines; default ${DEFAULT_ENGAGEMENT_RANGE}), centred on center [x, y, z] (default [0, 0, 0]) or near { ship | celestial, range?, direction? } (as add_ships), each on its own team (default "${ENGAGEMENT_TEAMS[0]}" and "${ENGAGEMENT_TEAMS[1]}").
- A side is a composition (a saved or built-in name such as "tfis", or an inline ${FLEET_COMPOSITION_SCHEMA}), or ships: [{ hull, count?, role?, name?, propMod?, dna?, radius? }]. A ship list is a fleet (fleet id: the side's fleet, else the team; the first ship is the FC; each line a squad, its role from the hull's EVE group unless given); with fleet: false it is free ships in a formation (formation, spacing and prefix as add_ships; ids "<team>-01", ...).
- heading is the yaw side A faces; side B faces back. Default 0, or across the line from the near ship or celestial, so both sides stand beside it.
- Hull and composition names resolve through tools-core. Pass scene to stage on that document with no tab.
- Returns engagement (center, heading, range, and per side its team, fleet, commander, ships and lead), hulls and the patch_scene result.`,
    inputSchema: {
      type: 'object',
      properties: {
        sides: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              composition: { type: ['string', 'object'], description: `A saved or built-in composition name, or an inline ${FLEET_COMPOSITION_SCHEMA}.` },
              ships: { type: 'array', items: { type: 'object' }, description: 'Ship lines { hull, count?, role?, name?, propMod?, dna?, radius? }.' },
              team: { type: 'string' },
              fleet: { type: ['string', 'boolean'], description: 'The fleet id, or false for free ships (ship lists only).' },
              name: { type: 'string', description: 'The fleet name.' },
              formation: { type: 'string', enum: [...SHIP_FORMATIONS, ...Object.keys(SHIP_FORMATION_ALIASES)] },
              spacing: { type: 'number' },
              prefix: { type: 'string' }
            }
          }
        },
        range: { type: 'number', minimum: 0, description: `Metres between the front lines. Default ${DEFAULT_ENGAGEMENT_RANGE}.` },
        center: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        near: { type: 'object', description: 'Centre off a ship or a celestial of the scene location: { ship | celestial, range?, direction? }.' },
        heading: { type: 'number', description: 'The yaw side A faces.' },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to stage on instead of the viewer's (no tab needed; returned, not shown).` }
      },
      required: ['sides']
    }
  },
  {
    name: 'get_state',
    where: 'page',
    description: `Live state of the viewer: renderer status, frame rate, camera, and per-ship build status, world position and bounding radius, plus pairwise distances between ships in metres. Each ship also reports its Destiny motion: position and velocity [x, y, z] (metres, m/s), speed, mode (stop, goto, follow, orbit) and the physics it flies with (below). simulation gives the Destiny tick and scene seconds. Motion is the authoritative state; the drawn ships trail it by up to one 1 s tick, as in EVE's client. Ships in a fleet also report fleet, wing, squad, role, commands and anchor (the ship they keep range on, and the range); fleets is the fleet tree with each squad's anchor resolved, plus formation (ready, the FC's heading, and how many members are following, in formation, catching up, holding, warping, leading, detached or waiting); every fleet, wing and squad also reports command (order_fleet): state (idle, moving, warping, broken-off or regrouping), leader, away (a wing or squad flying apart), home (a broken-off squad's), the leader's order while it moves, last (the last order_fleet: order, by, tick), warp (counts aligning, warping, landed, dropped, skipped) and regrouping (ships not yet back). A fleet member other than the FC also reports following: state (in-formation, catching-up, holding while its anchor or FC is in warp, warping in formation with warping naming its leader, leading a wing or squad apart, detached by an explicit order, or waiting for the ships' radii), group (kind, id, leader: while it flies in or leads a wing or squad apart), anchor and range (what it keeps range on), slot (its formation slot: range and direction in the FC's heading frame), distance (metres, surface to surface, to the anchor) and slotError (metres from its slot); its order is keep-at-range on the anchor, and its mode is goto while it steers to its slot and stop once settled. heading is each ship's [yaw, pitch] in degrees, the authoritative heading. Each ship also reports its order (what its ball is flying, with target, range and speed), pendingOrder (given, applying at the next tick), orderNote (why it stopped on its own, such as its target being removed) and targetDistance (metres, surface to surface on the balls' EVE radii, negative when they overlap); distances use the drawn bounding spheres. physics gives mass, agility, maxVelocity, radius (the ball's EVE radius), signatureRadius, alignTime (s) and source: sde (the hull's in-game values via tools-core), stats (the document's four stats) or class (class values when the EVE data cannot name the hull; note says why). location is the scene's EVE location, or null: system (id, name, region, securityStatus), origin (system metres), status (loading, ready or failed, with error), anchor (the celestial it was placed from, with its actual distance and surfaceDistance from the origin), star (distance and direction), and nearby: the ${LOCATION_NEARBY_LIMIT} celestials nearest the origin (id, name, kind, radius, position in scene metres, distance from the origin, surfaceDistance). location.dressing reports what the location drew: state, the nebula, the sun (graphic, environment template, lens flare, distance), counts per kind (drawn, validated without a renderer, loading, failed, skipped) and each dressed planet, moon, station and stargate with its state; environment.nebula says which nebula is drawn and whether it comes from the location or environment.universe. physics is what the ship flies with now: while its prop mod runs, the module's mass, maxVelocity, signatureRadius (the MWD bloom) and alignTime. propMod is null for a ship fitting "${PROP_MOD_MODULE_NONE}", else the module (module as written, name, typeID, kind, size S/M/L/XL, source: sde, baked (built-in values) or default (the hull-sized module standing in, note says why)), state (off, activating, active, stopping), cycleTime (s), since (the tick it started), stopsIn (s, while stopping), note (why it is off, such as entering warp) and its running numbers (maxVelocity, mass, signatureRadius, alignTime). boosters.maxVel stays the prop-mod-off max velocity. Each fleet reports propMods: counts of activating, active, stopping, off and none. audio reports the page's audio (state, the emitters, the last engine events posted, each with played, frameErrors / lastFrameError when the runtime's audio frame failed, and context: the AudioContext's state, where suspended while on means the browser holds it until a click).`,
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
Warp: the ship aligns at full speed toward the destination until it reaches 75 % of max velocity on that heading, as in EVE, then warps at its warp speed (warpSpeedMultiplier AU/s; class values without the SDE) and lands. The landing must be at least ${MIN_WARP_DISTANCE / 1000} km away (use goto nearer). While aligning any order cancels the warp; in warp a ship refuses orders until it lands. A fleet holds while its FC is in warp, then flies to the FC's landing (order_fleet warp warps the whole fleet in formation). get_state shows warp: phase, landing, progress, remaining, landsIn.
Fleets fly in formation on their FC: ordering the FC moves its fleet. Any order above on a fleet member (not the FC) takes it out of formation until rejoin, a fleet edit that regroups it, or load_scene; rejoin is refused for the FC, for a ship in no fleet and for the leader of a wing or squad flying apart (order_fleet regroup brings the group back); an order on that leader keeps it leading (following: "leading").
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
    name: 'switch_prop_mods',
    where: 'page',
    description: `Switches prop mods (MWDs and afterburners) on or off for ships, a whole fleet, a wing or a squad, live, as EVE's module rules do: switching on applies at the next 1 s Destiny tick; switching off lets the running cycle finish (10 s for an MWD, 7.5 s for an AB with max skills, 20 / 15 s capital) and stops at its end. Switching on while stopping keeps it running; off while activating cancels it. A running module swaps the ship's mass and max velocity (and the MWD's signature bloom) for the module's on both Destiny parks; the ship accelerates or slows at its agility. Fleet members keep following in formation at their own, now boosted, speeds; the switch never takes a ship out of formation, so switch the whole fleet to move it faster. Entering warp switches a running module off (it stays off after landing); switching on is refused in warp (allowed while aligning, which slows the align). Ships fitting "${PROP_MOD_MODULE_NONE}" and, switching on, ships in warp are skipped. Live only: not written to the document (set_prop_mods in patch_scene sets the state at load). The engine sound plays on activation and deactivation once the tab has audio on (click the view). delay (0 to 1, default 0) is how slowly the pilots respond: each ship switches after its own pseudo-random time, up to delay × ${MAX_FLEET_ORDER_DELAY} s in whole ticks (the same order at the same tick responds the same way), so a fleet's modules come on staggered. Returns { tick, active, ships: [{ id, module, state, at? (the tick an activation applies), stopsIn? (s), respondsIn? (s until a delayed pilot switches) }], skipped: [{ id, reason }] }; get_state shows each ship's propMod (queued: a switch its pilot has yet to make).`,
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'true switches on, false off.' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." },
        delay: { type: 'number', minimum: 0, maximum: 1, description: `Pilot response: 0 at once (default) to 1 very delayed (each ship up to ${MAX_FLEET_ORDER_DELAY} s).` }
      },
      required: ['active']
    }
  },
  {
    name: 'order_fleet',
    where: 'page',
    description: `Commands a whole fleet, one wing or one squad, as EVE's fleet commands do. Select it with fleet, and optionally wing or squad (a wing or squad order never includes the FC, who heads the whole fleet). by is the ship giving the order. It must command the group: its squad commander, its wing's commander or the fleet commander. Without by, the group's own commander gives the order, else the commander above it. An order from any other ship is refused.
Orders:
{ "type": "direction" | "goto" | "approach" | "keep-at-range" | "orbit" | "stop", ...order_ship's fields } moves the group. The order goes to its leader: for the fleet, the FC; for a wing or squad, its commander, else the giver when it is in the group, else the squad's lead (the member it anchors on), else its first member. The rest follow in formation. A wing or squad then flies apart from its fleet on its leader (get_state following.group, command.away) until regroup. A fleet move leaves groups that fly apart, and detached members, where they are.
{ "type": "warp", "point": [x, y, z] | "target": "<ship id>", "range"? } warps the group in formation: the FC warps the fleet, a wing commander only their wing, a squad commander only their squad. Every ship aligns at once and warps at its own hull warp speed to its slot around the leader's landing, in the warp's heading, so the group lands in formation. Ships that land first hold until the leader has landed; then all follow again. Some ships do not warp and fly to their slot instead (skipped): a ship that cannot move, or one whose slot is under ${MIN_WARP_DISTANCE / 1000} km away. A ship already in warp is skipped too and keeps its own warp. A fleet warp brings every ship that flies apart or is detached back into formation. A warped wing or squad flies apart on its leader until regroup.
{ "type": "anchor", "ship"?: "<ship id>" | null, "range"?: <metres> | null } re-anchors every squad of the group, as set_anchor does: ship null is the FC, range null is the role default.
{ "type": "break-off", "range"?: <metres, default ${DEFAULT_BREAK_OFF_RANGE}>, "ship"?: "<member>" } (a squad only) anchors the squad on its own lead (ship, else its commander, else its current lead, else its first member), range off the FC. The squad's home keeps the anchor it had.
{ "type": "regroup" } brings the group back: broken-off squads get their home anchor back; every ship that flies apart or is detached rejoins its fleet formation; ships ${MIN_WARP_DISTANCE / 1000} km or more from their slot warp to it in formation.
delay (0 to 1, default 0) is how slowly the pilots respond: every ship but the giver takes its own pseudo-random time, up to delay × ${MAX_FLEET_ORDER_DELAY} s in whole ticks (the same order at the same tick responds the same way), before its order or formation warp applies; a formation warp also waits for its leader's. get_state shows respondsIn on a ship whose pilot has yet to respond.
Moves and warps are live and not saved; a future timeline will cue the same object. anchor, break-off and regroup edit the document as patch_scene does. Targets must be outside the group. A wing or squad move and any warp wait until the fleet is planned (get_state fleets[].formation.ready).
Returns { fleet, wing?, squad?, order, by, leader, tick, delays? (each responding ship's seconds, with a delay), ships (the ships it moves; a warp: [{ id, landing }], each ship's predicted slot landing), skipped? ([{ id, reason }]), landing? (a warp: the leader's predicted landing), warping? (a regroup: the ships warping back) }. Document orders also return their operations and the patch result (scene, warnings, changes, and builds: the per-ship build reports). get_state shows each fleet's, wing's and squad's command: its state (idle, moving, warping, broken-off or regrouping), its leader, away, home, the last order_fleet and the warp progress. Each member's following also shows warping and leading.`,
    inputSchema: {
      type: 'object',
      properties: {
        fleet: { type: 'string', description: 'The fleet id.' },
        wing: { type: 'string', description: "With fleet: one wing (its commander and its squads' members, never the FC)." },
        squad: { type: 'string', description: 'With fleet: one squad (its members, never the FC).' },
        by: { type: 'string', description: 'The ship giving the order: a commander of the group (default: its nearest commander).' },
        delay: { type: 'number', minimum: 0, maximum: 1, description: `Pilot response: 0 at once (default) to 1 very delayed (each ship up to ${MAX_FLEET_ORDER_DELAY} s).` },
        order: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...FLEET_ORDER_TYPES] },
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'World position to fly or warp to, metres.' },
            target: { type: 'string', description: 'A ship outside the group to approach, keep range on, orbit or warp to.' },
            range: { anyOf: [{ type: 'number', minimum: 0, maximum: MAX_ORDER_RANGE }, { type: 'null' }], description: 'Metres, surface to surface (warp: short of a point, default 0; anchor: null resets to the role default; break-off: off the FC).' },
            speed: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            ship: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'anchor: the ship to anchor on (null: the FC); break-off: the squad member to lead it.' }
          },
          required: ['type']
        }
      },
      required: ['fleet', 'order']
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
