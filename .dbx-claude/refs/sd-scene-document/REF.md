# The scene document (`cjs-scene/1`): schema, patch ops, diff, camera, saved scenes

> The document is the only state a saved scene keeps; the page turns it into runtime objects. Fetch before changing
> `packages/scene/src/lib/scene.ts`, adding a patch op or a document field, touching `director.ts`'s apply path,
> `camera.ts`, or the saved-scene stores. Subsystem fields have their own refs: `fleets` (`sd-fleets`), `location`
> (`sd-locations`), `propMod` / `stats` / `type` (`sd-ship-stats`), staging ops (`sd-staging`).

## Shape

```json
{
  "schema": "cjs-scene/1",
  "name": "duel",
  "environment": { "universe": "res:/dx9/scene/universe/a01_cube.black" },
  "camera": { "target": null, "distance": null, "yaw": 45, "pitch": -15, "fov": 45, "mode": "orbit" },
  "ships": [
    { "id": "punisher-1", "dna": "af1_t1:amarrbase:amarr", "team": "red", "position": [0, 0, 0] },
    { "id": "rifter-1", "dna": "mf1_t1:minmatarbase:minmatar", "team": "blue", "position": [3000, 0, 0], "rotation": [180, 0, 0] }
  ],
  "fleets": [], "location": { }
}
```

- **Units are EVE's**: metres, degrees, **Y up**. `rotation` is `[yaw, pitch, roll]`. Yaw 0 faces +Z, 90 faces +X.
- Ship fields: `id` (ship-id pattern), `dna` (SOF `hull:faction:race[:commands]`), `name?`, `team?` (the side, for
  hostility; independent of fleets), `position`, `rotation`, `type?`, `stats?`, `propMod?`, `pilot?` (reserved: stored,
  unused), `orders?` (reserved: stored, not played).
- Top level: `schema`, `name`, `environment`, `camera`, `ships`, `fleets?`, `location?`, `timeline?` (reserved).
- **Unknown fields are reported as warnings and dropped.** `null` on an optional field means absent.
- `normalizeScene(input)` validates and reports **every** problem together; `SceneError` carries the problem list
  (and `ToolError` keeps it through the hub).

## Patch ops (`applySceneOperations`)

`applySceneOperations(scene, operations)` clones the document into an unvalidated **draft**, runs each op in order,
then normalizes once. Ops run on a draft that an earlier op in the same patch may have broken, so op code tolerates
malformed values and never throws; `normalizeScene` reports what is wrong with the result.

| Op family | Ops | Where |
|---|---|---|
| ships | `add_ship` / `update_ship { id, set }` (id can't change; `null` clears `type`, `stats`, `propMod`, `pilot`; `stats` replaced whole) / `remove_ship` (clears `camera.target`, leaves fleets with fallback) | `scene.ts` |
| scene | `set_camera`, `set_environment` (merged), `rename`, `set_location` (whole), `clear_location` | `scene.ts` |
| fleets | `add_/update_/remove_fleet`, `..._wing`, `..._squad`, `move_to_squad`, `remove_from_fleet`, `set_anchor` | `fleets/operations.ts` (`sd-fleets`) |
| compositions | `add_fleet_composition` | `compositions/operation.ts` (`sd-fleets` → `compositions`) |
| prop mods | `set_prop_mods` | `prop-mods/operation.ts` (`sd-ship-stats`) |
| staging | `add_ships`, `stage_engagement` | `staging/operation.ts` (`sd-staging`) |

**`applySceneOperations` stays synchronous and pure: it runs in the page.** Anything that needs tools-core (hull names,
SDE radii, celestials, saved compositions) is resolved by the **hub tool of the same name**, which fills the op's data
(`dna`, `radius`, `radii`, points) and forwards it. The raw op refuses what it cannot resolve and says to use the tool.

A new op family: export an `*_OPERATIONS` set + `apply*Operation(operation, context)` and add it to the `default:`
branch of `applyOperation` in `scene.ts`.

## Diff (`diffScenes`) and what the page does with it

`Director.Apply` diffs the new normalized document against the current one and does only the work the diff names:

| `SceneDiff` field | Page action |
|---|---|
| `added` / `removed` | build / retire ships (removing stops the ship's followers: `sd-destiny`) |
| `rebuilt` | DNA changed: rebuild that ship; it keeps flying |
| `moved` | placement changed: put that ship at rest there (ends its order) |
| `relabelled` | name/team only |
| `retuned` | `type`, `stats`, `pilot` or `propMod.module` changed: new flight numbers, no rebuild |
| `switched` | `propMod.active` changed: switch at once (no cycle wait). A ship can be in `retuned` too |
| `fleets` / `regrouped` | fleet changed / ships whose membership or resolved anchor changed: re-plan following, no rebuild |
| `location` | re-fetch `/map/system`, re-dress |
| `environment` | **reloads the tab** (the environment is initialized with the device) |
| `camera` | re-frame |

`load_scene` / `open_scene` restart every ship at rest at its document placement; a patch touches only what it changes.
Live state (orders, prop mod switches, camera follow from `frame_camera`) is **never written to the document**, so a
save or reload starts from the document's placements.

## Camera

- `target: null` frames every ship; `distance: null` fits the target. A ship target is followed every frame (focus
  shifts by the drawn ship's travel, keeping any orbit/pan/zoom). `mode`: `orbit` (keeps your angles) or `chase`
  (behind the ship, 12° above its heading, turns with it; a drag looks around and eases back).
- In the page: alt-click a ship to follow it (glides over), **C** toggles orbit/chase; both write into the document.
- **Edits keep a follow.** Every edit used to re-frame the document's camera, dropping a `frame_camera` follow (rarely
  persisted) or gliding a persisted one across a teleport. `camera.ts` `ReframesAfterEdit` decides: re-frame only on a
  load, a camera change, removing the followed ship, or when no ship is followed. `Director.Apply` calls it before its
  `appliedCamera` check.
- Picking reads EveCamera's actual projection, not the document's `fov` (its default zoom curve overrides fov every
  frame, and Carbon narrows the view above aspect 1.6).

## Saved scenes

| Store | Where | Notes |
|---|---|---|
| `disk` (default for saving) | `SceneFileStore` (`apps/scene-director/src/lib/store/scene-files.ts` over `document-files.ts`) in the hub's scenes dir: `--scenes <dir>` / `SCENE_DIRECTOR_SCENES`, default `scene-director/scenes` in the per-user data dir | validated on write and read; works with no tab |
| `browser` | the tab's IndexedDB (`apps/viewer/src/lib/store.ts`); the working copy lives under a reserved key listings hide | needs a connected tab |

- The tools are `where: 'hub'` (`hub/saved-scenes.ts`) and forward to the page's handlers for `store: "browser"`.
  Stores are independent (no write-through). With `store` omitted: `save_scene` → disk; `list_scenes` → both (each entry
  marked); `open_scene` → disk first, then browser (no tab: returns the disk scene with `loaded: false`);
  `delete_scene` → disk if there, else browser.
- **File names** come from the scene name, lowercased, every run of chars other than letters, digits, `_`, `-` turned
  into `-` (`Duel at Jita` → `duel-at-jita.json`), so no name escapes the dir. Case-only differences are the same
  scene; saving a different name that collapses onto another scene's file is **refused**, not overwritten. A
  hand-placed file is listed and opened by its file name.
- The scenes dir belongs to the hub's owner process: a joined MCP server uses that hub's dir. `viewer_status` reports
  it. A `scenes/` folder in the checkout is gitignored.
- **Tests and verify-page pass a temp `SceneFileStore`; never write to the default per-user dir.**
- Import/export through the CLI: `call save_scene '{"name":"duel"}' --in duel.json`, `call open_scene ... --out f.json`,
  `call get_scene --out current.json`.
