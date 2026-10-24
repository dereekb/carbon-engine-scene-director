# The controller protocol: flying ships from a program outside the page (sd-piloting sub-doc)

How any process on this machine drives the scene through the hub, and how a program (a script, a slower decision
model) flies ships with the page's pilots doing the per-tick work. Code: the hub's WebSocket (`hub.ts` header and
`Accept`), `remote-hub.ts` (the same protocol inside the CLI), and the example driver
`apps/scene-director/src/pilot-loop.ts`. Plan: `~/.claude/plans/i-want-to-work-woolly-flame.md` ("The outside
program", P5). **Status: delivered** (the protocol was already there; P5 added this doc and `pilot-loop`).

## The protocol

One WebSocket to `ws://127.0.0.1:5520/ws` (the hub's port, `--port`), JSON text frames:

```text
→ { "type": "hello", "role": "controller" }
← { "type": "hello", "role": "controller", "hub": { "url": "http://127.0.0.1:5520/" } }
→ { "type": "call", "id": 1, "name": "get_overview", "args": { "ship": "blue-03" } }
← { "type": "result", "id": 1, "ok": true, "value": { … } }
← { "type": "result", "id": 2, "ok": false, "error": { "message": "…", "problems": ["…"] } }
```

- **Say hello first.** The hub ignores a `call` from a connection that has not said hello as a controller: it never
  answers, so the caller hangs. Frames that are not JSON are dropped the same way.
- `id` is the caller's own number, echoed on the result; several calls may be in flight and results can come back out
  of order (match by id). `args` is the tool's JSON arguments, exactly as the MCP tool takes them (`packages/scene`
  `tools.ts`, `SCENE_TOOLS`).
- `error.problems` carries a scene document's problem list (a refused patch, a bad stance); `message` is always set.
- **No auth**: the hub listens on 127.0.0.1 only, and anything on the machine may call any tool.
- **Page tools go to the newest tab** (the last to connect as a page); hub tools (`where: 'hub'`: saved scenes,
  compositions, personalities, `ship_stats`, `viewer_status`, `page_log`, ...) answer without one.
- **No push channel**: the hub never sends a controller anything but results. Poll (`get_overview`, `get_state`).
- **Timeouts**: 60 s per page call (600 s for `load_scene`, `open_scene`, `patch_scene`, `order_fleet`, `auto_repair`,
  `timeline`, `time_control`), then `"<tool> timed out after 60s; see page_log"`.
- **The simulation only advances on animation frames: the tab must stay visible.** A hidden or minimised tab stops the
  Destiny clock (and with it every pilot), so polls keep returning the same picture. `time_control` (`sd-time`) pauses
  or changes the rate; a loop paced on wall time then sees fewer or more ticks per poll.

## Errors a controller sees

| message | meaning |
|---|---|
| `No viewer tab is connected. Open http://127.0.0.1:5520/ …` | a page tool with no tab; open the viewer |
| `the viewer tab closed or reloaded before answering` | the tab went away mid-call (pending calls on it all fail) |
| `<tool> timed out after 60s; see page_log` | the page did not answer; `page_log` has the browser's errors |
| `unknown tool "<name>"` | not in the tool list, **or a hub started from an older build** (restart it after a build that adds tools) |
| the tool's own refusal (`ship "x" is not in the scene`, a stance problem) | `ok: false` with the page's message and problems |

A closed socket means the hub stopped; reconnect and say hello again (nothing is kept per controller).

## The MCP route

An MCP client spawns `node bin/scene-director.js mcp` (the repo's `.mcp.json` does). When a hub already holds the port
the new process joins it as a controller (`RemoteHub`; that hub's scenes, fleets and personalities directories apply),
so a second model shares the same tab and scene; when the port is free it becomes the hub itself and the page must
connect to it. `scene-director call <tool> '<json>'` is the one-shot form of the same thing.

## Flying ships from outside: intent levers vs raw orders

The page's pilots (`ShipPilots`, REF.md "The page's pilots") fly a stance every Destiny tick: they read the fight,
keep the ideal range, kite, spiral in, burn out and switch prop mods and tackle. A program outside the page does not
need to (and at one poll a second over the WebSocket cannot) fly a ship tick by tick: it **picks the stance**.

- **Read**: one `get_overview { ship }` per piloted ship per tick (a tick is 1 s of scene time). Polling faster sees
  the same boundary; every call rebuilds every ship's combat profile on the page (`BrainFacts`), so N ships cost N
  calls a tick. `envelope: false` drops the ideal-range block when the program does not read it; `envelope: true` adds
  the out / in DPS at every candidate range. The `stance` block is the pilot's report: resolved type and sources,
  `flownBy`, `state` (`closing`, `holding`, `orbiting`, `kiting`, `disengaging`, `waiting`, `idle`, `in-line`,
  `manual`), `focus`, `window`, `ideal`, `why`, `pending` and the last decisions. `get_state` has the same per ship
  (`ships[].stance`) and per fleet (`fleets[].stances` counts).
- **Intent levers** (the pilot keeps flying every tick):
  - `order_ship { id, order: { type: "stance", set: { type, on?, range?, propMods?, disengage? } } }`: the ship's own
    stance, taken up at once; `{ type: "stance", clear: true }` or `{ type: "rejoin" }` hands it back to its groups'
    stance (else its formation slot).
  - `order_fleet { fleet, wing?, squad?, order: { type: "stance", set | clear } }`: a group's stance; each member takes
    it up after its pilot's reaction delay (`respondsIn` in the result, `pending` in the report until then).
  - `set_target` / `engage` choose the focus (own target > the called target > the nearest hostile); `order_fleet`
    `targets` calls one for the group.
- **Raw orders take the pilot over**: `order_ship` with a movement order (direction, goto, approach, keep-at-range,
  orbit, warp, stop), `switch_prop_mods` on the ship, and `switch_modules` touching its `prop`, `point`, `scram` or
  `web` modules hold the pilot (`state: "manual"`) until a stance order names the ship (either tool), a `rejoin`, or
  its resolved stance changes. The raw order is then flown as given, as before stances existed. The same raw levers on
  an FC also take its fleet's FC brain manual (`sd-personalities`).

So a program that wants the page to fly should pull only intent levers, and a program that does pull a raw order (a
warp out, a scripted approach) gives the ship back with a stance order or `rejoin`.

## The example driver (`pilot-loop`)

`node dist/apps/scene-director/pilot-loop.js --ship <id> [--port 5520]` (built with the app, beside `verify-page.js`):
Node's global `WebSocket`, the raw protocol above, and a 1 Hz loop that reads `get_overview { ship, envelope: true }`
and sets the ship's own stance with `order_ship` when its pick differs from the type the ship flies:

1. away (warping, arriving, destroyed): leave it;
2. a friend on its overview reports `repairs` (it fits remote repairers): `support`;
3. no hostile on its overview: leave it;
4. HP under 50 %: `kite`;
5. the trade up close (the envelope's mean out and in DPS within 2.5 km on its focus, else the nearest hostile's row as
   it stands): `brawl` when out ≥ 1.1 × in, `kite` when in > out, else leave it.

A switch waits 10 s after the last one, and a `manual` ship is left to whoever took it. Each tick prints one line to
stdout (`[  12 s] blue-03 brawl (orbiting), HP 82 %: keep, it out-trades red-01 up close (…)`; it is not the MCP
process, so stdout is free); errors go to stderr, and a closed hub ends it (exit 1). The stance stays on the ship when
the loop stops (Ctrl-C). It is a demonstration of the levers, not a good pilot: a real decision program would read the
envelope's ideal and the fleet's state, and set group stances with `order_fleet`.
