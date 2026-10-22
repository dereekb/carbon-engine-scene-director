---
name: windows-chrome
description: Drive Windows Chrome from this WSL2 box through the chrome-devtools MCP (mcp__chrome-devtools__* tools) to debug the viewer on the real GPU, and set up, check or repair that MCP. Use when you need to look at, click through, screenshot or profile the viewer page yourself, read the browser console or network, check WebGPU drawing, when the chrome-devtools tools are missing or fail to start, or when asked to set up Chrome / browser debugging here. Claude in Chrome does not work in WSL and headless Chromium here has no WebGPU adapter; this does both.
---

# windows-chrome

The chrome-devtools MCP runs **on the Windows side**: a portable Windows Node runs `chrome-devtools-mcp`, which
launches Windows Chrome (real GPU, WebGPU) and drives it over Windows loopback. Claude Code starts it through a WSL
wrapper, and MCP stdio crosses WSL interop. Windows Chrome reaches the hub on `127.0.0.1:5520` through WSL's
localhost forwarding, the same way a tab the user opens does.

Why not the usual setup: WSL here uses NAT networking, so WSL cannot reach Windows' `127.0.0.1`, and Chrome binds its
debug port to loopback only (`--remote-debugging-address` is gone). Bridges such as wsl-cdp (netsh portproxy,
firewall rule, relay) need admin and expose the debug port to every distro and container in `172.16.0.0/12`. This
setup needs no admin and opens no port.

## Pieces

| Piece | Where |
| --- | --- |
| Portable Node LTS + `chrome-devtools-mcp` | `C:\Users\<user>\.chrome-devtools-mcp\{node\, node_modules\}` |
| Wrapper (`cd` to the C: dir, `--no-usage-statistics --no-performance-crux`) | `~/.local/bin/chrome-devtools-mcp-windows` |
| MCP server `chrome-devtools`, user scope (every project on this box) | `~/.claude.json` |
| Chrome profile, the server's own (not the user's daily one) | `C:\Users\<user>\.cache\chrome-devtools-mcp\chrome-profile` |

## Set up, check, repair

```bash
.claude/skills/windows-chrome/scripts/setup.sh           # install what is missing, then check
.claude/skills/windows-chrome/scripts/setup.sh --check   # report each piece + an MCP handshake; changes nothing
.claude/skills/windows-chrome/scripts/setup.sh --update  # newest Node LTS + chrome-devtools-mcp
```

The check covers interop, the Windows Node, the package, the wrapper, the registration, a real `initialize`
handshake, whether Windows can reach the hub, and any running server/Chrome processes. After a fresh install, the
session needs `/mcp` (or a restart) before the `mcp__chrome-devtools__*` tools appear. `--update` refuses while a
server runs (Windows locks `node.exe`): disconnect `chrome-devtools` in `/mcp` first.

If the check says interop did not answer, WSL interop is wedged: the user runs `wsl --shutdown` from Windows.

## Debugging the viewer

1. `viewer_status`: the hub must be up. Note `connectedTabs`: if the user has a tab open, say you are about to take
   page tools from it.
2. `new_page` with `http://127.0.0.1:5520/`. It answers with the page list; keep the viewer's `pageId`. **Every page
   tool needs `pageId`** (the server routes by page ID).
3. The new tab is the hub's newest connection, so the scene-director page tools (`load_scene`, `screenshot`,
   `get_state`, `page_log`, ...) now go to it (`hub.ts`: `this.pages.at(-1)`). `close_page` when done hands them
   back to the user's tab.
4. Pick the tool by what you need to see:
   - `take_screenshot`: the viewport as Chrome shows it, overlay included. scene-director's `screenshot`: the
     renderer's own frame.
   - `list_console_messages` / `get_console_message`: everything the page printed. `page_log`: the hub's record,
     including `gpuErrors` from `engine.ts`'s `uncapturederror` listener.
   - `evaluate_script` for one-off probes, e.g. the adapter:
     `async () => JSON.stringify((await navigator.gpu.requestAdapter())?.info)`.
   - `take_snapshot` + `click` / `fill` / `press_key` for the DOM overlay; `list_network_requests` for loads;
     `performance_start_trace` / `performance_stop_trace` for frame time.
5. After a page-only change: rebuild (`npx nx build scene-director`), then `navigate_page` with `type: "reload"`.

Expected noise: a 404 for `/favicon.ico`, and the warning that `powerPreference` is ignored on Windows.

## Moving ships and timed captures

- `frame_camera { target }` follows the target's drawn hull every frame. get_state's `position` is the Destiny master
  ball, one to two ticks of travel ahead of what is drawn (about 1 km for a cruising frigate, hundreds of km in warp).
- Re-framing a ship the camera already follows throws the focus back by that lag, then glides it onto the hull over
  0.6 s. Wait at least 0.8 s after a `frame_camera` on a moving ship before a shot, and never re-frame mid-warp.
- A new tab boots into the scene its profile saved last. Load the check's scene once before you install a probe:
  a universe change reloads the tab and drops the probe.
- Keep the Chrome window visible. A background tab or a minimized or fully covered window stops rAF: fps drops to 0
  and screenshots time out. The user may resize the window during a run; `resize_page` again before the next one.
- Per-frame probes: once the first scene has loaded, `globalThis.sceneDirector` is `{ director, engine, link, world,
  clock }`. Wrap `engine.Frame` to sample each frame, and run the script with `evaluate_script` and
  `waitForStableDom: false`. Pass the function inline, because `sourcePath` must be a Windows path. A big result goes
  to `filePath` under `C:\Users\<user>\AppData\Local\Temp\`, which WSL reads at `/mnt/c/...`.
- Sub-second sequences (a warp's entry and exit) need a hub controller driver, not agent tool calls. Connect a Node
  WebSocket to `ws://127.0.0.1:5520/ws`, send `{ type: 'hello', role: 'controller' }`, then `{ type: 'call', id,
  name, args }`. Burst `screenshot` + `get_state` at up to 5 a second and write the PNGs and rows to `.scratch/`.
- Booster LOD (`EveBoosterSet2Renderable.UpdateVisibility`) goes by the booster sphere's pixel size. Let D be the
  camera distance from the focus, R the booster sphere radius and H the canvas height in device pixels. Then flames
  and flares draw while D < ~0.04·R·H, the high-LOD flame while D < ~0.008·R·H, and trails while D < ~0.16·R·H. On a
  900 px canvas that is 600 m, 115 m and 2.3 km for a Slasher (R 15.9 m); a Tempest Fleet Issue (R 269 m) is
  high-LOD at 1.5 km. The flags are not recomputed while a ship is culled, so trust them only on screen.
- The booster check's scripts (scene, probe, readout, driver) are in `.scratch/gpu-look/` on this machine and in the
  plan `real-gpu-look-at-the-speed-driven-boosters-and-the-warp.md`.
- The movement and fleet check (`.scratch/gpu-check/`, plan
  `agent-run-real-gpu-check-orbit-approach-keep-at-range-a-tfis-fleet-in-formation.md`) is the fuller template:
  - Its probe wraps `Director.TrackCamera` instead of `engine.Frame`: `main.ts` calls it every frame with the same
    `now`, renderer or not, so the same probe runs headless. It keeps per-ship, per-scene-second buckets (turn rate,
    tick-edge vs inner rate steps, axis reversals, bank, position error, jumps, lag, boosters, camera focus gap, target
    distances), so a 15 min fleet run stays a few MB. Dump it with `evaluate_script` and `filePath` under the Windows
    temp dir, then `readout.mjs <run dir>` joins it with the driver's `events.jsonl` segment marks and `rows.jsonl`.
  - Install it with `sourcePath` pointing at a copy under `C:\Users\<user>\AppData\Local\Temp\`: a Windows path works
    and keeps an 11 KB function out of the call. A page reload (yours, the user's, or a universe change) drops it and
    its buckets: dump before anything reloads.
  - `dry-run.mjs` validates the drivers headless against a private hub on 5597 (temp scenes and fleets dirs), never
    5520. Headless, a ClientBall's rotation filter advances only when something samples it, so compare only watched
    ships there; on the GPU every built ship is sampled each frame.
  - `movement.mjs --only teleport` and `fleet.mjs --from <phase>` re-run one part for a fix's before/after.
  - The user can touch the window mid-run: a drag or an alt-click in the page changes the camera under the driver
    (its rows show yaw/pitch/target jumps it did not ask for). Re-run that segment rather than judge it.

## Gotchas

- The first load in a fresh profile once stalled until a reload (2026-10-21; cold cache plus the ~20 MB file
  index). Reload before you debug a blank page.
- File paths you pass to its tools (screenshot/trace `filePath`, `upload_file`) are Windows paths, and the server
  only touches allowed directories (the Windows temp dir by default; the session's MCP roots are Linux paths, which
  mean nothing to it). Prefer inline results.
- It renders on the user's desktop: the Chrome window is in front of the user, and `new_page` brings its tab to the
  front unless you pass `background: true`.
- Ending the server (session exit, `/mcp` disconnect, SIGTERM) closes its `node.exe` and Chrome. If a start fails
  because the profile is in use, `setup.sh --check` lists leftover processes.
- Node and the package are pinned by what is installed: `--update` is the only thing that moves them.
