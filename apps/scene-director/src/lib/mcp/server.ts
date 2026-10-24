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
viewer_status.eveData says whether the hub has EVE data. With it off (--eve-data off, a machine without tools-core) ships and objects draw as stand-in cubes on a green screen and fly class numbers. Name hulls by dna and give objects a dna. search_hulls, search_map, get_system, set_location, search_objects and lookups by EVE name refuse.
ship_stats gives a hull's in-game speed, agility, signature and align time (needs tools-core's SDE; not with EVE data off).
order_ship flies a ship (direction, goto, approach, keep-at-range, orbit, warp, stop) at its in-game speed; get_state shows each ship's order, motion and warp progress.
get_overview is EVE's overview from one ship (every ship near it: distance, radial, transversal, angular, bearing, aspect, reach and tackle, the DPS each side applies now, who locks and shoots it) with its stance and the ideal range against its focus: what a program flying that ship reads each tick.
switch_prop_mods turns MWDs/ABs on or off for ships, a fleet, a wing or a squad, on EVE's cycle timing (get_state shows each module's state and the MWD signature bloom).
Ships carry EVE fits (ships[].fit, EFT text or a key of the document's fits): their modules set HP, resists, capacitor and speed, and switch_modules runs them (hardeners, reps, remote reps on a target, webs, scrams, siege, ...) on EVE's timing: webs slow and scrams pin their target, neuts drain its capacitor; get_state shows each ship's fit, live defense and module states.
Every ship mounts its fit's turrets on its hull, or default guns for its hull and race when it has no fit (a default weapons fit get_state reports with key "default"); set_target or engage locks a target (lock time from scan resolution and signature) and the turrets and launchers fire at it (switch_modules { modules: ["turret", "launcher"], state: "active" }, or engage to keep them firing; cease_fire stops them), once per weapon cycle with the game's firing effects and impacts; each turret shot rolls EVE's hit chance and does EVE damage through shield, armor and hull, each launcher cycle launches a missile that flies to the target and hits with EVE's missile damage (get_state missiles), and a ship at 0 hull is destroyed (get_state destroyed and combat.kills).
set_hp sets ships' shield, armor and structure HP live (HP, a percent of max or a seeded random draw; per layer, or the total shield first) to look battle damaged or start a low-HP fight: cinematic (default) never kills, gameplay destroys a ship left at 0 structure under combat.death; get_state shows defense and hpSet.
add_fleet_composition drops a doctrine fleet (cjs-fleet/1, inline, saved, or the built-in "tfis") into the live scene at a position (or near a ship, object or celestial) and heading; list_fleet_compositions / get_fleet_composition / save_fleet_composition manage compositions.
Fleet personalities are FC playstyles (cjs-fleet-personality/1): list_fleet_personalities shows the built-ins (line, brawler, kiter, sniper, headhunter, alpha, green, veteran, defensive), each saying when to pick it, and the saved ones; pick one per fleet with set_fleet_personality, or personality on add_fleet_composition, stage_engagement sides and add_ships' new fleet; save_fleet_personality keeps a custom one that extends a built-in. A personality fleet's FC brain then runs its fight: it calls targets, turns free fire on, flies the FC and switches prop mods with the same order_fleet and switch_prop_mods calls a model makes (get_state fleets[].fc.decisions shows each call and why); when its FC dies a successor takes command after a handover. Pulling one of those levers yourself (order_fleet targets, free-fire or a fleet move, engage, cease_fire, order_ship on its FC, switch_prop_mods) takes it manual (fc.manual) until set_fleet_personality is called again.
warpIn (add_fleet_composition, add_ships, stage_engagement sides) lands the new ships from warp instead: they wait off-grid, warp in at their hull warp speed, drop out staggered at their placements (or a fleet's live slots) and form up; get_state arrivals reports who waits, warps, landed and formed.
add_ships adds N ships of an EVE type in a formation (sphere, line, column, wedge, grid, wall) at a position or off a ship or celestial, facing a heading or a target, on a team, optionally as a new fleet or into a fleet squad; it is a shortcut for a one-line fleet template, which it returns for save_fleet_composition. stage_engagement sets up two sides (compositions, saved templates or ship lists) facing each other at a range around a point or a celestial, each on its own team. A battle in a few calls: set_location -> stage_engagement -> frame_camera -> screenshot.
Fleets fly in formation on their FC. order_fleet commands a fleet, wing or squad: a move goes to its leader and the rest follow (a wing or squad flies apart until regroup); a warp lands the group in formation (the FC warps the fleet, a wing or squad commander only their group); anchor / break-off / regroup edit the anchors; a targets order calls the group's primary and target queue: members without their own target lock and shoot it, then the next; a free-fire order lets members with no call pick the nearest hostile in their own reach. Without delay each pilot answers after its reaction (ships[].pilot.reaction). An order_ship order on a member takes it out of formation until { "type": "rejoin" }.
A fleet's logi squads repair members under fire on their own (auto_repair sets it on or off and the policy per fleet, wing or squad; get_state autoRepair shows each logi's target and why).
search_map / get_system find real EVE places in CCP's static data (needs tools-core's SDE; not with EVE data off); set_location puts the scene at one ("30 km off Jita IV - Moon 4 - Caldari Navy Assembly Plant", the Perimeter gate in Jita), and the page draws it (the region's nebula, the star, nearby planets, moons, stations and gates); get_state reports the location, the nearest celestials and what was dressed.
search_objects finds EVE types to place (stations, gates, Upwell structures, LCOs, wrecks: anything with a SOF graphic); add_objects places them by type name or id at a position or off a ship, object or celestial, facing a heading or a target, several lines in one call. Objects are static, listed in get_state.objects and framed by frame_camera; order_ship can approach, orbit, keep at range on or warp to them, and to the location's stations and gates as celestial:<id> (get_state.location.targets), or by name (an object's name, "Caldari Navy Assembly Plant"; planets, moons, stars and belts by name are warp-only: order_ship / order_fleet warp lands range off the surface). A scene spans at most 10,000 km around its origin.
add_asteroid_field adds a seeded asteroid field of EVE ores (EVE's own rock models, by ore name: Veldspar, Dark Ochre, Blue Ice, ...) as a sphere, disc or ring at a place, off a ship, object or celestial; an asteroid belt centres it. Rocks are scenery with no Destiny balls; patch_scene's update_asteroid_field and remove_asteroid_field edit it. The page draws a field instanced (a few draws per rock model); get_state asteroidFields lists each field's status, rocks and digest, and frame_camera frames one.
The cinematic camera: list_hardpoints shows a subject's generated camera positions (a ship, fleet, the engagement, an object or a celestial); play_shot / play_sequence play hardpoint shots, free poses and named library shots (list_shots: overlook pull-out, into the sun, battle fly-through, warp-in, chase, hero, flyby, ...) on the scene clock; stop_shot pauses or hands the camera back, resume_shot continues; get_state.cinema shows the shot, its progress and who drives. Look with screenshot.
A scene carries a script: its timeline's cues (each one lever tool's call at a time from play start) and each ship's orders (steps of order_ship orders, with after and duration). Give any lever tool (order_ship, order_fleet, switch_prop_mods, switch_modules, set_target, engage, cease_fire, auto_repair, play_shot, play_sequence, stop_shot, patch_scene) or add_fleet_composition, add_ships, stage_engagement or add_objects an at (seconds) and the call becomes a cue instead of running now, checked against the scene as it will be then (so a cue may order a fleet an earlier cue warps in; get_scene { at } shows that scene). A load of a scripted scene prepares with the scene clock held, then plays the cues and steps on Destiny's 1 s ticks, and a restart replays them the same; the timeline tool reports, plays, pauses and restarts the script, and get_state shows timeline and each scripted ship's script.
time_control pauses or plays the scene and sets the scene clock's rate, from slow motion (1/16) to fast-forward (32×): every 1 s Destiny tick still runs, with its orders, steering, modules and combat, so a fight plays the same at any rate (get_state time: seconds, tick, rate, paused, effectiveRate when the page falls behind). Pause before reading a moment you want to compare.
time_control { back: 10 } jumps back 10 scene seconds and { seek: <seconds> } to a scene time ({ seek: { timeline: <seconds> } } to a time on a scripted timeline): once the scene settles the page keeps snapshots of the last 2 minutes and journals the live commands, so a jump re-simulates from the nearest snapshot and the same fight plays again from there (ships destroyed after the target come back, and explosions, missiles, beams and warp flashes playing at it are drawn again); a new live command replaces the recorded future. An edit of the cues or ships' orders while the timeline plays re-simulates from the last snapshot before it (a timeline's t = 0 always stays recorded); other edits that change the simulation (and loads) start a new window: get_state time.back, recording and drift say what is recorded and whether replays matched.
movie is the timeline as a movie of beats (its cues, in a camera and a fleet lane): movie status lists them with their times or the events they wait for, add / move / edit / remove author them, seek { to: <beat> } lands paused on one for a screenshot, play { from: <beat> } plays from just before it, retake replays the movie from t = 0 after an edit cut the window, and set { movie: { letterbox, hud, end } } gives it its look and its end.
export_movie renders the movie offline to an MP4 on a fixed 1/fps scene clock (smooth however slowly the page draws; video only): start arms it, status reports the progress and then the file (path, url at the hub's /movies/<file>), cancel stops it; while it runs the page's scene, clock and camera tools are refused.`;

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
