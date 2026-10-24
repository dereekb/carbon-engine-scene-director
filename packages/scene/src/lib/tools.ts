/**
 * The MCP tool list, shared by the hub (which advertises it) and the page
 * (which implements the page-side tools). `where` says who answers a call:
 * "hub" tools are answered by the Node hub itself, so they work with no
 * browser open; "page" tools are forwarded to the connected viewer tab. The
 * saved-scene tools are hub tools that forward to the tab for `store: "browser"`
 * (and to show an opened scene), so the page still implements them too.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_WARP_IN_STAGGER, MAX_WARP_IN_STAGGER } from './arrivals/arrival';
import { COMPOSITION_ANCHOR_FC, COMPOSITION_ANCHOR_LEAD, FLEET_COMPOSITION_SCHEMA, MAX_FLEET_SHIPS } from './compositions/composition';
import { CALLED_PRE_LOCKS, DEFAULT_ANCHOR_RANGES, DEFAULT_ANCHOR_UP_RANGE, DEFAULT_BREAK_OFF_RANGE, DEFAULT_FORMATION_RADIUS, FLEET_ORDER_TYPES, FORMATION_GAP, FORMATION_SPACING, MAX_FLEET_ORDER_DELAY, SQUAD_ROLES } from './fleets';
import { APPROACH_RANGE, MAX_ORDER_RANGE, MIN_WARP_DISTANCE, SHIP_ORDER_REQUEST_TYPES } from './orders';
import { DEFAULT_CAMERA_FOV, DEFAULT_UNIVERSE, SCENE_SCHEMA } from './scene';
import { PROP_MOD_MODULE_AB, PROP_MOD_MODULE_MWD, PROP_MOD_MODULE_NONE } from './stats';
import { CELESTIAL_KINDS, DEFAULT_STARGATE_LOCATION_RANGE, DEFAULT_STATION_LOCATION_RANGE, LOCATION_NEARBY_LIMIT, MAP_SEARCH_KINDS } from './location';
import { DEFAULT_ENGAGEMENT_RANGE, DEFAULT_NEAR_SHIP_RANGE, ENGAGEMENT_TEAMS, NEAR_DIRECTIONS, SHIP_FORMATION_ALIASES, SHIP_FORMATIONS } from './staging';
import { DEFAULT_OBJECT_RADIUS, MAX_OBJECTS_PER_OPERATION, OBJECT_NEAREST_SHIPS } from './objects/object';
import { ASTEROID_FIELD_SHAPES, DEFAULT_FIELD_COUNT, DEFAULT_FIELD_RADIUS, DEFAULT_ROCK_SIZE, MAX_FIELD_MODELS, MAX_FIELD_ORES, MAX_FIELD_ROCKS } from './asteroids/field';
import { BUILT_IN_FLEET_PERSONALITY_NAMES } from './personalities/examples';
import { MAX_FLEET_REACH } from './personalities/normalize';
import {
  DEFAULT_FLEET_PERSONALITY,
  FLEET_ENGAGE_RULES,
  FLEET_PERSONALITY_SCHEMA,
  FLEET_PROP_MOD_RULES,
  FLEET_REACHES,
  FLEET_STANCES,
  FLEET_SUCCESSION_STEPS,
  FLEET_TARGET_PREFERENCES,
  FLEET_TARGET_ROLES,
  FLEET_TARGET_SWITCHES,
  MAX_FLEET_BACKUPS,
  MAX_FLEET_HANDOVER,
  MAX_FLEET_TARGET_QUEUE,
  MIN_FLEET_HANDOVER
} from './personalities/personality';
import { formatSceneDistance, LARGE_SCENE_DISTANCE, MAX_SCENE_DISTANCE } from './extent';
import { DEFAULT_MOVIE_LETTERBOX, MAX_CUE_OPERATIONS, MAX_PATCH_CUES, MAX_SHIP_STEPS, MAX_TIMELINE_CUES, MAX_TIMELINE_SECONDS, TIMELINE_ACTION_NAMES } from './timeline/timeline';
import { DEFAULT_MOVIE_LEAD_SECONDS, MOVIE_ACTIONS } from './timeline/movie';
import {
  DEFAULT_EXPORT_FPS,
  DEFAULT_EXPORT_HEIGHT,
  DEFAULT_EXPORT_PREROLL_SECONDS,
  DEFAULT_EXPORT_WIDTH,
  MAX_EXPORT_BITRATE,
  MAX_EXPORT_FPS,
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_LETTERBOX,
  MAX_EXPORT_NAME_LENGTH,
  MAX_EXPORT_PREROLL_SECONDS,
  MAX_EXPORT_SECONDS,
  MAX_EXPORT_WIDTH,
  MIN_EXPORT_BITRATE,
  MIN_EXPORT_FPS,
  MIN_EXPORT_LETTERBOX,
  MIN_EXPORT_SIZE,
  MOVIE_EXPORT_ACTIONS,
  MOVIE_EXPORT_CODECS,
  MOVIE_EXPORT_SOURCES
} from './export/command';
import { MODULE_CATEGORIES } from './fitting/categories';
import { HP_DISTRIBUTIONS } from './combat/distributions';
import { HP_SET_INTENTS } from './combat/hp-set';
import { OVERVIEW_DEFAULT_LIMIT, OVERVIEW_DEFAULT_WITHIN } from './piloting/overview';
import { DEFAULT_DISENGAGE, SHIP_STANCE_FORMATIONS, SHIP_STANCE_PROP_MODS, SHIP_STANCE_RANGE_KEYWORDS, SHIP_STANCE_TYPES } from './piloting/stance';
import { AUDIBLE_MAX_RATE, DEFAULT_SNAPSHOT_EVERY_SECONDS, DEFAULT_TIME_BUDGET_MB, DEFAULT_TIME_WINDOW_SECONDS, MAX_SEEK_AHEAD_SECONDS, MAX_SNAPSHOT_EVERY_SECONDS, MAX_TIME_RATE, MAX_TIME_WINDOW_SECONDS, MIN_SNAPSHOT_EVERY_SECONDS, MIN_TIME_RATE, MIN_TIME_WINDOW_SECONDS } from './time/command';
import { MODULE_SWITCH_STATES } from './fitting/switch';
import { AUTO_REPAIR_POLICIES, DEFAULT_AUTO_REPAIR_POLICY, REPAIR_COVER_MARGIN, REPAIR_PRE_LOCKS, REPAIR_PRESSURE_SECONDS, REPAIR_SWITCH_RATIO, REPAIR_TOP_OFF_FRACTION } from './logi';
import { CAMERA_MOVE_TYPES, CAMERA_SHOT_ENDS, CAMERA_SHOT_NAMES, CINEMA_EASINGS, DIRECTOR_HOLD_LIMITS, DIRECTOR_PACE_NAMES, DIRECTOR_PACES, DIRECTOR_SCALES, ENGAGEMENT_HARDPOINT_NAMES, GROUP_HARDPOINT_NAMES, LANDMARK_HARDPOINT_NAMES, SHIP_HARDPOINT_NAMES } from './cinema';

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

const STANCE_SHAPE_TEXT = `{ "type"?: ${SHIP_STANCE_TYPES.join('|')}, "on"?: "focus" | "<ship id>" | { "squad": "<id>" } | { "wing": "<id>" } (its leader), "range"?: <metres> | [min, max] | ${SHIP_STANCE_RANGE_KEYWORDS.join('|')}, "propMods"?: ${SHIP_STANCE_PROP_MODS.join('|')}, "formation"?: ${SHIP_STANCE_FORMATIONS.join('|')} (a fleet's, wing's or squad's), "disengage"?: <HP fraction in [0, 1) to burn out at, default ${DEFAULT_DISENGAGE}> }`;

const STANCE_TEXT = `"stance" on a fleet, wing, squad or ship is how its pilots fly: ${STANCE_SHAPE_TEXT}. A ship's resolves from its own, else its squad's, else its wing's, else its fleet's (the FC: its own, else the fleet's): type, on and range together from the nearest that sets type; propMods, formation and disengage key by key. A group's stance is flown in line by its leader (the FC for a fleet; a wing's or squad's leader as order_fleet picks it), the members holding formation on it; formation "loose" makes every member fly it alone (with no type: logi support, tackle tackle, the rest auto); a ship's own stance flies that ship alone. No stance anywhere: members hold formation on the FC. order_fleet and order_ship { "type": "stance", "set" | "clear" } set it live. An "on" ship, squad or wing that is removed falls back to the focus, with a warning. The page's pilots fly them every tick: a ship flown by its own or a loose stance leaves its formation while it does (an in-line wing or squad stance flies apart on its leader), a live stance order is taken up after each pilot's response, and a stance on a personality fleet's acting FC takes its brain's move and prop mods levers. order_ship (not a stance order), switch_prop_mods, or switch_modules on its prop mod, point, scram or web takes a piloted ship over until a stance order names it or it rejoins. get_state ships[].stance reports each one's state, focus, window, why and last calls; get_overview's stance block the same.`;

const SCENE_FORMAT = `Scene document (${SCENE_SCHEMA}). Metres and degrees, Y up.
{
  "schema": "${SCENE_SCHEMA}",
  "name": "duel",
  "environment": { "universe": "${DEFAULT_UNIVERSE}" },
  "camera": { "target": "<ship or object id, or null to frame every ship>", "distance": <metres or null to fit>, "yaw": 45, "pitch": -15, "fov": ${DEFAULT_CAMERA_FOV} },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "name": "Punisher", "team": "red", "position": [0, 0, 0], "rotation": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
dna is a SOF DNA string, hull:faction:race[:commands]; use search_hulls to find hull names. rotation is [yaw, pitch, roll].
camera.fov is the vertical field of view in degrees (5 to 120, default ${DEFAULT_CAMERA_FOV}); above an aspect of 1.6 the view keeps its 16:10 width and narrows in height, as Carbon does.
"type" (EVE type id or name) and "stats" ({ "mass": kg, "maxVelocity": m/s, "agility", "signatureRadius": m }, each optional) set a ship's flight numbers; ship_stats shows them.
"propMod" is the ship's propulsion module and its state at load: "<module>" or { "module"?: "<module>", "active"?: true }, where a module is an EVE type name ("50MN Microwarpdrive II"), a type id, "${PROP_MOD_MODULE_MWD}" / "${PROP_MOD_MODULE_AB}" (the Tech II module of that kind sized for the hull) or "${PROP_MOD_MODULE_NONE}". Omitted: the hull-sized Tech II microwarpdrive, off. "active": true runs it from the moment the scene loads; switch_prop_mods switches it live.
"fit" is the ship's EVE fit: EFT text ("[Hull, Fit name]\nDamage Control II\n...", as the game or Pyfa copies it) or a key of the top-level "fits" ({ "<key>": "<EFT text>" }; keys are 1-64 letters, digits, "_", "-" or ".", optionally twice with one "/"). A fleet composition's ships carry "<composition id>/<fit key>" and the scene keeps each text once. With a fit and no propMod.module, the ship's prop mod is the fit's first microwarpdrive or afterburner ("${PROP_MOD_MODULE_NONE}" when it fits neither). A string type naming another hull than the fit's header warns.
"pilot" on a ship holds its pilot's traits: { "command"?: 0-1 (FC ability: a pilot with it can command), "reaction"?: 0-1 (how fast it answers fleet orders) }, higher is better. reaction times every order_fleet, switch_prop_mods and switch_modules given without delay (in a personality fleet an unset reaction is a seeded draw); command is the pilot's FC ability in a personality fleet (the FC's decision delay, who succeeds it and how fast; in a personality fleet the FC and its backups draw one when unset, and a pilot that sets it is FC-capable). A pilot name and other pilot keys are reserved for later phases: stored, not used.
"orders" on a ship is its own script, steps it flies in turn from play start: [{ "after"?: <seconds to wait first>, "type": "<an order_ship order type>", ...that order's fields, "duration"?: <seconds it lasts> }] (at most ${MAX_SHIP_STEPS}). Without a duration a step ends when its order completes: a warp lands, a goto arrives, a stop halts, a rejoin is given; direction, approach, keep-at-range and orbit never complete, so they need a duration unless they are the last step. A target that is no ship or object id is a name, resolved when the step runs.
${STANCE_TEXT}
"timeline" is the scene's script: { "cues": [{ "id"?: "<default cue-<n>>", "at": <seconds from play start, up to ${MAX_TIMELINE_SECONDS}; it fires on the first 1 s tick at or after it>, "name"?, "<action>": <that tool's arguments> }] } (a bare array is shorthand; at most ${MAX_TIMELINE_CUES} cues). The action is one of ${TIMELINE_ACTION_NAMES.join(', ')}: order_ship takes { id, order }, patch_scene { operations } (document ops such as a warp-in add_fleet_composition or add_ships with dna filled; up to ${MAX_CUE_OPERATIONS}, no timeline ops or set_environment; at most ${MAX_PATCH_CUES} patch cues), the rest exactly their tool's arguments. Cues are checked against the scene as it will be when they fire (patch cues apply in time order, so a cue may order a fleet an earlier cue adds); a patch cue records the ids it adds ("adds", derived) and an edit taking one of them is refused. An event cue gives "when" instead of (or with) "at": { "<kill | arrival | warp | cue | primary | fire>": <filter>, "count"?: <the nth match, default 1>, "after"?: <s>, "latest"?: <timeline s: fire then if the event has not come> }, filters kill { ship?, team?, fleet?, wing? | squad?, primary?: "<fleet id: the victim was its called primary>", by?: { ship?, team?, fleet? } }, arrival { fleet?, ship?, phase?: "first" | "landed" (default) | "formed" }, warp { ship?, team?, fleet?, phase?: "exit" (default) | "enter", arrival?: true | false }, cue "<cue id>" (when it fires), primary { fleet, wing? | squad?, ship? } (a group's called primary changes), fire { ship?, team?, fleet?, target? } (a ship opening fire after 10 s quiet); "{}" matches any. Its "at" is when it arms (earlier events do not count), else "arms" is derived: the first second everything it names exists. It is "waiting" until its event, then due max(1, ceil(after)) s after the second the event happened in (never on the event's own tick), or at its latest; the page takes the events from the simulation's ticks (kills, warp-in landings, warps, called primaries, shots, fired cues), so an event cue fires on the same tick in every run (get_state timeline.waiting, timeline.events). "movie"?: { "letterbox"?: <aspect in [0.5, 4], default 2.39, or false>, "hud"?: <default false>, "end"?: <timeline s> } is the movie's look while the timeline plays and where it ends. Removing a ship, object, fleet, wing or squad drops the cues and steps naming it (an event cue's filter subject too, and the cues chained on a dropped cue), with a warning; remove_cue of a cue another waits for is refused. The page plays the script on Destiny's 1 s ticks: a load of a scripted scene holds the scene clock while every hull's numbers, fit and build settle (get_state timeline.preparing), then t = 0 is the next tick; each cue runs as its tool call made just before its tick (ship steps first, then cues in stored order: by time, an event cue's by its arm time, timed before event cues, then document order). Document cues (patch_scene, auto_repair, order_fleet anchor / break-off / regroup) change the live scene only: get_scene and save_scene keep the authored document (get_scene { live: true } shows the live one), and a load, open_scene, a tab reload or timeline restart replays the script from the placements. Cues added while it plays fire if their time is still ahead; an edit of the cues or ships' orders that reaches into the past re-simulates the scene from the last time-control snapshot before it back to now (the result's resimulated says from when), so the run is the one the edited script makes ("missed" only when the time window cannot reach back: movie retake replays the movie with it); a scene that gains its first cue is "stopped" until timeline play. Author cues with the tools: every lever tool (order_ship, order_fleet, switch_prop_mods, switch_modules, set_target, engage, cease_fire, auto_repair, play_shot, play_sequence, stop_shot, patch_scene) and add_fleet_composition, add_ships, stage_engagement and add_objects take at or when (and cue, its id): the call becomes a cue instead of running now.
"personalities" (optional) holds custom fleet personalities by key (not a built-in name): { "<key>": { "schema": "cjs-fleet-personality/1", "extends"?: "<built-in or key; default line>", "name"?, "description"?, "command"?: { "ability"?: 0-1 | [lo, hi], "backups"?, "succession"?: ["most-able"|"chain"|"anyone"], "handover"?: <s> }, "pilots"?: { "reaction"?: 0-1 | [lo, hi] }, "engage"?: "on-sight"|"in-range"|"when-attacked", "targeting"?: { "priority"?: ["fc"|"<squad role>"], "prefer"?, "reach"?: "lock"|"optimal"|"falloff"|<m>, "queue"?, "switch"?: "on-kill"|"on-better", "freeFire"? }, "movement"?: { "stance"?: "brawl"|"kite"|"snipe"|"hold", "range"?, "propMods"?: "never"|"closing"|"always" } } }; unset fields take their base's. A fleet's "personality" names a built-in (${BUILT_IN_FLEET_PERSONALITY_NAMES.join(', ')}) or a key; its FC brain runs the fight (calls, free fire, the FC's moves and the prop mods, as order_fleet and switch_prop_mods calls with the FC as by; get_state fleets[].fc), and its pilots' reaction draws time orders given without delay.
"fleets" (optional) groups ships into EVE fleets: [{ "id", "name"?, "commander": "<FC ship id>", "personality"?: "<built-in or personalities key>", "wings": [{ "id", "name"?, "commander"?, "squads": [{ "id", "name"?, "role": "${SQUAD_ROLES.join('|')}", "commander"?: "<a member>", "members": ["<ship id>"], "anchor"?: { "ship"?: "<ship id; default the FC>", "range"?: <metres, surface to surface; default logi ${DEFAULT_ANCHOR_RANGES.logi}, others ${DEFAULT_ANCHOR_UP_RANGE}> }, "home"?: { "ship"?, "range"? }, "targets"?, "autoRepair"? }], "targets"?, "autoRepair"? }], "targets"?: ["<ship or object id>"], "autoRepair"?: { "on"?: true|false, "policy"?: "urgent"|"damaged"|"shot-at" } }] (home is set by order_fleet break-off: the anchor regroup restores; targets, on a fleet, wing or squad, are its opening called targets in kill order, which a load starts the fight with and order_fleet's targets order then changes live: the first live one is its primary, the live rest its queue; autoRepair, on a fleet, wing or squad, is its logi auto-repair, each key taken from the nearest group that sets it (squad, wing, fleet), by default on for logi squads with policy urgent). A squad anchored on one of its own members (a logi anchor) puts that ship at range off the FC, and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m. A ship holds positions in one fleet and sits in at most one squad. Fleet members keep range on their anchors in formation behind the FC (get_state "following"). "team" is independent of fleets.
"location" (optional) puts the scene at a real EVE place: { "system": <solar system id>, "name"?: "<system>", "region"?: "<region>", "origin": [x, y, z] (system metres: where the scene's [0, 0, 0] sits; the star is at [0, 0, 0]), "anchor"?: { "celestial": <id>, "name"?, "kind"?: "${CELESTIAL_KINDS.join('|')}", "offset"?: [x, y, z] (metres from the celestial's centre to the origin) } }. Use the set_location tool to fill it from a name. Ships stay in scene metres around the origin. A location dresses the scene: the region's nebula replaces environment.universe (which applies only without a location), and the star, nearby planets and moons, and NPC stations and stargates are drawn around the origin.
"objects" (optional) are static EVE objects: stations, stargates, Upwell structures, large collidable objects and wrecks: [{ "id", "dna": "<SOF DNA>", "type"?: <EVE type id or name>, "name"?, "position": [x, y, z], "rotation": [yaw, pitch, roll], "radius"?: <metres: the type's SDE radius, or a wreck's model radius> }]. Ids are unique across ships and objects. The add_objects tool fills dna and radius from a type. Objects never move; ships can approach, keep at range on, orbit and warp to them (ranges on radius, else the model's bounding radius, else ${DEFAULT_OBJECT_RADIUS} m). Objects never collide with ships.
"asteroidFields" (optional) are seeded asteroid fields: [{ "id", "name"?, "position": [x, y, z] (the centre), "rotation": [yaw, pitch, roll], "shape": ${ASTEROID_FIELD_SHAPES.join(' | ')}, "radius", "innerRadius"?, "thickness"? and "arc"? (disc and ring), "count" (at most ${MAX_FIELD_ROCKS.toLocaleString('en-US')}), "size": [min, max] (rock radii, metres), "seed", "ores": [{ "ore"?, "type"?, "faction"?, "weight"?, "rocks": { "small": [dna, ...], "medium": [...], "large": [...] } }] }]. The seed expands a field into the same rocks everywhere; ids are unique across ships, objects and fields; the whole field fits the scene's ${formatSceneDistance(MAX_SCENE_DISTANCE)}. Rocks are scenery: no Destiny balls, not order targets. The add_asteroid_field tool fills ores from EVE ore names. The page draws each field instanced (a few draws per rock model), and get_state lists it under asteroidFields.
Scene extent: a ship or object position more than ${formatSceneDistance(MAX_SCENE_DISTANCE)} from [0, 0, 0] is refused, as an EVE grid; placements past ${formatSceneDistance(LARGE_SCENE_DISTANCE)} warn. Use set_location to move the origin.`;

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
A ship line is { "hull": "<EVE type name or type id>", "count"?: 1, "dna"?: "<SOF DNA>", "radius"?: <the hull's EVE radius>, "name"?, "propMod"?, "fit"?: "<key of fits>", "pilot"?: { "command"?, "reaction"? } }; the commander is a line without count. A top-level "personality"?: "<built-in or saved personality name>" becomes the fleet's personality (the tools embed a saved one in the scene). role is ${SQUAD_ROLES.join('|')}.
anchor is { "on"?: "${COMPOSITION_ANCHOR_FC}" | "${COMPOSITION_ANCHOR_LEAD}" | "<squad id>", "range"?: <metres, surface to surface> }. Defaults: squads keep ${DEFAULT_ANCHOR_UP_RANGE} m on the FC; logi default to "${COMPOSITION_ANCHOR_LEAD}": their first ship keeps ${DEFAULT_ANCHOR_RANGES.logi} m on the FC and the rest anchor up on it at ${DEFAULT_ANCHOR_UP_RANGE} m; "on" a squad id anchors on that squad's first ship.
Ships are placed at rest in formation: each at its anchor range on shells trailing the FC's heading, at least ${FORMATION_SPACING} x (r1 + r2) + ${FORMATION_GAP} m apart on EVE radii (${DEFAULT_FORMATION_RADIUS} m when unknown), all facing the heading. Ids: fleet "<id>" (numbered "<id>-2", ... when taken), ships "<fleet>-fc" and "<fleet>-<squad>-<nn>". At most ${MAX_FLEET_SHIPS} ships with the FC.
A line's propMod (a module name, a type id, "${PROP_MOD_MODULE_MWD}" / "${PROP_MOD_MODULE_AB}" or "${PROP_MOD_MODULE_NONE}") becomes each of its ships' propMod; without one a line with a fit takes the fit's microwarpdrive or afterburner ("${PROP_MOD_MODULE_NONE}" when it fits neither), else the hull-sized microwarpdrive. Each line ship carries its fit: the scene keeps the text once in its fits under "<composition id>/<fit key>" (a second fleet of the composition reuses it; other text under that key gets "<fleet id>/<fit key>").`;

const choices = (values: readonly string[]): string => values.map((value) => `"${value}"`).join('|');

const FLEET_PERSONALITY_FORMAT = `Fleet personality (${FLEET_PERSONALITY_SCHEMA}): an FC's playstyle a fleet runs its fight by. Every field is optional but id; an unset one takes the template's base (extends: a built-in or a saved name; default "${DEFAULT_FLEET_PERSONALITY}", which sets them all).
{ "schema": "${FLEET_PERSONALITY_SCHEMA}", "id": "my-brawler", "extends": "brawler", "name": "My brawler", "description": "<when to pick it>",
  "command": { "ability": 0-1 | [lo, hi] (the FC's and backups' command ability: 1 decides at once, 0 up to 10 s late), "backups": 0-${MAX_FLEET_BACKUPS} (FC-capable members besides the FC), "succession": [${choices(FLEET_SUCCESSION_STEPS)}] (who takes over when the FC dies, steps tried in order), "handover": ${MIN_FLEET_HANDOVER}-${MAX_FLEET_HANDOVER} (seconds: the longest handover, for a successor of ability 0) },
  "pilots": { "reaction": 0-1 | [lo, hi] (how fast members answer fleet orders: 1 at once, 0 up to 10 s late) },
  "engage": ${choices(FLEET_ENGAGE_RULES)} (open fire at the first hostile in lock range, once a target is in reach, or only once shot),
  "targeting": { "priority": [${choices(FLEET_TARGET_ROLES)}] (call order by role; fc is the enemy FC; unlisted roles rank last), "prefer": ${choices(FLEET_TARGET_PREFERENCES)} (within a tier), "reach": ${choices(FLEET_REACHES)} | <metres, at most ${MAX_FLEET_REACH}> (how far out it calls), "queue": 0-${MAX_FLEET_TARGET_QUEUE} (targets queued behind the primary), "switch": ${choices(FLEET_TARGET_SWITCHES)} (leave the primary only once it dies, or also for a higher tier in reach), "freeFire": true|false (members without a call shoot the nearest hostile they reach) },
  "movement": { "stance": ${choices(FLEET_STANCES)}, "range": ${choices(FLEET_REACHES)} | <metres> (what the stance keeps on its focus), "propMods": ${choices(FLEET_PROP_MOD_RULES)} } }
An ability or reaction [lo, hi] is a seeded draw per pilot; a ship's pilot { command?, reaction? } overrides it.`;

const PERSONALITY_ARGUMENT = {
  type: ['string', 'object'],
  description: `A built-in (${BUILT_IN_FLEET_PERSONALITY_NAMES.join(', ')}) or saved personality name, or an inline ${FLEET_PERSONALITY_SCHEMA} template; a saved or inline one is embedded in the scene's personalities.`
};

const OBJECT_LINE_PROPERTIES = {
  type: { type: ['string', 'integer'], description: 'An EVE type name ("Astrahus", "Ruined Stargate", "Minmatar Frigate Wreck") or type id.' },
  dna: { type: 'string', description: "SOF DNA, instead of or to override the type's." },
  radius: { type: 'number', description: "Metres: the ball's radius ranges are measured on. Default the type's SDE radius; a wreck (whose SDE radius is a 14 m placeholder) or a type without one takes its model's bounding radius." },
  id: { type: 'string', description: 'The id of a single object.' },
  name: { type: 'string' },
  prefix: { type: 'string', description: 'The id prefix for several.' },
  count: { type: 'integer', minimum: 1, maximum: MAX_OBJECTS_PER_OPERATION },
  formation: { type: 'string', enum: [...SHIP_FORMATIONS, ...Object.keys(SHIP_FORMATION_ALIASES)] },
  spacing: { type: 'number', description: 'Metres between neighbours, centre to centre.' },
  position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
  near: { type: 'object', description: '{ ship | object | celestial, range?, direction? }' },
  heading: { type: 'number', description: 'Yaw degrees.' },
  facing: { description: 'A point [x, y, z], a ship or object id, or { celestial }.' },
  rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[yaw, pitch, roll] degrees.' }
};

const WARP_IN_TEXT = `warpIn: true or { stagger?, together?, from? } lands the ships from warp instead of placing them: they wait off-grid, warp in at their own hull warp speed (Destiny's NPC warp-in, no align) and drop out at their placements within stagger seconds of each other (default ${DEFAULT_WARP_IN_STAGGER}, max ${MAX_WARP_IN_STAGGER}; the FC or lead first), then form up. The warp-ins start once their hulls are built and their flight numbers are in. together (default true) lands the group within stagger of its slowest hull, as a fleet warp does; false lands each hull at its own pace. from (a point, a ship or object id, or { celestial }) is where they warp in from: it sets the heading, so not with heading or facing; default along the heading. Until a ship lands, orders, prop mods and modules on it are refused; the result's arrivals and get_state.arrivals report each group (waiting, scheduled, warping, landed, forming-up, formed, with lands { first, last } in seconds); play_shot { shot: "warp-in", fleet | ships } watches them land. With scene (no tab) the document just places them at their landings, with a warning.`;

const WARP_IN_ARGUMENT = {
  anyOf: [
    { type: 'boolean' },
    {
      type: 'object',
      properties: {
        stagger: { type: 'number', minimum: 0, maximum: MAX_WARP_IN_STAGGER, description: `Seconds the landings spread over, the leader first. Default ${DEFAULT_WARP_IN_STAGGER}.` },
        together: { type: 'boolean', description: 'Land within stagger of the slowest hull (default true), or each hull at its own pace.' },
        from: {
          anyOf: [
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            { type: 'string', description: 'A ship or object id.' },
            { type: 'object', properties: { celestial: { type: ['string', 'integer'] } } }
          ],
          description: 'Where they warp in from; sets the heading.'
        }
      }
    }
  ],
  description: 'Land from warp: true, or { stagger?, together?, from? }.'
};

/**
 * load_scene / open_scene's `timeline`: play the scene's script once it prepared (default), or hold at t = 0.
 */
const TIMELINE_START_ARGUMENT = {
  type: 'string',
  enum: ['play', 'pause'],
  description: 'A scripted scene (timeline cues or ship orders): "play" (default) plays it from t = 0 once the scene prepared; "pause" holds it at t = 0 (ready) until timeline play.'
};

const STORE_ARGUMENT = {
  type: 'string',
  enum: ['disk', 'browser'],
  description: "disk: scene files kept by the hub; browser: the viewer tab's IndexedDB."
};

/**
 * The hub's scene-building tools that take `at`: they resolve names now and store their resolved op in a patch_scene
 * cue.
 */
export const CUEABLE_HUB_TOOL_NAMES = ['add_fleet_composition', 'add_ships', 'stage_engagement', 'add_objects'] as const;

/**
 * Every tool that takes `at` and `cue`: the timeline's actions (the page's levers) and the hub's scene-building tools.
 * With `at` a call becomes a timeline cue instead of running now.
 */
export const CUEABLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([...TIMELINE_ACTION_NAMES, ...CUEABLE_HUB_TOOL_NAMES]);

const AT_ARGUMENT = { type: 'number', minimum: 0, maximum: MAX_TIMELINE_SECONDS, description: 'Seconds of timeline time (from play start): the call becomes a timeline cue that runs then, instead of running now.' };

const CUE_ARGUMENT = { type: 'string', description: 'With at or when: the cue id (default the lowest free "cue-<n>").' };

const WHEN_ARGUMENT = {
  type: 'object',
  description: 'An event the call waits for: the call becomes an event cue that runs max(1, ceil(after)) s after it. One of kill, arrival, warp, cue, primary, fire with its filter ({} matches any), plus count, after and latest (timeline s: run then if the event has not come). With at, at is when it arms.',
  properties: {
    kill: { type: 'object', description: '{ ship?, team?, fleet?, wing? | squad?, primary?: "<fleet id>", by?: { ship?, team?, fleet? } }' },
    arrival: { type: 'object', description: '{ fleet?, ship?, phase?: "first" | "landed" (default) | "formed" }' },
    warp: { type: 'object', description: '{ ship?, team?, fleet?, phase?: "exit" (default) | "enter", arrival?: boolean }' },
    cue: { type: 'string', description: 'A cue id: when that cue fires.' },
    primary: { type: 'object', description: "{ fleet, wing? | squad?, ship? }: the group's called primary changes." },
    fire: { type: 'object', description: '{ ship?, team?, fleet?, target?: { ship?, team?, fleet? } }: a ship opening fire after 10 s quiet.' },
    count: { type: 'integer', minimum: 1, maximum: 1000, description: 'The nth matching event (default 1).' },
    after: { type: 'number', minimum: 0, maximum: MAX_TIMELINE_SECONDS, description: 'Seconds after the event.' },
    latest: { type: 'number', minimum: 0, maximum: MAX_TIMELINE_SECONDS, description: 'Timeline seconds: run then if the event has not come.' }
  }
};

const CUE_TEXT = `With at (seconds from play start, up to ${MAX_TIMELINE_SECONDS}) nothing runs now: the call is checked against the scene as it will be then and becomes a timeline cue (cue: its id) that runs as this same call on the first 1 s tick at or after at. With when (an event: { kill | arrival | warp | cue | primary | fire: <filter>, count?, after?, latest? }) it becomes an event cue instead, waiting for that event (at, if given, is when it arms; else it arms once everything it names exists) and running max(1, ceil(after)) s after it. Returns { cue (as stored), state (pending; a cue behind a playing timeline re-simulates the scene from before it, so it comes back fired: resimulated { from, to, ticks, ms } says from when, null when it changed only the future; missed, playing from the next restart, only when the time window cannot reach back: movie retake replays the movie with it), timeline (get_state's report), warnings }. A stopped timeline (a live scene's first cue) starts with timeline play; timeline restart replays it from the placements.`;

const HUB_CUE_TEXT = `${CUE_TEXT} Names, celestials, radii and near places resolve now, on the scene as it will be at that time (get_scene { at }: near may name a ship an earlier cue adds); the cue holds the resolved patch_scene operations, and cue.adds the ids it adds.`;

/**
 * A cueable tool: `at` and `cue` in its arguments and the cue sentence in its text.
 *
 * @param tool - The tool.
 * @returns The tool with them.
 */
function cueable(tool: ToolDefinition): ToolDefinition {
  const text = (CUEABLE_HUB_TOOL_NAMES as readonly string[]).includes(tool.name) ? HUB_CUE_TEXT : CUE_TEXT;
  return { ...tool, description: `${tool.description}\n${text}`, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, at: AT_ARGUMENT, when: WHEN_ARGUMENT, cue: CUE_ARGUMENT } } };
}

/**
 * set_hp's HP amount: a number of HP, or a percent of the max.
 */
const HP_AMOUNT_SCHEMA = {
  anyOf: [
    { type: 'number', minimum: 0 },
    { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*%\\s*$' }
  ]
};

/**
 * set_hp's value: an amount, or a seeded random draw.
 */
const HP_VALUE_SCHEMA = {
  anyOf: [
    ...HP_AMOUNT_SCHEMA.anyOf,
    {
      type: 'object',
      properties: { min: HP_AMOUNT_SCHEMA, max: HP_AMOUNT_SCHEMA, distribution: { type: 'string', enum: [...HP_DISTRIBUTIONS] }, mean: HP_AMOUNT_SCHEMA, sd: HP_AMOUNT_SCHEMA, mode: HP_AMOUNT_SCHEMA },
      required: ['min', 'max']
    }
  ]
};

const TOOL_LIST: ToolDefinition[] = [
  {
    name: 'viewer_status',
    where: 'hub',
    description:
      'Reports whether a viewer tab is connected, the URL to open, eveData (mode tools-core, or off: no-EVE-data mode, --eve-data off / SCENE_DIRECTOR_EVE_DATA=off on a machine without tools-core, where ships and objects draw as stand-in cubes on a green screen and the tools that need EVE data refuse, with a note) and, with EVE data, whether tools-core (the EVE data service) is reachable (toolsCore; null with EVE data off). Call this first if other tools fail.',
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
      "A hull's in-game flight numbers from the EVE data (tools-core's SDE): mass (kg), max velocity (m/s), agility, signature radius (m), align time (s) and warp speed (AU/s). They are given as published and as flown by a pilot with every skill at V, optionally with a prop mod running. Name the hull by dna (a scene ship's DNA; its hull:faction:race picks the EVE type) or type (an EVE type id or exact name; it wins over dna). propMod is \"mwd\" or \"ab\" (the Tech II module sized for the hull), a module's EVE name (\"500MN Cold-Gas Enduring Microwarpdrive\", any case, MWD/AB abbreviated) or type id, or explicit values; withPropMod is the ship with it running, and propModCycleTime its cycle in seconds (the Afterburner skill shortens an afterburner's). A ship that fits \"none\" needs no propMod here. stats overrides the hull's values like a scene ship's stats. For a ship in the scene, pass its dna, type and stats. Needs a prepared SDE in tools-core unless all four stats are given (with the hub's EVE data off, all four are required). With fit (EFT text; the hull defaults to its header's) the numbers come from EVE's dogma over the fitted modules (online, /OFFLINE ones off), the hull's traits and the skills, stacking penalties included: stats then adds defense (HP, resonances, resists and omni EHP per layer, shield recharge), capacitor (capacity, recharge, drain, stable) targeting and weapons (the turrets and launchers summed: turrets, launchers, volley, paper dps and dps by damage type), fit lists the modules by key (low-0, mid-1, ...; each with cycleTime (s: a gun's rate of fire), range and falloff (m) when it has them; a turret also damage (per shot by type, before EVE's hit quality), volley, dps, tracking and signatureResolution, a vorton projector its explosion and an entropic disintegrator its spool; a missile launcher damage (per missile by type, with Ballistic Control Systems), volley, dps, its missile's velocity (m/s), flightTime (s), missileRange ({ lower, upper, upperChance, mean } m: a missile flies whole seconds, the longer case with that chance) and explosion (radius, velocity, drf); empty guns load a fitting charge from the cargo, empty launchers a fitting missile or else the hull race's Tech I missile (note \"default missile\")) ...) with their categories and the names tools-core does not know, withPropMod runs the fit's prop mod, and active (module keys, categories such as \"hardener\" or \"armor-repairer\", \"all\", or module names) gives withActive with those modules running. trace adds every dogma step behind those numbers. Not modelled: implants, boosters, command bursts, heat, drones, fitting limits, effects on other ships. A fit needs the SDE; without it the hull flies with the fit's prop mod, with a fitNote.",
    inputSchema: {
      type: 'object',
      properties: {
        dna: { type: 'string', description: 'SOF DNA, hull:faction:race[:commands].' },
        type: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'EVE type id or exact English type name.' },
        propMod: { description: '"mwd" or "ab" (sized for the hull), a module name or type id, or { "speedFactor", "speedBoostFactor", "massAddition", "signatureRadiusBonus"?, "duration"?: ms }.' },
        stats: { type: 'object', description: '{ "mass": kg, "maxVelocity": m/s, "agility", "signatureRadius": m }, each optional; replaces the published values before skills.' },
        pilot: { type: 'object', description: '{ "skills": { "Navigation": 4 }, "defaultLevel": 5 }; every skill at V when omitted' },
        fit: { type: 'string', description: 'An EFT fit ("[Hull, Fit name]" then the modules); not with propMod.' },
        active: { type: 'array', items: { type: 'string' }, description: 'Modules to run in withActive: keys ("mid-0"), categories ("hardener"), "all" or names. Needs fit.' },
        trace: { type: 'boolean', description: "Add every dogma step behind the fit's numbers." }
      }
    }
  },
  {
    name: 'search_map',
    where: 'hub',
    description: `Searches CCP's static EVE map (tools-core's SDE) by name: ${MAP_SEARCH_KINDS.join(', ')}. The match is a case-insensitive substring, exact names first, then prefixes, then shorter names. Moons and asteroid belts are not searchable: get_system lists them, and set_location takes their full names. Stargates are named after their destination ("Stargate (Perimeter)"), so a gate name matches in every system with one; each celestial hit reports its system, and each system hit its region and security status. Needs a prepared SDE in tools-core. stats also give warpScrambleStatus (the hull and its modules: a warp core stabilizer lowers it, siege raises it; above 0 it cannot warp).`,
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
      properties: { scene: { type: 'object', description: 'The scene document.' }, timeline: TIMELINE_START_ARGUMENT },
      required: ['scene']
    }
  },
  {
    name: 'get_scene',
    where: 'page',
    description:
      "Returns the current scene document as JSON: the authored document, its timeline included. A timeline's document cues (a warp-in add, an anchor order) change only the live scene: live: true returns that instead; at returns the authored document as it will be at that timeline time (the patch cues due by then applied, its timeline left out).",
    inputSchema: {
      type: 'object',
      properties: {
        live: { type: 'boolean', description: 'The live scene: the authored document without its timeline, plus what its cues changed.' },
        at: { type: 'number', minimum: 0, description: 'Seconds of timeline time: the document projected to then.' }
      }
    }
  },
  {
    name: 'patch_scene',
    where: 'page',
    description: `Edits the current scene with a list of operations, applied in order, then updates the viewer to match. Operations:
{ "op": "add_ship", "ship": { ...ship } }
{ "op": "update_ship", "id": "<id>", "set": { "dna"?, "name"?, "team"?, "position"?, "rotation"?, "type"?, "stats"?, "propMod"?, "fit"?, "pilot"?, "orders"?, "stance"? } }   (null clears type, stats, propMod, fit, pilot, orders and stance)
{ "op": "remove_ship", "id": "<id>" }
{ "op": "set_camera", "camera": { ...fields to change } }
{ "op": "set_environment", "environment": { "universe": "res:/..." } }   (reloads the page)
{ "op": "rename", "name": "<name>" }
{ "op": "add_fleet", "fleet": { ...fleet } }   { "op": "update_fleet", "fleet": "<id>", "set": { "name"?, "commander"?, "personality"?, "targets"?, "autoRepair"?, "stance"? } }   { "op": "remove_fleet", "fleet": "<id>", "withShips"?: true }
{ "op": "add_wing", "fleet": "<id>", "wing": { ...wing } }   { "op": "update_wing", "fleet", "wing": "<id>", "set": { "name"?, "commander"?, "targets"?, "autoRepair"?, "stance"? } }   { "op": "remove_wing", "fleet", "wing" }
{ "op": "add_squad", "fleet", "wing", "squad": { ...squad } }   { "op": "update_squad", "fleet", "squad": "<id>", "set": { "name"?, "role"?, "commander"?, "anchor"?, "home"?, "targets"?, "autoRepair"?, "stance"? } }   { "op": "remove_squad", "fleet", "squad" }   (targets: the group's called targets, ship or object ids in kill order; autoRepair: { "on"?, "policy"? }, the group's logi auto-repair, replaced whole; null clears either)
{ "op": "move_to_squad", "ships": ["<id>"], "fleet", "squad" }   { "op": "remove_from_fleet", "ships": ["<id>"] }
{ "op": "set_anchor", "fleet", "squad", "anchor": { "ship"?, "range"? } }   (merged; null resets ship to the FC and range to the role default)
{ "op": "add_fleet_composition", "composition": { ...${FLEET_COMPOSITION_SCHEMA} }, "position": [x, y, z], "heading"?: <yaw degrees> | "facing"?: [x, y, z], "fleet"?: "<fleet id>", "team"?, "personality"? }   (needs dna on every ship line; the add_fleet_composition tool resolves hull names and saved names first)
{ "op": "add_ships", "dna", "hull"?, "radius"?, "count"?, "formation"?, "spacing"?, "position"? | "near"?: { "ship" | "object", "range"?, "direction"? }, "heading"? | "facing"?: [x, y, z] | "<ship or object id>", "team"?, "name"?, "prefix"?, "stats"?, "propMod"?, "fit"?: "<EFT text>", "pilot"?, "fleet"?: { "new": true, "personality"?, ... } | ..., "radii"?: { "<ship id>": metres } }   (the add_ships tool resolves hull names, celestials and radii first)
{ "op": "stage_engagement", "sides": [{ "composition": { ... } | "ships": [{ "dna", "pilot"?, ... }], "team"?, "fleet"?, "personality"?, ... }, { ... }], "range"?, "center"? | "near"?: { "ship" | "object", ... }, "heading"? }   (every ship line needs its dna; the stage_engagement tool resolves names first)
{ "op": "set_prop_mods", "ships": ["<id>"] | "fleet": "<id>" [, "wing" | "squad": "<id>"], "active"?: true | false, "module"?: "<module>" | null }   (merged into each selected ship's propMod; module null is the hull-sized default)
{ "op": "set_fits", "fits": { "<key>": "<EFT text>" | null } }   (merged into the scene's fits; null deletes a key no ship uses)
{ "op": "set_personalities", "personalities": { "<key>": <cjs-fleet-personality/1 template> | null } }   (merged into the scene's personalities; null deletes a key no fleet uses)
{ "op": "set_combat", "seed"?: <integer 0-4294967295> | null, "death"?: "explode" | "flag" | null }   (merged into the scene's combat: the seed keys every shot's roll, so a fight replays the same; death is what a ship does at 0 hull ("explode": it plays the client's death explosion sized to its hull, its modules and everything aimed at it stop, its fleet falls back as on a removal (a dead FC hands the fleet to its first live commander), the hull vanishes at the explosion's wreck switch and the ship leaves the scene once it has played, until a load revives it; "flag": it is recorded and flies on, taking no more damage until a load); null resets to seed 1 and "explode"; a change applies to later shots and deaths)
{ "op": "set_location", "location": { ...location } }   (replaces the location whole; the set_location tool resolves names)
{ "op": "clear_location" }
{ "op": "add_object", "object": { ...object } }
{ "op": "add_objects", "dna", "type"?, "radius"?, "id"?, "name"?, "prefix"?, "count"?, "formation"?, "spacing"?, "position"? | "near"?: { "ship" | "object", "range"?, "direction"? }, "heading"? | "facing"?: [x, y, z] | "<ship or object id>" | "rotation"?, "radii"?: { "<ship id>": metres } }   (the add_objects tool resolves type names, celestials and radii first)
{ "op": "update_object", "id", "set": { "dna"?, "type"?, "name"?, "position"?, "rotation"?, "radius"? } }   (null clears type, name and radius)
{ "op": "move_object", "id", "position"? | "near"?, "heading"? | "facing"? | "rotation"? }   (what is not given is kept)
{ "op": "remove_object", "id" }
{ "op": "add_asteroid_field", "ores": [{ "rocks", "ore"?, "weight"?, ... }], "id"?, "prefix"?, "name"?, "shape"?, "radius"?, "innerRadius"?, "thickness"?, "arc"?, "count"?, "size"?, "seed"?, "position"? | "near"?: { "ship" | "object", "range"?, "direction"? }, "heading"? | "facing"? | "rotation"?, "radii"? }   (the add_asteroid_field tool resolves ore names and celestials first)
{ "op": "update_asteroid_field", "id", "set": { "name"?, "ores"?, "shape"?, "radius"?, "innerRadius"?, "thickness"?, "arc"?, "count"?, "size"?, "seed"?, "position"?, "rotation"? } }   (ores is replaced whole; null clears name, innerRadius, thickness and arc)   { "op": "remove_asteroid_field", "id" }
{ "op": "add_cue", "cue": { "id"?, "at" | "when", "name"?, "<action>": { ... } } }   { "op": "update_cue", "id", "set": { "at"?, "when"?, "name"?, "<action>"? } }   (an action replaces the cue's; name null clears, at null makes an event cue wait unarmed, when null makes it timed)   { "op": "remove_cue", "id" }   { "op": "set_timeline", "timeline": { "cues": [...] } | null }   { "op": "clear_timeline" }   { "op": "set_movie", "movie": { "letterbox"?, "hud"?, "end"? } | null }   (merged; a null key resets it)
Taking a ship out of a squad (remove_ship, remove_from_fleet, move_to_squad, remove_squad, remove_wing) falls a squad anchored on it back to its squad commander, then its wing commander, then the FC, with a warning; a fleet commander must be replaced (update_fleet) or its fleet removed first. Removing a fleet, wing or squad keeps its ships in the scene, unless remove_fleet has "withShips": true. Removing a ship or object (remove_ship, remove_object, remove_fleet withShips) also takes it off every fleet's, wing's and squad's called targets, with a warning. Removing a ship, object, fleet, wing or squad drops the timeline cues and ship steps naming it (a ships selection or targets list just loses it), with a warning; a patch_scene cue that no longer applies refuses the removal, naming the cue.
Changing dna rebuilds that ship (it keeps flying); changing position or rotation puts it there at rest. Changing type, stats or the fit text a ship uses (its fit, or the fits entry it names) retunes the ship without a rebuild; stats replaces the whole override object and null clears it. Changing a ship's propMod.module retunes it; changing propMod.active switches its prop mod at once, with no cycle wait (changes.switched counts them); switch_prop_mods is the live, EVE-timed switch.
Removing a ship stops the ships approaching, keeping range on or orbiting it (changes.stopped counts them).
Removing an object stops the ships approaching, keeping range on or orbiting it (changes.stopped). Moving one makes them chase it. Changing an object's dna rebuilds it.
Changing an asteroid field's position or rotation moves it; any other key rebuilds its rocks from its seed (a higher count keeps the earlier rocks).
A location change moves the scene in its system, not the ships in the scene.
Fleet edits re-plan the following ships at once (a squad set to its own anchor and range breaks off, and rejoins when set back); a removed anchor's followers re-anchor through the fallback above and keep flying. Moving a following ship puts it there at rest and it flies back to its slot; moving the FC makes its fleet follow. Ships whose following ends (they left their fleet, it was removed, or they became its FC) stop, and changes.stopped counts them.`,
    inputSchema: {
      type: 'object',
      properties: { operations: { type: 'array', items: { type: 'object' }, minItems: 1 }, name: { type: 'string', description: "With at: the cue's name." } },
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
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, store: STORE_ARGUMENT, timeline: TIMELINE_START_ARGUMENT }, required: ['name'] }
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
    description: `Adds a fleet composition to the viewer's live scene: its ships in formation around the FC at position, or near { ship | object | celestial, range?, direction? } (as add_ships, range off the FC's surface; default heading the near ship's or object's), facing heading (yaw degrees, 0 faces +Z, 90 faces +X) or facing (a point or { celestial }), plus its fleet, with ids free in the scene. Give position or near, not both. Give the composition inline or the name of a saved one or a built-in example ("tfis", the TFIs armor doctrine, 44 ships). Hull names without dna or radius are resolved through tools-core's EVE data (needs its SDE). personality (a built-in or saved name, or an inline template) is the fleet's, over the composition's; list_fleet_personalities shows them. ${WARP_IN_TEXT} Pass scene to add to that document instead of the viewer's, with no tab: the result is returned, not shown (load_scene or save_scene it). Returns added (fleet, commander, ships), personality (name, from, chain, embedded), hulls (each hull's dna and radius and where they came from), and the patch_scene result. Remove it again with patch_scene remove_fleet "withShips": true; frame_camera on "<fleet>-fc" looks at it.
${FLEET_COMPOSITION_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: {
        composition: { type: 'object', description: `A ${FLEET_COMPOSITION_SCHEMA} composition. Give this or name.` },
        name: { type: 'string', description: 'A saved composition or built-in example. Give this or composition.' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: "The FC's [x, y, z] in metres. Give this or near." },
        near: { type: 'object', description: 'Where the FC goes instead of position: { ship | object | celestial, range?, direction? }, as add_ships.' },
        heading: { type: 'number', description: 'The fleet heading, yaw degrees. Default 0.' },
        facing: {
          anyOf: [
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            { type: 'object', properties: { celestial: { type: ['string', 'integer'] } } }
          ],
          description: 'A point or a celestial the fleet faces, instead of heading.'
        },
        fleet: { type: 'string', description: "The fleet id. Default the composition's id, numbered when taken." },
        team: { type: 'string', description: 'The team every added ship is on.' },
        personality: { ...PERSONALITY_ARGUMENT, description: `The fleet's personality, over the composition's. ${PERSONALITY_ARGUMENT.description}` },
        warpIn: WARP_IN_ARGUMENT,
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      }
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
    name: 'list_fleet_personalities',
    where: 'hub',
    description: `Lists fleet personalities, the FC playstyles a fleet runs its fight by: the saved ones (store "disk", newest first), then the read-only built-ins (store "built-in": ${BUILT_IN_FLEET_PERSONALITY_NAMES.join(', ')}), each with its title, what it extends and a description saying when to pick it. Pick one per fleet with set_fleet_personality, or personality on add_fleet_composition, stage_engagement sides and add_ships' new fleet.`,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_fleet_personality',
    where: 'hub',
    description: 'Returns a built-in or saved fleet personality by name (case does not matter): personality as written, and resolved (every field, its extends chain merged down to line, with chain).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'save_fleet_personality',
    where: 'hub',
    description: `Saves a fleet personality as a JSON file in the hub's personalities directory under name (default its id), which becomes its id: the key a scene embeds it under and a fleet picks it by. Built-in names are read-only (extend one instead), and its extends must name a built-in or a saved personality (save a base first). Names that differ only in case are the same personality. Returns the resolved template.
${FLEET_PERSONALITY_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: { personality: { type: 'object', description: `A ${FLEET_PERSONALITY_SCHEMA} template.` }, name: { type: 'string', description: 'Its id: 1-64 letters, digits, "_", "-" or ".". Default the template\'s id.' } },
      required: ['personality']
    }
  },
  {
    name: 'delete_fleet_personality',
    where: 'hub',
    description: 'Deletes a saved fleet personality by name. Built-ins are read-only; saved personalities extending it are named in the note. A scene keeps its embedded copy.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'set_fleet_personality',
    where: 'hub',
    description: `Gives a fleet in the viewer's live scene a personality, or clears it with null. personality is a built-in or saved name, an inline ${FLEET_PERSONALITY_SCHEMA} template, or a key of the scene's personalities. A saved or inline template is embedded in the scene's personalities (flattened over the saved templates it extends; a saved one refreshes the scene's copy), in the same patch as the fleet's update_fleet. From the next boundary the fleet's FC brain pulls its levers by it: the call (order_fleet targets), free fire, the FC's movement and the prop mods (switch_prop_mods), each after the FC's decision delay, with the acting FC as by; get_state fleets[].fc shows its state, pending decisions and every call it made with why (decisions). A model pulling a lever itself takes it manual (fc.manual): order_fleet targets or free-fire, engage and cease_fire the call and free fire (cease_fire also holds them), a fleet move or warp or order_ship on its FC the movement, switch_prop_mods the prop mods. Calling set_fleet_personality again, even with the same personality, hands every lever back to the brain. When the FC dies its succession protocol names the successor, who takes command after the handover (fc.state handover, takesOverIn). Its pilots answer orders given without delay at its reaction draws. Pass scene to edit that document instead (no tab). Returns fleet, personality (name, from: built-in, disk, scene or inline, chain, embedded) and the patch_scene result.
${FLEET_PERSONALITY_FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: {
        fleet: { type: 'string', description: 'The fleet id.' },
        personality: { type: ['string', 'object', 'null'], description: `${PERSONALITY_ARGUMENT.description} null clears it.` },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to edit instead of the viewer's (no tab needed; returned, not shown).` }
      },
      required: ['fleet', 'personality']
    }
  },
  {
    name: 'add_ships',
    where: 'hub',
    description: `Adds ships of one EVE type to the viewer's live scene in one call: count ships of hull (an EVE type name or id, resolved to SOF DNA and the hull's EVE radius through tools-core), in a formation at a place, facing a heading or a target, on a team, optionally as a new fleet or into a fleet's squad. A shortcut for a one-line fleet template: the result's template is that ${FLEET_COMPOSITION_SCHEMA} composition, ready for save_fleet_composition, add_fleet_composition and stage_engagement.
- formation: ${SHIP_FORMATIONS.map((formation) => `"${formation}"`).join(', ')} (${Object.entries(SHIP_FORMATION_ALIASES)
      .map(([alias, formation]) => `"${alias}" is ${formation}`)
      .join(', ')}). sphere is the default blob; line is abreast; column is astern; wedge is a V behind the lead; grid is ranks of lines behind the lead; wall is rows abreast stacked up and down.
- spacing: metres between neighbours, centre to centre (default ${FORMATION_SPACING} × two radii + ${FORMATION_GAP} m).
- The first ship (the lead) sits at the place: position [x, y, z], or near { ship | object | celestial, range?, direction? }. range is metres off its surface (default ${DEFAULT_NEAR_SHIP_RANGE} off a ship or object; off a celestial of the scene's location as set_location's defaults). direction is from it: ${NEAR_DIRECTIONS.join(', ')} or [x, y, z]; ahead, behind, left, right, above and below follow the ship's or object's own heading. Default: ahead off a ship or object, sun off a celestial. Ships are placed off a ship's document placement, not where it has flown since. Placements past ${formatSceneDistance(LARGE_SCENE_DISTANCE)} from the origin warn; past ${formatSceneDistance(MAX_SCENE_DISTANCE)} they are refused.
- heading is yaw degrees (0 faces +Z, 90 faces +X; default the near reference's heading, else 0), or facing (a point, a ship or object id, or { celestial }).
- fleet: { new: true, id?, name?, personality?, squad?: { id?, role?, anchor? } } makes a new fleet (personality: a built-in or saved name, or an inline template) (the first ship is the FC, the rest one squad; the role defaults from the hull's EVE group: logistics are logi, interdictors and interceptors tackle, recons and EAFs ewar, command ships boost, carriers support, the rest dps). { id, squad: "<squad id>" } joins a squad. { id, squad: { id?, role?, anchor? }, wing? } makes a new squad (in the fleet's last wing by default). Fleet members are placed at their formation slots around the FC instead of a formation; joining a squad can move members of later squads, a new squad moves nobody.
- Ids are "<prefix>-01", "-02", ... after the highest number already used (prefix: the hull name; "<fleet>-<squad>" when joining). stats, propMod, fit and team go on every ship.
- fit is EFT text every ship carries (the hull defaults to its header's); the scene keeps it once in its fits, under "<prefix>/<fit name slug>" (or "<fleet id>/..." for a new fleet), and the template carries it in its fits.
- ${WARP_IN_TEXT} Ships joining a fleet land at their live formation slots around the FC, along its heading (from is refused for them).
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
          description: 'Where the lead goes instead of position: off a ship, an object or a celestial of the scene location.',
          properties: {
            ship: { type: 'string' },
            object: { type: 'string', description: 'An object id.' },
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
            { type: 'string', description: 'A ship or object id.' },
            { type: 'object', properties: { celestial: { type: ['string', 'integer'] } } }
          ],
          description: 'What the ships face, instead of heading.'
        },
        team: { type: 'string' },
        name: { type: 'string', description: 'The ship name base (default the hull name); ships are "<name> <n>".' },
        prefix: { type: 'string', description: 'The ship id prefix.' },
        stats: { type: 'object', description: "Hull stat overrides for every ship (as a scene ship's stats)." },
        propMod: { description: "Every ship's prop mod: a module, or { module?, active? } (as a scene ship's propMod)." },
        fit: { type: 'string', description: 'EFT fit text for every ship ("[Hull, Fit name]\n..."); hull defaults to its header\'s.' },
        pilot: { type: 'object', description: "Every ship's pilot traits: { command?, reaction? }, each 0-1, higher is better." },
        fleet: { type: 'object', description: 'A new fleet { new: true, personality?, ... }, a squad to join { id, squad: "<id>" }, or a new squad { id, squad: { ... }, wing? }.' },
        warpIn: WARP_IN_ARGUMENT,
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      }
    }
  },
  {
    name: 'stage_engagement',
    where: 'hub',
    description: `Stages a fight in the viewer's live scene in one call: two sides facing each other range metres apart (between their front lines; default ${DEFAULT_ENGAGEMENT_RANGE}), centred on center [x, y, z] (default [0, 0, 0]) or near { ship | object | celestial, range?, direction? } (as add_ships), each on its own team (default "${ENGAGEMENT_TEAMS[0]}" and "${ENGAGEMENT_TEAMS[1]}").
- A side is a composition (a saved or built-in name such as "tfis", or an inline ${FLEET_COMPOSITION_SCHEMA}), or ships: [{ hull, count?, role?, name?, propMod?, fit?, pilot?, dna?, radius? }] (fit: EFT text for the line's ships; hull defaults to its header's). A ship list is a fleet (fleet id: the side's fleet, else the team; the first ship is the FC; each line a squad, its role from the hull's EVE group unless given); with fleet: false it is free ships in a formation (formation, spacing and prefix as add_ships; ids "<team>-01", ...). A fleet side's personality (a built-in or saved name, or an inline template) is its fleet's, over its composition's: { composition: "tfis", personality: "brawler" }.
- heading is the yaw side A faces; side B faces back. Default 0, or across the line from the near ship, object or celestial, so both sides stand beside it.
- A side's warpIn (true or { stagger?, together? }, as add_fleet_composition's; no from) lands it from warp along its own heading, onto the other side: reinforcements dropping on a fleet. The result's arrivals reports it.
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
              ships: { type: 'array', items: { type: 'object' }, description: 'Ship lines { hull, count?, role?, name?, propMod?, fit? (EFT text), pilot?, dna?, radius? }.' },
              team: { type: 'string' },
              fleet: { type: ['string', 'boolean'], description: 'The fleet id, or false for free ships (ship lists only).' },
              name: { type: 'string', description: 'The fleet name.' },
              personality: { ...PERSONALITY_ARGUMENT, description: `The side's fleet personality, over its composition's; not for free ships. ${PERSONALITY_ARGUMENT.description}` },
              formation: { type: 'string', enum: [...SHIP_FORMATIONS, ...Object.keys(SHIP_FORMATION_ALIASES)] },
              spacing: { type: 'number' },
              prefix: { type: 'string' },
              warpIn: { ...WARP_IN_ARGUMENT, description: 'Land this side from warp along its heading: true, or { stagger?, together? }.' }
            }
          }
        },
        range: { type: 'number', minimum: 0, description: `Metres between the front lines. Default ${DEFAULT_ENGAGEMENT_RANGE}.` },
        center: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        near: { type: 'object', description: 'Centre off a ship, an object or a celestial of the scene location: { ship | object | celestial, range?, direction? }.' },
        heading: { type: 'number', description: 'The yaw side A faces.' },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to stage on instead of the viewer's (no tab needed; returned, not shown).` }
      },
      required: ['sides']
    }
  },
  {
    name: 'search_objects',
    where: 'hub',
    description: `Finds EVE types to place with add_objects: stations, stargates, Upwell structures (Astrahus, Fortizar, Keepstar), large collidable objects (Ruined Stargate) and wrecks, matched on the English type name (not descriptions), ranked exact, prefix, word prefix, then substring, then shorter names. Ship wrecks are per race and size ("Minmatar Frigate Wreck", "Caldari Elite Frigate Wreck"); there is no "Rifter Wreck". group filters on part of the group or category name ("wreck", "citadel", "structure", "large collidable"). placeable (default true) keeps types with SOF DNA, which the page can build; note says how many matches had none. Returns { query, total, items: [{ typeID, name, group, category, radius?, radiusFrom?, dna?, published }], note? }: radius is what add_objects gives the type (radiusFrom "sof" when it is the model's: wrecks, whose SDE radius is a 14 m placeholder, and types with none). Needs a prepared SDE in tools-core.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of an EVE type name.' },
        group: { type: 'string', description: 'Part of the group or category name.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        placeable: { type: 'boolean', description: 'Only types with SOF DNA. Default true.' }
      },
      required: ['query']
    }
  },
  {
    name: 'add_objects',
    where: 'hub',
    description: `Places static EVE objects in the viewer's live scene in one call: stations, stargates, Upwell structures, large collidable objects and wrecks, by EVE type name or id (resolved through tools-core to SOF DNA and a radius: the type's SDE radius, or its model's bounding radius for a wreck, whose SDE radius is a 14 m placeholder, or a type with none; search_objects finds names). Give objects: [line, ...] or one line's fields at the top level. A line is { type | dna, radius?, id?, name?, prefix?, count?, formation?, spacing?, position? | near?, heading? | facing? | rotation? }.
- The place: position [x, y, z], or near { ship | object | celestial, range?, direction? }: range is metres off its surface to the object's surface (default ${DEFAULT_NEAR_SHIP_RANGE} off a ship or object; off a celestial of the scene's location as set_location's defaults); direction as add_ships (ahead, behind, left, right, above and below follow the ship's or object's heading). A line may sit off an object an earlier line adds: give that line an id.
- The rotation: rotation [yaw, pitch, roll], heading (yaw degrees), or facing (a point, a ship or object id, or { celestial }); default the near reference's heading, else 0.
- count (at most ${MAX_OBJECTS_PER_OPERATION}) lays copies out in a formation (as add_ships; spacing default ${FORMATION_SPACING} × two radii + ${FORMATION_GAP} m), all turned alike. id names one object; otherwise ids are "<prefix>-01", ... (prefix: the type name's slug) after the highest number any ship or object already uses, and names "<type> <n>".
- Atomic: every line goes in one patch_scene, and any problem (a type with no graphic, an unknown name, a place outside the scene's ${formatSceneDistance(MAX_SCENE_DISTANCE)}) fails the call with each line named, adding nothing. Placements past ${formatSceneDistance(LARGE_SCENE_DISTANCE)} warn, as do overlaps with ships or objects and a spacing under two radii.
- Objects are static: patch_scene's move_object, update_object and remove_object edit them; to move one off a celestial, remove_object it, then add_objects it again with the same id. Ships can approach, keep at range on, orbit and warp to them (order_ship), on that radius (the SDE's is what EVE's overview measures); they never collide.
- Pass scene to add to that document with no tab (returned, not shown). Returns added [{ id, type, name, position, rotation, radius }], types [{ type, typeID, name, group, category, dna, radius, dnaFrom, radiusFrom (given, sde, sof: the model's, or none), sdeRadius? }] and the patch_scene result.`,
    inputSchema: {
      type: 'object',
      properties: {
        objects: { type: 'array', minItems: 1, items: { type: 'object', properties: OBJECT_LINE_PROPERTIES }, description: 'The lines; or give one line at the top level.' },
        ...OBJECT_LINE_PROPERTIES,
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      }
    }
  },
  {
    name: 'add_asteroid_field',
    where: 'hub',
    description: `Adds a seeded asteroid field to the viewer's live scene: EVE's own rock models of the ores you name ("Veldspar", "Scordite", "Dark Ochre", "Arkonor", "Blue Ice", "Common Moon Asteroids", ...; resolved through tools-core to their SOF rock sets: four small, four medium and four large models per ore), scattered without overlap in a sphere, disc or ring.
- ores (1 to ${MAX_FIELD_ORES}, at most ${MAX_FIELD_MODELS} models in all): names, or { ore, weight? }, { faction, weight?, name? } (a SOF rock faction, e.g. "ore_pyrrhotite"), { rocks: [dna, ...] | { small, medium, large }, weight?, name? }. weight is the share of rocks (default 1).
- shape (sphere default; disc and ring lie in the field's local XZ plane and take thickness and arc, degrees around its local +Z; ring has a hole, innerRadius, default 0.6 × radius; a sphere with innerRadius is a shell), radius (metres, default ${DEFAULT_FIELD_RADIUS.toLocaleString('en-US')}), count (rocks, default ${DEFAULT_FIELD_COUNT}, at most ${MAX_FIELD_ROCKS.toLocaleString('en-US')}), size [min, max] (rock radii in metres, default [${DEFAULT_ROCK_SIZE.join(', ')}], log-uniform; the three model sizes split the range in thirds), seed (the same seed and settings give the same rocks; a higher count keeps the first rocks; default from the id).
- The place: position (the centre) or near { ship | object | celestial, range?, direction? }: the field's edge range off the reference's surface (default ${DEFAULT_NEAR_SHIP_RANGE} m off a ship or object, set_location's defaults off a celestial). An asteroid belt of the scene's location centres the field on it (range from its centre, default 0), with the belt's radius when radius is not given. Turned by rotation, heading or facing (a point, a ship or object id, or { celestial }); default the near reference's heading.
- The whole field (centre, radius and largest rock) must fit the scene's ${formatSceneDistance(MAX_SCENE_DISTANCE)}. Rocks are scenery: no Destiny balls, not order targets, nothing collides with them. Rocks that cannot be placed without overlap are dropped, with a warning.
- replace: true with an existing id replaces that field in the same patch. Atomic: any problem (an unknown or unmapped ore, a place outside the scene) adds nothing. Pass scene to add to that document with no tab (returned, not shown).
- Returns added { id, name, position, rotation, shape, radius, count, placed, envelope, digest }, ores [{ ore, type, group, faction, models: { small, medium, large }, from (sde, faction or given), skipped? }], warnings and the patch_scene result. patch_scene's update_asteroid_field and remove_asteroid_field edit fields. The page draws the field (get_state asteroidFields reports its status, placed rocks and digest). Needs a prepared SDE in tools-core.`,
    inputSchema: {
      type: 'object',
      properties: {
        ores: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FIELD_ORES,
          items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
          description: 'Ore names ("Veldspar"), { ore, weight? }, { faction, weight?, name? } or { rocks, weight?, name? }.'
        },
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string', description: 'The id prefix (default the name or first ore slug): "<prefix>-01".' },
        shape: { type: 'string', enum: [...ASTEROID_FIELD_SHAPES] },
        radius: { type: 'number', description: 'Metres.' },
        innerRadius: { type: 'number', description: 'Metres: a hole (disc, ring) or an empty core (sphere).' },
        thickness: { type: 'number', description: 'Metres (disc, ring).' },
        arc: { type: 'number', description: 'Degrees of the circle filled, centred on local +Z (disc, ring).' },
        count: { type: 'integer', minimum: 1, maximum: MAX_FIELD_ROCKS },
        size: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[min, max] rock radii, metres.' },
        seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        near: { type: 'object', description: '{ ship | object | celestial, range?, direction? }' },
        heading: { type: 'number', description: 'Yaw degrees.' },
        facing: { description: 'A point [x, y, z], a ship or object id, or { celestial }.' },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[yaw, pitch, roll] degrees.' },
        replace: { type: 'boolean', description: 'With an existing id: replace that field in the same patch.' },
        scene: { type: 'object', description: `A ${SCENE_SCHEMA} document to add to instead of the viewer's (no tab needed; returned, not shown).` }
      },
      required: ['ores']
    }
  },
  {
    name: 'get_state',
    where: 'page',
    description: `Live state of the viewer: eveData (mode: tools-core, or off in no-EVE-data mode; from: hub (--eve-data off) or url (this tab's ?eve=off); note; with it off, refused: EVE files a page path still asked for and the page refused, 0 expected, and expected: the runtime's own construction-time asks it refused as expected), renderer status, frame rate (renderer.moduleEffects counts the running modules' drawn effects: live, loading and failed, with the latest errors; renderer.turrets counts the ships' mounted turret sets: sets, loading, failed, unplaced (no hardpoint for them on the hull), targeting and firing (sets aiming at a target, and of those the ones firing), bursts (drawn since the load), with the latest errors; renderer.warpEffects counts the drawn warp flashes: live, loading, failed and skipped (over the cap), with the latest errors; renderer.standIns is what the page draws without EVE data: greenScreen (on with EVE data off, or when the universe file did not load: the backdrop is chroma-key green) and cubes (stand-in cubes drawn last frame, one per ship or object that is a stand-in or whose model did not build, on its ball, coloured by team, its nose face pale); renderer.animation is the clock the runtime's own animations run on (shader time, controllers, booster flicker, blinking lights): clock (scene: it advances with the scene clock, holding while paused or held and slowing in slow motion; real under ?anim=real), seconds, frozen and shaderTime (the time the shaders read)), camera, and per-ship build status (queued, building, ready, validated without a renderer, stand-in (no EVE data: a cube on its ball), failed with error, destroyed), world position and bounding radius, plus pairwise distances between ships in metres. Each ship also reports its Destiny motion: position and velocity [x, y, z] (metres, m/s), speed, mode (stop, goto, follow, orbit) and the physics it flies with (below). simulation gives the Destiny tick, scene seconds, held (true while a scripted load holds the scene clock for its prepare) and warpFlashes: the warp flashes played since the page loaded ({ warpOut: on entering warp, never for an arrival; warpIn: as the drawn ship nears its landing }), counted with or without a renderer. Motion is the authoritative state; the drawn ships trail it by up to one 1 s tick, as in EVE's client. Ships in a fleet also report fleet, wing, squad, role, commands and anchor (the ship they keep range on, and the range); fleets is the fleet tree with each squad's anchor resolved, plus formation (ready, the FC's heading, and how many members are following, in formation, catching up, holding, warping, leading, detached or waiting); every fleet, wing and squad also reports command (order_fleet): state (idle, moving, warping, broken-off or regrouping), leader, away (a wing or squad flying apart), home (a broken-off squad's), the leader's order while it moves, last (the last order_fleet: order, by, tick), warp (counts aligning, warping, landed, dropped, skipped) and regrouping (ships not yet back); one that calls targets also reports targets (its live list, in kill order) and called ({ primary, queue (the live ids after it), skipped? ([{ id, why: destroyed, warping, missing or own-ship }]), following (the members on its primary) }); a fleet with remote repairers also reports autoRepair: its logi's counts (logi, repairing, locking, idle, outOfRange, manual, off) and targets ([{ target, logi, hps }]: whom they hold up). A fleet member other than the FC also reports following: state (in-formation, catching-up, holding while its anchor or FC is in warp, warping in formation with warping naming its leader, leading a wing or squad apart, detached by an explicit order, piloting (a stance's pilot flies it on its own), or waiting for the ships' radii), group (kind, id, leader: while it flies in or leads a wing or squad apart), anchor and range (what it keeps range on), slot (its formation slot: range and direction in the FC's heading frame), distance (metres, surface to surface, to the anchor) and slotError (metres from its slot); its order is keep-at-range on the anchor, and its mode is goto while it steers to its slot and stop once settled. heading is each ship's [yaw, pitch] in degrees, the authoritative heading. Each ship also reports its order (what its ball is flying, with target, range and speed), pendingOrder (given, applying at the next tick), orderNote (why it stopped on its own, such as its target being removed) and targetDistance (metres, surface to surface on the balls' EVE radii, negative when they overlap); target is its weapons' target (set_target): { id, kind: ship or object, distance (m, surface to surface), source: own (set_target, engage, switch_modules) or called (its group's call, order_fleet targets) } or null; call is a fleet member's call, when a group of its squad, wing and fleet calls targets or it holds, stands down or responds: { state: following, holding (cease_fire), stood-down (cease_fire unlock), own-target, responding (to a delayed targets order), in-warp, no-primary or logi (a logi squad takes only its own squad's call), group ({ fleet, kind, id }: whose call it takes), primary, respondsIn (s) }; autoRepair is a fleet member's logi auto-repair, for a member with remote repairers or with auto-repair on (auto_repair): { state (destroyed, in-warp, waiting (its fit has not resolved), no-repairers, off, manual (switch_modules took its reps), repairing, locking (held on its lock or its next cycle start), out-of-range, idle), on, policy, source and policySource (squad, wing, fleet or default: where each came from), target?, reason? (under-fire, covering, topping-off, idle, out-of-range), why, since? (s on its target), layer?, modules? ([{ module, state }]), hps? (HP/s it lands after falloff), preLocks?, unreachable? ([{ id, distance, pressure }]: members needing reps beyond its reach), note? (a refused switch), layers? (a second repair layer, the same fields) }; stance is a ship's stance once one resolves on it (the scene format's stance): the resolved type, on, range, propMods, formation, disengage, sources and flownBy, plus its pilot's state (in-line: its group's leader flies it; closing, holding, orbiting, kiting, disengaging, waiting, idle, or manual while a model holds it), focus, window and ideal (m), why, pending (a live stance it has yet to take up: { type, flownBy, at, in (s) }) and decisions (its last calls: tick, tool, args, why, refused?), and a fleet with stances counts its members by that state in stances; and shots counts the shots its turrets fired since the load (omitted at 0); missiles its missiles ({ launched since the load, inFlight }, omitted at 0); targeting is a dogma ship's { scanResolution (mm), maxTargetRange (m), maxLocks }; locks its locks ({ target, state: waiting, locking or locked, lockTime (s, EVE's 40000 / (scanResolution × asinh(signature)²) fixed at its start), readyIn (s), note (such as out of targeting range) }); engaged its engagement ({ modules }); combat its tallies once it fired, was shot or was repaired ({ dealt, taken (HP), dps: { dealt, taken } over the trailing 20 s, shots, hits, misses, lastHits and lastTaken: the 3 latest shots fired and taken ({ tick, target or from, module, name, result: misses, grazes, glances off, hits, penetrates, smashes, wrecks or overkill, chance, quality, damage, layer, missile? (true for a missile: its chance and quality are EVE's missile application, an expired or lost one misses with a note) }), paperDps, repairs? (once it received or gave a repair: { received, given (HP restored; given counts remote repairs only), hps: { received, given } over the trailing 20 s, lastReceived: the 3 latest landings ({ tick, from, module, layer, amount: HP restored, nominal: the cycle's HP after falloff; a landing on a full layer restores 0 }) }) }); destroyed its kill ({ tick, by, module, weapon, mode, explosion? }; cause "set_hp" and no by, module or weapon for a gameplay set_hp that emptied its structure) once its structure reached 0: with death "explode" explosion is { state: waiting, playing, done or failed, file, scale?, localBlasts?, wreckSwitchTime?, totalDuration? (s), removesAt (the tick its ball leaves), gone }, its status reads destroyed once its hull is hidden, orders, targets and switches on it are refused or skipped ("it was destroyed"), and a load revives it; a fleet that lost ships reports destroyed (their ids) and actingFor (the dead FC its commander stands in for), and lists only its live members; the scene-level combat gives seed, death, shots, hits, repaired (HP every repair restored) and kills ([{ ship, name, team, by, module, weapon (or cause: set_hp), tick }]); the scene-level missiles (once a missile was launched after a load) gives inFlight, launched, hits, expired, lost, refused and flights (at most 40, flying first, soonest end first: { id, ship, module, charge, target, state: flying, lost, hit or expired, launchedAt (tick), age (s), expiresIn (s), distance (m, surface to surface to its target), speed, why }); distances use the drawn bounding spheres. physics gives mass, agility, maxVelocity, radius (the ball's EVE radius), signatureRadius, alignTime (s) and source: sde (the hull's in-game values via tools-core), stats (the document's four stats) or class (class values when the EVE data cannot name the hull; note says why). location is the scene's EVE location, or null: system (id, name, region, securityStatus), origin (system metres), status (loading, ready, failed with error, or off with no EVE data, with note), anchor (the celestial it was placed from, with its actual distance and surfaceDistance from the origin), star (distance and direction), and nearby: the ${LOCATION_NEARBY_LIMIT} celestials nearest the origin (id, name, kind, radius, position in scene metres, distance from the origin, surfaceDistance). location.dressing reports what the location drew: state, the nebula, the sun (graphic, environment template, lens flare, distance), counts per kind (drawn, validated without a renderer, loading, failed, skipped) and each dressed planet, moon, station and stargate with its state; environment.nebula says which nebula is drawn and whether it comes from the location or environment.universe. physics is what the ship flies with now: while its prop mod runs, the module's mass, maxVelocity, signatureRadius (the MWD bloom) and alignTime. propMod is null for a ship fitting "${PROP_MOD_MODULE_NONE}", else the module (module as written, name, typeID, kind, size S/M/L/XL, source: sde, baked (built-in values) or default (the hull-sized module standing in, note says why)), state (off, activating, active, stopping), cycleTime (s), since (the tick it started), stopsIn (s, while stopping), note (why it is off, such as entering warp) and its running numbers (maxVelocity, mass, signatureRadius, alignTime). boosters.maxVel stays the prop-mod-off max velocity. A ship with a fit flies by it once the hub has resolved its names and dogma (physics.math dogma: its modules online, with stacking penalties and the max-skills pilot; table until then or without the SDE). A ship without a fit flies a default weapons fit once the EVE data knows its hull: one T2 turret per turret hardpoint sized for the hull and picked by its race (Minmatar autocannons, Amarr pulse lasers, Caldari railguns, Gallente blasters, Triglavian disintegrators, EDENCOM vortons) with a charge, launchers on a launcher-only hull, plus its prop mod (never written to the document); fit is null only without one (the hull has no EVE type, or no weapon hardpoints: fitNote says why). Every ship's weapons are drawn on its hull. fit gives name, key (its fits key, inline, or default with default: true for the default weapons), hull, typeID, unknown (names the EVE data lacks), modules ({ module: its key such as low-0 or mid-2, name, state: offline, online, activating, active, stopping or reactivating (switch_modules; the prop module's is its propMod state, off reading online), cycle? ({ number, endsIn } s while it runs), at? (the tick an activation applies), stopsIn?, activatesIn?, readyIn? (reactivation), respondsIn? (a delayed pilot), target?, nextTarget? (a running weapon's or remote repairer's next target: it retargets at its first cycle once that target is locked), targetDistance? (m, surface to surface), effectiveness? (falloff, 0-1), cycleTime? (s per cycle while it runs: a gun's rate of fire), combat? (a turret's { damage per shot by type, volley, dps }; a launcher's { damage per missile by type, volley, dps, velocity (m/s), flightTime (s), range: { lower, upper, upperChance, mean } (m) }), inFlight? (a launcher's missiles flying), charge? (a turret without one loads the first fitting charge in the fit's cargo: note "loaded from cargo", or "no charge loaded"), mount? (a weapon's turret set on the drawn hull: { locator such as locator_turret_4, state: loading, mounted, failed or unplaced, models, aim: idle, targeting or firing, error }), prop?: the module propMod stands for, note? (such as why it stopped: entered warp, its target gone or out of range) }), drones, math and note (why not dogma yet); physics, defense and capacitor follow the modules' live states (a running hardener's resists, a suppressor's signature, siege's speed). defense gives shield, armor and structure ({ hp: current, max, resists in percent by em, thermal, kinetic, explosive, ehp of the current HP }), ehp, shieldRecharge (s), repairs (HP/s per layer of its running local repairers) and incoming (remote repairs running on it: { from, module, layer, amount per cycle, cycleTime, effectiveness }); repairs land at cycle events (shield boosters at a cycle's start, armor and hull repairers at its end). hpSet is the latest set_hp on the ship since the load: { state: applied or pending (waiting for its fit), tick (asked), appliedAt, intent, seed? (a random set's), values (as given), hp (the HP each target was set to), clamped?, note? (why it waits) }. capacitor gives level (GJ now, the live capacitor: it recharges on EVE's curve and neuts, nos and transmitters move it) and fraction, capacity (GJ), rechargeTime (s), peakRecharge and drain (GJ/s, the running modules), stable with stableAt or lastsFor (s), and energyWarfareResistance / remoteCapacitorImpedance when not 1. targeted is null unless a targeted module runs on the ship or it cannot warp: by (each running targeted module on it: from, module, name, category, effectiveness, amount per cycle, cycleTime, moved: the GJ its latest cycle moved, note), speedFactor and signatureFactor (its max velocity and signature with the webs and painters over without; physics already includes them), warpScrambleStatus (with the points and scrams on it and its own modules: above 0 it cannot warp), canWarp, warpNote (what pins it) and mwdBlocked (a scram on its microwarpdrive). Both are null on the table path. Each fleet reports propMods: counts of activating, active, stopping, off and none, and modules: its members' fitted modules by state. audio reports the page's audio (state: off with its note under ?audio=off or with no EVE data, the emitters, the last engine events posted, each with played, frameErrors / lastFrameError when the runtime's audio frame failed, gameObjects (registered audio objects: the listener and the page's emitters), foreign (any other registered audio object, by name, expected absent), rescheduled and backendErrors / lastBackendError (Web Audio throws the page recovered or contained), and context: the AudioContext's state, where suspended while on means the browser holds it until a click). arrivals (present while ships arrive by warp: warpIn on add_fleet_composition, add_ships, stage_engagement or add_ship) lists each arriving group: group, fleet, leader, ships ({ id, state: waiting (parked off-grid until its hull and flight numbers are in), scheduled, warping, landed, forming-up, formed or dropped, landsIn (s), note }), state, counts, lands { first, last } (s from now, once planned), together, stagger, landing (document: its placements; formation: its live slots around the FC) and notes; a group is kept 30 s after it formed. While a member arrives its following.state reads arriving and its fleet's formation.arriving counts it. objects lists the scene's static objects: id, type, name, dna, status (queued, building, ready, validated, stand-in (no EVE data: a cube on its ball) or failed, with error), position, rotation, radius (the Destiny ball's: what ranges are measured on) and radiusFrom (document, sof or default), sofRadius (the model's bounding radius), distance from the origin, nearestShips (up to ${OBJECT_NEAREST_SHIPS} { id, distance } surface to surface, negative inside) and targetedBy (ships ordered onto it); scene.objects counts them. asteroidFields lists the scene's asteroid fields (no per-rock lists): id, name, status (queued, building, ready, validated without a renderer, off under ?fields=off or with no EVE data (note says why), or failed, with error), position, rotation, shape, radius, innerRadius, thickness, arc, seed, rocks ({ requested, placed, bySize: { small, medium, large }, byOre: [{ ore, rocks }] }), models ({ total, built, failed, failedDnas }: the rock models drawn), cells (draw cells), envelope (the radius every rock fits in), distance from the origin, digest (the placed rocks' hash, the same as add_asteroid_field's) and nearestShips; scene.asteroidFields counts them. location.targets lists the location's stations and stargates within the scene extent that order_ship takes as "celestial:<id>": target, id, name, kind, radius, distance and surfaceDistance. cinema is the cinematic camera: state (idle, playing, paused or releasing), driver (claude, director (auto_camera), timeline (the timeline's camera cues) or user: user whenever the orbit camera draws), shot (name, library, hardpoint or pose, moves, transition, end, elapsed and duration in scene seconds, progress, holding), sequence (index, count, elapsed, duration, progress), resumable (what resume_shot would play), pose (eye, look, up, fov), near, far, letterbox, hud, note (why the last shot ended) and director (auto_camera's automatic camera: on, state (off, waiting, driving, paused or yielded), yieldedTo, source, bias, pick ({ framing, shot, scale, side, since, holdsFor, score, why, event, transition }), candidates (the best 3), axis, cuts, recent (the last 5 cuts), cost and note); camera.view says which camera draws (orbit or cinema) and camera.drawn what it drew. timeline is the scene's script as played (null without timeline cues or ship orders): state (stopped: a live scene gained a script, timeline play starts it; preparing: the scene clock held until every hull's numbers, fit and build settled; ready: held at t = 0 until play; playing; paused; done), time (whole seconds played), startedAt (the world tick of t = 0), camera (whether camera cues play), cues (total, pending, fired, failed, skipped, missed), next ([{ id, at, action, in }]), last ([{ id, at, action, tick, state, note }]), failed ([{ id, at, action, tick, error }]), scripts (ship script counts by state), liveEdits ({ count, last: [{ source: cue or edit, cue, tick, adds }] }: what the timeline changed in the live scene), preparing ({ seconds, waiting: lookups, fits, builds, fleets, objects, location }) and note; the timeline tool reports every cue. Each ship with orders reports script: state (waiting, arriving, flying, holding: its last never-ending order flies on, done, failed, interrupted: another order took it, destroyed), step, steps, order, startsIn and endsIn (s), note. time is the scene clock under time_control: seconds, tick, rate, paused, state (playing or paused), timeline (seconds of timeline time at now, once a scripted timeline started), effectiveRate (the rate actually kept, when fast-forward falls behind), held and audio (muted above ${AUDIBLE_MAX_RATE}×, suspended while paused); back (scene seconds a jump can go back now), earliest and latest (the window's start and the recorded end, later than seconds after a jump back), window ({ seconds kept, every, window, snapshots, bytes, budget, capture: ms }), recording ({ on, since, why: what last cut the window and cutAt, waiting: what the scene still waits for before recording starts }), replay ({ pending, next: { tool, seconds } }: the journaled commands still ahead), drift ({ count, tick, summary }: replays that came out different, expected absent) and jump (the last: from, to, snapshot, resimulated ticks, ms, warnings); time.state reads exporting (with exportFps) while export_movie runs. export is the page's movie export (export_movie), null before one this page session: id, state (preparing, seeking, prerolling, rendering, finishing, done, cancelled or failed), plan, frame, frames, progress, time (timeline seconds of the last frame drawn), rate ({ fps, realtime }), eta (s), waiting, encoder ({ queue, chunks, keyFrames, bytes }), frameMs ({ mean, max, retries }), startedAt, wallSeconds, gpuErrors, warnings and error.`,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_overview',
    where: 'page',
    description: `EVE's overview from one ship, read-only: what the page's pilots read, so a program outside the page can fly the ship with the same numbers. Rows are every other live ship within \`within\` (default ${OVERVIEW_DEFAULT_WITHIN / 1000} km, surface to surface), nearest first, at most \`limit\` (default ${OVERVIEW_DEFAULT_LIMIT}): id, name, team and relation (hostile: both teams set and different; friendly: the same; else neutral), distance (m), velocity, radial (m/s, positive while the gap opens), transversal (m/s), angular (rad/s, what turret tracking reads), bearing (degrees off this ship's nose) and aspect (degrees between its nose and this ship), its reach (weapons, capped at its lock range), lockRange and tackle (point, scram, web ranges), and for a ship that is not friendly the DPS it applies on this ship now (incomingDps: 0 beyond its lock range) and this ship's hitChance (its turrets, paper-DPS weighted) and outgoingDps on it now; for a friend, the HP/s this ship's remote repairers would land on it (repairs); its lock on this ship (targeting: locking | locked), shooting (its weapons fire at this ship), health (0-1) and layers, its target, propModOn, scrammed and webFactor. ship is this ship: position, speed and maxSpeed as it flies, signature, health, remainingEhp and ehp, its prop mod, scram and web state, target, locks, reach, lockRange, tackle, incomingReps. stance is its resolved stance (type, on, range, propMods, formation, disengage, sources, flownBy). envelope is the engagement envelope against its focus (target, else its own target, else the nearest hostile), weighed for its stance's type (kite, brawl, snipe, tackle or support; else auto): range to it now, inWindow, and ideal { type, ideal (m), window, posture, propMod, ordered (what to order to fly it: an orbit settles wider than ordered), out and in DPS there, score, dictates (self | focus), dictated, disengage, constrained, why }; envelope: true adds points (out and in DPS at every candidate range), envelope: false drops it. Measured on the page's live state at the call (Destiny ticks once a second while the tab is visible).`,
    inputSchema: {
      type: 'object',
      properties: {
        ship: { type: 'string', description: 'The ship the overview is measured from.' },
        within: { type: 'number', exclusiveMinimum: 0, description: `Metres, surface to surface (default ${OVERVIEW_DEFAULT_WITHIN}).` },
        limit: { type: 'integer', minimum: 1, description: `Rows (default ${OVERVIEW_DEFAULT_LIMIT}).` },
        target: { type: 'string', description: "The envelope's focus (default its own target, else the nearest hostile)." },
        envelope: { type: 'boolean', description: 'false: no envelope; true: with its points.' }
      },
      required: ['ship']
    }
  },
  {
    name: 'order_ship',
    where: 'page',
    description: `Gives a ship a live movement order through its Destiny ball, flown at the ship's in-game speed and agility (its hull as flown by a pilot with every skill at V, after the document's stats). Orders take effect at the next 1 s Destiny tick and are not saved in the scene document. speed is a fraction of max velocity in (0, 1], default 1. Ranges are metres, surface to surface between the two Destiny balls (EVE's radii), as EVE's overview shows them. A target is a ship id, an object id (the scene's objects) or a celestial target of the location ("celestial:<id>", get_state.location.targets: its stations and stargates). A target can also be a name: an object's name, or its type when only one object has it; else a celestial of the location ("Caldari Navy Assembly Plant", "IV - Moon 4", "the sun", "Perimeter gate"). A station or stargate becomes its celestial target (refused when it is none: beyond the scene's ${formatSceneDistance(MAX_SCENE_DISTANCE)} or without a radius). A planet, moon, star or asteroid belt takes only a warp, which lands range metres off its surface (a belt: off its centre) on the line toward the ship, refused when that landing is more than ${formatSceneDistance(MAX_SCENE_DISTANCE)} from the origin (set_location there first). An ambiguous name lists the candidates. Orders:
{ "type": "direction", "direction": [x, y, z], "speed"? }   fly along a world direction
{ "type": "goto", "point": [x, y, z], "speed"? }   fly to a world point and slow to a halt near it
{ "type": "approach", "target": "<ship or object id>", "speed"? }   close on the target (Destiny aims for ${APPROACH_RANGE} m)
{ "type": "keep-at-range", "target": "<ship or object id>", "range": <metres>, "speed"? }   hold the range on the target, following it
{ "type": "orbit", "target": "<ship or object id>", "range": <metres>, "speed"? }   circle the target; fast ships settle a little wider than the range, as in EVE
{ "type": "warp", "point": [x, y, z], "range"? }   align, warp and land range metres short of the point (default 0)
{ "type": "warp", "target": "<ship or object id, or a name>", "range"? }   align, warp and land range metres from where the target is when the order applies (a planet, moon, star or belt: off its surface)
{ "type": "stop" }   decelerate to a halt
{ "type": "rejoin" }   a fleet member that left its formation keeps range on its anchor in its slot again (it also clears the ship's own live stance)
{ "type": "stance", "set": ${STANCE_SHAPE_TEXT} | "clear": true }   the pilot's own stance, live (never saved; a load resets it): set replaces it whole, clear takes it away (its groups' stance applies again, else formation); returns the ship's resolved stance
Warp: the ship aligns at full speed toward the destination until it reaches 75 % of max velocity on that heading, as in EVE, then warps at its warp speed (warpSpeedMultiplier AU/s; class values without the SDE) and lands. The landing must be at least ${MIN_WARP_DISTANCE / 1000} km away (use goto nearer). While aligning any order cancels the warp; in warp a ship refuses orders until it lands. A fleet holds while its FC is in warp, then flies to the FC's landing (order_fleet warp warps the whole fleet in formation). get_state shows warp: phase, landing, progress, remaining, landsIn.
Fleets fly in formation on their FC: ordering the FC moves its fleet. Any order above on a fleet member (not the FC) takes it out of formation until rejoin, a fleet edit that regroups it, or load_scene; rejoin is refused for the FC, for a ship in no fleet and for the leader of a wing or squad flying apart (order_fleet regroup brings the group back); an order on that leader keeps it leading (following: "leading").
Removing a ship or object stops every ship approaching, keeping range on or orbiting it. Approach, keep-at-range and orbit are refused for a target in another Destiny bubble (thousands of km away): warp to it first. A new position or rotation (or load_scene) puts a ship at rest and ends its order. Returns { id, order, tick }, plus following: "detached" when the order took a fleet member out of formation, or the member's following report for rejoin, and resolved ({ name, kind: object or the celestial's kind, target or point, range }) when the target was a name (order then holds what it became). get_state shows each ship's order, pendingOrder, orderNote, targetDistance, mode and physics. A warp order is refused while the ship is warp scrambled (a point or scram on it: get_state targeted.canWarp), and a point landing while it aligns cancels the warp into a direction order along it. A ship still arriving by warp (warpIn: get_state arrivals) refuses orders, and is refused as a target, until it lands.`,
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
            target: { type: 'string', description: 'Ship id, object id or celestial:<id> to approach, keep range on, orbit or warp to; or an object or celestial name.' },
            range: { type: 'number', minimum: 0, maximum: MAX_ORDER_RANGE, description: 'Metres, surface to surface (warp: metres short of a point, default 0).' },
            speed: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            set: { type: 'object', description: `stance: the pilot's own stance, ${STANCE_SHAPE_TEXT}.` },
            clear: { type: 'boolean', description: "stance: true takes the pilot's own stance away." }
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
    description: `Switches prop mods (MWDs and afterburners) on or off for ships, a whole fleet, a wing or a squad, live, as EVE's module rules do: switching on applies at the next 1 s Destiny tick; switching off lets the running cycle finish (10 s for an MWD, 7.5 s for an AB with max skills, 20 / 15 s capital) and stops at its end. Switching on while stopping keeps it running; off while activating cancels it. A running module swaps the ship's mass and max velocity (and the MWD's signature bloom) for the module's on both Destiny parks; the ship accelerates or slows at its agility. Fleet members keep following in formation at their own, now boosted, speeds; the switch never takes a ship out of formation, so switch the whole fleet to move it faster. Entering warp switches a running module off (it stays off after landing); switching on is refused in warp (allowed while aligning, which slows the align). A warp scrambler on the ship switches a running microwarpdrive off at once and refuses switching it on (it stays off once the scram ends); afterburners are unaffected. Ships fitting "${PROP_MOD_MODULE_NONE}" and, switching on, ships in warp are skipped. Live only: not written to the document (set_prop_mods in patch_scene sets the state at load). The engine sound plays on activation and deactivation once the tab has audio on (click the view). delay (0 to 1) is how slowly the pilots respond: each ship switches after its own pseudo-random time, up to delay × ${MAX_FLEET_ORDER_DELAY} s in whole ticks (the same order at the same tick responds the same way), so a fleet's modules come on staggered; unset, each pilot switches after its reaction (ships[].pilot, or its personality fleet's draw), a pilot with none at once. Returns { tick, active, ships: [{ id, module, state, at? (the tick an activation applies), stopsIn? (s), respondsIn? (s until a delayed pilot switches) }], skipped: [{ id, reason }] }; get_state shows each ship's propMod (queued: a switch its pilot has yet to make). For a fitted ship this is switch_modules for its "prop" module (the same Destiny calls).`,
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'true switches on, false off.' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." },
        delay: { type: 'number', minimum: 0, maximum: 1, description: `Pilot response: 0 at once to 1 very delayed (each ship up to ${MAX_FLEET_ORDER_DELAY} s); unset, each pilot's reaction (ships[].pilot, or its personality fleet's draw), else at once.` }
      },
      required: ['active']
    }
  },
  {
    name: 'switch_modules',
    where: 'page',
    description: `Switches fitted modules (ships[].fit) for ships, a whole fleet, a wing or a squad, live, on EVE's module timing: "active" runs them (it applies at the next 1 s Destiny tick, then cycles), "online" stops them (a running module finishes its cycle, rounded up to a tick; an activation not yet applied is cancelled; an offline module comes online at the next tick) and "offline" takes them offline (a running one at its cycle end). After a stop a module waits out its reactivation delay (state reactivating; "active" meanwhile queues it). modules are selectors: a key ("mid-2", get_state fit.modules), a category (${MODULE_CATEGORIES.join(', ')}), a weapon kind ("turret", "launcher"), "all", or a module's name in any case. A ship whose fit has not resolved, or has no module a selector names, is skipped. Running modules apply their dogma at once: hardeners raise resists, siege and triage change the ship's physics, a suppressor shrinks its signature; local repairers repair the ship and remote repairers their target (shield at a cycle's start, armor and hull at its end), in the damage model get_state's defense reports. Webs slow their target (its max velocity, stacking-penalized, scaled by falloff at each cycle start and its web resistance) and target painters grow its signature; points and scrams add their strength to its warp scramble status (above 0 it cannot warp: warp orders are refused and a warp still aligning is cancelled), and a scram also switches its microwarpdrive off at once and keeps it off; neuts and nos drain a fitted target's live capacitor and remote capacitor transmitters fill it, at each cycle start (a nos never below its shooter's level). Sensor dampeners, weapon disruptors and ECM cycle without effect (their effect on locks and accuracy is not modelled yet); command bursts and cap boosters cycle without effect. Turrets fire at the ship's target (set_target; a switch's target becomes it first, and may be an authored object) once it is locked: switched on before the lock completes they wait in activating with the lock note (EVE's pre-activation), and a lost lock stops them at their cycle end. They fire once per weapon cycle (their rate of fire with every skill at V), each shot rolled on EVE's hit chance (Destiny's GetAccuracy: tracking, angular velocity, signature, optimal and falloff) and doing EVE damage through shield, armor and hull, then drawn one cycle-exact tick later with the game's firing effect and impacts (a miss draws past the hull); a new target is taken at their first cycle once it is locked, a cleared one stops them at their cycle end. engage keeps them firing. Launchers run the same way on the ship's target, once locked and at any range: each cycle start launches one missile (the loaded charge, else a fitting missile from the cargo, else the hull race's Tech I missile) that flies as a Destiny ball pursuing the target at the missile's speed and hits on contact with EVE's missile damage (min(1, S/E, (S/E x Ve/Vt)^drf) of its damage from the target's live signature and speed, no roll) through shield, armor and hull; it runs out of flight time on EVE's whole-second rule, is lost (flies on, no damage) when its target dies, warps or is removed, and vanishes when its own ship warps, dies or is removed. Refused, with a reason in skipped: bomb launchers (not modelled yet) and launchers without missiles loaded, micro jump drives and field generators, cloaks, cynos, bubbles, smartbombs and ECM bursts (not modelled yet); activating passive modules (only online or offline); rigs and subsystems offline; the prop mod offline; activating beyond a group's limit (maxGroupActive; maxGroupOnline when onlining), in warp, or a targeted module (remote repairers, webs, scrams, points, neuts, ...) without target (a weapon without the ship's target), on its own ship, on a ship in warp or out of reach (optimal + 2 x falloff, surface to surface on EVE radii). A targeted module runs on target, a ship in the scene; effectiveness (EVE's falloff curve) scales its repairs. Remote repairers wait for a lock on their target like turrets (EVE): switched on before it completes they wait in activating with the lock note, and a lost lock stops them at their cycle end; one running on another target is refused until it is switched online. Switching a fleet logi's remote repairers takes it off auto-repair (get_state autoRepair.state manual) until auto_repair is called on its group, and the result's notes say so. Webs, scrams, points, neuts, nos and transmitters still run without a lock. A running targeted module stops at its cycle end when its target drifts out of reach, at once when its target is removed or warps; entering warp stops a ship's targeted modules and those that are not warp safe at once. The "prop" module is the ship's prop mod: it switches through the same Destiny calls as switch_prop_mods. Live only: never written to the document (a fit's /OFFLINE is the persistent offline marker). delay (0 to 1) staggers the pilots as switch_prop_mods does. Returns { tick, state, ships: [{ id, modules: [{ module, name, state, at?, stopsIn?, activatesIn?, respondsIn?, target?, nextTarget?, effectiveness?, cycleTime? }] }], skipped: [{ id, module?, reason }], notes? (a logi taken off auto-repair) }; get_state shows each module's state, cycle and target.`,
    inputSchema: {
      type: 'object',
      properties: {
        modules: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Module selectors: keys ("mid-2"), categories ("hardener", "remote-armor-repairer", "prop", ...), "turret", "launcher", "all" or module names.' },
        state: { type: 'string', enum: [...MODULE_SWITCH_STATES], description: 'active runs them, online stops them, offline takes them offline.' },
        target: { type: 'string', description: "The ship id a targeted module runs on (remote repairers, webs, scrams, points, neuts, ...). For turrets and launchers it becomes the ship's target (set_target) and may be an object id; without it they fire at the ship's target." },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." },
        delay: { type: 'number', minimum: 0, maximum: 1, description: `Pilot response: 0 at once to 1 very delayed (each ship up to ${MAX_FLEET_ORDER_DELAY} s); unset, each pilot's reaction (ships[].pilot, or its personality fleet's draw), else at once.` }
      },
      required: ['modules', 'state']
    }
  },
  {
    name: 'set_target',
    where: 'page',
    description: `Gives ships, a whole fleet, a wing or a squad a target, live: another ship or an authored object (add_objects; the location's celestial:<id> stations and gates cannot be targeted yet). Their turrets turn to track it, and switch_modules { modules: ["turret", "launcher"], state: "active" } fires their turrets and launchers at it once per weapon cycle; running weapons take a new target at their first cycle once it is locked. Each ship starts its lock on the target: EVE's lock time 40000 / (scan resolution × asinh(signature)²) s from its live scan resolution and the target's live signature (an MWD's bloom included), within its max targeting range surface to surface (out of range it waits, and a lock lost out of range locks again once back), at most its max locked targets; weapons fire only at a locked target, and a ship with no EVE dogma for its hull fires unlocked. The previous target's lock is kept while weapons still fire at it. target null clears the targets (and ends an engagement): the guns return to idle and running weapons stop at their cycle end (missiles already flying fly on). No hostility check. Skipped, with a reason: the target ship itself, a ship in warp, a target in warp. A ship entering warp drops its target and every target on it; a removed target clears; a load clears every target. Live only: never written to the document. A target given here is the ship's own: it wins over its fleet groups' called targets (order_fleet targets) until it clears, then the ship takes its group's call again; target null on a ship that only follows a call is skipped (cease_fire holds its fire; order_fleet targets drop or clear ends the call). Returns { tick, target, ships: [{ id, target, previous?, source? ("called" when clearing its own target handed it its group's call), turrets (its turret count), launchers? (its launcher count), retargeted (its running weapons that follow), lock? ({ state, lockTime?, readyIn?, note? } or { refused }) }], skipped: [{ id, reason }] }; get_state shows each ship's target ({ id, kind, distance, source }), locks and shots.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The ship or object id to target; null clears the targets.' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." }
      },
      required: ['target']
    }
  },
  {
    name: 'engage',
    where: 'page',
    description: `Arms ships, a whole fleet, a wing or a squad on a target, live: the target becomes each ship's target (set_target) and its lock starts, and its selected weapons (turrets and launchers) switch active, wait for the lock and fire once per weapon cycle: each turret shot rolled on EVE's hit chance and doing EVE damage, each missile flying to the target and hitting with EVE's missile damage. The engagement keeps them firing: each tick an engaged ship's selected weapons back online switch active again, so they fire again after a lost lock (the target out of targeting range and back) or on a new set_target. It ends on cease_fire, set_target null, the ship's removal or a load; it survives the target's death (the guns hold until a new target). modules are switch_modules selectors (default ["turret", "launcher"]). Skipped, with a reason: the target itself, a ship in warp, a target in warp, a destroyed ship, a ship whose fit has not resolved, without targeting numbers or without a matching weapon. No hostility check: a warning when shooter and target share a team. The target is the ship's own (it wins over its fleet groups' called targets), and engage lifts a cease_fire hold or stand-down. Live only. Returns { tick, target, ships: [{ id, target, lock: { state, lockTime?, readyIn?, note? } or { refused }, modules: [{ module, name, state }] }], skipped: [{ id, module?, reason }], warnings? }; get_state shows each ship's engaged, locks and combat.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The ship or object id to lock and shoot.' },
        modules: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Weapon selectors as switch_modules (default ["turret", "launcher"]).' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." }
      },
      required: ['target']
    }
  },
  {
    name: 'cease_fire',
    where: 'page',
    description: `Ends the engagement of ships, a whole fleet, a wing or a squad: their engaged weapons (turrets and launchers) switch online and stop at their cycle end (missiles already flying fly on). unlock: true also clears their targets (as set_target null), and their locks drop. On a fleet member under its groups' calls (order_fleet targets) it holds: the ship keeps tracking the call and its locks but does not fire (held: "hold"); unlock stands it down from the call (held: "stand-down": no called target, its locks drop). Both last until its group calls again (a targets order, or a change to a list it takes), engage, or a load; a member firing at a call counts as engaged. Skipped: a ship neither engaged nor firing (unless it is unlocked). Live only. Returns { tick, ships: [{ id, modules (the weapons stopped), unlocked?, held? }], skipped: [{ id, reason }] }.`,
    inputSchema: {
      type: 'object',
      properties: {
        unlock: { type: 'boolean', description: 'Also clear the targets and drop the locks (default false).' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." }
      }
    }
  },
  {
    name: 'set_hp',
    where: 'page',
    description: `Sets the shield, armor and structure HP of ships, a whole fleet, a wing or a squad, live: to make them look battle damaged for a shot, or to start a low-HP fight. Give shield, armor and/or structure (each layer given is set; the others keep their HP), or total (the three combined, taken off a full ship shield first, then armor, then structure, as damage spills). A value is HP (a number), a percent of the layer's max ("40%", 0% to 100%; total: of the three maxes summed), or a seeded random draw { min, max, distribution?: "uniform" (default) | "normal" (mean?, sd?: default the middle and a quarter of the range; truncated to the range) | "triangular" (mode?: default the middle) }, its min, max, mean, sd and mode all in HP or all in percent (a percent sd is points of the max). Each ship draws on (seed, its id, the layer or total): the same call on the same scene gives the same HP, in any selection order; seed (default the document's combat seed) gives another mix. intent "cinematic" (default) never kills: structure the set writes is held at 1 HP at least; "gameplay" plays EVE's rule: a set that leaves structure at 0 destroys the ship at the next tick as combat.death says (explode: the death explosion at once, then it leaves; flag: recorded, it flies on), once it is out of warp and landed. HP above a layer's max is set to the max (clamped notes). Live only (never written to the document; a load restores full HP): shields recharge from the set HP on EVE's curve, repairers repair it, armor and structure stay until repaired or shot (a refit that re-resolves the fit brings the ship back at full HP), and the hull shows it at once (armor holes, hull flicker and fires; later hits draw on the shield above 5 %, else the armor above 5 %, else the hull). A ship whose fit is still resolving waits (pending) and takes the set once its HP is known. Skipped, with a reason: a destroyed ship, a ship with no EVE dogma for its hull. Returns { tick, intent, seed? (when a value is random), ships: [{ id, shield, armor, structure: { hp, max, was }, clamped? }], destroys? ([{ id, mode, note? }]: the gameplay deaths at the next tick), pending? ([{ id, note }]), skipped: [{ id, reason }] }; get_state shows each ship's defense (current and max HP per layer) and hpSet (the latest set).`,
    inputSchema: {
      type: 'object',
      properties: {
        shield: { ...HP_VALUE_SCHEMA, description: 'The shield HP to leave: HP, "<p>%" of its max, or { min, max, distribution? }.' },
        armor: { ...HP_VALUE_SCHEMA, description: 'The armor HP to leave.' },
        structure: { ...HP_VALUE_SCHEMA, description: 'The structure (hull) HP to leave.' },
        total: { ...HP_VALUE_SCHEMA, description: 'The HP to leave across the three layers, drained from full shield first (not with shield, armor or structure).' },
        intent: { type: 'string', enum: [...HP_SET_INTENTS], description: 'cinematic (default): never kills; gameplay: a ship left at 0 structure is destroyed at the next tick.' },
        seed: { type: 'integer', minimum: 0, maximum: 4294967295, description: "Keys the random draws (default the document's combat seed)." },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids (or give fleet).' },
        fleet: { type: 'string', description: 'A fleet id: every ship holding a position in it.' },
        wing: { type: 'string', description: "With fleet: the wing's commander and its squads." },
        squad: { type: 'string', description: "With fleet: the squad's members." }
      }
    }
  },
  {
    name: 'order_fleet',
    where: 'page',
    description: `Commands a whole fleet, one wing or one squad, as EVE's fleet commands do. Select it with fleet, and optionally wing or squad (a wing or squad order never includes the FC, who heads the whole fleet). by is the ship giving the order. It must command the group: its squad commander, its wing's commander or the fleet commander. Without by, the group's own commander gives the order, else the commander above it. An order from any other ship is refused.
Orders:
{ "type": "direction" | "goto" | "approach" | "keep-at-range" | "orbit" | "stop", ...order_ship's fields } moves the group. The order goes to its leader: for the fleet, the FC; for a wing or squad, its commander, else the giver when it is in the group, else the squad's lead (the member it anchors on), else its first member. The rest follow in formation. A wing or squad then flies apart from its fleet on its leader (get_state following.group, command.away) until regroup. A fleet move leaves groups that fly apart, and detached members, where they are.
{ "type": "warp", "point": [x, y, z] | "target": "<ship, object or celestial target id, or a name as order_ship takes>", "range"? } warps the group in formation (a planet, moon, star or belt by name: range off its surface on the line toward the FC): the FC warps the fleet, a wing commander only their wing, a squad commander only their squad. Every ship aligns at once and warps at its own hull warp speed to its slot around the leader's landing, in the warp's heading, so the group lands in formation. Ships that land first hold until the leader has landed; then all follow again. Some ships do not warp and fly to their slot instead (skipped): a ship that cannot move, or one whose slot is under ${MIN_WARP_DISTANCE / 1000} km away. A ship already in warp is skipped too and keeps its own warp, and a member still arriving by warp (warpIn) keeps arriving and forms up once it lands; a group whose leader is still arriving is refused until it lands. A fleet warp brings every ship that flies apart or is detached back into formation. A warped wing or squad flies apart on its leader until regroup.
{ "type": "anchor", "ship"?: "<ship id>" | null, "range"?: <metres> | null } re-anchors every squad of the group, as set_anchor does: ship null is the FC, range null is the role default.
{ "type": "break-off", "range"?: <metres, default ${DEFAULT_BREAK_OFF_RANGE}>, "ship"?: "<member>" } (a squad only) anchors the squad on its own lead (ship, else its commander, else its current lead, else its first member), range off the FC. The squad's home keeps the anchor it had.
{ "type": "regroup" } brings the group back: broken-off squads get their home anchor back; every ship that flies apart or is detached rejoins its fleet formation; ships ${MIN_WARP_DISTANCE / 1000} km or more from their slot warp to it in formation.
{ "type": "targets", "primary": "<id>" | "queue": ["<id>", ...] | "set": [...] | "drop": [...] | "next": true | "clear": true } calls the group's targets live, with exactly one action. The group's called list holds ship or object ids in kill order (the document's "targets" are the opening calls a load starts with; the order edits the live list at once and never saves it, so a reload replays the same fight): its first live entry is the group's primary (destroyed, missing and warping targets are skipped) and the live rest its queue. primary puts an id first, the rest keeping their order behind it; queue appends the ids it does not call yet; set replaces the list ([] clears); drop takes ids off (an id it does not call is refused); next moves past the live primary; clear empties it. The FC calls for the fleet, a wing commander for their wing, a squad commander for their squad. The group's own ships and location celestials (celestial:<id>) cannot be called. A kill never edits the list (a load revives the opening call); removing a called ship or object takes it off every list, live and document. A patch that edits a group's document targets replaces its live call.
Every member without its own target locks and shoots the primary of the nearest group in its chain with a live primary (its squad's, else its wing's, else the fleet's; the FC takes only the fleet's call, a logi squad only its own squad's), its turrets kept firing as engage keeps them, pre-locks the next ${CALLED_PRE_LOCKS} queued targets within its lock limit, and moves to the next called target at the tick after the primary dies, warps off or is removed. Own targets (set_target, engage, switch_modules) win until they clear. cease_fire holds a member's fire (unlock stands it down) until its group calls again: any targets order re-arms the group. With delay each member keeps shooting what it shot until it responds; kills, removals and patches move members on at once. No auto-approach: a member out of lock range keeps its formation and its lock waits (bring the fleet in with approach or keep-at-range). A targets order returns targets (the live list after), primary and queue (live), ships ([{ id, target, source, respondsIn?, lock? }]), skipped ([{ id, reason }]: its own target, logi, in warp, holding, stood down, responding, or following a nearer group's call) and warnings? (a destroyed id in queue or set, skipped until a load; a target on the giver's team); a destroyed primary is refused.
{ "type": "free-fire", "on": true | false } lets the group's members pick their own targets, live (never saved; a load ends it): a member whose chain (its squad, wing or fleet; the FC the fleet's only) has free fire on and that has no called primary to take, no own target and is not logi or stood down locks and shoots the nearest hostile (a ship on another team) within its own reach (its turrets' optimal + falloff, its launchers' range, capped at its lock range) once its pilot responds, and picks again the same way when that target dies, warps off or leaves its reach. Precedence: own target, then the group's call (a call takes over at once), then free fire. cease_fire holds a free target unarmed (unlock clears it); free fire on re-arms the group as a targets order does; off clears the free targets at once. Returns order_fleet's fields plus freeFire (on) and ships ([{ id, target, source, respondsIn? }]). get_state: target.source "free", call.state "free-fire" (call.free: the pick, picksIn: seconds until a pick), and freeFire: true on the group.
{ "type": "stance", "set": ${STANCE_SHAPE_TEXT} | "clear": true } sets the group's stance live (never saved; a load resets it to the document's), with a targets order's authority: set replaces the group's stance whole, clear takes it away (the levels above apply again). See the scene format's "stance" for how it resolves; a squad or wing in on must be of this fleet. Returns order_fleet's fields plus stance (the group's live stance, null when cleared) and ships ([{ id, type, flownBy, respondsIn? }]: each member's resolved stance and who flies it).
delay (0 to 1) is how slowly the pilots respond: every ship but the giver takes its own pseudo-random time, up to delay × ${MAX_FLEET_ORDER_DELAY} s in whole ticks (the same order at the same tick responds the same way), before its order or formation warp applies; a formation warp also waits for its leader's. Without delay each pilot answers after its reaction (ships[].pilot.reaction, or its personality fleet's draw; reaction r takes round((1 - r) × ${MAX_FLEET_ORDER_DELAY} s × 0.5 to 1)), and a pilot with no reaction at once; warps and regroups never wait on reactions (a fleet warp is simultaneous), and delay 0 makes everyone answer at once. get_state shows respondsIn on a ship whose pilot has yet to respond.
Moves, warps, targets and free fire are live and not saved; with at the same object becomes a timeline cue ({ "at", "order_fleet": { ... } }). anchor, break-off and regroup edit the document as patch_scene does. Targets must be outside the group. A wing or squad move and any warp wait until the fleet is planned (get_state fleets[].formation.ready).
Returns { fleet, wing?, squad?, order, by, leader, tick, delays? (each responding ship's seconds, when any pilot waits), ships (the ships it moves; a warp: [{ id, landing }], each ship's predicted slot landing), skipped? ([{ id, reason }]), landing? (a warp: the leader's predicted landing), warping? (a regroup: the ships warping back), resolved? (a target given by name, as order_ship) }. Document orders also return their operations and the patch result (scene, warnings, changes, and builds: the per-ship build reports). get_state shows each fleet's, wing's and squad's command: its state (idle, moving, warping, broken-off or regrouping), its leader, away, home, the last order_fleet and the warp progress. Each member's following also shows warping and leading. A fleet warp leaves out members a point or scram holds (skipped with the reason; they stay regrouped), and a warp led by a tackled leader is refused.`,
    inputSchema: {
      type: 'object',
      properties: {
        fleet: { type: 'string', description: 'The fleet id.' },
        wing: { type: 'string', description: "With fleet: one wing (its commander and its squads' members, never the FC)." },
        squad: { type: 'string', description: 'With fleet: one squad (its members, never the FC).' },
        by: { type: 'string', description: 'The ship giving the order: a commander of the group (default: its nearest commander).' },
        delay: { type: 'number', minimum: 0, maximum: 1, description: `Pilot response: 0 at once to 1 very delayed (each ship up to ${MAX_FLEET_ORDER_DELAY} s); unset, each pilot's reaction (ships[].pilot, or its personality fleet's draw), else at once.` },
        order: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...FLEET_ORDER_TYPES] },
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'World position to fly or warp to, metres.' },
            target: { type: 'string', description: 'A ship outside the group, an object or celestial:<id> to approach, keep range on, orbit or warp to; or an object or celestial name.' },
            range: { anyOf: [{ type: 'number', minimum: 0, maximum: MAX_ORDER_RANGE }, { type: 'null' }], description: 'Metres, surface to surface (warp: short of a point, default 0; anchor: null resets to the role default; break-off: off the FC).' },
            speed: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            ship: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'anchor: the ship to anchor on (null: the FC); break-off: the squad member to lead it.' },
            primary: { type: 'string', description: 'targets: the ship or object to call first.' },
            queue: { type: 'array', items: { type: 'string' }, description: 'targets: ids to call after the list.' },
            set: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }], description: "targets: the whole list, in kill order ([] clears); stance: the group's stance object." },
            drop: { type: 'array', items: { type: 'string' }, description: 'targets: ids to take off the list.' },
            next: { type: 'boolean', description: 'targets: true moves past the live primary.' },
            clear: { type: 'boolean', description: "targets: true empties the list; stance: true takes the group's stance away." },
            on: { type: 'boolean', description: 'free-fire: true lets members without a call pick their own targets, false ends it.' }
          },
          required: ['type']
        }
      },
      required: ['fleet', 'order']
    }
  },
  {
    name: 'auto_repair',
    where: 'page',
    description: `Sets a fleet's, wing's or squad's logi auto-repair: whether its logi repair fleet members under fire on their own, and how they pick. A logi is a fleet member with an online remote repairer (remote armor repairers, shield transporters, remote hull repairers) whose auto-repair is on: on by default for logi squads (role "logi"), off elsewhere, so a rep-fitted ship in another squad repairs once its squad, wing or fleet turns it on. Each key resolves from the nearest group that sets it (its squad, its wing, its fleet). A logi repairs members of its own fleet (never itself, other fleets, free ships, objects, or a ship that is destroyed, warping or arriving), and keeps its anchor: members out of its reach are reported, never approached.
How it picks, per repair layer, every pass: a member under fire (HP lost to shots in the last ${REPAIR_PRESSURE_SECONDS} s) whose reps do not yet cover it comes first, then a member under fire that is covered, then a calm member below ${Math.round(REPAIR_TOP_OFF_FRACTION * 100)} % on its layer to top off (repaired to full). The policy orders a tier: urgent (default ${DEFAULT_AUTO_REPAIR_POLICY}: the soonest to die at its incoming damage net of the reps on it), damaged (the lowest HP) or shot-at (the most incoming damage). Coverage: reps worth ${Math.round(REPAIR_COVER_MARGIN * 100)} % of a member's incoming damage cover it, so the next logi takes another member: one primary gets every logi, split fire gets split reps. Sticky: a logi keeps its target unless a better tier appears or a member at least ${REPAIR_SWITCH_RATIO}× as urgent in the same tier, and leaves one that is healed and calm, dead, gone, warping or out of reach. Its reps run on EVE's timing: they wait for a lock on the target (lock time from its scan resolution and the target's signature), a rep running on another target switches at its next cycle start (its last cycle still lands on the old one, and the beam restarts on the new one), and reps that cannot reach the target stay off. Each logi pre-locks up to ${REPAIR_PRE_LOCKS} members under fire or being locked by hostile ships, within its lock limit.
on: true or false turns it on or off; policy (${AUTO_REPAIR_POLICIES.join(', ')}) sets how it picks; null resets a key so the group inherits it; an omitted key stays. Turning it off stops the reps it switched on at their cycle end (the last cycle still lands); reps it never switched are left alone. It writes the group's autoRepair in the document (update_fleet / update_wing / update_squad set, which patch_scene and a timeline can cue), so it saves. A switch_modules on a logi's remote repairers takes that logi off auto-repair (get_state autoRepair.state manual); calling auto_repair on its group hands it back. Per-ship selection (ships) is refused: a ship repairs as its squad does.
Returns { fleet, wing?, squad?, autoRepair (the group's field after, or null), ships: [{ id, on, policy, source, state, target?, reason? }] (the group's ships), operations, and the patch result (scene, warnings, changes, builds) when it changed the document }. get_state shows each logi's autoRepair (state, target, why, hps, pre-locks, out-of-reach members), each ship's combat.repairs and each fleet's autoRepair (counts and targets).`,
    inputSchema: {
      type: 'object',
      properties: {
        fleet: { type: 'string', description: 'The fleet id.' },
        wing: { type: 'string', description: "With fleet: one wing (it sets the wing's autoRepair)." },
        squad: { type: 'string', description: "With fleet: one squad (it sets the squad's autoRepair)." },
        on: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'true or false; null inherits from the group above.' },
        policy: { anyOf: [{ type: 'string', enum: [...AUTO_REPAIR_POLICIES] }, { type: 'null' }], description: 'urgent (soonest to die), damaged (lowest HP) or shot-at (most incoming damage); null inherits.' }
      },
      required: ['fleet']
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
    description:
      "Points the camera at one ship, object or asteroid field (its envelope), or fits every ship (every object when the scene has no ships, every field when it has neither) when target is omitted, without editing the saved camera settings unless persist is true. Without a distance it fits: the target's bounding sphere spans 87 % of the view's height (its width in a portrait view).",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ship, object or asteroid field id; omit to frame all ships.' },
        yaw: { type: 'number' },
        pitch: { type: 'number' },
        distance: { type: 'number' },
        persist: { type: 'boolean', description: 'Also write this camera into the scene document.' }
      }
    }
  },
  {
    name: 'list_hardpoints',
    where: 'page',
    description: `Lists the cinematic camera's generated positions (hardpoints) on a subject, resolved on the scene as drawn now: name, kind, description, eye, look, up (scene metres around the origin), fov, distance, anchored and a note when one cannot resolve. Four kinds of subject: a ship (ship: ${SHIP_HARDPOINT_NAMES.join(', ')}; scaled by its hull radius), a group (fleet [+ wing | squad], or ships: ${GROUP_HARDPOINT_NAMES.join(', ')}; scaled by the formation), a landmark (object, a scene object id, or celestial, an id, "celestial:<id>" or a name from get_state.location: ${LANDMARK_HARDPOINT_NAMES.join(', ')}, plus into-celestial aimed at it), or none for the engagement (teams?: the two teams, default the two biggest: ${ENGAGEMENT_HARDPOINT_NAMES.join(', ')}). Anchored hardpoints hold their eye once a shot places it: flyby waits ahead on the ship's path; warp-landing waits at the landing of the group's warp (order_fleet / order_ship warp, or its arrival by warpIn), looking back up the lane, and frames the group where it is until it warps. Ships still arriving by warp are left out of every other hardpoint (and the engagement) until they land. Hardpoints re-resolve every frame, so a shot on one follows its subject. Play one with play_shot { hardpoint: { name, <subject> } }. Returns { kind, subject (its centre, radius and axes; the engagement's teams and their centroids a and b), hardpoints, warnings }.`,
    inputSchema: {
      type: 'object',
      properties: {
        ship: { type: 'string', description: 'A ship id: its ship hardpoints.' },
        fleet: { type: 'string', description: 'A fleet id: its group hardpoints (narrow with wing or squad).' },
        wing: { type: 'string' },
        squad: { type: 'string' },
        ships: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ship ids framed as one group.' },
        object: { type: 'string', description: 'A scene object id: its landmark hardpoints.' },
        celestial: { type: ['string', 'integer'], description: 'A location celestial (id, "celestial:<id>" or exact name): its landmark hardpoints.' },
        teams: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: "The engagement's two teams (with no subject), or the ships a landmark frames." },
        target: { type: 'string', description: "over-the-shoulder's target ship (default the nearest enemy)." },
        side: { type: 'string', enum: ['port', 'starboard'], description: 'The side the overlook, warp-landing and the landmark hero and foreground take.' },
        fov: { type: 'number', minimum: 5, maximum: 120, description: 'Overrides every hardpoint lens, degrees.' },
        fill: { type: 'number', minimum: 0.05, maximum: 1.5, description: 'Overrides how much of the frame the subject fills.' },
        bank: { type: 'boolean', description: "Ship hardpoints stand in the hull's banked frame (rolling with it)." }
      }
    }
  },
  {
    name: 'play_shot',
    where: 'page',
    description: `Plays one cinematic camera shot on the scene clock (driver claude), replacing whatever plays; a blend starts from the drawn pose. A shot is { hardpoint | pose | shot, moves?, duration?, end?, transition?, lag?, letterbox?, hud?, clearance?, name? }:
- hardpoint: { name, <subject>, target?, side?, fov?, fill?, bank? }, a generated position that follows its subject every frame (list_hardpoints shows them): ship hardpoints take ship (${SHIP_HARDPOINT_NAMES.join(', ')}); group ones fleet [+ wing | squad] or ships (${GROUP_HARDPOINT_NAMES.join(', ')}); landmark ones object or celestial (${LANDMARK_HARDPOINT_NAMES.join(', ')}); engagement ones teams? (${ENGAGEMENT_HARDPOINT_NAMES.join(', ')}; into-celestial needs celestial or object).
- pose: { eye, look, up?, roll? (degrees), fov? }, a free placement held until stopped. eye and look are each [x, y, z] scene metres, { position }, or a point on a hull { ship | object, offset?: [forward, starboard, up], units?: "metres" | "radii", bank? }: the eye rides the hull, the look follows it.
- shot: a named library shot (list_shots): ${CAMERA_SHOT_NAMES.join(', ')}. Give its subject keys (ship, fleet, wing, squad, ships, teams, object, celestial, target) beside it, plus fov, fill, bank (on its hardpoint) and side, duration (the builder rescales its moves); end, transition, lag, letterbox, hud, clearance and name replace the library's, and moves are added after its own. Library shots hold their last frame when their time is up.
- moves (applied in order in the hardpoint's frame), each with at? (s into the shot), duration?, easing? (${CINEMA_EASINGS.join(', ')}): dolly / truck / crane { distance m }, push { factor: < 1 in }, zoom { fov }, orbit { axis?, rate? °/s | angle? ° }, roll { rate? | angle? }, spin { axis, rate? | angle? } (axis up, subject-up, view-up or [x, y, z]), path { points (waypoints as above, bare [forward, starboard, up] with frame "subject"), frame?: world | subject, units?: metres | radii (of the subject), look?: path | subject | a waypoint, up?: base | world | { ship | object } }, track { lag s }, shake { amplitude °, frequency? Hz, decay? s }. Types: ${CAMERA_MOVE_TYPES.join(', ')}.
- duration s (omitted: hold until stopped); end: release (default: blend back to the orbit camera) or hold (keep the last frame); transition: "cut" (default) or "blend" or { type: "blend", duration? (1.5 s), easing? }; lag { eye?, look? } (time constants, s); letterbox: an aspect (2.39) or false; hud: false hides the overlay; clearance: hull radii the eye keeps out of (false: none).
Examples: { "hardpoint": { "name": "hero-port", "ship": "tfis-fc" }, "duration": 8, "transition": "blend", "moves": [{ "type": "push", "factor": 0.7 }, { "type": "roll", "angle": 12 }] }; { "pose": { "eye": [0, 3000, -12000], "look": { "ship": "tfis-fc" }, "roll": 8, "fov": 35 } }; { "shot": "overlook-pull-out" }.
The user's drag or wheel on the view takes the camera back. While the director (auto_camera) is on, a play takes the camera from it, and it takes it back when the shot ends (end release). While a movie owns the camera (a started timeline with camera cues or a movie block), a play is a live preview: a time_control jump, a movie seek or a script edit's re-simulation returns the movie's camera. Returns { state, driver, shots (the normalized shots as played, library shots expanded: copy and tweak one as an explicit shot), warnings }; get_state.cinema shows its progress; look with screenshot.`,
    inputSchema: {
      type: 'object',
      properties: {
        shot: { type: 'string', enum: [...CAMERA_SHOT_NAMES], description: 'A library shot (list_shots).' },
        hardpoint: { type: 'object', description: '{ name, ship | fleet [+ wing | squad] | ships | teams | object | celestial, target?, side?, fov?, fill?, bank? }' },
        pose: { type: 'object', description: '{ eye, look, up?, roll?, fov? }: eye and look are [x, y, z], { position } or { ship | object, offset?, units?, bank? }.' },
        moves: { type: 'array', items: { type: 'object' }, description: `Moves: ${CAMERA_MOVE_TYPES.join(', ')}.` },
        duration: { type: 'number', exclusiveMinimum: 0, description: 'Seconds; omit to hold until stopped.' },
        end: { type: 'string', enum: [...CAMERA_SHOT_ENDS], description: 'What the shot does when its duration is up.' },
        transition: { description: '"cut", "blend" or { type: "blend", duration?, easing? }.', anyOf: [{ type: 'string', enum: ['cut', 'blend'] }, { type: 'object' }] },
        lag: { type: 'object', description: '{ eye?, look? } time constants, seconds.' },
        letterbox: {
          description: 'An aspect in [0.5, 4] (2.39 for scope), or false.',
          anyOf: [
            { type: 'number', minimum: 0.5, maximum: 4 },
            { type: 'boolean', enum: [false] }
          ]
        },
        hud: { type: 'boolean' },
        clearance: {
          description: 'Hull radii the eye is kept out of each hull (default 1.15), or false.',
          anyOf: [
            { type: 'number', minimum: 0, maximum: 10 },
            { type: 'boolean', enum: [false] }
          ]
        },
        name: { type: 'string' },
        ship: { type: 'string', description: "A library shot's ship." },
        fleet: { type: 'string', description: "A library shot's fleet." },
        wing: { type: 'string' },
        squad: { type: 'string' },
        ships: { type: 'array', items: { type: 'string' } },
        teams: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
        object: { type: 'string' },
        celestial: { type: ['string', 'integer'] },
        target: { type: 'string' },
        side: { type: 'string', enum: ['port', 'starboard'] },
        fov: { type: 'number', minimum: 5, maximum: 120 },
        fill: { type: 'number', minimum: 0.05, maximum: 1.5 },
        bank: { type: 'boolean' }
      }
    }
  },
  {
    name: 'play_sequence',
    where: 'page',
    description:
      "Plays cinematic camera shots back to back on the scene clock (driver claude): shots is a list of play_shot shots, explicit or library references ({ shot: '<name>', ... }). Every shot but the last needs a duration; each starts on its own transition (a cut, or a blend from the previous shot's pose); the last holds without a duration, else releases or holds per its end. Returns as play_shot; get_state.cinema.sequence shows the index and the whole sequence's progress.",
    inputSchema: {
      type: 'object',
      properties: { shots: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'The shots, in order.' } },
      required: ['shots']
    }
  },
  {
    name: 'stop_shot',
    where: 'page',
    description:
      "Stops the cinematic camera. By default it hands the camera back to the user: the orbit camera takes the shot's last eye and look (and follows its ship when it framed one) and the view blends there in 0.5 s. adopt: false blends back to the orbit's previous view instead; cut: true switches at once. pause: true freezes the shot instead (its clock, moves and sequence stop; the hardpoint still follows its subject) until resume_shot. A stopped or released shot (stop_shot, frame_camera, the user's drag) stays resumable until a new play, a load, or its subject leaving. While the director (auto_camera) is on, stop_shot over a Claude or timeline shot hands the camera back to the director, and over the director's own shot hands it to the user (auto_camera or D hands it back). Returns get_state.cinema.",
    inputSchema: {
      type: 'object',
      properties: {
        pause: { type: 'boolean', description: 'Freeze the shot instead of stopping it.' },
        adopt: { type: 'boolean', description: 'The orbit camera takes the shot view (default true).' },
        cut: { type: 'boolean', description: 'No blend back.' }
      }
    }
  },
  {
    name: 'resume_shot',
    where: 'page',
    description: 'Resumes the cinematic camera: a paused shot continues where it froze; otherwise the last stopped or released shot or sequence plays again from where it stopped, blending in from the drawn view over 1.5 s. Errors when nothing is paused or stopped; a no-op while a shot plays. Returns get_state.cinema.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'auto_camera',
    where: 'page',
    description: `Hands the camera to the automatic director, which cuts between hardpoints and library shots by what is happening: fleets opening fire, a called primary switching, a ship about to die or exploding, a warp-in landing, reps holding a ship up, MWD bursts, close passes, and plain motion on a scene without combat. It decides at each 1 s Destiny tick from the simulation (deterministic for a given scene, event stream and seed), holds each shot between the pace's min and max (slow ${DIRECTOR_PACES.slow.min}–${DIRECTOR_PACES.slow.max} s, normal ${DIRECTOR_PACES.normal.min}–${DIRECTOR_PACES.normal.max} s (default), fast ${DIRECTOR_PACES.fast.min}–${DIRECTOR_PACES.fast.max} s; an urgent event such as a kill or a landing may cut after 2 s), keeps one side of the axis of action between the two teams (the 180° rule), varies wide, medium and close, and favours recognisable ships (the FC, the called primary, the followed subject). Any call turns it on (on: false turns it off and hands the user the view) and sets its bias, key by key (a value sets it, null resets it, an omitted key stays; the bias lasts until the tab reloads): follow { fleet } (its acting FC, the successor after a death) or { ship }; favour wide, medium or close; sun: into the sun when possible; teams [a, b] (the axis; default the two biggest with landed ships); pace; hold { min ${DIRECTOR_HOLD_LIMITS.min[0]}–${DIRECTOR_HOLD_LIMITS.min[1]} s, max up to ${DIRECTOR_HOLD_LIMITS.max} s } (wins over pace); letterbox and hud while it drives; seed (default the document's combat seed). follow and teams must name a fleet, ship or team in the scene. Claude's play_shot / play_sequence and timeline camera cues take the camera and hand it back when they end; stop_shot over them hands it back at once; the user's drag, frame_camera or a camera change takes it until auto_camera or D hands it back. Returns { director (get_state.cinema.director), cinema (get_state.cinema), log (the last 20 cuts: tick, at, framing, subject, scale, side, why) }.`,
    inputSchema: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'false turns the director off (default true: any call turns it on).' },
        follow: { anyOf: [{ type: 'object', properties: { fleet: { type: 'string' } }, required: ['fleet'] }, { type: 'object', properties: { ship: { type: 'string' } }, required: ['ship'] }, { type: 'null' }], description: '{ fleet } follows its acting FC, { ship } a ship; null clears.' },
        favour: { anyOf: [{ type: 'string', enum: [...DIRECTOR_SCALES] }, { type: 'null' }], description: 'Favour a scale: wide, medium or close; null clears.' },
        sun: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'Into the sun when possible.' },
        teams: { anyOf: [{ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, { type: 'null' }], description: 'The axis of action: two team ids.' },
        pace: { anyOf: [{ type: 'string', enum: [...DIRECTOR_PACE_NAMES] }, { type: 'null' }], description: 'How long shots hold: slow, normal (default) or fast.' },
        hold: { anyOf: [{ type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } }, { type: 'null' }], description: 'Hold seconds { min?, max? }; wins over pace.' },
        letterbox: { anyOf: [{ type: 'number', minimum: 0.5, maximum: 4 }, { type: 'boolean', enum: [false] }, { type: 'null' }], description: 'The aspect while it drives (2.39), or false.' },
        hud: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'false hides the overlay while it drives.' },
        seed: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }], description: "The jitter seed (default the document's combat seed)." }
      }
    }
  },
  {
    name: 'timeline',
    where: 'page',
    description:
      'Reports and controls the scene\'s script (the document\'s timeline cues and ships\' orders) as the page plays it. action "status" (default) reports; "play" starts a stopped timeline (t = 0 at the next tick, live), plays a ready one (loaded paused) or resumes a paused one; "pause" holds the cursor and the ship scripts while the ships fly on (later cues shift by the pause); "restart" reloads the authored document, replaying the script from the placements (paused: true holds it at t = 0, ready, until play). camera: false hands the camera to the user (a timeline shot playing releases, later camera cues are skipped, and a director an auto_camera cue turned on turns off) and true plays them again; it lasts until the tab reloads. Returns the state (idle, stopped, preparing, ready, playing, paused, done), time (whole seconds played), startedAt (the world tick of t = 0), held (the scene clock held for the prepare), the cue counts, next, last and failed cues, waiting (event cues still waiting for their event: when, armsIn, latestIn), beat (the last fired fleet and camera cue), events (the run\'s event log: count and the last ones), list (every cue: id, at, when / whenText, arms, latest, due, event (what resolved an event cue), name, action, kind, state waiting / pending / fired / failed / skipped / missed, tick, note, error, its lever\'s compact result), ships (every ship script: state, step, steps, order, startsIn, endsIn, note), liveEdits (what cues changed in the live scene), preparing (what it waits for) and note; restart adds the load\'s warnings and changes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'play', 'pause', 'restart'], description: 'Default status.' },
        paused: { type: 'boolean', description: 'restart only: hold at t = 0 until play.' },
        camera: { type: 'boolean', description: "Whether the timeline's camera cues play." }
      }
    }
  },
  {
    name: 'time_control',
    where: 'page',
    description: `Pauses or plays the scene, and sets its clock's rate: slow motion (down to ${MIN_TIME_RATE}, one Destiny tick every 16 s) or fast-forward (up to ${MAX_TIME_RATE}×). Fast-forward steps every 1 s Destiny tick with its pending orders, Follow the FC steering, module cycles, locks and combat rolls, exactly as at 1×; the clock never jumps: when the page cannot step the ticks fast enough it waits at the last one and effectiveRate reports the rate it keeps. The drawn effects of a frame's ticks play together. Paused, nothing moves, fires or animates while the camera, the HUD and the tools go on: every drawn effect (beams, overlays, hull lights and glows, boosters, the dressing) runs on the scene clock, so it holds still and slows in slow motion (a cinematic shot holds on the scene clock too). Audio mutes above ${AUDIBLE_MAX_RATE}× and suspends while paused; slow motion stays audible at normal pitch. Rate and pause last across loads until the tab reloads; Space, [ and ] do the same on the page. Jumps: once the scene has settled (every lookup answered and every hull built) the page snapshots the whole simulation every \`every\` scene seconds (default ${DEFAULT_SNAPSHOT_EVERY_SECONDS}) for the last \`window\` seconds (default ${DEFAULT_TIME_WINDOW_SECONDS}, within ${DEFAULT_TIME_BUDGET_MB} MB) and journals the live commands (order_ship, order_fleet's live orders, switch_prop_mods, switch_modules, set_target, engage, cease_fire, set_hp). back jumps that many scene seconds back (← on the page jumps 10 s) and seek to a scene time (get_state time.seconds), or in a scripted scene to { timeline: s } seconds of timeline time (get_state time.timeline): the page restores the nearest snapshot, re-simulates silently to the target with the journaled commands and the timeline's cues replaying at their ticks (a cue's warp-in lands again), and lands there; ships destroyed after it are back, and the effects playing at the target are drawn again: an explosion whose hull still shows replays from its start, missiles in flight, running modules' beams and overlays, and warp flashes. Playing on replays the recorded future, the same fight with the same kills, until a new live command replaces it. A seek past the recorded end simulates forward (at most ${MAX_SEEK_AHEAD_SECONDS} s). A jump before the window clamps to its start with a warning. Once a scripted timeline starts, its t = 0 stays in the window whatever the window's length (the origin snapshot), so a jump or a seek { timeline } can always go back to it. Script edits (cues and ships' orders only, while the timeline plays) re-simulate from the last snapshot before them instead of cutting the window (time.jump cause "edit"). Other edits that change the simulation (patch_scene and the scene tools, except camera-only and name-only edits), a load, or a lookup landing start a new window (time.recording.why says which). Applied in the order every / window, the jump, rate, pause: { back: 10, rate: 0.25 } re-watches the last 10 s in slow motion, { seek: 42, pause: true } lands paused. {} reports. Returns get_state's time (seconds, tick, rate, paused, state, back, earliest, latest, window, recording, replay, drift, jump, ...) plus warnings.`,
    inputSchema: {
      type: 'object',
      properties: {
        pause: { type: 'boolean', description: 'true pauses, false plays.' },
        rate: { type: 'number', minimum: MIN_TIME_RATE, maximum: MAX_TIME_RATE, description: 'Scene time per real time: 1 real time, 0.25 slow motion, 4 fast-forward.' },
        back: { type: 'number', exclusiveMinimum: 0, description: 'Scene seconds to jump back from now (time.back says how far the window reaches).' },
        seek: {
          anyOf: [
            { type: 'number', minimum: 0 },
            { type: 'object', properties: { timeline: { type: 'number', minimum: 0 } }, required: ['timeline'], additionalProperties: false }
          ],
          description: 'Where to jump: a scene time in get_state time.seconds, or { timeline: s } seconds of timeline time (get_state time.timeline, a scripted scene once its timeline started); back inside the window, or forward past it.'
        },
        every: { type: 'number', minimum: MIN_SNAPSHOT_EVERY_SECONDS, maximum: MAX_SNAPSHOT_EVERY_SECONDS, description: `Snapshot spacing, scene seconds (default ${DEFAULT_SNAPSHOT_EVERY_SECONDS}): smaller makes jumps faster, at more memory.` },
        window: { type: 'number', minimum: MIN_TIME_WINDOW_SECONDS, maximum: MAX_TIME_WINDOW_SECONDS, description: `How far back the snapshots reach, scene seconds (default ${DEFAULT_TIME_WINDOW_SECONDS}).` }
      }
    }
  },
  {
    name: 'movie',
    where: 'page',
    description: `Movie mode: the scene's timeline as a movie, its cues the beats (the authoring view; the timeline tool stays the low-level cue list). Each beat is in a lane: camera (play_shot, play_sequence, stop_shot, auto_camera) or fleet (every other lever, warp-in patch cues included); its time is when it fired, else when it is due (timed, or an event cue whose event came), else null while it waits for its event. action "status" (default) reports. Edits (each a timeline edit: one that reaches into the past re-simulates the scene from the last snapshot before it back to now, resimulated says from when): "add" { beat: { id?, at?, when?, name?, <action>: <its tool's arguments> } } (a hub-resolved warp-in is add_fleet_composition / add_ships / stage_engagement with at or when); "move" { id, at?, when? } (when null makes it timed; at null lets an event cue arm once what it names exists); "edit" { id, set: { at?, when?, name?, <action>? } }; "remove" { id }; "set" { movie: { letterbox?: <aspect in [0.5, 4], default ${DEFAULT_MOVIE_LETTERBOX}, or false>, hud?: <default false>, end?: <timeline s> } | null } sets the movie block (a null key resets it; null removes it). Playback: "play" { from?: <beat id | timeline s>, lead?: <s before the beat, default ${DEFAULT_MOVIE_LEAD_SECONDS}>, rate? } lands lead seconds before the beat (or at from seconds) and plays the clock; with no from it plays from now (a stopped or ready timeline starts). "seek" { to: <beat id | timeline s>, offset?: s, play?: false } lands on the beat paused (its cue has fired: a shot is on its first frame), ready for screenshot; a seek more than ${MAX_SEEK_AHEAD_SECONDS} s past the recorded end runs as consecutive jumps. "pause" pauses the scene clock (not the timeline's cursor). "restart" { paused? } replays the movie from t = 0 (timeline restart). "retake", after a scene edit cut the time window (a live edit that changes the simulation, a load), replays the movie from t = 0 and comes back to the timeline time it was at, the pause state kept, so every beat can be reached again. play, seek, retake and edits that re-simulate wait two frames before returning, so a screenshot right after shows the landing. While the timeline plays a movie block letterboxes the frame with the HUD off (a playing shot's own letterbox / hud win; L and H on the page switch them for the run), and at end the clock pauses exactly there (play goes on past it). While a movie owns the camera, a play_shot is a live preview: a jump or a re-simulation returns the movie's camera. Returns the movie: state, time (timeline s), end, ended, look { letterbox, hud, applied }, camera { driver, beat }, beat { fleet, camera } (the last fired per lane), next (the next beat, with in), beats (id, name, lane, action, trigger { at } or { when, arms, after, latest }, time, state, in, note, error), waiting, events { count, last }, window { earliest, latest, origin } (timeline s; origin: t = 0 can be reached) and scripts; edits return { beat, resimulated, movie, warnings }, play, seek, restart and retake the movie plus warnings.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MOVIE_ACTIONS], description: 'Default status.' },
        beat: { type: 'object', description: "add: the cue { id?, at?, when?, name?, <action>: <its tool's arguments> }." },
        id: { type: 'string', description: "move, edit, remove: the beat's cue id." },
        at: { anyOf: [{ type: 'number', minimum: 0, maximum: MAX_TIMELINE_SECONDS }, { type: 'null' }], description: 'move: timeline seconds (an event cue: when it arms; null derives it).' },
        when: { anyOf: [{ type: 'object' }, { type: 'null' }], description: 'move: the event it waits for ({ kill | arrival | warp | cue | primary | fire: <filter>, count?, after?, latest? }), or null to make it timed.' },
        set: { type: 'object', description: "edit: { at?, when?, name?, <action>? } (the timeline's update_cue)." },
        from: { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }], description: 'play: a beat id or timeline seconds; omitted plays from now.' },
        lead: { type: 'number', minimum: 0, description: `play with from: seconds before the beat to land (default ${DEFAULT_MOVIE_LEAD_SECONDS}).` },
        rate: { type: 'number', minimum: MIN_TIME_RATE, maximum: MAX_TIME_RATE, description: 'play: the clock rate.' },
        to: { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }], description: 'seek: a beat id or timeline seconds.' },
        offset: { type: 'number', description: 'seek: seconds from the beat (negative lands before it).' },
        play: { type: 'boolean', description: 'seek: play on from the landing (default false: land paused).' },
        paused: { type: 'boolean', description: 'restart: hold at t = 0 until play.' },
        movie: {
          anyOf: [
            {
              type: 'object',
              properties: {
                letterbox: { anyOf: [{ type: 'number', minimum: 0.5, maximum: 4 }, { type: 'boolean' }, { type: 'null' }] },
                hud: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
                end: { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: MAX_TIMELINE_SECONDS }, { type: 'null' }] }
              }
            },
            { type: 'null' }
          ],
          description: 'set: the movie block (a null key resets it), or null to remove it.'
        }
      }
    }
  },
  {
    name: 'export_movie',
    where: 'hub',
    description: `Renders the movie (the scene's scripted timeline) or a time range offline to an MP4 file on a fixed scene clock: each frame advances the scene exactly 1/fps however slowly the page draws. Destiny still steps every tick, cues and event cues fire on their ticks, and the camera (shots, moves, lag, shake, the automatic director) and the effects run on scene time. So the file is smooth even for a battle the page draws at a few frames a second; it just takes longer. action "start" replays the movie from its placements by default (timeline restart), seeks silently to from and draws preroll seconds before it without encoding; it returns { id, state, file: { path, url, windowsPath? }, plan, warnings } once the export is armed. "status" (the default; works with no tab) gives the progress (frame, frames, progress, time, rate { fps, realtime }, eta, waiting: what it waits for, encoder, frameMs) and, once done, result { path, url, bytes, frames, seconds, ... }. "cancel" stops it and deletes the partial file. While it runs, the page's scene, clock and camera tools are refused (reads, screenshot and save_scene still work) and the tab's input is locked (Esc in the tab cancels, H toggles the overlay). Keep the Chrome window visible: a hidden or minimized tab stops drawing. Frames are encoded in the page with WebCodecs (H.264, or HEVC on a GPU that has it) and written by the hub to its movies directory (viewer_status moviesDirectory), served at /movies/<file>. Video only: no sound. The picture is width × height with the letterbox (the option, else the movie's look) as black bars; a playing shot's own letterbox still wins while it plays. When it ends or is cancelled the clock is paused at the last frame and the run stays in the time window. A scene with no timeline exports duration seconds from now. source "slate" encodes the timeline time on black instead of the scene, which needs no renderer (for headless checks).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MOVIE_EXPORT_ACTIONS], description: 'Default status.' },
        from: { type: 'number', minimum: 0, description: 'start: timeline seconds of the first frame (default 0).' },
        to: { type: 'number', exclusiveMinimum: 0, description: "start: timeline seconds to end at (default the movie's end)." },
        duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_EXPORT_SECONDS, description: 'start: seconds to export, instead of to (a scene with no timeline: seconds from now).' },
        fps: { type: 'integer', minimum: MIN_EXPORT_FPS, maximum: MAX_EXPORT_FPS, description: `start: frames a second (default ${DEFAULT_EXPORT_FPS}).` },
        width: { type: 'integer', minimum: MIN_EXPORT_SIZE, maximum: MAX_EXPORT_WIDTH, multipleOf: 2, description: `start: pixels, even (default ${DEFAULT_EXPORT_WIDTH}).` },
        height: { type: 'integer', minimum: MIN_EXPORT_SIZE, maximum: MAX_EXPORT_HEIGHT, multipleOf: 2, description: `start: pixels, even (default ${DEFAULT_EXPORT_HEIGHT}).` },
        letterbox: { anyOf: [{ type: 'number', minimum: MIN_EXPORT_LETTERBOX, maximum: MAX_EXPORT_LETTERBOX }, { const: false }], description: "start: the picture's aspect inside the frame (black bars), or false for none (default the movie's look)." },
        codec: { type: 'string', enum: [...MOVIE_EXPORT_CODECS], description: 'start: default h264 (HEVC needs a GPU encoder).' },
        bitrate: { type: 'integer', minimum: MIN_EXPORT_BITRATE, maximum: MAX_EXPORT_BITRATE, description: 'start: bits a second (default about 0.2 bits a pixel a frame: 12.4 Mbps at 1080p30).' },
        restart: { type: 'boolean', description: 'start: true (the default with a timeline) replays from the placements; false exports the run in the time window.' },
        preroll: { type: 'number', minimum: 0, maximum: MAX_EXPORT_PREROLL_SECONDS, description: `start: seconds drawn, not encoded, before a from > 0 (default ${DEFAULT_EXPORT_PREROLL_SECONDS}).` },
        name: { type: 'string', maxLength: MAX_EXPORT_NAME_LENGTH, description: "start: the file's name without .mp4 (default the scene's name and the time)." },
        source: { type: 'string', enum: [...MOVIE_EXPORT_SOURCES], description: 'start: scene (default; needs WebGPU) or slate (the timeline time on black, no renderer).' }
      }
    }
  },
  {
    name: 'list_shots',
    where: 'hub',
    description:
      "Lists the named cinematic shot library (works with no viewer tab): each shot's name, description, subject kind (engagement, group, ship or landmark), the options it reads, its default duration (none: holds until stopped), end, an example reference for play_shot / play_sequence, and that example expanded into the explicit shot it plays.",
    inputSchema: { type: 'object', properties: {} }
  }
];

export const TOOLS: ToolDefinition[] = TOOL_LIST.map((tool) => (CUEABLE_TOOL_NAMES.has(tool.name) ? cueable(tool) : tool));

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
