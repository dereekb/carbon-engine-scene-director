# carbon-engine-scene-director

Build EVE Online space scenes as JSON documents and watch them render live in
the browser, driven by Claude through MCP tools. Rendering is
[CarbonEngineJS](https://github.com/carbonenginejs/runtime)'s WebGPU renderer;
ship and environment data come from a local
[tools-core](https://github.com/carbonenginejs/tools-core) service.

**Phase 1** (this): scene documents, ships placed from SOF DNA, camera,
screenshots, saved scenes. Movement orders, combat and timelines are reserved
fields in the document and come in later phases.

```text
Claude Code ──stdio──▶ scene-director mcp (Node)
                          hub: http://127.0.0.1:5520  page + /resource proxy + /ws
                            │ WebSocket
                            ▼
                       viewer tab (Chrome/Edge, WebGPU)
                         scene document ─▶ SOF ships ─▶ EveSpaceScene ─▶ canvas
                         IndexedDB: saved scenes and the working copy
                       tools-core :5510 ◀── every resource request
```

The page owns the scene. The hub only serves it, proxies resources and
routes tool calls, so a page reload restores the working scene from
IndexedDB and Claude can reconnect at any time.

## Requirements

- Node 22+ for this project; tools-core needs Node 22 for its SQLite binding.
- A runtime build in `../carbonenginejs/runtime` (`npm run build:npm` there).
  It is copied into `node_modules` on install; see `runtimePin` in package.json.
- tools-core serving on 127.0.0.1:5510. In its checkout:
  `node bin/cjs-tools-service.js --no-audio-auto-prepare --no-sde-auto-prepare`
- Chrome or Edge with WebGPU, on a machine with a GPU. Under WSL2, open the
  viewer from Windows; localhost forwarding reaches the hub.

## Run

```sh
npm install
npm run build          # bundles the page into dist/page
npm run serve          # hub only, for using the page by hand
```

Open http://127.0.0.1:5520/. With nothing saved, it shows a welcome scene.

For Claude Code, `.mcp.json` registers the server for this directory (start
Claude Code here and approve it), or add it everywhere with:

```sh
claude mcp add scene-director -- node /mnt/a/github/carbon-engine-scene-director/bin/scene-director.js mcp
```

The MCP server starts the hub itself, or joins one already running on the port.

From a shell, any tool can be called against a running hub:

```sh
node bin/scene-director.js call get_state
node bin/scene-director.js call load_scene '{"scene":{"ships":[{"id":"a","dna":"af1_t1:amarrbase:amarr"}]}}'
node bin/scene-director.js call screenshot '{"maxWidth":960}' --out shot.png
```

## Tools

| Tool | Answered by | Does |
|---|---|---|
| `viewer_status` | hub | connected tabs, the URL to open, tools-core reachability |
| `page_log` | hub | the viewer's recent console output and errors |
| `search_hulls` | hub | SOF hull, faction or race names |
| `load_scene` | page | replaces the scene with a document |
| `get_scene` | page | the current document |
| `patch_scene` | page | edits by operation (add, update, remove, camera, environment, rename) |
| `save_scene` / `list_scenes` / `open_scene` / `delete_scene` | page | IndexedDB storage |
| `get_state` | page | renderer status, per-ship build status and placement, distances |
| `screenshot` | page | the next frame as a PNG |
| `frame_camera` | page | points the camera at a ship or fits all ships |

## Scene document

```json
{
  "schema": "cjs-scene/1",
  "name": "duel",
  "environment": { "universe": "res:/dx9/scene/universe/a01_cube.black" },
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 45 },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ]
}
```

Metres and degrees, Y up. `rotation` is `[yaw, pitch, roll]`. A `null` camera
target frames every ship; a `null` distance fits the target. Unknown fields are
reported as warnings and dropped. `orders` on a ship and a top-level `timeline`
are stored but not played yet.

Edits are diffed against the current document: a DNA change rebuilds that
ship, a placement change moves it in place, and an environment change reloads
the page (the scene's environment is initialized with the device).

## Development

```sh
npm test               # scene, hub and MCP tests, offline
npm run verify:page    # the real page in headless Chromium against a running tools-core
```

Headless Chromium usually has no WebGPU adapter, so `verify:page` checks
everything but drawing: SOF builds from real data, edits, storage and reload.

## Runtime notes

- `src/page/runtime.js` is the single import point for the runtime. The WebGPU
  render context is internal to the runtime package and is reached through the
  `runtime-dist/` alias that `scripts/build-page.js` resolves.
- The bundle ignores the runtime's `sideEffects` list: many listed files
  register classes on import, and dropping them breaks Black reading.
- Ships hold still through `StaticPosition`/`StaticRotation` curves
  (`src/page/ships.js`); Destiny-driven balls replace them in the movement phase.

## EVE content

The code is MIT. EVE's content is not: using it means accepting CCP Games'
[EVE Online Content Creation Terms of Use](https://support.eveonline.com/hc/en-us/articles/8563917741084-EVE-Online-Content-Creation-Terms-of-Use).
Work made from EVE content must be non-commercial and carry CCP's disclaimer.
EVE Online and all related assets are the property of CCP hf. This project is
not affiliated with or endorsed by CCP Games or Fenris Creations.
